import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  confirmSlotByTokenHash,
  getInterview,
  insertApplication,
  upsertCompany,
  upsertEmailThread,
  upsertJob,
  type ApplicationRow,
  type EmailThreadRow,
  type TenantHandle,
} from '@wma/db';
import {
  defaultGuards,
  InMemoryOutgoingStore,
  InMemorySender,
  type ContentGuard,
  type OutgoingEmail,
  type ProposedSlot,
} from '@wma/shared';
import type {
  BusyInterval,
  CalendarEventInput,
  CalendarPort,
  MailboxPort,
  ReplyContext,
  SchedulingDeps,
} from '../../src/scheduling/types';
import { setupEnv, type TestEnv, type TestTenant } from '../helpers';

export const NOW = new Date();
export const WEB = 'https://app.example.test';
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const companyTag = `schedtest-${Date.now()}`;

export interface SchedulingTestEnv extends TestEnv {
  owner: pg.Pool;
}

export async function setupSchedulingEnv(): Promise<SchedulingTestEnv> {
  const env = await setupEnv();
  const owner = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test',
  });
  const cleanup = env.cleanup;
  return {
    ...env,
    owner,
    async cleanup() {
      await cleanup();
      await owner.query('delete from companies where name like $1', [`${companyTag}%`]);
      await owner.end();
    },
  };
}

export class FakeCalendar implements CalendarPort {
  busyIntervals: BusyInterval[] = [];
  failBusy: unknown = false;
  /** Number of createEvent calls that fail before one succeeds. */
  failCreates = 0;
  /** Number of createEvent calls that store the event and then lose the response (throw). */
  loseResponses = 0;
  /** When set, updateEvent throws it. */
  failUpdate: unknown = null;
  /** When set, createEvent throws it (an authentication error, say). */
  createError: unknown = null;
  busyCalls = 0;
  /** Events by id: create is get-or-create, like Google with a client-supplied id. */
  readonly events = new Map<string, CalendarEventInput & { id: string }>();
  readonly created: Array<CalendarEventInput & { id: string }> = [];
  readonly updated: Array<CalendarEventInput & { id: string }> = [];

  async busy(): Promise<BusyInterval[]> {
    this.busyCalls++;
    if (this.failBusy)
      throw this.failBusy instanceof Error ? this.failBusy : new Error('calendar down');
    return this.busyIntervals;
  }
  async createEvent(event: CalendarEventInput) {
    if (this.createError) throw this.createError;
    if (this.failCreates > 0) {
      this.failCreates--;
      throw new Error('calendar write failed');
    }
    const id = event.id ?? `evt-${this.events.size + 1}`;
    if (this.events.has(id)) {
      this.events.set(id, { ...event, id });
      this.updated.push({ ...event, id });
    } else {
      this.events.set(id, { ...event, id });
      this.created.push({ ...event, id });
    }
    if (this.loseResponses > 0) {
      this.loseResponses--;
      throw new Error('response lost');
    }
    return { id };
  }
  async updateEvent(id: string, event: CalendarEventInput) {
    if (this.failUpdate) throw this.failUpdate;
    this.events.set(id, { ...event, id });
    this.updated.push({ ...event, id });
  }
  get touched() {
    return this.busyCalls + this.created.length + this.updated.length;
  }
}

export class FakeMailbox implements MailboxPort {
  calls = 0;
  context: ReplyContext = {
    to: 'recruiter@acme.example',
    subject: 'Re: Interview for Staff Engineer',
    fromName: 'Dana Recruiter',
    inReplyTo: '<msg-1@acme.example>',
    references: '<msg-1@acme.example>',
  };
  async replyContext() {
    this.calls++;
    return this.context;
  }
}

export interface Harness {
  deps: SchedulingDeps;
  calendar: FakeCalendar;
  mailbox: FakeMailbox;
  sender: InMemorySender;
  store: InMemoryOutgoingStore;
  reminders: string[];
  setGuards(g: ContentGuard[]): void;
  /** Mail that went to anyone but the user. */
  toRecruiter(email: string): OutgoingEmail[];
}

export function makeHarness(): Harness {
  const calendar = new FakeCalendar();
  const mailbox = new FakeMailbox();
  const sender = new InMemorySender();
  const store = new InMemoryOutgoingStore();
  const reminders: string[] = [];
  const mail = { sender, guards: defaultGuards, store };
  return {
    calendar,
    mailbox,
    sender,
    store,
    reminders,
    deps: {
      clock: { now: () => NOW },
      calendar,
      mailbox,
      mail,
      webOrigin: WEB,
      scheduleReminders: async (_h, id) => {
        reminders.push(id);
      },
    },
    setGuards(g) {
      mail.guards = g;
    },
    toRecruiter: (email) => sender.sent.filter((m) => m.to !== email),
  };
}

export interface Seeded {
  t: TestTenant;
  application: ApplicationRow;
  thread: EmailThreadRow;
  companyName: string;
}

/** An applied application at a company, with a linked interview thread. */
export async function seedThread(
  env: TestEnv,
  opts: { title?: string; companyName?: string } = {},
): Promise<Seeded> {
  const t = await env.makeTenant();
  const companyName = opts.companyName ?? `${companyTag}-Acme`;
  const company = await upsertCompany(t.handle, { name: companyName, createdBy: 'user' });
  const { job } = await upsertJob(t.handle, {
    companyId: company.id,
    title: opts.title ?? 'Staff Engineer',
    url: `https://jobs.example.test/${randomBytes(6).toString('hex')}`,
  });
  const { application } = await insertApplication(t.handle, {
    userId: t.userId,
    jobId: job.id,
    status: 'applied',
  });
  const thread = await upsertEmailThread(t.handle, {
    userId: t.userId,
    gmailThreadId: `thr-${randomBytes(6).toString('hex')}`,
    kind: 'interview',
    applicationId: application.id,
  });
  return { t, application, thread, companyName };
}

export const proposed = (start: string, over: Partial<ProposedSlot> = {}): ProposedSlot => ({
  start,
  end: null,
  tz_hint: null,
  ambiguous: false,
  ...over,
});

/** Three clean options on 12-14 Nov 2037 at 10:00 Pacific. */
export const threeSlots = () => [
  proposed('2037-11-12T10:00:00-08:00'),
  proposed('2037-11-13T10:00:00-08:00'),
  proposed('2037-11-14T10:00:00-08:00'),
];

export const offerInput = (s: Seeded, slots: ProposedSlot[], compensationFlag = false) => ({
  userId: s.t.userId,
  applicationId: s.application.id,
  threadId: s.thread.id,
  messageId: 'gmail-msg-1',
  slots,
  compensationFlag,
});

/** The tokens in a confirmation email, in the order they were listed. */
export function tokensIn(email: OutgoingEmail): string[] {
  return [...email.text.matchAll(/\/confirm\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
}

export const confirmToken = (handle: TenantHandle, token: string) =>
  confirmSlotByTokenHash(handle, sha256(token));

export const interviewOf = (handle: TenantHandle, id: string) => getInterview(handle, id);
