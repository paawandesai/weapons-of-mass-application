import { chromium, type Browser } from 'playwright';
import type { BrowserLike } from './deps';

let shared: Promise<Browser> | null = null;

/** One browser per worker process, started on first use and restarted if it dies. */
function browser(): Promise<Browser> {
  shared ??= chromium.launch({ headless: true }).then((b) => {
    b.on('disconnected', () => {
      shared = null;
    });
    return b;
  });
  shared.catch(() => {
    shared = null;
  });
  return shared;
}

/** The process-wide Playwright browser (also used to render resume PDFs). */
export const sharedBrowser = browser;

export async function launchSharedBrowser(): Promise<BrowserLike> {
  const b = await browser();
  return { newContext: () => b.newContext() };
}

export async function closeSharedBrowser(): Promise<void> {
  const current = shared;
  shared = null;
  if (current) await (await current).close().catch(() => {});
}
