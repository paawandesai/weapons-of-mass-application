export interface FollowUpFacts {
  /** The user's display name; the sign-off. */
  senderName: string;
  companyName: string;
  jobTitle: string;
  appliedAt: Date;
}

export interface FollowUpMessage {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "March 3, 2026" in UTC, so the text does not depend on the worker's locale or zone. */
export function formatAppliedDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The one follow-up per application: names the role and company, says when the application went
 * in, and asks for a status. It states nothing about the sender's experience and nothing else
 * the application did not already say.
 */
export function renderFollowUp(f: FollowUpFacts): FollowUpMessage {
  const paragraphs = [
    'Hello,',
    `I applied for the ${f.jobTitle} position at ${f.companyName} on ${formatAppliedDate(f.appliedAt)} and wanted to follow up on the status of my application.`,
    'If there is anything more you need from me, please let me know. Thank you for your time.',
    `Best regards,\n${f.senderName}`,
  ];
  return {
    subject: `Following up on my application: ${f.jobTitle}`,
    text: paragraphs.join('\n\n'),
    html: paragraphs.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join(''),
  };
}
