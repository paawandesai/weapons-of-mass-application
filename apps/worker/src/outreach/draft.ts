import {
  activity,
  createOutreachDraft,
  getApplication,
  getCompany,
  getJob,
  type OutreachDraftRow,
  type TenantHandle,
} from '@wma/db';
import type { StructuredLlm } from '@wma/llm';
import { moneyGuard, type ProfileDocument } from '@wma/shared';
import { loadProfileDocument, profileForPrompt } from '../discovery/profile-view';
import { loadVersionedPrompt } from '../discovery/prompts';
import { meterLlm } from '../llm-usage';
import { OutreachDraft } from './schema';

/** The contact the user entered. The app finds no one itself. */
export interface OutreachContact {
  name: string;
  title?: string | null;
  profileUrl?: string | null;
  email: string;
}

export interface OutreachDraftInput {
  userId: string;
  applicationId: string;
  approvedVersion: number;
  contact: OutreachContact;
}

export type OutreachDraftResult =
  | { status: 'drafted'; draft: OutreachDraftRow }
  | { status: 'not_found' }
  | { status: 'failed'; reason: string };

const MAX_POSTING_CHARS = 8_000;
const strip = (s: string, tag: string) => s.replace(new RegExp(`</?${tag}>`, 'gi'), '');
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export function renderOutreachRequest(input: {
  profile: ProfileDocument;
  company: string;
  title: string;
  posting: string;
  contact: OutreachContact;
}): string {
  return [
    `Company: ${input.company}`,
    `Job title: ${input.title}`,
    '<contact>',
    strip(`Name: ${input.contact.name}`, 'contact'),
    ...(input.contact.title ? [strip(`Title: ${input.contact.title}`, 'contact')] : []),
    '</contact>',
    '<profile>',
    JSON.stringify(profileForPrompt(input.profile)),
    '</profile>',
    '<posting>',
    strip(input.posting, 'posting').slice(0, MAX_POSTING_CHARS),
    '</posting>',
  ].join('\n');
}

/**
 * Drafts the email and stores it in `draft`. Nothing is sent: the draft waits for the user's
 * approval. A reply that fails validation, or that contains money text (which the send guard would
 * block anyway), is retried once; two failures are logged and nothing is stored.
 */
export async function generateOutreachDraft(
  handle: TenantHandle,
  input: OutreachDraftInput,
  deps: { llm: StructuredLlm },
): Promise<OutreachDraftResult> {
  const application = await getApplication(handle, input.applicationId);
  if (!application || application.userId !== input.userId) return { status: 'not_found' };
  const job = await getJob(handle, application.jobId);
  const company = job?.companyId ? await getCompany(handle, job.companyId) : null;
  const profile = await loadProfileDocument(handle, input.userId, input.approvedVersion);
  const prompt = loadVersionedPrompt('outreach-draft', 'v1');
  const llm = meterLlm(handle, input.userId, 'outreach', deps.llm, application.id);
  const request = renderOutreachRequest({
    profile,
    company: company?.name ?? 'the company',
    title: job?.title ?? 'the role',
    posting: job?.description ?? '(no description was captured for this posting)',
    contact: input.contact,
  });

  let lastError = 'unknown';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await llm.generateStructured({
        prompt: 'outreach-draft/v1',
        system: prompt.body,
        user: request,
        schema: OutreachDraft,
        maxTokens: 1500,
      });
      const parsed = OutreachDraft.safeParse(res.output);
      if (!parsed.success) throw new Error('the draft did not match the expected fields');
      const d = parsed.data;
      const money = await moneyGuard.check({
        userId: input.userId,
        to: input.contact.email,
        subject: d.subject,
        text: `${d.body}\n${d.linkedin_note}`,
        html: '',
      });
      if (!money.ok) throw new Error(`the draft mentions money (${money.reason})`);
      const draft = await createOutreachDraft(handle, {
        userId: input.userId,
        applicationId: application.id,
        contactName: input.contact.name,
        contactTitle: input.contact.title ?? null,
        contactProfileUrl: input.contact.profileUrl ?? null,
        toAddress: input.contact.email,
        subject: d.subject,
        bodyText: d.body,
        linkedinNote: d.linkedin_note,
      });
      await activity.logActivity(handle, {
        userId: input.userId,
        applicationId: application.id,
        actor: 'agent',
        action: 'outreach_drafted',
        detail: { draft_id: draft.id, prompt_version: prompt.id, attempt },
      });
      return { status: 'drafted', draft };
    } catch (e) {
      lastError = errorText(e);
    }
  }
  await activity.logActivity(handle, {
    userId: input.userId,
    applicationId: application.id,
    actor: 'agent',
    action: 'outreach_draft_failed',
    detail: { attempts: 2, error: lastError },
  });
  return { status: 'failed', reason: lastError };
}
