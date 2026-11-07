import { dedupeKey } from '@wma/shared';
import type { Judged } from './judge';

export type Ranked = Judged & { rank: number };

export interface RankResult {
  ranked: Ranked[];
  excluded: Array<{ item: Judged; reason: 'deadline_passed' }>;
}

const postedMs = (j: Judged) => {
  const t = j.candidate.postedAt ? Date.parse(j.candidate.postedAt) : NaN;
  return Number.isNaN(t) ? null : t;
};

/**
 * Orders approved candidates: fit desc, then deadline asc (none last), then posted date desc (none
 * last), then dedupe key asc. A deadline before `today` (date-only, UTC) excludes the candidate.
 */
export function rank(approved: readonly Judged[], today: string): RankResult {
  const excluded: RankResult['excluded'] = [];
  const live: Judged[] = [];
  for (const j of approved) {
    if (!j.judgment.apply) continue;
    const d = j.judgment.application_deadline;
    if (d && d < today) excluded.push({ item: j, reason: 'deadline_passed' });
    else live.push(j);
  }
  live.sort((a, b) => {
    if (a.judgment.fit !== b.judgment.fit) return b.judgment.fit - a.judgment.fit;
    const da = a.judgment.application_deadline;
    const db = b.judgment.application_deadline;
    if (da !== db) {
      if (da === null) return 1;
      if (db === null) return -1;
      return da < db ? -1 : 1;
    }
    const pa = postedMs(a);
    const pb = postedMs(b);
    if (pa !== pb) {
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pb - pa;
    }
    const ka = dedupeKey(a.candidate);
    const kb = dedupeKey(b.candidate);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return { ranked: live.map((j, i) => ({ ...j, rank: i + 1 })), excluded };
}

/** The first min(target, approved) of the ranked list. */
export function selectTopN<T>(ranked: readonly T[], target: number): T[] {
  return ranked.slice(0, Math.max(0, Math.min(target, ranked.length)));
}
