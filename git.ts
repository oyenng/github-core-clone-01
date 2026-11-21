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

// Side-band framing for protocol v2 fetch replies: the payload travels
// in band-1 pkt-lines holding at most 65515 data bytes each, which keeps
// every framed line inside the 65524-byte protocol ceiling. An empty
// payload still produces one frame carrying only the band byte.
export function sideBandFrames(data: Buffer): Buffer {
  const frames: Buffer[] = [];
  const LIMIT = 65515;
  let cursor = 0;
  while (cursor < data.length) {
    const end = Math.min(cursor + LIMIT, data.length);
    frames.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(cursor, end)])));
    cursor = end;
  }
  if (frames.length === 0) {
    frames.push(pktLine(Buffer.from([1])));
  }
  return Buffer.concat(frames);
}

// ---------------------------------------------------------------------------
// Delta chains. A git delta describes how to rebuild a target object
// from a base object: two little-endian varints (base size, target
// size) followed by instructions that either copy a span of the base
// (opcode with the high bit set) or insert literal bytes (opcode equal
// to the insert length).
// ---------------------------------------------------------------------------

function decodeVarint(buf: Buffer, start: number): [number, number] {
  let value = 0;
  let factor = 1;
  let pos = start;
  for (;;) {
    const byte = buf[pos];
    pos += 1;
    value += (byte & 0x7f) * factor;
    if (byte < 0x80) break;
    factor *= 128;
  }
  return [value, pos];
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  let baseSize = 0;
  [baseSize, pos] = decodeVarint(delta, pos);
  if (baseSize !== base.length) throw new Error("delta base size mismatch");
  let targetSize = 0;
  [targetSize, pos] = decodeVarint(delta, pos);

  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (pos < delta.length) {
    const opcode = delta[pos];
    pos += 1;
    if (opcode === 0) throw new Error("delta opcode 0");
    if (opcode & 0x80) {
      // Copy from base: bits 0-3 of the opcode say which offset bytes
      // follow, bits 4-6 say which size bytes follow.
      let offset = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (opcode & (1 << bit)) {
          offset += delta[pos] * 2 ** (8 * bit);
          pos += 1;
        }
      }
      let size = 0;
      for (let bit = 0; bit < 3; bit++) {
        if (opcode & (0x10 << bit)) {
          size += delta[pos] * 2 ** (8 * bit);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      base.copy(out, written, offset, offset + size);
      written += size;
    } else {
      // Insert the next `opcode` bytes of the delta itself.
      delta.copy(out, written, pos, pos + opcode);
      pos += opcode;
      written += opcode;
    }
  }
  if (written !== targetSize) throw new Error("delta target size mismatch");
  return out;
}

// ---------------------------------------------------------------------------
// Packfile writing. The forge writes the simplest legal pack: objects
// sorted by OID, each stored whole (never deltified), compressed at
// zlib level 0, so the same object set always yields the same pack
// bytes and therefore the same trailer checksum.
// ---------------------------------------------------------------------------

const PACK_TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function encodePackEntryHeader(type: string, size: number): Buffer {
  const code = PACK_TYPE_CODES[type];
  // The size is split into a 4-bit group (sharing the first byte with
  // the type code) and then 7-bit groups, least significant first.
  const groups: number[] = [size % 16];
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    groups.push(rest % 128);
    rest = Math.floor(rest / 128);
  }
  const bytes: number[] = [];
  for (let i = 0; i < groups.length; i++) {
    let byte = groups[i];
    if (i === 0) byte += code * 16;
    if (i < groups.length - 1) byte += 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

export function buildPack(rec: RepoRec, oids: string[]): Buffer {
  const ordered = oids.slice().sort();
  const header = Buffer.allocUnsafe(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(ordered.length, 8);
  const chunks: Buffer[] = [header];
  for (const oid of ordered) {
    const obj = rec.objects.get(oid);
    if (obj === undefined) continue;
    chunks.push(encodePackEntryHeader(obj.type, obj.data.length));
    chunks.push(zlib.deflateSync(obj.data, { level: 0 }));
  }
  const body = Buffer.concat(chunks);
  const checksum = crypto.createHash("sha1").update(body).digest();
  return Buffer.concat([body, checksum]);
}

// ---------------------------------------------------------------------------
// Packfile reading (receive-pack). zlib's inflateSync ignores trailing
// bytes, so the exact end of one object's compressed stream is found by
// probing: grow a window exponentially until the slice inflates to the
// declared size, then binary-search inside that bracket for the
// smallest working slice.
// ---------------------------------------------------------------------------

function inflateEntry(buf: Buffer, start: number, expectedSize: number): { data: Buffer; next: number } {
  const available = buf.length - start;
  const inflatesToSize = (length: number): boolean => {
    try {
      return zlib.inflateSync(buf.subarray(start, start + length)).length === expectedSize;
    } catch {
      return false;
    }
  };
  let bracketLo = 0;
  let bracketHi = 1;
  while (bracketHi < available && !inflatesToSize(bracketHi)) {
    bracketLo = bracketHi;
    bracketHi *= 2;
  }
  if (bracketHi > available) bracketHi = available;
  if (!inflatesToSize(bracketHi)) throw new Error("pack object inflate failed");
  while (bracketLo + 1 < bracketHi) {
    const mid = bracketLo + Math.floor((bracketHi - bracketLo) / 2);
    if (inflatesToSize(mid)) bracketHi = mid;
    else bracketLo = mid;
  }
  const data = zlib.inflateSync(buf.subarray(start, start + bracketHi));
  return { data: data, next: start + bracketHi };
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  data: Buffer; // inflated payload; for deltas this is the delta itself
  refBase: string | null; // base OID for REF_DELTA entries
  ofsBase: number; // absolute pack offset of the base for OFS_DELTA, else -1
}

const PACK_TYPE_NAMES: Record<number, string> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

// Parse a whole pack stream and store every object it carries in the
// repo. Returns the stored OIDs. Any structural problem (bad header,
// checksum mismatch, a delta whose base cannot be found) throws; full
// objects stored before the failure stay stored, which is safe because
// storage is content-addressed.
export function parsePack(rec: RepoRec, pack: Buffer): string[] {
  if (pack.length < 12 + 20) throw new Error("pack too short");
  if (pack.toString("ascii", 0, 4) !== "PACK") throw new Error("bad pack magic");
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error("bad pack version");
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = crypto.createHash("sha1").update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error("pack checksum mismatch");

  // First pass: walk the entries and inflate each payload.
  const raw: RawPackEntry[] = [];
  const rawByOffset = new Map<number, RawPackEntry>();
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = pos;
    let byte = pack[pos];
    pos += 1;
    const typeCode = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let factor = 16;
    while (byte & 0x80) {
      byte = pack[pos];
      pos += 1;
      size += (byte & 0x7f) * factor;
      factor *= 128;
    }
    let refBase: string | null = null;
    let ofsBase = -1;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base entry, encoded so
      // that each continuation adds one before shifting.
      let c = pack[pos];
      pos += 1;
      let back = c & 0x7f;
      while (c & 0x80) {
        c = pack[pos];
        pos += 1;
        back = (back + 1) * 128 + (c & 0x7f);
      }
      ofsBase = entryOffset - back;
    } else if (typeCode === 7) {
      // REF_DELTA: the base is named by its OID.
      refBase = pack.toString("hex", pos, pos + 20);
      pos += 20;
    }
    const inflated = inflateEntry(pack, pos, size);
    pos = inflated.next;
    const entry: RawPackEntry = {
      offset: entryOffset,
      typeCode: typeCode,
      data: inflated.data,
      refBase: refBase,
      ofsBase: ofsBase,
    };
    raw.push(entry);
    rawByOffset.set(entryOffset, entry);
  }

  // Second pass: turn entries into stored objects, resolving delta
  // bases recursively (a base may itself be a delta in the same pack).
  const resolved = new Map<number, string>();
  const storedOids: string[] = [];
  const resolveEntry = (entry: RawPackEntry): string => {
    const memo = resolved.get(entry.offset);
    if (memo !== undefined) return memo;
    let oid: string;
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      oid = storeObject(rec, PACK_TYPE_NAMES[entry.typeCode], entry.data);
    } else {
      let baseObj: GitObj | null = null;
      if (entry.typeCode === 7 && entry.refBase !== null) {
        baseObj = getObject(rec, entry.refBase);
      } else if (entry.typeCode === 6) {
        const baseEntry = rawByOffset.get(entry.ofsBase);
        if (baseEntry !== undefined) {
          baseObj = getObject(rec, resolveEntry(baseEntry));
        }
      }
      if (baseObj === null) throw new Error("unresolved pack delta");
      const rebuilt = applyDelta(baseObj.data, entry.data);
      oid = storeObject(rec, baseObj.type, rebuilt);
    }
    resolved.set(entry.offset, oid);
    storedOids.push(oid);
    return oid;
  };
  for (const entry of raw) {
    resolveEntry(entry);
  }
  if (resolved.size !== raw.length) throw new Error("unresolved pack delta");
  return storedOids;
}

// ---------------------------------------------------------------------------
// Trees. On the wire a tree is a run of "<mode> <name>\0<20-byte oid>"
// records; entries sort by name, with directories sorting as if their
// name ended in "/".
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // "100644" | "100755" | "120000" | "40000"
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let cursor = 0;
  while (cursor < data.length) {
    const spaceAt = data.indexOf(0x20, cursor);
    const nulAt = data.indexOf(0x00, spaceAt + 1);
    entries.push({
      mode: data.toString("ascii", cursor, spaceAt),
      name: data.toString("utf8", spaceAt + 1, nulAt),
      oid: data.toString("hex", nulAt + 1, nulAt + 21),
    });
    cursor = nulAt + 21;
  }
  return entries;
}

function treeEntrySortKey(entry: TreeEntry): string {
  return entry.mode === "40000" ? entry.name + "/" : entry.name;
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const decorated = entries.map((entry) => ({ key: treeEntrySortKey(entry), entry: entry }));
  decorated.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const chunks: Buffer[] = [];
  for (const item of decorated) {
    chunks.push(Buffer.from(item.entry.mode + " " + item.entry.name + "\0", "utf8"));
    chunks.push(Buffer.from(item.entry.oid, "hex"));
  }
  return Buffer.concat(chunks);
}

// Flatten a tree and all its subtrees into a path -> {mode, oid} map.
// Iterative, with an explicit stack of (tree oid, path prefix) pairs.
export function flattenTree(
  rec: RepoRec,
  treeOid: string,
  prefix: string,
  out: Map<string, { mode: string; oid: string }>,
): void {
  const pending: Array<{ oid: string; prefix: string }> = [{ oid: treeOid, prefix: prefix }];
  while (pending.length > 0) {
    const current = pending.pop() as { oid: string; prefix: string };
    const obj = getObject(rec, current.oid);
    if (obj === null || obj.type !== "tree") continue;
    for (const entry of parseTree(obj.data)) {
      const path = current.prefix === "" ? entry.name : current.prefix + "/" + entry.name;
      if (entry.mode === "40000") {
        pending.push({ oid: entry.oid, prefix: path });
      } else {
        out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    }
  }
}

// Rebuild the nested tree hierarchy for a flat path map and store every
// level; returns the root tree's OID.
export function buildTreeFromFlat(
  rec: RepoRec,
  flat: Map<string, { mode: string; oid: string }>,
): string {
  interface DirNode {
    files: TreeEntry[];
    subdirs: Map<string, DirNode>;
  }
  const newDir = (): DirNode => ({ files: [], subdirs: new Map() });
  const root = newDir();
  for (const [path, value] of flat) {
    const segments = path.split("/");
    let node = root;
    for (let i = 0; i + 1 < segments.length; i++) {
      let child = node.subdirs.get(segments[i]);
      if (child === undefined) {
        child = newDir();
        node.subdirs.set(segments[i], child);
      }
      node = child;
    }
    node.files.push({
      mode: value.mode,
      name: segments[segments.length - 1],
      oid: value.oid,
    });
  }
  const storeDir = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const file of node.files) entries.push(file);
    for (const [name, child] of node.subdirs) {
      entries.push({ mode: "40000", name: name, oid: storeDir(child) });
    }
    return storeObject(rec, "tree", buildTreeData(entries));
  };
  return storeDir(root);
}

// Three-way merge over flat path maps. A path changed on only one side
// takes that side's version; a path changed on both sides in the same
// way takes the shared result; a true conflict resolves to "theirs"
// (the head side), which keeps every merge total and reproducible.
export function mergeFlat(
  base: Map<string, { mode: string; oid: string }>,
  ours: Map<string, { mode: string; oid: string }>,
  theirs: Map<string, { mode: string; oid: string }>,
): Map<string, { mode: string; oid: string }> {
  type Spot = { mode: string; oid: string };
  const sameSpot = (a: Spot | undefined, b: Spot | undefined): boolean => {
    if (a === undefined || b === undefined) return a === b;
    return a.oid === b.oid && a.mode === b.mode;
  };
  const allPaths = new Set<string>();
  for (const map of [base, ours, theirs]) {
    for (const key of map.keys()) allPaths.add(key);
  }
  const merged = new Map<string, Spot>();
  for (const path of Array.from(allPaths).sort()) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    let winner: Spot | undefined;
    if (sameSpot(o, t)) winner = o;
    else if (sameSpot(b, o)) winner = t;
    else if (sameSpot(b, t)) winner = o;
    else winner = t;
    if (winner !== undefined) merged.set(path, winner);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Commits. The header block is "key value" lines (tree, parent*,
// author, committer), then a blank line, then the free-form message.
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
  const blankAt = text.indexOf("\n\n");
  const headerText = blankAt === -1 ? text : text.slice(0, blankAt);
  const info: CommitInfo = {
    tree: ZERO_OID,
    parents: [],
    author: "",
    committer: "",
    message: blankAt === -1 ? "" : text.slice(blankAt + 2),
  };
  for (const line of headerText.split("\n")) {
    const spaceAt = line.indexOf(" ");
    if (spaceAt === -1) continue;
    const key = line.slice(0, spaceAt);
    const value = line.slice(spaceAt + 1);
    if (key === "tree") info.tree = value.trim();
    else if (key === "parent") info.parents.push(value.trim());
    else if (key === "author") info.author = value;
    else if (key === "committer") info.committer = value;
  }
  return info;
}

export function buildCommitData(info: CommitInfo): Buffer {
  const lines: string[] = ["tree " + info.tree];
  for (const parent of info.parents) lines.push("parent " + parent);
  lines.push("author " + info.author);
  lines.push("committer " + info.committer);
  return Buffer.from(lines.join("\n") + "\n\n" + info.message, "utf8");
}

// Create a commit authored by the forge bot at the current logical tick.
export function makeCommit(
  rec: RepoRec,
  treeOid: string,
  parents: string[],
  message: string,
): string {
  const ident = BOT_IDENT + " " + gitTimestampNow();
  const data = buildCommitData({
    tree: treeOid,
    parents: parents,
    author: ident,
    committer: ident,
    message: message,
  });
  return storeObject(rec, "commit", data);
}

export function commitTreeOid(rec: RepoRec, commitOid: string): string | null {
  const obj = getObject(rec, commitOid);
  if (obj === null || obj.type !== "commit") return null;
  return parseCommit(obj.data).tree;
}

// Reachability over the parent graph: is `anc` an ancestor of `desc`
// (or the same commit)? Depth-first with a visited set.
export function isAncestor(rec: RepoRec, anc: string, desc: string): boolean {
  const visited = new Set<string>();
  const stack: string[] = [desc];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === anc) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const obj = getObject(rec, current);
    if (obj === null || obj.type !== "commit") continue;
    for (const parent of parseCommit(obj.data).parents) {
      stack.push(parent);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fetch object selection.
//
// Full fetches (depthLimit null) send the closure of the wants minus
// the closure of the haves. Depth-limited fetches send the commits
// within depthLimit steps of the wants together with their complete
// trees; commits sitting exactly at the depth boundary are reported
// as `shallow` when the cut leaves them with un-sent parents. A commit
// the client already has is still walked through in depth mode (so
// deepening a shallow clone counts depth correctly), but neither it
// nor its tree is sent again.
// ---------------------------------------------------------------------------

export function collectFetchObjects(
  rec: RepoRec,
  wants: string[],
  haves: string[],
  depthLimit: number | null,
): { oids: string[]; shallow: string[] } {
  const haveSet = new Set<string>(haves);

  // Objects the client provably holds (full mode only): every object
  // reachable from any have, commits, trees and blobs alike.
  const excluded = new Set<string>();
  if (depthLimit === null) {
    const pending = haves.slice();
    while (pending.length > 0) {
      const oid = pending.pop() as string;
      if (excluded.has(oid)) continue;
      const obj = getObject(rec, oid);
      if (obj === null) continue;
      excluded.add(oid);
      if (obj.type === "commit") {
        const commit = parseCommit(obj.data);
        pending.push(commit.tree);
        for (const parent of commit.parents) pending.push(parent);
      } else if (obj.type === "tree") {
        for (const entry of parseTree(obj.data)) pending.push(entry.oid);
      }
    }
  }

  const included = new Set<string>();
  const sweepTree = (rootOid: string): void => {
    const pending: string[] = [rootOid];
    while (pending.length > 0) {
      const oid = pending.pop() as string;
      if (included.has(oid) || excluded.has(oid)) continue;
      const obj = getObject(rec, oid);
      if (obj === null) continue;
      included.add(oid);
      if (obj.type === "tree") {
        for (const entry of parseTree(obj.data)) pending.push(entry.oid);
      }
    }
  };

  const shallowSet = new Set<string>();

  if (depthLimit === null) {
    const seenCommits = new Set<string>();
    const pending = wants.slice();
    while (pending.length > 0) {
      const oid = pending.pop() as string;
      if (seenCommits.has(oid) || haveSet.has(oid) || excluded.has(oid)) continue;
      const obj = getObject(rec, oid);
      if (obj === null) continue;
      if (obj.type === "commit") {
        seenCommits.add(oid);
        included.add(oid);
        const commit = parseCommit(obj.data);
        sweepTree(commit.tree);
        for (const parent of commit.parents) pending.push(parent);
      } else {
        included.add(oid);
        if (obj.type === "tree") sweepTree(oid);
      }
    }
  } else {
    const seenCommits = new Set<string>();
    let ring = wants.slice();
    let depth = 0;
    while (ring.length > 0 && depth < depthLimit) {
      const atBoundary = depth + 1 >= depthLimit;
      const nextRing: string[] = [];
      for (const oid of ring) {
        if (seenCommits.has(oid)) continue;
        const obj = getObject(rec, oid);
        if (obj === null || obj.type !== "commit") continue;
        seenCommits.add(oid);
        const commit = parseCommit(obj.data);
        if (!haveSet.has(oid)) {
          included.add(oid);
          sweepTree(commit.tree);
        }
        for (const parent of commit.parents) {
          if (atBoundary) shallowSet.add(oid);
          else nextRing.push(parent);
        }
      }
      ring = nextRing;
      depth += 1;
    }
  }

  return {
    oids: Array.from(included).sort(),
    shallow: Array.from(shallowSet).sort(),
  };
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
