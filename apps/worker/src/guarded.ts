import {
  activity,
  ProfileNotApprovedError,
  requireApprovedProfile,
  type TenantHandle,
} from '@wma/db';

export interface JobContext {
  handle: TenantHandle;
  userId: string;
}

export interface GuardedContext extends JobContext {
  /** The approved profile version the job must act on. */
  approvedVersion: number;
}

export type GuardResult<R> =
  { ran: true; result: R } | { ran: false; reason: 'profile_not_approved' };

/**
 * Wraps a job handler with the approval gate (tenancy rule 9): the check runs first; for a user
 * without an approved profile one `profile_not_approved` activity entry is written and the
 * handler is never called. Every job except profile.build must be registered through this.
 */
export function guardedJob<R>(
  name: string,
  handler: (ctx: GuardedContext) => Promise<R>,
): (ctx: JobContext) => Promise<GuardResult<R>> {
  return async (ctx) => {
    let approvedVersion: number;
    try {
      approvedVersion = await requireApprovedProfile(ctx.handle, ctx.userId);
    } catch (e) {
      if (!(e instanceof ProfileNotApprovedError)) throw e;
      await activity.logActivity(ctx.handle, {
        userId: ctx.userId,
        actor: 'agent',
        action: 'profile_not_approved',
        detail: { job: name },
      });
      return { ran: false, reason: 'profile_not_approved' };
    }
    return { ran: true, result: await handler({ ...ctx, approvedVersion }) };
  };
}
