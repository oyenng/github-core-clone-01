// mcp.ts — the Model Context Protocol face of the forge.
//
// Clients POST JSON-RPC 2.0 to /mcp, either a single request object or
// a batch array. Requests carrying an id get a response object;
// notifications (no id) are acknowledged by the transport with a bare
// 202 and no body. The ten tools mirror the operations the REST layer
// exposes, with the argument spellings the GitHub MCP server uses.

import type { ServerResponse } from "node:http";
import { advanceTick, isoNow, httpDateNow } from "./clock.ts";
import { getRepo, invalidateRepo } from "./store.ts";
import type { RepoRec } from "./store.ts";
import {
  VIEWER_LOGIN,
  serializeRepo,
  serializeIssue,
  serializePr,
  createRepoOp,
  createIssueOp,
  createPrOp,
  mergePrOp,
  getContentOp,
  putContentOp,
  isOpError,
} from "./rest.ts";

// ---------------------------------------------------------------------------
// Tool catalogue. Each entry is assembled by defineTool so the published
// schemas share one shape: an object schema with named properties, a
// required list, and no additional properties allowed.
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type PropMap = Record<string, Record<string, unknown>>;

function defineTool(
  name: string,
  description: string,
  properties: PropMap,
  required: string[],
): ToolDef {
  const inputSchema: Record<string, unknown> = {
    type: "object",
    properties: properties,
    required: required,
    additionalProperties: false,
  };
  return { name: name, description: description, inputSchema: inputSchema };
}

function strProp(description?: string): Record<string, unknown> {
  const prop: Record<string, unknown> = { type: "string" };
  if (description !== undefined) prop.description = description;
  return prop;
}

function numProp(description?: string): Record<string, unknown> {
  const prop: Record<string, unknown> = { type: "number" };
  if (description !== undefined) prop.description = description;
  return prop;
}

function boolProp(description?: string): Record<string, unknown> {
  const prop: Record<string, unknown> = { type: "boolean" };
  if (description !== undefined) prop.description = description;
  return prop;
}

function enumProp(values: string[], description?: string): Record<string, unknown> {
  const prop: Record<string, unknown> = { type: "string", enum: values };
  if (description !== undefined) prop.description = description;
  return prop;
}

export const TOOLS: ToolDef[] = [
  defineTool(
    "create_repo",
    "Create a new repository.",
    {
      owner: strProp("Repository owner login. Defaults to the viewer."),
      name: strProp("Repository name."),
      description: strProp("Repository description."),
      private: boolProp("Whether the repository is private."),
      auto_init: boolProp("Create an initial commit with a README."),
      default_branch: strProp("Default branch name. Defaults to main."),
    },
    ["name"],
  ),
  defineTool(
    "get_repo",
    "Get a repository by owner and name.",
    {
      owner: strProp(),
      repo: strProp("Repository name."),
      name: strProp("Repository name (alias of repo)."),
      full_name: strProp("Full name in owner/repo form."),
    },
    ["owner", "repo"],
  ),
  defineTool(
    "create_issue",
    "Create an issue in a repository.",
    {
      owner: strProp(),
      repo: strProp(),
      title: strProp(),
      body: strProp("Issue body."),
    },
    ["owner", "repo", "title"],
  ),
  defineTool(
    "list_issues",
    "List issues of a repository, optionally filtered by state.",
    {
      owner: strProp(),
      repo: strProp(),
      state: enumProp(["open", "closed", "all"], "Issue state filter."),
    },
    ["owner", "repo"],
  ),
  defineTool(
    "get_issue",
    "Get one issue by number.",
    { owner: strProp(), repo: strProp(), number: numProp() },
    ["owner", "repo", "number"],
  ),
  defineTool(
    "update_issue",
    "Update an issue's title, body or state.",
    {
      owner: strProp(),
      repo: strProp(),
      number: numProp(),
      title: strProp(),
      body: strProp(),
      state: enumProp(["open", "closed"]),
    },
    ["owner", "repo", "number"],
  ),
  defineTool(
    "create_pull_request",
    "Create a pull request from a head branch into a base branch.",
    {
      owner: strProp(),
      repo: strProp(),
      title: strProp(),
      head: strProp(),
      base: strProp(),
      body: strProp(),
    },
    ["owner", "repo", "title", "head", "base"],
  ),
  defineTool(
    "merge_pull_request",
    "Merge a pull request (merge, squash or rebase).",
    {
      owner: strProp(),
      repo: strProp(),
      pull_number: numProp("Pull request number."),
      number: numProp("Pull request number (alias of pull_number)."),
      merge_method: enumProp(["merge", "squash", "rebase"]),
      commit_title: strProp(),
      commit_message: strProp(),
    },
    ["owner", "repo", "pull_number"],
  ),
  defineTool(
    "get_file_contents",
    "Get the contents of a file or directory in a repository.",
    {
      owner: strProp(),
      repo: strProp(),
      path: strProp(),
      ref: strProp("Branch, ref or commit SHA."),
    },
    ["owner", "repo", "path"],
  ),
  defineTool(
    "create_or_update_file",
    "Create or update a file in a repository with a new commit.",
    {
      owner: strProp(),
      repo: strProp(),
      path: strProp(),
      content: strProp("File content as UTF-8 text."),
      message: strProp(),
      branch: strProp(),
      sha: strProp("Blob SHA of the file being replaced, when updating."),
    },
    ["owner", "repo", "path", "content", "message"],
  ),
];

// ---------------------------------------------------------------------------
// Argument access and result envelopes.
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

function strArg(args: Args, key: string): string | null {
  const value = args[key];
  return typeof value === "string" ? value : null;
}

function numArg(args: Args, key: string): number | null {
  const value = args[key];
  return typeof value === "number" ? value : null;
}

function okResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: "text", text: text }], isError: false };
}

function errResult(message: string): Record<string, unknown> {
  const text = JSON.stringify({ error: message });
  return { content: [{ type: "text", text: text }], isError: true };
}

// Most tools address a repository first; this resolves the owner/repo
// argument pair to a record, or null when there is no such repository.
function repoFromArgs(args: Args): RepoRec | null {
  const owner = strArg(args, "owner");
  const repo = strArg(args, "repo");
  return getRepo(owner === null ? "" : owner, repo === null ? "" : repo);
}

// ---------------------------------------------------------------------------
// Tool implementations. Each returns a result envelope; lookup failures
// are reported inside the envelope (isError) rather than as RPC errors.
// ---------------------------------------------------------------------------

function runCreateRepo(args: Args): Record<string, unknown> {
  const name = strArg(args, "name");
  if (name === null) return errResult("name is required");
  const owner = strArg(args, "owner");
  const created = createRepoOp(
    owner === null ? VIEWER_LOGIN : owner,
    name,
    strArg(args, "description"),
    args.private === true,
    args.auto_init === true,
    strArg(args, "default_branch") ?? "main",
  );
  return isOpError(created) ? errResult(created.message) : okResult(serializeRepo(created));
}

function runGetRepo(args: Args): Record<string, unknown> {
  let owner = strArg(args, "owner") ?? "";
  let repo = strArg(args, "repo") ?? strArg(args, "name") ?? "";
  const fullName = strArg(args, "full_name");
  if (fullName !== null) {
    const slash = fullName.indexOf("/");
    if (slash >= 0) {
      owner = fullName.slice(0, slash);
      repo = fullName.slice(slash + 1);
    }
  }
  const rec = getRepo(owner, repo);
  return rec === null ? errResult("Repository not found") : okResult(serializeRepo(rec));
}

function runCreateIssue(args: Args): Record<string, unknown> {
  const rec = repoFromArgs(args);
  if (rec === null) return errResult("Repository not found");
  const title = strArg(args, "title");
  if (title === null) return errResult("title is required");
  const issue = createIssueOp(rec, title, strArg(args, "body"), rec.owner);
  return okResult(serializeIssue(rec, issue));
}

function runListIssues(args: Args): Record<string, unknown> {
  const rec = repoFromArgs(args);
  if (rec === null) return errResult("Repository not found");
  const wanted = strArg(args, "state") ?? "open";
  const issues = Array.from(rec.issues.values());
  issues.sort((a, b) => a.number - b.number);
  const out: Record<string, unknown>[] = [];
  for (const issue of issues) {
    if (wanted === "all" || issue.state === wanted) {
      out.push(serializeIssue(rec, issue));
    }
  }
  return okResult(out);
}

function runGetIssue(args: Args): Record<string, unknown> {
  const rec = repoFromArgs(args);
  if (rec === null) return errResult("Repository not found");
  const number = numArg(args, "number");
  const issue = number === null ? undefined : rec.issues.get(number);
  return issue === undefined
    ? errResult("Issue not found")
    : okResult(serializeIssue(rec, issue));
}

function runUpdateIssue(args: Args): Record<string, unknown> {
  const rec = repoFromArgs(args);
  if (rec === null) return errResult("Repository not found");
  const number = numArg(args, "number");
  const issue = number === null ? undefined : rec.issues.get(number);
  if (issue === undefined) return errResult("Issue not found");
  advanceTick();
  const title = strArg(args, "title");
  if (title !== null) issue.title = title;
  if (args.body !== undefined) issue.body = strArg(args, "body");
  const state = strArg(args, "state");
  if (state === "open" || state === "closed") {
    issue.state = state;
    issue.closedAt = state === "closed" ? isoNow() : null;
  }
  issue.updatedAt = isoNow();
  rec.updatedAt = isoNow();
  invalidateRepo(rec.owner, rec.name);
  return okResult(serializeIssue(rec, issue));
}

function runCreatePullRequest(args: Args): Record<string, unknown> {
  const rec = repoFromArgs(args);
  if (rec === null) return errResult("Repository not found");
  const title = strArg(args, "title");
  const head = strArg(args, "head");
  const base = strArg(args, "base");
  if (title === null || head === null || base === null) {
    return errResult("title, head and base are required");
  }
  const pr = createPrOp(rec, title, strArg(args, "body"), head, base, rec.owner);
  return isOpError(pr) ? errResult(pr.message) : okResult(serializePr(rec, pr));
}

function runMergePullRequest(args: Args): Record<string, unknown> {
  const rec = repoFromArgs(args);
  if (rec === null) return errResult("Repository not found");
  const number = numArg(args, "pull_number") ?? numArg(args, "number");
  const pr = number === null ? undefined : rec.prs.get(number);
  if (pr === undefined) return errResult("Pull request not found");
  const outcome = mergePrOp(
    rec,
    pr,
    strArg(args, "merge_method") ?? "merge",
    strArg(args, "commit_title"),
    strArg(args, "commit_message"),
  );
  if (isOpError(outcome)) return errResult(outcome.message);
  return okResult({
    sha: outcome.sha,
    merged: true,
    message: "Pull Request successfully merged",
  });
}

function runGetFileContents(args: Args): Record<string, unknown> {
  const rec = repoFromArgs(args);
  if (rec === null) return errResult("Repository not found");
  const path = strArg(args, "path") ?? "";
  const found = getContentOp(rec, path, strArg(args, "ref"));
  if (found === null) return errResult("Path not found");
  if (found.kind === "dir") {
    return okResult({ type: "dir", path: path, entries: found.entries });
  }
  return okResult({
    type: "file",
    name: found.entry.name,
    path: found.entry.path,
    sha: found.entry.sha,
    size: found.entry.size,
    encoding: "base64",
    content: found.data.toString("base64"),
    text: found.data.toString("utf8"),
  });
}

function runCreateOrUpdateFile(args: Args): Record<string, unknown> {
  const rec = repoFromArgs(args);
  if (rec === null) return errResult("Repository not found");
  const path = strArg(args, "path");
  const content = strArg(args, "content");
  const message = strArg(args, "message");
  if (path === null || content === null || message === null) {
    return errResult("path, content and message are required");
  }
  const written = putContentOp(
    rec,
    path,
    Buffer.from(content, "utf8"),
    message,
    strArg(args, "branch"),
    strArg(args, "sha"),
  );
  if (isOpError(written)) return errResult(written.message);
  return okResult({
    content: {
      name: written.entry.name,
      path: written.entry.path,
      sha: written.entry.sha,
      size: written.entry.size,
      type: "file",
    },
    commit: { sha: written.commitOid },
  });
}

const TOOL_RUNNERS: Record<string, (args: Args) => Record<string, unknown>> = {
  create_repo: runCreateRepo,
  get_repo: runGetRepo,
  create_issue: runCreateIssue,
  list_issues: runListIssues,
  get_issue: runGetIssue,
  update_issue: runUpdateIssue,
  create_pull_request: runCreatePullRequest,
  merge_pull_request: runMergePullRequest,
  get_file_contents: runGetFileContents,
  create_or_update_file: runCreateOrUpdateFile,
};

// ---------------------------------------------------------------------------
// JSON-RPC dispatch. A request without an id is a notification and is
// answered with null here; the transport turns that into a 202.
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcSuccess(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id, result: result };
}

function rpcFailure(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id, error: { code: code, message: message } };
}

function dispatchOne(req: RpcRequest): Record<string, unknown> | null {
  if (!("id" in req) || req.id === undefined) {
    return null;
  }
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === "string" ? req.method : "";
  const params: Record<string, unknown> =
    typeof req.params === "object" && req.params !== null ? req.params : {};

  switch (method) {
    case "initialize": {
      const version =
        typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : "2024-11-05";
      return rpcSuccess(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "standalone-git-forge", version: "1.0.0" },
      });
    }
    case "ping":
      return rpcSuccess(id, {});
    case "tools/list":
      return rpcSuccess(id, { tools: TOOLS });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const runner = TOOL_RUNNERS[name];
      if (runner === undefined) {
        return rpcFailure(id, -32602, "Unknown tool: " + name);
      }
      const rawArgs = params.arguments;
      const args: Args =
        typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Args) : {};
      return rpcSuccess(id, runner(args));
    }
    default:
      return rpcFailure(id, -32601, "Method not found: " + method);
  }
}

// ---------------------------------------------------------------------------
// Transport: parse the body, dispatch, and write the reply with the
// forge's deterministic Date header.
// ---------------------------------------------------------------------------

function writeJson(res: ServerResponse, status: number, payload: Buffer | null): void {
  res.sendDate = false;
  res.cork();
  if (payload === null) {
    res.writeHead(status, { "Date": httpDateNow(), "Connection": "keep-alive" });
    res.end();
  } else {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(payload.length),
      "Date": httpDateNow(),
      "Connection": "keep-alive",
    });
    res.end(payload);
  }
  res.uncork();
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

export function handleMcp(res: ServerResponse, body: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    const failure = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    };
    writeJson(res, 400, jsonBytes(failure));
    return;
  }

  if (Array.isArray(parsed)) {
    const replies: Record<string, unknown>[] = [];
    for (const item of parsed) {
      const reply = dispatchOne(item as RpcRequest);
      if (reply !== null) replies.push(reply);
    }
    if (replies.length === 0) {
      writeJson(res, 202, null);
    } else {
      writeJson(res, 200, jsonBytes(replies));
    }
    return;
  }

  const reply = dispatchOne(parsed as RpcRequest);
  if (reply === null) {
    writeJson(res, 202, null);
  } else {
    writeJson(res, 200, jsonBytes(reply));
  }
}
