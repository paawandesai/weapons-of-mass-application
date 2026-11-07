import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activity, getApplication, getFile, listCaptchaRequestsForApplication } from '@wma/db';
import { FakeLlm, type StructuredRequest } from '@wma/llm';
import { runSubmission } from '../../src/submission/job';
import type { BrowserLike } from '../../src/submission/deps';
import type { FormAdapter } from '../../src/submission/types';
import { PROFILE } from '../fixtures/submission';
import {
  approveProfile,
  makeDeps,
  seedApplication,
  setupSubmissionEnv,
  type SubmissionEnv,
} from './support';

const here = dirname(fileURLToPath(import.meta.url));
const FORMS = join(here, '../fixtures/forms');
const SRC = join(here, '../../src/submission');
// Task 8.1 needs the real adapters, answers and form fixtures; skipped until they exist.
const available =
  existsSync(join(SRC, 'adapters/index.ts')) &&
  existsSync(join(SRC, 'answers/index.ts')) &&
  existsSync(join(FORMS, 'greenhouse/form.html'));

// The saved forms ask Yes/No questions about the United States; the profile states it.
const E2E_PROFILE = {
  ...PROFILE,
  standard_answers: {
    ...PROFILE.standard_answers,
    work_authorization: 'Authorized to work in the United States',
  },
};

const VENDORS = [
  { name: 'greenhouse', host: 'boards.greenhouse.io', query: '' },
  { name: 'lever', host: 'jobs.lever.co', query: '' },
  { name: 'ashby', host: 'jobs.ashbyhq.com', query: '' },
] as const;

let env: SubmissionEnv;
let browser: Browser;
let realBrowser: BrowserLike;
let adapterFor: (name: string) => FormAdapter;
let realResolveAnswers: typeof import('../../src/submission/answers').resolveAnswers;

beforeAll(async () => {
  if (!available) return;
  env = await setupSubmissionEnv();
  browser = await chromium.launch();
  realBrowser = { newContext: () => browser.newContext() };
  const adapters = await import('../../src/submission/adapters');
  adapterFor = (name) => adapters.adapters.find((a) => a.ats === name)!;
  realResolveAnswers = (await import('../../src/submission/answers')).resolveAnswers;
});
afterAll(async () => {
  await browser?.close();
  await env?.cleanup();
});

/** The real adapter, pointed at a saved form instead of the live board. */
function atFixture(adapter: FormAdapter, url: string): FormAdapter {
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'load') return (page: never) => target.load(page, url);
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** The question block of an answer-form-question request, as the resolver sent it. */
function questionOf(req: StructuredRequest): { options: string[] | null; field_type: string } {
  const raw = /<question>\n([\s\S]*?)\n<\/question>/.exec(req.user)?.[1] ?? '{}';
  return JSON.parse(
    raw
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&'),
  );
}

const llm = () =>
  new FakeLlm([
    (req: StructuredRequest) => {
      if (req.prompt.startsWith('answer-form-question')) {
        const { options, field_type } = questionOf(req);
        return {
          answer:
            field_type === 'checkbox' && !options?.length
              ? 'Yes'
              : (options?.[0] ?? 'I enjoy building platforms.'),
          grounded: true,
          unanswerable: false,
          ungrounded_claims: [],
        };
      }
      if (req.prompt.startsWith('solve-captcha')) return { answer: '7K3Q' };
      return { classification: 'free-text', standard_key: null };
    },
  ]);

describe.skipIf(!available)('task 8.1: hand-off to applied on the three vendor forms', () => {
  for (const v of VENDORS) {
    it(`${v.name}: applied with a resume, the answers and the activity trail`, async () => {
      const t = await env.makeTenant();
      await approveProfile(t, E2E_PROFILE);
      const s = await seedApplication(t);
      const form = pathToFileURL(join(FORMS, v.name, 'form.html')).toString();
      const deps = makeDeps(env.db, { llm: llm() });
      deps.selectAdapter = () => atFixture(adapterFor(v.name), form);
      deps.launchBrowser = async () => realBrowser;
      deps.resolveAnswers = (ctx, fields) => realResolveAnswers(ctx, fields);

      const out = await runSubmission(deps, env.db, {
        tenantId: t.id,
        userId: t.userId,
        applicationId: s.application.id,
      });
      expect(out).toMatchObject({ outcome: 'applied', source: 'page' });
      const row = await getApplication(t.handle, s.application.id);
      expect(row).toMatchObject({ status: 'applied', confirmationSource: 'page' });
      expect(row!.resumePdfRef).toBe(`tenants/${t.id}/applications/${s.application.id}/resume.pdf`);
      expect(await getFile(t.handle, row!.resumePdfRef!)).not.toBeNull();
      expect(Object.keys(row!.formAnswers as object).length).toBeGreaterThan(3);
      const trail = (await activity.listByApplication(t.handle, s.application.id))
        .reverse()
        .map((e) => e.action);
      expect(trail).toEqual([
        'submission-started',
        'tailored',
        'filled',
        'submitting',
        'submitted',
      ]);
      expect(deps.followUps).toHaveLength(1);
      if (v.name === 'ashby') {
        // A grouped checkbox is answered with the chosen option strings, not a boolean.
        const stack = Object.entries(row!.formAnswers as Record<string, unknown>).find(([q]) =>
          q.startsWith('Which of these have you used'),
        );
        expect(stack?.[1]).toEqual(['Kubernetes']);
      }
    }, 60000);
  }

  it('greenhouse with a CAPTCHA: the first solver clears it', async () => {
    const t = await env.makeTenant();
    await approveProfile(t, E2E_PROFILE);
    const s = await seedApplication(t);
    const form = pathToFileURL(join(FORMS, 'greenhouse/form.html')).toString() + '?captcha';
    const deps = makeDeps(env.db, { llm: llm() });
    deps.selectAdapter = () => atFixture(adapterFor('greenhouse'), form);
    deps.launchBrowser = async () => realBrowser;
    deps.resolveAnswers = (ctx, fields) => realResolveAnswers(ctx, fields);
    const out = await runSubmission(deps, env.db, {
      tenantId: t.id,
      userId: t.userId,
      applicationId: s.application.id,
    });
    expect(out.outcome).toBe('applied');
    const [req] = await listCaptchaRequestsForApplication(t.handle, s.application.id);
    expect(req).toMatchObject({ resolvedBy: 'agent1' });
  }, 60000);
});
