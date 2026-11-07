import { GOOGLE_SCOPES, googleConfig } from './config';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface AuthUrlInput {
  state: string;
  codeChallenge: string;
  /** `consent` forces Google to issue a refresh token (first sign-in); omit for returning users. */
  forceConsent: boolean;
}

export function buildAuthUrl(input: AuthUrlInput): string {
  const cfg = googleConfig();
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    ...(input.forceConsent ? { prompt: 'consent' } : {}),
  }).toString();
  return u.toString();
}

export interface TokenResult {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<TokenResult> {
  const cfg = googleConfig();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== 'string') {
    throw new OAuthError(
      typeof body.error === 'string' ? body.error : 'token_exchange_failed',
      `token exchange failed with status ${res.status}`,
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [],
  };
}

export interface UserInfo {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  const res = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new OAuthError('userinfo_failed', `userinfo failed with status ${res.status}`);
  const b = (await res.json()) as Record<string, unknown>;
  if (typeof b.sub !== 'string' || typeof b.email !== 'string') {
    throw new OAuthError('userinfo_failed', 'userinfo response missing sub or email');
  }
  return {
    sub: b.sub,
    email: b.email.toLowerCase(),
    emailVerified: b.email_verified === true || b.email_verified === 'true',
    name: typeof b.name === 'string' ? b.name : null,
  };
}
