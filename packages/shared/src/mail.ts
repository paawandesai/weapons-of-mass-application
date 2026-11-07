export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  /** When set, the part is inline and referenced from the HTML as `cid:<contentId>`. */
  contentId?: string;
}

export interface OutgoingEmail {
  userId: string;
  /** Recipient address(es). */
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
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

export interface MailDeps {
  sender: GmailSender;
  /** Run in order before every send. The inbox wave registers the compensation-content guard here. */
  guards: ContentGuard[];
}

/** The only function that sends mail: nothing else holds a sender. */
export async function sendEmail(deps: MailDeps, email: OutgoingEmail): Promise<SentEmail> {
  for (const guard of deps.guards) {
    const result = await guard.check(email);
    if (!result.ok) throw new ContentGuardError(guard.name, result.reason);
  }
  return deps.sender.send(email);
}

/** Records messages instead of sending them. */
export class InMemorySender implements GmailSender {
  readonly sent: OutgoingEmail[] = [];

  async send(email: OutgoingEmail): Promise<SentEmail> {
    this.sent.push(email);
    return { messageId: `mem-${this.sent.length}` };
  }
}
