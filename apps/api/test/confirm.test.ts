import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  activity,
  getInterview,
  insertApplication,
  insertInterview,
  insertInterviewSlot,
  listSlotsForInterview,
  upsertCompany,
  upsertEmailThread,
  upsertJob,
} from '@wma/db';
import type { AppEnv } from '../src/middleware/session';
import { createConfirmRoutes } from '../src/routes/confirm';
import { BOOK_QUEUE_OPTIONS, type BookingQueue } from '../src/services/confirm';
import { setupEnv, type TestEnv, type TestTenant } from './support';

let env: TestEnv;
let owner: pg.Pool;
const companyTag = `confirmtest-${Date.now()}`;
beforeAll(async () => {
  env = await setupEnv();
  owner = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test',
  });
});
afterAll(async () => {
  await env.cleanup();
  await owner.query('delete from companies where name like $1', [`${companyTag}%`]);
  await owner.end();
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const now = () => new Date();

function makeQueue() {
  const calls: Array<{ interviewId: string; slotId: string }> = [];
  const reminderCalls: Array<{ interviewId: string; slotId: string }> = [];
  const queue: BookingQueue = {
    async enqueueBookInterview(data, slotId) {
      calls.push({ interviewId: data.interviewId, slotId });
    },
    async enqueueScheduleReminders(data, slotId) {
      reminderCalls.push({ interviewId: data.interviewId, slotId });
    },
  };
  return { queue, calls, reminderCalls };
}

const appWith = (queue: BookingQueue) => {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('db', env.db);
    c.set('now', now);
    await next();
  });
  a.route('/confirm', createConfirmRoutes({ queue }));
  return a;
};

const post = (path: string) => ({ path, init: { method: 'POST' } });

/** An interview with one open slot per entry in `hours` (each a day apart), tokens returned. */
async function seed(
  t: TestTenant,
  opts: { count?: number; ttlSeconds?: number; startsInMs?: number; at?: Date[] } = {},
) {
  const company = await upsertCompany(t.handle, { name: `${companyTag}-Acme`, createdBy: 'user' });
  const { job } = await upsertJob(t.handle, {
    companyId: company.id,
    title: 'Staff Engineer',
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
  const { interview } = await insertInterview(t.handle, {
    userId: t.userId,
    applicationId: application.id,
    threadId: thread.id,
  });
  const base = Date.now() + (opts.startsInMs ?? 3 * 86_400_000);
  const tokens: string[] = [];
  for (let i = 0; i < (opts.at?.length ?? opts.count ?? 3); i++) {
    const tok = token();
    tokens.push(tok);
    const startsAt = opts.at?.[i] ?? new Date(base + i * 86_400_000);
    await insertInterviewSlot(t.handle, {
      interviewId: interview.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      tokenHash: sha256(tok),
      ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
    });
  }
  return { interview, tokens, application };
}

describe('GET/POST /confirm/:token', () => {
  it('GET shows the slot with a POST button and never confirms', async () => {
    const t = await env.makeTenant();
    const { interview, tokens } = await seed(t);
    const { queue, calls } = makeQueue();
    const app = appWith(queue);
    for (let i = 0; i < 3; i++) {
      const res = await app.request(`/confirm/${tokens[0]}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Staff Engineer');
      expect(html).toContain(`${companyTag}-Acme`);
      expect(html).toContain('<form method="post">');
    }
    const row = await getInterview(t.handle, interview.id);
    expect(row?.confirmedSlotId).toBeNull();
    expect(row?.confirmedAt).toBeNull();
    expect(calls).toHaveLength(0);
    const slots = await listSlotsForInterview(t.handle, interview.id);
    expect(slots.every((s) => !s.confirmedAt && !s.invalidatedAt)).toBe(true);
  });

  it('POST confirms once, records the slot and queues the booking', async () => {
    const t = await env.makeTenant();
    const { interview, tokens } = await seed(t);
    const { queue, calls } = makeQueue();
    const app = appWith(queue);
    const first = await app.request(`/confirm/${tokens[1]}`, post('').init);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('You are confirmed');
    const row = await getInterview(t.handle, interview.id);
    const slots = await listSlotsForInterview(t.handle, interview.id);
    const chosen = slots.find((s) => s.confirmedAt);
    expect(chosen?.tokenHash).toBe(sha256(tokens[1]!));
    expect(row?.confirmedSlotId).toBe(chosen?.id);
    expect(row?.startsAt?.getTime()).toBe(chosen?.startsAt.getTime());
    expect(calls).toEqual([{ interviewId: interview.id, slotId: chosen!.id }]);
    const log = await activity.listByUser(t.handle, t.userId);
    expect(log.filter((e) => e.action === 'slot_confirmed')).toHaveLength(1);

    const again = await app.request(`/confirm/${tokens[1]}`, post('').init);
    expect(again.status).toBe(410);
    expect(await again.text()).toContain('already confirmed');
    expect(calls).toHaveLength(1);
  });

  it('invalidates the sibling links when one is confirmed', async () => {
    const t = await env.makeTenant();
    const { interview, tokens } = await seed(t);
    const { queue, calls } = makeQueue();
    const app = appWith(queue);
    expect((await app.request(`/confirm/${tokens[0]}`, post('').init)).status).toBe(200);
    for (const tok of tokens.slice(1)) {
      expect((await app.request(`/confirm/${tok}`)).status).toBe(410);
      expect((await app.request(`/confirm/${tok}`, post('').init)).status).toBe(410);
    }
    const slots = await listSlotsForInterview(t.handle, interview.id);
    expect(slots.filter((s) => s.confirmedAt)).toHaveLength(1);
    expect(slots.filter((s) => s.invalidatedAt)).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it('an expired link is 410 and writes nothing', async () => {
    const t = await env.makeTenant();
    const { interview, tokens } = await seed(t, { count: 1, ttlSeconds: -60 });
    const { queue, calls } = makeQueue();
    const app = appWith(queue);
    expect((await app.request(`/confirm/${tokens[0]}`)).status).toBe(410);
    const res = await app.request(`/confirm/${tokens[0]}`, post('').init);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('expired');
    expect((await getInterview(t.handle, interview.id))?.confirmedSlotId).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('a token from another tenant, an unknown token and a malformed one are 410 and change nothing', async () => {
    const a = await env.makeTenant();
    const b = await env.makeTenant();
    const seeded = await seed(a, { count: 1 });
    const { queue, calls } = makeQueue();
    const app = appWith(queue);
    // Tenant B cannot confirm tenant A's slot even with its token hash in hand.
    const { confirmSlotByTokenHash } = await import('@wma/db');
    expect(await confirmSlotByTokenHash(b.handle, sha256(seeded.tokens[0]!))).toEqual({
      ok: false,
      reason: 'no_longer_open',
    });
    for (const tok of [token(), 'short', 'a'.repeat(200)]) {
      expect((await app.request(`/confirm/${tok}`)).status).toBe(410);
      expect((await app.request(`/confirm/${tok}`, post('').init)).status).toBe(410);
    }
    const row = await getInterview(a.handle, seeded.interview.id);
    expect(row?.confirmedSlotId).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('still confirms when the queue is down and logs it for the repair pass', async () => {
    const t = await env.makeTenant();
    const { interview, tokens } = await seed(t, { count: 1 });
    const queue: BookingQueue = {
      enqueueBookInterview: vi.fn().mockRejectedValue(new Error('down')),
      enqueueScheduleReminders: vi.fn().mockResolvedValue(undefined),
    };
    const res = await appWith(queue).request(`/confirm/${tokens[0]}`, post('').init);
    expect(res.status).toBe(200);
    expect((await getInterview(t.handle, interview.id))?.confirmedSlotId).not.toBeNull();
    const log = await activity.listByUser(t.handle, t.userId);
    expect(log.some((e) => e.action === 'book_enqueue_failed')).toBe(true);
  });

  it('queues the reminders from the confirmation itself, and a lost reminder enqueue does not cost the booking', async () => {
    const t = await env.makeTenant();
    const { interview, tokens } = await seed(t, { count: 2 });
    const { queue, calls, reminderCalls } = makeQueue();
    const res = await appWith(queue).request(`/confirm/${tokens[0]}`, post('').init);
    expect(res.status).toBe(200);
    expect(reminderCalls).toEqual([{ interviewId: interview.id, slotId: expect.any(String) }]);
    expect(calls).toHaveLength(1);

    const t2 = await env.makeTenant();
    const second = await seed(t2, { count: 1 });
    const book = vi.fn().mockResolvedValue(undefined);
    const broken: BookingQueue = {
      enqueueBookInterview: book,
      enqueueScheduleReminders: vi.fn().mockRejectedValue(new Error('down')),
    };
    expect(
      (await appWith(broken).request(`/confirm/${second.tokens[0]}`, post('').init)).status,
    ).toBe(200);
    expect(book).toHaveBeenCalledTimes(1);
    const log = await activity.listByUser(t2.handle, t2.userId);
    expect(log.find((e) => e.action === 'book_enqueue_failed')?.detail).toMatchObject({
      failed: ['reminders'],
    });
  });

  it('refuses a slot whose time has already started (database clock): GET and POST are 410, nothing is written', async () => {
    const t = await env.makeTenant();
    const { interview, tokens } = await seed(t, { startsInMs: -2 * 3_600_000, count: 1 });
    const { queue, calls, reminderCalls } = makeQueue();
    const app = appWith(queue);
    const get = await app.request(`/confirm/${tokens[0]}`);
    expect(get.status).toBe(410);
    expect(await get.text()).toContain('already started');
    const res = await app.request(`/confirm/${tokens[0]}`, post('').init);
    expect(res.status).toBe(410);
    const row = await getInterview(t.handle, interview.id);
    expect(row?.confirmedSlotId).toBeNull();
    expect(row?.confirmedGeneration).toBe(0);
    expect(calls).toHaveLength(0);
    expect(reminderCalls).toHaveLength(0);
  });

  it('each confirmation moves the interview to a new confirmed generation', async () => {
    const t = await env.makeTenant();
    const { interview, tokens } = await seed(t, { count: 1 });
    const { queue } = makeQueue();
    await appWith(queue).request(`/confirm/${tokens[0]}`, post('').init);
    expect((await getInterview(t.handle, interview.id))?.confirmedGeneration).toBe(1);
  });

  it('shows both offsets for a slot that crosses a DST transition (fall back)', async () => {
    const t = await env.makeTenant();
    // 2026-11-01 01:30 PDT (08:30Z) to 01:30 PST (09:30Z) in America/Los_Angeles; far in the future relative to the DB clock is not needed: use a future year.
    const start = new Date('2031-11-02T08:30:00Z'); // 01:30 PDT on the 2031 fall-back day
    const { tokens } = await seed(t, { at: [start], count: 1 });
    const res = await appWith(makeQueue().queue).request(`/confirm/${tokens[0]}`);
    expect(res.status).toBe(200);
    const html = (await res.text()).replace(/\u202f/g, ' ');
    expect(html).toContain('1:30 AM PDT (GMT-7) to 1:30 AM PST (GMT-8)');
  });

  it('uses the same exclusive queue options as the worker', () => {
    expect(BOOK_QUEUE_OPTIONS.policy).toBe('exclusive');
  });
});
