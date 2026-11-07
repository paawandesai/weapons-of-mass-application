/**
 * Port factory: one place that decides, per tenant, whether mail and calendar are the real Google
 * ones or the demo tenant's local tables. The flag is `tenants.demo`, read once per factory call
 * on first use. A real tenant never reaches `demo_*` tables.
 *
 * Wiring (done by the simulated-recruiter workstream, not here). Everywhere a production dep is
 * built from `(handle, userId)`, build it from `portFactory(handle, userId)` instead:
 *
 *   createInboxDeps (apps/worker/src/inbox/wiring.ts)
 *     gmail: (handle, userId) => portFactory(handle, userId).inbox
 *     mail:  (handle, userId) => { const p = portFactory(handle, userId);
 *              return { sender: p.sender, lookup: p.sentLookup, guards: defaultGuards,
 *                       store: createOutgoingStore(handle, userId),
 *                       onBlocked: createBlockedLogger(handle, userId) }; }
 *
 *   createSchedulingDeps (apps/worker/src/scheduling/ports.ts)
 *     const p = portFactory(handle, userId);
 *     calendar: p.calendar, mailbox: p.mailbox,
 *     mail: { sender: p.sender, lookup: p.sentLookup, ...guards, store, onBlocked }
 *     (ports.ts will import this module and this module imports ports.ts; both only call each
 *      other inside functions, never at module load, so the ESM cycle is harmless.)
 *
 *   createNotificationDeps (apps/worker/src/notifications/deps.ts)
 *     mail: (handle, userId) => { const p = portFactory(handle, userId);
 *              return { sender: p.sender, lookup: p.sentLookup, guards: defaultGuards, store, onBlocked }; }
 *
 * The returned ports are synchronous to construct and resolve the flag on first call, so they
 * drop into the existing synchronous dependency shapes. `demo` is a promise of the flag.
 */
import { createGmailSender } from '@wma/google';
import type { TenantHandle } from '@wma/db';
import type { GmailSender, SentLookup } from '@wma/shared';
import { createInboxGmailPort, type InboxGmailPort } from '../inbox/gmail-reader';
import { createCalendarPort, createMailboxPort } from '../scheduling/ports';
import type { CalendarPort, MailboxPort } from '../scheduling/types';
import { createSentLookup } from '../submission/gmail';
import {
  createDemoCalendarPort,
  createDemoInboxGmailPort,
  createDemoMailboxPort,
  createDemoSender,
  createDemoSentLookup,
  isDemoTenant,
} from './ports';

export interface Ports {
  inbox: InboxGmailPort;
  sender: GmailSender;
  sentLookup: SentLookup;
  calendar: CalendarPort;
  mailbox: MailboxPort;
  /** Resolves to `tenants.demo` for the handle's tenant. */
  demo: Promise<boolean>;
}

interface Impl {
  inbox: InboxGmailPort;
  sender: GmailSender;
  sentLookup: SentLookup;
  calendar: CalendarPort;
  mailbox: MailboxPort;
}

export function portFactory(handle: TenantHandle, userId: string): Ports {
  let flag: Promise<boolean> | null = null;
  const demo = () => (flag ??= isDemoTenant(handle));
  const impls: { demo?: Impl; real?: Impl } = {};
  const pick = async (): Promise<Impl> => {
    if (await demo()) {
      return (impls.demo ??= {
        inbox: createDemoInboxGmailPort(handle, userId),
        sender: createDemoSender(handle, userId),
        sentLookup: createDemoSentLookup(handle, userId),
        calendar: createDemoCalendarPort(handle, userId),
        mailbox: createDemoMailboxPort(handle),
      });
    }
    return (impls.real ??= {
      inbox: createInboxGmailPort(handle, userId),
      sender: createGmailSender(handle),
      sentLookup: createSentLookup(handle, userId),
      calendar: createCalendarPort(handle, userId),
      mailbox: createMailboxPort(handle, userId),
    });
  };
  return {
    inbox: {
      currentHistoryId: async () => (await pick()).inbox.currentHistoryId(),
      listHistory: async (id) => (await pick()).inbox.listHistory(id),
      listSince: async (after) => (await pick()).inbox.listSince(after),
      getMessage: async (id) => (await pick()).inbox.getMessage(id),
      getThread: async (id) => (await pick()).inbox.getThread(id),
    },
    sender: { send: async (email) => (await pick()).sender.send(email) },
    sentLookup: { find: async (q) => (await pick()).sentLookup.find(q) },
    calendar: {
      busy: async (from, to) => (await pick()).calendar.busy(from, to),
      createEvent: async (e) => (await pick()).calendar.createEvent(e),
      updateEvent: async (id, e) => (await pick()).calendar.updateEvent(id, e),
    },
    mailbox: {
      replyContext: async (thread, self) => (await pick()).mailbox.replyContext(thread, self),
    },
    get demo() {
      return demo();
    },
  };
}
