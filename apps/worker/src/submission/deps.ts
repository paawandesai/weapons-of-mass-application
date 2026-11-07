import type { TenantHandle } from '@wma/db';
import type { StructuredLlm } from '@wma/llm';
import type { MailDeps } from '@wma/shared';
import type {
  AdapterPage,
  AnswerResolution,
  Clock,
  FieldDescriptor,
  FormAdapter,
  GmailPort,
  SubmissionContext,
  TailorResult,
} from './types';

/** The page the job drives: a Playwright `Page` satisfies it. */
export interface PageLike extends AdapterPage {
  goto(url: string): Promise<unknown>;
  screenshot(options?: { fullPage?: boolean }): Promise<Buffer>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  press(selector: string, key: string, options?: { timeout?: number }): Promise<void>;
}

export interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

/** One per worker process; each application opens and closes its own context on it. */
export interface BrowserLike {
  /** `timezoneId` is the user's IANA zone; the browser's default applies when it is unknown. */
  newContext(opts?: { timezoneId?: string }): Promise<ContextLike>;
}

export interface FollowUpJobData {
  tenantId: string;
  userId: string;
  applicationId: string;
}

export interface FollowUpQueue {
  /** Idempotent per application id. */
  enqueueFollowUp(data: FollowUpJobData, startAfter: Date): Promise<void>;
}

/** Everything the job takes from outside, so tests inject fakes. */
export interface SubmissionDeps {
  tailor(ctx: SubmissionContext): Promise<TailorResult>;
  resolveAnswers(ctx: SubmissionContext, fields: FieldDescriptor[]): Promise<AnswerResolution[]>;
  selectAdapter(url: string): FormAdapter | null;
  launchBrowser(): Promise<BrowserLike>;
  gmail(handle: TenantHandle, userId: string): GmailPort;
  clock: Clock;
  llm: StructuredLlm;
  sendMail(handle: TenantHandle, userId: string): MailDeps;
  followUp: FollowUpQueue;
  /** Origin of the public site, for the link in the CAPTCHA email. */
  webOrigin: string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
