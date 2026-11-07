import { describe, expect, it } from 'vitest';
import { buildMime } from '../src/send';

describe('buildMime', () => {
  const base = {
    userId: 'u',
    to: 'me@example.test',
    subject: 'Captcha for Acme',
    html: '<img src="cid:img1">',
    text: 'open the link',
  };

  it('builds alternatives with an inline image and an attachment', () => {
    const mime = buildMime({
      ...base,
      attachments: [
        {
          filename: 'c.png',
          contentType: 'image/png',
          content: Buffer.from('png'),
          contentId: 'img1',
        },
        { filename: 'r.pdf', contentType: 'application/pdf', content: Buffer.from('pdf') },
      ],
    });
    expect(mime).toContain('Subject: Captcha for Acme');
    expect(mime).toContain('multipart/mixed');
    expect(mime).toContain('multipart/related');
    expect(mime).toContain('multipart/alternative');
    expect(mime).toContain('Content-ID: <img1>');
    expect(mime).toContain('Content-Disposition: attachment; filename="r.pdf"');
  });

  it('encodes non-ASCII subjects and refuses header injection', () => {
    expect(buildMime({ ...base, subject: 'Café' })).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(() => buildMime({ ...base, subject: 'a\r\nBcc: x@y.z' })).toThrow();
  });
});
