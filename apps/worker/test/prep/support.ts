import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  insertApplication,
  insertInterview,
  updateApplication,
  updateInterview,
  upsertCompany,
  upsertEmailThread,
  upsertJob,
  type ApplicationStatus,
} from '@wma/db';
import type { Http, HttpResponse } from '@wma/discovery';
import { SLUG_PREFIX } from '../inbox/support';
import type { TestTenant } from '../helpers';

export { approve, setupInboxEnv, type InboxEnv } from '../inbox/support';

const fixtures = join(import.meta.dirname, '..', 'fixtures');
export const fixtureText = (path: string) => readFileSync(join(fixtures, path), 'utf8');
export const fixtureJson = <T = unknown>(path: string) => JSON.parse(fixtureText(path)) as T;

let n = 0;

export interface Seeded {
  applicationId: string;
  interviewId: string;
  companyName: string;
}

/** A company with a board page URL, a posting with pay, an application and a booked interview. */
export async function seedBooked(
  t: TestTenant,
  opts: {
    status?: ApplicationStatus;
    boardUrl?: string | null;
    pay?: { min: number; max: number } | null;
    location?: string | null;
  } = {},
): Promise<Seeded> {
  n++;
  const slug = `${SLUG_PREFIX}-w4-${n}`;
  const company = await upsertCompany(t.handle, {
    name: `Harbor Robotics ${n}`,
    ats: 'greenhouse',
    boardSlug: slug,
    boardUrl: opts.boardUrl === undefined ? `https://boards.example.test/${slug}` : opts.boardUrl,
    createdBy: 'llm',
  });
  const { job } = await upsertJob(t.handle, {
    companyId: company.id,
    ats: 'greenhouse',
    atsJobId: String(7000 + n),
    title: 'Staff Platform Engineer',
    url: `https://boards.example.test/${slug}/jobs/${7000 + n}`,
    description: 'Own the fleet platform. Kubernetes, Go, on-call.',
    location: opts.location === undefined ? 'San Francisco Bay Area' : opts.location,
    payMin: opts.pay === null ? null : (opts.pay?.min ?? 210000),
    payMax: opts.pay === null ? null : (opts.pay?.max ?? 260000),
    currency: 'USD',
  });
  const { application } = await insertApplication(t.handle, { userId: t.userId, jobId: job.id });
  await updateApplication(t.handle, application.id, {
    status: opts.status ?? 'interviewing',
    appliedAt: new Date('2026-03-10T09:00:00Z'),
  });
  const thread = await upsertEmailThread(t.handle, {
    userId: t.userId,
    gmailThreadId: `thr-w4-${t.id}-${n}`,
    kind: 'interview',
    applicationId: application.id,
  });
  const { interview } = await insertInterview(t.handle, {
    userId: t.userId,
    applicationId: application.id,
    threadId: thread.id,
  });
  await updateInterview(t.handle, interview.id, {
    confirmedAt: new Date(),
    startsAt: new Date('2030-03-12T22:00:00Z'),
    endsAt: new Date('2030-03-12T23:00:00Z'),
  });
  return { applicationId: application.id, interviewId: interview.id, companyName: company.name };
}

/** An Http that answers from a map of URL to body, recording what it was asked. */
export class FakeHttp implements Http {
  readonly requested: string[] = [];
  constructor(private readonly pages: Record<string, string | number> = {}) {}
  async get(url: string): Promise<HttpResponse> {
    this.requested.push(url);
    const hit = this.pages[url];
    if (hit === undefined) throw new Error(`no route for ${url}`);
    const status = typeof hit === 'number' ? hit : 200;
    const body = typeof hit === 'number' ? '' : hit;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(),
      text: () => body,
      json: <T>() => JSON.parse(body) as T,
    };
  }
  async json<T>(url: string): Promise<T> {
    return (await this.get(url)).json<T>();
  }
}
