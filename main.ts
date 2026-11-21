// main.ts — entrypoint of the standalone GitHub-compatible git forge.
//
// One Node process hosts four surfaces over a single in-memory store:
// git smart HTTP, the REST v3 API, GraphQL v4, and an MCP endpoint.
// Nothing here reads the wall clock or a random source; every timestamp
// comes from the logical clock in clock.ts, so a fixed sequence of
// requests always produces the same bytes back.

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
// Request body collection. When the client declares a Content-Length,
// the body is gathered into one pre-sized Buffer so a large push does
// not allocate per chunk; otherwise chunks are concatenated at the end.
// A stream error still delivers whatever arrived, mirroring a truncated
// upload rather than hanging the request.
// ---------------------------------------------------------------------------

function collectBody(req: IncomingMessage, done: (body: Buffer) => void): void {
  const declared = req.headers["content-length"];
  const expected = declared === undefined ? -1 : Number.parseInt(declared, 10);

  if (expected === 0) {
    done(Buffer.alloc(0));
    return;
  }
  if (expected > 0) {
    const target = Buffer.allocUnsafe(expected);
    let filled = 0;
    const finish = (): void => done(target.subarray(0, filled));
    req.on("data", (chunk: Buffer) => {
      chunk.copy(target, filled);
      filled += chunk.length;
    });
    req.on("end", finish);
    req.on("error", finish);
    return;
  }
  const parts: Buffer[] = [];
  const finishConcat = (): void => done(Buffer.concat(parts));
  req.on("data", (chunk: Buffer) => {
    parts.push(chunk);
  });
  req.on("end", finishConcat);
  req.on("error", finishConcat);
}

// Small JSON replies produced by the router itself (health, auth and
// not-found responses) all share the forge's header set.
function replyJson(res: ServerResponse, status: number, text: string): void {
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

const NOT_FOUND_BODY = '{"message":"Not Found"}';

// The trial harness passes its credential in MAKEFUN_SHOP_TOKEN. When
// the variable is set, every surface except the boot probe requires a
// matching Bearer token; when it is absent (standalone runs) no check
// is applied.
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? "";

function tokenAccepted(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === "") return true;
  return req.headers["authorization"] === "Bearer " + SHOP_TOKEN;
}

// ---------------------------------------------------------------------------
// Routing. Fixed API prefixes are matched first; anything else is tried
// as a git URL of the form /<owner>/<repo>[.git]/<endpoint>.
// ---------------------------------------------------------------------------

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): Promise<void> {
  const url = req.url ?? "/";
  const qmark = url.indexOf("?");
  const path = qmark === -1 ? url : url.slice(0, qmark);
  const query = parseQuery(qmark === -1 ? "" : url.slice(qmark + 1));
  const method = req.method ?? "GET";

  // Boot probe for the harness: unauthenticated, constant body.
  if (path === "/healthz") {
    if (method === "GET") replyJson(res, 200, '{"ok":true}');
    else replyJson(res, 404, NOT_FOUND_BODY);
    return;
  }

  if (!tokenAccepted(req)) {
    replyJson(res, 401, '{"message":"Bad credentials"}');
    return;
  }

  if (path === "/api/graphql" || path === "/mcp") {
    if (method !== "POST") {
      replyJson(res, 404, NOT_FOUND_BODY);
    } else if (path === "/api/graphql") {
      handleGraphQL(res, body);
    } else {
      handleMcp(res, body);
    }
    return;
  }

  if (path === "/api/v3" || path.startsWith("/api/v3/")) {
    handleRest(req, res, path, query, url, body);
    return;
  }

  if (path === "" || path === "/") {
    replyJson(
      res,
      200,
      '{"name":"standalone-git-forge","version":"1.0.0","agent":"standalone-forge/1.0"}',
    );
    return;
  }

  const segments = splitPath(path);
  if (segments.length >= 3) {
    const owner = segments[0];
    let repo = segments[1];
    if (repo.endsWith(".git")) repo = repo.slice(0, repo.length - 4);
    const rec = getRepo(owner, repo);
    if (rec !== null) {
      const endpoint = segments.slice(2).join("/");
      const repoKey = owner + "/" + repo;
      if (endpoint === "info/refs" && method === "GET") {
        handleInfoRefs(req, res, rec, query.get("service") ?? "");
        return;
      }
      if (endpoint === "git-upload-pack" && method === "POST") {
        await handleUploadPack(res, rec, repoKey, body);
        return;
      }
      if (endpoint === "git-receive-pack" && method === "POST") {
        handleReceivePack(res, rec, repoKey, body);
        return;
      }
    }
  }
  replyJson(res, 404, NOT_FOUND_BODY);
}

// ---------------------------------------------------------------------------
// Warmup: run the hot primitives once before the first request so the
// JIT has compiled them, then reset store and clock so the process
// still starts from the exact deterministic origin.
// ---------------------------------------------------------------------------

function warmupPrimitives(): void {
  const probe = JSON.stringify({ probe: [1, 2, 3], nested: { flag: true } });
  JSON.parse(probe);
  const probeBytes = Buffer.from(probe, "utf8");
  crypto.createHash("sha1").update(probeBytes).digest("hex");
  const packed = zlib.deflateSync(probeBytes, { level: 0 });
  zlib.inflateSync(packed);
  parsePkt(pktLine("warmup\n"), 0);
  const bulk = Buffer.allocUnsafe(65536);
  bulk.fill(7);
  zlib.deflateSync(bulk, { level: 0 });
  resetStore();
  resetClock();
}

function buildServer(): http.Server {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    res.sendDate = false;
    collectBody(req, (body) => {
      routeRequest(req, res, body).catch(() => {
        try {
          if (res.headersSent) res.end();
          else replyJson(res, 500, '{"message":"Internal Server Error"}');
        } catch {
          // The socket is already gone; there is nothing left to send.
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

warmupPrimitives();

// ---------------------------------------------------------------------------
// Lifecycle. With MAKEFUN_ENV_URL set (trial harness) the server binds
// an ephemeral port, registers it, and serves until the env reports
// done, then exits 0. Without it, the server listens on PORT (default
// 3000) until killed.
// ---------------------------------------------------------------------------

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff shared by the env handshake loops: 250 ms,
// doubling per attempt, capped at 2 s.
function backoffMs(attempt: number): number {
  const steps = Math.min(attempt, 8);
  return Math.min(2000, 250 * 2 ** steps);
}

async function announcePort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let fatalStatus = 0;
    try {
      const res = await fetch(ENV_URL + "/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: port }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) fatalStatus = res.status;
    } catch {
      // Network-level failure: fall through and retry.
    }
    if (fatalStatus !== 0) {
      throw new Error("register answered HTTP " + fatalStatus);
    }
    await pause(backoffMs(attempt));
  }
}

async function awaitEnvDone(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(ENV_URL + "/done", {
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const payload = (await res.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet; keep polling.
    }
    await pause(backoffMs(attempt));
  }
}

if (ENV_URL === "") {
  const port = Number(process.env.PORT || 3000);
  buildServer().listen(port, "0.0.0.0");
} else {
  const server = buildServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the server did not bind an ephemeral TCP port");
  }
  await announcePort(bound.port);
  await awaitEnvDone();
  server.close();
  process.exit(0);
}
