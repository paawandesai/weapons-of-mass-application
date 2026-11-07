import type { ProposedSlot } from '@wma/shared';
import type { BusyInterval } from './types';

export const DEFAULT_SLOT_MINUTES = 60;

export interface NormalizedSlot {
  start: Date;
  end: Date;
  tzHint: string | null;
}

const OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Turns the classifier's options into concrete slots. Dropped, each with a note: options the model
 * marked ambiguous, options without an explicit offset (the zone cannot be inferred), unparseable
 * or inverted ranges, and options that start at or before `now`. A missing end becomes start plus
 * the default length. Repeated starts keep the first.
 */
export function normalizeSlots(
  proposed: ProposedSlot[],
  now: Date,
  zone: string,
): { slots: NormalizedSlot[]; notes: string[] } {
  const slots: NormalizedSlot[] = [];
  const notes: string[] = [];
  const seen = new Set<number>();
  for (const p of proposed) {
    const label = p.start;
    if (p.ambiguous) {
      notes.push(`Dropped "${label}": the date, year or time zone was ambiguous.`);
      continue;
    }
    if (!OFFSET_RE.test(p.start.trim()) || (p.end && !OFFSET_RE.test(p.end.trim()))) {
      notes.push(`Dropped "${label}": no time zone could be inferred.`);
      continue;
    }
    const start = new Date(p.start);
    const end = p.end ? new Date(p.end) : new Date(start.getTime() + DEFAULT_SLOT_MINUTES * 60_000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      notes.push(`Dropped "${label}": not a valid time range.`);
      continue;
    }
    if (start <= now) {
      notes.push(`Dropped "${label}": already in the past.`);
      continue;
    }
    if (seen.has(start.getTime())) continue;
    seen.add(start.getTime());
    slots.push({ start, end, tzHint: p.tz_hint ?? zone });
  }
  slots.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { slots, notes };
}

/** Any overlap counts: a slot touching a busy interval only at an edge does not. */
export const overlaps = (s: { start: Date; end: Date }, b: BusyInterval) =>
  s.start < b.end && b.start < s.end;

/** The short zone name ("PST") and the numeric offset ("GMT-8") of an instant in a zone. */
function zoneOf(d: Date, zone: string): { name: string; offset: string } {
  const get = (style: 'short' | 'shortOffset') =>
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', timeZoneName: style })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value ?? zone;
  return { name: get('short'), offset: get('shortOffset') };
}

/**
 * "Thursday, November 12, 2026, 10:00 AM to 11:00 AM PST". When the slot crosses a DST
 * transition the start and end are in different zones, so both carry their zone and offset
 * ("1:30 AM PDT (GMT-7) to 1:30 AM PST (GMT-8)"): the offered instant is never ambiguous.
 */
export function formatSlot(s: { start: Date; end: Date }, zone: string): string {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(s.start);
  const time = (d: Date) =>
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' })
      .format(d)
      .replace(/\u202f/g, ' ');
  const a = zoneOf(s.start, zone);
  const b = zoneOf(s.end, zone);
  if (a.offset === b.offset) return `${day}, ${time(s.start)} to ${time(s.end)} ${b.name}`;
  return `${day}, ${time(s.start)} ${a.name} (${a.offset}) to ${time(s.end)} ${b.name} (${b.offset})`;
}
