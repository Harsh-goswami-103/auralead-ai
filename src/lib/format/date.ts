/**
 * Dates are stored in UTC and shown in the workspace time zone (Workspace.timezone, default
 * Asia/Kolkata; R5). Every formatter names its zone explicitly, so output never depends on the
 * host TZ.
 */
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(kind: 'date' | 'datetime', timeZone: string): Intl.DateTimeFormat {
  const key = `${kind}|${timeZone}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(
      'en-IN',
      kind === 'date'
        ? { timeZone, day: 'numeric', month: 'short', year: 'numeric' }
        : { timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' },
    );
    cache.set(key, f);
  }
  return f;
}

function assertValid(date: Date): void {
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date');
}

/** `16 Oct 2026` */
export function formatDate(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  assertValid(date);
  return formatter('date', timeZone).format(date);
}

/** `16 Oct 2026, 1:30 am IST` */
export function formatDateTime(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  assertValid(date);
  return formatter('datetime', timeZone).format(date);
}

/** Exact UTC ISO-8601 with milliseconds, for "As of" stamps, CSV and payloads. */
export function formatUtcIso(date: Date): string {
  assertValid(date);
  return date.toISOString();
}
