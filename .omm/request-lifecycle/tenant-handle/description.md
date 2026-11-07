`packages/db/src/client.ts` `TenantHandle` and the repo functions in `packages/db/src/repos/`, each taking the handle first so every query is filtered by `tenant_id`.
