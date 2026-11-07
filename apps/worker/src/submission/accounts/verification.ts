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
        .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
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
  'input[autocomplete="one-time-code"]',
  'input[name*="code" i]',
  'input[id*="code" i]',
  'input[name*="verif" i]',
  'input[aria-label*="code" i]',
];

/** Types the code into the page's verification field and submits it with Enter. */
export async function enterVerificationCode(page: PageLike, code: string): Promise<void> {
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
