import { describe, expect, it } from 'vitest';
import { humanUserAgent, launchArgs } from '../../src/submission/browser';

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
