import { createDb, DEFAULT_DATABASE_URL, type Db } from '@wma/db';

/** DATABASE_URL points at the owner role; the application must connect as the non-owner wma_app. */
export function appDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const u = new URL(env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  u.username = 'wma_app';
  u.password = env.APP_DB_PASSWORD || 'wma_app';
  return u.toString();
}

let shared: Db | null = null;

export function getDb(): Db {
  shared ??= createDb(appDatabaseUrl());
  return shared;
}
