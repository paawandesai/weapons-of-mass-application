/**
 * LLM cost accounting. Every model call the worker makes is recorded as one `llm_usage` row with
 * the user it was made for, the purpose (which part of the product), the prompt, the token counts
 * and the estimated cost in USD. The types here are shared by the LLM package (which records), the
 * database package (which stores) and the API (which summarises).
 */

/** Which part of the product a call served. The prompt id gives the finer detail. */
export const LLM_PURPOSES = [
  /** Profile build from the resume, LinkedIn, GitHub, Drive and the survey. */
  'onboarding',
  /** Daily run: company list and the apply/skip judgment per posting. */
  'discovery',
  /** Submitting one application: tailored resume, form answers, CAPTCHA reading. */
  'application',
  /** Linking and classifying recruiter mail. */
  'inbox',
  /** Interview prep plans. */
  'interview_prep',
  /** Offer comparables extraction. */
  'negotiation',
  /** Drafting recruiter outreach emails (never sent without the user's approval). */
  'outreach',
] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];

export const LLM_PURPOSE_LABELS: Record<LlmPurpose, string> = {
  onboarding: 'Onboarding (profile build)',
  discovery: 'Discovery (daily run)',
  application: 'Applications',
  inbox: 'Inbox',
  interview_prep: 'Interview prep',
  negotiation: 'Offer negotiation',
  outreach: 'Recruiter outreach',
};

/** Token counts as the API reports them. Cache fields are 0 when the call used no cache. */
export interface LlmTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** One recorded call, as the tracking wrapper hands it to the store. */
export interface LlmCallRecord {
  purpose: LlmPurpose;
  /** The application the call was made for, when there is one. */
  applicationId: string | null;
  model: string;
  /** Prompt id, e.g. `profile-build/v1`. */
  prompt: string;
  usage: LlmTokenUsage;
  /** Estimated from the price table; null when the model has no known price. */
  costUsd: number | null;
  durationMs: number;
}

/** Aggregate over a set of calls (API shape). */
export interface LlmUsageTotals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** Sum of the estimated costs. Calls with no known price count as 0 and are reported in `unpriced_calls`. */
  cost_usd: number;
  unpriced_calls: number;
}

export interface LlmUsageByPurpose extends LlmUsageTotals {
  purpose: LlmPurpose;
}

export interface LlmUsageByApplication extends LlmUsageTotals {
  application_id: string;
  company: string | null;
  title: string | null;
  status: string;
}

export interface LlmUsageCall {
  id: string;
  at: string;
  purpose: LlmPurpose;
  application_id: string | null;
  model: string;
  prompt: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number | null;
  duration_ms: number;
}

/** `?window=` on `GET /api/usage`. */
export type LlmUsageWindow = 'all' | '7d' | '30d';

/** `GET /api/usage` */
export interface LlmUsagePace {
  /** Model calls in the last 5 hours, the window subscription plans meter. */
  last_5h: LlmUsageTotals;
  /** Model calls since the start of the last 24 hours. */
  last_24h: LlmUsageTotals;
}

export interface LlmUsageResponse {
  /** Which backend serves the model calls (`LLM_BACKEND`): `anthropic` is billed per token, the rest use a subscription. */
  backend: string;
  pace: LlmUsagePace;
  /** Start of the window the totals cover (ISO), or null for all time. */
  since: string | null;
  total: LlmUsageTotals;
  by_purpose: LlmUsageByPurpose[];
  by_application: LlmUsageByApplication[];
  recent: LlmUsageCall[];
}
