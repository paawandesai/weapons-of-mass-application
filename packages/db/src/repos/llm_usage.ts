import { and, desc, eq, gte, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { LlmCallRecord, LlmPurpose, LlmUsageTotals } from '@wma/shared';
import type { TenantHandle } from '../client';
import { llmUsage } from '../schema';

export type LlmUsageRow = typeof llmUsage.$inferSelect;

export interface LlmUsageInput extends LlmCallRecord {
  userId: string;
}

/** Appends one call to the ledger. Called by the LLM tracking wrapper after every completed call. */
export async function recordLlmUsage(handle: TenantHandle, input: LlmUsageInput): Promise<void> {
  await handle.run((tx) =>
    tx.insert(llmUsage).values({
      tenantId: handle.tenantId,
      userId: input.userId,
      applicationId: input.applicationId ?? null,
      purpose: input.purpose,
      prompt: input.prompt,
      model: input.model,
      inputTokens: input.usage.input_tokens,
      outputTokens: input.usage.output_tokens,
      cacheCreationInputTokens: input.usage.cache_creation_input_tokens,
      cacheReadInputTokens: input.usage.cache_read_input_tokens,
      costUsd: input.costUsd === null ? null : input.costUsd.toFixed(8),
      durationMs: input.durationMs,
    }),
  );
}

export interface UsageWindow {
  /** Only calls at or after this instant. */
  since?: Date;
}

const totalsColumns = {
  calls: sql<number>`count(*)::int`,
  input_tokens: sql<number>`coalesce(sum(${llmUsage.inputTokens}), 0)::bigint`,
  output_tokens: sql<number>`coalesce(sum(${llmUsage.outputTokens}), 0)::bigint`,
  cache_creation_input_tokens: sql<number>`coalesce(sum(${llmUsage.cacheCreationInputTokens}), 0)::bigint`,
  cache_read_input_tokens: sql<number>`coalesce(sum(${llmUsage.cacheReadInputTokens}), 0)::bigint`,
  cost_usd: sql<string>`coalesce(sum(${llmUsage.costUsd}), 0)`,
  unpriced_calls: sql<number>`count(*) filter (where ${llmUsage.costUsd} is null)::int`,
};

type RawTotals = {
  calls: number;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_creation_input_tokens: number | string;
  cache_read_input_tokens: number | string;
  cost_usd: string | number;
  unpriced_calls: number;
};

/** bigint sums arrive as strings from pg; numeric sums too. */
function toTotals(r: RawTotals): LlmUsageTotals {
  return {
    calls: Number(r.calls),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    cache_creation_input_tokens: Number(r.cache_creation_input_tokens),
    cache_read_input_tokens: Number(r.cache_read_input_tokens),
    cost_usd: Number(r.cost_usd),
    unpriced_calls: Number(r.unpriced_calls),
  };
}

function userScope(handle: TenantHandle, userId: string, window: UsageWindow): SQL {
  const parts: SQL[] = [eq(llmUsage.tenantId, handle.tenantId), eq(llmUsage.userId, userId)];
  if (window.since) parts.push(gte(llmUsage.at, window.since));
  return and(...parts)!;
}

export async function totalLlmUsage(
  handle: TenantHandle,
  userId: string,
  window: UsageWindow = {},
): Promise<LlmUsageTotals> {
  const rows = await handle.run((tx) =>
    tx
      .select(totalsColumns)
      .from(llmUsage)
      .where(userScope(handle, userId, window)),
  );
  return toTotals(rows[0]!);
}

export async function llmUsageByPurpose(
  handle: TenantHandle,
  userId: string,
  window: UsageWindow = {},
): Promise<Array<LlmUsageTotals & { purpose: LlmPurpose }>> {
  const rows = await handle.run((tx) =>
    tx
      .select({ purpose: llmUsage.purpose, ...totalsColumns })
      .from(llmUsage)
      .where(userScope(handle, userId, window))
      .groupBy(llmUsage.purpose)
      .orderBy(desc(sql`coalesce(sum(${llmUsage.costUsd}), 0)`), desc(sql`count(*)`)),
  );
  return rows.map((r) => ({ purpose: r.purpose as LlmPurpose, ...toTotals(r) }));
}

/** Per application, most expensive first. Calls with no application are left out. */
export async function llmUsageByApplication(
  handle: TenantHandle,
  userId: string,
  window: UsageWindow = {},
  limit = 50,
): Promise<Array<LlmUsageTotals & { applicationId: string }>> {
  const rows = await handle.run((tx) =>
    tx
      .select({ applicationId: llmUsage.applicationId, ...totalsColumns })
      .from(llmUsage)
      .where(and(userScope(handle, userId, window), isNotNull(llmUsage.applicationId)))
      .groupBy(llmUsage.applicationId)
      .orderBy(desc(sql`coalesce(sum(${llmUsage.costUsd}), 0)`), desc(sql`count(*)`))
      .limit(limit),
  );
  return rows.map((r) => ({ applicationId: r.applicationId!, ...toTotals(r) }));
}

/** Totals for one application (any user of the tenant; callers check ownership). */
export async function llmUsageForApplication(
  handle: TenantHandle,
  applicationId: string,
): Promise<LlmUsageTotals> {
  const rows = await handle.run((tx) =>
    tx
      .select(totalsColumns)
      .from(llmUsage)
      .where(
        and(eq(llmUsage.tenantId, handle.tenantId), eq(llmUsage.applicationId, applicationId)),
      ),
  );
  return toTotals(rows[0]!);
}

/** Newest calls first. Default 50, capped at 200. */
export async function listRecentLlmUsage(
  handle: TenantHandle,
  userId: string,
  limit = 50,
): Promise<LlmUsageRow[]> {
  const n = Math.min(Math.max(1, limit), 200);
  return handle.run((tx) =>
    tx
      .select()
      .from(llmUsage)
      .where(userScope(handle, userId, {}))
      .orderBy(desc(llmUsage.at), desc(llmUsage.id))
      .limit(n),
  );
}
