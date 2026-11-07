import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  DEMO_POSTINGS,
  insertApplication,
  listDemoThread,
  seedDemo,
  updateApplication,
  type ApplicationRow,
  type JobRow,
  type SeedSummary,
  type TenantHandle,
} from '@wma/db';
import { listJobsByIds } from '@wma/db';
import { setupEnv, type TestEnv } from '../helpers';

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';

export interface DemoEnv extends TestEnv {
  owner: pg.Pool;
  summary: SeedSummary;
  handle: TenantHandle;
  /** Seeded job rows by title. */
  jobsByTitle(title: string): Promise<JobRow>;
}

/** The seeded demo tenant (flagged) in the test database, plus the usual app-role helpers. */
export async function setupDemoEnv(): Promise<DemoEnv> {
  const env = await setupEnv();
  const owner = new pg.Pool({ connectionString: ownerUrl });
  const slug = `demo-w-${randomUUID().slice(0, 8)}`;
  const summary = await seedDemo(ownerUrl, { slug, flagged: true });
  const handle = env.db.forTenant(summary.tenantId);
  return {
    ...env,
    owner,
    summary,
    handle,
    async jobsByTitle(title) {
      const r = await owner.query<{ id: string }>(
        'select id from jobs where tenant_id = $1 and title = $2',
        [summary.tenantId, title],
      );
      return (await listJobsByIds(handle, [r.rows[0]!.id]))[0]!;
    },
    async cleanup() {
      await owner.query('update tenants set demo = false where id = $1', [summary.tenantId]);
      await owner.query('delete from tenants where id = $1', [summary.tenantId]);
      await owner.query(
        `delete from companies c where c.board_slug = any($1::text[])
           and not exists (select 1 from jobs j where j.company_id = c.id)`,
        [DEMO_POSTINGS.map((p) => p.slug)],
      );
      await env.cleanup();
      await owner.end();
    },
  };
}

/** An application on the job, moved to `applied` at `appliedAt`. */
export async function appliedTo(
  handle: TenantHandle,
  userId: string,
  jobId: string,
  appliedAt = new Date(),
): Promise<ApplicationRow> {
  const { application } = await insertApplication(handle, { userId, jobId });
  return (await updateApplication(handle, application.id, { status: 'applied', appliedAt }))!;
}

export const threadTexts = async (handle: TenantHandle, threadId: string) =>
  (await listDemoThread(handle, threadId)).map((m) => `${m.subject}\n${m.bodyText}`);

export const MONEY = /\$|\bsalary\b|\bcompensation\b|\bequity\b/i;
