# Code intelligence usage

`pi-mobius` now ships a repo-owned `code-intel` extension with two tool families:

- **AST-backed tools** for bounded repo maps and structural search
- **TypeScript LSP-backed tools** for definition, references, and hover on TS/TSX/JS files

For the MVP, **generic MCP bridging remains deferred**. Pi exposes these capabilities as Pi-native tools instead of routing through a generic MCP client/server layer.

## What codemap support means today

If you are asking whether Pi already has codemap support in this repo, the answer is **yes**.

What exists today:

- an on-demand bounded repo/subtree map via `code_intel_repo_map`
- structural and symbol-aware follow-up via `code_intel_ast_search`
- semantic TypeScript follow-up via `code_intel_definition`, `code_intel_references`, and `code_intel_hover`

What does **not** exist today:

- a persisted codemap artifact on disk
- maintained ownership summaries
- generic MCP-backed codemap tooling

For the evidence-backed current-state memo, see [`docs/codemap-gap-analysis.md`](./codemap-gap-analysis.md). For a deterministic setup and verification flow, see [`docs/codemap-adoption-guide.md`](./codemap-adoption-guide.md).

## Quick setup

### Local checkout / contributor flow

If you are loading this repo from a local checkout, install dependencies first:

```bash
cd /path/to/pi-mobius
npm install
pi install .
```

If Pi is already running in this repo, reload the package after changes:

```text
/reload
```

### Project-local Pi config example

This repo already includes a project-local `.pi/settings.json` pointing at the package root. For another project, a minimal local package setup looks like:

```json
{
  "packages": [
    "/absolute/path/to/pi-mobius"
  ]
}
```

Then start Pi in that project and run:

```text
/reload
```

## Fast verification

A new user can confirm the shipped codemap surface with this sequence:

```text
1. Use code_intel_repo_map on extensions/code-intel
2. Use code_intel_ast_search with the pattern pi.registerTool($$$ARGS) under extensions/
3. Use code_intel_definition for extensions/code-intel/lsp.ts at line 487, column 22
```

If those calls work, the current codemap workflow is available in Pi for this repo.

## Tool reference

### AST tools

#### `code_intel_repo_map`

Use when you need a **bounded overview** of a repo or subtree before opening many files.

What it returns:

- top files
- top symbols
- concise `kind signature @ line` summaries
- bounded output only

Good use cases:

- orienting on `extensions/` before editing
- finding likely ownership of a function or type
- narrowing a large change down to a few files

Example prompt:

```text
Use code_intel_repo_map on extensions/code-intel and summarize the most important files before we edit anything.
```

#### `code_intel_ast_search`

Use when you need **structural** or **symbol-aware** search on JS/TS code.

It supports two effective modes:

- **symbol mode** for simple identifiers like `buildRepoMap`
- **pattern mode** for structural patterns like `pi.registerTool($$$ARGS)`

Good use cases:

- find all tool registrations in an extension
- locate a top-level symbol quickly
- search for a recurring call shape without grep noise

Example prompts:

```text
Use code_intel_ast_search for buildRepoMap inside extensions/code-intel.
```

```text
Use code_intel_ast_search with the pattern pi.registerTool($$$ARGS) under extensions/.
```

### TypeScript LSP tools

These tools are currently scoped to **TypeScript / TSX / JavaScript** files.

#### `code_intel_definition`

Use when you know a file location and want semantic **go-to-definition**.

Example prompt:

```text
Use code_intel_definition for extensions/code-intel/lsp.ts at line 487, column 22.
```

#### `code_intel_references`

Use when you need semantic **references/usages** of a symbol, grouped by file.

Example prompt:

```text
Use code_intel_references for extensions/code-intel/lsp.ts at line 502, column 5.
```

#### `code_intel_hover`

Use when you need a compact **type/doc/signature** summary at a location.

Example prompt:

```text
Use code_intel_hover for extensions/code-intel/lsp.ts at line 347, column 117.
```

## When to use AST vs LSP vs grep/read

| Need | Prefer | Why |
|---|---|---|
| Quick repo/subtree orientation | `code_intel_repo_map` | Gives bounded symbol context without opening many files |
| Structural code pattern search | `code_intel_ast_search` | More precise than grep for JS/TS syntax |
| Semantic definition lookup | `code_intel_definition` | Uses the language server instead of text matching |
| Semantic usages/references | `code_intel_references` | Understands symbols, not just strings |
| Type/doc summary at a cursor position | `code_intel_hover` | Best for compact semantic insight |
| Raw text grep across any file type | built-in `grep` | Better for non-code or broad text search |
| Exact file contents | built-in `read` | Best when you already know the file to inspect |
| File discovery by glob/path | built-in `find` / `ls` | Better for filesystem exploration than code semantics |

### Practical rule of thumb

- Start with **AST** when you need orientation or a structural shortlist.
- Switch to **LSP** when you need semantic navigation on TS/TSX/JS.
- Fall back to **grep/read** when the target is non-code text, config text, or you already know the exact file.

## Example workflows

### Workflow 1: narrow a change before editing

```text
1. Use code_intel_repo_map on extensions/
2. Use code_intel_ast_search for pi.registerTool($$$ARGS)
3. Read the 1-2 files that look most relevant
4. Edit only after the shortlist is clear
```

### Workflow 2: inspect a semantic call path in TypeScript

```text
1. Use code_intel_definition at the call site
2. Use code_intel_hover on the target symbol
3. Use code_intel_references to see where else it is used
4. Read only the few files that the LSP results point to
```

### Workflow 3: degrade cleanly when LSP is unavailable

If the TypeScript language server is missing or cannot start, LSP tools return an actionable message instead of opaque protocol errors. In that case:

```text
1. Use code_intel_repo_map to find the relevant files
2. Use code_intel_ast_search on the target symbol or call shape
3. Use read/grep for exact follow-up inspection
```

## Output boundaries

The code-intel tools are intentionally bounded.

Current expectations:

- repo maps return only a capped set of files and symbols
- AST search returns only a capped set of matches with short previews
- definition returns only a small target set with short snippets
- references are capped and grouped by file
- hover is normalized to a short summary

If you need more detail, use the returned paths and positions with built-in `read`.

## Troubleshooting

### `/reload` reports an extension error

Run:

```text
/reload
```

Then inspect the most recent package or extension error in the transcript. Common local-checkout causes are missing dependencies because `npm install` was skipped.

### LSP tool says the TypeScript language server is unavailable

For a local checkout, install dependencies:

```bash
cd /path/to/pi-mobius
npm install
```

Then reload Pi:

```text
/reload
```

### AST tool returns no matches

Try one of these:

- narrow the path to the relevant subtree
- use a simple identifier instead of a full pattern
- simplify the structural pattern
- fall back to `grep` if the target is mostly text rather than syntax

## MVP boundary

This slice is intentionally small:

- **In:** AST repo maps, AST search, TypeScript definition/references/hover
- **Out:** generic MCP bridging, raw protocol passthrough, rename/code-action workflows, multi-language LSP expansion
