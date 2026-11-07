import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertEmailThread } from '@wma/db';
import { setupEnv, type TestEnv, type TestTenant } from '../helpers';

let env: TestEnv;
let T: TestTenant;
beforeAll(async () => {
  env = await setupEnv();
  T = await env.makeTenant();
});
afterAll(async () => {
  await env.cleanup();
});

describe('email_threads.subject', () => {
  it('is stored from the first message and kept when later messages carry another subject', async () => {
    const base = { userId: T.userId, gmailThreadId: 'real-thread-1', kind: 'other' as const };
    const a = await upsertEmailThread(T.handle, { ...base, subject: 'Your application' });
    expect(a.subject).toBe('Your application');
    const b = await upsertEmailThread(T.handle, { ...base, subject: 'Re: Your application' });
    expect(b.subject).toBe('Your application');
    const c = await upsertEmailThread(T.handle, { ...base, gmailThreadId: 'real-thread-2' });
    expect(c.subject).toBeNull();
    const d = await upsertEmailThread(T.handle, {
      ...base,
      gmailThreadId: 'real-thread-2',
      subject: 'Hello',
    });
    expect(d.subject).toBe('Hello');
  });
});
