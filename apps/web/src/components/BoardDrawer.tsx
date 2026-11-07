import { useEffect, useRef } from 'react';
import { BoardDetail } from './BoardDetail';

/** Side panel over the board that shows one card's detail. Escape or the close button dismiss it. */
export function BoardDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className="drawer" role="dialog" aria-label="Card detail">
      <div className="drawer-bar">
        <button ref={closeRef} type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <BoardDetail key={id} id={id} />
    </aside>
  );
}
