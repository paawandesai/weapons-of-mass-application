import { useSearchParams } from 'react-router-dom';

const MESSAGES: Record<string, string> = {
  unverified_email:
    'Google has not verified that email address, so we cannot create an account with it. Verify it with Google and try again.',
  declined: 'Sign-in was cancelled on the Google screen. Approve access to continue.',
  oauth_error: 'Google sign-in did not complete. Please try again.',
  account_conflict:
    'An account with this email address already exists and is linked to a different Google identity. Sign in with the Google account you used before.',
};

export function SignInPage() {
  const [params] = useSearchParams();
  const error = params.get('error');
  const message = error ? (MESSAGES[error] ?? 'Sign-in did not complete. Please try again.') : null;

  return (
    <main className="signin">
      <h1>Weapons of Mass Application</h1>
      <p className="muted">
        Sign in with Google once. The agent uses Gmail, Calendar and Drive on your behalf, and you
        review your profile before it applies anywhere.
      </p>
      {message && (
        <p role="alert" className="banner error">
          {message}
        </p>
      )}
      <a className="button primary" href="/auth/google/start">
        Sign in with Google
      </a>
    </main>
  );
}
