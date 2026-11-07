export class HttpError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network' | 'status',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Concurrent requests per host (default 2). */
  perHost?: number;
  /** Retries on 429, 5xx, timeout and network errors (default 2). */
  retries?: number;
  backoffMs?: number;
}

export interface GetInit {
  headers?: Record<string, string>;
  redirect?: 'follow' | 'manual';
  /** Overrides the per-host limit; applies only to the first request to a host. */
  hostLimit?: number;
}

/**
 * A fully read response. The body is consumed while the request still holds its per-host permit,
 * so the concurrency limit covers the download and not just the time to the first header.
 */
export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  text(): string;
  /** Throws when the body is not JSON. */
  json<T = unknown>(): T;
}

export interface Http {
  /** Resolves with the final response, whatever its status; throws HttpError on timeout/network. */
  get(url: string, init?: GetInit): Promise<HttpResponse>;
  /** Parsed JSON of a 2xx response; throws HttpError for any other status. */
  json<T = unknown>(url: string, init?: GetInit): Promise<T>;
}

class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function buffered(res: Response, body: string): HttpResponse {
  return {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    text: () => body,
    json: <T>() => JSON.parse(body) as T,
  };
}

/** HTTP client with a per-host concurrency cap, timeouts, and exponential backoff on 429/5xx. */
export function createHttp(options: HttpOptions = {}): Http {
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = options.retries ?? 2;
  const backoffMs = options.backoffMs ?? 500;
  const hosts = new Map<string, Semaphore>();

  const semaphoreFor = (host: string, limit: number) => {
    let s = hosts.get(host);
    if (!s) hosts.set(host, (s = new Semaphore(limit)));
    return s;
  };

  async function get(url: string, init: GetInit = {}): Promise<HttpResponse> {
    const host = new URL(url).host;
    const sem = semaphoreFor(host, init.hostLimit ?? options.perHost ?? 2);
    await sem.acquire();
    // The permit is held until the body has been read (or the attempt failed), not merely until
    // the headers arrive: a slow stream must not let more downloads in than the limit allows.
    try {
      let lastError: HttpError | null = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await doFetch(url, {
            headers: { accept: 'application/json, text/html;q=0.8', ...init.headers },
            redirect: init.redirect ?? 'follow',
            signal: controller.signal,
          });
          const retryable = res.status === 429 || res.status >= 500;
          if (retryable && attempt < retries) {
            lastError = new HttpError('status', `${url} -> ${res.status}`, res.status);
            void res.body?.cancel().catch(() => {});
            continue;
          }
          return buffered(res, await res.text());
        } catch (e) {
          const timedOut =
            controller.signal.aborted ||
            (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'));
          lastError = new HttpError(
            timedOut ? 'timeout' : 'network',
            `${url}: ${e instanceof Error ? e.message : String(e)}`,
          );
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError ?? new HttpError('network', url);
    } finally {
      sem.release();
    }
  }

  return {
    get,
    async json<T>(url: string, init?: GetInit): Promise<T> {
      const res = await get(url, init);
      if (!res.ok) throw new HttpError('status', `${url} -> ${res.status}`, res.status);
      try {
        return res.json<T>();
      } catch {
        throw new HttpError('status', `${url}: body is not JSON`, res.status);
      }
    },
  };
}

/** Process-wide client so per-host limits hold across concurrent calls. */
let shared: Http | null = null;
export const sharedHttp = (): Http => (shared ??= createHttp());

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
