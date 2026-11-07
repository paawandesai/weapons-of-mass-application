import { cleanText } from './connections';

const SLUG_RE = /^[A-Za-z0-9\-_%.]{2,100}$/;

/** Returns the canonical profile URL, or null when this is not a linkedin.com/in/<slug> URL. */
export function normalizeLinkedinUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
  const m = /^\/in\/([^/]+)\/?$/.exec(u.pathname);
  if (!m || !SLUG_RE.test(m[1]!)) return null;
  return `https://www.linkedin.com/in/${m[1]}`;
}

export interface LinkedinResult {
  text: string;
  /** `ok` when readable text came back; otherwise why it degraded. */
  outcome: 'ok' | 'blocked' | 'timeout' | 'error';
}

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));

/** Visible text of an HTML page plus its title and description metas. */
export function htmlToText(html: string): string {
  const metas: string[] = [];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (title) metas.push(title);
  for (const m of html.matchAll(
    /<meta\s+[^>]*?(?:name|property)=["'](?:description|og:title|og:description)["'][^>]*>/gi,
  )) {
    const c = /content=["']([^"']*)["']/i.exec(m[0])?.[1];
    if (c) metas.push(c);
  }
  const body = html
    .replace(/<(script|style|noscript|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const lines = [...metas, ...body.split('\n')]
    .map((l) => decode(l).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return cleanText([...new Set(lines)].join('\n'), 30_000);
}

const WALL_RE = /authwall|\/login|\/signup|checkpoint\/challenge/i;

/**
 * Fetches the public profile page with a timeout. Never throws: a login wall, a timeout or a
 * network error degrades to empty text, and the caller marks the source partial.
 */
export async function fetchLinkedinText(
  url: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<LinkedinResult> {
  const doFetch = opts.fetch ?? fetch;
  let current = url;
  try {
    for (let hop = 0; hop < 3; hop++) {
      const res = await doFetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; WeaponsOfMassApplication/1.0)',
          accept: 'text/html',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        if (!next) return { text: '', outcome: 'blocked' };
        const target = new URL(next, current).toString();
        const host = new URL(target).hostname.toLowerCase();
        if ((host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) || WALL_RE.test(target)) {
          return { text: '', outcome: 'blocked' };
        }
        current = target;
        continue;
      }
      if (res.status !== 200) return { text: '', outcome: 'blocked' };
      const html = (await res.text()).slice(0, 2_000_000);
      const text = htmlToText(html);
      return text.length >= 20 ? { text, outcome: 'ok' } : { text: '', outcome: 'blocked' };
    }
    return { text: '', outcome: 'blocked' };
  } catch (e) {
    const name = (e as Error).name;
    return {
      text: '',
      outcome: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error',
    };
  }
}
