// store.ts — the forge's entire state, held in plain in-memory maps.
//
// There is no database and no disk state: repositories, git objects,
// issues, pull requests, comments and labels all live in Map instances
// owned by this module. Factory helpers create every record, and they
// always populate the fields in a fixed order with null (never
// undefined) for absent values, which keeps object shapes stable and
// property access fast.

import { isoNow } from "./clock.ts";

export const BASE_URL = "https://forge.local";
export const ZERO_OID = "0000000000000000000000000000000000000000";

export interface GitObj {
  type: string; // "blob" | "tree" | "commit" | "tag"
  data: Buffer; // raw payload (without the "<type> <size>\0" header)
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string; // "open" | "closed"
  labels: string[]; // label names attached to the issue
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface PrRec {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string; // "open" | "closed"
  headRef: string;
  headSha: string;
  headRepoKey: string | null; // null => same repo
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
}

export interface CommentRec {
  id: number;
  issueNumber: number;
  body: string;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>; // refname -> oid (hex)
  objects: Map<string, GitObj>; // oid (hex) -> object
  issues: Map<number, IssueRec>;
  prs: Map<number, PrRec>;
  comments: Map<number, CommentRec[]>; // issue/pr number -> comments
  labels: Map<string, LabelRec>; // label name -> record
  nextNumber: number; // shared issue/PR number sequence (GitHub semantics)
}

export function repoKeyOf(owner: string, name: string): string {
  return owner + "/" + name;
}

export const repos: Map<string, RepoRec> = new Map();

// One counter per entity kind, all starting at 1. They live in a single
// record so resetStore() can restart every sequence with one loop.
const idCounters = {
  repo: 1,
  issue: 1,
  pr: 1,
  comment: 1,
  label: 1,
};

function takeId(kind: keyof typeof idCounters): number {
  const value = idCounters[kind];
  idCounters[kind] = value + 1;
  return value;
}

export function allocRepoId(): number {
  return takeId("repo");
}
export function allocIssueId(): number {
  return takeId("issue");
}
export function allocPrId(): number {
  return takeId("pr");
}
export function allocCommentId(): number {
  return takeId("comment");
}
export function allocLabelId(): number {
  return takeId("label");
}

export function makeRepo(
  owner: string,
  name: string,
  description: string | null,
  isPrivate: boolean,
  defaultBranch: string,
): RepoRec {
  const stamp = isoNow();
  const rec: RepoRec = {
    id: allocRepoId(),
    owner: owner,
    name: name,
    description: description,
    isPrivate: isPrivate,
    defaultBranch: defaultBranch,
    createdAt: stamp,
    updatedAt: stamp,
    refs: new Map(),
    objects: new Map(),
    issues: new Map(),
    prs: new Map(),
    comments: new Map(),
    labels: new Map(),
    nextNumber: 1,
  };
  return rec;
}

export function makeIssue(
  rec: RepoRec,
  title: string,
  body: string | null,
  authorLogin: string,
): IssueRec {
  const stamp = isoNow();
  const issue: IssueRec = {
    id: allocIssueId(),
    number: rec.nextNumber++,
    title: title,
    body: body,
    state: "open",
    labels: [],
    authorLogin: authorLogin,
    createdAt: stamp,
    updatedAt: stamp,
    closedAt: null,
  };
  return issue;
}

export function makePr(
  rec: RepoRec,
  title: string,
  body: string | null,
  headRef: string,
  headSha: string,
  headRepoKey: string | null,
  baseRef: string,
  baseSha: string,
  authorLogin: string,
): PrRec {
  const stamp = isoNow();
  const pr: PrRec = {
    id: allocPrId(),
    number: rec.nextNumber++,
    title: title,
    body: body,
    state: "open",
    headRef: headRef,
    headSha: headSha,
    headRepoKey: headRepoKey,
    baseRef: baseRef,
    baseSha: baseSha,
    merged: false,
    mergeCommitSha: null,
    authorLogin: authorLogin,
    createdAt: stamp,
    updatedAt: stamp,
    closedAt: null,
    mergedAt: null,
  };
  return pr;
}

export function makeComment(
  issueNumber: number,
  body: string,
  authorLogin: string,
): CommentRec {
  const stamp = isoNow();
  const comment: CommentRec = {
    id: allocCommentId(),
    issueNumber: issueNumber,
    body: body,
    authorLogin: authorLogin,
    createdAt: stamp,
    updatedAt: stamp,
  };
  return comment;
}

export function getRepo(owner: string, name: string): RepoRec | null {
  const found = repos.get(repoKeyOf(owner, name));
  return found === undefined ? null : found;
}

// ---------------------------------------------------------------------------
// Byte-budgeted LRU caches for pre-encoded responses.
//
// Each cached entry remembers the mutation tick at which its bytes were
// produced. Readers compare that tick against the clock's current tick
// and only serve the entry when they match, so any mutation anywhere in
// the store quietly invalidates every stale response without the writer
// needing to know which URLs exist.
// ---------------------------------------------------------------------------

interface CacheEntry {
  body: Buffer;
  tick: number;
  size: number;
}

export class ByteLru {
  map: Map<string, CacheEntry>;
  bytes: number;
  cap: number;

  constructor(cap: number) {
    this.map = new Map();
    this.bytes = 0;
    this.cap = cap;
  }

  get(key: string): CacheEntry | null {
    const hit = this.map.get(key);
    if (hit === undefined) {
      return null;
    }
    // Re-insert at the tail so iteration order stays recency-ordered.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, body: Buffer, tick: number): void {
    const previous = this.map.get(key);
    if (previous !== undefined) {
      this.bytes -= previous.size;
      this.map.delete(key);
    }
    if (body.length > this.cap) {
      return; // a single entry larger than the budget is never cached
    }
    this.map.set(key, { body: body, tick: tick, size: body.length });
    this.bytes += body.length;
    // Evict least-recently-used entries (front of the map) until the
    // total size is back within budget.
    while (this.bytes > this.cap) {
      const oldest = this.map.keys().next();
      if (oldest.done) {
        break;
      }
      const victim = this.map.get(oldest.value);
      if (victim !== undefined) {
        this.bytes -= victim.size;
      }
      this.map.delete(oldest.value);
    }
  }

  deletePrefix(prefix: string): void {
    const doomed: string[] = [];
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) {
        doomed.push(key);
      }
    }
    for (const key of doomed) {
      const entry = this.map.get(key);
      if (entry !== undefined) {
        this.bytes -= entry.size;
      }
      this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}

// Cache of finished REST GET responses (64 MB budget).
export const respCache = new ByteLru(64 * 1024 * 1024);
// Cache of assembled git-upload-pack wire responses (200 MB budget).
export const wireCache = new ByteLru(200 * 1024 * 1024);
// In-flight wire assemblies, so concurrent identical fetches share work.
export const inflightFetch: Map<string, Promise<Buffer>> = new Map();

export function invalidateRepo(owner: string, name: string): void {
  const key = repoKeyOf(owner, name);
  // REST GET responses for a repo are keyed by their request path, and
  // wire responses by "<owner>/<name>:...", so two prefix sweeps drop
  // everything cached for the repo.
  respCache.deletePrefix("GET /api/v3/repos/" + key);
  wireCache.deletePrefix(key + ":");
}

export function resetStore(): void {
  repos.clear();
  idCounters.repo = 1;
  idCounters.issue = 1;
  idCounters.pr = 1;
  idCounters.comment = 1;
  idCounters.label = 1;
  respCache.clear();
  wireCache.clear();
  inflightFetch.clear();
}
