import { CONFIRM_CAP_S, CONFIRM_POLL_S } from './constants';
import { fromAllowedDomains, matchesCompany, mentionsTitle, senderDomains } from './domains';
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
 * Rule 10: the vendor's marker on the page (checked a few times while it loads), else a Gmail
 * poll for up to 600 s. Returns null when neither shows up, which the job records as `unconfirmed`.
 */
export async function awaitConfirmation(
  ctx: SubmissionContext,
  adapter: FormAdapter,
  page: PageLike,
  since: Date,
  /** Runs before each look at the page (rule 40: an emailed-code prompt is handled here); true when it acted. */
  beforeCheck: () => Promise<boolean> = async () => false,
): Promise<{ source: ConfirmationSource; messageId?: string } | null> {
  for (let i = 0; i < 3; i++) {
    await beforeCheck();
    if (await adapter.confirmed(page)) return { source: 'page' };
    if (i < 2) await ctx.clock.sleep(2000);
  }
  const msg = await pollUntil(
    ctx.clock,
    { intervalMs: CONFIRM_POLL_S * 1000, capMs: CONFIRM_CAP_S * 1000 },
    async () => {
      if ((await beforeCheck()) && (await adapter.confirmed(page))) return PAGE_CONFIRMED;
      return findConfirmationEmail(ctx, since);
    },
  );
  if (msg === PAGE_CONFIRMED) return { source: 'page' };
  return msg ? { source: 'email', messageId: msg.id } : null;
}
