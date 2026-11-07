import { chromium, type Browser } from 'playwright';
import { DEFAULT_TIMEZONE } from './constants';
import type { BrowserLike } from './deps';

let shared: Promise<Browser> | null = null;

const VIEWPORT = { width: 1280, height: 900 };

/** The browser's own user agent with the headless marker removed. */
export function humanUserAgent(defaultUserAgent: string): string {
  return defaultUserAgent.replace('HeadlessChrome', 'Chrome');
}

/** Launch arguments; `--no-sandbox` only when the process is root (a container). */
export function launchArgs(uid: number | undefined): string[] {
  const args = ['--disable-blink-features=AutomationControlled'];
  if (uid === 0) args.push('--no-sandbox');
  return args;
}

/** Real Chrome (new headless) when installed; Playwright's bundled Chromium otherwise. */
async function launch(): Promise<Browser> {
  const args = launchArgs(process.getuid?.());
  try {
    return await chromium.launch({ channel: 'chrome', headless: true, args });
  } catch (e) {
    console.warn(
      `[submission] Google Chrome could not be launched (${(e as Error).message.split('\n')[0]}); using bundled Chromium`,
    );
    return chromium.launch({ headless: true, args });
  }
}

/** One browser per worker process, started on first use and restarted if it dies. */
function browser(): Promise<Browser> {
  shared ??= launch().then((b) => {
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

let userAgent: Promise<string> | null = null;

async function defaultUserAgent(b: Browser): Promise<string> {
  userAgent ??= (async () => {
    const probe = await b.newContext();
    try {
      const page = await probe.newPage();
      return humanUserAgent(await page.evaluate(() => navigator.userAgent));
    } finally {
      await probe.close();
    }
  })();
  userAgent.catch(() => {
    userAgent = null;
  });
  return userAgent;
}

export async function launchSharedBrowser(): Promise<BrowserLike> {
  const b = await browser();
  return {
    newContext: async (opts) =>
      b.newContext({
        userAgent: await defaultUserAgent(b),
        locale: 'en-US',
        timezoneId: opts?.timezoneId ?? DEFAULT_TIMEZONE,
        viewport: VIEWPORT,
      }),
  };
}

export async function closeSharedBrowser(): Promise<void> {
  const current = shared;
  shared = null;
  userAgent = null;
  if (current) await (await current).close().catch(() => {});
}
