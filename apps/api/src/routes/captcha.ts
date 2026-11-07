import { Hono, type Context } from 'hono';
import type { AppEnv } from '../middleware/session';
import {
  acceptAnswer,
  challengeImage,
  findOpenRequest,
  MAX_ANSWER_LENGTH,
} from '../services/captcha';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
img{max-width:100%;border:1px solid #ccc;border-radius:4px;margin:1rem 0}
input[type=text]{width:100%;box-sizing:border-box;font-size:1.25rem;padding:.5rem;margin-bottom:1rem}
button{font-size:1rem;padding:.5rem 1.25rem}
.error{color:#b00020}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function send(c: Context<AppEnv>, status: 200 | 400 | 410, html: string) {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'",
  );
  return c.html(html, status);
}

const closedPage = () =>
  page(
    'No longer open',
    '<h1>This request is no longer open</h1><p>The link has already been used or has expired. Nothing was entered.</p>',
  );

function formPage(image: string | null, error?: string): string {
  return page(
    'Type the characters',
    `<h1>Type the characters you see</h1>
${image ? `<img src="${image}" alt="Security check">` : ''}
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post">
<input type="text" name="answer" maxlength="${MAX_ANSWER_LENGTH}" autocomplete="off" autocapitalize="off" autofocus required>
<button type="submit">Send</button>
</form>`,
  );
}

/** Public: the visitor holds only a single-use link, so these routes sit outside the session check. */
export const captchaRoutes = new Hono<AppEnv>();

captchaRoutes.get('/:token', async (c) => {
  const open = await findOpenRequest(c.get('db'), c.req.param('token'));
  if (!open) return send(c, 410, closedPage());
  return send(c, 200, formPage(await challengeImage(open)));
});

captchaRoutes.post('/:token', async (c) => {
  const db = c.get('db');
  const token = c.req.param('token');
  let answer = '';
  const type = c.req.header('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const body = (await c.req.json()) as { answer?: unknown };
      answer = typeof body.answer === 'string' ? body.answer : '';
    } else {
      const body = await c.req.parseBody();
      answer = typeof body.answer === 'string' ? body.answer : '';
    }
  } catch {
    answer = '';
  }
  const result = await acceptAnswer(db, token, answer);
  if (result === 'accepted') {
    return send(
      c,
      200,
      page('Thank you', '<h1>Thank you</h1><p>Your answer was sent. You can close this page.</p>'),
    );
  }
  if (result === 'invalid') {
    const open = await findOpenRequest(db, token);
    return send(
      c,
      400,
      formPage(
        open ? await challengeImage(open) : null,
        'Enter the characters shown in the picture.',
      ),
    );
  }
  return send(c, 410, closedPage());
});
