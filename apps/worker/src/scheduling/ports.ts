import { getCalendarClient, getGmailClient } from '@wma/google';
import { createBlockedLogger, createOutgoingStore, type TenantHandle } from '@wma/db';
import { defaultGuards } from '@wma/shared';
import { portFactory } from '../demo/factory';
import {
  systemClock,
  type CalendarEventInput,
  type CalendarPort,
  type MailboxPort,
  type SchedulingDeps,
} from './types';

function statusOf(e: unknown): number | null {
  if (!e || typeof e !== 'object') return null;
  const err = e as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const v of [err.code, err.status, err.response?.status]) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
}

function eventBody(e: CalendarEventInput) {
  return {
    summary: e.summary,
    description: e.description,
    start: { dateTime: e.start.toISOString(), timeZone: e.timeZone },
    end: { dateTime: e.end.toISOString(), timeZone: e.timeZone },
  };
}

/** The user's primary Google calendar. */
export function createCalendarPort(handle: TenantHandle, userId: string): CalendarPort {
  return {
    async busy(from, to) {
      const cal = await getCalendarClient(handle, userId);
      const res = await cal.freebusy.query({
        requestBody: {
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          items: [{ id: 'primary' }],
        },
      });
      const primary = res.data.calendars?.primary;
      if (!primary || (primary.errors && primary.errors.length > 0)) {
        throw new Error('freebusy returned no data for the primary calendar');
      }
      return (primary.busy ?? []).flatMap((b) =>
        b.start && b.end ? [{ start: new Date(b.start), end: new Date(b.end) }] : [],
      );
    },
    /** Get-or-create by `event.id`: an event that already exists under the id is updated, never duplicated. */
    async createEvent(event) {
      const cal = await getCalendarClient(handle, userId);
      const id = event.id;
      if (id) {
        try {
          const got = await cal.events.get({ calendarId: 'primary', eventId: id });
          if (got.data.id) {
            await cal.events.patch({
              calendarId: 'primary',
              eventId: id,
              requestBody: { ...eventBody(event), status: 'confirmed' },
            });
            return { id: got.data.id };
          }
        } catch (e) {
          if (statusOf(e) !== 404) throw e;
        }
      }
      try {
        const res = await cal.events.insert({
          calendarId: 'primary',
          requestBody: { ...eventBody(event), ...(id ? { id } : {}) },
        });
        if (!res.data.id) throw new Error('calendar returned no event id');
        return { id: res.data.id };
      } catch (e) {
        // Another attempt inserted it between our get and insert.
        if (id && statusOf(e) === 409) {
          await cal.events.patch({
            calendarId: 'primary',
            eventId: id,
            requestBody: { ...eventBody(event), status: 'confirmed' },
          });
          return { id };
        }
        throw e;
      }
    },
    async updateEvent(id, event) {
      const cal = await getCalendarClient(handle, userId);
      await cal.events.patch({ calendarId: 'primary', eventId: id, requestBody: eventBody(event) });
    },
  };
}

function parseAddress(from: string): { name: string | null; address: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (m) return { name: m[1]!.trim() || null, address: m[2]!.trim() };
  return { name: null, address: from.trim() };
}

/** Reads the recruiter thread through the user's Gmail (metadata only). */
export function createMailboxPort(handle: TenantHandle, userId: string): MailboxPort {
  return {
    async replyContext(gmailThreadId, selfEmail) {
      const gmail = await getGmailClient(handle, userId);
      const res = await gmail.users.threads.get({
        userId: 'me',
        id: gmailThreadId,
        format: 'metadata',
        metadataHeaders: ['From', 'Reply-To', 'Subject', 'Message-ID', 'References'],
      });
      const header = (
        m: { payload?: { headers?: Array<{ name?: string | null; value?: string | null }> } },
        n: string,
      ) => m.payload?.headers?.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? '';
      const messages = res.data.messages ?? [];
      const inbound = messages.filter(
        (m) => !header(m, 'From').toLowerCase().includes(selfEmail.toLowerCase()),
      );
      const last = inbound[inbound.length - 1] ?? messages[messages.length - 1];
      if (!last) throw new Error('thread has no messages');
      const from = parseAddress(header(last, 'From'));
      const replyTo = header(last, 'Reply-To');
      const subject = header(last, 'Subject');
      const messageId = header(last, 'Message-ID');
      const refs = header(last, 'References');
      return {
        to: replyTo ? parseAddress(replyTo).address : from.address,
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        fromName: from.name,
        ...(messageId
          ? { inReplyTo: messageId, references: refs ? `${refs} ${messageId}` : messageId }
          : {}),
      };
    },
  };
}

/**
 * Collaborators for one user; `scheduleReminders` comes from the notifications workstream. Demo
 * tenants get the local calendar and mailbox, every other tenant Google's (see demo/factory).
 * The factory and this module import each other, but only call each other inside functions.
 */
export function createSchedulingDeps(
  handle: TenantHandle,
  userId: string,
  scheduleReminders: SchedulingDeps['scheduleReminders'],
): SchedulingDeps {
  const ports = portFactory(handle, userId);
  return {
    clock: systemClock,
    calendar: ports.calendar,
    mailbox: ports.mailbox,
    mail: {
      sender: ports.sender,
      guards: defaultGuards,
      store: createOutgoingStore(handle, userId),
      onBlocked: createBlockedLogger(handle, userId),
      lookup: ports.sentLookup,
    },
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    scheduleReminders,
  };
}
