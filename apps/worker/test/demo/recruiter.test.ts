import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getDemoMessage,
  insertOutgoingMessage,
  listDemoMessages,
  upsertCompany,
  upsertJob,
  type DemoMailboxMessageRow,
} from '@wma/db';
import { createDemoSender } from '../../src/demo/ports';
import {
  acceptedSlot,
  proposeSlots,
  recruiterIdentity,
  runSimulatedRecruiter,
  SIMULATED_HEADER,
  SLOTS_HEADER,
  type ProposedTime,
} from '../../src/demo/recruiter';
import { formatSlot } from '../../src/scheduling/slots';
import { runSimulatedRecruiterTick } from '../../src/jobs/simulated-recruiter';
import { appliedTo, MONEY, setupDemoEnv, type DemoEnv } from './support';

let env: DemoEnv;
let userId: string;
beforeAll(async () => {
  env = await setupDemoEnv();
  userId = env.summary.userId;
});
afterAll(async () => {
  await env.cleanup();
});

const mailbox = () => listDemoMessages(env.handle, userId);
const slotsOf = (m: DemoMailboxMessageRow): ProposedTime[] =>
  (
    JSON.parse((m.headers as Record<string, string>)[SLOTS_HEADER]!) as Array<{
      start: string;
      end: string;
    }>
  ).map((s) => ({ start: new Date(s.start), end: new Date(s.end) }));

describe('identity and slots', () => {
  it('gives a company one stable recruiter address <first>.<last>@<company-slug>.example', () => {
    const a = recruiterIdentity('Harbor Robotics', 'harbor-robotics');
    expect(a).toEqual(recruiterIdentity('Harbor Robotics', 'harbor-robotics'));
    expect(a.address).toMatch(/^[a-z]+\.[a-z]+@harbor-robotics\.example$/);
    expect(a.address).toBe(`${a.first}.${a.last}@harbor-robotics.example`.toLowerCase());
  });

  it('proposes three upcoming weekdays', () => {
    const slots = proposeSlots(new Date('2026-11-06T20:00:00Z'), 'America/Los_Angeles');
    expect(slots).toHaveLength(3);
    for (const s of slots) {
      expect(s.start.getTime()).toBeGreaterThan(Date.parse('2026-11-08T20:00:00Z') - 86_400_000);
      const day = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        weekday: 'short',
      }).format(s.start);
      expect(['Sat', 'Sun']).not.toContain(day);
    }
    expect(new Set(slots.map((s) => s.start.getTime())).size).toBe(3);
  });
});

describe('proposal on applied', () => {
  it('delivers one marked three-slot proposal for a seeded job, and only once', async () => {
    const job = await env.jobsByTitle('Staff Platform Engineer');
    const app = await appliedTo(env.handle, userId, job.id);
    const r1 = await runSimulatedRecruiter(env.handle, userId, { delayMs: 0 });
    const r2 = await runSimulatedRecruiter(env.handle, userId, { delayMs: 0 });
    expect(r1.delivered.map((d) => [d.kind, d.applicationId])).toEqual([['proposal', app.id]]);
    expect(r2.delivered).toEqual([]);
    const msgs = (await mailbox()).filter((m) => m.threadId === `sim-thread-${app.id}`);
    expect(msgs).toHaveLength(1);
    const m = msgs[0]!;
    expect(m.fromAddress).toBe(recruiterIdentity('Harbor Robotics', 'harbor-robotics').address);
    expect(m.fromName).toBeTruthy();
    expect((m.headers as Record<string, string>)[SIMULATED_HEADER]).toBe('1');
    expect(m.labelIds).toEqual(['INBOX']);
    expect(m.subject).toContain('Staff Platform Engineer');
    expect(m.bodyText.match(/^- /gm)).toHaveLength(3);
    expect(slotsOf(m)).toHaveLength(3);
    expect(MONEY.test(`${m.subject}\n${m.bodyText}`)).toBe(false);
  });

  it('waits for the configured delay', async () => {
    const job = await env.jobsByTitle('Senior Backend Engineer');
    const appliedAt = new Date('2026-11-06T12:00:00Z');
    const app = await appliedTo(env.handle, userId, job.id, appliedAt);
    const at = (s: number) => ({ now: () => new Date(appliedAt.getTime() + s * 1000) });
    const early = await runSimulatedRecruiter(env.handle, userId, {
      delayMs: 60_000,
      clock: at(30),
    });
    expect(early.delivered.filter((d) => d.applicationId === app.id)).toEqual([]);
    const forced = await runSimulatedRecruiter(env.handle, userId, {
      delayMs: 60_000,
      clock: at(30),
      immediate: true,
    });
    expect(forced.delivered.map((d) => d.applicationId)).toContain(app.id);
  });

  it('sends nothing for a job that is not seeded, even on a demo tenant', async () => {
    const company = await upsertCompany(env.handle, { name: 'Plain Co', createdBy: 'user' });
    const { job } = await upsertJob(env.handle, {
      companyId: company.id,
      title: 'Unseeded Engineer',
      url: 'https://jobs.example.test/unseeded-1',
    });
    const app = await appliedTo(env.handle, userId, job.id);
    const r = await runSimulatedRecruiter(env.handle, userId, { delayMs: 0 });
    expect(r.delivered.map((d) => d.applicationId)).not.toContain(app.id);
    expect(await getDemoMessage(env.handle, `sim-proposal-${app.id}`)).toBeNull();
  });

  it('does nothing at all for a tenant without the demo flag', async () => {
    const real = await env.makeTenant();
    const company = await upsertCompany(real.handle, { name: 'Real Co', createdBy: 'user' });
    const { job } = await upsertJob(real.handle, {
      companyId: company.id,
      title: 'Real Engineer',
      url: 'https://jobs.example.test/real-1',
    });
    // Even a posting marked seeded is ignored: the tenant flag is what gates the recruiter.
    await env.owner.query('update jobs set seeded = true where id = $1', [job.id]);
    const app = await appliedTo(real.handle, real.userId, job.id);
    const r = await runSimulatedRecruiter(real.handle, real.userId, { delayMs: 0 });
    expect(r).toEqual({ skipped: 'not_demo', delivered: [] });
    expect(await getDemoMessage(real.handle, `sim-proposal-${app.id}`)).toBeNull();
    const n = await env.owner.query(
      'select count(*)::int as n from demo_mailbox_messages where tenant_id = $1',
      [real.id],
    );
    expect(n.rows[0].n).toBe(0);
  });
});

/** The user's recruiter_reply as the booking step leaves it: a SENT message plus its outgoing row. */
async function userReplies(threadId: string, applicationId: string, body: string) {
  const sender = createDemoSender(env.handle, userId);
  const sent = await sender.send({
    userId,
    kind: 'recruiter_reply',
    applicationId,
    to: 'x@y.example',
    subject: 'Re: Interview',
    html: '',
    text: body,
    threadId,
  });
  return insertOutgoingMessage(env.handle, {
    userId,
    applicationId,
    kind: 'recruiter_reply',
    toAddress: 'x@y.example',
    subject: 'Re: Interview',
    bodyText: body,
    gmailMessageId: sent.messageId,
    sentAt: new Date(),
  });
}

describe('acknowledgement and unavailable-slot reply', () => {
  it('acknowledges a matching slot in the same thread, naming it', async () => {
    const job = await env.jobsByTitle('Senior Software Engineer, Data Pipelines');
    const app = await appliedTo(env.handle, userId, job.id);
    await runSimulatedRecruiter(env.handle, userId, { delayMs: 0 });
    const threadId = `sim-thread-${app.id}`;
    const proposal = (await mailbox()).find((m) => m.threadId === threadId)!;
    const chosen = slotsOf(proposal)[1]!;
    const out = await userReplies(
      threadId,
      app.id,
      `Hello,\n\n${formatSlot(chosen, 'America/Los_Angeles')} works for me.\n\nBest regards,\nJordan Avery`,
    );
    const r = await runSimulatedRecruiter(env.handle, userId, { delayMs: 0 });
    const ack = r.delivered.find((d) => d.applicationId === app.id)!;
    expect(ack.kind).toBe('acknowledgement');
    const row = (await getDemoMessage(env.handle, `sim-reply-${out.id}`))!;
    expect(row.threadId).toBe(threadId);
    expect(row.fromAddress).toBe(proposal.fromAddress);
    expect((row.headers as Record<string, string>)[SIMULATED_HEADER]).toBe('1');
    expect(row.bodyText).toContain(formatSlot(chosen, 'America/Los_Angeles'));
    expect(MONEY.test(row.bodyText)).toBe(false);
    // once only
    expect((await runSimulatedRecruiter(env.handle, userId, { delayMs: 0 })).delivered).toEqual([]);
  });

  it('says the time is unavailable and repeats the three slots when the reply names another time', async () => {
    const job = await env.jobsByTitle('Staff Software Engineer, Scheduling');
    const app = await appliedTo(env.handle, userId, job.id);
    await runSimulatedRecruiter(env.handle, userId, { delayMs: 0 });
    const threadId = `sim-thread-${app.id}`;
    const proposal = (await mailbox()).find((m) => m.threadId === threadId)!;
    const offered = slotsOf(proposal);
    const odd = { start: new Date('2031-01-04T03:00:00Z'), end: new Date('2031-01-04T03:45:00Z') };
    expect(
      acceptedSlot(formatSlot(odd, 'America/Los_Angeles'), offered, 'America/Los_Angeles'),
    ).toBeNull();
    const out = await userReplies(
      threadId,
      app.id,
      `Hello,\n\n${formatSlot(odd, 'America/Los_Angeles')} works for me.`,
    );
    const r = await runSimulatedRecruiter(env.handle, userId, { delayMs: 0 });
    expect(r.delivered.find((d) => d.applicationId === app.id)?.kind).toBe('unavailable');
    const row = (await getDemoMessage(env.handle, `sim-reply-${out.id}`))!;
    expect(row.threadId).toBe(threadId);
    expect(row.bodyText).toMatch(/not available/i);
    for (const s of offered) expect(row.bodyText).toContain(formatSlot(s, 'America/Los_Angeles'));
  });
});

describe('job entry point', () => {
  it('does nothing when no single tenant is flagged', async () => {
    const send = async () => null;
    const db = { demoUser: async () => null, forTenant: env.db.forTenant };
    expect(await runSimulatedRecruiterTick({ send } as never, db, {}, 0)).toBeNull();
  });
});
