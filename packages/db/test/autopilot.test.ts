import { describe, expect, it } from 'vitest';
import { pickConfirmLink } from '../src/seed/autopilot';

const offer = `Gauntlet Jobs offered these times.

Monday, November 9, 2026, 10:00 AM PST
http://localhost:5173/confirm/aaa_111-AAA

Tuesday, November 10, 2026, 2:00 PM PST
http://localhost:5173/confirm/bbb_222-BBB

Wednesday, November 11, 2026, 11:00 AM PST
http://localhost:5173/confirm/ccc_333-CCC

Each link works once.`;

describe('pickConfirmLink', () => {
  it('takes the second offered time', () => {
    expect(pickConfirmLink(offer)).toBe('bbb_222-BBB');
  });
  it('takes the only time when there is one', () => {
    expect(pickConfirmLink('Just this: http://x.test/confirm/only-One_1 ok')).toBe('only-One_1');
  });
  it('finds nothing in mail without confirm links', () => {
    expect(pickConfirmLink('Thanks for applying. https://x.test/jobs/1')).toBeNull();
  });
});
