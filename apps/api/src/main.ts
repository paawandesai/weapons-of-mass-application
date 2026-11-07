import { serve } from '@hono/node-server';
import { loadEnv, vault } from '@wma/db';
import { createApp } from './app';
import { getDb } from './db';
import { checkDemoTenants } from './demo-check';

loadEnv();
vault.assertVaultConfigured();
if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET must be set');
await checkDemoTenants(getDb());
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`api listening on :${info.port}`);
});
