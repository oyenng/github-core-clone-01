// mcp.ts — Model Context Protocol endpoint: JSON-RPC 2.0 over POST /mcp,
// single requests and batch arrays. Notifications (no `id`, e.g.
// notifications/initialized) are answered by the HTTP layer with
// 202 Accepted and an empty body.

import type { ServerResponse } from "node:http";
import { advanceTick, isoNow, httpDateNow } from "./clock.ts";
import { getRepo, invalidateRepo } from "./store.ts";
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

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function schema(props: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties: props, required: required, additionalProperties: false };
}
const S = { type: "string" };
const N = { type: "number" };
const B = { type: "boolean" };

export const TOOLS: ToolDef[] = [
  {
    name: "create_repo",
    description: "Create a new repository.",
    inputSchema: schema(
      {
        owner: { type: "string", description: "Repository owner login. Defaults to the viewer." },
        name: { type: "string", description: "Repository name." },
        description: { type: "string", description: "Repository description." },
        private: { type: "boolean", description: "Whether the repository is private." },
        auto_init: { type: "boolean", description: "Create an initial commit with a README." },
        default_branch: { type: "string", description: "Default branch name. Defaults to main." },
      },
      ["name"],
    ),
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and name.",
    inputSchema: schema(
      {
        owner: S,
        repo: { type: "string", description: "Repository name." },
        name: { type: "string", description: "Repository name (alias of repo)." },
        full_name: { type: "string", description: "Full name in owner/repo form." },
      },
      ["owner", "repo"],
    ),
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: schema(
      { owner: S, repo: S, title: S, body: { type: "string", description: "Issue body." } },
      ["owner", "repo", "title"],
    ),
  },
  {
    name: "list_issues",
    description: "List issues of a repository, optionally filtered by state.",
    inputSchema: schema(
      {
        owner: S,
        repo: S,
        state: { type: "string", enum: ["open", "closed", "all"], description: "Issue state filter." },
      },
      ["owner", "repo"],
    ),
  },
  {
    name: "get_issue",
    description: "Get one issue by number.",
    inputSchema: schema({ owner: S, repo: S, number: N }, ["owner", "repo", "number"]),
  },
  {
    name: "update_issue",
    description: "Update an issue's title, body or state.",
    inputSchema: schema(
      {
        owner: S,
        repo: S,
        number: N,
        title: S,
        body: S,
        state: { type: "string", enum: ["open", "closed"] },
      },
      ["owner", "repo", "number"],
    ),
  },
  {
    name: "create_pull_request",
    description: "Create a pull request from a head branch into a base branch.",
    inputSchema: schema(
      { owner: S, repo: S, title: S, head: S, base: S, body: S },
      ["owner", "repo", "title", "head", "base"],
    ),
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request (merge, squash or rebase).",
    inputSchema: schema(
      {
        owner: S,
        repo: S,
        pull_number: { type: "number", description: "Pull request number." },
        number: { type: "number", description: "Pull request number (alias of pull_number)." },
        merge_method: { type: "string", enum: ["merge", "squash", "rebase"] },
        commit_title: S,
        commit_message: S,
      },
      ["owner", "repo", "pull_number"],
    ),
  },
  {
    name: "get_file_contents",
    description: "Get the contents of a file or directory in a repository.",
    inputSchema: schema(
      { owner: S, repo: S, path: S, ref: { type: "string", description: "Branch, ref or commit SHA." } },
      ["owner", "repo", "path"],
    ),
  },
  {
    name: "create_or_update_file",
    description: "Create or update a file in a repository with a new commit.",
    inputSchema: schema(
      {
        owner: S,
        repo: S,
        path: S,
        content: { type: "string", description: "File content as UTF-8 text." },
        message: S,
        branch: S,
        sha: { type: "string", description: "Blob SHA of the file being replaced, when updating." },
      },
      ["owner", "repo", "path", "content", "message"],
    ),
  },
];

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function argStr(a: Record<string, unknown>, k: string): string | null {
  return typeof a[k] === "string" ? (a[k] as string) : null;
}
function argNum(a: Record<string, unknown>, k: string): number | null {
  return typeof a[k] === "number" ? (a[k] as number) : null;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case "create_repo": {
      const repoName = argStr(args, "name");
      if (repoName === null) return toolError("name is required");
      const created = createRepoOp(
        argStr(args, "owner") ?? VIEWER_LOGIN,
        repoName,
        argStr(args, "description"),
        args.private === true,
        args.auto_init === true,
        argStr(args, "default_branch") ?? "main",
      );
      if (isOpError(created)) return toolError(created.message);
      return toolResult(serializeRepo(created));
    }
    case "get_repo": {
      let owner = argStr(args, "owner") ?? "";
      let repoName = argStr(args, "repo") ?? argStr(args, "name") ?? "";
      const fullName = argStr(args, "full_name");
      if (fullName !== null && fullName.indexOf("/") >= 0) {
        owner = fullName.slice(0, fullName.indexOf("/"));
        repoName = fullName.slice(fullName.indexOf("/") + 1);
      }
      const rec = getRepo(owner, repoName);
      if (rec === null) return toolError("Repository not found");
      return toolResult(serializeRepo(rec));
    }
    case "create_issue": {
      const rec = getRepo(argStr(args, "owner") ?? "", argStr(args, "repo") ?? "");
      if (rec === null) return toolError("Repository not found");
      const title = argStr(args, "title");
      if (title === null) return toolError("title is required");
      const issue = createIssueOp(rec, title, argStr(args, "body"), rec.owner);
      return toolResult(serializeIssue(rec, issue));
    }
    case "list_issues": {
      const rec = getRepo(argStr(args, "owner") ?? "", argStr(args, "repo") ?? "");
      if (rec === null) return toolError("Repository not found");
      const state = argStr(args, "state") ?? "open";
      const out: Record<string, unknown>[] = [];
      const sorted = Array.from(rec.issues.values()).sort((a, b) => a.number - b.number);
      for (const issue of sorted) {
        if (state !== "all" && issue.state !== state) continue;
        out.push(serializeIssue(rec, issue));
      }
      return toolResult(out);
    }
    case "get_issue": {
      const rec = getRepo(argStr(args, "owner") ?? "", argStr(args, "repo") ?? "");
      if (rec === null) return toolError("Repository not found");
      const num = argNum(args, "number");
      const issue = num === null ? undefined : rec.issues.get(num);
      if (issue === undefined) return toolError("Issue not found");
      return toolResult(serializeIssue(rec, issue));
    }
    case "update_issue": {
      const rec = getRepo(argStr(args, "owner") ?? "", argStr(args, "repo") ?? "");
      if (rec === null) return toolError("Repository not found");
      const num = argNum(args, "number");
      const issue = num === null ? undefined : rec.issues.get(num);
      if (issue === undefined) return toolError("Issue not found");
      advanceTick();
      const title = argStr(args, "title");
      if (title !== null) issue.title = title;
      if (args.body !== undefined) issue.body = argStr(args, "body");
      const state = argStr(args, "state");
      if (state === "closed" || state === "open") {
        issue.state = state;
        issue.closedAt = state === "closed" ? isoNow() : null;
      }
      issue.updatedAt = isoNow();
      rec.updatedAt = isoNow();
      invalidateRepo(rec.owner, rec.name);
      return toolResult(serializeIssue(rec, issue));
    }
    case "create_pull_request": {
      const rec = getRepo(argStr(args, "owner") ?? "", argStr(args, "repo") ?? "");
      if (rec === null) return toolError("Repository not found");
      const title = argStr(args, "title");
      const head = argStr(args, "head");
      const base = argStr(args, "base");
      if (title === null || head === null || base === null) {
        return toolError("title, head and base are required");
      }
      const pr = createPrOp(rec, title, argStr(args, "body"), head, base, rec.owner);
      if (isOpError(pr)) return toolError(pr.message);
      return toolResult(serializePr(rec, pr));
    }
    case "merge_pull_request": {
      const rec = getRepo(argStr(args, "owner") ?? "", argStr(args, "repo") ?? "");
      if (rec === null) return toolError("Repository not found");
      const num = argNum(args, "pull_number") ?? argNum(args, "number");
      const pr = num === null ? undefined : rec.prs.get(num);
      if (pr === undefined) return toolError("Pull request not found");
      const result = mergePrOp(
        rec,
        pr,
        argStr(args, "merge_method") ?? "merge",
        argStr(args, "commit_title"),
        argStr(args, "commit_message"),
      );
      if (isOpError(result)) return toolError(result.message);
      return toolResult({ sha: result.sha, merged: true, message: "Pull Request successfully merged" });
    }
    case "get_file_contents": {
      const rec = getRepo(argStr(args, "owner") ?? "", argStr(args, "repo") ?? "");
      if (rec === null) return toolError("Repository not found");
      const path = argStr(args, "path") ?? "";
      const result = getContentOp(rec, path, argStr(args, "ref"));
      if (result === null) return toolError("Path not found");
      if (result.kind === "dir") {
        return toolResult({ type: "dir", path: path, entries: result.entries });
      }
      return toolResult({
        type: "file",
        name: result.entry.name,
        path: result.entry.path,
        sha: result.entry.sha,
        size: result.entry.size,
        encoding: "base64",
        content: result.data.toString("base64"),
        text: result.data.toString("utf8"),
      });
    }
    case "create_or_update_file": {
      const rec = getRepo(argStr(args, "owner") ?? "", argStr(args, "repo") ?? "");
      if (rec === null) return toolError("Repository not found");
      const path = argStr(args, "path");
      const content = argStr(args, "content");
      const message = argStr(args, "message");
      if (path === null || content === null || message === null) {
        return toolError("path, content and message are required");
      }
      const result = putContentOp(
        rec,
        path,
        Buffer.from(content, "utf8"),
        message,
        argStr(args, "branch"),
        argStr(args, "sha"),
      );
      if (isOpError(result)) return toolError(result.message);
      return toolResult({
        content: {
          name: result.entry.name,
          path: result.entry.path,
          sha: result.entry.sha,
          size: result.entry.size,
          type: "file",
        },
        commit: { sha: result.commitOid },
      });
    }
  }
  return toolError("Unknown tool: " + name);
}

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function handleOne(req: RpcRequest): Record<string, unknown> | null {
  const hasId = "id" in req && req.id !== undefined;
  if (!hasId) return null; // notification: no response object
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === "string" ? req.method : "";
  const params: Record<string, unknown> =
    typeof req.params === "object" && req.params !== null ? req.params : {};
  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id: id, result: result });
  const err = (code: number, message: string): Record<string, unknown> => ({
    jsonrpc: "2.0",
    id: id,
    error: { code: code, message: message },
  });

  if (method === "initialize") {
    return ok({
      protocolVersion:
        typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "standalone-git-forge", version: "1.0.0" },
    });
  }
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: TOOLS });
  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    if (!TOOLS.some((t) => t.name === name)) {
      return err(-32602, "Unknown tool: " + name);
    }
    const args: Record<string, unknown> =
      typeof params.arguments === "object" && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {};
    return ok(callTool(name, args));
  }
  return err(-32601, "Method not found: " + method);
}

export function handleMcp(res: ServerResponse, body: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    const payload = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
      "utf8",
    );
    res.sendDate = false;
    res.writeHead(400, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(payload.length),
      "Date": httpDateNow(),
      "Connection": "keep-alive",
    });
    res.end(payload);
    return;
  }

  const respond = (payload: Buffer | null, status: number): void => {
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
  };

  if (Array.isArray(parsed)) {
    const responses: Record<string, unknown>[] = [];
    for (const item of parsed) {
      const r = handleOne(item as RpcRequest);
      if (r !== null) responses.push(r);
    }
    if (responses.length === 0) {
      respond(null, 202);
      return;
    }
    respond(Buffer.from(JSON.stringify(responses), "utf8"), 200);
    return;
  }
  const single = handleOne(parsed as RpcRequest);
  if (single === null) {
    respond(null, 202);
    return;
  }
  respond(Buffer.from(JSON.stringify(single), "utf8"), 200);
}
