import { recordLlmUsage, type TenantHandle } from '@wma/db';
import { trackLlm, type StructuredLlm } from '@wma/llm';
import type { LlmPurpose } from '@wma/shared';

/**
 * The LLM port bound to a user and a purpose: every call it makes lands in `llm_usage` with its
 * tokens and estimated cost. Jobs wrap their injected client with this where the tenant handle and
 * user are known; the rest of the code keeps using the plain `StructuredLlm` port. A call may name
 * its own application through `applicationId` on the request; `applicationId` here is the default.
 */
export function meterLlm(
  handle: TenantHandle,
  userId: string,
  purpose: LlmPurpose,
  llm: StructuredLlm,
  applicationId: string | null = null,
): StructuredLlm {
  return trackLlm(llm, (record) => recordLlmUsage(handle, { userId, ...record }), {
    purpose,
    applicationId,
  });
}
