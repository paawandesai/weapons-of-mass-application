const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  hellip: '...',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[body.toLowerCase()] ?? m;
  });
}

/** Plain text from HTML: block tags become newlines, other tags vanish, entities decode. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|p|div|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ');
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, ''))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Greenhouse returns `content` as HTML that was itself entity-escaped. */
export function escapedHtmlToText(s: string): string {
  return htmlToText(decodeEntities(s));
}

export function hrefs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href\s*=\s*"([^"]+)"/gi)) out.push(decodeEntities(m[1]!));
  return out;
}

/** `YYYY-MM-DD` of an instant, in UTC. */
export const utcDate = (d: Date): string => d.toISOString().slice(0, 10);

export function toIso(value: unknown): string | null {
  if (value == null || value === '') return null;
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
