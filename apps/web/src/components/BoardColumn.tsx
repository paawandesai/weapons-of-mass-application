import { useState } from 'react';
import type { BoardCardData, BoardColumnId } from '../api';
import { BoardCard } from './BoardCard';

export function BoardColumn({
  id,
  label,
  cards,
  highlightId,
  onOpen,
  onDragStart,
  onDropCard,
  onMove,
}: {
  id: BoardColumnId;
  label: string;
  cards: BoardCardData[];
  highlightId: string | null;
  onOpen: (id: string) => void;
  onDragStart: (id: string) => void;
  onDropCard: (to: BoardColumnId) => void;
  onMove: (id: string, to: BoardColumnId) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <section
      className={`board-column${over ? ' over' : ''}`}
      aria-label={label}
      data-column={id}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDropCard(id);
      }}
    >
      <h2>
        {label} <span className="muted small">{cards.length}</span>
      </h2>
      <div className="board-cards">
        {cards.map((c) => (
          <BoardCard
            key={c.id}
            card={c}
            column={id}
            highlighted={c.id === highlightId}
            onOpen={onOpen}
            onDragStart={onDragStart}
            onMove={onMove}
          />
        ))}
      </div>
    </section>
  );
}
