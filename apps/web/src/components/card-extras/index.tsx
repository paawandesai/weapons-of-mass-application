import { Loading } from '../Loading';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { LlmUsageTotals } from '@wma/shared';
import { api, errorMessage, formatTime, type InterviewView, type NegotiationView } from '../../api';
import { formatUsd } from '../../pages/UsagePage';
import { FeedbackForm } from './FeedbackForm';
import { OfferPanel } from './OfferPanel';
import { OutreachPanel } from './OutreachPanel';
import { PrepPanel } from './PrepPanel';
import { RecordInterviewForm } from './RecordInterviewForm';

export { FeedbackForm } from './FeedbackForm';
export { OfferPanel } from './OfferPanel';
export { OutreachPanel } from './OutreachPanel';
export { PrepPanel } from './PrepPanel';
export { PrepPlanView } from './PrepPlanView';
export { RecordInterviewForm } from './RecordInterviewForm';

/**
 * What the card needs from the application. `interviews` and `negotiation` may be left out; the
 * component then loads them for `id`.
 */
export interface CardExtrasApplication {
  id: string;
  status: string;
  interviews?: InterviewView[];
  negotiation?: NegotiationView | null;
}

export const PREP_POLL_MS = 5000;

/** Prep plan, interview feedback and the offer panel for a card. */
export function CardExtras({ application }: { application: CardExtrasApplication }) {
  const given = application.interviews !== undefined;
  const [loaded, setLoaded] = useState<{
    interviews: InterviewView[];
    negotiation: NegotiationView | null;
    llm_usage?: LlmUsageTotals;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  const load = useCallback(() => {
    return api
      .applicationExtras(application.id)
      .then((r) => setLoaded(r))
      .catch((e) => setError(errorMessage(e)));
  }, [application.id]);

  useEffect(() => {
    if (!given) void load();
  }, [given, load]);

  const interviews = loaded?.interviews ?? application.interviews ?? null;
  const negotiation =
    loaded !== null
      ? loaded.negotiation
      : application.negotiation !== undefined
        ? application.negotiation
        : null;

  const pending = interviews?.some((i) => i.prep_plan_status === 'pending') ?? false;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void load(), PREP_POLL_MS);
    return () => clearInterval(t);
  }, [pending, load]);

  if (error)
    return (
      <p role="alert" className="banner error">
        {error}
      </p>
    );
  if (interviews === null) return <Loading />;

  const showOffer = application.status === 'offer' || negotiation !== null;
  const closed = application.status === 'closed';
  const recorded = () => {
    setRecording(false);
    void load();
  };
  return (
    <div className="card-extras">
      {interviews.length === 0 ? (
        <>
          <p className="muted">No interview is booked yet, so there is no prep plan.</p>
          {!closed ? (
            <RecordInterviewForm applicationId={application.id} onRecorded={recorded} />
          ) : null}
        </>
      ) : (
        <>
          {interviews.map((iv) => (
            <div key={iv.id} className="interview">
              <h3>Interview{iv.starts_at ? ` on ${formatTime(iv.starts_at)}` : ''}</h3>
              <PrepPanel interview={iv} onChanged={() => void load()} />
              {iv.confirmed ? <FeedbackForm interview={iv} onSaved={() => void load()} /> : null}
            </div>
          ))}
          {!closed && !recording ? (
            <p>
              <button type="button" className="link" onClick={() => setRecording(true)}>
                Record another interview
              </button>
            </p>
          ) : null}
          {!closed && recording ? (
            <RecordInterviewForm
              applicationId={application.id}
              onRecorded={recorded}
              onCancel={() => setRecording(false)}
            />
          ) : null}
        </>
      )}
      {showOffer ? (
        <OfferPanel
          negotiation={negotiation}
          applicationId={application.id}
          onChanged={() => void load()}
        />
      ) : null}
      {!closed ? <OutreachPanel applicationId={application.id} /> : null}
      {loaded?.llm_usage && loaded.llm_usage.calls > 0 ? (
        <p className="muted small usage-line">
          Agent cost for this application: {formatUsd(loaded.llm_usage.cost_usd)} across{' '}
          {loaded.llm_usage.calls} model {loaded.llm_usage.calls === 1 ? 'call' : 'calls'}.{' '}
          <Link to="/usage">See all usage</Link>
        </p>
      ) : null}
    </div>
  );
}
