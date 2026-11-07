import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  DEMO_POSTINGS,
  listRunCandidates,
  seedDemo,
  type Db,
  type SeedSummary,
} from '../src';
import { loadEnv } from '../src/env';

loadEnv();
const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';
const appUrl = (() => {
  const u = new URL(ownerUrl);
  u.username = 'wma_app';
  u.password = process.env.APP_DB_PASSWORD || 'wma_app';
  return u.toString();
})();

const slug = `demo-test-${randomUUID().slice(0, 8)}`;
let owner: pg.Pool;
let app: Db;
let first: SeedSummary;
let second: SeedSummary;

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: ownerUrl });
  app = createDb(appUrl);
  // Not flagged: the single-demo-tenant checks in other tests must not see this tenant.
  first = await seedDemo(ownerUrl, { slug, flagged: false, formsOrigin: 'http://127.0.0.1:4310' });
  second = await seedDemo(ownerUrl, { slug, flagged: false, formsOrigin: 'http://127.0.0.1:4310' });
});
afterAll(async () => {
  await owner.query('delete from tenants where slug = any($1::text[])', [
    [slug, `${slug}-sc`, `${slug}-port`],
  ]);
  await owner.query(
    `delete from companies c where c.board_slug = any($1::text[])
       and not exists (select 1 from jobs j where j.company_id = c.id)`,
    [DEMO_POSTINGS.map((p) => p.slug)],
  );
  await app.close();
  await owner.end();
});

describe('seed:demo', () => {
  it('creates the demo tenant, user, profile, companies, jobs and one finished run', () => {
    expect(first.created).toBe(true);
    expect(first.counts).toEqual({
      tenants: 1,
      users: 1,
      profiles: 1,
      sourceConnections: 5,
      companies: 12,
      jobs: 12,
      seededJobs: 12,
      captchaJobs: 1,
      runs: 1,
      runCandidates: 12,
      applications: 0,
      interviews: 0,
      demoMailboxMessages: 0,
    });
  });

  it('is idempotent: a second run leaves identical counts and ids', () => {
    expect(second.created).toBe(false);
    expect(second.counts).toEqual(first.counts);
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.userId).toBe(first.userId);
  });

  it('points every job at a fixture form on the vendor shapes, one of them the CAPTCHA variant', async () => {
    const r = await owner.query<{ ats: string; url: string }>(
      'select ats, url from jobs where tenant_id = $1',
      [first.tenantId],
    );
    expect(new Set(r.rows.map((x) => x.ats))).toEqual(new Set(['greenhouse', 'lever', 'ashby']));
    for (const row of r.rows) {
      expect(row.url).toMatch(
        new RegExp(`^http://127\\.0\\.0\\.1:4310/forms/${row.ats}/[a-z0-9-]+(\\?captcha)?$`),
      );
    }
    expect(r.rows.filter((x) => x.url.endsWith('?captcha'))).toHaveLength(1);
  });

  it('gives the user an approved profile, a Pacific time zone and connected sources', async () => {
    const u = await owner.query(
      'select email, timezone, approved_profile_version as v from users where id = $1',
      [first.userId],
    );
    expect(u.rows[0]).toMatchObject({ timezone: 'America/Los_Angeles', v: 1 });
    expect(u.rows[0].email).toContain('@wma.local');
    const c = await owner.query(
      "select count(*)::int as n from source_connections where tenant_id = $1 and status <> 'connected'",
      [first.tenantId],
    );
    expect(c.rows[0].n).toBe(0);
  });

  it('stores the run with its candidates in rank order and creates no applications', async () => {
    const handle = app.forTenant(first.tenantId);
    const run = await owner.query<{ id: string; status: string; date: string }>(
      'select id, status, date::text from runs where tenant_id = $1',
      [first.tenantId],
    );
    expect(run.rows[0]!.status).toBe('finished');
    expect(run.rows[0]!.date).not.toBe(new Date().toISOString().slice(0, 10));
    const candidates = await listRunCandidates(handle, run.rows[0]!.id);
    expect(candidates.map((c) => c.rank)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(candidates.every((c) => c.judgment !== null)).toBe(true);
    const apps = await owner.query('select 1 from applications where tenant_id = $1', [
      first.tenantId,
    ]);
    expect(apps.rowCount).toBe(0);
  });

  it('holds no real contact data', async () => {
    const r = await owner.query<{ document: { contact: { email: string; phone: string } } }>(
      'select document from profiles where tenant_id = $1',
      [first.tenantId],
    );
    const { email, phone } = r.rows[0]!.document.contact;
    expect(email).toMatch(/@wma\.local$/);
    expect(phone).toMatch(/555/);
  });
});

describe('the demo flag at the database level', () => {
  it('cannot be set by the application role, on update or on insert', async () => {
    const id = await app.createTenant();
    try {
      const direct = new pg.Pool({ connectionString: appUrl });
      try {
        await expect(
          direct.query('update tenants set demo = true where id = $1', [id]),
        ).rejects.toThrow(/permission denied|row-level/);
        const c = await direct.connect();
        try {
          await c.query('begin');
          await c.query(`select set_config('app.tenant_id', $1, true)`, [id]);
          await expect(c.query('update tenants set demo = true')).rejects.toThrow(
            /permission denied/,
          );
          await c.query('rollback');
          await c.query('begin');
          const other = randomUUID();
          await c.query(`select set_config('app.tenant_id', $1, true)`, [other]);
          await expect(
            c.query('insert into tenants (id, demo) values ($1, true)', [other]),
          ).rejects.toThrow(/cannot be set by the application role/);
          await c.query('rollback');
        } finally {
          c.release();
        }
      } finally {
        await direct.end();
      }
      const r = await owner.query('select demo from tenants where id = $1', [id]);
      expect(r.rows[0].demo).toBe(false);
    } finally {
      await owner.query('delete from tenants where id = $1', [id]);
    }
  });
});

describe('seed:demo --scenarios', () => {
  const scSlug = `${slug}-sc`;
  const origin = 'http://127.0.0.1:4310';
  let a: SeedSummary;
  let b: SeedSummary;

  beforeAll(async () => {
    a = await seedDemo(ownerUrl, {
      slug: scSlug,
      flagged: false,
      formsOrigin: origin,
      scenarios: true,
    });
    // A test moved a card between passes; the next pass puts it back.
    await owner.query("update applications set status = 'closed' where id = $1", [
      a.scenarios!.interviewing,
    ]);
    b = await seedDemo(ownerUrl, {
      slug: scSlug,
      flagged: false,
      formsOrigin: origin,
      scenarios: true,
    });
  });

  it('provisions an applied, an interviewing and an offer application, an interview and a running run', async () => {
    expect(a.counts).toMatchObject({
      applications: 3,
      interviews: 1,
      demoMailboxMessages: 1,
      runs: 2,
    });
    const apps = await owner.query<{ id: string; status: string }>(
      'select id, status from applications where tenant_id = $1 order by status',
      [a.tenantId],
    );
    expect(apps.rows.map((r) => r.status)).toEqual(['applied', 'interviewing', 'offer']);
    const run = await owner.query<{ status: string; n: number }>(
      `select r.status, (select count(*)::int from run_candidates c where c.run_id = r.id) as n
         from runs r where r.tenant_id = $1 and r.counts @> '{"scenario": "running"}'`,
      [a.tenantId],
    );
    expect(run.rows[0]).toMatchObject({ status: 'running' });
    expect(run.rows[0]!.n).toBeGreaterThan(0);
  });

  it('delivers the proposal for the applied card and owes a mail sync with it', async () => {
    const m = await owner.query<{ gmail_message_id: string; subject: string }>(
      'select gmail_message_id, subject from demo_mailbox_messages where tenant_id = $1',
      [a.tenantId],
    );
    expect(m.rows[0]!.gmail_message_id).toBe(`sim-proposal-${a.scenarios!.applied}`);
    expect(m.rows[0]!.subject).toMatch(/^Interview for /);
    const p = await owner.query<{ kind: string }>(
      'select kind from pending_jobs where tenant_id = $1',
      [a.tenantId],
    );
    expect(p.rows).toEqual([{ kind: 'mail-sync' }]);
  });

  it('books the interview with a ready prep plan and gives the offer card pay data', async () => {
    const i = await owner.query(
      'select prep_plan_status, confirmed_slot_id, calendar_event_id from interviews where id = $1',
      [a.scenarios!.interview],
    );
    expect(i.rows[0]).toMatchObject({ prep_plan_status: 'ready' });
    expect(i.rows[0].confirmed_slot_id).not.toBeNull();
    const o = await owner.query('select negotiation from applications where id = $1', [
      a.scenarios!.offer,
    ]);
    expect(o.rows[0].negotiation.comparables.length).toBeGreaterThan(0);
  });

  it('is idempotent and restores a moved fixture card', async () => {
    expect(b.counts).toEqual(a.counts);
    expect(b.scenarios).toEqual(a.scenarios);
    const r = await owner.query('select status from applications where id = $1', [
      a.scenarios!.interviewing,
    ]);
    expect(r.rows[0].status).toBe('interviewing');
  });
});

describe('seed:demo robustness', () => {
  it('builds posting urls from the configured forms origin', async () => {
    const portSlug = `${slug}-port`;
    const s = await seedDemo(ownerUrl, {
      slug: portSlug,
      flagged: false,
      formsOrigin: 'http://127.0.0.1:4999',
    });
    const r = await owner.query<{ url: string }>('select url from jobs where tenant_id = $1', [
      s.tenantId,
    ]);
    expect(r.rows).toHaveLength(12);
    expect(r.rows.every((x) => x.url.startsWith('http://127.0.0.1:4999/forms/'))).toBe(true);
    const c = await owner.query<{ url: string }>(
      'select url from run_candidates where tenant_id = $1',
      [s.tenantId],
    );
    expect(c.rows.every((x) => x.url.startsWith('http://127.0.0.1:4999/forms/'))).toBe(true);
  });

  it('gives a marked run that lost its candidates its candidates back', async () => {
    await owner.query('delete from run_candidates where tenant_id = $1', [first.tenantId]);
    const again = await seedDemo(ownerUrl, {
      slug,
      flagged: false,
      formsOrigin: 'http://127.0.0.1:4310',
    });
    expect(again.counts.runs).toBe(1);
    expect(again.counts.runCandidates).toBe(12);
  });
});
