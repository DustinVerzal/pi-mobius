# Codemap gap analysis for `pi-mobius`

_Last updated: 2026-03-23_

## Executive answer

**What exists for Pi today?** Yes: this repo already ships a codemap-capable, Pi-native `extensions/code-intel/` extension. The shipped tool surface is:

- `code_intel_repo_map`
- `code_intel_ast_search`
- `code_intel_definition`
- `code_intel_references`
- `code_intel_hover`

That is the current, implemented answer to “codemap support for Pi” in `pi-mobius` today. It is an **on-demand, bounded code-intelligence layer** for repo orientation and semantic lookup, not a persisted repository-knowledge artifact.

**What is still missing?** `pi-mobius` does **not** currently write or maintain:

- a persisted codemap file on disk
- file/module ownership summaries maintained over time
- maintenance automation for a repository-knowledge artifact
- a Pi built-in codemap or native MCP codemap surface
- multi-language semantic LSP coverage beyond TypeScript/TSX/JS

**Decision:** adopt the existing `extensions/code-intel/` workflow as Pi’s codemap solution for the current use case, and **defer new build work** unless the requirement changes from “on-demand repo orientation” to “persisted, maintained repository knowledge.”

## Scope and historical note

Some repo documents predate the shipped implementation and should be read as historical context, not as the latest implementation truth.

| Source | Status today | How to use it |
|---|---|---|
| `docs/code-intel-research.md` | **Historical pre-implementation research brief** | Useful for rationale and upstream comparisons, but statements about the repo not yet shipping code-intel are no longer current. |
| `docs/code-intel-adr.md` | **Historical product decision record** | Still useful for intended MVP boundaries and result-shaping rules. |
| `README.md` | **Current user-facing truth** | Confirms the package ships code-intel today and tells users how to verify it. |
| `docs/code-intel-usage.md` | **Current operator workflow** | Describes how to use the shipped tools now. |
| `extensions/code-intel/` | **Current implementation truth** | Definitive source for tool registration, caching, limits, and fallback behavior. |
| `tests/code-intel-ast.test.mjs`, `tests/code-intel-lsp.test.mjs`, `docs/code-intel-smoke.md` | **Current validation evidence** | Best source for what has actually been exercised and proven. |

## 1) What `pi-mobius` already ships today

### Shipped codemap-capable surface

| Surface | Evidence | What it gives Pi today | Notable boundary |
|---|---|---|---|
| Repo-owned extension package | `README.md`, `package.json`, `extensions/code-intel/index.ts` | Codemap support lives in a repo-owned Pi extension/package, not a Pi built-in. | Users must install/load this package for the tools to exist. |
| `code_intel_repo_map` | `extensions/code-intel/index.ts`, `extensions/code-intel/ast.ts`, `tests/code-intel-ast.test.mjs` | Bounded AST-backed repo or subtree map for JS/TS files. | No persisted map file; output is generated on demand. |
| `code_intel_ast_search` | `extensions/code-intel/index.ts`, `extensions/code-intel/ast.ts`, `tests/code-intel-ast.test.mjs` | Symbol-aware or structural search across JS/TS files. | JS/TS-focused, not a general cross-language codemap search. |
| `code_intel_definition` | `extensions/code-intel/index.ts`, `extensions/code-intel/lsp.ts`, `tests/code-intel-lsp.test.mjs` | Semantic go-to-definition for TS/TSX/JS. | Depends on a TypeScript language server. |
| `code_intel_references` | `extensions/code-intel/index.ts`, `extensions/code-intel/lsp.ts`, `tests/code-intel-lsp.test.mjs` | Semantic usages grouped by file. | TS/TSX/JS only in the current MVP. |
| `code_intel_hover` | `extensions/code-intel/index.ts`, `extensions/code-intel/lsp.ts`, `tests/code-intel-lsp.test.mjs` | Compact type/doc/signature lookup at a location. | Not a full IDE/LSP surface. |

### Current implementation facts

#### AST path (`extensions/code-intel/ast.ts`)

Current facts established by the shipped code:

- Supported source files are currently JS/TS-family extensions (`.js`, `.cjs`, `.mjs`, `.jsx`, `.ts`, `.cts`, `.mts`, `.tsx`).
- The AST layer ignores common noise paths and generated artifacts such as `.git`, `node_modules`, `coverage`, `dist`, `build`, `.generated.*`, `.gen.*`, and `.d.ts`.
- `code_intel_repo_map` is bounded to **20 files** and **100 symbols** by default, with roughly an **8KB** output cap.
- `code_intel_ast_search` is bounded to **20 matches** by default, also with roughly an **8KB** output cap.
- The AST cache is **in-memory only** via `fileSymbolCache`, keyed by file `mtimeMs` and `size`.
- The AST cache is cleared on `session_shutdown` via `clearCodeIntelAstCache()`.
- There is **no on-disk codemap persistence** and no background maintenance job.

Why this matters: the shipped AST surface already behaves like a lightweight codemap for orientation, but only as an ephemeral, generated summary.

#### LSP path (`extensions/code-intel/lsp.ts`)

Current facts established by the shipped code:

- LSP support is currently scoped to **TypeScript / TSX / JavaScript** files.
- The extension keeps **one lazy TypeScript LSP client per workspace root** in `workspaceClients`.
- The TypeScript server command is resolved from project settings (`.pi/settings.json`), then global settings (`~/.pi/agent/settings.json`), then local `node_modules/.bin`, then `typescript-language-server --stdio`.
- The extension tracks open document versions in-memory via `documentVersions`.
- Definition, reference, and hover results are all **bounded and human-readable**, rather than raw LSP JSON dumps.
- The LSP client set is cleared on `session_shutdown` via `clearCodeIntelLspClients()`.
- If the language server is missing, the tool returns an **actionable setup message** instead of failing opaquely.

Why this matters: the shipped semantic layer already covers the most important “codemap follow-up” workflows for this TypeScript-heavy repo.

### Current validation evidence

| Evidence | What it proves |
|---|---|
| `tests/code-intel-ast.test.mjs` | Tool registration exists today; repo-map and AST-search results stay bounded and ignore noisy paths. |
| `tests/code-intel-lsp.test.mjs` | Definition/references/hover work against the shipped TypeScript implementation and missing-server fallback is actionable. |
| `docs/code-intel-smoke.md` | `npm install`, reload-equivalent loading, AST behavior, TypeScript LSP flow, and regression checks were all exercised against this repo. |
| `README.md` quick start | A new user can confirm code-intel support by asking Pi to use `code_intel_repo_map` on `extensions/code-intel`. |
| `docs/code-intel-usage.md` | The package already documents AST-first and LSP-follow-up workflows as the intended operator path. |

## 2) Comparator refresh: what other harnesses teach us

The goal here is not to copy other harnesses mechanically. It is to turn their codemap/code-intel practices into concrete requirements or anti-patterns for Pi and `extensions/code-intel/`.

| Comparator | Current upstream finding | Pi requirement to keep | Pi anti-pattern to avoid | Mapping to `extensions/code-intel/` |
|---|---|---|---|---|
| **Aider repo map** (`https://aider.chat/docs/repomap.html`) | Aider sends a concise repo map containing the most important files/symbols, optimized to fit a token budget and help the model choose which files to inspect next. | Keep codemap output **bounded, symbol-first, and navigation-oriented** rather than turning it into a full-file dump. | Do **not** treat “codemap” as “serialize the whole repo into context.” | Pi already follows this pattern with `code_intel_repo_map` caps (20 files, 100 symbols, ~8KB) and `code_intel_ast_search` follow-up search. |
| **OpenCode LSP** (`https://opencode.ai/docs/lsp/`) | OpenCode treats LSP as a curated product feature: lazy server startup, per-language config, bounded operations, and explicit enable/disable behavior. | Keep LSP support **curated, lazy, and configurable** instead of exposing raw protocol access. | Do **not** broaden Pi’s code-intel surface into a generic IDE proxy before there is product need. | Pi already has lazy per-workspace TypeScript clients, settings-based command overrides, and a narrow `definition` / `references` / `hover` surface. |
| **Codex MCP + approvals/security** (`https://developers.openai.com/codex/mcp`, `https://developers.openai.com/codex/agent-approvals-security`) | Codex’s MCP story works because it also ships trust boundaries: allow/deny tool lists, startup/tool timeouts, project trust, sandboxing, and approval policy. | If Pi ever adds MCP-backed codemap tooling, it must first define **tool policy, trust, timeouts, and failure modes**. | Do **not** bolt an MCP codemap bridge onto Pi and pretend transport alone solves product/security scope. | Current Pi docs show no native MCP surface. The present repo-owned, direct AST/LSP design is the safer and smaller fit. |
| **MCP bridge ecosystem** (`cclsp`, `mcp-language-server`, `mcp-lsp-driver`, `ast-grep-mcp`) | Bridges can expose AST/LSP capability, but usually add another server process, config surface, dependency chain, and trust model. | Prefer **direct library/process integration** when Pi already owns the runtime and only needs a small curated tool surface. | Do **not** add Python/uv or extra MCP-hosting layers for problems already solved by `@ast-grep/napi` and direct `typescript-language-server` spawning. | This validates the current `extensions/code-intel/` architecture rather than suggesting a rewrite around MCP. |

### Distilled Pi-relevant requirements

From the comparator set, the practical requirements for Pi are:

1. **Keep codemap output bounded and human-readable.**
   - Aider reinforces that a codemap is valuable because it reduces context load.
   - Pi should continue to prefer concise summaries over raw AST/LSP payloads.
2. **Keep the tool surface curated.**
   - OpenCode shows the value of exposing a small set of semantic operations rather than a generic protocol dump.
   - Pi should keep `repo_map`, `ast_search`, `definition`, `references`, and `hover` as the primary surface.
3. **Use lazy startup and workspace scoping.**
   - OpenCode’s model matches Pi’s current per-workspace lazy LSP design.
   - Future expansion should preserve that model.
4. **Treat MCP as a product/security decision, not an implementation shortcut.**
   - Codex demonstrates that MCP support needs timeouts, allow/deny controls, trust, and approval semantics.
   - Pi should not adopt MCP for codemap work until it has that surrounding control plane.
5. **Prefer direct integration over bridge-on-bridge architecture.**
   - The MCP bridge ecosystem is useful reference material, but mostly a poor default for Pi’s current needs.
   - `extensions/code-intel/` is already the right ownership boundary.

### Distilled Pi-relevant anti-patterns

- **Anti-pattern: equating “codemap” with a persisted artifact by default.**
  For Pi’s current workflow, the valuable behavior is often an on-demand bounded map, not a maintained file.
- **Anti-pattern: exposing raw protocol dumps as tools.**
  This increases context cost and makes follow-up reasoning worse.
- **Anti-pattern: solving AST/LSP needs with an MCP bridge first.**
  That adds configuration and trust complexity before the user gets more value.
- **Anti-pattern: making codemap a separate ownership system before proving the existing on-demand tools are insufficient.**
  That would add maintenance burden without clear evidence of need.

## 3) Gap analysis: where the shipped extension is enough, and where it is not

| Desired outcome | Current status | Evidence | Gap? | Interpretation |
|---|---|---|---|---|
| Fast repo/subtree orientation | **Covered now** | `code_intel_repo_map`, README examples, AST tests | Minor only | This is already the codemap-like entry point for Pi. |
| Structural/symbol-aware search | **Covered now** | `code_intel_ast_search`, AST tests | Minor only | Complements the repo map and reduces grep noise. |
| Semantic TypeScript navigation | **Covered now** | `definition`, `references`, `hover`, LSP tests, smoke note | Setup-dependent | Good enough for TS-heavy repos when the server is installed. |
| Actionable degraded path when LSP is unavailable | **Covered now** | `actionableMissingServerMessage`, LSP tests, usage doc | Small | Existing fallback is explicit and adequate. |
| Persisted codemap artifact on disk | **Missing** | No writer/persistence path in `extensions/code-intel/` | Yes | This is a different product slice than the one currently shipped. |
| Maintained ownership/responsibility summaries | **Missing** | No ownership model or maintenance workflow in docs/code | Yes | Not required for today’s on-demand code-intel flow. |
| Multi-language semantic navigation | **Missing** | Current LSP path is TS/TSX/JS-only | Yes | Worth revisiting only if product demand expands beyond this repo’s current needs. |
| Native Pi built-in codemap/MCP platform surface | **Missing by design** | Pi docs grep shows no native codemap/MCP docs | Yes | Any future deeper codemap work still belongs in a repo-owned extension/package. |

## Recommendation and explicit decision

### Decision

**Adopt the existing `extensions/code-intel/` workflow as the codemap solution for Pi today. Do not start a second implementation slice right now. Defer new build work unless and until the team explicitly asks for a persisted, maintained repository-knowledge artifact.**

### Why this is the right decision

1. **The core codemap use case is already implemented.**
   If “codemap” means “help the agent understand the repo and find the right files/symbols,” `pi-mobius` already ships that today.
2. **Comparator evidence supports the shipped shape.**
   Aider supports bounded repo maps, OpenCode supports curated semantic tools, and Codex shows that MCP requires more platform ownership than Pi currently documents.
3. **The missing pieces are a different product problem.**
   Persisted ownership summaries and maintenance automation are not just “slightly better repo_map”; they require artifact design, update policy, drift management, and extra operator workflow.
4. **Adoption has a better cost/value ratio than extension work right now.**
   The repo already has implementation, docs, tests, and smoke evidence for the current surface. The highest-value next move is to document and operationalize it clearly.

### Plain-language answer for the original question

- **Does something already exist for Pi?** Yes. `pi-mobius` already ships a repo-owned codemap-capable `code-intel` extension.
- **Is it a persisted codemap artifact?** No. It is an on-demand bounded repo/symbol summary plus TS semantic navigation.
- **Should we build more right now?** No for the current use case. Adopt the shipped extension, document it as Pi’s codemap answer, and only reopen build work if the requirement becomes “maintained repository knowledge on disk.”

## Follow-on artifact

Because the decision is adoption-only, the next artifact is:

- [`docs/codemap-adoption-guide.md`](./codemap-adoption-guide.md)

That guide gives a deterministic setup and verification flow for new users.

## Reopen criteria for future extension work

A new implementation/spec should only be opened if the team needs one or more of the following:

- a codemap file or database persisted on disk
- module/file ownership summaries maintained across edits
- automated refresh or CI validation of a repository-knowledge artifact
- multi-language semantic navigation beyond the current TypeScript-first slice
- a broader Pi-native MCP platform with explicit trust/approval controls
