import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activity, updateInterview, upsertCompany } from '@wma/db';
import {
  cancelReminders,
  reminderKey,
  runReminder,
  scheduleReminders,
} from '../../src/notifications/reminders';
import type { ReminderJobData } from '../../src/notifications/reminders';
import { REMINDER_JOB } from '../../src/notifications/constants';
import { setupEnv, type TestEnv } from '../helpers';
import {
  approveProfile,
  makeDeps,
  seedApplication,
  seedInterview,
  type TestNotificationDeps,
} from './support';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
});

const H = 3_600_000;
// 2030-03-12 22:00 UTC is 3:00 PM PDT, the default zone's local time.
const START = new Date('2030-03-12T22:00:00Z');

async function setup(confirmedAt: Date, startsAt: Date = START, prepReady = false) {
  const t = await env.makeTenant();
  await approveProfile(t);
  const s = await seedApplication(t);
  const interview = await seedInterview(t, s, { startsAt, prepReady });
  const deps = makeDeps(confirmedAt);
  return { t, s, interview, deps };
}

/** Runs every queued reminder that is due at the deps clock. */
async function runDue(t: Awaited<ReturnType<typeof setup>>['t'], deps: TestNotificationDeps) {
  const outcomes = [];
  for (const j of deps.queue.takeDue(REMINDER_JOB, deps.clock.now())) {
    outcomes.push(await runReminder(t.handle, j.data as unknown as ReminderJobData, deps));
  }
  return outcomes;
}

describe('rule 13: reminders', () => {
  it('booked more than 24h out: reminders at T-24h and T-1h, one per offset, keyed (interview, offset)', async () => {
    const { t, interview, deps } = await setup(new Date(START.getTime() - 72 * H));
    const scheduled = await scheduleReminders(t.handle, interview.id, deps);
    expect(scheduled.map((r) => r.offset)).toEqual([86400, 3600]);
    const queued = deps.queue.queued(REMINDER_JOB);
    expect(queued.map((j) => j.opts.singletonKey)).toEqual([
      reminderKey(interview.id, 86400),
      reminderKey(interview.id, 3600),
    ]);
    expect(queued.map((j) => j.opts.startAfter)).toEqual([
      new Date(START.getTime() - 24 * H),
      new Date(START.getTime() - 1 * H),
    ]);

    // Nothing is due yet; at T-24h one goes out, at T-1h the other.
    expect(await runDue(t, deps)).toEqual([]);
    deps.clock.set(new Date(START.getTime() - 24 * H));
    expect(await runDue(t, deps)).toMatchObject([{ status: 'sent' }]);
    deps.clock.set(new Date(START.getTime() - 1 * H));
    expect(await runDue(t, deps)).toMatchObject([{ status: 'sent' }]);
    expect(deps.sender.sent).toHaveLength(2);
    expect(deps.sender.sent.every((m) => m.to === t.email)).toBe(true);
  });

  it('scheduling twice keeps exactly one queued job per offset', async () => {
    const { t, interview, deps } = await setup(new Date(START.getTime() - 72 * H));
    await scheduleReminders(t.handle, interview.id, deps);
    await scheduleReminders(t.handle, interview.id, deps);
    expect(deps.queue.queued(REMINDER_JOB)).toHaveLength(2);
  });

  it('confirmed less than 24h out: only the 1-hour reminder; less than 1h out: none', async () => {
    const a = await setup(new Date(START.getTime() - 5 * H));
    const scheduled = await scheduleReminders(a.t.handle, a.interview.id, a.deps);
    expect(scheduled.map((r) => r.offset)).toEqual([3600]);

    const b = await setup(new Date(START.getTime() - 30 * 60_000));
    expect(await scheduleReminders(b.t.handle, b.interview.id, b.deps)).toEqual([]);
    expect(b.deps.queue.queued()).toHaveLength(0);
  });

  it('rescheduled: the old reminders are cancelled and new ones are scheduled for the new time', async () => {
    const { t, interview, deps } = await setup(new Date(START.getTime() - 72 * H));
    await scheduleReminders(t.handle, interview.id, deps);
    const NEW = new Date(START.getTime() + 48 * H);
    await updateInterview(t.handle, interview.id, {
      startsAt: NEW,
      endsAt: new Date(NEW.getTime() + H),
    });
    await scheduleReminders(t.handle, interview.id, deps);

    expect(deps.queue.jobs.filter((j) => j.state === 'cancelled')).toHaveLength(2);
    const queued = deps.queue.queued(REMINDER_JOB);
    expect(queued.map((j) => j.opts.startAfter)).toEqual([
      new Date(NEW.getTime() - 24 * H),
      new Date(NEW.getTime() - 1 * H),
    ]);

    // Run to the end of time: only the new reminders go out, and they name the new time.
    deps.clock.set(new Date(NEW.getTime() - 30 * 60_000));
    await runDue(t, deps);
    expect(deps.sender.sent).toHaveLength(2);
    expect(
      deps.sender.sent.every((m) => m.text.includes('Thu, Mar 14') || m.text.includes('Mar 14')),
    ).toBe(true);
  });

  it('a stale reminder that escaped cancellation still sends nothing once the start has changed', async () => {
    const { t, interview, deps } = await setup(new Date(START.getTime() - 72 * H));
    await scheduleReminders(t.handle, interview.id, deps);
    const stale = deps.queue.queued(REMINDER_JOB)[0]!.data as unknown as ReminderJobData;
    const NEW = new Date(START.getTime() + 24 * H);
    await updateInterview(t.handle, interview.id, { startsAt: NEW });
    deps.clock.set(new Date(START.getTime() - 23 * H));
    expect(await runReminder(t.handle, stale, deps)).toEqual({
      status: 'skipped',
      reason: 'rescheduled',
    });
    expect(deps.sender.sent).toHaveLength(0);
  });

  it('interview no longer confirmed: the reminder is a no-op', async () => {
    const { t, interview, deps } = await setup(new Date(START.getTime() - 72 * H));
    await scheduleReminders(t.handle, interview.id, deps);
    // The interview is withdrawn (confirmation cleared) without anyone cancelling the jobs.
    await updateInterview(t.handle, interview.id, { confirmedAt: null });
    deps.clock.set(new Date(START.getTime() - 30 * 60_000));
    const outcomes = await runDue(t, deps);
    expect(outcomes).toEqual([
      { status: 'skipped', reason: 'not_confirmed' },
      { status: 'skipped', reason: 'not_confirmed' },
    ]);
    expect(deps.sender.sent).toHaveLength(0);
    expect(deps.memory!.rows).toHaveLength(0);
  });

  it('scheduling for an unconfirmed interview queues nothing', async () => {
    const t = await env.makeTenant();
    await approveProfile(t);
    const s = await seedApplication(t);
    const interview = await seedInterview(t, s, { startsAt: START, confirmed: false });
    const deps = makeDeps(new Date(START.getTime() - 72 * H));
    expect(await scheduleReminders(t.handle, interview.id, deps)).toEqual([]);
    expect(deps.queue.queued()).toHaveLength(0);
  });

  it('cancelReminders cancels both offsets', async () => {
    const { t, interview, deps } = await setup(new Date(START.getTime() - 72 * H));
    await scheduleReminders(t.handle, interview.id, deps);
    expect(await cancelReminders(interview.id, deps)).toBe(2);
    expect(deps.queue.queued()).toHaveLength(0);
  });

  it('the same reminder run twice (a retry) sends once', async () => {
    const { t, interview, deps } = await setup(new Date(START.getTime() - 72 * H));
    await scheduleReminders(t.handle, interview.id, deps);
    const data = deps.queue.queued(REMINDER_JOB)[0]!.data as unknown as ReminderJobData;
    deps.clock.set(new Date(START.getTime() - 24 * H));
    expect(await runReminder(t.handle, data, deps)).toMatchObject({ status: 'sent' });
    expect(await runReminder(t.handle, data, deps)).toEqual({
      status: 'skipped',
      reason: 'already_sent',
    });
    expect(deps.sender.sent).toHaveLength(1);
    const log = await activity.listByApplication(t.handle, interview.applicationId);
    expect(log.filter((e) => e.action === 'reminder_sent')).toHaveLength(1);
  });

  it('content: company, role, time in the user zone, card link; prep link only when ready', async () => {
    const plainCase = await setup(new Date(START.getTime() - 72 * H));
    const data = (d: typeof plainCase) =>
      ({
        tenantId: d.t.id,
        userId: d.t.userId,
        interviewId: d.interview.id,
        offset: 86400,
        startsAt: START.toISOString(),
      }) as ReminderJobData;
    plainCase.deps.clock.set(new Date(START.getTime() - 24 * H));
    await runReminder(plainCase.t.handle, data(plainCase), plainCase.deps);
    const m = plainCase.deps.sender.sent[0]!;
    expect(m.subject).toContain(plainCase.s.companyName);
    expect(m.text).toContain(plainCase.s.job.title);
    expect(m.text.replace(/\u202f/g, ' ')).toContain('Tue, Mar 12, 3:00 PM PDT');
    expect(m.text).toContain(`https://app.example.test/applications/${plainCase.s.application.id}`);
    expect(m.text).not.toContain('/prep');
    expect(m.text).not.toContain('Interviewer:');
    expect(m.kind).toBe('reminder');

    const ready = await setup(new Date(START.getTime() - 72 * H), START, true);
    ready.deps.clock.set(new Date(START.getTime() - 24 * H));
    await runReminder(ready.t.handle, data(ready), ready.deps);
    const r = ready.deps.sender.sent[0]!;
    expect(r.text).toContain(
      `https://app.example.test/applications/${ready.s.application.id}/prep`,
    );
    expect(r.html).toContain('Read the prep plan');
  });

  it('names the interviewer when scheduling recorded one', async () => {
    const { t, interview, deps, s } = await setup(new Date(START.getTime() - 72 * H));
    await activity.logActivity(t.handle, {
      userId: t.userId,
      applicationId: s.application.id,
      actor: 'user',
      action: 'slot_confirmed',
      detail: { interviewer: 'Priya Raman' },
    });
    deps.clock.set(new Date(START.getTime() - 24 * H));
    await runReminder(
      t.handle,
      {
        tenantId: t.id,
        userId: t.userId,
        interviewId: interview.id,
        offset: 86400,
        startsAt: START.toISOString(),
      },
      deps,
    );
    expect(deps.sender.sent[0]!.text).toContain('Interviewer: Priya Raman');
  });

  it('rule 15: employer money text in the role is scrubbed before the guard, so the reminder is sent', async () => {
    const t = await env.makeTenant();
    await approveProfile(t);
    const company = await upsertCompany(t.handle, {
      name: 'Acme (equity, $150k)',
      ats: 'greenhouse',
      boardSlug: `money-${t.id.slice(0, 8)}`,
      createdBy: 'llm',
    });
    const s = await seedApplication(t, { companyId: company.id });
    const interview = await seedInterview(t, s, { startsAt: START });
    const deps = makeDeps(new Date(START.getTime() - 24 * H));
    const out = await runReminder(
      t.handle,
      {
        tenantId: t.id,
        userId: t.userId,
        interviewId: interview.id,
        offset: 86400,
        startsAt: START.toISOString(),
      },
      deps,
    );
    expect(out.status).toBe('sent');
    const row = deps.memory!.rows[0]!;
    expect(row.blocked).toBe(false);
    expect(row.subject).toContain('[omitted]');
    expect(row.bodyText + row.subject).not.toMatch(/\$|equity/i);
  });
});
