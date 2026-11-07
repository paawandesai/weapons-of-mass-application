`app.use('*')` sets `db` (injected or `getDb()`) and `now` on the Hono context. Tests pass an in-memory-backed Db and a fixed clock.
