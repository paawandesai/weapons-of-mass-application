/** Shared page navigation with a short retry for transient goto failures. */

export const GOTO_ATTEMPTS = 2;
export const GOTO_BACKOFF_MS = 1_000;

export type GotoPage = {
  goto: (
    url: string,
    opts?: { waitUntil?: 'domcontentloaded' | 'load' | 'commit' | 'networkidle'; timeout?: number },
  ) => Promise<unknown>;
};

/**
 * Calls `page.goto` up to `attempts` times (default 2) with linear backoff. The last error is
 * rethrown if every try fails. Used so a single `net::` blip is not a browser-error.
 */
export async function gotoWithRetry(
  page: GotoPage,
  url: string,
  opts: {
    waitUntil?: 'domcontentloaded' | 'load' | 'commit' | 'networkidle';
    timeout?: number;
    attempts?: number;
    backoffMs?: number;
  } = {},
): Promise<void> {
  const attempts = opts.attempts ?? GOTO_ATTEMPTS;
  const backoff = opts.backoffMs ?? GOTO_BACKOFF_MS;
  const waitUntil = opts.waitUntil ?? 'domcontentloaded';
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { waitUntil, timeout: opts.timeout });
      return;
    } catch (e) {
      last = e;
      if (i + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, backoff * (i + 1)));
      }
    }
  }
  throw last;
}
