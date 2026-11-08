import { Loading } from '../components/Loading';
import {
  LLM_PURPOSE_LABELS,
  type LlmUsageResponse,
  type LlmUsageTotals,
  type LlmUsageWindow,
} from '@wma/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage, formatTime } from '../api';

/** Backends that run a logged-in CLI on a subscription; the others bill per token. */
const SUBSCRIPTION_BACKENDS = ['claude-code', 'codex', 'grok'];

const WINDOWS: Array<{ key: LlmUsageWindow; label: string }> = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'all', label: 'All time' },
];

/** Dollars with cents for the headline; sub-cent figures keep two more digits so they are not shown as $0.00. */
export function formatUsd(n: number | null): string {
  if (n === null) return 'not priced';
  if (n === 0) return '$0.00';
  const digits = n < 0.01 ? 4 : 2;
  return `$${n.toFixed(digits)}`;
}

const formatTokens = (n: number) => n.toLocaleString();

function tokens(
  t: Pick<
    LlmUsageTotals,
    'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'
  >,
): string {
  const cached = t.cache_read_input_tokens + t.cache_creation_input_tokens;
  return `${formatTokens(t.input_tokens + cached)} in · ${formatTokens(t.output_tokens)} out`;
}

export function UsagePage() {
  const [window, setWindow] = useState<LlmUsageWindow>('30d');
  const [data, setData] = useState<LlmUsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    api
      .usage(window)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [window]);

  if (error)
    return (
      <p role="alert" className="banner error">
        {error}
      </p>
    );

  return (
    <section>
      <h1>Usage</h1>
      <p className="muted">
        What the agent has spent on model calls for you: building your profile, judging postings,
        writing applications, reading recruiter mail, and preparing for interviews. Costs are
        estimates from the published per-token prices.
      </p>
      <div className="usage-windows" role="group" aria-label="Period">
        {WINDOWS.map((w) => (
          <button
            key={w.key}
            type="button"
            className={w.key === window ? 'chip active' : 'chip'}
            aria-pressed={w.key === window}
            onClick={() => setWindow(w.key)}
          >
            {w.label}
          </button>
        ))}
      </div>

      {!data ? (
        <Loading />
      ) : (
        <>
          {SUBSCRIPTION_BACKENDS.includes(data.backend) ? (
            <div className="card usage-pace" aria-label="Subscription pace">
              <strong>Running on your {data.backend} subscription</strong>
              <span>
                {data.pace.last_5h.calls} {data.pace.last_5h.calls === 1 ? 'call' : 'calls'} in the
                last 5 hours · {data.pace.last_24h.calls} in the last 24 hours (
                {tokens(data.pace.last_24h)})
              </span>
              <span className="muted">
                Plans cap usage per 5-hour window and per week. If runs start failing, lower
                JUDGE_CAP_PER_RUN. Dollar figures below are what the same calls would cost on the
                API, not what you pay.
              </span>
            </div>
          ) : null}
          <div className="card usage-total" aria-label="Total">
            <span className="usage-amount">{formatUsd(data.total.cost_usd)}</span>
            <span className="muted">
              {data.total.calls} model {data.total.calls === 1 ? 'call' : 'calls'} ·{' '}
              {tokens(data.total)}
              {data.total.unpriced_calls > 0 ? ` · ${data.total.unpriced_calls} not priced` : ''}
            </span>
          </div>

          <h2>By activity</h2>
          {data.by_purpose.length === 0 ? (
            <p className="muted">No model calls in this period.</p>
          ) : (
            <table className="plain" aria-label="Cost by activity">
              <thead>
                <tr>
                  <th>Activity</th>
                  <th>Calls</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.by_purpose.map((p) => (
                  <tr key={p.purpose}>
                    <td>{LLM_PURPOSE_LABELS[p.purpose] ?? p.purpose}</td>
                    <td>{p.calls}</td>
                    <td>{tokens(p)}</td>
                    <td>{formatUsd(p.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>By application</h2>
          {data.by_application.length === 0 ? (
            <p className="muted">No application has used the model in this period.</p>
          ) : (
            <table className="plain" aria-label="Cost by application">
              <thead>
                <tr>
                  <th>Application</th>
                  <th>Calls</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.by_application.map((a) => (
                  <tr key={a.application_id}>
                    <td>
                      <Link to={`/applications/${a.application_id}`}>
                        {a.title ?? 'Application'}
                        {a.company ? ` at ${a.company}` : ''}
                      </Link>
                    </td>
                    <td>{a.calls}</td>
                    <td>{tokens(a)}</td>
                    <td>{formatUsd(a.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>Recent calls</h2>
          {data.recent.length === 0 ? (
            <p className="muted">Nothing yet.</p>
          ) : (
            <table className="plain" aria-label="Recent model calls">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Activity</th>
                  <th>Prompt</th>
                  <th>Model</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr key={r.id}>
                    <td>{formatTime(r.at)}</td>
                    <td>{LLM_PURPOSE_LABELS[r.purpose] ?? r.purpose}</td>
                    <td>{r.prompt}</td>
                    <td>{r.model}</td>
                    <td>{tokens(r)}</td>
                    <td>{formatUsd(r.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
