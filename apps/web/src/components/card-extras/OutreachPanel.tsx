import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { OutreachDraftView, OutreachListResponse } from '@wma/shared';
import { api, errorMessage, formatTime } from '../../api';

export const OUTREACH_POLL_MS = 4000;
/** How long to keep checking for a draft the worker was asked to write. */
const DRAFTING_GIVE_UP_MS = 3 * 60_000;

const STATE_LABEL: Record<OutreachDraftView['state'], string> = {
  draft: 'Waiting for your approval',
  approved: 'Approved, sending shortly',
  sending: 'Sending',
  sent: 'Sent',
  rejected: 'Rejected',
  failed: 'Not sent',
};

const FAILURE_LABEL: Record<string, string> = {
  daily_cap: 'the daily limit was reached',
  not_replyable: 'the address cannot receive replies',
  blocked: 'the message mentions pay, which the app never sends',
};

function DraftCard({ draft, onChanged }: { draft: OutreachDraftView; onChanged: () => void }) {
  const [to, setTo] = useState(draft.to_address);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body_text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // The server's copy is the truth: a refresh replaces what the fields show.
  useEffect(() => {
    setTo(draft.to_address);
    setSubject(draft.subject);
    setBody(draft.body_text);
    setConfirming(false);
  }, [draft.to_address, draft.subject, draft.body_text, draft.state]);

  const dirty = to !== draft.to_address || subject !== draft.subject || body !== draft.body_text;
  const editable = draft.state === 'draft';

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function copyNote() {
    try {
      await navigator.clipboard.writeText(draft.linkedin_note ?? '');
      setCopied(true);
    } catch {
      setError('Could not copy. Select the text and copy it by hand.');
    }
  }

  return (
    <div className="outreach-draft" aria-label={`Outreach to ${draft.contact_name}`}>
      <h4>
        To {draft.contact_name}
        {draft.contact_title ? `, ${draft.contact_title}` : ''}{' '}
        <span className={`badge ${draft.state === 'draft' ? 'waiting' : ''}`}>
          {STATE_LABEL[draft.state]}
        </span>
      </h4>
      {draft.contact_profile_url ? (
        <p className="small">
          <a href={draft.contact_profile_url} target="_blank" rel="noreferrer noopener">
            Their profile
          </a>
        </p>
      ) : null}
      {editable ? (
        <>
          <p>
            <label>
              Send to
              <br />
              <input type="email" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </p>
          <p>
            <label>
              Subject
              <br />
              <input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
            </label>
          </p>
          <p>
            <label>
              Message
              <br />
              <textarea
                rows={9}
                maxLength={4000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
          </p>
        </>
      ) : (
        <>
          <p className="small muted">
            To {draft.to_address}. Subject: {draft.subject}
          </p>
          <pre className="outreach-body">{draft.body_text}</pre>
        </>
      )}
      {draft.state === 'sent' && draft.sent_at ? (
        <p className="muted small">Sent {formatTime(draft.sent_at)}.</p>
      ) : null}
      {draft.state === 'failed' ? (
        <p role="alert" className="banner error">
          This email was not sent
          {draft.failure_reason
            ? `: ${FAILURE_LABEL[draft.failure_reason] ?? draft.failure_reason}`
            : ''}
          .
        </p>
      ) : null}
      {draft.linkedin_note ? (
        <p className="small">
          LinkedIn note to paste yourself: <em>{draft.linkedin_note}</em>{' '}
          <button type="button" className="link" onClick={() => void copyNote()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="banner error">
          {error}
        </p>
      ) : null}
      {editable ? (
        <p className="actions">
          {dirty ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api.editOutreach(draft.id, { to_address: to, subject, body_text: body }),
                )
              }
            >
              Save changes
            </button>
          ) : null}
          {!confirming ? (
            <button
              type="button"
              className="primary"
              disabled={busy || dirty}
              title={dirty ? 'Save your changes first' : undefined}
              onClick={() => setConfirming(true)}
            >
              Approve and send
            </button>
          ) : (
            <span className="confirm" role="group" aria-label="Confirm sending">
              <span>Send this exact message to {draft.to_address} from your Gmail?</span>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void run(() => api.approveOutreach(draft.id, draft.content_hash))}
              >
                Yes, send it
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => api.rejectOutreach(draft.id))}
          >
            Reject
          </button>
        </p>
      ) : null}
    </div>
  );
}

function ContactForm({ applicationId, onQueued }: { applicationId: string; onQueued: () => void }) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [profile, setProfile] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.requestOutreachDraft(applicationId, {
        name: name.trim(),
        title: title.trim() || null,
        profile_url: profile.trim() || null,
        email: email.trim(),
      });
      setName('');
      setTitle('');
      setProfile('');
      setEmail('');
      onQueued();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="Add a recruiter contact" onSubmit={submit}>
      <p className="muted small">
        Paste a recruiter or hiring manager you found yourself. The app writes a draft; nothing is
        sent until you approve it.
      </p>
      <p>
        <label>
          Name
          <br />
          <input required value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          Title (optional)
          <br />
          <input value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          Email
          <br />
          <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          Profile link (optional)
          <br />
          <input type="url" value={profile} onChange={(e) => setProfile(e.target.value)} />
        </label>
      </p>
      {error ? (
        <p role="alert" className="banner error">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={busy || !name.trim() || !email.trim()}>
        {busy ? 'Requesting…' : 'Write a draft'}
      </button>
    </form>
  );
}

/** Recruiter outreach for one application: add a contact, review the draft, approve to send. */
export function OutreachPanel({ applicationId }: { applicationId: string }) {
  const [data, setData] = useState<OutreachListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftingSince, setDraftingSince] = useState<number | null>(null);

  const load = useCallback(() => {
    return api
      .outreach(applicationId)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [applicationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const count = data?.drafts.length ?? 0;
  const inFlight = data?.drafts.some((d) => d.state === 'approved' || d.state === 'sending');
  const drafting = draftingSince !== null;
  useEffect(() => {
    if (!inFlight && !drafting) return;
    const t = setInterval(() => void load(), OUTREACH_POLL_MS);
    return () => clearInterval(t);
  }, [inFlight, drafting, load]);

  // A new draft arrived, or the worker took too long: stop saying "writing".
  const [countAtRequest, setCountAtRequest] = useState(0);
  useEffect(() => {
    if (draftingSince === null) return;
    if (count > countAtRequest || Date.now() - draftingSince > DRAFTING_GIVE_UP_MS)
      setDraftingSince(null);
  }, [count, countAtRequest, draftingSince, data]);

  return (
    <section className="card outreach" aria-label="Recruiter outreach">
      <h3>Reach out to a recruiter</h3>
      {error ? (
        <p role="alert" className="banner error">
          {error}
        </p>
      ) : null}
      {data
        ? data.drafts.map((d) => <DraftCard key={d.id} draft={d} onChanged={() => void load()} />)
        : null}
      {drafting ? <p className="muted">Writing a draft… this can take a minute.</p> : null}
      {data ? (
        <p className="muted small">
          {data.sent_today} of {data.daily_cap} outreach emails sent today.
        </p>
      ) : null}
      <ContactForm
        applicationId={applicationId}
        onQueued={() => {
          setCountAtRequest(count);
          setDraftingSince(Date.now());
        }}
      />
    </section>
  );
}
