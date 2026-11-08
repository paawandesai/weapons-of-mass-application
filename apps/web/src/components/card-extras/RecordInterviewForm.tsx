import { useState, type FormEvent } from 'react';
import { api, errorMessage, type InterviewView } from '../../api';

const DURATIONS = [30, 45, 60, 90] as const;

/** "YYYY-MM-DDTHH:MM" in local time, the format a datetime-local input takes. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * For an interview booked outside the app (the employer's scheduling page, a phone call): the
 * user enters the time, the card moves to Interviewing and a prep plan is prepared.
 */
export function RecordInterviewForm({
  applicationId,
  onRecorded,
  onCancel,
}: {
  applicationId: string;
  onRecorded: (interview: InterviewView) => void;
  onCancel?: () => void;
}) {
  const [startsAt, setStartsAt] = useState('');
  const [minutes, setMinutes] = useState<string>('60');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const min = toLocalInput(new Date());

  async function submit(e: FormEvent) {
    e.preventDefault();
    const start = new Date(startsAt);
    if (!startsAt || Number.isNaN(start.getTime())) {
      setError('Enter the date and time of the interview.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const end = new Date(start.getTime() + Number(minutes) * 60_000);
      const res = await api.recordInterview(applicationId, {
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
      });
      onRecorded(res.interview);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" aria-label="Record an interview" onSubmit={submit}>
      <h3>Record an interview</h3>
      <p className="muted">
        Booked a time with the company directly? Enter it here and your prep plan will be prepared.
      </p>
      <p>
        <label>
          Date and time
          <br />
          <input
            type="datetime-local"
            value={startsAt}
            min={min}
            required
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </label>
      </p>
      <p>
        <label>
          Length
          <br />
          <select value={minutes} onChange={(e) => setMinutes(e.target.value)}>
            {DURATIONS.map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </label>
      </p>
      <div className="row">
        <button type="submit" disabled={busy}>
          Save interview
        </button>
        {onCancel ? (
          <button type="button" className="link" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="banner error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
