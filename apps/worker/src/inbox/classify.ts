import { InboxClassification, type ProposedSlot } from '@wma/shared';
import type { StructuredLlm } from '@wma/llm';
import { loadVersionedPrompt } from '../discovery/prompts';
import type { InboxMessage } from './gmail-reader';

export const INBOX_CLASSIFY_PROMPT = 'inbox-classify@v2';
const MAX_BODY = 8000;

export interface ClassifyContext {
  companyName: string;
  jobTitle: string;
  /** For cost attribution of the call; not shown to the model. */
  applicationId?: string | null;
}

export interface Classified extends InboxClassification {
  promptVersion: string;
}

/**
 * Rule 53: wording that moves or re-proposes a time already agreed. It sets `reschedule` whatever
 * the model said, so a missed flag cannot turn a move into a second interview.
 */
export const RESCHEDULE_WORDS =
  /\b(?:re-?schedul\w*|move (?:our|the|this) (?:call|interview|conversation|meeting)|no longer works?|something (?:has )?came up|push(?:ed)? (?:it |the call |the interview )?back|(?:change|changing) (?:the|our) time|(?:a )?different time)\b/i;

const safe = (s: string) => s.replace(/<\/?email>/gi, '');

/** A booking link must be a plain http(s) URL; anything else is treated as absent. */
function cleanLink(link: string | null): string | null {
  const trimmed = link?.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A slot whose start cannot be read as a date can never be offered: it is marked ambiguous. */
function cleanSlot(slot: ProposedSlot): ProposedSlot {
  const ok = !Number.isNaN(Date.parse(slot.start));
  return ok ? slot : { ...slot, ambiguous: true };
}

/**
 * Rule 3: one structured call for a linked message. A reply that does not match the schema (or a
 * failed call) is retried once; a second failure throws and the message is recorded as failed.
 */
export async function classifyMessage(
  llm: StructuredLlm,
  msg: InboxMessage,
  ctx: ClassifyContext,
): Promise<Classified> {
  const prompt = loadVersionedPrompt('inbox-classify', 'v2');
  const user = [
    `Received: ${msg.receivedAt.toISOString()}`,
    `Company: ${ctx.companyName}`,
    `Job title: ${ctx.jobTitle}`,
    '<email>',
    `From: ${safe(msg.from)}`,
    `Subject: ${safe(msg.subject)}`,
    '',
    safe(msg.text).slice(0, MAX_BODY),
    '</email>',
  ].join('\n');
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await llm.generateStructured({
        prompt: 'inbox-classify/v2',
        system: prompt.body,
        user,
        schema: InboxClassification,
        maxTokens: 2000,
        applicationId: ctx.applicationId ?? null,
      });
      const parsed = InboxClassification.safeParse(res.output);
      if (!parsed.success) {
        lastError = new Error('inbox-classify output failed validation');
        continue;
      }
      return {
        ...parsed.data,
        booking_link: cleanLink(parsed.data.booking_link),
        proposed_slots: parsed.data.proposed_slots.map(cleanSlot),
        confirmed_slot: parsed.data.confirmed_slot ? cleanSlot(parsed.data.confirmed_slot) : null,
        promptVersion: prompt.id,
      };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('inbox-classify failed');
}
