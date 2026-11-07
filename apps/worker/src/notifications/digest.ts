import {
  activity,
  getApplication,
  getDigestCheckpoint,
  getUserById,
  hasActivityWithDetail,
  lastDigestSentAt,
  listApplicationLabels,
  listAwaitingConfirmation,
  listFlaggedThreads,
  listOutgoingMessagesForUser,
  listPendingHumanCaptchas,
  listUpcomingInterviews,
  setDigestCheckpoint,
  type ApplicationLabel,
  type DigestRosterEntry,
  type TenantHandle,
  type User,
} from '@wma/db';
import { sendEmailRecovering } from '@wma/shared';
import {
  DIGEST_JOB,
  DIGEST_LOOKBACK_FIRST_MS,
  DIGEST_RETRY_DELAY_S,
  DIGEST_RETRY_LIMIT,
  UPCOMING_WINDOW_MS,
} from './constants';
import type { NotificationDeps } from './deps';
import { cardUrl, origin } from './links';
import type { NotificationQueue } from './queue';
import { DeliveryUncertainError } from './reminders';
import { renderDigest, scrub, type DigestSection } from './templates';
import { formatLocal, formatLocalDate, localParts } from './time';

export interface DigestJobData {
  tenantId: string;
  userId: string;
  /** The user's local date (`YYYY-MM-DD`) the digest is for. */
  date: string;
}

/**
 * True at the user's digest hour, and also at the first valid hour after it when a DST gap
 * removed that hour from the day (hour 2 on a spring-forward day in America/Los_Angeles: 02:xx
 * never happens, so the digest goes out at 03:xx). The singleton key and the delivery receipt
 * keep a repeated hour (fall back) from producing a second digest.
 */
export function isDigestHour(
  now: Date,
  timeZone: string,
  digestHour: number,
  parts: { date: string; hour: number } = localParts(now, timeZone),
): boolean {
  if (parts.hour === digestHour) return true;
  if (parts.hour < digestHour) return false;
  // The previous hour was still before the digest hour (or on the previous day): this is the
  // first local hour at or past a digest hour that did not exist today.
  const prev = localParts(new Date(now.getTime() - 3_600_000), timeZone);
  return prev.date !== parts.date || prev.hour < digestHour;
}

/** Singleton key `(user_id, local_date)`. */
export const digestKey = (userId: string, date: string) => `${userId}:${date}`;

export interface DigestRoster {
  digestRoster(): Promise<DigestRosterEntry[]>;
}

/**
 * Hourly tick: one digest job per user whose local hour in their own zone is their digest hour.
 * The date is the user's local date, so the singleton key is per user per local day.
 */
export async function enqueueScheduledDigests(
  queue: NotificationQueue,
  roster: DigestRoster,
  now: Date,
): Promise<{ enqueued: number; duplicates: number; skipped: number }> {
  let enqueued = 0;
  let duplicates = 0;
  let skipped = 0;
  for (const u of await roster.digestRoster()) {
    let parts;
    try {
      parts = localParts(now, u.timezone);
    } catch {
      skipped++; // an unusable zone is never guessed at
      continue;
    }
    if (!isDigestHour(now, u.timezone, u.digestHour, parts)) continue;
    const data: DigestJobData = { tenantId: u.tenantId, userId: u.userId, date: parts.date };
    const id = await queue.send(DIGEST_JOB, data, {
      singletonKey: digestKey(u.userId, parts.date),
      retryLimit: DIGEST_RETRY_LIMIT,
      retryDelay: DIGEST_RETRY_DELAY_S,
    });
    if (id) enqueued++;
    else duplicates++;
  }
  return { enqueued, duplicates, skipped };
}

/** The user's activity in (`since`, `until`], oldest first. */
async function activitySince(
  handle: TenantHandle,
  userId: string,
  since: Date,
  until: Date,
): Promise<activity.ActivityEntry[]> {
  const out: activity.ActivityEntry[] = [];
  let before: activity.ActivityEntry['cursor'] | undefined;
  for (let page = 0; page < 50; page++) {
    const rows = await activity.listByUser(handle, userId, { limit: 200, before });
    for (const r of rows) {
      if (r.at.getTime() <= since.getTime()) return out.reverse();
      // Newer than the cutoff belongs to the next digest, whose checkpoint is this cutoff.
      if (r.at.getTime() > until.getTime()) continue;
      out.push(r);
    }
    if (rows.length < 200) break;
    before = rows[rows.length - 1]!.cursor;
  }
  return out.reverse();
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

// Rule 33: a parked question that asks for a take-home exercise.
const TAKE_HOME = /exercise|assignment|take[- ]home|case study|work sample/i;

interface Line {
  text: string;
  url?: string;
}

/**
 * Builds the sections of one user's digest; an empty array means a quiet day. Activity and
 * blocked sends are read in (`since`, `cutoff`]: the caller stores `cutoff` as the checkpoint, so
 * nothing committed after it is lost or listed twice. Pending items (unconfirmed slots, flagged
 * threads, CAPTCHAs, interviews) are state, not events, and appear in every digest while open.
 */
export async function collectDigestSections(
  handle: TenantHandle,
  user: User,
  since: Date,
  deps: Pick<NotificationDeps, 'now' | 'webOrigin'>,
  cutoff: Date = deps.now(),
): Promise<DigestSection[]> {
  const now = cutoff;
  const entries = await activitySince(handle, user.id, since, cutoff);
  const blocked = (
    await listOutgoingMessagesForUser(handle, user.id, { blockedOnly: true, since })
  ).filter((b) => b.createdAt.getTime() <= cutoff.getTime());
  const flaggedThreads = await listFlaggedThreads(handle, user.id);
  const awaiting = await listAwaitingConfirmation(handle, user.id);
  const captchas = await listPendingHumanCaptchas(handle, user.id, now);
  const horizon = now.getTime() + UPCOMING_WINDOW_MS;
  const upcoming = (await listUpcomingInterviews(handle, user.id, now)).filter(
    (i) => i.startsAt && i.startsAt.getTime() <= horizon,
  );

  const ids = [
    ...entries.map((e) => e.applicationId),
    ...flaggedThreads.map((t) => t.applicationId),
    ...blocked.map((b) => b.applicationId),
    ...awaiting.map((a) => a.applicationId),
    ...captchas.map((c) => c.applicationId),
    ...upcoming.map((i) => i.applicationId),
  ].filter((x): x is string => !!x);
  const labels = await listApplicationLabels(handle, ids);
  const nameOf = (id: string | null): string => {
    const l: ApplicationLabel | undefined = id ? labels.get(id) : undefined;
    return l ? scrub(`${l.companyName} - ${l.jobTitle}`) : 'an application';
  };
  const link = (id: string | null) => (id ? cardUrl(deps.webOrigin, id) : undefined);

  const applied: Line[] = [];
  const replies: Line[] = [];
  const followUps: Line[] = [];
  const booked: Line[] = [];
  const needsYou: Line[] = [];
  const flaggedSeen = new Set<string>();
  for (const e of entries) {
    const d = (e.detail ?? {}) as Record<string, unknown>;
    const who = nameOf(e.applicationId);
    const url = link(e.applicationId);
    switch (e.action) {
      case 'submitted':
        applied.push({ text: who, url });
        break;
      case 'thread_linked': {
        const kind = str(d.classification);
        replies.push({
          text: kind ? `${who}: reply received (${scrub(kind)})` : `${who}: reply received`,
          url,
        });
        break;
      }
      case 'status_changed': {
        const to = str(d.to) ?? str(d.status);
        if (to) replies.push({ text: `${who}: moved to ${scrub(to)}`, url });
        break;
      }
      case 'follow_up_sent':
        followUps.push({ text: who, url });
        break;
      case 'interview_booked':
        booked.push({ text: who, url });
        break;
      case 'mailbox_reauth_needed':
        needsYou.push({ text: 'Gmail access needs to be reconnected; mail sync is paused.' });
        break;
      case 'digest_flag': {
        // The inbox writes `kind` (and `link` for a scheduling link); scheduling writes `kind` too.
        const flag = str(d.kind) ?? str(d.flag);
        const where = str(d.thread_id) ?? e.applicationId ?? '';
        if (flag === 'compensation') {
          if (!flaggedSeen.has(`compensation:${where}`)) {
            flaggedSeen.add(`compensation:${where}`);
            needsYou.push({
              text: `${who}: the thread discusses pay terms. Nothing was sent; any reply is up to you.`,
              url,
            });
          }
        } else if (flag === 'booking_link') {
          if (!flaggedSeen.has(`booking_link:${where}`)) {
            flaggedSeen.add(`booking_link:${where}`);
            const href = str(d.link);
            needsYou.push({
              text: `${who}: they sent a scheduling link${href ? `: ${scrub(href)}` : ''}. Nothing was sent.`,
              url,
            });
          }
        } else if (flag === 'activity_on_closed') {
          needsYou.push({ text: `${who}: new interview activity on a closed application.`, url });
        } else if (flag === 'no_free_slot') {
          needsYou.push({
            text: `${who}: every time they proposed conflicts with your calendar.`,
            url,
          });
        } else if (flag) {
          needsYou.push({ text: `${who}: ${scrub(flag.replace(/_/g, ' '))}.`, url });
        }
        break;
      }
      default:
        break;
    }
  }

  // Threads still flagged from earlier days: listed every time until the application closes.
  for (const t of flaggedThreads) {
    const who = nameOf(t.applicationId);
    const url = link(t.applicationId);
    if (t.compensationFlag && !flaggedSeen.has(`compensation:${t.threadId}`)) {
      flaggedSeen.add(`compensation:${t.threadId}`);
      needsYou.push({
        text: `${who}: the thread discusses pay terms. Nothing was sent; any reply is up to you.`,
        url,
      });
    }
    if (t.bookingLink && !flaggedSeen.has(`booking_link:${t.threadId}`)) {
      flaggedSeen.add(`booking_link:${t.threadId}`);
      needsYou.push({
        text: `${who}: they sent a scheduling link: ${scrub(t.bookingLink)}. Nothing was sent.`,
        url,
      });
    }
  }

  // Rule 30: answers the agent inferred or guessed, for applications submitted in the window.
  const guessed: Line[] = [];
  const submittedIds = [
    ...new Set(
      entries
        .filter((e) => e.action === 'submitted' && e.applicationId)
        .map((e) => e.applicationId!),
    ),
  ];
  for (const appId of submittedIds) {
    const row = await getApplication(handle, appId);
    const raw = row?.formAnswers;
    if (!raw || typeof raw !== 'object') continue;
    for (const [question, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const a = v as { value?: unknown; source?: unknown };
      if (a.source !== 'inferred' && a.source !== 'guessed') continue;
      const shown = typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
      guessed.push({
        text: `${nameOf(appId)}: ${scrub(question)}: ${scrub(shown)}`,
        url: link(appId),
      });
    }
  }

  // Rule 33: companies whose applications parked on a take-home exercise in the window, once each,
  // with a link to remove the company from the list. Nothing is removed automatically.
  const takeHome: Line[] = [];
  const takeHomeSeen = new Set<string>();
  for (const e of entries) {
    if (e.action !== 'unanswerable-question') continue;
    const question = str(((e.detail ?? {}) as Record<string, unknown>).question);
    const company = e.applicationId ? labels.get(e.applicationId)?.companyName : undefined;
    if (!question || !TAKE_HOME.test(question) || !company) continue;
    if (takeHomeSeen.has(company)) continue;
    takeHomeSeen.add(company);
    takeHome.push({
      text: `${scrub(company)}: the application asks for a take-home exercise and is parked. Remove the company from your list if you do not want to do one.`,
      url: `${origin(deps.webOrigin)}/connections`,
    });
  }

  const pending: Line[] = awaiting.map((a) => ({
    text: `${nameOf(a.applicationId)}: times offered ${a.slots
      .map((sl) => formatLocal(sl.startsAt, user.timezone))
      .join('; ')}. Use the link in the confirmation email.`,
    url: link(a.applicationId),
  }));
  const captchaLines: Line[] = captchas.map((c) => ({
    text: `${nameOf(c.applicationId)}: a security check is waiting for you.`,
    url: link(c.applicationId),
  }));
  const blockedLines: Line[] = blocked.map((b) => ({
    text: `${nameOf(b.applicationId)}: a ${b.kind.replace(/_/g, ' ')} message was blocked by the content guard and not sent.`,
    url: link(b.applicationId),
  }));
  const upcomingLines: Line[] = upcoming.map((i) => ({
    text: `${nameOf(i.applicationId)}: ${formatLocal(i.startsAt!, user.timezone)}`,
    url: link(i.applicationId),
  }));

  const all: DigestSection[] = [
    { title: 'Applications submitted', lines: applied },
    { title: 'Answers we guessed today', lines: guessed },
    { title: 'Take-home exercises', lines: takeHome },
    { title: 'Replies from employers', lines: replies },
    { title: 'Follow-ups sent', lines: followUps },
    { title: 'Interviews booked', lines: booked },
    { title: 'Waiting for your confirmation', lines: pending },
    { title: 'Threads that need you', lines: needsYou },
    { title: 'Security checks waiting for you', lines: captchaLines },
    { title: 'Blocked messages', lines: blockedLines },
    { title: 'Interviews in the next 7 days', lines: upcomingLines },
  ];
  return all.filter((sec) => sec.lines.length > 0);
}

export type DigestOutcome =
  | { status: 'sent'; outgoingId: string; sections: number }
  | { status: 'blocked'; outgoingId: string }
  | { status: 'skipped'; reason: 'already_sent' };

/** Delivery key of one user's digest for a local date. */
export const digestDeliveryKey = (userId: string, date: string) => `digest:${userId}:${date}`;

/**
 * Sends one user's digest for a local date. At most one digest goes out per user per local date,
 * whatever the number of enqueues or hour changes: a `digest_sent` entry, or a sent receipt under
 * the key `digest:<user>:<date>` (a crash after Gmail accepted it but before the entry), makes any
 * later run a no-op that finishes the bookkeeping. Activity is collected in (checkpoint, cutoff]
 * and the checkpoint moves to the cutoff once the digest is out. A failed send is logged and
 * rethrown so the queue retries it.
 */
export async function runDigest(
  handle: TenantHandle,
  data: Pick<DigestJobData, 'userId'> & { date?: string },
  deps: NotificationDeps,
): Promise<DigestOutcome> {
  const user = await getUserById(handle, data.userId);
  const cutoff = deps.now();
  const date = data.date ?? localParts(cutoff, user.timezone).date;
  if (await hasActivityWithDetail(handle, user.id, 'digest_sent', 'local_date', date)) {
    return { status: 'skipped', reason: 'already_sent' };
  }
  const mailDeps = deps.mail(handle, user.id);
  const key = digestDeliveryKey(user.id, date);

  const receipt = await mailDeps.store.findByKey(key);
  if (receipt?.state === 'sent') {
    await activity.logActivity(handle, {
      userId: user.id,
      actor: 'agent',
      action: 'digest_sent',
      detail: { local_date: date, outgoing_id: receipt.id, recovered: true },
    });
    // The receipt was written right after the earlier run collected its sections.
    await setDigestCheckpoint(handle, user.id, receipt.createdAt);
    return { status: 'skipped', reason: 'already_sent' };
  }

  const since =
    (await getDigestCheckpoint(handle, user.id)) ??
    (await lastDigestSentAt(handle, user.id)) ??
    new Date(cutoff.getTime() - DIGEST_LOOKBACK_FIRST_MS);
  const sections = await collectDigestSections(handle, user, since, deps, cutoff);
  const mail = renderDigest({ dateLabel: formatLocalDate(cutoff, user.timezone), sections });

  let result;
  try {
    result = await sendEmailRecovering(mailDeps, {
      userId: user.id,
      kind: 'digest',
      to: user.email,
      deliveryKey: key,
      ...mail,
    });
  } catch (e) {
    await activity.logActivity(handle, {
      userId: user.id,
      actor: 'agent',
      action: 'digest_failed',
      detail: { local_date: date, error: e instanceof Error ? e.name : 'error' },
    });
    throw e;
  }
  if (result.status === 'uncertain') {
    await activity.logActivity(handle, {
      userId: user.id,
      actor: 'agent',
      action: 'digest_failed',
      detail: { local_date: date, error: 'delivery_uncertain', outgoing_id: result.outgoingId },
    });
    throw new DeliveryUncertainError(key);
  }
  if (result.status === 'blocked') {
    // Scrubbing makes this unreachable; if it happens it is a template bug and must be visible.
    await activity.logActivity(handle, {
      userId: user.id,
      actor: 'agent',
      action: 'digest_failed',
      detail: { local_date: date, error: 'blocked_by_guard', outgoing_id: result.outgoingId },
    });
    return { status: 'blocked', outgoingId: result.outgoingId };
  }
  await activity.logActivity(handle, {
    userId: user.id,
    actor: 'agent',
    action: 'digest_sent',
    detail: { local_date: date, outgoing_id: result.outgoingId, sections: sections.length },
  });
  await setDigestCheckpoint(handle, user.id, cutoff);
  return { status: 'sent', outgoingId: result.outgoingId, sections: sections.length };
}
