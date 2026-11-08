export function Loading({ pad }: { pad?: boolean }) {
  return (
    <p role="status" className={`loading muted${pad ? ' pad' : ''}`}>
      <span className="spinner" aria-hidden="true" />
      Loading…
    </p>
  );
}
