import type { LlmCallRecord, LlmPurpose } from '@wma/shared';
import { estimateCostUsd } from './pricing';
import type { StructuredLlm, StructuredRequest, StructuredResponse } from './types';

/** Receives one record per completed call. Errors it throws are logged, never propagated. */
export type LlmUsageSink = (record: LlmCallRecord) => Promise<void>;

export interface TrackScope {
  purpose: LlmPurpose;
  /** Default application for every call; a request's own `applicationId` wins. */
  applicationId?: string | null;
}

/**
 * Wraps a `StructuredLlm` so every call that returns is recorded with its tokens and estimated
 * cost. A call that throws (transport or API error) reports no usage and is not recorded.
 * Recording failures are logged and swallowed: the ledger must never fail the job it measures.
 */
export function trackLlm(llm: StructuredLlm, sink: LlmUsageSink, scope: TrackScope): StructuredLlm {
  return {
    get model() {
      return llm.model;
    },
    async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse> {
      const started = Date.now();
      const res = await llm.generateStructured(request);
      const model = res.model ?? llm.model;
      const record: LlmCallRecord = {
        purpose: scope.purpose,
        applicationId: request.applicationId ?? scope.applicationId ?? null,
        model,
        prompt: request.prompt,
        usage: res.usage,
        costUsd: estimateCostUsd(model, res.usage),
        durationMs: Date.now() - started,
      };
      try {
        await sink(record);
      } catch (e) {
        console.error('llm usage: could not record call', request.prompt, e);
      }
      return res;
    },
  };
}
