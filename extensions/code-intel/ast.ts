import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { truncateHead, type TruncationResult } from "@mariozechner/pi-coding-agent";

export const DEFAULT_REPO_MAP_MAX_FILES = 20;
export const DEFAULT_REPO_MAP_MAX_SYMBOLS = 100;
export const DEFAULT_AST_SEARCH_MAX_MATCHES = 20;
export const CODE_INTEL_MAX_BYTES = 8 * 1024;
export const CODE_INTEL_MAX_LINES = 240;

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".yarn",
  ".pnpm-store",
  "coverage",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
]);

const IGNORED_FILE_SUFFIXES = [
  ".min.js",
  ".min.css",
  ".map",
  ".generated.ts",
  ".generated.tsx",
  ".generated.js",
  ".generated.jsx",
  ".gen.ts",
  ".gen.tsx",
  ".gen.js",
  ".gen.jsx",
  ".d.ts",
];

const SUPPORTED_LANGUAGES: Record<string, Lang> = {
  ".js": Lang.JavaScript,
  ".cjs": Lang.JavaScript,
  ".mjs": Lang.JavaScript,
  ".jsx": Lang.Tsx,
  ".ts": Lang.TypeScript,
  ".cts": Lang.TypeScript,
  ".mts": Lang.TypeScript,
  ".tsx": Lang.Tsx,
};

const KIND_PRIORITIES: Record<string, number> = {
  function: 120,
  class: 115,
  interface: 110,
  type: 105,
  enum: 100,
  const: 85,
};

interface FileCacheEntry {
  mtimeMs: number;
  size: number;
  symbols: RepoSymbol[];
}

export interface RepoSymbol {
  kind: string;
  name: string;
  signature: string;
  line: number;
  column: number;
  path: string;
  absolutePath: string;
  exported: boolean;
  score: number;
}

export interface RepoFileSummary {
  path: string;
  symbolCount: number;
  symbols: RepoSymbol[];
  score: number;
}

export interface RepoMapResult {
  rootPath: string;
  scannedFiles: number;
  totalSymbols: number;
  fileSummaries: RepoFileSummary[];
  text: string;
  truncation: TruncationResult;
}

export interface AstSearchMatch {
  mode: "symbol" | "pattern";
  path: string;
  line: number;
  column: number;
  kind: string;
  preview: string;
  name?: string;
  signature?: string;
}

export interface AstSearchResult {
  rootPath: string;
  mode: "symbol" | "pattern";
  query: string;
  scannedFiles: number;
  matchCount: number;
  matches: AstSearchMatch[];
  text: string;
  truncation: TruncationResult;
}

const fileSymbolCache = new Map<string, FileCacheEntry>();

export function clearCodeIntelAstCache(): void {
  fileSymbolCache.clear();
}

export function normalizePathArgument(input: string | undefined): string | undefined {
  return input?.trim().replace(/^@/, "") || undefined;
}

export function resolveSearchRoot(cwd: string, input: string | undefined): string {
  return resolve(cwd, normalizePathArgument(input) ?? ".");
}

export function getSupportedLanguage(filePath: string): Lang | undefined {
  return SUPPORTED_LANGUAGES[extname(filePath).toLowerCase()];
}

export function isIgnoredDirectoryName(name: string): boolean {
  return IGNORED_DIRECTORY_NAMES.has(name);
}

export function isIgnoredFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => isIgnoredDirectoryName(segment))) return true;
  return IGNORED_FILE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export function inferSearchMode(query: string): "symbol" | "pattern" {
  return /^[A-Za-z_$][\w$]*$/.test(query.trim()) ? "symbol" : "pattern";
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value ?? fallback)));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectSupportedFiles(path: string): Promise<string[]> {
  if (!(await pathExists(path))) {
    throw new Error(`Path not found: ${path}`);
  }

  const metadata = await stat(path);
  if (metadata.isFile()) {
    if (isIgnoredFilePath(path) || !getSupportedLanguage(path)) return [];
    return [path];
  }

  if (!metadata.isDirectory()) return [];

  const results: string[] = [];
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = resolve(path, entry.name);
    if (entry.isDirectory()) {
      if (isIgnoredDirectoryName(entry.name)) continue;
      results.push(...await collectSupportedFiles(absolutePath));
      continue;
    }

    if (!entry.isFile()) continue;
    if (isIgnoredFilePath(absolutePath)) continue;
    if (!getSupportedLanguage(absolutePath)) continue;
    results.push(absolutePath);
  }

  results.sort();
  return results;
}

function shortenSignature(kind: string, name: string, nodeText: string): string {
  const compact = nodeText.replace(/\s+/g, " ").trim();

  if (kind === "function") {
    const match = compact.match(new RegExp(`${escapeRegExp(name)}\\s*\\(([^)]*)\\)`));
    return `${name}(${match?.[1]?.trim() ?? "..."})`;
  }

  if (kind === "class") return `class ${name}`;
  if (kind === "interface") return `interface ${name}`;
  if (kind === "type") return `type ${name}`;
  if (kind === "enum") return `enum ${name}`;
  if (kind === "const") return `const ${name}`;

  return compact.slice(0, 120);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snippetFromText(text: string, lineLimit = 3, lineWidth = 140): string {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .slice(0, lineLimit)
    .map((line) => line.length > lineWidth ? `${line.slice(0, lineWidth - 1)}…` : line);

  return lines.join("\n");
}

function scoreSymbol(symbol: RepoSymbol): number {
  return symbol.score + (symbol.exported ? 20 : 0) - Math.min(symbol.line, 200) / 50;
}

function scoreFile(file: RepoFileSummary): number {
  return file.symbols.reduce((sum, symbol) => sum + scoreSymbol(symbol), 0) + file.symbolCount;
}

function unwrapTopLevelDeclaration(node: any): { declaration: any; exported: boolean } {
  if (node.kind() !== "export_statement") {
    return { declaration: node, exported: false };
  }

  return {
    declaration: node.field("declaration") ?? node,
    exported: true,
  };
}

function normalizeDeclarationKind(kind: string): string | undefined {
  switch (kind) {
    case "function_declaration":
      return "function";
    case "class_declaration":
      return "class";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
      return "type";
    case "enum_declaration":
      return "enum";
    case "lexical_declaration":
      return "const";
    default:
      return undefined;
  }
}

function declarationName(node: any, fallback: string): string | undefined {
  const directName = node.field("name")?.text()?.trim();
  if (directName) return directName;

  if (node.kind() === "lexical_declaration") {
    const declarator = node.children().find((child: any) => child.kind() === "variable_declarator");
    const declaratorName = declarator?.field("name")?.text()?.trim();
    if (declaratorName) return declaratorName;
  }

  return fallback;
}

function declarationLine(node: any): { line: number; column: number } {
  const range = node.range();
  return {
    line: range.start.line + 1,
    column: range.start.column + 1,
  };
}

async function readSymbolsForFile(filePath: string, cwd: string): Promise<RepoSymbol[]> {
  const metadata = await stat(filePath);
  const cached = fileSymbolCache.get(filePath);
  if (cached && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) {
    return cached.symbols;
  }

  const language = getSupportedLanguage(filePath);
  if (!language) return [];

  const source = await readFile(filePath, "utf8");
  const root = parse(language, source).root();
  const seen = new Set<string>();
  const symbols: RepoSymbol[] = [];
  const relativePath = relative(cwd, filePath) || filePath;
  const fallbackName = relativePath.replace(/\.[^.]+$/, "").split(/[\\/]/).pop() || "default_export";

  for (const topLevelNode of root.children()) {
    const { declaration, exported } = unwrapTopLevelDeclaration(topLevelNode);
    const kind = normalizeDeclarationKind(declaration.kind());
    if (!kind) continue;

    if (kind === "const") {
      for (const declarator of declaration.children().filter((child: any) => child.kind() === "variable_declarator")) {
        const name = declarator.field("name")?.text()?.trim();
        if (!name) continue;
        const { line, column } = declarationLine(declarator);
        const dedupeKey = `${kind}:${name}:${line}:${column}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        symbols.push({
          kind,
          name,
          signature: shortenSignature(kind, name, declarator.text()),
          line,
          column,
          path: relativePath,
          absolutePath: filePath,
          exported,
          score: KIND_PRIORITIES[kind] ?? 50,
        });
      }
      continue;
    }

    const name = declarationName(declaration, fallbackName);
    if (!name) continue;
    const { line, column } = declarationLine(declaration);
    const dedupeKey = `${kind}:${name}:${line}:${column}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    symbols.push({
      kind,
      name,
      signature: shortenSignature(kind, name, declaration.text()),
      line,
      column,
      path: relativePath,
      absolutePath: filePath,
      exported,
      score: KIND_PRIORITIES[kind] ?? 50,
    });
  }

  symbols.sort((left, right) => {
    const scoreDelta = scoreSymbol(right) - scoreSymbol(left);
    if (scoreDelta !== 0) return scoreDelta;
    const lineDelta = left.line - right.line;
    if (lineDelta !== 0) return lineDelta;
    return left.name.localeCompare(right.name);
  });

  fileSymbolCache.set(filePath, {
    mtimeMs: metadata.mtimeMs,
    size: metadata.size,
    symbols,
  });

  return symbols;
}

function formatRepoMap(fileSummaries: RepoFileSummary[], scannedFiles: number, totalSymbols: number, rootPath: string): string {
  if (fileSummaries.length === 0) {
    return [
      `No supported JS/TS source files with extracted symbols were found under ${rootPath}.`,
      "Ignored noisy paths such as node_modules, .git, dist, build, coverage, and generated outputs.",
    ].join("\n");
  }

  const lines: string[] = [
    `Repo map for ${rootPath}`,
    `Scanned ${scannedFiles} supported files and extracted ${totalSymbols} symbols.`,
    "Ignored noisy paths such as node_modules, .git, dist, build, coverage, and generated outputs.",
    "",
  ];

  for (const file of fileSummaries) {
    lines.push(file.path);
    for (const symbol of file.symbols) {
      lines.push(`  - ${symbol.kind} ${symbol.signature} @ L${symbol.line}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function formatSymbolSearch(query: string, matches: AstSearchMatch[], scannedFiles: number, rootPath: string): string {
  if (matches.length === 0) {
    return [
      `No symbol matches found for \"${query}\" under ${rootPath}.`,
      `Scanned ${scannedFiles} supported files with the AST symbol index.`,
      "Ignored noisy paths such as node_modules, .git, dist, build, coverage, and generated outputs.",
    ].join("\n");
  }

  const lines = [
    `AST symbol search for \"${query}\" under ${rootPath}`,
    `Found ${matches.length} matches across ${scannedFiles} supported files.`,
    "",
  ];

  for (const match of matches) {
    lines.push(`- ${match.kind} ${match.signature ?? match.name ?? "(anonymous)"} — ${match.path}:L${match.line}`);
  }

  return lines.join("\n");
}

function formatPatternSearch(query: string, matches: AstSearchMatch[], scannedFiles: number, rootPath: string): string {
  if (matches.length === 0) {
    return [
      `No structural matches found for pattern \"${query}\" under ${rootPath}.`,
      `Scanned ${scannedFiles} supported files with AST pattern matching.`,
      "Ignored noisy paths such as node_modules, .git, dist, build, coverage, and generated outputs.",
    ].join("\n");
  }

  const lines = [
    `AST structural search for \"${query}\" under ${rootPath}`,
    `Found ${matches.length} matches across ${scannedFiles} supported files.`,
    "",
  ];

  for (const match of matches) {
    lines.push(`${match.path}:L${match.line}:${match.column} — ${match.kind}`);
    lines.push(match.preview.split("\n").map((line) => `  ${line}`).join("\n"));
    lines.push("");
  }

  return lines.join("\n").trim();
}

export async function buildRepoMap(options: {
  cwd: string;
  path?: string;
  maxFiles?: number;
  maxSymbols?: number;
}): Promise<RepoMapResult> {
  const rootPath = resolveSearchRoot(options.cwd, options.path);
  const files = await collectSupportedFiles(rootPath);
  const maxFiles = clamp(options.maxFiles, DEFAULT_REPO_MAP_MAX_FILES, 1, DEFAULT_REPO_MAP_MAX_FILES);
  const maxSymbols = clamp(options.maxSymbols, DEFAULT_REPO_MAP_MAX_SYMBOLS, 1, DEFAULT_REPO_MAP_MAX_SYMBOLS);

  const fileSummaries: RepoFileSummary[] = [];
  let totalSymbols = 0;

  for (const file of files) {
    let symbols: RepoSymbol[] = [];
    try {
      symbols = await readSymbolsForFile(file, options.cwd);
    } catch {
      continue;
    }
    if (symbols.length === 0) continue;
    totalSymbols += symbols.length;
    fileSummaries.push({
      path: relative(options.cwd, file) || file,
      symbolCount: symbols.length,
      symbols,
      score: 0,
    });
  }

  for (const file of fileSummaries) {
    file.score = scoreFile(file);
  }

  fileSummaries.sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) return scoreDelta;
    return left.path.localeCompare(right.path);
  });

  const selected: RepoFileSummary[] = [];
  let remainingSymbols = maxSymbols;
  for (const file of fileSummaries) {
    if (selected.length >= maxFiles || remainingSymbols <= 0) break;
    const symbols = file.symbols.slice(0, remainingSymbols);
    if (symbols.length === 0) continue;
    selected.push({
      ...file,
      symbols,
      symbolCount: symbols.length,
    });
    remainingSymbols -= symbols.length;
  }

  const rawText = formatRepoMap(selected, files.length, totalSymbols, rootPath);
  const truncation = truncateHead(rawText, {
    maxBytes: CODE_INTEL_MAX_BYTES,
    maxLines: CODE_INTEL_MAX_LINES,
  });

  const text = truncation.truncated
    ? `${truncation.content}\n\n[Repo map truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines.]`
    : truncation.content;

  return {
    rootPath,
    scannedFiles: files.length,
    totalSymbols,
    fileSummaries: selected,
    text,
    truncation,
  };
}

export async function runAstSearch(options: {
  cwd: string;
  query: string;
  path?: string;
  limit?: number;
  mode?: "symbol" | "pattern" | "auto";
}): Promise<AstSearchResult> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("AST search query cannot be empty.");
  }

  const rootPath = resolveSearchRoot(options.cwd, options.path);
  const files = await collectSupportedFiles(rootPath);
  const limit = clamp(options.limit, DEFAULT_AST_SEARCH_MAX_MATCHES, 1, DEFAULT_AST_SEARCH_MAX_MATCHES);
  const mode = options.mode === "symbol" || options.mode === "pattern"
    ? options.mode
    : inferSearchMode(query);

  const matches: AstSearchMatch[] = [];

  if (mode === "symbol") {
    for (const file of files) {
      let symbols: RepoSymbol[] = [];
      try {
        symbols = await readSymbolsForFile(file, options.cwd);
      } catch {
        continue;
      }

      for (const symbol of symbols) {
        const haystack = `${symbol.name} ${symbol.signature}`.toLowerCase();
        const needle = query.toLowerCase();
        if (!haystack.includes(needle)) continue;
        matches.push({
          mode,
          path: symbol.path,
          line: symbol.line,
          column: symbol.column,
          kind: symbol.kind,
          name: symbol.name,
          signature: symbol.signature,
          preview: `${symbol.kind} ${symbol.signature}`,
        });
      }
    }

    matches.sort((left, right) => {
      const leftExact = left.name?.toLowerCase() === query.toLowerCase() ? 1 : 0;
      const rightExact = right.name?.toLowerCase() === query.toLowerCase() ? 1 : 0;
      if (rightExact !== leftExact) return rightExact - leftExact;
      const leftStarts = left.name?.toLowerCase().startsWith(query.toLowerCase()) ? 1 : 0;
      const rightStarts = right.name?.toLowerCase().startsWith(query.toLowerCase()) ? 1 : 0;
      if (rightStarts !== leftStarts) return rightStarts - leftStarts;
      const pathDelta = left.path.localeCompare(right.path);
      if (pathDelta !== 0) return pathDelta;
      return left.line - right.line;
    });
  } else {
    for (const file of files) {
      const language = getSupportedLanguage(file);
      if (!language) continue;

      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch {
        continue;
      }

      let root;
      try {
        root = parse(language, source).root();
      } catch {
        continue;
      }

      let patternMatches: ReturnType<typeof root.findAll>;
      try {
        patternMatches = root.findAll(query);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`AST pattern parse failed for \"${query}\": ${message}`);
      }

      for (const match of patternMatches) {
        const range = match.range();
        matches.push({
          mode,
          path: relative(options.cwd, file) || file,
          line: range.start.line + 1,
          column: range.start.column + 1,
          kind: match.kind(),
          preview: snippetFromText(match.text()),
        });
      }
    }

    matches.sort((left, right) => {
      const pathDelta = left.path.localeCompare(right.path);
      if (pathDelta !== 0) return pathDelta;
      const lineDelta = left.line - right.line;
      if (lineDelta !== 0) return lineDelta;
      return left.column - right.column;
    });
  }

  const limitedMatches = matches.slice(0, limit);
  const rawText = mode === "symbol"
    ? formatSymbolSearch(query, limitedMatches, files.length, rootPath)
    : formatPatternSearch(query, limitedMatches, files.length, rootPath);

  const truncation = truncateHead(rawText, {
    maxBytes: CODE_INTEL_MAX_BYTES,
    maxLines: CODE_INTEL_MAX_LINES,
  });

  const text = truncation.truncated
    ? `${truncation.content}\n\n[AST search truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines.]`
    : truncation.content;

  return {
    rootPath,
    mode,
    query,
    scannedFiles: files.length,
    matchCount: matches.length,
    matches: limitedMatches,
    text,
    truncation,
  };
}
