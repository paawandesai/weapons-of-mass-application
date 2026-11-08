import { Loading } from '../components/Loading';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  ApiError,
  errorMessage,
  type BoardCardData,
  type BoardColumnId,
  type BoardData,
  type SearchResult,
} from '../api';
import { BoardColumn } from '../components/BoardColumn';
import { COLUMNS } from '../components/BoardCard';
import { BoardDrawer } from '../components/BoardDrawer';
import { SearchBar } from '../components/SearchBar';
import { ToastList, useToasts } from '../components/Toast';

function findCard(
  columns: BoardData['columns'],
  id: string,
): { card: BoardCardData; column: BoardColumnId; index: number } | null {
  for (const { id: column } of COLUMNS) {
    const index = columns[column].findIndex((c) => c.id === id);
    if (index >= 0) return { card: columns[column][index]!, column, index };
  }
  return null;
}

export function BoardPage() {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const dragged = useRef<string | null>(null);
  const { toasts, push, dismiss } = useToasts();
  const openId = params.get('card');
  const waitingOnly = params.get('waiting') === '1';
  const waitingCount = board
    ? COLUMNS.reduce((n, { id }) => n + board.columns[id].filter((c) => c.attention).length, 0)
    : 0;
  const toggleWaiting = () =>
    setParams((p) => {
      const next = Object.fromEntries(p);
      if (waitingOnly) delete next.waiting;
      else next.waiting = '1';
      return next;
    });

  const load = useCallback(async () => {
    try {
      setBoard(await api.board());
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!highlightId || !board) return;
    const el = document.querySelector(`[data-card-id="${CSS.escape(highlightId)}"]`);
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [highlightId, board]);

  const move = useCallback(
    async (id: string, to: BoardColumnId) => {
      if (!board) return;
      const found = findCard(board.columns, id);
      if (!found || found.column === to) return;
      const { card, column, index } = found;
      const moved: BoardCardData = { ...card, status: to, badge: null };
      // Optimistic: the card is in its new column before the server answers.
      setBoard((b) =>
        b
          ? {
              columns: {
                ...b.columns,
                [column]: b.columns[column].filter((c) => c.id !== id),
                [to]: [moved, ...b.columns[to]],
              },
            }
          : b,
      );
      try {
        await api.moveStage(id, card.status, to);
      } catch (e) {
        // Put the card back where it was.
        setBoard((b) => {
          if (!b) return b;
          const back = [...b.columns[column].filter((c) => c.id !== id)];
          back.splice(Math.min(index, back.length), 0, card);
          return {
            columns: {
              ...b.columns,
              [to]: b.columns[to].filter((c) => c.id !== id),
              [column]: back,
            },
          };
        });
        push(
          e instanceof ApiError && e.status === 409
            ? e.message
            : `The card could not be moved. ${errorMessage(e)}`,
        );
        if (e instanceof ApiError && e.status === 409) void load();
      }
    },
    [board, load, push],
  );

  const open = useCallback(
    (id: string) => setParams((p) => ({ ...Object.fromEntries(p), card: id }), { replace: false }),
    [setParams],
  );
  const close = useCallback(
    () =>
      setParams(
        (p) => {
          const next = Object.fromEntries(p);
          delete next.card;
          return next;
        },
        { replace: false },
      ),
    [setParams],
  );
  const onSearchSelect = useCallback(
    (r: SearchResult) => {
      setHighlightId(r.application_id);
      open(r.application_id);
    },
    [open],
  );

  return (
    <section className="board-page">
      <div className="board-head">
        <h1>Board</h1>
        <button
          type="button"
          className={waitingOnly ? 'chip active' : 'chip'}
          aria-pressed={waitingOnly}
          onClick={toggleWaiting}
        >
          Waiting on you <span className="muted small">{waitingCount}</span>
        </button>
        <SearchBar onSelect={onSearchSelect} />
      </div>
      {loadError ? (
        <p role="alert" className="banner error">
          {loadError}
        </p>
      ) : null}
      {board === null && !loadError ? <Loading /> : null}
      {board ? (
        <div className="board">
          {COLUMNS.map(({ id, label }) => (
            <BoardColumn
              key={id}
              id={id}
              label={label}
              cards={waitingOnly ? board.columns[id].filter((c) => c.attention) : board.columns[id]}
              highlightId={highlightId}
              onOpen={(cardId) => {
                setHighlightId(cardId);
                open(cardId);
              }}
              onDragStart={(cardId) => {
                dragged.current = cardId;
              }}
              onDropCard={(to) => {
                const cardId = dragged.current;
                dragged.current = null;
                if (cardId) void move(cardId, to);
              }}
              onMove={(cardId, to) => void move(cardId, to)}
            />
          ))}
        </div>
      ) : null}
      {openId ? <BoardDrawer id={openId} onClose={close} /> : null}
      <ToastList toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}
