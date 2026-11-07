import { getGmailClient, GoogleNotConnectedError, isInvalidGrant } from '@wma/google';
import type { TenantHandle } from '@wma/db';
import { collect, linksIn, stripTags, type MessagePart } from '../submission/gmail';
import type { InboundMessage } from '../submission/types';

/** One mailbox message with the thread it belongs to. */
export interface InboxMessage extends InboundMessage {
  threadId: string;
  /** Gmail label ids (INBOX, SENT, DRAFT, ...). */
  labelIds: string[];
}

export type HistoryResult =
  /** Message ids added since the start id, and the mailbox's current history id. */
  | { expired: false; messageIds: string[]; historyId: string }
  /** The start id is too old for the history API; the caller falls back to a dated listing. */
  | { expired: true };

/** Read side of Gmail used by the inbox sync (read-only; sending goes through `sendEmail`). */
export interface InboxGmailPort {
  /** The mailbox's current history id. */
  currentHistoryId(): Promise<string>;
  listHistory(startHistoryId: string): Promise<HistoryResult>;
  /** Inbox message ids received at or after `after` (the dated fallback). */
  listSince(after: Date): Promise<string[]>;
  /** Null when the message no longer exists. */
  getMessage(id: string): Promise<InboxMessage | null>;
  /** A thread's messages, oldest first (the follow-up contact lookup). */
  getThread(threadId: string): Promise<InboxMessage[]>;
}

interface RawMessage {
  id?: string | null;
  threadId?: string | null;
  labelIds?: string[] | null;
  internalDate?: string | null;
  payload?:
    | (MessagePart & { headers?: Array<{ name?: string | null; value?: string | null }> | null })
    | null;
}

/** Turns a Gmail `format=full` message resource into an `InboxMessage`. */
export function parseGmailMessage(raw: RawMessage): InboxMessage | null {
  if (!raw.id) return null;
  const header = (name: string) =>
    raw.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? '';
  const body = { text: '', html: '' };
  collect(raw.payload ?? undefined, body);
  return {
    id: raw.id,
    threadId: raw.threadId ?? raw.id,
    labelIds: raw.labelIds ?? [],
    from: header('from'),
    subject: header('subject'),
    receivedAt: new Date(Number(raw.internalDate ?? 0)),
    text: body.text || stripTags(body.html),
    links: linksIn(body.text, body.html),
  };
}

const statusOf = (e: unknown): number | null => {
  if (!e || typeof e !== 'object') return null;
  const err = e as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const v of [err.code, err.status, err.response?.status]) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
};

/** The mailbox rejected the credentials (401, a revoked or expired grant, or no grant at all). */
export function isAuthError(e: unknown): boolean {
  return statusOf(e) === 401 || isInvalidGrant(e) || e instanceof GoogleNotConnectedError;
}

/** Pages read per listing; reaching it with a page token left is an error, never a silent cut-off. */
const MAX_PAGES = 100;

/** A listing could not be read to the end. The sync fails without advancing its mark. */
export class ListingTruncatedError extends Error {
  constructor(what: string) {
    super(`gmail ${what} listing has more pages than ${MAX_PAGES}; not advancing`);
    this.name = 'ListingTruncatedError';
  }
}

type GmailClient = Awaited<ReturnType<typeof getGmailClient>>;

/** The production port over the user's Gmail connection. `client` is injectable for tests. */
export function createInboxGmailPort(
  handle: TenantHandle,
  userId: string,
  client: () => Promise<GmailClient> = () => getGmailClient(handle, userId),
): InboxGmailPort {
  return {
    async currentHistoryId() {
      const gmail = await client();
      const res = await gmail.users.getProfile({ userId: 'me' });
      if (!res.data.historyId) throw new Error('gmail profile has no history id');
      return String(res.data.historyId);
    },
    async listHistory(startHistoryId) {
      const gmail = await client();
      const ids = new Set<string>();
      let pageToken: string | undefined;
      let historyId = startHistoryId;
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await gmail.users.history.list({
            userId: 'me',
            startHistoryId,
            historyTypes: ['messageAdded'],
            labelId: 'INBOX',
            maxResults: 500,
            ...(pageToken ? { pageToken } : {}),
          });
          for (const h of res.data.history ?? [])
            for (const m of h.messagesAdded ?? []) if (m.message?.id) ids.add(m.message.id);
          if (res.data.historyId) historyId = String(res.data.historyId);
          pageToken = res.data.nextPageToken ?? undefined;
          if (!pageToken) break;
          if (page === MAX_PAGES - 1) throw new ListingTruncatedError('history');
        }
      } catch (e) {
        if (statusOf(e) === 404) return { expired: true };
        throw e;
      }
      return { expired: false, messageIds: [...ids], historyId };
    },
    async listSince(after) {
      const gmail = await client();
      const ids: string[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await gmail.users.messages.list({
          userId: 'me',
          q: `in:inbox after:${Math.floor(after.getTime() / 1000)}`,
          maxResults: 500,
          ...(pageToken ? { pageToken } : {}),
        });
        for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
        pageToken = res.data.nextPageToken ?? undefined;
        if (!pageToken) break;
        if (page === MAX_PAGES - 1) throw new ListingTruncatedError('message');
      }
      return ids;
    },
    async getMessage(id) {
      const gmail = await client();
      try {
        const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        return parseGmailMessage(res.data);
      } catch (e) {
        if (statusOf(e) === 404) return null;
        throw e;
      }
    },
    async getThread(threadId) {
      const gmail = await client();
      const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
      const out: InboxMessage[] = [];
      for (const m of res.data.messages ?? []) {
        const parsed = parseGmailMessage(m);
        if (parsed) out.push(parsed);
      }
      return out.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    },
  };
}
