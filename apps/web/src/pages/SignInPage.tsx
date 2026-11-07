import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Mark } from '../components/Logo';

const LaunchField = lazy(() => import('../components/landing/LaunchField'));

const MESSAGES: Record<string, string> = {
  unverified_email:
    'Google has not verified that email address, so we cannot create an account with it. Verify it with Google and try again.',
  declined: 'Sign-in was cancelled on the Google screen. Approve access to continue.',
  oauth_error: 'Google sign-in did not complete. Please try again.',
  account_conflict:
    'An account with this email address already exists and is linked to a different Google identity. Sign in with the Google account you used before.',
};

const SEQUENCE = ['Discover', 'Decide', 'Tailor', 'Submit', 'Follow up', 'Book'];

const STEPS: { code: string; title: string; body: string }[] = [
  {
    code: '01',
    title: 'Connect once',
    body: 'Sign in with Google. Add a resume, a LinkedIn URL, a GitHub username or Drive. The agent builds one master profile from everything you connected.',
  },
  {
    code: '02',
    title: 'Set the targets',
    body: 'A short survey: roles, salary floor, locations and remote preference, constraints, career direction, and how many applications a day you want.',
  },
  {
    code: '03',
    title: 'Approve the profile',
    body: 'You read and edit the profile the agent wrote before anything leaves. Not one application goes out before you approve it.',
  },
  {
    code: '04',
    title: 'Autopilot runs',
    body: 'Every run discovers postings, judges each one against your targets, writes a tailored resume, submits the application and records it on your board.',
  },
  {
    code: '05',
    title: 'Inbox handled',
    body: 'Recruiter replies are read and answered. When times are proposed, the agent checks your calendar and sends you the slots. You pick one. Only then is it booked.',
  },
  {
    code: '06',
    title: 'Prep and offers',
    body: 'Every booked interview gets a prep plan. Offers land on the board with comparables attached. The agent never writes to an employer about money.',
  },
];

const GUARDRAILS: string[] = [
  'No interview is booked without your explicit confirmation of day and time.',
  'No application goes out before you approve the master profile.',
  'Tailoring never invents experience. Every resume and every form answer is visible on the card.',
  'The agent sends nothing involving compensation or offer terms.',
  'Voluntary self-identification is never filled in.',
  'Any connected source can be disconnected, which stops further reads.',
  'The activity log records every action taken on your behalf.',
];

const SURFACES: { title: string; body: string }[] = [
  {
    title: 'The board',
    body: 'Every application as a card, from Applied through Interview to Offer. Open one to see the tailored resume, each form answer and the full thread.',
  },
  {
    title: 'The daily digest',
    body: 'One email a day: what was applied to, who replied, what is waiting on you, and what is on the calendar.',
  },
  {
    title: 'The run view',
    body: 'What the agent did on its last pass, posting by posting, and why it passed on the ones it skipped.',
  },
];

/** Reveals children once they scroll into view. Visible immediately where observers are unavailable. */
function Reveal({
  children,
  as: Tag = 'div',
  className = '',
  delay = 0,
}: {
  children: ReactNode;
  as?: 'div' | 'li' | 'section' | 'article';
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      { threshold: 0.18, rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      // The union of element refs is wider than any single tag's ref type.
      ref={ref as never}
      className={`reveal ${shown ? 'is-shown' : ''} ${className}`.trim()}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}

function useWebGL() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('WebGLRenderingContext' in window)) return;
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl');
    setOk(gl !== null);
  }, []);
  return ok;
}

export function SignInPage() {
  const [params] = useSearchParams();
  const error = params.get('error');
  const message = error ? (MESSAGES[error] ?? 'Sign-in did not complete. Please try again.') : null;
  const webgl = useWebGL();
  const title = ['Weapons', 'of', 'Mass', 'Application'];

  return (
    <main className="landing">
      {webgl && (
        <Suspense fallback={null}>
          <LaunchField className="launch-field" />
        </Suspense>
      )}
      <div className="landing-vignette" aria-hidden="true" />

      <header className="landing-top">
        <span className="brand">
          <Mark />
          <span className="wordmark">
            <span className="wordmark-short" aria-hidden="true">
              WoMA
            </span>
            <span className="wordmark-long">Weapons of Mass Application</span>
          </span>
        </span>
        <nav aria-label="Landing">
          <a href="#how">How it works</a>
          <a href="#guardrails">Guardrails</a>
        </nav>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <p className="eyebrow">
          <span className="blink" aria-hidden="true" />
          Autopilot for the job search
        </p>
        <h1 id="hero-title" className="hero-title">
          {title.map((word, i) => (
            <span key={word} className="hero-word" style={{ animationDelay: `${120 + i * 110}ms` }}>
              {word}
            </span>
          ))}
        </h1>
        <p className="hero-lede">
          Connect your accounts once, approve the profile it builds, and the agent finds postings,
          tailors a resume for each, submits, answers recruiters and books interviews only on your
          say-so.
        </p>
        <div className="hero-actions">
          <a className="button primary launch" href="/auth/google/start">
            Sign in with Google
          </a>
          <a className="button ghost" href="#how">
            See how it works
          </a>
        </div>
        {message && (
          <p role="alert" className="banner error">
            {message}
          </p>
        )}
        <div className="sequence" aria-label="What a run does">
          <span className="sequence-label">Run sequence</span>
          <span className="sequence-window">
            <span className="sequence-reel">
              {[...SEQUENCE, SEQUENCE[0]].map((s, i) => (
                <span key={`${s}-${i}`}>{s}</span>
              ))}
            </span>
          </span>
          <span className="sequence-track" aria-hidden="true">
            {SEQUENCE.map((s) => (
              <i key={s} />
            ))}
          </span>
        </div>
        <a className="scroll-cue" href="#how" aria-label="Scroll to how it works">
          <span />
        </a>
      </section>

      <section id="how" className="landing-section" aria-labelledby="how-title">
        <Reveal className="section-head">
          <h3>Sequence</h3>
          <h2 id="how-title">From sign-in to offer, without the grind</h2>
        </Reveal>
        <ol className="lp-steps">
          {STEPS.map((s, i) => (
            <Reveal key={s.code} as="li" className="lp-step" delay={i * 70}>
              <span className="lp-step-code">{s.code}</span>
              <h4>{s.title}</h4>
              <p>{s.body}</p>
            </Reveal>
          ))}
        </ol>
      </section>

      <section className="landing-section band" aria-labelledby="surfaces-title">
        <Reveal className="section-head">
          <h3>Visibility</h3>
          <h2 id="surfaces-title">Everything it does, where you can see it</h2>
        </Reveal>
        <div className="surfaces">
          {SURFACES.map((s, i) => (
            <Reveal key={s.title} as="article" className="surface" delay={i * 90}>
              <h4>{s.title}</h4>
              <p>{s.body}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <section id="guardrails" className="landing-section" aria-labelledby="guardrails-title">
        <Reveal className="section-head">
          <h3>Guardrails</h3>
          <h2 id="guardrails-title">Rules the agent cannot break</h2>
        </Reveal>
        <ul className="guardrails">
          {GUARDRAILS.map((g, i) => (
            <Reveal key={g} as="li" className="guardrail" delay={i * 60}>
              <span className="stamp" aria-hidden="true">
                Locked
              </span>
              <span>{g}</span>
            </Reveal>
          ))}
        </ul>
      </section>

      <section className="landing-section" aria-labelledby="cta-title">
        <Reveal className="final-plate">
          <Mark size={72} />
          <h2 id="cta-title">Ready to launch</h2>
          <p>
            One Google sign-in covers Gmail and Calendar. You review the profile before the first
            application goes out.
          </p>
          <a className="button primary launch" href="/auth/google/start">
            Start with Google
          </a>
        </Reveal>
      </section>

      <footer className="landing-foot">
        <span>Weapons of Mass Application</span>
        <span>Apply at scale. Decide in person.</span>
      </footer>
    </main>
  );
}
