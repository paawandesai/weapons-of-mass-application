import {
  activity,
  getCurrentTenant,
  getUserById,
  insertRun,
  insertRunCandidates,
  listUserCompanies,
  transitionRun,
  unselectRunCandidates,
  updateRun,
  type RunCandidateInput,
  type RunRow,
  type TenantHandle,
} from '@wma/db';
import type { StructuredLlm } from '@wma/llm';
import { dedupeKey } from '@wma/shared';
import { guardedJob } from '../guarded';
import { dropAlreadyApplied } from './applied';
import { generateCompanyList } from './company-list';
import { discover } from './discover';
import { handOff, type SubmitQueue } from './handoff';
import { sharedHttp, type Http } from '@wma/discovery';
import { judgeAll, type Judged, type JudgeResult } from './judge';
import { loadProfileDocument } from './profile-view';
import {
  rank,
  relevanceScore,
  selectWithCompanyCap,
  DEFAULT_MAX_PER_COMPANY,
  type RelevanceProfile,
} from './rank';
import type { BoardRef, RemovedCompany, SourceAdapter } from './types';
import type { Candidate } from '@wma/shared';

/** Runs left in `running` longer than this belong to a dead worker and are replaced. */
export const STALE_RUN_MS = 60 * 60 * 1000;
export const QUEUED_STEP = 'queued';

export const RUN_STEPS = [
  'start',
  'companies',
  'fetch',
  'dedupe',
  'judge',
  'rank',
  'hand_off',
  'finalize',
] as const;
export type RunStep = (typeof RUN_STEPS)[number];

export interface DailyRunDeps {
  llm: StructuredLlm;
  queue: SubmitQueue;
  http?: Http;
  now?: () => Date;
  adapters?: SourceAdapter[];
  judgeConcurrency?: number;
  /** Most postings one run judges (`JUDGE_CAP_PER_RUN`). */
  judgeCap?: number;
  /** Most selections per company in one run (`MAX_PER_COMPANY_PER_RUN`, default 1). */
  maxPerCompany?: number;
}

export const DEFAULT_JUDGE_CAP = 120;

/**
 * The postings a run may judge: seeded source first (the seeded adapter reports candidates under the
 * form's vendor, so the caller says which are seeded), then local relevance score descending, then
 * newest `postedAt` first (undated last), ties in the order the sources returned them. The first
 * `cap` are kept. `prefilterZero` counts kept postings whose score is 0.
 */
export function applyJudgeCap(
  candidates: Candidate[],
  cap: number,
  isSeeded: (c: Candidate) => boolean = () => false,
  profile?: RelevanceProfile,
): { kept: Candidate[]; dropped: number; prefilterZero: number } {
  const time = (c: Candidate) => (c.postedAt ? new Date(c.postedAt).getTime() : Number.NaN);
  const scored = candidates.map((c, i) => ({
    c,
    i,
    seeded: isSeeded(c),
    score: profile ? relevanceScore(c, profile) : 0,
  }));
  scored.sort((a, b) => {
    if (a.seeded !== b.seeded) return a.seeded ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    const ta = time(a.c);
    const tb = time(b.c);
    const na = Number.isNaN(ta);
    const nb = Number.isNaN(tb);
    if (na !== nb) return na ? 1 : -1;
    if (!na && ta !== tb) return tb - ta;
    return a.i - b.i;
  });
  const kept = scored.slice(0, cap);
  return {
    kept: kept.map((k) => k.c),
    dropped: Math.max(0, scored.length - cap),
    prefilterZero: kept.filter((k) => k.score === 0).length,
  };
}

export interface RunParams {
  userId: string;
  /** Run date, `YYYY-MM-DD` (UTC). */
  date: string;
  trigger: 'scheduled' | 'manual';
}

export type RunOutcome =
  | { ran: true; runId: string; status: RunRow['status'] }
  /** A run for the date already exists (finished, running, ...); nothing was started. */
  | { ran: false; runId: string; reason: 'run_exists' };

export interface RunCounts {
  fetched: number;
  in_run_duplicates: number;
  deduped: number;
  already_applied: number;
  judged: number;
  skipped: number;
  approved: number;
  unjudged: number;
  /** Postings beyond the per-run judge cap: not judged, no `run_candidates` row. */
  over_cap: number;
  deadline_passed: number;
  selected: number;
  over_target: number;
  /** Approved postings skipped because their company already had the per-run maximum selected. */
  company_cap: number;
  /** Judged postings whose local relevance score was 0 (visibility only). */
  prefilter_zero: number;
  /** HN and LinkedIn postings dropped because the user removed the company (not in `fetched`). */
  removed_company: number;
  /** Selected postings another run had already turned into applications. */
  hand_off_conflicts: number;
  requeued: number;
}

const emptyCounts = (): RunCounts => ({
  fetched: 0,
  in_run_duplicates: 0,
  deduped: 0,
  already_applied: 0,
  judged: 0,
  skipped: 0,
  approved: 0,
  unjudged: 0,
  over_cap: 0,
  deadline_passed: 0,
  selected: 0,
  over_target: 0,
  company_cap: 0,
  prefilter_zero: 0,
  removed_company: 0,
  hand_off_conflicts: 0,
  requeued: 0,
});

/**
 * Claims the (user, date) slot. A run that was only queued by the API, one skipped for a missing
 * profile (the profile may be approved now), or one stranded `running` by a dead worker is taken
 * over; any other existing run wins and nothing starts. Every takeover is a compare-and-set on the
 * row's current state, so when two actors race exactly one wins and the other sees the winner.
 */
async function claimRun(
  handle: TenantHandle,
  p: RunParams,
  targetN: number,
  now: Date,
): Promise<RunRow | { existing: RunRow }> {
  const takeoverPatch = {
    status: 'running' as const,
    step: 'start',
    endedAt: null,
    error: null,
    targetN,
    counts: {},
    sourceStatus: {},
    shortDay: false,
    shortfall: 0,
    dispatchState: 'dispatched' as const,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const { run, created } = await insertRun(handle, {
      userId: p.userId,
      date: p.date,
      trigger: p.trigger,
      targetN,
      step: 'start',
      dispatchState: 'dispatched',
    });
    if (created) return run;
    const stranded =
      run.status === 'running' &&
      run.step !== QUEUED_STEP &&
      now.getTime() - run.startedAt.getTime() > STALE_RUN_MS;
    if (stranded) {
      await transitionRun(
        handle,
        run.id,
        { status: 'running', step: run.step },
        {
          status: 'failed',
          endedAt: now,
          error: 'run abandoned: the worker stopped before it finished',
        },
      );
      continue; // the date is free again (or someone else moved the row): look again
    }
    let claimed: RunRow | null = null;
    if (run.status === 'skipped_no_profile') {
      claimed = await transitionRun(
        handle,
        run.id,
        { status: 'skipped_no_profile' },
        takeoverPatch,
      );
    } else if (run.status === 'running' && run.step === QUEUED_STEP) {
      claimed = await transitionRun(
        handle,
        run.id,
        { status: 'running', step: QUEUED_STEP },
        takeoverPatch,
      );
    } else {
      return { existing: run };
    }
    if (claimed) return claimed;
    // Lost the race: the winner's row decides (the loop re-reads it).
  }
  const { run } = await insertRun(handle, { userId: p.userId, date: p.date, targetN });
  return { existing: run };
}

/** The whole daily run for one user (design D9). Never throws for run-level failures. */
export async function executeDailyRun(
  handle: TenantHandle,
  p: RunParams,
  deps: DailyRunDeps,
): Promise<RunOutcome> {
  const now = deps.now ?? (() => new Date());
  const { userId } = p;
  const user = await getUserById(handle, userId);
  const target = user.dailyTarget;

  const claimed = await claimRun(handle, p, target, now());
  if ('existing' in claimed) {
    await activity.logActivity(handle, {
      userId,
      actor: 'agent',
      action: 'run_skipped',
      detail: {
        date: p.date,
        reason: 'run_exists',
        run_id: claimed.existing.id,
        status: claimed.existing.status,
      },
    });
    return { ran: false, runId: claimed.existing.id, reason: 'run_exists' };
  }
  const run = claimed;
  await activity.logActivity(handle, {
    userId,
    actor: 'agent',
    action: 'run_started',
    detail: { run_id: run.id, date: p.date, trigger: p.trigger, target },
  });

  let step: RunStep = 'start';
  const setStep = async (s: RunStep, patch: Parameters<typeof updateRun>[2] = {}) => {
    step = s;
    await updateRun(handle, run.id, { step: s, ...patch });
  };
  const counts = emptyCounts();

  try {
    const gated = await guardedJob('daily-run', async ({ approvedVersion }) => {
      const profile = await loadProfileDocument(handle, userId, approvedVersion);

      const isDemo = (await getCurrentTenant(handle)).demo;

      await setStep('companies');
      if (isDemo) {
        // The seeded companies are the demo's company list; nothing is generated.
        await activity.logActivity(handle, {
          userId,
          actor: 'agent',
          action: 'company_list_skipped',
          detail: { reason: 'demo_tenant' },
        });
      } else if ((await listUserCompanies(handle, userId, { includeRemoved: true })).length === 0) {
        try {
          await generateCompanyList(handle, userId, { llm: deps.llm, http: deps.http, now });
        } catch {
          // The sweep continues with HN and LinkedIn; the activity log already says why if it matters.
        }
      }
      const boards: BoardRef[] = (await listUserCompanies(handle, userId)).flatMap(({ company }) =>
        company.ats && company.boardSlug
          ? [
              {
                companyId: company.id,
                companyName: company.name,
                ats: company.ats,
                boardSlug: company.boardSlug,
                region: (company.boardRegion === 'eu' ? 'eu' : '') as BoardRef['region'],
              },
            ]
          : [],
      );
      const removed: RemovedCompany[] = (
        await listUserCompanies(handle, userId, { includeRemoved: true })
      )
        .filter((r) => r.membership.removedAt)
        .map(({ company }) => ({
          name: company.name,
          ats: company.ats,
          boardSlug: company.boardSlug,
          region: company.boardRegion,
        }));

      await setStep('fetch');
      const found = await discover({
        boards,
        profile,
        http: deps.http ?? sharedHttp(),
        now: now(),
        adapters: deps.adapters,
        removed,
      });
      counts.removed_company = found.removedCompany;
      counts.fetched = found.fetched;
      counts.in_run_duplicates = found.inRunDuplicates;
      counts.deduped = found.candidates.length;
      await updateRun(handle, run.id, { sourceStatus: found.sourceStatus, counts });

      await setStep('dedupe');
      const { kept, dropped } = await dropAlreadyApplied(handle, userId, found.candidates);
      counts.already_applied = dropped.length;

      const cap = deps.judgeCap ?? DEFAULT_JUDGE_CAP;
      const capped = applyJudgeCap(kept, cap, (c) => found.seededKeys.has(dedupeKey(c)), profile);
      counts.over_cap = capped.dropped;
      counts.prefilter_zero = capped.prefilterZero;
      if (capped.dropped > 0) {
        await activity.logActivity(handle, {
          userId,
          actor: 'agent',
          action: 'judge_capped',
          detail: { run_id: run.id, cap, dropped: capped.dropped },
        });
      }

      await setStep('judge', { counts });
      const results: JudgeResult[] = await judgeAll(
        capped.kept,
        { llm: deps.llm, profile, today: p.date },
        deps.judgeConcurrency,
      );
      const judged = results.filter((r): r is Judged => r.status === 'judged');
      counts.unjudged = results.length - judged.length;
      counts.judged = judged.length;

      await setStep('rank');
      const approved = judged.filter((j) => j.judgment.apply);
      counts.skipped = judged.length - approved.length;
      counts.approved = approved.length;
      const { ranked, excluded } = rank(approved, p.date);
      counts.deadline_passed = excluded.length;
      const { selected, skipped } = selectWithCompanyCap(
        ranked,
        target,
        deps.maxPerCompany ?? DEFAULT_MAX_PER_COMPANY,
      );
      counts.selected = selected.length;
      counts.company_cap = skipped.length;
      counts.over_target = ranked.length - selected.length - skipped.length;
      const companyCapKeys = new Set(skipped.map((s) => dedupeKey(s.candidate)));
      const selectedKeys = new Set(selected.map((s) => dedupeKey(s.candidate)));
      const rankByKey = new Map(ranked.map((r) => [dedupeKey(r.candidate), r.rank]));
      const excludedKeys = new Set(excluded.map((e) => dedupeKey(e.item.candidate)));

      const rows: RunCandidateInput[] = results.map((r) => {
        const key = dedupeKey(r.candidate);
        const base = {
          title: r.candidate.title,
          companyName: r.candidate.companyName,
          url: r.candidate.url,
          ats: r.candidate.ats,
          atsJobId: r.candidate.atsJobId,
          promptVersion: r.promptVersion,
          model: r.model,
        };
        if (r.status === 'unjudged') return { ...base, exclusionReason: 'unjudged' };
        const rk = rankByKey.get(key) ?? null;
        const isSelected = selectedKeys.has(key);
        const exclusionReason = isSelected
          ? null
          : companyCapKeys.has(key)
            ? 'company_cap'
            : rk !== null
              ? 'over_target'
              : excludedKeys.has(key)
                ? 'deadline_passed'
                : 'not_approved';
        return { ...base, judgment: r.judgment, rank: rk, selected: isSelected, exclusionReason };
      });
      const stored = await insertRunCandidates(handle, run.id, rows);
      const rowIdByKey = new Map(
        stored.map((row) => [
          dedupeKey({ ats: row.ats, atsJobId: row.atsJobId, url: row.url }),
          row.id,
        ]),
      );

      await setStep('hand_off', { counts });
      const handed = await handOff(
        handle,
        { userId, runId: run.id, runDate: p.date, selected },
        deps.queue,
      );
      counts.requeued = handed.requeued.length;
      // Postings another run claimed first are not this run's selections: clear their flag so the
      // stored selection, the stored applications and `counts.selected` all agree.
      counts.hand_off_conflicts = handed.conflicts.length;
      await unselectRunCandidates(
        handle,
        run.id,
        handed.conflicts.flatMap((k) => rowIdByKey.get(k) ?? []),
        'already_applied',
      );
      counts.selected = handed.created.length;

      await setStep('finalize');
      const shortDay = counts.selected < target;
      const status = shortDay ? 'short_day' : 'finished';
      await updateRun(handle, run.id, {
        status,
        step: 'finalize',
        endedAt: now(),
        counts,
        shortDay,
        shortfall: Math.max(0, target - counts.selected),
      });
      return status;
    })({ handle, userId });

    if (!gated.ran) {
      await updateRun(handle, run.id, {
        status: 'skipped_no_profile',
        step: 'start',
        endedAt: now(),
      });
      await activity.logActivity(handle, {
        userId,
        actor: 'agent',
        action: 'run_finished',
        detail: { run_id: run.id, status: 'skipped_no_profile', counts },
      });
      return { ran: true, runId: run.id, status: 'skipped_no_profile' };
    }
    await activity.logActivity(handle, {
      userId,
      actor: 'agent',
      action: 'run_finished',
      detail: { run_id: run.id, status: gated.result, counts },
    });
    return { ran: true, runId: run.id, status: gated.result };
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await updateRun(handle, run.id, {
      status: 'failed',
      step,
      endedAt: now(),
      error: message,
      counts,
    });
    await activity.logActivity(handle, {
      userId,
      actor: 'agent',
      action: 'run_failed',
      detail: { run_id: run.id, step, error: message },
    });
    return { ran: true, runId: run.id, status: 'failed' };
  }
}
