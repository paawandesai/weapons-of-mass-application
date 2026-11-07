import type { ApplicationStatus } from './jobs';
import type { Classification } from './inbox';

export interface StatusChange {
  status: ApplicationStatus;
  closedReason?: 'rejected';
}

/**
 * The only way mail moves a card (design rule 4). Returns the change to apply, or null when the
 * message changes nothing. Forward-only; `closed` is a sink. `pending` moves only on a
 * confirmation (the caller also records confirmation_source = email).
 */
export function nextStatus(
  current: ApplicationStatus,
  classification: Classification,
): StatusChange | null {
  if (current === 'closed') return null;
  switch (classification) {
    case 'rejection':
      return { status: 'closed', closedReason: 'rejected' };
    case 'confirmation':
      return current === 'pending' ? { status: 'applied' } : null;
    case 'interview':
      return current === 'applied' ? { status: 'interviewing' } : null;
    case 'offer':
      return current === 'applied' || current === 'interviewing' ? { status: 'offer' } : null;
    case 'other':
      return null;
  }
}
