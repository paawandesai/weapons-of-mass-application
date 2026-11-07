`createApp(opts)` in `apps/api/src/app.ts`; `main.ts` serves it with `@hono/node-server` after `loadEnv`, `vault.assertVaultConfigured`, the `SESSION_SECRET` check and `checkDemoTenants`.
