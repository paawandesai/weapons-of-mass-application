`apps/api/src/middleware/session.ts`. Loads the session by cookie, 401 when absent or expired, sets `user` and `handle` (from `db.forTenant`) for downstream routes.
