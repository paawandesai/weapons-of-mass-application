import type { MeResponse } from '@wma/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage, formatTime } from '../api';

interface Step {
  label: string;
  done: boolean;
  detail?: string;
  to: string;
  action: string;
}

export function DashboardPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [surveyDone, setSurveyDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.me(), api.survey()])
      .then(([m, s]) => {
        if (!live) return;
        setMe(m);
        setSurveyDone(s.answers !== null);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, []);

  if (error)
    return (
      <p role="alert" className="banner error">
        {error}
      </p>
    );
  if (!me) return <p className="muted">Loading…</p>;

  const resume = me.connections.find((c) => c.kind === 'resume');
  const approved = me.user.approved_profile_version !== null;
  const steps: Step[] = [
    { label: 'Signed in with Google', done: true, to: '/connections', action: 'View connections' },
    {
      label: 'Resume uploaded',
      done: resume?.status === 'connected',
      to: '/connections',
      action: 'Upload resume',
    },
    { label: 'Survey completed', done: surveyDone, to: '/survey', action: 'Take survey' },
    {
      label: 'Profile approved',
      done: approved,
      detail:
        approved && me.user.approved_profile_at
          ? `Approved ${formatTime(me.user.approved_profile_at)}`
          : undefined,
      to: '/profile/review',
      action: 'Review profile',
    },
  ];

  return (
    <section>
      <h1>Welcome{me.user.display_name ? `, ${me.user.display_name}` : ''}</h1>
      <p className="muted">Finish these steps and the agent can start applying for you.</p>
      <ol className="steps" aria-label="Onboarding progress">
        {steps.map((s) => (
          <li key={s.label} className={s.done ? 'done' : 'todo'}>
            <span className="status">{s.done ? 'Done' : 'To do'}</span>
            <span className="grow">
              {s.label}
              {s.detail && <span className="muted"> · {s.detail}</span>}
            </span>
            <Link to={s.to}>{s.done ? 'Open' : s.action}</Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
