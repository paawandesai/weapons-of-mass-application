import type { ProfileDocument } from '@wma/shared';
import type { ResumeFacts, TailoredResume } from './schema';

const SUFFIXES = new Set(['inc', 'llc', 'ltd', 'corp', 'co', 'gmbh']);

/** Rule 6 normalization: lowercase, strip accents and punctuation, drop trailing legal suffixes. */
export function normalizeName(s: string): string {
  const words = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1] as string)) words.pop();
  return words.join(' ');
}

export interface ParsedDate {
  year: number;
  month: number | null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const YEAR_MIN = 1950;
const YEAR_MAX = 2100;

const validYear = (y: number) => y >= YEAR_MIN && y <= YEAR_MAX;
const validMonth = (m: number) => m >= 1 && m <= 12;

/**
 * 'present' for an open end, a date, null when nothing was stated, or 'invalid' when a nonempty
 * string is not a supported date (`YYYY-MM`, `YYYY`, `Mon YYYY`, `MM/YYYY`) or has an impossible
 * month or year. The caller fails closed on 'invalid'.
 */
export function parseDate(
  raw: string | null | undefined,
): ParsedDate | 'present' | 'invalid' | null {
  if (raw == null) return null;
  const s = raw.trim().toLowerCase();
  if (s === '') return null;
  if (/^(present|current|now|ongoing|today|to date)$/.test(s)) return 'present';
  const make = (year: number, month: number | null): ParsedDate | 'invalid' =>
    validYear(year) && (month === null || validMonth(month)) ? { year, month } : 'invalid';
  let m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) return make(Number(m[1]), Number(m[2]));
  m = /^(\d{4})$/.exec(s);
  if (m) return make(Number(m[1]), null);
  m = /^([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const idx = MONTHS.indexOf(m[1] as string);
    if (idx >= 0) return make(Number(m[2]), idx + 1);
  }
  m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return make(Number(m[2]), Number(m[1]));
  return 'invalid';
}

/** Negative when a is earlier than b; compares months only when both are known. */
function cmp(a: ParsedDate, b: ParsedDate): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month == null || b.month == null) return 0;
  return a.month - b.month;
}

type ProfileRole = ProfileDocument['work_history'][number];

/** Profile range for an employer: the roles with the same title when any, else all its roles. */
function profileRange(
  entries: ProfileRole[],
  title: string,
): { start: ParsedDate | null; end: ParsedDate | 'open' | null } {
  const sameTitle = entries.filter((e) => normalizeName(e.title) === normalizeName(title));
  const use = sameTitle.length > 0 ? sameTitle : entries;
  const starts = use.map((e) => parseDate(e.start_date));
  const ends = use.map((e) => parseDate(e.end_date));
  const start = starts.some((s) => s == null || s === 'present' || s === 'invalid')
    ? null
    : (starts as ParsedDate[]).reduce((a, b) => (cmp(b, a) < 0 ? b : a));
  let end: ParsedDate | 'open' | null;
  if (ends.some((e) => e == null || e === 'present' || e === 'invalid')) end = 'open';
  else end = (ends as ParsedDate[]).reduce((a, b) => (cmp(b, a) > 0 ? b : a));
  return { start, end };
}

function degreeForms(e: ProfileDocument['education'][number]): Set<string> {
  const out = new Set<string>();
  const d = e.degree ? normalizeName(e.degree) : '';
  const f = e.field ? normalizeName(e.field) : '';
  if (d) out.add(d);
  if (d && f) {
    out.add(normalizeName(`${e.degree} ${e.field}`));
    out.add(normalizeName(`${e.degree} in ${e.field}`));
    out.add(normalizeName(`${e.field} ${e.degree}`));
  }
  if (!d && f) out.add(f);
  return out;
}

/**
 * Rule 6: every employer, title, degree and certification in the resume facts must be in the
 * profile after normalization, and no date range may fall outside the profile's range for that
 * employer. Returns one quoted failure per problem; empty means the check passed. Skills are not
 * checked.
 */
export function compareFacts(profile: ProfileDocument, facts: ResumeFacts): string[] {
  const failures: string[] = [];
  const byEmployer = new Map<string, ProfileRole[]>();
  for (const w of profile.work_history) {
    const k = normalizeName(w.employer);
    byEmployer.set(k, [...(byEmployer.get(k) ?? []), w]);
  }

  const seenEmployers = new Set<string>();
  const checkEmployer = (name: string): ProfileRole[] | null => {
    const entries = byEmployer.get(normalizeName(name)) ?? null;
    if (!entries && !seenEmployers.has(normalizeName(name))) {
      failures.push(`Employer "${name}" is not in the profile.`);
    }
    seenEmployers.add(normalizeName(name));
    return entries;
  };

  for (const name of facts.employers) checkEmployer(name);

  for (const r of facts.roles) {
    const entries = checkEmployer(r.employer);
    if (!entries) continue;
    if (!entries.some((e) => normalizeName(e.title) === normalizeName(r.title))) {
      failures.push(`Title "${r.title}" at "${r.employer}" is not in the profile.`);
    }
    const range = profileRange(entries, r.title);
    const start = parseDate(r.start_date);
    const end = parseDate(r.end_date);
    const label = `${r.start_date ?? '?'} to ${r.end_date ?? '?'}`;
    const at = `"${r.title}" at "${r.employer}"`;
    if (start === 'invalid') {
      failures.push(
        `Start date "${r.start_date}" for ${at} is not a valid date (use YYYY-MM or YYYY).`,
      );
    }
    if (end === 'invalid') {
      failures.push(
        `End date "${r.end_date}" for ${at} is not a valid date (use YYYY-MM, YYYY or present).`,
      );
    }
    if (start === 'present') {
      failures.push(
        `Start date "${r.start_date}" for ${at} is not a valid date (use YYYY-MM or YYYY).`,
      );
    }
    if (start === 'invalid' || end === 'invalid' || start === 'present') continue;
    if (start && end && end !== 'present' && cmp(start, end) > 0) {
      failures.push(`Dates "${label}" at "${r.employer}" end before they start.`);
    }
    if (start) {
      if (range.start && cmp(start, range.start) < 0) {
        failures.push(
          `Dates "${label}" at "${r.employer}" start before the profile's start date ${entries[0]?.start_date}.`,
        );
      }
      if (range.end && range.end !== 'open' && cmp(start, range.end) > 0) {
        failures.push(`Dates "${label}" at "${r.employer}" start after the profile's end date.`);
      }
    }
    if (end === 'present') {
      if (range.end !== 'open' && range.end !== null) {
        failures.push(`"${r.employer}" is shown as current but the profile has it ending.`);
      }
    } else if (end) {
      if (range.end && range.end !== 'open' && cmp(end, range.end) > 0) {
        failures.push(`Dates "${label}" at "${r.employer}" end after the profile's end date.`);
      }
      if (range.start && cmp(end, range.start) < 0) {
        failures.push(`Dates "${label}" at "${r.employer}" end before the profile's start date.`);
      }
    }
  }

  for (const e of facts.education) {
    const entries = profile.education.filter(
      (p) => normalizeName(p.institution) === normalizeName(e.institution),
    );
    if (entries.length === 0) {
      failures.push(`Institution "${e.institution}" is not in the profile.`);
      continue;
    }
    const wantDegree = e.degree ? normalizeName(e.degree) : '';
    const wantField = e.field ? normalizeName(e.field) : '';
    const matches = entries.filter(
      (p) =>
        (!wantDegree || degreeForms(p).has(wantDegree)) &&
        (!wantField || (p.field ? normalizeName(p.field) === wantField : false)),
    );
    if (matches.length === 0) {
      const said = [e.degree, e.field && `in ${e.field}`].filter(Boolean).join(' ');
      if (said) failures.push(`Degree "${said}" at "${e.institution}" is not in the profile.`);
    }
  }

  // A certification is claimed only when the profile states it as held (certifications[]).
  const held = new Set<string>();
  for (const c of profile.certifications ?? []) {
    held.add(normalizeName(c.name));
    if (c.issuer) held.add(normalizeName(`${c.issuer} ${c.name}`));
  }
  for (const c of facts.certifications) {
    const n = normalizeName(c);
    if (n === '' || !held.has(n)) {
      failures.push(`Certification "${c}" is not stated as held in the profile.`);
    }
  }
  return failures;
}

/** The same facts read straight off the structured resume (a deterministic second check). */
export function factsFromContent(content: TailoredResume): ResumeFacts {
  return {
    employers: content.experience.map((e) => e.employer),
    roles: content.experience.map((e) => ({
      employer: e.employer,
      title: e.title,
      start_date: e.start_date,
      end_date: e.end_date,
    })),
    education: content.education.map((e) => ({
      institution: e.institution,
      degree: e.degree,
      field: e.field,
    })),
    certifications: [],
  };
}

export function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}
