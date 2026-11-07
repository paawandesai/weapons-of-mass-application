import { Candidate, parseAtsJobUrl } from '@wma/shared';
import { HttpError, mapLimit, type HttpResponse } from '@wma/discovery';
import { decodeEntities, hrefs, htmlToText } from '../text';
import type { SourceAdapter, SourceContext, SourceResult } from '../types';

const SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobSearch/search';
const DETAIL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';
const MAX_QUERIES = 3;
const MAX_CARDS_PER_QUERY = 15;
const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
};

class Blocked extends Error {}

const WALL = /authwall|uas\/login|checkpoint\/challenge|captcha/i;

/** LinkedIn answers anonymous traffic with 999, redirects to a login wall, or a challenge page. */
function readPage(res: HttpResponse): string {
  if (res.status === 999 || res.status === 429 || res.status === 401 || res.status === 403) {
    throw new Blocked(`status ${res.status}`);
  }
  if (res.status >= 300 && res.status < 400) throw new Blocked('redirected to login');
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = res.text();
  if (WALL.test(body.slice(0, 4000))) throw new Blocked('login wall');
  return body;
}

export interface LinkedInCard {
  jobId: string;
  title: string;
  company: string;
  location: string | null;
}

export function parseSearchCards(html: string): LinkedInCard[] {
  const cards: LinkedInCard[] = [];
  for (const chunk of html.split(/<li\b/i).slice(1)) {
    const id =
      chunk.match(/jobPosting:(\d+)/)?.[1] ?? chunk.match(/\/jobs\/view\/[^"?]*?-?(\d{6,})/)?.[1];
    const title = chunk.match(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/i)?.[1];
    const company = chunk.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/i)?.[1];
    const location = chunk.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/i)?.[1];
    if (!id || !title) continue;
    cards.push({
      jobId: id,
      title: htmlToText(title),
      company: company ? htmlToText(company) : 'Unknown company',
      location: location ? htmlToText(location) : null,
    });
  }
  return cards;
}

/** The ATS job URL a LinkedIn posting links out to, if any (direct or via LinkedIn's redirector). */
export function externalAtsUrl(html: string): string | null {
  for (const href of hrefs(html)) {
    const direct = parseAtsJobUrl(href);
    if (direct) return href;
    const wrapped = href.match(/linkedin\.com\/safety\/go\/?\?[^"]*?\burl=([^&"]+)/i)?.[1];
    if (wrapped) {
      const url = decodeURIComponent(decodeEntities(wrapped));
      if (parseAtsJobUrl(url)) return url;
    }
  }
  return null;
}

function queriesFor(
  ctx: SourceContext,
): Array<{ keywords: string; location: string; remote: boolean }> {
  const { survey, preferences } = ctx.profile;
  const roles = [...new Set([...survey.target_roles, ...preferences.target_titles])].slice(
    0,
    MAX_QUERIES,
  );
  const location = preferences.locations[0] ?? '';
  return roles.map((keywords) => ({ keywords, location, remote: preferences.remote === 'remote' }));
}

export const linkedinAdapter: SourceAdapter = {
  id: 'linkedin-public',
  async fetch(ctx: SourceContext): Promise<SourceResult> {
    const queries = queriesFor(ctx);
    if (queries.length === 0)
      return { status: 'ok', candidates: [], detail: 'no search terms in the profile' };
    const found = new Map<string, Candidate>();
    let partial = false;
    try {
      for (const q of queries) {
        const params = new URLSearchParams({ keywords: q.keywords, start: '0' });
        if (q.location) params.set('location', q.location);
        if (q.remote) params.set('f_WT', '2');
        const html = readPage(
          await ctx.http.get(`${SEARCH}?${params}`, { headers: HEADERS, redirect: 'manual' }),
        );
        const cards = parseSearchCards(html).slice(0, MAX_CARDS_PER_QUERY);
        const details = await mapLimit(cards, 2, async (card) => {
          try {
            const page = readPage(
              await ctx.http.get(`${DETAIL}/${card.jobId}`, {
                headers: HEADERS,
                redirect: 'manual',
              }),
            );
            return { card, page };
          } catch (e) {
            if (e instanceof Blocked) throw e;
            partial = true;
            return null;
          }
        });
        for (const d of details) {
          if (!d) continue;
          const url = externalAtsUrl(d.page);
          const ref = url ? parseAtsJobUrl(url) : null;
          if (!url || !ref) continue;
          found.set(
            `${ref.ats}:${ref.atsJobId}`,
            Candidate.parse({
              source: 'linkedin',
              title: d.card.title,
              companyName: d.card.company,
              url,
              ats: ref.ats,
              atsJobId: ref.atsJobId,
              description: htmlToText(d.page).slice(0, 20_000) || null,
              location: d.card.location,
              raw: { linkedinJobId: d.card.jobId },
            }),
          );
        }
      }
    } catch (e) {
      if (e instanceof Blocked) {
        // Nothing found before the block is kept only if some searches had already succeeded.
        return found.size
          ? { status: 'partial', candidates: [...found.values()], detail: 'blocked part-way' }
          : { status: 'unavailable', candidates: [], detail: 'blocked by linkedin' };
      }
      if (e instanceof HttpError) {
        return { status: 'unavailable', candidates: [], detail: 'linkedin unreachable' };
      }
      return {
        status: 'unavailable',
        candidates: [],
        detail: 'linkedin returned an unexpected page',
      };
    }
    return { status: partial ? 'partial' : 'ok', candidates: [...found.values()] };
  },
};
