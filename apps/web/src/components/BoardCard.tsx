import { formatDate, formatPay, formatTime, type BoardCardData, type BoardColumnId } from '../api';

export const COLUMNS: { id: BoardColumnId; label: string }[] = [
  { id: 'applied', label: 'Applied' },
  { id: 'interviewing', label: 'Interviewing' },
  { id: 'offer', label: 'Offer' },
  { id: 'closed', label: 'Closed' },
];

const MODE_LABEL: Record<string, string> = { onsite: 'Onsite', hybrid: 'Hybrid', remote: 'Remote' };

export function BoardCard({
  card,
  column,
  highlighted,
  onOpen,
  onDragStart,
  onMove,
}: {
  card: BoardCardData;
  column: BoardColumnId;
  highlighted: boolean;
  onOpen: (id: string) => void;
  onDragStart: (id: string) => void;
  onMove: (id: string, to: BoardColumnId) => void;
}) {
  const pay = formatPay(card.pay_min, card.pay_max, card.currency);
  const name = card.company ?? 'Unknown company';
  return (
    <article
      className={`board-card${highlighted ? ' highlight' : ''}`}
      data-card-id={card.id}
      data-highlighted={highlighted ? 'true' : undefined}
      draggable
      onDragStart={(e) => {
        e.dataTransfer?.setData('text/plain', card.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        onDragStart(card.id);
      }}
    >
      <div className="row">
        <button type="button" className="link card-title" onClick={() => onOpen(card.id)}>
          {name}
        </button>
        {card.badge === 'pending' ? <span className="badge partial">Pending</span> : null}
      </div>
      {card.attention ? (
        <button
          type="button"
          className="badge waiting"
          data-attention={card.attention.kind}
          onClick={() => onOpen(card.id)}
        >
          Waiting on you: {card.attention.label}
        </button>
      ) : null}
      <div>{card.title ?? 'Untitled role'}</div>
      <dl className="card-facts">
        <dt>Location</dt>
        <dd>
          {card.location_mode
            ? (MODE_LABEL[card.location_mode] ?? card.location_mode)
            : 'Not listed'}
        </dd>
        <dt>Pay</dt>
        <dd>{pay ?? 'Not listed'}</dd>
        <dt>Applied</dt>
        <dd>{card.applied_at ? formatDate(card.applied_at) : 'Not yet'}</dd>
        <dt>Last activity</dt>
        <dd>{formatTime(card.last_activity_at)}</dd>
      </dl>
      <label className="move-select">
        <span className="sr-only">Move {name} to</span>
        <select
          value={column}
          aria-label={`Move ${name} to`}
          onChange={(e) => onMove(card.id, e.target.value as BoardColumnId)}
        >
          {COLUMNS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
    </article>
  );
}
