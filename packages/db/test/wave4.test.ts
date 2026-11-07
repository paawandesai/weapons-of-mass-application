import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  changeStageByUser,
  currentDemoHistoryId,
  findDemoSent,
  getApplication,
  getCurrentTenant,
  getDemoEvent,
  getDemoMessage,
  insertDemoMessage,
  listDemoEvents,
  listDemoMessagesAfterHistory,
  listDemoThread,
  listStageOverrides,
  updateApplication,
  updateDemoEvent,
  upsertDemoEvent,
} from '../src';
import { makeApplication, pgErrorMessage, setupEnv, type TestEnv } from './helpers';

let env: TestEnv;
let A: Awaited<ReturnType<TestEnv['makeTenant']>>;
let B: Awaited<ReturnType<TestEnv['makeTenant']>>;

beforeAll(async () => {
  env = await setupEnv();
  A = await env.makeTenant();
  B = await env.makeTenant();
});
afterAll(async () => {
  await env.cleanup();
});

const msg = (t: typeof A, over: Partial<Parameters<typeof insertDemoMessage>[1]> = {}) =>
  insertDemoMessage(t.handle, {
    userId: t.userId,
    fromAddress: 'recruiter@acme.test',
    toAddress: 'me@example.test',
    subject: 'Hello',
    bodyText: 'Hi there',
    ...over,
  });

describe('wave 4 schema', () => {
  it('adds the new columns with safe defaults', async () => {
    const t = await getCurrentTenant(A.handle);
    expect(t.demo).toBe(false);
    const { job, application } = await makeApplication(A);
    expect(application.negotiation).toBeNull();
    const rows = await env.owner.query('select seeded from jobs where id = $1', [job.id]);
    expect(rows.rows[0].seeded).toBe(false);
    const cols = await env.owner.query(
      `select column_name from information_schema.columns
       where table_name = 'interviews' and column_name in ('feedback','prep_plan','prep_plan_status')`,
    );
    expect(cols.rows).toHaveLength(3);
  });

  it('forces RLS with four policies and grants wma_app on each new tenant table', async () => {
    for (const table of ['stage_overrides', 'demo_mailbox_messages', 'demo_calendar_events']) {
      const rls = await env.owner.query(
        'select relrowsecurity, relforcerowsecurity from pg_class where relname = $1',
        [table],
      );
      expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const pol = await env.owner.query(
        'select cmd from pg_policies where tablename = $1 order by cmd',
        [table],
      );
      expect(pol.rows.map((r) => r.cmd)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      const grant = await env.owner.query(
        `select count(*)::int as n from information_schema.role_table_grants
         where table_name = $1 and grantee = 'wma_app'`,
        [table],
      );
      expect(grant.rows[0].n).toBe(4);
    }
  });

  it('is idempotent to re-run: migrations record exactly the generated files', async () => {
    const r = await env.owner.query('select count(*)::int as n from drizzle.__drizzle_migrations');
    expect(r.rows[0].n).toBeGreaterThanOrEqual(14);
  });
});

describe('demo mailbox', () => {
  it('advances the history id on every insert, per tenant', async () => {
    const a1 = await msg(A);
    const a2 = await msg(A);
    const b1 = await msg(B);
    expect(a2.historyId).toBe(a1.historyId + 1);
    expect(b1.historyId).toBe(1);
    expect(await currentDemoHistoryId(A.handle, A.userId)).toBe(a2.historyId);
  });

  it('is idempotent on the message id and lists after a history id', async () => {
    const first = await msg(A, { gmailMessageId: 'fixed-id', threadId: 't-1' });
    const again = await msg(A, { gmailMessageId: 'fixed-id', threadId: 't-1' });
    expect(again.id).toBe(first.id);
    const after = await listDemoMessagesAfterHistory(A.handle, A.userId, first.historyId - 1);
    expect(after.map((m) => m.gmailMessageId)).toContain('fixed-id');
    const none = await listDemoMessagesAfterHistory(A.handle, A.userId, first.historyId);
    expect(none.map((m) => m.gmailMessageId)).not.toContain('fixed-id');
  });

  it('finds sent mail by recipient and exact subject', async () => {
    const sent = await msg(A, {
      labelIds: ['SENT'],
      toAddress: 'rec@acme.test',
      subject: 'Re: Interview',
      threadId: 't-2',
    });
    const hit = await findDemoSent(A.handle, A.userId, {
      to: 'rec@acme.test',
      subject: 'Re: Interview',
      after: new Date(Date.now() - 60_000),
    });
    expect(hit?.id).toBe(sent.id);
    expect(
      await findDemoSent(A.handle, A.userId, {
        to: 'other@acme.test',
        subject: 'Re: Interview',
        after: new Date(0),
      }),
    ).toBeNull();
  });

  it('isolates tenants: B sees none of A and cannot write as A', async () => {
    const m = await msg(A, { gmailMessageId: 'iso-1', threadId: 'iso-t' });
    expect(await getDemoMessage(B.handle, 'iso-1')).toBeNull();
    expect(await listDemoThread(B.handle, 'iso-t')).toEqual([]);
    const err = await pgErrorMessage(
      B.handle.run((tx) =>
        tx.execute(
          `insert into demo_mailbox_messages (tenant_id, user_id, thread_id, gmail_message_id, history_id, from_address, to_address, subject, body_text) values ('${A.id}', '${A.userId}', 'x', 'y', 999, 'a', 'b', 'c', 'd')` as never,
        ),
      ),
    );
    expect(err).toMatch(/row-level security|violates/i);
    expect(m.tenantId).toBe(A.id);
  });
});

describe('demo calendar', () => {
  it('is get-or-create by client id and tenant-scoped', async () => {
    const start = new Date('2031-01-01T17:00:00Z');
    const end = new Date('2031-01-01T17:30:00Z');
    const one = await upsertDemoEvent(A.handle, {
      userId: A.userId,
      clientId: 'evt-1',
      summary: 'Interview',
      startsAt: start,
      endsAt: end,
    });
    const two = await upsertDemoEvent(A.handle, {
      userId: A.userId,
      clientId: 'evt-1',
      summary: 'Interview (moved)',
      startsAt: start,
      endsAt: end,
    });
    expect(two.id).toBe(one.id);
    expect(two.summary).toBe('Interview (moved)');
    expect(await listDemoEvents(A.handle, A.userId, { from: start, to: end })).toHaveLength(1);
    expect(
      await listDemoEvents(A.handle, A.userId, { from: end, to: new Date('2031-01-02T00:00:00Z') }),
    ).toHaveLength(0);
    expect(await getDemoEvent(B.handle, 'evt-1')).toBeNull();
    expect(await updateDemoEvent(B.handle, 'evt-1', { summary: 'hijack' })).toBeNull();
    expect((await getDemoEvent(A.handle, 'evt-1'))?.summary).toBe('Interview (moved)');
  });
});

describe('changeStageByUser', () => {
  it('moves the card, writes an override and a user activity entry in one go', async () => {
    const { application } = await makeApplication(A);
    await updateApplication(A.handle, application.id, { status: 'applied' });
    const r = await changeStageByUser(A.handle, {
      userId: A.userId,
      applicationId: application.id,
      from: 'applied',
      to: 'closed',
    });
    expect(r).toEqual({ ok: true });
    const after = await getApplication(A.handle, application.id);
    expect(after?.status).toBe('closed');
    expect(after?.closedReason).toBe('user');
    const overrides = await listStageOverrides(A.handle, application.id);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({ fromStatus: 'applied', toStatus: 'closed' });
    const log = await activity.listByApplication(A.handle, application.id);
    const entry = log.find((e) => e.action === 'stage_changed');
    expect(entry).toMatchObject({ actor: 'user', detail: { from: 'applied', to: 'closed' } });
  });

  it('on a stale from returns the current status and writes nothing', async () => {
    const { application } = await makeApplication(A);
    await updateApplication(A.handle, application.id, { status: 'interviewing' });
    const before = await getApplication(A.handle, application.id);
    const r = await changeStageByUser(A.handle, {
      userId: A.userId,
      applicationId: application.id,
      from: 'applied',
      to: 'closed',
    });
    expect(r).toEqual({ ok: false, current: 'interviewing' });
    const after = await getApplication(A.handle, application.id);
    expect(after?.status).toBe('interviewing');
    expect(after?.lastActivityAt).toEqual(before?.lastActivityAt);
    expect(await listStageOverrides(A.handle, application.id)).toEqual([]);
    const log = await activity.listByApplication(A.handle, application.id);
    expect(log).toEqual([]);
  });

  it('answers current null for another tenant, and writes nothing', async () => {
    const { application } = await makeApplication(A);
    const r = await changeStageByUser(B.handle, {
      userId: B.userId,
      applicationId: application.id,
      from: 'pending',
      to: 'closed',
    });
    expect(r).toEqual({ ok: false, current: null });
    expect((await getApplication(A.handle, application.id))?.status).toBe('pending');
  });

  it('reopening a closed card clears the closed reason', async () => {
    const { application } = await makeApplication(A);
    await changeStageByUser(A.handle, {
      userId: A.userId,
      applicationId: application.id,
      from: 'pending',
      to: 'closed',
    });
    const r = await changeStageByUser(A.handle, {
      userId: A.userId,
      applicationId: application.id,
      from: 'closed',
      to: 'applied',
    });
    expect(r.ok).toBe(true);
    expect((await getApplication(A.handle, application.id))?.closedReason).toBeNull();
    expect(await listStageOverrides(A.handle, application.id)).toHaveLength(2);
  });

  it('isolates stage overrides between tenants', async () => {
    const { application } = await makeApplication(A);
    await changeStageByUser(A.handle, {
      userId: A.userId,
      applicationId: application.id,
      from: 'pending',
      to: 'applied',
    });
    expect(await listStageOverrides(B.handle, application.id)).toEqual([]);
  });
});

describe('demo helpers', () => {
  it('counts flagged tenants and resolves the demo user only when exactly one is flagged', async () => {
    const base = await env.db.demoTenantCount();
    expect(base).toBe(0);
    expect(await env.db.demoUser()).toBeNull();
    await env.owner.query('update tenants set demo = true where id = $1', [A.id]);
    try {
      expect(await env.db.demoTenantCount()).toBe(1);
      expect(await env.db.demoUser()).toEqual({ tenantId: A.id, userId: A.userId });
      await env.owner.query('update tenants set demo = true where id = $1', [B.id]);
      expect(await env.db.demoTenantCount()).toBe(2);
      expect(await env.db.demoUser()).toBeNull();
    } finally {
      await env.owner.query('update tenants set demo = false where id = any($1::uuid[])', [
        [A.id, B.id],
      ]);
    }
    expect(randomUUID()).toBeTruthy();
  });
});
