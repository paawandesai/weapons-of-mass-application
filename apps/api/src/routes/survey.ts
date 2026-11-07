import { Hono } from 'hono';
import { z } from 'zod';
import { activity, getLatestProfileBuild } from '@wma/db';
import { surveySubmissionSchema } from '@wma/shared';
import type { AppEnv } from '../middleware/session';
import { hasResume, requestProfileBuild } from '../services/builds';
import { invalidJson, readJson, validationError } from '../services/http';
import { pgBossQueue, type BuildQueue } from '../services/queue';
import { builtFromList, findLatestProfile } from '../services/review';
import { getSurveyAnswers, saveSurvey } from '../services/survey';

export interface SurveyDeps {
  queue?: BuildQueue;
}

export function createSurveyRoutes(deps: SurveyDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const { handle, userId } = c.get('session');
    return c.json({ answers: await getSurveyAnswers(handle, userId) });
  });

  app.put('/', async (c) => {
    const { handle, userId } = c.get('session');
    const raw = await readJson(c);
    if (raw === undefined) return invalidJson(c);
    const parsed = z.object({ answers: surveySubmissionSchema }).safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error);
    const version = await saveSurvey(handle, userId, parsed.data.answers);

    // The survey is saved; starting the first build is best effort and never fails the save.
    let buildStarted = false;
    try {
      const latest = await findLatestProfile(handle, userId);
      const neverBuilt = !latest || builtFromList(latest.builtFrom).length === 0;
      if (neverBuilt && (await hasResume(handle, userId))) {
        const before = await getRunningBuildId(handle, userId);
        const jobId = await requestProfileBuild(handle, userId, deps.queue ?? pgBossQueue);
        if (before !== jobId) {
          buildStarted = true;
          await activity.logActivity(handle, {
            userId,
            actor: 'user',
            action: 'profile_build_requested',
            detail: { job_id: jobId, trigger: 'survey' },
          });
        }
      }
    } catch (e) {
      console.error('survey: could not start the first profile build', e);
    }
    return c.json({ version, build_started: buildStarted });
  });

  return app;
}

async function getRunningBuildId(
  handle: Parameters<typeof hasResume>[0],
  userId: string,
): Promise<string | null> {
  const b = await getLatestProfileBuild(handle, userId);
  return b && b.state === 'running' ? b.id : null;
}

export const surveyRoutes = createSurveyRoutes();
