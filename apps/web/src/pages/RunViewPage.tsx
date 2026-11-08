import { Loading } from '../components/Loading';
import { useEffect, useRef, useState } from 'react';
import { errorMessage, formatTime, type RunCandidateView, type RunSummary } from '../api';
import { api } from '../api';

export const RUN_POLL_MS = 5000;

const STATUS_LABEL: Record<RunSummary['status'], string> = {
  running: 'Running',
  finished: 'Finished',
  short_day: 'Finished, fewer applications than the daily target',
  failed: 'Failed',
  skipped_no_profile: 'Skipped until your profile is approved',
};

const REASON_LABEL: Record<string, string> = {
  not_approved: 'Not approved',
  over_target: 'Over the daily limit',
  company_cap: 'Another role at this company was chosen',
  already_applied: 'Already applied to',
  unjudged: 'Could not be judged',
  deadline_passed: 'Deadline has passed',
  removed_company: 'Company removed from your list',
};
const reasonText = (r: string) => REASON_LABEL[r] ?? r.replace(/_/g, ' ');

function verdict(c: RunCandidateView): string {
  if (c.selected) return 'Selected to apply';
  if (c.apply === false) return 'Skip';
  if (c.apply === true) return c.exclusion_reason ? 'Approved, not applied' : 'Approved';
  return 'Not judged';
}

export function RunViewPage() {
  const [run, setRun] = useState<RunSummary | null>(null);
  const [candidates, setCandidates] = useState<RunCandidateView[]>([]);
  const [nextRunAt, setNextRunAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef<string | null>(null);
  const runId = useRef<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const runningRef = useRef(false);
  const running = run?.status === 'running';

  // One poll in flight at a time: the next is scheduled only after the current one (including a
  // multi-page drain) has finished, so responses cannot arrive out of order and the cursor only
  // moves forward.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const drain = async (): Promise<boolean> => {
      let stillRunning = false;
      try {
        for (;;) {
          const r = await api.currentRun(cursor.current);
          if (!live) return false;
          const fresh = (r.run?.id ?? null) !== runId.current;
          runId.current = r.run?.id ?? null;
          if (fresh || r.next_cursor !== null) cursor.current = r.next_cursor;
          setRun(r.run);
          setNextRunAt(r.next_run_at);
          setCandidates((prev) => (fresh ? r.candidates : [...prev, ...r.candidates]));
          setError(null);
          setLoaded(true);
          stillRunning = r.run?.status === 'running';
          if (!r.has_more) break;
        }
      } catch (e) {
        if (live) {
          setError(errorMessage(e));
          setLoaded(true);
        }
        // Keep trying only while a run was in progress on the last good answer.
        stillRunning = runningRef.current;
      }
      return stillRunning;
    };

    const tick = async () => {
      const again = await drain();
      runningRef.current = again;
      if (live && again) timer = setTimeout(() => void tick(), RUN_POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [reload]);

  const startRun = async () => {
    setStarting(true);
    setNotice(null);
    try {
      const r = await api.startRun();
      if (r.run.status === 'finished' || r.run.status === 'short_day') {
        setNotice("Today's run already happened.");
      }
      setError(null);
      // Restart the load/poll loop so a queued run is picked up and followed to the end.
      setReload((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  if (!loaded) return <Loading />;

  return (
    <section>
      <div className="row">
        <h1 className="grow">Runs</h1>
        <button
          type="button"
          className="primary"
          onClick={() => void startRun()}
          disabled={running || starting}
        >
          {starting ? 'Starting…' : running ? 'Running…' : 'Run today'}
        </button>
      </div>
      {notice ? <p className="muted">{notice}</p> : null}
      {error ? (
        <p role="alert" className="banner error">
          {error}
        </p>
      ) : null}
      {!run ? (
        <div className="card">
          <p>No run has happened yet.</p>
          {nextRunAt ? (
            <p className="muted">Your next run is scheduled for {formatTime(nextRunAt)}.</p>
          ) : null}
        </div>
      ) : (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>{STATUS_LABEL[run.status]}</h2>
            <p className="muted">Started {formatTime(run.started_at)}</p>
            <dl className="facts">
              <dt>Postings considered</dt>
              <dd>{run.counts.judged ?? candidates.length}</dd>
              <dt>Approved</dt>
              <dd>{run.counts.approved ?? 0}</dd>
              <dt>Applied to</dt>
              <dd>{run.counts.selected ?? 0}</dd>
            </dl>
            {run.status === 'failed' ? (
              <p role="alert" className="banner error">
                This run did not finish. It will be tried again at the next run.
              </p>
            ) : null}
          </div>
          {candidates.length === 0 ? (
            <p className="muted">
              {running
                ? 'Looking through postings. They appear here as they are judged.'
                : 'No postings were judged in this run.'}
            </p>
          ) : (
            <ol className="rows" aria-label="Candidates">
              {candidates.map((c, i) => (
                <li key={`${c.url}-${i}`}>
                  <div className="grow">
                    <strong>
                      {c.url ? (
                        <a href={c.url} target="_blank" rel="noopener noreferrer">
                          {c.title}
                        </a>
                      ) : (
                        c.title
                      )}
                    </strong>{' '}
                    <span className="muted">at {c.company}</span>
                    <div>
                      <span>{verdict(c)}</span>
                      {!c.selected && c.exclusion_reason ? (
                        <span className="muted"> ({reasonText(c.exclusion_reason)})</span>
                      ) : null}
                    </div>
                    {c.rationale ? <div className="muted small">{c.rationale}</div> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
