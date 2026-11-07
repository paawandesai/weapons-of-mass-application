import type { AtsId, BoardRegion } from '@wma/shared';
import { HttpError, sharedHttp, type Http } from './http';

export const SUPPORTED_ATS: readonly AtsId[] = ['greenhouse', 'lever', 'ashby'];
export const SUPPORTED_ATS_MESSAGE = 'Ashby, Greenhouse or Lever';

export type { BoardRegion };

export interface Board {
  ats: AtsId;
  boardSlug: string;
  /** 'eu' for the EU-hosted Lever and Greenhouse boards, '' for every other board. */
  region: BoardRegion;
  boardUrl: string;
}

/** Only Lever and Greenhouse have an EU deployment; the region is ignored for Ashby. */
const regional = (ats: AtsId, region: BoardRegion): BoardRegion => (ats === 'ashby' ? '' : region);

export function boardPublicUrl(ats: AtsId, slug: string, region: BoardRegion = ''): string {
  const eu = regional(ats, region) === 'eu';
  switch (ats) {
    case 'greenhouse':
      return `https://${eu ? 'boards.eu' : 'boards'}.greenhouse.io/${slug}`;
    case 'lever':
      return `https://${eu ? 'jobs.eu' : 'jobs'}.lever.co/${slug}`;
    case 'ashby':
      return `https://jobs.ashbyhq.com/${slug}`;
  }
}

/** Public JSON endpoints (design D2). `content` asks Greenhouse for full descriptions. */
export function boardApiUrl(
  ats: AtsId,
  slug: string,
  opts: { full?: boolean; region?: BoardRegion } = {},
): string {
  const s = encodeURIComponent(slug);
  const eu = regional(ats, opts.region ?? '') === 'eu';
  switch (ats) {
    case 'greenhouse':
      return `https://${eu ? 'boards-api.eu' : 'boards-api'}.greenhouse.io/v1/boards/${s}/jobs${opts.full ? '?content=true' : ''}`;
    case 'lever':
      return `https://${eu ? 'api.eu' : 'api'}.lever.co/v0/postings/${s}?mode=json`;
    case 'ashby':
      return `https://api.ashbyhq.com/posting-api/job-board/${s}${opts.full ? '?includeCompensation=true' : ''}`;
  }
}

const BOARD_HOSTS: Array<{ host: RegExp; ats: AtsId }> = [
  { host: /^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/, ats: 'greenhouse' },
  { host: /^jobs(?:\.eu)?\.lever\.co$/, ats: 'lever' },
  { host: /^jobs\.ashbyhq\.com$/, ats: 'ashby' },
];

/** ATS, slug and region from a board or job URL on one of the three hosted ATSs; null otherwise. */
export function parseBoardUrl(
  input: string,
): { ats: AtsId; boardSlug: string; region: BoardRegion } | null {
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const hit = BOARD_HOSTS.find((h) => h.host.test(host));
  if (!hit) return null;
  let slug = u.pathname.split('/').filter(Boolean)[0];
  if (hit.ats === 'greenhouse' && slug === 'embed') slug = u.searchParams.get('for') ?? undefined;
  if (!slug || !/^[a-z0-9][a-z0-9_.-]*$/i.test(slug)) return null;
  return {
    ats: hit.ats,
    boardSlug: slug.toLowerCase(),
    region: hit.ats === 'ashby' || !/\.eu\./.test(host) ? '' : 'eu',
  };
}

const LEGAL_SUFFIXES = new Set([
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
]);

/** Words of a company name: lowercase, accents and punctuation removed, legal suffixes dropped. */
export function nameWords(name: string): string[] {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1]!)) words.pop();
  return words;
}

const cleanHint = (h: string) =>
  h
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '');

/**
 * Slug candidates in the order they are tried: hyphenated name, concatenated name, then the LLM
 * hints (hints are only hints; every candidate is verified against the ATS). At most 6.
 */
export function slugVariants(name: string, hints: readonly string[] = []): string[] {
  const words = nameWords(name);
  const out: string[] = [];
  if (words.length) {
    out.push(words.join('-'));
    out.push(words.join(''));
  }
  for (const h of hints) out.push(cleanHint(h));
  return [...new Set(out)].filter((s) => /^[a-z0-9][a-z0-9-]*$/.test(s)).slice(0, 6);
}

export type ProbeResult = 'found' | 'missing' | 'unavailable';

/** Does `slug` have a public board on `ats`? Server errors and timeouts are `unavailable`. */
export async function probeBoard(
  http: Http,
  ats: AtsId,
  slug: string,
  region: BoardRegion = '',
): Promise<ProbeResult> {
  let res;
  try {
    res = await http.get(boardApiUrl(ats, slug, { region }));
  } catch (e) {
    if (e instanceof HttpError) return 'unavailable';
    throw e;
  }
  if (res.status >= 500 || res.status === 429) return 'unavailable';
  if (!res.ok) return 'missing';
  try {
    const body = res.json<unknown>();
    const jobs = Array.isArray(body) ? body : (body as { jobs?: unknown } | null)?.jobs;
    return Array.isArray(jobs) ? 'found' : 'missing';
  } catch {
    return 'missing';
  }
}

export type ResolveResult =
  | { status: 'resolved'; boards: Board[]; partial: boolean }
  /** Every ATS answered and none has a board for any slug variant. */
  | { status: 'unresolved' }
  /** No board found and at least one ATS could not be asked (timeout, server error). */
  | { status: 'unavailable' };

export interface ResolveDeps {
  http?: Http;
}

/**
 * Resolves a company name to its public boards: for each ATS the first slug variant that answers
 * 200 wins (design D2). ATS probes run concurrently; the HTTP client caps each host at 2.
 */
export async function resolveBoard(
  name: string,
  hints: readonly string[] = [],
  deps: ResolveDeps = {},
): Promise<ResolveResult> {
  const http = deps.http ?? sharedHttp();
  const variants = slugVariants(name, hints);
  const perAts = await Promise.all(
    SUPPORTED_ATS.map(async (ats): Promise<{ board: Board | null; unavailable: boolean }> => {
      let unavailable = false;
      for (const slug of variants) {
        const r = await probeBoard(http, ats, slug);
        if (r === 'found') {
          return {
            board: { ats, boardSlug: slug, region: '', boardUrl: boardPublicUrl(ats, slug) },
            unavailable,
          };
        }
        if (r === 'unavailable') unavailable = true;
      }
      return { board: null, unavailable };
    }),
  );
  const boards = perAts.flatMap((r) => (r.board ? [r.board] : []));
  const anyUnavailable = perAts.some((r) => r.unavailable && !r.board);
  if (boards.length) return { status: 'resolved', boards, partial: anyUnavailable };
  return anyUnavailable ? { status: 'unavailable' } : { status: 'unresolved' };
}
