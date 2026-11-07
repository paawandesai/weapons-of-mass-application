import { PgBoss } from 'pg-boss';
import {
  activity,
  DEFAULT_DATABASE_URL,
  getCompanyByBoard,
  getRun,
  getRunForDate,
  getUserById,
  getUserCompany,
  insertRun,
  listResolvedCompaniesByName,
  listRunCandidates,
  listUserCompanies,
  ProfileNotApprovedError,
  removeUserCompany,
  requireApprovedProfile,
  restoreUserCompany,
  transitionRun,
  updateRun,
  upsertCompany,
  upsertUserCompany,
  type CompanyRow,
  type RunCandidateRow,
  type RunRow,
  type TenantHandle,
} from '@wma/db';
import {
  boardPublicUrl,
  parseBoardUrl,
  resolveBoard,
  SUPPORTED_ATS_MESSAGE,
  type ResolveResult,
} from '@wma/discovery';

// ---------------------------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------------------------

export interface CompanyView {
  id: string;
  name: string;
  ats: string | null;
  board_slug: string | null;
  board_url: string | null;
  /** False when no supported board was found: the company is on the list but is not searched. */
  resolved: boolean;
  source: 'llm' | 'user' | 'hn';
  reason: string | null;
  added_at: string;
}

export type BoardResolver = (name: string) => Promise<ResolveResult>;
export const defaultResolver: BoardResolver = (name) => resolveBoard(name);

/** The user's active list; an unresolved name that a resolved board of the same name replaced is hidden. */
export async function listCompanyViews(
  handle: TenantHandle,
  userId: string,
): Promise<CompanyView[]> {
  const rows = await listUserCompanies(handle, userId);
  const resolvedNames = new Set(
    rows.filter((r) => r.company.ats).map((r) => r.company.name.toLowerCase()),
  );
  return rows
    .filter((r) => r.company.ats || !resolvedNames.has(r.company.name.toLowerCase()))
    .map(({ membership, company }) => ({
      id: company.id,
      name: company.name,
      ats: company.ats,
      board_slug: company.boardSlug,
      board_url: company.boardUrl,
      resolved: company.ats !== null,
      source: membership.source,
      reason: membership.reason,
      added_at: membership.addedAt.toISOString(),
    }));
}

export class CompanyAddError extends Error {
  constructor(
    readonly code: 'invalid_board_url' | 'unresolvable_company' | 'resolution_unavailable',
    message: string,
    readonly status: 400 | 503,
  ) {
    super(message);
  }
}

const titleCase = (slug: string) =>
  slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');

/** Companies for a request: by board URL (no network, no LLM) or by name (cache, then the ATS APIs). */
async function companiesFor(
  handle: TenantHandle,
  input: { name?: string; board_url?: string },
  resolve: BoardResolver,
): Promise<{ companies: CompanyRow[]; via: 'url' | 'name' }> {
  if (input.board_url) {
    const parsed = parseBoardUrl(input.board_url);
    if (!parsed) {
      throw new CompanyAddError(
        'invalid_board_url',
        `That is not a board URL on ${SUPPORTED_ATS_MESSAGE}.`,
        400,
      );
    }
    const known = await getCompanyByBoard(handle, parsed.ats, parsed.boardSlug, parsed.region);
    const company =
      known ??
      (await upsertCompany(handle, {
        name: titleCase(parsed.boardSlug),
        ats: parsed.ats,
        boardSlug: parsed.boardSlug,
        boardRegion: parsed.region,
        boardUrl: boardPublicUrl(parsed.ats, parsed.boardSlug, parsed.region),
        createdBy: 'user',
      }));
    return { companies: [company], via: 'url' };
  }
  const name = input.name!.trim();
  const cached = await listResolvedCompaniesByName(handle, name);
  if (cached.length) return { companies: cached, via: 'name' };
  const r = await resolve(name);
  if (r.status === 'resolved') {
    const companies: CompanyRow[] = [];
    for (const b of r.boards) {
      companies.push(
        await upsertCompany(handle, {
          name,
          ats: b.ats,
          boardSlug: b.boardSlug,
          boardRegion: b.region,
          boardUrl: b.boardUrl,
          resolvedAt: new Date(),
          createdBy: 'user',
        }),
      );
    }
    return { companies, via: 'name' };
  }
  if (r.status === 'unavailable') {
    throw new CompanyAddError(
      'resolution_unavailable',
      'We could not reach the job boards just now. Try again in a minute.',
      503,
    );
  }
  throw new CompanyAddError(
    'unresolvable_company',
    `We could not find a public job board for "${name}" on ${SUPPORTED_ATS_MESSAGE}. Paste the company's board link instead.`,
    400,
  );
}

/** Adds (or restores) a company on the user's list and records the user action. */
export async function addCompany(
  handle: TenantHandle,
  userId: string,
  input: { name?: string; board_url?: string },
  resolve: BoardResolver = defaultResolver,
): Promise<{ companies: CompanyView[]; added: boolean }> {
  const { companies, via } = await companiesFor(handle, input, resolve);
  let added = false;
  for (const company of companies) {
    const existing = await getUserCompany(handle, userId, company.id);
    if (existing?.removedAt) {
      await restoreUserCompany(handle, userId, company.id);
      added = true;
    } else if (!existing) {
      await upsertUserCompany(handle, { userId, companyId: company.id, source: 'user' });
      added = true;
    } else {
      continue;
    }
    await activity.logActivity(handle, {
      userId,
      actor: 'user',
      action: 'company_added',
      detail: {
        company_id: company.id,
        name: company.name,
        ats: company.ats,
        board_slug: company.boardSlug,
        via,
      },
    });
  }
  const ids = new Set(companies.map((c) => c.id));
  const views = (await listCompanyViews(handle, userId)).filter((v) => ids.has(v.id));
  return { companies: views, added };
}

/** Removes a company from the user's list; false when it is not on the list. */
export async function removeCompany(
  handle: TenantHandle,
  userId: string,
  companyId: string,
): Promise<boolean> {
  const existing = await getUserCompany(handle, userId, companyId);
  if (!existing || existing.removedAt) return false;
  await removeUserCompany(handle, userId, companyId);
  const name = (await listUserCompanies(handle, userId, { includeRemoved: true })).find(
    (r) => r.company.id === companyId,
  )?.company.name;
  await activity.logActivity(handle, {
    userId,
    actor: 'user',
    action: 'company_removed',
    detail: { company_id: companyId, name: name ?? null },
  });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

export const DAILY_RUN_JOB = 'daily-run';

export interface DailyRunRequest {
  tenantId: string;
  userId: string;
  date: string;
  trigger: 'manual';
}

/** Hands a manual run to the worker. Injected in tests. */
export interface RunQueue {
  /**
   * Resolves true when a job now exists for the run, false when pg-boss declined it (a job with
   * the same singleton key is still outstanding); rejects when the queue could not be reached.
   */
  enqueueDailyRun(data: DailyRunRequest): Promise<boolean>;
}

let boss: Promise<PgBoss> | null = null;
function getBoss(): Promise<PgBoss> {
  boss ??= (async () => {
    const b = new PgBoss({
      connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
      supervise: false,
      schedule: false,
    });
    b.on('error', (err) => console.error('pg-boss error', err));
    await b.start();
    await b.createQueue(DAILY_RUN_JOB, { policy: 'exclusive' });
    return b;
  })();
  boss.catch(() => {
    boss = null;
  });
  return boss;
}

export const pgBossRunQueue: RunQueue = {
  async enqueueDailyRun(data) {
    const b = await getBoss();
    const id = await b.send(DAILY_RUN_JOB, data, {
      singletonKey: `daily-run:${data.userId}:${data.date}`,
      retryLimit: 0,
    });
    return id !== null;
  },
};

export interface CandidateView {
  rank: number | null;
  title: string;
  company: string;
  url: string;
  ats: string | null;
  /** Null when the posting could not be judged. */
  apply: boolean | null;
  rationale: string | null;
  selected: boolean;
  exclusion_reason: string | null;
  pay_min: number | null;
  pay_max: number | null;
  currency: string | null;
  location_mode: string | null;
  seniority: string | null;
  application_deadline: string | null;
  prompt_version: string | null;
  model: string | null;
}

export interface RunView {
  id: string;
  date: string;
  trigger: string;
  status: string;
  step: string | null;
  target: number;
  started_at: string;
  ended_at: string | null;
  source_status: unknown;
  counts: unknown;
  short_day: boolean;
  shortfall: number;
  error: string | null;
}

type JudgmentJson = Partial<
  Record<
    | 'apply'
    | 'rationale'
    | 'pay_min'
    | 'pay_max'
    | 'currency'
    | 'location_mode'
    | 'seniority'
    | 'application_deadline',
    unknown
  >
>;

/** `fit` is an internal ordering hint: this view is built field by field so it can never leak. */
export function toCandidateView(c: RunCandidateRow): CandidateView {
  const j = (c.judgment ?? {}) as JudgmentJson;
  const pick = <T>(v: unknown): T | null => (v === undefined ? null : (v as T));
  return {
    rank: c.rank,
    title: c.title,
    company: c.companyName,
    url: c.url,
    ats: c.ats,
    apply: pick<boolean>(j.apply),
    rationale: pick<string>(j.rationale),
    selected: c.selected,
    exclusion_reason: c.exclusionReason,
    pay_min: pick<number>(j.pay_min),
    pay_max: pick<number>(j.pay_max),
    currency: pick<string>(j.currency),
    location_mode: pick<string>(j.location_mode),
    seniority: pick<string>(j.seniority),
    application_deadline: pick<string>(j.application_deadline),
    prompt_version: c.promptVersion,
    model: c.model,
  };
}

export function toRunView(r: RunRow): RunView {
  return {
    id: r.id,
    date: r.date,
    trigger: r.trigger,
    status: r.status,
    step: r.step,
    target: r.targetN,
    started_at: r.startedAt.toISOString(),
    ended_at: r.endedAt ? r.endedAt.toISOString() : null,
    source_status: r.sourceStatus,
    counts: r.counts,
    short_day: r.shortDay,
    shortfall: r.shortfall,
    error: r.error,
  };
}

export async function runResponse(handle: TenantHandle, run: RunRow) {
  const candidates = await listRunCandidates(handle, run.id);
  return { run: toRunView(run), candidates: candidates.map(toCandidateView) };
}

const QUEUED_STEP = 'queued';

export type RequestRunResult =
  /** `queued` is true when this call handed the run to the worker (new run or retried dispatch). */
  { run: RunRow; created: boolean; queued: boolean };

/**
 * Sends a queued run to the worker and records the outcome on the row: `dispatched` when pg-boss
 * accepted it, `failed` when sending threw or pg-boss declined (a job for the same key is still
 * outstanding). A `failed` run is retried by the next trigger, so the day never stays reserved
 * without executable work.
 */
async function dispatchRun(
  handle: TenantHandle,
  run: RunRow,
  queue: RunQueue,
  request: DailyRunRequest,
): Promise<RunRow> {
  let accepted = false;
  try {
    accepted = await queue.enqueueDailyRun(request);
  } catch {
    accepted = false;
  }
  const dispatchState = accepted ? 'dispatched' : 'failed';
  // Compare-and-set: the worker may already have claimed the row and moved it on.
  const updated = await transitionRun(
    handle,
    run.id,
    { status: 'running', step: QUEUED_STEP },
    { dispatchState },
  );
  return updated ?? (await getRun(handle, run.id)) ?? run;
}

/**
 * Manual trigger. A run already on record for today's date is returned as is (one non-failed run
 * per user per day) unless it is a queued run whose dispatch failed, which is dispatched again.
 * An unapproved profile ends the run at once as `skipped_no_profile`; a later trigger, after
 * approval, takes that row over with a compare-and-set (a worker that got there first wins and its
 * run is returned). Otherwise the run is queued for the worker.
 */
export async function requestRun(
  handle: TenantHandle,
  userId: string,
  queue: RunQueue,
  now: Date,
): Promise<RequestRunResult> {
  const date = now.toISOString().slice(0, 10);
  const user = await getUserById(handle, userId);
  const request: DailyRunRequest = { tenantId: handle.tenantId, userId, date, trigger: 'manual' };

  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await getRunForDate(handle, userId, date);

    if (existing && existing.status !== 'skipped_no_profile') {
      const retryable =
        existing.status === 'running' &&
        existing.step === QUEUED_STEP &&
        (existing.dispatchState === 'failed' || existing.dispatchState === null);
      if (!retryable) return { run: existing, created: false, queued: false };
      // Whoever flips failed/null back to queued owns the re-dispatch.
      const claimed = await transitionRun(
        handle,
        existing.id,
        { status: 'running', step: QUEUED_STEP, dispatchState: ['failed', null] },
        { dispatchState: 'queued' },
      );
      if (!claimed) continue;
      const run = await dispatchRun(handle, claimed, queue, request);
      return { run, created: false, queued: run.dispatchState === 'dispatched' };
    }

    let approved = true;
    try {
      await requireApprovedProfile(handle, userId);
    } catch (e) {
      if (!(e instanceof ProfileNotApprovedError)) throw e;
      approved = false;
    }
    if (!approved) {
      if (existing) return { run: existing, created: false, queued: false };
      const { run, created } = await insertRun(handle, {
        userId,
        date,
        trigger: 'manual',
        targetN: user.dailyTarget,
        status: 'skipped_no_profile',
      });
      if (!created) return { run, created: false, queued: false };
      await updateRun(handle, run.id, { endedAt: now });
      await activity.logActivity(handle, {
        userId,
        actor: 'agent',
        action: 'profile_not_approved',
        detail: { job: 'daily-run' },
      });
      return { run: (await getRun(handle, run.id))!, created: true, queued: false };
    }

    let run: RunRow;
    if (existing) {
      // Skipped earlier, approved now. The row must still be skipped for the takeover to apply.
      const claimed = await transitionRun(
        handle,
        existing.id,
        { status: 'skipped_no_profile' },
        {
          status: 'running',
          step: QUEUED_STEP,
          endedAt: null,
          error: null,
          targetN: user.dailyTarget,
          dispatchState: 'queued',
        },
      );
      if (!claimed) continue; // someone else moved it: re-read and return the winner
      run = claimed;
    } else {
      const inserted = await insertRun(handle, {
        userId,
        date,
        trigger: 'manual',
        targetN: user.dailyTarget,
        step: QUEUED_STEP,
        dispatchState: 'queued',
      });
      if (!inserted.created) continue;
      run = inserted.run;
    }
    const dispatched = await dispatchRun(handle, run, queue, request);
    return { run: dispatched, created: true, queued: dispatched.dispatchState === 'dispatched' };
  }
  const run = await getRunForDate(handle, userId, date);
  if (!run) throw new Error('could not settle a run for the date');
  return { run, created: false, queued: false };
}
