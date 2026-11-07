import { Hono } from 'hono';
import { z } from 'zod';
import { surveySubmissionSchema } from '@wma/shared';
import type { AppEnv } from '../middleware/session';
import { invalidJson, readJson, validationError } from '../services/http';
import { getSurveyAnswers, saveSurvey } from '../services/survey';

export const surveyRoutes = new Hono<AppEnv>();

surveyRoutes.get('/', async (c) => {
  const { handle, userId } = c.get('session');
  return c.json({ answers: await getSurveyAnswers(handle, userId) });
});

surveyRoutes.put('/', async (c) => {
  const { handle, userId } = c.get('session');
  const raw = await readJson(c);
  if (raw === undefined) return invalidJson(c);
  const parsed = z.object({ answers: surveySubmissionSchema }).safeParse(raw);
  if (!parsed.success) return validationError(c, parsed.error);
  const version = await saveSurvey(handle, userId, parsed.data.answers);
  return c.json({ version });
});
