import { describe, expect, it } from 'vitest';
import { humanUserAgent, launchArgs } from '../../src/submission/browser';
import { gotoWithRetry } from '../../src/submission/navigate';

describe('rule 37: the real browser', () => {
  it('drops the Headless marker from the user agent', () => {
    const ua =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36';
    expect(humanUserAgent(ua)).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    );
    expect(humanUserAgent('Chrome/140')).toBe('Chrome/140');
  });

  it('adds --no-sandbox only for root', () => {
    expect(launchArgs(1000)).toEqual(['--disable-blink-features=AutomationControlled']);
    expect(launchArgs(undefined)).toEqual(['--disable-blink-features=AutomationControlled']);
    expect(launchArgs(0)).toEqual([
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ]);
  });
});

describe('gotoWithRetry', () => {
  it('retries a failed page.goto once and succeeds on the second try', async () => {
    let n = 0;
    const page = {
      goto: async (url: string) => {
        n += 1;
        if (n === 1) throw new Error(`page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at ${url}`);
      },
    };
    await gotoWithRetry(page, 'https://job-boards.greenhouse.io/x', { backoffMs: 1, timeout: 50 });
    expect(n).toBe(2);
  });

  it('rethrows after both attempts fail', async () => {
    const page = {
      goto: async () => {
        throw new Error('page.goto: net::ERR_FAILED');
      },
    };
    await expect(
      gotoWithRetry(page, 'https://example.test', { backoffMs: 1, attempts: 2 }),
    ).rejects.toThrow('net::ERR_FAILED');
  });
});
