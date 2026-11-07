`createAppDb()` plus `db.forTenant(tenantId)` per job. Owns pg-boss supervision and schedules. Takes advisory locks (`repos/locks.ts`) and `FOR NO KEY UPDATE` row locks where jobs may race.
