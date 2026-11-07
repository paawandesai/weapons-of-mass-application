import { GoogleNotConnectedError, isInvalidGrant } from '@wma/google';

const statusOf = (e: unknown): number | null => {
  if (!e || typeof e !== 'object') return null;
  const err = e as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const v of [err.code, err.status, err.response?.status]) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
};

/** The Google grant is unusable (401, revoked or expired, or no grant at all): retrying cannot fix it. */
export function isGoogleAuthError(e: unknown): boolean {
  return statusOf(e) === 401 || isInvalidGrant(e) || e instanceof GoogleNotConnectedError;
}
