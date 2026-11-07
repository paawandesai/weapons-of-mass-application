import { describe, expect, it } from 'vitest';
import { ApplicationStatus, isActionable } from '../src';

describe('isActionable', () => {
  it('is false only for a closed application', () => {
    for (const status of ApplicationStatus.options) {
      expect(isActionable({ status })).toBe(status !== 'closed');
    }
  });

  it('accepts a full application row', () => {
    expect(isActionable({ status: 'closed', id: 'x' } as { status: 'closed' })).toBe(false);
    expect(isActionable({ status: 'pending' })).toBe(true);
  });
});
