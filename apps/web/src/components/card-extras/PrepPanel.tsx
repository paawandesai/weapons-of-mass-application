import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage, type InterviewView } from '../../api';

/** Prep plan status for one interview on the card, with a Generate button. */
export function PrepPanel({
  interview,
  onChanged,
}: {
  interview: InterviewView;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = interview.prep_plan_status;

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      await api.requestPrepPlan(interview.id);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label="Prep plan">
      <h3>Prep plan</h3>
      {status === 'ready' ? (
        <p>
          <Link to={`/interviews/${interview.id}/prep`}>Open the prep plan</Link>
        </p>
      ) : status === 'pending' ? (
        <p className="muted" role="status">
          Your prep plan is being prepared.
        </p>
      ) : (
        <p className="muted">
          {status === 'failed'
            ? 'The prep plan could not be prepared.'
            : 'There is no prep plan for this interview yet.'}
        </p>
      )}
      {status !== 'ready' && status !== 'pending' ? (
        <button type="button" onClick={generate} disabled={busy}>
          {status === 'failed' ? 'Try again' : 'Generate prep plan'}
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="banner error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
