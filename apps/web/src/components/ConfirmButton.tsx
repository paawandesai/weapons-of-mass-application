import { useState } from 'react';

interface Props {
  label: string;
  question: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
}

export function ConfirmButton({ label, question, confirmLabel, onConfirm, disabled }: Props) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="danger" disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm" role="group" aria-label={question}>
      <span>{question}</span>
      <button
        type="button"
        className="danger"
        onClick={async () => {
          setAsking(false);
          await onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}
