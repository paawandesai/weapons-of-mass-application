import {
  activity,
  demoFormsOrigin,
  getDemoMessage,
  getUserById,
  insertDemoMessage,
  insertPendingJob,
  listApplications,
  listCompaniesByIds,
  listDemoThread,
  listJobsByIds,
  listOutgoingMessagesForUser,
  type DemoMailboxMessageRow,
  type TenantHandle,
} from '@wma/db';
import { formatSlot } from '../scheduling/slots';
import {
  afterBooking,
  confirmationMessage,
  firstMessage,
  gauntletMode,
  scenarioFor,
  type GauntletScenario,
} from './gauntlet';
import { isDemoTenant } from './ports';

/**
 * The simulated employer side of the demo (design rule 12). For a demo tenant and seeded jobs
 * only, it writes the recruiter's mail into the tenant's `demo_mailbox_messages`, where the real
 * inbox sync reads it:
 *
 *  - a three-slot proposal once an application on a seeded job is `applied`;
 *  - an acknowledgement in the same thread when the user's `recruiter_reply` names one of the
 *    proposed slots, or an "unavailable" reply that repeats the three slots when it names another.
 *
 * Every message carries `X-WMA-Simulated: 1`. Delivery is idempotent: each message has a
 * deterministic id derived from the application (proposal) or the outgoing message (reply), so a
 * repeated pass writes nothing twice.
 */

export const SIMULATED_HEADER = 'X-WMA-Simulated';
export const SLOTS_HEADER = 'X-WMA-Simulated-Slots';
export const KIND_HEADER = 'X-WMA-Simulated-Kind';
export const DEFAULT_RECRUITER_DELAY_S = 60;

/** `SIMULATED_RECRUITER_DELAY_S` (seconds) as milliseconds; 60 s when unset or invalid. */
export function recruiterDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SIMULATED_RECRUITER_DELAY_S;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_RECRUITER_DELAY_S) * 1000;
}

export interface RecruiterClock {
  now(): Date;
}

export interface RecruiterOptions {
  /** Wait after `applied` (and after the user's reply) before answering. 0 in tests. */
  delayMs: number;
  clock?: RecruiterClock;
  /** Ignore the delay (the on-demand sync). */
  immediate?: boolean;
  /**
   * Gauntlet mode: `golden`, one scenario, or null; default `GAUNTLET_SCENARIO`. Null runs every
   * Gauntlet employer like any seeded job.
   */
  scenario?: GauntletScenario | 'golden' | null;
  /** Called once per message written, e.g. to queue a mail sync for the user. */
  onDelivered?: (info: Delivered) => Promise<void> | void;
}

export interface Delivered {
  /** `confirmation` and `scenario` are Gauntlet Jobs mail without proposed times. */
  kind: 'proposal' | 'acknowledgement' | 'unavailable' | 'confirmation' | 'scenario';
  applicationId: string;
  threadId: string;
  gmailMessageId: string;
}

export interface RecruiterResult {
  skipped: 'not_demo' | null;
  delivered: Delivered[];
}

const FIRST = [
  'Priya',
  'Marcus',
  'Elena',
  'Tomas',
  'Aisha',
  'Daniel',
  'Mei',
  'Rafael',
  'Hannah',
  'Omar',
  'Sofia',
  'Caleb',
];
const LAST = [
  'Natarajan',
  'Whitfield',
  'Okafor',
  'Lindqvist',
  'Moreau',
  'Castellano',
  'Brandt',
  'Iyer',
  'Rosales',
  'Hartman',
  'Nakamura',
  'Quist',
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export interface RecruiterIdentity {
  name: string;
  first: string;
  last: string;
  /** `<first>.<last>@<company-slug>.example` */
  address: string;
}

/** The same company always gets the same recruiter. */
export function recruiterIdentity(
  companyName: string,
  companySlug?: string | null,
): RecruiterIdentity {
  const slug = slugify(companySlug || companyName) || 'company';
  const h = hash(slug);
  const first = FIRST[h % FIRST.length]!;
  const last = LAST[Math.floor(h / FIRST.length) % LAST.length]!;
  return {
    name: `${first} ${last}`,
    first,
    last,
    address: `${first}.${last}@${slug}.example`.toLowerCase(),
  };
}

export interface ProposedTime {
  start: Date;
  end: Date;
}

/** Local wall-clock time in `zone` as an instant. */
function zonedInstant(y: number, mo: number, d: number, hour: number, zone: string): Date {
  const offsetMs = (at: Date) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      })
        .formatToParts(at)
        .map((x) => [x.type, Number(x.value)]),
    ) as Record<string, number>;
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - at.getTime();
  };
  const guess = Date.UTC(y, mo - 1, d, hour, 0, 0);
  const first = guess - offsetMs(new Date(guess));
  return new Date(guess - offsetMs(new Date(first)));
}

const SLOT_HOURS = [10, 14, 11];
const SLOT_MINUTES = 45;

/** Three slots on the next three weekdays at least two days out (10:00, 14:00, 11:00 local). */
export function proposeSlots(now: Date, zone: string): ProposedTime[] {
  const out: ProposedTime[] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  for (let i = 2; out.length < 3 && i < 20; i++) {
    const probe = new Date(now.getTime() + i * dayMs);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
    }).formatToParts(probe);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    if (get('weekday') === 'Sat' || get('weekday') === 'Sun') continue;
    const start = zonedInstant(
      Number(get('year')),
      Number(get('month')),
      Number(get('day')),
      SLOT_HOURS[out.length]!,
      zone,
    );
    out.push({ start, end: new Date(start.getTime() + SLOT_MINUTES * 60_000) });
  }
  return out;
}

const bullets = (slots: ProposedTime[], zone: string) =>
  slots.map((s) => `- ${formatSlot(s, zone)}`).join('\n');

export interface MessageInput {
  recruiter: RecruiterIdentity;
  companyName: string;
  jobTitle: string;
  firstName: string;
  slots: ProposedTime[];
  zone: string;
}

export function proposalBody(i: MessageInput): { subject: string; text: string } {
  return {
    subject: `Interview for ${i.jobTitle} at ${i.companyName}`,
    text: [
      `Hi ${i.firstName},`,
      '',
      `Thank you for applying for the ${i.jobTitle} role at ${i.companyName}. We would like to speak with you. Could you do any of these times?`,
      '',
      bullets(i.slots, i.zone),
      '',
      `Each call is ${SLOT_MINUTES} minutes. Reply with the time that suits you best.`,
      '',
      i.recruiter.name,
      `Talent Acquisition, ${i.companyName}`,
    ].join('\n'),
  };
}

export function acknowledgementBody(i: MessageInput, accepted: ProposedTime): string {
  return [
    `Hi ${i.firstName},`,
    '',
    `Confirmed: ${formatSlot(accepted, i.zone)}. I have you down for the ${i.jobTitle} conversation and will be on the call.`,
    '',
    'Looking forward to speaking with you.',
    '',
    i.recruiter.name,
    `Talent Acquisition, ${i.companyName}`,
  ].join('\n');
}

export function unavailableBody(i: MessageInput): string {
  return [
    `Hi ${i.firstName},`,
    '',
    `Thank you for the reply. Unfortunately that time is not available. These are the times I can offer for the ${i.jobTitle} conversation:`,
    '',
    bullets(i.slots, i.zone),
    '',
    'Please let me know which one works.',
    '',
    i.recruiter.name,
    `Talent Acquisition, ${i.companyName}`,
  ].join('\n');
}

const headerOf = (m: DemoMailboxMessageRow, name: string): string | null => {
  const h = m.headers as Record<string, unknown>;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key && typeof h[key] === 'string' ? (h[key] as string) : null;
};

const isSimulated = (m: DemoMailboxMessageRow) => headerOf(m, SIMULATED_HEADER) === '1';

function slotsOf(m: DemoMailboxMessageRow): ProposedTime[] {
  try {
    const raw = JSON.parse(headerOf(m, SLOTS_HEADER) ?? '[]') as Array<{
      start: string;
      end: string;
    }>;
    return raw.map((s) => ({ start: new Date(s.start), end: new Date(s.end) }));
  } catch {
    return [];
  }
}

/** The proposed slot a reply names (by the same text the scheduling reply uses), or null. */
export function acceptedSlot(
  text: string,
  slots: ProposedTime[],
  zone: string,
): ProposedTime | null {
  return (
    slots.find((s) => {
      const when = formatSlot(s, zone);
      return text.includes(when) || text.includes(when.split(' to ')[0]!);
    }) ?? null
  );
}

const proposalId = (applicationId: string) => `sim-proposal-${applicationId}`;
const replyId = (outgoingId: string) => `sim-reply-${outgoingId}`;

/**
 * One pass for one user. Does nothing unless the tenant carries the demo flag. Safe to run as
 * often as wanted; see the module comment for what it writes.
 */
export async function runSimulatedRecruiter(
  handle: TenantHandle,
  userId: string,
  options: RecruiterOptions,
): Promise<RecruiterResult> {
  if (!(await isDemoTenant(handle))) return { skipped: 'not_demo', delivered: [] };
  const clock = options.clock ?? { now: () => new Date() };
  const now = clock.now();
  const wait = options.immediate ? 0 : options.delayMs;
  const due = (since: Date | null) => !since || since.getTime() + wait <= now.getTime();
  const user = await getUserById(handle, userId);
  const zone = user.timezone;
  const firstName = (user.displayName ?? 'there').split(' ')[0]!;
  const delivered: Delivered[] = [];
  const mode = options.scenario === undefined ? gauntletMode() : options.scenario;

  const deliver = async (
    d: Delivered,
    input: Parameters<typeof insertDemoMessage>[1],
    detail: object,
  ) => {
    // The message and the request to sync it commit together; the dispatcher sends the request.
    await handle.transaction(async (h) => {
      await insertDemoMessage(h, input);
      await insertPendingJob(h, {
        userId,
        kind: 'mail-sync',
        payload: { tenantId: handle.tenantId, userId },
        dedupeKey: `mail-sync:${d.gmailMessageId}`,
      });
    });
    await activity.logActivity(handle, {
      userId,
      applicationId: d.applicationId,
      actor: 'agent',
      action: 'simulated_message_delivered',
      detail: { simulated: true, kind: d.kind, thread: d.threadId, ...detail },
    });
    delivered.push(d);
    await options.onDelivered?.(d);
  };

  // 1. Proposals for applied applications on seeded jobs.
  const applied = await listApplications(handle, userId, { status: ['applied'] });
  const jobs = new Map(
    (
      await listJobsByIds(
        handle,
        applied.map((a) => a.jobId),
      )
    ).map((j) => [j.id, j]),
  );
  const companyIds = [
    ...new Set([...jobs.values()].flatMap((j) => (j.seeded && j.companyId ? [j.companyId] : []))),
  ];
  const companies = new Map((await listCompaniesByIds(handle, companyIds)).map((c) => [c.id, c]));
  const slotsHeader = (slots: ProposedTime[]) =>
    JSON.stringify(slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })));
  const mail = (
    m: { threadId: string; gmailMessageId: string; subject: string; text: string },
    from: { address: string; name: string },
    headers: Record<string, string>,
  ): Parameters<typeof insertDemoMessage>[1] => ({
    userId,
    threadId: m.threadId,
    gmailMessageId: m.gmailMessageId,
    fromAddress: from.address,
    fromName: from.name,
    toAddress: user.email,
    subject: m.subject,
    bodyText: m.text,
    headers: {
      'Message-ID': `<${m.gmailMessageId}@${from.address.split('@')[1]}>`,
      [SIMULATED_HEADER]: '1',
      ...headers,
    },
    internalDate: now,
  });
  const scenarioOf = (c: { boardSlug: string | null }) => scenarioFor(mode, c.boardSlug);

  for (const app of applied) {
    const job = jobs.get(app.jobId);
    const company = job?.companyId ? companies.get(job.companyId) : undefined;
    if (!job || !job.seeded || !company) continue;
    const recruiter = recruiterIdentity(company.name, company.boardSlug);
    const input: MessageInput = {
      recruiter,
      companyName: company.name,
      jobTitle: job.title,
      firstName,
      slots: proposeSlots(now, zone),
      zone,
    };
    const threadId = `sim-thread-${app.id}`;
    // Gauntlet Jobs confirms at once, like an applicant-tracking system, in a thread of its own.
    const confirmId = `sim-confirm-${app.id}`;
    const scenario = scenarioOf(company);
    if (scenario && !(await getDemoMessage(handle, confirmId))) {
      const careers = {
        address: `no-reply@${recruiter.address.split('@')[1]}`,
        name: `${company.name} Careers`,
      };
      await deliver(
        {
          kind: 'confirmation',
          applicationId: app.id,
          threadId: `sim-confirm-thread-${app.id}`,
          gmailMessageId: confirmId,
        },
        mail(
          {
            threadId: `sim-confirm-thread-${app.id}`,
            gmailMessageId: confirmId,
            ...confirmationMessage(input),
          },
          careers,
          { [KIND_HEADER]: 'confirmation' },
        ),
        { from: careers.address },
      );
    }
    if (!due(app.appliedAt ?? app.lastActivityAt)) continue;
    const gmailMessageId = proposalId(app.id);
    if (await getDemoMessage(handle, gmailMessageId)) continue;
    const proposal = proposalBody(input);
    const msg = scenario
      ? firstMessage(
          scenario,
          input,
          proposal,
          `${demoFormsOrigin()}/forms/greenhouse/gauntlet-book.html`,
        )
      : { ...proposal, proposesSlots: true };
    if (!msg) continue; // ghost
    const kind = msg.proposesSlots ? 'proposal' : 'scenario';
    await deliver(
      { kind, applicationId: app.id, threadId, gmailMessageId },
      mail({ threadId, gmailMessageId, ...msg }, recruiter, {
        [KIND_HEADER]: kind,
        ...(msg.proposesSlots ? { [SLOTS_HEADER]: slotsHeader(input.slots) } : {}),
      }),
      { from: recruiter.address },
    );
  }

  // 2. Answers to the user's recruiter replies on simulated threads.
  const replies = (await listOutgoingMessagesForUser(handle, userId)).filter(
    (o) =>
      o.kind === 'recruiter_reply' &&
      o.state === 'sent' &&
      !o.blocked &&
      o.gmailMessageId &&
      o.applicationId,
  );
  for (const out of replies) {
    if (!due(out.sentAt ?? out.createdAt)) continue;
    const gmailMessageId = replyId(out.id);
    if (await getDemoMessage(handle, gmailMessageId)) continue;
    const sent = await getDemoMessage(handle, out.gmailMessageId!);
    if (!sent) continue;
    const thread = await listDemoThread(handle, sent.threadId);
    // The latest proposal: a Gauntlet reschedule or next round proposes new times in the thread.
    const proposal = [...thread]
      .reverse()
      .find((m) => isSimulated(m) && headerOf(m, KIND_HEADER) === 'proposal');
    if (!proposal) continue;
    const slots = slotsOf(proposal);
    const match = acceptedSlot(sent.bodyText, slots, zone);
    const jobTitle =
      /^(?:re:\s*)?interview for (.*) at .*$/i.exec(proposal.subject)?.[1] ?? 'the role';
    const companyName =
      /^(?:re:\s*)?interview for .* at (.*)$/i.exec(proposal.subject)?.[1] ?? 'the company';
    const recruiter: RecruiterIdentity = {
      name: proposal.fromName ?? 'Recruiter',
      first: (proposal.fromName ?? 'Recruiter').split(' ')[0]!,
      last: '',
      address: proposal.fromAddress,
    };
    const input: MessageInput = { recruiter, companyName, jobTitle, firstName, slots, zone };
    const kind = match ? 'acknowledgement' : 'unavailable';
    const text = match ? acknowledgementBody(input, match) : unavailableBody(input);
    await deliver(
      { kind, applicationId: out.applicationId!, threadId: sent.threadId, gmailMessageId },
      {
        userId,
        threadId: sent.threadId,
        gmailMessageId,
        fromAddress: recruiter.address,
        fromName: recruiter.name,
        toAddress: user.email,
        subject: /^re:/i.test(proposal.subject) ? proposal.subject : `Re: ${proposal.subject}`,
        bodyText: text,
        headers: {
          'Message-ID': `<${gmailMessageId}@${recruiter.address.split('@')[1]}>`,
          'In-Reply-To': headerOf(sent, 'Message-ID') ?? '',
          [SIMULATED_HEADER]: '1',
          [KIND_HEADER]: kind,
          [SLOTS_HEADER]: JSON.stringify(
            slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
          ),
        },
        internalDate: now,
      },
      { from: recruiter.address },
    );
  }

  // 3. Gauntlet follow-ups after each booked interview (a reschedule, the next round).
  if (mode) {
    const all = await listApplications(handle, userId);
    const allJobs = new Map(
      (
        await listJobsByIds(
          handle,
          all.map((a) => a.jobId),
        )
      ).map((j) => [j.id, j]),
    );
    const gauntletCompanies = new Map(
      (
        await listCompaniesByIds(handle, [
          ...new Set([...allJobs.values()].flatMap((j) => (j.companyId ? [j.companyId] : []))),
        ])
      )
        .filter((c) => scenarioOf(c))
        .map((c) => [c.id, c]),
    );
    for (const app of all) {
      const job = allJobs.get(app.jobId);
      const company = job?.companyId ? gauntletCompanies.get(job.companyId) : undefined;
      if (!job || !company) continue;
      const threadId = `sim-thread-${app.id}`;
      const acks = (await listDemoThread(handle, threadId)).filter(
        (m) => isSimulated(m) && headerOf(m, KIND_HEADER) === 'acknowledgement',
      );
      const last = acks.at(-1);
      if (!last || !due(last.internalDate)) continue;
      const gmailMessageId = `sim-step-${app.id}-${acks.length}`;
      if (await getDemoMessage(handle, gmailMessageId)) continue;
      const recruiter = recruiterIdentity(company.name, company.boardSlug);
      const slots = proposeSlots(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), zone);
      const input: MessageInput = {
        recruiter,
        companyName: company.name,
        jobTitle: job.title,
        firstName,
        slots,
        zone,
      };
      const msg = afterBooking(scenarioOf(company)!, acks.length, input, bullets(slots, zone));
      if (!msg) continue;
      await deliver(
        { kind: 'proposal', applicationId: app.id, threadId, gmailMessageId },
        mail({ threadId, gmailMessageId, ...msg }, recruiter, {
          'In-Reply-To': headerOf(last, 'Message-ID') ?? '',
          [KIND_HEADER]: 'proposal',
          [SLOTS_HEADER]: slotsHeader(slots),
        }),
        { from: recruiter.address },
      );
    }
  }
  return { skipped: null, delivered };
}
