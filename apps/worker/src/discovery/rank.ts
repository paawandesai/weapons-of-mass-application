import { dedupeKey, type Candidate } from '@wma/shared';
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

export const DEFAULT_MAX_PER_COMPANY = 1;

/** The company a candidate counts against: `companyId`, else the normalised `companyName`. */
export function companyKey(c: Pick<Candidate, 'companyId' | 'companyName'>): string {
  if (c.companyId) return `id:${c.companyId}`;
  return `name:${c.companyName
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()}`;
}

/**
 * Walks the ranked list taking candidates until `target` are selected, skipping one whose company
 * already has `cap` selections. Skipped candidates are returned (in rank order) for the run view.
 */
export function selectWithCompanyCap<T extends { candidate: Candidate }>(
  ranked: readonly T[],
  target: number,
  cap: number = DEFAULT_MAX_PER_COMPANY,
  /**
   * Selections already made earlier in the same run, by `companyKey`. Updated in place, so a run
   * that judges in batches keeps one company cap across all of them.
   */
  perCompany: Map<string, number> = new Map(),
): { selected: T[]; skipped: T[] } {
  const selected: T[] = [];
  const skipped: T[] = [];
  const limit = Math.max(0, target);
  for (const item of ranked) {
    if (selected.length >= limit) break;
    const key = companyKey(item.candidate);
    const n = perCompany.get(key) ?? 0;
    if (n >= cap) {
      skipped.push(item);
      continue;
    }
    perCompany.set(key, n + 1);
    selected.push(item);
  }
  return { selected, skipped };
}

const STOP_WORDS = new Set([
  'engineer',
  'senior',
  'staff',
  'lead',
  'principal',
  'software',
  'the',
  'and',
  'of',
]);
const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Two-letter terms that carry a title's meaning ("AI Engineer", "ML Engineer"). Without them
 * "AI Engineer" would reduce to the stop word "engineer" and match every engineering posting.
 */
const SHORT_TERMS = new Set(['ai', 'ml', 'qa', 'ux', 'ui', 'ar', 'vr', 'bi']);

/**
 * Title words that count as a significant word of the target. "AI" in a target also matches a
 * posting titled with ML, LLM, GenAI, agents or "Machine Learning"; the reverse holds for "ML".
 */
const ALIASES: Record<string, readonly string[]> = {
  ai: ['ai', 'ml', 'llm', 'llms', 'genai', 'agent', 'agents', 'agentic', 'machine learning'],
  ml: ['ml', 'ai', 'machine learning'],
};

/** Titles above an early-career level, or not individual-contributor roles. */
const SENIORITY_WORDS = new Set([
  'senior',
  'sr',
  'staff',
  'principal',
  'lead',
  'manager',
  'director',
  'head',
  'vp',
  'distinguished',
]);
/** Points a senior title loses when no target title is itself senior (larger than any title match). */
export const SENIORITY_PENALTY = 6;

/** True when `word` (or one of its aliases) appears in the posting title. */
function titleHas(word: string, titleWords: Set<string>, titleText: string): boolean {
  const alts = ALIASES[word] ?? [word];
  return alts.some((a) => (a.includes(' ') ? titleText.includes(` ${a} `) : titleWords.has(a)));
}

/**
 * The words of a target title that carry meaning: length >= 3 (or a known two-letter term such as
 * "ai"), minus stop words. A title made only of stop words ("Staff Software Engineer") would
 * otherwise match every posting or none, so it falls back to all its words of length >= 3.
 */
export function significantWords(title: string): string[] {
  const long = words(title).filter((w) => w.length >= 3 || SHORT_TERMS.has(w));
  const sig = long.filter((w) => !STOP_WORDS.has(w));
  return [...new Set(sig.length > 0 ? sig : long.filter((w) => w.length >= 3))];
}

/** True when the title names a level above early career (Senior, Staff, Lead, Manager, ...). */
export function isSeniorTitle(title: string): boolean {
  return words(title).some((w) => SENIORITY_WORDS.has(w));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The profile parts the local relevance score reads. */
export interface RelevanceProfile {
  preferences: { target_titles: readonly string[] };
  survey: { target_roles: readonly string[] };
  skills: ReadonlyArray<{ name: string }>;
}

/**
 * Local, model-free relevance of a posting to the profile (wave 5 rule 17): +3 per target title or
 * role whose significant words all appear in the posting title, +1 per such word in the title, +1
 * per profile skill named in the title or the first 2,000 characters of the description (max +5),
 * and -SENIORITY_PENALTY for a senior title when none of the targets is senior.
 */
export function relevanceScore(c: Candidate, profile: RelevanceProfile): number {
  const titleWords = new Set(words(c.title));
  const titleText = ` ${words(c.title).join(' ')} `;
  // One entry per semantic target: the same token normalisation as matching, so case and
  // punctuation differences between preferences and survey do not score a target twice.
  const targets = new Map<string, string>();
  for (const raw of [...profile.preferences.target_titles, ...profile.survey.target_roles]) {
    const t = raw.trim();
    if (!t) continue;
    const key = words(t).join(' ') || t.toLowerCase();
    if (!targets.has(key)) targets.set(key, t);
  }
  let score = 0;
  for (const t of targets.values()) {
    const sig = significantWords(t);
    if (sig.length === 0) continue;
    if (sig.every((w) => titleHas(w, titleWords, titleText))) score += 3;
    score += sig.filter((w) => titleHas(w, titleWords, titleText)).length;
  }
  // A senior title is judged last for a person whose own targets are not senior: those postings
  // are almost always skipped for seniority and would crowd out the ones worth judging.
  const targetsSenior = [...targets.values()].some(isSeniorTitle);
  if (!targetsSenior && targets.size > 0 && isSeniorTitle(c.title)) score -= SENIORITY_PENALTY;
  const haystack = `${c.title}\n${(c.description ?? '').slice(0, 2000)}`.toLowerCase();
  let skills = 0;
  for (const s of new Set(profile.skills.map((k) => k.name.trim().toLowerCase()).filter(Boolean))) {
    if (new RegExp(`(?<![a-z0-9])${escapeRe(s)}(?![a-z0-9])`).test(haystack)) skills++;
  }
  return score + Math.min(5, skills);
}
