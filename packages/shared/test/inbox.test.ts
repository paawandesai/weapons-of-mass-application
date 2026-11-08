import { describe, expect, it } from 'vitest';
import { InboxClassification } from '../src/inbox';

const base = {
  classification: 'interview',
  compensation_flag: false,
  booking_link: null,
  proposed_slots: [],
  confirmed_slot: null,
};

describe('InboxClassification.reschedule', () => {
  it('defaults to false when the model omits it', () => {
    expect(InboxClassification.parse(base).reschedule).toBe(false);
  });
  it('round-trips true', () => {
    expect(InboxClassification.parse({ ...base, reschedule: true }).reschedule).toBe(true);
  });
});
