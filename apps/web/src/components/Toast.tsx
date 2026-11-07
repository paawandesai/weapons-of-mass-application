import { useCallback, useEffect, useRef, useState } from 'react';

export interface ToastMessage {
  id: number;
  text: string;
}

const TOAST_MS = 6000;

/** Transient error messages. `push` shows one; each clears itself after a few seconds. */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((text: string) => {
    const id = next.current++;
    setToasts((t) => [...t, { id, text }]);
  }, []);
  return { toasts, push, dismiss };
}

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast.id, onDismiss]);
  return (
    <div role="alert" className="toast">
      <span>{toast.text}</span>
      <button type="button" className="link" onClick={() => onDismiss(toast.id)}>
        Dismiss
      </button>
    </div>
  );
}

export function ToastList({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
