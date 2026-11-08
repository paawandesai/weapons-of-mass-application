import type {
  ApplicationStatus,
  BuildStatus,
  Connection,
  ConnectionKind,
  LlmUsageResponse,
  LlmUsageTotals,
  LlmUsageWindow,
  MeResponse,
  DemoMailboxResponse,
  ProfileDocument,
  ProfileResponse,
  SurveyAnswers,
} from '@wma/shared';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, message: string, status = 0, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Please try again.';
}

interface RequestOptions {
  json?: unknown;
  form?: FormData;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const init: RequestInit = { method, credentials: 'include', headers: {} };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  } else if (opts.form) {
    init.body = opts.form;
  }

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('network', 'Could not reach the server. Check your connection.');
  }

  if (res.status === 204) return undefined as T;

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const b = (body ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof b.code === 'string' ? b.code : `http_${res.status}`;
    const message =
      typeof b.message === 'string' && b.message
        ? b.message
        : `The request failed (${res.status}).`;
    throw new ApiError(code, message, res.status, body);
  }
  return body as T;
}

export type BoardColumnId = 'applied' | 'interviewing' | 'offer' | 'closed';

export interface BoardCardData {
  id: string;
  status: ApplicationStatus;
  badge: 'pending' | null;
  company: string | null;
  title: string | null;
  location_mode: string | null;
  pay_min: number | null;
  pay_max: number | null;
  currency: string | null;
  applied_at: string | null;
  last_activity_at: string;
}

export interface BoardData {
  columns: Record<BoardColumnId, BoardCardData[]>;
}

export interface SearchResult {
  application_id: string;
  company: string;
  title: string | null;
  status: ApplicationStatus;
  column: BoardColumnId;
  badge: 'pending' | null;
}

export interface SlotDetail {
  id: string;
  starts_at: string;
  ends_at: string;
  state: 'confirmed' | 'invalidated' | 'expired' | 'open';
}

export interface InterviewDetail {
  id: string;
  thread_id: string;
  starts_at: string | null;
  ends_at: string | null;
  confirmed_at: string | null;
  booked: boolean;
  slots: SlotDetail[];
  prep_plan_status: 'pending' | 'ready' | 'failed' | null;
  prep_plan: string | null;
  feedback: unknown;
}

export interface ThreadDetail {
  id: string;
  subject: string | null;
  kind: string;
  compensation_flag: boolean;
  booking_link: string | null;
  last_message_at: string;
  messages: { id: string; from: string; at: string; body: string }[];
}

export interface ActivityEntryData {
  id: string;
  at: string;
  actor: 'agent' | 'user';
  action: string;
  detail: Record<string, unknown>;
}

export interface ApplicationDetail {
  id: string;
  status: ApplicationStatus;
  pending_reason: string | null;
  closed_reason: string | null;
  applied_at: string | null;
  last_activity_at: string;
  job: {
    id: string;
    title: string;
    url: string;
    ats: string | null;
    company: string | null;
    location: string | null;
    location_mode: string | null;
    pay_min: number | null;
    pay_max: number | null;
    currency: string | null;
    posted_at: string | null;
  } | null;
  decision: { rationale: string; seniority: string | null } | null;
  resume: { ref: string } | null;
  form_answers: {
    question: string;
    status: 'filled' | 'blank' | 'skipped' | 'attached';
    value: unknown;
    skipped?: string;
    /** Set when the agent inferred or guessed the answer (rule 30). */
    source?: 'inferred' | 'guessed';
  }[];
  unmet_requirements: string[];
  threads: ThreadDetail[];
  outgoing: { id: string; kind: string; subject: string; state: string; sent_at: string | null }[];
  activity: ActivityEntryData[];
  activity_next: string | null;
  interviews: InterviewDetail[];
  prep_plan: {
    interview_id: string;
    status: 'pending' | 'ready' | 'failed' | null;
    text: string | null;
  } | null;
  feedback: unknown;
  negotiation: unknown;
}

export interface DriveFolder {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------------------------
// Run view, interviews (feedback, prep plan) and negotiation
// ---------------------------------------------------------------------------------------------

export type RunStatus = 'running' | 'finished' | 'short_day' | 'failed' | 'skipped_no_profile';

export interface RunSummary {
  id: string;
  date: string;
  trigger: string;
  status: RunStatus;
  step: string | null;
  target: number;
  started_at: string;
  ended_at: string | null;
  counts: Record<string, number | undefined>;
  short_day: boolean;
  shortfall: number;
  error: string | null;
}

export interface RunCandidateView {
  rank: number | null;
  title: string;
  company: string;
  url: string;
  apply: boolean | null;
  rationale: string | null;
  selected: boolean;
  exclusion_reason: string | null;
}

export interface CurrentRun {
  run: RunSummary | null;
  candidates: RunCandidateView[];
  next_cursor: string | null;
  has_more: boolean;
  /** When no run exists yet: the next scheduled start, or null when the profile is not approved. */
  next_run_at: string | null;
}

export interface Feedback {
  notes: string;
  relayed: string;
  rating: number | null;
  submitted_at: string;
  updated_at: string;
}
export interface FeedbackInput {
  notes: string;
  relayed: string;
  rating: number | null;
}

export interface PrepPlan {
  likely_questions: { question: string; answer_outline: string }[];
  topics: string[];
  company_research: string;
  interviewer_background: string | null;
}
export type PrepPlanStatus = 'pending' | 'ready' | 'failed';

export interface InterviewView {
  id: string;
  application_id: string;
  starts_at: string | null;
  ends_at: string | null;
  confirmed: boolean;
  booked_via: 'email' | 'manual' | null;
  prep_plan_status: PrepPlanStatus | null;
  prep_plan: PrepPlan | null;
  feedback: Feedback | null;
}

export interface Comparable {
  source: string;
  title: string;
  level: string | null;
  location: string | null;
  currency: string | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  sample_size: number | null;
  retrieved_at: string;
}
export interface NegotiationView {
  posted_min: number | null;
  posted_max: number | null;
  currency: string | null;
  floor: number | null;
  comparables: Comparable[];
  fetched_at: string | null;
  error: string | null;
}
export interface ApplicationExtras {
  interviews: InterviewView[];
  negotiation: NegotiationView | null;
  /** What the agent spent on this application; absent from older servers. */
  llm_usage?: LlmUsageTotals;
}

export const api = {
  me: () => request<MeResponse>('GET', '/api/me'),
  signOut: () => request<void>('POST', '/auth/signout'),
  demoMailbox: () => request<DemoMailboxResponse>('GET', '/api/admin/demo-mailbox'),

  uploadResume: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ connection: Connection }>('POST', '/api/sources/resume', { form });
  },
  setLinkedIn: (url: string) =>
    request<{ connection: Connection }>('POST', '/api/sources/linkedin', { json: { url } }),
  setGitHub: (username: string) =>
    request<{ connection: Connection }>('POST', '/api/sources/github', { json: { username } }),
  driveFolders: () => request<{ folders: DriveFolder[] }>('GET', '/api/sources/drive/folders'),
  setDriveFolders: (folder_ids: string[]) =>
    request<{ connection: Connection }>('POST', '/api/sources/drive', { json: { folder_ids } }),
  disconnect: (kind: ConnectionKind) => request<void>('DELETE', `/api/sources/${kind}`),

  startBuild: () => request<{ job_id: string }>('POST', '/api/profile/build'),
  buildStatus: () => request<BuildStatus>('GET', '/api/profile/build/status'),
  profile: () => request<ProfileResponse>('GET', '/api/profile'),
  saveProfile: (document: ProfileDocument) =>
    request<{ version: number }>('PUT', '/api/profile', { json: { document } }),
  /** Approves the version the user reviewed; the server refuses if a newer one exists. */
  approve: (version: number) =>
    request<{ approved_version: number; approved_at: string }>('POST', '/api/profile/approve', {
      json: { version },
    }),

  board: () => request<BoardData>('GET', '/api/board'),
  searchCompanies: (q: string) =>
    request<{ results: SearchResult[] }>('GET', `/api/search/companies?q=${encodeURIComponent(q)}`),
  application: (id: string, activityBefore?: string | null) =>
    request<ApplicationDetail>(
      'GET',
      `/api/applications/${encodeURIComponent(id)}${
        activityBefore ? `?activity_before=${encodeURIComponent(activityBefore)}` : ''
      }`,
    ),
  moveStage: (id: string, from: ApplicationStatus, to: ApplicationStatus) =>
    request<{ id: string; status: ApplicationStatus }>(
      'POST',
      `/api/applications/${encodeURIComponent(id)}/stage`,
      { json: { from, to } },
    ),

  usage: (window: LlmUsageWindow) =>
    request<LlmUsageResponse>('GET', `/api/usage?window=${encodeURIComponent(window)}`),
  survey: () => request<{ answers: SurveyAnswers | null }>('GET', '/api/survey'),
  saveSurvey: (answers: SurveyAnswers) =>
    request<{ version: number }>('PUT', '/api/survey', { json: { answers } }),

  currentRun: (cursor?: string | null) =>
    request<CurrentRun>(
      'GET',
      cursor ? `/api/runs/current?cursor=${encodeURIComponent(cursor)}` : '/api/runs/current',
    ),
  startRun: () => request<{ run: RunSummary; candidates: RunCandidateView[] }>('POST', '/api/runs'),
  interview: (id: string) =>
    request<{ interview: InterviewView }>('GET', `/api/interviews/${encodeURIComponent(id)}`),
  applicationExtras: (applicationId: string) =>
    request<ApplicationExtras>(
      'GET',
      `/api/interviews/for-application/${encodeURIComponent(applicationId)}`,
    ),
  submitFeedback: (id: string, input: FeedbackInput) =>
    request<{ feedback: Feedback }>('POST', `/api/interviews/${encodeURIComponent(id)}/feedback`, {
      json: input,
    }),
  editFeedback: (id: string, input: FeedbackInput) =>
    request<{ feedback: Feedback }>('PUT', `/api/interviews/${encodeURIComponent(id)}/feedback`, {
      json: input,
    }),
  requestNegotiation: (applicationId: string) =>
    request<{ status: 'queued'; enqueued: boolean }>(
      'POST',
      `/api/interviews/for-application/${encodeURIComponent(applicationId)}/negotiation`,
    ),
  recordInterview: (applicationId: string, input: { starts_at: string; ends_at: string | null }) =>
    request<{ interview: InterviewView; enqueued: boolean }>(
      'POST',
      `/api/interviews/for-application/${encodeURIComponent(applicationId)}/record`,
      { json: input },
    ),
  requestPrepPlan: (id: string) =>
    request<{ status: PrepPlanStatus; enqueued: boolean }>(
      'POST',
      `/api/interviews/${encodeURIComponent(id)}/prep-plan`,
    ),
};

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function formatPay(
  min: number | null,
  max: number | null,
  currency: string | null,
): string | null {
  if (min === null && max === null) return null;
  const fmt = (n: number) => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency ?? 'USD',
        maximumFractionDigits: 0,
      }).format(n);
    } catch {
      return String(n);
    }
  };
  if (min !== null && max !== null && min !== max) return `${fmt(min)} – ${fmt(max)}`;
  return fmt((min ?? max)!);
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}
