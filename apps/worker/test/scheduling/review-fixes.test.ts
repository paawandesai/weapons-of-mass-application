import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  applyTransition,
  getApplication,
  getInterview,
  getInterviewByThread,
  insertProfileVersion,
  listInterviewsAwaitingBooking,
  listSlotsForInterview,
  setApprovedProfileVersion,
  upsertEmailThread,
} from '@wma/db';
import {
  BOOK_QUEUE_OPTIONS as SHARED_BOOK_QUEUE_OPTIONS,
  profileDocumentSchema,
} from '@wma/shared';
import profile from '../../../../packages/shared/test/fixtures/profile.full.json';
import { BOOK_QUEUE_OPTIONS, runBookInterview } from '../../src/jobs/book-interview';
import {
  bookInterview,
  CalendarUnavailableError,
  EventCreationError,
  formatSlot,
  offerSlots,
  recordOffer,
  requeueUnbookedInterviews,
  resendPendingConfirmations,
  sendOfferEmail,
} from '../../src/scheduling';
import {
  confirmToken,
  makeHarness,
  NOW,
  offerInput,
  proposed,
  seedThread,
  setupSchedulingEnv,
  sha256,
  threeSlots,
  tokensIn,
  type Harness,
  type SchedulingTestEnv,
  type Seeded,
} from './support';

let env: SchedulingTestEnv;
beforeAll(async () => {
  env = await setupSchedulingEnv();
});
afterAll(async () => {
  await env.cleanup();
});

const replies = (h: Harness) => h.sender.sent.filter((m) => m.kind === 'recruiter_reply');
const requests = (h: Harness) => h.sender.sent.filter((m) => m.kind === 'slot_confirmation');
const book = (s: Seeded, h: Harness, interviewId: string) =>
  bookInterview(s.t.handle, { userId: s.t.userId, interviewId }, h.deps);

async function offerAndConfirm(s: Seeded, h: Harness, n = 0, threadId = s.thread.id) {
  const out = await offerSlots(s.t.handle, { ...offerInput(s, threeSlots()), threadId }, h.deps);
  const request = requests(h).at(-1)!;
  expect((await confirmToken(s.t.handle, tokensIn(request)[n]!)).ok).toBe(true);
  return out.interviewId!;
}

const reschedule = (s: Seeded, h: Harness) =>
  offerSlots(
    s.t.handle,
    {
      ...offerInput(s, [
        proposed('2037-11-17T09:00:00-08:00'),
        proposed('2037-11-18T09:00:00-08:00'),
      ]),
      messageId: 'gmail-msg-2',
    },
    h.deps,
  );

describe('recordOffer / sendOfferEmail split', () => {
  it('recordOffer rolls back with the caller transaction and sends nothing', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    await expect(
      s.t.handle.transaction(async (tx) => {
        const rec = await recordOffer(tx, offerInput(s, threeSlots()), h.deps);
        expect(rec.status).toBe('offered');
        expect(rec.issued).toHaveLength(3);
        throw new Error('message transaction failed');
      }),
    ).rejects.toThrow('message transaction failed');
    expect(await getInterviewByThread(s.t.handle, s.thread.id)).toBeNull();
    expect(h.sender.sent).toHaveLength(0);
  });

  it('records slots and hashed tokens in the transaction; the email goes out after commit and marks the interview', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const rec = await s.t.handle.transaction((tx) =>
      recordOffer(tx, offerInput(s, threeSlots()), h.deps),
    );
    expect(h.sender.sent).toHaveLength(0);
    const id = rec.interviewId!;
    let row = (await getInterview(s.t.handle, id))!;
    expect(row.confirmationEmailSentAt).toBeNull();
    const slots = await listSlotsForInterview(s.t.handle, id);
    expect(slots.map((x) => x.tokenHash).sort()).toEqual(
      rec.issued.map((i) => sha256(i.token)).sort(),
    );

    expect(await sendOfferEmail(s.t.handle, id, h.deps, rec.issued)).toBe('sent');
    expect(requests(h)).toHaveLength(1);
    expect(tokensIn(requests(h)[0]!)).toEqual(rec.issued.map((i) => i.token));
    row = (await getInterview(s.t.handle, id))!;
    expect(row.confirmationEmailSentAt).toEqual(NOW);
    // The links in the email are the ones that were stored.
    expect((await confirmToken(s.t.handle, rec.issued[1]!.token)).ok).toBe(true);
  });

  it('a crash between commit and send leaves the gap that resendPendingConfirmations repairs', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const rec = await s.t.handle.transaction((tx) =>
      recordOffer(tx, offerInput(s, threeSlots()), h.deps),
    );
    // (the worker died here: no sendOfferEmail)
    expect(await resendPendingConfirmations(s.t.handle, s.t.userId, h.deps)).toBe(1);
    expect(requests(h)).toHaveLength(1);
    // The lost tokens are replaced; the new links work and the old ones do not.
    const fresh = tokensIn(requests(h)[0]!);
    expect(fresh).toHaveLength(3);
    expect((await confirmToken(s.t.handle, rec.issued[0]!.token)).ok).toBe(false);
    expect((await confirmToken(s.t.handle, fresh[0]!)).ok).toBe(true);
    expect(await resendPendingConfirmations(s.t.handle, s.t.userId, h.deps)).toBe(0);
  });

  it('a blocked confirmation email is not recorded as sent and the repair pass retries it', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    h.setGuards([{ name: 'test', check: () => ({ ok: false, reason: 'blocked' }) }]);
    const out = await offerSlots(s.t.handle, offerInput(s, threeSlots()), h.deps);
    expect(out.status).toBe('blocked');
    expect((await getInterview(s.t.handle, out.interviewId!))?.confirmationEmailSentAt).toBeNull();
    h.setGuards([]);
    expect(await resendPendingConfirmations(s.t.handle, s.t.userId, h.deps)).toBe(1);
  });
});

describe('calendar event idempotency', () => {
  it('a lost response retries the same client event id and never creates a second event', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const interviewId = await offerAndConfirm(s, h);
    h.calendar.loseResponses = 1;

    await expect(book(s, h, interviewId)).rejects.toBeInstanceOf(EventCreationError);
    const mid = (await getInterview(s.t.handle, interviewId))!;
    // The id was persisted before the insert, and the event already exists in the calendar.
    expect(mid.calendarEventClientId).toMatch(/^[0-9a-f]{32}$/);
    expect(mid.calendarEventId).toBeNull();
    expect(h.calendar.events.has(mid.calendarEventClientId!)).toBe(true);

    const out = await book(s, h, interviewId);
    expect(out).toMatchObject({ status: 'booked', eventId: mid.calendarEventClientId });
    expect(h.calendar.events.size).toBe(1);
    expect(h.calendar.created).toHaveLength(1);
    expect(replies(h)).toHaveLength(1);
  });
});

describe('booking queue options', () => {
  it('the exclusive policy is shared by the worker and the API creation sites', () => {
    expect(BOOK_QUEUE_OPTIONS).toBe(SHARED_BOOK_QUEUE_OPTIONS);
    expect(BOOK_QUEUE_OPTIONS.policy).toBe('exclusive');
    expect(BOOK_QUEUE_OPTIONS.retryLimit).toBe(5);
  });
});

describe('booking is serialized against a reschedule (confirmed generation)', () => {
  it('a booking that is overtaken by a reschedule and a new confirmation sends nothing and writes nothing', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const interviewId = await offerAndConfirm(s, h, 0);
    // Runs after the job read its snapshot and before it takes the lock.
    h.deps.scheduleReminders = async () => {
      await reschedule(s, h);
      const request = requests(h).at(-1)!;
      expect((await confirmToken(s.t.handle, tokensIn(request)[1]!)).ok).toBe(true);
    };
    const stale = await book(s, h, interviewId);
    expect(stale).toEqual({ status: 'stale' });
    expect(replies(h)).toHaveLength(0);
    expect(h.calendar.events.size).toBe(0);
    const row = (await getInterview(s.t.handle, interviewId))!;
    expect(row.replySentAt).toBeNull();
    expect(row.bookedGeneration).toBeNull();
    expect(row.confirmedGeneration).toBe(3);

    // The next job books the CURRENT slot (18 Nov), once.
    h.deps.scheduleReminders = async () => undefined;
    expect(await book(s, h, interviewId)).toMatchObject({ status: 'booked' });
    expect(replies(h)).toHaveLength(1);
    expect(replies(h)[0]!.text).toContain('Wednesday, November 18, 2037, 9:00 AM');
  });

  it('a reschedule that starts while the reply is being sent waits for it, then clears the markers it set', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const interviewId = await offerAndConfirm(s, h, 0);
    let overtaking: Promise<unknown> | null = null;
    const inner = h.mailbox.context;
    h.mailbox.replyContext = async () => {
      // Started while the booking holds the interview row; it must queue behind it.
      overtaking = reschedule(s, h);
      await new Promise((r) => setTimeout(r, 100));
      return inner;
    };
    const out = await book(s, h, interviewId);
    // Which one wins the lock after the reply commits is a race; both end in the same state.
    expect(['booked', 'stale']).toContain(out.status);
    await overtaking;
    const row = (await getInterview(s.t.handle, interviewId))!;
    // The reschedule applied last: unconfirmed, no stale reply marker, a new generation.
    expect(row.confirmedSlotId).toBeNull();
    expect(row.replySentAt).toBeNull();
    expect(row.confirmedGeneration).toBe(2);
    expect(replies(h)).toHaveLength(1);
    expect(requests(h)).toHaveLength(2);
  });
});

describe('status transitions are applied against the current status', () => {
  it('a rejection that committed during booking is not overwritten by Interviewing', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const interviewId = await offerAndConfirm(s, h, 0);
    h.deps.scheduleReminders = async () => {
      expect(await applyTransition(s.t.handle, s.application.id, 'rejection')).toMatchObject({
        changed: true,
        to: 'closed',
      });
    };
    expect(await book(s, h, interviewId)).toMatchObject({ status: 'booked' });
    const app = (await getApplication(s.t.handle, s.application.id))!;
    expect(app.status).toBe('closed');
    expect(app.closedReason).toBe('rejected');
    const changes = (await activity.listByUser(s.t.handle, s.t.userId)).filter(
      (e) => e.action === 'status_changed',
    );
    expect(changes.every((e) => (e.detail as { to: string }).to !== 'interviewing')).toBe(true);
  });

  it('applyTransition moves forward only and reports what changed', async () => {
    const s = await seedThread(env);
    const h = (id: string, c: Parameters<typeof applyTransition>[2]) =>
      applyTransition(s.t.handle, id, c);
    expect(await h(s.application.id, 'other')).toMatchObject({
      changed: false,
      reason: 'no_change',
    });
    expect(await h(s.application.id, 'interview')).toMatchObject({
      changed: true,
      from: 'applied',
      to: 'interviewing',
    });
    expect(await h(s.application.id, 'interview')).toMatchObject({ changed: false });
    expect(await h(s.application.id, 'offer')).toMatchObject({ changed: true, to: 'offer' });
    expect(await h(s.application.id, 'interview')).toMatchObject({ changed: false });
    expect(await h(s.application.id, 'rejection')).toMatchObject({ changed: true, to: 'closed' });
    expect(await h(s.application.id, 'offer')).toMatchObject({ changed: false });
    expect(await h('00000000-0000-4000-8000-000000000000', 'offer')).toMatchObject({
      changed: false,
      reason: 'not_found',
    });
  });

  it('two concurrent transitions end on the later-in-order status without a lost update', async () => {
    const s = await seedThread(env);
    const [a, b] = await Promise.all([
      applyTransition(s.t.handle, s.application.id, 'interview'),
      applyTransition(s.t.handle, s.application.id, 'rejection'),
    ]);
    const final = (await getApplication(s.t.handle, s.application.id))!;
    // Whatever order they ran in, the card ends closed: closed is a sink and never reverts.
    expect(final.status).toBe('closed');
    expect([a.changed, b.changed].filter(Boolean).length).toBeGreaterThanOrEqual(1);
  });
});

describe('recovered recruiter replies match the interview and slot', () => {
  it('a reply sent for one interview is not mistaken for another interview on the same application', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const first = await offerAndConfirm(s, h, 0);
    const thread2 = await upsertEmailThread(s.t.handle, {
      userId: s.t.userId,
      gmailThreadId: `thr2-${s.thread.gmailThreadId}`,
      kind: 'interview',
      applicationId: s.application.id,
    });
    const second = await offerAndConfirm(s, h, 1, thread2.id);
    expect(second).not.toBe(first);

    await book(s, h, first);
    expect(replies(h)).toHaveLength(1);
    await book(s, h, second);
    expect(replies(h)).toHaveLength(2);

    const keys = h.store.rows.filter((r) => r.kind === 'recruiter_reply').map((r) => r.deliveryKey);
    const slot1 = (await getInterview(s.t.handle, first))!.confirmedSlotId;
    const slot2 = (await getInterview(s.t.handle, second))!.confirmedSlotId;
    expect(keys).toEqual([
      `recruiter_reply:${first}:${slot1}`,
      `recruiter_reply:${second}:${slot2}`,
    ]);
    expect((await getInterview(s.t.handle, second))!.replySentAt).not.toBeNull();
  });

  it('a send that went out but was not recorded is recovered from its receipt, not repeated', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const interviewId = await offerAndConfirm(s, h, 0);
    const slotId = (await getInterview(s.t.handle, interviewId))!.confirmedSlotId!;
    const begun = await h.store.begin({
      kind: 'recruiter_reply',
      applicationId: s.application.id,
      to: 'recruiter@acme.example',
      subject: 'Re: Interview',
      bodyText: 'x',
      bodyHtml: null,
      gmailMessageId: null,
      blocked: false,
      blockedReason: null,
      sentAt: null,
      deliveryKey: `recruiter_reply:${interviewId}:${slotId}`,
    });
    if (!begun.created) throw new Error('receipt already existed');
    await h.store.finalize(begun.id, { gmailMessageId: 'gm-1', sentAt: NOW });

    const out = await book(s, h, interviewId);
    expect(out).toMatchObject({ status: 'booked' });
    expect(replies(h)).toHaveLength(0);
    expect((await getInterview(s.t.handle, interviewId))!.replySentAt).not.toBeNull();
    expect(h.calendar.created).toHaveLength(1);
  });

  it('a pending receipt of unknown outcome is not blindly re-sent', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const interviewId = await offerAndConfirm(s, h, 0);
    const slotId = (await getInterview(s.t.handle, interviewId))!.confirmedSlotId!;
    await h.store.begin({
      kind: 'recruiter_reply',
      applicationId: s.application.id,
      to: 'recruiter@acme.example',
      subject: 'Re: Interview',
      bodyText: 'x',
      bodyHtml: null,
      gmailMessageId: null,
      blocked: false,
      blockedReason: null,
      sentAt: null,
      deliveryKey: `recruiter_reply:${interviewId}:${slotId}`,
    });
    await expect(book(s, h, interviewId)).rejects.toMatchObject({ code: 'reply_uncertain' });
    expect(replies(h)).toHaveLength(0);
    expect(h.calendar.created).toHaveLength(0);
  });
});

describe('stale bookings', () => {
  it('a booking that runs after the confirmed time began sends no reply and creates no event', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const interviewId = await offerAndConfirm(s, h, 0);
    h.deps.clock = { now: () => new Date('2037-11-12T19:00:00Z') }; // 11:00 PST, after the 10:00 start
    expect(await book(s, h, interviewId)).toEqual({ status: 'expired' });
    expect(replies(h)).toHaveLength(0);
    expect(h.calendar.events.size).toBe(0);
    const log = (await activity.listByUser(s.t.handle, s.t.userId)).map((e) => e.action);
    expect(log).toContain('interview_booking_expired');
  });
});

describe('reschedule completion is tracked per confirmed generation', () => {
  it('a retained event id does not hide an unfinished reschedule from the repair pass', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const interviewId = await offerAndConfirm(s, h, 0);
    await book(s, h, interviewId);
    const queued: string[] = [];
    const enqueue = async (d: { interviewId: string }) => {
      queued.push(d.interviewId);
    };
    expect(await requeueUnbookedInterviews(s.t.handle, s.t.userId, enqueue)).toBe(0);

    await reschedule(s, h);
    const request = requests(h).at(-1)!;
    expect((await confirmToken(s.t.handle, tokensIn(request)[1]!)).ok).toBe(true);
    const row = (await getInterview(s.t.handle, interviewId))!;
    expect(row.calendarEventId).not.toBeNull();
    expect(row.bookedGeneration).not.toBe(row.confirmedGeneration);
    expect((await listInterviewsAwaitingBooking(s.t.handle, s.t.userId)).map((i) => i.id)).toEqual([
      interviewId,
    ]);

    // The Calendar update fails (retries exhausted): still owed.
    h.calendar.failUpdate = new Error('calendar down');
    await expect(book(s, h, interviewId)).rejects.toBeInstanceOf(EventCreationError);
    expect(await requeueUnbookedInterviews(s.t.handle, s.t.userId, enqueue)).toBe(1);

    h.calendar.failUpdate = null;
    expect(await book(s, h, interviewId)).toMatchObject({ status: 'booked', created: false });
    expect(await requeueUnbookedInterviews(s.t.handle, s.t.userId, enqueue)).toBe(0);
    const done = (await getInterview(s.t.handle, interviewId))!;
    expect(done.bookedGeneration).toBe(done.confirmedGeneration);
    expect(h.calendar.updated.at(-1)!.start.toISOString()).toBe('2037-11-18T17:00:00.000Z');
  });
});

describe('reminders do not depend on the recruiter reply', () => {
  it('are scheduled even when the reply is blocked', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const interviewId = await offerAndConfirm(s, h, 0);
    h.setGuards([{ name: 'test', check: () => ({ ok: false, reason: 'blocked' }) }]);
    expect(await book(s, h, interviewId)).toEqual({ status: 'reply_blocked' });
    expect(h.reminders).toEqual([interviewId]);
  });

  it('a failure to schedule them is logged and does not stop the reply', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const interviewId = await offerAndConfirm(s, h, 0);
    h.deps.scheduleReminders = async () => {
      throw new Error('queue down');
    };
    expect(await book(s, h, interviewId)).toMatchObject({ status: 'booked' });
    expect(replies(h)).toHaveLength(1);
    const log = (await activity.listByUser(s.t.handle, s.t.userId)).map((e) => e.action);
    expect(log).toContain('reminder_schedule_failed');
  });
});

describe('Google authentication errors are preserved', () => {
  const approve = async (t: Seeded['t']) => {
    await insertProfileVersion(t.handle, {
      userId: t.userId,
      document: profileDocumentSchema.parse(profile),
    });
    await setApprovedProfileVersion(t.handle, t.userId, 1);
  };

  it('a revoked grant while creating the event reaches the caller unchanged', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const interviewId = await offerAndConfirm(s, h, 0);
    const revoked = Object.assign(new Error('invalid_grant'), { code: 400 });
    h.calendar.createError = revoked;
    await expect(book(s, h, interviewId)).rejects.toBe(revoked);
    const log = (await activity.listByUser(s.t.handle, s.t.userId)).map((e) => e.action);
    expect(log).not.toContain('interview_event_failed');
  });

  it('the booking job treats it as a revoked connection instead of retrying', async () => {
    const s = await seedThread(env);
    await approve(s.t);
    const h = makeHarness();
    const interviewId = await offerAndConfirm(s, h, 0);
    h.calendar.createError = Object.assign(new Error('unauthorized'), { code: 401 });
    const out = await runBookInterview(
      env.db,
      { tenantId: s.t.id, userId: s.t.userId, interviewId },
      () => h.deps,
    );
    expect(out).toEqual({ ran: false });
  });

  it('a 401 from freebusy is rethrown, not turned into deferred calendar work; other failures still are', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const denied = Object.assign(new Error('Request had invalid credentials'), { code: 401 });
    h.calendar.failBusy = denied;
    await expect(offerSlots(s.t.handle, offerInput(s, threeSlots()), h.deps)).rejects.toBe(denied);

    h.calendar.failBusy = new Error('calendar down');
    await expect(
      offerSlots(s.t.handle, offerInput(s, threeSlots()), h.deps),
    ).rejects.toBeInstanceOf(CalendarUnavailableError);
  });
});

describe('slots across a DST transition', () => {
  it('shows the zone and offset of both ends when they differ (fall back)', () => {
    const slot = {
      start: new Date('2026-11-01T08:30:00Z'), // 01:30 PDT
      end: new Date('2026-11-01T09:30:00Z'), // 01:30 PST
    };
    const text = formatSlot(slot, 'America/Los_Angeles').replace(/\u202f/g, ' ');
    expect(text).toBe('Sunday, November 1, 2026, 1:30 AM PDT (GMT-7) to 1:30 AM PST (GMT-8)');
  });

  it('shows both offsets across spring forward and keeps the plain form otherwise', () => {
    const spring = {
      start: new Date('2026-03-08T09:30:00Z'), // 01:30 PST
      end: new Date('2026-03-08T10:30:00Z'), // 03:30 PDT
    };
    expect(formatSlot(spring, 'America/Los_Angeles').replace(/\u202f/g, ' ')).toContain(
      '1:30 AM PST (GMT-8) to 3:30 AM PDT (GMT-7)',
    );
    const plain = {
      start: new Date('2026-11-12T18:00:00Z'),
      end: new Date('2026-11-12T19:00:00Z'),
    };
    expect(formatSlot(plain, 'America/Los_Angeles').replace(/\u202f/g, ' ')).toBe(
      'Thursday, November 12, 2026, 10:00 AM to 11:00 AM PST',
    );
  });
});
