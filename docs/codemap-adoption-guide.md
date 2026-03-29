# Codemap adoption guide for `pi-mobius`

_Last updated: 2026-03-23_

## Purpose

Use this guide if you want a deterministic answer to:

- **Does Pi already have codemap support in this repo?**
- **How do I confirm it is loaded and working?**
- **What exactly is supported today, and what is not?**

Short answer:

- **Yes:** `pi-mobius` already ships codemap-capable support through `extensions/code-intel/`.
- **Today’s codemap meaning:** on-demand bounded repo maps, AST search, and TypeScript semantic navigation.
- **Not shipped today:** a persisted codemap file, ownership-maintenance automation, or generic MCP-backed codemap tooling.

For the evidence-backed decision memo, see [`docs/codemap-gap-analysis.md`](./codemap-gap-analysis.md).

## What codemap support means in this repo today

The shipped tools are:

- `code_intel_repo_map` — bounded AST-backed repo/subtree summary
- `code_intel_ast_search` — bounded AST-backed symbol or structural search
- `code_intel_definition` — TypeScript/TSX/JS definition lookup
- `code_intel_references` — TypeScript/TSX/JS references lookup
- `code_intel_hover` — TypeScript/TSX/JS hover/type/doc summary

This is enough for the normal Pi codemap workflow:

1. get a bounded map of the relevant subtree
2. search for symbols or patterns structurally
3. use semantic TypeScript follow-up when exact locations matter
4. read only the few files that the tool results point to

## What is not included today

Do **not** expect these capabilities from the current implementation:

- a `codemap.json`, `codemap.md`, or other maintained codemap file on disk
- automatic ownership or responsibility summaries for every module
- a background updater that keeps repository knowledge synchronized
- multi-language LSP beyond the current TypeScript-first slice
- a native Pi built-in codemap or MCP control plane

If you need those, that is future extension work, not the current shipped surface.

## Deterministic setup

### Preferred install path

Install from git/URL when possible:

```bash
pi install <git-or-https-source>
```

For a local checkout:

```bash
git clone <repo-url> pi-mobius
cd pi-mobius
npm install
pi install .
```

If Pi is already open in the target repo, run:

```text
/reload
```

## Deterministic confirmation flow

Follow this exact sequence.

### 1) Confirm the package is loaded

In Pi, run or check:

- `/subagents-info`
- `/plan status`
- `/rtk-status`

Those confirm the package is loaded broadly.

### 2) Confirm codemap entry-point availability

Ask Pi:

```text
Use code_intel_repo_map on extensions/code-intel.
```

**Expected result:** Pi calls `code_intel_repo_map` successfully and returns a bounded repo summary mentioning files like:

- `extensions/code-intel/ast.ts`
- `extensions/code-intel/lsp.ts`
- `extensions/code-intel/index.ts`

If Pi cannot call the tool at all, the package/extension is not loaded in the current scope.

### 3) Confirm structural codemap follow-up

Ask Pi:

```text
Use code_intel_ast_search with the pattern pi.registerTool($$$ARGS) under extensions/.
```

**Expected result:** Pi returns bounded structural matches rather than raw grep noise.

### 4) Confirm semantic TypeScript follow-up

Ask Pi:

```text
Use code_intel_definition for extensions/code-intel/lsp.ts at line 487, column 22.
```

**Expected result:** Pi returns a compact definition target, not raw LSP JSON.

Optional follow-ups:

```text
Use code_intel_references for extensions/code-intel/lsp.ts at line 502, column 5.
```

```text
Use code_intel_hover for extensions/code-intel/lsp.ts at line 347, column 117.
```

### 5) Interpret the result correctly

If steps 2-4 work, then **codemap support is already available in Pi for this repo today**.

That means:

- repo orientation works
- structural search works
- semantic TS navigation works

It does **not** mean:

- a persistent codemap artifact exists
- ownership summaries are maintained automatically
- Pi has a built-in codemap/MCP platform feature

## CLI/test verification for maintainers

If you want proof outside the Pi chat flow, use the existing tests.

### Run the code-intel test suite

```bash
node --test tests/code-intel-ast.test.mjs tests/code-intel-lsp.test.mjs
```

What this proves:

- the five tool names are registered
- AST repo maps are bounded and ignore noisy paths
- AST structural/symbol search works
- TypeScript definition/references/hover work when the language server is available
- missing-server fallback stays actionable

### Optional reload-equivalent extension check

```bash
node - <<'NODE'
import { DefaultResourceLoader } from '@mariozechner/pi-coding-agent';
const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: './.pi-test-agent' });
await loader.reload();
const result = loader.getExtensions();
console.log(JSON.stringify({ extensionCount: result.extensions.length, errors: result.errors }, null, 2));
process.exit(result.errors.length === 0 ? 0 : 1);
NODE
```

**Expected result:** no extension load errors.

## Recommended operator workflow

Use the tools in this order.

### Workflow A: orient before editing

```text
1. Use code_intel_repo_map on the relevant subtree.
2. Use code_intel_ast_search on the likely symbol or call shape.
3. Read only the files that appear important.
4. Edit after the shortlist is clear.
```

### Workflow B: follow a semantic TypeScript path

```text
1. Use code_intel_definition at the call site.
2. Use code_intel_hover on the resolved symbol.
3. Use code_intel_references to see impact.
4. Read just the files the LSP results point to.
```

### Workflow C: degrade cleanly when LSP is unavailable

```text
1. Use code_intel_repo_map for orientation.
2. Use code_intel_ast_search for structural narrowing.
3. Use read/grep for exact follow-up inspection.
4. Restore LSP support later by fixing the TypeScript language server setup.
```

## Settings surface today

The current TypeScript LSP command can be overridden in:

- project settings: `.pi/settings.json`
- global settings: `~/.pi/agent/settings.json`

Shape:

```json
{
  "codeIntel": {
    "lsp": {
      "typescript": {
        "command": ["typescript-language-server", "--stdio"]
      }
    }
  }
}
```

Resolution order in the current implementation is:

1. project-local Pi settings
2. global Pi settings
3. local `node_modules/.bin/typescript-language-server`
4. `typescript-language-server --stdio`

## Troubleshooting

### Pi says the code-intel tool does not exist

Likely causes:

- the package is not installed in the current scope
- Pi needs `/reload`
- you are in a repo/session where `pi-mobius` is not active

### LSP tools say the TypeScript language server is unavailable

For a local checkout:

```bash
cd /path/to/pi-mobius
npm install
```

Then in Pi:

```text
/reload
```

The current implementation intentionally returns an actionable message and keeps AST tools available.

### Repo map or AST search returns nothing useful

Try:

- narrowing the path to a smaller subtree
- searching for a simple identifier first
- simplifying the structural pattern
- falling back to `grep` for non-code or text-heavy targets

## Bottom line

If a new user follows the confirmation flow in this document and sees `code_intel_repo_map` plus at least one of the follow-up tools working, then they can conclude:

- **Pi already has codemap support in this repo today**
- that support lives in `extensions/code-intel/`
- it is **adoption-ready now** for on-demand repo orientation
- any request for a persisted codemap artifact is **future work**, not a missing step in the current adoption flow
