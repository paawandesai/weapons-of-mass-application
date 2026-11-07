import { dedupeKey, parseAtsJobUrl, type Candidate, type ProfileDocument } from '@wma/shared';
import { defaultAdapters } from './adapters';
import { nameWords, sharedHttp, type Http } from '@wma/discovery';
import type {
  BoardRef,
  RemovedCompany,
  SourceAdapter,
  SourceResult,
  SourceStatusEntry,
} from './types';

export interface DiscoverDeps {
  boards: BoardRef[];
  profile: ProfileDocument;
  http?: Http;
  now?: Date;
  adapters?: SourceAdapter[];
  /** Companies the user removed; HN and LinkedIn postings from them are dropped. */
  removed?: RemovedCompany[];
}

export interface DiscoverResult {
  /** Unique candidates; the board (ATS API) version wins over HN and LinkedIn. */
  candidates: Candidate[];
  sourceStatus: Record<string, SourceStatusEntry>;
  /** Candidates returned by all sources before in-run dedupe. */
  fetched: number;
  inRunDuplicates: number;
  /** HN and LinkedIn postings dropped because the user removed the company. Not part of `fetched`. */
  removedCompany: number;
}

const isBoardSource = (c: Candidate) =>
  c.source === 'ashby' || c.source === 'greenhouse' || c.source === 'lever';

const normName = (name: string) => nameWords(name).join(' ');
const boardKey = (ats: string, slug: string, region: string) => `${ats}:${slug}:${region}`;

/**
 * True for a posting that belongs to a removed company: its link points at the removed company's
 * board (resolved slug and region) or its company name matches a removed name after normalization.
 */
export function removedMatcher(removed: readonly RemovedCompany[]): (c: Candidate) => boolean {
  const names = new Set(removed.map((r) => normName(r.name)).filter(Boolean));
  const boards = new Set(
    removed.flatMap((r) => (r.ats && r.boardSlug ? [boardKey(r.ats, r.boardSlug, r.region)] : [])),
  );
  return (c) => {
    const ref = parseAtsJobUrl(c.url);
    if (ref && boards.has(boardKey(ref.ats, ref.boardSlug, ref.region))) return true;
    return names.has(normName(c.companyName));
  };
}

/**
 * Runs every adapter independently (an adapter failure is a status, never an abort) and collapses
 * candidates that share a dedupe key, keeping the board candidate over HN or LinkedIn.
 */
export async function discover(deps: DiscoverDeps): Promise<DiscoverResult> {
  const ctx = {
    http: deps.http ?? sharedHttp(),
    boards: deps.boards,
    profile: deps.profile,
    now: deps.now ?? new Date(),
  };
  const adapters = deps.adapters ?? defaultAdapters();
  const results = await Promise.all(
    adapters.map(async (a): Promise<[string, SourceResult]> => {
      try {
        return [a.id, await a.fetch(ctx)];
      } catch {
        return [a.id, { status: 'unavailable', candidates: [], detail: 'adapter failed' }];
      }
    }),
  );

  const isRemoved = removedMatcher(deps.removed ?? []);
  let removedCompany = 0;
  const sourceStatus: Record<string, SourceStatusEntry> = {};
  const unique = new Map<string, Candidate>();
  let fetched = 0;
  for (const [id, r] of results) {
    const all = r.candidates;
    const kept = all.filter((c) => isBoardSource(c) || !isRemoved(c));
    removedCompany += all.length - kept.length;
    sourceStatus[id] = {
      status: r.status,
      candidates: kept.length,
      ...(r.detail ? { detail: r.detail } : {}),
      ...(r.failedBoards?.length ? { failed_boards: r.failedBoards } : {}),
    };
    fetched += kept.length;
    for (const c of kept) {
      const key = dedupeKey(c);
      const have = unique.get(key);
      if (!have || (isBoardSource(c) && !isBoardSource(have)))
        unique.set(key, withCompanyId(c, deps.boards));
    }
  }
  return {
    candidates: [...unique.values()],
    sourceStatus,
    fetched,
    inRunDuplicates: fetched - unique.size,
    removedCompany,
  };
}

/** HN and LinkedIn candidates learn their company id when the link points at a board on the list. */
function withCompanyId(c: Candidate, boards: BoardRef[]): Candidate {
  if (c.companyId) return c;
  const ref = parseAtsJobUrl(c.url);
  const board =
    ref &&
    boards.find(
      (b) => b.ats === ref.ats && b.boardSlug === ref.boardSlug && b.region === ref.region,
    );
  return board ? { ...c, companyId: board.companyId } : c;
}
