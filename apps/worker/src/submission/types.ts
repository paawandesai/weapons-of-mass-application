import type { ApplicationRow, JobRow, TenantHandle, vault } from '@wma/db';
import type { StructuredLlm } from '@wma/llm';
import type { AtsId, Judgment, MailDeps, ProfileDocument } from '@wma/shared';

/**
 * The page a form adapter drives. A Playwright `Page` satisfies it; adapters declare their own
 * parameter as `Page` (method parameters are bivariant), so this file needs no browser dependency.
 */
export interface AdapterPage {
  url(): string;
}

export type FieldClassification = 'standard' | 'free-text' | 'self-identification' | 'resume';

export interface FieldDescriptor {
  /** Stable id within the form (vendor field name or selector key). */
  id: string;
  /** The question text; `applications.form_answers` is keyed by it. */
  label: string;
  type: 'text' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'file' | 'date' | 'number';
  required: boolean;
  maxLength: number | null;
  classification: FieldClassification;
  options?: string[];
  /** The question's help text or instructions, when the page has any (at most 1,000 chars). */
  description?: string;
  /**
   * Set when the page layer could not describe the control fully: `large-list` (a combobox with
   * more than 60 options, `options` omitted) or `unknown-control` (read as `text`).
   */
  hint?: 'large-list' | 'unknown-control';
}

/** A resolved value for one field, by field id. Skipped fields are simply absent. */
export type FieldValues = Record<string, string | boolean | string[]>;

export interface Account {
  email: string;
  password: string;
}

export interface Credential {
  username: string;
  password: string;
}

export type SignInOutcome = 'ok' | 'rejected';

export interface CaptchaHandle {
  /**
   * `image` (default): a text-and-image widget the solver chain can read. `frame`: an hCaptcha or
   * reCAPTCHA challenge in an iframe, which has no image to solve; it goes straight to the human
   * stage and `screenshot()` is the full page.
   */
  challenge?: 'image' | 'frame';
  /** The challenge region as a PNG. */
  screenshot(): Promise<Buffer>;
  enter(answer: string): Promise<void>;
  /** True when the challenge is no longer present or the page moved on. */
  cleared(): Promise<boolean>;
}

/** Something the form says about itself that is recorded but does not stop the submission. */
export interface FormNotice {
  kind: 'application-limit';
  max: number;
  days: number;
}

/** One per vendor; selected by URL pattern. */
export interface FormAdapter {
  readonly ats: AtsId;
  detect(url: string): boolean;
  load(page: AdapterPage, url: string): Promise<void>;
  requiresAccount(page: AdapterPage): Promise<boolean>;
  signUp(page: AdapterPage, account: Account): Promise<void>;
  signIn(page: AdapterPage, credential: Credential): Promise<SignInOutcome>;
  fields(page: AdapterPage): Promise<FieldDescriptor[]>;
  fill(page: AdapterPage, values: FieldValues): Promise<void>;
  attachResume(page: AdapterPage, pdf: { filename: string; bytes: Buffer }): Promise<void>;
  submit(page: AdapterPage): Promise<void>;
  confirmed(page: AdapterPage): Promise<boolean>;
  findCaptcha(page: AdapterPage): Promise<CaptchaHandle | null>;
  /** Visible notices on the form, e.g. an application limit (`form-notice` activity entry). */
  notices?(page: AdapterPage): Promise<FormNotice[]>;
}

export type TailorFailureDetail = 'invalid_facts' | 'too_long';

/** Outcome of the tailor step: a checked, rendered resume, or a failure that parks the application. */
export type TailorResult =
  | {
      ok: true;
      /** File store key of the rendered PDF (`tenants/<t>/applications/<id>/resume.pdf`). */
      pdfKey: string;
      pageCount: 1 | 2;
      unmetRequirements: string[];
      /** True when the first draft failed the truthfulness check and the second passed. */
      regenerated: boolean;
    }
  | {
      ok: false;
      reason: 'tailoring-check-failed';
      detail: TailorFailureDetail;
      /** The failed facts, quoted. */
      failures: string[];
    };

/** How one form field was resolved (profile, then generated answer, then blank). */
export type AnswerResolution =
  | {
      fieldId: string;
      question: string;
      status: 'filled';
      value: string | boolean | string[];
      /** `inferred`: a default derived from the profile (rule 28); `guessed`: a model guess (rule 29). */
      source: 'profile' | 'generated' | 'inferred' | 'guessed';
    }
  | { fieldId: string; question: string; status: 'skipped'; skipped: 'self-identification' }
  | {
      fieldId: string;
      question: string;
      status: 'blank';
      reason: 'optional-unanswerable' | 'no-resume-field';
    }
  | { fieldId: string; question: string; status: 'unanswerable' }
  | {
      fieldId: string;
      question: string;
      status: 'missing-profile-field';
      /** Additive (answers module): the profile field that has no value, e.g. `work_authorization`. */
      profileField?: string;
    };

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface InboundMessage {
  id: string;
  from: string;
  subject: string;
  receivedAt: Date;
  text: string;
  links: string[];
}

/** Read side of Gmail used for verification and confirmation polling. */
export interface GmailPort {
  search(query: {
    fromDomains: string[];
    after: Date;
    subjectContains?: string;
  }): Promise<InboundMessage[]>;
}

/** File store scoped to the context's tenant (keys come from applicationFileKey). */
export interface SubmissionFiles {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

/** Vault access for `ats_password` secrets, bound to the context's tenant and user. */
export interface SubmissionVault {
  get(ref: string): Promise<Awaited<ReturnType<typeof vault.get>>>;
  put(ref: string, value: string): Promise<void>;
}

/** Everything one submission attempt needs; built once per job run. */
export interface SubmissionContext {
  handle: TenantHandle;
  userId: string;
  application: ApplicationRow;
  job: JobRow;
  /** The company's display name; mail about the application must tie back to it. */
  companyName: string;
  /** Names of companies the user has an applied application for (rule 27). */
  priorApplications: string[];
  profile: ProfileDocument;
  /** The decision facts from `run_candidates.judgment`; null when the run row is gone. */
  judgment: Judgment | null;
  clock: Clock;
  gmail: GmailPort;
  /** Outgoing mail (CAPTCHA request emails) goes through sendEmail with these deps. */
  mail: MailDeps;
  llm: StructuredLlm;
  files: SubmissionFiles;
  vault: SubmissionVault;
}
