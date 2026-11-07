import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, lt } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { demoCalendarEvents } from '../schema';

export type DemoCalendarEventRow = typeof demoCalendarEvents.$inferSelect;

export interface DemoEventInput {
  userId: string;
  /** Defaults to a generated `demo-evt-<uuid>`. */
  clientId?: string;
  summary: string;
  description?: string;
  startsAt: Date;
  endsAt: Date;
}

/** Get-or-create by `clientId`: an existing event under the id is updated, never duplicated. */
export async function upsertDemoEvent(
  handle: TenantHandle,
  input: DemoEventInput,
): Promise<DemoCalendarEventRow> {
  const rows = await handle.run((tx) =>
    tx
      .insert(demoCalendarEvents)
      .values({
        tenantId: handle.tenantId,
        userId: input.userId,
        clientId: input.clientId ?? `demo-evt-${randomUUID()}`,
        summary: input.summary,
        description: input.description ?? '',
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      })
      .onConflictDoUpdate({
        target: [demoCalendarEvents.tenantId, demoCalendarEvents.clientId],
        set: {
          summary: input.summary,
          description: input.description ?? '',
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          updatedAt: new Date(),
        },
      })
      .returning(),
  );
  return rows[0]!;
}

/** Updates an existing event; null when no event has that client id. */
export async function updateDemoEvent(
  handle: TenantHandle,
  clientId: string,
  patch: Partial<Pick<DemoEventInput, 'summary' | 'description' | 'startsAt' | 'endsAt'>>,
): Promise<DemoCalendarEventRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(demoCalendarEvents)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(demoCalendarEvents.tenantId, handle.tenantId),
          eq(demoCalendarEvents.clientId, clientId),
        ),
      )
      .returning(),
  );
  return rows[0] ?? null;
}

export async function getDemoEvent(
  handle: TenantHandle,
  clientId: string,
): Promise<DemoCalendarEventRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(demoCalendarEvents)
      .where(
        and(
          eq(demoCalendarEvents.tenantId, handle.tenantId),
          eq(demoCalendarEvents.clientId, clientId),
        ),
      ),
  );
  return rows[0] ?? null;
}

/** Events overlapping [from, to) when a window is given, else all; ordered by start. */
export function listDemoEvents(
  handle: TenantHandle,
  userId: string,
  window?: { from: Date; to: Date },
): Promise<DemoCalendarEventRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(demoCalendarEvents)
      .where(
        and(
          eq(demoCalendarEvents.tenantId, handle.tenantId),
          eq(demoCalendarEvents.userId, userId),
          ...(window
            ? [
                lt(demoCalendarEvents.startsAt, window.to),
                gt(demoCalendarEvents.endsAt, window.from),
              ]
            : []),
        ),
      )
      .orderBy(asc(demoCalendarEvents.startsAt), asc(demoCalendarEvents.id)),
  );
}
