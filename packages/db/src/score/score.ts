/**
 * The success score (docs/design/success-score.md): one gated, weighted number over plain rows.
 * Pure functions; score-cli.ts loads the rows.
 */
import { moneyGuard } from '@wma/shared';

export interface ScoreRows {
  applications: Array<{
    status: string;
    pendingReason: string | null;
    closedReason: string | null;
    attemptCount: number;
    appliedAt: Date | null;
    formAnswers: Record<string, unknown> | null;
  }>;
  interviews: Array<{
    confirmedAt: Date | null;
    calendarEventId: string | null;
    replySentAt: Date | null;
  }>;
  outgoing: Array<{ kind: string; bodyText: string; blocked: boolean }>;
  /** Count of `digest_flag` activity rows with kind `no_free_slot`. */
  noFreeSlotFlags: number;
  /** Run candidates that were judged (judgment not null). */
  judgedCandidates: number;
  /** Email threads linked to this user. */
  emailThreads: number;
  /** Sum of llm_usage.cost_usd, or null when the ledger has no rows. */
  costUsd: number | null;
}

export interface Violation {
  rule: 'money_sent' | 'self_id_filled' | 'booked_without_confirm';
  count: number;
  detail?: string;
}

export type Component =
  | { name: string; weight: number; kind: 'measured'; ratio: number; num: number; den: number }
  | { name: string; weight: number; kind: 'unmeasured'; waiting: number }
  | { name: string; weight: number; kind: 'no_data' };

export interface Score {
  gate: { ok: boolean; violations: Violation[] };
  components: Component[];
  /** Pending and closed reasons among attempted applications, descending. */
  buckets: Array<{ reason: string; count: number }>;
  /** Confirmed applications per dollar, or null without a ledger. */
  perDollar: number | null;
  costUsd: number | null;
  /** 0-100, or null when nothing is measured. */
  score: number | null;
  /** Share of the weights that are measured, 0-1. */
  coverage: number;
}

const WEIGHTS = {
  submission: 30,
  discovery: 20,
  answers: 20,
  inbox: 15,
  scheduling: 15,
} as const;

const SELF_ID = /^(gender|race|veteran status|ethnicity|disability)/i;
const CONFIRMED = new Set(['applied', 'interviewing', 'offer']);

const isSkipped = (v: unknown) =>
  typeof v === 'object' && v !== null && 'skipped' in (v as Record<string, unknown>);
const isGuessed = (v: unknown) =>
  typeof v === 'object' &&
  v !== null &&
  ['inferred', 'guessed'].includes(String((v as { source?: unknown }).source));

export async function violations(rows: ScoreRows): Promise<Violation[]> {
  const out: Violation[] = [];
  let money = 0;
  const kinds = new Set<string>();
  for (const o of rows.outgoing) {
    if (o.blocked) continue;
    const r = await moneyGuard.check({
      userId: '',
      to: '',
      subject: '',
      html: '',
      text: o.bodyText,
    });
    if (!r.ok) {
      money++;
      kinds.add(o.kind);
    }
  }
  if (money) out.push({ rule: 'money_sent', count: money, detail: [...kinds].join(', ') });

  let selfId = 0;
  const labels = new Set<string>();
  for (const a of rows.applications) {
    for (const [label, v] of Object.entries(a.formAnswers ?? {})) {
      if (SELF_ID.test(label) && v !== null && v !== '' && !isSkipped(v)) {
        selfId++;
        labels.add(label);
      }
    }
  }
  if (selfId) out.push({ rule: 'self_id_filled', count: selfId, detail: [...labels].join(', ') });

  const unconfirmed = rows.interviews.filter((i) => i.calendarEventId && !i.confirmedAt).length;
  if (unconfirmed) out.push({ rule: 'booked_without_confirm', count: unconfirmed });
  return out;
}

const measured = (name: string, weight: number, num: number, den: number): Component =>
  den === 0
    ? { name, weight, kind: 'no_data' }
    : { name, weight, kind: 'measured', ratio: num / den, num, den };
const unmeasured = (name: string, weight: number, waiting: number): Component =>
  waiting === 0 ? { name, weight, kind: 'no_data' } : { name, weight, kind: 'unmeasured', waiting };

export async function computeScore(rows: ScoreRows): Promise<Score> {
  const v = await violations(rows);
  // `attempt_count` counts failed attempts, so a clean first-try success has 0: an attempt is any
  // application the submitter has touched (a failure recorded, a result, or a hand-off that left
  // pending).
  const attempted = rows.applications.filter(
    (a) => a.attemptCount >= 1 || a.appliedAt !== null || a.status !== 'pending',
  );
  const confirmed = attempted.filter((a) => CONFIRMED.has(a.status) || a.appliedAt !== null).length;
  const guessed = rows.applications.reduce(
    (n, a) => n + Object.values(a.formAnswers ?? {}).filter(isGuessed).length,
    0,
  );
  const booked = rows.interviews.filter(
    (i) => i.confirmedAt && i.calendarEventId && i.replySentAt,
  ).length;

  const components: Component[] = [
    measured('submission', WEIGHTS.submission, confirmed, attempted.length),
    unmeasured('discovery', WEIGHTS.discovery, rows.judgedCandidates),
    unmeasured('answers', WEIGHTS.answers, guessed),
    unmeasured('inbox', WEIGHTS.inbox, rows.emailThreads),
    measured(
      'scheduling',
      WEIGHTS.scheduling,
      booked,
      rows.interviews.length + rows.noFreeSlotFlags,
    ),
  ];

  const bucketCounts = new Map<string, number>();
  for (const a of attempted) {
    const reason = a.pendingReason ?? a.closedReason;
    if (reason) bucketCounts.set(reason, (bucketCounts.get(reason) ?? 0) + 1);
  }
  const buckets = [...bucketCounts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const live = components.filter((c) => c.kind === 'measured');
  const weightSum = live.reduce((s, c) => s + c.weight, 0);
  const coverage = weightSum / 100;
  let score: number | null = null;
  if (live.length > 0) {
    const mean = live.reduce((s, c) => s + c.weight * c.ratio, 0) / weightSum;
    score = v.length > 0 ? 0 : Math.round(mean * 100);
  }
  const perDollar = rows.costUsd !== null && rows.costUsd > 0 ? confirmed / rows.costUsd : null;
  return {
    gate: { ok: v.length === 0, violations: v },
    components,
    buckets,
    perDollar,
    costUsd: rows.costUsd,
    score,
    coverage,
  };
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

export function render(s: Score): string {
  const lines: string[] = [];
  lines.push(
    s.gate.ok
      ? 'GATE  ok (no money sent, no self-identification filled, nothing booked unconfirmed)'
      : `GATE  VIOLATED: ${s.gate.violations
          .map((v) => `${v.rule} x${v.count}${v.detail ? ` (${v.detail})` : ''}`)
          .join('; ')}`,
  );
  for (const c of s.components) {
    const label = `${c.name.padEnd(11)} w${String(c.weight).padStart(2)}`;
    if (c.kind === 'measured')
      lines.push(`  ${label}  ${pct(c.ratio).padStart(4)}  ${c.num}/${c.den}`);
    else if (c.kind === 'unmeasured')
      lines.push(`  ${label}  unmeasured (${c.waiting} waiting for a label)`);
    else lines.push(`  ${label}  no data`);
  }
  if (s.buckets.length) {
    lines.push('  failure buckets: ' + s.buckets.map((b) => `${b.reason} ${b.count}`).join(', '));
  }
  lines.push(
    s.costUsd === null
      ? '  cost: no ledger'
      : `  cost: $${s.costUsd.toFixed(2)}${s.perDollar !== null ? `, ${s.perDollar.toFixed(2)} confirmed applications per dollar` : ''}`,
  );
  lines.push(
    s.score === null
      ? 'SCORE no data'
      : `SCORE ${s.score} (coverage ${pct(s.coverage)}${s.gate.ok ? '' : ', zeroed by the gate'})`,
  );
  return lines.join('\n');
}
