// store.ts — Pure in-memory V8 storage.
//
// Everything lives in native Map/Array structures for O(1) access with no
// FFI or SQL cost. Entity records are built by factory functions that
// always assign properties in the same order with the same types (null
// instead of undefined) so V8 keeps monomorphic object shapes and fast
// inline caches.

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

let nextRepoId = 1;
let nextIssueId = 1;
let nextPrId = 1;
let nextCommentId = 1;
let nextLabelId = 1;

export function allocRepoId(): number {
  return nextRepoId++;
}
export function allocIssueId(): number {
  return nextIssueId++;
}
export function allocPrId(): number {
  return nextPrId++;
}
export function allocCommentId(): number {
  return nextCommentId++;
}
export function allocLabelId(): number {
  return nextLabelId++;
}

export function makeRepo(
  owner: string,
  name: string,
  description: string | null,
  isPrivate: boolean,
  defaultBranch: string,
): RepoRec {
  const now = isoNow();
  const rec: RepoRec = {
    id: allocRepoId(),
    owner: owner,
    name: name,
    description: description,
    isPrivate: isPrivate,
    defaultBranch: defaultBranch,
    createdAt: now,
    updatedAt: now,
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
  const now = isoNow();
  const issue: IssueRec = {
    id: allocIssueId(),
    number: rec.nextNumber++,
    title: title,
    body: body,
    state: "open",
    labels: [],
    authorLogin: authorLogin,
    createdAt: now,
    updatedAt: now,
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
  const now = isoNow();
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
    createdAt: now,
    updatedAt: now,
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
  const now = isoNow();
  const comment: CommentRec = {
    id: allocCommentId(),
    issueNumber: issueNumber,
    body: body,
    authorLogin: authorLogin,
    createdAt: now,
    updatedAt: now,
  };
  return comment;
}

export function getRepo(owner: string, name: string): RepoRec | null {
  const rec = repos.get(repoKeyOf(owner, name));
  return rec === undefined ? null : rec;
}

// ---------------------------------------------------------------------------
// Byte-budgeted LRU caches. Response cache entries remember the mutation
// tick they were built at; a hit is only served when the tick still equals
// the current tick, so any mutation transparently invalidates stale bytes.
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
    const e = this.map.get(key);
    if (e === undefined) return null;
    // refresh recency
    this.map.delete(key);
    this.map.set(key, e);
    return e;
  }
  set(key: string, body: Buffer, tick: number): void {
    const old = this.map.get(key);
    if (old !== undefined) {
      this.bytes -= old.size;
      this.map.delete(key);
    }
    const size = body.length;
    if (size > this.cap) return; // never cache something bigger than the cap
    this.map.set(key, { body: body, tick: tick, size: size });
    this.bytes += size;
    while (this.bytes > this.cap) {
      const first = this.map.keys().next();
      if (first.done) break;
      const e = this.map.get(first.value);
      if (e !== undefined) this.bytes -= e.size;
      this.map.delete(first.value);
    }
  }
  deletePrefix(prefix: string): void {
    for (const k of this.map.keys()) {
      if (k.startsWith(prefix)) {
        const e = this.map.get(k);
        if (e !== undefined) this.bytes -= e.size;
        this.map.delete(k);
      }
    }
  }
  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}

// Pre-encoded GET response cache (headers are rebuilt from the entry's
// stored tick -> cached HTTP date, body is the exact Buffer to send).
export const respCache = new ByteLru(64 * 1024 * 1024);
// Full git-upload-pack wire-response cache (spec cap: 200 MB of the 250 MB
// total wire/pack budget).
export const wireCache = new ByteLru(200 * 1024 * 1024);
// Singleflight map for concurrent shallow-clone wire assembly.
export const inflightFetch: Map<string, Promise<Buffer>> = new Map();

export function invalidateRepo(owner: string, name: string): void {
  const key = repoKeyOf(owner, name);
  // All cached REST GETs for this repo live under /api/v3/repos/<owner>/<name>
  respCache.deletePrefix("GET /api/v3/repos/" + key);
  wireCache.deletePrefix(key + ":");
}

export function resetStore(): void {
  repos.clear();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPrId = 1;
  nextCommentId = 1;
  nextLabelId = 1;
  respCache.clear();
  wireCache.clear();
  inflightFetch.clear();
}
