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
  GAUNTLET_POSTINGS,
  GAUNTLET_SCENARIO_BY_SLUG,
  insertOutgoingMessage,
  listDemoThread,
  postingUrl,
  upsertCompany,
  upsertJob,
  type DemoMailboxMessageRow,
} from '@wma/db';
import { FORMS_ROOT, resolveFormPath } from '../../src/demo/forms-server';
import {
  gauntletMode,
  gauntletScenario,
  scenarioFor,
  type GauntletScenario,
} from '../../src/demo/gauntlet';
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
const companyIds = new Map<string, string>();
beforeAll(async () => {
  env = await setupDemoEnv();
  userId = env.summary.userId;
  for (const p of GAUNTLET_POSTINGS) {
    const c = await upsertCompany(env.handle, {
      name: p.company,
      ats: 'greenhouse', // as the seed sets it: the board slug is kept only with an ATS
      boardSlug: p.slug,
      createdBy: 'user',
    });
    companyIds.set(p.slug, c.id);
  }
});
afterAll(async () => {
  await env.owner.query(
    `delete from companies c where c.board_slug like 'gauntlet-%'
       and not exists (select 1 from jobs j where j.company_id = c.id)`,
  );
  await env.cleanup();
});

let n = 0;
/** A fresh seeded Gauntlet posting (default Gauntlet Jobs) with an application on it. */
async function gauntletApp(appliedAt = new Date(), slug = 'gauntlet-jobs') {
  const posting = GAUNTLET_POSTINGS.find((p) => p.slug === slug)!;
  const { job } = await upsertJob(env.handle, {
    companyId: companyIds.get(slug)!,
    title: posting.title,
    url: `${postingUrl(posting)}?t=${n++}`,
  });
  await env.owner.query('update jobs set seeded = true where id = $1', [job.id]);
  return appliedTo(env.handle, userId, job.id, appliedAt);
}

const run = (scenario: GauntletScenario | 'golden' | null, extra = {}) =>
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
  it('reads the mode from GAUNTLET_SCENARIO and rejects typos', () => {
    expect(gauntletMode({})).toBeNull();
    expect(gauntletMode({ GAUNTLET_SCENARIO: 'golden' })).toBe('golden');
    expect(gauntletScenario({ GAUNTLET_SCENARIO: 'golden' })).toBeNull();
    expect(gauntletScenario({ GAUNTLET_SCENARIO: 'offer' })).toBe('offer');
    expect(() => gauntletMode({ GAUNTLET_SCENARIO: 'ofer' })).toThrow(/must be golden or one of/);
  });

  it('gives each golden employer its own scenario, and the override to all of them', () => {
    expect(scenarioFor(null, 'gauntlet-jobs')).toBeNull();
    expect(scenarioFor('golden', 'gauntlet-jobs')).toBe('slots');
    expect(scenarioFor('golden', 'gauntlet-labs')).toBe('ghost');
    expect(scenarioFor('golden', 'acme')).toBeNull();
    expect(scenarioFor('offer', 'gauntlet-jobs')).toBe('offer');
    expect(scenarioFor('offer', 'gauntlet-labs')).toBe('offer');
    expect(scenarioFor('offer', 'acme')).toBeNull();
  });

  it('seeds the golden eight, one posting per scenario, or one posting by scenario name', () => {
    expect(demoPostings({})).toBe(DEMO_POSTINGS);
    const eight = demoPostings({ GAUNTLET_SCENARIO: 'golden' });
    expect(eight).toHaveLength(8);
    expect(new Set(eight.map((p) => p.slug)).size).toBe(8); // one company each
    expect(eight.map((p) => GAUNTLET_SCENARIO_BY_SLUG[p.slug]).sort()).toEqual(
      [
        'booking-link',
        'ghost',
        'injection',
        'pay-question',
        'reschedule',
        'rounds',
        'slots',
        'vague-time',
      ].sort(),
    );
    expect(demoPostings({ GAUNTLET_SCENARIO: 'slots' })).toEqual([GAUNTLET_POSTING]);
    expect(demoPostings({ GAUNTLET_SCENARIO: 'ghost' })[0]!.slug).toBe('gauntlet-labs');
    expect(demoPostings({ GAUNTLET_SCENARIO: 'offer' })).toEqual([GAUNTLET_POSTING]);
    expect(() => demoPostings({ GAUNTLET_SCENARIO: 'nope' })).toThrow(/unknown scenario/);
  });

  it('gives the persona every golden title', () => {
    expect(demoProfile({})).toBe(DEMO_PROFILE);
    const titles = demoProfile({ GAUNTLET_SCENARIO: 'golden' }).preferences.target_titles;
    for (const p of GAUNTLET_POSTINGS) expect(titles).toContain(p.title);
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

  it('serves every golden posting its own form', async () => {
    for (const p of GAUNTLET_POSTINGS) {
      const path = new URL(postingUrl(p)).pathname;
      expect(await resolveFormPath(FORMS_ROOT, path)).toMatch(
        new RegExp(`${path.split('/').pop()}\\.html$`),
      );
    }
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

  it('in golden mode, runs each employer under its own scenario in one pass', async () => {
    const jobs = await gauntletApp(new Date(), 'gauntlet-jobs');
    const labs = await gauntletApp(new Date(), 'gauntlet-labs');
    const platform = await gauntletApp(new Date(), 'gauntlet-platform');
    const r = await run('golden');
    const kinds = (id: string) =>
      r.delivered.filter((d) => d.applicationId === id).map((d) => d.kind);
    expect(kinds(jobs.id)).toEqual(['confirmation', 'proposal']);
    expect(kinds(labs.id)).toEqual(['confirmation']); // ghost
    expect(kinds(platform.id)).toEqual(['confirmation', 'proposal']);
    expect((await thread(platform.id))[0]!.bodyText).toMatch(/salary range/);
    expect((await thread(jobs.id))[0]!.bodyText).not.toMatch(/salary range/);
  });

  it('treats the posting like any seeded job when no scenario is set', async () => {
    const app = await gauntletApp();
    const r = await run(null);
    expect(r.delivered.filter((d) => d.applicationId === app.id).map((d) => d.kind)).toEqual([
      'proposal',
    ]);
  });
});
