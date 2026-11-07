import {
  getEmailThreadByGmailId,
  listApplications,
  listCompaniesByIds,
  listJobsByIds,
  type ApplicationRow,
  type JobRow,
  type TenantHandle,
} from '@wma/db';
import type { StructuredLlm } from '@wma/llm';
import { loadVersionedPrompt } from '../discovery/prompts';
import { matchesCompany } from '../submission/domains';
import type { InboxMessage } from './gmail-reader';
import { InboxLink } from './schemas';

export const INBOX_LINK_PROMPT = 'inbox-link@v1';
const MAX_BODY = 6000;

export interface LinkCandidate {
  application: ApplicationRow;
  job: JobRow;
  companyName: string;
}

export type LinkMethod = 'existing' | 'deterministic' | 'llm';
export interface LinkResult {
  applicationId: string;
  method: LinkMethod;
}

const norm = (s: string) =>
  ` ${s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;

/** The job title appears as a whole phrase in the subject or body. */
export function mentionsJobTitle(msg: InboxMessage, title: string): boolean {
  const needle = norm(title);
  return needle.trim().length > 0 && norm(`${msg.subject}\n${msg.text}`).includes(needle);
}

/** Every application of the user with its job and company name. Tenant-scoped through the handle. */
export async function loadCandidates(
  handle: TenantHandle,
  userId: string,
): Promise<LinkCandidate[]> {
  const apps = await listApplications(handle, userId);
  const jobs = new Map(
    (
      await listJobsByIds(
        handle,
        apps.map((a) => a.jobId),
      )
    ).map((j) => [j.id, j]),
  );
  const companyIds = [...new Set([...jobs.values()].map((j) => j.companyId).filter((x) => !!x))];
  const companies = new Map(
    (await listCompaniesByIds(handle, companyIds as string[])).map((c) => [c.id, c.name]),
  );
  const out: LinkCandidate[] = [];
  for (const application of apps) {
    const job = jobs.get(application.jobId);
    if (!job) continue;
    out.push({
      application,
      job,
      companyName: (job.companyId && companies.get(job.companyId)) || '',
    });
  }
  return out;
}

export type Shortlist =
  | { kind: 'one'; candidate: LinkCandidate }
  | { kind: 'ask'; candidates: LinkCandidate[] }
  | { kind: 'none' };

/**
 * Rule 2, deterministic part, over one pool of applications. Sender domain (or the ATS naming the
 * company) narrows to the company's applications, then the job title picks among them. Exactly
 * one title match among the company's applications links directly. Several matches, or a company
 * with no title mention, go to the model. With no company evidence at all (a recruiter writing
 * from a personal address) the title matches alone are the model's candidates; with no evidence
 * of any kind nothing is asked.
 */
export function shortlist(msg: InboxMessage, pool: LinkCandidate[]): Shortlist {
  const byCompany = pool.filter((c) => matchesCompany(msg, { name: c.companyName, job: c.job }));
  const byTitle = (list: LinkCandidate[]) => list.filter((c) => mentionsJobTitle(msg, c.job.title));
  if (byCompany.length > 0) {
    const both = byTitle(byCompany);
    if (both.length === 1) return { kind: 'one', candidate: both[0]! };
    return { kind: 'ask', candidates: both.length > 1 ? both : byCompany };
  }
  const titles = byTitle(pool);
  return titles.length > 0 ? { kind: 'ask', candidates: titles } : { kind: 'none' };
}

const safe = (s: string) => s.replace(/<\/?(email|candidates)>/gi, '');

/** Asks the model which candidate (if any) the message belongs to; an id outside the list is null. */
export async function askLlmToLink(
  llm: StructuredLlm,
  msg: InboxMessage,
  candidates: LinkCandidate[],
): Promise<string | null> {
  const prompt = loadVersionedPrompt('inbox-link', 'v1');
  const user = [
    '<candidates>',
    ...candidates.map(
      (c) =>
        `- id: ${c.application.id} | company: ${safe(c.companyName)} | title: ${safe(c.job.title)}`,
    ),
    '</candidates>',
    '<email>',
    `From: ${safe(msg.from)}`,
    `Subject: ${safe(msg.subject)}`,
    '',
    safe(msg.text).slice(0, MAX_BODY),
    '</email>',
  ].join('\n');
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await llm.generateStructured({
        prompt: 'inbox-link/v1',
        system: prompt.body,
        user,
        schema: InboxLink,
        maxTokens: 500,
      });
      const parsed = InboxLink.safeParse(res.output);
      if (!parsed.success) {
        lastError = new Error('inbox-link output failed validation');
        continue;
      }
      const id = parsed.data.application_id;
      return id && candidates.some((c) => c.application.id === id) ? id : null;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('inbox-link failed');
}

/**
 * Links a message to one of the user's applications, or returns null. A thread that already has a
 * row keeps its application. Otherwise non-closed applications are matched first; only when none
 * shows any evidence do closed ones get a deterministic-only pass, so mail for a rejected
 * application is still seen (and flagged) without sending the model a pool of dead applications.
 */
export async function linkMessage(
  handle: TenantHandle,
  userId: string,
  msg: InboxMessage,
  llm: StructuredLlm,
): Promise<LinkResult | null> {
  const existing = await getEmailThreadByGmailId(handle, msg.threadId);
  if (existing?.applicationId && existing.userId === userId) {
    return { applicationId: existing.applicationId, method: 'existing' };
  }
  const all = await loadCandidates(handle, userId);
  const open = all.filter((c) => c.application.status !== 'closed');
  const first = shortlist(msg, open);
  if (first.kind === 'one') {
    return { applicationId: first.candidate.application.id, method: 'deterministic' };
  }
  if (first.kind === 'ask') {
    const id = await askLlmToLink(llm, msg, first.candidates);
    return id ? { applicationId: id, method: 'llm' } : null;
  }
  const closed = shortlist(
    msg,
    all.filter((c) => c.application.status === 'closed'),
  );
  return closed.kind === 'one'
    ? { applicationId: closed.candidate.application.id, method: 'deterministic' }
    : null;
}
