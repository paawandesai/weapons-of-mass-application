import { DEFAULT_DATABASE_URL, loadEnv } from './env';
import { runMigrations } from './migrate';

loadEnv();
const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
await runMigrations({ url, appPassword: process.env.APP_DB_PASSWORD });
console.log('migrations applied');
