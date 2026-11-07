import { Hono } from 'hono';
import { activity, getCurrentTenant, listDemoMessages, type DemoMailboxMessageRow } from '@wma/db';
import type { DemoBodyPart, DemoMailboxMessage } from '@wma/shared';
import type { AppEnv } from '../middleware/session';
import { getBoss } from '../services/queue';

/** Queue names owned by the worker; the API only enqueues. */
export const MAIL_SYNC_JOB = 'mail-sync';
export const SIMULATED_RECRUITER_JOB = 'simulated-recruiter';

export interface SyncNowData {
  tenantId: string;
  userId: string;
}

/** Hands the demo tenant's on-demand sync to the worker. Injected in tests. */
export interface SyncQueue {
  /** Runs one simulated-recruiter pass without its delay, then a mail sync for the user. */
  enqueueSyncNow(data: SyncNowData): Promise<void>;
}

export const pgBossSyncQueue: SyncQueue = {
  async enqueueSyncNow(data) {
    const b = await getBoss();
    await b.createQueue(SIMULATED_RECRUITER_JOB);
    await b.createQueue(MAIL_SYNC_JOB, { policy: 'exclusive' });
    // The recruiter pass queues a sync of its own when it writes mail; this one covers mail that
    // is already waiting (a sync is skipped while one is queued or running for the user).
    await b.send(SIMULATED_RECRUITER_JOB, { immediate: true });
    await b.send(MAIL_SYNC_JOB, data, {
      singletonKey: `mail-sync:${data.userId}`,
      retryLimit: 5,
      retryDelay: 60,
      retryBackoff: true,
    });
  },
};

const URL_RE = /https?:\/\/[^\s<>"')]+/g;

/** Splits a body into text and http(s) links, dropping trailing sentence punctuation from a link. */
export function bodyParts(text: string): DemoBodyPart[] {
  const parts: DemoBodyPart[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const link = m[0].replace(/[.,;:!?]+$/, '');
    const start = m.index!;
    if (start > at) parts.push({ type: 'text', value: text.slice(at, start) });
    parts.push({ type: 'link', value: link });
    at = start + link.length;
  }
  if (at < text.length) parts.push({ type: 'text', value: text.slice(at) });
  return parts;
}

const formatAddress = (name: string | null, address: string) =>
  name ? `${name} <${address}>` : address;

function toMessage(m: DemoMailboxMessageRow): DemoMailboxMessage {
  return {
    id: m.gmailMessageId,
    thread_id: m.threadId,
    direction: m.labelIds.includes('SENT') ? 'sent' : 'received',
    subject: m.subject,
    from: formatAddress(m.fromName, m.fromAddress),
    to: m.toAddress,
    date: m.internalDate.toISOString(),
    body_text: m.bodyText,
    body: bodyParts(m.bodyText),
  };
}

export interface AdminDeps {
  queue?: SyncQueue;
}

/** Demo-tenant utilities. Every route answers 404 for a tenant without the demo flag. */
export function createAdminRoutes(deps: AdminDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // The demo flag has no write path (design rule 11). This route gives an attempt an explicit
  // refusal for every method, whoever asks; the application database role holds no UPDATE on
  // tenants either, so there is nothing behind it.
  app.all('/demo-flag', (c) =>
    c.json({ code: 'forbidden', message: 'The demo flag cannot be changed here.' }, 403),
  );

  app.use('*', async (c, next) => {
    const { handle } = c.get('session');
    if (!(await getCurrentTenant(handle)).demo) {
      return c.json({ code: 'not_found', message: 'Not found' }, 404);
    }
    await next();
  });

  /** The demo user's simulated mailbox, newest first, so the audience can open the links in it. */
  app.get('/demo-mailbox', async (c) => {
    const { handle, userId } = c.get('session');
    const rows = await listDemoMessages(handle, userId);
    return c.json({ messages: rows.reverse().map(toMessage) });
  });

  /** Reads the demo mailbox now instead of at the next hourly tick. */
  app.post('/sync-now', async (c) => {
    const { handle, userId, tenantId } = c.get('session');
    await (deps.queue ?? pgBossSyncQueue).enqueueSyncNow({ tenantId, userId });
    await activity.logActivity(handle, {
      userId,
      actor: 'user',
      action: 'sync_requested',
      detail: { demo: true },
    });
    return c.json({ queued: true }, 202);
  });

  return app;
}

export const adminRoutes = createAdminRoutes();
