/** Waits are wall-clock seconds measured with the injected clock. */
export const HUMAN_WINDOW_S = 900;
export const WORKER_POLL_S = 5;
export const VERIFY_POLL_S = 15;
export const VERIFY_CAP_S = 300;
export const CONFIRM_POLL_S = 15;
export const CONFIRM_CAP_S = 600;
export const MAX_AGENT_ATTEMPTS = 3;
export const MAX_HUMAN_ATTEMPTS = 3;
export const PASSWORD_LENGTH = 24;
export const FOLLOW_UP_DELAY_DAYS = 7;
/** Failures allowed before the application is closed: first failure retries, the second closes. */
export const MAX_FAILED_ATTEMPTS = 2;
export const SUBMIT_CONCURRENCY = 2;

export const SUBMIT_APPLICATION_JOB = 'submit-application';
/** Enqueued by a successful submission; consumed by the inbox wave. */
export const FOLLOW_UP_JOB = 'follow-up';

/**
 * Send options for submit-application jobs. A job only fails to pg-boss when no application
 * outcome was committed (database outage, profile load), so retrying it is always safe.
 * `singletonKey` is added by the sender (the application id).
 */
export const SUBMIT_QUEUE_OPTIONS = {
  retryLimit: 5,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 60 * 60,
} as const;
