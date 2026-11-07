import type { JobRow } from '@wma/db';
import { parseAtsJobUrl, type AtsId } from '@wma/shared';
import type { InboundMessage } from './types';

const ATS_MAIL_DOMAINS: Record<AtsId, string[]> = {
  greenhouse: ['greenhouse.io', 'greenhouse-mail.io'],
  lever: ['lever.co'],
  ashby: ['ashbyhq.com'],
};

const ATS_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com)$/;

/** Sender domains that count as the ATS or the company for this job. */
export function senderDomains(job: Pick<JobRow, 'url' | 'ats'>): string[] {
  const out = new Set<string>();
  const ref = parseAtsJobUrl(job.url);
  const ats = ref?.ats ?? job.ats;
  if (ats) for (const d of ATS_MAIL_DOMAINS[ats]) out.add(d);
  else for (const list of Object.values(ATS_MAIL_DOMAINS)) for (const d of list) out.add(d);
  if (ref) out.add(`${ref.boardSlug}.com`);
  try {
    const host = new URL(job.url).hostname.toLowerCase();
    if (!ATS_HOSTS.test(host)) out.add(host.split('.').slice(-2).join('.'));
  } catch {
    // not a URL: the ATS domains stand
  }
  return [...out];
}

/** A confirmation email mentions the job title in its subject or body. */
export function mentionsTitle(msg: InboundMessage, title: string): boolean {
  const needle = title.trim().toLowerCase();
  return needle.length > 0 && `${msg.subject}\n${msg.text}`.toLowerCase().includes(needle);
}

/** The mailbox address inside a From header (`Name <a@b.com>` or a bare address), lowercased. */
export function senderAddress(from: string): string | null {
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  const bare = angle ? angle[1] : /^\s*"?([^\s"<>,;]+@[^\s"<>,;]+)"?\s*$/.exec(from)?.[1];
  return bare ? bare.toLowerCase() : null;
}

/** The domain of the sender's mailbox, from the parsed address only (never the display name). */
export function senderDomain(from: string): string | null {
  const addr = senderAddress(from);
  return addr ? (addr.split('@').pop() ?? null) : null;
}

/** True when `domain` is one of `allowed` or a subdomain of one. */
export function domainAllowed(domain: string | null, allowed: readonly string[]): boolean {
  if (!domain) return false;
  return allowed.some((d) => {
    const a = d.toLowerCase();
    return domain === a || domain.endsWith(`.${a}`);
  });
}

/** Messages whose parsed sender is in, or under, one of the domains. */
export function fromAllowedDomains<T extends { from: string }>(
  messages: T[],
  allowed: readonly string[],
): T[] {
  return messages.filter((m) => domainAllowed(senderDomain(m.from), allowed));
}

const normalizeText = (s: string) =>
  ` ${s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;

/** Domains that belong to the company itself (not the ATS): its slug and posting host. */
export function companyDomains(job: Pick<JobRow, 'url'>): string[] {
  const out = new Set<string>();
  const ref = parseAtsJobUrl(job.url);
  if (ref) out.add(`${ref.boardSlug}.com`);
  try {
    const host = new URL(job.url).hostname.toLowerCase();
    if (!ATS_HOSTS.test(host)) out.add(host.split('.').slice(-2).join('.'));
  } catch {
    // no company host
  }
  return [...out];
}

const ATS_DOMAIN_LIST = Object.values(ATS_MAIL_DOMAINS).flat();

/**
 * Evidence that a message is about this company: its sender is the company's own domain (or a
 * subdomain), or it comes from the ATS and names the company (or its board slug) in the sender's
 * display name, subject or body. The sender domain alone never counts for an ATS-wide address.
 */
export function matchesCompany(
  msg: InboundMessage,
  company: { name: string; job: Pick<JobRow, 'url'> },
): boolean {
  const domain = senderDomain(msg.from);
  if (domainAllowed(domain, companyDomains(company.job))) return true;
  if (!domainAllowed(domain, ATS_DOMAIN_LIST)) return false;
  const haystack = normalizeText(
    `${msg.from.replace(/<[^>]*>/g, ' ')}\n${msg.subject}\n${msg.text}`,
  );
  const needles = [company.name, parseAtsJobUrl(company.job.url)?.boardSlug ?? '']
    .map((n) => normalizeText(n))
    .filter((n) => n.trim().length >= 2);
  if (needles.some((n) => haystack.includes(n))) return true;
  // A verification mail may only carry a link into the company's own board.
  const slug = parseAtsJobUrl(company.job.url)?.boardSlug?.toLowerCase();
  return !!slug && msg.links.some((l) => linkNamesBoard(l, slug));
}

function linkNamesBoard(link: string, slug: string): boolean {
  try {
    const u = new URL(link);
    return (
      u.pathname.toLowerCase().split('/').includes(slug) ||
      u.hostname.toLowerCase().split('.')[0] === slug
    );
  } catch {
    return false;
  }
}
