import {
  unresolvedBlockingFlags,
  type OutreachDraftView,
  type BuildStatus,
  type Connection,
  type LlmUsageResponse,
  type ProfileDocument,
  type SurveyAnswers,
} from '@wma/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const NOW = '2026-11-06T10:00:00.000Z';

export function fixtureDocument(): ProfileDocument {
  return {
    identity: {
      full_name: 'Ada Lovelace',
      headline: 'Engineer',
      location: 'London',
      summary: null,
    },
    contact: {
      email: 'ada@example.com',
      phone: null,
      linkedin_url: null,
      github_url: null,
      website_url: null,
    },
    work_history: [
      {
        employer: 'Analytical Engines Ltd',
        title: 'Programmer',
        location: null,
        start_date: '2019-03',
        end_date: null,
        summary: null,
        highlights: ['Wrote the first program'],
        sources: ['resume'],
      },
    ],
    projects: [],
    skills: [{ name: 'Mathematics', category: null }],
    education: [],
    preferences: { target_titles: ['Staff engineer'], locations: ['London'], remote: 'hybrid' },
    survey: {
      target_roles: ['Staff engineer'],
      salary_floor: 150000,
      work_life_balance: null,
      family_constraints: null,
      willing_to_relocate: null,
      career_direction: null,
      daily_target: 12,
    },
    standard_answers: {
      work_authorization: null,
      visa_sponsorship_required: null,
      start_date: null,
      earliest_start_date: null,
      previous_interviews: null,
      notice_period: null,
      reasons_for_change: null,
    },
    flags: [],
  };
}

export function conn(
  kind: Connection['kind'],
  status: Connection['status'],
  config = {},
): Connection {
  return { kind, status, config, connected_at: status === 'disconnected' ? null : NOW };
}

export interface MockState {
  authed: boolean;
  connections: Connection[];
  survey: SurveyAnswers | null;
  profile: null | {
    version: number;
    document: ProfileDocument;
    approved_version: number | null;
    approved_at: string | null;
    /** Sources the version was built from; defaults to a built profile. */
    built_from?: string[];
  };
  folders: { id: string; name: string }[];
  buildStatuses: BuildStatus[];
  hasResume: boolean;
  saved: unknown[];
  approveCalls: number;
  /** Versions sent in approve requests, in order. */
  approvedVersions: number[];
  /** What approve answers for run_started. */
  runStarted?: boolean;
  signedOut: boolean;
  outreach: OutreachDraftView[];
  outreachCalls: { approved: string[]; rejected: string[]; requested: unknown[] };
  usage: Pick<
    LlmUsageResponse,
    'total' | 'by_purpose' | 'by_application' | 'recent' | 'backend' | 'pace'
  >;
}

const zeroTotals = {
  calls: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cost_usd: 0,
  unpriced_calls: 0,
};

function initial(): MockState {
  return {
    authed: true,
    connections: [
      conn('resume', 'connected', { filename: 'ada.pdf' }),
      conn('gmail', 'connected'),
      conn('calendar', 'connected'),
      conn('drive', 'connected'),
      conn('linkedin', 'disconnected'),
      conn('github', 'disconnected'),
    ],
    survey: null,
    profile: null,
    folders: [
      { id: 'f1', name: 'Career' },
      { id: 'f2', name: 'Writing' },
    ],
    buildStatuses: [{ state: 'done', version: 2 }],
    hasResume: true,
    saved: [],
    approveCalls: 0,
    approvedVersions: [],
    signedOut: false,
    outreach: [],
    outreachCalls: { approved: [], rejected: [], requested: [] },
    usage: {
      total: zeroTotals,
      by_purpose: [],
      by_application: [],
      recent: [],
      backend: 'anthropic',
      pace: { last_5h: zeroTotals, last_24h: zeroTotals },
    },
  };
}

export const state: MockState = initial();
export function resetState(): void {
  Object.assign(state, initial());
}

const unauth = () =>
  HttpResponse.json({ code: 'unauthenticated', message: 'Sign in first.' }, { status: 401 });
const setConn = (c: Connection) => {
  state.connections = [...state.connections.filter((x) => x.kind !== c.kind), c];
  return HttpResponse.json({ connection: c }, { status: 201 });
};

export const handlers = [
  http.get('*/auth/google/start', () => new HttpResponse(null, { status: 302 })),
  http.post('*/auth/signout', () => {
    state.signedOut = true;
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('*/api/me', () =>
    state.authed
      ? HttpResponse.json({
          user: {
            id: 'u1',
            email: 'ada@example.com',
            display_name: 'Ada',
            approved_profile_version: state.profile?.approved_version ?? null,
            approved_profile_at: state.profile?.approved_at ?? null,
            daily_target: 12,
            digest_hour: 8,
          },
          connections: state.connections,
        })
      : unauth(),
  ),

  http.post('*/api/sources/resume', () =>
    setConn(conn('resume', 'connected', { filename: 'upload.pdf' })),
  ),
  http.post('*/api/sources/linkedin', async ({ request }) => {
    const { url } = (await request.json()) as { url: string };
    return setConn(conn('linkedin', 'connected', { url }));
  }),
  http.post('*/api/sources/github', async ({ request }) => {
    const { username } = (await request.json()) as { username: string };
    return setConn(conn('github', 'connected', { username }));
  }),
  http.get('*/api/sources/drive/folders', () => {
    const drive = state.connections.find((c) => c.kind === 'drive');
    if (!drive || drive.status === 'disconnected')
      return HttpResponse.json(
        { code: 'drive_not_connected', message: 'Drive is not connected.' },
        { status: 409 },
      );
    return HttpResponse.json({ folders: state.folders });
  }),
  http.post('*/api/sources/drive', async ({ request }) => {
    const { folder_ids } = (await request.json()) as { folder_ids: string[] };
    const folders = folder_ids.map((id) => ({
      id,
      name: state.folders.find((f) => f.id === id)?.name ?? id,
    }));
    return setConn(conn('drive', 'connected', { folder_ids, folders }));
  }),
  http.delete('*/api/sources/:kind', ({ params }) => {
    state.connections = state.connections.map((c) =>
      c.kind === params.kind ? conn(c.kind, 'disconnected') : c,
    );
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('*/api/profile/build', () =>
    state.hasResume
      ? HttpResponse.json({ job_id: 'j1' }, { status: 202 })
      : HttpResponse.json(
          { code: 'no_resume', message: 'Upload a resume first.' },
          { status: 409 },
        ),
  ),
  http.get('*/api/profile/build/status', () => {
    const next =
      state.buildStatuses.length > 1 ? state.buildStatuses.shift()! : state.buildStatuses[0]!;
    return HttpResponse.json(next);
  }),
  http.get('*/api/profile', () =>
    state.profile
      ? HttpResponse.json({
          ...state.profile,
          built_from: state.profile.built_from ?? ['resume'],
          flags: state.profile.document.flags,
        })
      : HttpResponse.json({ code: 'no_profile', message: 'No profile yet.' }, { status: 404 }),
  ),
  http.put('*/api/profile', async ({ request }) => {
    const { document } = (await request.json()) as { document: ProfileDocument };
    state.saved.push(document);
    state.profile = {
      version: (state.profile?.version ?? 0) + 1,
      document,
      approved_version: state.profile?.approved_version ?? null,
      approved_at: state.profile?.approved_at ?? null,
      built_from: state.profile?.built_from,
    };
    return HttpResponse.json({ version: state.profile.version });
  }),
  http.post('*/api/profile/approve', async ({ request }) => {
    state.approveCalls++;
    const { version } = (await request.json()) as { version: number };
    state.approvedVersions.push(version);
    if (!state.profile)
      return HttpResponse.json({ code: 'no_profile', message: 'No profile yet.' }, { status: 404 });
    if (version !== state.profile.version)
      return HttpResponse.json(
        {
          code: 'version_mismatch',
          message: 'The profile changed since you opened it.',
          latest_version: state.profile.version,
        },
        { status: 409 },
      );
    // Same rule as the API: blocking flags count while present; partial_source never blocks.
    const blocking = unresolvedBlockingFlags(state.profile.document.flags);
    if (blocking.length)
      return HttpResponse.json(
        { code: 'unresolved_flags', message: 'Flags remain.', flags: blocking },
        { status: 409 },
      );
    state.profile.approved_version = state.profile.version;
    state.profile.approved_at = NOW;
    return HttpResponse.json({
      approved_version: state.profile.version,
      approved_at: NOW,
      run_started: state.runStarted ?? false,
    });
  }),

  http.get('*/api/outreach', () =>
    HttpResponse.json({ drafts: state.outreach, sent_today: 1, daily_cap: 5 }),
  ),
  http.post('*/api/outreach/drafts', async ({ request }) => {
    state.outreachCalls.requested.push(await request.json());
    return HttpResponse.json({ queued: true }, { status: 202 });
  }),
  http.post('*/api/outreach/:id/approve', async ({ params, request }) => {
    const { content_hash } = (await request.json()) as { content_hash: string };
    const d = state.outreach.find((x) => x.id === params.id);
    if (!d) return HttpResponse.json({ code: 'not_found', message: 'gone' }, { status: 404 });
    if (d.content_hash !== content_hash)
      return HttpResponse.json(
        { code: 'stale', message: 'The draft changed since you opened it.' },
        { status: 409 },
      );
    state.outreachCalls.approved.push(d.id);
    d.state = 'approved';
    return HttpResponse.json({ draft: d });
  }),
  http.post('*/api/outreach/:id/reject', ({ params }) => {
    const d = state.outreach.find((x) => x.id === params.id);
    if (d) d.state = 'rejected';
    state.outreachCalls.rejected.push(String(params.id));
    return HttpResponse.json({ draft: d });
  }),
  http.get('*/api/survey', () => HttpResponse.json({ answers: state.survey })),
  http.get('*/api/usage', ({ request }) =>
    HttpResponse.json({
      since: new URL(request.url).searchParams.get('window') === 'all' ? null : NOW,
      total: state.usage.total,
      by_purpose: state.usage.by_purpose,
      by_application: state.usage.by_application,
      recent: state.usage.recent,
      backend: state.usage.backend,
      pace: state.usage.pace,
    }),
  ),
  http.put('*/api/survey', async ({ request }) => {
    const { answers } = (await request.json()) as { answers: SurveyAnswers };
    state.survey = answers;
    return HttpResponse.json({ version: 1 });
  }),
];

export const server = setupServer(...handlers);
