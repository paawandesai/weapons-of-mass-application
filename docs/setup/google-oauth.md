# Google OAuth setup

Sign-in uses one Google consent screen that also grants Gmail, Calendar and Drive access. The app runs in Google's testing mode, so only listed test users can sign in.

## Console steps

1. Open the Google Cloud console and create a project (for example `wma-dev`).
2. Under APIs & Services, Library, enable: Gmail API, Google Calendar API, Google Drive API and People API.
3. Under APIs & Services, OAuth consent screen:
   - User type External, publishing status Testing.
   - Fill in the app name and support email.
   - Add the scopes: `openid`, `email`, `profile`, `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.send`, `https://www.googleapis.com/auth/calendar`, `https://www.googleapis.com/auth/drive.readonly`.
   - Add every Google account that will sign in as a test user. Others are refused by Google.
4. Under Credentials, Create credentials, OAuth client ID:
   - Application type Web application.
   - Authorized JavaScript origin: `http://localhost:3000`
   - Authorized redirect URI: `http://localhost:3000/auth/google/callback`
5. Copy the client ID and client secret into `.env`.

In testing mode Google expires refresh tokens after 7 days. When that happens the app marks Gmail, Calendar and Drive as disconnected and asks the user to reconnect.

## Environment variables

| Variable               | Purpose                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | OAuth client ID                                                                  |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret                                                              |
| `GOOGLE_REDIRECT_URI`  | Must match the console exactly (default `http://localhost:3000/auth/google/callback`) |
| `WEB_ORIGIN`           | Where the browser is sent after the callback, for success and failure (default `http://localhost:5173`, the Vite dev server) |
| `SESSION_SECRET`       | Signs the short-lived sign-in cookie; generate with `openssl rand -base64 32`    |
| `VAULT_MASTER_KEY`     | Encrypts the stored refresh token (32 bytes, base64)                             |

The API refuses to start without `VAULT_MASTER_KEY` and `SESSION_SECRET`.

## How the flow behaves

- `GET /auth/google/start` redirects to Google using the authorization code flow with PKCE, offline access and, for a first sign-in or `?reconnect=1`, a forced consent screen so Google issues a refresh token.
- `GET /auth/google/callback` creates the account on first sign-in, records which scopes were granted (a declined scope marks that source disconnected), stores the refresh token in the vault, starts a session and redirects to `WEB_ORIGIN` (`/`). Failures redirect to `WEB_ORIGIN/signin?error=unverified_email`, `declined`, `oauth_error` or `account_conflict`. The callback itself stays on the API port (the registered redirect URI); only the browser's landing page is the web origin, which matters locally because the API runs on port 3000 and the web app on 5173.
- Returning users are matched by their Google account's stable subject, never by email. If a different Google identity presents an email that is already registered, sign-in stops with `account_conflict` and nothing is created or linked.
- Sessions last 30 days from last use and are ended by `POST /auth/signout`.
