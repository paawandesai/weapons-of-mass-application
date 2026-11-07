import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  customType,
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
    /** Will reference applications once that table exists (later change). */
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
