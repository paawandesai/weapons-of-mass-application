import { Loading } from './Loading';
import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  errorMessage,
  formatDate,
  formatPay,
  formatTime,
  resumeUrl,
  type ApplicationDetail,
} from '../api';
import { CardExtras } from './card-extras';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  closed: 'Closed',
};

const SLOT_LABEL: Record<string, string> = {
  confirmed: 'Confirmed',
  open: 'Offered',
  expired: 'Expired',
  invalidated: 'Withdrawn',
};

function answerText(a: ApplicationDetail['form_answers'][number]): string {
  if (a.status === 'blank') return 'Left blank';
  if (a.status === 'skipped') return 'Skipped (optional self-identification)';
  if (a.status === 'attached') return `Attached ${String(a.value)}`;
  return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
}

function basename(ref: string): string {
  return ref.split('/').pop() || ref;
}

/** The card detail: summary, resume, answers, threads, interviews, activity and the extras. */
export function BoardDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    setNotFound(false);
    api
      .application(id)
      .then((d) => live && setDetail(d))
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [id]);

  async function loadEarlier() {
    if (!detail?.activity_next) return;
    setLoadingMore(true);
    try {
      const older = await api.application(id, detail.activity_next);
      setDetail((d) =>
        d
          ? {
              ...d,
              activity: [...older.activity, ...d.activity],
              activity_next: older.activity_next,
            }
          : d,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }

  if (notFound) return <p className="muted">This application could not be found.</p>;
  if (error)
    return (
      <p role="alert" className="banner error">
        {error}
      </p>
    );
  if (!detail) return <Loading />;

  const job = detail.job;
  const pay = job ? formatPay(job.pay_min, job.pay_max, job.currency) : null;
  return (
    <div className="detail">
      <header>
        <h1>{job?.company ?? 'Unknown company'}</h1>
        <p className="row">
          <strong>{job?.title ?? 'Untitled role'}</strong>
          <span className="badge">{STATUS_LABEL[detail.status] ?? detail.status}</span>
          {detail.status === 'pending' ? <span className="badge partial">Pending</span> : null}
          {job ? (
            <a href={job.url} target="_blank" rel="noreferrer">
              View posting
            </a>
          ) : null}
        </p>
        <dl className="card-facts">
          <dt>Location</dt>
          <dd>{job?.location_mode ?? 'Not listed'}</dd>
          <dt>Pay</dt>
          <dd>{pay ?? 'Not listed'}</dd>
          <dt>Applied</dt>
          <dd>{detail.applied_at ? formatDate(detail.applied_at) : 'Not yet'}</dd>
          <dt>Last activity</dt>
          <dd>{formatTime(detail.last_activity_at)}</dd>
        </dl>
        {detail.pending_reason ? (
          <p className="banner">Waiting on: {detail.pending_reason}</p>
        ) : null}
      </header>

      {detail.decision ? (
        <section aria-labelledby="d-why">
          <h2 id="d-why">Why this job</h2>
          <p>{detail.decision.rationale}</p>
        </section>
      ) : null}

      <section aria-labelledby="d-resume">
        <h2 id="d-resume">Resume</h2>
        {detail.resume ? (
          <p>
            Tailored resume:{' '}
            <a href={resumeUrl(detail.id)} download>
              Download <code>{basename(detail.resume.ref)}</code>
            </a>
          </p>
        ) : (
          <p className="muted">No tailored resume yet.</p>
        )}
        {detail.unmet_requirements.length > 0 ? (
          <>
            <h3>Requirements not met</h3>
            <ul>
              {detail.unmet_requirements.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section aria-labelledby="d-answers">
        <h2 id="d-answers">Answers</h2>
        {detail.form_answers.length === 0 ? (
          <p className="muted">No form answers yet.</p>
        ) : (
          <dl className="answers">
            {detail.form_answers.map((a) => (
              <div key={a.question}>
                <dt>{a.question}</dt>
                <dd>
                  {answerText(a)}
                  {a.source && (
                    <small className="muted">
                      {' '}
                      Answered by inference, correct it in your profile if wrong
                    </small>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section aria-labelledby="d-threads">
        <h2 id="d-threads">Email</h2>
        {detail.threads.length === 0 && detail.outgoing.length === 0 ? (
          <p className="muted">No email on this application yet.</p>
        ) : null}
        {detail.threads.map((t) => (
          <div key={t.id} className="card">
            <p className="row">
              <strong>{t.subject ?? 'Email thread'}</strong>
              <span className="badge">{t.kind}</span>
              {t.compensation_flag ? <span className="badge partial">Mentions pay</span> : null}
              <span className="muted small">{formatTime(t.last_message_at)}</span>
            </p>
            {t.messages.map((m) => (
              <blockquote key={m.id} className="message">
                <div className="muted small">
                  {m.from} · {formatTime(m.at)}
                </div>
                <p>{m.body}</p>
              </blockquote>
            ))}
          </div>
        ))}
        {detail.outgoing.length > 0 ? (
          <ul className="rows" aria-label="Sent by the agent">
            {detail.outgoing.map((m) => (
              <li key={m.id}>
                <span>{m.subject}</span>
                <span className="badge">{m.kind.replace('_', ' ')}</span>
                {m.sent_at ? <span className="muted small">{formatTime(m.sent_at)}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {detail.interviews.length > 0 ? (
        <section aria-labelledby="d-interviews">
          <h2 id="d-interviews">Interview times</h2>
          {detail.interviews.map((iv) => (
            <div key={iv.id} className="card">
              <p>
                {iv.starts_at ? <strong>{formatTime(iv.starts_at)}</strong> : 'Time not confirmed'}
              </p>
              <ul className="rows">
                {iv.slots.map((s) => (
                  <li key={s.id}>
                    <span>{formatTime(s.starts_at)}</span>
                    <span className="badge">{SLOT_LABEL[s.state] ?? s.state}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}

      <section aria-labelledby="d-extras">
        <h2 id="d-extras">Interview prep and feedback</h2>
        <CardExtras application={{ id: detail.id, status: detail.status }} />
      </section>

      <section aria-labelledby="d-activity">
        <h2 id="d-activity">Activity</h2>
        {detail.activity_next ? (
          <button type="button" onClick={loadEarlier} disabled={loadingMore}>
            Show earlier activity
          </button>
        ) : null}
        {detail.activity.length === 0 ? (
          <p className="muted">No activity yet.</p>
        ) : (
          <ol className="rows activity" aria-label="Activity log">
            {detail.activity.map((e) => (
              <li key={e.id}>
                <span className="muted small">{formatTime(e.at)}</span>
                <span className="badge">{e.actor === 'user' ? 'You' : 'Agent'}</span>
                <span>{e.action.replace(/[_-]/g, ' ')}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
