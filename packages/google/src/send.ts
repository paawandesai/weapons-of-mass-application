import { randomBytes } from 'node:crypto';
import type { TenantHandle } from '@wma/db';
import type { EmailAttachment, GmailSender, OutgoingEmail } from '@wma/shared';
import { getGmailClient } from './client';

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');
const wrap76 = (s: string) => s.replace(/(.{76})/g, '$1\r\n');
const boundary = (tag: string) => `=_${tag}_${randomBytes(12).toString('hex')}`;

/** Header values are ASCII-only on the wire; anything else becomes an RFC 2047 encoded word. */
function headerValue(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error('header value contains a line break');
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${b64(v)}?=`;
}

function textPart(type: string, body: string): string {
  return [
    `Content-Type: ${type}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(body)),
  ].join('\r\n');
}

function filePart(a: EmailAttachment): string {
  const name = headerValue(a.filename).replace(/"/g, '');
  return [
    `Content-Type: ${a.contentType}; name="${name}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${a.contentId ? 'inline' : 'attachment'}; filename="${name}"`,
    ...(a.contentId ? [`Content-ID: <${a.contentId}>`] : []),
    '',
    wrap76(b64(a.content)),
  ].join('\r\n');
}

function multipart(subtype: string, parts: string[]): string {
  const b = boundary(subtype);
  return [
    `Content-Type: multipart/${subtype}; boundary="${b}"`,
    '',
    ...parts.flatMap((p) => [`--${b}`, p]),
    `--${b}--`,
  ].join('\r\n');
}

/** RFC 5322 message: text and HTML alternatives, inline images, then ordinary attachments. */
export function buildMime(email: OutgoingEmail): string {
  const to = (Array.isArray(email.to) ? email.to : [email.to]).join(', ');
  const inline = (email.attachments ?? []).filter((a) => a.contentId);
  const files = (email.attachments ?? []).filter((a) => !a.contentId);
  let body = multipart('alternative', [
    textPart('text/plain', email.text),
    textPart('text/html', email.html),
  ]);
  if (inline.length) body = multipart('related', [body, ...inline.map(filePart)]);
  if (files.length) body = multipart('mixed', [body, ...files.map(filePart)]);
  return [
    `To: ${headerValue(to)}`,
    `Subject: ${headerValue(email.subject)}`,
    ...(email.inReplyTo ? [`In-Reply-To: ${headerValue(email.inReplyTo)}`] : []),
    ...(email.references || email.inReplyTo
      ? [`References: ${headerValue(email.references ?? email.inReplyTo ?? '')}`]
      : []),
    'MIME-Version: 1.0',
    body,
  ].join('\r\n');
}

/** Sends through the user's own Gmail (the `from` is the authorized account). */
export function createGmailSender(handle: TenantHandle): GmailSender {
  return {
    async send(email) {
      const gmail = await getGmailClient(handle, email.userId);
      const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: Buffer.from(buildMime(email)).toString('base64url'),
          ...(email.threadId ? { threadId: email.threadId } : {}),
        },
      });
      return { messageId: res.data.id ?? '' };
    },
  };
}
