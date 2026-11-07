import type { PgBoss } from 'pg-boss';
import { deleteRunsBefore, type Db } from '@wma/db';
import { createLlmClient, type StructuredLlm } from '@wma/llm';
import { bossSubmitQueue, type SubmitQueue } from '../discovery/handoff';
import type { Http } from '@wma/discovery';
import { DEFAULT_JUDGE_CAP, executeDailyRun, type DailyRunDeps } from '../discovery/run';
import { utcDate } from '../discovery/text';
import { adaptersFor } from '../discovery/adapters';
import type { SourceAdapter } from '../discovery/types';

export const DAILY_RUN_JOB = 'daily-run';
/** Hourly: enqueues a daily-run for every user whose run hour is the current UTC hour. */
export const DAILY_RUN_TICK_JOB = 'daily-run-tick';
/** Nightly: deletes runs older than RUN_RETENTION_DAYS. */
export const DAILY_RUN_CLEANUP_JOB = 'daily-run-cleanup';
export const RUN_RETENTION_DAYS = 7;

/** `JUDGE_CAP_PER_RUN`: an integer >= 1, else the default (the caller logs the fallback). */
export function parseJudgeCap(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_JUDGE_CAP;
  const n = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (Number.isSafeInteger(n) && n >= 1) return n;
  console.warn(
    `JUDGE_CAP_PER_RUN=${JSON.stringify(value)} is not an integer >= 1; using ${DEFAULT_JUDGE_CAP}`,
  );
  return DEFAULT_JUDGE_CAP;
}

export interface DailyRunJobData {
  tenantId: string;
  userId: string;
  /** Run date, `YYYY-MM-DD` (UTC). */
  date: string;
  trigger?: 'scheduled' | 'manual';
}

export const dailyRunKey = (userId: string, date: string) => `daily-run:${userId}:${date}`;

/**
 * Enqueues a daily-run. The queue's exclusive policy plus the singleton key make a second enqueue
 * for the same user and date a no-op while the first is queued or running (returns null); the
 * (user, date) unique index on `runs` covers the time after it has finished.
 */
export function enqueueDailyRun(boss: PgBoss, data: DailyRunJobData): Promise<string | null> {
  return boss.send(DAILY_RUN_JOB, data, {
    singletonKey: dailyRunKey(data.userId, data.date),
    retryLimit: 0,
  });
}

export interface RosterUser {
  tenantId: string;
  userId: string;
  /** UTC hour 0-23 at which the user's run starts (the user's configured hour). */
  runHour: number;
}

/**
 * Cross-tenant enumeration for the scheduler. Row-level security hides every other tenant from
 * the application role, so enumeration goes through two SECURITY DEFINER functions that return
 * identifiers and an hour only; everything done for a user afterwards goes through a tenant handle.
 */
export interface Roster {
  /** Users with an approved profile. */
  activeUsers(): Promise<RosterUser[]>;
  /** Tenants that own runs dated before `cutoff` (`YYYY-MM-DD`). */
  tenantsWithRunsBefore(cutoff: string): Promise<string[]>;
}

/** The production roster: the application connection and the roster functions, nothing more. */
export function dbRoster(db: Db): Roster {
  return {
    activeUsers: () => db.runRoster(),
    tenantsWithRunsBefore: (cutoff) => db.tenantsWithRunsBefore(cutoff),
  };
}

/** Scheduler tick: one daily-run per active user whose run hour is `now`'s UTC hour. */
export async function enqueueScheduledRuns(
  boss: PgBoss,
  roster: Roster,
  now: Date,
): Promise<{ date: string; enqueued: number; duplicates: number }> {
  const date = utcDate(now);
  const hour = now.getUTCHours();
  let enqueued = 0;
  let duplicates = 0;
  for (const u of await roster.activeUsers()) {
    if (u.runHour !== hour) continue;
    const id = await enqueueDailyRun(boss, {
      tenantId: u.tenantId,
      userId: u.userId,
      date,
      trigger: 'scheduled',
    });
    if (id) enqueued++;
    else duplicates++;
  }
  return { date, enqueued, duplicates };
}

/** Deletes every tenant's runs dated before today minus the retention window. */
export async function cleanupOldRuns(
  db: Db,
  roster: Roster,
  now: Date,
): Promise<{ cutoff: string; deleted: number }> {
  const cutoff = utcDate(new Date(now.getTime() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000));
  let deleted = 0;
  for (const tenantId of await roster.tenantsWithRunsBefore(cutoff)) {
    deleted += await deleteRunsBefore(db.forTenant(tenantId), cutoff);
  }
  return { cutoff, deleted };
}

export interface DailyRunRegistration {
  llm?: StructuredLlm;
  queue?: SubmitQueue;
  roster?: Roster;
  http?: Http;
  now?: () => Date;
  adapters?: SourceAdapter[];
  /** Skip the cron schedules (tests). */
  schedule?: boolean;
}

/**
 * Registers the daily-run worker, the hourly scheduler tick and the nightly cleanup. The LLM
 * client is created on first run so a worker without an API key can still start.
 */
export async function registerDailyRun(
  boss: PgBoss,
  db: Db,
  options: DailyRunRegistration = {},
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const judgeCap = parseJudgeCap(process.env.JUDGE_CAP_PER_RUN);
  const roster = options.roster ?? dbRoster(db);
  const queue = options.queue ?? bossSubmitQueue(boss);
  let llm = options.llm;
  const deps = (adapters: SourceAdapter[] | undefined): DailyRunDeps => ({
    llm: (llm ??= createLlmClient()),
    queue,
    http: options.http,
    now,
    adapters,
    judgeCap,
  });

  await boss.createQueue(DAILY_RUN_JOB, { policy: 'exclusive' });
  await boss.createQueue(DAILY_RUN_TICK_JOB);
  await boss.createQueue(DAILY_RUN_CLEANUP_JOB);

  await boss.work<DailyRunJobData>(DAILY_RUN_JOB, async (jobs) => {
    for (const job of jobs) {
      const { tenantId, userId, date, trigger } = job.data;
      const handle = db.forTenant(tenantId);
      // The demo tenant searches only its seeded postings; an explicit adapter list wins (tests).
      const adapters = options.adapters ?? (await adaptersFor(handle));
      await executeDailyRun(
        handle,
        { userId, date, trigger: trigger ?? 'scheduled' },
        deps(adapters),
      );
    }
  });
  await boss.work(DAILY_RUN_TICK_JOB, async () => {
    await enqueueScheduledRuns(boss, roster, now());
  });
  await boss.work(DAILY_RUN_CLEANUP_JOB, async () => {
    await cleanupOldRuns(db, roster, now());
  });
  if (options.schedule !== false) {
    await boss.schedule(DAILY_RUN_TICK_JOB, '0 * * * *');
    await boss.schedule(DAILY_RUN_CLEANUP_JOB, '30 3 * * *');
  }
}
