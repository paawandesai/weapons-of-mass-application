import { describe, expect, it } from 'vitest';
import {
  ApplicationStatus,
  Classification,
  InboxClassification,
  InboxClassificationJsonSchema,
  nextStatus,
  type StatusChange,
} from '../src';

const none = null;
const to = (status: StatusChange['status']): StatusChange => ({ status });
const closedRejected: StatusChange = { status: 'closed', closedReason: 'rejected' };

// Expected result for every (status, classification) pair, written out in full.
const TABLE: Record<string, Record<string, StatusChange | null>> = {
  pending: {
    confirmation: to('applied'),
    rejection: closedRejected,
    interview: none,
    offer: none,
    other: none,
  },
  applied: {
    confirmation: none,
    rejection: closedRejected,
    interview: to('interviewing'),
    offer: to('offer'),
    other: none,
  },
  interviewing: {
    confirmation: none,
    rejection: closedRejected,
    interview: none,
    offer: to('offer'),
    other: none,
  },
  offer: {
    confirmation: none,
    rejection: closedRejected,
    interview: none,
    offer: none,
    other: none,
  },
  closed: { confirmation: none, rejection: none, interview: none, offer: none, other: none },
};

describe('nextStatus', () => {
  it('the table covers every status and classification', () => {
    expect(Object.keys(TABLE).sort()).toEqual([...ApplicationStatus.options].sort());
    for (const s of ApplicationStatus.options) {
      expect(Object.keys(TABLE[s]!).sort()).toEqual([...Classification.options].sort());
    }
  });

  for (const status of ApplicationStatus.options) {
    for (const cls of Classification.options) {
      it(`${status} + ${cls}`, () => {
        expect(nextStatus(status, cls)).toEqual(TABLE[status]![cls]);
      });
    }
  }

  it('closed is a sink and transitions never move backward', () => {
    const order = ['pending', 'applied', 'interviewing', 'offer'];
    for (const cls of Classification.options) {
      expect(nextStatus('closed', cls)).toBeNull();
      for (const s of ApplicationStatus.options) {
        const r = nextStatus(s, cls);
        if (r && r.status !== 'closed') {
          expect(order.indexOf(r.status)).toBeGreaterThan(order.indexOf(s));
        }
      }
    }
  });
});

describe('InboxClassification', () => {
  const valid = {
    classification: 'interview',
    compensation_flag: false,
    booking_link: null,
    proposed_slots: [
      { start: '2026-11-12T10:00:00-08:00', end: null, tz_hint: 'PT', ambiguous: false },
    ],
  };

  it('accepts the rule 3 shape', () => {
    expect(InboxClassification.parse(valid)).toEqual({ ...valid, reschedule: false });
  });

  it('rejects an unknown classification and a missing slot flag', () => {
    expect(InboxClassification.safeParse({ ...valid, classification: 'spam' }).success).toBe(false);
    expect(
      InboxClassification.safeParse({
        ...valid,
        proposed_slots: [{ start: 'x', end: null, tz_hint: null }],
      }).success,
    ).toBe(false);
  });

  it('exports a JSON schema with the top-level properties', () => {
    const props = Object.keys((InboxClassificationJsonSchema as { properties: object }).properties);
    expect(props.sort()).toEqual(
      [
        'booking_link',
        'classification',
        'compensation_flag',
        'proposed_slots',
        'reschedule',
      ].sort(),
    );
  });
});
