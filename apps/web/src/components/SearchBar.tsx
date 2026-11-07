import { useEffect, useId, useState } from 'react';
import { api, errorMessage, type SearchResult } from '../api';

export const SEARCH_MIN_CHARS = 2;
const DEBOUNCE_MS = 200;

const COLUMN_LABEL: Record<SearchResult['column'], string> = {
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  closed: 'Closed',
};

/** Company-name search over the user's own applications; choosing a result calls `onSelect`. */
export function SearchBar({ onSelect }: { onSelect: (result: SearchResult) => void }) {
  const inputId = useId();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const term = q.trim();

  useEffect(() => {
    if (term.length < SEARCH_MIN_CHARS) {
      setResults(null);
      setError(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api
        .searchCompanies(term)
        .then((r) => {
          if (!live) return;
          setResults(r.results);
          setError(null);
        })
        .catch((e) => live && setError(errorMessage(e)));
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [term]);

  return (
    <div className="searchbar" role="search">
      <label htmlFor={inputId} className="sr-only">
        Find a company
      </label>
      <input
        id={inputId}
        type="search"
        placeholder="Find a company"
        autoComplete="off"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
      {results !== null && !error ? (
        results.length === 0 ? (
          <p className="muted search-empty">Nothing matched “{term}”.</p>
        ) : (
          <ul className="search-results" aria-label="Search results">
            {results.map((r) => (
              <li key={r.application_id}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(r);
                    setQ('');
                    setResults(null);
                  }}
                >
                  <strong>{r.company}</strong>
                  <span>{r.title ?? 'Untitled role'}</span>
                  <span className="badge">{COLUMN_LABEL[r.column]}</span>
                  {r.badge === 'pending' ? <span className="badge partial">Pending</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
