import { describe, expect, it } from 'vitest';
import { GoogleNotConnectedError } from '@wma/google';
import { createInboxGmailPort, isAuthError, parseGmailMessage } from '../../src/inbox/gmail-reader';
import { authError, fixture, toRawGmail } from './support';

describe('parseGmailMessage', () => {
  it('reads sender, subject, thread, labels, date, body text and links from a Gmail resource', () => {
    const f = fixture('booking-link', {
      domain: 'acme.example.com',
      title: 'Dev',
      companyName: 'Acme',
    });
    const m = parseGmailMessage(toRawGmail(f))!;
    expect(m).toMatchObject({
      id: f.id,
      threadId: f.threadId,
      labelIds: ['INBOX', 'UNREAD'],
      from: f.from,
      subject: f.subject,
      receivedAt: new Date(f.date),
    });
    expect(m.text).toContain('choose a time');
    expect(m.links).toEqual(['https://cal.acme.example.com/dana/intro-call']);
  });

  it('falls back to the html part with tags stripped', () => {
    const m = parseGmailMessage({
      id: 'x',
      payload: {
        headers: [{ name: 'From', value: 'a@b.example' }],
        mimeType: 'text/html',
        body: { data: Buffer.from('<p>Hello <b>there</b></p>').toString('base64url') },
      },
    })!;
    expect(m.text.trim()).toBe('Hello there');
    expect(m.threadId).toBe('x');
  });

  it('returns null without an id', () => {
    expect(parseGmailMessage({})).toBeNull();
  });
});

describe('isAuthError', () => {
  it('recognises 401 in the shapes googleapis uses, invalid_grant and a missing grant', () => {
    expect(isAuthError(authError())).toBe(true);
    expect(isAuthError({ response: { status: 401 } })).toBe(true);
    expect(isAuthError({ status: '401' })).toBe(true);
    expect(
      isAuthError(
        Object.assign(new Error('x'), { response: { data: { error: 'invalid_grant' } } }),
      ),
    ).toBe(true);
    expect(isAuthError(new GoogleNotConnectedError())).toBe(true);
    expect(isAuthError(Object.assign(new Error('boom'), { code: 503 }))).toBe(false);
    expect(isAuthError(new Error('boom'))).toBe(false);
  });
});

/** A minimal stand-in for the googleapis client, recording the requests it receives. */
function stubClient(handlers: {
  history?: (req: Record<string, unknown>) => unknown;
  list?: (req: Record<string, unknown>) => unknown;
  get?: (req: Record<string, unknown>) => unknown;
}) {
  const requests: Array<[string, Record<string, unknown>]> = [];
  const call =
    (name: string, fn: ((r: Record<string, unknown>) => unknown) | undefined) =>
    async (req: Record<string, unknown>) => {
      requests.push([name, req]);
      const v = fn?.(req);
      if (v instanceof Error) throw v;
      return { data: v };
    };
  const client = {
    users: {
      getProfile: async () => ({ data: { historyId: 'h-42' } }),
      history: { list: call('history', handlers.history) },
      messages: { list: call('list', handlers.list), get: call('get', handlers.get) },
      threads: { get: call('thread', undefined) },
    },
  };
  return { client: (async () => client) as never, requests };
}

describe('createInboxGmailPort', () => {
  const handle = {} as never;

  it('reads the current history id from the profile', async () => {
    const { client } = stubClient({});
    expect(await createInboxGmailPort(handle, 'u', client).currentHistoryId()).toBe('h-42');
  });

  it('pages through history, collects added message ids once, and returns the newest history id', async () => {
    const pages = [
      {
        history: [{ messagesAdded: [{ message: { id: 'm1' } }, { message: { id: 'm2' } }] }],
        nextPageToken: 'p2',
        historyId: '110',
      },
      {
        history: [{ messagesAdded: [{ message: { id: 'm2' } }, { message: { id: 'm3' } }] }],
        historyId: '120',
      },
    ];
    let i = 0;
    const { client, requests } = stubClient({ history: () => pages[i++] });
    const r = await createInboxGmailPort(handle, 'u', client).listHistory('100');
    expect(r).toEqual({ expired: false, messageIds: ['m1', 'm2', 'm3'], historyId: '120' });
    expect(requests[0]![1]).toMatchObject({
      startHistoryId: '100',
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
    });
    expect(requests[1]![1]).toMatchObject({ pageToken: 'p2' });
  });

  it('reports an expired history id (404) so the caller falls back to the dated listing', async () => {
    const { client } = stubClient({
      history: () => Object.assign(new Error('Requested entity was not found.'), { code: 404 }),
    });
    expect(await createInboxGmailPort(handle, 'u', client).listHistory('1')).toEqual({
      expired: true,
    });
  });

  it('lets a 401 from history propagate for the sync to handle', async () => {
    const { client } = stubClient({ history: () => authError() });
    await expect(createInboxGmailPort(handle, 'u', client).listHistory('1')).rejects.toSatisfy(
      isAuthError,
    );
  });

  it('lists inbox messages after an instant with an after: filter', async () => {
    const { client, requests } = stubClient({
      list: () => ({ messages: [{ id: 'a' }, { id: 'b' }] }),
    });
    const ids = await createInboxGmailPort(handle, 'u', client).listSince(
      new Date('2026-03-01T00:00:00Z'),
    );
    expect(ids).toEqual(['a', 'b']);
    expect(requests[0]![1].q).toBe(`in:inbox after:${Date.parse('2026-03-01T00:00:00Z') / 1000}`);
  });

  it('fails instead of returning a history id when pagination is cut off', async () => {
    const { client } = stubClient({
      history: () => ({ history: [], nextPageToken: 'more', historyId: '999' }),
    });
    await expect(createInboxGmailPort(handle, 'u', client).listHistory('1')).rejects.toThrow(
      /not advancing/,
    );
  });

  it('fails on a truncated dated listing', async () => {
    const { client } = stubClient({
      list: () => ({ messages: [{ id: 'a' }], nextPageToken: 'more' }),
    });
    await expect(
      createInboxGmailPort(handle, 'u', client).listSince(new Date('2026-03-01T00:00:00Z')),
    ).rejects.toThrow(/not advancing/);
  });

  it('treats a missing message (404) as null', async () => {
    const { client } = stubClient({ get: () => Object.assign(new Error('gone'), { code: 404 }) });
    expect(await createInboxGmailPort(handle, 'u', client).getMessage('zz')).toBeNull();
  });
});
