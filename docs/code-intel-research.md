# Code intelligence research brief

_Last updated: 2026-03-22_

## Decision summary

**Recommendation:** ship a **Pi-native `code-intel` extension** in this repo, start with **direct AST integration** for bounded repo/symbol summaries, then add a **narrow direct LSP path for one language** (default: TypeScript/TSX/JS). **Generic MCP support is out of scope for the MVP.**

Why this is the current best fit:

1. **Pi already documents the extension and package primitives we need**: custom tools, commands, dynamic registration, package loading, built-in tool overrides, process spawning hooks, and explicit output truncation guidance. The shipped Pi docs do **not** document native MCP client/server support, so an MCP-first implementation would force us to invent a Pi integration layer before we deliver user-facing code-intel value.  
   **Sources:** `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`, `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/packages.md`.
2. **This repo already favors repo-owned wrappers around external capabilities** instead of exposing third-party integrations as first-class top-level packages. `extensions/subagents-bridge/index.ts` wraps `@tintinweb/pi-subagents`, and `extensions/rtk-integration/index.ts` wraps Pi's bash tool. That pattern maps cleanly to a repo-owned `extensions/code-intel/` package.  
   **Sources:** `extensions/subagents-bridge/index.ts`, `extensions/rtk-integration/index.ts`, `README.md`, `package.json`.
3. **AST-first gives the fastest context-efficiency win.** Aider's repo-map docs show that AST-derived symbol maps are useful precisely because they summarize large repositories without shipping whole files into model context.  
   **Sources:** `https://aider.chat/docs/repomap.html`, `https://aider.chat/2023/10/22/repomap.html`.
4. **MCP is valuable, but MCP-first is not the shortest path here.** OpenCode and Codex both support MCP, but they do so inside harnesses that already own MCP config, trust, approval, and tool-surface policy. Pi does not document such a layer today.  
   **Sources:** `/tmp/pi-github-repos/opencode-ai/opencode/README.md`, `https://opencode.ai/docs/tools/lsp`, `https://developers.openai.com/codex/mcp`, `https://developers.openai.com/codex/agent-approvals-security`.

## Evidence base locked for this repo

### 1) Pi can host code-intel tools without inventing a new platform layer

| Claim | Evidence | Why it matters |
|---|---|---|
| Pi extensions can register custom tools and commands | `docs/extensions.md` documents `pi.registerTool()` and `pi.registerCommand()` | A `code-intel` extension can expose AST and LSP tools directly. |
| Pi packages can ship extensions and runtime dependencies | `docs/packages.md`; local `package.json` already uses the `pi` manifest and `dependencies`/`bundledDependencies` | We can add a repo-owned extension and install supporting libraries with normal package wiring. |
| Pi supports process spawning / remote-style tool composition | `docs/extensions.md` (`pi.exec`, `createBashTool`, spawn hooks, tool overrides) | We can spawn an LSP server process or wrap an existing tool safely. |
| Pi explicitly requires bounded tool output | `docs/extensions.md` “Output Truncation” section | AST and LSP tools must return concise, human-readable summaries rather than raw protocol dumps. |
| Pi SDK/session model supports long-lived state and lifecycle hooks | `docs/sdk.md`, `docs/extensions.md` session and tool lifecycle sections | Useful for caching AST indexes and managing LSP client lifecycle. |
| Pi docs ship no documented MCP integration surface | Repo-local grep of `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/*.md` for `MCP` returned no matches on 2026-03-22 | A generic MCP bridge would be net-new platform work, not a straightforward extension feature. |

### 2) Current repo constraints

| Claim | Evidence | Why it matters |
|---|---|---|
| `pi-mobius` currently ships package-owned extensions, not a code-intel module | `README.md` “Package contents”; `extensions/` currently contains `opencode-plan-mode`, `prompt-master-injection`, `rtk-integration`, and `subagents-bridge` | There is no existing AST/LSP extension to extend in place. |
| This repo already wraps upstream packages behind local ownership | `extensions/subagents-bridge/index.ts` imports upstream `@tintinweb/pi-subagents`; `extensions/rtk-integration/index.ts` wraps Pi bash behavior | A local `code-intel` extension fits the repo’s existing architecture. |
| Duplicate registration is already a known operational risk | `README.md` “Troubleshooting duplicate subagent registrations”; `docs/packages.md` “Scope and Deduplication” | The MVP should avoid broad, auto-imported external tool surfaces that increase registration/conflict risk. |
| Package wiring is straightforward for new runtime deps | local `package.json` and `docs/packages.md` dependency guidance | AST/LSP dependencies can be added without changing the package model. |

### 3) Upstream comparators worth learning from

| Comparator | Evidence used | What it proves for us |
|---|---|---|
| OpenCode | `/tmp/pi-github-repos/opencode-ai/opencode/README.md`; `https://opencode.ai/docs/tools/lsp` | A coding harness can support both MCP config and curated LSP operations, but those are explicit product features, not freebies. |
| Aider | `https://aider.chat/docs/repomap.html`; `https://aider.chat/2023/10/22/repomap.html` | AST-derived repo maps are a proven way to improve large-repo navigation without sending full files. |
| Codex | `https://developers.openai.com/codex/mcp`; `https://developers.openai.com/codex/agent-approvals-security`; fetched `openai/codex` repo structure | MCP works well when the harness already owns approvals, trust, and sandbox policy. |
| MCP bridge ecosystem | `https://raw.githubusercontent.com/ktnyt/cclsp/main/README.md`; `/tmp/pi-github-repos/isaacphi/mcp-language-server@main/README.md`; `https://raw.githubusercontent.com/OpticLM/mcp-lspdriver-ts/main/README.md`; `https://raw.githubusercontent.com/ast-grep/ast-grep-mcp/main/README.md` | Useful comparison set, but all of them assume an MCP-hosting environment or introduce another abstraction layer. |

## What the upstream evidence says

### OpenCode: MCP and LSP are both viable, but they are product-level integrations

OpenCode’s local README documents both `mcpServers` and `lsp` configuration blocks, including stdio/SSE MCP servers and language-server commands. The same README says MCP tools become available to the assistant once configured, and that LSP currently provides diagnostics to the AI even though the underlying client supports more of the full protocol. The separate OpenCode LSP docs go further and list curated operations such as `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, and `workspaceSymbol`.  
**Sources:** `/tmp/pi-github-repos/opencode-ai/opencode/README.md`, `https://opencode.ai/docs/tools/lsp`.

**Takeaway for Pi:** OpenCode validates the product shape we want—curated code-intel tools rather than raw protocol access—but it does **not** remove the need to design a Pi-native tool contract.

### Aider: AST summaries are a practical, context-efficient foundation

Aider’s docs say it sends a concise repository map containing key symbols and signatures, and its tree-sitter article explains why: large repos do not fit into prompt context, so the tool sends only the most relevant symbol definitions and signatures. That is almost exactly the problem our AST-first slice should solve for Pi.  
**Sources:** `https://aider.chat/docs/repomap.html`, `https://aider.chat/2023/10/22/repomap.html`.

**Takeaway for Pi:** a bounded repo-map / symbol-summary tool is high-value even before live LSP workflows are ready.

### Codex: MCP support is strongest when paired with an explicit trust and approval model

Codex’s MCP docs show first-class support for stdio and HTTP MCP servers, shared CLI/IDE configuration, and allow/deny lists for enabled tools. Its approvals/security docs then show the complementary control plane: sandbox mode, approval policy, network controls, and explicit handling for destructive app/MCP tool calls.  
**Sources:** `https://developers.openai.com/codex/mcp`, `https://developers.openai.com/codex/agent-approvals-security`.

**Takeaway for Pi:** MCP is not just a transport detail. It comes with trust, permissions, and tool-surface policy. Pi does not document this today, so MCP-first would expand scope well beyond “add code intelligence.”

### MCP tooling ecosystem: useful references, wrong default for this MVP

- **`cclsp`** positions itself as an MCP server that adapts LSP for LLMs and specifically emphasizes fuzzy-to-exact symbol resolution for model-friendly inputs.  
  **Source:** `https://raw.githubusercontent.com/ktnyt/cclsp/main/README.md`.
- **`mcp-language-server`** exposes definition, references, diagnostics, hover, rename, and edit tools through an MCP server, but its setup requires both the MCP server binary and separately installed language servers.  
  **Source:** `/tmp/pi-github-repos/isaacphi/mcp-language-server@main/README.md`.
- **`mcp-lsp-driver`** is a TypeScript SDK for IDE plugin authors that bridges MCP and LSP, including a built-in LSP client, but its design center is “install MCP tools/resources on a server,” not “embed a minimal Pi extension.”  
  **Source:** `https://raw.githubusercontent.com/OpticLM/mcp-lspdriver-ts/main/README.md`.
- **`ast-grep-mcp`** proves structural AST search can be exposed through MCP, but it introduces Python/uv and an MCP server process for something we can call directly from Node in Pi.  
  **Source:** `https://raw.githubusercontent.com/ast-grep/ast-grep-mcp/main/README.md`.

**Takeaway for Pi:** these are useful references and fallback options, but all of them add an MCP abstraction layer that Pi does not yet natively own.

## Candidate shortlist

### Direct-library shortlist

| Candidate | Role | Evidence | Strengths | Risks / notes | Shortlist verdict |
|---|---|---|---|---|---|
| `@ast-grep/napi` | AST parsing + structural search + repo-map building | `https://ast-grep.github.io/guide/api-usage/js-api.html`, `https://ast-grep.github.io/reference/api.html`, `https://www.npmjs.com/package/@ast-grep/napi`, `npm view @ast-grep/napi` | Official Node binding, stable JS API, good fit for bounded symbol summaries and targeted structural search | Default built-in languages are JS ecosystem first; broader language support needs dynamic language packages | **Yes — preferred AST foundation** |
| `vscode-languageserver-protocol` | Typed LSP message shapes / protocol contracts | `/tmp/pi-github-repos/microsoft/vscode-languageserver-node@main/protocol/README.md`, `/tmp/pi-github-repos/microsoft/vscode-languageserver-node@main/protocol/package.json`, `npm view vscode-languageserver-protocol` | Official protocol package, widely used, matches a direct spawn-and-speak-LSP approach | It is a protocol implementation building block, not a finished “just works” Pi client by itself | **Yes — preferred protocol building block** |
| `typescript-language-server` (external server process) | First LSP runtime target for this repo | OpenCode LSP docs list TypeScript support; repo is TypeScript-heavy; `cclsp` and `mcp-language-server` both show standard `typescript-language-server --stdio` workflows | Predictable first language for this repo, easy to validate on real files | Environment-dependent install; MVP needs a clean missing-server fallback | **Yes — first language target** |

### MCP-bridge comparison shortlist

| Candidate | What it gives | Evidence | Why not the default MVP path |
|---|---|---|---|
| `cclsp` | MCP server for definition/references/rename/diagnostics with model-friendly symbol resolution | `https://raw.githubusercontent.com/ktnyt/cclsp/main/README.md` | Adds MCP-server lifecycle/config before Pi has native MCP ownership. |
| `mcp-language-server` | Multi-language MCP wrapper around LSP servers | `/tmp/pi-github-repos/isaacphi/mcp-language-server@main/README.md` | Good proof-of-concept, but doubles setup surface: MCP server **and** language server. |
| `mcp-lsp-driver` | TS SDK that can expose LSP as MCP tools/resources | `https://raw.githubusercontent.com/OpticLM/mcp-lspdriver-ts/main/README.md` | More attractive for IDE/MCP hosts than for a minimal Pi extension. |
| `ast-grep-mcp` | AST search through MCP | `https://raw.githubusercontent.com/ast-grep/ast-grep-mcp/main/README.md` | Adds Python/uv + MCP for a capability Node can consume directly via `@ast-grep/napi`. |

## Recommended MVP direction

### Architecture call for Step 2

**For the MVP, generic MCP support is OUT.**

Recommended shape:

1. **Create `extensions/code-intel/` as a repo-owned Pi extension.**  
   **Why:** matches the existing wrapper pattern in `subagents-bridge` and `rtk-integration`.  
   **Sources:** `extensions/subagents-bridge/index.ts`, `extensions/rtk-integration/index.ts`, `README.md`.
2. **AST first:** expose a bounded repo-map/symbol-summary tool and a targeted AST search tool backed by `@ast-grep/napi`.  
   **Why:** Aider-style context reduction is the quickest win, and Pi explicitly requires bounded tool output.  
   **Sources:** `https://aider.chat/docs/repomap.html`, `https://aider.chat/2023/10/22/repomap.html`, `docs/extensions.md` output truncation guidance, `https://ast-grep.github.io/guide/api-usage/js-api.html`.
3. **Direct LSP second:** choose one language for the first shippable workflow, most likely TypeScript/TSX/JS, and talk to its language server directly from the extension.  
   **Why:** this repo is TypeScript-based, and a narrow direct path avoids depending on a generic MCP bridge before Pi has an MCP contract.  
   **Sources:** local repo `extensions/**/*.ts`, `package.json`, `https://opencode.ai/docs/tools/lsp`, `/tmp/pi-github-repos/microsoft/vscode-languageserver-node@main/protocol/README.md`.
4. **Keep outputs curated and bounded.**  
   - Repo maps should return top symbols/files, not full AST dumps.  
   - AST search should cap matches and summarize path/line/snippet.  
   - LSP should expose a small operation set (definition, references, hover or symbols) and shape results for humans, not JSON-RPC transcripts.  
   **Sources:** `docs/extensions.md` truncation guidance; OpenCode LSP operation list in `https://opencode.ai/docs/tools/lsp`.

## Explicit non-goals for the MVP

- **No generic MCP client/server support in Pi for this first slice.** The evidence base does not show a documented Pi-native MCP surface today.  
  **Sources:** Pi docs corpus under `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs`; grep for `MCP` returned no matches on 2026-03-22.
- **No raw protocol dump tools.** Pi’s extension docs explicitly warn about tool output size and context overflow.  
  **Source:** `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`.
- **No multi-language LSP ambition in the first implementation.** The first slice should prove one language and a small operation set before broadening support.  
  **Sources:** OpenCode LSP docs; `mcp-language-server` README setup burden; local repo is primarily TypeScript.

## Decision table

| Decision | Status | Justification |
|---|---|---|
| Ship a repo-owned `code-intel` extension | **In** | Matches repo architecture and Pi packaging model. |
| Use `@ast-grep/napi` for AST-backed repo intelligence | **In** | Best direct fit for bounded symbol summaries and structural search. |
| Add a narrow direct LSP path for one language | **In** | Delivers real navigation value without waiting for generic MCP support. |
| Start with TypeScript/TSX/JS as the first LSP target | **In** | Best fit for this repository and common language-server availability. |
| Generic MCP bridge for AST/LSP | **Out for MVP** | Pi docs do not document native MCP support; MCP adds trust/policy/setup scope that is not required to ship the first user-visible win. |

## Source index

### Local repo evidence

- `package.json`
- `README.md`
- `extensions/subagents-bridge/index.ts`
- `extensions/rtk-integration/index.ts`

### Local Pi docs evidence

- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/packages.md`

### Fetched / cloned upstream evidence

- `https://opencode.ai/docs/tools/lsp`
- `/tmp/pi-github-repos/opencode-ai/opencode/README.md`
- `https://aider.chat/docs/repomap.html`
- `https://aider.chat/2023/10/22/repomap.html`
- `https://developers.openai.com/codex/mcp`
- `https://developers.openai.com/codex/agent-approvals-security`
- `https://raw.githubusercontent.com/ktnyt/cclsp/main/README.md`
- `/tmp/pi-github-repos/isaacphi/mcp-language-server@main/README.md`
- `https://raw.githubusercontent.com/OpticLM/mcp-lspdriver-ts/main/README.md`
- `https://raw.githubusercontent.com/ast-grep/ast-grep-mcp/main/README.md`
- `https://ast-grep.github.io/guide/api-usage/js-api.html`
- `https://ast-grep.github.io/reference/api.html`
- `https://www.npmjs.com/package/@ast-grep/napi`
- `/tmp/pi-github-repos/microsoft/vscode-languageserver-node@main/protocol/README.md`
- `/tmp/pi-github-repos/microsoft/vscode-languageserver-node@main/protocol/package.json`
