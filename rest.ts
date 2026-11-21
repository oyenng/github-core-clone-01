// rest.ts — GitHub REST v3 API surface plus the shared domain operations
// (repo/issue/PR/content create + PR merge) that GraphQL and MCP reuse, so
// every surface mutates the one store in exactly the same way.

import type { IncomingMessage, ServerResponse } from "node:http";
import { advanceTick, getTick, isoNow, httpDateNow } from "./clock.ts";
import {
  type RepoRec,
  type IssueRec,
  type PrRec,
  type CommentRec,
  type LabelRec,
  BASE_URL,
  ZERO_OID,
  repos,
  repoKeyOf,
  getRepo,
  makeRepo,
  makeIssue,
  makePr,
  makeComment,
  allocLabelId,
  respCache,
  invalidateRepo,
} from "./store.ts";
import {
  getObject,
  storeObject,
  parseTree,
  parseCommit,
  makeCommit,
  flattenTree,
  buildTreeFromFlat,
  mergeFlat,
  resolveRev,
  isAncestor,
  headTarget,
} from "./git.ts";

export const VIEWER_LOGIN = "adaiversen";

// ---------------------------------------------------------------------------
// Serializers (fixed property order => monomorphic shapes, stable bytes)
// ---------------------------------------------------------------------------

export function userIdFor(login: string): number {
  if (login === VIEWER_LOGIN) return 1000;
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) % 100000;
  return h + 1;
}

export function serializeUser(login: string): Record<string, unknown> {
  const id = userIdFor(login);
  return {
    login: login,
    id: id,
    node_id: Buffer.from("User:" + id).toString("base64"),
    avatar_url: "",
    gravatar_id: "",
    url: BASE_URL + "/api/v3/users/" + login,
    html_url: BASE_URL + "/" + login,
    type: "User",
    site_admin: false,
  };
}

export function serializeRepo(rec: RepoRec): Record<string, unknown> {
  const full = rec.owner + "/" + rec.name;
  let openIssues = 0;
  for (const i of rec.issues.values()) if (i.state === "open") openIssues++;
  for (const p of rec.prs.values()) if (p.state === "open") openIssues++;
  return {
    id: rec.id,
    node_id: Buffer.from("Repository:" + rec.id).toString("base64"),
    name: rec.name,
    full_name: full,
    private: rec.isPrivate,
    owner: serializeUser(rec.owner),
    html_url: BASE_URL + "/" + full,
    description: rec.description,
    fork: false,
    url: BASE_URL + "/api/v3/repos/" + full,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    pushed_at: rec.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    forks_count: 0,
    open_issues_count: openIssues,
    default_branch: rec.defaultBranch,
    visibility: rec.isPrivate ? "private" : "public",
  };
}

function issueUrl(rec: RepoRec, number: number): string {
  return BASE_URL + "/api/v3/repos/" + rec.owner + "/" + rec.name + "/issues/" + number;
}

export function serializeLabel(rec: RepoRec, label: LabelRec): Record<string, unknown> {
  const full = rec.owner + "/" + rec.name;
  return {
    id: label.id,
    node_id: Buffer.from("Label:" + label.id).toString("base64"),
    url: BASE_URL + "/api/v3/repos/" + full + "/labels/" + encodeURIComponent(label.name),
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function serializeIssueLabels(rec: RepoRec, issue: IssueRec): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const name of issue.labels) {
    const label = rec.labels.get(name);
    if (label !== undefined) out.push(serializeLabel(rec, label));
  }
  return out;
}

export function serializeIssue(rec: RepoRec, issue: IssueRec): Record<string, unknown> {
  const comments = rec.comments.get(issue.number);
  return {
    id: issue.id,
    node_id: Buffer.from("Issue:" + issue.id).toString("base64"),
    url: issueUrl(rec, issue.number),
    repository_url: BASE_URL + "/api/v3/repos/" + rec.owner + "/" + rec.name,
    labels_url: issueUrl(rec, issue.number) + "/labels{/name}",
    comments_url: issueUrl(rec, issue.number) + "/comments",
    events_url: issueUrl(rec, issue.number) + "/events",
    html_url: BASE_URL + "/" + rec.owner + "/" + rec.name + "/issues/" + issue.number,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: serializeUser(issue.authorLogin),
    labels: serializeIssueLabels(rec, issue),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: comments === undefined ? 0 : comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: "OWNER",
  };
}

// A pull request rendered in the issue shape (GitHub lists PRs as issues).
export function serializePrAsIssue(rec: RepoRec, pr: PrRec): Record<string, unknown> {
  const comments = rec.comments.get(pr.number);
  const base: Record<string, unknown> = {
    id: pr.id,
    node_id: Buffer.from("Issue:" + pr.id).toString("base64"),
    url: issueUrl(rec, pr.number),
    repository_url: BASE_URL + "/api/v3/repos/" + rec.owner + "/" + rec.name,
    labels_url: issueUrl(rec, pr.number) + "/labels{/name}",
    comments_url: issueUrl(rec, pr.number) + "/comments",
    events_url: issueUrl(rec, pr.number) + "/events",
    html_url: BASE_URL + "/" + rec.owner + "/" + rec.name + "/issues/" + pr.number,
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    user: serializeUser(pr.authorLogin),
    labels: [],
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: comments === undefined ? 0 : comments.length,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    author_association: "OWNER",
    pull_request: {
      url: BASE_URL + "/api/v3/repos/" + rec.owner + "/" + rec.name + "/pulls/" + pr.number,
      html_url: BASE_URL + "/" + rec.owner + "/" + rec.name + "/pull/" + pr.number,
      diff_url: BASE_URL + "/" + rec.owner + "/" + rec.name + "/pull/" + pr.number + ".diff",
      patch_url: BASE_URL + "/" + rec.owner + "/" + rec.name + "/pull/" + pr.number + ".patch",
    },
  };
  return base;
}

export function serializeComment(rec: RepoRec, c: CommentRec): Record<string, unknown> {
  return {
    id: c.id,
    node_id: Buffer.from("IssueComment:" + c.id).toString("base64"),
    url: BASE_URL + "/api/v3/repos/" + rec.owner + "/" + rec.name + "/issues/comments/" + c.id,
    html_url:
      BASE_URL + "/" + rec.owner + "/" + rec.name + "/issues/" + c.issueNumber + "#issuecomment-" + c.id,
    issue_url: issueUrl(rec, c.issueNumber),
    user: serializeUser(c.authorLogin),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    author_association: "OWNER",
    body: c.body,
  };
}

function prRefSide(
  rec: RepoRec,
  pr: PrRec,
  which: "head" | "base",
): Record<string, unknown> {
  const isHead = which === "head";
  const ref = isHead ? pr.headRef : pr.baseRef;
  const sha = isHead ? pr.headSha : pr.baseSha;
  let sideRepo: RepoRec | null = rec;
  if (isHead && pr.headRepoKey !== null) {
    const r = repos.get(pr.headRepoKey);
    sideRepo = r === undefined ? null : r;
  }
  const ownerLogin = sideRepo === null ? pr.authorLogin : sideRepo.owner;
  return {
    label: ownerLogin + ":" + ref,
    ref: ref,
    sha: sha,
    user: serializeUser(ownerLogin),
    repo: sideRepo === null ? null : serializeRepo(sideRepo),
  };
}

export function prCommitStats(rec: RepoRec, pr: PrRec): { commits: number; changedFiles: number } {
  const commits = prCommitsList(rec, pr);
  const files = prFilesList(rec, pr);
  return { commits: commits.length, changedFiles: files.length };
}

export function serializePr(rec: RepoRec, pr: PrRec): Record<string, unknown> {
  const full = rec.owner + "/" + rec.name;
  const stats = prCommitStats(rec, pr);
  let additions = 0;
  let deletions = 0;
  for (const f of prFilesList(rec, pr)) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return {
    id: pr.id,
    node_id: Buffer.from("PullRequest:" + pr.id).toString("base64"),
    url: BASE_URL + "/api/v3/repos/" + full + "/pulls/" + pr.number,
    html_url: BASE_URL + "/" + full + "/pull/" + pr.number,
    diff_url: BASE_URL + "/" + full + "/pull/" + pr.number + ".diff",
    patch_url: BASE_URL + "/" + full + "/pull/" + pr.number + ".patch",
    issue_url: issueUrl(rec, pr.number),
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    user: serializeUser(pr.authorLogin),
    body: pr.body,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    labels: [],
    milestone: null,
    head: prRefSide(rec, pr, "head"),
    base: prRefSide(rec, pr, "base"),
    author_association: "OWNER",
    merged: pr.merged,
    mergeable: pr.merged ? null : true,
    mergeable_state: pr.merged ? "unknown" : "clean",
    comments: 0,
    review_comments: 0,
    commits: stats.commits,
    additions: additions,
    deletions: deletions,
    changed_files: stats.changedFiles,
  };
}

export interface IdentParts {
  name: string;
  email: string;
  date: string;
}

export function parseIdent(ident: string): IdentParts {
  const m = /^(.*)<([^>]*)>\s+(\d+)\s+([+-]\d{4})$/.exec(ident.trim());
  if (m === null) return { name: ident, email: "", date: isoNow() };
  const ts = parseInt(m[3], 10);
  return {
    name: m[1].trim(),
    email: m[2],
    date: new Date(ts * 1000).toISOString(),
  };
}

export function serializeCommit(rec: RepoRec, oid: string): Record<string, unknown> | null {
  const obj = getObject(rec, oid);
  if (obj === null || obj.type !== "commit") return null;
  const c = parseCommit(obj.data);
  const full = rec.owner + "/" + rec.name;
  const author = parseIdent(c.author);
  const committer = parseIdent(c.committer);
  return {
    sha: oid,
    node_id: Buffer.from("Commit:" + oid).toString("base64"),
    commit: {
      author: author,
      committer: committer,
      message: c.message,
      tree: {
        sha: c.tree,
        url: BASE_URL + "/api/v3/repos/" + full + "/git/trees/" + c.tree,
      },
      url: BASE_URL + "/api/v3/repos/" + full + "/git/commits/" + oid,
      comment_count: 0,
    },
    url: BASE_URL + "/api/v3/repos/" + full + "/commits/" + oid,
    html_url: BASE_URL + "/" + full + "/commit/" + oid,
    comments_url: BASE_URL + "/api/v3/repos/" + full + "/commits/" + oid + "/comments",
    author: serializeUser(author.email === "bot@forge.local" ? "forge-bot" : author.name),
    committer: serializeUser(committer.email === "bot@forge.local" ? "forge-bot" : committer.name),
    parents: c.parents.map((p) => ({
      sha: p,
      url: BASE_URL + "/api/v3/repos/" + full + "/commits/" + p,
      html_url: BASE_URL + "/" + full + "/commit/" + p,
    })),
  };
}

// The compact commit object embedded in contents create/update responses.
export function serializeGitCommit(rec: RepoRec, oid: string): Record<string, unknown> | null {
  const obj = getObject(rec, oid);
  if (obj === null || obj.type !== "commit") return null;
  const c = parseCommit(obj.data);
  const full = rec.owner + "/" + rec.name;
  return {
    sha: oid,
    node_id: Buffer.from("Commit:" + oid).toString("base64"),
    author: parseIdent(c.author),
    committer: parseIdent(c.committer),
    message: c.message,
    tree: { sha: c.tree, url: BASE_URL + "/api/v3/repos/" + full + "/git/trees/" + c.tree },
    url: BASE_URL + "/api/v3/repos/" + full + "/git/commits/" + oid,
    html_url: BASE_URL + "/" + full + "/commit/" + oid,
    parents: c.parents.map((p) => ({
      sha: p,
      url: BASE_URL + "/api/v3/repos/" + full + "/git/commits/" + p,
      html_url: BASE_URL + "/" + full + "/commit/" + p,
    })),
  };
}

// ---------------------------------------------------------------------------
// Domain operations (shared by REST, GraphQL and MCP)
// ---------------------------------------------------------------------------

export interface OpError {
  status: number;
  message: string;
}

export function createRepoOp(
  owner: string,
  name: string,
  description: string | null,
  isPrivate: boolean,
  autoInit: boolean,
  defaultBranch: string,
): RepoRec | OpError {
  if (name === "" || name.indexOf("/") >= 0 || name.indexOf(" ") >= 0) {
    return { status: 422, message: "Validation Failed: name is invalid" };
  }
  const key = repoKeyOf(owner, name);
  if (repos.has(key)) {
    return { status: 422, message: "name already exists on this account" };
  }
  advanceTick();
  const rec = makeRepo(owner, name, description, isPrivate, defaultBranch);
  repos.set(key, rec);
  if (autoInit) {
    const blob = storeObject(rec, "blob", Buffer.from("# " + name + "\n", "utf8"));
    const flat = new Map<string, { mode: string; oid: string }>();
    flat.set("README.md", { mode: "100644", oid: blob });
    const tree = buildTreeFromFlat(rec, flat);
    const commit = makeCommit(rec, tree, [], "Initial commit");
    rec.refs.set("refs/heads/" + defaultBranch, commit);
  }
  invalidateRepo(owner, name);
  return rec;
}

export function isOpError(x: unknown): x is OpError {
  return (
    typeof x === "object" &&
    x !== null &&
    "status" in x &&
    "message" in x &&
    !("refs" in x)
  );
}

export function createIssueOp(
  rec: RepoRec,
  title: string,
  body: string | null,
  authorLogin: string,
  labels?: string[],
): IssueRec {
  advanceTick();
  const issue = makeIssue(rec, title, body, authorLogin);
  if (labels !== undefined) issue.labels = labels.slice();
  rec.issues.set(issue.number, issue);
  rec.updatedAt = isoNow();
  invalidateRepo(rec.owner, rec.name);
  return issue;
}

export function createPrOp(
  rec: RepoRec,
  title: string,
  body: string | null,
  head: string,
  base: string,
  authorLogin: string,
): PrRec | OpError {
  // head may be "branch" or "owner:branch" (cross-repo).
  let headRef = head;
  let headRepo: RepoRec = rec;
  let headRepoKey: string | null = null;
  const colon = head.indexOf(":");
  if (colon >= 0) {
    const headOwner = head.slice(0, colon);
    headRef = head.slice(colon + 1);
    if (headOwner !== rec.owner) {
      const other = getRepo(headOwner, rec.name);
      if (other === null) return { status: 422, message: "Validation Failed: head repository not found" };
      headRepo = other;
      headRepoKey = repoKeyOf(headOwner, rec.name);
    }
  }
  const headSha = headRepo.refs.get("refs/heads/" + headRef);
  if (headSha === undefined) {
    return { status: 422, message: "Validation Failed: head ref does not exist" };
  }
  const baseSha = rec.refs.get("refs/heads/" + base);
  if (baseSha === undefined) {
    return { status: 422, message: "Validation Failed: base ref does not exist" };
  }
  if (headSha === baseSha) {
    return { status: 422, message: "Validation Failed: no commits between base and head" };
  }
  advanceTick();
  const pr = makePr(rec, title, body, headRef, headSha, headRepoKey, base, baseSha, authorLogin);
  rec.prs.set(pr.number, pr);
  rec.updatedAt = isoNow();
  invalidateRepo(rec.owner, rec.name);
  return pr;
}

// Find a merge base (best common ancestor) with a deterministic BFS.
export function mergeBaseOf(rec: RepoRec, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const queueA: string[] = [a];
  while (queueA.length > 0) {
    const cur = queueA.shift() as string;
    if (ancestorsOfA.has(cur)) continue;
    ancestorsOfA.add(cur);
    const obj = getObject(rec, cur);
    if (obj === null || obj.type !== "commit") continue;
    for (const p of parseCommit(obj.data).parents) queueA.push(p);
  }
  const seen = new Set<string>();
  const queueB: string[] = [b];
  while (queueB.length > 0) {
    const cur = queueB.shift() as string;
    if (ancestorsOfA.has(cur)) return cur;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(rec, cur);
    if (obj === null || obj.type !== "commit") continue;
    for (const p of parseCommit(obj.data).parents) queueB.push(p);
  }
  return null;
}

function flatOfCommit(rec: RepoRec, commitOid: string): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const obj = getObject(rec, commitOid);
  if (obj === null || obj.type !== "commit") return out;
  flattenTree(rec, parseCommit(obj.data).tree, "", out);
  return out;
}

// Commits on the head side that are not reachable from the PR's base,
// newest first.
export function prCommitsList(rec: RepoRec, pr: PrRec): string[] {
  const baseAncestors = new Set<string>();
  const baseTip = rec.refs.get("refs/heads/" + pr.baseRef);
  const startBase = baseTip === undefined ? pr.baseSha : baseTip;
  const qb: string[] = [startBase];
  while (qb.length > 0) {
    const cur = qb.shift() as string;
    if (baseAncestors.has(cur)) continue;
    baseAncestors.add(cur);
    const obj = getObject(rec, cur);
    if (obj === null || obj.type !== "commit") continue;
    for (const p of parseCommit(obj.data).parents) qb.push(p);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const q: string[] = [pr.headSha];
  while (q.length > 0) {
    const cur = q.shift() as string;
    if (seen.has(cur) || baseAncestors.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(rec, cur);
    if (obj === null || obj.type !== "commit") continue;
    out.push(cur);
    for (const p of parseCommit(obj.data).parents) q.push(p);
  }
  return out;
}

export interface PrFile {
  sha: string;
  filename: string;
  status: string; // added | removed | modified
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
}

function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number; patch: string } {
  const splitLines = (t: string): string[] => {
    if (t === "") return [];
    const parts = t.split("\n");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  };
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // LCS lengths via dynamic programming (files in scope are small).
  const m = a.length;
  const n = b.length;
  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) dp.push(new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const patchLines: string[] = [];
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      patchLines.push(" " + a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      patchLines.push("-" + a[i]);
      deletions++;
      i++;
    } else {
      patchLines.push("+" + b[j]);
      additions++;
      j++;
    }
  }
  while (i < m) {
    patchLines.push("-" + a[i]);
    deletions++;
    i++;
  }
  while (j < n) {
    patchLines.push("+" + b[j]);
    additions++;
    j++;
  }
  const header = "@@ -1," + m + " +1," + n + " @@";
  return { additions: additions, deletions: deletions, patch: header + "\n" + patchLines.join("\n") };
}

export function prFilesList(rec: RepoRec, pr: PrRec): PrFile[] {
  const baseTip = rec.refs.get("refs/heads/" + pr.baseRef);
  const baseSha = baseTip === undefined ? pr.baseSha : baseTip;
  const mb = mergeBaseOf(rec, baseSha, pr.headSha);
  const baseFlat = mb === null ? new Map<string, { mode: string; oid: string }>() : flatOfCommit(rec, mb);
  const headFlat = flatOfCommit(rec, pr.headSha);
  const files: PrFile[] = [];
  const keys = new Set<string>();
  for (const k of baseFlat.keys()) keys.add(k);
  for (const k of headFlat.keys()) keys.add(k);
  for (const path of Array.from(keys).sort()) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    const oldText = b === undefined ? "" : (getObject(rec, b.oid)?.data.toString("utf8") ?? "");
    const newText = h === undefined ? "" : (getObject(rec, h.oid)?.data.toString("utf8") ?? "");
    const d = lineDiffCounts(oldText, newText);
    files.push({
      sha: h === undefined ? b!.oid : h.oid,
      filename: path,
      status: b === undefined ? "added" : h === undefined ? "removed" : "modified",
      additions: d.additions,
      deletions: d.deletions,
      changes: d.additions + d.deletions,
      patch: d.patch,
    });
  }
  return files;
}

// True when the PR's head and its base both changed some path relative to
// the merge base, differently (a file-level three-way conflict).
export function prHasConflict(rec: RepoRec, pr: PrRec): boolean {
  const baseTip = rec.refs.get("refs/heads/" + pr.baseRef);
  if (baseTip === undefined) return false;
  const headRepo: RepoRec = pr.headRepoKey === null ? rec : (repos.get(pr.headRepoKey) ?? rec);
  const mb = mergeBaseOf(rec, baseTip, pr.headSha);
  const baseFlat = mb === null ? new Map<string, { mode: string; oid: string }>() : flatOfCommit(rec, mb);
  const oursFlat = flatOfCommit(rec, baseTip);
  const headFlat = flatOfCommit(headRepo, pr.headSha);
  const flatEq = (
    a: { mode: string; oid: string } | undefined,
    b: { mode: string; oid: string } | undefined,
  ): boolean => {
    if (a === undefined && b === undefined) return true;
    if (a === undefined || b === undefined) return false;
    return a.oid === b.oid && a.mode === b.mode;
  };
  const keys = new Set<string>();
  for (const k of baseFlat.keys()) keys.add(k);
  for (const k of oursFlat.keys()) keys.add(k);
  for (const k of headFlat.keys()) keys.add(k);
  for (const k of keys) {
    const b = baseFlat.get(k);
    const o = oursFlat.get(k);
    const t = headFlat.get(k);
    if (!flatEq(b, o) && !flatEq(b, t) && !flatEq(o, t)) return true;
  }
  return false;
}

export function mergePrOp(
  rec: RepoRec,
  pr: PrRec,
  method: string,
  commitTitle: string | null,
  commitMessage: string | null,
): { sha: string } | OpError {
  if (pr.merged) return { status: 405, message: "Pull Request already merged" };
  if (pr.state !== "open") return { status: 405, message: "Pull Request is not open" };
  const baseRefName = "refs/heads/" + pr.baseRef;
  const baseTip = rec.refs.get(baseRefName);
  if (baseTip === undefined) return { status: 404, message: "Base branch not found" };
  const headRepo: RepoRec = pr.headRepoKey === null ? rec : (repos.get(pr.headRepoKey) ?? rec);
  // Head objects live in the head repo; for same-repo PRs headRepo === rec.
  const headFlat = flatOfCommit(headRepo, pr.headSha);
  const mb = mergeBaseOf(rec, baseTip, pr.headSha);
  const baseFlat = mb === null ? new Map<string, { mode: string; oid: string }>() : flatOfCommit(rec, mb);
  const oursFlat = flatOfCommit(rec, baseTip);

  if (prHasConflict(rec, pr)) {
    return { status: 405, message: "Pull Request is not mergeable: merge conflict" };
  }

  advanceTick();
  let newCommit: string;
  if (method === "rebase") {
    // Replay head commits (oldest first) onto the base tip.
    const commits = prCommitsList(rec, pr).reverse();
    let currentTip = baseTip;
    let currentFlat = oursFlat;
    for (const c of commits) {
      const cObj = getObject(headRepo, c);
      if (cObj === null) continue;
      const cInfo = parseCommit(cObj.data);
      const parentFlat =
        cInfo.parents.length > 0 ? flatOfCommit(headRepo, cInfo.parents[0]) : new Map<string, { mode: string; oid: string }>();
      const cFlat = flatOfCommit(headRepo, c);
      const merged = mergeFlat(parentFlat, currentFlat, cFlat);
      const tree = buildTreeFromFlat(rec, merged);
      currentTip = makeCommit(rec, tree, [currentTip], cInfo.message);
      currentFlat = merged;
    }
    newCommit = currentTip;
  } else {
    const merged = mergeFlat(baseFlat, oursFlat, headFlat);
    const tree = buildTreeFromFlat(rec, merged);
    if (method === "squash") {
      const title = commitTitle !== null ? commitTitle : pr.title + " (#" + pr.number + ")";
      const msg = commitMessage !== null && commitMessage !== "" ? title + "\n\n" + commitMessage : title;
      newCommit = makeCommit(rec, tree, [baseTip], msg);
    } else {
      // merge (default)
      const title =
        commitTitle !== null
          ? commitTitle
          : "Merge pull request #" + pr.number + " from " + pr.headRef;
      const msg = commitMessage !== null && commitMessage !== "" ? title + "\n\n" + commitMessage : title;
      newCommit = makeCommit(rec, tree, [baseTip, pr.headSha], msg);
    }
  }
  rec.refs.set(baseRefName, newCommit);
  pr.merged = true;
  pr.state = "closed";
  pr.mergeCommitSha = newCommit;
  pr.mergedAt = isoNow();
  pr.closedAt = isoNow();
  pr.updatedAt = isoNow();
  rec.updatedAt = isoNow();
  invalidateRepo(rec.owner, rec.name);
  return { sha: newCommit };
}

// ---------------------------------------------------------------------------
// Contents operations
// ---------------------------------------------------------------------------

export interface ContentEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: string; // "file" | "dir"
}

export function getContentOp(
  rec: RepoRec,
  path: string,
  ref: string | null,
): { kind: "file"; entry: ContentEntry; data: Buffer } | { kind: "dir"; entries: ContentEntry[] } | null {
  const commitOid = resolveRev(rec, ref === null || ref === "" ? rec.defaultBranch : ref);
  if (commitOid === null) return null;
  const commitObj = getObject(rec, commitOid);
  if (commitObj === null || commitObj.type !== "commit") return null;
  let treeOid = parseCommit(commitObj.data).tree;
  const clean = path.replace(/^\/+|\/+$/g, "");
  if (clean === "") {
    const treeObj = getObject(rec, treeOid);
    if (treeObj === null) return null;
    const entries: ContentEntry[] = parseTree(treeObj.data).map((e) => ({
      name: e.name,
      path: e.name,
      sha: e.oid,
      size: e.mode === "40000" ? 0 : (getObject(rec, e.oid)?.data.length ?? 0),
      type: e.mode === "40000" ? "dir" : "file",
    }));
    return { kind: "dir", entries: entries };
  }
  const segs = clean.split("/");
  for (let i = 0; i < segs.length; i++) {
    const treeObj = getObject(rec, treeOid);
    if (treeObj === null || treeObj.type !== "tree") return null;
    const entry = parseTree(treeObj.data).find((e) => e.name === segs[i]);
    if (entry === undefined) return null;
    if (i === segs.length - 1) {
      if (entry.mode === "40000") {
        const sub = getObject(rec, entry.oid);
        if (sub === null) return null;
        const entries: ContentEntry[] = parseTree(sub.data).map((e) => ({
          name: e.name,
          path: clean + "/" + e.name,
          sha: e.oid,
          size: e.mode === "40000" ? 0 : (getObject(rec, e.oid)?.data.length ?? 0),
          type: e.mode === "40000" ? "dir" : "file",
        }));
        return { kind: "dir", entries: entries };
      }
      const blob = getObject(rec, entry.oid);
      if (blob === null) return null;
      return {
        kind: "file",
        entry: { name: entry.name, path: clean, sha: entry.oid, size: blob.data.length, type: "file" },
        data: blob.data,
      };
    }
    if (entry.mode !== "40000") return null;
    treeOid = entry.oid;
  }
  return null;
}

export function putContentOp(
  rec: RepoRec,
  path: string,
  content: Buffer,
  message: string,
  branch: string | null,
  sha: string | null,
): { entry: ContentEntry; commitOid: string; created: boolean } | OpError {
  const branchName = branch === null || branch === "" ? rec.defaultBranch : branch;
  const refName = "refs/heads/" + branchName;
  const tip = rec.refs.get(refName);
  const clean = path.replace(/^\/+/, "");
  if (clean === "") return { status: 422, message: "Validation Failed: path is required" };
  const flat = new Map<string, { mode: string; oid: string }>();
  if (tip !== undefined) {
    const tipObj = getObject(rec, tip);
    if (tipObj !== null && tipObj.type === "commit") {
      flattenTree(rec, parseCommit(tipObj.data).tree, "", flat);
    }
  }
  const existing = flat.get(clean);
  if (existing !== undefined) {
    if (sha === null) return { status: 422, message: "Validation Failed: sha is required when updating a file" };
    if (sha !== existing.oid) return { status: 409, message: "Conflict: sha does not match the current file" };
  }
  advanceTick();
  const blobOid = storeObject(rec, "blob", content);
  flat.set(clean, { mode: existing === undefined ? "100644" : existing.mode, oid: blobOid });
  const tree = buildTreeFromFlat(rec, flat);
  const commitOid = makeCommit(rec, tree, tip === undefined ? [] : [tip], message);
  rec.refs.set(refName, commitOid);
  rec.updatedAt = isoNow();
  invalidateRepo(rec.owner, rec.name);
  return {
    entry: { name: clean.slice(clean.lastIndexOf("/") + 1), path: clean, sha: blobOid, size: content.length, type: "file" },
    commitOid: commitOid,
    created: existing === undefined,
  };
}

export function deleteContentOp(
  rec: RepoRec,
  path: string,
  message: string,
  branch: string | null,
  sha: string | null,
): { commitOid: string } | OpError {
  const branchName = branch === null || branch === "" ? rec.defaultBranch : branch;
  const refName = "refs/heads/" + branchName;
  const tip = rec.refs.get(refName);
  if (tip === undefined) return { status: 404, message: "Branch not found" };
  const clean = path.replace(/^\/+/, "");
  const flat = new Map<string, { mode: string; oid: string }>();
  const tipObj = getObject(rec, tip);
  if (tipObj !== null && tipObj.type === "commit") {
    flattenTree(rec, parseCommit(tipObj.data).tree, "", flat);
  }
  const existing = flat.get(clean);
  if (existing === undefined) return { status: 404, message: "Not Found" };
  if (sha !== null && sha !== existing.oid) {
    return { status: 409, message: "Conflict: sha does not match the current file" };
  }
  advanceTick();
  flat.delete(clean);
  const tree = buildTreeFromFlat(rec, flat);
  const commitOid = makeCommit(rec, tree, [tip], message);
  rec.refs.set(refName, commitOid);
  rec.updatedAt = isoNow();
  invalidateRepo(rec.owner, rec.name);
  return { commitOid: commitOid };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter++;
  return "FORGE-" + requestCounter.toString(16).toUpperCase().padStart(8, "0");
}

function sendRawJson(res: ServerResponse, status: number, body: Buffer): void {
  res.sendDate = false;
  res.cork();
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Date": httpDateNow(),
    "X-GitHub-Request-Id": nextRequestId(),
    "Connection": "keep-alive",
  });
  res.end(body);
  res.uncork();
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  sendRawJson(res, status, Buffer.from(JSON.stringify(obj), "utf8"));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message: message, documentation_url: BASE_URL + "/api/v3" });
}

function sendCachedOrBuild(
  res: ServerResponse,
  cacheKey: string,
  build: () => Record<string, unknown> | unknown[],
): void {
  const entry = respCache.get(cacheKey);
  if (entry !== null && entry.tick === getTick()) {
    sendRawJson(res, 200, entry.body);
    return;
  }
  const body = Buffer.from(JSON.stringify(build()), "utf8");
  respCache.set(cacheKey, body, getTick());
  sendRawJson(res, 200, body);
}

// Split a path into segments with indexOf scanning (no regex, no URL class).
export function splitPath(path: string): string[] {
  const segs: string[] = [];
  let start = 0;
  for (let i = 0; i <= path.length; i++) {
    if (i === path.length || path.charCodeAt(i) === 47) {
      if (i > start) segs.push(decodeURIComponent(path.slice(start, i)));
      start = i + 1;
    }
  }
  return segs;
}

export function parseQuery(qs: string): Map<string, string> {
  const out = new Map<string, string>();
  if (qs === "") return out;
  let start = 0;
  for (let i = 0; i <= qs.length; i++) {
    if (i === qs.length || qs.charCodeAt(i) === 38) {
      const pair = qs.slice(start, i);
      const eq = pair.indexOf("=");
      if (eq >= 0) {
        out.set(decodeURIComponent(pair.slice(0, eq)), decodeURIComponent(pair.slice(eq + 1)));
      } else if (pair !== "") {
        out.set(decodeURIComponent(pair), "");
      }
      start = i + 1;
    }
  }
  return out;
}

// Returns null when a non-empty body is not valid JSON (the caller answers
// 400); an empty body and a non-object JSON value both read as {}.
function parseJsonBody(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const v = JSON.parse(body.toString("utf8")) as unknown;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return {};
  } catch {
    return null;
  }
}

// GitHub-style list pagination: slice `items` by page/per_page and, when the
// caller passes a response, set the Link header (absolute, same-origin URLs
// built from the request's Host header and the original query parameters).
function paginate<T>(
  req: IncomingMessage,
  res: ServerResponse,
  rawTarget: string,
  query: Map<string, string>,
  items: T[],
): T[] {
  let perPage = parseInt(query.get("per_page") ?? "30", 10);
  if (!(perPage > 0)) perPage = 30;
  if (perPage > 100) perPage = 100;
  let page = parseInt(query.get("page") ?? "1", 10);
  if (!(page > 0)) page = 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (totalPages > 1) {
    const q = rawTarget.indexOf("?");
    const pathPart = q >= 0 ? rawTarget.slice(0, q) : rawTarget;
    const host = req.headers.host ?? "localhost";
    const mk = (p: number): string => {
      const parts: string[] = [];
      let sawPage = false;
      let sawPerPage = false;
      for (const [k, v] of query) {
        if (k === "page") {
          parts.push("page=" + p);
          sawPage = true;
        } else if (k === "per_page") {
          parts.push("per_page=" + perPage);
          sawPerPage = true;
        } else {
          parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
        }
      }
      if (!sawPage) parts.push("page=" + p);
      if (!sawPerPage) parts.push("per_page=" + perPage);
      return "http://" + host + pathPart + "?" + parts.join("&");
    };
    const links: string[] = [];
    if (page < totalPages) {
      links.push("<" + mk(page + 1) + ">; rel=\"next\"");
      links.push("<" + mk(totalPages) + ">; rel=\"last\"");
    }
    if (page > 1) {
      links.push("<" + mk(1) + ">; rel=\"first\"");
      links.push("<" + mk(page - 1) + ">; rel=\"prev\"");
    }
    if (links.length > 0) res.setHeader("Link", links.join(", "));
  }
  return items.slice((page - 1) * perPage, page * perPage);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function bool(v: unknown): boolean {
  return v === true;
}

// ---------------------------------------------------------------------------
// REST router. `path` excludes the query string; `rawTarget` includes it
// (used as the response-cache key).
// ---------------------------------------------------------------------------

export function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: Map<string, string>,
  rawTarget: string,
  body: Buffer,
): void {
  const method = req.method === undefined ? "GET" : req.method;
  const segs = splitPath(path); // ["api","v3",...]
  const parsed =
    method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE"
      ? parseJsonBody(body)
      : {};
  if (parsed === null) return sendError(res, 400, "Problems parsing JSON");
  const json: Record<string, unknown> = parsed;

  // /api/v3 (the API root) and /api/v3/meta
  if (segs.length === 2 && method === "GET") {
    res.setHeader("X-Oauth-Scopes", "repo, read:org");
    sendJson(res, 200, {
      current_user_url: BASE_URL + "/api/v3/user",
      current_user_repositories_url: BASE_URL + "/api/v3/user/repos{?type,page,per_page,sort}",
      repository_url: BASE_URL + "/api/v3/repos/{owner}/{repo}",
      issue_search_url: BASE_URL + "/api/v3/search/issues?q={query}{&page,per_page,sort,order}",
      rate_limit_url: BASE_URL + "/api/v3/rate_limit",
      organization_repositories_url: BASE_URL + "/api/v3/orgs/{org}/repos{?type,page,per_page,sort}",
      emojis_url: BASE_URL + "/api/v3/emojis",
      meta_url: BASE_URL + "/api/v3/meta",
    });
    return;
  }
  if (segs.length === 3 && segs[2] === "meta" && method === "GET") {
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      installed_version: "1.0.0",
      github_services_sha: "0000000000000000000000000000000000000000",
      hooks: [],
      git: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
      code_scanning: [],
      packages: [],
      plans: [],
    });
    return;
  }

  // /api/v3/user
  if (segs.length === 3 && segs[2] === "user" && method === "GET") {
    sendJson(res, 200, serializeUser(VIEWER_LOGIN));
    return;
  }
  // /api/v3/user/repos
  if (segs.length === 4 && segs[2] === "user" && segs[3] === "repos") {
    if (method === "POST") {
      const name = str(json.name);
      if (name === null) return sendError(res, 422, "Validation Failed: name is required");
      const created = createRepoOp(
        VIEWER_LOGIN,
        name,
        str(json.description),
        bool(json.private),
        bool(json.auto_init),
        str(json.default_branch) ?? "main",
      );
      if (isOpError(created)) return sendError(res, created.status, created.message);
      sendJson(res, 201, serializeRepo(created));
      return;
    }
    if (method === "GET") {
      const list: Record<string, unknown>[] = [];
      for (const rec of repos.values()) {
        if (rec.owner === VIEWER_LOGIN) list.push(serializeRepo(rec));
      }
      sendJson(res, 200, paginate(req, res, rawTarget, query, list));
      return;
    }
  }
  // /api/v3/orgs/:org/repos
  if (segs.length === 5 && segs[2] === "orgs" && segs[4] === "repos" && method === "POST") {
    const name = str(json.name);
    if (name === null) return sendError(res, 422, "Validation Failed: name is required");
    const created = createRepoOp(
      segs[3],
      name,
      str(json.description),
      bool(json.private),
      bool(json.auto_init),
      str(json.default_branch) ?? "main",
    );
    if (isOpError(created)) return sendError(res, created.status, created.message);
    sendJson(res, 201, serializeRepo(created));
    return;
  }

  // Everything below is /api/v3/repos/:owner/:repo[/...]
  if (segs.length < 5 || segs[2] !== "repos") {
    return sendError(res, 404, "Not Found");
  }
  const owner = segs[3];
  const repoName = segs[4];
  const rec = getRepo(owner, repoName);
  const restSegs = segs.slice(5);
  const cacheKey = "GET " + rawTarget;

  if (restSegs.length === 0) {
    if (rec === null) return sendError(res, 404, "Not Found");
    if (method === "GET") {
      sendCachedOrBuild(res, cacheKey, () => serializeRepo(rec));
      return;
    }
    if (method === "PATCH") {
      advanceTick();
      const newName = str(json.name);
      const desc = json.description;
      if (typeof desc === "string" || desc === null) rec.description = desc as string | null;
      if (typeof json.private === "boolean") rec.isPrivate = json.private;
      const db = str(json.default_branch);
      if (db !== null) rec.defaultBranch = db;
      rec.updatedAt = isoNow();
      if (newName !== null && newName !== rec.name) {
        repos.delete(repoKeyOf(rec.owner, rec.name));
        rec.name = newName;
        repos.set(repoKeyOf(rec.owner, rec.name), rec);
      }
      invalidateRepo(rec.owner, rec.name);
      sendJson(res, 200, serializeRepo(rec));
      return;
    }
    if (method === "DELETE") {
      advanceTick();
      repos.delete(repoKeyOf(owner, repoName));
      invalidateRepo(owner, repoName);
      res.sendDate = false;
      res.writeHead(204, {
        "Date": httpDateNow(),
        "X-GitHub-Request-Id": nextRequestId(),
        "Connection": "keep-alive",
      });
      res.end();
      return;
    }
    return sendError(res, 404, "Not Found");
  }

  if (rec === null) return sendError(res, 404, "Not Found");
  const full = rec.owner + "/" + rec.name;

  // ---- branches ----
  if (restSegs[0] === "branches") {
    if (restSegs.length === 1 && method === "GET") {
      sendCachedOrBuild(res, cacheKey, () => {
        const out: Record<string, unknown>[] = [];
        for (const refName of Array.from(rec.refs.keys()).sort()) {
          if (!refName.startsWith("refs/heads/")) continue;
          const branch = refName.slice("refs/heads/".length);
          out.push({
            name: branch,
            commit: {
              sha: rec.refs.get(refName),
              url: BASE_URL + "/api/v3/repos/" + full + "/commits/" + rec.refs.get(refName),
            },
            protected: false,
          });
        }
        return out;
      });
      return;
    }
    if (restSegs.length === 2 && method === "GET") {
      const branch = restSegs[1];
      const sha = rec.refs.get("refs/heads/" + branch);
      if (sha === undefined) return sendError(res, 404, "Branch not found");
      sendCachedOrBuild(res, cacheKey, () => ({
        name: branch,
        commit: {
          sha: sha,
          url: BASE_URL + "/api/v3/repos/" + full + "/commits/" + sha,
        },
        protected: false,
      }));
      return;
    }
  }

  // ---- commits ----
  if (restSegs[0] === "commits") {
    if (restSegs.length === 1 && method === "GET") {
      const shaParam = query.get("sha") ?? rec.defaultBranch;
      const tip = resolveRev(rec, shaParam);
      if (tip === null) return sendError(res, 404, "No commits found");
      const perPage = parseInt(query.get("per_page") ?? "30", 10) || 30;
      const page = parseInt(query.get("page") ?? "1", 10) || 1;
      sendCachedOrBuild(res, cacheKey, () => {
        const ordered: string[] = [];
        const seen = new Set<string>();
        const queue: string[] = [tip];
        while (queue.length > 0) {
          const cur = queue.shift() as string;
          if (seen.has(cur)) continue;
          seen.add(cur);
          const obj = getObject(rec, cur);
          if (obj === null || obj.type !== "commit") continue;
          ordered.push(cur);
          for (const p of parseCommit(obj.data).parents) queue.push(p);
        }
        const slice = ordered.slice((page - 1) * perPage, page * perPage);
        const out: Record<string, unknown>[] = [];
        for (const oid of slice) {
          const s = serializeCommit(rec, oid);
          if (s !== null) out.push(s);
        }
        return out;
      });
      return;
    }
    if (restSegs.length === 2 && method === "GET") {
      const s = serializeCommit(rec, restSegs[1]);
      if (s === null) return sendError(res, 404, "Not Found");
      sendCachedOrBuild(res, cacheKey, () => s);
      return;
    }
  }

  // ---- git refs ----
  if (restSegs[0] === "git" && restSegs[1] === "refs") {
    if (method === "POST" && restSegs.length === 2) {
      const ref = str(json.ref);
      const sha = str(json.sha);
      if (ref === null || sha === null || !ref.startsWith("refs/")) {
        return sendError(res, 422, "Validation Failed: ref and sha are required");
      }
      const target = getObject(rec, sha);
      if (target === null) return sendError(res, 422, "Validation Failed: object does not exist");
      advanceTick();
      rec.refs.set(ref, sha);
      rec.updatedAt = isoNow();
      invalidateRepo(rec.owner, rec.name);
      sendJson(res, 201, {
        ref: ref,
        node_id: Buffer.from("Ref:" + ref).toString("base64"),
        url: BASE_URL + "/api/v3/repos/" + full + "/git/refs/" + ref.slice("refs/".length),
        object: {
          sha: sha,
          type: target.type,
          url: BASE_URL + "/api/v3/repos/" + full + "/git/commits/" + sha,
        },
      });
      return;
    }
    if (method === "DELETE" && restSegs.length >= 3) {
      const exact = "refs/" + restSegs.slice(2).join("/");
      if (!rec.refs.has(exact)) return sendError(res, 422, "Validation Failed: reference does not exist");
      advanceTick();
      rec.refs.delete(exact);
      rec.updatedAt = isoNow();
      invalidateRepo(rec.owner, rec.name);
      res.sendDate = false;
      res.writeHead(204, {
        "Date": httpDateNow(),
        "X-GitHub-Request-Id": nextRequestId(),
        "Connection": "keep-alive",
      });
      res.end();
      return;
    }
    if (method === "GET") {
      const sub = restSegs.slice(2).join("/");
      const serializeRef = (refName: string): Record<string, unknown> => ({
        ref: refName,
        node_id: Buffer.from("Ref:" + refName).toString("base64"),
        url: BASE_URL + "/api/v3/repos/" + full + "/git/refs/" + refName.slice("refs/".length),
        object: {
          sha: rec.refs.get(refName),
          type: getObject(rec, rec.refs.get(refName) as string)?.type ?? "commit",
          url: BASE_URL + "/api/v3/repos/" + full + "/git/commits/" + rec.refs.get(refName),
        },
      });
      if (sub === "") {
        sendCachedOrBuild(res, cacheKey, () =>
          Array.from(rec.refs.keys()).sort().map(serializeRef),
        );
        return;
      }
      const exact = "refs/" + sub;
      if (rec.refs.has(exact)) {
        sendCachedOrBuild(res, cacheKey, () => serializeRef(exact));
        return;
      }
      // Namespace listing (e.g. git/refs/heads).
      const prefix = exact + "/";
      const matches = Array.from(rec.refs.keys()).filter((r) => r.startsWith(prefix)).sort();
      if (matches.length > 0) {
        sendCachedOrBuild(res, cacheKey, () => matches.map(serializeRef));
        return;
      }
      return sendError(res, 404, "Not Found");
    }
  }

  // ---- contents ----
  if (restSegs[0] === "contents") {
    const contentPath = restSegs.slice(1).join("/");
    if (method === "GET") {
      const result = getContentOp(rec, contentPath, query.get("ref") ?? null);
      if (result === null) return sendError(res, 404, "Not Found");
      sendCachedOrBuild(res, cacheKey, () => {
        const entryJson = (e: ContentEntry): Record<string, unknown> => ({
          name: e.name,
          path: e.path,
          sha: e.sha,
          size: e.size,
          url: BASE_URL + "/api/v3/repos/" + full + "/contents/" + e.path,
          html_url: BASE_URL + "/" + full + "/blob/" + rec.defaultBranch + "/" + e.path,
          git_url: BASE_URL + "/api/v3/repos/" + full + "/git/blobs/" + e.sha,
          download_url: null,
          type: e.type,
          _links: {
            self: BASE_URL + "/api/v3/repos/" + full + "/contents/" + e.path,
            git: BASE_URL + "/api/v3/repos/" + full + "/git/blobs/" + e.sha,
            html: BASE_URL + "/" + full + "/blob/" + rec.defaultBranch + "/" + e.path,
          },
        });
        if (result.kind === "dir") return result.entries.map(entryJson);
        return {
          name: result.entry.name,
          path: result.entry.path,
          sha: result.entry.sha,
          size: result.entry.size,
          url: BASE_URL + "/api/v3/repos/" + full + "/contents/" + result.entry.path,
          html_url: BASE_URL + "/" + full + "/blob/" + rec.defaultBranch + "/" + result.entry.path,
          git_url: BASE_URL + "/api/v3/repos/" + full + "/git/blobs/" + result.entry.sha,
          download_url: null,
          type: "file",
          encoding: "base64",
          content: result.data.toString("base64"),
          _links: {
            self: BASE_URL + "/api/v3/repos/" + full + "/contents/" + result.entry.path,
            git: BASE_URL + "/api/v3/repos/" + full + "/git/blobs/" + result.entry.sha,
            html: BASE_URL + "/" + full + "/blob/" + rec.defaultBranch + "/" + result.entry.path,
          },
        };
      });
      return;
    }
    if (method === "PUT") {
      const message = str(json.message);
      const contentB64 = str(json.content);
      if (message === null || contentB64 === null) {
        return sendError(res, 422, "Validation Failed: message and content are required");
      }
      const content = Buffer.from(contentB64.replace(/\n/g, ""), "base64");
      const result = putContentOp(rec, contentPath, content, message, str(json.branch), str(json.sha));
      if (isOpError(result)) return sendError(res, result.status, result.message);
      sendJson(res, result.created ? 201 : 200, {
        content: {
          name: result.entry.name,
          path: result.entry.path,
          sha: result.entry.sha,
          size: result.entry.size,
          encoding: "base64",
          url: BASE_URL + "/api/v3/repos/" + full + "/contents/" + result.entry.path,
          html_url: BASE_URL + "/" + full + "/blob/" + rec.defaultBranch + "/" + result.entry.path,
          git_url: BASE_URL + "/api/v3/repos/" + full + "/git/blobs/" + result.entry.sha,
          download_url: null,
          type: "file",
        },
        commit: serializeGitCommit(rec, result.commitOid),
      });
      return;
    }
    if (method === "DELETE") {
      const message = str(json.message);
      if (message === null) return sendError(res, 422, "Validation Failed: message is required");
      const result = deleteContentOp(rec, contentPath, message, str(json.branch), str(json.sha));
      if (isOpError(result)) return sendError(res, result.status, result.message);
      sendJson(res, 200, { content: null, commit: serializeGitCommit(rec, result.commitOid) });
      return;
    }
  }

  // ---- labels ----
  if (restSegs[0] === "labels") {
    if (restSegs.length === 1) {
      if (method === "GET") {
        const list = Array.from(rec.labels.values()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        sendJson(res, 200, paginate(req, res, rawTarget, query, list.map((l) => serializeLabel(rec, l))));
        return;
      }
      if (method === "POST") {
        const name = str(json.name);
        if (name === null || name === "") {
          return sendError(res, 422, "Validation Failed: name is required");
        }
        if (rec.labels.has(name)) {
          return sendError(res, 422, "Validation Failed: name has already been taken");
        }
        advanceTick();
        const rawColor = str(json.color) ?? "ededed";
        const label: LabelRec = {
          id: allocLabelId(),
          name: name,
          color: rawColor.replace(/^#/, "").toLowerCase(),
          description: str(json.description),
        };
        rec.labels.set(name, label);
        rec.updatedAt = isoNow();
        invalidateRepo(rec.owner, rec.name);
        sendJson(res, 201, serializeLabel(rec, label));
        return;
      }
    }
    if (restSegs.length === 2) {
      const label = rec.labels.get(restSegs[1]);
      if (method === "GET") {
        if (label === undefined) return sendError(res, 404, "Not Found");
        sendJson(res, 200, serializeLabel(rec, label));
        return;
      }
      if (method === "DELETE") {
        if (label === undefined) return sendError(res, 404, "Not Found");
        advanceTick();
        rec.labels.delete(restSegs[1]);
        for (const issue of rec.issues.values()) {
          issue.labels = issue.labels.filter((n) => n !== restSegs[1]);
        }
        rec.updatedAt = isoNow();
        invalidateRepo(rec.owner, rec.name);
        res.sendDate = false;
        res.writeHead(204, {
          "Date": httpDateNow(),
          "X-GitHub-Request-Id": nextRequestId(),
          "Connection": "keep-alive",
        });
        res.end();
        return;
      }
    }
  }

  // ---- issues ----
  if (restSegs[0] === "issues") {
    if (restSegs.length === 1) {
      if (method === "GET") {
        const state = query.get("state") ?? "open";
        const direction = query.get("direction") ?? "desc";
        const items: (IssueRec | PrRec)[] = [];
        for (const i of rec.issues.values()) items.push(i);
        for (const p of rec.prs.values()) items.push(p);
        items.sort((a, b) => (direction === "asc" ? a.number - b.number : b.number - a.number));
        const out: Record<string, unknown>[] = [];
        for (const it of items) {
          if (state !== "all" && it.state !== state) continue;
          out.push("headRef" in it ? serializePrAsIssue(rec, it as PrRec) : serializeIssue(rec, it as IssueRec));
        }
        sendJson(res, 200, paginate(req, res, rawTarget, query, out));
        return;
      }
      if (method === "POST") {
        const title = str(json.title);
        if (title === null || title === "") {
          return sendError(res, 422, "Validation Failed: title is required");
        }
        let labelNames: string[] = [];
        if (json.labels !== undefined) {
          if (!Array.isArray(json.labels)) {
            return sendError(res, 422, "Validation Failed: labels must be an array");
          }
          for (const entry of json.labels) {
            const name = typeof entry === "string" ? entry : entry !== null && typeof entry === "object" ? str((entry as Record<string, unknown>).name) : null;
            if (name === null || !rec.labels.has(name)) {
              return sendError(res, 422, "Validation Failed: labels contains an invalid label");
            }
            labelNames.push(name);
          }
        }
        const issue = createIssueOp(rec, title, str(json.body), rec.owner, labelNames);
        sendJson(res, 201, serializeIssue(rec, issue));
        return;
      }
    }
    if (restSegs.length >= 2) {
      const number = parseInt(restSegs[1], 10);
      const issue = rec.issues.get(number);
      const pr = rec.prs.get(number);
      if (restSegs.length === 2) {
        if (method === "GET") {
          if (issue !== undefined) {
            sendCachedOrBuild(res, cacheKey, () => serializeIssue(rec, issue));
            return;
          }
          if (pr !== undefined) {
            sendCachedOrBuild(res, cacheKey, () => serializePrAsIssue(rec, pr));
            return;
          }
          return sendError(res, 404, "Not Found");
        }
        if (method === "PATCH") {
          if (issue === undefined && pr === undefined) return sendError(res, 404, "Not Found");
          advanceTick();
          const target: IssueRec | PrRec = (issue !== undefined ? issue : pr) as IssueRec | PrRec;
          const title = str(json.title);
          if (title !== null) target.title = title;
          if (json.body !== undefined) target.body = str(json.body);
          const state = str(json.state);
          if (state === "closed" || state === "open") {
            target.state = state;
            target.closedAt = state === "closed" ? isoNow() : null;
          }
          target.updatedAt = isoNow();
          rec.updatedAt = isoNow();
          invalidateRepo(rec.owner, rec.name);
          sendJson(res, 200, issue !== undefined ? serializeIssue(rec, target as IssueRec) : serializePrAsIssue(rec, target as PrRec));
          return;
        }
      }
      if (restSegs.length === 3 && restSegs[2] === "comments") {
        if (issue === undefined && pr === undefined) return sendError(res, 404, "Not Found");
        if (method === "GET") {
          const list = rec.comments.get(number) ?? [];
          sendJson(res, 200, paginate(req, res, rawTarget, query, list.map((c) => serializeComment(rec, c))));
          return;
        }
        if (method === "POST") {
          const bodyText = str(json.body);
          if (bodyText === null) return sendError(res, 422, "Validation Failed: body is required");
          advanceTick();
          const comment = makeComment(number, bodyText, rec.owner);
          const list = rec.comments.get(number);
          if (list === undefined) rec.comments.set(number, [comment]);
          else list.push(comment);
          rec.updatedAt = isoNow();
          invalidateRepo(rec.owner, rec.name);
          sendJson(res, 201, serializeComment(rec, comment));
          return;
        }
      }
    }
  }

  // ---- pull requests ----
  if (restSegs[0] === "pulls") {
    if (restSegs.length === 1) {
      if (method === "GET") {
        const state = query.get("state") ?? "open";
        const headQ = query.get("head");
        const baseQ = query.get("base");
        const direction = query.get("direction") ?? "desc";
        const list = Array.from(rec.prs.values()).sort((a, b) =>
          direction === "asc" ? a.number - b.number : b.number - a.number,
        );
        const out: Record<string, unknown>[] = [];
        for (const pr of list) {
          if (state !== "all" && pr.state !== state) continue;
          if (headQ !== null && headQ !== undefined) {
            const want = headQ.indexOf(":") >= 0 ? headQ.slice(headQ.indexOf(":") + 1) : headQ;
            if (pr.headRef !== want) continue;
          }
          if (baseQ !== null && baseQ !== undefined && pr.baseRef !== baseQ) continue;
          out.push(serializePr(rec, pr));
        }
        sendJson(res, 200, paginate(req, res, rawTarget, query, out));
        return;
      }
      if (method === "POST") {
        const title = str(json.title);
        const head = str(json.head);
        const base = str(json.base);
        if (title === null || head === null || base === null) {
          return sendError(res, 422, "Validation Failed: title, head and base are required");
        }
        const pr = createPrOp(rec, title, str(json.body), head, base, rec.owner);
        if (isOpError(pr)) return sendError(res, pr.status, pr.message);
        sendJson(res, 201, serializePr(rec, pr));
        return;
      }
    }
    if (restSegs.length >= 2) {
      const number = parseInt(restSegs[1], 10);
      const pr = rec.prs.get(number);
      if (pr === undefined) return sendError(res, 404, "Not Found");
      if (restSegs.length === 2) {
        if (method === "GET") {
          sendCachedOrBuild(res, cacheKey, () => serializePr(rec, pr));
          return;
        }
        if (method === "PATCH") {
          advanceTick();
          const title = str(json.title);
          if (title !== null) pr.title = title;
          if (json.body !== undefined) pr.body = str(json.body);
          const state = str(json.state);
          if (state === "closed" || state === "open") {
            pr.state = state;
            pr.closedAt = state === "closed" ? isoNow() : null;
          }
          const newBase = str(json.base);
          if (newBase !== null && rec.refs.has("refs/heads/" + newBase)) {
            pr.baseRef = newBase;
            pr.baseSha = rec.refs.get("refs/heads/" + newBase) as string;
          }
          pr.updatedAt = isoNow();
          rec.updatedAt = isoNow();
          invalidateRepo(rec.owner, rec.name);
          sendJson(res, 200, serializePr(rec, pr));
          return;
        }
      }
      if (restSegs.length === 3 && restSegs[2] === "files" && method === "GET") {
        sendCachedOrBuild(res, cacheKey, () => {
          const full2 = full;
          return prFilesList(rec, pr).map((f) => ({
            sha: f.sha,
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            blob_url: BASE_URL + "/api/v3/repos/" + full2 + "/git/blobs/" + f.sha,
            raw_url: BASE_URL + "/" + full2 + "/raw/" + pr.headRef + "/" + f.filename,
            contents_url: BASE_URL + "/api/v3/repos/" + full2 + "/contents/" + f.filename + "?ref=" + pr.headRef,
            patch: f.patch,
          }));
        });
        return;
      }
      if (restSegs.length === 3 && restSegs[2] === "commits" && method === "GET") {
        sendCachedOrBuild(res, cacheKey, () => {
          const out: Record<string, unknown>[] = [];
          for (const oid of prCommitsList(rec, pr)) {
            const s = serializeCommit(rec, oid);
            if (s !== null) out.push(s);
          }
          return out;
        });
        return;
      }
      if (restSegs.length === 3 && restSegs[2] === "merge" && method === "PUT") {
        const method2 = str(json.merge_method) ?? "merge";
        const result = mergePrOp(rec, pr, method2, str(json.commit_title), str(json.commit_message));
        if (isOpError(result)) return sendError(res, result.status, result.message);
        sendJson(res, 200, {
          sha: result.sha,
          merged: true,
          message: "Pull Request successfully merged",
        });
        return;
      }
    }
  }

  return sendError(res, 404, "Not Found");
}
