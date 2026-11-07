import { readFile } from 'node:fs/promises';
import { PDFParse } from 'pdf-parse';
import { chromium, type Browser } from 'playwright';
import { dateRange } from './tailor/format';
import type { ResumeDocument } from './tailor/schema';

/** Font sizes in points: the house size, then the single shrink step (rule 17). */
export const FONT_STEPS_PT = [10.5, 9.5] as const;
export const MAX_PAGES = 2;

const TEMPLATE_URL = new URL('../../templates/resume.html', import.meta.url);

/** Rendering threw or produced an empty file (the `render-failed` outcome). */
export class RenderError extends Error {
  readonly code = 'render-failed' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RenderError';
  }
}

/** Still more than two pages after the font-shrink step. */
export class ResumeTooLongError extends Error {
  readonly code = 'too_long' as const;
  constructor(readonly pageCount: number) {
    super(`resume renders to ${pageCount} pages at the smallest font step`);
    this.name = 'ResumeTooLongError';
  }
}

export interface RenderedPdf {
  bytes: Buffer;
  pageCount: 1 | 2;
  /** Index into FONT_STEPS_PT that was used. */
  fontStep: number;
}

export type ResumeRenderer = (doc: ResumeDocument) => Promise<RenderedPdf>;

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function bodyHtml(doc: ResumeDocument): string {
  const c = doc.content;
  const e = escapeHtml;
  const parts: string[] = [`<h1>${e(doc.name)}</h1>`];
  if (c.headline) parts.push(`<p class="headline">${e(c.headline)}</p>`);
  if (doc.contact.length)
    parts.push(`<p class="contact">${doc.contact.map(e).join(' &middot; ')}</p>`);
  if (c.summary) parts.push(`<h2>Summary</h2><p>${e(c.summary)}</p>`);
  if (c.experience.length) {
    parts.push('<h2>Experience</h2>');
    for (const x of c.experience) {
      const sub = [x.employer, x.location].filter(Boolean).join(', ');
      parts.push(
        `<div class="entry"><div class="row"><span>${e(x.title)}</span><span class="when">${e(dateRange(x.start_date, x.end_date))}</span></div>` +
          `<div class="sub">${e(sub)}</div>` +
          (x.bullets.length
            ? `<ul>${x.bullets.map((b) => `<li>${e(b)}</li>`).join('')}</ul>`
            : '') +
          '</div>',
      );
    }
  }
  if (c.projects.length) {
    parts.push('<h2>Projects</h2>');
    for (const p of c.projects) {
      parts.push(
        `<div class="entry"><div class="row"><span>${e(p.name)}</span></div>` +
          (p.description ? `<p>${e(p.description)}</p>` : '') +
          (p.technologies.length ? `<div class="sub">${e(p.technologies.join(', '))}</div>` : '') +
          '</div>',
      );
    }
  }
  if (c.education.length) {
    parts.push('<h2>Education</h2>');
    for (const x of c.education) {
      const deg = [x.degree, x.field].filter(Boolean).join(', ');
      parts.push(
        `<div class="entry"><div class="row"><span>${e(x.institution)}</span><span class="when">${e(dateRange(x.start_date, x.end_date))}</span></div>` +
          (deg ? `<div class="sub">${e(deg)}</div>` : '') +
          '</div>',
      );
    }
  }
  if (c.skills.length) parts.push(`<h2>Skills</h2><p>${c.skills.map(e).join(', ')}</p>`);
  return parts.join('\n    ');
}

export async function resumeHtml(doc: ResumeDocument, fontSizePt: number): Promise<string> {
  const template = await readFile(TEMPLATE_URL, 'utf8');
  return template
    .replace('{{TITLE}}', () => escapeHtml(`${doc.name} - Resume`))
    .replace('{{FONT_SIZE}}', () => String(fontSizePt))
    .replace('{{BODY}}', () => bodyHtml(doc));
}

export async function countPages(bytes: Uint8Array): Promise<number> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const info = await parser.getInfo();
    return info.total;
  } finally {
    await parser.destroy();
  }
}

async function printOnce(browser: Browser, html: string): Promise<Buffer> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return Buffer.from(
      await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true }),
    );
  } finally {
    await context.close();
  }
}

export interface RenderOptions {
  /** A shared browser (one per worker process). When absent one is launched and closed here. */
  browser?: Browser;
}

/**
 * Rule 17: renders the house template at Letter size. More than two pages shrinks the font one
 * step; still more than two throws ResumeTooLongError. Throws RenderError when the browser fails
 * or the file is empty.
 */
export async function renderResumePdf(
  doc: ResumeDocument,
  opts: RenderOptions = {},
): Promise<RenderedPdf> {
  const own = opts.browser ? null : await launch();
  const browser = opts.browser ?? (own as Browser);
  try {
    let pages = 0;
    for (let step = 0; step < FONT_STEPS_PT.length; step++) {
      let bytes: Buffer;
      try {
        bytes = await printOnce(browser, await resumeHtml(doc, FONT_STEPS_PT[step] as number));
        pages = bytes.length === 0 ? 0 : await countPages(bytes);
      } catch (cause) {
        throw new RenderError(`resume render failed: ${(cause as Error).message}`, { cause });
      }
      if (pages < 1) throw new RenderError('resume render produced an empty file');
      if (pages <= MAX_PAGES) return { bytes, pageCount: pages as 1 | 2, fontStep: step };
    }
    throw new ResumeTooLongError(pages);
  } finally {
    await own?.close();
  }
}

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (cause) {
    throw new RenderError(`browser launch failed: ${(cause as Error).message}`, { cause });
  }
}
