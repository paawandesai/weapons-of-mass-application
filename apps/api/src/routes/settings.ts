import { Hono } from 'hono';
import { z } from 'zod';
import { getUserById, setNotificationSettings } from '@wma/db';
import type { AppEnv } from '../middleware/session';
import { invalidJson, readJson, validationError } from '../services/http';

/** Mounted at /api/settings behind requireSession. */
export const settingsRoutes = new Hono<AppEnv>();

/** The platform's canonical name for an IANA zone, or null for anything else (offsets included). */
function canonicalZone(tz: string): string | null {
  if (!tz || /^[+-]/.test(tz)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const notificationSettingsSchema = z
  .object({
    digest_hour: z.number().int().min(0).max(23).optional(),
    timezone: z
      .string()
      .refine((v) => canonicalZone(v) !== null, { message: 'not an IANA time zone' })
      .optional(),
  })
  .strict()
  .refine((v) => v.digest_hour !== undefined || v.timezone !== undefined, {
    message: 'give digest_hour, timezone or both',
  });

const view = (u: { digestHour: number; timezone: string }) => ({
  digest_hour: u.digestHour,
  timezone: u.timezone,
});

settingsRoutes.get('/notifications', async (c) => {
  const { handle, userId } = c.get('session');
  return c.json(view(await getUserById(handle, userId)));
});

settingsRoutes.put('/notifications', async (c) => {
  const { handle, userId } = c.get('session');
  const raw = await readJson(c);
  if (raw === undefined) return invalidJson(c);
  const parsed = notificationSettingsSchema.safeParse(raw);
  if (!parsed.success) return validationError(c, parsed.error);
  const user = await setNotificationSettings(handle, userId, {
    digestHour: parsed.data.digest_hour,
    timezone:
      parsed.data.timezone !== undefined
        ? (canonicalZone(parsed.data.timezone) ?? undefined)
        : undefined,
  });
  return c.json(view(user));
});
