import type { Browser } from 'playwright';

export interface LevelsQuery {
  title: string;
  location: string | null;
}

/** Returns the visible text of the public compensation page for the query; throws when it cannot. */
export type LevelsFetcher = (query: LevelsQuery) => Promise<string>;

const DEFAULT_BASE = 'https://www.levels.fyi';
const LEVEL_WORDS =
  /\b(senior|sr|staff|principal|lead|junior|jr|associate|distinguished|head of|manager of|i{1,3}|iv|v)\b/gi;
const MAX_PAGE_CHARS = 20_000;

export const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** `/t/<title>[/locations/<location>]` on the public site; level words are dropped from the title. */
export function levelsUrl(query: LevelsQuery, base: string = DEFAULT_BASE): string {
  const title = slug(query.title.replace(LEVEL_WORDS, ' ')) || slug(query.title);
  const location = query.location ? slug(query.location) : '';
  const path = `/t/${title}${location ? `/locations/${location}` : ''}`;
  return `${base.replace(/\/+$/, '')}${path}`;
}

export interface PlaywrightLevelsOptions {
  /** Origin to fetch from; tests point it at a local server. */
  baseUrl?: string;
  browser?: () => Promise<Pick<Browser, 'newContext'>>;
  timeoutMs?: number;
}

/** The levels.fyi public page, rendered in the worker's shared Playwright browser. */
export function createPlaywrightLevelsFetcher(
  options: PlaywrightLevelsOptions = {},
): LevelsFetcher {
  return async (query) => {
    const base = options.baseUrl ?? process.env.LEVELS_FYI_BASE_URL ?? DEFAULT_BASE;
    const getBrowser =
      options.browser ?? (async () => (await import('../submission/browser')).sharedBrowser());
    const context = await (await getBrowser()).newContext();
    try {
      const page = await context.newPage();
      const response = await page.goto(levelsUrl(query, base), {
        waitUntil: 'domcontentloaded',
        timeout: options.timeoutMs ?? 25_000,
      });
      if (!response || !response.ok())
        throw new Error(`the compensation page answered ${response?.status() ?? 'nothing'}`);
      const text = await page.innerText('body');
      return text
        .replace(/[^\S\n]+/g, ' ')
        .trim()
        .slice(0, MAX_PAGE_CHARS);
    } finally {
      await context.close().catch(() => {});
    }
  };
}
