import { DEFAULT_DATABASE_URL, loadEnv, vault } from '@wma/db';
import { createLlmClient } from '@wma/llm';
import { createBoss } from './boss';
import { createAppDb } from './db';
import { googleDrivePort } from './drive';
import { registerJobs } from './register';
import { closeSharedBrowser } from './submission/browser';

loadEnv();
// Fail before any job can be consumed: Drive reads need the vault, and a build must not complete
// under an invalid vault configuration.
vault.assertVaultConfigured();
const llm = createLlmClient();
const boss = createBoss(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
boss.on('error', (err) => console.error('pg-boss error', err));
await boss.start();
const db = createAppDb();
await registerJobs(boss, db, { llm, drive: googleDrivePort });
console.log('worker started');

const stop = async () => {
  await boss.stop();
  await closeSharedBrowser();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
