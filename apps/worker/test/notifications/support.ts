import {
  createBlockedLogger,
  createOutgoingStore,
  insertInterview,
  updateInterview,
  upsertEmailThread,
  type InterviewRow,
  type TenantHandle,
} from '@wma/db';
import {
  InMemoryOutgoingStore,
  InMemorySender,
  defaultGuards,
  type OutgoingStore,
} from '@wma/shared';
import type { NotificationDeps } from '../../src/notifications/deps';
import type { NotificationQueue, QueueSendOptions } from '../../src/notifications/queue';
import { approveProfile, seedApplication, type Seeded } from '../submission/support';
import type { TestTenant } from '../helpers';

export { approveProfile, seedApplication };

export class Clock {
  private t: number;
  constructor(start: Date) {
    this.t = start.getTime();
  }
  now = () => new Date(this.t);
  set(d: Date) {
    this.t = d.getTime();
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export interface FakeJob {
  id: string;
  job: string;
  data: Record<string, unknown>;
  opts: QueueSendOptions;
  state: 'queued' | 'active' | 'cancelled' | 'done';
}

/**
 * A queue with pg-boss's exclusive-policy semantics: one queued OR active job per singleton key.
 * `cancelByKey` reaches queued jobs only, as pg-boss's cancel does for a job that already started.
 */
export class FakeQueue implements NotificationQueue {
  readonly jobs: FakeJob[] = [];
  async send(job: string, data: object, opts: QueueSendOptions) {
    if (
      this.jobs.some(
        (j) =>
          j.job === job &&
          j.opts.singletonKey === opts.singletonKey &&
          (j.state === 'queued' || j.state === 'active'),
      )
    ) {
      return null;
    }
    const id = `job-${this.jobs.length + 1}`;
    this.jobs.push({ id, job, data: data as Record<string, unknown>, opts, state: 'queued' });
    return id;
  }
  async cancelByKey(job: string, singletonKey: string) {
    let n = 0;
    for (const j of this.jobs) {
      if (j.job === job && j.opts.singletonKey === singletonKey && j.state === 'queued') {
        j.state = 'cancelled';
        n++;
      }
    }
    return n;
  }
  /** A worker picks the queued job up: it is now running and still holds its singleton key. */
  activate(job: string, singletonKey: string) {
    const j = this.jobs.find(
      (x) => x.job === job && x.opts.singletonKey === singletonKey && x.state === 'queued',
    );
    if (!j) throw new Error(`no queued ${job} job with key ${singletonKey}`);
    j.state = 'active';
    return j;
  }
  /** The running job finished and releases its key. */
  complete(id: string) {
    const j = this.jobs.find((x) => x.id === id);
    if (j) j.state = 'done';
  }
  queued(job?: string) {
    return this.jobs.filter((j) => j.state === 'queued' && (!job || j.job === job));
  }
  /** Queued jobs whose start time has arrived at `now`; marks them done. */
  takeDue(job: string, now: Date) {
    const due = this.queued(job).filter((j) => !j.opts.startAfter || j.opts.startAfter <= now);
    for (const j of due) j.state = 'done';
    return due;
  }
}

export interface TestNotificationDeps extends NotificationDeps {
  clock: Clock;
  queue: FakeQueue;
  sender: InMemorySender;
  /** Present when built with `store: 'memory'`. */
  memory?: InMemoryOutgoingStore;
  failSend: { on: boolean };
  /** Runs inside the send, after the message was composed and before Gmail accepts it. */
  beforeSend: { run: (() => Promise<void>) | null };
}

export function makeDeps(
  start: Date,
  opts: { store?: 'memory' | 'db'; guards?: boolean } = {},
): TestNotificationDeps {
  const clock = new Clock(start);
  const queue = new FakeQueue();
  const sender = new InMemorySender();
  const failSend = { on: false };
  const beforeSend: { run: (() => Promise<void>) | null } = { run: null };
  const memory = opts.store === 'db' ? undefined : new InMemoryOutgoingStore();
  const deps: TestNotificationDeps = {
    clock,
    queue,
    sender,
    memory,
    failSend,
    beforeSend,
    now: clock.now,
    webOrigin: 'https://app.example.test',
    mail: (handle: TenantHandle, userId: string) => {
      const store: OutgoingStore = memory ?? createOutgoingStore(handle, userId);
      return {
        sender: {
          send: async (email) => {
            if (failSend.on) throw new Error('gmail unavailable');
            await beforeSend.run?.();
            return sender.send(email);
          },
        },
        // What a Gmail "sent" search would find: only messages the fake sender accepted.
        lookup: {
          find: async (q) => {
            const i = sender.sent.findIndex(
              (m) => m.subject === q.subject && [m.to].flat().join(', ') === q.to,
            );
            return i >= 0 ? { messageId: `mem-${i + 1}` } : null;
          },
        },
        guards: opts.guards === false ? [] : defaultGuards,
        store,
        onBlocked: createBlockedLogger(handle, userId),
      };
    },
  };
  return deps;
}

/** A thread, an interview and (optionally) a confirmed slot time for an application. */
export async function seedInterview(
  t: TestTenant,
  s: Seeded,
  opts: { startsAt?: Date; confirmed?: boolean; prepReady?: boolean } = {},
): Promise<InterviewRow> {
  const thread = await upsertEmailThread(t.handle, {
    userId: t.userId,
    gmailThreadId: `thr-${s.application.id}`,
    kind: 'interview',
    applicationId: s.application.id,
  });
  const { interview } = await insertInterview(t.handle, {
    userId: t.userId,
    applicationId: s.application.id,
    threadId: thread.id,
  });
  if (!opts.startsAt) return interview;
  const confirmed = opts.confirmed ?? true;
  return (await updateInterview(t.handle, interview.id, {
    startsAt: opts.startsAt,
    endsAt: new Date(opts.startsAt.getTime() + 3_600_000),
    ...(confirmed ? { confirmedAt: new Date() } : {}),
    ...(opts.prepReady ? { prepPlanStatus: 'ready' as const, prepPlan: 'plan' } : {}),
  }))!;
}

export const plain = (s: string) => s.replace(/\u202f/g, ' ');
