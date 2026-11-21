// clock.ts — Cached deterministic logical clock.
//
// ABSOLUTE RULE: nothing in this codebase may call Date.now(), new Date()
// without a fixed argument, Math.random(), crypto.randomUUID() or
// process.hrtime(). All timestamps derive from a logical mutation tick so
// that two fresh instances replaying the same request sequence produce
// byte-identical output.
//
// The tick advances ONLY on state mutations (repo/issue/comment/PR/file
// create-update-delete, git push, PR merge). GET handlers, clone, fetch,
// ls-refs, tools/list and GraphQL queries only READ the cached strings.

let mutationTick = 0;

// Base instant: 2026-01-01T00:00:00.000Z == 1767225600000 ms since epoch.
const BASE_MS = 1767225600000;

let cachedIsoDate: string = "2026-01-01T00:00:00.000Z";
let cachedHttpDate: string = "Thu, 01 Jan 2026 00:00:00 GMT";
let cachedGitTimestamp: string = "1767225600 +0000";

export function getTick(): number {
  return mutationTick;
}

export function isoNow(): string {
  return cachedIsoDate;
}

export function httpDateNow(): string {
  return cachedHttpDate;
}

export function gitTimestampNow(): string {
  return cachedGitTimestamp;
}

// Called exactly once per state mutation. Recomputes the three cached
// string forms a single time so hot read paths never format dates.
export function advanceTick(): void {
  ++mutationTick;
  const ms = BASE_MS + mutationTick * 1000;
  const d = new Date(ms);
  cachedIsoDate = d.toISOString();
  cachedHttpDate = d.toUTCString();
  cachedGitTimestamp = String(1767225600 + mutationTick) + " +0000";
}

// Test/warmup support: reset the clock back to the base instant.
export function resetClock(): void {
  mutationTick = 0;
  cachedIsoDate = "2026-01-01T00:00:00.000Z";
  cachedHttpDate = "Thu, 01 Jan 2026 00:00:00 GMT";
  cachedGitTimestamp = "1767225600 +0000";
}
