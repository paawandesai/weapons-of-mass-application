import { createHash } from 'node:crypto';
import {
  getFile,
  getOpenCaptchaByTokenHash,
  submitHumanAnswer,
  type CaptchaRequestRow,
  type Db,
  type TenantHandle,
} from '@wma/db';

export const MAX_ANSWER_LENGTH = 64;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export type OpenRequest = { handle: TenantHandle; request: CaptchaRequestRow };

/**
 * The request behind a reply link while it can still take an answer; null otherwise. The row is
 * loaded by the token hash itself (one tenant-scoped query on the database clock), so a token the
 * worker has replaced since the tenant lookup finds nothing instead of the newer challenge.
 */
export async function findOpenRequest(db: Db, token: string): Promise<OpenRequest | null> {
  if (!TOKEN_RE.test(token)) return null;
  const tokenHash = hashToken(token);
  const found = await db.resolveCaptchaToken(tokenHash);
  if (!found) return null;
  const handle = db.forTenant(found.tenantId);
  const request = await getOpenCaptchaByTokenHash(handle, tokenHash);
  return request ? { handle, request } : null;
}

/** The challenge picture as a data URI, or null when the file is gone. */
export async function challengeImage(open: OpenRequest): Promise<string | null> {
  if (!open.request.imageRef) return null;
  const bytes = await getFile(open.handle, open.request.imageRef);
  return bytes ? `data:image/png;base64,${bytes.toString('base64')}` : null;
}

export type AnswerResult = 'accepted' | 'closed' | 'invalid';

/**
 * Records the reply. Only the first reply to an open request is written; a reused, replaced or
 * expired link writes nothing.
 */
export async function acceptAnswer(
  db: Db,
  token: string,
  rawAnswer: string,
): Promise<AnswerResult> {
  const answer = rawAnswer.trim();
  if (!TOKEN_RE.test(token)) return 'closed';
  const found = await db.resolveCaptchaToken(hashToken(token));
  if (!found) return 'closed';
  if (answer.length === 0 || answer.length > MAX_ANSWER_LENGTH) {
    const open = await findOpenRequest(db, token);
    return open ? 'invalid' : 'closed';
  }
  const handle = db.forTenant(found.tenantId);
  const row = await submitHumanAnswer(handle, hashToken(token), answer);
  return row ? 'accepted' : 'closed';
}
