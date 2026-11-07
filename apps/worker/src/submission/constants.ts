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

/**
 * The follow-up delay in milliseconds. `GAUNTLET_TIME_SCALE` (demo/gauntlet only) divides it so the
 * seven-day follow-up fires in minutes during a golden run; unset or 1 is real time. Only this
 * delay is compressed: reminders and the digest keep their clocks.
 */
export function followUpDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const scale = Number(env.GAUNTLET_TIME_SCALE ?? 1);
  if (!Number.isFinite(scale) || scale < 1)
    throw new Error('GAUNTLET_TIME_SCALE must be a number >= 1');
  return Math.round((FOLLOW_UP_DELAY_DAYS * 24 * 60 * 60 * 1000) / scale);
}
/** Failures allowed before the application is closed: first failure retries, the second closes. */
export const MAX_FAILED_ATTEMPTS = 2;
export const SUBMIT_CONCURRENCY = 2;

export const SUBMIT_APPLICATION_JOB = 'submit-application';
/** The constant lives with its job; re-exported so submission code keeps one import. */
export { FOLLOW_UP_JOB } from '../jobs/follow-up';

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

/** The browser context's time zone when the user's is unknown. */
export const DEFAULT_TIMEZONE = 'America/Los_Angeles';
