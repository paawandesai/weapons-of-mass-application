import { SubmissionFailure } from '../failure';
import { fromAllowedDomains, matchesCompany, senderDomains } from '../domains';
import { pollUntil } from '../poll';
import { VERIFY_CAP_S, VERIFY_POLL_S } from '../constants';
import type { PageLike } from '../deps';
import type { InboundMessage, SubmissionContext } from '../types';

export type Verification =
  | { kind: 'link'; url: string; messageId: string }
  | { kind: 'code'; code: string; messageId: string };

const VERIFY_URL = /verif|confirm|activate|validate/i;
const NOT_A_VERIFY_LINK = /unsubscribe|privacy|terms|preferences/i;
const CODE = /(?<![\w.-])(\d{6,8})(?![\w-]|\.\d)/;

/** The first verification link or 6-8 digit code a message carries, or null. */
export function extractVerification(msg: InboundMessage): Verification | null {
  const https = msg.links.filter((l) => l.startsWith('https://'));
  const byUrl = https.find((l) => VERIFY_URL.test(l) && !NOT_A_VERIFY_LINK.test(l));
  if (byUrl) return { kind: 'link', url: byUrl, messageId: msg.id };
  const code = CODE.exec(`${msg.subject}\n${msg.text}`)?.[1];
  if (code) return { kind: 'code', code, messageId: msg.id };
  if (VERIFY_URL.test(msg.subject)) {
    const first = https.find((l) => !NOT_A_VERIFY_LINK.test(l));
    if (first) return { kind: 'link', url: first, messageId: msg.id };
  }
  return null;
}

/**
 * Polls Gmail every 15 s for up to 300 s for verification mail about this company that arrived
 * after the credential's registration started. Mail from the ATS that names another company, or
 * that predates this sign-up, is never used.
 */
export async function waitForVerification(
  ctx: SubmissionContext,
  since: Date,
  opts: { newest?: boolean } = {},
): Promise<Verification> {
  const fromDomains = senderDomains(ctx.job);
  const company = { name: ctx.companyName, job: ctx.job };
  const found = await pollUntil(
    ctx.clock,
    { intervalMs: VERIFY_POLL_S * 1000, capMs: VERIFY_CAP_S * 1000 },
    async () => {
      const messages = fromAllowedDomains(
        await ctx.gmail.search({ fromDomains, after: since }),
        fromDomains,
      );
      const sorted = messages
        .filter((m) => m.receivedAt.getTime() >= since.getTime() && matchesCompany(m, company))
        .sort((a, b) =>
          opts.newest
            ? b.receivedAt.getTime() - a.receivedAt.getTime()
            : a.receivedAt.getTime() - b.receivedAt.getTime(),
        );
      for (const m of sorted) {
        const v = extractVerification(m);
        if (v) return v;
      }
      return null;
    },
  );
  if (!found) throw new SubmissionFailure('verification-timeout', { waited_s: VERIFY_CAP_S });
  return found;
}

const CODE_INPUTS = [
  'input[data-wma-code="1"]',
  'input[aria-label*="security" i]',
  'input[name*="security" i]',
  'input[id*="security" i]',
  'input[autocomplete="one-time-code"]',
  'input[name*="code" i]',
  'input[id*="code" i]',
  'input[name*="verif" i]',
  'input[aria-label*="code" i]',
];

/**
 * Greenhouse's security-code widget is one single-character box per character (8 of them): the
 * visible `maxlength=1` text inputs next to the code prompt. Tags them `data-wma-code-box=<i>` in
 * page order and returns how many there are (0 when the page has no such group).
 */
const TAG_CODE_BOXES = `(() => {
  document.querySelectorAll('[data-wma-code-box]').forEach((e) => e.removeAttribute('data-wma-code-box'));
  const shown = (e) => {
    const r = e.getBoundingClientRect();
    const st = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const boxes = [...document.querySelectorAll('input')].filter(
    (e) =>
      shown(e) &&
      !e.disabled &&
      e.maxLength === 1 &&
      ['text', 'number', 'tel', 'password', ''].includes((e.getAttribute('type') || '').toLowerCase()),
  );
  if (boxes.length < 4) return 0;
  // Keep the largest run that shares a parent with the first box's group.
  const groups = new Map();
  for (const b of boxes) {
    const key = b.parentElement && b.parentElement.parentElement ? b.parentElement.parentElement : b.parentElement;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  let best = [];
  for (const g of groups.values()) if (g.length > best.length) best = g;
  if (best.length < 4) best = boxes;
  best.forEach((b, i) => b.setAttribute('data-wma-code-box', String(i)));
  return best.length;
})()`;

const READ_CODE_BOXES = `(() => [...document.querySelectorAll('[data-wma-code-box]')]
  .sort((a, b) => Number(a.getAttribute('data-wma-code-box')) - Number(b.getAttribute('data-wma-code-box')))
  .map((e) => e.value || '')
  .join(''))()`;

/** Fills a one-box-per-character code widget; true when every box ended up holding its character. */
async function fillCodeBoxes(page: PageLike, code: string): Promise<boolean> {
  if (!page.evaluate) return false;
  const count = Number(await page.evaluate(TAG_CODE_BOXES).catch(() => 0)) || 0;
  if (count < code.length) return false;
  const box = (i: number) => `input[data-wma-code-box="${i}"]`;
  const read = async () => String(await page.evaluate!(READ_CODE_BOXES).catch(() => ''));
  // Typed one key per box, as a person would: the widget's key handlers move the focus along.
  for (let i = 0; i < code.length; i++) {
    await page.press(box(i), code[i]!, { timeout: 2000 }).catch(() => {});
  }
  if ((await read()) !== code) {
    for (let i = 0; i < code.length; i++) {
      await page.fill(box(i), code[i]!, { timeout: 2000 }).catch(() => {});
    }
  }
  if ((await read()) !== code) return false;
  await page.press(box(code.length - 1), 'Enter', { timeout: 2000 }).catch(() => {});
  return true;
}

/** Types the code into the page's verification field and submits it with Enter. */
export async function enterVerificationCode(page: PageLike, code: string): Promise<void> {
  if (await fillCodeBoxes(page, code)) return;
  for (const selector of CODE_INPUTS) {
    try {
      await page.fill(selector, code, { timeout: 2000 });
      await page.press(selector, 'Enter', { timeout: 2000 });
      return;
    } catch {
      // try the next selector
    }
  }
  throw new SubmissionFailure('verification-timeout', { detail: 'code_input_not_found' });
}
