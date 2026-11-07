import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage, type InterviewView } from '../api';
import { PrepPlanView } from '../components/card-extras';

/** The prep plan of one interview; the card and reminders link here. */
export function PrepPlanPage() {
  const { id = '' } = useParams();
  const [interview, setInterview] = useState<InterviewView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .interview(id)
      .then((r) => live && setInterview(r.interview))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [id]);

  return (
    <section>
      <h1>Interview prep plan</h1>
      {error ? (
        <p role="alert" className="banner error">
          {error}
        </p>
      ) : !interview ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p>
            <Link to={`/applications/${interview.application_id}`}>Back to the card</Link>
          </p>
          {interview.prep_plan_status === 'ready' && interview.prep_plan ? (
            <PrepPlanView plan={interview.prep_plan} />
          ) : (
            <p className="muted">
              {interview.prep_plan_status === 'pending'
                ? 'Your prep plan is being prepared.'
                : 'There is no prep plan for this interview yet. You can generate one from the card.'}
            </p>
          )}
        </>
      )}
    </section>
  );
}
