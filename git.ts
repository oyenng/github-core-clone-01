// git.ts — Hand-rolled Git object model, packfile v2/v3 codec, delta
// resolution, tree walking/merging and the Git Smart HTTP protocol
// (upload-pack v2 + v0, receive-pack v0). No child_process, no external
// git binary, no third-party code: only node:zlib / node:crypto /
// node:buffer from the standard library.

import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gitTimestampNow, httpDateNow, advanceTick, getTick } from "./clock.ts";
import {
  type GitObj,
  type RepoRec,
  ZERO_OID,
  wireCache,
  inflightFetch,
  invalidateRepo,
} from "./store.ts";

export const BOT_IDENT = "Forge Bot <bot@forge.local>";
const AGENT = "standalone-forge/1.0";

// ---------------------------------------------------------------------------
// Hashing / object store primitives
// ---------------------------------------------------------------------------

export function sha1Hex(data: Buffer): string {
  return crypto.createHash("sha1").update(data).digest("hex");
}

export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(type + " " + data.length + "\0", "utf8");
  return sha1Hex(Buffer.concat([header, data]));
}

export function storeObject(rec: RepoRec, type: string, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!rec.objects.has(oid)) {
    rec.objects.set(oid, { type: type, data: data });
  }
  return oid;
}

export function getObject(rec: RepoRec, oid: string): GitObj | null {
  const o = rec.objects.get(oid);
  return o === undefined ? null : o;
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH: Buffer = Buffer.from("0000", "ascii");
export const PKT_DELIM: Buffer = Buffer.from("0001", "ascii");
export const PKT_RESPONSE_END: Buffer = Buffer.from("0002", "ascii");

export interface Pkt {
  kind: string; // "data" | "flush" | "delim" | "response-end"
  payload: Buffer;
  next: number;
}

// Parse one pkt-line at `offset`. Returns null when no complete line remains.
export function parsePkt(buf: Buffer, offset: number): Pkt | null {
  if (offset + 4 > buf.length) return null;
  const hex = buf.toString("ascii", offset, offset + 4);
  const len = parseInt(hex, 16);
  if (Number.isNaN(len)) return null;
  if (len === 0) return { kind: "flush", payload: Buffer.alloc(0), next: offset + 4 };
  if (len === 1) return { kind: "delim", payload: Buffer.alloc(0), next: offset + 4 };
  if (len === 2) return { kind: "response-end", payload: Buffer.alloc(0), next: offset + 4 };
  if (len === 3) return { kind: "flush", payload: Buffer.alloc(0), next: offset + 4 };
  if (offset + len > buf.length) return null;
  return {
    kind: "data",
    payload: buf.subarray(offset + 4, offset + len),
    next: offset + len,
  };
}

// Side-band-64k framing: wrap `data` in band-1 frames (max 65515 data bytes
// per frame so each pkt-line stays well under the 65524 protocol maximum).
export function sideBandFrames(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < data.length; off += CHUNK) {
    const slice = data.subarray(off, Math.min(off + CHUNK, data.length));
    const frame = Buffer.allocUnsafe(slice.length + 1);
    frame[0] = 0x01;
    slice.copy(frame, 1);
    parts.push(pktLine(frame));
  }
  if (parts.length === 0) {
    const frame = Buffer.allocUnsafe(1);
    frame[0] = 0x01;
    parts.push(pktLine(frame));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Delta application (Git delta format: source size, target size, then a
// sequence of copy/insert instructions)
// ---------------------------------------------------------------------------

function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    const b = buf[p++];
    value |= (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value: value, next: p };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const src = readVarint(delta, pos);
  pos = src.next;
  if (src.value !== base.length) throw new Error("delta base size mismatch");
  const tgt = readVarint(delta, pos);
  pos = tgt.next;
  const out = Buffer.allocUnsafe(tgt.value);
  let outPos = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[pos++];
      if (op & 0x02) cpOff |= delta[pos++] << 8;
      if (op & 0x04) cpOff |= delta[pos++] << 16;
      if (op & 0x08) cpOff |= delta[pos++] << 24;
      if (op & 0x10) cpSize = delta[pos++];
      if (op & 0x20) cpSize |= delta[pos++] << 8;
      if (op & 0x40) cpSize |= delta[pos++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, outPos, cpOff, cpOff + cpSize);
      outPos += cpSize;
    } else if (op !== 0) {
      delta.copy(out, outPos, pos, pos + op);
      pos += op;
      outPos += op;
    } else {
      throw new Error("delta opcode 0");
    }
  }
  if (outPos !== tgt.value) throw new Error("delta target size mismatch");
  return out;
}

// ---------------------------------------------------------------------------
// Packfile building (deterministic: OIDs sorted lexicographically, every
// object stored whole, zlib level 0 => byte-identical output for identical
// object sets)
// ---------------------------------------------------------------------------

const TYPE_NUM: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packObjectHeader(type: string, size: number): Buffer {
  const t = TYPE_NUM[type];
  const bytes: number[] = [];
  let b = (t << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

export function buildPack(rec: RepoRec, oids: string[]): Buffer {
  const sorted = oids.slice().sort();
  const parts: Buffer[] = [];
  const head = Buffer.allocUnsafe(12);
  head.write("PACK", 0, "ascii");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(sorted.length, 8);
  parts.push(head);
  for (const oid of sorted) {
    const obj = rec.objects.get(oid);
    if (obj === undefined) continue;
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(zlib.deflateSync(obj.data, { level: 0 }));
  }
  const body = Buffer.concat(parts);
  const trailer = crypto.createHash("sha1").update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Packfile parsing (receive-pack). inflateSync tolerates trailing bytes, so
// the exact compressed length of each object is found by binary search for
// the smallest slice that inflates to the declared size.
// ---------------------------------------------------------------------------

function inflateExact(buf: Buffer, start: number, expectedSize: number): { data: Buffer; next: number } {
  let lo = 1;
  let hi = buf.length - start;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      const out = zlib.inflateSync(buf.subarray(start, start + mid));
      ok = out.length === expectedSize;
    } catch {
      ok = false;
    }
    if (ok) {
      best = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (best < 0) throw new Error("pack object inflate failed");
  const data = zlib.inflateSync(buf.subarray(start, start + best));
  return { data: data, next: start + best };
}

interface PackEntry {
  offset: number;
  typeNum: number;
  size: number;
  data: Buffer | null; // inflated payload for full objects; delta payload for deltas
  baseOid: string | null;
  baseOffset: number; // absolute pack offset for OFS_DELTA, -1 otherwise
}

const TYPE_NAME: Record<number, string> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

// Parses and stores every object of a pack stream. Returns stored OIDs.
// Throws on any structural or checksum problem (nothing is stored then for
// objects that fail delta resolution; full objects parsed before the error
// may already be stored, which is harmless — content-addressed).
export function parsePack(rec: RepoRec, pack: Buffer): string[] {
  if (pack.length < 12 + 20) throw new Error("pack too short");
  if (pack.toString("ascii", 0, 4) !== "PACK") throw new Error("bad pack magic");
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error("bad pack version");
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = crypto.createHash("sha1").update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error("pack checksum mismatch");

  const entries: PackEntry[] = [];
  const byOffset: Map<number, PackEntry> = new Map();
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const entryStart = pos;
    let b = pack[pos++];
    const typeNum = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = pack[pos++];
      size |= (b & 0x7f) * Math.pow(2, shift);
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (typeNum === 6) {
      // OFS_DELTA
      let c = pack[pos++];
      let ofs = c & 0x7f;
      while (c & 0x80) {
        c = pack[pos++];
        ofs = ((ofs + 1) << 7) | (c & 0x7f);
      }
      baseOffset = entryStart - ofs;
    } else if (typeNum === 7) {
      // REF_DELTA
      baseOid = pack.toString("hex", pos, pos + 20);
      pos += 20;
    }
    const inflated = inflateExact(pack, pos, size);
    pos = inflated.next;
    const entry: PackEntry = {
      offset: entryStart,
      typeNum: typeNum,
      size: size,
      data: inflated.data,
      baseOid: baseOid,
      baseOffset: baseOffset,
    };
    entries.push(entry);
    byOffset.set(entryStart, entry);
  }

  // Resolve entries into stored objects. Full objects first, then deltas
  // whose bases are known, iterating until no progress is made.
  const resolvedOid: Map<number, string> = new Map(); // pack offset -> oid
  const stored: string[] = [];
  let progress = true;
  let guard = 0;
  while (progress && guard++ < 1000) {
    progress = false;
    for (const e of entries) {
      if (resolvedOid.has(e.offset)) continue;
      if (e.typeNum >= 1 && e.typeNum <= 4) {
        const type = TYPE_NAME[e.typeNum];
        const oid = storeObject(rec, type, e.data as Buffer);
        resolvedOid.set(e.offset, oid);
        stored.push(oid);
        progress = true;
      } else if (e.typeNum === 6 || e.typeNum === 7) {
        let baseObj: GitObj | null = null;
        if (e.typeNum === 7 && e.baseOid !== null) {
          baseObj = getObject(rec, e.baseOid);
        } else if (e.typeNum === 6) {
          const baseEntry = byOffset.get(e.baseOffset);
          if (baseEntry !== undefined && resolvedOid.has(baseEntry.offset)) {
            baseObj = getObject(rec, resolvedOid.get(baseEntry.offset) as string);
          }
        }
        if (baseObj !== null) {
          const result = applyDelta(baseObj.data, e.data as Buffer);
          const oid = storeObject(rec, baseObj.type, result);
          resolvedOid.set(e.offset, oid);
          stored.push(oid);
          progress = true;
        }
      }
    }
  }
  if (resolvedOid.size !== entries.length) throw new Error("unresolved pack delta");
  return stored;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // "100644" | "100755" | "120000" | "40000"
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    const mode = data.toString("ascii", pos, sp);
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.toString("utf8", sp + 1, nul);
    const oid = data.toString("hex", nul + 1, nul + 21);
    entries.push({ mode: mode, name: name, oid: oid });
    pos = nul + 21;
  }
  return entries;
}

function treeSortKey(e: TreeEntry): string {
  return e.mode === "40000" ? e.name + "/" : e.name;
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = entries.slice().sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(e.mode + " " + e.name + "\0", "utf8"));
    parts.push(Buffer.from(e.oid, "hex"));
  }
  return Buffer.concat(parts);
}

// Flatten a tree (recursively) into path -> {mode, oid}.
export function flattenTree(
  rec: RepoRec,
  treeOid: string,
  prefix: string,
  out: Map<string, { mode: string; oid: string }>,
): void {
  const obj = getObject(rec, treeOid);
  if (obj === null || obj.type !== "tree") return;
  for (const e of parseTree(obj.data)) {
    const path = prefix === "" ? e.name : prefix + "/" + e.name;
    if (e.mode === "40000") {
      flattenTree(rec, e.oid, path, out);
    } else {
      out.set(path, { mode: e.mode, oid: e.oid });
    }
  }
}

// Rebuild nested trees from a flat path map; returns the root tree OID.
export function buildTreeFromFlat(
  rec: RepoRec,
  flat: Map<string, { mode: string; oid: string }>,
): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, v] of flat) {
    const segs = path.split("/");
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      let child = node.dirs.get(segs[i]);
      if (child === undefined) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(segs[i], child);
      }
      node = child;
    }
    node.files.push({ mode: v.mode, name: segs[segs.length - 1], oid: v.oid });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = node.files.slice();
    for (const [name, child] of node.dirs) {
      entries.push({ mode: "40000", name: name, oid: build(child) });
    }
    return storeObject(rec, "tree", buildTreeData(entries));
  };
  return build(root);
}

// Deterministic 3-way merge of flat tree maps. On a true conflict the
// "theirs" (head) side wins, which keeps merges total and reproducible.
export function mergeFlat(
  base: Map<string, { mode: string; oid: string }>,
  ours: Map<string, { mode: string; oid: string }>,
  theirs: Map<string, { mode: string; oid: string }>,
): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const keys = new Set<string>();
  for (const k of base.keys()) keys.add(k);
  for (const k of ours.keys()) keys.add(k);
  for (const k of theirs.keys()) keys.add(k);
  const sortedKeys = Array.from(keys).sort();
  const eq = (
    a: { mode: string; oid: string } | undefined,
    b: { mode: string; oid: string } | undefined,
  ): boolean => {
    if (a === undefined && b === undefined) return true;
    if (a === undefined || b === undefined) return false;
    return a.oid === b.oid && a.mode === b.mode;
  };
  for (const k of sortedKeys) {
    const b = base.get(k);
    const o = ours.get(k);
    const t = theirs.get(k);
    let pick: { mode: string; oid: string } | undefined;
    if (eq(o, t)) pick = o;
    else if (eq(b, o)) pick = t;
    else if (eq(b, t)) pick = o;
    else pick = t; // conflict: head wins
    if (pick !== undefined) out.set(k, pick);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString("utf8");
  const sep = text.indexOf("\n\n");
  const head = sep >= 0 ? text.slice(0, sep) : text;
  const message = sep >= 0 ? text.slice(sep + 2) : "";
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author = "";
  let committer = "";
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) author = line.slice(7);
    else if (line.startsWith("committer ")) committer = line.slice(10);
  }
  return { tree: tree, parents: parents, author: author, committer: committer, message: message };
}

export function buildCommitData(info: CommitInfo): Buffer {
  let head = "tree " + info.tree + "\n";
  for (const p of info.parents) head += "parent " + p + "\n";
  head += "author " + info.author + "\n";
  head += "committer " + info.committer + "\n";
  return Buffer.from(head + "\n" + info.message, "utf8");
}

// Create a commit authored by the forge bot at the current logical tick.
export function makeCommit(
  rec: RepoRec,
  treeOid: string,
  parents: string[],
  message: string,
): string {
  const ident = BOT_IDENT + " " + gitTimestampNow();
  return storeObject(rec, "commit", buildCommitData({
    tree: treeOid,
    parents: parents,
    author: ident,
    committer: ident,
    message: message,
  }));
}

export function commitTreeOid(rec: RepoRec, commitOid: string): string | null {
  const obj = getObject(rec, commitOid);
  if (obj === null || obj.type !== "commit") return null;
  return parseCommit(obj.data).tree;
}

// Breadth-first ancestor test (is `anc` reachable from `desc`?).
export function isAncestor(rec: RepoRec, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const queue: string[] = [desc];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(rec, cur);
    if (obj === null || obj.type !== "commit") continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

// Collect the object set for a fetch.
// - depthLimit null: full closure of wants minus the full closure of haves.
// - depthLimit N: commits within N steps of wants (their complete trees and
//   blobs); `shallow` lists the boundary commits that still have parents.
export function collectFetchObjects(
  rec: RepoRec,
  wants: string[],
  haves: string[],
  depthLimit: number | null,
): { oids: string[]; shallow: string[] } {
  const haveSet = new Set<string>(haves);
  const excluded = new Set<string>();
  if (depthLimit === null && haves.length > 0) {
    // Full closure of haves is excluded from the pack.
    const stack: string[] = haves.slice();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (excluded.has(oid)) continue;
      const obj = getObject(rec, oid);
      if (obj === null) continue;
      excluded.add(oid);
      if (obj.type === "commit") {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === "tree") {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      }
    }
  }

  const included = new Set<string>();
  const shallow: string[] = [];
  const includeTree = (treeOid: string): void => {
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (included.has(oid) || excluded.has(oid)) continue;
      const obj = getObject(rec, oid);
      if (obj === null) continue;
      included.add(oid);
      if (obj.type === "tree") {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      }
    }
  };

  if (depthLimit === null) {
    const queue: string[] = wants.slice();
    const seenCommits = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seenCommits.has(oid) || haveSet.has(oid) || excluded.has(oid)) continue;
      const obj = getObject(rec, oid);
      if (obj === null) continue;
      if (obj.type === "commit") {
        seenCommits.add(oid);
        included.add(oid);
        const c = parseCommit(obj.data);
        includeTree(c.tree);
        for (const p of c.parents) queue.push(p);
      } else {
        included.add(oid);
        if (obj.type === "tree") includeTree(oid);
      }
    }
  } else {
    // Depth-limited BFS over commits.
    let frontier: string[] = wants.slice();
    const seenCommits = new Set<string>();
    let depth = 0;
    while (frontier.length > 0 && depth < depthLimit) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (seenCommits.has(oid) || haveSet.has(oid)) continue;
        const obj = getObject(rec, oid);
        if (obj === null || obj.type !== "commit") continue;
        seenCommits.add(oid);
        included.add(oid);
        const c = parseCommit(obj.data);
        includeTree(c.tree);
        const isBoundary = depth + 1 >= depthLimit;
        for (const p of c.parents) {
          if (isBoundary) {
            if (!shallow.includes(oid)) shallow.push(oid);
          } else {
            next.push(p);
          }
        }
      }
      frontier = next;
      depth++;
    }
    shallow.sort();
  }

  const oids = Array.from(included).sort();
  return { oids: oids, shallow: shallow };
}

// ---------------------------------------------------------------------------
// Ref helpers
// ---------------------------------------------------------------------------

export function sortedRefNames(rec: RepoRec): string[] {
  return Array.from(rec.refs.keys()).sort();
}

export function headTarget(rec: RepoRec): string {
  return "refs/heads/" + rec.defaultBranch;
}

// Resolve a revision expression used by REST/GraphQL: a branch name, a full
// ref, "HEAD", or a raw commit OID. Returns a commit OID or null.
export function resolveRev(rec: RepoRec, rev: string): string | null {
  if (rev === "HEAD") {
    const t = rec.refs.get(headTarget(rec));
    return t === undefined ? null : t;
  }
  const byRef = rec.refs.get(rev);
  if (byRef !== undefined) return byRef;
  const byBranch = rec.refs.get("refs/heads/" + rev);
  if (byBranch !== undefined) return byBranch;
  const byTag = rec.refs.get("refs/tags/" + rev);
  if (byTag !== undefined) return byTag;
  const obj = getObject(rec, rev);
  if (obj !== null && obj.type === "commit") return rev;
  if (obj !== null && obj.type === "tag") {
    // Annotated tag: peel one level (payload starts "object <hex>").
    const m = /^object ([0-9a-f]{40})/.exec(obj.data.toString("utf8"));
    if (m !== null) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP plumbing shared by the git endpoints
// ---------------------------------------------------------------------------

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.sendDate = false;
  res.cork();
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": String(body.length),
    "Date": httpDateNow(),
    "Connection": "keep-alive",
    "Cache-Control": "no-cache",
  });
  res.end(body);
  res.uncork();
}

function advertisement(rec: RepoRec, capabilities: string, includeHeadCaps: boolean): Buffer {
  const parts: Buffer[] = [];
  const names = sortedRefNames(rec);
  const headOid = rec.refs.get(headTarget(rec));
  let first = true;
  const firstLine = (oid: string, name: string): Buffer => {
    if (first && includeHeadCaps) {
      first = false;
      return pktLine(oid + " " + name + "\0" + capabilities + "\n");
    }
    first = false;
    return pktLine(oid + " " + name + "\n");
  };
  if (names.length === 0) {
    parts.push(pktLine(ZERO_OID + " capabilities^{}\0" + capabilities + "\n"));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  // HEAD first (as a symref advertisement via its target oid).
  if (headOid !== undefined) parts.push(firstLine(headOid, "HEAD"));
  for (const name of names) {
    const oid = rec.refs.get(name) as string;
    parts.push(firstLine(oid, name));
    const obj = getObject(rec, oid);
    if (obj !== null && obj.type === "tag") {
      const m = /^object ([0-9a-f]{40})/.exec(obj.data.toString("utf8"));
      if (m !== null) parts.push(pktLine(m[1] + " " + name + "^{}\n"));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// GET /info/refs?service=git-upload-pack|git-receive-pack
export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  rec: RepoRec,
  service: string,
): void {
  const proto = req.headers["git-protocol"];
  const isV2 = typeof proto === "string" && proto.indexOf("version=2") >= 0;
  if (service === "git-upload-pack" && isV2) {
    const body = Buffer.concat([
      pktLine("version 2\n"),
      pktLine("agent=" + AGENT + "\n"),
      pktLine("ls-refs=unborn\n"),
      pktLine("fetch=shallow wait-for-done\n"),
      pktLine("object-format=sha1\n"),
      PKT_FLUSH,
    ]);
    sendBuffer(res, 200, "application/x-git-upload-pack-advertisement", body);
    return;
  }
  if (service === "git-upload-pack") {
    const caps =
      "multi_ack_detailed side-band-64k shallow ofs-delta symref=HEAD:" +
      headTarget(rec) +
      " agent=" +
      AGENT;
    const body = Buffer.concat([
      pktLine("# service=git-upload-pack\n"),
      PKT_FLUSH,
      advertisement(rec, caps, true),
    ]);
    sendBuffer(res, 200, "application/x-git-upload-pack-advertisement", body);
    return;
  }
  if (service === "git-receive-pack") {
    const caps =
      "report-status delete-refs side-band-64k quiet atomic ofs-delta agent=" + AGENT;
    const body = Buffer.concat([
      pktLine("# service=git-receive-pack\n"),
      PKT_FLUSH,
      advertisement(rec, caps, true),
    ]);
    sendBuffer(res, 200, "application/x-git-receive-pack-advertisement", body);
    return;
  }
  sendBuffer(res, 403, "text/plain", Buffer.from("unknown service\n"));
}

// ---------------------------------------------------------------------------
// git-upload-pack (POST)
// ---------------------------------------------------------------------------

interface FetchArgs {
  command: string;
  wants: string[];
  haves: string[];
  deepen: number | null;
  done: boolean;
  waitForDone: boolean;
  noProgress: boolean;
  symrefs: boolean;
  peel: boolean;
  unborn: boolean;
  refPrefixes: string[];
}

function parseUploadPackRequest(body: Buffer): FetchArgs {
  const args: FetchArgs = {
    command: "",
    wants: [],
    haves: [],
    deepen: null,
    done: false,
    waitForDone: false,
    noProgress: false,
    symrefs: false,
    peel: false,
    unborn: false,
    refPrefixes: [],
  };
  let pos = 0;
  let section = 0; // 0 = capability lines, 1 = arguments (after delim)
  while (pos < body.length) {
    const pkt = parsePkt(body, pos);
    if (pkt === null) break;
    pos = pkt.next;
    if (pkt.kind === "flush") break;
    if (pkt.kind === "delim") {
      section = 1;
      continue;
    }
    if (pkt.kind !== "data") continue;
    let line = pkt.payload.toString("utf8");
    if (line.endsWith("\n")) line = line.slice(0, line.length - 1);
    if (section === 0 && line.startsWith("command=")) {
      args.command = line.slice("command=".length);
      continue;
    }
    if (section === 0) continue; // other capability lines (agent=, object-format=)
    // argument lines
    if (line.startsWith("want ")) args.wants.push(line.slice(5).trim());
    else if (line.startsWith("have ")) args.haves.push(line.slice(5).trim());
    else if (line.startsWith("deepen ")) args.deepen = parseInt(line.slice(7).trim(), 10);
    else if (line === "done") args.done = true;
    else if (line === "wait-for-done") args.waitForDone = true;
    else if (line === "no-progress") args.noProgress = true;
    else if (line === "ofs-delta") { /* accepted, we never send deltas */ }
    else if (line === "symrefs") args.symrefs = true;
    else if (line === "peel") args.peel = true;
    else if (line === "unborn") args.unborn = true;
    else if (line.startsWith("ref-prefix ")) args.refPrefixes.push(line.slice("ref-prefix ".length));
    // deepen-since / deepen-not / shallow / filter / server-option: ignored
  }
  return args;
}

function lsRefsResponse(rec: RepoRec, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  const prefixes = args.refPrefixes;
  const matches = (name: string): boolean => {
    if (prefixes.length === 0) return true;
    for (const p of prefixes) if (name.startsWith(p)) return true;
    return false;
  };
  const headOid = rec.refs.get(headTarget(rec));
  if (args.symrefs || args.unborn) {
    if (matches("HEAD")) {
      if (headOid !== undefined) {
        parts.push(pktLine(headOid + " HEAD symref-target:" + headTarget(rec) + "\n"));
      } else if (args.unborn) {
        // Real git format: the line starts with the literal word "unborn".
        parts.push(pktLine("unborn HEAD symref-target:" + headTarget(rec) + "\n"));
      }
    }
  }
  for (const name of sortedRefNames(rec)) {
    if (!matches(name)) continue;
    const oid = rec.refs.get(name) as string;
    let line = oid + " " + name;
    const obj = getObject(rec, oid);
    if (args.peel && obj !== null && obj.type === "tag") {
      const m = /^object ([0-9a-f]{40})/.exec(obj.data.toString("utf8"));
      if (m !== null) line += " peeled:" + m[1];
    }
    parts.push(pktLine(line + "\n"));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function fetchWireV2(rec: RepoRec, repoKey: string, args: FetchArgs): Promise<Buffer> {
  // Spec-mandated cache key for the hot shallow-clone path.
  let cacheKey: string | null = null;
  if (args.deepen === 1 && args.wants.length === 1 && args.haves.length === 0) {
    cacheKey = repoKey + ":" + args.wants[0] + ":d1";
  } else {
    cacheKey =
      repoKey +
      ":w=" + args.wants.slice().sort().join(",") +
      ":h=" + args.haves.slice().sort().join(",") +
      ":d=" + (args.deepen === null ? "full" : String(args.deepen)) +
      ":t" + getTick();
  }
  const hit = wireCache.get(cacheKey);
  if (hit !== null) return hit.body;
  const inflight = inflightFetch.get(cacheKey);
  if (inflight !== undefined) return inflight;

  const build = (): Buffer => {
    const { oids, shallow } = collectFetchObjects(rec, args.wants, args.haves, args.deepen);
    const pack = buildPack(rec, oids);
    const parts: Buffer[] = [];
    if (args.deepen !== null && shallow.length > 0) {
      parts.push(pktLine("shallow-info\n"));
      for (const s of shallow) parts.push(pktLine("shallow " + s + "\n"));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine("packfile\n"));
    parts.push(sideBandFrames(pack));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  };

  const promise = Promise.resolve().then(build);
  inflightFetch.set(cacheKey, promise);
  try {
    const wire = await promise;
    wireCache.set(cacheKey, wire, getTick());
    return wire;
  } finally {
    inflightFetch.delete(cacheKey);
  }
}

// Protocol v0 upload-pack request: "want <oid> <caps>" lines, flush, then
// "have" lines and a final "done" line (not pkt-framed after the flush in
// some clients; git sends have/done as plain lines).
function handleUploadPackV0(res: ServerResponse, rec: RepoRec, body: Buffer): void {
  const wants: string[] = [];
  const haves: string[] = [];
  let deepen: number | null = null;
  let pos = 0;
  while (pos < body.length) {
    const pkt = parsePkt(body, pos);
    if (pkt === null) break;
    pos = pkt.next;
    if (pkt.kind === "flush" || pkt.kind === "delim") continue;
    if (pkt.kind !== "data") continue;
    let line = pkt.payload.toString("utf8");
    if (line.endsWith("\n")) line = line.slice(0, line.length - 1);
    if (line.startsWith("want ")) {
      const restOfLine = line.slice(5);
      const sp = restOfLine.indexOf(" ");
      wants.push((sp >= 0 ? restOfLine.slice(0, sp) : restOfLine).trim());
    } else if (line.startsWith("have ")) {
      haves.push(line.slice(5).trim());
    } else if (line.startsWith("deepen ")) {
      deepen = parseInt(line.slice(7).trim(), 10);
    }
    // "done" needs no handling: the request is complete by construction.
  }
  const { oids, shallow } = collectFetchObjects(rec, wants, haves, deepen);
  const pack = buildPack(rec, oids);
  const parts: Buffer[] = [];
  if (deepen !== null) {
    for (const s of shallow) parts.push(pktLine("shallow " + s + "\n"));
  }
  parts.push(pktLine("NAK\n"));
  parts.push(sideBandFrames(pack));
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, "application/x-git-upload-pack-result", Buffer.concat(parts));
}

export async function handleUploadPack(
  res: ServerResponse,
  rec: RepoRec,
  repoKey: string,
  body: Buffer,
): Promise<void> {
  // Detect v0: first pkt-line payload starts with "want ".
  const first = parsePkt(body, 0);
  if (first !== null && first.kind === "data" && first.payload.toString("utf8").startsWith("want ")) {
    handleUploadPackV0(res, rec, body);
    return;
  }
  const args = parseUploadPackRequest(body);
  if (args.command === "ls-refs") {
    sendBuffer(res, 200, "application/x-git-upload-pack-result", lsRefsResponse(rec, args));
    return;
  }
  if (args.command === "fetch") {
    // Empty-repository clone: the client asks for the zero OID. Answer with
    // an empty (but valid) packfile section.
    const realWants = args.wants.filter((w) => w !== ZERO_OID);
    if (realWants.length === 0) {
      const emptyWire = Buffer.concat([
        pktLine("packfile\n"),
        sideBandFrames(buildPack(rec, [])),
        PKT_FLUSH,
      ]);
      sendBuffer(res, 200, "application/x-git-upload-pack-result", emptyWire);
      return;
    }
    // Validate wants exist.
    for (const w of args.wants) {
      if (getObject(rec, w) === null) {
        const err = Buffer.concat([pktLine("error fetch failed: unknown object " + w + "\n"), PKT_FLUSH]);
        sendBuffer(res, 200, "application/x-git-upload-pack-result", err);
        return;
      }
    }
    if (!args.done) {
      // Negotiation round. Over HTTP the exchange is stateless: once we
      // mark the request "ready", the packfile section must follow in the
      // same response (git dies with "expected 'packfile'" otherwise).
      // Only a client that explicitly sent wait-for-done gets acks alone.
      const parts: Buffer[] = [pktLine("acknowledgments\n")];
      let acked = false;
      for (const h of args.haves) {
        if (getObject(rec, h) !== null) {
          parts.push(pktLine("ACK " + h + "\n"));
          acked = true;
        }
      }
      if (!acked) parts.push(pktLine("NAK\n"));
      parts.push(pktLine("ready\n"));
      parts.push(PKT_DELIM);
      if (args.waitForDone) {
        parts.push(PKT_FLUSH);
        sendBuffer(res, 200, "application/x-git-upload-pack-result", Buffer.concat(parts));
        return;
      }
      const wire = await fetchWireV2(rec, repoKey, args);
      sendBuffer(
        res,
        200,
        "application/x-git-upload-pack-result",
        Buffer.concat([Buffer.concat(parts), wire]),
      );
      return;
    }
    const wire = await fetchWireV2(rec, repoKey, args);
    sendBuffer(res, 200, "application/x-git-upload-pack-result", wire);
    return;
  }
  const err = Buffer.concat([pktLine("error unknown command\n"), PKT_FLUSH]);
  sendBuffer(res, 200, "application/x-git-upload-pack-result", err);
}

// ---------------------------------------------------------------------------
// git-receive-pack (POST, protocol v0 push)
// ---------------------------------------------------------------------------

interface RefCommand {
  oldOid: string;
  newOid: string;
  refName: string;
}

export function handleReceivePack(
  res: ServerResponse,
  rec: RepoRec,
  repoKey: string,
  body: Buffer,
): void {
  const commands: RefCommand[] = [];
  let pos = 0;
  let capabilities = "";
  let firstLine = true;
  while (pos < body.length) {
    const pkt = parsePkt(body, pos);
    if (pkt === null) break;
    pos = pkt.next;
    if (pkt.kind === "flush") break;
    if (pkt.kind !== "data") continue;
    let line = pkt.payload.toString("utf8");
    if (firstLine) {
      firstLine = false;
      const nul = line.indexOf("\0");
      if (nul >= 0) {
        capabilities = line.slice(nul + 1).replace(/\n$/, "");
        line = line.slice(0, nul);
      }
    }
    if (line.endsWith("\n")) line = line.slice(0, line.length - 1);
    const sp1 = line.indexOf(" ");
    const sp2 = line.indexOf(" ", sp1 + 1);
    if (sp1 < 0 || sp2 < 0) continue;
    commands.push({
      oldOid: line.slice(0, sp1),
      newOid: line.slice(sp1 + 1, sp2),
      refName: line.slice(sp2 + 1).trim(),
    });
  }

  const results: { refName: string; ok: boolean; msg: string }[] = [];
  let unpackOk = true;
  const packBytes = body.subarray(pos);
  const hasPack = packBytes.length >= 4 && packBytes.toString("ascii", 0, 4) === "PACK";
  if (hasPack) {
    try {
      parsePack(rec, Buffer.from(packBytes));
    } catch {
      unpackOk = false;
    }
  }

  if (unpackOk && commands.length > 0) {
    let changed = false;
    // Peel an oid through annotated tags to the commit it names (null when
    // the chain does not end at a commit in the store).
    const peelToCommit = (oid: string): string | null => {
      let cur = oid;
      for (let i = 0; i < 16; i++) {
        const obj = getObject(rec, cur);
        if (obj === null) return null;
        if (obj.type === "commit") return cur;
        if (obj.type !== "tag") return null;
        const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString("utf8"));
        if (m === null) return null;
        cur = m[1];
      }
      return null;
    };
    for (const cmd of commands) {
      // The new object must exist (unless this is a delete).
      if (cmd.newOid !== ZERO_OID && getObject(rec, cmd.newOid) === null) {
        results.push({ refName: cmd.refName, ok: false, msg: "unknown object" });
        continue;
      }
      if (cmd.newOid !== ZERO_OID && cmd.oldOid !== ZERO_OID) {
        // An update: refuse a non-fast-forward move of an existing ref.
        const current = rec.refs.get(cmd.refName);
        if (current !== undefined && current !== cmd.newOid) {
          const currentCommit = peelToCommit(current);
          const newCommit = peelToCommit(cmd.newOid);
          const fastForward =
            currentCommit !== null && newCommit !== null && isAncestor(rec, currentCommit, newCommit);
          if (!fastForward) {
            results.push({ refName: cmd.refName, ok: false, msg: "non-fast-forward" });
            continue;
          }
        }
      }
      if (cmd.newOid === ZERO_OID) {
        rec.refs.delete(cmd.refName);
      } else {
        rec.refs.set(cmd.refName, cmd.newOid);
      }
      changed = true;
      results.push({ refName: cmd.refName, ok: true, msg: "" });
    }
    if (changed) {
      advanceTick();
      invalidateRepo(rec.owner, rec.name);
    }
  } else if (!unpackOk) {
    for (const cmd of commands) {
      results.push({ refName: cmd.refName, ok: false, msg: "unpack failed" });
    }
  }

  if (capabilities.indexOf("report-status") >= 0) {
    const inner: Buffer[] = [];
    inner.push(pktLine(unpackOk ? "unpack ok\n" : "unpack error\n"));
    for (const r of results) {
      inner.push(pktLine(r.ok ? "ok " + r.refName + "\n" : "ng " + r.refName + " " + r.msg + "\n"));
    }
    inner.push(PKT_FLUSH);
    const report = Buffer.concat([sideBandFrames(Buffer.concat(inner)), PKT_FLUSH]);
    sendBuffer(res, 200, "application/x-git-receive-pack-result", report);
    return;
  }
  sendBuffer(res, 200, "application/x-git-receive-pack-result", Buffer.alloc(0));
}
