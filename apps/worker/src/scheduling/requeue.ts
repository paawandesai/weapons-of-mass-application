import { listInterviewsAwaitingBooking, type TenantHandle } from '@wma/db';

/**
 * Re-enqueues booking for confirmed interviews whose reply or event is not recorded (the
 * confirmation committed but the enqueue was lost). The singleton key makes a duplicate a no-op.
 * Returns how many were handed to `enqueue`.
 */
export async function requeueUnbookedInterviews(
  handle: TenantHandle,
  userId: string,
  enqueue: (data: { tenantId: string; userId: string; interviewId: string }) => Promise<void>,
): Promise<number> {
  let n = 0;
  for (const i of await listInterviewsAwaitingBooking(handle, userId)) {
    await enqueue({ tenantId: handle.tenantId, userId, interviewId: i.id });
    n++;
  }
  return n;
}
