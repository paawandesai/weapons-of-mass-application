import type { APIRequestContext } from '@playwright/test';

export interface ExtrasInterview {
  id: string;
  prep_plan_status: 'pending' | 'ready' | 'failed' | null;
  feedback: unknown;
}

/** Ids of the signed-in user's applications in a status; empty when the API cannot be read. */
export async function applicationIds(
  request: APIRequestContext,
  status: string,
): Promise<string[]> {
  const res = await request.get(`/api/applications?status=${status}`);
  if (!res.ok()) return [];
  const body = (await res.json()) as { applications: Array<{ id: string }> };
  return body.applications.map((a) => a.id);
}

/** The first application with an interview that matches, with that interview. */
export async function findInterview(
  request: APIRequestContext,
  match: (i: ExtrasInterview) => boolean = () => true,
): Promise<{ applicationId: string; interview: ExtrasInterview } | null> {
  for (const status of ['interviewing', 'offer', 'applied']) {
    for (const id of await applicationIds(request, status)) {
      const res = await request.get(`/api/interviews/for-application/${id}`);
      if (!res.ok()) continue;
      const body = (await res.json()) as { interviews: ExtrasInterview[] };
      const interview = body.interviews.find(match);
      if (interview) return { applicationId: id, interview };
    }
  }
  return null;
}

/** The id of the first application in a status; throws when the scenario fixture is missing. */
export async function requireApplication(
  request: APIRequestContext,
  status: 'applied' | 'interviewing' | 'offer',
): Promise<string> {
  const id = (await applicationIds(request, status))[0];
  if (!id) throw new Error(`no application in ${status}: run 'pnpm seed:demo --scenarios'`);
  return id;
}
