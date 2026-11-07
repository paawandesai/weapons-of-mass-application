/**
 * The automated user's one decision: which confirm link in a "Pick an interview time" email to
 * press. The second offered time, or the only one; null when the email carries none. The first
 * time is the one most likely to clash with a real calendar, and any fixed choice keeps a golden
 * run deterministic.
 */
export function pickConfirmLink(bodyText: string): string | null {
  const tokens = [...bodyText.matchAll(/https?:\/\/\S+\/confirm\/([A-Za-z0-9_-]+)/g)].map(
    (m) => m[1]!,
  );
  return tokens[1] ?? tokens[0] ?? null;
}
