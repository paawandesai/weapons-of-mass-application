import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { insertDemoMessage } from '@wma/db';
import { createDemoInboxGmailPort } from '../../src/demo/ports';

const ok = <T extends { expired: boolean }>(r: T) => {
  if (r.expired) throw new Error('expired');
  return r as Extract<T, { expired: false }>;
};
import { setupEnv, type TestEnv, type TestTenant } from '../helpers';

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';
let env: TestEnv;
let owner: pg.Pool;
let T: TestTenant;

beforeAll(async () => {
  env = await setupEnv();
  owner = new pg.Pool({ connectionString: ownerUrl });
  T = await env.makeTenant();
  await owner.query('update tenants set demo = true where id = $1', [T.id]);
});
afterAll(async () => {
  await owner.query('update tenants set demo = false where id = $1', [T.id]);
  await owner.end();
  await env.cleanup();
});

const add = (id: string, labelIds: string[] = ['INBOX']) =>
  insertDemoMessage(T.handle, {
    userId: T.userId,
    gmailMessageId: id,
    fromAddress: 'r@acme.test',
    toAddress: T.email,
    subject: id,
    bodyText: id,
    labelIds,
  });

describe('history listing', () => {
  it('returns a watermark that covers exactly the messages it listed', async () => {
    const port = createDemoInboxGmailPort(T.handle, T.userId);
    const start = await port.currentHistoryId();
    await add('w-1');
    await add('w-sent', ['SENT']);
    const a = ok(await port.listHistory(start));
    expect(a.messageIds).toEqual(['w-1']);

    // A message committed after the listing is found by the next sync, not skipped.
    await add('w-2');
    const b = ok(await port.listHistory(a.historyId));
    expect(b.messageIds).toEqual(['w-2']);
    expect(Number(b.historyId)).toBeGreaterThan(Number(a.historyId));
    expect(ok(await port.listHistory(b.historyId)).messageIds).toEqual([]);
  });
});
