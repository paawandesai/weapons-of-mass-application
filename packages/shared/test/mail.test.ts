import { describe, expect, it } from 'vitest';
import { ContentGuardError, InMemorySender, sendEmail, type ContentGuard } from '../src';

const msg = {
  userId: 'u1',
  to: 'me@example.test',
  subject: 'Hello',
  html: '<p>hi</p>',
  text: 'hi',
};

describe('InMemorySender and sendEmail', () => {
  it('records what was sent and returns a message id', async () => {
    const sender = new InMemorySender();
    const r = await sendEmail({ sender, guards: [] }, msg);
    expect(r.messageId).toBe('mem-1');
    expect(sender.sent).toEqual([msg]);
  });

  it('passes attachments through', async () => {
    const sender = new InMemorySender();
    const attachments = [
      { filename: 'c.png', contentType: 'image/png', content: Buffer.from([1]), contentId: 'c1' },
    ];
    await sendEmail({ sender, guards: [] }, { ...msg, attachments });
    expect(sender.sent[0]!.attachments).toEqual(attachments);
  });

  it('runs guards in order and a failing guard blocks the send', async () => {
    const sender = new InMemorySender();
    const order: string[] = [];
    const ok: ContentGuard = {
      name: 'ok',
      check: () => (order.push('ok'), { ok: true }),
    };
    const no: ContentGuard = {
      name: 'no',
      check: async () => (order.push('no'), { ok: false, reason: 'nope' }),
    };
    await expect(sendEmail({ sender, guards: [ok, no] }, msg)).rejects.toBeInstanceOf(
      ContentGuardError,
    );
    expect(order).toEqual(['ok', 'no']);
    expect(sender.sent).toEqual([]);
  });
});
