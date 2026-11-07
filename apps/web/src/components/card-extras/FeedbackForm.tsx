import { useState, type FormEvent } from 'react';
import { api, errorMessage, formatTime, type Feedback, type InterviewView } from '../../api';

/** Notes, relayed feedback and a 1 to 5 rating for one interview; creates or edits. */
export function FeedbackForm({
  interview,
  onSaved,
}: {
  interview: Pick<InterviewView, 'id' | 'feedback'>;
  onSaved?: (feedback: Feedback) => void;
}) {
  const [saved, setSaved] = useState<Feedback | null>(interview.feedback);
  const [notes, setNotes] = useState(interview.feedback?.notes ?? '');
  const [relayed, setRelayed] = useState(interview.feedback?.relayed ?? '');
  const [rating, setRating] = useState<string>(
    interview.feedback?.rating ? String(interview.feedback.rating) : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    const input = { notes, relayed, rating: rating ? Number(rating) : null };
    try {
      const res = saved
        ? await api.editFeedback(interview.id, input)
        : await api.submitFeedback(interview.id, input);
      setSaved(res.feedback);
      setDone(true);
      onSaved?.(res.feedback);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" aria-label="Interview feedback" onSubmit={submit}>
      <h3>How did the interview go?</h3>
      <p>
        <label>
          Your notes
          <br />
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            maxLength={10000}
          />
        </label>
      </p>
      <p>
        <label>
          Feedback the interviewer shared
          <br />
          <textarea
            value={relayed}
            onChange={(e) => setRelayed(e.target.value)}
            rows={3}
            maxLength={10000}
          />
        </label>
      </p>
      <p>
        <label>
          Overall rating{' '}
          <select value={rating} onChange={(e) => setRating(e.target.value)}>
            <option value="">No rating</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </p>
      <div className="row">
        <button type="submit" disabled={busy}>
          {saved ? 'Save changes' : 'Submit feedback'}
        </button>
        {saved ? (
          <span className="muted small">
            Submitted {formatTime(saved.submitted_at)}
            {saved.updated_at !== saved.submitted_at
              ? `, edited ${formatTime(saved.updated_at)}`
              : ''}
          </span>
        ) : null}
        {done ? <span role="status">Saved.</span> : null}
      </div>
      {error ? (
        <p role="alert" className="banner error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
