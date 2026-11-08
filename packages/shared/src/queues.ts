/**
 * Queue names and creation options shared by the API (the producer that enqueues on a confirmed
 * slot) and the worker (the consumer). Both sides create the queue, so they must agree on the
 * options; whichever starts first wins, and an exclusive policy is what makes a singleton key
 * exclude a duplicate job while one is queued or running.
 */
export const BOOK_INTERVIEW_JOB = 'book-interview';

/** Event failures are retried; the reply is recorded before the event so it is never re-sent. */
export const BOOK_QUEUE_OPTIONS = {
  policy: 'exclusive',
  retryLimit: 5,
  retryDelay: 60,
  retryBackoff: true,
} as const;

/** Schedules the T-24h and T-1h reminders of a just-confirmed interview, independent of the recruiter reply. */
export const SCHEDULE_REMINDERS_JOB = 'schedule-reminders';

export const SCHEDULE_REMINDERS_QUEUE_OPTIONS = {
  policy: 'exclusive',
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
} as const;

/**
 * Prep-plan generation, one queued-or-running job per interview (singleton key). A job that is
 * interrupted by a worker crash is redelivered; the handler is idempotent (it rewrites the plan).
 */
export const PREP_PLAN_JOB = 'prep-plan';

export const PREP_PLAN_QUEUE_OPTIONS = {
  policy: 'exclusive',
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
} as const;

/** Offer pay-data gathering, one queued-or-running job per application (singleton key). */
export const NEGOTIATION_JOB = 'negotiation';

export const NEGOTIATION_QUEUE_OPTIONS = {
  policy: 'exclusive',
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: true,
} as const;

/** Outbox dedupe keys for follow-on work: the same key means the same unit of work. */
export const prepPlanKey = (interviewId: string) => `prep-plan:${interviewId}`;
export const negotiationKey = (applicationId: string) => `negotiation:${applicationId}`;
/** One reminder schedule per confirmed time of an interview (the generation changes with the time). */
export const scheduleRemindersKey = (interviewId: string, generation: number) =>
  `schedule-reminders:${interviewId}:${generation}`;
