import type {
  BuildStatus,
  Connection,
  ConnectionKind,
  MeResponse,
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

export interface DriveFolder {
  id: string;
  name: string;
}

export const api = {
  me: () => request<MeResponse>('GET', '/api/me'),
  signOut: () => request<void>('POST', '/auth/signout'),

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

  survey: () => request<{ answers: SurveyAnswers | null }>('GET', '/api/survey'),
  saveSurvey: (answers: SurveyAnswers) =>
    request<{ version: number }>('PUT', '/api/survey', { json: { answers } }),
};

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
