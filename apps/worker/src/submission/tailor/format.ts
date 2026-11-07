import { parseDate } from './facts';
import type { ResumeDocument } from './schema';

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** `2021-03` -> `Mar 2021`, `2021` -> `2021`, `present` -> `Present`, unparseable text as is. */
export function formatDate(raw: string): string {
  const p = parseDate(raw);
  if (p === 'present') return 'Present';
  if (!p || p === 'invalid') return raw;
  return p.month ? `${MONTH_NAMES[p.month - 1]} ${p.year}` : String(p.year);
}

export function dateRange(start: string | null, end: string | null): string {
  if (start && end) return `${formatDate(start)} - ${formatDate(end)}`;
  if (start) return formatDate(start);
  if (end) return formatDate(end);
  return '';
}

/** The resume as plain text, in print order; the input to fact extraction. */
export function resumeToText(doc: ResumeDocument): string {
  const c = doc.content;
  const out: string[] = [doc.name];
  if (c.headline) out.push(c.headline);
  if (doc.contact.length) out.push(doc.contact.join(' | '));
  if (c.summary) out.push('', 'SUMMARY', c.summary);
  if (c.experience.length) {
    out.push('', 'EXPERIENCE');
    for (const e of c.experience) {
      out.push(
        [e.title, e.employer, e.location, dateRange(e.start_date, e.end_date)]
          .filter(Boolean)
          .join(' | '),
      );
      for (const b of e.bullets) out.push(`- ${b}`);
    }
  }
  if (c.projects.length) {
    out.push('', 'PROJECTS');
    for (const p of c.projects) {
      out.push([p.name, p.description, p.technologies.join(', ')].filter(Boolean).join(' - '));
    }
  }
  if (c.education.length) {
    out.push('', 'EDUCATION');
    for (const e of c.education) {
      out.push(
        [
          [e.degree, e.field].filter(Boolean).join(' '),
          e.institution,
          dateRange(e.start_date, e.end_date),
        ]
          .filter(Boolean)
          .join(' | '),
      );
    }
  }
  if (c.skills.length) out.push('', 'SKILLS', c.skills.join(', '));
  return out.join('\n');
}
