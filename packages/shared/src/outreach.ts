/**
 * Recruiter outreach. A draft is written for an application and sits in `draft` until the user
 * approves it; only an approved draft whose content still matches the approval is ever sent.
 */
export const OUTREACH_STATES = [
  'draft',
  'approved',
  'sending',
  'sent',
  'rejected',
  'failed',
] as const;
export type OutreachState = (typeof OUTREACH_STATES)[number];

/** Queue (and pending_jobs kind) of the job that sends an approved draft. */
export const SEND_OUTREACH_JOB = 'send-outreach';
export const SEND_OUTREACH_QUEUE_OPTIONS = {
  policy: 'exclusive',
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: true,
} as const;

/** At most this many outreach emails are sent per UTC day. */
export const OUTREACH_DAILY_CAP = 5;
export const MAX_OUTREACH_SUBJECT = 200;
export const MAX_OUTREACH_BODY = 4000;
export const MAX_LINKEDIN_NOTE = 300;

export interface OutreachDraftView {
  id: string;
  application_id: string;
  contact_name: string;
  contact_title: string | null;
  contact_profile_url: string | null;
  to_address: string;
  subject: string;
  body_text: string;
  linkedin_note: string | null;
  state: OutreachState;
  /** What the user must send back to approve: ties the approval to exactly this content. */
  content_hash: string;
  approved_at: string | null;
  sent_at: string | null;
  failure_reason: string | null;
  created_at: string;
}

export interface OutreachListResponse {
  drafts: OutreachDraftView[];
  /** Emails already sent today (UTC) and the cap. */
  sent_today: number;
  daily_cap: number;
}

/** Queue (and pending_jobs kind) of the job that drafts an email for a contact the user entered. */
export const DRAFT_OUTREACH_JOB = 'draft-outreach';
export const DRAFT_OUTREACH_QUEUE_OPTIONS = {
  policy: 'exclusive',
  retryLimit: 1,
  retryDelay: 30,
  retryBackoff: false,
} as const;

export interface DraftOutreachData {
  tenantId: string;
  userId: string;
  applicationId: string;
  contact: { name: string; title: string | null; profile_url: string | null; email: string };
}

export interface SendOutreachData {
  tenantId: string;
  userId: string;
  draftId: string;
}
