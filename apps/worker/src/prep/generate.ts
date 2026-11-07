import {
  activity,
  getApplication,
  getCompany,
  getInterview,
  getJob,
  updateInterview,
  type TenantHandle,
} from '@wma/db';
import type { Http } from '@wma/discovery';
import type { StructuredLlm } from '@wma/llm';
import {
  isActionable,
  PREP_PLAN_JOB,
  SKIPPED_NOT_ACTIONABLE,
  type ProfileDocument,
} from '@wma/shared';
import { loadVersionedPrompt } from '../discovery/prompts';
import { loadProfileDocument, profileForPrompt } from '../discovery/profile-view';
import { PrepPlan } from './schema';
import { meterLlm } from '../llm-usage';
import { gatherResearch } from './research';

export { PREP_PLAN_JOB };
export const PREP_PLAN_PROMPT = 'prep-plan@v1';
const MAX_POSTING_CHARS = 10_000;

export interface PrepPlanDeps {
  llm: StructuredLlm;
  http: Http;
  /** The interviewer's name when the invitation names one. */
  interviewerName?: (handle: TenantHandle, interviewId: string) => Promise<string | null>;
}

export interface PrepPlanInput {
  userId: string;
  interviewId: string;
  approvedVersion: number;
  /** Booking enqueues with this set: a plan that already exists is left alone. */
  onlyIfMissing?: boolean;
}

export type PrepPlanResult =
  | { status: 'not_found' }
  | { status: 'skipped'; reason: 'not_actionable' | 'already_exists' }
  | { status: 'ready' }
  | { status: 'failed' };

const strip = (s: string, tag: string) => s.replace(new RegExp(`</?${tag}>`, 'gi'), '');

/** Builds the user message: all supplied text is data inside tagged blocks. */
export function renderPrepRequest(input: {
  profile: ProfileDocument;
  company: string;
  title: string;
  location: string | null;
  posting: string;
  boardText: string | null;
  interviewer: string | null;
  startsAt: Date | null;
}): string {
  return [
    `Company: ${input.company}`,
    `Job title: ${input.title}`,
    ...(input.location ? [`Location: ${input.location}`] : []),
    ...(input.startsAt ? [`Interview time: ${input.startsAt.toISOString()}`] : []),
    `Interviewer: ${input.interviewer ?? 'not named'}`,
    '<profile>',
    JSON.stringify(profileForPrompt(input.profile)),
    '</profile>',
    '<posting>',
    strip(input.posting, 'posting').slice(0, MAX_POSTING_CHARS),
    '</posting>',
    '<board_page>',
    input.boardText ? strip(input.boardText, 'board_page') : '(the board page could not be read)',
    '</board_page>',
  ].join('\n');
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * Rule 9. Gathers the posting and the company board page, asks for the four sections, and stores
 * the validated JSON as the plan. A failed attempt (call error or output that does not validate)
 * is retried once; two failures set the status to `failed` and write an activity entry. Nothing
 * here touches the application's status.
 */
export async function generatePrepPlan(
  handle: TenantHandle,
  input: PrepPlanInput,
  deps: PrepPlanDeps,
): Promise<PrepPlanResult> {
  const interview = await getInterview(handle, input.interviewId);
  if (!interview || interview.userId !== input.userId) return { status: 'not_found' };
  const application = await getApplication(handle, interview.applicationId);
  if (!application) return { status: 'not_found' };
  const base = { userId: input.userId, applicationId: application.id, actor: 'agent' as const };
  const llm = meterLlm(handle, input.userId, 'interview_prep', deps.llm, application.id);

  if (!isActionable(application)) {
    if (interview.prepPlanStatus === 'pending')
      await updateInterview(handle, interview.id, { prepPlanStatus: null });
    await activity.logActivity(handle, {
      ...base,
      action: SKIPPED_NOT_ACTIONABLE,
      detail: { job: PREP_PLAN_JOB, interview_id: interview.id },
    });
    return { status: 'skipped', reason: 'not_actionable' };
  }
  if (input.onlyIfMissing && interview.prepPlanStatus === 'ready')
    return { status: 'skipped', reason: 'already_exists' };

  await updateInterview(handle, interview.id, { prepPlanStatus: 'pending' });

  const job = await getJob(handle, application.jobId);
  const company = job?.companyId ? await getCompany(handle, job.companyId) : null;
  const profile = await loadProfileDocument(handle, input.userId, input.approvedVersion);
  const prompt = loadVersionedPrompt('prep-plan', 'v1');
  const research = await gatherResearch(deps.http, company?.boardUrl ?? null);
  const interviewer = deps.interviewerName
    ? await deps.interviewerName(handle, interview.id).catch(() => null)
    : null;
  const user = renderPrepRequest({
    profile,
    company: company?.name ?? 'the company',
    title: job?.title ?? 'the role',
    location: job?.location ?? null,
    posting: job?.description ?? '(no description was captured for this posting)',
    boardText: research.boardText,
    interviewer,
    startsAt: interview.startsAt,
  });

  let lastError = 'unknown';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await llm.generateStructured({
        prompt: 'prep-plan/v1',
        system: prompt.body,
        user,
        schema: PrepPlan,
        maxTokens: 6000,
      });
      const parsed = PrepPlan.safeParse(res.output);
      if (!parsed.success) throw new Error('the plan did not match the expected sections');
      // Without a named interviewer there is nothing to say about one.
      const plan: PrepPlan = {
        ...parsed.data,
        interviewer_background: interviewer ? parsed.data.interviewer_background : null,
      };
      await updateInterview(handle, interview.id, {
        prepPlan: JSON.stringify(plan),
        prepPlanStatus: 'ready',
      });
      await activity.logActivity(handle, {
        ...base,
        action: 'prep_plan_ready',
        detail: {
          interview_id: interview.id,
          prompt_version: prompt.id,
          model: llm.model,
          attempt,
          board_page_read: research.boardText !== null,
        },
      });
      return { status: 'ready' };
    } catch (e) {
      lastError = errorText(e);
    }
  }
  await updateInterview(handle, interview.id, { prepPlanStatus: 'failed' });
  await activity.logActivity(handle, {
    ...base,
    action: 'prep_plan_failed',
    detail: { interview_id: interview.id, attempts: 2, error: lastError },
  });
  return { status: 'failed' };
}
