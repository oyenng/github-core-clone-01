// main.ts — Standalone GitHub-compatible git forge: one process serving
// Git Smart HTTP, the REST v3 API, GraphQL v4 and MCP from a single
// in-memory store. Zero dependencies (Node.js 22 standard library only).
//
//   node --experimental-strip-types /bot/main.ts
//
// Determinism contract: no Date.now(), no Math.random(), no wall-clock
// reads anywhere — every timestamp comes from the cached logical clock in
// clock.ts, so identical request sequences replay byte-identically.

import * as http from "node:http";
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resetClock, httpDateNow } from "./clock.ts";
import { getRepo, resetStore } from "./store.ts";
import {
  handleInfoRefs,
  handleUploadPack,
  handleReceivePack,
  pktLine,
  parsePkt,
} from "./git.ts";
import { handleRest, parseQuery, splitPath, nextRequestId } from "./rest.ts";
import { handleGraphQL } from "./graphql.ts";
import { handleMcp } from "./mcp.ts";

// ---------------------------------------------------------------------------
// Single-allocation request body reader: when Content-Length is known the
// body lands in exactly one pre-sized Buffer (chunk.copy), so sequential
// POST/push workloads do not pay per-chunk allocation or GC pauses.
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, cb: (body: Buffer) => void): void {
  const lenHeader = req.headers["content-length"];
  const len = lenHeader === undefined ? -1 : parseInt(lenHeader, 10);
  if (len >= 0) {
    if (len === 0) {
      cb(Buffer.alloc(0));
      return;
    }
    const buf = Buffer.allocUnsafe(len);
    let offset = 0;
    req.on("data", (chunk: Buffer) => {
      chunk.copy(buf, offset);
      offset += chunk.length;
    });
    req.on("end", () => cb(buf.subarray(0, offset)));
    req.on("error", () => cb(buf.subarray(0, offset)));
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => cb(Buffer.concat(chunks)));
  req.on("error", () => cb(Buffer.concat(chunks)));
}

function sendPlainJson(res: ServerResponse, status: number, text: string): void {
  const body = Buffer.from(text, "utf8");
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

// The trial harness hands the entry its only credential as an environment
// variable; when it is set, every surface except /healthz requires the
// matching Bearer token and refuses anything else with a 401.
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? "";

// ---------------------------------------------------------------------------
// Routing. Path segments are located with indexOf scanning; the three API
// surfaces are prefix-dispatched, everything else is a git route of the
// form /:owner/:repo[.git]/<endpoint>.
// ---------------------------------------------------------------------------

async function dispatch(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  const rawUrl = req.url === undefined ? "/" : req.url;
  const q = rawUrl.indexOf("?");
  const path = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
  const query = parseQuery(q >= 0 ? rawUrl.slice(q + 1) : "");
  const method = req.method === undefined ? "GET" : req.method;

  // The harness boot probe: no credential, always the same tiny body.
  if (path === "/healthz") {
    if (method === "GET") sendPlainJson(res, 200, '{"ok":true}');
    else sendPlainJson(res, 404, '{"message":"Not Found"}');
    return;
  }

  if (SHOP_TOKEN !== "" && req.headers["authorization"] !== "Bearer " + SHOP_TOKEN) {
    sendPlainJson(res, 401, '{"message":"Bad credentials"}');
    return;
  }

  if (path === "/api/graphql") {
    if (method === "POST") handleGraphQL(res, body);
    else sendPlainJson(res, 404, '{"message":"Not Found"}');
    return;
  }
  if (path === "/mcp") {
    if (method === "POST") handleMcp(res, body);
    else sendPlainJson(res, 404, '{"message":"Not Found"}');
    return;
  }
  if (path === "/api/v3" || path.startsWith("/api/v3/")) {
    handleRest(req, res, path, query, rawUrl, body);
    return;
  }
  if (path === "/" || path === "") {
    sendPlainJson(
      res,
      200,
      '{"name":"standalone-git-forge","version":"1.0.0","agent":"standalone-forge/1.0"}',
    );
    return;
  }

  // Git routes: /:owner/:repo[.git]/info/refs | git-upload-pack | git-receive-pack
  const segs = splitPath(path);
  if (segs.length >= 3) {
    const owner = segs[0];
    let repoName = segs[1];
    if (repoName.endsWith(".git")) repoName = repoName.slice(0, repoName.length - 4);
    const rec = getRepo(owner, repoName);
    if (rec === null) {
      sendPlainJson(res, 404, '{"message":"Not Found"}');
      return;
    }
    const tail = segs.slice(2).join("/");
    if (tail === "info/refs" && method === "GET") {
      handleInfoRefs(req, res, rec, query.get("service") ?? "");
      return;
    }
    if (tail === "git-upload-pack" && method === "POST") {
      await handleUploadPack(res, rec, owner + "/" + repoName, body);
      return;
    }
    if (tail === "git-receive-pack" && method === "POST") {
      handleReceivePack(res, rec, owner + "/" + repoName, body);
      return;
    }
  }
  sendPlainJson(res, 404, '{"message":"Not Found"}');
}

// ---------------------------------------------------------------------------
// Pre-listen JIT warmup: exercise the hot primitives once so V8 compiles
// them before the first real request, then reset all state so the process
// starts from the exact deterministic origin.
// ---------------------------------------------------------------------------

function warmup(): void {
  const sample = JSON.stringify({ a: [1, 2, 3], b: "warmup", c: { d: true } });
  JSON.parse(sample);
  const buf = Buffer.from(sample, "utf8");
  crypto.createHash("sha1").update(buf).digest("hex");
  const deflated = zlib.deflateSync(buf, { level: 0 });
  zlib.inflateSync(deflated);
  const line = pktLine("warmup\n");
  parsePkt(line, 0);
  const big = Buffer.allocUnsafe(65536);
  big.fill(7);
  zlib.deflateSync(big, { level: 0 });
  resetStore();
  resetClock();
}

function createForgeServer(): http.Server {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    res.sendDate = false;
    readBody(req, (body) => {
      dispatch(req, res, body).catch(() => {
        try {
          if (!res.headersSent) {
            sendPlainJson(res, 500, '{"message":"Internal Server Error"}');
          } else {
            res.end();
          }
        } catch {
          // socket already gone; nothing deterministic left to say
        }
      });
    });
  });
  server.on("connection", (socket) => {
    socket.setNoDelay(true);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  return server;
}

warmup();

// ---------------------------------------------------------------------------
// Lifecycle. Under the trial harness (MAKEFUN_ENV_URL set) the process binds
// an ephemeral port, registers it with the env, serves until the env says
// the trial is done, then exits 0. Standalone (no env URL) it listens on
// PORT (default 3000) and serves until killed.
// ---------------------------------------------------------------------------

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number): number {
  return Math.min(2000, 250 * 2 ** Math.min(attempt, 8));
}

async function registerWithEnv(port: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(ENV_URL + "/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: port }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error("register answered HTTP " + res.status);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("register answered HTTP ")) throw e;
    }
    await sleepMs(retryDelay(attempt));
  }
}

async function waitForEnvDone(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(ENV_URL + "/done", { signal: AbortSignal.timeout(30000) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // env not answering yet: keep polling
    }
    await sleepMs(retryDelay(attempt));
  }
}

if (ENV_URL !== "") {
  const server = createForgeServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the server did not bind an ephemeral TCP port");
  }
  await registerWithEnv(address.port);
  await waitForEnvDone();
  server.close();
  process.exit(0);
} else {
  const PORT = Number(process.env.PORT || 3000);
  createForgeServer().listen(PORT, "0.0.0.0");
}
