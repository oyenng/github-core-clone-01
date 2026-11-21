// clock.ts — a logical clock for the forge; wall time is never consulted.
//
// Every timestamp the forge produces comes from one mutation counter.
// The counter starts at zero and every state-changing operation in the
// store bumps it by exactly one, so the current instant is always
// EPOCH_SECONDS + counter. Replaying the same sequence of operations
// therefore yields the same timestamps, byte for byte, on every run.
//
// Three renderings of the current instant are cached and rebuilt on each
// bump: an ISO-8601 string for JSON bodies, an IMF-fixdate for HTTP
// headers, and the "<unix> +0000" form git expects inside commits.

const EPOCH_SECONDS = 1767225600; // 2026-01-01T00:00:00.000Z

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

let counter = 0;
let isoCache = "";
let httpCache = "";
let gitCache = "";

function pad2(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

function rebuildCaches(): void {
  const instant = new Date((EPOCH_SECONDS + counter) * 1000);
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth();
  const day = instant.getUTCDate();
  const hms =
    pad2(instant.getUTCHours()) + ":" +
    pad2(instant.getUTCMinutes()) + ":" +
    pad2(instant.getUTCSeconds());
  isoCache =
    year + "-" + pad2(month + 1) + "-" + pad2(day) + "T" + hms + ".000Z";
  httpCache =
    WEEKDAY_NAMES[instant.getUTCDay()] + ", " + pad2(day) + " " +
    MONTH_NAMES[month] + " " + year + " " + hms + " GMT";
  gitCache = String(EPOCH_SECONDS + counter) + " +0000";
}

rebuildCaches();

export function getTick(): number {
  return counter;
}

export function isoNow(): string {
  return isoCache;
}

export function httpDateNow(): string {
  return httpCache;
}

export function gitTimestampNow(): string {
  return gitCache;
}

export function advanceTick(): void {
  counter += 1;
  rebuildCaches();
}

export function resetClock(): void {
  counter = 0;
  rebuildCaches();
}
