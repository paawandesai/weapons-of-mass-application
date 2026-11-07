import { randomUUID } from 'node:crypto';
import {
  currentDemoHistoryId,
  findDemoSent,
  getCurrentTenant,
  getDemoMessage,
  getUserById,
  insertDemoMessage,
  listDemoEvents,
  listDemoMessagesAfterHistory,
  listDemoMessagesSince,
  listDemoThread,
  updateDemoEvent,
  upsertDemoEvent,
  type DemoMailboxMessageRow,
  type TenantHandle,
} from '@wma/db';
import type { GmailSender, SentLookup } from '@wma/shared';
import type { InboxGmailPort, InboxMessage } from '../inbox/gmail-reader';
import { linksIn } from '../submission/gmail';
import type { CalendarPort, MailboxPort, ReplyContext } from '../scheduling/types';

/**
 * Demo-tenant implementations of the ports the inbox sync, the guarded sender and scheduling
 * use against Gmail and Calendar. They read and write `demo_mailbox_messages` and
 * `demo_calendar_events`, so the real inbox, linking, classification, offer, confirm and booking
 * code runs unchanged against local mail. `portFactory` (./factory.ts) picks these or the real
 * ports by `tenants.demo`.
 */

/** Whether the handle's tenant is the flagged demo tenant. */
export async function isDemoTenant(handle: TenantHandle): Promise<boolean> {
  return (await getCurrentTenant(handle)).demo;
}

const formatFrom = (name: string | null, address: string) =>
  name ? `"${name.replace(/"/g, '')}" <${address}>` : address;

function toInboxMessage(m: DemoMailboxMessageRow): InboxMessage {
  return {
    id: m.gmailMessageId,
    threadId: m.threadId,
    labelIds: m.labelIds,
    from: formatFrom(m.fromName, m.fromAddress),
    subject: m.subject,
    receivedAt: m.internalDate,
    text: m.bodyText,
    links: linksIn(m.bodyText, ''),
  };
}

/** Read side of the demo mailbox; history ids are the per-tenant counter, as strings like Gmail's. */
export function createDemoInboxGmailPort(handle: TenantHandle, userId: string): InboxGmailPort {
  return {
    async currentHistoryId() {
      return String(await currentDemoHistoryId(handle, userId));
    },
    async listHistory(startHistoryId) {
      const start = Number(startHistoryId);
      // The watermark is read first and bounds the listing, so a message that commits in
      // between is neither skipped nor covered by the returned watermark. History ids are
      // allocated gap-free under a lock held until commit, so everything up to `through` is
      // already visible.
      const through = await currentDemoHistoryId(handle, userId);
      const added = await listDemoMessagesAfterHistory(
        handle,
        userId,
        Number.isFinite(start) ? start : 0,
        'INBOX',
        through,
      );
      return {
        expired: false,
        messageIds: added.map((m) => m.gmailMessageId),
        historyId: String(Math.max(through, Number.isFinite(start) ? start : 0)),
      };
    },
    async listSince(after) {
      const rows = await listDemoMessagesSince(handle, userId, after, 'INBOX');
      return rows.map((m) => m.gmailMessageId);
    },
    async getMessage(id) {
      const row = await getDemoMessage(handle, id);
      return row && row.userId === userId ? toInboxMessage(row) : null;
    },
    async getThread(threadId) {
      const rows = await listDemoThread(handle, threadId);
      return rows.filter((m) => m.userId === userId).map(toInboxMessage);
    },
  };
}

/** Stores the user's outgoing mail as a SENT-labelled message, so thread reads and lookups see it. */
export function createDemoSender(handle: TenantHandle, userId: string): GmailSender {
  return {
    async send(email) {
      const user = await getUserById(handle, email.userId || userId);
      const gmailMessageId = `demo-msg-${randomUUID()}`;
      const headers: Record<string, string> = { 'Message-ID': `<${gmailMessageId}@wma.local>` };
      if (email.inReplyTo) headers['In-Reply-To'] = email.inReplyTo;
      if (email.references) headers['References'] = email.references;
      const row = await insertDemoMessage(handle, {
        userId: user.id,
        threadId: email.threadId,
        gmailMessageId,
        fromAddress: user.email,
        fromName: user.displayName,
        toAddress: Array.isArray(email.to) ? email.to.join(', ') : email.to,
        subject: email.subject,
        bodyText: email.text,
        headers,
        labelIds: ['SENT'],
      });
      return { messageId: row.gmailMessageId };
    },
  };
}

/** Finds mail the demo user already sent (a pending delivery receipt's recovery path). */
export function createDemoSentLookup(handle: TenantHandle, userId: string): SentLookup {
  return {
    async find({ to, subject, after }) {
      const first = to.split(',')[0]!.trim();
      const row = await findDemoSent(handle, userId, { to: first, subject, after });
      return row ? { messageId: row.gmailMessageId } : null;
    },
  };
}

/** The in-process fake calendar: events are rows, `busy` reads them back. */
export function createDemoCalendarPort(handle: TenantHandle, userId: string): CalendarPort {
  return {
    async busy(from, to) {
      const rows = await listDemoEvents(handle, userId, { from, to });
      return rows.map((r) => ({ start: r.startsAt, end: r.endsAt }));
    },
    /** Get-or-create by `event.id`, like the Google implementation. */
    async createEvent(event) {
      const row = await upsertDemoEvent(handle, {
        userId,
        ...(event.id ? { clientId: event.id } : {}),
        summary: event.summary,
        description: event.description,
        startsAt: event.start,
        endsAt: event.end,
      });
      return { id: row.clientId };
    },
    async updateEvent(id, event) {
      const row = await updateDemoEvent(handle, id, {
        summary: event.summary,
        description: event.description,
        startsAt: event.start,
        endsAt: event.end,
      });
      if (!row) throw new Error(`demo calendar event ${id} not found`);
    },
  };
}

const header = (m: DemoMailboxMessageRow, name: string): string => {
  const h = m.headers as Record<string, unknown>;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key && typeof h[key] === 'string' ? (h[key] as string) : '';
};

const addressOf = (v: string) => /<([^>]+)>/.exec(v)?.[1]?.trim() ?? v.trim();

/** Scheduling's `MailboxPort` over the demo mailbox: who to answer and under which subject. */
export function createDemoMailboxPort(handle: TenantHandle): MailboxPort {
  return {
    async replyContext(gmailThreadId, selfEmail): Promise<ReplyContext> {
      const messages = await listDemoThread(handle, gmailThreadId);
      const inbound = messages.filter(
        (m) => !m.fromAddress.toLowerCase().includes(selfEmail.toLowerCase()),
      );
      const last = inbound[inbound.length - 1] ?? messages[messages.length - 1];
      if (!last) throw new Error('thread has no messages');
      const replyTo = header(last, 'Reply-To');
      const messageId = header(last, 'Message-ID');
      const refs = header(last, 'References');
      return {
        to: replyTo ? addressOf(replyTo) : last.fromAddress,
        subject: /^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`,
        fromName: last.fromName,
        ...(messageId
          ? { inReplyTo: messageId, references: refs ? `${refs} ${messageId}` : messageId }
          : {}),
      };
    },
  };
}
