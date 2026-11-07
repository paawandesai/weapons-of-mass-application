export const REMINDER_JOB = 'reminder';
export const DIGEST_JOB = 'digest';
/** Hourly: enqueues a digest for every user whose local hour is their digest hour. */
export const DIGEST_TICK_JOB = 'digest-tick';

/** Seconds before the interview start at which a reminder goes out (design rule 13). */
export const REMINDER_OFFSETS_S = [86_400, 3_600] as const;
export type ReminderOffset = (typeof REMINDER_OFFSETS_S)[number];

/** A failed digest send is retried three times, ten minutes apart: inside the hour. */
export const DIGEST_RETRY_LIMIT = 3;
export const DIGEST_RETRY_DELAY_S = 600;

export const DIGEST_LOOKBACK_FIRST_MS = 24 * 3_600_000;
export const UPCOMING_WINDOW_MS = 7 * 24 * 3_600_000;
