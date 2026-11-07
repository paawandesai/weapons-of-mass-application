/** The WoMA mark: a one-page resume folded into a missile, fins on, launched. */
export function Mark({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg
      className="mark"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <g transform="rotate(45 32 32)">
        <rect x="28" y="46" width="8" height="11" fill="var(--khaki)" />
        <polygon points="22,38 11,53 22,49" fill="var(--orange)" />
        <polygon points="42,38 53,53 42,49" fill="var(--orange)" />
        <rect x="22" y="18" width="20" height="30" fill="var(--bone)" />
        <polygon points="32,3 21,19 43,19" fill="var(--orange)" />
        <g stroke="var(--olive)" strokeWidth="2.4" strokeLinecap="square">
          <line x1="26" y1="25" x2="38" y2="25" />
          <line x1="26" y1="30" x2="38" y2="30" />
          <line x1="26" y1="35" x2="38" y2="35" />
          <line x1="26" y1="40" x2="35" y2="40" />
        </g>
      </g>
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <span className="wordmark-short" aria-hidden="true">
        WoMA
      </span>
      <span className="wordmark-long">Weapons of Mass Application</span>
    </span>
  );
}
