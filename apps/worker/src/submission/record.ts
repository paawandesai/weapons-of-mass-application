import { activity, updateApplication, type ApplicationPatch } from '@wma/db';
import type { SubmissionContext } from './types';

export interface Step {
  action: string;
  detail?: Record<string, unknown>;
  patch?: ApplicationPatch;
}

/**
 * Applies a state change and writes its activity entry in one transaction, so a crash between
 * steps leaves the last entry as the evidence. Keeps `ctx.application` current.
 */
export async function recordStep(ctx: SubmissionContext, step: Step): Promise<void> {
  const row = await ctx.handle.transaction(async (h) => {
    const updated = await updateApplication(h, ctx.application.id, step.patch ?? {});
    await activity.logActivity(h, {
      userId: ctx.userId,
      applicationId: ctx.application.id,
      actor: 'agent',
      action: step.action,
      detail: step.detail,
    });
    return updated;
  });
  if (row) ctx.application = row;
}
