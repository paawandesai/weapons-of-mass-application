import { Hono } from 'hono';
import type { Db } from '@wma/db';
import { authRoutes } from './auth/routes';
import { getDb } from './db';
import { requireSession, type AppEnv } from './middleware/session';
import { adminRoutes } from './routes/admin';
import { applicationsRoutes } from './routes/applications';
import { boardRoutes } from './routes/board';
import { captchaRoutes } from './routes/captcha';
import { companiesRoutes } from './routes/companies';
import { confirmRoutes } from './routes/confirm';
import { interviewsRoutes } from './routes/interviews';
import { meRoutes } from './routes/me';
import { profileRoutes } from './routes/profile';
import { runsRoutes } from './routes/runs';
import { searchRoutes } from './routes/search';
import { settingsRoutes } from './routes/settings';
import { sourcesRoutes } from './routes/sources';
import { surveyRoutes } from './routes/survey';

export interface AppOptions {
  db?: Db;
  /** Clock override for tests. */
  now?: () => Date;
}

export function createApp(opts: AppOptions = {}) {
  const app = new Hono<AppEnv>();
  const now = opts.now ?? (() => new Date());

  app.use('*', async (c, next) => {
    c.set('db', opts.db ?? getDb());
    c.set('now', now);
    await next();
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.route('/auth', authRoutes);

  app.use('/api/*', requireSession);
  app.route('/api/me', meRoutes);
  app.route('/api/sources', sourcesRoutes);
  app.route('/api/profile', profileRoutes);
  app.route('/api/survey', surveyRoutes);
  app.route('/api/companies', companiesRoutes);
  app.route('/api/runs', runsRoutes);
  app.route('/api/applications', applicationsRoutes);
  app.route('/api/settings', settingsRoutes);
  app.route('/api/board', boardRoutes);
  app.route('/api/search', searchRoutes);
  app.route('/api/interviews', interviewsRoutes);
  app.route('/api/admin', adminRoutes);
  // Public: the visitor holds only a single-use token, so this is outside requireSession.
  app.route('/captcha', captchaRoutes);
  app.route('/confirm', confirmRoutes);

  app.notFound((c) =>
    c.req.path.startsWith('/api/')
      ? c.json({ code: 'not_found', message: 'Not found' }, 404)
      : c.text('Not found', 404),
  );
  app.onError((e, c) => {
    console.error('request failed:', e.name);
    return c.json({ code: 'internal', message: 'Something went wrong' }, 500);
  });
  return app;
}
