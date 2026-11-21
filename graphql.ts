// graphql.ts — A hand-written GraphQL lexer, recursive-descent parser and
// executor (no external libraries) covering the query/mutation shapes that
// `gh` and github-mcp-server send: named/anonymous operations, variables
// with defaults, aliases, nested arguments, inline fragments and fragment
// spreads, all resolved against the same store as REST and MCP.

import type { ServerResponse } from "node:http";
import { advanceTick, httpDateNow, isoNow } from "./clock.ts";
import {
  type RepoRec,
  type IssueRec,
  type PrRec,
  BASE_URL,
  repos,
  getRepo,
  makeComment,
  invalidateRepo,
} from "./store.ts";
import { getObject, parseTree, parseCommit, resolveRev } from "./git.ts";
import {
  VIEWER_LOGIN,
  createRepoOp,
  createIssueOp,
  createPrOp,
  mergePrOp,
  prFilesList,
  prHasConflict,
  isOpError,
  parseIdent,
} from "./rest.ts";

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

interface Token {
  kind: string; // "name" | "int" | "float" | "string" | "punct" | "eof"
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  const isNameStart = (c: string): boolean =>
    (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
  const isNameChar = (c: string): boolean =>
    isNameStart(c) || (c >= "0" && c <= "9");
  while (i < n) {
    const c = input[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "," || c === "\uFEFF") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    if (c === "." && input.slice(i, i + 3) === "...") {
      tokens.push({ kind: "punct", value: "..." });
      i += 3;
      continue;
    }
    if ("!$():=@[]{}|".indexOf(c) >= 0) {
      tokens.push({ kind: "punct", value: c });
      i++;
      continue;
    }
    if (c === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        const raw = end < 0 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: "string", value: raw });
        i = end < 0 ? n : end + 3;
        continue;
      }
      let j = i + 1;
      let out = "";
      while (j < n && input[j] !== '"') {
        if (input[j] === "\\" && j + 1 < n) {
          const esc = input[j + 1];
          if (esc === "n") out += "\n";
          else if (esc === "t") out += "\t";
          else if (esc === "r") out += "\r";
          else if (esc === "b") out += "\b";
          else if (esc === "f") out += "\f";
          else if (esc === "/") out += "/";
          else if (esc === "\\") out += "\\";
          else if (esc === '"') out += '"';
          else if (esc === "u") {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += input[j];
          j++;
        }
      }
      tokens.push({ kind: "string", value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < n && isNameChar(input[j])) j++;
      tokens.push({ kind: "name", value: input.slice(i, j) });
      i = j;
      continue;
    }
    if ((c >= "0" && c <= "9") || c === "-") {
      let j = i;
      let isFloat = false;
      if (input[j] === "-") j++;
      while (j < n && input[j] >= "0" && input[j] <= "9") j++;
      if (input[j] === ".") {
        isFloat = true;
        j++;
        while (j < n && input[j] >= "0" && input[j] <= "9") j++;
      }
      if (input[j] === "e" || input[j] === "E") {
        isFloat = true;
        j++;
        if (input[j] === "+" || input[j] === "-") j++;
        while (j < n && input[j] >= "0" && input[j] <= "9") j++;
      }
      tokens.push({ kind: isFloat ? "float" : "int", value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error("GraphQL lexer: unexpected character " + JSON.stringify(c));
  }
  tokens.push({ kind: "eof", value: "" });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: "variable"; name: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "enum"; value: string }
  | { kind: "list"; values: ValueNode[] }
  | { kind: "object"; fields: Map<string, ValueNode> };

interface FieldNode {
  kind: "field";
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: "inlineFragment"; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: "fragmentSpread"; name: string };

interface OperationNode {
  operation: string; // query | mutation
  name: string | null;
  varDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class Parser {
  tokens: Token[];
  pos: number;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek(): Token {
    return this.tokens[this.pos];
  }
  next(): Token {
    return this.tokens[this.pos++];
  }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== "punct" || t.value !== v) throw new Error("GraphQL parse: expected " + v);
  }
  skipPunct(v: string): boolean {
    const t = this.peek();
    if (t.kind === "punct" && t.value === v) {
      this.pos++;
      return true;
    }
    return false;
  }
  expectName(): string {
    const t = this.next();
    if (t.kind !== "name") throw new Error("GraphQL parse: expected name");
    return t.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== "eof") {
      const t = this.peek();
      if (t.kind === "punct" && t.value === "{") {
        operations.push({
          operation: "query",
          name: null,
          varDefaults: new Map(),
          selectionSet: this.parseSelectionSet(),
        });
      } else if (t.kind === "name" && (t.value === "query" || t.value === "mutation" || t.value === "subscription")) {
        const op = this.next().value;
        let name: string | null = null;
        if (this.peek().kind === "name") name = this.next().value;
        const varDefaults = new Map<string, ValueNode>();
        if (this.skipPunct("(")) {
          while (!this.skipPunct(")")) {
            this.expectPunct("$");
            const varName = this.expectName();
            this.expectPunct(":");
            this.parseType();
            if (this.skipPunct("=")) varDefaults.set(varName, this.parseValue());
            this.skipDirectives();
          }
        }
        this.skipDirectives();
        operations.push({
          operation: op,
          name: name,
          varDefaults: varDefaults,
          selectionSet: this.parseSelectionSet(),
        });
      } else if (t.kind === "name" && t.value === "fragment") {
        this.next();
        const fragName = this.expectName();
        const onKw = this.expectName();
        if (onKw !== "on") throw new Error("GraphQL parse: expected 'on' in fragment");
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, {
          name: fragName,
          typeCondition: typeCondition,
          selectionSet: this.parseSelectionSet(),
        });
      } else {
        throw new Error("GraphQL parse: unexpected token " + t.value);
      }
    }
    return { operations: operations, fragments: fragments };
  }

  parseType(): void {
    if (this.skipPunct("[")) {
      this.parseType();
      this.expectPunct("]");
    } else {
      this.expectName();
    }
    this.skipPunct("!");
  }

  skipDirectives(): void {
    while (this.skipPunct("@")) {
      this.expectName();
      if (this.skipPunct("(")) {
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === "eof") throw new Error("GraphQL parse: unterminated directive");
          if (t.kind === "punct" && t.value === "(") depth++;
          if (t.kind === "punct" && t.value === ")") depth--;
        }
      }
    }
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct("{");
    const selections: SelectionNode[] = [];
    while (!this.skipPunct("}")) {
      if (this.peek().kind === "eof") throw new Error("GraphQL parse: unterminated selection set");
      if (this.peek().kind === "punct" && this.peek().value === "...") {
        this.next();
        if (this.peek().kind === "name" && this.peek().value === "on") {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({
            kind: "inlineFragment",
            typeCondition: typeCondition,
            selectionSet: this.parseSelectionSet(),
          });
        } else {
          const spreadName = this.expectName();
          this.skipDirectives();
          selections.push({ kind: "fragmentSpread", name: spreadName });
        }
        continue;
      }
      selections.push(this.parseField());
    }
    return selections;
  }

  parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(":")) {
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, ValueNode>();
    if (this.skipPunct("(")) {
      while (!this.skipPunct(")")) {
        const argName = this.expectName();
        this.expectPunct(":");
        args.set(argName, this.parseValue());
      }
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === "punct" && this.peek().value === "{") {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: "field", alias: alias, name: name, args: args, selectionSet: selectionSet };
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === "punct" && t.value === "$") {
      return { kind: "variable", name: this.expectName() };
    }
    if (t.kind === "punct" && t.value === "[") {
      const values: ValueNode[] = [];
      while (!this.skipPunct("]")) values.push(this.parseValue());
      return { kind: "list", values: values };
    }
    if (t.kind === "punct" && t.value === "{") {
      const fields = new Map<string, ValueNode>();
      while (!this.skipPunct("}")) {
        const k = this.expectName();
        this.expectPunct(":");
        fields.set(k, this.parseValue());
      }
      return { kind: "object", fields: fields };
    }
    if (t.kind === "int") return { kind: "int", value: parseInt(t.value, 10) };
    if (t.kind === "float") return { kind: "float", value: parseFloat(t.value) };
    if (t.kind === "string") return { kind: "string", value: t.value };
    if (t.kind === "name") {
      if (t.value === "true") return { kind: "boolean", value: true };
      if (t.value === "false") return { kind: "boolean", value: false };
      if (t.value === "null") return { kind: "null" };
      return { kind: "enum", value: t.value };
    }
    throw new Error("GraphQL parse: unexpected value token " + t.value);
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

// Wrapped runtime values carry their GraphQL type in __type.
interface GqlObj {
  __type: string;
  [key: string]: unknown;
}

function obj(type: string, fields: Record<string, unknown>): GqlObj {
  const o: GqlObj = { __type: type };
  for (const k of Object.keys(fields)) o[k] = fields[k];
  return o;
}

function nodeId(kind: string, id: number | string): string {
  return Buffer.from(kind + ":" + id).toString("base64");
}

function decodeNodeId(id: string): { kind: string; id: string } | null {
  try {
    const raw = Buffer.from(id, "base64").toString("utf8");
    const colon = raw.indexOf(":");
    if (colon < 0) return null;
    return { kind: raw.slice(0, colon), id: raw.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoWrapper(rec: RepoRec): GqlObj {
  return obj("Repository", { rec: rec });
}
function issueWrapper(rec: RepoRec, issue: IssueRec): GqlObj {
  return obj("Issue", { rec: rec, issue: issue });
}
function prWrapper(rec: RepoRec, pr: PrRec): GqlObj {
  return obj("PullRequest", { rec: rec, pr: pr });
}
function userWrapper(login: string): GqlObj {
  return obj("User", { login: login });
}
function commitWrapper(rec: RepoRec, oid: string): GqlObj {
  return obj("Commit", { rec: rec, oid: oid });
}

// ---------------------------------------------------------------------------
// Schema registry for __type introspection and unknown-field errors.
// ---------------------------------------------------------------------------

interface TypeInfo {
  kind: string; // OBJECT | ENUM | INTERFACE | SCALAR
  fields: string[];
  enumValues: string[];
}

const TYPE_REGISTRY: Record<string, TypeInfo> = {
  Query: {
    kind: "OBJECT",
    fields: ["viewer", "repository", "node", "nodes", "user", "organization", "search", "rateLimit", "__type", "__schema"],
    enumValues: [],
  },
  Mutation: {
    kind: "OBJECT",
    fields: ["createRepository", "createIssue", "updateIssue", "closeIssue", "reopenIssue", "createPullRequest", "updatePullRequest", "mergePullRequest", "closePullRequest", "addComment"],
    enumValues: [],
  },
  User: {
    kind: "OBJECT",
    fields: ["id", "login", "name", "email", "url", "avatarUrl", "repository", "repositories", "issues", "pullRequests", "createdAt", "updatedAt", "isViewer"],
    enumValues: [],
  },
  Organization: {
    kind: "OBJECT",
    fields: ["id", "login", "name", "url", "avatarUrl", "repository", "repositories"],
    enumValues: [],
  },
  Repository: {
    kind: "OBJECT",
    fields: ["id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequest", "pullRequests", "description", "isPrivate", "isFork", "url", "createdAt", "updatedAt", "object", "ref", "refs", "stargazerCount", "forkCount", "primaryLanguage", "licenseInfo"],
    enumValues: [],
  },
  Issue: {
    kind: "OBJECT",
    fields: ["id", "number", "title", "titleHTML", "body", "bodyHTML", "state", "url", "author", "repository", "comments", "labels", "assignees", "createdAt", "updatedAt", "closedAt", "milestone", "reactionGroups", "participants"],
    enumValues: [],
  },
  PullRequest: {
    kind: "OBJECT",
    fields: ["id", "number", "title", "body", "state", "merged", "mergeable", "headRefName", "baseRefName", "headRef", "baseRef", "headRefOid", "baseRefOid", "files", "commits", "author", "repository", "createdAt", "updatedAt", "closedAt", "mergedAt", "mergeCommit", "url", "additions", "deletions", "changedFiles", "comments", "labels"],
    enumValues: [],
  },
  PullRequestChangedFile: {
    kind: "OBJECT",
    fields: ["path", "additions", "deletions", "changeType"],
    enumValues: [],
  },
  IssueComment: {
    kind: "OBJECT",
    fields: ["id", "body", "bodyHTML", "author", "createdAt", "updatedAt", "url", "issue"],
    enumValues: [],
  },
  Ref: { kind: "OBJECT", fields: ["id", "name", "prefix", "target", "repository"], enumValues: [] },
  Commit: {
    kind: "OBJECT",
    fields: ["id", "oid", "message", "messageHeadline", "messageBody", "author", "committer", "tree", "treeOid", "url", "parents", "committedDate", "authoredDate", "history"],
    enumValues: [],
  },
  Tree: { kind: "OBJECT", fields: ["id", "oid", "entries"], enumValues: [] },
  TreeEntry: { kind: "OBJECT", fields: ["name", "type", "mode", "oid", "object", "path"], enumValues: [] },
  Blob: { kind: "OBJECT", fields: ["id", "oid", "byteSize", "text", "isTruncated", "isBinary"], enumValues: [] },
  GitActor: { kind: "OBJECT", fields: ["name", "email", "date", "user", "avatarUrl"], enumValues: [] },
  PageInfo: {
    kind: "OBJECT",
    fields: ["hasNextPage", "hasPreviousPage", "startCursor", "endCursor"],
    enumValues: [],
  },
  SearchType: { kind: "ENUM", fields: [], enumValues: ["ISSUE", "REPOSITORY", "USER", "CODE", "COMMIT", "PULL_REQUEST", "DISCUSSION"] },
  IssueState: { kind: "ENUM", fields: [], enumValues: ["OPEN", "CLOSED"] },
  PullRequestState: { kind: "ENUM", fields: [], enumValues: ["OPEN", "CLOSED", "MERGED"] },
  MergeableState: { kind: "ENUM", fields: [], enumValues: ["MERGEABLE", "CONFLICTING", "UNKNOWN"] },
  PullRequestMergeMethod: { kind: "ENUM", fields: [], enumValues: ["MERGE", "SQUASH", "REBASE"] },
  RepositoryPermission: { kind: "ENUM", fields: [], enumValues: ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"] },
  IssueOrderField: { kind: "ENUM", fields: [], enumValues: ["CREATED_AT", "UPDATED_AT", "COMMENTS"] },
  OrderDirection: { kind: "ENUM", fields: [], enumValues: ["ASC", "DESC"] },
  FileStatus: { kind: "ENUM", fields: [], enumValues: ["ADDED", "DELETED", "MODIFIED", "RENAMED", "COPIED", "CHANGED", "UNCHANGED"] },
};

// Field names accepted per wrapper type when validating a document; a field
// outside the set is reported as a GraphQL error naming the field. Types not
// listed here (payloads, edges, connections, introspection types) accept the
// fields their resolvers know.
const FIELD_SETS: Record<string, Set<string>> = {};
for (const typeName of Object.keys(TYPE_REGISTRY)) {
  FIELD_SETS[typeName] = new Set(TYPE_REGISTRY[typeName].fields);
}
FIELD_SETS["__Type"] = new Set(["name", "kind", "description", "fields", "enumValues", "possibleTypes", "inputFields", "ofType", "specifiedByURL", "interfaces"]);
FIELD_SETS["__Field"] = new Set(["name", "description", "args", "type", "isDeprecated", "deprecationReason"]);
FIELD_SETS["__EnumValue"] = new Set(["name", "description", "isDeprecated", "deprecationReason"]);
FIELD_SETS["__Schema"] = new Set(["types", "queryType", "mutationType", "subscriptionType", "directives", "description"]);

interface Ctx {
  variables: Map<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string }[];
}

function valueOf(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case "variable":
      return ctx.variables.get(node.name);
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "enum":
      return node.value;
    case "null":
      return null;
    case "list":
      return node.values.map((v) => valueOf(v, ctx));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of node.fields) out[k] = valueOf(v, ctx);
      return out;
    }
  }
}

function argStr(args: Map<string, ValueNode>, name: string, ctx: Ctx): string | null {
  const v = args.get(name);
  if (v === undefined) return null;
  const val = valueOf(v, ctx);
  return typeof val === "string" ? val : null;
}
function argInt(args: Map<string, ValueNode>, name: string, ctx: Ctx): number | null {
  const v = args.get(name);
  if (v === undefined) return null;
  const val = valueOf(v, ctx);
  return typeof val === "number" ? val : null;
}
function argObj(args: Map<string, ValueNode>, name: string, ctx: Ctx): Record<string, unknown> {
  const v = args.get(name);
  if (v === undefined) return {};
  const val = valueOf(v, ctx);
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}
function argList(args: Map<string, ValueNode>, name: string, ctx: Ctx): unknown[] {
  const v = args.get(name);
  if (v === undefined) return [];
  const val = valueOf(v, ctx);
  if (Array.isArray(val)) return val;
  if (val === null || val === undefined) return [];
  return [val];
}

function findRepoById(idNum: number): RepoRec | null {
  for (const rec of repos.values()) if (rec.id === idNum) return rec;
  return null;
}
function findIssueById(idNum: number): { rec: RepoRec; issue: IssueRec } | null {
  for (const rec of repos.values()) {
    for (const issue of rec.issues.values()) {
      if (issue.id === idNum) return { rec: rec, issue: issue };
    }
  }
  return null;
}
function findPrById(idNum: number): { rec: RepoRec; pr: PrRec } | null {
  for (const rec of repos.values()) {
    for (const pr of rec.prs.values()) {
      if (pr.id === idNum) return { rec: rec, pr: pr };
    }
  }
  return null;
}

function cursorOf(index: number): string {
  return Buffer.from("cursor:" + index).toString("base64");
}

function decodeCursor(cursor: string | null): number {
  if (cursor === null) return -1;
  try {
    const raw = Buffer.from(cursor, "base64").toString("utf8");
    if (!raw.startsWith("cursor:")) return -1;
    const n = parseInt(raw.slice("cursor:".length), 10);
    return Number.isNaN(n) ? -1 : n;
  } catch {
    return -1;
  }
}

// A Relay-style connection over `items` (already in final order): `after`
// resumes past that cursor's index, `first` caps the page. Cursors and
// pageInfo are expressed in full-list coordinates so pages chain.
function connection(type: string, items: GqlObj[], first: number | null, after?: string | null): GqlObj {
  const start = Math.max(0, decodeCursor(after === undefined ? null : after) + 1);
  const rest = items.slice(start);
  const sliced = first === null ? rest : rest.slice(0, first);
  const endIndex = start + sliced.length - 1;
  return obj(type, {
    items: sliced,
    totalCount: items.length,
    pageInfo: {
      hasNextPage: start + sliced.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: sliced.length > 0 ? cursorOf(start) : null,
      endCursor: sliced.length > 0 ? cursorOf(endIndex) : null,
    },
  });
}

// Resolve one field on one parent object to a raw value (scalar, GqlObj,
// array of GqlObj, or null).
function resolveField(
  parent: GqlObj,
  field: string,
  args: Map<string, ValueNode>,
  ctx: Ctx,
): unknown {
  const type = parent.__type;

  if (type === "Query") {
    if (field === "__type") {
      const name = argStr(args, "name", ctx);
      if (name === null) return null;
      const info = TYPE_REGISTRY[name];
      if (info === undefined) return null;
      return obj("__Type", {
        name: name,
        kind: info.kind,
        fieldsList: info.fields.map((f) => obj("__Field", { name: f })),
        enumValuesList: info.enumValues.map((v) => obj("__EnumValue", { name: v })),
      });
    }
    if (field === "__schema") {
      return obj("__Schema", {
        typesList: Object.keys(TYPE_REGISTRY).map((n) => {
          const info = TYPE_REGISTRY[n];
          return obj("__Type", {
            name: n,
            kind: info.kind,
            fieldsList: info.fields.map((f) => obj("__Field", { name: f })),
            enumValuesList: info.enumValues.map((v) => obj("__EnumValue", { name: v })),
          });
        }),
      });
    }
    if (field === "viewer") return userWrapper(VIEWER_LOGIN);
    if (field === "repository") {
      const owner = argStr(args, "owner", ctx);
      const name = argStr(args, "name", ctx);
      if (owner === null || name === null) return null;
      const rec = getRepo(owner, name);
      return rec === null ? null : repoWrapper(rec);
    }
    if (field === "node") {
      const id = argStr(args, "id", ctx);
      if (id === null) return null;
      const decoded = decodeNodeId(id);
      if (decoded === null) return null;
      if (decoded.kind === "Repository") {
        const rec = findRepoById(parseInt(decoded.id, 10));
        return rec === null ? null : repoWrapper(rec);
      }
      if (decoded.kind === "Issue") {
        const found = findIssueById(parseInt(decoded.id, 10));
        return found === null ? null : issueWrapper(found.rec, found.issue);
      }
      if (decoded.kind === "PullRequest") {
        const found = findPrById(parseInt(decoded.id, 10));
        return found === null ? null : prWrapper(found.rec, found.pr);
      }
      return null;
    }
    return null;
  }

  if (type === "Mutation") {
    if (field === "createRepository") {
      const input = argObj(args, "input", ctx);
      const name = typeof input.name === "string" ? input.name : "";
      const description = typeof input.description === "string" ? input.description : null;
      const visibility = typeof input.visibility === "string" ? input.visibility : "PUBLIC";
      const created = createRepoOp(
        VIEWER_LOGIN,
        name,
        description,
        visibility === "PRIVATE",
        false,
        "main",
      );
      if (isOpError(created)) throw new Error(created.message);
      return obj("CreateRepositoryPayload", {
        clientMutationId: typeof input.clientMutationId === "string" ? input.clientMutationId : null,
        repository: repoWrapper(created),
      });
    }
    if (field === "createIssue") {
      const input = argObj(args, "input", ctx);
      let rec: RepoRec | null = null;
      if (typeof input.repositoryId === "string") {
        const decoded = decodeNodeId(input.repositoryId);
        if (decoded !== null) rec = findRepoById(parseInt(decoded.id, 10));
      }
      if (rec === null && typeof input.owner === "string" && typeof input.name === "string") {
        rec = getRepo(input.owner, input.name);
      }
      if (rec === null) throw new Error("Repository not found");
      const title = typeof input.title === "string" ? input.title : "";
      const body = typeof input.body === "string" ? input.body : null;
      const issue = createIssueOp(rec, title, body, rec.owner);
      return obj("CreateIssuePayload", {
        clientMutationId: typeof input.clientMutationId === "string" ? input.clientMutationId : null,
        issue: issueWrapper(rec, issue),
      });
    }
    if (field === "updateIssue") {
      const input = argObj(args, "input", ctx);
      if (typeof input.id !== "string") throw new Error("id is required");
      const decoded = decodeNodeId(input.id);
      if (decoded === null) throw new Error("Invalid issue id");
      const found = findIssueById(parseInt(decoded.id, 10));
      if (found === null) throw new Error("Issue not found");
      const issue = found.issue;
      if (typeof input.title === "string") issue.title = input.title;
      if (typeof input.body === "string" || input.body === null) issue.body = input.body as string | null;
      if (typeof input.state === "string") {
        const st = (input.state as string).toUpperCase();
        if (st === "CLOSED") {
          issue.state = "closed";
          issue.closedAt = isoNow();
        } else if (st === "OPEN") {
          issue.state = "open";
          issue.closedAt = null;
        }
      }
      issue.updatedAt = isoNow();
      return obj("UpdateIssuePayload", {
        clientMutationId: typeof input.clientMutationId === "string" ? input.clientMutationId : null,
        issue: issueWrapper(found.rec, issue),
      });
    }
    if (field === "closeIssue") {
      const input = argObj(args, "input", ctx);
      if (typeof input.issueId !== "string") throw new Error("issueId is required");
      const decoded = decodeNodeId(input.issueId);
      if (decoded === null) throw new Error("Invalid issue id");
      const found = findIssueById(parseInt(decoded.id, 10));
      if (found === null) throw new Error("Issue not found");
      advanceTick();
      found.issue.state = "closed";
      found.issue.closedAt = isoNow();
      found.issue.updatedAt = isoNow();
      invalidateRepo(found.rec.owner, found.rec.name);
      return obj("CloseIssuePayload", {
        clientMutationId: typeof input.clientMutationId === "string" ? input.clientMutationId : null,
        issue: issueWrapper(found.rec, found.issue),
      });
    }
    if (field === "addComment") {
      const input = argObj(args, "input", ctx);
      if (typeof input.subjectId !== "string") throw new Error("subjectId is required");
      const bodyText = typeof input.body === "string" ? input.body : "";
      const decoded = decodeNodeId(input.subjectId);
      if (decoded === null) throw new Error("Invalid subject id");
      const idNum = parseInt(decoded.id, 10);
      let rec: RepoRec | null = null;
      let number = 0;
      if (decoded.kind === "Issue") {
        const found = findIssueById(idNum);
        if (found !== null) {
          rec = found.rec;
          number = found.issue.number;
        }
      } else if (decoded.kind === "PullRequest") {
        const found = findPrById(idNum);
        if (found !== null) {
          rec = found.rec;
          number = found.pr.number;
        }
      }
      if (rec === null) throw new Error("Subject not found");
      advanceTick();
      const comment = makeComment(number, bodyText, rec.owner);
      const list = rec.comments.get(number);
      if (list === undefined) rec.comments.set(number, [comment]);
      else list.push(comment);
      rec.updatedAt = isoNow();
      invalidateRepo(rec.owner, rec.name);
      const node = obj("IssueComment", {
        rec: rec,
        commentId: comment.id,
        body: comment.body,
        authorLogin: comment.authorLogin,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        issueNumber: number,
      });
      return obj("AddCommentPayload", {
        clientMutationId: typeof input.clientMutationId === "string" ? input.clientMutationId : null,
        commentEdge: obj("CommentEdge", { nodeValue: node, cursor: cursorOf(0) }),
      });
    }
    if (field === "createPullRequest") {
      const input = argObj(args, "input", ctx);
      let rec: RepoRec | null = null;
      if (typeof input.repositoryId === "string") {
        const decoded = decodeNodeId(input.repositoryId);
        if (decoded !== null) rec = findRepoById(parseInt(decoded.id, 10));
      }
      if (rec === null) throw new Error("Repository not found");
      const title = typeof input.title === "string" ? input.title : "";
      const body = typeof input.body === "string" ? input.body : null;
      const headRef = typeof input.headRefName === "string" ? input.headRefName : "";
      const baseRef = typeof input.baseRefName === "string" ? input.baseRefName : "";
      const pr = createPrOp(rec, title, body, headRef, baseRef, rec.owner);
      if (isOpError(pr)) throw new Error(pr.message);
      return obj("CreatePullRequestPayload", {
        clientMutationId: typeof input.clientMutationId === "string" ? input.clientMutationId : null,
        pullRequest: prWrapper(rec, pr),
      });
    }
    if (field === "mergePullRequest") {
      const input = argObj(args, "input", ctx);
      if (typeof input.pullRequestId !== "string") throw new Error("pullRequestId is required");
      const decoded = decodeNodeId(input.pullRequestId);
      if (decoded === null) throw new Error("Invalid pull request id");
      const found = findPrById(parseInt(decoded.id, 10));
      if (found === null) throw new Error("Pull request not found");
      let method = "merge";
      if (typeof input.mergeMethod === "string") {
        const mm = (input.mergeMethod as string).toUpperCase();
        if (mm === "SQUASH") method = "squash";
        else if (mm === "REBASE") method = "rebase";
        else method = "merge";
      }
      const headline = typeof input.commitHeadline === "string" ? input.commitHeadline : null;
      const bodyText = typeof input.commitBody === "string" ? input.commitBody : null;
      const result = mergePrOp(found.rec, found.pr, method, headline, bodyText);
      if (isOpError(result)) throw new Error(result.message);
      return obj("MergePullRequestPayload", {
        clientMutationId: typeof input.clientMutationId === "string" ? input.clientMutationId : null,
        pullRequest: prWrapper(found.rec, found.pr),
      });
    }
    return null;
  }

  if (type === "User" || type === "Organization") {
    const login = parent.login as string;
    if (field === "login") return login;
    if (field === "id") return nodeId("User", login.length * 7 + 1);
    if (field === "url") return BASE_URL + "/" + login;
    if (field === "name") return login;
    if (field === "repository") {
      const name = argStr(args, "name", ctx);
      if (name === null) return null;
      const rec = getRepo(login, name);
      return rec === null ? null : repoWrapper(rec);
    }
    return null;
  }

  if (type === "__Type") {
    if (field === "name") return parent.name;
    if (field === "kind") return parent.kind;
    if (field === "description") return null;
    if (field === "fields") return parent.kind === "ENUM" ? null : parent.fieldsList;
    if (field === "enumValues") return parent.kind === "ENUM" ? parent.enumValuesList : null;
    if (field === "possibleTypes") return null;
    if (field === "inputFields") return null;
    if (field === "ofType") return null;
    if (field === "interfaces") return [];
    return null;
  }

  if (type === "__Field" || type === "__EnumValue") {
    if (field === "name") return parent.name;
    if (field === "description") return null;
    if (field === "isDeprecated") return false;
    if (field === "deprecationReason") return null;
    if (field === "args") return [];
    if (field === "type") return null;
    return null;
  }

  if (type === "__Schema") {
    if (field === "types") return parent.typesList;
    if (field === "queryType") return obj("__Type", { name: "Query", kind: "OBJECT", fieldsList: [], enumValuesList: [] });
    if (field === "mutationType") return obj("__Type", { name: "Mutation", kind: "OBJECT", fieldsList: [], enumValuesList: [] });
    if (field === "subscriptionType") return null;
    if (field === "directives") return [];
    if (field === "description") return null;
    return null;
  }

  if (type === "Repository") {
    const rec = parent.rec as RepoRec;
    switch (field) {
      case "id":
        return nodeId("Repository", rec.id);
      case "databaseId":
        return rec.id;
      case "viewerPermission":
        return "ADMIN";
      case "hasIssuesEnabled":
        return true;
      case "name":
        return rec.name;
      case "nameWithOwner":
        return rec.owner + "/" + rec.name;
      case "description":
        return rec.description;
      case "isPrivate":
        return rec.isPrivate;
      case "isFork":
        return false;
      case "url":
        return BASE_URL + "/" + rec.owner + "/" + rec.name;
      case "createdAt":
        return rec.createdAt;
      case "updatedAt":
        return rec.updatedAt;
      case "owner":
        return userWrapper(rec.owner);
      case "defaultBranchRef": {
        const tip = rec.refs.get("refs/heads/" + rec.defaultBranch);
        if (tip === undefined) return null;
        return obj("Ref", { rec: rec, name: rec.defaultBranch, oid: tip });
      }
      case "issue": {
        const num = argInt(args, "number", ctx);
        if (num === null) return null;
        const issue = rec.issues.get(num);
        return issue === undefined ? null : issueWrapper(rec, issue);
      }
      case "issues": {
        const first = argInt(args, "first", ctx);
        const after = argStr(args, "after", ctx);
        const states = argList(args, "states", ctx).map((s) => String(s).toUpperCase());
        const orderBy = argObj(args, "orderBy", ctx);
        const direction = typeof orderBy.direction === "string" ? (orderBy.direction as string).toUpperCase() : "DESC";
        const items: GqlObj[] = [];
        const sorted = Array.from(rec.issues.values()).sort((a, b) =>
          direction === "ASC" ? a.number - b.number : b.number - a.number,
        );
        for (const issue of sorted) {
          if (states.length > 0) {
            const want = issue.state === "open" ? "OPEN" : "CLOSED";
            if (!states.includes(want)) continue;
          }
          items.push(issueWrapper(rec, issue));
        }
        return connection("IssueConnection", items, first, after);
      }
      case "pullRequest": {
        const num = argInt(args, "number", ctx);
        if (num === null) return null;
        const pr = rec.prs.get(num);
        return pr === undefined ? null : prWrapper(rec, pr);
      }
      case "pullRequests": {
        const first = argInt(args, "first", ctx);
        const states = argList(args, "states", ctx).map((s) => String(s).toUpperCase());
        const items: GqlObj[] = [];
        const sorted = Array.from(rec.prs.values()).sort((a, b) => a.number - b.number);
        for (const pr of sorted) {
          if (states.length > 0) {
            const want = pr.state === "open" ? "OPEN" : "CLOSED";
            if (!states.includes(want)) continue;
          }
          items.push(prWrapper(rec, pr));
        }
        return connection("PullRequestConnection", items, first);
      }
      case "object": {
        const expr = argStr(args, "expression", ctx);
        if (expr === null) return null;
        return objectExpression(rec, expr);
      }
      case "ref": {
        const qualified = argStr(args, "qualifiedName", ctx);
        if (qualified === null) return null;
        const oid = rec.refs.get(qualified);
        if (oid === undefined) return null;
        const short = qualified.startsWith("refs/heads/") ? qualified.slice("refs/heads/".length) : qualified;
        return obj("Ref", { rec: rec, name: short, oid: oid });
      }
    }
    return null;
  }

  if (type === "Ref") {
    const rec = parent.rec as RepoRec;
    if (field === "name") return parent.name;
    if (field === "prefix") return "refs/heads/";
    if (field === "target") return commitWrapper(rec, parent.oid as string);
    return null;
  }

  if (type === "Commit") {
    const rec = parent.rec as RepoRec;
    const oid = parent.oid as string;
    const gitObj = getObject(rec, oid);
    if (gitObj === null) return null;
    const c = parseCommit(gitObj.data);
    switch (field) {
      case "id":
        return nodeId("Commit", oid);
      case "oid":
        return oid;
      case "message":
        return c.message;
      case "messageHeadline":
        return c.message.split("\n")[0];
      case "author": {
        const a = parseIdent(c.author);
        return obj("GitActor", { name: a.name, email: a.email, date: a.date });
      }
      case "committer": {
        const a = parseIdent(c.committer);
        return obj("GitActor", { name: a.name, email: a.email, date: a.date });
      }
      case "tree":
        return obj("Tree", { rec: rec, oid: c.tree });
      case "treeOid":
        return c.tree;
      case "url":
        return BASE_URL + "/" + rec.owner + "/" + rec.name + "/commit/" + oid;
      case "parents": {
        const first = argInt(args, "first", ctx);
        const items = c.parents.map((p) => commitWrapper(rec, p));
        return connection("CommitConnection", items, first);
      }
    }
    return null;
  }

  if (type === "Tree") {
    const rec = parent.rec as RepoRec;
    const oid = parent.oid as string;
    if (field === "id") return nodeId("Tree", oid);
    if (field === "oid") return oid;
    if (field === "entries") {
      const gitObj = getObject(rec, oid);
      if (gitObj === null) return [];
      return parseTree(gitObj.data).map((e) =>
        obj("TreeEntry", {
          rec: rec,
          name: e.name,
          mode: parseInt(e.mode, 10),
          entryType: e.mode === "40000" ? "tree" : "blob",
          oid: e.oid,
        }),
      );
    }
    return null;
  }

  if (type === "TreeEntry") {
    const rec = parent.rec as RepoRec;
    switch (field) {
      case "name":
        return parent.name;
      case "type":
        return parent.entryType;
      case "mode":
        return parent.mode;
      case "oid":
        return parent.oid;
      case "object": {
        const oid = parent.oid as string;
        const gitObj = getObject(rec, oid);
        if (gitObj === null) return null;
        if (gitObj.type === "tree") return obj("Tree", { rec: rec, oid: oid });
        if (gitObj.type === "blob") return obj("Blob", { rec: rec, oid: oid });
        if (gitObj.type === "commit") return commitWrapper(rec, oid);
        return null;
      }
    }
    return null;
  }

  if (type === "Blob") {
    const rec = parent.rec as RepoRec;
    const oid = parent.oid as string;
    const gitObj = getObject(rec, oid);
    if (field === "id") return nodeId("Blob", oid);
    if (field === "oid") return oid;
    if (field === "byteSize") return gitObj === null ? 0 : gitObj.data.length;
    if (field === "text") return gitObj === null ? null : gitObj.data.toString("utf8");
    if (field === "isTruncated") return false;
    return null;
  }

  if (type === "Issue") {
    const rec = parent.rec as RepoRec;
    const issue = parent.issue as IssueRec;
    switch (field) {
      case "id":
        return nodeId("Issue", issue.id);
      case "number":
        return issue.number;
      case "title":
        return issue.title;
      case "body":
        return issue.body;
      case "state":
        return issue.state === "open" ? "OPEN" : "CLOSED";
      case "url":
        return BASE_URL + "/" + rec.owner + "/" + rec.name + "/issues/" + issue.number;
      case "createdAt":
        return issue.createdAt;
      case "updatedAt":
        return issue.updatedAt;
      case "closedAt":
        return issue.closedAt;
      case "author":
        return userWrapper(issue.authorLogin);
      case "repository":
        return repoWrapper(rec);
      case "comments": {
        const first = argInt(args, "first", ctx);
        const list = rec.comments.get(issue.number) ?? [];
        const items = list.map((c) =>
          obj("IssueComment", { rec: rec, commentId: c.id, body: c.body, authorLogin: c.authorLogin, createdAt: c.createdAt, updatedAt: c.updatedAt, issueNumber: issue.number }),
        );
        return connection("IssueCommentConnection", items, first);
      }
    }
    return null;
  }

  if (type === "IssueComment") {
    switch (field) {
      case "id":
        return nodeId("IssueComment", parent.commentId as number);
      case "body":
        return parent.body;
      case "createdAt":
        return parent.createdAt;
      case "updatedAt":
        return parent.updatedAt;
      case "author":
        return userWrapper(parent.authorLogin as string);
    }
    return null;
  }

  if (type === "PullRequest") {
    const rec = parent.rec as RepoRec;
    const pr = parent.pr as PrRec;
    switch (field) {
      case "id":
        return nodeId("PullRequest", pr.id);
      case "number":
        return pr.number;
      case "title":
        return pr.title;
      case "body":
        return pr.body;
      case "state":
        return pr.merged ? "MERGED" : pr.state === "open" ? "OPEN" : "CLOSED";
      case "url":
        return BASE_URL + "/" + rec.owner + "/" + rec.name + "/pull/" + pr.number;
      case "createdAt":
        return pr.createdAt;
      case "updatedAt":
        return pr.updatedAt;
      case "closedAt":
        return pr.closedAt;
      case "mergedAt":
        return pr.mergedAt;
      case "merged":
        return pr.merged;
      case "author":
        return userWrapper(pr.authorLogin);
      case "repository":
        return repoWrapper(rec);
      case "headRefName":
        return pr.headRef;
      case "baseRefName":
        return pr.baseRef;
      case "headRefOid":
        return pr.headSha;
      case "baseRefOid":
        return pr.baseSha;
      case "mergeCommit":
        return pr.mergeCommitSha === null ? null : commitWrapper(rec, pr.mergeCommitSha);
      case "headRef":
        return obj("Ref", { rec: rec, name: pr.headRef, oid: pr.headSha });
      case "baseRef":
        return obj("Ref", { rec: rec, name: pr.baseRef, oid: pr.baseSha });
      case "mergeable":
        if (pr.merged || pr.state !== "open") return "UNKNOWN";
        return prHasConflict(rec, pr) ? "CONFLICTING" : "MERGEABLE";
      case "files": {
        const first = argInt(args, "first", ctx);
        const items = prFilesList(rec, pr).map((f) =>
          obj("PullRequestChangedFile", {
            path: f.filename,
            additions: f.additions,
            deletions: f.deletions,
            changeType: f.status === "added" ? "ADDED" : f.status === "removed" ? "DELETED" : "MODIFIED",
          }),
        );
        return connection("PullRequestChangedFileConnection", items, first);
      }
      case "additions": {
        let n = 0;
        for (const f of prFilesList(rec, pr)) n += f.additions;
        return n;
      }
      case "deletions": {
        let n = 0;
        for (const f of prFilesList(rec, pr)) n += f.deletions;
        return n;
      }
      case "changedFiles":
        return prFilesList(rec, pr).length;
    }
    return null;
  }

  if (type === "PullRequestChangedFile") {
    if (field === "path") return parent.path;
    if (field === "additions") return parent.additions;
    if (field === "deletions") return parent.deletions;
    if (field === "changeType") return parent.changeType;
    return null;
  }

  if (type.endsWith("Connection")) {
    const items = parent.items as GqlObj[];
    if (field === "totalCount") return parent.totalCount;
    if (field === "nodes") return items;
    if (field === "edges") {
      return items.map((item, idx) =>
        obj("Edge", { nodeValue: item, cursor: Buffer.from("cursor:" + idx).toString("base64") }),
      );
    }
    if (field === "pageInfo") {
      const info = parent.pageInfo as
        | { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
        | undefined;
      if (info !== undefined) return obj("PageInfo", info);
      return obj("PageInfo", {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      });
    }
    return null;
  }

  if (type === "Edge" || type === "CommentEdge") {
    if (field === "node") return parent.nodeValue;
    if (field === "cursor") return parent.cursor;
    return null;
  }

  if (type === "PageInfo") {
    if (field === "hasNextPage") return parent.hasNextPage;
    if (field === "hasPreviousPage") return parent.hasPreviousPage;
    if (field === "startCursor") return parent.startCursor;
    if (field === "endCursor") return parent.endCursor;
    return null;
  }

  if (type === "GitActor") {
    if (field === "name") return parent.name;
    if (field === "email") return parent.email;
    if (field === "date") return parent.date;
    if (field === "user") return null;
    return null;
  }

  if (type.endsWith("Payload")) {
    if (field === "clientMutationId") return parent.clientMutationId ?? null;
    if (field === "repository") return parent.repository ?? null;
    if (field === "issue") return parent.issue ?? null;
    if (field === "pullRequest") return parent.pullRequest ?? null;
    if (field === "commentEdge") return parent.commentEdge ?? null;
    if (field === "actor") return userWrapper(VIEWER_LOGIN);
    return null;
  }

  return null;
}

// repository.object(expression): "HEAD", "<branch>", "<oid>",
// "<rev>:<path>" — resolves to a Commit, Tree or Blob wrapper.
function objectExpression(rec: RepoRec, expr: string): GqlObj | null {
  let rev = expr;
  let path = "";
  const colon = expr.indexOf(":");
  if (colon >= 0) {
    rev = expr.slice(0, colon);
    path = expr.slice(colon + 1);
  }
  const commitOid = resolveRev(rec, rev === "" ? "HEAD" : rev);
  if (commitOid === null) return null;
  const commitObj = getObject(rec, commitOid);
  if (commitObj === null) return null;
  if (path === "") {
    if (commitObj.type === "commit") return commitWrapper(rec, commitOid);
    if (commitObj.type === "tree") return obj("Tree", { rec: rec, oid: commitOid });
    if (commitObj.type === "blob") return obj("Blob", { rec: rec, oid: commitOid });
    return null;
  }
  if (commitObj.type !== "commit") return null;
  let treeOid = parseCommit(commitObj.data).tree;
  const segs = path.split("/").filter((s) => s !== "");
  for (let i = 0; i < segs.length; i++) {
    const treeObj = getObject(rec, treeOid);
    if (treeObj === null || treeObj.type !== "tree") return null;
    const entry = parseTree(treeObj.data).find((e) => e.name === segs[i]);
    if (entry === undefined) return null;
    if (i === segs.length - 1) {
      if (entry.mode === "40000") return obj("Tree", { rec: rec, oid: entry.oid });
      return obj("Blob", { rec: rec, oid: entry.oid });
    }
    treeOid = entry.oid;
  }
  return null;
}

// Complete a raw resolved value against a selection set.
function completeValue(
  value: unknown,
  selectionSet: SelectionNode[] | null,
  ctx: Ctx,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((v) => completeValue(v, selectionSet, ctx));
  }
  if (typeof value === "object" && (value as GqlObj).__type !== undefined) {
    if (selectionSet === null) return null;
    return executeSelectionSet(value as GqlObj, selectionSet, ctx);
  }
  return value;
}

function executeSelectionSet(
  parent: GqlObj,
  selections: SelectionNode[],
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === "field") {
      const key = sel.alias === null ? sel.name : sel.alias;
      if (sel.name === "__typename") {
        out[key] = parent.__type;
        continue;
      }
      const fieldSet = FIELD_SETS[parent.__type];
      if (fieldSet !== undefined && !fieldSet.has(sel.name)) {
        ctx.errors.push({
          message: "Field '" + sel.name + "' doesn't exist on type '" + parent.__type + "'",
        });
        out[key] = null;
        continue;
      }
      const raw = resolveField(parent, sel.name, sel.args, ctx);
      out[key] = completeValue(raw, sel.selectionSet, ctx);
    } else if (sel.kind === "inlineFragment") {
      if (sel.typeCondition === null || sel.typeCondition === parent.__type) {
        const sub = executeSelectionSet(parent, sel.selectionSet, ctx);
        for (const k of Object.keys(sub)) out[k] = sub[k];
      }
    } else if (sel.kind === "fragmentSpread") {
      const frag = ctx.fragments.get(sel.name);
      if (frag !== undefined && frag.typeCondition === parent.__type) {
        const sub = executeSelectionSet(parent, frag.selectionSet, ctx);
        for (const k of Object.keys(sub)) out[k] = sub[k];
      }
    }
  }
  return out;
}

function executeOne(parsed: Record<string, unknown>): Record<string, unknown> {
  const query = typeof parsed.query === "string" ? parsed.query : "";
  const operationName = typeof parsed.operationName === "string" ? parsed.operationName : null;
  const variablesIn =
    typeof parsed.variables === "object" && parsed.variables !== null
      ? (parsed.variables as Record<string, unknown>)
      : {};
  try {
    const doc = new Parser(lex(query)).parseDocument();
    let operation: OperationNode | null = null;
    for (const op of doc.operations) {
      if (operationName === null || op.name === operationName) {
        operation = op;
        break;
      }
    }
    if (operation === null) return { errors: [{ message: "Operation not found" }] };
    const variables = new Map<string, unknown>();
    for (const [k, v] of operation.varDefaults)
      variables.set(k, valueOf(v, { variables: new Map(), fragments: doc.fragments, errors: [] }));
    for (const k of Object.keys(variablesIn)) variables.set(k, variablesIn[k]);
    const ctx: Ctx = { variables: variables, fragments: doc.fragments, errors: [] };
    const rootType = operation.operation === "mutation" ? "Mutation" : "Query";
    const root: GqlObj = obj(rootType, {});
    const data = executeSelectionSet(root, operation.selectionSet, ctx);
    if (ctx.errors.length > 0) return { data: data, errors: ctx.errors };
    return { data: data };
  } catch (e) {
    return { errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
}

export function executeGraphQL(body: Buffer): Record<string, unknown> | Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return { errors: [{ message: "Invalid JSON body" }] };
  }
  // GitHub operation batching: an array of documents answers an array of
  // results, in order.
  if (Array.isArray(parsed)) {
    return parsed.map((entry) =>
      executeOne(
        typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {},
      ),
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { errors: [{ message: "Invalid GraphQL request" }] };
  }
  return executeOne(parsed as Record<string, unknown>);
}

export function handleGraphQL(res: ServerResponse, body: Buffer): void {
  const result = executeGraphQL(body);
  const payload = Buffer.from(JSON.stringify(result), "utf8");
  res.sendDate = false;
  res.cork();
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(payload.length),
    "Date": httpDateNow(),
    "Connection": "keep-alive",
  });
  res.end(payload);
  res.uncork();
}
