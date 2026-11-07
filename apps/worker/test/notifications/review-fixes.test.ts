import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  getDigestCheckpoint,
  updateApplication,
  updateInterview,
  upsertEmailThread,
} from '@wma/db';
import { SCHEDULE_REMINDERS_JOB, sendEmail } from '@wma/shared';
import { flagDigest } from '../../src/inbox/flags';
import { DIGEST_JOB, REMINDER_JOB } from '../../src/notifications/constants';
import {
  digestDeliveryKey,
  enqueueScheduledDigests,
  isDigestHour,
  runDigest,
} from '../../src/notifications/digest';
import {
  reminderDeliveryKey,
  reminderKey,
  runReminder,
  scheduleReminders,
  SCHEDULE_RETRY_BASE_S,
  SCHEDULE_RETRY_MAX_ATTEMPTS,
  type ReminderJobData,
  type ScheduleRemindersJobData,
} from '../../src/notifications/reminders';
import { renderReminder } from '../../src/notifications/templates';
import { relativeWhen } from '../../src/notifications/time';
import { setupEnv, type TestEnv, type TestTenant } from '../helpers';
import { approveProfile, makeDeps, plain, seedApplication, seedInterview } from './support';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
});

const H = 3_600_000;
const MIN = 60_000;
const START = new Date('2030-03-12T22:00:00Z');

async function tenant() {
  const t = await env.makeTenant();
  await approveProfile(t);
  return t;
}

describe('reminder replacement when the old singleton is active', () => {
  it('retries the replacement after the old job finishes instead of losing it', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const interview = await seedInterview(t, s, { startsAt: START });
    const deps = makeDeps(new Date(START.getTime() - 72 * H));
    await scheduleReminders(t.handle, interview.id, deps);

    // The T-1h reminder is running when the interview moves two days later.
    const old = deps.queue.activate(REMINDER_JOB, reminderKey(interview.id, 3600));
    const newStart = new Date(START.getTime() + 48 * H);
    await updateInterview(t.handle, interview.id, {
      startsAt: newStart,
      endsAt: new Date(newStart.getTime() + H),
    });
    const scheduled = await scheduleReminders(t.handle, interview.id, deps);

    // The exclusive queue refused the 1-hour replacement; only the 24-hour one was queued.
    expect(scheduled.map((r) => r.offset)).toEqual([86400]);
    const retry = deps.queue.queued(SCHEDULE_REMINDERS_JOB);
    expect(retry).toHaveLength(1);
    expect(retry[0]!.data).toMatchObject({ interviewId: interview.id, attempt: 1 });
    expect(retry[0]!.opts.startAfter).toEqual(
      new Date(deps.now().getTime() + SCHEDULE_RETRY_BASE_S * 1000),
    );

    // The old job ends (it sees the changed start and skips); the retry then queues the new one.
    expect(await runReminder(t.handle, old.data as unknown as ReminderJobData, deps)).toMatchObject(
      { status: 'skipped', reason: 'rescheduled' },
    );
    deps.queue.complete(old.id);
    deps.clock.advance((SCHEDULE_RETRY_BASE_S + 1) * 1000);
    for (const j of deps.queue.takeDue(SCHEDULE_REMINDERS_JOB, deps.now())) {
      const d = j.data as unknown as ScheduleRemindersJobData;
      await scheduleReminders(t.handle, d.interviewId, deps, d.attempt);
    }
    const q = deps.queue.queued(REMINDER_JOB);
    expect(q.map((j) => j.opts.singletonKey).sort()).toEqual(
      [reminderKey(interview.id, 86400), reminderKey(interview.id, 3600)].sort(),
    );
    expect(q.map((j) => (j.data as { startsAt: string }).startsAt)).toEqual([
      newStart.toISOString(),
      newStart.toISOString(),
    ]);
    expect(deps.queue.queued(SCHEDULE_REMINDERS_JOB)).toHaveLength(0);
  });

  it('keeps retrying with growing delays while the old job runs, and gives up after the cap', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const interview = await seedInterview(t, s, { startsAt: START });
    const deps = makeDeps(new Date(START.getTime() - 72 * H));
    await scheduleReminders(t.handle, interview.id, deps);
    deps.queue.activate(REMINDER_JOB, reminderKey(interview.id, 3600));
    deps.queue.activate(REMINDER_JOB, reminderKey(interview.id, 86400));

    const delays: number[] = [];
    let attempt = 0;
    for (let i = 0; i < SCHEDULE_RETRY_MAX_ATTEMPTS + 3; i++) {
      await scheduleReminders(t.handle, interview.id, deps, attempt);
      const next = deps.queue.queued(SCHEDULE_REMINDERS_JOB).at(-1);
      if (!next || (next.data as { attempt: number }).attempt === attempt) break;
      attempt = (next.data as { attempt: number }).attempt;
      delays.push((next.opts.startAfter!.getTime() - deps.now().getTime()) / 1000);
    }
    expect(delays).toEqual(
      Array.from({ length: SCHEDULE_RETRY_MAX_ATTEMPTS }, (_, i) => SCHEDULE_RETRY_BASE_S * 2 ** i),
    );
  });
});

describe('reminder completion recovered from the delivery receipt', () => {
  it('a reminder that went out but was never logged is recognized, not sent again', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const interview = await seedInterview(t, s, { startsAt: START });
    const deps = makeDeps(new Date(START.getTime() - 25 * H));
    const data: ReminderJobData = {
      tenantId: t.id,
      userId: t.userId,
      interviewId: interview.id,
      offset: 86400,
      startsAt: START.toISOString(),
    };
    // The worker died after Gmail accepted the message and the receipt was finalized.
    const key = reminderDeliveryKey(interview.id, 86400, data.startsAt);
    expect(
      await sendEmail(deps.mail(t.handle, t.userId), {
        userId: t.userId,
        kind: 'reminder',
        applicationId: s.application.id,
        to: t.email,
        subject: 'Reminder',
        html: '<p>x</p>',
        text: 'x',
        deliveryKey: key,
      }),
    ).toMatchObject({ status: 'sent' });
    expect(deps.sender.sent).toHaveLength(1);

    expect(await runReminder(t.handle, data, deps)).toEqual({
      status: 'skipped',
      reason: 'already_sent',
    });
    expect(deps.sender.sent).toHaveLength(1);
    const logged = (await activity.listByUser(t.handle, t.userId)).filter(
      (e) => e.action === 'reminder_sent',
    );
    expect(logged).toHaveLength(1);
    // And a third run is stopped by the activity marker.
    expect(await runReminder(t.handle, data, deps)).toMatchObject({ reason: 'already_sent' });
  });

  it('the same offset for a new start time is a new reminder, not the old receipt', async () => {
    expect(reminderDeliveryKey('iv', 86400, '2030-03-12T22:00:00.000Z')).not.toBe(
      reminderDeliveryKey('iv', 86400, '2030-03-14T22:00:00.000Z'),
    );
  });
});

describe('reminder wording comes from the real local date and time', () => {
  const zone = 'America/Los_Angeles';
  const render = (startsAt: Date, now: Date) =>
    renderReminder({
      company: 'Acme',
      role: 'Engineer',
      startsAt,
      now,
      timezone: zone,
      cardUrl: 'https://app.example.test/applications/x',
    });

  it('T-24h on the fall-back day for a 23:30 PST interview says today, not tomorrow', () => {
    const start = new Date('2026-11-02T07:30:00Z'); // 23:30 PST on Nov 1
    const now = new Date(start.getTime() - 24 * H); // 00:30 PDT on Nov 1
    expect(relativeWhen(start, now, zone)).toBe('today');
    const mail = render(start, now);
    expect(mail.subject).toContain('today');
    expect(mail.text).not.toContain('tomorrow');
    expect(plain(mail.text)).toContain('Sun, Nov 1, 11:30 PM PST');
  });

  it('an ordinary T-24h says tomorrow, an hour out says about an hour', () => {
    const start = new Date('2030-03-12T22:00:00Z');
    expect(relativeWhen(start, new Date(start.getTime() - 24 * H), zone)).toBe('tomorrow');
    expect(relativeWhen(start, new Date(start.getTime() - 1 * H), zone)).toBe('in about an hour');
  });

  it('delayed jobs describe the time that is actually left', () => {
    const start = new Date('2030-03-12T22:00:00Z');
    expect(relativeWhen(start, new Date(start.getTime() - 20 * MIN), zone)).toBe(
      'in about 20 minutes',
    );
    expect(relativeWhen(start, new Date(start.getTime() - 4 * H), zone)).toBe('in about 4 hours');
    expect(relativeWhen(start, new Date(start.getTime() - 9 * H), zone)).toBe('today');
    expect(relativeWhen(start, new Date(start.getTime() - 50 * H), zone)).toBe(
      'on Tuesday, Mar 12',
    );
  });

  it('runReminder uses the send-time clock: a T-24h job that ran late is not "tomorrow"', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const interview = await seedInterview(t, s, { startsAt: START });
    // The 24-hour job ran 20 hours late: 4 hours before the 3:00 PM start.
    const deps = makeDeps(new Date(START.getTime() - 4 * H));
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
    const mail = deps.sender.sent[0]!;
    expect(mail.subject).toContain('in about 4 hours');
    expect(mail.text).not.toContain('tomorrow');
    expect(plain(mail.text)).toContain('Tue, Mar 12, 3:00 PM PDT');
  });
});

describe('digest hour skipped by DST', () => {
  const zone = 'America/Los_Angeles';

  it('sends at the first valid hour after a missing hour 2, once', () => {
    // 2030-03-10: clocks go from 01:59 PST to 03:00 PDT at 10:00Z.
    expect(isDigestHour(new Date('2030-03-10T09:30:00Z'), zone, 2)).toBe(false); // 01:30 PST
    expect(isDigestHour(new Date('2030-03-10T10:30:00Z'), zone, 2)).toBe(true); // 03:30 PDT
    expect(isDigestHour(new Date('2030-03-10T11:30:00Z'), zone, 2)).toBe(false); // 04:30 PDT
    // An ordinary day still fires only at the hour.
    expect(isDigestHour(new Date('2030-03-12T09:30:00Z'), zone, 2)).toBe(true); // 02:30 PDT
    expect(isDigestHour(new Date('2030-03-12T10:30:00Z'), zone, 2)).toBe(false);
  });

  it('a digest hour that exists is not fired late', () => {
    expect(isDigestHour(new Date('2030-03-10T17:30:00Z'), zone, 8)).toBe(false); // 10:30 PDT
    expect(isDigestHour(new Date('2030-03-10T15:30:00Z'), zone, 8)).toBe(true); // 08:30 PDT
  });

  it('enqueues the skipped-hour digest on the spring-forward day, keyed by the local date', async () => {
    const t = await tenant();
    const roster = {
      digestRoster: async () => [
        { tenantId: t.id, userId: t.userId, digestHour: 2, timezone: zone },
      ],
    };
    const deps = makeDeps(new Date());
    const ticks = [
      '2030-03-10T08:30:00Z', // 00:30 PST
      '2030-03-10T09:30:00Z', // 01:30 PST
      '2030-03-10T10:30:00Z', // 03:30 PDT  <- first valid hour after the gap
      '2030-03-10T11:30:00Z', // 04:30 PDT
    ];
    for (const at of ticks) await enqueueScheduledDigests(deps.queue, roster, new Date(at));
    const jobs = deps.queue.jobs.filter((j) => j.job === DIGEST_JOB);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({ date: '2030-03-10' });
  });

  it('a repeated hour on the fall-back day still yields one digest', async () => {
    const t = await tenant();
    const roster = {
      digestRoster: async () => [
        { tenantId: t.id, userId: t.userId, digestHour: 1, timezone: zone },
      ],
    };
    const deps = makeDeps(new Date('2030-11-03T08:30:00Z'), { store: 'db' });
    // 2030-11-03: 01:30 PDT (08:30Z) and again 01:30 PST (09:30Z).
    for (const at of ['2030-11-03T08:30:00Z', '2030-11-03T09:30:00Z']) {
      deps.clock.set(new Date(at));
      await enqueueScheduledDigests(deps.queue, roster, deps.now());
      for (const j of deps.queue.takeDue(DIGEST_JOB, deps.now())) {
        await runDigest(t.handle, j.data as { userId: string; date: string }, deps);
      }
    }
    expect(deps.sender.sent).toHaveLength(1);
  });
});

describe('digest: flags the inbox actually emits', () => {
  it('lists the scheduling link from detail.link of a digest_flag with kind booking_link', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    await flagDigest(t.handle, {
      userId: t.userId,
      applicationId: s.application.id,
      kind: 'booking_link',
      detail: {
        thread_id: 'th-1',
        gmail_message_id: 'm-1',
        link: 'https://cal.example.test/me/30',
      },
    });
    const deps = makeDeps(new Date());
    deps.clock.set(new Date());
    await runDigest(t.handle, { userId: t.userId }, deps);
    expect(deps.sender.sent[0]!.text).toContain(
      `${s.companyName} - ${s.job.title}: they sent a scheduling link: https://cal.example.test/me/30`,
    );
  });

  it('the no_free_slot flag scheduling writes is read by the same field', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    await flagDigest(t.handle, {
      userId: t.userId,
      applicationId: s.application.id,
      kind: 'no_free_slot',
      detail: { reason: 'calendar_conflict' },
    });
    const deps = makeDeps(new Date());
    deps.clock.set(new Date());
    await runDigest(t.handle, { userId: t.userId }, deps);
    expect(deps.sender.sent[0]!.text).toContain('every time they proposed conflicts');
  });
});

describe('digest: unresolved flagged threads appear in every digest', () => {
  async function flagged(t: TestTenant, opts: { link?: string; compensation?: boolean } = {}) {
    const s = await seedApplication(t);
    const thread = await upsertEmailThread(t.handle, {
      userId: t.userId,
      gmailThreadId: `thr-${s.application.id}`,
      kind: 'interview',
      applicationId: s.application.id,
      compensationFlag: opts.compensation ?? false,
      bookingLink: opts.link ?? null,
    });
    return { s, thread };
  }

  it('a pay thread and an unused scheduling link keep showing after the day they arrived', async () => {
    const t = await tenant();
    const pay = await flagged(t, { compensation: true });
    const link = await flagged(t, { link: 'https://cal.example.test/book/z' });
    const deps = makeDeps(new Date());
    const label = (x: { s: { companyName: string; job: { title: string } } }) =>
      `${x.s.companyName} - ${x.s.job.title}`;

    for (const date of ['2030-05-01', '2030-05-02', '2030-05-03']) {
      deps.clock.set(new Date());
      await runDigest(t.handle, { userId: t.userId, date }, deps);
    }
    expect(deps.sender.sent).toHaveLength(3);
    for (const m of deps.sender.sent) {
      expect(m.text).toContain(`${label(pay)}: the thread discusses pay terms`);
      expect(m.text).toContain(
        `${label(link)}: they sent a scheduling link: https://cal.example.test/book/z`,
      );
    }
  });

  it('is deduplicated against the same flag in the recent activity', async () => {
    const t = await tenant();
    const { s, thread } = await flagged(t, {
      compensation: true,
      link: 'https://cal.example.test/q',
    });
    await flagDigest(t.handle, {
      userId: t.userId,
      applicationId: s.application.id,
      kind: 'compensation',
      detail: { thread_id: thread.id, gmail_message_id: 'm1' },
    });
    await flagDigest(t.handle, {
      userId: t.userId,
      applicationId: s.application.id,
      kind: 'booking_link',
      detail: { thread_id: thread.id, gmail_message_id: 'm1', link: 'https://cal.example.test/q' },
    });
    const deps = makeDeps(new Date());
    deps.clock.set(new Date());
    await runDigest(t.handle, { userId: t.userId }, deps);
    const text = deps.sender.sent[0]!.text;
    expect(text.match(/discusses pay terms/g)).toHaveLength(1);
    expect(text.match(/scheduling link/g)).toHaveLength(1);
  });

  it('stops listing a thread once its application is closed', async () => {
    const t = await tenant();
    const { s } = await flagged(t, { compensation: true });
    await updateApplication(t.handle, s.application.id, {
      status: 'closed',
      closedReason: 'rejected',
    });
    const deps = makeDeps(new Date());
    deps.clock.set(new Date());
    await runDigest(t.handle, { userId: t.userId }, deps);
    expect(deps.sender.sent[0]!.text).not.toContain('pay terms');
  });
});

describe('digest checkpoint at the collection cutoff', () => {
  it('activity committed between collection and the send is in the next digest, once', async () => {
    const t = await tenant();
    const a = await seedApplication(t);
    const b = await seedApplication(t);
    const deps = makeDeps(new Date(), { store: 'db' });
    await activity.logActivity(t.handle, {
      userId: t.userId,
      applicationId: a.application.id,
      actor: 'agent',
      action: 'submitted',
    });
    deps.clock.set(new Date());
    const cutoff1 = deps.now();
    // While the digest is being sent, another activity commits.
    deps.beforeSend.run = async () => {
      await new Promise((r) => setTimeout(r, 5));
      await activity.logActivity(t.handle, {
        userId: t.userId,
        applicationId: b.application.id,
        actor: 'agent',
        action: 'submitted',
      });
    };
    await runDigest(t.handle, { userId: t.userId, date: '2030-06-01' }, deps);
    deps.beforeSend.run = null;
    expect(deps.sender.sent[0]!.text).toContain(a.job.title);
    expect(deps.sender.sent[0]!.text).not.toContain(b.job.title);
    // The checkpoint is the cutoff, not the (later) time the message was recorded as sent.
    expect(await getDigestCheckpoint(t.handle, t.userId)).toEqual(cutoff1);

    await new Promise((r) => setTimeout(r, 10));
    deps.clock.set(new Date());
    await runDigest(t.handle, { userId: t.userId, date: '2030-06-02' }, deps);
    expect(deps.sender.sent[1]!.text).toContain(b.job.title);
    expect(deps.sender.sent[1]!.text).not.toContain(a.job.title);

    deps.clock.set(new Date());
    await runDigest(t.handle, { userId: t.userId, date: '2030-06-03' }, deps);
    expect(deps.sender.sent[2]!.text).not.toContain(b.job.title);
  });
});

describe('digest completion recovered from the delivery receipt', () => {
  it('a digest that went out but whose activity entry was lost is not sent twice', async () => {
    const t = await tenant();
    const deps = makeDeps(new Date(), { store: 'db' });
    const date = '2030-07-04';
    // The worker died after Gmail accepted the digest and its receipt was finalized.
    await sendEmail(deps.mail(t.handle, t.userId), {
      userId: t.userId,
      kind: 'digest',
      to: t.email,
      subject: 'Your daily digest',
      html: '<p>x</p>',
      text: 'x',
      deliveryKey: digestDeliveryKey(t.userId, date),
    });
    expect(deps.sender.sent).toHaveLength(1);

    expect(await runDigest(t.handle, { userId: t.userId, date }, deps)).toEqual({
      status: 'skipped',
      reason: 'already_sent',
    });
    expect(deps.sender.sent).toHaveLength(1);
    const log = await activity.listByUser(t.handle, t.userId);
    expect(log.filter((e) => e.action === 'digest_sent')).toHaveLength(1);
    expect(await getDigestCheckpoint(t.handle, t.userId)).toBeInstanceOf(Date);
    // Repeating it changes nothing.
    await runDigest(t.handle, { userId: t.userId, date }, deps);
    expect(deps.sender.sent).toHaveLength(1);
  });
});
