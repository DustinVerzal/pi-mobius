import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  buildRepoMap,
  clearCodeIntelAstCache,
  CODE_INTEL_MAX_BYTES,
  DEFAULT_AST_SEARCH_MAX_MATCHES,
  DEFAULT_REPO_MAP_MAX_FILES,
  DEFAULT_REPO_MAP_MAX_SYMBOLS,
  runAstSearch,
} from "./ast.js";
import {
  clearCodeIntelLspClients,
  lookupTypeScriptDefinition,
  lookupTypeScriptHover,
  lookupTypeScriptReferences,
} from "./lsp.js";

const repoMapParams = Type.Object({
  path: Type.Optional(Type.String({ description: "File or directory to summarize (default: current working directory)." })),
  maxFiles: Type.Optional(Type.Number({ description: `Maximum files to include (default ${DEFAULT_REPO_MAP_MAX_FILES}, max ${DEFAULT_REPO_MAP_MAX_FILES}).` })),
  maxSymbols: Type.Optional(Type.Number({ description: `Maximum symbols to include (default ${DEFAULT_REPO_MAP_MAX_SYMBOLS}, max ${DEFAULT_REPO_MAP_MAX_SYMBOLS}).` })),
});

const astSearchParams = Type.Object({
  query: Type.String({ description: "Identifier name or AST pattern to search for. Simple identifiers use symbol mode; everything else uses structural pattern mode." }),
  path: Type.Optional(Type.String({ description: "File or directory to search (default: current working directory)." })),
  limit: Type.Optional(Type.Number({ description: `Maximum matches to include (default ${DEFAULT_AST_SEARCH_MAX_MATCHES}, max ${DEFAULT_AST_SEARCH_MAX_MATCHES}).` })),
  mode: Type.Optional(Type.String({ description: "Optional mode override: symbol, pattern, or auto." })),
});

const lspPositionParams = Type.Object({
  filePath: Type.String({ description: "Path to the TS/TSX/JS file to query." }),
  line: Type.Number({ description: "1-based line number." }),
  column: Type.Number({ description: "1-based column number." }),
});

export default function codeIntel(pi: ExtensionAPI): void {
  pi.on("session_shutdown", async () => {
    clearCodeIntelAstCache();
    await clearCodeIntelLspClients();
  });

  pi.registerTool({
    name: "code_intel_repo_map",
    label: "Code Intel Repo Map",
    description: `Build a bounded AST-backed map of a JS/TS repo or subtree. Returns concise file/symbol summaries only, capped at roughly ${Math.round(CODE_INTEL_MAX_BYTES / 1024)}KB. Ignores noisy paths such as node_modules, .git, dist, build, coverage, and generated artifacts.`,
    promptSnippet: "Summarize the repository or a subtree into a bounded AST-backed file and symbol map.",
    promptGuidelines: [
      "Use code_intel_repo_map when you need a high-level JS/TS symbol map before reading many files.",
      "For JS/TS exploration, prefer this tool over grep when the goal is repo orientation, likely ownership, or file shortlisting.",
      "Do not start JS/TS subtree understanding with grep unless you need exact text matching rather than code structure.",
    ],
    parameters: repoMapParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await buildRepoMap({
        cwd: ctx.cwd,
        path: params.path,
        maxFiles: params.maxFiles,
        maxSymbols: params.maxSymbols,
      });

      return {
        content: [{ type: "text", text: result.text }],
        details: {
          rootPath: result.rootPath,
          scannedFiles: result.scannedFiles,
          totalSymbols: result.totalSymbols,
          fileCount: result.fileSummaries.length,
          truncation: result.truncation,
        },
      };
    },
  });

  pi.registerTool({
    name: "code_intel_ast_search",
    label: "Code Intel AST Search",
    description: `Run a bounded AST-backed symbol or structural search over JS/TS files. Returns concise, human-readable matches only, capped at roughly ${Math.round(CODE_INTEL_MAX_BYTES / 1024)}KB. Ignores noisy paths such as node_modules, .git, dist, build, coverage, and generated artifacts.`,
    promptSnippet: "Find JS/TS symbols or structural patterns with AST-backed matching and concise results.",
    promptGuidelines: [
      "Use code_intel_ast_search when grep is too text-based and you need structural or symbol-aware matching.",
      "For JS/TS symbol or call-shape search, prefer this tool over grep unless you need an exact raw text match.",
      "Pass a simple identifier to search by symbol name, or a JS/TS pattern like pi.registerTool($$$ARGS) for structural search.",
    ],
    parameters: astSearchParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const mode = params.mode === "symbol" || params.mode === "pattern" || params.mode === "auto"
        ? params.mode
        : undefined;

      const result = await runAstSearch({
        cwd: ctx.cwd,
        query: params.query,
        path: params.path,
        limit: params.limit,
        mode,
      });

      return {
        content: [{ type: "text", text: result.text }],
        details: {
          rootPath: result.rootPath,
          query: result.query,
          mode: result.mode,
          scannedFiles: result.scannedFiles,
          matchCount: result.matchCount,
          truncation: result.truncation,
        },
      };
    },
  });

  pi.registerTool({
    name: "code_intel_definition",
    label: "Code Intel Definition",
    description: "Look up a TypeScript/TSX/JS definition through the TypeScript language server. Returns a compact human-readable summary instead of raw LSP JSON.",
    promptSnippet: "Find the definition of a TS/TSX/JS symbol at a specific file position.",
    promptGuidelines: [
      "Use code_intel_definition for semantic go-to-definition on TS/TSX/JS files when a specific location is known.",
      "Prefer this over grep when following a TypeScript symbol from a known call site or identifier location.",
    ],
    parameters: lspPositionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await lookupTypeScriptDefinition({
        cwd: ctx.cwd,
        filePath: params.filePath,
        line: params.line,
        column: params.column,
      });

      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  });

  pi.registerTool({
    name: "code_intel_references",
    label: "Code Intel References",
    description: "Find TypeScript/TSX/JS references through the TypeScript language server. Returns grouped, bounded references instead of raw protocol arrays.",
    promptSnippet: "Find semantic references for a TS/TSX/JS symbol at a specific file position.",
    promptGuidelines: [
      "Use code_intel_references when you need semantic usages of a TS/TSX/JS symbol instead of text matches.",
      "Prefer this over grep when impact analysis depends on symbol identity rather than string matching.",
    ],
    parameters: lspPositionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await lookupTypeScriptReferences({
        cwd: ctx.cwd,
        filePath: params.filePath,
        line: params.line,
        column: params.column,
      });

      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  });

  pi.registerTool({
    name: "code_intel_hover",
    label: "Code Intel Hover",
    description: "Get a compact TypeScript/TSX/JS hover summary through the TypeScript language server. Returns short signature/doc text instead of raw protocol output.",
    promptSnippet: "Get a compact semantic hover summary for a TS/TSX/JS symbol at a specific file position.",
    promptGuidelines: [
      "Use code_intel_hover for type/doc insight at a known TS/TSX/JS cursor position.",
      "Prefer this over reading surrounding files when you only need a compact semantic summary.",
    ],
    parameters: lspPositionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await lookupTypeScriptHover({
        cwd: ctx.cwd,
        filePath: params.filePath,
        line: params.line,
        column: params.column,
      });

      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  });
}
