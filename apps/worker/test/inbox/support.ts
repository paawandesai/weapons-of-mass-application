import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { vi } from 'vitest';
import {
  createBlockedLogger,
  createOutgoingStore,
  getCompany,
  insertApplication,
  insertProfileVersion,
  setApprovedProfileVersion,
  updateApplication,
  upsertCompany,
  upsertJob,
  type ApplicationRow,
  type ApplicationStatus,
  type JobRow,
} from '@wma/db';
import { FakeLlm, type StructuredRequest } from '@wma/llm';
import { defaultGuards, InMemorySender, type InboxClassification } from '@wma/shared';
import profile from '../../../../packages/shared/test/fixtures/profile.full.json';
import { flagDigest } from '../../src/inbox/flags';
import type { InboxDeps } from '../../src/inbox/deps';
import {
  parseGmailMessage,
  type HistoryResult,
  type InboxGmailPort,
  type InboxMessage,
} from '../../src/inbox/gmail-reader';
import { setupEnv, type TestEnv, type TestTenant } from '../helpers';

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';
export const SLUG_PREFIX = `inboxtest-${Date.now()}`;

/** Fixed "now" for sync and follow-up runs. */
export const NOW = new Date('2026-03-20T12:00:00Z');

export interface InboxEnv extends TestEnv {
  owner: pg.Pool;
}

export async function setupInboxEnv(): Promise<InboxEnv> {
  const env = await setupEnv();
  const owner = new pg.Pool({ connectionString: ownerUrl });
  return {
    ...env,
    owner,
    async cleanup() {
      await env.cleanup(); // tenants first: jobs reference the shared companies
      await owner.query('delete from companies where board_slug like $1', [`${SLUG_PREFIX}%`]);
      await owner.end();
    },
  };
}

export async function approve(t: TestTenant): Promise<void> {
  const row = await insertProfileVersion(t.handle, {
    userId: t.userId,
    document: profile as never,
  });
  await setApprovedProfileVersion(t.handle, t.userId, row.version);
}

let counter = 0;

export interface Seed {
  application: ApplicationRow;
  job: JobRow;
  companyId: string;
  companyName: string;
  slug: string;
  /** The company's own mail domain (the board slug plus .com). */
  domain: string;
  title: string;
}

/** A company on a Greenhouse board, a posting on it, and an application in the given state. */
export async function seed(
  t: TestTenant,
  opts: {
    title?: string;
    companyName?: string;
    status?: ApplicationStatus;
    appliedAt?: Date | null;
    /** Reuse an existing company (same board) for a second role. */
    like?: Seed;
  } = {},
): Promise<Seed> {
  const n = ++counter;
  const slug = opts.like?.slug ?? `${SLUG_PREFIX}-${n}`;
  const companyName = opts.like?.companyName ?? opts.companyName ?? `Harbor Robotics ${n}`;
  const company = opts.like
    ? { id: opts.like.companyId }
    : await upsertCompany(t.handle, {
        name: companyName,
        ats: 'greenhouse',
        boardSlug: slug,
        createdBy: 'llm',
      });
  const title = opts.title ?? 'Staff Platform Engineer';
  const { job } = await upsertJob(t.handle, {
    companyId: company.id,
    ats: 'greenhouse',
    atsJobId: String(5000 + n),
    title,
    url: `https://boards.greenhouse.io/${slug}/jobs/${5000 + n}`,
  });
  const { application: created } = await insertApplication(t.handle, {
    userId: t.userId,
    jobId: job.id,
  });
  const application =
    (await updateApplication(t.handle, created.id, {
      status: opts.status ?? 'applied',
      appliedAt: opts.appliedAt === undefined ? new Date('2026-03-10T09:00:00Z') : opts.appliedAt,
    })) ?? created;
  const name = (await getCompany(t.handle, company.id))?.name ?? companyName;
  return {
    application,
    job,
    companyId: company.id,
    companyName: name,
    slug,
    domain: `${slug}.com`,
    title,
  };
}

export interface MessageFixture {
  id: string;
  threadId: string;
  date: string;
  from: string;
  subject: string;
  body: string;
  classification: InboxClassification;
  labelIds?: string[];
}

const fixturesDir = join(import.meta.dirname, '..', 'fixtures', 'inbox');

/** Loads a fictional recorded message and fills {{domain}}, {{title}} and {{company}}. */
export function fixture(
  name: string,
  s?: Pick<Seed, 'domain' | 'title' | 'companyName'>,
): MessageFixture {
  const text = readFileSync(join(fixturesDir, `${name}.json`), 'utf8');
  const filled = s
    ? text
        .replaceAll('{{domain}}', s.domain)
        .replaceAll('{{title}}', s.title)
        .replaceAll('{{company}}', s.companyName)
    : text;
  return JSON.parse(filled) as MessageFixture;
}

export function loadRaw(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'));
}

/** A fixture as the Gmail API returns it (`format=full`, base64url bodies). */
export function toRawGmail(f: MessageFixture, overrides: Partial<MessageFixture> = {}) {
  const m = { ...f, ...overrides };
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds ?? ['INBOX', 'UNREAD'],
    internalDate: String(new Date(m.date).getTime()),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: m.from },
        { name: 'To', value: 'mara@example.test' },
        { name: 'Subject', value: m.subject },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from(m.body).toString('base64url') } },
      ],
    },
  };
}

export const message = (f: MessageFixture, o: Partial<MessageFixture> = {}): InboxMessage =>
  parseGmailMessage(toRawGmail(f, o))!;

/** A mailbox in memory: serves messages through the same parser the real port uses. */
export class FakeInboxGmail implements InboxGmailPort {
  readonly messages = new Map<string, InboxMessage>();
  readonly fetched: string[] = [];
  readonly calls: string[] = [];
  historyId = 'h-100';
  /** Ids the next history listing reports; consumed by listHistory. */
  history: string[] = [];
  expired = false;
  fail: Error | null = null;
  threads = new Map<string, InboxMessage[]>();
  onGetMessage: (id: string, fetched: number) => Promise<void> | void = () => {};

  add(m: InboxMessage, opts: { inHistory?: boolean } = {}) {
    this.messages.set(m.id, m);
    this.threads.set(m.threadId, [...(this.threads.get(m.threadId) ?? []), m]);
    if (opts.inHistory !== false) this.history.push(m.id);
  }

  async currentHistoryId() {
    this.calls.push('currentHistoryId');
    if (this.fail) throw this.fail;
    return this.historyId;
  }
  async listHistory(startHistoryId: string): Promise<HistoryResult> {
    this.calls.push(`listHistory:${startHistoryId}`);
    if (this.fail) throw this.fail;
    if (this.expired) return { expired: true };
    const messageIds = this.history.splice(0);
    return { expired: false, messageIds, historyId: this.historyId };
  }
  async listSince(after: Date) {
    this.calls.push(`listSince:${after.toISOString()}`);
    if (this.fail) throw this.fail;
    return [...this.messages.values()].filter((m) => m.receivedAt >= after).map((m) => m.id);
  }
  async getMessage(id: string) {
    this.calls.push(`getMessage:${id}`);
    if (this.fail) throw this.fail;
    this.fetched.push(id);
    await this.onGetMessage(id, this.fetched.length);
    return this.messages.get(id) ?? null;
  }
  async getThread(threadId: string) {
    this.calls.push(`getThread:${threadId}`);
    if (this.fail) throw this.fail;
    return this.threads.get(threadId) ?? [];
  }
}

/** A 401 as googleapis raises it. */
export function authError(): Error {
  const raw = loadRaw('auth-401') as { code: number; message: string };
  return Object.assign(new Error(raw.message), { code: raw.code });
}

export interface Answers {
  /** What `inbox-link` returns; a function sees the candidate ids in the prompt. */
  link?: (request: StructuredRequest) => string | null;
  /** Classification by subject text found in the prompt; unknown subjects get `other`. */
  classify: Record<string, InboxClassification>;
}

/** FakeLlm that answers both inbox prompts from recorded outputs. */
export function inboxLlm(answers: Answers) {
  return new FakeLlm([
    (request: StructuredRequest) => {
      if (request.prompt === 'inbox-link/v1') {
        return { application_id: answers.link ? answers.link(request) : null };
      }
      const hit = Object.entries(answers.classify).find(([subject]) =>
        request.user.includes(subject),
      );
      return (
        hit?.[1] ?? {
          classification: 'other',
          compensation_flag: false,
          booking_link: null,
          proposed_slots: [],
          confirmed_slot: null,
        }
      );
    },
  ]);
}

export function classifyAnswers(
  ...fixtures: MessageFixture[]
): Record<string, InboxClassification> {
  return Object.fromEntries(fixtures.map((f) => [f.subject, f.classification]));
}

export function makeDeps(gmail: FakeInboxGmail, llm: FakeLlm, sender = new InMemorySender()) {
  const offerSlots = vi.fn(async (..._args: unknown[]) => ({
    send: { interviewId: 'interview-1', issued: [] } as {
      interviewId: string;
      issued: unknown;
    } | null,
  }));
  const sendOfferEmail = vi.fn(async (..._args: unknown[]) => undefined);
  const recordConfirmedInterview = vi.fn(async (..._args: unknown[]) => ({
    interviewId: null as string | null,
  }));
  const deps: InboxDeps = {
    gmail: () => gmail,
    llm,
    mail: (handle, userId) => ({
      sender,
      guards: defaultGuards,
      store: createOutgoingStore(handle, userId),
      onBlocked: createBlockedLogger(handle, userId),
    }),
    recordOffer: offerSlots,
    recordConfirmedInterview,
    sendOfferEmail,
    resendPendingConfirmations: vi.fn(async () => 0),
    requeueUnbookedInterviews: vi.fn(async () => 0),
    flagDigest,
    clock: { now: () => NOW },
  };
  return { deps, offerSlots, recordConfirmedInterview, sendOfferEmail, sender };
}
