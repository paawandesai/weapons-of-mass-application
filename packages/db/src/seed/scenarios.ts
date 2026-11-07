import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { insertDemoMessage } from '../repos/demo_mailbox';
import { insertPendingJob } from '../repos/pending_jobs';
import { insertRunCandidates } from '../repos/run_candidates';
import {
  applications,
  emailThreads,
  interviewSlots,
  interviews,
  jobs,
  runCandidates,
  runs,
} from '../schema';
import { DEMO_POSTINGS, postingJobId, postingUrl, type DemoPosting } from './catalog';

/**
 * Deterministic fixtures for the rehearsal and the e2e suite (`seed:demo --scenarios`):
 *
 *  - applied:      an application with the simulated recruiter's proposal already in the mailbox
 *  - interviewing: a booked interview (confirmed slot, calendar event) with a ready prep plan
 *  - offer:        an application in Offer with pay data
 *  - running:      today's run, still running, with a few candidates
 *
 * Each fixture is keyed by its posting (user + job), thread id or run marker, so a second pass
 * adds nothing. A pass restores the three applications to their fixture status, which is what lets
 * the rehearsal run twice after a test has moved a card.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ZONE = 'America/Los_Angeles';

export interface ScenarioPostings {
  applied: DemoPosting;
  interviewing: DemoPosting;
  offer: DemoPosting;
}

/** Which catalog posting backs each application fixture. */
export const SCENARIO_POSTINGS: ScenarioPostings = {
  applied: DEMO_POSTINGS[0]!,
  interviewing: DEMO_POSTINGS[2]!,
  offer: DEMO_POSTINGS[3]!,
};

export interface ScenarioSummary {
  applied: string;
  interviewing: string;
  offer: string;
  interview: string;
  runningRun: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const slug = (p: DemoPosting) => p.slug.replace(/[^a-z0-9]+/g, '-');

function recruiterOf(p: DemoPosting): { name: string; address: string } {
  const first = 'Priya';
  const last = 'Natarajan';
  return { name: `${first} ${last}`, address: `${first}.${last}@${slug(p)}.example`.toLowerCase() };
}

/** Next weekdays at least two days out, at 10:00, 14:00 and 11:00 Pacific time. */
function proposedSlots(now: Date): Array<{ start: Date; end: Date }> {
  const out: Array<{ start: Date; end: Date }> = [];
  const hours = [10, 14, 11];
  for (let i = 2; out.length < 3 && i < 20; i++) {
    const probe = new Date(now.getTime() + i * DAY_MS);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: ZONE,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
    }).formatToParts(probe);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    if (get('weekday') === 'Sat' || get('weekday') === 'Sun') continue;
    const wall = Date.UTC(
      Number(get('year')),
      Number(get('month')) - 1,
      Number(get('day')),
      hours[out.length]!,
    );
    const zoned = (at: number) => {
      const p = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
          timeZone: ZONE,
          hourCycle: 'h23',
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          second: 'numeric',
        })
          .formatToParts(new Date(at))
          .map((x) => [x.type, Number(x.value)]),
      ) as Record<string, number>;
      return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - at;
    };
    const first = wall - zoned(wall);
    const start = new Date(wall - zoned(first));
    out.push({ start, end: new Date(start.getTime() + 45 * 60_000) });
  }
  return out;
}

function describeSlot(s: { start: Date; end: Date }): string {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(s.start);
  const time = (d: Date, withZone = false) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: ZONE,
      hour: 'numeric',
      minute: '2-digit',
      ...(withZone ? { timeZoneName: 'short' } : {}),
    })
      .format(d)
      .replace(/\u202f/g, ' ');
  return `${day}, ${time(s.start)} to ${time(s.end, true)}`;
}

async function jobFor(handle: TenantHandle, p: DemoPosting, origin: string) {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.tenantId, handle.tenantId), eq(jobs.url, postingUrl(p, origin)))),
  );
  const job = rows[0];
  if (!job) throw new Error(`seeded job for ${p.company} is missing; seed the catalog first`);
  return job;
}

/** Creates the application when absent and puts it in `status` either way. */
async function ensureApplication(
  handle: TenantHandle,
  userId: string,
  jobId: string,
  status: 'applied' | 'interviewing' | 'offer',
  appliedAt: Date,
  extra: { negotiation?: unknown } = {},
): Promise<string> {
  const values = {
    status,
    closedReason: null,
    pendingReason: null,
    appliedAt,
    lastActivityAt: new Date(),
    ...(extra.negotiation !== undefined ? { negotiation: extra.negotiation } : {}),
  };
  const rows = await handle.run((tx) =>
    tx
      .insert(applications)
      .values({ tenantId: handle.tenantId, userId, jobId, ...values })
      .onConflictDoUpdate({
        target: [applications.userId, applications.jobId],
        set: values,
      })
      .returning({ id: applications.id }),
  );
  return rows[0]!.id;
}

export async function seedScenarios(
  handle: TenantHandle,
  user: { id: string; email: string },
  origin: string,
  now: Date = new Date(),
): Promise<ScenarioSummary> {
  const userId = user.id;

  // applied, with the recruiter's proposal delivered and a mail sync owed in the same commit
  const appliedPosting = SCENARIO_POSTINGS.applied;
  const appliedJob = await jobFor(handle, appliedPosting, origin);
  const appliedId = await ensureApplication(
    handle,
    userId,
    appliedJob.id,
    'applied',
    new Date(now.getTime() - HOUR_MS),
  );
  const recruiter = recruiterOf(appliedPosting);
  const slots = proposedSlots(now);
  const messageId = `sim-proposal-${appliedId}`;
  await handle.transaction(async (h) => {
    await insertDemoMessage(h, {
      userId,
      threadId: `sim-thread-${appliedId}`,
      gmailMessageId: messageId,
      fromAddress: recruiter.address,
      fromName: recruiter.name,
      toAddress: user.email,
      subject: `Interview for ${appliedPosting.title} at ${appliedPosting.company}`,
      bodyText: [
        `Hi ${'Jordan'},`,
        '',
        `Thank you for applying for the ${appliedPosting.title} role at ${appliedPosting.company}. We would like to speak with you. Could you do any of these times?`,
        '',
        ...slots.map((s) => `- ${describeSlot(s)}`),
        '',
        'Each call is 45 minutes. Reply with the time that suits you best.',
        '',
        recruiter.name,
        `Talent Acquisition, ${appliedPosting.company}`,
      ].join('\n'),
      headers: {
        'Message-ID': `<${messageId}@${slug(appliedPosting)}.example>`,
        'X-WMA-Simulated': '1',
        'X-WMA-Simulated-Kind': 'proposal',
        'X-WMA-Simulated-Slots': JSON.stringify(
          slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
        ),
      },
      internalDate: new Date(now.getTime() - 30 * 60_000),
    });
    await insertPendingJob(h, {
      userId,
      kind: 'mail-sync',
      payload: { tenantId: handle.tenantId, userId },
      dedupeKey: `mail-sync:${messageId}`,
    });
  });

  // interviewing, with a booked interview and a ready prep plan
  const interviewingPosting = SCENARIO_POSTINGS.interviewing;
  const interviewingJob = await jobFor(handle, interviewingPosting, origin);
  const interviewingId = await ensureApplication(
    handle,
    userId,
    interviewingJob.id,
    'interviewing',
    new Date(now.getTime() - 4 * DAY_MS),
  );
  const interviewId = await ensureBookedInterview(
    handle,
    userId,
    interviewingId,
    interviewingPosting,
    now,
  );

  // offer, with pay data
  const offerPosting = SCENARIO_POSTINGS.offer;
  const offerJob = await jobFor(handle, offerPosting, origin);
  const retrieved = new Date(now.getTime() - 2 * HOUR_MS).toISOString();
  const offerId = await ensureApplication(
    handle,
    userId,
    offerJob.id,
    'offer',
    new Date(now.getTime() - 10 * DAY_MS),
    {
      negotiation: {
        posted_min: offerPosting.payMin,
        posted_max: offerPosting.payMax,
        currency: 'USD',
        floor: 190000,
        comparables: [
          {
            source: 'levels.fyi',
            title: offerPosting.title,
            level: 'Senior',
            location: 'San Francisco Bay Area',
            currency: 'USD',
            p25: offerPosting.payMin - 20000,
            p50: Math.round((offerPosting.payMin + offerPosting.payMax) / 2),
            p75: offerPosting.payMax + 15000,
            sample_size: 84,
            retrieved_at: retrieved,
          },
        ],
        fetched_at: retrieved,
        error: null,
      },
    },
  );

  const runningRun = await seedRunningRun(handle, userId, origin, now);
  return {
    applied: appliedId,
    interviewing: interviewingId,
    offer: offerId,
    interview: interviewId,
    runningRun,
  };
}

async function ensureBookedInterview(
  handle: TenantHandle,
  userId: string,
  applicationId: string,
  p: DemoPosting,
  now: Date,
): Promise<string> {
  return handle.transaction(async (h) => {
    const recruiter = recruiterOf(p);
    const gmailThreadId = `sim-thread-${applicationId}`;
    const thread = (
      await h.run((tx) =>
        tx
          .insert(emailThreads)
          .values({
            tenantId: h.tenantId,
            userId,
            applicationId,
            gmailThreadId,
            kind: 'interview',
            subject: `Interview for ${p.title} at ${p.company}`,
            lastMessageAt: new Date(now.getTime() - 3 * DAY_MS),
          })
          .onConflictDoUpdate({
            target: [emailThreads.tenantId, emailThreads.gmailThreadId],
            set: { applicationId },
          })
          .returning({ id: emailThreads.id }),
      )
    )[0]!;
    const existing = await h.run((tx) =>
      tx
        .select({ id: interviews.id })
        .from(interviews)
        .where(and(eq(interviews.tenantId, h.tenantId), eq(interviews.threadId, thread.id))),
    );
    if (existing[0]) return existing[0].id;

    const starts = proposedSlots(now)[0]!;
    const row = (
      await h.run((tx) =>
        tx
          .insert(interviews)
          .values({
            tenantId: h.tenantId,
            userId,
            applicationId,
            threadId: thread.id,
            startsAt: starts.start,
            endsAt: starts.end,
            confirmedAt: new Date(now.getTime() - 2 * DAY_MS),
            confirmedGeneration: 1,
            bookedGeneration: 1,
            replySentAt: new Date(now.getTime() - 2 * DAY_MS),
            calendarEventClientId: `seeded-${applicationId}`,
            calendarEventId: `seeded-${applicationId}`,
            prepPlanStatus: 'ready',
            prepPlan: JSON.stringify({
              likely_questions: [
                {
                  question: 'Walk me through a system you designed that had to scale 10x.',
                  answer_outline:
                    'Name the bottleneck, the options you weighed, the migration plan and the result in numbers.',
                },
                {
                  question: 'How do you decide what to build versus buy for platform tooling?',
                  answer_outline:
                    'Cost of ownership, team size, time to value, and one example where you reversed the call.',
                },
                {
                  question: 'Tell me about a time you mentored an engineer through a hard project.',
                  answer_outline:
                    'Situation, what you changed in how you worked together, the outcome.',
                },
              ],
              topics: [
                'Event streaming and exactly-once handoff',
                'Postgres performance and partitioning',
                'Incident response and on-call practice',
              ],
              company_research: `${p.company}: ${p.description} The posting is for a ${p.title} based in ${p.location}.`,
              interviewer_background: `${recruiter.name} leads talent acquisition at ${p.company}.`,
            }),
          })
          .returning({ id: interviews.id }),
      )
    )[0]!;
    const slotId = (
      await h.run((tx) =>
        tx
          .insert(interviewSlots)
          .values({
            tenantId: h.tenantId,
            interviewId: row.id,
            startsAt: starts.start,
            endsAt: starts.end,
            tzHint: ZONE,
            tokenHash: sha(`scenario-slot-${applicationId}`),
            expiresAt: new Date(now.getTime() + 7 * DAY_MS),
            confirmedAt: new Date(now.getTime() - 2 * DAY_MS),
          })
          .returning({ id: interviewSlots.id }),
      )
    )[0]!;
    await h.run((tx) =>
      tx
        .update(interviews)
        .set({ confirmedSlotId: slotId.id })
        .where(and(eq(interviews.tenantId, h.tenantId), eq(interviews.id, row.id))),
    );
    return row.id;
  });
}

/** Today's run, still `running`, with the first few postings as candidates. */
async function seedRunningRun(
  handle: TenantHandle,
  userId: string,
  origin: string,
  now: Date,
): Promise<string> {
  const marker = sql`${runs.counts} @> '{"scenario": "running"}'::jsonb`;
  const date = now.toISOString().slice(0, 10);
  return handle.transaction(async (h) => {
    const found = await h.run((tx) =>
      tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.tenantId, h.tenantId), eq(runs.userId, userId), marker)),
    );
    let runId = found[0]?.id;
    if (!runId) {
      const inserted = await h.run((tx) =>
        tx
          .insert(runs)
          .values({
            tenantId: h.tenantId,
            userId,
            date,
            trigger: 'manual',
            status: 'running',
            step: 'judge',
            targetN: 8,
            startedAt: new Date(now.getTime() - 60_000),
            counts: { scenario: 'running', fetched: DEMO_POSTINGS.length, judged: 4 },
          })
          .onConflictDoNothing()
          .returning({ id: runs.id }),
      );
      runId = inserted[0]?.id;
      // Today already has a run of its own: leave it alone.
      if (!runId)
        return (
          await h.run((tx) =>
            tx
              .select({ id: runs.id })
              .from(runs)
              .where(
                and(eq(runs.tenantId, h.tenantId), eq(runs.userId, userId), eq(runs.date, date)),
              ),
          )
        )[0]!.id;
    }
    const have = await h.run((tx) =>
      tx
        .select({ id: runCandidates.id })
        .from(runCandidates)
        .where(and(eq(runCandidates.tenantId, h.tenantId), eq(runCandidates.runId, runId!))),
    );
    if (have.length === 0) {
      await insertRunCandidates(
        h,
        runId,
        DEMO_POSTINGS.slice(0, 4).map((p, i) => ({
          title: p.title,
          companyName: p.company,
          url: postingUrl(p, origin),
          ats: p.vendor,
          atsJobId: postingJobId(p),
          judgment: {
            apply: true,
            rationale: `${p.title} at ${p.company} matches the target titles and the ${p.mode} preference.`,
            fit: 5 - i,
            pay_min: p.payMin,
            pay_max: p.payMax,
            currency: 'USD',
            location_mode: p.mode,
            seniority: /staff|principal/i.test(p.title) ? 'staff' : 'senior',
            application_deadline: null,
          },
          promptVersion: 'apply-decision@v1',
          model: 'seeded',
          rank: i + 1,
          selected: true,
          exclusionReason: null,
        })),
      );
    }
    return runId;
  });
}
