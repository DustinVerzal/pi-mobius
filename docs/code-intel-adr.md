# ADR: first shippable code-intelligence slice

- **Status:** Accepted
- **Date:** 2026-03-22
- **Depends on:** `docs/code-intel-research.md`

## Context

The research brief locked the evidence base for adding code intelligence to `pi-mobius` and concluded that the shortest path to user value is a **Pi-native `code-intel` extension** with **direct AST integration first**, then a **narrow direct LSP path** for one language. The brief also explicitly ruled **generic MCP support out of the MVP** because Pi’s shipped docs cover extensions, SDK lifecycle, package loading, tool overrides, and output truncation, but do **not** document a native MCP client/server surface.  
**Sources:** `docs/code-intel-research.md`, `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`, `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/packages.md`.

This repo also already prefers **repo-owned wrappers around external capabilities**. `extensions/subagents-bridge/index.ts` wraps an upstream subagent package, and `extensions/rtk-integration/index.ts` wraps Pi’s bash behavior. That makes a repo-owned `extensions/code-intel/` extension a better fit than importing a generic bridge as a top-level package.  
**Sources:** `extensions/subagents-bridge/index.ts`, `extensions/rtk-integration/index.ts`, `README.md`.

## Decision

We will ship a new repo-owned extension at:

- `extensions/code-intel/`

The MVP will use:

- **AST:** direct integration via `@ast-grep/napi`
- **LSP:** direct language-server process integration for **TypeScript / TSX / JavaScript** via `typescript-language-server --stdio`
- **MCP:** **not included** as a generic bridge in the MVP

## Exact MVP tool surface

The extension will expose exactly these tools in the first slice:

1. **`code_intel_repo_map`**  
   AST-backed, bounded repo/subtree symbol summary.
2. **`code_intel_ast_search`**  
   AST-backed structural or symbol search with concise match summaries.
3. **`code_intel_definition`**  
   LSP-backed definition lookup for TS/TSX/JS.
4. **`code_intel_references`**  
   LSP-backed references lookup for TS/TSX/JS.
5. **`code_intel_hover`**  
   LSP-backed compact hover / type / doc summary for TS/TSX/JS.

The MVP will **not** expose:

- raw AST dump tools
- raw JSON-RPC passthrough tools
- rename / workspace edit tools
- code actions
- diagnostics streaming as a generic protocol surface
- generic MCP bridge tools

## AST vs LSP vs MCP decisions

### AST decision

**Choose direct integration.**

Reasoning:

- `@ast-grep/napi` is the shortest Node-native path to structural search and symbol extraction in this repo.  
  **Sources:** `docs/code-intel-research.md`, `https://ast-grep.github.io/guide/api-usage/js-api.html`, `https://ast-grep.github.io/reference/api.html`.
- Aider’s repo-map evidence shows AST-derived summaries are useful specifically because they compress large repos into bounded symbol context.  
  **Sources:** `https://aider.chat/docs/repomap.html`, `https://aider.chat/2023/10/22/repomap.html`.
- An MCP wrapper around AST search would add another process and tool-hosting layer for a capability Pi can call directly from Node.  
  **Sources:** `https://raw.githubusercontent.com/ast-grep/ast-grep-mcp/main/README.md`, `docs/code-intel-research.md`.

**Decision:** AST is **direct**, not MCP-bridged.

### LSP decision

**Choose direct integration.**

Reasoning:

- Pi docs already support the primitives needed for a direct client path: extension tools, lifecycle hooks, process spawning, and package wiring.  
  **Sources:** `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`, `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/packages.md`.
- This repo is TypeScript-heavy, so TypeScript is the best first language to validate on real files.  
  **Sources:** `package.json`, `extensions/opencode-plan-mode/index.ts`, `extensions/prompt-master-injection/index.ts`, `extensions/rtk-integration/index.ts`, `extensions/subagents-bridge/index.ts`.
- `vscode-languageserver-protocol` is a clean protocol building block, but the product behavior should remain a Pi-native tool contract rather than an exposed bridge.  
  **Sources:** `/tmp/pi-github-repos/microsoft/vscode-languageserver-node@main/protocol/README.md`, `/tmp/pi-github-repos/microsoft/vscode-languageserver-node@main/protocol/package.json`.
- MCP LSP bridges (`cclsp`, `mcp-language-server`, `mcp-lsp-driver`) prove the pattern is viable, but they add config/trust/setup surface that the MVP does not need.  
  **Sources:** `https://raw.githubusercontent.com/ktnyt/cclsp/main/README.md`, `/tmp/pi-github-repos/isaacphi/mcp-language-server@main/README.md`, `https://raw.githubusercontent.com/OpticLM/mcp-lspdriver-ts/main/README.md`.

**Decision:** LSP is **direct**, not MCP-bridged.

### MCP decision

**Generic MCP support is deferred.**

Reasoning:

- Pi’s local docs do not document a native MCP client/server integration surface.  
  **Sources:** Pi docs corpus under `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs`; repo-local grep for `MCP` returned no matches on 2026-03-22.
- Codex’s MCP docs and approvals docs show that successful MCP support is tightly coupled with trust, approvals, sandboxing, and tool allow/deny policy. Pi does not ship an equivalent documented model in the evidence base reviewed for this ADR.  
  **Sources:** `https://developers.openai.com/codex/mcp`, `https://developers.openai.com/codex/agent-approvals-security`.
- OpenCode demonstrates that MCP can be useful, but it is a deliberate product feature with explicit MCP config and permissions, not a free side effect of having extension support.  
  **Sources:** `/tmp/pi-github-repos/opencode-ai/opencode/README.md`.

**Decision:** generic MCP support is **out for MVP**.

## First supported language

The first LSP-supported language is:

- **TypeScript / TSX / JavaScript**

Initial server command expectation:

- `typescript-language-server --stdio`

Why this language first:

- it matches this repo
- it is well-supported by the ecosystem
- it gives an immediate validation target on real package extensions in this repository  
  **Sources:** `docs/code-intel-research.md`, `https://opencode.ai/docs/tools/lsp`, `/tmp/pi-github-repos/isaacphi/mcp-language-server@main/README.md`, `https://raw.githubusercontent.com/ktnyt/cclsp/main/README.md`.

## Dependency shortlist

Runtime dependencies to add or rely on for the first slice:

- `@ast-grep/napi`
- `vscode-languageserver-protocol`

External executable expected for the first LSP slice:

- `typescript-language-server`

Notes:

- `vscode-languageserver-protocol` is treated as a protocol/types building block, not as a full Pi-native client by itself.  
  **Sources:** `/tmp/pi-github-repos/microsoft/vscode-languageserver-node@main/protocol/README.md`, `/tmp/pi-github-repos/microsoft/vscode-languageserver-node@main/protocol/package.json`.
- The missing server must not be auto-installed in MVP; we will fail with an actionable setup message instead.  
  **Sources:** `docs/code-intel-research.md`.

## Result shape and hard bounds

Pi’s extension docs explicitly require output truncation and warn against overwhelming model context. The new tools therefore must return **bounded, human-readable summaries**, not raw protocol or AST payloads.  
**Source:** `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`.

### `code_intel_repo_map`

Purpose: give the model a quick map of the current repo or a subtree.

Result contract:

- return at most **20 files**
- return at most **100 symbols** total
- format each item as: `kind name(signature?) - path`
- group by file
- skip obvious noise paths such as `node_modules`, `.git`, dist/build/output artifacts, and generated files where detectable
- cap total text at roughly **8KB**
- if truncated, say so explicitly and note what was omitted

### `code_intel_ast_search`

Purpose: structural or symbol-aware search that is more precise than grep.

Result contract:

- return at most **20 matches**
- each match includes `path:line`, node kind, and a **1-3 line snippet**
- cap total text at roughly **8KB**
- never emit raw tree dumps
- if nothing matches, say that plainly

### `code_intel_definition`

Purpose: jump to likely definitions for the symbol at a location.

Result contract:

- return at most **3 targets**
- each target includes `path:line[:column]`
- include a short enclosing signature or snippet
- cap total text at roughly **4KB**
- if multiple definitions exist, label them clearly
- never return raw `Location` / `LocationLink` JSON blobs

### `code_intel_references`

Purpose: show where a symbol is used.

Result contract:

- return at most **20 references**
- group by file
- include one short snippet per hit
- cap total text at roughly **8KB**
- summarize overflow counts when more matches exist
- never dump raw protocol arrays

### `code_intel_hover`

Purpose: compact semantic/type/doc summary.

Result contract:

- normalize markdown/text into a concise text block
- return at most **15 lines** or about **2KB**
- prefer signature + one or two short doc paragraphs
- omit protocol framing fields

### Global rendering rules

All tools must:

- prefer human-readable text over JSON
- mention truncation when caps are hit
- keep enough location detail for follow-up reads
- avoid repeating file content already included elsewhere in the same response

## Cache and process lifecycle rules

### AST cache

- keep an **in-memory, per-workspace** cache only
- cache symbol/index summaries, not full file bodies
- build lazily on first use
- invalidate entries by file `mtime` / size checks
- update per file when possible instead of rebuilding everything
- clear cache on `session_shutdown`
- do **not** introduce on-disk persistence in MVP

### LSP lifecycle

- create **one lazy-started TypeScript language-server process per workspace root**
- start it on the first LSP-backed tool call
- reuse it for `definition`, `references`, and `hover`
- if the process exits or becomes unhealthy, recreate it on the next request
- close the process on `session_shutdown`
- do not allow duplicate TS server instances for the same workspace root in one runtime

## Config location and shape

Use Pi’s normal settings locations:

- project-local: `.pi/settings.json`
- global: `~/.pi/agent/settings.json`

Recommended namespace:

- `codeIntel`

Initial config shape:

```json
{
  "codeIntel": {
    "enabled": true,
    "lsp": {
      "typescript": {
        "command": ["typescript-language-server", "--stdio"]
      }
    }
  }
}
```

Project settings should override global settings, consistent with Pi’s documented settings/package model.  
**Sources:** `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/packages.md`, `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`.

## Missing-server fallback behavior

If `typescript-language-server` is unavailable:

- LSP-backed tools must **not crash**
- they must return a **clear setup message** that includes:
  - the missing command
  - a short install hint
  - a note that AST tools remain available
- where reasonable, they may include AST-only fallback candidates instead of a hard empty result

Expected message shape:

> TypeScript language server is not available (`typescript-language-server --stdio`). Install it, then `/reload`. AST-backed tools remain available for repo maps and structural search.

## Consequences

### Positive

- ships a useful repo-navigation slice quickly
- keeps the first tool surface small and debuggable
- aligns with existing repo architecture
- avoids premature MCP platform work
- gives a clear path to later expansion

### Negative / trade-offs

- first LSP slice is language-limited
- environment setup for `typescript-language-server` remains external
- direct LSP integration still requires careful lifecycle handling
- generic MCP compatibility is deferred to a future milestone

## Follow-up work enabled by this ADR

1. Add `extensions/code-intel/` with the five MVP tools.
2. Wire approved dependencies in `package.json`.
3. Verify bounded AST summaries on this repo.
4. Verify `/reload` loads the extension without tool conflicts.
5. Prove one end-to-end TypeScript LSP flow or return the approved missing-server fallback.

## Verification targets inherited from this decision

This ADR is considered correctly implemented only if later steps demonstrate:

- `npm install` succeeds with the approved dependency changes
- `/reload` loads the new extension without duplicate registrations
- AST tools return bounded, human-readable summaries on this repo
- the first TypeScript LSP workflow works end-to-end or fails with the defined actionable setup message
- existing packaged features such as `/plan`, `/agents`, and `/rtk-status` continue to behave as before
