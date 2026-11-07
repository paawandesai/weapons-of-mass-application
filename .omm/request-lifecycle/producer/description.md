`services/queue.ts` (`profile.build`, producer-only PgBoss) and `services/confirm.ts` (`book-interview`, `schedule-reminders` with `${interviewId}:${slotId}` singleton keys). The API never consumes.
