import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const sourceKind = pgEnum('source_kind', [
  'resume',
  'linkedin',
  'github',
  'drive',
  'gmail',
  'calendar',
]);
export const sourceStatus = pgEnum('source_status', ['connected', 'disconnected', 'partial']);
export const secretKind = pgEnum('secret_kind', ['google_refresh_token', 'ats_password']);

/** The tenant row itself has no tenant_id; its RLS policy keys on `id`. */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull().unique(),
    googleSub: text('google_sub').notNull().unique(),
    displayName: text('display_name'),
    approvedProfileVersion: integer('approved_profile_version'),
    approvedProfileAt: timestamp('approved_profile_at', { withTimezone: true }),
    digestHour: integer('digest_hour').notNull().default(8),
    dailyTarget: integer('daily_target').notNull().default(12),
    createdAt: createdAt(),
  },
  (t) => [
    index('users_tenant_idx').on(t.tenantId),
    // Target for composite FKs so a child row cannot reference a user of another tenant.
    unique('users_tenant_id_id_key').on(t.tenantId, t.id),
  ],
);

/** Composite FK (tenant_id, user_id) -> users, so a row cannot point at another tenant's user. */
const userRef = (t: { tenantId: AnyPgColumn; userId: AnyPgColumn }) =>
  foreignKey({
    columns: [t.tenantId, t.userId],
    foreignColumns: [users.tenantId, users.id],
  }).onDelete('cascade');

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_tenant_user_idx').on(t.tenantId, t.userId), userRef(t)],
);

export const sourceConnections = pgTable(
  'source_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    kind: sourceKind('kind').notNull(),
    status: sourceStatus('status').notNull().default('connected'),
    config: jsonb('config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    fileRef: text('file_ref'),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
  },
  (t) => [
    index('source_connections_tenant_user_idx').on(t.tenantId, t.userId),
    // One row per (user, kind); both writing paths upsert on this.
    uniqueIndex('source_connections_tenant_user_kind_key').on(t.tenantId, t.userId, t.kind),
    userRef(t),
  ],
);

export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    version: integer('version').notNull(),
    document: jsonb('document').notNull(),
    builtFrom: jsonb('built_from')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index('profiles_tenant_user_idx').on(t.tenantId, t.userId),
    unique('profiles_user_id_version_key').on(t.userId, t.version),
    userRef(t),
  ],
);

export const buildState = pgEnum('build_state', ['running', 'done', 'failed']);

/** One row per profile.build request; the status endpoint reads the latest per user. */
export const profileBuilds = pgTable(
  'profile_builds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    state: buildState('state').notNull().default('running'),
    version: integer('version'),
    reason: text('reason'),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('profile_builds_tenant_user_idx').on(t.tenantId, t.userId, t.createdAt),
    // At most one running build per user: the reservation is enforced by the database.
    uniqueIndex('profile_builds_one_running_key')
      .on(t.userId)
      .where(sql`${t.state} = 'running'`),
    userRef(t),
  ],
);

export const activityLog = pgTable(
  'activity_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    applicationId: uuid('application_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    index('activity_log_tenant_user_at_idx').on(t.tenantId, t.userId, t.at),
    index('activity_log_tenant_application_at_idx').on(t.tenantId, t.applicationId, t.at),
    userRef(t),
    foreignKey({
      columns: [t.tenantId, t.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
    }),
  ],
);

export const vaultKeys = pgTable(
  'vault_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    wrappedDek: bytea('wrapped_dek').notNull(),
    /** IV and tag of the AES-256-GCM wrap of the DEK under the master key. */
    wrapIv: bytea('wrap_iv').notNull(),
    wrapTag: bytea('wrap_tag').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('vault_keys_tenant_id_key').on(t.tenantId)],
);

export const secrets = pgTable(
  'secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: secretKind('kind').notNull(),
    ref: varchar('ref', { length: 200 }).notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    iv: bytea('iv').notNull(),
    tag: bytea('tag').notNull(),
    createdAt: createdAt(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('secrets_tenant_kind_ref_key').on(t.tenantId, t.kind, t.ref)],
);

// ---------------------------------------------------------------------------------------------
// Wave 2: companies, daily runs, jobs, applications, ATS credentials, CAPTCHA requests.
// ---------------------------------------------------------------------------------------------

export const atsKind = pgEnum('ats_kind', ['ashby', 'greenhouse', 'lever']);
export const companySource = pgEnum('company_source', ['llm', 'user', 'hn']);
export const runStatus = pgEnum('run_status', [
  'running',
  'finished',
  'short_day',
  'skipped_no_profile',
  'failed',
]);
export const runTrigger = pgEnum('run_trigger', ['scheduled', 'manual']);
/** Manual dispatch bookkeeping: queued (row committed), dispatched (pg-boss accepted) or failed. */
export const dispatchState = pgEnum('dispatch_state', ['queued', 'dispatched', 'failed']);
export const applicationStatus = pgEnum('application_status', [
  'pending',
  'applied',
  'interviewing',
  'offer',
  'closed',
]);
export const confirmationSource = pgEnum('confirmation_source', ['page', 'email']);
export const credentialStatus = pgEnum('credential_status', [
  'registering',
  'verified',
  'rejected',
]);
export const captchaStage = pgEnum('captcha_stage', ['agent1', 'agent2', 'human']);

/** Global ATS board cache shared by every tenant: no tenant_id, no row-level security. */
export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    ats: atsKind('ats'),
    boardSlug: text('board_slug'),
    /** '' for the default (US) host, 'eu' for the EU-hosted Lever and Greenhouse boards. */
    boardRegion: text('board_region').notNull().default(''),
    boardUrl: text('board_url'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** An unresolved name is not retried before this instant. */
    unresolvedUntil: timestamp('unresolved_until', { withTimezone: true }),
    createdBy: companySource('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('companies_ats_board_slug_key')
      .on(t.ats, t.boardSlug, t.boardRegion)
      .where(sql`${t.ats} is not null`),
    index('companies_name_idx').on(t.name),
    // One identity per unresolved company name, so concurrent generations cannot fork it.
    uniqueIndex('companies_unresolved_name_key')
      .on(sql`lower(${t.name})`)
      .where(sql`${t.ats} is null`),
  ],
);

export const userCompanies = pgTable(
  'user_companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    source: companySource('source').notNull(),
    reason: text('reason'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => [
    index('user_companies_tenant_user_idx').on(t.tenantId, t.userId),
    unique('user_companies_user_id_company_id_key').on(t.userId, t.companyId),
    userRef(t),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    /** The user's run date in UTC. */
    date: date('date', { mode: 'string' }).notNull(),
    trigger: runTrigger('trigger').notNull().default('scheduled'),
    dispatchState: dispatchState('dispatch_state'),
    status: runStatus('status').notNull().default('running'),
    step: text('step'),
    targetN: integer('target_n').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    sourceStatus: jsonb('source_status')
      .notNull()
      .default(sql`'{}'::jsonb`),
    counts: jsonb('counts')
      .notNull()
      .default(sql`'{}'::jsonb`),
    shortDay: boolean('short_day').notNull().default(false),
    shortfall: integer('shortfall').notNull().default(0),
    error: text('error'),
  },
  (t) => [
    index('runs_tenant_user_date_idx').on(t.tenantId, t.userId, t.date),
    // A failed run releases the date so a retry can run.
    uniqueIndex('runs_user_date_not_failed_key')
      .on(t.userId, t.date)
      .where(sql`${t.status} <> 'failed'`),
    unique('runs_tenant_id_id_key').on(t.tenantId, t.id),
    userRef(t),
  ],
);

export const runCandidates = pgTable(
  'run_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    companyName: text('company_name').notNull(),
    url: text('url').notNull(),
    ats: atsKind('ats'),
    atsJobId: text('ats_job_id'),
    /** Null when the candidate was never judged (exclusion_reason = unjudged). */
    judgment: jsonb('judgment'),
    promptVersion: text('prompt_version'),
    model: text('model'),
    rank: integer('rank'),
    selected: boolean('selected').notNull().default(false),
    exclusionReason: text('exclusion_reason'),
  },
  (t) => [
    index('run_candidates_tenant_run_idx').on(t.tenantId, t.runId, t.rank),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
    }).onDelete('cascade'),
  ],
);

/** Written only at hand-off. */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => companies.id),
    ats: atsKind('ats'),
    atsJobId: text('ats_job_id'),
    title: text('title').notNull(),
    url: text('url').notNull(),
    description: text('description'),
    location: text('location'),
    locationMode: text('location_mode'),
    payMin: bigint('pay_min', { mode: 'number' }),
    payMax: bigint('pay_max', { mode: 'number' }),
    currency: text('currency'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    raw: jsonb('raw'),
    createdAt: createdAt(),
  },
  (t) => [
    index('jobs_tenant_idx').on(t.tenantId),
    uniqueIndex('jobs_tenant_ats_job_id_key')
      .on(t.tenantId, t.ats, t.atsJobId)
      .where(sql`${t.atsJobId} is not null`),
    unique('jobs_tenant_url_key').on(t.tenantId, t.url),
    unique('jobs_tenant_id_id_key').on(t.tenantId, t.id),
  ],
);

export const applications = pgTable(
  'applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    jobId: uuid('job_id').notNull(),
    /** Runs are deleted after 7 days; the application stays. */
    runId: uuid('run_id'),
    status: applicationStatus('status').notNull().default('pending'),
    pendingReason: text('pending_reason'),
    closedReason: text('closed_reason'),
    attemptCount: integer('attempt_count').notNull().default(0),
    resumePdfRef: text('resume_pdf_ref'),
    formAnswers: jsonb('form_answers')
      .notNull()
      .default(sql`'{}'::jsonb`),
    unmetRequirements: jsonb('unmet_requirements')
      .notNull()
      .default(sql`'[]'::jsonb`),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    /** Set once the follow-up job is confirmed queued. Null on an applied row is the outbox record: the job is still owed and reconciliation enqueues it. */
    followUpEnqueuedAt: timestamp('follow_up_enqueued_at', { withTimezone: true }),
    confirmationSource: confirmationSource('confirmation_source'),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('applications_tenant_user_status_idx').on(t.tenantId, t.userId, t.status),
    unique('applications_user_id_job_id_key').on(t.userId, t.jobId),
    unique('applications_tenant_id_id_key').on(t.tenantId, t.id),
    userRef(t),
    foreignKey({ columns: [t.tenantId, t.jobId], foreignColumns: [jobs.tenantId, jobs.id] }),
    // set null only the run column (hand-edited to `SET NULL (run_id)` in the migration SQL so the
    // non-null tenant column is kept).
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
    }).onDelete('set null'),
  ],
);

/** Vault reference `<ats>:<company_id>`; the password itself lives in `secrets`. */
export const atsCredentials = pgTable(
  'ats_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    ats: atsKind('ats').notNull(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    username: text('username').notNull(),
    vaultRef: text('vault_ref').notNull(),
    /** registering: sign-up may not have completed (resume with the vaulted password). */
    status: credentialStatus('status').notNull().default('registering'),
    /** Start of the latest sign-up attempt; verification mail must arrive after it. */
    registrationStartedAt: timestamp('registration_started_at', { withTimezone: true }),
    createdAt: createdAt(),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  },
  (t) => [
    index('ats_credentials_tenant_user_idx').on(t.tenantId, t.userId),
    unique('ats_credentials_user_ats_company_key').on(t.userId, t.ats, t.companyId),
    userRef(t),
  ],
);

export const captchaRequests = pgTable(
  'captcha_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Denormalized from the application so "one open human request per user" is one query. */
    userId: uuid('user_id').notNull(),
    applicationId: uuid('application_id').notNull(),
    stage: captchaStage('stage').notNull().default('agent1'),
    attempts: jsonb('attempts')
      .notNull()
      .default(sql`'{"agent1":0,"agent2":0,"human":0}'::jsonb`),
    imageRef: text('image_ref'),
    /** sha256 of the single-use token; the token itself is never stored. */
    tokenHash: text('token_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    humanAnswer: text('human_answer'),
    resolvedBy: captchaStage('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('captcha_requests_tenant_application_idx').on(t.tenantId, t.applicationId),
    index('captcha_requests_tenant_user_stage_idx').on(t.tenantId, t.userId, t.stage),
    uniqueIndex('captcha_requests_token_hash_key')
      .on(t.tokenHash)
      .where(sql`${t.tokenHash} is not null`),
    userRef(t),
    foreignKey({
      columns: [t.tenantId, t.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
    }).onDelete('cascade'),
  ],
);
