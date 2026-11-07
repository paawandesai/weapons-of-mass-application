import { CONFIRM_CAP_S, CONFIRM_POLL_S } from './constants';
import { fromAllowedDomains, matchesCompany, mentionsTitle, senderDomains } from './domains';
import { SubmissionFailure } from './failure';
import { pollUntil } from './poll';
import type { PageLike } from './deps';
import type { FormAdapter, InboundMessage, SubmissionContext } from './types';

const PAGE_CONFIRMED = Symbol('page-confirmed');

export type ConfirmationSource = 'page' | 'email';

/**
 * First message after `since` that is about this application: the sender is the company or the
 * ATS naming the company, and it mentions the job title.
 */
export async function findConfirmationEmail(
  ctx: SubmissionContext,
  since: Date,
): Promise<InboundMessage | null> {
  const domains = senderDomains(ctx.job);
  const messages = fromAllowedDomains(
    await ctx.gmail.search({ fromDomains: domains, after: since }),
    domains,
  );
  const company = { name: ctx.companyName, job: ctx.job };
  return (
    messages
      .filter(
        (m) =>
          m.receivedAt.getTime() >= since.getTime() &&
          mentionsTitle(m, ctx.job.title) &&
          matchesCompany(m, company),
      )
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())[0] ?? null
  );
}

/**
 * Rules 10 and 41: on every tick, before any Gmail poll, the page is looked at again: the vendor's
 * confirmation or a thank-you text with no controls left (`adapter.confirmed`), visible validation
 * errors (`form-rejected`); an emailed-code prompt (`beforeCheck`, rule 40) is handled first. Page evidence returns at once and wins over mail. Without
 * any, a Gmail poll runs for up to 600 s; null means neither showed up (`unconfirmed`).
 */
export async function awaitConfirmation(
  ctx: SubmissionContext,
  adapter: FormAdapter,
  page: PageLike,
  since: Date,
  /** Rule 40: an emailed-code prompt is handled here; true when it acted. */
  beforeCheck: () => Promise<boolean> = async () => false,
): Promise<{ source: ConfirmationSource; messageId?: string } | null> {
  const pageConfirmed = async (): Promise<boolean> => {
    // Rule 40 first, as before: a code prompt is not confirmation, and a handled one is looked at again.
    const acted = await beforeCheck();
    if (await adapter.confirmed(page)) return true;
    if (acted) return false;
    const errors = (await adapter.validationErrors?.(page)) ?? [];
    if (errors.length > 0) throw new SubmissionFailure('form-rejected', { errors });
    return false;
  };
  for (let i = 0; i < 3; i++) {
    if (await pageConfirmed()) return { source: 'page' };
    if (i < 2) await ctx.clock.sleep(2000);
  }
  const msg = await pollUntil(
    ctx.clock,
    { intervalMs: CONFIRM_POLL_S * 1000, capMs: CONFIRM_CAP_S * 1000 },
    async () => ((await pageConfirmed()) ? PAGE_CONFIRMED : findConfirmationEmail(ctx, since)),
  );
  if (msg === PAGE_CONFIRMED) return { source: 'page' };
  return msg ? { source: 'email', messageId: msg.id } : null;
}
