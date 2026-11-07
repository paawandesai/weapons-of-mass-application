import { Candidate, parseAtsJobUrl, type AtsId } from '@wma/shared';
import { HttpError, mapLimit } from '@wma/discovery';
import { hrefs, htmlToText } from '../text';
import type { SourceAdapter, SourceContext, SourceResult } from '../types';

const HN = 'https://hacker-news.firebaseio.com/v0';
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const MAX_COMMENTS = 500;
const MAX_THREADS_SCANNED = 8;

interface HnItem {
  id: number;
  title?: string;
  text?: string;
  time?: number;
  kids?: number[];
  dead?: boolean;
  deleted?: boolean;
}

/** `Ask HN: Who is hiring? (November 2026)` for the month of `now`. */
export function isThreadFor(title: string | undefined, now: Date): boolean {
  const m = title?.match(/^Ask HN: Who is hiring\? \(([A-Za-z]+) (\d{4})\)/i);
  return (
    !!m &&
    MONTHS.indexOf(m[1]!.toLowerCase()) === now.getUTCMonth() &&
    Number(m[2]) === now.getUTCFullYear()
  );
}

/**
 * One candidate per supported ATS job link in a comment. Comments that link only to careers pages
 * or email addresses yield nothing. The first `|`-separated segments are company and role.
 */
export function parseComment(item: HnItem): Candidate[] {
  if (!item.text || item.dead || item.deleted) return [];
  const links = new Map<string, { ats: AtsId; atsJobId: string; url: string }>();
  for (const href of hrefs(item.text)) {
    const ref = parseAtsJobUrl(href);
    if (ref && !links.has(`${ref.ats}:${ref.atsJobId}`)) {
      links.set(`${ref.ats}:${ref.atsJobId}`, { ats: ref.ats, atsJobId: ref.atsJobId, url: href });
    }
  }
  if (links.size === 0) return [];
  const text = htmlToText(item.text);
  const head = (text.split('\n')[0] ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  const companyName = (head[0] ?? '').slice(0, 120) || 'Unknown company';
  const title = (head[1] ?? '').slice(0, 160) || `Role at ${companyName}`;
  const location = head.find((s, i) => i >= 2 && /remote|onsite|hybrid|,/i.test(s)) ?? null;
  return [...links.values()].map((l) =>
    Candidate.parse({
      source: 'hn',
      title,
      companyName,
      url: l.url,
      ats: l.ats,
      atsJobId: l.atsJobId,
      description: text,
      location,
      postedAt: item.time ? new Date(item.time * 1000).toISOString() : null,
      raw: { hnId: item.id },
    }),
  );
}

export const hnAdapter: SourceAdapter = {
  id: 'hn-who-is-hiring',
  async fetch(ctx: SourceContext): Promise<SourceResult> {
    const { http } = ctx;
    let thread: HnItem | null = null;
    try {
      const user = await http.json<{ submitted?: number[] }>(`${HN}/user/whoishiring.json`, {
        hostLimit: 8,
      });
      for (const id of (user.submitted ?? []).slice(0, MAX_THREADS_SCANNED)) {
        const item = await http.json<HnItem | null>(`${HN}/item/${id}.json`);
        if (item && isThreadFor(item.title, ctx.now)) {
          thread = item;
          break;
        }
      }
    } catch (e) {
      if (e instanceof HttpError)
        return { status: 'unavailable', candidates: [], detail: 'hacker news unreachable' };
      throw e;
    }
    if (!thread) return { status: 'ok', candidates: [], detail: 'no thread for the current month' };

    let failed = 0;
    const kids = (thread.kids ?? []).slice(0, MAX_COMMENTS);
    const parsed = await mapLimit(kids, 8, async (id) => {
      try {
        const item = await http.json<HnItem | null>(`${HN}/item/${id}.json`);
        return item ? parseComment(item) : [];
      } catch {
        failed++;
        return [] as Candidate[];
      }
    });
    const candidates = parsed.flat();
    if (kids.length > 0 && failed === kids.length) {
      return { status: 'unavailable', candidates: [], detail: 'no comment could be read' };
    }
    return failed
      ? { status: 'partial', candidates, detail: `${failed} of ${kids.length} comments failed` }
      : { status: 'ok', candidates };
  },
};
