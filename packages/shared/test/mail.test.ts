import { describe, expect, it, vi } from 'vitest';
import {
  defaultGuards,
  InMemoryOutgoingStore,
  InMemorySender,
  moneyGuard,
  reconcileOutgoing,
  redactConfirmTokens,
  scrubEmployerText,
  sendEmail,
  sendEmailRecovering,
  type ContentGuard,
  type OutgoingEmail,
} from '../src';

const msg: OutgoingEmail = {
  userId: 'u1',
  to: 'me@example.test',
  subject: 'Hello',
  html: '<p>hi</p>',
  text: 'hi',
};

function deps(guards: ContentGuard[]) {
  const sender = new InMemorySender();
  const store = new InMemoryOutgoingStore();
  return { sender, store, deps: { sender, guards, store } };
}

describe('sendEmail', () => {
  it('stores a sent row with the mailbox message id and returns it', async () => {
    const { sender, store, deps: d } = deps([]);
    const r = await sendEmail(d, { ...msg, kind: 'follow_up', applicationId: 'a1' });
    expect(r).toMatchObject({ status: 'sent', messageId: 'mem-1' });
    expect(sender.sent).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      kind: 'follow_up',
      applicationId: 'a1',
      to: 'me@example.test',
      subject: 'Hello',
      bodyText: 'hi',
      bodyHtml: '<p>hi</p>',
      gmailMessageId: 'mem-1',
      blocked: false,
      blockedReason: null,
    });
    expect(store.rows[0]!.sentAt).toBeInstanceOf(Date);
  });

  it('defaults the kind to other and joins several recipients', async () => {
    const { store, deps: d } = deps([]);
    await sendEmail(d, { ...msg, to: ['a@x.test', 'b@x.test'] });
    expect(store.rows[0]).toMatchObject({ kind: 'other', to: 'a@x.test, b@x.test' });
  });

  it('passes attachments through', async () => {
    const { sender, deps: d } = deps([]);
    const attachments = [
      { filename: 'c.png', contentType: 'image/png', content: Buffer.from([1]), contentId: 'c1' },
    ];
    await sendEmail(d, { ...msg, attachments });
    expect(sender.sent[0]!.attachments).toEqual(attachments);
  });

  it('stores a blocked row, calls onBlocked and never calls the sender', async () => {
    const { sender, store, deps: d } = deps(defaultGuards);
    const send = vi.spyOn(sender, 'send');
    const onBlocked = vi.fn();
    const r = await sendEmail(
      { ...d, onBlocked },
      { ...msg, kind: 'recruiter_reply', subject: 'About the salary' },
    );
    expect(r).toMatchObject({ status: 'blocked', guard: 'money', outgoingId: 'out-1' });
    expect(send).not.toHaveBeenCalled();
    expect(sender.sent).toEqual([]);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      blocked: true,
      sentAt: null,
      gmailMessageId: null,
      kind: 'recruiter_reply',
    });
    expect(store.rows[0]!.blockedReason).toContain('salary');
    expect(onBlocked).toHaveBeenCalledOnce();
    expect(onBlocked.mock.calls[0]![0]).toMatchObject({ guard: 'money', outgoingId: 'out-1' });
  });

  it('runs guards in order and the first failing guard blocks', async () => {
    const { sender, store, deps: d } = deps([]);
    const order: string[] = [];
    const ok: ContentGuard = { name: 'ok', check: () => (order.push('ok'), { ok: true }) };
    const no: ContentGuard = {
      name: 'no',
      check: async () => (order.push('no'), { ok: false, reason: 'nope' }),
    };
    const never: ContentGuard = { name: 'never', check: () => (order.push('never'), { ok: true }) };
    const r = await sendEmail({ ...d, guards: [ok, no, never] }, msg);
    expect(r).toMatchObject({ status: 'blocked', guard: 'no', reason: 'nope' });
    expect(order).toEqual(['ok', 'no']);
    expect(sender.sent).toEqual([]);
    expect(store.rows[0]!.blockedReason).toBe('no: nope');
  });

  it('a sender error propagates and stores nothing', async () => {
    const { store, deps: d } = deps([]);
    const sender = {
      send: async () => {
        throw new Error('gmail down');
      },
    };
    await expect(sendEmail({ ...d, sender }, msg)).rejects.toThrow('gmail down');
    expect(store.rows).toEqual([]);
  });
});

describe('recoverable keyed sends', () => {
  const keyed = { ...msg, kind: 'follow_up' as const, deliveryKey: 'follow_up:app-1' };

  it('writes the pending receipt before calling the sender and finalizes it after', async () => {
    const { store, deps: d } = deps([]);
    let during: string | undefined;
    const sender = {
      send: async () => {
        during = store.rows[0]?.state;
        return { messageId: 'g-1' };
      },
    };
    const r = await sendEmail({ ...d, sender }, keyed);
    expect(during).toBe('pending');
    expect(r).toMatchObject({ status: 'sent', messageId: 'g-1' });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      state: 'sent',
      gmailMessageId: 'g-1',
      deliveryKey: 'follow_up:app-1',
    });
    expect(store.rows[0]!.sentAt).toBeInstanceOf(Date);
  });

  it('a second send with the same key returns the stored result and does not call Gmail', async () => {
    const { sender, deps: d } = deps([]);
    await sendEmail(d, keyed);
    const again = await sendEmail(d, keyed);
    expect(again).toMatchObject({ status: 'sent', messageId: 'mem-1', alreadySent: true });
    expect(sender.sent).toHaveLength(1);
  });

  it('a crash after Gmail accepted leaves a pending row; the retry is uncertain and sends nothing', async () => {
    const { sender, store, deps: d } = deps([]);
    const crashing = {
      ...d,
      store: Object.assign(Object.create(store), {
        finalize: async () => {
          throw new Error('db down');
        },
      }),
    };
    // finalize failing after acceptance does not turn the accepted send into an error
    expect(await sendEmail(crashing, keyed)).toMatchObject({ status: 'sent' });
    expect(store.rows[0]!.state).toBe('pending');
    const retry = await sendEmail(d, keyed);
    expect(retry).toMatchObject({ status: 'uncertain', deliveryKey: 'follow_up:app-1' });
    expect(sender.sent).toHaveLength(1);
  });

  it('a sender error keeps the pending receipt so the retry is not blind', async () => {
    const { store, deps: d } = deps([]);
    const failing = {
      send: async () => {
        throw new Error('timeout');
      },
    };
    await expect(sendEmail({ ...d, sender: failing }, keyed)).rejects.toThrow('timeout');
    expect(store.rows[0]!.state).toBe('pending');
    expect(await sendEmail(d, keyed)).toMatchObject({ status: 'uncertain' });
  });

  it('reconcile finalizes the receipt when Gmail has the message', async () => {
    const { sender, store, deps: d } = deps([]);
    await store.begin({
      kind: 'follow_up',
      applicationId: null,
      to: msg.to as string,
      subject: msg.subject,
      bodyText: 'hi',
      bodyHtml: null,
      gmailMessageId: null,
      blocked: false,
      blockedReason: null,
      sentAt: null,
      deliveryKey: 'follow_up:app-1',
    });
    const lookup = { find: vi.fn(async () => ({ messageId: 'g-77' })) };
    const r = await reconcileOutgoing({ ...d, lookup }, 'follow_up:app-1');
    expect(r).toMatchObject({ status: 'sent', messageId: 'g-77' });
    expect(store.rows[0]).toMatchObject({ state: 'sent', gmailMessageId: 'g-77' });
    expect(sender.sent).toHaveLength(0);
  });

  it('reconcile removes the receipt when Gmail has nothing, and sendEmailRecovering then sends once', async () => {
    const { sender, store, deps: d } = deps([]);
    const failing = {
      send: async () => {
        throw new Error('timeout');
      },
    };
    await expect(sendEmail({ ...d, sender: failing }, keyed)).rejects.toThrow();
    const lookup = { find: vi.fn(async () => null) };
    const r = await sendEmailRecovering({ ...d, lookup }, keyed);
    expect(r).toMatchObject({ status: 'sent' });
    expect(sender.sent).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
  });

  it('without a lookup, an unresolved receipt stays uncertain', async () => {
    const { store, deps: d } = deps([]);
    await expect(
      sendEmail(
        {
          ...d,
          sender: {
            send: async () => {
              throw new Error('x');
            },
          },
        },
        keyed,
      ),
    ).rejects.toThrow();
    expect(await reconcileOutgoing(d, 'follow_up:app-1')).toMatchObject({ status: 'uncertain' });
    expect(store.rows).toHaveLength(1);
  });

  it('a blocked keyed message is stored blocked and never opens a receipt', async () => {
    const { sender, store, deps: d } = deps([moneyGuard]);
    const r = await sendEmail(d, { ...keyed, text: 'salary $1' });
    expect(r.status).toBe('blocked');
    expect(sender.sent).toHaveLength(0);
    expect(store.rows[0]).toMatchObject({ state: 'blocked', deliveryKey: null });
  });
});

describe('redactConfirmTokens', () => {
  it('replaces the token in a confirmation link, in text and html, and leaves the delivered email alone', async () => {
    const link = 'https://app.example.test/confirm/AbC_123-xyz';
    const { sender, store, deps: d } = deps([]);
    await sendEmail(d, {
      ...msg,
      kind: 'slot_confirmation',
      text: `Pick: ${link}`,
      html: `<a href="${link}">Pick</a>`,
    });
    expect(sender.sent[0]!.text).toContain('AbC_123-xyz');
    expect(store.rows[0]!.bodyText).toBe('Pick: https://app.example.test/confirm/[redacted]');
    expect(store.rows[0]!.bodyHtml).toBe(
      '<a href="https://app.example.test/confirm/[redacted]">Pick</a>',
    );
    expect(redactConfirmTokens(null)).toBeNull();
  });
});

describe('moneyGuard', () => {
  const check = (over: Partial<OutgoingEmail>) => moneyGuard.check({ ...msg, ...over });

  it('blocks a literal dollar sign anywhere', async () => {
    expect(await check({ text: 'We offer $150k' })).toMatchObject({ ok: false });
    expect(await check({ text: 'pay: 5$' })).toMatchObject({ ok: false });
  });

  it.each([
    'salary',
    'SALARY',
    'Salary',
    'sAlArY',
    'compensation',
    'COMPENSATION',
    'Compensation',
    'equity',
    'EQUITY',
    'Equity',
  ])('blocks the word %s', async (w) => {
    expect(await check({ text: `Regarding ${w} please` })).toMatchObject({ ok: false });
    expect(await check({ subject: `${w}?` })).toMatchObject({ ok: false });
  });

  it('respects word boundaries', async () => {
    expect(await check({ text: 'An equitable process', subject: 'Salaries and equities' })).toEqual(
      {
        ok: true,
      },
    );
    expect(await check({ text: 'compensate' })).toEqual({ ok: true });
  });

  it('blocks a dollar sign inside a URL', async () => {
    expect(await check({ text: 'see https://x.test/a?price=$5' })).toMatchObject({ ok: false });
  });

  it('passes a clean message', async () => {
    expect(await check({ text: 'Thursday at 3pm works. Thanks!' })).toEqual({ ok: true });
  });

  it('checks the html body, not only the text', async () => {
    const r = await check({ text: 'clean', html: '<p>Your <b>salary</b></p>' });
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toContain('html');
  });

  it('checks the subject', async () => {
    expect(await check({ subject: 'Equity grant' })).toMatchObject({ ok: false });
  });
});

describe('scrubEmployerText', () => {
  it('replaces an amount whole', () => {
    expect(scrubEmployerText('They said $150k base')).toBe('They said [omitted] base');
    expect(scrubEmployerText('$1,200.50 and $2M')).toBe('[omitted] and [omitted]');
  });

  it('replaces money words in any case', () => {
    expect(scrubEmployerText('Salary, COMPENSATION and Equity')).toBe(
      '[omitted], [omitted] and [omitted]',
    );
  });

  it('leaves clean text alone and does not touch "equitable"', () => {
    expect(scrubEmployerText('An equitable chat on Friday')).toBe('An equitable chat on Friday');
  });

  it('always yields text the guard passes, even for odd dollar forms', async () => {
    for (const s of ['$', '$abc', 'US$ 100', '$150kfoo', 'range $100-$200 salary equity']) {
      const out = scrubEmployerText(s);
      expect(await moneyGuard.check({ ...msg, text: out, html: out })).toEqual({ ok: true });
    }
  });

  it('a digest quoting a recruiter "$150k" renders [omitted] and passes the guard', async () => {
    const quoted = scrubEmployerText('Recruiter wrote: "the band is $150k"');
    expect(quoted).toBe('Recruiter wrote: "the band is [omitted]"');
    const { sender, deps: d } = deps(defaultGuards);
    const r = await sendEmail(d, {
      ...msg,
      kind: 'digest',
      text: quoted,
      html: `<p>${quoted}</p>`,
    });
    expect(r.status).toBe('sent');
    expect(sender.sent).toHaveLength(1);
  });
});
