import { Hono, type Context } from 'hono';
import type { AppEnv } from '../middleware/session';
import {
  confirmSlot,
  findSlot,
  pgBossBookingQueue,
  type BookingQueue,
  type SlotDetails,
} from '../services/confirm';

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
.when{font-size:1.25rem;font-weight:600;margin:1rem 0}
button{font-size:1rem;padding:.5rem 1.25rem}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function send(c: Context<AppEnv>, status: 200 | 410, html: string) {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  );
  return c.html(html, status);
}

const closedPage = (state: string) =>
  page('No longer open', `<h1>This link is no longer open</h1><p>${esc(state)}</p>`);

const openPage = (d: SlotDetails) =>
  page(
    'Confirm your interview time',
    `<h1>Confirm your interview time</h1>
<p>${esc(d.role)} at ${esc(d.company)}</p>
<p class="when">${esc(d.when)}</p>
<form method="post">
<button type="submit">Confirm this time</button>
</form>`,
  );

const donePage = (d: SlotDetails) =>
  page(
    'Interview confirmed',
    `<h1>You are confirmed</h1>
<p>${esc(d.role)} at ${esc(d.company)}</p>
<p class="when">${esc(d.when)}</p>
<p>We are replying to them now and adding it to your calendar. You can close this page.</p>`,
  );

export interface ConfirmDeps {
  queue?: BookingQueue;
}

/**
 * Public: the visitor holds only a single-use slot token, so this sits outside requireSession.
 * GET renders the slot and a POST button and never confirms (mail scanners prefetch links);
 * POST confirms once (design rule 9). A used, expired or replaced link is 410.
 */
export function createConfirmRoutes(deps: ConfirmDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const queue = deps.queue ?? pgBossBookingQueue;

  app.get('/:token', async (c) => {
    const found = await findSlot(c.get('db'), c.req.param('token'), c.get('now')());
    if (!found) return send(c, 410, closedPage('This request is no longer open.'));
    if (!found.open) return send(c, 410, closedPage(found.state));
    return send(c, 200, openPage(found.details));
  });

  app.post('/:token', async (c) => {
    const result = await confirmSlot(c.get('db'), c.req.param('token'), queue, c.get('now')());
    if (!result.ok) return send(c, 410, closedPage(result.state));
    return send(c, 200, donePage(result.details));
  });

  return app;
}

export const confirmRoutes = createConfirmRoutes();
