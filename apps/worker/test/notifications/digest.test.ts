import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  insertCaptchaRequest,
  insertInterviewSlot,
  insertOutgoingMessage,
  lastDigestSentAt,
  listOutgoingMessagesForUser,
  setNotificationSettings,
  updateCaptchaRequest,
  updateApplication,
  upsertCompany,
} from '@wma/db';
import { flagDigest } from '../../src/inbox/flags';
import { DIGEST_JOB } from '../../src/notifications/constants';
import {
  digestKey,
  enqueueScheduledDigests,
  runDigest,
  type DigestJobData,
} from '../../src/notifications/digest';
import { localParts } from '../../src/notifications/time';
import { setupEnv, type TestEnv, type TestTenant } from '../helpers';
import {
  approveProfile,
  makeDeps,
  plain,
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
const D = 24 * H;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tenant() {
  const t = await env.makeTenant();
  await approveProfile(t);
  return t;
}
const digests = (t: TestTenant) =>
  listOutgoingMessagesForUser(t.handle, t.userId).then((rows) =>
    rows.filter((r) => r.kind === 'digest'),
  );
const forUser = (deps: TestNotificationDeps, t: TestTenant) =>
  deps.queue.jobs.filter(
    (j) => j.job === DIGEST_JOB && (j.data as unknown as DigestJobData).userId === t.userId,
  );

describe('rule 14: digest content', () => {
  it('a day with nothing still sends a short digest', async () => {
    const t = await tenant();
    const deps = makeDeps(new Date(), { store: 'db' });
    const out = await runDigest(t.handle, { userId: t.userId }, deps);
    expect(out).toMatchObject({ status: 'sent', sections: 0 });
    expect(deps.sender.sent).toHaveLength(1);
    const mail = deps.sender.sent[0]!;
    expect(mail.to).toBe(t.email);
    expect(mail.kind).toBe('digest');
    expect(mail.text).toContain('No activity');
    expect((await digests(t))[0]).toMatchObject({ blocked: false, kind: 'digest' });
  });

  it('lists each pending item kind and the activity since the last digest', async () => {
    const t = await tenant();
    const now = new Date();
    const deps = makeDeps(now, { store: 'db' });
    const log = (applicationId: string, action: string, detail: Record<string, unknown> = {}) =>
      activity.logActivity(t.handle, {
        userId: t.userId,
        applicationId,
        actor: 'agent',
        action,
        detail,
      });

    const applied = await seedApplication(t);
    const replied = await seedApplication(t);
    const comp = await seedApplication(t);
    const booking = await seedApplication(t);
    const awaitingApp = await seedApplication(t);
    const captchaApp = await seedApplication(t);
    const blockedApp = await seedApplication(t);
    const soonApp = await seedApplication(t);
    const farApp = await seedApplication(t);

    await log(applied.application.id, 'submitted');
    await log(replied.application.id, 'thread_linked', { classification: 'interview' });
    await log(replied.application.id, 'follow_up_sent');
    await log(replied.application.id, 'interview_booked');
    await flagDigest(t.handle, {
      userId: t.userId,
      applicationId: comp.application.id,
      kind: 'compensation',
      detail: { thread_id: 'thr-1', gmail_message_id: 'm1' },
    });
    await flagDigest(t.handle, {
      userId: t.userId,
      applicationId: booking.application.id,
      kind: 'booking_link',
      detail: {
        thread_id: 'thr-2',
        gmail_message_id: 'm2',
        link: 'https://cal.example.test/book/abc',
      },
    });
    await activity.logActivity(t.handle, {
      userId: t.userId,
      actor: 'agent',
      action: 'mailbox_reauth_needed',
    });

    // Pending: unconfirmed slots.
    const iv = await seedInterview(t, awaitingApp);
    const slotStart = new Date(now.getTime() + 3 * D);
    await insertInterviewSlot(t.handle, {
      interviewId: iv.id,
      startsAt: slotStart,
      endsAt: new Date(slotStart.getTime() + H),
      tokenHash: createHash('sha256').update('a').digest('hex'),
    });
    // Pending: human-stage CAPTCHA.
    const cap = await insertCaptchaRequest(t.handle, {
      userId: t.userId,
      applicationId: captchaApp.application.id,
    });
    await updateCaptchaRequest(t.handle, cap.id, {
      stage: 'human',
      expiresAt: new Date(now.getTime() + H),
    });
    // Blocked send.
    await insertOutgoingMessage(t.handle, {
      userId: t.userId,
      applicationId: blockedApp.application.id,
      kind: 'follow_up',
      toAddress: 'jobs@x.test',
      subject: 'Quick note',
      bodyText: 'cost $5',
      blocked: true,
      blockedReason: 'money: text contains "$"',
    });
    // Interviews: one in 2 days (listed), one in 20 days (not listed).
    await seedInterview(t, soonApp, { startsAt: new Date(now.getTime() + 2 * D) });
    await seedInterview(t, farApp, { startsAt: new Date(now.getTime() + 20 * D) });

    deps.clock.set(new Date());
    const out = await runDigest(t.handle, { userId: t.userId }, deps);
    expect(out.status).toBe('sent');
    const text = plain(deps.sender.sent[0]!.text);
    const html = deps.sender.sent[0]!.html;
    const has = (s: { companyName: string; job: { title: string } }) =>
      `${s.companyName} - ${s.job.title}`;

    expect(text).toContain('Applications submitted');
    expect(text).toContain(has(applied));
    expect(text).toContain(`${has(replied)}: reply received (interview)`);
    expect(text).toContain('Follow-ups sent');
    expect(text).toContain('Interviews booked');
    expect(text).toContain('Waiting for your confirmation');
    expect(text).toContain(`${has(awaitingApp)}: times offered`);
    expect(text).toContain(`${has(comp)}: the thread discusses pay terms`);
    expect(text).toContain(
      `${has(booking)}: they sent a scheduling link: https://cal.example.test/book/abc`,
    );
    expect(text).toContain('Gmail access needs to be reconnected');
    expect(text).toContain('Security checks waiting for you');
    expect(text).toContain(`${has(captchaApp)}: a security check is waiting`);
    expect(text).toContain('Blocked messages');
    expect(text).toContain(`${has(blockedApp)}: a follow up message was blocked`);
    expect(text).not.toContain('contains');
    expect(text).toContain('Interviews in the next 7 days');
    expect(text).toContain(has(soonApp));
    expect(text).not.toContain(has(farApp));
    expect(html).toContain('<h3>Blocked messages</h3>');
    expect(text).toContain(`https://app.example.test/applications/${soonApp.application.id}`);
  });

  it('covers only activity since the previous digest, and never another tenant', async () => {
    const t = await tenant();
    const other = await tenant();
    const deps = makeDeps(new Date(), { store: 'db' });
    const a = await seedApplication(t);
    const b = await seedApplication(t);
    const foreign = await seedApplication(other);
    await activity.logActivity(t.handle, {
      userId: t.userId,
      applicationId: a.application.id,
      actor: 'agent',
      action: 'submitted',
    });
    await activity.logActivity(other.handle, {
      userId: other.userId,
      applicationId: foreign.application.id,
      actor: 'agent',
      action: 'submitted',
    });

    deps.clock.set(new Date());
    await runDigest(t.handle, { userId: t.userId, date: '2030-01-01' }, deps);
    const first = deps.sender.sent[0]!.text;
    expect(first).toContain(a.job.title);
    expect(first).not.toContain(foreign.job.title);

    await sleep(15);
    await activity.logActivity(t.handle, {
      userId: t.userId,
      applicationId: b.application.id,
      actor: 'agent',
      action: 'submitted',
    });
    deps.clock.set(new Date());
    await runDigest(t.handle, { userId: t.userId, date: '2030-01-02' }, deps);
    const second = deps.sender.sent[1]!.text;
    expect(second).toContain(b.job.title);
    expect(second).not.toContain(a.job.title);
    expect(await lastDigestSentAt(t.handle, t.userId)).toBeInstanceOf(Date);
  });
});

describe('rule 15: employer text is scrubbed before the guard', () => {
  it('a digest quoting "$150k" from a recruiter renders [omitted] and is sent, not blocked', async () => {
    const t = await tenant();
    const deps = makeDeps(new Date(), { store: 'db' });
    const s = await seedApplication(t);
    await activity.logActivity(t.handle, {
      userId: t.userId,
      applicationId: s.application.id,
      actor: 'agent',
      action: 'digest_flag',
      detail: { kind: 'compensation' },
    });
    await activity.logActivity(t.handle, {
      userId: t.userId,
      applicationId: s.application.id,
      actor: 'agent',
      action: 'digest_flag',
      detail: { kind: 'booking_link', link: 'https://cal.example.test/pay-$150k-equity' },
    });
    await activity.logActivity(t.handle, {
      userId: t.userId,
      applicationId: s.application.id,
      actor: 'agent',
      action: 'status_changed',
      detail: { to: 'Offer $150k salary' },
    });

    deps.clock.set(new Date());
    const out = await runDigest(t.handle, { userId: t.userId }, deps);
    expect(out.status).toBe('sent');
    const mail = deps.sender.sent[0]!;
    expect(mail.text).toContain('[omitted]');
    expect(mail.text + mail.html + mail.subject).not.toMatch(
      /\$|\bsalary\b|\bcompensation\b|\bequity\b/i,
    );
    const [row] = await digests(t);
    expect(row).toMatchObject({ blocked: false });
    expect(row!.bodyText).toContain('[omitted]');
    const blocked = await listOutgoingMessagesForUser(t.handle, t.userId, { blockedOnly: true });
    expect(blocked).toHaveLength(0);
  });

  it('employer text in a company name is scrubbed in the digest too', async () => {
    const t = await tenant();
    const deps = makeDeps(new Date(), { store: 'db' });
    const company = await upsertCompany(t.handle, {
      name: 'Acme (equity, $150k)',
      ats: 'greenhouse',
      boardSlug: `money-${t.id.slice(0, 8)}`,
      createdBy: 'llm',
    });
    const s = await seedApplication(t, { companyId: company.id });
    await activity.logActivity(t.handle, {
      userId: t.userId,
      applicationId: s.application.id,
      actor: 'agent',
      action: 'submitted',
    });
    deps.clock.set(new Date());
    const out = await runDigest(t.handle, { userId: t.userId }, deps);
    expect(out.status).toBe('sent');
    expect(deps.sender.sent[0]!.text).toContain('Acme ([omitted], [omitted])');
  });
});

describe('rule 14: scheduling, singleton and hour changes', () => {
  it('enqueues at the digest hour in the user zone, keyed by the user local date', async () => {
    const t = await tenant();
    await setNotificationSettings(t.handle, t.userId, {
      digestHour: 8,
      timezone: 'Pacific/Auckland',
    });
    // 2030-06-09 20:30 UTC is 2030-06-10 08:30 in Auckland (UTC+12): local date differs from UTC.
    const deps = makeDeps(new Date('2030-06-09T20:30:00Z'), { store: 'db' });
    await enqueueScheduledDigests(deps.queue, env.db, deps.now());
    const jobs = forUser(deps, t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.opts.singletonKey).toBe(digestKey(t.userId, '2030-06-10'));
    expect(jobs[0]!.data).toMatchObject({ tenantId: t.id, userId: t.userId, date: '2030-06-10' });
    expect(jobs[0]!.opts).toMatchObject({ retryLimit: 3 });

    // Not their hour an hour earlier or later; a second tick in the same hour is a duplicate.
    const other = makeDeps(new Date('2030-06-09T19:30:00Z'), { store: 'db' });
    await enqueueScheduledDigests(other.queue, env.db, other.now());
    expect(forUser(other, t)).toHaveLength(0);
    const again = await enqueueScheduledDigests(
      deps.queue,
      env.db,
      new Date('2030-06-09T20:45:00Z'),
    );
    expect(forUser(deps, t)).toHaveLength(1);
    expect(again.duplicates).toBeGreaterThanOrEqual(1);
  });

  it('changing the hour after the digest went out yields no second digest that day', async () => {
    const t = await tenant();
    await setNotificationSettings(t.handle, t.userId, { digestHour: 8, timezone: 'UTC' });
    const deps = makeDeps(new Date('2030-06-10T08:05:00Z'), { store: 'db' });
    const tick = async () => {
      await enqueueScheduledDigests(deps.queue, env.db, deps.now());
      for (const j of deps.queue.takeDue(DIGEST_JOB, deps.now())) {
        const d = j.data as unknown as DigestJobData;
        if (d.userId === t.userId) await runDigest(t.handle, d, deps);
      }
    };
    await tick();
    expect(await digests(t)).toHaveLength(1);

    await setNotificationSettings(t.handle, t.userId, { digestHour: 17 });
    deps.clock.set(new Date('2030-06-10T17:05:00Z'));
    await tick();
    expect(await digests(t)).toHaveLength(1);
    expect(deps.sender.sent).toHaveLength(1);

    // The next day it goes out at the new hour.
    deps.clock.set(new Date('2030-06-11T08:05:00Z'));
    await tick();
    expect(await digests(t)).toHaveLength(1);
    deps.clock.set(new Date('2030-06-11T17:05:00Z'));
    await tick();
    expect(await digests(t)).toHaveLength(2);
  });

  it('changing the hour before the digest went out moves it to the new hour, still one that day', async () => {
    const t = await tenant();
    await setNotificationSettings(t.handle, t.userId, { digestHour: 8, timezone: 'UTC' });
    const deps = makeDeps(new Date('2030-06-10T07:00:00Z'), { store: 'db' });
    await setNotificationSettings(t.handle, t.userId, { digestHour: 17 });
    const tick = async () => {
      await enqueueScheduledDigests(deps.queue, env.db, deps.now());
      for (const j of deps.queue.takeDue(DIGEST_JOB, deps.now())) {
        const d = j.data as unknown as DigestJobData;
        if (d.userId === t.userId) await runDigest(t.handle, d, deps);
      }
    };
    deps.clock.set(new Date('2030-06-10T08:05:00Z'));
    await tick();
    expect(await digests(t)).toHaveLength(0);
    deps.clock.set(new Date('2030-06-10T17:05:00Z'));
    await tick();
    expect(await digests(t)).toHaveLength(1);
  });

  it('the same job run twice sends once (singleton per user and local date)', async () => {
    const t = await tenant();
    const deps = makeDeps(new Date('2030-06-10T08:05:00Z'), { store: 'db' });
    const data = { userId: t.userId, date: '2030-06-10' };
    expect(await runDigest(t.handle, data, deps)).toMatchObject({ status: 'sent' });
    expect(await runDigest(t.handle, data, deps)).toEqual({
      status: 'skipped',
      reason: 'already_sent',
    });
    expect(deps.sender.sent).toHaveLength(1);
  });

  it('a settings update is what the next scheduled digest uses', async () => {
    const t = await tenant();
    await setNotificationSettings(t.handle, t.userId, { digestHour: 6, timezone: 'UTC' });
    const at = (hh: string) => makeDeps(new Date(`2030-06-10T${hh}:10:00Z`), { store: 'db' });
    const old = at('06');
    await enqueueScheduledDigests(old.queue, env.db, old.now());
    expect(forUser(old, t)).toHaveLength(1);

    await setNotificationSettings(t.handle, t.userId, { digestHour: 9, timezone: 'Europe/Lisbon' });
    // Lisbon is UTC+1 in June: 09:xx local is 08:xx UTC.
    const oldHour = at('06');
    await enqueueScheduledDigests(oldHour.queue, env.db, oldHour.now());
    expect(forUser(oldHour, t)).toHaveLength(0);
    const newHour = at('08');
    await enqueueScheduledDigests(newHour.queue, env.db, newHour.now());
    expect(forUser(newHour, t)).toHaveLength(1);
    expect(localParts(newHour.now(), 'Europe/Lisbon')).toEqual({ date: '2030-06-10', hour: 9 });
  });
});

describe('rule 14: failed sends', () => {
  it('a failed send is logged and rethrown for the queue to retry, then the retry sends once', async () => {
    const t = await tenant();
    const deps = makeDeps(new Date('2030-06-10T08:05:00Z'), { store: 'db' });
    deps.failSend.on = true;
    const data = { userId: t.userId, date: '2030-06-10' };
    await expect(runDigest(t.handle, data, deps)).rejects.toThrow('gmail unavailable');
    const failed = (await activity.listByUser(t.handle, t.userId)).filter(
      (e) => e.action === 'digest_failed',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]!.detail).toMatchObject({ local_date: '2030-06-10', error: 'Error' });
    // Only a pending receipt exists; nothing went out.
    expect((await digests(t)).filter((r) => r.state === 'sent')).toHaveLength(0);

    // The retry reconciles the pending receipt against the mailbox (nothing there) and sends once.
    deps.failSend.on = false;
    expect(await runDigest(t.handle, data, deps)).toMatchObject({ status: 'sent' });
    const rows = await digests(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('sent');
    expect(deps.sender.sent).toHaveLength(1);
  });

  it('retry policy: three retries, ten minutes apart (inside the hour)', async () => {
    const t = await tenant();
    await setNotificationSettings(t.handle, t.userId, { digestHour: 8, timezone: 'UTC' });
    const deps = makeDeps(new Date('2030-06-10T08:05:00Z'), { store: 'db' });
    await enqueueScheduledDigests(deps.queue, env.db, deps.now());
    const [job] = forUser(deps, t);
    expect(job!.opts.retryLimit! * job!.opts.retryDelay!).toBeLessThanOrEqual(3600);
    expect(job!.opts.retryLimit).toBe(3);
  });
});

describe('rule 30: answers we guessed today', () => {
  const submit = (t: TestTenant, applicationId: string) =>
    activity.logActivity(t.handle, {
      userId: t.userId,
      applicationId,
      actor: 'agent',
      action: 'submitted',
    });

  it('lists inferred and guessed answers of applications submitted in the window', async () => {
    const t = await tenant();
    const a = await seedApplication(t);
    const plainApp = await seedApplication(t);
    await updateApplication(t.handle, a.application.id, {
      formAnswers: {
        'Full name': 'Mara Quill',
        'Work authorization': {
          value: 'Authorized to work in the United States',
          source: 'inferred',
        },
        'Years of Kafka experience?': { value: 'About 5', source: 'guessed' },
        Gender: { skipped: 'self-identification' },
      },
    });
    await updateApplication(t.handle, plainApp.application.id, {
      formAnswers: { 'Full name': 'Mara Quill' },
    });
    await submit(t, a.application.id);
    await submit(t, plainApp.application.id);
    const deps = makeDeps(new Date(), { store: 'db' });
    deps.clock.set(new Date(Date.now() + 1000));
    await runDigest(t.handle, { userId: t.userId }, deps);
    const text = plain(deps.sender.sent[0]!.text);
    expect(text).toContain('Answers we guessed today');
    expect(text).toContain(
      `${a.companyName} - ${a.job.title}: Work authorization: Authorized to work in the United States`,
    );
    expect(text).toContain(
      `${a.companyName} - ${a.job.title}: Years of Kafka experience?: About 5`,
    );
    expect(text).not.toContain('Mara Quill');
    expect(text).not.toContain(`${plainApp.companyName} - ${plainApp.job.title}: Full name`);
  });

  it('omits the section when nothing was inferred or guessed', async () => {
    const t = await tenant();
    const a = await seedApplication(t);
    await updateApplication(t.handle, a.application.id, {
      formAnswers: { 'Full name': 'Mara Quill' },
    });
    await submit(t, a.application.id);
    const deps = makeDeps(new Date(), { store: 'db' });
    deps.clock.set(new Date(Date.now() + 1000));
    await runDigest(t.handle, { userId: t.userId }, deps);
    const text = deps.sender.sent[0]!.text;
    expect(text).toContain('Applications submitted');
    expect(text).not.toContain('Answers we guessed today');
  });
});
