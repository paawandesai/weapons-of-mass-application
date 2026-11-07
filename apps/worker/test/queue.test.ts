import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { getLatestProfileBuild, startProfileBuild } from '@wma/db';
import { FakeLlm } from '@wma/llm';
import { registerJobs } from '../src/register';
import { PROFILE_BUILD_JOB } from '../src/jobs/profile-build';
import { normalizeModelOutput } from '../src/profile/build';
import clean from './fixtures/llm/clean.json';
import { connect, setupEnv, type TestEnv } from './helpers';
import { GITHUB_TEXT, LINKEDIN_TEXT, RESUME_TEXT } from './fixtures/sources';

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';

let env: TestEnv;
let boss: PgBoss;
beforeAll(async () => {
  env = await setupEnv();
  boss = new PgBoss(ownerUrl);
  boss.on('error', () => {});
  await boss.start();
});
afterAll(async () => {
  await boss.stop({ graceful: false, timeout: 2000 });
  await env.cleanup();
});

describe('profile.build on pg-boss', () => {
  it('a queued job is picked up, builds a version, and the build row turns done', async () => {
    const t = await env.makeTenant();
    await connect(t, 'resume', { text: RESUME_TEXT });
    await connect(t, 'linkedin', {
      url: 'https://www.linkedin.com/in/mara-quill',
      text: LINKEDIN_TEXT,
    });
    await connect(t, 'github', { username: 'mara-quill', text: GITHUB_TEXT });
    const build = await startProfileBuild(t.handle, t.userId);

    await registerJobs(boss, env.db, { llm: new FakeLlm([clean]) });
    await boss.send(
      PROFILE_BUILD_JOB,
      { tenantId: t.id, userId: t.userId, buildId: build.id },
      { retryLimit: 0, singletonKey: build.id },
    );

    let row = await getLatestProfileBuild(t.handle, t.userId);
    for (let i = 0; i < 60 && row?.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 250));
      row = await getLatestProfileBuild(t.handle, t.userId);
    }
    expect(row).toMatchObject({ state: 'done', version: 1 });
  }, 30000);
});

describe('normalizeModelOutput', () => {
  it('turns empty contact strings into null, adds a scheme to bare links and maps Present to null', () => {
    const out = normalizeModelOutput({
      contact: {
        email: 'a@example.com',
        phone: '',
        linkedin_url: 'linkedin.com/in/x',
        github_url: 'https://github.com/x',
        website_url: '',
      },
      work_history: [
        { start_date: '2020-01', end_date: 'Present' },
        { start_date: '', end_date: '2021-02' },
      ],
      projects: [],
      education: [],
    }) as { contact: Record<string, unknown>; work_history: Array<Record<string, unknown>> };
    expect(out.contact).toMatchObject({
      phone: null,
      linkedin_url: 'https://linkedin.com/in/x',
      github_url: 'https://github.com/x',
      website_url: null,
    });
    expect(out.work_history).toEqual([
      { start_date: '2020-01', end_date: null },
      { start_date: null, end_date: '2021-02' },
    ]);
  });
});
