import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemorySender, defaultGuards, sendEmail } from '@wma/shared';
import {
  activity,
  confirmSlotByTokenHash,
  createBlockedLogger,
  createOutgoingStore,
  getEmailThread,
  getEmailThreadByGmailId,
  getInterview,
  getMailSyncState,
  getSlotByTokenHash,
  insertInterview,
  insertInterviewSlot,
  insertOutgoingMessage,
  getOutgoingMessageByKey,
  isMessageProcessed,
  listOutgoingMessagesForApplication,
  listProcessedMessageIds,
  listSlotsForInterview,
  markMessageProcessed,
  setNotificationSettings,
  updateApplication,
  upsertEmailThread,
  upsertMailSyncState,
  getApplication,
} from '../src';
import { makeApplication, pgErrorMessage, setupEnv, type TestEnv } from './helpers';

let env: TestEnv;
let A: Awaited<ReturnType<TestEnv['makeTenant']>>;
let B: Awaited<ReturnType<TestEnv['makeTenant']>>;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const gid = () => `g-${randomBytes(6).toString('hex')}`;
const at = (h: number) => new Date(Date.UTC(2030, 0, 1, h));

beforeAll(async () => {
  env = await setupEnv();
  A = await env.makeTenant();
  B = await env.makeTenant();
});
afterAll(async () => {
  await env.cleanup();
});

async function seedInterview(t: typeof A, slots = 2) {
  const { application } = await makeApplication(t);
  const thread = await upsertEmailThread(t.handle, {
    userId: t.userId,
    gmailThreadId: gid(),
    kind: 'interview',
    applicationId: application.id,
  });
  const { interview } = await insertInterview(t.handle, {
    userId: t.userId,
    applicationId: application.id,
    threadId: thread.id,
  });
  const tokens: string[] = [];
  for (let i = 0; i < slots; i++) {
    const tk = token();
    tokens.push(tk);
    await insertInterviewSlot(t.handle, {
      interviewId: interview.id,
      startsAt: at(10 + i),
      endsAt: at(11 + i),
      tzHint: 'PT',
      tokenHash: hash(tk),
    });
  }
  return { application, thread, interview, tokens };
}

describe('schema round trips', () => {
  it('email_threads upserts per (tenant, gmail thread) and keeps the application link', async () => {
    const { application } = await makeApplication(A);
    const g = gid();
    const first = await upsertEmailThread(A.handle, {
      userId: A.userId,
      gmailThreadId: g,
      kind: 'unlinked',
    });
    expect(first.applicationId).toBeNull();
    expect(first.compensationFlag).toBe(false);
    const linked = await upsertEmailThread(A.handle, {
      userId: A.userId,
      gmailThreadId: g,
      kind: 'offer',
      applicationId: application.id,
      compensationFlag: true,
      bookingLink: 'https://cal.example.test/x',
      promptVersion: 'inbox-classify@1',
    });
    expect(linked.id).toBe(first.id);
    const again = await upsertEmailThread(A.handle, {
      userId: A.userId,
      gmailThreadId: g,
      kind: 'offer',
    });
    expect(again).toMatchObject({
      applicationId: application.id,
      compensationFlag: true,
      promptVersion: 'inbox-classify@1',
    });
    expect((await getEmailThreadByGmailId(A.handle, g))?.id).toBe(first.id);
  });

  it('processed_messages records a message once', async () => {
    const m = gid();
    expect(await isMessageProcessed(A.handle, m)).toBe(false);
    expect(
      await markMessageProcessed(A.handle, {
        userId: A.userId,
        gmailMessageId: m,
        outcome: 'failed',
      }),
    ).toBe(true);
    expect(
      await markMessageProcessed(A.handle, {
        userId: A.userId,
        gmailMessageId: m,
        outcome: 'linked',
      }),
    ).toBe(false);
    expect(await isMessageProcessed(A.handle, m)).toBe(true);
    const m2 = gid();
    expect((await listProcessedMessageIds(A.handle, [m, m2])).has(m)).toBe(true);
    expect((await listProcessedMessageIds(A.handle, [m, m2])).has(m2)).toBe(false);
    // The same Gmail id in another tenant is a different message.
    expect(
      await markMessageProcessed(B.handle, {
        userId: B.userId,
        gmailMessageId: m,
        outcome: 'unlinked',
      }),
    ).toBe(true);
  });

  it('interviews: one per thread; slots and prep plan columns round trip', async () => {
    const s = await seedInterview(A, 1);
    const again = await insertInterview(A.handle, {
      userId: A.userId,
      applicationId: s.application.id,
      threadId: s.thread.id,
    });
    expect(again.created).toBe(false);
    expect(again.interview.id).toBe(s.interview.id);
    const slots = await listSlotsForInterview(A.handle, s.interview.id);
    expect(slots).toHaveLength(1);
    expect(slots[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6.9 * 86400_000);
    expect(s.interview.prepPlanStatus).toBeNull();
  });

  it('outgoing_messages and mail_sync_state round trip', async () => {
    const { application } = await makeApplication(A);
    const row = await insertOutgoingMessage(A.handle, {
      userId: A.userId,
      applicationId: application.id,
      kind: 'follow_up',
      toAddress: 'r@example.test',
      subject: 's',
      bodyText: 'b',
      sentAt: new Date(),
      gmailMessageId: 'gm1',
    });
    expect(row.blocked).toBe(false);
    expect(await listOutgoingMessagesForApplication(A.handle, application.id)).toHaveLength(1);

    expect(await getMailSyncState(A.handle, A.userId)).toBeNull();
    const s1 = await upsertMailSyncState(A.handle, A.userId, { historyId: '100' });
    expect(s1).toMatchObject({ historyId: '100', reauthNeeded: false });
    const s2 = await upsertMailSyncState(A.handle, A.userId, { reauthNeeded: true });
    expect(s2).toMatchObject({ historyId: '100', reauthNeeded: true });
  });

  it('applications.followed_up_at and users.timezone', async () => {
    const { application } = await makeApplication(A);
    expect(application.followedUpAt).toBeNull();
    const done = new Date();
    await updateApplication(A.handle, application.id, { followedUpAt: done });
    expect((await getApplication(A.handle, application.id))?.followedUpAt?.getTime()).toBe(
      done.getTime(),
    );
    const u = await setNotificationSettings(A.handle, A.userId, {
      timezone: 'Europe/Berlin',
      digestHour: 6,
    });
    expect(u).toMatchObject({ timezone: 'Europe/Berlin', digestHour: 6 });
    const fresh = await env.makeTenant();
    const owner = await env.owner.query('select timezone from users where id = $1', [fresh.userId]);
    expect(owner.rows[0].timezone).toBe('America/Los_Angeles');
  });
});

describe('tenant isolation', () => {
  it('B cannot read A rows in any new table', async () => {
    const s = await seedInterview(A);
    await insertOutgoingMessage(A.handle, {
      userId: A.userId,
      kind: 'other',
      toAddress: 'x@x.test',
      subject: 's',
      bodyText: 'b',
    });
    await markMessageProcessed(A.handle, {
      userId: A.userId,
      gmailMessageId: gid(),
      outcome: 'unlinked',
    });
    await upsertMailSyncState(A.handle, A.userId, { historyId: '1' });
    for (const table of [
      'email_threads',
      'processed_messages',
      'interviews',
      'interview_slots',
      'outgoing_messages',
      'mail_sync_state',
    ]) {
      const r = await B.handle.run((tx) =>
        tx.execute(`select count(*)::int as n from ${table} where tenant_id = '${A.id}'` as never),
      );
      expect((r.rows[0] as { n: number }).n).toBe(0);
    }
    expect(await getEmailThread(B.handle, s.thread.id)).toBeNull();
    expect(await getInterview(B.handle, s.interview.id)).toBeNull();
    expect(await getSlotByTokenHash(B.handle, hash(s.tokens[0]!))).toBeNull();
    expect(await confirmSlotByTokenHash(B.handle, hash(s.tokens[0]!))).toEqual({
      ok: false,
      reason: 'no_longer_open',
    });
    expect((await getInterview(A.handle, s.interview.id))?.confirmedAt).toBeNull();
  });

  it('rejects inserting a row stamped with another tenant (RLS with check)', async () => {
    const { application } = await makeApplication(A);
    const sql = (table: string, cols: string, vals: string) =>
      B.handle.run((tx) => tx.execute(`insert into ${table} (${cols}) values (${vals})` as never));
    expect(
      await pgErrorMessage(
        sql(
          'email_threads',
          'tenant_id, user_id, gmail_thread_id, kind',
          `'${A.id}', '${A.userId}', 'x', 'other'`,
        ),
      ),
    ).toContain('row-level security');
    expect(
      await pgErrorMessage(
        sql(
          'outgoing_messages',
          'tenant_id, user_id, kind, to_address, subject, body_text',
          `'${A.id}', '${A.userId}', 'other', 'a', 'b', 'c'`,
        ),
      ),
    ).toContain('row-level security');
    expect(
      await pgErrorMessage(
        sql('mail_sync_state', 'tenant_id, user_id', `'${A.id}', '${A.userId}'`),
      ),
    ).toContain('row-level security');
    expect(
      await pgErrorMessage(
        sql(
          'processed_messages',
          'tenant_id, user_id, gmail_message_id, outcome',
          `'${A.id}', '${A.userId}', 'm', 'linked'`,
        ),
      ),
    ).toContain('row-level security');
    expect(application.tenantId).toBe(A.id);
  });

  it('rejects cross-tenant references through the tenant-qualified keys', async () => {
    const a = await seedInterview(A, 1);
    const b = await makeApplication(B);
    // B thread pointing at A's application.
    expect(
      await pgErrorMessage(
        upsertEmailThread(B.handle, {
          userId: B.userId,
          gmailThreadId: gid(),
          kind: 'other',
          applicationId: a.application.id,
        }),
      ),
    ).toContain('foreign key');
    // B interview pointing at A's thread / A's application.
    expect(
      await pgErrorMessage(
        insertInterview(B.handle, {
          userId: B.userId,
          applicationId: b.application.id,
          threadId: a.thread.id,
        }),
      ),
    ).toContain('foreign key');
    // B slot pointing at A's interview.
    expect(
      await pgErrorMessage(
        insertInterviewSlot(B.handle, {
          interviewId: a.interview.id,
          startsAt: at(1),
          endsAt: at(2),
          tokenHash: hash(token()),
        }),
      ),
    ).toContain('foreign key');
    // B outgoing message and processed message pointing at A's rows.
    expect(
      await pgErrorMessage(
        insertOutgoingMessage(B.handle, {
          userId: B.userId,
          applicationId: a.application.id,
          kind: 'other',
          toAddress: 'a',
          subject: 'b',
          bodyText: 'c',
        }),
      ),
    ).toContain('foreign key');
    expect(
      await pgErrorMessage(
        markMessageProcessed(B.handle, {
          userId: B.userId,
          gmailMessageId: gid(),
          outcome: 'linked',
          threadId: a.thread.id,
        }),
      ),
    ).toContain('foreign key');
    // A user id from another tenant.
    expect(
      await pgErrorMessage(upsertMailSyncState(B.handle, A.userId, { historyId: '1' })),
    ).toContain('foreign key');
  });

  it('the same Gmail thread id is independent per tenant', async () => {
    const g = gid();
    const a = await upsertEmailThread(A.handle, {
      userId: A.userId,
      gmailThreadId: g,
      kind: 'other',
    });
    const b = await upsertEmailThread(B.handle, {
      userId: B.userId,
      gmailThreadId: g,
      kind: 'other',
    });
    expect(a.id).not.toBe(b.id);
  });
});

describe('confirmSlotByTokenHash', () => {
  it('confirms once, invalidates siblings, and records the slot on the interview', async () => {
    const s = await seedInterview(A, 3);
    const before = await getSlotByTokenHash(A.handle, hash(s.tokens[1]!));
    expect(before?.open).toBe(true);

    const r = await confirmSlotByTokenHash(A.handle, hash(s.tokens[1]!));
    expect(r).toMatchObject({ ok: true, interviewId: s.interview.id });

    const interview = (await getInterview(A.handle, s.interview.id))!;
    const slots = await listSlotsForInterview(A.handle, s.interview.id);
    const chosen = slots.find((x) => x.tokenHash === hash(s.tokens[1]!))!;
    expect(interview.confirmedSlotId).toBe(chosen.id);
    expect(interview.confirmedAt).not.toBeNull();
    expect(interview.startsAt?.getTime()).toBe(chosen.startsAt.getTime());
    expect(interview.endsAt?.getTime()).toBe(chosen.endsAt.getTime());
    expect(chosen.confirmedAt).not.toBeNull();
    expect(chosen.invalidatedAt).toBeNull();
    for (const sib of slots.filter((x) => x.id !== chosen.id)) {
      expect(sib.invalidatedAt).not.toBeNull();
      expect(sib.confirmedAt).toBeNull();
    }
  });

  it('a reused token and a sibling token both return no_longer_open and write nothing', async () => {
    const s = await seedInterview(A, 2);
    expect((await confirmSlotByTokenHash(A.handle, hash(s.tokens[0]!))).ok).toBe(true);
    const snapshot = JSON.stringify(await listSlotsForInterview(A.handle, s.interview.id));
    const interviewBefore = JSON.stringify(await getInterview(A.handle, s.interview.id));

    expect(await confirmSlotByTokenHash(A.handle, hash(s.tokens[0]!))).toEqual({
      ok: false,
      reason: 'no_longer_open',
    });
    expect(await confirmSlotByTokenHash(A.handle, hash(s.tokens[1]!))).toEqual({
      ok: false,
      reason: 'no_longer_open',
    });
    expect((await getSlotByTokenHash(A.handle, hash(s.tokens[1]!)))?.open).toBe(false);

    expect(JSON.stringify(await listSlotsForInterview(A.handle, s.interview.id))).toBe(snapshot);
    expect(JSON.stringify(await getInterview(A.handle, s.interview.id))).toBe(interviewBefore);
  });

  it('an unknown token returns no_longer_open', async () => {
    expect(await confirmSlotByTokenHash(A.handle, hash('nope'))).toEqual({
      ok: false,
      reason: 'no_longer_open',
    });
  });

  it('expiry is judged on the database clock', async () => {
    const s = await seedInterview(A, 1);
    const expired = token();
    await insertInterviewSlot(A.handle, {
      interviewId: s.interview.id,
      startsAt: at(20),
      endsAt: at(21),
      tokenHash: hash(expired),
      ttlSeconds: -5,
    });
    expect((await getSlotByTokenHash(A.handle, hash(expired)))?.open).toBe(false);
    expect(await confirmSlotByTokenHash(A.handle, hash(expired))).toEqual({
      ok: false,
      reason: 'no_longer_open',
    });
    expect((await getInterview(A.handle, s.interview.id))?.confirmedAt).toBeNull();

    // A live token that expires between GET and POST is refused too.
    await env.owner.query(
      "update interview_slots set expires_at = now() - interval '1 second' where token_hash = $1",
      [hash(s.tokens[0]!)],
    );
    expect(await confirmSlotByTokenHash(A.handle, hash(s.tokens[0]!))).toEqual({
      ok: false,
      reason: 'no_longer_open',
    });
    // Just inside the window still works.
    const near = token();
    await insertInterviewSlot(A.handle, {
      interviewId: s.interview.id,
      startsAt: at(22),
      endsAt: at(23),
      tokenHash: hash(near),
      ttlSeconds: 60,
    });
    expect((await confirmSlotByTokenHash(A.handle, hash(near))).ok).toBe(true);
  });

  it('concurrent confirms of sibling tokens yield exactly one winner', async () => {
    const s = await seedInterview(A, 4);
    const results = await Promise.all(
      s.tokens.map((tk) => confirmSlotByTokenHash(A.handle, hash(tk))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const slots = await listSlotsForInterview(A.handle, s.interview.id);
    expect(slots.filter((x) => x.confirmedAt)).toHaveLength(1);
  });
});

describe('pre-tenant lookups', () => {
  it('resolveSlotToken returns identifiers for a known hash and null otherwise', async () => {
    const s = await seedInterview(A, 1);
    const slot = (await listSlotsForInterview(A.handle, s.interview.id))[0]!;
    expect(await env.db.resolveSlotToken(hash(s.tokens[0]!))).toEqual({
      tenantId: A.id,
      slotId: slot.id,
    });
    expect(await env.db.resolveSlotToken(hash('unknown'))).toBeNull();
  });

  it('digestRoster lists users with an approved profile with hour and zone', async () => {
    const t = await env.makeTenant();
    expect((await env.db.digestRoster()).some((x) => x.userId === t.userId)).toBe(false);
    await env.owner.query('update users set approved_profile_version = 1 where id = $1', [
      t.userId,
    ]);
    await setNotificationSettings(t.handle, t.userId, { digestHour: 5, timezone: 'Asia/Tokyo' });
    const entry = (await env.db.digestRoster()).find((x) => x.userId === t.userId);
    expect(entry).toEqual({
      tenantId: t.id,
      userId: t.userId,
      digestHour: 5,
      timezone: 'Asia/Tokyo',
    });
  });
});

describe('createOutgoingStore with sendEmail', () => {
  it('persists a blocked row, logs send_blocked, and never calls the sender', async () => {
    const { application } = await makeApplication(A);
    const sender = new InMemorySender();
    const result = await sendEmail(
      {
        sender,
        guards: defaultGuards,
        store: createOutgoingStore(A.handle, A.userId),
        onBlocked: createBlockedLogger(A.handle, A.userId),
      },
      {
        userId: A.userId,
        applicationId: application.id,
        kind: 'recruiter_reply',
        to: 'r@example.test',
        subject: 'Re: role',
        text: 'Is the salary negotiable?',
        html: '<p>Is the salary negotiable?</p>',
      },
    );
    expect(result.status).toBe('blocked');
    expect(sender.sent).toEqual([]);
    const rows = await listOutgoingMessagesForApplication(A.handle, application.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      blocked: true,
      kind: 'recruiter_reply',
      sentAt: null,
      gmailMessageId: null,
    });
    expect(rows[0]!.blockedReason).toContain('salary');
    const log = await activity.listByApplication(A.handle, application.id);
    expect(log.map((e) => e.action)).toContain('send_blocked');
  });

  it('persists a sent row with the gmail message id', async () => {
    const { application } = await makeApplication(A);
    const sender = new InMemorySender();
    const result = await sendEmail(
      { sender, guards: defaultGuards, store: createOutgoingStore(A.handle, A.userId) },
      {
        userId: A.userId,
        applicationId: application.id,
        kind: 'follow_up',
        to: 'r@example.test',
        subject: 'Following up',
        text: 'Checking in.',
        html: '<p>Checking in.</p>',
      },
    );
    expect(result).toMatchObject({ status: 'sent', messageId: 'mem-1' });
    const rows = await listOutgoingMessagesForApplication(A.handle, application.id);
    expect(rows[0]).toMatchObject({
      blocked: false,
      kind: 'follow_up',
      gmailMessageId: 'mem-1',
      toAddress: 'r@example.test',
    });
    expect(rows[0]!.sentAt).toBeInstanceOf(Date);
  });
});

describe('wave 3 review fixes: delivery receipts', () => {
  const mailDeps = (t: typeof A, sender = new InMemorySender()) => ({
    sender,
    guards: defaultGuards,
    store: createOutgoingStore(t.handle, t.userId),
  });

  it('stores confirmation tokens redacted while the delivered email keeps them', async () => {
    const { application } = await makeApplication(A);
    const sender = new InMemorySender();
    const link = 'https://app.example.test/confirm/Zx9_secretToken-1';
    await sendEmail(mailDeps(A, sender), {
      userId: A.userId,
      applicationId: application.id,
      kind: 'slot_confirmation',
      to: 'me@example.test',
      subject: 'Pick a time',
      text: `Pick: ${link}`,
      html: `<a href="${link}">Pick</a>`,
      deliveryKey: `slot_confirmation:${application.id}:1`,
    });
    expect(sender.sent[0]!.text).toContain('secretToken');
    const [row] = await listOutgoingMessagesForApplication(A.handle, application.id);
    expect(row!.bodyText).not.toContain('secretToken');
    expect(row!.bodyHtml).not.toContain('secretToken');
    expect(row!.bodyText).toContain('/confirm/[redacted]');
  });

  it('a keyed send writes a pending row first, finalizes it, and a repeat sends nothing', async () => {
    const { application } = await makeApplication(A);
    const key = `follow_up:${application.id}`;
    const sender = new InMemorySender();
    const email = {
      userId: A.userId,
      applicationId: application.id,
      kind: 'follow_up' as const,
      to: 'r@example.test',
      subject: 'Hi',
      text: 'x',
      html: '<p>x</p>',
      deliveryKey: key,
    };
    await sendEmail(mailDeps(A, sender), email);
    const row = await getOutgoingMessageByKey(A.handle, key);
    expect(row).toMatchObject({ state: 'sent', gmailMessageId: 'mem-1' });
    expect(await sendEmail(mailDeps(A, sender), email)).toMatchObject({ alreadySent: true });
    expect(sender.sent).toHaveLength(1);
  });

  it('a pending row left by a crash makes the retry uncertain; unique per tenant, reusable across tenants', async () => {
    const { application } = await makeApplication(A);
    const key = `reminder:${application.id}:3600`;
    const store = createOutgoingStore(A.handle, A.userId);
    const row = {
      kind: 'reminder' as const,
      applicationId: application.id,
      to: 'a@x.test',
      subject: 's',
      bodyText: 't',
      bodyHtml: null,
      gmailMessageId: null,
      blocked: false,
      blockedReason: null,
      sentAt: null,
      deliveryKey: key,
    };
    expect(await store.begin(row)).toMatchObject({ created: true });
    expect(await store.begin(row)).toMatchObject({ created: false, receipt: { state: 'pending' } });
    const sender = new InMemorySender();
    expect(
      await sendEmail(mailDeps(A, sender), {
        userId: A.userId,
        applicationId: application.id,
        kind: 'reminder',
        to: 'a@x.test',
        subject: 's',
        text: 't',
        html: 't',
        deliveryKey: key,
      }),
    ).toMatchObject({ status: 'uncertain' });
    expect(sender.sent).toHaveLength(0);
    const { application: appB } = await makeApplication(B);
    expect(
      await createOutgoingStore(B.handle, B.userId).begin({ ...row, applicationId: appB.id }),
    ).toMatchObject({ created: true });
  });
});

describe('wave 3 review fixes: thread metadata and sync state', () => {
  it('an older message never overwrites a newer thread; the compensation flag is sticky', async () => {
    const { application } = await makeApplication(A);
    const gmailThreadId = gid();
    const base = { userId: A.userId, gmailThreadId, applicationId: application.id };
    await upsertEmailThread(A.handle, {
      ...base,
      kind: 'interview',
      compensationFlag: true,
      bookingLink: 'https://cal.test/x',
      promptVersion: 'v2',
      lastMessageAt: at(12),
    });
    const t = await upsertEmailThread(A.handle, {
      ...base,
      kind: 'confirmation',
      compensationFlag: false,
      bookingLink: null,
      promptVersion: 'v1',
      lastMessageAt: at(8),
    });
    expect(t).toMatchObject({
      kind: 'interview',
      compensationFlag: true,
      bookingLink: 'https://cal.test/x',
      promptVersion: 'v2',
    });
    expect(t.lastMessageAt).toEqual(at(12));
    const newer = await upsertEmailThread(A.handle, {
      ...base,
      kind: 'other',
      compensationFlag: false,
      bookingLink: null,
      lastMessageAt: at(15),
    });
    expect(newer).toMatchObject({ kind: 'other', compensationFlag: true, bookingLink: null });
    expect(newer.lastMessageAt).toEqual(at(15));
  });

  it('deferred message ids round trip and are replaced as a list', async () => {
    await upsertMailSyncState(A.handle, A.userId, { deferredMessageIds: ['m1', 'm2'] });
    expect((await getMailSyncState(A.handle, A.userId))!.deferredMessageIds).toEqual(['m1', 'm2']);
    await upsertMailSyncState(A.handle, A.userId, { historyId: 'h-9' });
    expect((await getMailSyncState(A.handle, A.userId))!.deferredMessageIds).toEqual(['m1', 'm2']);
    await upsertMailSyncState(A.handle, A.userId, { deferredMessageIds: [] });
    expect((await getMailSyncState(A.handle, A.userId))!.deferredMessageIds).toEqual([]);
  });
});
