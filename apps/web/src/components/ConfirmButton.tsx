import { useState } from 'react';

interface Props {
  label: string;
  question: string;
  confirmLabel: string;
  /** Shown on the confirm button while `onConfirm` is pending. */
  busyLabel?: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
}

export function ConfirmButton({
  label,
  question,
  confirmLabel,
  busyLabel = 'Working…',
  onConfirm,
  disabled,
}: Props) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="danger" disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm" role="group" aria-label={question} aria-busy={busy}>
      <span>{question}</span>
      <button
        type="button"
        className="danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setAsking(false);
          }
        }}
      >
        {busy ? busyLabel : confirmLabel}
      </button>
      <button type="button" disabled={busy} onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}
