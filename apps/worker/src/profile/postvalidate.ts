import { randomUUID } from 'node:crypto';
import type { ProfileFlag, ProfileModelOutput, WorkHistoryEntry } from '@wma/shared';
import type { SourceBundle } from './types';

/** Lowercase, Unicode-normalised, whitespace collapsed. */
export function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const COMPANY_SUFFIXES = new Set([
  'inc',
  'llc',
  'ltd',
  'corp',
  'corporation',
  'co',
  'company',
  'gmbh',
  'plc',
  'sa',
  'ag',
  'bv',
]);

/** "Google LLC" and "Google" are the same employer for conflict detection. */
function employerKey(employer: string): string {
  const tokens = norm(employer).replace(/[.,]/g, ' ').split(' ').filter(Boolean);
  while (tokens.length > 1 && COMPANY_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join(' ');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function containsSkill(haystack: string, skill: string): boolean {
  const s = norm(skill);
  if (!s) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(s)}($|[^a-z0-9])`).test(haystack);
}

const digits = (s: string) => s.replace(/\D/g, '');
const bareUrl = (u: string) =>
  norm(u)
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');

const END_OF_TIME = '9999-12';

/** A year-only date (YYYY) spans the whole year: it starts in January and ends in December. */
const earliest = (d: string) => (d.length === 4 ? `${d}-01` : d);
const latest = (d: string) => (d.length === 4 ? `${d}-12` : d);

/**
 * start1 <= end2 and start2 <= end1, null end = 9999-12, a YYYY date taken as the whole year
 * (start at its earliest month, end at its latest). Unknown starts never overlap.
 */
export function rangesOverlap(
  a: { start_date: string | null; end_date: string | null },
  b: { start_date: string | null; end_date: string | null },
): boolean {
  if (!a.start_date || !b.start_date) return false;
  const aEnd = a.end_date ? latest(a.end_date) : END_OF_TIME;
  const bEnd = b.end_date ? latest(b.end_date) : END_OF_TIME;
  return earliest(a.start_date) <= bEnd && earliest(b.start_date) <= aEnd;
}

export interface PostValidation {
  output: ProfileModelOutput;
  flags: ProfileFlag[];
}

const flag = (f: Omit<ProfileFlag, 'id' | 'resolved'>): ProfileFlag => ({
  id: randomUUID(),
  resolved: false,
  ...f,
});

/**
 * Enforces the never-invent rules (design brief rules 2 to 7) on a schema-valid model output.
 * Pure: reads only the output and the bundle.
 */
export function postValidate(model: ProfileModelOutput, bundle: SourceBundle): PostValidation {
  const textById = new Map(bundle.sources.map((s) => [s.id, norm(s.text)]));
  const allText = [...textById.values()].join('\n');
  const flags: ProfileFlag[] = [];

  /** Keeps only source ids that exist in the bundle and returns their joined text. */
  const cited = (ids: string[]) => {
    const known = [...new Set(ids)].filter((id) => textById.has(id));
    return { known, text: known.map((id) => textById.get(id)!).join('\n') };
  };

  function filterEntries<E extends { sources: string[] }>(
    section: 'work_history' | 'projects' | 'education',
    entries: E[],
    valueOf: (e: E) => string,
  ): E[] {
    const kept: E[] = [];
    for (const entry of entries) {
      const { known, text } = cited(entry.sources);
      const value = valueOf(entry);
      if (known.length > 0 && text.includes(norm(value))) {
        kept.push({ ...entry, sources: known });
      } else {
        flags.push(
          flag({
            kind: 'unsupported_entry',
            path: null,
            section,
            value,
            message: `"${value}" was not found in the sources it cited, so it was left out of ${section.replace('_', ' ')}.`,
            sources: entry.sources,
          }),
        );
      }
    }
    return kept;
  }

  const work_history = filterEntries('work_history', model.work_history, (e) => e.employer);
  const education = filterEntries('education', model.education, (e) => e.institution);
  const projects = filterEntries('projects', model.projects, (e) => e.name);

  // Rule 5: unsupported skills are dropped silently.
  const seenSkills = new Set<string>();
  const skills = model.skills.filter((s) => {
    const key = norm(s.name);
    if (seenSkills.has(key) || !containsSkill(allText, s.name)) return false;
    seenSkills.add(key);
    return true;
  });

  // Rule 6: same employer, overlapping ranges, different titles, different sources.
  for (let i = 0; i < work_history.length; i++) {
    for (let j = i + 1; j < work_history.length; j++) {
      const a = work_history[i]!;
      const b = work_history[j]!;
      if (conflicts(a, b)) {
        flags.push(
          flag({
            kind: 'date_conflict',
            path: `work_history.${i}`,
            // Both conflicting entries, so either one being edited or removed resolves it.
            paths: [`work_history.${i}`, `work_history.${j}`],
            section: 'work_history',
            value: a.employer,
            message: `${a.employer}: "${a.title}" and "${b.title}" overlap in time and come from different sources. Keep the right one and delete the other.`,
            sources: [...new Set([...a.sources, ...b.sources])],
          }),
        );
      }
    }
  }

  // Rule 7: sources that returned nothing (or part) are flagged and the build continues.
  for (const s of bundle.sources) {
    if (s.partial || s.text.trim() === '') {
      flags.push(
        flag({
          kind: 'partial_source',
          path: null,
          section: null,
          value: s.id,
          message: `${s.label ?? s.id} returned ${s.text.trim() === '' ? 'no text' : 'only partial data'}; the profile was built from what was available.`,
          sources: [s.id],
        }),
      );
    }
  }

  // Contact details are only kept when a source states them (never-invent applies here too).
  const c = model.contact;
  const phoneDigits = c.phone ? digits(c.phone) : '';
  const contact = {
    email: allText.includes(norm(c.email)) ? c.email : bundle.accountEmail,
    phone:
      c.phone && phoneDigits.length >= 5 && digits(allText).includes(phoneDigits) ? c.phone : null,
    linkedin_url:
      c.linkedin_url && allText.includes(bareUrl(c.linkedin_url))
        ? c.linkedin_url
        : bundle.links.linkedin_url,
    github_url:
      c.github_url && allText.includes(bareUrl(c.github_url))
        ? c.github_url
        : bundle.links.github_url,
    website_url: c.website_url && allText.includes(bareUrl(c.website_url)) ? c.website_url : null,
  };

  return { output: { ...model, contact, work_history, education, projects, skills }, flags };
}

function conflicts(a: WorkHistoryEntry, b: WorkHistoryEntry): boolean {
  if (employerKey(a.employer) !== employerKey(b.employer)) return false;
  if (norm(a.title) === norm(b.title)) return false;
  const sa = new Set(a.sources);
  const sb = new Set(b.sources);
  const sameSources = sa.size === sb.size && [...sa].every((x) => sb.has(x));
  if (sameSources) return false;
  return rangesOverlap(a, b);
}
