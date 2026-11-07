import type { ApplicationStatus } from './jobs';

/**
 * Whether an agent job may still act on an application: everything except a closed card.
 * Jobs that act on an application (submission retry, follow-up, scheduling offers, booking,
 * prep plan, negotiation) check this first and log `skipped_not_actionable` when it is false.
 */
export function isActionable(application: { status: ApplicationStatus }): boolean {
  return application.status !== 'closed';
}

/** Activity-log action written when an agent job skips a closed application. */
export const SKIPPED_NOT_ACTIONABLE = 'skipped_not_actionable';
