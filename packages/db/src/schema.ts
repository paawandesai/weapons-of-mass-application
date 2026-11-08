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
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
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
  /** Server-set only (seed script or migration); no API writes it. */
  demo: boolean('demo').notNull().default(false),
  /** Natural key of seeded tenants (`demo`); null for every tenant created through sign-in. */
  slug: text('slug').unique(),
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
    /** IANA zone the digest hour and slot display are interpreted in. */
    timezone: text('timezone').notNull().default('America/Los_Angeles'),
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
    /** Phase of a running build: gathering, extracting or checking. Null reads as gathering. */
    step: text('step'),
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
    /** True for demo fixture postings the simulated recruiter answers; set only by the seed script. */
    seeded: boolean('seeded').notNull().default(false),
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
    /** Set when the follow-up email was sent; the follow-up job sends at most once. */
    followedUpAt: timestamp('followed_up_at', { withTimezone: true }),
    confirmationSource: confirmationSource('confirmation_source'),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    /** Offer panel data `{posted_min, posted_max, currency, floor, comparables[], fetched_at, error}`. */
    negotiation: jsonb('negotiation'),
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

// ---------------------------------------------------------------------------------------------
// Wave 3: inbox sync, interview scheduling, outgoing mail.
// ---------------------------------------------------------------------------------------------

export const threadKind = pgEnum('thread_kind', [
  'confirmation',
  'rejection',
  'interview',
  'offer',
  'other',
  'unlinked',
]);
export const processedOutcome = pgEnum('processed_outcome', ['linked', 'unlinked', 'failed']);
export const prepPlanStatus = pgEnum('prep_plan_status', ['pending', 'ready', 'failed']);
/** pending: the send is in flight or its outcome is unknown; sent: Gmail accepted it; blocked: a guard stopped it. */
export const outgoingState = pgEnum('outgoing_state', ['pending', 'sent', 'blocked']);

export const outgoingKind = pgEnum('outgoing_kind', [
  'follow_up',
  'slot_confirmation',
  'recruiter_reply',
  'reminder',
  'digest',
  'captcha_request',
  'other',
]);

export const emailThreads = pgTable(
  'email_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    /** Null while the thread is unlinked. */
    applicationId: uuid('application_id'),
    gmailThreadId: text('gmail_thread_id').notNull(),
    kind: threadKind('kind').notNull(),
    compensationFlag: boolean('compensation_flag').notNull().default(false),
    bookingLink: text('booking_link'),
    /** Subject of the thread's first message, written at sync time. */
    subject: text('subject'),
    promptVersion: text('prompt_version'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('email_threads_tenant_gmail_thread_key').on(t.tenantId, t.gmailThreadId),
    unique('email_threads_tenant_id_id_key').on(t.tenantId, t.id),
    index('email_threads_tenant_application_idx').on(t.tenantId, t.applicationId),
    userRef(t),
    foreignKey({
      columns: [t.tenantId, t.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
    }).onDelete('cascade'),
  ],
);

export const processedMessages = pgTable(
  'processed_messages',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    gmailMessageId: text('gmail_message_id').notNull(),
    /** Null for a message that failed before a thread row existed. */
    threadId: uuid('thread_id'),
    outcome: processedOutcome('outcome').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.gmailMessageId] }),
    index('processed_messages_tenant_user_idx').on(t.tenantId, t.userId),
    userRef(t),
    foreignKey({
      columns: [t.tenantId, t.threadId],
      foreignColumns: [emailThreads.tenantId, emailThreads.id],
    }).onDelete('cascade'),
  ],
);

export const interviews = pgTable(
  'interviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    applicationId: uuid('application_id').notNull(),
    threadId: uuid('thread_id').notNull(),
    /** The slot the user confirmed (no foreign key: slots reference their interview). */
    confirmedSlotId: uuid('confirmed_slot_id'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    calendarEventId: text('calendar_event_id'),
    replySentAt: timestamp('reply_sent_at', { withTimezone: true }),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    prepPlan: text('prep_plan'),
    prepPlanStatus: prepPlanStatus('prep_plan_status'),
    feedback: jsonb('feedback'),
    confirmationEmailSentAt: timestamp('confirmation_email_sent_at', { withTimezone: true }),
    /** Bumped each time a slot is confirmed and each time a reschedule clears the confirmation; booking writes are conditioned on it. */
    confirmedGeneration: integer('confirmed_generation').notNull().default(0),
    /** Client-generated Calendar event id, persisted before the insert so a retry finds the same event. */
    calendarEventClientId: text('calendar_event_client_id'),
    /** The confirmed generation whose reply and Calendar write both completed; null until then. */
    bookedGeneration: integer('booked_generation'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('interviews_tenant_id_id_key').on(t.tenantId, t.id),
    // One interview per application thread.
    index('interviews_tenant_thread_created_idx').on(t.tenantId, t.threadId, t.createdAt),
    index('interviews_tenant_application_idx').on(t.tenantId, t.applicationId),
    index('interviews_tenant_user_starts_idx').on(t.tenantId, t.userId, t.startsAt),
    userRef(t),
    foreignKey({
      columns: [t.tenantId, t.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.threadId],
      foreignColumns: [emailThreads.tenantId, emailThreads.id],
    }).onDelete('cascade'),
  ],
);

export const interviewSlots = pgTable(
  'interview_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    interviewId: uuid('interview_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    tzHint: text('tz_hint'),
    /** sha256 of the single-use token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('interview_slots_token_hash_key').on(t.tokenHash),
    index('interview_slots_tenant_interview_idx').on(t.tenantId, t.interviewId),
    foreignKey({
      columns: [t.tenantId, t.interviewId],
      foreignColumns: [interviews.tenantId, interviews.id],
    }).onDelete('cascade'),
  ],
);

export const outgoingMessages = pgTable(
  'outgoing_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    applicationId: uuid('application_id'),
    kind: outgoingKind('kind').notNull(),
    toAddress: text('to_address').notNull(),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html'),
    gmailMessageId: text('gmail_message_id'),
    blocked: boolean('blocked').notNull().default(false),
    blockedReason: text('blocked_reason'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    state: outgoingState('state').notNull().default('sent'),
    /** Logical identity of the send (kind + logical id); written before Gmail is called. */
    deliveryKey: text('delivery_key'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('outgoing_messages_tenant_delivery_key_key')
      .on(t.tenantId, t.deliveryKey)
      .where(sql`${t.deliveryKey} is not null`),
    index('outgoing_messages_tenant_user_created_idx').on(t.tenantId, t.userId, t.createdAt),
    index('outgoing_messages_tenant_application_idx').on(t.tenantId, t.applicationId),
    userRef(t),
    foreignKey({
      columns: [t.tenantId, t.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
    }).onDelete('cascade'),
  ],
);

export const mailSyncState = pgTable(
  'mail_sync_state',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    historyId: text('history_id'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    reauthNeeded: boolean('reauth_needed').notNull().default(false),
    /** Messages listed but not processed (calendar unreadable); retried by id on every sync. */
    deferredMessageIds: text('deferred_message_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] }), userRef(t)],
);

/** Per-user digest cursor: activity up to `collectedThrough` was included in a digest. */
export const digestState = pgTable(
  'digest_state',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    collectedThrough: timestamp('collected_through', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] }), userRef(t)],
);

// ---------------------------------------------------------------------------------------------
// Wave 4: user stage moves and the per-tenant demo mailbox and calendar.
// ---------------------------------------------------------------------------------------------

/** One row per board move made by the user (the agent's own transitions never write here). */
export const stageOverrides = pgTable(
  'stage_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    applicationId: uuid('application_id').notNull(),
    fromStatus: applicationStatus('from_status').notNull(),
    toStatus: applicationStatus('to_status').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('stage_overrides_tenant_application_idx').on(t.tenantId, t.applicationId, t.at),
    userRef(t),
    foreignKey({
      columns: [t.tenantId, t.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
    }).onDelete('cascade'),
  ],
);

/** The demo tenant's mailbox: what Gmail would hold for the user, read by the same inbox code. */
export const demoMailboxMessages = pgTable(
  'demo_mailbox_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    threadId: text('thread_id').notNull(),
    gmailMessageId: text('gmail_message_id').notNull(),
    /** Per-tenant, strictly increasing (wma_demo_next_history_id). */
    historyId: bigint('history_id', { mode: 'number' }).notNull(),
    fromAddress: text('from_address').notNull(),
    fromName: text('from_name'),
    toAddress: text('to_address').notNull(),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    headers: jsonb('headers')
      .notNull()
      .default(sql`'{}'::jsonb`),
    labelIds: text('label_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    internalDate: timestamp('internal_date', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('demo_mailbox_tenant_message_key').on(t.tenantId, t.gmailMessageId),
    unique('demo_mailbox_tenant_history_key').on(t.tenantId, t.historyId),
    index('demo_mailbox_tenant_thread_idx').on(t.tenantId, t.threadId, t.internalDate),
    userRef(t),
  ],
);

/** The demo tenant's calendar: events the fake calendar port records. */
export const demoCalendarEvents = pgTable(
  'demo_calendar_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    /** The id the scheduling code uses to find the event again (a Google event id in production). */
    clientId: text('client_id').notNull(),
    summary: text('summary').notNull(),
    description: text('description').notNull().default(''),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('demo_calendar_tenant_client_key').on(t.tenantId, t.clientId),
    index('demo_calendar_tenant_user_starts_idx').on(t.tenantId, t.userId, t.startsAt),
    userRef(t),
  ],
);

/**
 * Durable follow-on work, written inside the transaction of the parent change and dispatched to
 * the queue by a reconciler. `dedupeKey` is unique per tenant so a repeated trigger is one row.
 */
export const pendingJobs = pgTable(
  'pending_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: createdAt(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  },
  (t) => [
    unique('pending_jobs_tenant_dedupe_key').on(t.tenantId, t.dedupeKey),
    index('pending_jobs_undispatched_idx').on(t.tenantId, t.dispatchedAt),
    userRef(t),
  ],
);

/**
 * One row per model call the worker makes: who it was for, which part of the product, the prompt,
 * the token counts and the estimated cost. Written by the LLM tracking wrapper; summed by the
 * usage endpoint. `applicationId` is set when the call served one application.
 */
export const llmUsage = pgTable(
  'llm_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    applicationId: uuid('application_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    purpose: text('purpose').notNull(),
    prompt: text('prompt').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheCreationInputTokens: integer('cache_creation_input_tokens').notNull().default(0),
    cacheReadInputTokens: integer('cache_read_input_tokens').notNull().default(0),
    /** Estimated USD from the price table at call time; null when the model had no known price. */
    costUsd: numeric('cost_usd', { precision: 14, scale: 8 }),
    durationMs: integer('duration_ms').notNull().default(0),
  },
  (t) => [
    index('llm_usage_tenant_user_at_idx').on(t.tenantId, t.userId, t.at),
    index('llm_usage_tenant_application_idx').on(t.tenantId, t.applicationId),
    userRef(t),
    foreignKey({
      columns: [t.tenantId, t.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
    }).onDelete('set null'),
  ],
);
