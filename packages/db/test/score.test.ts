import { describe, expect, it } from 'vitest';
import { computeScore, render, type ScoreRows } from '../src/score/score';

const at = new Date();
const booked = { confirmedAt: at, calendarEventId: 'evt', replySentAt: at };
const app = (over: Partial<ScoreRows['applications'][number]> = {}) => ({
  status: 'applied',
  pendingReason: null,
  closedReason: null,
  attemptCount: 1,
  appliedAt: at,
  formAnswers: null,
  ...over,
});
const base = (over: Partial<ScoreRows> = {}): ScoreRows => ({
  applications: [],
  interviews: [],
  outgoing: [],
  noFreeSlotFlags: 0,
  judgedCandidates: 0,
  emailThreads: 0,
  costUsd: null,
  ...over,
});

describe('success score (docs/design/success-score.md)', () => {
  it('no data: score null, coverage 0, gate ok', async () => {
    const s = await computeScore(base());
    expect(s).toMatchObject({ score: null, coverage: 0, gate: { ok: true } });
    expect(render(s)).toContain('SCORE no data');
  });

  it('submission ratio and failure buckets; untouched pending is not an attempt, a clean success is', async () => {
    const s = await computeScore(
      base({
        applications: [
          app(),
          app({ attemptCount: 0 }),
          app({ status: 'pending', appliedAt: null, pendingReason: 'unanswerable-question' }),
          app({ status: 'closed', appliedAt: null, closedReason: 'browser-error' }),
          app({ status: 'pending', appliedAt: null, attemptCount: 0 }),
        ],
      }),
    );
    expect(s.components[0]).toMatchObject({ name: 'submission', kind: 'measured', num: 2, den: 4 });
    expect(s.buckets).toEqual([
      { reason: 'browser-error', count: 1 },
      { reason: 'unanswerable-question', count: 1 },
    ]);
    // Only submission measured: renormalised weights give the ratio itself.
    expect(s.score).toBe(50);
    expect(s.coverage).toBe(0.3);
  });

  it('scheduling counts no_free_slot flags in the denominator', async () => {
    const s = await computeScore(
      base({
        interviews: [booked, { confirmedAt: null, calendarEventId: null, replySentAt: null }],
        noFreeSlotFlags: 2,
      }),
    );
    expect(s.components[4]).toMatchObject({ name: 'scheduling', num: 1, den: 4 });
  });

  it('weights renormalise over measured components; one perfect component gives 100', async () => {
    const s = await computeScore(base({ applications: [app()], interviews: [booked] }));
    expect(s.score).toBe(100);
    expect(s.coverage).toBe(0.45);
    const t = await computeScore(
      base({
        applications: [
          app(),
          app({ status: 'pending', appliedAt: null, pendingReason: 'captcha' }),
        ],
        interviews: [booked],
      }),
    );
    // (30*0.5 + 15*1) / 45 = 0.666..
    expect(t.score).toBe(67);
  });

  it('unmeasured components report what is waiting for a label and leave the score', async () => {
    const s = await computeScore(
      base({
        applications: [
          app({ formAnswers: { Travel: { value: 'Yes', source: 'inferred' }, Email: 'a@b.c' } }),
        ],
        judgedCandidates: 12,
        emailThreads: 3,
      }),
    );
    expect(s.components[1]).toMatchObject({ name: 'discovery', kind: 'unmeasured', waiting: 12 });
    expect(s.components[2]).toMatchObject({ name: 'answers', kind: 'unmeasured', waiting: 1 });
    expect(s.components[3]).toMatchObject({ name: 'inbox', kind: 'unmeasured', waiting: 3 });
    expect(s.score).toBe(100);
    expect(render(s)).toContain('unmeasured (12 waiting for a label)');
  });

  it('gate: money sent zeroes the score; a blocked message is not a leak', async () => {
    const leak = {
      kind: 'recruiter_reply',
      bodyText: 'My salary expectation is $200k.',
      blocked: false,
    };
    const s = await computeScore(base({ applications: [app()], outgoing: [leak] }));
    expect(s.gate).toMatchObject({ ok: false, violations: [{ rule: 'money_sent', count: 1 }] });
    expect(s.score).toBe(0);
    expect(render(s)).toContain('zeroed by the gate');
    const blocked = await computeScore(
      base({ applications: [app()], outgoing: [{ ...leak, blocked: true }] }),
    );
    expect(blocked.gate.ok).toBe(true);
    expect(blocked.score).toBe(100);
  });

  it('gate: a filled self-identification field; a skipped marker is fine', async () => {
    const filled = await computeScore(
      base({ applications: [app({ formAnswers: { Gender: 'Male' } })] }),
    );
    expect(filled.gate.violations).toEqual([
      { rule: 'self_id_filled', count: 1, detail: 'Gender' },
    ]);
    const skipped = await computeScore(
      base({
        applications: [
          app({ formAnswers: { Gender: { skipped: 'self-identification' }, Race: null } }),
        ],
      }),
    );
    expect(skipped.gate.ok).toBe(true);
  });

  it('gate: a calendar event without a confirmation', async () => {
    const s = await computeScore(
      base({ interviews: [{ confirmedAt: null, calendarEventId: 'evt', replySentAt: null }] }),
    );
    expect(s.gate.violations).toEqual([{ rule: 'booked_without_confirm', count: 1 }]);
    expect(s.score).toBe(0);
  });

  it('cost: applications per dollar, or no ledger', async () => {
    const s = await computeScore(base({ applications: [app(), app()], costUsd: 8 }));
    expect(s.perDollar).toBeCloseTo(0.25);
    expect(render(s)).toContain('$8.00, 0.25 confirmed applications per dollar');
    expect(render(await computeScore(base()))).toContain('cost: no ledger');
    expect((await computeScore(base({ costUsd: 0 }))).perDollar).toBeNull();
  });
});
