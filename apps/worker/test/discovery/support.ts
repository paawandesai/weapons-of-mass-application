import { readFileSync } from 'node:fs';
import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';
import {
  insertProfileVersion,
  setApprovedProfileVersion,
  setDailyTarget,
  type TenantHandle,
} from '@wma/db';
import { profileDocumentSchema, type Candidate, type Judgment } from '@wma/shared';
import profileFixture from '../../../../packages/shared/test/fixtures/profile.full.json';
import { createHttp } from '@wma/discovery';
import type { SubmitQueue } from '../../src/discovery/handoff';
import type { SubmitApplicationJobData } from '../../src/jobs/submit-application';
import type { BoardRef, SourceAdapter } from '../../src/discovery/types';

export const NOW = new Date('2026-11-07T10:00:00Z');
export const TODAY = '2026-11-07';

export const profile = profileDocumentSchema.parse(profileFixture);

const dir = new URL('../fixtures/discovery/', import.meta.url);
export const fixtureText = (name: string) => readFileSync(new URL(name, dir), 'utf8');
export const fixtureJson = <T = unknown>(name: string): T => JSON.parse(fixtureText(name)) as T;

/** Board data by (ats, slug); anything else is a 404. */
export interface World {
  greenhouse: Record<string, unknown>;
  lever: Record<string, unknown>;
  ashby: Record<string, unknown>;
  /** Slugs that answer with a server error instead. */
  failing: Set<string>;
  hits: string[];
  hn: boolean;
  linkedin: 'ok' | 'blocked' | 'redirect';
}

export function defaultWorld(): World {
  return {
    greenhouse: { 'northwind-labs': fixtureJson('greenhouse-board.json') },
    lever: { quillbase: fixtureJson('lever-board.json') },
    ashby: { brightforge: fixtureJson('ashby-board.json') },
    failing: new Set(),
    hits: [],
    hn: true,
    linkedin: 'ok',
  };
}

export function worldHandlers(w: World) {
  const board =
    (kind: 'greenhouse' | 'lever' | 'ashby') =>
    ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
      const slug = String(params.slug);
      w.hits.push(`${kind}:${slug}`);
      void request;
      if (w.failing.has(`${kind}:${slug}`)) return new HttpResponse('boom', { status: 503 });
      const data = w[kind][slug];
      return data === undefined
        ? new HttpResponse('{"ok":false}', { status: 404 })
        : HttpResponse.json(data);
    };
  const items = fixtureJson<Record<string, unknown>>('hn-items.json');
  return [
    http.get('https://boards-api.greenhouse.io/v1/boards/:slug/jobs', board('greenhouse')),
    http.get('https://api.lever.co/v0/postings/:slug', board('lever')),
    http.get('https://api.ashbyhq.com/posting-api/job-board/:slug', board('ashby')),
    http.get('https://hacker-news.firebaseio.com/v0/user/whoishiring.json', () => {
      w.hits.push('hn');
      return w.hn
        ? HttpResponse.json(fixtureJson('hn-whoishiring.json'))
        : new HttpResponse('x', { status: 500 });
    }),
    http.get('https://hacker-news.firebaseio.com/v0/item/:id.json', ({ params }) =>
      HttpResponse.json(items[String(params.id)] ?? null),
    ),
    http.get('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobSearch/search', () => {
      w.hits.push('linkedin');
      if (w.linkedin === 'blocked') return new HttpResponse('', { status: 999 });
      if (w.linkedin === 'redirect') {
        return new HttpResponse(null, {
          status: 302,
          headers: { location: 'https://www.linkedin.com/authwall?trk=x' },
        });
      }
      return new HttpResponse(fixtureText('linkedin-search.html'), {
        headers: { 'content-type': 'text/html' },
      });
    }),
    http.get(
      'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/:id',
      ({ params }) =>
        new HttpResponse(
          fixtureText(
            params.id === '3900000001'
              ? 'linkedin-detail-ats.html'
              : 'linkedin-detail-easyapply.html',
          ),
          { headers: { 'content-type': 'text/html' } },
        ),
    ),
  ];
}

/** An msw server that errors on any request it has no handler for: tests never reach a network. */
export function createWorld() {
  const world = defaultWorld();
  const server = setupServer(...worldHandlers(world));
  return {
    world,
    server,
    reset() {
      Object.assign(world, defaultWorld());
      server.resetHandlers();
    },
  };
}

export { delay, http, HttpResponse };

/** No backoff sleeps, short timeout. */
export const fastHttp = (timeoutMs = 2000) =>
  createHttp({ sleep: async () => {}, timeoutMs, backoffMs: 0 });

export const boardRefs: BoardRef[] = [
  {
    companyId: 'c-gh',
    companyName: 'Northwind Labs',
    ats: 'greenhouse',
    boardSlug: 'northwind-labs',
    region: '',
  },
  { companyId: 'c-lv', companyName: 'Quillbase', ats: 'lever', boardSlug: 'quillbase', region: '' },
  {
    companyId: 'c-ab',
    companyName: 'Brightforge',
    ats: 'ashby',
    boardSlug: 'brightforge',
    region: '',
  },
];

export function candidate(over: Partial<Candidate> & { title: string }): Candidate {
  return {
    source: 'greenhouse',
    companyName: 'Fictional Co',
    companyId: null,
    url: `https://boards.greenhouse.io/fictional/jobs/${Math.floor(Math.random() * 1e9)}`,
    ats: null,
    atsJobId: null,
    description: null,
    location: null,
    postedAt: null,
    ...over,
  };
}

export function judgment(over: Partial<Judgment> = {}): Judgment {
  return {
    apply: true,
    rationale: 'Matches the target role.',
    fit: 3,
    pay_min: null,
    pay_max: null,
    currency: null,
    location_mode: null,
    seniority: null,
    application_deadline: null,
    ...over,
  };
}

/** Records submit-application enqueues instead of sending them. */
export function fakeQueue(): SubmitQueue & {
  sent: SubmitApplicationJobData[];
  /** Application ids with a live job; clear it to simulate lost or failed jobs. */
  live: Set<string>;
  failAt?: number;
} {
  const q = {
    sent: [] as SubmitApplicationJobData[],
    live: new Set<string>(),
    failAt: undefined as number | undefined,
    async enqueueSubmit(data: SubmitApplicationJobData) {
      if (q.failAt !== undefined && q.sent.length === q.failAt) throw new Error('queue down');
      q.sent.push(data);
      q.live.add(data.applicationId);
    },
    async hasLiveJob(applicationId: string) {
      return q.live.has(applicationId);
    },
  };
  return q;
}

/** A source that returns fixed candidates. */
export const staticAdapter = (id: SourceAdapter['id'], candidates: Candidate[]): SourceAdapter => ({
  id,
  fetch: async () => ({ status: 'ok', candidates }),
});

/** Approves a profile for the tenant's user and sets the daily target. */
export async function approveProfile(handle: TenantHandle, userId: string, target = 12) {
  const row = await insertProfileVersion(handle, { userId, document: profile });
  await setApprovedProfileVersion(handle, userId, row.version);
  await setDailyTarget(handle, userId, target);
  return row.version;
}
