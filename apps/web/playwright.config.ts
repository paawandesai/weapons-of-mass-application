import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the real API, worker and database. Start those first
 * (`pnpm dev` at the repository root); the web dev server is started here when it is not up.
 * The dev server proxies /api and /auth to the API on :3000, so one origin serves both.
 */
const WEB_PORT = process.env.WEB_PORT ?? '5173';
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${WEB_PORT}`;
export const STORAGE_STATE = 'e2e/.auth/state.json';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite --port ${WEB_PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
