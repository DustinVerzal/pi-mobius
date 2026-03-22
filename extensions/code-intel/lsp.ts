import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { readFile, stat } from "node:fs/promises";
import {
  createProtocolConnection,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  HoverRequest,
  InitializedNotification,
  InitializeRequest,
  ReferencesRequest,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver-protocol/node";
import { truncateHead, type TruncationResult } from "@mariozechner/pi-coding-agent";
import { CODE_INTEL_MAX_BYTES, CODE_INTEL_MAX_LINES, normalizePathArgument } from "./ast.js";

const STARTUP_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DEFINITION_RESULTS = 3;
const MAX_REFERENCE_RESULTS = 20;
const MAX_HOVER_LINES = 15;
const MAX_HOVER_BYTES = 2 * 1024;
const MAX_DEFINITION_BYTES = 4 * 1024;
const MAX_REFERENCES_BYTES = 8 * 1024;
const WORKSPACE_MARKERS = ["tsconfig.json", "jsconfig.json", "package.json", ".git"];

const documentVersions = new Map<string, number>();
const workspaceClients = new Map<string, TypeScriptLspClient>();

export class TypeScriptLspUnavailableError extends Error {}

interface CodeIntelSettings {
  codeIntel?: {
    lsp?: {
      typescript?: {
        command?: string[] | string;
      };
    };
  };
}

interface PositionRequest {
  cwd: string;
  filePath: string;
  line: number;
  column: number;
}

interface LspTextResult {
  text: string;
  details: Record<string, unknown>;
  truncation: TruncationResult;
}

interface TypeScriptDefinitionLocation {
  path: string;
  line: number;
  column: number;
  snippet: string;
}

interface TypeScriptReferenceLocation {
  path: string;
  line: number;
  column: number;
  snippet: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(command: string, cwd: string): Promise<boolean> {
  const looksLikePath = command.includes("/") || command.includes("\\") || command.startsWith(".");
  if (looksLikePath) {
    return pathExists(resolve(cwd, command));
  }

  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = process.platform === "win32"
    ? [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`]
    : [command];

  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      if (await pathExists(resolve(entry, candidate))) return true;
    }
  }

  return false;
}

async function readJson(path: string): Promise<CodeIntelSettings> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CodeIntelSettings;
  } catch {
    return {};
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

async function resolveTypeScriptServerCommand(cwd: string): Promise<string[]> {
  const globalSettings = await readJson(join(homedir(), ".pi/agent/settings.json"));
  const projectSettings = await readJson(join(cwd, ".pi/settings.json"));

  const configured = projectSettings.codeIntel?.lsp?.typescript?.command ?? globalSettings.codeIntel?.lsp?.typescript?.command;
  if (typeof configured === "string") {
    return [configured];
  }
  if (isStringArray(configured) && configured.length > 0) {
    return configured;
  }

  const localBinary = resolve(cwd, "node_modules", ".bin", process.platform === "win32" ? "typescript-language-server.cmd" : "typescript-language-server");
  if (await pathExists(localBinary)) {
    return [localBinary, "--stdio"];
  }

  return ["typescript-language-server", "--stdio"];
}

async function findWorkspaceRoot(cwd: string, targetFile: string): Promise<string> {
  const fallback = resolve(cwd);
  let current = dirname(targetFile);

  while (current.startsWith(fallback)) {
    for (const marker of WORKSPACE_MARKERS) {
      if (await pathExists(join(current, marker))) {
        return current;
      }
    }

    if (current === fallback) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return fallback;
}

function toUri(path: string): string {
  return pathToFileURL(path).href;
}

function fromUri(uri: string): string {
  return fileURLToPath(uri);
}

function normalizeFilePath(cwd: string, filePath: string): string {
  return resolve(cwd, normalizePathArgument(filePath) ?? "");
}

function ensureSupportedTypeScriptFile(filePath: string): void {
  const extension = extname(filePath).toLowerCase();
  if (![".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(extension)) {
    throw new TypeScriptLspUnavailableError(`TypeScript LSP in this MVP only supports TS/TSX/JS files. Received: ${filePath}`);
  }
}

function toLspPosition(line: number, column: number): { line: number; character: number } {
  return {
    line: Math.max(0, Math.floor(line) - 1),
    character: Math.max(0, Math.floor(column) - 1),
  };
}

function languageIdForPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".tsx":
      return "typescriptreact";
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".jsx":
      return "javascriptreact";
    default:
      return "javascript";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new TypeScriptLspUnavailableError(message)), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolvePromise(value);
    }, (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

async function readSnippet(filePath: string, targetLine: number, lineCount = 2): Promise<string> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, targetLine - 1);
    return lines.slice(start, start + lineCount).map((line) => line.trimEnd()).join("\n").trim();
  } catch {
    return "";
  }
}

function renderTruncatedText(content: string, maxBytes: number, maxLines: number, label: string): { text: string; truncation: TruncationResult } {
  const truncation = truncateHead(content, { maxBytes, maxLines });
  return {
    text: truncation.truncated
      ? `${truncation.content}\n\n[${label} truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines.]`
      : truncation.content,
    truncation,
  };
}

function normalizeLocations(result: any): Array<{ uri: string; range: any }> {
  if (!result) return [];
  const values = Array.isArray(result) ? result : [result];
  return values.flatMap((value) => {
    if (!value) return [];
    if (value.targetUri) {
      return [{ uri: value.targetUri, range: value.targetSelectionRange ?? value.targetRange }];
    }
    if (value.uri) {
      return [{ uri: value.uri, range: value.range }];
    }
    return [];
  });
}

function normalizeHoverContents(contents: any): string {
  if (!contents) return "";
  if (typeof contents === "string") return contents.trim();
  if (Array.isArray(contents)) {
    return contents.map((item) => normalizeHoverContents(item)).filter(Boolean).join("\n\n").trim();
  }
  if (typeof contents === "object") {
    if (typeof contents.value === "string") return contents.value.trim();
    if (typeof contents.language === "string" && typeof contents.value === "string") {
      return `${contents.language}\n${contents.value}`.trim();
    }
  }
  return String(contents).trim();
}

function actionableMissingServerMessage(command: string[]): string {
  return [
    `TypeScript language server is not available (${command.join(" ")}).`,
    "Install the local dependencies with `npm install`, then run `/reload`.",
    "AST-backed tools remain available for repo maps and structural search.",
  ].join(" ");
}

class TypeScriptLspClient {
  readonly workspaceRoot: string;
  readonly command: string[];
  child: ReturnType<typeof spawn> | undefined;
  connection: any;
  startPromise: Promise<void> | undefined;
  stderrLines: string[] = [];

  constructor(workspaceRoot: string, command: string[]) {
    this.workspaceRoot = workspaceRoot;
    this.command = command;
  }

  async start(): Promise<void> {
    if (this.connection) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.doStart().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const [binary, ...args] = this.command;
    if (!(await commandExists(binary, this.workspaceRoot))) {
      throw new TypeScriptLspUnavailableError(actionableMissingServerMessage(this.command));
    }

    const child = spawn(binary, args, {
      cwd: this.workspaceRoot,
      env: process.env,
      stdio: "pipe",
    });

    this.child = child;

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      const pieces = String(chunk).split(/\r?\n/).filter(Boolean);
      this.stderrLines.push(...pieces);
      this.stderrLines = this.stderrLines.slice(-20);
    });
    child.on("exit", () => {
      this.connection = undefined;
      this.child = undefined;
      workspaceClients.delete(this.workspaceRoot);
    });

    const spawnErrorPromise = new Promise<never>((_resolve, reject) => {
      child.once("error", (error) => reject(error));
    });

    const earlyExitPromise = new Promise<never>((_resolve, reject) => {
      child.once("exit", (code, signal) => {
        if (this.connection) return;
        reject(new Error(`TypeScript language server exited before initialization (code=${code ?? "null"}, signal=${signal ?? "null"}).`));
      });
    });

    const connection = createProtocolConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    this.connection = connection;
    connection.listen();

    const initializePromise = connection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: toUri(this.workspaceRoot),
      capabilities: {},
      clientInfo: {
        name: "pi-mobius-code-intel",
        version: "0.1.0",
      },
      workspaceFolders: [{ uri: toUri(this.workspaceRoot), name: basename(this.workspaceRoot) }],
      trace: "off",
    });

    try {
      await withTimeout(Promise.race([initializePromise, spawnErrorPromise, earlyExitPromise]), STARTUP_TIMEOUT_MS, actionableMissingServerMessage(this.command));
      connection.sendNotification(InitializedNotification.type, {});
    } catch (error) {
      await this.shutdown();
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT|not found/i.test(message)) {
        throw new TypeScriptLspUnavailableError(actionableMissingServerMessage(this.command));
      }
      if (this.stderrLines.length > 0) {
        throw new TypeScriptLspUnavailableError(`${actionableMissingServerMessage(this.command)} Latest server stderr: ${this.stderrLines.join(" | ")}`);
      }
      throw new TypeScriptLspUnavailableError(`${actionableMissingServerMessage(this.command)} ${message}`.trim());
    }
  }

  async ensureOpenDocument(filePath: string): Promise<void> {
    await this.start();
    const uri = toUri(filePath);
    const text = await readFile(filePath, "utf8");
    const currentVersion = documentVersions.get(uri);

    if (!currentVersion) {
      this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: {
          uri,
          languageId: languageIdForPath(filePath),
          version: 1,
          text,
        },
      });
      documentVersions.set(uri, 1);
      return;
    }

    const nextVersion = currentVersion + 1;
    this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text }],
    });
    documentVersions.set(uri, nextVersion);
  }

  async definition(filePath: string, line: number, column: number): Promise<any> {
    await this.ensureOpenDocument(filePath);
    return withTimeout(this.connection.sendRequest(DefinitionRequest.type, {
      textDocument: { uri: toUri(filePath) },
      position: toLspPosition(line, column),
    }), REQUEST_TIMEOUT_MS, "TypeScript definition lookup timed out.");
  }

  async references(filePath: string, line: number, column: number): Promise<any> {
    await this.ensureOpenDocument(filePath);
    return withTimeout(this.connection.sendRequest(ReferencesRequest.type, {
      textDocument: { uri: toUri(filePath) },
      position: toLspPosition(line, column),
      context: { includeDeclaration: true },
    }), REQUEST_TIMEOUT_MS, "TypeScript references lookup timed out.");
  }

  async hover(filePath: string, line: number, column: number): Promise<any> {
    await this.ensureOpenDocument(filePath);
    return withTimeout(this.connection.sendRequest(HoverRequest.type, {
      textDocument: { uri: toUri(filePath) },
      position: toLspPosition(line, column),
    }), REQUEST_TIMEOUT_MS, "TypeScript hover lookup timed out.");
  }

  async shutdown(): Promise<void> {
    try {
      this.connection?.dispose?.();
    } catch {
      // ignore shutdown errors
    }
    this.connection = undefined;

    if (!this.child) return;
    const child = this.child;
    this.child = undefined;

    child.removeAllListeners();
    try {
      child.kill();
    } catch {
      // ignore kill errors
    }
  }
}

async function getTypeScriptClient(cwd: string, filePath: string): Promise<TypeScriptLspClient> {
  const workspaceRoot = await findWorkspaceRoot(cwd, filePath);
  const existing = workspaceClients.get(workspaceRoot);
  if (existing) return existing;

  const command = await resolveTypeScriptServerCommand(cwd);
  const client = new TypeScriptLspClient(workspaceRoot, command);
  workspaceClients.set(workspaceRoot, client);
  return client;
}

export async function clearCodeIntelLspClients(): Promise<void> {
  for (const client of workspaceClients.values()) {
    await client.shutdown();
  }
  workspaceClients.clear();
  documentVersions.clear();
}

export async function lookupTypeScriptDefinition(params: PositionRequest): Promise<LspTextResult> {
  const absoluteFilePath = normalizeFilePath(params.cwd, params.filePath);
  ensureSupportedTypeScriptFile(absoluteFilePath);

  const client = await getTypeScriptClient(params.cwd, absoluteFilePath);
  const result = await client.definition(absoluteFilePath, params.line, params.column);
  const locations = normalizeLocations(result).slice(0, MAX_DEFINITION_RESULTS);

  const normalized: TypeScriptDefinitionLocation[] = [];
  for (const location of locations) {
    const path = fromUri(location.uri);
    const line = location.range?.start?.line + 1;
    const column = location.range?.start?.character + 1;
    normalized.push({
      path: path.startsWith(params.cwd) ? path.slice(params.cwd.length + 1) : path,
      line,
      column,
      snippet: await readSnippet(path, line, 2),
    });
  }

  const rawText = normalized.length === 0
    ? `No TypeScript definition found for ${params.filePath}:L${params.line}:${params.column}.`
    : [
        `TypeScript definition lookup for ${params.filePath}:L${params.line}:${params.column}`,
        `Found ${normalized.length} definition target(s).`,
        "",
        ...normalized.flatMap((location) => [
          `- ${location.path}:L${location.line}:${location.column}`,
          location.snippet ? location.snippet.split("\n").map((line) => `  ${line}`).join("\n") : "",
        ]),
      ].filter(Boolean).join("\n");

  const rendered = renderTruncatedText(rawText, MAX_DEFINITION_BYTES, CODE_INTEL_MAX_LINES, "Definition result");
  return {
    text: rendered.text,
    details: {
      filePath: params.filePath,
      line: params.line,
      column: params.column,
      locations: normalized,
    },
    truncation: rendered.truncation,
  };
}

export async function lookupTypeScriptReferences(params: PositionRequest): Promise<LspTextResult> {
  const absoluteFilePath = normalizeFilePath(params.cwd, params.filePath);
  ensureSupportedTypeScriptFile(absoluteFilePath);

  const client = await getTypeScriptClient(params.cwd, absoluteFilePath);
  const result = await client.references(absoluteFilePath, params.line, params.column);
  const locations = normalizeLocations(result).slice(0, MAX_REFERENCE_RESULTS);

  const normalized: TypeScriptReferenceLocation[] = [];
  for (const location of locations) {
    const path = fromUri(location.uri);
    const line = location.range?.start?.line + 1;
    const column = location.range?.start?.character + 1;
    normalized.push({
      path: path.startsWith(params.cwd) ? path.slice(params.cwd.length + 1) : path,
      line,
      column,
      snippet: await readSnippet(path, line, 1),
    });
  }

  const grouped = new Map<string, TypeScriptReferenceLocation[]>();
  for (const location of normalized) {
    const items = grouped.get(location.path) ?? [];
    items.push(location);
    grouped.set(location.path, items);
  }

  const body: string[] = [];
  for (const [path, items] of grouped.entries()) {
    body.push(path);
    for (const item of items) {
      body.push(`  - L${item.line}:${item.column} ${item.snippet}`.trimEnd());
    }
    body.push("");
  }

  const rawText = normalized.length === 0
    ? `No TypeScript references found for ${params.filePath}:L${params.line}:${params.column}.`
    : [
        `TypeScript references for ${params.filePath}:L${params.line}:${params.column}`,
        `Found ${normalized.length} reference(s) across ${grouped.size} file(s).`,
        "",
        body.join("\n").trim(),
      ].filter(Boolean).join("\n");

  const rendered = renderTruncatedText(rawText, MAX_REFERENCES_BYTES, CODE_INTEL_MAX_LINES, "References result");
  return {
    text: rendered.text,
    details: {
      filePath: params.filePath,
      line: params.line,
      column: params.column,
      references: normalized,
    },
    truncation: rendered.truncation,
  };
}

export async function lookupTypeScriptHover(params: PositionRequest): Promise<LspTextResult> {
  const absoluteFilePath = normalizeFilePath(params.cwd, params.filePath);
  ensureSupportedTypeScriptFile(absoluteFilePath);

  const client = await getTypeScriptClient(params.cwd, absoluteFilePath);
  const result = await client.hover(absoluteFilePath, params.line, params.column);
  const hoverText = normalizeHoverContents(result?.contents);

  const rawText = hoverText
    ? [
        `TypeScript hover for ${params.filePath}:L${params.line}:${params.column}`,
        "",
        hoverText,
      ].join("\n")
    : `No TypeScript hover info found for ${params.filePath}:L${params.line}:${params.column}.`;

  const rendered = renderTruncatedText(rawText, MAX_HOVER_BYTES, MAX_HOVER_LINES, "Hover result");
  return {
    text: rendered.text,
    details: {
      filePath: params.filePath,
      line: params.line,
      column: params.column,
      hover: hoverText,
    },
    truncation: rendered.truncation,
  };
}
