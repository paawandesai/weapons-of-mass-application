import { randomBytes } from 'node:crypto';
import { createSession, deleteSession, type TenantHandle } from '@wma/db';
import { SESSION_TTL_MS } from '../middleware/session';

export const newSessionId = () => randomBytes(32).toString('base64url');

export async function startSession(
  handle: TenantHandle,
  userId: string,
  now: Date,
): Promise<string> {
  const id = newSessionId();
  await createSession(handle, { id, userId, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) });
  return id;
}

export const endSession = deleteSession;
