import { scrubEmployerText } from '@wma/shared';
import { formatLocal, relativeWhen } from './time';

/**
 * User-facing templates. Every employer-supplied value (company, role, interviewer, thread
 * notes, links) goes through `s` BEFORE it is placed in the message, so the content guard never
 * sees employer money text and a blocked notification stays a bug (design rule 15). Static
 * template wording avoids the guarded words on purpose.
 */
const s = scrubEmployerText;

const esc = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ReminderInput {
  company: string;
  role: string;
  interviewer?: string | null;
  startsAt: Date;
  timezone: string;
  /** When the reminder is rendered (the send time): the wording is read against the user's calendar at this moment. */
  now: Date;
  cardUrl: string;
  /** Present only when the prep plan is ready. */
  prepUrl?: string | null;
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export function renderReminder(input: ReminderInput): RenderedMail {
  const when = relativeWhen(input.startsAt, input.now, input.timezone);
  const company = s(input.company);
  const role = s(input.role);
  const interviewer = input.interviewer ? s(input.interviewer) : null;
  const time = formatLocal(input.startsAt, input.timezone);
  const subject = `Reminder: interview ${when} with ${company} (${role})`;
  const rows: Array<[string, string]> = [
    ['Company', company],
    ['Role', role],
    ...(interviewer ? ([['Interviewer', interviewer]] as Array<[string, string]>) : []),
    ['When', time],
  ];
  const text = [
    `Your interview with ${company} is ${when}.`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    `Interview card: ${input.cardUrl}`,
    ...(input.prepUrl ? [`Prep plan: ${input.prepUrl}`] : []),
  ].join('\n');
  const html = [
    `<p>Your interview with <strong>${esc(company)}</strong> is ${when}.</p>`,
    '<ul>',
    ...rows.map(([k, v]) => `<li>${k}: ${esc(v)}</li>`),
    '</ul>',
    `<p><a href="${esc(input.cardUrl)}">Open the interview card</a></p>`,
    ...(input.prepUrl ? [`<p><a href="${esc(input.prepUrl)}">Read the prep plan</a></p>`] : []),
  ].join('\n');
  return { subject, text, html };
}

export interface DigestSection {
  title: string;
  /** Already scrubbed lines; each may carry a link. */
  lines: Array<{ text: string; url?: string }>;
}

export interface DigestInput {
  dateLabel: string;
  sections: DigestSection[];
}

export function renderDigest(input: DigestInput): RenderedMail {
  const subject = `Your daily digest for ${input.dateLabel}`;
  if (input.sections.length === 0) {
    const line = 'No activity since your last digest, and nothing is waiting on you.';
    return { subject, text: line, html: `<p>${esc(line)}</p>` };
  }
  const text = input.sections
    .flatMap((sec) => [
      sec.title,
      ...sec.lines.map((l) => `- ${l.text}${l.url ? ` (${l.url})` : ''}`),
      '',
    ])
    .join('\n')
    .trimEnd();
  const html = input.sections
    .map(
      (sec) =>
        `<h3>${esc(sec.title)}</h3>\n<ul>\n${sec.lines
          .map(
            (l) => `<li>${esc(l.text)}${l.url ? ` (<a href="${esc(l.url)}">open</a>)` : ''}</li>`,
          )
          .join('\n')}\n</ul>`,
    )
    .join('\n');
  return { subject, text, html };
}

export { s as scrub };
