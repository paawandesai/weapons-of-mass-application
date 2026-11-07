import { z } from 'zod';

export const AtsId = z.enum(['ashby', 'greenhouse', 'lever']);
export type AtsId = z.infer<typeof AtsId>;

export const CandidateSource = z.enum(['ashby', 'greenhouse', 'lever', 'hn', 'linkedin']);
export type CandidateSource = z.infer<typeof CandidateSource>;

/** A posting as an adapter reports it, before any judgment. */
export const Candidate = z.object({
  source: CandidateSource,
  title: z.string().min(1),
  companyName: z.string().min(1),
  /** Set when the company is in the global cache. */
  companyId: z.string().nullable().default(null),
  url: z.string().min(1),
  ats: AtsId.nullable().default(null),
  atsJobId: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  /** ISO 8601 timestamp. */
  postedAt: z.string().nullable().default(null),
  raw: z.unknown().optional(),
});
export type Candidate = z.infer<typeof Candidate>;

const isRealDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Output of the `apply-decision@v1` prompt. `fit` orders the day's list and is never exposed by an API. */
export const Judgment = z.object({
  apply: z.boolean(),
  rationale: z.string().max(600),
  fit: z.number().int().min(1).max(5),
  pay_min: z.number().int().nullable(),
  pay_max: z.number().int().nullable(),
  currency: z.string().nullable(),
  location_mode: z.enum(['onsite', 'hybrid', 'remote']).nullable(),
  seniority: z.string().nullable(),
  application_deadline: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
    .refine(isRealDate, 'not a calendar date')
    .nullable(),
});
export type Judgment = z.infer<typeof Judgment>;

/** The same shape as a plain JSON Schema object, for structured output. */
export const JudgmentJsonSchema = z.toJSONSchema(Judgment) as Record<string, unknown>;

export const ApplicationStatus = z.enum(['pending', 'applied', 'interviewing', 'offer', 'closed']);
export type ApplicationStatus = z.infer<typeof ApplicationStatus>;

export const PendingReason = z.enum([
  'tailoring-check-failed',
  'unsupported-ats',
  'unmapped-field',
  'missing-profile-field',
  'unanswerable-question',
  'verification-timeout',
  'credential-rejected',
  'captcha-timeout',
  'unconfirmed',
  'browser-error',
]);
export type PendingReason = z.infer<typeof PendingReason>;

// ---------------------------------------------------------------------------------------------
// URL normalization and dedupe keys
// ---------------------------------------------------------------------------------------------

export type BoardRegion = '' | 'eu';

export interface AtsJobRef {
  ats: AtsId;
  boardSlug: string;
  atsJobId: string;
  /** 'eu' for jobs.eu.lever.co and boards.eu.greenhouse.io; '' otherwise. */
  region: BoardRegion;
}

/** Query parameters that identify the posting on a company-hosted page; everything else is tracking. */
const KEPT_PARAMS = new Set(['gh_jid']);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const GREENHOUSE_HOST = /^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/;
const LEVER_HOST = /^jobs(?:\.eu)?\.lever\.co$/;
const ASHBY_HOST = /^jobs\.ashbyhq\.com$/;

function parse(url: string): URL | null {
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}

const regionOf = (host: string): BoardRegion => (/\.eu\./.test(host) ? 'eu' : '');

/** `boards.greenhouse.io/embed/job_app?for=<slug>&token=<id>`: the embedded application form. */
function isGreenhouseEmbed(u: URL): boolean {
  return (
    GREENHOUSE_HOST.test(u.hostname.toLowerCase()) && /^\/embed\/job_app\/?$/i.test(u.pathname)
  );
}

function refFromParsed(u: URL): AtsJobRef | null {
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  const region = regionOf(host);
  let m: RegExpMatchArray | null;
  if (isGreenhouseEmbed(u)) {
    const slug = u.searchParams.get('for');
    const token = u.searchParams.get('token');
    if (slug && /^[a-z0-9][a-z0-9_.-]*$/i.test(slug) && token && /^\d+$/.test(token)) {
      return { ats: 'greenhouse', boardSlug: slug.toLowerCase(), atsJobId: token, region };
    }
    return null;
  }
  if (GREENHOUSE_HOST.test(host) && (m = path.match(/^\/([^/]+)\/jobs\/(\d+)(?:\/|$)/i))) {
    return { ats: 'greenhouse', boardSlug: m[1]!.toLowerCase(), atsJobId: m[2]!, region };
  }
  if (LEVER_HOST.test(host) && (m = path.match(new RegExp(`^/([^/]+)/(${UUID})(?:/|$)`, 'i')))) {
    return { ats: 'lever', boardSlug: m[1]!.toLowerCase(), atsJobId: m[2]!.toLowerCase(), region };
  }
  if (ASHBY_HOST.test(host) && (m = path.match(new RegExp(`^/([^/]+)/(${UUID})(?:/|$)`, 'i')))) {
    return { ats: 'ashby', boardSlug: m[1]!.toLowerCase(), atsJobId: m[2]!.toLowerCase(), region };
  }
  return null;
}

/** Recognizes the three hosted ATS URL shapes; null for anything else. */
export function parseAtsJobUrl(url: string): AtsJobRef | null {
  const u = parse(url);
  return u ? refFromParsed(u) : null;
}

/**
 * Lowercase host, no fragment, no trailing slash, query stripped except posting-id parameters.
 * A recognized ATS URL is cut back to board and job id (so `/apply` and tracking suffixes agree).
 * Input that is not a URL is returned trimmed.
 */
export function normalizeJobUrl(url: string): string {
  const u = parse(url);
  if (!u) return url.trim();
  const ref = refFromParsed(u);
  const origin = `${u.protocol}//${u.host.toLowerCase()}`;
  if (ref && isGreenhouseEmbed(u)) {
    return `${origin}/embed/job_app?for=${encodeURIComponent(ref.boardSlug)}&token=${ref.atsJobId}`;
  }
  if (ref) {
    const segments = u.pathname.split('/').filter(Boolean);
    const keep = ref.ats === 'greenhouse' ? segments.slice(0, 3) : segments.slice(0, 2);
    return `${origin}/${keep.join('/')}`.replace(/\/+$/, '');
  }
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => KEPT_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = kept.length
    ? `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
    : '';
  const path = u.pathname.replace(/\/+$/, '');
  return `${origin}${path}${query}`;
}

export interface DedupeInput {
  ats?: AtsId | null;
  atsJobId?: string | null;
  url: string;
}

/**
 * `ats:ats_job_id` when both are known (from the fields, else read from a hosted ATS URL), else the
 * normalized URL. The same function serves in-run dedupe and the already-applied lookup.
 */
export function dedupeKey(candidate: DedupeInput): string {
  if (candidate.ats && candidate.atsJobId) {
    return `${candidate.ats}:${candidate.atsJobId.toLowerCase()}`;
  }
  const ref = parseAtsJobUrl(candidate.url);
  if (ref) return `${ref.ats}:${ref.atsJobId}`;
  return normalizeJobUrl(candidate.url);
}
