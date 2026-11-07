export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  /** When set, the part is inline and referenced from the HTML as `cid:<contentId>`. */
  contentId?: string;
}

export type OutgoingKind =
  | 'follow_up'
  | 'slot_confirmation'
  | 'recruiter_reply'
  | 'reminder'
  | 'digest'
  | 'captcha_request'
  | 'other';

export interface OutgoingEmail {
  userId: string;
  /** Stored with the message; defaults to 'other'. */
  kind?: OutgoingKind;
  /** The application the message concerns, when there is one. */
  applicationId?: string | null;
  /** Recipient address(es). */
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
  /** Gmail thread id when the message is a reply on an existing thread. */
  threadId?: string;
  /** RFC 5322 Message-ID of the message being answered (threading headers). */
  inReplyTo?: string;
  references?: string;
  /**
   * Deterministic identity of this logical send (kind + logical id). With a key, `sendEmail` writes a
   * pending receipt before calling the sender and never re-sends while that receipt exists.
   */
  deliveryKey?: string;
}

/** What a sender returns for an accepted message. */
export interface SentEmail {
  messageId: string;
}

/** Port to the user's mailbox. The Gmail implementation lives in @wma/google (createGmailSender). */
export interface GmailSender {
  send(email: OutgoingEmail): Promise<SentEmail>;
}

export type ContentGuardResult = { ok: true } | { ok: false; reason: string };

/** Inspects a message before it is sent; any guard that returns ok: false blocks the send. */
export interface ContentGuard {
  readonly name: string;
  check(email: OutgoingEmail): ContentGuardResult | Promise<ContentGuardResult>;
}

export class ContentGuardError extends Error {
  readonly code = 'content_guard' as const;
  constructor(
    readonly guard: string,
    readonly reason: string,
  ) {
    super(`email blocked by ${guard}: ${reason}`);
    this.name = 'ContentGuardError';
  }
}

/** Money text: a literal `$`, or the whole words salary, compensation, equity (design rule 15). */
const MONEY_SOURCE = String.raw`\$|\bsalary\b|\bcompensation\b|\bequity\b`;
const MONEY_RE = new RegExp(MONEY_SOURCE, 'i');
/** Scrubber: a dollar amount such as "$150k" or "$1,200.50" is replaced whole, then any stray match. */
const SCRUB_RE = new RegExp(
  String.raw`\$\s*\d[\d,]*(?:\.\d+)?\s*[kKmM]?(?![\w])|` + MONEY_SOURCE,
  'gi',
);

export const OMITTED = '[omitted]';

/** Blocks any outgoing message whose subject, text or html contains money text. */
export const moneyGuard: ContentGuard = {
  name: 'money',
  check(email) {
    for (const [part, value] of [
      ['subject', email.subject],
      ['text', email.text],
      ['html', email.html],
    ] as const) {
      const m = MONEY_RE.exec(value ?? '');
      if (m) return { ok: false, reason: `${part} contains "${m[0].toLowerCase()}"` };
    }
    return { ok: true };
  },
};

/**
 * Replaces money text in employer-quoted content with "[omitted]". User-facing templates run
 * employer text through this BEFORE the guard, so the output never trips `moneyGuard`.
 */
export function scrubEmployerText(s: string): string {
  return s.replace(SCRUB_RE, OMITTED);
}

/** Confirmation links carry a live capability; the stored copy never does. */
const CONFIRM_TOKEN_RE = /\/confirm\/[^\s"'<>)\]]+/g;
export const REDACTED_TOKEN_PATH = '/confirm/[redacted]';

/** Replaces `/confirm/<token>` paths with a placeholder (for persisted copies of outgoing bodies). */
export function redactConfirmTokens(s: string): string;
export function redactConfirmTokens(s: string | null): string | null;
export function redactConfirmTokens(s: string | null): string | null {
  return s === null ? null : s.replace(CONFIRM_TOKEN_RE, REDACTED_TOKEN_PATH);
}

/** What `sendEmail` records for every attempt, sent or blocked (design rule 16). */
export interface OutgoingRecord {
  kind: OutgoingKind;
  applicationId: string | null;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  gmailMessageId: string | null;
  blocked: boolean;
  blockedReason: string | null;
  sentAt: Date | null;
}

export type OutgoingState = 'pending' | 'sent' | 'blocked';

/** A stored delivery receipt found by its key. */
export interface OutgoingReceipt {
  id: string;
  state: OutgoingState;
  gmailMessageId: string | null;
  to: string;
  subject: string;
  createdAt: Date;
}

/**
 * Persistence port; the database implementation is `createOutgoingStore` in @wma/db. Implementations
 * persist a redacted copy of the bodies (see `redactConfirmTokens`).
 */
export interface OutgoingStore {
  /** A finished row: blocked, or sent without a delivery key. */
  record(row: OutgoingRecord): Promise<{ id: string }>;
  /** Writes the pending receipt for a keyed send; reports the existing receipt when the key is taken. */
  begin(
    row: OutgoingRecord & { deliveryKey: string },
  ): Promise<{ created: true; id: string } | { created: false; receipt: OutgoingReceipt }>;
  /** Pending -> sent. */
  finalize(id: string, sent: { gmailMessageId: string; sentAt: Date }): Promise<void>;
  findByKey(deliveryKey: string): Promise<OutgoingReceipt | null>;
  /** Removes a pending receipt whose send is known not to have happened. */
  abandon(id: string): Promise<void>;
}

/** Looks in the mailbox for a message that may have been accepted without a recorded receipt. */
export interface SentLookup {
  find(query: { to: string; subject: string; after: Date }): Promise<{ messageId: string } | null>;
}

export interface BlockedSend {
  email: OutgoingEmail;
  guard: string;
  reason: string;
  /** Id of the stored blocked row. */
  outgoingId: string;
}

export interface MailDeps {
  sender: GmailSender;
  /** Run in order before every send. Production uses `defaultGuards` ([moneyGuard]); tests may pass []. */
  guards: ContentGuard[];
  /** Every attempt is recorded here before `sendEmail` returns. */
  store: OutgoingStore;
  /** Called after a blocked row is stored (activity-log hook: action `send_blocked`). */
  onBlocked?: (blocked: BlockedSend) => void | Promise<void>;
  /** Resolves a pending receipt by checking the mailbox (see `reconcileOutgoing`). */
  lookup?: SentLookup;
}

export const defaultGuards: ContentGuard[] = [moneyGuard];

export type SendResult =
  | { status: 'sent'; messageId: string; outgoingId: string; alreadySent?: boolean }
  | { status: 'blocked'; guard: string; reason: string; outgoingId: string }
  /** A pending receipt for this key exists: an earlier attempt may have been accepted. Not re-sent. */
  | { status: 'uncertain'; outgoingId: string; deliveryKey: string };

const refused = (e: unknown): boolean => {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  return [err.code, err.status, err.response?.status].some((v) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && n >= 400 && n < 500 && n !== 408;
  });
};

const toAddress = (to: OutgoingEmail['to']) => (Array.isArray(to) ? to.join(', ') : to);

/**
 * The only function that sends mail: nothing else holds a sender. A blocked message is stored with
 * blocked = true, reported through `onBlocked`, and the sender is never called.
 *
 * With a `deliveryKey` the send is recoverable: a pending receipt is written BEFORE the sender is
 * called and finalized after. If the key already has a sent receipt the stored result is returned;
 * if it has a pending one the outcome of the earlier attempt is unknown, so the result is
 * `uncertain` and nothing is sent (resolve it with `reconcileOutgoing`). A sender error propagates and
 * leaves the pending receipt in place. Without a key the row is written after a successful send.
 */
export async function sendEmail(deps: MailDeps, email: OutgoingEmail): Promise<SendResult> {
  const base = {
    kind: email.kind ?? 'other',
    applicationId: email.applicationId ?? null,
    to: toAddress(email.to),
    subject: email.subject,
    bodyText: email.text,
    bodyHtml: email.html ?? null,
  };
  for (const guard of deps.guards) {
    const result = await guard.check(email);
    if (!result.ok) {
      const { id } = await deps.store.record({
        ...base,
        gmailMessageId: null,
        blocked: true,
        blockedReason: `${guard.name}: ${result.reason}`,
        sentAt: null,
      });
      await deps.onBlocked?.({ email, guard: guard.name, reason: result.reason, outgoingId: id });
      return { status: 'blocked', guard: guard.name, reason: result.reason, outgoingId: id };
    }
  }
  const key = email.deliveryKey;
  if (!key) {
    const sent = await deps.sender.send(email);
    const { id } = await deps.store.record({
      ...base,
      gmailMessageId: sent.messageId,
      blocked: false,
      blockedReason: null,
      sentAt: new Date(),
    });
    return { status: 'sent', messageId: sent.messageId, outgoingId: id };
  }
  const begun = await deps.store.begin({
    ...base,
    deliveryKey: key,
    gmailMessageId: null,
    blocked: false,
    blockedReason: null,
    sentAt: null,
  });
  if (!begun.created) {
    const r = begun.receipt;
    if (r.state === 'sent' && r.gmailMessageId)
      return { status: 'sent', messageId: r.gmailMessageId, outgoingId: r.id, alreadySent: true };
    return { status: 'uncertain', outgoingId: r.id, deliveryKey: key };
  }
  let sent: SentEmail;
  try {
    sent = await deps.sender.send(email);
  } catch (e) {
    // A 4xx from Gmail means the message was refused: nothing went out, so the receipt can go and
    // the caller may retry. Anything else (timeout, 5xx, dropped connection) may have been
    // accepted, so the pending receipt stays for `reconcileOutgoing`.
    if (refused(e)) await deps.store.abandon(begun.id);
    throw e;
  }
  try {
    await deps.store.finalize(begun.id, { gmailMessageId: sent.messageId, sentAt: new Date() });
  } catch {
    // The message is out; the pending receipt stays and `reconcileOutgoing` completes it later.
  }
  return { status: 'sent', messageId: sent.messageId, outgoingId: begun.id };
}

export type ReconcileResult =
  | { status: 'none' }
  | { status: 'sent'; messageId: string; outgoingId: string }
  /** The mailbox has no such message; the pending receipt was removed so the caller may send again. */
  | { status: 'not_sent' }
  /** Cannot tell (no lookup configured). */
  | { status: 'uncertain'; outgoingId: string };

/** Resolves a pending receipt by checking the mailbox for the message it may have produced. */
export async function reconcileOutgoing(
  deps: MailDeps,
  deliveryKey: string,
): Promise<ReconcileResult> {
  const receipt = await deps.store.findByKey(deliveryKey);
  if (!receipt) return { status: 'none' };
  if (receipt.state === 'sent' && receipt.gmailMessageId)
    return { status: 'sent', messageId: receipt.gmailMessageId, outgoingId: receipt.id };
  if (!deps.lookup) return { status: 'uncertain', outgoingId: receipt.id };
  const found = await deps.lookup.find({
    to: receipt.to,
    subject: receipt.subject,
    after: new Date(receipt.createdAt.getTime() - 60_000),
  });
  if (!found) {
    await deps.store.abandon(receipt.id);
    return { status: 'not_sent' };
  }
  await deps.store.finalize(receipt.id, { gmailMessageId: found.messageId, sentAt: new Date() });
  return { status: 'sent', messageId: found.messageId, outgoingId: receipt.id };
}

/** `sendEmail`, and when the result is uncertain, one reconcile (and one re-send if Gmail has nothing). */
export async function sendEmailRecovering(
  deps: MailDeps,
  email: OutgoingEmail,
): Promise<SendResult> {
  const first = await sendEmail(deps, email);
  if (first.status !== 'uncertain') return first;
  const r = await reconcileOutgoing(deps, first.deliveryKey);
  if (r.status === 'sent')
    return { status: 'sent', messageId: r.messageId, outgoingId: r.outgoingId, alreadySent: true };
  if (r.status === 'not_sent' || r.status === 'none') return sendEmail(deps, email);
  return first;
}

/** Records messages instead of sending them. */
export class InMemorySender implements GmailSender {
  readonly sent: OutgoingEmail[] = [];

  async send(email: OutgoingEmail): Promise<SentEmail> {
    this.sent.push(email);
    return { messageId: `mem-${this.sent.length}` };
  }
}

/** Keeps recorded rows in memory (tests). Stores redacted bodies like the database store. */
export class InMemoryOutgoingStore implements OutgoingStore {
  readonly rows: Array<
    OutgoingRecord & {
      id: string;
      state: OutgoingState;
      deliveryKey: string | null;
      createdAt: Date;
    }
  > = [];

  private seq = 0;

  private push(row: OutgoingRecord, state: OutgoingState, deliveryKey: string | null) {
    const id = `out-${++this.seq}`;
    this.rows.push({
      ...row,
      bodyText: redactConfirmTokens(row.bodyText),
      bodyHtml: redactConfirmTokens(row.bodyHtml),
      id,
      state,
      deliveryKey,
      createdAt: new Date(),
    });
    return id;
  }

  async record(row: OutgoingRecord): Promise<{ id: string }> {
    return { id: this.push(row, row.blocked ? 'blocked' : 'sent', null) };
  }

  async begin(row: OutgoingRecord & { deliveryKey: string }) {
    const existing = this.rows.find((r) => r.deliveryKey === row.deliveryKey);
    if (existing) return { created: false as const, receipt: this.receipt(existing) };
    return { created: true as const, id: this.push(row, 'pending', row.deliveryKey) };
  }

  async finalize(id: string, sent: { gmailMessageId: string; sentAt: Date }) {
    const r = this.rows.find((x) => x.id === id);
    if (r)
      Object.assign(r, { state: 'sent', gmailMessageId: sent.gmailMessageId, sentAt: sent.sentAt });
  }

  async findByKey(deliveryKey: string) {
    const r = this.rows.find((x) => x.deliveryKey === deliveryKey);
    return r ? this.receipt(r) : null;
  }

  async abandon(id: string) {
    const i = this.rows.findIndex((x) => x.id === id && x.state === 'pending');
    if (i >= 0) this.rows.splice(i, 1);
  }

  private receipt(r: (typeof this.rows)[number]): OutgoingReceipt {
    return {
      id: r.id,
      state: r.state,
      gmailMessageId: r.gmailMessageId,
      to: r.to,
      subject: r.subject,
      createdAt: r.createdAt,
    };
  }
}
