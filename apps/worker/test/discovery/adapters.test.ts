import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ashbyAdapter } from '../../src/discovery/adapters/ashby';
import { greenhouseAdapter } from '../../src/discovery/adapters/greenhouse';
import { hnAdapter, isThreadFor, parseComment } from '../../src/discovery/adapters/hn';
import { leverAdapter } from '../../src/discovery/adapters/lever';
import {
  externalAtsUrl,
  linkedinAdapter,
  parseSearchCards,
} from '../../src/discovery/adapters/linkedin';
import type { SourceContext } from '../../src/discovery/types';
import {
  boardRefs,
  createWorld,
  fastHttp,
  fixtureJson,
  fixtureText,
  http,
  HttpResponse,
  NOW,
  profile,
} from './support';

const w = createWorld();
beforeAll(() => w.server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => w.reset());
afterAll(() => w.server.close());

const ctx = (over: Partial<SourceContext> = {}): SourceContext => ({
  http: fastHttp(),
  boards: boardRefs,
  profile,
  now: NOW,
  ...over,
});

describe('board adapters', () => {
  it('greenhouse maps board JSON to candidates', async () => {
    const r = await greenhouseAdapter.fetch(ctx());
    expect(r.status).toBe('ok');
    expect(r.candidates).toHaveLength(2);
    const [a, b] = r.candidates;
    expect(a).toMatchObject({
      source: 'greenhouse',
      title: 'Senior Backend Engineer, Data Platform',
      companyName: 'Northwind Labs',
      companyId: 'c-gh',
      ats: 'greenhouse',
      atsJobId: '4001001',
      location: 'Remote - EU',
      url: 'https://boards.greenhouse.io/northwind-labs/jobs/4001001?gh_src=abc123',
      postedAt: '2026-11-03T14:00:00.000Z',
    });
    // escaped HTML becomes text
    expect(a!.description).toContain("Build the streaming pipelines behind Northwind's analytics.");
    expect(a!.description).toContain('- Go and Postgres');
    expect(a!.description).toContain('Apply by 2026-11-20');
    expect(a!.description).not.toContain('<');
    // company-hosted careers page -> the hosted board URL
    expect(b!.url).toBe('https://job-boards.greenhouse.io/northwind-labs/jobs/4001002');
  });

  it('lever maps board JSON to candidates', async () => {
    const r = await leverAdapter.fetch(ctx());
    expect(r.status).toBe('ok');
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0]).toMatchObject({
      source: 'lever',
      title: 'Staff Platform Engineer',
      companyName: 'Quillbase',
      ats: 'lever',
      atsJobId: '0c7c1a52-3f0e-4c63-8b8e-5a1f6d2b9e11',
      url: 'https://jobs.lever.co/quillbase/0c7c1a52-3f0e-4c63-8b8e-5a1f6d2b9e11',
      location: 'Lisbon, Portugal',
      postedAt: new Date(1793696400000).toISOString(),
    });
    expect(r.candidates[0]!.description).toContain('Own the internal developer platform');
    expect(r.candidates[0]!.description).toContain('four-day week');
    expect(r.candidates[0]!.raw).toMatchObject({
      pay: { min: 120000, max: 150000, currency: 'EUR' },
    });
  });

  it('ashby maps board JSON to candidates and skips unlisted jobs', async () => {
    const r = await ashbyAdapter.fetch(ctx());
    expect(r.status).toBe('ok');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      source: 'ashby',
      title: 'Senior Backend Engineer',
      companyName: 'Brightforge',
      ats: 'ashby',
      atsJobId: '8f2b6c1e-0d44-4f37-9a55-2e3c8b7d1a60',
      location: 'Remote (EU)',
      postedAt: '2026-11-05T08:30:00.000Z',
    });
    expect(r.candidates[0]!.raw).toMatchObject({ pay: 'EUR 95K - 125K', isRemote: true });
  });

  it('a board that fails is skipped and named; the others still return (partial)', async () => {
    w.world.failing.add('greenhouse:second');
    w.world.greenhouse.second = {};
    const r = await greenhouseAdapter.fetch(
      ctx({
        boards: [
          ...boardRefs,
          {
            companyId: 'c-2',
            companyName: 'Second',
            ats: 'greenhouse',
            boardSlug: 'second',
            region: '',
          },
        ],
      }),
    );
    expect(r.status).toBe('partial');
    expect(r.failedBoards).toEqual(['second']);
    expect(r.candidates).toHaveLength(2);
  });

  it('every board failing makes the source unavailable', async () => {
    w.world.failing.add('lever:quillbase');
    const r = await leverAdapter.fetch(ctx());
    expect(r).toMatchObject({ status: 'unavailable', candidates: [], failedBoards: ['quillbase'] });
  });

  it('no boards for that ATS is an empty ok result', async () => {
    const r = await ashbyAdapter.fetch(ctx({ boards: boardRefs.filter((b) => b.ats !== 'ashby') }));
    expect(r).toEqual({ status: 'ok', candidates: [] });
  });
});

describe('hn-who-is-hiring', () => {
  it('keeps one of three sample comments: the one linking to a supported ATS job', async () => {
    const r = await hnAdapter.fetch(ctx());
    expect(r.status).toBe('ok');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      source: 'hn',
      companyName: 'Lanternworks',
      title: 'Senior Backend Engineer',
      ats: 'lever',
      atsJobId: '3b9c7e10-2d5a-4f61-8e47-9c0a1b2d3e4f',
      location: 'Remote (EU)',
      url: 'https://jobs.lever.co/lanternworks/3b9c7e10-2d5a-4f61-8e47-9c0a1b2d3e4f?lever-source=hn',
    });
    expect(r.candidates[0]!.description).toContain('We build observability tooling');
  });

  it('finds only the current month thread', () => {
    expect(isThreadFor('Ask HN: Who is hiring? (November 2026)', NOW)).toBe(true);
    expect(isThreadFor('Ask HN: Who is hiring? (October 2026)', NOW)).toBe(false);
    expect(isThreadFor('Ask HN: Who wants to be hired? (November 2026)', NOW)).toBe(false);
  });

  it('a comment with a careers page or an email yields nothing', () => {
    const items = fixtureJson<Record<string, never>>('hn-items.json');
    expect(parseComment(items['91000002']!)).toEqual([]);
    expect(parseComment(items['91000003']!)).toEqual([]);
    expect(parseComment(items['91000004']!)).toEqual([]);
  });

  it('a board link without a job id is not an application URL', () => {
    expect(
      parseComment({
        id: 1,
        text: 'Acme | Eng | Remote<p><a href="https://jobs.lever.co/acme">board</a>',
      }),
    ).toEqual([]);
  });

  it('unreachable Hacker News is unavailable, not an error', async () => {
    w.world.hn = false;
    const r = await hnAdapter.fetch(ctx());
    expect(r.status).toBe('unavailable');
  });

  it('no thread for the month is an empty ok result', async () => {
    const r = await hnAdapter.fetch(ctx({ now: new Date('2027-03-01T00:00:00Z') }));
    expect(r).toMatchObject({ status: 'ok', candidates: [] });
  });

  it('a failed comment fetch makes the source partial', async () => {
    w.server.use(
      http.get(
        'https://hacker-news.firebaseio.com/v0/item/91000002.json',
        () => new HttpResponse('x', { status: 500 }),
      ),
    );
    const r = await hnAdapter.fetch(ctx());
    expect(r.status).toBe('partial');
    expect(r.candidates).toHaveLength(1);
  });
});

describe('linkedin-public', () => {
  it('parses search cards and the outbound ATS link', () => {
    const cards = parseSearchCards(fixtureText('linkedin-search.html'));
    expect(cards).toEqual([
      {
        jobId: '3900000001',
        title: 'Senior Backend Engineer',
        company: 'Brightforge',
        location: 'Lisbon, Portugal',
      },
      {
        jobId: '3900000002',
        title: 'Backend Developer',
        company: 'Orchard Co',
        location: 'Porto, Portugal',
      },
    ]);
    expect(externalAtsUrl(fixtureText('linkedin-detail-ats.html'))).toBe(
      'https://jobs.ashbyhq.com/brightforge/8f2b6c1e-0d44-4f37-9a55-2e3c8b7d1a60?utm_source=linkedin',
    );
    expect(externalAtsUrl(fixtureText('linkedin-detail-easyapply.html'))).toBeNull();
  });

  it('maps results that link to a supported ATS and drops the rest', async () => {
    const r = await linkedinAdapter.fetch(ctx());
    expect(r.status).toBe('ok');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      source: 'linkedin',
      companyName: 'Brightforge',
      ats: 'ashby',
      atsJobId: '8f2b6c1e-0d44-4f37-9a55-2e3c8b7d1a60',
    });
  });

  it('marks the source unavailable on a 999 without throwing', async () => {
    w.world.linkedin = 'blocked';
    expect(await linkedinAdapter.fetch(ctx())).toMatchObject({
      status: 'unavailable',
      candidates: [],
    });
  });

  it('marks the source unavailable on a login-wall redirect without throwing', async () => {
    w.world.linkedin = 'redirect';
    expect(await linkedinAdapter.fetch(ctx())).toMatchObject({
      status: 'unavailable',
      candidates: [],
    });
  });

  it('a login wall served as a 200 page is also unavailable', async () => {
    w.server.use(
      http.get(
        'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobSearch/search',
        () =>
          new HttpResponse('<html><body><form action="/uas/login">authwall</form></body></html>'),
      ),
    );
    expect(await linkedinAdapter.fetch(ctx())).toMatchObject({ status: 'unavailable' });
  });

  it('empty results are ok and empty', async () => {
    w.server.use(
      http.get(
        'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobSearch/search',
        () => new HttpResponse('<ul></ul>'),
      ),
    );
    expect(await linkedinAdapter.fetch(ctx())).toEqual({ status: 'ok', candidates: [] });
  });
});

describe('regions and embedded Greenhouse links', () => {
  it('a Lever EU board is fetched from api.eu.lever.co and keeps its public URL', async () => {
    const urls: string[] = [];
    w.server.use(
      http.get('https://api.eu.lever.co/v0/postings/:slug', ({ request }) => {
        urls.push(request.url);
        return HttpResponse.json([
          { id: '0c7c1a52-3f0e-4c63-8b8e-5a1f6d2b9e11', text: 'Engineer' },
        ]);
      }),
    );
    const eu = {
      companyId: 'c-eu',
      companyName: 'Euro Co',
      ats: 'lever' as const,
      boardSlug: 'euroco',
      region: 'eu' as const,
    };
    const r = await leverAdapter.fetch(ctx({ boards: [eu] }));
    expect(r.status).toBe('ok');
    expect(urls).toEqual(['https://api.eu.lever.co/v0/postings/euroco?mode=json']);
    expect(r.candidates[0]!.url).toBe(
      'https://jobs.eu.lever.co/euroco/0c7c1a52-3f0e-4c63-8b8e-5a1f6d2b9e11',
    );
  });

  it('an HN comment linking to an embedded Greenhouse application is kept with its job id', () => {
    const out = parseComment({
      id: 9,
      time: 1_762_000_000,
      text: 'Acme | Backend Engineer | Remote<p>Apply: <a href="https://boards.greenhouse.io/embed/job_app?for=acme&amp;token=5551234">here</a>',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ats: 'greenhouse', atsJobId: '5551234' });
  });
});
