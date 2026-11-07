import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertDemoMessage } from '@wma/db';
import { createOutgoingStore, createBlockedLogger } from '@wma/db';
import { defaultGuards, sendEmail } from '@wma/shared';
import {
  createDemoCalendarPort,
  createDemoInboxGmailPort,
  createDemoMailboxPort,
  createDemoSender,
  createDemoSentLookup,
  isDemoTenant,
} from '../../src/demo/ports';
import { portFactory } from '../../src/demo/factory';
import { setupEnv, type TestEnv, type TestTenant } from '../helpers';

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';
let env: TestEnv;
let owner: pg.Pool;
let T: TestTenant;
let U: TestTenant;

beforeAll(async () => {
  env = await setupEnv();
  owner = new pg.Pool({ connectionString: ownerUrl });
  T = await env.makeTenant();
  U = await env.makeTenant();
  await owner.query('update tenants set demo = true where id = $1', [T.id]);
});
afterAll(async () => {
  await owner.query('update tenants set demo = false where id = $1', [T.id]);
  await owner.end();
  await env.cleanup();
});

describe('demo mailbox ports', () => {
  it('reads inbox mail, history and threads', async () => {
    const port = createDemoInboxGmailPort(T.handle, T.userId);
    const start = await port.currentHistoryId();
    const inbound = await insertDemoMessage(T.handle, {
      userId: T.userId,
      threadId: 'th-a',
      fromAddress: 'sam@acme.test',
      fromName: 'Sam Rivera',
      toAddress: T.email,
      subject: 'Interview times',
      bodyText: 'Pick one: https://acme.test/book',
    });
    const hist = await port.listHistory(start);
    expect(hist).toMatchObject({ expired: false, messageIds: [inbound.gmailMessageId] });
    const msg = await port.getMessage(inbound.gmailMessageId);
    expect(msg).toMatchObject({
      threadId: 'th-a',
      from: '"Sam Rivera" <sam@acme.test>',
      subject: 'Interview times',
      labelIds: ['INBOX'],
      links: ['https://acme.test/book'],
    });
    expect(await port.getMessage('nope')).toBeNull();
    expect(await port.listSince(new Date(Date.now() - 60_000))).toContain(inbound.gmailMessageId);
  });

  it('stores a message sent through the guarded sender; thread reads and history advance', async () => {
    const port = createDemoInboxGmailPort(T.handle, T.userId);
    const before = Number(await port.currentHistoryId());
    const result = await sendEmail(
      {
        sender: createDemoSender(T.handle, T.userId),
        guards: defaultGuards,
        store: createOutgoingStore(T.handle, T.userId),
        onBlocked: createBlockedLogger(T.handle, T.userId),
        lookup: createDemoSentLookup(T.handle, T.userId),
      },
      {
        userId: T.userId,
        kind: 'recruiter_reply',
        to: 'sam@acme.test',
        subject: 'Re: Interview times',
        text: 'Tuesday works for me.',
        html: '<p>Tuesday works for me.</p>',
        threadId: 'th-a',
        inReplyTo: '<m1@acme.test>',
      },
    );
    expect(result.status).toBe('sent');
    const after = Number(await port.currentHistoryId());
    expect(after).toBe(before + 1);
    const thread = await port.getThread('th-a');
    const last = thread[thread.length - 1]!;
    expect(last.labelIds).toEqual(['SENT']);
    expect(last.text).toBe('Tuesday works for me.');
    expect(last.from).toContain(T.email);
    // A sent message is not new inbox mail.
    const hist = await port.listHistory(String(before));
    expect(hist).toMatchObject({ expired: false, messageIds: [] });
    // The lookup recovers it by recipient and subject.
    const found = await createDemoSentLookup(T.handle, T.userId).find({
      to: 'sam@acme.test',
      subject: 'Re: Interview times',
      after: new Date(Date.now() - 60_000),
    });
    expect(found?.messageId).toBe(last.id);
  });

  it('builds a reply context from the latest inbound message', async () => {
    const ctx = await createDemoMailboxPort(T.handle).replyContext('th-a', T.email);
    expect(ctx).toMatchObject({
      to: 'sam@acme.test',
      subject: 'Re: Interview times',
      fromName: 'Sam Rivera',
    });
  });

  it('does not show one tenant mail to another', async () => {
    const port = createDemoInboxGmailPort(U.handle, U.userId);
    expect(await port.getThread('th-a')).toEqual([]);
    expect(await port.currentHistoryId()).toBe('0');
  });
});

describe('demo calendar port', () => {
  it('creates, reuses by id, updates and reports busy time', async () => {
    const cal = createDemoCalendarPort(T.handle, T.userId);
    const start = new Date('2032-03-01T17:00:00Z');
    const end = new Date('2032-03-01T17:45:00Z');
    const input = {
      id: 'evt-x',
      summary: 'Interview',
      description: 'd',
      start,
      end,
      timeZone: 'UTC',
    };
    expect(await cal.createEvent(input)).toEqual({ id: 'evt-x' });
    expect(await cal.createEvent(input)).toEqual({ id: 'evt-x' });
    expect(
      await cal.busy(new Date('2032-03-01T00:00:00Z'), new Date('2032-03-02T00:00:00Z')),
    ).toEqual([{ start, end }]);
    const moved = new Date('2032-03-02T17:00:00Z');
    await cal.updateEvent('evt-x', {
      ...input,
      start: moved,
      end: new Date('2032-03-02T17:45:00Z'),
    });
    expect(
      await cal.busy(new Date('2032-03-01T00:00:00Z'), new Date('2032-03-02T00:00:00Z')),
    ).toEqual([]);
    await expect(cal.updateEvent('missing', input)).rejects.toThrow();
    expect(await createDemoCalendarPort(U.handle, U.userId).busy(start, moved)).toEqual([]);
  });
});

describe('port factory', () => {
  it('chooses by the tenant flag', async () => {
    expect(await isDemoTenant(T.handle)).toBe(true);
    expect(await isDemoTenant(U.handle)).toBe(false);
    const demo = portFactory(T.handle, T.userId);
    expect(await demo.demo).toBe(true);
    const row = await insertDemoMessage(T.handle, {
      userId: T.userId,
      fromAddress: 'x@acme.test',
      toAddress: T.email,
      subject: 'via factory',
      bodyText: 'b',
    });
    expect((await demo.inbox.getMessage(row.gmailMessageId))?.subject).toBe('via factory');
    const sent = await demo.sender.send({
      userId: T.userId,
      to: 'x@acme.test',
      subject: 's',
      html: '',
      text: 't',
    });
    expect(sent.messageId).toMatch(/^demo-msg-/);
    expect(await portFactory(U.handle, U.userId).demo).toBe(false);
  });
});
