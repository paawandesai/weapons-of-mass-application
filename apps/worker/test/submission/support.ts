import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  insertApplication,
  insertProfileVersion,
  putFile,
  setApprovedProfileVersion,
  upsertCompany,
  getCompany,
  upsertJob,
  type ApplicationRow,
  type Db,
  type JobRow,
} from '@wma/db';
import { FakeLlm } from '@wma/llm';
import { InMemoryOutgoingStore, InMemorySender, type AtsId } from '@wma/shared';
import profile from '../../../../packages/shared/test/fixtures/profile.full.json';
import { domainAllowed, senderDomain } from '../../src/submission/domains';
import type {
  BrowserLike,
  ContextLike,
  FollowUpJobData,
  PageLike,
  SubmissionDeps,
} from '../../src/submission/deps';
import type {
  Account,
  CaptchaHandle,
  Clock,
  Credential,
  FieldDescriptor,
  FormAdapter,
  GmailPort,
  InboundMessage,
  SignInOutcome,
  SubmitTrace,
  TailorResult,
} from '../../src/submission/types';
import { setupEnv, type TestEnv, type TestTenant } from '../helpers';

process.env.FILE_STORE_DIR ??= mkdtempSync(join(tmpdir(), 'wma-submission-'));
process.env.VAULT_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';
export const SLUG_PREFIX = `subtest-${Date.now()}`;

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export interface SubmissionEnv extends TestEnv {
  owner: pg.Pool;
}

export async function setupSubmissionEnv(): Promise<SubmissionEnv> {
  const env = await setupEnv();
  const owner = new pg.Pool({ connectionString: ownerUrl });
  const cleanup = env.cleanup;
  return {
    ...env,
    owner,
    async cleanup() {
      // Tenants first: ats_credentials references the shared companies.
      await owner.query(
        `delete from tenants where id in (select tenant_id from users where email like '%@example.test')
         and id in (select tenant_id from jobs where url like $1)`,
        [`%${SLUG_PREFIX}%`],
      );
      await owner.query('delete from companies where board_slug like $1', [`${SLUG_PREFIX}%`]);
      await owner.end();
      await cleanup();
    },
  };
}

export async function approveProfile(t: TestTenant, document: unknown = profile): Promise<void> {
  const row = await insertProfileVersion(t.handle, {
    userId: t.userId,
    document: document as never,
  });
  await setApprovedProfileVersion(t.handle, t.userId, row.version);
}

let counter = 0;

export interface Seeded {
  application: ApplicationRow;
  job: JobRow;
  companyId: string;
  /** The company's display name, as the job sees it. */
  companyName: string;
}

/** A company, a posting on its Greenhouse board and a pending application. */
export async function seedApplication(
  t: TestTenant,
  opts: { companyId?: string; attemptCount?: number; ats?: AtsId; url?: string } = {},
): Promise<Seeded> {
  const n = ++counter;
  let companyId = opts.companyId;
  let slug = `${SLUG_PREFIX}-${n}`;
  if (!companyId) {
    const company = await upsertCompany(t.handle, {
      name: `Acme ${n}`,
      ats: 'greenhouse',
      boardSlug: slug,
      createdBy: 'llm',
    });
    companyId = company.id;
    slug = company.boardSlug!;
  }
  const { job } = await upsertJob(t.handle, {
    companyId,
    ats: 'greenhouse',
    atsJobId: String(1000 + n),
    title: `Staff Engineer ${n}`,
    url: opts.url ?? `https://boards.greenhouse.io/${slug}/jobs/${1000 + n}`,
  });
  const { application } = await insertApplication(t.handle, {
    userId: t.userId,
    jobId: job.id,
    attemptCount: opts.attemptCount ?? 0,
  });
  const companyName = (await getCompany(t.handle, companyId))?.name ?? `Acme ${n}`;
  return { application, job, companyId, companyName };
}

export class FakeClock implements Clock {
  private t: number;
  readonly sleeps: number[] = [];
  /** Runs on every sleep after time advances (deliver mail, answer a CAPTCHA). */
  onSleep: (clock: FakeClock) => Promise<void> | void = () => {};
  constructor(start: Date = new Date()) {
    this.t = start.getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.t += ms;
    await this.onSleep(this);
    await new Promise((r) => setImmediate(r));
  }
}

export class MemoryGmail implements GmailPort {
  messages: InboundMessage[] = [];
  searches = 0;
  add(m: Partial<InboundMessage> & { from: string; receivedAt: Date }): InboundMessage {
    const msg: InboundMessage = {
      id: `msg-${this.messages.length + 1}`,
      subject: '',
      text: '',
      links: [],
      ...m,
    };
    this.messages.push(msg);
    return msg;
  }
  async search(q: { fromDomains: string[]; after: Date; subjectContains?: string }) {
    this.searches++;
    return this.messages.filter((m) => {
      return (
        domainAllowed(senderDomain(m.from), q.fromDomains) &&
        m.receivedAt.getTime() >= q.after.getTime() &&
        (!q.subjectContains || m.subject.toLowerCase().includes(q.subjectContains.toLowerCase()))
      );
    });
  }
}

export class FakePage implements PageLike {
  visited: string[] = [];
  typed: Array<{ selector: string; value: string }> = [];
  failScreenshot = false;
  /** A screenshot takes this long (ms); `shooting` is true while one is in flight. */
  screenshotDelayMs = 0;
  shooting = false;
  screenshots = 0;
  constructor(private current = 'about:blank') {}
  url() {
    return this.current;
  }
  async goto(url: string) {
    this.visited.push(url);
    this.current = url;
  }
  async screenshot() {
    if (this.failScreenshot) throw new Error('page closed');
    this.shooting = true;
    try {
      if (this.screenshotDelayMs) await new Promise((r) => setTimeout(r, this.screenshotDelayMs));
    } finally {
      this.shooting = false;
    }
    this.screenshots++;
    return PNG;
  }
  async fill(selector: string, value: string) {
    this.typed.push({ selector, value });
  }
  async press() {}
}

export class FakeBrowser implements BrowserLike {
  launches = 0;
  opened = 0;
  open = 0;
  maxOpen = 0;
  closed = 0;
  /** Contexts closed while one of their pages was still taking a screenshot. */
  closedMidScreenshot = 0;
  pages: FakePage[] = [];
  async newContext(): Promise<ContextLike> {
    this.opened++;
    this.open++;
    this.maxOpen = Math.max(this.maxOpen, this.open);
    let done = false;
    const mine: FakePage[] = [];
    return {
      newPage: async () => {
        const p = new FakePage();
        this.pages.push(p);
        mine.push(p);
        return p;
      },
      close: async () => {
        if (done) return;
        done = true;
        if (mine.some((p) => p.shooting)) this.closedMidScreenshot++;
        this.open--;
        this.closed++;
      },
    };
  }
}

export const FIELDS: FieldDescriptor[] = [
  {
    id: 'name',
    label: 'Full name',
    type: 'text',
    required: true,
    maxLength: null,
    classification: 'standard',
  },
  {
    id: 'resume',
    label: 'Resume',
    type: 'file',
    required: true,
    maxLength: null,
    classification: 'resume',
  },
  {
    id: 'why',
    label: 'Why do you want to work here?',
    type: 'textarea',
    required: false,
    maxLength: 500,
    classification: 'free-text',
  },
  {
    id: 'gender',
    label: 'Gender',
    type: 'select',
    required: false,
    maxLength: null,
    classification: 'self-identification',
  },
];

/** A scriptable adapter; every call is recorded in `calls`. */
export class FakeAdapter implements FormAdapter {
  ats: AtsId = 'greenhouse';
  calls: string[] = [];
  needsAccount = false;
  signedIn = false;
  signUps: Account[] = [];
  signIns: Credential[] = [];
  signInOutcome: SignInOutcome = 'ok';
  fieldList: FieldDescriptor[] = FIELDS;
  filled: Array<Record<string, unknown>> = [];
  attached = 0;
  submits = 0;
  confirmedAfterSubmit = true;
  /** The vendor page already shows the confirmation when it is loaded (a submit went through earlier). */
  confirmedOnLoad = false;
  fillError: Error | null = null;
  signUpError: Error | null = null;
  loadDelayMs = 0;
  loadError: Error | null = null;
  beforeSubmit: () => Promise<void> | void = () => {};
  /** Handed out by submit, in order (the last one repeats); empty means no trace. */
  traces: SubmitTrace[] = [];
  /** How many times the page shows an emailed-code prompt before it stops. */
  codePrompts = 0;
  advances = 0;
  /** Handed out by findCaptcha, in order; null entries mean "no challenge". */
  captchas: Array<CaptchaHandle | null> = [];
  /** After signUp the page still asks for an account (verification pending) until this is set. */
  verifiedAfterSignUp = true;
  private submitted = false;

  detect() {
    return true;
  }
  async load(_page: unknown, _url: string) {
    this.calls.push('load');
    if (this.loadDelayMs) await new Promise((r) => setTimeout(r, this.loadDelayMs));
    if (this.loadError) throw this.loadError;
  }
  async requiresAccount() {
    return this.needsAccount && !this.signedIn;
  }
  async signUp(_page: unknown, account: Account) {
    this.calls.push('signUp');
    this.signUps.push(account);
    if (this.signUpError) throw this.signUpError;
    if (this.verifiedAfterSignUp) this.signedIn = true;
  }
  async signIn(_page: unknown, credential: Credential): Promise<SignInOutcome> {
    this.calls.push('signIn');
    this.signIns.push(credential);
    if (this.signInOutcome === 'ok') this.signedIn = true;
    return this.signInOutcome;
  }
  async fields() {
    this.calls.push('fields');
    return this.fieldList;
  }
  async fill(_page: unknown, values: Record<string, unknown>) {
    this.calls.push('fill');
    if (this.fillError) throw this.fillError;
    this.filled.push(values);
  }
  async attachResume() {
    this.calls.push('attachResume');
    this.attached++;
  }
  async submit() {
    this.calls.push('submit');
    await this.beforeSubmit();
    this.submits++;
    this.submitted = true;
    return this.traces[Math.min(this.submits - 1, this.traces.length - 1)];
  }
  /** Visible validation errors on the page now (rule 41). */
  validationErrors: () => Promise<string[]> = async () => [];
  async codePrompt() {
    if (this.codePrompts <= 0) return false;
    this.codePrompts--;
    return true;
  }
  async advanceCode() {
    this.advances++;
  }
  async confirmed() {
    if (this.confirmedOnLoad) return true;
    return this.submitted && this.confirmedAfterSubmit;
  }
  async findCaptcha() {
    return this.captchas.shift() ?? null;
  }
}

/**
 * A challenge that clears only when the expected answer is entered. Like the vendors' widgets it
 * draws a new picture when a wrong answer is entered, and only then: taking screenshots never
 * changes the challenge, so a test can tell a re-send of a fresh picture from a re-send of the old one.
 */
export class FakeCaptcha implements CaptchaHandle {
  entered: string[] = [];
  shots = 0;
  /** Which picture is currently drawn; advances only on a wrong answer (or `refresh()`). */
  version = 1;
  constructor(public expected: string | (() => string)) {}
  refresh() {
    this.version++;
  }
  async screenshot() {
    this.shots++;
    return Buffer.concat([PNG, Buffer.from(`#${this.version}`)]);
  }
  async enter(answer: string) {
    this.entered.push(answer);
    if (!(await this.cleared())) this.refresh();
  }
  async cleared() {
    const want = typeof this.expected === 'function' ? this.expected() : this.expected;
    return this.entered.at(-1) === want;
  }
}

/**
 * An iframe challenge as the production handle models it (generic.ts findFrameCaptcha): the
 * challenge lives in a cross-origin frame, so `enter` does nothing, and it is cleared only by the
 * provider marking it solved (the response token), never by an answer typed by us.
 */
export class FrameCaptcha implements CaptchaHandle {
  readonly challenge = 'frame' as const;
  entered: string[] = [];
  shots = 0;
  /** Set from outside the handle: the person solved the challenge in the page. */
  solved = false;
  async screenshot() {
    this.shots++;
    return Buffer.concat([PNG, Buffer.from('#full-page')]);
  }
  async enter(answer: string) {
    this.entered.push(answer);
  }
  async cleared() {
    return this.solved;
  }
}

export interface TestDeps extends SubmissionDeps {
  adapter: FakeAdapter;
  browser: FakeBrowser;
  clock: FakeClock;
  gmailBox: MemoryGmail;
  sender: InMemorySender;
  followUps: Array<{ data: FollowUpJobData; startAfter: Date }>;
  tailorCalls: number;
  answerCalls: number;
}

export interface DepsOptions {
  adapter?: FakeAdapter;
  llm?: FakeLlm;
  tailor?: (calls: number) => TailorResult | Promise<TailorResult>;
  unsupported?: boolean;
  clock?: FakeClock;
  resolveAnswers?: SubmissionDeps['resolveAnswers'];
}

const GOOD_PDF = Buffer.from('%PDF-1.4\n%resume\n');

export function makeDeps(db: Db, opts: DepsOptions = {}): TestDeps {
  const adapter = opts.adapter ?? new FakeAdapter();
  const browser = new FakeBrowser();
  const clock = opts.clock ?? new FakeClock();
  const gmailBox = new MemoryGmail();
  const sender = new InMemorySender();
  const followUps: TestDeps['followUps'] = [];
  const deps: TestDeps = {
    adapter,
    browser,
    clock,
    gmailBox,
    sender,
    followUps,
    tailorCalls: 0,
    answerCalls: 0,
    async tailor(ctx) {
      deps.tailorCalls++;
      if (opts.tailor) return opts.tailor(deps.tailorCalls);
      const pdfKey = `tenants/${ctx.handle.tenantId}/applications/${ctx.application.id}/resume.pdf`;
      await putFile(ctx.handle, pdfKey, GOOD_PDF);
      return { ok: true, pdfKey, pageCount: 1, unmetRequirements: ['Rust'], regenerated: false };
    },
    async resolveAnswers(ctx, fields) {
      deps.answerCalls++;
      if (opts.resolveAnswers) return opts.resolveAnswers(ctx, fields);
      return fields.map((f) => {
        const base = { fieldId: f.id, question: f.label };
        if (f.classification === 'self-identification')
          return { ...base, status: 'skipped' as const, skipped: 'self-identification' as const };
        if (f.classification === 'resume')
          return {
            ...base,
            status: 'filled' as const,
            value: 'resume.pdf',
            source: 'profile' as const,
          };
        if (f.classification === 'free-text')
          return {
            ...base,
            status: 'filled' as const,
            value: 'Because the work is interesting.',
            source: 'generated' as const,
          };
        return {
          ...base,
          status: 'filled' as const,
          value: 'Mara Quill',
          source: 'profile' as const,
        };
      });
    },
    selectAdapter: () => (opts.unsupported ? null : adapter),
    launchBrowser: async () => {
      browser.launches++;
      return browser;
    },
    gmail: () => gmailBox,
    llm: opts.llm ?? new FakeLlm([{ answer: 'x' }]),
    sendMail: () => ({ sender, guards: [], store: new InMemoryOutgoingStore() }),
    followUp: {
      async enqueueFollowUp(data, startAfter) {
        // Idempotent per application, like the real queue.
        if (!followUps.some((f) => f.data.applicationId === data.applicationId))
          followUps.push({ data, startAfter });
      },
    },
    webOrigin: 'https://app.example.test',
  };
  void db;
  return deps;
}

export const newId = () => randomUUID();
