import { activity, type TenantHandle } from '@wma/db';

export type DigestFlagKind =
  'activity_on_closed' | 'booking_link' | 'compensation' | 'no_free_slot';

export interface DigestFlag {
  userId: string;
  applicationId: string | null;
  kind: DigestFlagKind;
  detail: Record<string, unknown>;
}

/** Activity action the digest reads for items that need the user's attention (design rule 14). */
export const DIGEST_FLAG_ACTION = 'digest_flag';

/** Writes one `digest_flag` entry; the digest lists it under the next day's items. */
export async function flagDigest(handle: TenantHandle, flag: DigestFlag): Promise<void> {
  await activity.logActivity(handle, {
    userId: flag.userId,
    applicationId: flag.applicationId,
    actor: 'agent',
    action: DIGEST_FLAG_ACTION,
    detail: { kind: flag.kind, ...flag.detail },
  });
}
