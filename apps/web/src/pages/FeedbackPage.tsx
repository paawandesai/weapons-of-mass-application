import { Loading } from '../components/Loading';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage, type InterviewView } from '../api';
import { FeedbackForm } from '../components/card-extras';

/** The feedback form of one interview; reminders link here. */
export function FeedbackPage() {
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
      <h1>Interview feedback</h1>
      {error ? (
        <p role="alert" className="banner error">
          {error}
        </p>
      ) : interview ? (
        <>
          <p>
            <Link to={`/applications/${interview.application_id}`}>Back to the card</Link>
          </p>
          <FeedbackForm interview={interview} />
        </>
      ) : (
        <Loading />
      )}
    </section>
  );
}
