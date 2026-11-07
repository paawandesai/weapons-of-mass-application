/** True for a zone name the platform's Intl knows. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  /** `YYYY-MM-DD` in the zone. */
  date: string;
  /** 0..23 in the zone. */
  hour: number;
}

/** The calendar date and hour at `at` in `timeZone`. */
export function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

/** "Tue, Nov 11, 3:00 PM PST": a moment as the user reads it in their zone. */
export function formatLocal(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
    .format(at)
    .replace(/\u202f/g, ' '); // newer ICU puts a narrow no-break space before AM/PM
}

export function formatLocalDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(at);
}

const calendarDay = (date: string) => Date.parse(`${date}T00:00:00Z`);

/**
 * How far away `startsAt` is when read at `now`, in the user's own calendar: "in about 20
 * minutes", "in about an hour", "in about 3 hours", "today", "tomorrow" or "on Tuesday, Nov 11".
 * Derived from the local dates, not from a fixed number of seconds, so a 24-hour reminder that
 * crosses a DST change, or a delayed job, never claims "tomorrow" when it is not.
 */
export function relativeWhen(startsAt: Date, now: Date, timeZone: string): string {
  const minutes = Math.round((startsAt.getTime() - now.getTime()) / 60_000);
  if (minutes < 45) return `in about ${Math.max(minutes, 1)} minute${minutes === 1 ? '' : 's'}`;
  if (minutes <= 75) return 'in about an hour';
  const startDay = localParts(startsAt, timeZone).date;
  const today = localParts(now, timeZone).date;
  const days = Math.round((calendarDay(startDay) - calendarDay(today)) / 86_400_000);
  if (days === 0) {
    const hours = Math.round(minutes / 60);
    return hours <= 5 ? `in about ${hours} hours` : 'today';
  }
  if (days === 1) return 'tomorrow';
  return `on ${new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(startsAt)}`;
}
