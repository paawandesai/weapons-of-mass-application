export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
] as const;

/** Maps each source kind to the scope(s) that must all be granted for it to count as connected. */
export const SOURCE_SCOPES = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
  ],
  calendar: ['https://www.googleapis.com/auth/calendar'],
  drive: ['https://www.googleapis.com/auth/drive.readonly'],
} as const;

export type GoogleSourceKind = keyof typeof SOURCE_SCOPES;
export const GOOGLE_SOURCE_KINDS = Object.keys(SOURCE_SCOPES) as GoogleSourceKind[];

export function googleConfig(): GoogleConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3000/auth/google/callback';
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }
  return { clientId, clientSecret, redirectUri };
}

/** The scope-to-source rule: a source is connected only when every one of its scopes was granted. */
export function sourceStatusFromScopes(granted: string[]): Record<GoogleSourceKind, boolean> {
  const set = new Set(granted);
  return {
    gmail: SOURCE_SCOPES.gmail.every((s) => set.has(s)),
    calendar: SOURCE_SCOPES.calendar.every((s) => set.has(s)),
    drive: SOURCE_SCOPES.drive.every((s) => set.has(s)),
  };
}
