import { chromium, type Browser } from 'playwright';
import { PDFParse } from 'pdf-parse';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderResumePdf, ResumeTooLongError } from '../../src/submission/pdf';
import { documentFor } from '../../src/submission/tailor';
import type { TailoredResume } from '../../src/submission/tailor/schema';
import { GOOD_RESUME, PROFILE } from '../fixtures/submission';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

async function text(bytes: Uint8Array): Promise<string> {
  const p = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    return (await p.getText()).text;
  } finally {
    await p.destroy();
  }
}

/** Many roles with long bullets: far past two pages even at the smaller font. */
function oversized(): TailoredResume {
  const role = (i: number) => ({
    employer: 'Google',
    title: 'Staff Software Engineer',
    location: null,
    start_date: '2021-03',
    end_date: 'present',
    bullets: Array.from(
      { length: 8 },
      (_, j) =>
        `Item ${i}.${j}: ` +
        'Led the migration of batch pipelines to streaming and cut latency by half across regions. '.repeat(
          3,
        ),
    ),
  });
  return { ...GOOD_RESUME, experience: Array.from({ length: 14 }, (_, i) => role(i)) };
}

describe('renderResumePdf (task 2.4, rule 17)', () => {
  it('renders the fixture to 1-2 Letter pages whose first text line is the name', async () => {
    const r = await renderResumePdf(documentFor(PROFILE, GOOD_RESUME), { browser });
    expect(r.pageCount).toBeGreaterThanOrEqual(1);
    expect(r.pageCount).toBeLessThanOrEqual(2);
    expect(r.fontStep).toBe(0);
    const t = await text(r.bytes);
    expect(t.trim().split('\n')[0]?.trim()).toBe('Mara Quill');
    expect(t).toContain('Kubernetes');
    // Letter: 612 x 792 pt
    const p = new PDFParse({ data: new Uint8Array(r.bytes) });
    const info = await p.getInfo({ parsePageInfo: true });
    await p.destroy();
    expect(Math.round(info.pages[0]?.width ?? 0)).toBe(612);
    expect(Math.round(info.pages[0]?.height ?? 0)).toBe(792);
  });

  it('fails with too_long when the content stays over two pages after the font shrink', async () => {
    const err = await renderResumePdf(documentFor(PROFILE, oversized()), { browser }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ResumeTooLongError);
    expect((err as ResumeTooLongError).pageCount).toBeGreaterThan(2);
  });

  it('escapes HTML in resume text', async () => {
    const content = { ...GOOD_RESUME, summary: '<script>window.x=1</script> & more' };
    const r = await renderResumePdf(documentFor(PROFILE, content), { browser });
    expect(await text(r.bytes)).toContain('<script>window.x=1</script> & more');
  });

  it('launches and closes its own browser when none is given', async () => {
    const r = await renderResumePdf(documentFor(PROFILE, GOOD_RESUME));
    expect(r.bytes.subarray(0, 4).toString()).toBe('%PDF');
  });
});
