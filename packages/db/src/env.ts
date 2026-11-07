import { resolve } from 'node:path';
import dotenv from 'dotenv';

export const DEFAULT_DATABASE_URL = 'postgres://wma:wma@localhost:5432/wma';

/** Loads the repo-root .env (dev only; real environment variables win). */
export function loadEnv(): void {
  dotenv.config({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });
}
