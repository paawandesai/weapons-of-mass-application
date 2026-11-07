import { and, eq, sql } from 'drizzle-orm';
import { createDb, type Db, type TenantHandle } from '../client';
import { upsertCompany } from '../repos/companies';
import { findJob } from '../repos/jobs';
import { insertProfileVersion, getProfileVersion } from '../repos/profiles';
import { insertRunCandidates } from '../repos/run_candidates';
import { upsertConnection } from '../repos/source_connections';
import {
  createUser,
  listUsers,
  setApprovedProfileVersion,
  setNotificationSettings,
} from '../repos/users';
import { jobs, runCandidates, runs } from '../schema';
import { seedScenarios, type ScenarioSummary } from './scenarios';
import {
  demoFormsOrigin,
  DEMO_POSTINGS,
  demoPostings,
  demoProfile,
  DEMO_TENANT_SLUG,
  DEMO_USER_EMAIL,
  postingJobId,
  postingUrl,
} from './catalog';

export interface SeedOptions {
  /** Tenant natural key. Default `demo`. */
  slug?: string;
  /** Default `demo@wma.local` for the `demo` slug, `demo+<slug>@wma.local` otherwise. */
  email?: string;
  /** Tenant id used when the tenant is created; ignored when the slug already exists. */
  tenantId?: string;
  /** Sets `tenants.demo`. Default true; tests that must not disturb the single-demo-tenant rule pass false. */
  flagged?: boolean;
  /** Origin of the fixture forms server in posting URLs. Default: `demoFormsOrigin()` (env). */
  formsOrigin?: string;
  /** Also provision the rehearsal fixtures (applied, interviewing, offer, running run). */
  scenarios?: boolean;
  log?: (line: string) => void;
}

export interface SeedSummary {
  tenantId: string;
  userId: string;
  slug: string;
  created: boolean;
  counts: {
    tenants: number;
    users: number;
    profiles: number;
    sourceConnections: number;
    companies: number;
    jobs: number;
    seededJobs: number;
    captchaJobs: number;
    runs: number;
    runCandidates: number;
    applications: number;
    interviews: number;
    demoMailboxMessages: number;
  };
  /** Present when `scenarios` was requested. */
  scenarios?: ScenarioSummary;
}

/** Run-view rationale per posting; written once, never regenerated. */
const rationale = (title: string, company: string, mode: string) =>
  `${title} at ${company} matches the target titles and the ${mode} preference.`;

const SELECTED_COUNT = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

async function ensureTenant(
  db: Db,
  opts: Required<Pick<SeedOptions, 'slug' | 'flagged'>> & { tenantId: string },
) {
  const existing = await db.pool.query<{ id: string }>('select id from tenants where slug = $1', [
    opts.slug,
  ]);
  const id = existing.rows[0]?.id ?? opts.tenantId;
  const handle = db.forTenant(id);
  await handle.run((tx) =>
    tx.execute(sql`
      insert into tenants (id, slug, demo) values (${id}::uuid, ${opts.slug}, ${opts.flagged})
      on conflict (id) do update set demo = excluded.demo, slug = excluded.slug`),
  );
  return { id, handle, created: existing.rows.length === 0 };
}

/**
 * Creates (or completes) the demo tenant. Idempotent by natural keys: tenant slug, user email,
 * company (ats, board slug), job url, one marked run. Must connect as the OWNER role: only the
 * owner can set `tenants.demo`.
 */
export async function seedDemoWith(db: Db, options: SeedOptions = {}): Promise<SeedSummary> {
  const slug = options.slug ?? DEMO_TENANT_SLUG;
  const email =
    options.email ?? (slug === DEMO_TENANT_SLUG ? DEMO_USER_EMAIL : `demo+${slug}@wma.local`);
  const log = options.log ?? (() => {});
  const tenant = await ensureTenant(db, {
    slug,
    flagged: options.flagged ?? true,
    tenantId: options.tenantId ?? crypto.randomUUID(),
  });
  const handle = tenant.handle;
  const origin = (options.formsOrigin ?? demoFormsOrigin()).replace(/\/+$/, '');
  const profile = demoProfile();
  const postings = demoPostings();
  const gauntlet = postings !== DEMO_POSTINGS;

  let user = (await listUsers(handle)).find((u) => u.email === email);
  if (!user) {
    user = await createUser(handle, {
      email,
      googleSub: `demo-sub-${slug}`,
      displayName: profile.identity.full_name,
    });
  }
  await setNotificationSettings(handle, user.id, {
    timezone: 'America/Los_Angeles',
    digestHour: 8,
  });

  if (user.approvedProfileVersion === null) {
    const row = await insertProfileVersion(handle, {
      userId: user.id,
      document: { ...profile, contact: { ...profile.contact, email } },
      builtFrom: { seeded: true },
    });
    await setApprovedProfileVersion(handle, user.id, row.version);
    log(`profile version ${row.version} approved`);
  } else {
    await getProfileVersion(handle, user.id, user.approvedProfileVersion);
  }

  for (const kind of ['resume', 'linkedin', 'github', 'gmail', 'calendar'] as const) {
    await upsertConnection(handle, {
      userId: user.id,
      kind,
      status: 'connected',
      config: { seeded: true },
    });
  }

  const companyIds = new Map<string, string>();
  for (const p of postings) {
    const company = await upsertCompany(handle, {
      name: p.company,
      ats: p.vendor,
      boardSlug: p.slug,
      boardUrl: `${origin}/forms/${p.vendor}/`,
      createdBy: 'user',
    });
    companyIds.set(p.slug, company.id);
    const url = postingUrl(p, origin);
    const existing = await findJob(handle, { ats: p.vendor, atsJobId: postingJobId(p), url });
    if (existing) {
      // A seed under another forms origin moves the posting there instead of adding a second one.
      await handle.run((tx) =>
        tx
          .update(jobs)
          .set({ seeded: true, url })
          .where(and(eq(jobs.tenantId, handle.tenantId), eq(jobs.id, existing.id))),
      );
    } else {
      await handle.run((tx) =>
        tx.insert(jobs).values({
          tenantId: handle.tenantId,
          companyId: company.id,
          ats: p.vendor,
          atsJobId: postingJobId(p),
          title: p.title,
          url,
          description: p.description,
          location: p.location,
          locationMode: p.mode,
          payMin: p.payMin,
          payMax: p.payMax,
          currency: 'USD',
          postedAt: new Date(Date.now() - 3 * DAY_MS),
          raw: { seeded: true },
          seeded: true,
        }),
      );
    }
  }

  // Gauntlet mode skips the finished run: its selected candidates could mark the one posting as
  // already seen, and today's run would then apply to nothing.
  if (!gauntlet) await seedRun(handle, user.id, origin);
  const scenarios = options.scenarios
    ? await seedScenarios(handle, { id: user.id, email: user.email }, origin)
    : undefined;

  const counts = await countsFor(db, tenant.id);
  log(JSON.stringify(counts));
  return {
    tenantId: tenant.id,
    userId: user.id,
    slug,
    created: tenant.created,
    counts,
    ...(scenarios ? { scenarios } : {}),
  };
}

/**
 * One finished run dated yesterday (today stays free for an on-demand run), marked
 * `counts.seeded`. The run and its candidates commit together, and a marked run that lost its
 * candidates (an older interrupted seed) gets them back, so the seed repairs itself.
 */
async function seedRun(handle: TenantHandle, userId: string, origin: string): Promise<void> {
  await handle.transaction(async (h) => {
    const marked = await h.run((tx) =>
      tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.tenantId, h.tenantId),
            eq(runs.userId, userId),
            sql`${runs.counts} @> '{"seeded": true}'::jsonb`,
          ),
        ),
    );
    let runId = marked[0]?.id;
    if (!runId) {
      const day = new Date(Date.now() - DAY_MS);
      const date = day.toISOString().slice(0, 10);
      const started = new Date(`${date}T15:00:00Z`);
      const rows = await h.run((tx) =>
        tx
          .insert(runs)
          .values({
            tenantId: h.tenantId,
            userId,
            date,
            trigger: 'scheduled',
            status: 'finished',
            step: 'finalize',
            targetN: SELECTED_COUNT,
            startedAt: started,
            endedAt: new Date(started.getTime() + 4 * 60_000),
            counts: {
              seeded: true,
              fetched: DEMO_POSTINGS.length,
              deduped: DEMO_POSTINGS.length,
              judged: DEMO_POSTINGS.length,
              approved: DEMO_POSTINGS.length,
              selected: SELECTED_COUNT,
              over_target: DEMO_POSTINGS.length - SELECTED_COUNT,
            },
            shortDay: false,
            shortfall: 0,
          })
          .onConflictDoNothing()
          .returning({ id: runs.id }),
      );
      runId = rows[0]?.id;
    }
    if (!runId) return; // a run already holds the date; the seed adds nothing to it
    const have = await h.run((tx) =>
      tx
        .select({ id: runCandidates.id })
        .from(runCandidates)
        .where(and(eq(runCandidates.tenantId, h.tenantId), eq(runCandidates.runId, runId!))),
    );
    if (have.length > 0) return;
    await insertRunCandidates(
      h,
      runId,
      DEMO_POSTINGS.map((p, i) => ({
        title: p.title,
        companyName: p.company,
        url: postingUrl(p, origin),
        ats: p.vendor,
        atsJobId: postingJobId(p),
        judgment: {
          apply: true,
          rationale: rationale(p.title, p.company, p.mode),
          fit: Math.max(1, 5 - Math.floor(i / 4)),
          pay_min: p.payMin,
          pay_max: p.payMax,
          currency: 'USD',
          location_mode: p.mode,
          seniority: /staff|principal/i.test(p.title) ? 'staff' : 'senior',
          application_deadline: null,
        },
        promptVersion: 'apply-decision@v1',
        model: 'seeded',
        rank: i + 1,
        selected: i < SELECTED_COUNT,
        exclusionReason: i < SELECTED_COUNT ? null : 'over_target',
      })),
    );
  });
}

async function countsFor(db: Db, tenantId: string): Promise<SeedSummary['counts']> {
  const r = await db.pool.query<Record<string, string>>(
    `select
       (select count(*) from tenants where id = $1) as tenants,
       (select count(*) from users where tenant_id = $1) as users,
       (select count(*) from profiles where tenant_id = $1) as profiles,
       (select count(*) from source_connections where tenant_id = $1) as source_connections,
       (select count(*) from companies c where exists
          (select 1 from jobs j where j.company_id = c.id and j.tenant_id = $1)) as companies,
       (select count(*) from jobs where tenant_id = $1) as jobs,
       (select count(*) from jobs where tenant_id = $1 and seeded) as seeded_jobs,
       (select count(*) from jobs where tenant_id = $1 and url like '%?captcha') as captcha_jobs,
       (select count(*) from runs where tenant_id = $1) as runs,
       (select count(*) from run_candidates where tenant_id = $1) as run_candidates,
       (select count(*) from applications where tenant_id = $1) as applications,
       (select count(*) from interviews where tenant_id = $1) as interviews,
       (select count(*) from demo_mailbox_messages where tenant_id = $1) as demo_mailbox_messages`,
    [tenantId],
  );
  const row = r.rows[0]!;
  const n = (k: string) => Number(row[k]);
  return {
    tenants: n('tenants'),
    users: n('users'),
    profiles: n('profiles'),
    sourceConnections: n('source_connections'),
    companies: n('companies'),
    jobs: n('jobs'),
    seededJobs: n('seeded_jobs'),
    captchaJobs: n('captcha_jobs'),
    runs: n('runs'),
    runCandidates: n('run_candidates'),
    applications: n('applications'),
    interviews: n('interviews'),
    demoMailboxMessages: n('demo_mailbox_messages'),
  };
}

/** Connects with `ownerUrl` (the OWNER role), seeds, and closes the connection. */
export async function seedDemo(ownerUrl: string, options: SeedOptions = {}): Promise<SeedSummary> {
  const db = createDb(ownerUrl);
  try {
    return await seedDemoWith(db, options);
  } finally {
    await db.close();
  }
}
