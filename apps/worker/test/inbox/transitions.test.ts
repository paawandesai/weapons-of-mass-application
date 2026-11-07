import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  getApplication,
  getEmailThreadByGmailId,
  getMailSyncState,
  isMessageProcessed,
  listOutgoingMessagesForUser,
  upsertMailSyncState,
  type ApplicationStatus,
} from '@wma/db';
import { InboxClassificationJsonSchema } from '@wma/shared';
import { CalendarUnavailableError } from '../../src/scheduling/offer';
import { INBOX_CLASSIFY_PROMPT } from '../../src/inbox/classify';
import { processMessage, runMailSync } from '../../src/inbox/sync';
import {
  approve,
  classifyAnswers,
  FakeInboxGmail,
  fixture,
  inboxLlm,
  makeDeps,
  message,
  seed,
  setupInboxEnv,
  type InboxEnv,
  type MessageFixture,
} from './support';

let env: InboxEnv;
beforeAll(async () => {
  env = await setupInboxEnv();
});
afterAll(async () => {
  await env.cleanup();
});

/** Seeds an application in `status`, delivers one fixture through the sync, returns what happened. */
async function deliver(
  name: string,
  status: ApplicationStatus = 'applied',
  mutate?: (f: MessageFixture) => MessageFixture,
) {
  const t = await env.makeTenant();
  await approve(t);
  await upsertMailSyncState(t.handle, t.userId, { historyId: 'h-1' });
  const s = await seed(t, { status, appliedAt: status === 'pending' ? null : undefined });
  const f = mutate ? mutate(fixture(name, s)) : fixture(name, s);
  const gmail = new FakeInboxGmail();
  gmail.add(message(f));
  const llm = inboxLlm({ classify: classifyAnswers(f) });
  const d = makeDeps(gmail, llm);
  await runMailSync(t.handle, t.userId, d.deps);
  const app = (await getApplication(t.handle, s.application.id))!;
  const log = await activity.listByUser(t.handle, t.userId);
  const flags = log
    .filter((e) => e.action === 'digest_flag')
    .map((e) => e.detail as Record<string, unknown>);
  const thread = await getEmailThreadByGmailId(t.handle, f.threadId);
  return { t, s, f, app, log, flags, thread, llm, ...d };
}

describe('rule 3: classification', () => {
  it.each([
    ['confirmation', 'confirmation'],
    ['rejection', 'rejection'],
    ['interview', 'interview'],
    ['offer', 'offer'],
    ['other', 'other'],
  ])('fixture %s is stored as %s with the prompt version', async (name, kind) => {
    const r = await deliver(name);
    expect(r.thread).toMatchObject({ kind, promptVersion: INBOX_CLASSIFY_PROMPT });
    expect(INBOX_CLASSIFY_PROMPT).toBe('inbox-classify@v1');
  });

  it('sends the model the company, title and message, with the shared schema, and nothing about other applications', async () => {
    const r = await deliver('interview');
    const call = r.llm.calls.find((c) => c.prompt === 'inbox-classify/v1')!;
    expect(call.user).toContain(`Company: ${r.s.companyName}`);
    expect(call.user).toContain(`Job title: ${r.s.title}`);
    expect(call.user).toContain('Tuesday March 24, 2026');
    expect(call.system).toMatch(/proposed_slots/);
    expect(Object.keys((InboxClassificationJsonSchema.properties ?? {}) as object)).toEqual([
      'classification',
      'compensation_flag',
      'booking_link',
      'proposed_slots',
    ]);
  });

  it('a compensation question is flagged on the thread and in the digest, with its slot still offered', async () => {
    const r = await deliver('compensation-question');
    expect(r.thread).toMatchObject({ kind: 'interview', compensationFlag: true });
    expect(r.flags).toContainEqual(expect.objectContaining({ kind: 'compensation' }));
  });

  it('a booking link is stored on the thread and flagged with the link', async () => {
    const r = await deliver('booking-link');
    expect(r.thread?.bookingLink).toBe(`https://cal.${r.s.domain}/dana/intro-call`);
    expect(r.flags).toContainEqual(
      expect.objectContaining({
        kind: 'booking_link',
        link: `https://cal.${r.s.domain}/dana/intro-call`,
      }),
    );
  });

  it('a non-URL booking link from the model is treated as absent', async () => {
    const r = await deliver('booking-link', 'applied', (f) => ({
      ...f,
      classification: { ...f.classification, booking_link: 'javascript:alert(1)' },
    }));
    expect(r.thread?.bookingLink).toBeNull();
    expect(r.flags.some((f) => f.kind === 'booking_link')).toBe(false);
  });
});

describe('rule 4: status transitions from mail (integration)', () => {
  it('a rejection closes the application with reason rejected and logs status_changed', async () => {
    const r = await deliver('rejection');
    expect(r.app).toMatchObject({ status: 'closed', closedReason: 'rejected' });
    const entry = r.log.find((e) => e.action === 'status_changed');
    expect(entry).toMatchObject({ applicationId: r.s.application.id, actor: 'agent' });
    expect(entry!.detail).toMatchObject({
      from: 'applied',
      to: 'closed',
      closed_reason: 'rejected',
      via: 'email',
    });
  });

  it('a rejection also closes an Interviewing application', async () => {
    const r = await deliver('rejection', 'interviewing');
    expect(r.app).toMatchObject({ status: 'closed', closedReason: 'rejected' });
  });

  it('an interview invitation moves Applied to Interviewing', async () => {
    const r = await deliver('interview');
    expect(r.app.status).toBe('interviewing');
  });

  it('an offer moves Applied to Offer, and the dollar figure only flags the thread', async () => {
    const r = await deliver('offer');
    expect(r.app.status).toBe('offer');
    expect(r.thread?.compensationFlag).toBe(true);
    expect(r.sender.sent).toHaveLength(0);
  });

  it('a confirmation on a Pending application makes it Applied with confirmation source email', async () => {
    const r = await deliver('confirmation', 'pending');
    expect(r.app).toMatchObject({ status: 'applied', confirmationSource: 'email' });
    expect(r.app.appliedAt).toEqual(new Date(r.f.date));
    expect(r.log.find((e) => e.action === 'status_changed')!.detail).toMatchObject({
      from: 'pending',
      to: 'applied',
    });
  });

  it('a confirmation on an Applied application changes only the last-activity timestamp', async () => {
    const before = Date.now();
    const r = await deliver('confirmation');
    expect(r.app.status).toBe('applied');
    expect(r.log.some((e) => e.action === 'status_changed')).toBe(false);
    expect(r.app.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('an unclassifiable message leaves the status alone', async () => {
    const r = await deliver('other');
    expect(r.app.status).toBe('applied');
    expect(r.log.some((e) => e.action === 'status_changed')).toBe(false);
  });

  it('an Offer is never moved backwards by an interview message', async () => {
    const r = await deliver('interview', 'offer');
    expect(r.app.status).toBe('offer');
  });
});

describe('rule 5: activity on a closed application', () => {
  it('an interview message on a Closed application leaves it Closed and sets a digest flag', async () => {
    const r = await deliver('interview', 'closed');
    expect(r.app.status).toBe('closed');
    expect(r.log.some((e) => e.action === 'status_changed')).toBe(false);
    expect(r.flags).toContainEqual(
      expect.objectContaining({ kind: 'activity_on_closed', classification: 'interview' }),
    );
    expect(r.offerSlots).not.toHaveBeenCalled();
  });

  it('an offer on a Closed application is flagged the same way', async () => {
    const r = await deliver('offer', 'closed');
    expect(r.app.status).toBe('closed');
    expect(r.flags).toContainEqual(
      expect.objectContaining({ kind: 'activity_on_closed', classification: 'offer' }),
    );
  });

  it('a first-time thread for a closed application is found by the deterministic pass', async () => {
    const r = await deliver('rejection', 'closed');
    expect(r.thread?.applicationId).toBe(r.s.application.id);
    expect(r.app.status).toBe('closed');
  });
});

describe('rules 6 and 7: compensation and booking links', () => {
  it('compensation: nothing is sent, the slots are still handed to scheduling with the flag', async () => {
    const r = await deliver('compensation-question');
    expect(r.sender.sent).toHaveLength(0);
    expect(await listOutgoingMessagesForUser(r.t.handle, r.t.userId)).toHaveLength(0);
    expect(r.offerSlots).toHaveBeenCalledTimes(1);
    expect(r.offerSlots).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: r.t.userId,
        applicationId: r.s.application.id,
        threadId: r.thread!.id,
        messageId: r.f.id,
        compensationFlag: true,
        slots: r.f.classification.proposed_slots,
      }),
    );
  });

  it('booking link: digest item with the link, no slots offered, no reply', async () => {
    const r = await deliver('booking-link');
    expect(r.offerSlots).not.toHaveBeenCalled();
    expect(r.sender.sent).toHaveLength(0);
    expect(r.flags.filter((f) => f.kind === 'booking_link')).toHaveLength(1);
  });

  it('booking link wins over stray slots in the same message', async () => {
    const r = await deliver('booking-link', 'applied', (f) => ({
      ...f,
      classification: {
        ...f.classification,
        proposed_slots: fixture('interview').classification.proposed_slots,
      },
    }));
    expect(r.offerSlots).not.toHaveBeenCalled();
  });

  it('an interview with slots hands all of them over (ambiguous ones included) after the commit', async () => {
    const r = await deliver('interview');
    expect(r.offerSlots).toHaveBeenCalledTimes(1);
    const [, input] = r.offerSlots.mock.calls[0] as unknown as [
      unknown,
      { slots: unknown[]; compensationFlag: boolean },
    ];
    expect(input.slots).toHaveLength(3);
    expect(input.compensationFlag).toBe(false);
    expect(r.sender.sent).toHaveLength(0);
  });

  async function interviewWith(offer: () => Promise<unknown>) {
    const t = await env.makeTenant();
    await approve(t);
    await upsertMailSyncState(t.handle, t.userId, { historyId: 'h-1' });
    const s = await seed(t);
    const f = fixture('interview', s);
    const gmail = new FakeInboxGmail();
    gmail.historyId = 'h-2';
    gmail.add(message(f));
    const d = makeDeps(gmail, inboxLlm({ classify: classifyAnswers(f) }));
    d.deps.recordOffer = async () => {
      await offer();
      return { send: null };
    };
    const out = await runMailSync(t.handle, t.userId, d.deps);
    return { t, s, f, gmail, d, out };
  }

  it('an unreadable calendar defers the message: not processed, status untouched, mark held, retried next sync', async () => {
    let fail = true;
    const r = await interviewWith(async () => {
      if (fail) throw new CalendarUnavailableError();
    });
    expect(r.out).toMatchObject({ status: 'ok', deferred: 1, linked: 0, historyId: 'h-2' });
    expect(await isMessageProcessed(r.t.handle, r.f.id)).toBe(false);
    expect((await getApplication(r.t.handle, r.s.application.id))!.status).toBe('applied');
    expect(await getEmailThreadByGmailId(r.t.handle, r.f.threadId)).toBeNull();
    // The mark moves on; the deferred message is kept by id, independent of any dated window.
    const state = await getMailSyncState(r.t.handle, r.t.userId);
    expect(state!.historyId).toBe('h-2');
    expect(state!.deferredMessageIds).toEqual([r.f.id]);

    fail = false;
    r.gmail.history = [];
    const again = await runMailSync(r.t.handle, r.t.userId, r.d.deps);
    expect(again).toMatchObject({ deferred: 0, linked: 1, historyId: 'h-2' });
    expect((await getMailSyncState(r.t.handle, r.t.userId))!.deferredMessageIds).toEqual([]);
    expect((await getApplication(r.t.handle, r.s.application.id))!.status).toBe('interviewing');
  });

  it('a deferred message survives a dated fallback whose window no longer covers it', async () => {
    let fail = true;
    const r = await interviewWith(async () => {
      if (fail) throw new CalendarUnavailableError();
    });
    expect(r.out).toMatchObject({ deferred: 1 });
    fail = false;
    r.gmail.expired = true;
    r.gmail.history = [];
    const again = await runMailSync(r.t.handle, r.t.userId, r.d.deps);
    expect(again).toMatchObject({ mode: 'dated', deferred: 0, linked: 1 });
  });

  it('the confirmation email is sent after the message transaction commits, not inside it', async () => {
    const t = await env.makeTenant();
    await approve(t);
    await upsertMailSyncState(t.handle, t.userId, { historyId: 'h-1' });
    const s = await seed(t);
    const f = fixture('interview', s);
    const gmail = new FakeInboxGmail();
    gmail.historyId = 'h-2';
    gmail.add(message(f));
    const d = makeDeps(gmail, inboxLlm({ classify: classifyAnswers(f) }));
    let committedWhenSent: boolean | null = null;
    d.deps.sendOfferEmail = async () => {
      committedWhenSent = await isMessageProcessed(t.handle, f.id);
    };
    const out = await runMailSync(t.handle, t.userId, d.deps);
    expect(out).toMatchObject({ linked: 1 });
    expect(committedWhenSent).toBe(true);
  });

  it('a send failure after commit leaves the message processed (the repair pass resends)', async () => {
    const t = await env.makeTenant();
    await approve(t);
    await upsertMailSyncState(t.handle, t.userId, { historyId: 'h-1' });
    const s = await seed(t);
    const f = fixture('interview', s);
    const gmail = new FakeInboxGmail();
    gmail.historyId = 'h-2';
    gmail.add(message(f));
    const d = makeDeps(gmail, inboxLlm({ classify: classifyAnswers(f) }));
    d.deps.sendOfferEmail = async () => {
      throw new Error('gmail 503');
    };
    const out = await runMailSync(t.handle, t.userId, d.deps);
    expect(out).toMatchObject({ status: 'ok', linked: 1, failed: 0 });
    expect(await isMessageProcessed(t.handle, f.id)).toBe(true);
    const log = await activity.listByUser(t.handle, t.userId);
    expect(log.some((e) => e.action === 'offer_email_failed')).toBe(true);
  });

  it('an authentication failure while sending the confirmation revokes the mailbox and holds the mark', async () => {
    const t = await env.makeTenant();
    await approve(t);
    await upsertMailSyncState(t.handle, t.userId, { historyId: 'h-1' });
    const s = await seed(t);
    const f = fixture('interview', s);
    const gmail = new FakeInboxGmail();
    gmail.historyId = 'h-2';
    gmail.add(message(f));
    const d = makeDeps(gmail, inboxLlm({ classify: classifyAnswers(f) }));
    d.deps.sendOfferEmail = async () => {
      throw Object.assign(new Error('unauthorized'), { code: 401 });
    };
    const out = await runMailSync(t.handle, t.userId, d.deps);
    expect(out).toEqual({ status: 'reauth_needed' });
    const state = await getMailSyncState(t.handle, t.userId);
    expect(state).toMatchObject({ historyId: 'h-1', reauthNeeded: true });
  });

  it('an authentication failure while recording the offer is not a per-message failure', async () => {
    const r = await interviewWith(async () => {
      throw Object.assign(new Error('invalid_grant'), { code: 401 });
    });
    expect(r.out).toEqual({ status: 'reauth_needed' });
    expect(await isMessageProcessed(r.t.handle, r.f.id)).toBe(false);
    expect((await getMailSyncState(r.t.handle, r.t.userId))!.historyId).toBe('h-1');
  });

  it('any other scheduling failure fails that message only (recorded, skipped) and the sync completes', async () => {
    const r = await interviewWith(async () => {
      throw new Error('boom');
    });
    expect(r.out).toMatchObject({ status: 'ok', failed: 1, historyId: 'h-2' });
    expect(await isMessageProcessed(r.t.handle, r.f.id)).toBe(true);
  });

  it('runs the scheduling repair passes after the batch', async () => {
    const r = await interviewWith(async () => undefined);
    expect(r.d.deps.resendPendingConfirmations).toHaveBeenCalledWith(expect.anything(), r.t.userId);
    expect(r.d.deps.requeueUnbookedInterviews).toHaveBeenCalledWith(expect.anything(), r.t.userId);
  });
});

describe('concurrent classifications', () => {
  it('a rejection and an interview processed at the same time end Closed, whichever commits first', async () => {
    for (let round = 0; round < 3; round++) {
      const t = await env.makeTenant();
      await approve(t);
      const s = await seed(t);
      const rej = fixture('rejection', s);
      const itv = fixture('interview', s);
      const gmail = new FakeInboxGmail();
      gmail.add(message(rej));
      gmail.add(message(itv));
      const d = makeDeps(gmail, inboxLlm({ classify: classifyAnswers(rej, itv) }));
      const outcomes = await Promise.all([
        processMessage(t.handle, t.userId, t.email, rej.id, message(rej), d.deps),
        processMessage(t.handle, t.userId, t.email, itv.id, message(itv), d.deps),
      ]);
      const failures = (await activity.listByUser(t.handle, t.userId)).filter(
        (e) => e.action === 'processing_failed',
      );
      expect(failures.map((e) => e.detail)).toEqual([]);
      expect(outcomes).toEqual(['linked', 'linked']);
      expect((await getApplication(t.handle, s.application.id))!.status).toBe('closed');
    }
  });
});
