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
