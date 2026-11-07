import { serve } from '@hono/node-server';
import { loadEnv, vault } from '@wma/db';
import { createApp } from './app';

loadEnv();
vault.assertVaultConfigured();
if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET must be set');
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`api listening on :${info.port}`);
});
