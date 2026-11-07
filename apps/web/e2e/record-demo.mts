/**
 * Demo recording harness (docs/demo-script.md). Drives the web app in a real browser against a
 * freshly seeded demo stack (scripts/demo/stack.sh up) and records one WebM per scene, with HTML
 * title cards rendered as stills between them. Scenes follow the PRD demo plan: profile, run,
 * board, recruiter mail and the confirm click, the booked interview with its prep plan.
 *
 *   BASE_URL=http://localhost:5190 OUT_DIR=data/demo pnpm -F @wma/web exec tsx e2e/record-demo.mts
 *
 * SCENES=04,07 records only those scenes (prefix match on the file name). The demo sign-in token
 * comes from DEMO_LOGIN_TOKEN or the repo .env and is only ever sent as a request header.
 *
 * Slow steps (form submissions, the simulated recruiter, booking, the prep plan) are recorded in
 * full and then removed by scripts/demo/cut-waits.sh: every `skip()` block appends the footage
 * interval it covered, relative to the scene's recording start, to <OUT_DIR>/cuts.json. The click
 * and the first second of the pending state stay; the footage resumes just before the result.
 */
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.BASE_URL ?? 'http://localhost:5190').replace(/\/+$/, '');
const OUT = resolve(process.env.OUT_DIR ?? 'data/demo');
const VIEWPORT = { width: 1440, height: 900 };
const ONLY = (process.env.SCENES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const want = (name: string): boolean => ONLY.length === 0 || ONLY.some((o) => name.startsWith(o));

function demoToken(): string {
  if (process.env.DEMO_LOGIN_TOKEN) return process.env.DEMO_LOGIN_TOKEN;
  const file = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*DEMO_LOGIN_TOKEN\s*=\s*(.*?)\s*$/.exec(line);
      if (m) return m[1]!.replace(/^["']|["']$/g, '');
    }
  }
  throw new Error('DEMO_LOGIN_TOKEN is not set');
}
const TOKEN = demoToken();

mkdirSync(join(OUT, 'raw'), { recursive: true });

// ---- cuts -------------------------------------------------------------------------------------
const cuts: Record<string, Array<[number, number]>> = {};
const sceneStart = new WeakMap<Page, number>();
const KEEP_AFTER_CLICK = 1.2;
const RESUME_BEFORE_RESULT = 0.3;
async function skip(
  page: Page,
  name: string,
  fn: () => Promise<void>,
  keep = KEEP_AFTER_CLICK,
): Promise<void> {
  const t0 = sceneStart.get(page) ?? Date.now();
  const from = (Date.now() - t0) / 1000 + keep;
  await fn();
  const to = (Date.now() - t0) / 1000 - RESUME_BEFORE_RESULT;
  if (to > from + 0.5) (cuts[name] ??= []).push([Number(from.toFixed(2)), Number(to.toFixed(2))]);
}

// ---- pages ------------------------------------------------------------------------------------
async function signIn(context: BrowserContext): Promise<void> {
  const res = await context.request.post(`${BASE}/auth/demo`, {
    headers: { 'X-Demo-Token': TOKEN },
  });
  if (!res.ok()) throw new Error(`demo sign-in failed: ${res.status()}`);
}

async function newScene(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: join(OUT, 'raw'), size: VIEWPORT },
    reducedMotion: 'no-preference',
    colorScheme: 'light',
    timezoneId: 'America/Los_Angeles',
  });
  await signIn(context);
  const page = await context.newPage();
  sceneStart.set(page, Date.now());
  return page;
}

async function finish(page: Page, name: string): Promise<void> {
  const video = page.video();
  await page.context().close();
  if (video) {
    const path = await video.path();
    renameSync(path, join(OUT, `${name}.webm`));
    console.log('scene', name, '->', `${name}.webm`);
  }
  saveCuts();
}

/** Written after every scene, so a crash later in the pass loses no cut. */
function saveCuts(): void {
  const cutsPath = join(OUT, 'cuts.json');
  const existing = existsSync(cutsPath)
    ? (JSON.parse(readFileSync(cutsPath, 'utf8')) as Record<string, Array<[number, number]>>)
    : {};
  writeFileSync(cutsPath, JSON.stringify({ ...existing, ...cuts }, null, 2));
}

async function api<T>(page: Page, path: string, init?: { method?: string }): Promise<T> {
  const res = await page.context().request.fetch(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: { Origin: BASE },
  });
  if (!res.ok()) throw new Error(`${path} -> ${res.status()}`);
  return (await res.json()) as T;
}

async function slowScroll(page: Page, px: number, steps = 12, pause = 140): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, px / steps);
    await page.waitForTimeout(pause);
  }
}

/** Polls `until` every `every` ms inside a cut; `tick` runs after each miss (a page reload, say). */
async function waitInCut(
  page: Page,
  name: string,
  until: () => Promise<boolean>,
  opts: {
    every?: number;
    max?: number;
    keep?: number;
    tick?: () => Promise<void>;
    after?: () => Promise<void>;
  } = {},
): Promise<void> {
  const every = opts.every ?? 5000;
  const max = opts.max ?? 600_000;
  await skip(
    page,
    name,
    async () => {
      const deadline = Date.now() + max;
      let met = false;
      while (Date.now() < deadline) {
        if (await until()) {
          met = true;
          break;
        }
        await page.waitForTimeout(every);
        if (opts.tick) await opts.tick();
      }
      if (!met) throw new Error(`${name}: condition not met within ${max / 1000}s`);
      if (opts.after) await opts.after();
    },
    opts.keep,
  );
}

const reloadAnd = (page: Page, ready: () => Promise<unknown>) => async () => {
  await page.reload({ waitUntil: 'load' });
  await ready();
  await page.waitForTimeout(400);
};

// ---- title cards ------------------------------------------------------------------------------
function cardHtml(title: string, subtitle: string, small?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Stardos+Stencil:wght@700&display=swap" rel="stylesheet">
  <style>
    html,body{margin:0;height:100%;background:#2f3522;color:#eee8d5;font-family:'IBM Plex Mono',ui-monospace,monospace}
    .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;padding:0 120px;text-align:center}
    .mark{width:84px;height:84px}
    .rule{width:120px;height:5px;background:#e8590c}
    h1{font-family:'Stardos Stencil',Impact,sans-serif;font-size:64px;font-weight:700;margin:0;letter-spacing:.03em;line-height:1.05}
    p{font-size:24px;color:#cfc7a9;margin:0;max-width:980px;line-height:1.45}
    .small{position:absolute;bottom:44px;left:0;right:0;text-align:center;font-size:16px;color:#9c9271;letter-spacing:.18em;text-transform:uppercase}
  </style></head><body><div class="wrap">
  <svg class="mark" viewBox="0 0 64 64"><g transform="rotate(45 32 32)">
    <rect x="28" y="46" width="8" height="11" fill="#9c9271"/>
    <polygon points="22,38 11,53 22,49" fill="#e8590c"/><polygon points="42,38 53,53 42,49" fill="#e8590c"/>
    <rect x="22" y="18" width="20" height="30" fill="#eee8d5"/><polygon points="32,3 21,19 43,19" fill="#e8590c"/>
    <g stroke="#2f3522" stroke-width="2.4" stroke-linecap="square"><line x1="26" y1="25" x2="38" y2="25"/><line x1="26" y1="30" x2="38" y2="30"/><line x1="26" y1="35" x2="38" y2="35"/><line x1="26" y1="40" x2="35" y2="40"/></g>
  </g></svg>
  <div class="rule"></div><h1>${title}</h1><p>${subtitle}</p></div>
  ${small ? `<div class="small">${small}</div>` : ''}</body></html>`;
}

async function card(
  browser: Browser,
  name: string,
  title: string,
  subtitle: string,
  seconds = 3,
  small?: string,
): Promise<void> {
  if (!want(name)) return;
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.setContent(cardHtml(title, subtitle, small), { waitUntil: 'load' });
  await page.waitForTimeout(1200); // web fonts
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  writeFileSync(join(OUT, `${name}.seconds`), String(seconds));
  await context.close();
  console.log('card', name);
}

// ---- API shapes used here ---------------------------------------------------------------------
interface Application {
  id: string;
  status: string;
  pending_reason: string | null;
  job: { title: string; company: string; url: string };
}
interface Applications {
  applications: Application[];
}
interface Mailbox {
  messages: Array<{ direction: string; subject: string; body_text: string; date: string }>;
}
interface Interviews {
  interviews: Array<{ id: string; prep_plan_status: string | null; confirmed_at?: string | null }>;
}
interface Current {
  run: { status: string } | null;
  candidates: unknown[];
}

const drawer = (page: Page) => page.getByRole('dialog', { name: 'Card detail' });

async function openCard(page: Page, column: string, title: string): Promise<void> {
  const region = page.getByRole('region', { name: column });
  const cardEl = region.locator('article').filter({ hasText: title }).first();
  await cardEl.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await cardEl.locator('button.card-title').click();
  await drawer(page).waitFor();
  await page.waitForTimeout(1500);
}

async function scrollDrawerTo(page: Page, heading: string, pause = 2500): Promise<void> {
  const h = drawer(page).getByRole('heading', { name: heading }).first();
  if ((await h.count()) === 0) return;
  await h.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await page.waitForTimeout(pause);
}

// ---- scenes -----------------------------------------------------------------------------------
async function main(): Promise<void> {
  const browser = await chromium.launch();

  await card(
    browser,
    '01-title',
    'Weapons of Mass Application',
    'An agent that runs your job search end to end: finds postings, decides, applies with a tailored resume, handles recruiter mail, and books interviews only after you confirm a time.',
    8,
    'Demo tenant · fictional employers · real model, real code',
  );

  if (want('02-profile')) {
    const page = await newScene(browser);
    await page.goto(`${BASE}/profile/review`, { waitUntil: 'load' });
    await page.getByRole('heading', { name: 'Profile review' }).waitFor();
    await page.waitForTimeout(3500);
    await slowScroll(page, 900, 14, 160);
    await page.waitForTimeout(1200);
    await slowScroll(page, 1400, 18, 150);
    await page.waitForTimeout(1500);
    await page
      .getByRole('heading', { name: 'Standard answers' })
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await page.waitForTimeout(3000);
    await page.getByRole('link', { name: 'Connections' }).click();
    await page.getByRole('heading', { name: 'Connections' }).waitFor();
    await page.waitForTimeout(4500);
    await finish(page, '02-profile');
  }

  await card(
    browser,
    '03-card',
    'The daily run',
    'Twelve postings, judged live. Approve, decline, apply.',
    3,
  );

  if (want('04-run')) {
    const page = await newScene(browser);
    await page.goto(`${BASE}/runs`, { waitUntil: 'load' });
    await page.getByRole('heading', { name: 'Runs' }).waitFor();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Run today' }).click();
    // The page still lists yesterday's run until the new one is picked up: wait for today's run
    // to start, then to finish (about ten seconds of judging; the first six stay in the footage),
    // then for the view's poll to render its candidates.
    await page.getByRole('heading', { name: 'Running' }).waitFor({ timeout: 60_000 });
    const todayDone = async () => {
      const r = await api<Current>(page, '/api/runs/current');
      return r.run !== null && r.run.status !== 'running' && r.candidates.length >= 12;
    };
    await waitInCut(page, '04-run', todayDone, { every: 2000, keep: 6, max: 180_000 });
    await page
      .getByRole('list', { name: 'Candidates' })
      .locator('li')
      .nth(11)
      .waitFor({ timeout: 30_000 });
    await page.waitForTimeout(2500);
    await slowScroll(page, 1500, 20, 170);
    await page.waitForTimeout(2500);
    await finish(page, '04-run');
  }

  if (want('05-board')) {
    const page = await newScene(browser);
    await page.goto(`${BASE}/board`, { waitUntil: 'load' });
    await page.getByRole('heading', { name: 'Board' }).waitFor();
    await page.waitForTimeout(1500);
    // The submissions take about two minutes; the board does not poll, so reload inside the cut.
    // Pending cards (a form question the profile cannot answer) sit in Applied with a badge.
    const settled = async () => {
      const applied = (await api<Applications>(page, '/api/applications?status=applied'))
        .applications;
      // New applications start in pending with no reason; a parked one has a pending_reason.
      const parked = (
        await api<Applications>(page, '/api/applications?status=pending')
      ).applications.filter((a) => a.pending_reason !== null);
      return applied.length + parked.length;
    };
    const boardReady = () => page.getByRole('region', { name: 'Applied' }).waitFor();
    await waitInCut(page, '05-board', async () => (await settled()) >= 10, {
      every: 6000,
      tick: reloadAnd(page, boardReady),
      after: reloadAnd(page, boardReady),
    });
    await page.waitForTimeout(4000);
    const applied = (await api<Applications>(page, '/api/applications?status=applied'))
      .applications;
    const pending = (
      await api<Applications>(page, '/api/applications?status=pending')
    ).applications.filter((a) => a.pending_reason !== null);
    const captcha = applied.find((a) => a.job.url.includes('captcha'));
    const first = applied.find((a) => a !== captcha) ?? applied[0]!;
    await openCard(page, 'Applied', first.job.title);
    await scrollDrawerTo(page, 'Why this job', 3000);
    await scrollDrawerTo(page, 'Resume', 3500);
    await scrollDrawerTo(page, 'Answers', 3500);
    await scrollDrawerTo(page, 'Activity', 3500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    if (captcha) {
      await openCard(page, 'Applied', captcha.job.title);
      await scrollDrawerTo(page, 'Activity', 4500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1200);
    }
    if (pending[0]) {
      await openCard(page, 'Applied', pending[0].job.title);
      await scrollDrawerTo(page, 'Activity', 4500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
    }
    await finish(page, '05-board');
  }

  await card(
    browser,
    '06-card',
    'The recruiter writes back',
    'The agent reads the mail and asks you to pick a time. It never picks for you.',
    3,
  );

  if (want('07-inbox')) {
    const page = await newScene(browser);
    await page.goto(`${BASE}/demo/inbox`, { waitUntil: 'load' });
    await page.getByRole('heading', { name: 'Inbox' }).waitFor();
    await page.waitForTimeout(1500);
    const mailbox = async () => (await api<Mailbox>(page, '/api/admin/demo-mailbox')).messages;
    const offers = async () =>
      (await mailbox()).filter((m) => m.subject.startsWith('Pick an interview time'));
    // Until the recruiter answers the page says "No mail yet."; wait for the load to settle either way.
    const inboxReady = async () => {
      await page.getByRole('heading', { name: 'Inbox' }).waitFor();
      await page
        .getByText('Loading…')
        .waitFor({ state: 'detached', timeout: 15_000 })
        .catch(() => undefined);
    };
    await waitInCut(page, '07-inbox', async () => (await offers()).length >= 1, {
      every: 8000,
      tick: reloadAnd(page, inboxReady),
      after: reloadAnd(page, inboxReady),
    });
    await page.waitForTimeout(2000);
    // The oldest offer and the recruiter message it answers; the inbox lists newest first.
    const all = await mailbox();
    const offer = [...all].reverse().find((m) => m.subject.startsWith('Pick an interview time'))!;
    const role = offer.subject.replace('Pick an interview time: ', '');
    const proposal = page.getByRole('article', { name: `Interview for ${role}` }).first();
    await proposal.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await page.waitForTimeout(5000);
    const offerEl = page.getByRole('article', { name: offer.subject }).first();
    await offerEl.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await page.waitForTimeout(5000);
    const links = [...offer.body_text.matchAll(/https?:\/\/\S+\/confirm\/[A-Za-z0-9_-]+/g)].map(
      (m) => m[0],
    );
    const link = links[1] ?? links[0];
    if (!link) throw new Error('no confirm link in the offer');
    const token = link.split('/confirm/')[1]!;
    await page.goto(`${BASE}/confirm/${token}`, { waitUntil: 'load' });
    await page.waitForTimeout(3500);
    await page.getByRole('button', { name: 'Confirm this time' }).click();
    await page.waitForLoadState('load');
    await page.waitForTimeout(4000);
    writeFileSync(join(OUT, 'confirmed-role.txt'), role);
    await finish(page, '07-inbox');
  }

  if (want('08-interview')) {
    const page = await newScene(browser);
    const role = existsSync(join(OUT, 'confirmed-role.txt'))
      ? readFileSync(join(OUT, 'confirmed-role.txt'), 'utf8')
      : '';
    const title = role.split(' at ')[0] ?? '';
    await page.goto(`${BASE}/board`, { waitUntil: 'load' });
    await page.getByRole('heading', { name: 'Board' }).waitFor();
    await page.waitForTimeout(1500);
    // Booking is seconds; the prep plan follows within about a minute. Both waits are cut.
    const booked = async (): Promise<boolean> => {
      const apps = (await api<Applications>(page, '/api/applications?status=interviewing'))
        .applications;
      const app = apps.find((a) => !title || a.job.title === title);
      if (!app) return false;
      const { interviews } = await api<Interviews>(
        page,
        `/api/interviews/for-application/${app.id}`,
      );
      const ack = (await api<Mailbox>(page, '/api/admin/demo-mailbox')).messages.some(
        (m) =>
          m.direction === 'received' &&
          /confirmed|see you|look forward/i.test(m.body_text) &&
          m.subject.includes(title),
      );
      return interviews.some((i) => i.prep_plan_status === 'ready') && ack;
    };
    const interviewingReady = () => page.getByRole('region', { name: 'Interviewing' }).waitFor();
    await waitInCut(page, '08-interview', booked, {
      every: 6000,
      max: 300_000,
      tick: reloadAnd(page, interviewingReady),
      after: reloadAnd(page, interviewingReady),
    }).catch((e) => console.warn(String(e)));
    await page.waitForTimeout(3500);
    await openCard(page, 'Interviewing', title);
    await scrollDrawerTo(page, 'Interview times', 3500);
    await scrollDrawerTo(page, 'Email', 5000);
    await scrollDrawerTo(page, 'Interview prep and feedback', 2500);
    const open = drawer(page).getByRole('link', { name: 'Open the prep plan' });
    if (await open.count()) {
      await open.click();
      await page.getByRole('heading', { name: 'Interview prep plan' }).waitFor();
      await page.waitForTimeout(3500);
      await slowScroll(page, 1200, 16, 170);
      await page.waitForTimeout(3000);
    }
    await finish(page, '08-interview');
  }

  await card(
    browser,
    '09-end',
    'Weapons of Mass Application',
    'Built in a day with Claude. 1,296 tests, a simulated-employer regression suite, and eight real applications submitted on 2026-11-07.',
    6,
    'github.com/hdxsfbr/weapons-of-mass-application',
  );

  await browser.close();
  saveCuts();
  console.log('cuts', JSON.stringify(cuts));
  console.log('recorded to', OUT);
}

await main();
