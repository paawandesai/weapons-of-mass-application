import { Judgment, type Candidate, type ProfileDocument } from '@wma/shared';
import type { StructuredLlm } from '@wma/llm';
import { mapLimit } from '@wma/discovery';
import { loadVersionedPrompt } from './prompts';
import { profileForPrompt } from './profile-view';

export const JUDGE_CONCURRENCY = 8;
const MAX_DESCRIPTION_CHARS = 8_000;
const MAX_RATIONALE = 600;

export interface JudgeContext {
  llm: StructuredLlm;
  profile: ProfileDocument;
  /** Run date, `YYYY-MM-DD`; lets the model resolve deadlines written without a year. */
  today: string;
}

export interface Judged {
  candidate: Candidate;
  status: 'judged';
  judgment: Judgment;
  /** `apply-decision@v1`. */
  promptVersion: string;
  model: string;
}
export interface Unjudged {
  candidate: Candidate;
  status: 'unjudged';
  promptVersion: string;
  model: string;
}
export type JudgeResult = Judged | Unjudged;

const esc = (s: string) => s.replace(/<\/?posting>/gi, '');

const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 300);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Structured facts an ATS reports outside the description (Lever salary range and workplace type,
 * Ashby compensation summary and remote flag, Greenhouse departments). The model cannot judge a
 * salary or remote constraint it was never shown, so these are rendered next to the description.
 */
export function postingFacts(c: Candidate): string[] {
  const raw = (c.raw && typeof c.raw === 'object' ? c.raw : {}) as Record<string, unknown>;
  const lines: string[] = [];
  if (c.source === 'lever') {
    const pay = raw.pay as
      { min?: unknown; max?: unknown; currency?: unknown; interval?: unknown } | null | undefined;
    if (pay && (isNum(pay.min) || isNum(pay.max))) {
      const range = [pay.min, pay.max].filter(isNum).join(' to ');
      const currency = isStr(pay.currency) ? ` ${pay.currency}` : '';
      const interval = isStr(pay.interval) ? ` (${pay.interval})` : '';
      lines.push(`Salary range: ${range}${currency}${interval}`);
    }
    if (isStr(raw.workplaceType)) lines.push(`Workplace type: ${clip(raw.workplaceType)}`);
  } else if (c.source === 'ashby') {
    if (isStr(raw.pay)) lines.push(`Compensation: ${clip(raw.pay)}`);
    if (typeof raw.isRemote === 'boolean') lines.push(`Remote: ${raw.isRemote ? 'yes' : 'no'}`);
  } else if (c.source === 'greenhouse') {
    const departments = Array.isArray(raw.departments) ? raw.departments.filter(isStr) : [];
    if (departments.length) lines.push(`Departments: ${clip(departments.join(', '))}`);
  }
  return lines;
}

export function renderPosting(c: Candidate, today: string): string {
  const description = (c.description ?? '').slice(0, MAX_DESCRIPTION_CHARS);
  return [
    `Today: ${today}`,
    '<posting>',
    `Title: ${esc(c.title)}`,
    `Company: ${esc(c.companyName)}`,
    c.location ? `Location: ${esc(c.location)}` : '',
    c.postedAt ? `Posted: ${c.postedAt.slice(0, 10)}` : '',
    `URL: ${esc(c.url)}`,
    ...postingFacts(c).map(esc),
    '',
    esc(description) || '(no description)',
    '</posting>',
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
}

/**
 * Light cleanup of known model habits before validation: an over-long rationale is cut, "" is
 * null, and a pay of 0 (the model's way of saying "not stated") is null.
 */
export function normalizeJudgment(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const out = { ...(raw as Record<string, unknown>) };
  if (typeof out.rationale === 'string' && out.rationale.length > MAX_RATIONALE) {
    out.rationale = `${out.rationale.slice(0, MAX_RATIONALE - 3).trimEnd()}...`;
  }
  for (const k of ['pay_min', 'pay_max']) if (out[k] === 0) out[k] = null;
  for (const k of ['application_deadline', 'currency', 'seniority', 'location_mode']) {
    if (typeof out[k] === 'string' && (out[k] as string).trim() === '') out[k] = null;
  }
  return out;
}

/** The system prompt is the stable prefix (instructions + profile) so it can be cached. */
export function buildSystem(profile: ProfileDocument): string {
  const prompt = loadVersionedPrompt('apply-decision', 'v1');
  return prompt.body.replace('{{PROFILE}}', JSON.stringify(profileForPrompt(profile), null, 1));
}

export const APPLY_DECISION_PROMPT = 'apply-decision@v1';

/**
 * One structured-output call per posting. A reply that does not match the schema (or a failed
 * call) is retried once; a second failure leaves the candidate unjudged. `system` may be passed to
 * avoid rebuilding the prefix for every posting.
 */
export async function judge(
  candidate: Candidate,
  ctx: JudgeContext,
  system: string = buildSystem(ctx.profile),
): Promise<JudgeResult> {
  const user = renderPosting(candidate, ctx.today);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await ctx.llm.generateStructured({
        prompt: 'apply-decision/v1',
        system,
        user,
        schema: Judgment,
        maxTokens: 4000,
        cacheSystem: true,
      });
      const parsed = Judgment.safeParse(normalizeJudgment(res.output));
      if (parsed.success) {
        return {
          candidate,
          status: 'judged',
          judgment: parsed.data,
          promptVersion: APPLY_DECISION_PROMPT,
          model: ctx.llm.model,
        };
      }
    } catch (e) {
      // A timed-out call is not retried: the second attempt would burn another full timeout on the
      // same posting. Other transport failures get the same single retry as a malformed reply.
      if (e instanceof Error && /timed out/.test(e.message)) break;
    }
  }
  return {
    candidate,
    status: 'unjudged',
    promptVersion: APPLY_DECISION_PROMPT,
    model: ctx.llm.model,
  };
}

/** Judges all candidates with bounded concurrency; results keep the input order. */
export async function judgeAll(
  candidates: readonly Candidate[],
  ctx: JudgeContext,
  concurrency: number = JUDGE_CONCURRENCY,
  makeSystem: (profile: ProfileDocument) => string = buildSystem,
): Promise<JudgeResult[]> {
  const system = makeSystem(ctx.profile);
  return mapLimit(candidates, concurrency, (c) => judge(c, ctx, system));
}
