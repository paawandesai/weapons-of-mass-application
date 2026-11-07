import {
  activity,
  getApplication,
  getInterview,
  lockInterview,
  markFollowOnDispatched,
  recordFollowOnJob,
  updateInterview,
  type InterviewRow,
  type TenantHandle,
} from '@wma/db';
import {
  isActionable,
  negotiationKey,
  NEGOTIATION_JOB,
  NEGOTIATION_QUEUE_OPTIONS,
  PREP_PLAN_JOB,
  PREP_PLAN_QUEUE_OPTIONS,
  prepPlanKey,
  SKIPPED_NOT_ACTIONABLE,
} from '@wma/shared';
import { getBoss } from './queue';
import { feedbackView, type FeedbackView } from './feedback';

export { NEGOTIATION_JOB, PREP_PLAN_JOB };

export interface PrepPlanRequest {
  tenantId: string;
  userId: string;
  interviewId: string;
}

export interface NegotiationRequest {
  tenantId: string;
  userId: string;
  applicationId: string;
}

/** Hands plan generation and pay-data gathering to the worker. Injected in tests. */
export interface PrepQueue {
  /** False when the queue declined the job because an identical one is still outstanding. */
  enqueuePrepPlan(data: PrepPlanRequest): Promise<boolean>;
  enqueueNegotiation(data: NegotiationRequest): Promise<boolean>;
}

export const pgBossPrepQueue: PrepQueue = {
  async enqueuePrepPlan(data) {
    const b = await getBoss();
    // The same exclusive policy as the worker's queue, whichever side creates it first.
    await b.createQueue(PREP_PLAN_JOB, PREP_PLAN_QUEUE_OPTIONS);
    const id = await b.send(PREP_PLAN_JOB, data, {
      singletonKey: prepPlanKey(data.interviewId),
      ...PREP_PLAN_QUEUE_OPTIONS,
    });
    return id !== null;
  },
  async enqueueNegotiation(data) {
    const b = await getBoss();
    await b.createQueue(NEGOTIATION_JOB, NEGOTIATION_QUEUE_OPTIONS);
    const id = await b.send(NEGOTIATION_JOB, data, {
      singletonKey: negotiationKey(data.applicationId),
      ...NEGOTIATION_QUEUE_OPTIONS,
    });
    return id !== null;
  },
};

export interface PrepPlanView {
  likely_questions: { question: string; answer_outline: string }[];
  topics: string[];
  company_research: string;
  interviewer_background: string | null;
}

/** The stored plan is JSON text; anything that does not parse to the four sections is treated as absent. */
export function parsePrepPlan(text: string | null): PrepPlanView | null {
  if (!text) return null;
  try {
    const p = JSON.parse(text) as Partial<PrepPlanView>;
    if (
      !p ||
      !Array.isArray(p.likely_questions) ||
      !Array.isArray(p.topics) ||
      typeof p.company_research !== 'string'
    )
      return null;
    return {
      likely_questions: p.likely_questions,
      topics: p.topics,
      company_research: p.company_research,
      interviewer_background:
        typeof p.interviewer_background === 'string' ? p.interviewer_background : null,
    };
  } catch {
    return null;
  }
}

export interface InterviewView {
  id: string;
  application_id: string;
  starts_at: string | null;
  ends_at: string | null;
  confirmed: boolean;
  prep_plan_status: InterviewRow['prepPlanStatus'];
  prep_plan: PrepPlanView | null;
  feedback: FeedbackView | null;
}

export function toInterviewView(row: InterviewRow): InterviewView {
  return {
    id: row.id,
    application_id: row.applicationId,
    starts_at: row.startsAt ? row.startsAt.toISOString() : null,
    ends_at: row.endsAt ? row.endsAt.toISOString() : null,
    confirmed: row.confirmedAt !== null,
    prep_plan_status: row.prepPlanStatus,
    prep_plan: row.prepPlanStatus === 'ready' ? parsePrepPlan(row.prepPlan) : null,
    feedback: feedbackView(row.feedback),
  };
}

export type RequestPrepResult =
  { status: 'not_found' } | { status: 'not_actionable' } | { status: 'pending'; enqueued: boolean };

/**
 * On-demand plan generation. The interview row is locked while the status is read and set to
 * `pending`, so two requests cannot both enqueue; a request while the plan is already pending
 * changes nothing and enqueues nothing.
 */
export async function requestPrepPlan(
  handle: TenantHandle,
  userId: string,
  interviewId: string,
  queue: PrepQueue,
): Promise<RequestPrepResult> {
  const interview = await getInterview(handle, interviewId);
  if (!interview || interview.userId !== userId) return { status: 'not_found' };
  const application = await getApplication(handle, interview.applicationId);
  if (!application) return { status: 'not_found' };
  if (!isActionable(application)) {
    await activity.logActivity(handle, {
      userId,
      applicationId: application.id,
      actor: 'agent',
      action: SKIPPED_NOT_ACTIONABLE,
      detail: { job: PREP_PLAN_JOB, interview_id: interview.id },
    });
    return { status: 'not_actionable' };
  }

  // The pending state and the outbox row commit together, so a pending plan always has work
  // recorded for the reconciler even if this process dies before the direct enqueue below.
  const data: PrepPlanRequest = { tenantId: handle.tenantId, userId, interviewId };
  const previous = await handle.transaction(async (h) => {
    const locked = await lockInterview(h, interviewId);
    if (!locked) return 'missing' as const;
    if (locked.prepPlanStatus === 'pending') return 'pending' as const;
    await updateInterview(h, interviewId, { prepPlanStatus: 'pending' });
    await recordFollowOnJob(h, {
      userId,
      kind: PREP_PLAN_JOB,
      payload: data as unknown as Record<string, unknown>,
      dedupeKey: prepPlanKey(interviewId),
    });
    return 'requested' as const;
  });
  if (previous === 'missing') return { status: 'not_found' };
  if (previous === 'pending') return { status: 'pending', enqueued: false };

  // Fast path. A queue that is down is not an error: the outbox row is dispatched later.
  let accepted = false;
  try {
    accepted = await queue.enqueuePrepPlan(data);
    await markFollowOnDispatched(handle, prepPlanKey(interviewId));
  } catch {
    accepted = false;
  }
  return { status: 'pending', enqueued: accepted };
}

export type RequestNegotiationResult =
  { status: 'not_found' } | { status: 'not_offer' } | { status: 'queued'; enqueued: boolean };

/** Starts the pay-data job for a card that is in Offer (for cards moved there by hand). */
export async function requestNegotiation(
  handle: TenantHandle,
  userId: string,
  applicationId: string,
  queue: PrepQueue,
): Promise<RequestNegotiationResult> {
  const application = await getApplication(handle, applicationId);
  if (!application || application.userId !== userId) return { status: 'not_found' };
  if (application.status !== 'offer') return { status: 'not_offer' };
  const data: NegotiationRequest = { tenantId: handle.tenantId, userId, applicationId };
  await recordFollowOnJob(handle, {
    userId,
    kind: NEGOTIATION_JOB,
    payload: data as unknown as Record<string, unknown>,
    dedupeKey: negotiationKey(applicationId),
  });
  try {
    const enqueued = await queue.enqueueNegotiation(data);
    await markFollowOnDispatched(handle, negotiationKey(applicationId));
    return { status: 'queued', enqueued };
  } catch {
    // Recorded above: the reconciler sends it.
    return { status: 'queued', enqueued: false };
  }
}
