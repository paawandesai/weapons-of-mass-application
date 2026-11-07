import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  countInterviewsForThread,
  getInterview,
  getInterviewByThread,
  listSlotsForInterview,
  updateInterview,
} from '@wma/db';
import {
  CalendarUnavailableError,
  offerSlots,
  resendPendingConfirmations,
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
  WEB,
  type SchedulingTestEnv,
} from './support';

let env: SchedulingTestEnv;
beforeAll(async () => {
  env = await setupSchedulingEnv();
});
afterAll(async () => {
  await env.cleanup();
});

describe('offerSlots (rule 8, tasks 5.1 to 5.4)', () => {
  it('one ambiguous time among three yields two slots and a note, and one email to the user', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const slots = threeSlots();
    slots[1] = proposed('2037-11-13T10:00:00-08:00', { ambiguous: true });
    const out = await offerSlots(s.t.handle, offerInput(s, slots), h.deps);

    expect(out.status).toBe('offered');
    expect(out.offered).toBe(2);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toMatch(/ambiguous/);
    const rows = await listSlotsForInterview(s.t.handle, out.interviewId!);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.startsAt.toISOString())).toEqual([
      '2037-11-12T18:00:00.000Z',
      '2037-11-14T18:00:00.000Z',
    ]);
    // Default length when the recruiter gave no end.
    expect(rows[0]!.endsAt.getTime() - rows[0]!.startsAt.getTime()).toBe(3_600_000);

    expect(h.sender.sent).toHaveLength(1);
    const mail = h.sender.sent[0]!;
    expect(mail.to).toBe(s.t.email);
    expect(mail.kind).toBe('slot_confirmation');
    expect(mail.text).toContain(s.companyName);
    expect(mail.text).toContain('Staff Engineer');
    expect(mail.text).toContain('Thursday, November 12, 2037, 10:00 AM to 11:00 AM PST');
    const tokens = tokensIn(mail);
    expect(tokens).toHaveLength(2);
    for (const tok of tokens) expect(mail.text).toContain(`${WEB}/confirm/${tok}`);

    // Tokens: 32 random bytes, only the sha256 is stored, 7 days expiry.
    for (const [i, tok] of tokens.entries()) {
      expect(Buffer.from(tok, 'base64url')).toHaveLength(32);
      expect(rows[i]!.tokenHash).toBe(sha256(tok));
      expect(rows[i]!.tokenHash).not.toContain(tok);
      const days = (rows[i]!.expiresAt.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.99);
      expect(days).toBeLessThan(7.01);
    }
    const interview = await getInterview(s.t.handle, out.interviewId!);
    expect(interview?.confirmationEmailSentAt).toEqual(NOW);
    const log = await activity.listByUser(s.t.handle, s.t.userId);
    expect(log.find((e) => e.action === 'slots_offered')?.detail).toMatchObject({ count: 2 });
  });

  it('drops past options and options with no time zone, each with a note', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const out = await offerSlots(
      s.t.handle,
      offerInput(s, [
        proposed(new Date(NOW.getTime() - 86_400_000).toISOString()),
        proposed('2037-11-13T10:00:00'),
        proposed('2037-11-12T10:00:00-08:00'),
      ]),
      h.deps,
    );
    expect(out.offered).toBe(1);
    expect(out.notes.map((n) => n.replace(/^.*: /, ''))).toEqual([
      'already in the past.',
      'no time zone could be inferred.',
    ]);
  });

  it('removes a slot that overlaps a calendar event and offers the rest', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    h.calendar.busyIntervals = [
      { start: new Date('2037-11-13T17:30:00Z'), end: new Date('2037-11-13T18:30:00Z') },
    ];
    const out = await offerSlots(s.t.handle, offerInput(s, threeSlots()), h.deps);
    expect(out.offered).toBe(2);
    const starts = (await listSlotsForInterview(s.t.handle, out.interviewId!)).map((r) =>
      r.startsAt.toISOString(),
    );
    expect(starts).toEqual(['2037-11-12T18:00:00.000Z', '2037-11-14T18:00:00.000Z']);
    expect(tokensIn(h.sender.sent[0]!)).toHaveLength(2);
  });

  it('a slot that only touches a busy interval at its edge is kept', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    h.calendar.busyIntervals = [
      { start: new Date('2037-11-12T19:00:00Z'), end: new Date('2037-11-12T20:00:00Z') },
    ];
    const out = await offerSlots(s.t.handle, offerInput(s, threeSlots()), h.deps);
    expect(out.offered).toBe(3);
  });

  it('every slot in conflict flags no_free_slot, creates nothing and sends no email', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    h.calendar.busyIntervals = [
      { start: new Date('2037-11-12T00:00:00Z'), end: new Date('2037-11-16T00:00:00Z') },
    ];
    const out = await offerSlots(s.t.handle, offerInput(s, threeSlots()), h.deps);
    expect(out.status).toBe('no_free_slot');
    expect(h.sender.sent).toHaveLength(0);
    expect(h.store.rows).toHaveLength(0);
    expect(await getInterviewByThread(s.t.handle, s.thread.id)).toBeNull();
    const flag = (await activity.listByUser(s.t.handle, s.t.userId)).find(
      (e) => e.action === 'digest_flag',
    );
    expect(flag?.applicationId).toBe(s.application.id);
    expect(flag?.detail).toMatchObject({
      kind: 'no_free_slot',
      thread_id: s.thread.id,
      reason: 'calendar_conflict',
    });
    expect((flag?.detail as { conflicts: unknown[] }).conflicts).toHaveLength(3);
  });

  it('options that are all dropped (ambiguous) also flag no_free_slot without calling the calendar', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const out = await offerSlots(
      s.t.handle,
      offerInput(s, [proposed('2037-11-12T10:00:00-08:00', { ambiguous: true })]),
      h.deps,
    );
    expect(out.status).toBe('no_free_slot');
    expect(h.calendar.busyCalls).toBe(0);
    expect(h.sender.sent).toHaveLength(0);
  });

  it('a calendar that cannot be read sends nothing, logs the failure and throws', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    h.calendar.failBusy = true;
    await expect(
      offerSlots(s.t.handle, offerInput(s, threeSlots()), h.deps),
    ).rejects.toBeInstanceOf(CalendarUnavailableError);
    expect(h.sender.sent).toHaveLength(0);
    expect(await getInterviewByThread(s.t.handle, s.thread.id)).toBeNull();
    const log = await activity.listByUser(s.t.handle, s.t.userId);
    expect(log.some((e) => e.action === 'calendar_read_failed')).toBe(true);
  });

  it('the recruiter thread has no reply after the request is sent', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    await offerSlots(s.t.handle, offerInput(s, threeSlots()), h.deps);
    expect(h.sender.sent.every((m) => m.to === s.t.email)).toBe(true);
    expect(h.toRecruiter(s.t.email)).toHaveLength(0);
    expect(h.store.rows.filter((r) => r.kind === 'recruiter_reply')).toHaveLength(0);
    expect(h.mailbox.calls).toBe(0);
  });

  it('empty input (a booking link, or a request for availability) writes and sends nothing', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const out = await offerSlots(s.t.handle, offerInput(s, []), h.deps);
    expect(out.status).toBe('no_slots');
    expect(await getInterviewByThread(s.t.handle, s.thread.id)).toBeNull();
    expect(h.sender.sent).toHaveLength(0);
    expect(h.store.rows).toHaveLength(0);
    expect(h.calendar.touched).toBe(0);
    expect(await activity.listByUser(s.t.handle, s.t.userId)).toHaveLength(0);
  });

  it('offering the same times again while the request is out does nothing', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    await offerSlots(s.t.handle, offerInput(s, threeSlots()), h.deps);
    const again = await offerSlots(s.t.handle, offerInput(s, threeSlots()), h.deps);
    expect(again.status).toBe('already_offered');
    expect(h.sender.sent).toHaveLength(1);
  });

  it('employer text with money is scrubbed so the request passes the guard', async () => {
    const s = await seedThread(env, { title: 'Engineer ($150k, equity)' });
    const h = makeHarness();
    const out = await offerSlots(s.t.handle, offerInput(s, threeSlots()), h.deps);
    expect(out.status).toBe('offered');
    expect(h.sender.sent[0]!.subject).toContain('[omitted]');
    expect(h.store.rows.some((r) => r.blocked)).toBe(false);
  });
});

describe('resendPendingConfirmations (crash gap)', () => {
  it('repairs slots stored without a sent request, with fresh tokens, once', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const realSend = h.sender.send.bind(h.sender);
    h.sender.send = async () => {
      throw new Error('gmail down');
    };
    await expect(offerSlots(s.t.handle, offerInput(s, threeSlots()), h.deps)).rejects.toThrow();
    const interview = (await getInterviewByThread(s.t.handle, s.thread.id))!;
    expect(interview.confirmationEmailSentAt).toBeNull();
    const before = await listSlotsForInterview(s.t.handle, interview.id);
    expect(before).toHaveLength(3);

    h.sender.send = realSend;
    expect(await resendPendingConfirmations(s.t.handle, s.t.userId, h.deps)).toBe(1);
    expect(h.sender.sent).toHaveLength(1);
    const tokens = tokensIn(h.sender.sent[0]!);
    expect(tokens).toHaveLength(3);
    const after = await listSlotsForInterview(s.t.handle, interview.id);
    const open = after.filter((r) => !r.invalidatedAt);
    expect(open).toHaveLength(3);
    expect(open.map((r) => r.tokenHash).sort()).toEqual(tokens.map(sha256).sort());
    expect(before.every((r) => after.find((a) => a.id === r.id)?.invalidatedAt)).toBe(true);
    expect((await getInterview(s.t.handle, interview.id))?.confirmationEmailSentAt).toEqual(NOW);

    expect(await resendPendingConfirmations(s.t.handle, s.t.userId, h.deps)).toBe(0);
    expect(h.sender.sent).toHaveLength(1);
  });
});

describe('interview rounds (rule 55)', () => {
  const later = () => [
    proposed('2037-11-17T09:00:00-08:00'),
    proposed('2037-11-18T09:00:00-08:00'),
  ];
  async function confirmed() {
    const s = await seedThread(env);
    const h = makeHarness();
    const first = await offerSlots(s.t.handle, offerInput(s, threeSlots()), h.deps);
    const request = h.sender.sent.at(-1)!;
    expect((await confirmToken(s.t.handle, tokensIn(request)[0]!)).ok).toBe(true);
    return { s, h, id: first.interviewId! };
  }

  it('confirmed + reschedule + future start: the same row is cleared and re-offered', async () => {
    const { s, h, id } = await confirmed();
    const out = await offerSlots(
      s.t.handle,
      { ...offerInput(s, later()), messageId: 'm2', reschedule: true },
      h.deps,
    );
    expect(out).toMatchObject({ status: 'offered', reschedule: true, interviewId: id });
    expect((await getInterview(s.t.handle, id))?.confirmedSlotId).toBeNull();
    expect(await countInterviewsForThread(s.t.handle, s.thread.id)).toBe(1);
  });

  it('confirmed + no flag: a second row; the first keeps its confirmation; round 2 is logged', async () => {
    const { s, h, id } = await confirmed();
    const before = (await getInterview(s.t.handle, id))!;
    expect(before.confirmedSlotId).not.toBeNull();
    const out = await offerSlots(
      s.t.handle,
      { ...offerInput(s, later()), messageId: 'm2' },
      h.deps,
    );
    expect(out).toMatchObject({ status: 'offered', reschedule: false });
    expect(out.interviewId).not.toBe(id);
    const after = (await getInterview(s.t.handle, id))!;
    expect(after.confirmedSlotId).toBe(before.confirmedSlotId);
    expect(after.calendarEventId).toBe(before.calendarEventId);
    expect(after.confirmedGeneration).toBe(before.confirmedGeneration);
    expect((await getInterviewByThread(s.t.handle, s.thread.id))?.id).toBe(out.interviewId);
    const log = (await activity.listByUser(s.t.handle, s.t.userId)).filter(
      (e) => e.action === 'slots_offered',
    );
    expect(log.map((e) => (e.detail as { round: number }).round).sort()).toEqual([1, 2]);
    expect(log.some((e) => (e.detail as { reschedule: boolean }).reschedule)).toBe(false);
  });

  it('confirmed + reschedule + start in the past: a second row', async () => {
    const { s, h, id } = await confirmed();
    await updateInterview(s.t.handle, id, { startsAt: new Date(NOW.getTime() - 3_600_000) });
    const out = await offerSlots(
      s.t.handle,
      { ...offerInput(s, later()), messageId: 'm2', reschedule: true },
      h.deps,
    );
    expect(out).toMatchObject({ status: 'offered', reschedule: false });
    expect(out.interviewId).not.toBe(id);
    expect(await countInterviewsForThread(s.t.handle, s.thread.id)).toBe(2);
  });

  it('unconfirmed + a new proposal: the same row', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const first = await offerSlots(s.t.handle, offerInput(s, threeSlots()), h.deps);
    const second = await offerSlots(
      s.t.handle,
      { ...offerInput(s, later()), messageId: 'm2' },
      h.deps,
    );
    expect(second.interviewId).toBe(first.interviewId);
    expect(await countInterviewsForThread(s.t.handle, s.thread.id)).toBe(1);
  });
});
