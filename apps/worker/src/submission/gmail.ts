import { getGmailClient } from '@wma/google';
import type { TenantHandle } from '@wma/db';
import { fromAllowedDomains } from './domains';
import type { GmailPort, InboundMessage } from './types';

interface MessagePart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: MessagePart[] | null;
}

const decode = (data: string | null | undefined) =>
  data ? Buffer.from(data, 'base64url').toString('utf8') : '';

function collect(part: MessagePart | undefined, out: { text: string; html: string }) {
  if (!part) return;
  if (part.mimeType === 'text/plain') out.text += decode(part.body?.data);
  else if (part.mimeType === 'text/html') out.html += decode(part.body?.data);
  for (const p of part.parts ?? []) collect(p, out);
}

function linksIn(text: string, html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/gi))
    found.add(m[1]!.replace(/&amp;/g, '&'));
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')]+/g)) found.add(m[0]);
  return [...found];
}

const stripTags = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

/** Reads the user's mailbox through their Google connection (read-only). */
export function createGmailPort(handle: TenantHandle, userId: string): GmailPort {
  return {
    async search({ fromDomains, after, subjectContains }) {
      const gmail = await getGmailClient(handle, userId);
      const q = [
        `(${fromDomains.map((d) => `from:${d}`).join(' OR ')})`,
        `after:${Math.floor(after.getTime() / 1000)}`,
        subjectContains ? `subject:"${subjectContains.replace(/"/g, '')}"` : '',
      ]
        .filter(Boolean)
        .join(' ');
      const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 20 });
      const out: InboundMessage[] = [];
      for (const ref of list.data.messages ?? []) {
        if (!ref.id) continue;
        const msg = (await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' }))
          .data;
        const header = (name: string) =>
          msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? '';
        const body = { text: '', html: '' };
        collect(msg.payload ?? undefined, body);
        out.push({
          id: ref.id,
          from: header('from'),
          subject: header('subject'),
          receivedAt: new Date(Number(msg.internalDate ?? 0)),
          text: body.text || stripTags(body.html),
          links: linksIn(body.text, body.html),
        });
      }
      // Gmail's `from:` is a text match; keep only mail whose parsed sender is in, or under, an
      // allowed domain and that arrived at or after the cutoff.
      return fromAllowedDomains(out, fromDomains).filter(
        (m) => m.receivedAt.getTime() >= after.getTime(),
      );
    },
  };
}
