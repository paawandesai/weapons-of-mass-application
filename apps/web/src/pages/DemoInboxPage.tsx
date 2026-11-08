import { Loading } from '../components/Loading';
import { useCallback, useEffect, useState } from 'react';
import type { DemoMailboxMessage } from '@wma/shared';
import { api, errorMessage } from '../api';

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Body({ message }: { message: DemoMailboxMessage }) {
  return (
    <p className="mail-body" style={{ whiteSpace: 'pre-wrap' }}>
      {message.body.map((part, i) =>
        part.type === 'link' ? (
          <a key={i} href={part.value} target="_blank" rel="noreferrer noopener">
            {part.value}
          </a>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </p>
  );
}

/** The demo user's simulated mailbox: recruiter mail with its links, newest first. */
export function DemoInboxPage() {
  const [messages, setMessages] = useState<DemoMailboxMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    return api
      .demoMailbox()
      .then((r) => setMessages(r.messages))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <h1>Inbox</h1>
      <p>
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </p>
      {error ? (
        <p role="alert" className="banner error">
          {error}
        </p>
      ) : messages === null ? (
        <Loading />
      ) : messages.length === 0 ? (
        <p className="muted">No mail yet.</p>
      ) : (
        <ul aria-label="Messages" style={{ listStyle: 'none', padding: 0 }}>
          {messages.map((m) => (
            <li key={m.id}>
              <article aria-label={m.subject}>
                <h2>{m.subject}</h2>
                <p className="muted">
                  {m.direction === 'sent' ? `To ${m.to}` : `From ${m.from}`} · {when(m.date)}
                </p>
                <Body message={m} />
              </article>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
