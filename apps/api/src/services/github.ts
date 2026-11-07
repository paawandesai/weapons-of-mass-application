const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const isGithubUsername = (s: string) => USERNAME_RE.test(s);

export interface GithubRepo {
  name: string;
  description: string | null;
  language: string | null;
  pushed_at: string | null;
}

export type GithubResult =
  | { outcome: 'ok'; repos: GithubRepo[]; text: string }
  | { outcome: 'not_found' }
  | { outcome: 'unavailable' };

interface ApiRepo {
  name: string;
  description: string | null;
  language: string | null;
  pushed_at: string | null;
  fork?: boolean;
  private?: boolean;
}

export function reposToText(username: string, repos: GithubRepo[]): string {
  if (repos.length === 0) return '';
  const lines = repos.map((r) => {
    const parts = [`${username}/${r.name}`];
    if (r.description) parts.push(`: ${r.description}`);
    if (r.language) parts.push(` (${r.language})`);
    if (r.pushed_at) parts.push(`, pushed ${r.pushed_at.slice(0, 7)}`);
    return parts.join('');
  });
  return [`GitHub user ${username}, public repositories:`, ...lines].join('\n');
}

/** Public repositories of a user via the unauthenticated REST API (own, non-fork repos). */
export async function fetchGithub(
  username: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<GithubResult> {
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(
      `https://api.github.com/users/${encodeURIComponent(username)}/repos?type=owner&sort=pushed&per_page=100`,
      {
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'weapons-of-mass-application',
          'x-github-api-version': '2022-11-28',
        },
      },
    );
    if (res.status === 404) return { outcome: 'not_found' };
    if (res.status !== 200) return { outcome: 'unavailable' };
    const body = (await res.json()) as ApiRepo[];
    const repos = body
      .filter((r) => !r.fork && !r.private)
      .map((r) => ({
        name: r.name,
        description: r.description,
        language: r.language,
        pushed_at: r.pushed_at,
      }));
    return { outcome: 'ok', repos, text: reposToText(username, repos) };
  } catch {
    return { outcome: 'unavailable' };
  }
}
