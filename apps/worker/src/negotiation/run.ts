import {
  activity,
  getApplication,
  getCompany,
  getJob,
  setNegotiation,
  type TenantHandle,
} from '@wma/db';
import type { StructuredLlm } from '@wma/llm';
import { isActionable, NEGOTIATION_JOB, SKIPPED_NOT_ACTIONABLE } from '@wma/shared';
import { meterLlm } from '../llm-usage';
import { loadProfileDocument } from '../discovery/profile-view';
import { loadVersionedPrompt } from '../discovery/prompts';
import type { LevelsFetcher } from './levels';
import {
  COMPARABLES_SOURCE,
  ComparablesExtract,
  type Comparable,
  type NegotiationData,
} from './schema';

export { NEGOTIATION_JOB };
export const COMPARABLES_PROMPT = 'comparables-extract@v1';

export interface NegotiationDeps {
  llm: StructuredLlm;
  fetchPage: LevelsFetcher;
  now?: () => Date;
}

export interface NegotiationInput {
  userId: string;
  applicationId: string;
  approvedVersion: number;
}

export type NegotiationResult =
  | { status: 'not_found' }
  | { status: 'skipped'; reason: 'not_actionable' | 'not_offer' }
  | { status: 'written'; comparables: number; error: string | null };

/** Page text goes in a tagged block; the closing tag cannot be forged from inside it. */
const safe = (s: string) => s.replace(/<\/?page>/gi, '');

/** Reads the page text into comparables. One retry for a failed call or an invalid answer. */
export async function extractComparables(
  llm: StructuredLlm,
  query: { title: string; location: string | null },
  pageText: string,
  retrievedAt: Date,
): Promise<Comparable[]> {
  const prompt = loadVersionedPrompt('comparables-extract', 'v1');
  const user = [
    `Title: ${query.title}`,
    `Location: ${query.location ?? 'not stated'}`,
    '<page>',
    safe(pageText),
    '</page>',
  ].join('\n');
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await llm.generateStructured({
        prompt: 'comparables-extract/v1',
        system: prompt.body,
        user,
        schema: ComparablesExtract,
        maxTokens: 3000,
      });
      const parsed = ComparablesExtract.safeParse(res.output);
      if (!parsed.success) throw new Error('comparables output failed validation');
      return parsed.data.comparables.map((c) => ({
        source: COMPARABLES_SOURCE,
        ...c,
        retrieved_at: retrievedAt.toISOString(),
      }));
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error('comparables extraction failed');
}

/**
 * Rule 10. Writes the offer panel data for an application that is in Offer: the posted range from
 * the job, the salary floor from the approved profile, and levels.fyi comparables for the title
 * and location. A failed or empty lookup still writes the range and floor and logs
 * `comparables_failed`. Reads and writes only; it never sends, drafts or queues a message.
 */
export async function runNegotiation(
  handle: TenantHandle,
  input: NegotiationInput,
  deps: NegotiationDeps,
): Promise<NegotiationResult> {
  const now = deps.now ?? (() => new Date());
  const application = await getApplication(handle, input.applicationId);
  if (!application || application.userId !== input.userId) return { status: 'not_found' };
  const base = { userId: input.userId, applicationId: application.id, actor: 'agent' as const };

  if (!isActionable(application)) {
    await activity.logActivity(handle, {
      ...base,
      action: SKIPPED_NOT_ACTIONABLE,
      detail: { job: NEGOTIATION_JOB },
    });
    return { status: 'skipped', reason: 'not_actionable' };
  }
  if (application.status !== 'offer') return { status: 'skipped', reason: 'not_offer' };

  const job = await getJob(handle, application.jobId);
  const company = job?.companyId ? await getCompany(handle, job.companyId) : null;
  const profile = await loadProfileDocument(handle, input.userId, input.approvedVersion);
  const fetchedAt = now();
  const query = { title: job?.title ?? '', location: job?.location ?? null };

  let comparables: Comparable[] = [];
  let error: string | null = null;
  let reason = '';
  try {
    const text = await deps.fetchPage(query);
    try {
      comparables = await extractComparables(
        meterLlm(handle, input.userId, 'negotiation', deps.llm, input.applicationId),
        query,
        text,
        fetchedAt,
      );
      if (comparables.length === 0) {
        error = 'no_data';
        reason = 'the page showed no pay figures for this title and location';
      }
    } catch (e) {
      error = 'extract_failed';
      reason = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
  } catch (e) {
    error = 'fetch_failed';
    reason = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }

  const data: NegotiationData = {
    posted_min: job?.payMin ?? null,
    posted_max: job?.payMax ?? null,
    currency: job?.currency ?? null,
    floor: profile.survey.salary_floor ?? null,
    comparables,
    fetched_at: fetchedAt.toISOString(),
    error,
  };
  await setNegotiation(handle, application.id, data);
  if (error) {
    await activity.logActivity(handle, {
      ...base,
      action: 'comparables_failed',
      detail: { error, reason, company: company?.name ?? null, source: COMPARABLES_SOURCE },
    });
  }
  await activity.logActivity(handle, {
    ...base,
    action: 'negotiation_ready',
    detail: { comparables: comparables.length, prompt_version: COMPARABLES_PROMPT },
  });
  return { status: 'written', comparables: comparables.length, error };
}
