import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { createDb } from '../client';
import { DEFAULT_DATABASE_URL, loadEnv } from '../env';
import * as schema from '../schema';
import { computeScore, render, type ScoreRows } from './score';

// `pnpm score [--tenant ID --user ID] [--since YYYY-MM-DD] [--json]` (docs/design/success-score.md).
// Defaults to the demo user so the command works on a fresh checkout.
loadEnv();
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const since = opt('since') ? new Date(`${opt('since')}T00:00:00Z`) : null;
if (since && Number.isNaN(since.getTime())) throw new Error('--since must be YYYY-MM-DD');

const db = createDb(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
try {
  let tenantId = opt('tenant');
  let userId = opt('user');
  if (!tenantId || !userId) {
    const demo = await db.demoUser();
    if (!demo) throw new Error('pass --tenant and --user (no demo tenant in this database)');
    tenantId ??= demo.tenantId;
    userId ??= demo.userId;
  }
  const handle = db.forTenant(tenantId);
  const uid = userId;
  const after = <T extends { createdAt: unknown }>(col: T['createdAt']) =>
    since ? gte(col as never, since) : undefined;

  const rows: ScoreRows = await handle.run(async (tx) => {
    const a = schema.applications;
    const applications = await tx
      .select({
        status: a.status,
        pendingReason: a.pendingReason,
        closedReason: a.closedReason,
        attemptCount: a.attemptCount,
        appliedAt: a.appliedAt,
        formAnswers: a.formAnswers,
      })
      .from(a)
      .where(and(eq(a.userId, uid), after<typeof a>(a.createdAt)));
    const i = schema.interviews;
    const interviews = await tx
      .select({
        confirmedAt: i.confirmedAt,
        calendarEventId: i.calendarEventId,
        replySentAt: i.replySentAt,
      })
      .from(i)
      .where(and(eq(i.userId, uid), after<typeof i>(i.createdAt)));
    const o = schema.outgoingMessages;
    const outgoing = await tx
      .select({ kind: o.kind, bodyText: o.bodyText, blocked: o.blocked })
      .from(o)
      .where(and(eq(o.userId, uid), after<typeof o>(o.createdAt)));
    const l = schema.activityLog;
    const [flags] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(l)
      .where(
        and(
          eq(l.userId, uid),
          eq(l.action, 'digest_flag'),
          sql`${l.detail} ->> 'kind' = 'no_free_slot'`,
          since ? gte(l.at, since) : undefined,
        ),
      );
    const c = schema.runCandidates;
    const r = schema.runs;
    const [judged] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(c)
      .innerJoin(r, and(eq(r.id, c.runId), eq(r.tenantId, c.tenantId)))
      .where(
        and(eq(r.userId, uid), isNotNull(c.judgment), since ? gte(r.startedAt, since) : undefined),
      );
    const t = schema.emailThreads;
    const [threads] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(t)
      .where(and(eq(t.userId, uid), since ? gte(t.lastMessageAt, since) : undefined));
    const u = schema.llmUsage;
    const [usage] = await tx
      .select({ n: sql<number>`count(*)::int`, cost: sql<string | null>`sum(${u.costUsd})` })
      .from(u)
      .where(and(eq(u.userId, uid), since ? gte(u.at, since) : undefined));
    return {
      applications: applications.map((x) => ({
        ...x,
        formAnswers: (x.formAnswers as Record<string, unknown> | null) ?? null,
      })),
      interviews,
      outgoing,
      noFreeSlotFlags: flags?.n ?? 0,
      judgedCandidates: judged?.n ?? 0,
      emailThreads: threads?.n ?? 0,
      costUsd: usage && usage.n > 0 ? Number(usage.cost ?? 0) : null,
    };
  });
  const result = await computeScore(rows);
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : render(result));
} finally {
  await db.close();
}
