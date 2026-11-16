import { describe, expect, it } from 'vitest';
import { gmailSearchQuery } from '../../src/submission/gmail';

describe('gmailSearchQuery', () => {
  it('searches in:anywhere (Trash and Spam included) for recent ATS senders', () => {
    const q = gmailSearchQuery({
      fromDomains: ['greenhouse.io', 'greenhouse-mail.io', 'anthropic.com'],
      after: new Date('2026-11-16T19:44:53.000Z'),
    });
    expect(q.startsWith('in:anywhere ')).toBe(true);
    expect(q).toContain('from:greenhouse.io');
    expect(q).toContain('from:greenhouse-mail.io');
    expect(q).toContain('from:anthropic.com');
    expect(q).toContain(`after:${Math.floor(Date.parse('2026-11-16T19:44:53.000Z') / 1000)}`);
    expect(q).not.toContain('in:inbox');
  });
});
