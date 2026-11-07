import type { PgBoss } from 'pg-boss';
import { createBlockedLogger, createOutgoingStore, type TenantHandle } from '@wma/db';
import { defaultGuards, type MailDeps } from '@wma/shared';
import { portFactory } from '../demo/factory';
import { bossNotificationQueue, type NotificationQueue } from './queue';

export interface NotificationDeps {
  queue: NotificationQueue;
  /** The guarded send path for one user (sender, guards, store, blocked logger). */
  mail(handle: TenantHandle, userId: string): MailDeps;
  now(): Date;
  webOrigin: string;
}

/** Production wiring: Gmail sender (the local mailbox for the demo tenant), the money guard, the database store, the system clock. */
export function createNotificationDeps(boss: PgBoss): NotificationDeps {
  return {
    queue: bossNotificationQueue(boss),
    mail: (handle, userId) => {
      const ports = portFactory(handle, userId);
      return {
        sender: ports.sender,
        guards: defaultGuards,
        store: createOutgoingStore(handle, userId),
        onBlocked: createBlockedLogger(handle, userId),
        lookup: ports.sentLookup,
      };
    },
    now: () => new Date(),
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  };
}
