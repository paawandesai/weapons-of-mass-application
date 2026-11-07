import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request, type FullConfig } from '@playwright/test';

/** Reads one key from the repository's .env when it is not already in the environment. */
function fromDotenv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  const file = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] === key) return m[2]!.replace(/^["']|["']$/g, '');
  }
  return undefined;
}

/**
 * Signs in as the demo user (POST /auth/demo with DEMO_LOGIN_TOKEN) and stores the session
 * cookie where the config's `storageState` expects it.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const token = fromDotenv('DEMO_LOGIN_TOKEN');
  if (!token) throw new Error('DEMO_LOGIN_TOKEN must be set to run the e2e tests');
  const project = config.projects[0]!;
  const baseURL = project.use.baseURL ?? 'http://localhost:5173';
  const storagePath = resolve(project.testDir, '.auth/state.json');
  mkdirSync(dirname(storagePath), { recursive: true });
  const ctx = await request.newContext({ baseURL });
  const res = await ctx.post('/auth/demo', { headers: { 'X-Demo-Token': token } });
  if (!res.ok()) {
    throw new Error(
      `demo sign-in failed (${res.status()}): is the API running with DEMO_LOGIN_TOKEN set and the demo tenant seeded?`,
    );
  }
  // The fixtures `seed:demo --scenarios` provisions. Missing ones fail the run here instead of
  // letting specs skip themselves.
  const missing: string[] = [];
  for (const status of ['applied', 'interviewing', 'offer']) {
    const r = await ctx.get(`/api/applications?status=${status}`);
    const body = r.ok() ? ((await r.json()) as { applications: unknown[] }) : null;
    if (!body || body.applications.length === 0) missing.push(`an application in ${status}`);
  }
  const run = await ctx.get('/api/runs/current');
  const current = run.ok()
    ? ((await run.json()) as { run: { status: string } | null; candidates: unknown[] })
    : null;
  if (current?.run?.status !== 'running' || current.candidates.length === 0) {
    missing.push('a running run with candidates');
  }
  if (missing.length > 0) {
    throw new Error(
      `e2e fixtures are missing (${missing.join(', ')}): run 'pnpm seed:demo --scenarios' first`,
    );
  }
  await ctx.storageState({ path: storagePath });
  await ctx.dispose();
}
