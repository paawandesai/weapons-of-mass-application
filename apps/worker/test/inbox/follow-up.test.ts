import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PgBoss } from 'pg-boss';
import {
  activity,
  getApplication,
  listEmailThreadsForApplication,
  listOutgoingMessagesForApplication,
  updateApplication,
  upsertEmailThread,
  type ApplicationStatus,
} from '@wma/db';
import { isReplyable, runFollowUp } from '../../src/inbox/follow-up';
import { renderFollowUp } from '../../src/inbox/templates/follow-up';
import { FOLLOW_UP_JOB } from '../../src/submission/constants';
import { createFollowUpQueue } from '../../src/submission/followup';
import {
  approve,
  FakeInboxGmail,
  fixture,
  inboxLlm,
  makeDeps,
  message,
  NOW,
  seed,
  setupInboxEnv,
  type InboxEnv,
  type Seed,
} from './support';

let env: InboxEnv;
beforeAll(async () => {
  env = await setupInboxEnv();
});
afterAll(async () => {
  await env.cleanup();
});

interface Opts {
  status?: ApplicationStatus;
  appliedAt?: Date | null;
  companyName?: string;
  thread?: 'none' | 'confirmation' | 'other';
  from?: (s: Seed) => string;
  followedUpAt?: Date;
}

async function setup(o: Opts = {}) {
  const t = await env.makeTenant();
  await approve(t);
  const s = await seed(t, {
    status: o.status ?? 'applied',
    appliedAt: o.appliedAt === undefined ? new Date('2026-03-10T09:00:00Z') : o.appliedAt,
    companyName: o.companyName,
  });
  if (o.followedUpAt)
    await updateApplication(t.handle, s.application.id, { followedUpAt: o.followedUpAt });
  const gmail = new FakeInboxGmail();
  const kind = o.thread ?? 'confirmation';
  if (kind !== 'none') {
    const f = fixture('confirmation', s);
    const msg = message(f, { from: o.from ? o.from(s) : f.from });
    gmail.add(msg, { inHistory: false });
    await upsertEmailThread(t.handle, {
      userId: t.userId,
      gmailThreadId: msg.threadId,
      kind,
      applicationId: s.application.id,
    });
  }
  const d = makeDeps(gmail, inboxLlm({ classify: {} }));
  const run = () =>
    runFollowUp(t.handle, { userId: t.userId, applicationId: s.application.id }, d.deps);
  const log = async () =>
    (await activity.listByUser(t.handle, t.userId)).filter((e) => e.action.startsWith('follow_up'));
  return { t, s, gmail, run, log, ...d };
}

describe('rule 12: follow-up', () => {
  it('sends nothing on a thread flagged for compensation, even when it is only a confirmation', async () => {
    const r = await setup();
    const threads = await listEmailThreadsForApplication(r.t.handle, r.s.application.id);
    await upsertEmailThread(r.t.handle, {
      userId: r.t.userId,
      gmailThreadId: threads[0]!.gmailThreadId,
      kind: 'confirmation',
      compensationFlag: true,
      applicationId: r.s.application.id,
    });
    const out = await r.run();
    expect(out).toEqual({ sent: false, reason: 'compensation_flagged' });
    expect(r.sender.sent).toHaveLength(0);
  });

  it('uses the application id as the delivery key, so a repeated run cannot send twice', async () => {
    const r = await setup();
    await r.run();
    await updateApplication(r.t.handle, r.s.application.id, { followedUpAt: null });
    const again = await r.run();
    expect(again).toMatchObject({ sent: true });
    expect(r.sender.sent).toHaveLength(1);
    const rows = await listOutgoingMessagesForApplication(r.t.handle, r.s.application.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveryKey).toBe(`follow_up:${r.s.application.id}`);
  });

  it('sends one plain follow-up to the confirmation sender, stores it and sets followed_up_at', async () => {
    const r = await setup();
    const out = await r.run();
    expect(out).toEqual({ sent: true, to: `recruiting@${r.s.domain}` });
    expect(r.sender.sent).toHaveLength(1);
    expect(r.sender.sent[0]).toMatchObject({
      to: `recruiting@${r.s.domain}`,
      kind: 'follow_up',
      applicationId: r.s.application.id,
    });
    expect(r.sender.sent[0]!.text).toContain(r.s.title);
    expect(r.sender.sent[0]!.text).toContain(r.s.companyName);
    expect(r.sender.sent[0]!.text).toContain('March 10, 2026');
    const stored = await listOutgoingMessagesForApplication(r.t.handle, r.s.application.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      kind: 'follow_up',
      blocked: false,
      toAddress: `recruiting@${r.s.domain}`,
    });
    expect((await getApplication(r.t.handle, r.s.application.id))!.followedUpAt).toEqual(NOW);
    expect((await r.log()).map((e) => e.action)).toEqual(['follow_up_sent']);
  });

  it('never sends a second follow-up', async () => {
    const r = await setup();
    await r.run();
    expect(await r.run()).toEqual({ sent: false, reason: 'already_followed_up' });
    expect(r.sender.sent).toHaveLength(1);
  });

  it('skips when the application already has a follow-up timestamp', async () => {
    const r = await setup({ followedUpAt: new Date('2026-03-17T00:00:00Z') });
    expect(await r.run()).toEqual({ sent: false, reason: 'already_followed_up' });
    expect(r.sender.sent).toHaveLength(0);
  });

  it.each(['pending', 'interviewing', 'offer', 'closed'] as const)(
    'skips when the application is %s',
    async (status) => {
      const r = await setup({ status });
      expect(await r.run()).toEqual({ sent: false, reason: 'not_applied' });
      expect(r.sender.sent).toHaveLength(0);
      expect((await r.log())[0]!.detail).toMatchObject({ reason: 'not_applied', status });
    },
  );

  it('skips when a thread beyond the confirmation is linked (the employer replied)', async () => {
    const r = await setup({ thread: 'other' });
    expect(await r.run()).toEqual({ sent: false, reason: 'employer_replied' });
    expect(r.sender.sent).toHaveLength(0);
  });

  it('skips with no_contact when there is no linked thread to take an address from', async () => {
    const r = await setup({ thread: 'none' });
    expect(await r.run()).toEqual({ sent: false, reason: 'no_contact' });
    expect(r.sender.sent).toHaveLength(0);
    expect((await r.log())[0]).toMatchObject({
      action: 'follow_up_skipped',
      detail: { reason: 'no_contact' },
    });
    expect((await getApplication(r.t.handle, r.s.application.id))!.followedUpAt).toBeNull();
  });

  it('skips with no_contact when the confirmation came from a no-reply address', async () => {
    const r = await setup({ from: (s) => `Acme Careers <no-reply@${s.domain}>` });
    expect(await r.run()).toEqual({ sent: false, reason: 'no_contact' });
    expect(r.sender.sent).toHaveLength(0);
  });

  it('skips before seven days have passed', async () => {
    const r = await setup({ appliedAt: new Date('2026-03-18T12:00:00Z') });
    expect(await r.run()).toEqual({ sent: false, reason: 'too_early' });
  });

  it('a guard block is stored and logged, nothing is sent, and the follow-up is not marked sent', async () => {
    const r = await setup({ companyName: 'Equity Partners' });
    const out = await r.run();
    expect(out).toEqual({ sent: false, reason: 'blocked' });
    expect(r.sender.sent).toHaveLength(0);
    const stored = await listOutgoingMessagesForApplication(r.t.handle, r.s.application.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ blocked: true, sentAt: null });
    const all = (await activity.listByUser(r.t.handle, r.t.userId)).map((e) => e.action);
    expect(all).toContain('send_blocked');
    expect((await getApplication(r.t.handle, r.s.application.id))!.followedUpAt).toBeNull();
  });

  it('a send failure leaves the follow-up unmarked and a pending receipt; the retry reconciles with Gmail before sending', async () => {
    const r = await setup();
    const realSend = r.sender.send.bind(r.sender);
    r.sender.send = vi.fn(async () => {
      throw new Error('gmail 503');
    });
    await expect(r.run()).rejects.toThrow('gmail 503');
    expect((await getApplication(r.t.handle, r.s.application.id))!.followedUpAt).toBeNull();
    const rows = await listOutgoingMessagesForApplication(r.t.handle, r.s.application.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'pending', sentAt: null });

    // Without a way to ask Gmail the outcome stays unresolved and nothing is sent twice.
    r.sender.send = realSend;
    expect(await r.run()).toEqual({ sent: false, reason: 'send_uncertain' });
    expect(r.sender.sent).toHaveLength(0);

    // With a lookup that finds nothing in Sent the receipt is dropped and the send happens once.
    const mail = r.deps.mail;
    r.deps.mail = (h, u) => ({ ...mail(h, u), lookup: { find: async () => null } });
    expect(await r.run()).toMatchObject({ sent: true });
    expect(r.sender.sent).toHaveLength(1);
    expect(await listOutgoingMessagesForApplication(r.t.handle, r.s.application.id)).toHaveLength(
      1,
    );
  });

  it('a send Gmail already accepted (found in Sent) is adopted, not repeated', async () => {
    const r = await setup();
    r.sender.send = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    await expect(r.run()).rejects.toThrow();
    const mail = r.deps.mail;
    r.deps.mail = (h, u) => ({
      ...mail(h, u),
      lookup: { find: async () => ({ messageId: 'g-sent-1' }) },
    });
    r.sender.send = vi.fn(async () => ({ messageId: 'dup' }));
    expect(await r.run()).toMatchObject({ sent: true });
    expect(r.sender.send).not.toHaveBeenCalled();
    const rows = await listOutgoingMessagesForApplication(r.t.handle, r.s.application.id);
    expect(rows[0]).toMatchObject({ state: 'sent', gmailMessageId: 'g-sent-1' });
    expect((await getApplication(r.t.handle, r.s.application.id))!.followedUpAt).not.toBeNull();
  });

  it('an unknown application is a no-op', async () => {
    const r = await setup();
    const out = await runFollowUp(
      r.t.handle,
      { userId: r.t.userId, applicationId: crypto.randomUUID() },
      r.deps,
    );
    expect(out).toEqual({ sent: false, reason: 'application_missing' });
  });
});

describe('follow-up text and addresses', () => {
  it('names the role, company and date, makes no claim about experience and passes the money guard', () => {
    const m = renderFollowUp({
      senderName: 'Mara Quill',
      companyName: 'Harbor Robotics',
      jobTitle: 'Staff Platform Engineer',
      appliedAt: new Date('2026-03-03T00:00:00Z'),
    });
    expect(m.subject).toContain('Staff Platform Engineer');
    expect(m.text).toContain(
      'Staff Platform Engineer position at Harbor Robotics on March 3, 2026',
    );
    expect(m.text).not.toMatch(/\$|salary|compensation|equity|experience|years/i);
    expect(m.html).toContain('<p>');
  });

  it('escapes employer-controlled names in the html part', () => {
    const m = renderFollowUp({
      senderName: 'M',
      companyName: 'A<b>&Co',
      jobTitle: 'Dev',
      appliedAt: NOW,
    });
    expect(m.html).toContain('A&lt;b&gt;&amp;Co');
  });

  it.each([
    ['no-reply@acme.com', false],
    ['noreply@acme.com', false],
    ['do-not-reply@acme.com', false],
    ['donotreply+x@acme.com', false],
    ['mailer-daemon@acme.com', false],
    ['dana@acme.com', true],
    ['recruiting@acme.com', true],
    ['replyto@acme.com', true],
  ])('%s replyable: %s', (addr, ok) => {
    expect(isReplyable(addr)).toBe(ok);
  });
});

describe('task 4.1: one follow-up job per application', () => {
  it('the job id and singleton key are the application id, so a second enqueue is the same job', async () => {
    const send = vi.fn(async () => 'job-1');
    const boss = { createQueue: vi.fn(async () => {}), send } as unknown as PgBoss;
    const queue = createFollowUpQueue(boss);
    const data = { tenantId: 't', userId: 'u', applicationId: 'app-1' };
    const at = new Date('2026-03-17T09:00:00Z');
    await queue.enqueueFollowUp(data, at);
    await queue.enqueueFollowUp(data, at);
    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls as unknown as Array<
      [string, unknown, Record<string, unknown>]
    >) {
      expect(call[0]).toBe(FOLLOW_UP_JOB);
      expect(call[2]).toMatchObject({ id: 'app-1', singletonKey: 'app-1', startAfter: at });
    }
  });
});
