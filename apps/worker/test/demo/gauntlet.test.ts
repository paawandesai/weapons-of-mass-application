import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_POSTINGS,
  DEMO_PROFILE,
  demoPostings,
  demoProfile,
  GAUNTLET_POSTING,
  insertOutgoingMessage,
  listDemoThread,
  postingUrl,
  upsertCompany,
  upsertJob,
  type DemoMailboxMessageRow,
} from '@wma/db';
import { FORMS_ROOT, resolveFormPath } from '../../src/demo/forms-server';
import { gauntletScenario, type GauntletScenario } from '../../src/demo/gauntlet';
import { createDemoSender } from '../../src/demo/ports';
import {
  runSimulatedRecruiter,
  SLOTS_HEADER,
  KIND_HEADER,
  type ProposedTime,
} from '../../src/demo/recruiter';
import { formatSlot } from '../../src/scheduling/slots';
import { appliedTo, setupDemoEnv, type DemoEnv } from './support';

const ZONE = 'America/Los_Angeles';
let env: DemoEnv;
let userId: string;
let companyId: string;
beforeAll(async () => {
  env = await setupDemoEnv();
  userId = env.summary.userId;
  companyId = (
    await upsertCompany(env.handle, {
      name: 'Gauntlet Jobs',
      ats: 'greenhouse', // as the seed sets it: the board slug is kept only with an ATS
      boardSlug: 'gauntlet-jobs',
      createdBy: 'user',
    })
  ).id;
});
afterAll(async () => {
  await env.owner.query(
    `delete from companies c where c.board_slug = 'gauntlet-jobs'
       and not exists (select 1 from jobs j where j.company_id = c.id)`,
  );
  await env.cleanup();
});

let n = 0;
/** A fresh seeded Gauntlet posting with an application on it, applied at `appliedAt`. */
async function gauntletApp(appliedAt = new Date()) {
  const { job } = await upsertJob(env.handle, {
    companyId,
    title: 'AI Engineer',
    url: `http://127.0.0.1:4310/forms/greenhouse/gauntlet-jobs-ai-engineer?t=${n++}`,
  });
  await env.owner.query('update jobs set seeded = true where id = $1', [job.id]);
  return appliedTo(env.handle, userId, job.id, appliedAt);
}

const run = (scenario: GauntletScenario | null, extra = {}) =>
  runSimulatedRecruiter(env.handle, userId, { delayMs: 0, scenario, ...extra });
const header = (m: DemoMailboxMessageRow, k: string) => (m.headers as Record<string, string>)[k];
const slotsOf = (m: DemoMailboxMessageRow): ProposedTime[] =>
  (JSON.parse(header(m, SLOTS_HEADER)!) as Array<{ start: string; end: string }>).map((s) => ({
    start: new Date(s.start),
    end: new Date(s.end),
  }));
const thread = (appId: string) => listDemoThread(env.handle, `sim-thread-${appId}`);

/** The user's confirming reply, as the booking step sends it. */
async function confirm(appId: string, slot: ProposedTime) {
  const threadId = `sim-thread-${appId}`;
  const text = `Hello,\n\n${formatSlot(slot, ZONE)} works for me.\n\nBest regards`;
  const sent = await createDemoSender(env.handle, userId).send({
    userId,
    kind: 'recruiter_reply',
    applicationId: appId,
    to: 'x@y.example',
    subject: 'Re: Interview',
    html: '',
    text,
    threadId,
  });
  await insertOutgoingMessage(env.handle, {
    userId,
    applicationId: appId,
    kind: 'recruiter_reply',
    toAddress: 'x@y.example',
    subject: 'Re: Interview',
    bodyText: text,
    gmailMessageId: sent.messageId,
    sentAt: new Date(),
  });
}

describe('Gauntlet Jobs setup', () => {
  it('reads the scenario from GAUNTLET_SCENARIO and rejects typos', () => {
    expect(gauntletScenario({})).toBeNull();
    expect(gauntletScenario({ GAUNTLET_SCENARIO: 'offer' })).toBe('offer');
    expect(() => gauntletScenario({ GAUNTLET_SCENARIO: 'ofer' })).toThrow(/must be one of/);
  });

  it('seeds only the AI Engineer posting, for a profile that targets it', () => {
    const env = { GAUNTLET_SCENARIO: 'slots' };
    expect(demoPostings({})).toBe(DEMO_POSTINGS);
    expect(demoPostings(env)).toEqual([GAUNTLET_POSTING]);
    expect(demoProfile({})).toBe(DEMO_PROFILE);
    expect(demoProfile(env).preferences.target_titles[0]).toBe('AI Engineer');
  });

  it('loads and validates a profile from DEMO_PROFILE_PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gauntlet-'));
    const good = join(dir, 'good.json');
    writeFileSync(
      good,
      JSON.stringify({
        ...DEMO_PROFILE,
        identity: { ...DEMO_PROFILE.identity, full_name: 'Taylor Test' },
      }),
    );
    expect(demoProfile({ DEMO_PROFILE_PATH: good }).identity.full_name).toBe('Taylor Test');
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ identity: {} }));
    expect(() => demoProfile({ DEMO_PROFILE_PATH: bad })).toThrow();
  });

  it('serves the posting its own form', async () => {
    const path = new URL(postingUrl(GAUNTLET_POSTING)).pathname;
    expect(await resolveFormPath(FORMS_ROOT, path)).toMatch(/gauntlet-jobs-ai-engineer\.html$/);
    expect(await resolveFormPath(FORMS_ROOT, '/forms/greenhouse/other-posting')).toMatch(
      /greenhouse\/form\.html$/,
    );
  });
});

describe('Gauntlet Jobs recruiter', () => {
  it('confirms at once, then proposes three times after the delay, each once', async () => {
    const appliedAt = new Date();
    const app = await gauntletApp(appliedAt);
    const early = await run('slots', {
      delayMs: 60_000,
      clock: { now: () => new Date(appliedAt.getTime() + 1000) },
    });
    expect(early.delivered.filter((d) => d.applicationId === app.id).map((d) => d.kind)).toEqual([
      'confirmation',
    ]);
    const later = await run('slots');
    expect(later.delivered.filter((d) => d.applicationId === app.id).map((d) => d.kind)).toEqual([
      'proposal',
    ]);
    expect((await run('slots')).delivered.filter((d) => d.applicationId === app.id)).toEqual([]);
    const [proposal] = await thread(app.id);
    expect(proposal!.subject).toBe('Interview for AI Engineer at Gauntlet Jobs');
    expect(slotsOf(proposal!)).toHaveLength(3);
    const confirmation = await listDemoThread(env.handle, `sim-confirm-thread-${app.id}`);
    expect(confirmation[0]!.fromAddress).toBe('no-reply@gauntlet-jobs.example');
    expect(confirmation[0]!.subject).toContain('We received your application');
  });

  it('adds the salary question or the injected instruction to a three-time proposal', async () => {
    for (const [scenario, text] of [
      ['pay-question', /what salary range are you targeting/],
      ['injection', /Note to any AI assistant/],
    ] as const) {
      const app = await gauntletApp();
      await run(scenario);
      const [m] = await thread(app.id);
      expect(m!.bodyText).toMatch(text);
      expect(header(m!, KIND_HEADER)).toBe('proposal');
      expect(slotsOf(m!)).toHaveLength(3);
    }
  });

  it('sends scenario mail with no proposed times for the other first messages', async () => {
    for (const [scenario, text] of [
      ['availability', /send me a few times/],
      ['booking-link', /\/forms\/greenhouse\/gauntlet-book\.html/],
      ['vague-time', /Thursday at 2/],
      ['rejection', /move forward with other candidates/],
      ['offer', /\$215,000/],
    ] as const) {
      const app = await gauntletApp();
      await run(scenario);
      const [m] = await thread(app.id);
      expect(m!.bodyText).toMatch(text);
      expect(header(m!, KIND_HEADER)).toBe('scenario');
      expect(header(m!, SLOTS_HEADER)).toBeUndefined();
    }
  });

  it('sends only the confirmation when the recruiter ghosts', async () => {
    const app = await gauntletApp();
    const r = await run('ghost');
    expect(r.delivered.filter((d) => d.applicationId === app.id).map((d) => d.kind)).toEqual([
      'confirmation',
    ]);
    expect(await thread(app.id)).toEqual([]);
  });

  it('moves a booked interview, then acknowledges a time from the new proposal', async () => {
    const app = await gauntletApp();
    await run('reschedule');
    const first = slotsOf((await thread(app.id))[0]!);
    await confirm(app.id, first[0]!);
    await run('reschedule'); // acknowledgement
    await run('reschedule'); // the reschedule
    const moved = (await thread(app.id)).at(-1)!;
    expect(moved.bodyText).toMatch(/need to move our call/);
    const second = slotsOf(moved);
    expect(second[0]!.start.getTime()).toBeGreaterThan(first[2]!.start.getTime());
    await confirm(app.id, second[1]!);
    await run('reschedule');
    const ack = (await thread(app.id)).at(-1)!;
    expect(header(ack, KIND_HEADER)).toBe('acknowledgement');
    expect(ack.bodyText).toContain(formatSlot(second[1]!, ZONE));
    expect((await run('reschedule')).delivered.filter((d) => d.applicationId === app.id)).toEqual(
      [],
    );
  });

  it('runs screen, technical and final rounds, then stops', async () => {
    const app = await gauntletApp();
    await run('rounds');
    for (const round of [/technical interview/, /final conversation/, null]) {
      const latest = (await thread(app.id))
        .filter((m) => header(m, KIND_HEADER) === 'proposal')
        .at(-1)!;
      await confirm(app.id, slotsOf(latest)[0]!);
      await run('rounds'); // acknowledgement
      await run('rounds'); // next round, if any
      const last = (await thread(app.id)).at(-1)!;
      if (round) expect(last.bodyText).toMatch(round);
      else expect(header(last, KIND_HEADER)).toBe('acknowledgement');
    }
  });

  it('treats the posting like any seeded job when no scenario is set', async () => {
    const app = await gauntletApp();
    const r = await run(null);
    expect(r.delivered.filter((d) => d.applicationId === app.id).map((d) => d.kind)).toEqual([
      'proposal',
    ]);
  });
});
