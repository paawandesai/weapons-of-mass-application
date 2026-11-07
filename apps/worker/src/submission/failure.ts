import type { PendingReason } from '@wma/shared';

/**
 * A step that cannot continue. The job turns it into a pending reason (with a retry) or, on the
 * second failure, a closed application. `detail` goes to the activity log, so it must never hold
 * a password, token or other secret.
 */
export class SubmissionFailure extends Error {
  constructor(
    readonly reason: PendingReason,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(reason);
    this.name = 'SubmissionFailure';
  }
}

/**
 * Something outside the application broke (database, profile load) before an outcome could be
 * recorded. It propagates to the queue so pg-boss retries the job.
 */
export class InfrastructureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InfrastructureError';
  }
}

/** The error categories a log entry may carry; anything else is reported as `Error`. */
const ERROR_CATEGORIES = new Set([
  'TimeoutError',
  'RenderError',
  'ResumeTooLongError',
  'TypeError',
  'RangeError',
  'ZodError',
  'SyntaxError',
]);

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const LONG_TOKEN_RE = /[A-Za-z0-9_+/=-]{20,}/g;
const SECRET_WORD_RE = /(password|passwd|passcode|secret|token|bearer|authorization|api[_-]?key)/i;

/**
 * Makes browser or library text safe for the activity log: everything from the first mention of
 * a password (or token, secret, key) onwards is dropped, URLs are replaced, long token-like runs
 * are redacted, and any exact secret the caller knows about is removed wherever it appears.
 */
export function sanitizeMessage(raw: string, secrets: readonly string[] = []): string {
  let text = raw;
  for (const s of secrets) if (s.length >= 4) text = text.split(s).join('[redacted]');
  const cut = SECRET_WORD_RE.exec(text);
  if (cut) text = text.slice(0, cut.index);
  text = text
    .replace(URL_RE, '[url]')
    .replace(LONG_TOKEN_RE, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 200);
}

/** A log-safe description of an unexpected error: an allowlisted category and a sanitized message. */
export function describeError(
  e: unknown,
  secrets: readonly string[] = [],
): { error: string; message?: string } {
  if (e instanceof Error) {
    const error = ERROR_CATEGORIES.has(e.name) ? e.name : 'Error';
    const message = sanitizeMessage(e.message, secrets);
    return message ? { error, message } : { error };
  }
  return { error: 'unknown' };
}

const DB_CODE = /^[0-9A-Z]{5}$/;
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

/** True for database and connection errors (including ones wrapped as a `cause`). */
export function isInfrastructureError(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    if (cur instanceof InfrastructureError) return true;
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && (NETWORK_CODES.has(code) || DB_CODE.test(code))) {
      // SQLSTATE codes are five characters; vendor error codes elsewhere are not.
      if (NETWORK_CODES.has(code) || /^\d/.test(code) || /^(XX|42|53|57|08|40|23|22)/.test(code)) {
        return true;
      }
    }
    if ((cur as { name?: unknown }).name === 'DrizzleQueryError') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
