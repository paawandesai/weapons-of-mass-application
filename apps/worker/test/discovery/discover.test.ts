import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { insertApplication, upsertJob } from '@wma/db';
import { dropAlreadyApplied } from '../../src/discovery/applied';
import { discover } from '../../src/discovery/discover';
import type { RemovedCompany, SourceAdapter } from '../../src/discovery/types';
import { setupEnv, type TestEnv } from '../helpers';
import {
  boardRefs,
  candidate,
  createWorld,
  fastHttp,
  NOW,
  profile,
  staticAdapter,
} from './support';

const w = createWorld();
let env: TestEnv;
beforeAll(async () => {
  w.server.listen({ onUnhandledRequest: 'error' });
  env = await setupEnv();
});
afterEach(() => w.reset());
afterAll(async () => {
  w.server.close();
  await env.cleanup();
});

const run = (over: { adapters?: SourceAdapter[]; removed?: RemovedCompany[] } = {}) =>
  discover({ boards: boardRefs, profile, http: fastHttp(), now: NOW, ...over });

describe('discover', () => {
  it('runs every source with per-source status and dedupes across them', async () => {
    const r = await run();
    expect(Object.keys(r.sourceStatus).sort()).toEqual([
      'ashby',
      'greenhouse',
      'hn-who-is-hiring',
      'lever',
      'linkedin-public',
    ]);
    expect(r.sourceStatus.greenhouse).toMatchObject({ status: 'ok', candidates: 2 });
    expect(r.sourceStatus['hn-who-is-hiring']).toMatchObject({ status: 'ok', candidates: 1 });
    // LinkedIn's Brightforge posting is the same job as the Ashby board posting.
    expect(r.sourceStatus['linkedin-public']).toMatchObject({ status: 'ok', candidates: 1 });
    expect(r.fetched).toBe(2 + 2 + 1 + 1 + 1);
    expect(r.candidates).toHaveLength(6);
    expect(r.inRunDuplicates).toBe(1);
    expect(r.fetched).toBe(r.candidates.length + r.inRunDuplicates);
  });

  it('keeps the board candidate when HN links to the same posting', async () => {
    const board = candidate({
      source: 'ashby',
      title: 'Senior Backend Engineer',
      companyName: 'Brightforge',
      companyId: 'c-ab',
      url: 'https://jobs.ashbyhq.com/brightforge/8f2b6c1e-0d44-4f37-9a55-2e3c8b7d1a60',
      ats: 'ashby',
      atsJobId: '8f2b6c1e-0d44-4f37-9a55-2e3c8b7d1a60',
      description: 'board description',
    });
    const hn = candidate({
      source: 'hn',
      title: 'Backend',
      companyName: 'Brightforge Inc',
      url: 'https://jobs.ashbyhq.com/brightforge/8f2b6c1e-0d44-4f37-9a55-2e3c8b7d1a60?utm_source=hn',
      ats: 'ashby',
      atsJobId: '8f2b6c1e-0d44-4f37-9a55-2e3c8b7d1a60',
      description: 'hn text',
    });
    // HN first in the adapter list: the board version must still win.
    for (const order of [
      [staticAdapter('hn-who-is-hiring', [hn]), staticAdapter('ashby', [board])],
      [staticAdapter('ashby', [board]), staticAdapter('hn-who-is-hiring', [hn])],
    ]) {
      const r = await run({ adapters: order });
      expect(r.candidates).toHaveLength(1);
      expect(r.candidates[0]).toMatchObject({
        source: 'ashby',
        description: 'board description',
        companyId: 'c-ab',
      });
      expect(r.inRunDuplicates).toBe(1);
    }
  });

  it('collapses one posting under two URLs (tracking parameters) into one candidate', async () => {
    const a = candidate({ title: 'X', url: 'https://example.com/jobs/1?utm_source=a&gh_jid=77' });
    const b = candidate({
      title: 'X',
      url: 'https://example.com/jobs/1/?gh_jid=77&utm_medium=b#top',
    });
    const r = await run({ adapters: [staticAdapter('hn-who-is-hiring', [a, b])] });
    expect(r.candidates).toHaveLength(1);
  });

  it('an adapter that throws becomes unavailable; the others still run', async () => {
    const boom: SourceAdapter = {
      id: 'lever',
      fetch: async () => {
        throw new Error('kaput');
      },
    };
    const r = await run({ adapters: [boom, staticAdapter('ashby', [candidate({ title: 'Y' })])] });
    expect(r.sourceStatus.lever).toMatchObject({ status: 'unavailable', candidates: 0 });
    expect(r.candidates).toHaveLength(1);
  });

  it('every source unavailable gives zero candidates, not an error', async () => {
    w.world.hn = false;
    w.world.linkedin = 'blocked';
    w.world.failing.add('greenhouse:northwind-labs');
    w.world.failing.add('lever:quillbase');
    w.world.failing.add('ashby:brightforge');
    const r = await run();
    expect(r.candidates).toEqual([]);
    expect(Object.values(r.sourceStatus).every((s) => s.status === 'unavailable')).toBe(true);
  });
});

describe('removed companies', () => {
  const hn = candidate({
    source: 'hn',
    title: 'Backend Engineer',
    companyName: 'Zenith Robotics',
    url: 'https://jobs.lever.co/zenith/0c7c1a52-3f0e-4c63-8b8e-5a1f6d2b9e11',
    ats: 'lever',
    atsJobId: '0c7c1a52-3f0e-4c63-8b8e-5a1f6d2b9e11',
  });
  const other = candidate({
    source: 'linkedin',
    title: 'Data Engineer',
    companyName: 'Fine Co',
    url: 'https://jobs.lever.co/fineco/1c7c1a52-3f0e-4c63-8b8e-5a1f6d2b9e11',
    ats: 'lever',
    atsJobId: '1c7c1a52-3f0e-4c63-8b8e-5a1f6d2b9e11',
  });
  const adapters = [
    staticAdapter('hn-who-is-hiring', [hn]),
    staticAdapter('linkedin-public', [other]),
  ];

  it('drops HN and LinkedIn postings that point at a removed company board', async () => {
    const r = await run({
      adapters,
      removed: [{ name: 'Something Else', ats: 'lever', boardSlug: 'zenith', region: '' }],
    });
    expect(r.candidates.map((c) => c.title)).toEqual(['Data Engineer']);
    expect(r.removedCompany).toBe(1);
    // fetched counts only what survived, so fetched = deduped + in-run duplicates still holds
    expect(r.fetched).toBe(r.candidates.length + r.inRunDuplicates);
  });

  it('drops them by normalized company name when the link names no board on the list', async () => {
    const r = await run({
      adapters,
      removed: [{ name: 'ZENITH Robotics, Inc.', ats: null, boardSlug: null, region: '' }],
    });
    expect(r.candidates.map((c) => c.title)).toEqual(['Data Engineer']);
    expect(r.removedCompany).toBe(1);
  });

  it('a removed Lever EU board does not remove the US board of the same slug', async () => {
    const r = await run({
      adapters,
      removed: [{ name: 'Nope', ats: 'lever', boardSlug: 'zenith', region: 'eu' }],
    });
    expect(r.candidates).toHaveLength(2);
    expect(r.removedCompany).toBe(0);
  });

  it('nothing is dropped when nothing was removed', async () => {
    const r = await run({ adapters, removed: [] });
    expect(r.candidates).toHaveLength(2);
  });
});

describe('dropAlreadyApplied', () => {
  it('drops a candidate matching an existing application by URL only', async () => {
    const t = await env.makeTenant();
    const { job } = await upsertJob(t.handle, {
      title: 'Platform Engineer',
      url: 'https://careers.example.org/jobs/platform-engineer?gh_jid=555',
    });
    await insertApplication(t.handle, { userId: t.userId, jobId: job.id, status: 'closed' });
    const tracked = candidate({
      title: 'Platform Engineer',
      url: 'https://CAREERS.example.org/jobs/platform-engineer/?utm_source=x&gh_jid=555#apply',
    });
    const other = candidate({
      title: 'Other',
      url: 'https://careers.example.org/jobs/other?gh_jid=556',
    });
    const r = await dropAlreadyApplied(t.handle, t.userId, [tracked, other]);
    expect(r.dropped).toEqual([tracked]);
    expect(r.kept).toEqual([other]);
  });

  it('matches by ATS job id regardless of url shape, and only for this user', async () => {
    const a = await env.makeTenant();
    const b = await env.makeTenant();
    const { job } = await upsertJob(a.handle, {
      ats: 'lever',
      atsJobId: '3b9c7e10-2d5a-4f61-8e47-9c0a1b2d3e4f',
      title: 'Senior Backend Engineer',
      url: 'https://jobs.lever.co/lanternworks/3b9c7e10-2d5a-4f61-8e47-9c0a1b2d3e4f',
    });
    await insertApplication(a.handle, { userId: a.userId, jobId: job.id });
    const c = candidate({
      title: 'Senior Backend Engineer',
      url: 'https://jobs.lever.co/lanternworks/3b9c7e10-2d5a-4f61-8e47-9c0a1b2d3e4f/apply?lever-source=hn',
    });
    expect((await dropAlreadyApplied(a.handle, a.userId, [c])).dropped).toHaveLength(1);
    expect((await dropAlreadyApplied(b.handle, b.userId, [c])).dropped).toHaveLength(0);
  });
});
