import { scrubEmployerText, type OutgoingEmail } from '@wma/shared';
import { formatSlot } from './slots';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Employer-quoted text goes through the scrubber before it reaches a template. */
const clean = (s: string | null | undefined) => scrubEmployerText((s ?? '').trim());

export interface ConfirmationOption {
  start: Date;
  end: Date;
  link: string;
}

export interface ConfirmationInput {
  userId: string;
  applicationId: string;
  to: string;
  companyName: string;
  jobTitle: string;
  zone: string;
  options: ConfirmationOption[];
}

/** The one email asking the user to pick a time. Nothing is sent to the recruiter at this point. */
export function confirmationEmail(i: ConfirmationInput): OutgoingEmail {
  const company = clean(i.companyName);
  const title = clean(i.jobTitle);
  const subject = `Pick an interview time: ${title} at ${company}`;
  const lines = i.options.map((o) => ({ when: formatSlot(o, i.zone), link: o.link }));
  const text = [
    `${company} offered these times for the ${title} interview.`,
    'Open the link for the time you want and press Confirm. Nothing is sent to them until you do.',
    '',
    ...lines.flatMap((l) => [l.when, l.link, '']),
    'Each link works once, and all of them close when you confirm one.',
  ].join('\n');
  const html = `<p>${esc(company)} offered these times for the ${esc(title)} interview.</p>
<p>Open the link for the time you want and press Confirm. Nothing is sent to them until you do.</p>
<ul>
${lines.map((l) => `<li><a href="${esc(l.link)}">${esc(l.when)}</a></li>`).join('\n')}
</ul>
<p>Each link works once, and all of them close when you confirm one.</p>`;
  return {
    userId: i.userId,
    kind: 'slot_confirmation',
    applicationId: i.applicationId,
    to: i.to,
    subject,
    html,
    text,
  };
}

export interface ReplyInput {
  userId: string;
  applicationId: string;
  to: string;
  subject: string;
  recruiterName: string | null;
  senderName: string | null;
  companyName: string;
  jobTitle: string;
  zone: string;
  slot: { start: Date; end: Date };
  threadId: string;
  inReplyTo?: string;
  references?: string;
}

/** The acceptance reply: the time only. It never mentions pay, whatever the recruiter asked. */
export function recruiterReply(i: ReplyInput): OutgoingEmail {
  const when = formatSlot(i.slot, i.zone);
  // A subject that quotes pay (the recruiter asked about it) is replaced by a neutral one, so
  // the acceptance is never held back by, or repeats, the money text.
  const subject =
    scrubEmployerText(i.subject) === i.subject
      ? i.subject
      : `Re: Interview for ${clean(i.jobTitle)}`;
  const greeting = i.recruiterName ? `Hello ${clean(i.recruiterName)},` : 'Hello,';
  const body = [
    greeting,
    '',
    `Thank you for reaching out. ${when} works for me, and I am looking forward to speaking with you about the ${clean(i.jobTitle)} role at ${clean(i.companyName)}.`,
    '',
    'Best regards,',
    ...(i.senderName ? [i.senderName] : []),
  ].join('\n');
  const html = body
    .split('\n\n')
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  return {
    userId: i.userId,
    kind: 'recruiter_reply',
    applicationId: i.applicationId,
    to: i.to,
    subject,
    html,
    text: body,
    threadId: i.threadId,
    ...(i.inReplyTo ? { inReplyTo: i.inReplyTo } : {}),
    ...(i.references ? { references: i.references } : {}),
  };
}

export function eventDetails(i: {
  companyName: string;
  jobTitle: string;
  interviewer: string | null;
  prepLink: string | null;
}): { summary: string; description: string } {
  const company = clean(i.companyName);
  const title = clean(i.jobTitle);
  return {
    summary: `Interview: ${title} at ${company}`,
    description: [
      `Company: ${company}`,
      `Role: ${title}`,
      ...(i.interviewer ? [`Interviewer: ${clean(i.interviewer)}`] : []),
      ...(i.prepLink ? [`Prep plan: ${i.prepLink}`] : []),
    ].join('\n'),
  };
}
