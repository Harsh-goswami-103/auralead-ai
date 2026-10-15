/**
 * Display helpers for the inbox (T22): times in the workspace time zone with the zone named
 * ("05:30 IST"), and the short relative hint for the window ("about 3 h left"). Pure, no hooks, so
 * both server and client components use them; they never decide eligibility.
 */
const cache = new Map<string, Intl.DateTimeFormat>();

function fmt(key: string, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${key}|${timeZone}`;
  let f = cache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat('en-IN', { timeZone, ...options });
    cache.set(k, f);
  }
  return f;
}

/** `05:30 IST` */
export function formatClockTime(date: Date, timeZone: string): string {
  return fmt('clock', timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(date);
}

/** `21 Oct` */
export function formatDayMonth(date: Date, timeZone: string): string {
  return fmt('daymonth', timeZone, { day: 'numeric', month: 'short' }).format(date);
}

/** `21 Oct, 05:30 IST` */
export function formatShortDateTime(date: Date, timeZone: string): string {
  return `${formatDayMonth(date, timeZone)}, ${formatClockTime(date, timeZone)}`;
}

/** "about 3 h left", "about 25 min left", "less than a minute left". */
export function remainingHint(msLeft: number): string {
  if (msLeft <= 60_000) return 'less than a minute left';
  const minutes = Math.round(msLeft / 60_000);
  if (minutes < 60) return `about ${minutes} min left`;
  return `about ${Math.round(minutes / 60)} h left`;
}

/** "3 h ago", "12 min ago", "2 d ago". */
export function ageHint(msAgo: number): string {
  const minutes = Math.max(0, Math.floor(msAgo / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
