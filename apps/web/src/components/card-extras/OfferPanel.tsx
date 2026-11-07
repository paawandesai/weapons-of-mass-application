import { useState } from 'react';
import { api, errorMessage, type NegotiationView } from '../../api';
import { formatDate, formatMoney, formatRange } from './money';

/** Compensation data for an offer: the posted range, comparables with source and date, the floor. */
export function OfferPanel({
  negotiation,
  applicationId,
  onChanged,
}: {
  negotiation: NegotiationView | null;
  applicationId?: string;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  async function gather() {
    if (!applicationId) return;
    setBusy(true);
    setError(null);
    try {
      await api.requestNegotiation(applicationId);
      setAsked(true);
      onChanged?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!negotiation) {
    return (
      <section className="card" aria-label="Offer">
        <h3>Offer</h3>
        <p className="muted">
          {asked
            ? 'We are gathering pay data for this offer. Check back shortly.'
            : 'Pay data for this offer has not been gathered yet.'}
        </p>
        {applicationId && !asked ? (
          <button type="button" onClick={gather} disabled={busy}>
            Gather pay data
          </button>
        ) : null}
        {error ? (
          <p role="alert" className="banner error">
            {error}
          </p>
        ) : null}
      </section>
    );
  }
  const currency = negotiation.currency;
  return (
    <section className="card" aria-label="Offer">
      <h3>Offer</h3>
      <dl className="facts">
        <dt>Posted range</dt>
        <dd>{formatRange(negotiation.posted_min, negotiation.posted_max, currency)}</dd>
        <dt>Your salary floor</dt>
        <dd>{formatMoney(negotiation.floor, currency)}</dd>
      </dl>
      <h4>Comparable pay</h4>
      {negotiation.comparables.length === 0 ? (
        <p className="muted">No comparable pay data was found for this title and location.</p>
      ) : (
        <table className="plain">
          <thead>
            <tr>
              <th>Role</th>
              <th>25th</th>
              <th>Median</th>
              <th>75th</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {negotiation.comparables.map((c, i) => (
              <tr key={`${c.title}-${c.level ?? ''}-${i}`}>
                <td>
                  {c.title}
                  {c.level ? ` (${c.level})` : ''}
                  {c.location ? <span className="muted small"> {c.location}</span> : null}
                </td>
                <td>{formatMoney(c.p25, c.currency ?? currency)}</td>
                <td>{formatMoney(c.p50, c.currency ?? currency)}</td>
                <td>{formatMoney(c.p75, c.currency ?? currency)}</td>
                <td>
                  {c.source}
                  <span className="muted small"> retrieved {formatDate(c.retrieved_at)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
