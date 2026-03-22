# Code-intel smoke validation

_Last updated: 2026-03-22_

## Scope

This smoke pass validates the first shipped `code-intel` slice alongside the existing packaged features in `pi-mobius`.

## Commands and checks run

### 1) Dependency install

Command:

```bash
npm install
```

Observed result:

- install completed successfully after adding `@ast-grep/napi`, `vscode-languageserver-protocol`, `typescript`, and `typescript-language-server`
- npm reported `found 0 vulnerabilities`

## 2) `/reload`-equivalent extension loading check

Command:

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

Observed result:

```json
{
  "extensionCount": 5,
  "errors": []
}
```

Interpretation:

- the package reload path loaded all five local extensions
- no duplicate tool or command registration errors were reported during extension discovery / reload

## 3) AST tool validation on this repo

Command:

```bash
node - <<'NODE'
import jitiFactory from '@mariozechner/jiti';
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const ast = await jiti.import('./extensions/code-intel/ast.ts');
const repoMap = await ast.buildRepoMap({ cwd: process.cwd(), path: 'extensions', maxFiles: 5, maxSymbols: 20 });
const patternSearch = await ast.runAstSearch({ cwd: process.cwd(), path: 'extensions', query: 'pi.registerTool($$$ARGS)', mode: 'pattern', limit: 5 });
console.log('--- repo map preview ---');
console.log(repoMap.text);
console.log('\n--- ast search preview ---');
console.log(patternSearch.text);
NODE
```

Observed highlights:

- repo map scanned `11` supported files and extracted `240` symbols under `extensions/`
- output was bounded and human-readable
- ignored-path note was present (`node_modules`, `.git`, `dist`, `build`, `coverage`, generated outputs)
- structural search found bounded tool-registration matches across the repo

Sample output excerpt:

```text
Repo map for /Users/dustinverzal/repos/pi-mobius/extensions
Scanned 11 supported files and extracted 240 symbols.
Ignored noisy paths such as node_modules, .git, dist, build, coverage, and generated outputs.
...
AST structural search for "pi.registerTool($$$ARGS)" under /Users/dustinverzal/repos/pi-mobius/extensions
Found 5 matches across 11 supported files.
```

Interpretation:

- AST tools return bounded summaries instead of raw AST dumps
- obvious noise paths are excluded
- the tool outputs are useful on this repo without needing full-file reads first

## 4) TypeScript LSP workflow validation

Command:

```bash
node - <<'NODE'
import jitiFactory from '@mariozechner/jiti';
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const lsp = await jiti.import('./extensions/code-intel/lsp.ts');
try {
  const definition = await lsp.lookupTypeScriptDefinition({ cwd: process.cwd(), filePath: 'extensions/code-intel/lsp.ts', line: 487, column: 22 });
  const references = await lsp.lookupTypeScriptReferences({ cwd: process.cwd(), filePath: 'extensions/code-intel/lsp.ts', line: 502, column: 5 });
  const hover = await lsp.lookupTypeScriptHover({ cwd: process.cwd(), filePath: 'extensions/code-intel/lsp.ts', line: 347, column: 117 });
  console.log('DEFINITION\n' + definition.text + '\n');
  console.log('REFERENCES\n' + references.text + '\n');
  console.log('HOVER\n' + hover.text + '\n');
} finally {
  await lsp.clearCodeIntelLspClients();
}
NODE
```

Observed result:

- **definition** resolved `renderTruncatedText` from a call site back to its function definition
- **references** returned four semantic references for `ensureSupportedTypeScriptFile`
- **hover** returned a compact function signature for `actionableMissingServerMessage`

Sample output excerpts:

```text
TypeScript definition lookup for extensions/code-intel/lsp.ts:L487:22
Found 1 definition target(s).
- extensions/code-intel/lsp.ts:L219:10
```

```text
TypeScript references for extensions/code-intel/lsp.ts:L502:5
Found 4 reference(s) across 1 file(s).
```

```text
TypeScript hover for extensions/code-intel/lsp.ts:L347:117

```typescript
function actionableMissingServerMessage(command: string[]): string
```
```

Interpretation:

- the first LSP workflow completed successfully on the chosen language
- results were bounded and human-readable
- outputs did not fall back to opaque JSON-RPC arrays or protocol dumps

## 5) Missing-server fallback validation

Command coverage:

- `tests/code-intel-lsp.test.mjs` creates a temp workspace with a fake TypeScript server command and asserts that the tool rejects with an actionable setup message

Observed result:

- failure mode is explicit and actionable
- message tells the operator to run `npm install`, then `/reload`
- AST tools remain available in that degraded path

## 6) Existing packaged feature regression check

Command:

```bash
node --test \
  tests/opencode-plan-mode.test.mjs \
  tests/opencode-plan-mode.integration.test.mjs \
  tests/opencode-plan-mode.rail.test.mjs \
  tests/rtk-integration.test.mjs \
  tests/code-intel-ast.test.mjs \
  tests/code-intel-lsp.test.mjs
```

Observed result:

- `42` tests passed
- `0` failed

This covers:

- plan mode behavior and execution handoff logic
- plan rail stability
- RTK integration behavior
- new AST tool behavior
- new LSP tool behavior and missing-server fallback

Additional subagent bridge registration check:

```bash
node - <<'NODE'
import jitiFactory from '@mariozechner/jiti';
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const bridgeModule = await jiti.import('./extensions/subagents-bridge/index.ts');
const bridge = bridgeModule.default ?? bridgeModule;
const commands = [];
const tools = [];
const pi = {
  registerCommand(name) { commands.push(name); },
  registerTool(def) { tools.push(def.name); },
  on() {}, setActiveTools() {}, getActiveTools() { return []; },
  events: { on() {}, emit() {} }, exec() { throw new Error('not used'); },
  sendMessage() {}, sendUserMessage() {}, appendEntry() {}, registerShortcut() {},
  registerFlag() {}, registerMessageRenderer() {}, getCommands() { return []; },
  registerProvider() {}, unregisterProvider() {}, setSessionName() {},
  getSessionName() { return undefined; }, setLabel() {}, getAllTools() { return []; },
  getFlag() { return undefined; }, setThinkingLevel() {}, getThinkingLevel() { return 'off'; },
  setModel() { return Promise.resolve(false); },
};
bridge(pi);
console.log(JSON.stringify({ commands, tools }, null, 2));
process.exit(0);
NODE
```

Observed result:

```json
{
  "commands": ["agents", "subagents-info"],
  "tools": ["Agent", "get_subagent_result", "steer_subagent"]
}
```

Interpretation:

- `/agents` and the upstream subagent tools are still registered through the bridge
- no evidence of duplicate registration regressions appeared in the load path or test pass

## Overall outcome

- `npm install` succeeds
- reload-equivalent loading succeeds without extension conflicts
- AST tools work on this repo with bounded, human-readable output and noise-path filtering
- the first TypeScript LSP workflow works end-to-end
- missing-server fallback is explicit and actionable
- existing packaged plan mode, RTK integration, and subagent bridge registration did not regress in the validated paths

## Remaining gaps / risks

- interactive TUI command invocation of `/agents`, `/plan`, and `/rtk-status` was validated indirectly through tests and registration checks rather than by a full manual transcript capture in an interactive Pi session
- the current LSP slice is intentionally limited to TypeScript / TSX / JS
- generic MCP bridging remains deferred for the MVP

## Recommended next expansion path

1. document operator-facing examples in README and usage docs
2. add richer snippet shaping and optional workspace-symbol support if needed
3. consider a second language only after TypeScript usage proves stable
4. revisit MCP compatibility only if a Pi-native MCP surface or strong product need emerges
