# pi-mobius

Repo-owned Pi package that restores the lost symlink/global setup as a versioned package.

## Recommended install

For other users, prefer a git/URL install instead of telling them to clone the repo and run `pi install .`.

Pi clones git/URL sources into a Pi-managed directory and runs `npm install` automatically. That matters for `pi-mobius`, because `extensions/subagents-bridge/index.ts` imports `@tintinweb/pi-subagents` at runtime.

> Replace `<PUBLISHED_GIT_URL>` with the final public repo URL once it exists. This checkout currently has no configured git remote, so the README keeps a placeholder instead of guessing the final source string.

### Global install

```bash
pi install <PUBLISHED_GIT_URL>
```

### Project-local install

```bash
pi install -l <PUBLISHED_GIT_URL>
```

### Direct answers for friend-sharing

- **Is `pi install .` enough?** Only if that clone already ran `npm install` first.
- **When is `npm install` required?** Any time you are loading `pi-mobius` from a local checkout or local path, including `pi install .`, `pi install /path/to/pi-mobius`, `pi install -l /path/to/pi-mobius`, or opening this repo directly after cloning it.
- **Do users need to install the subagent extension separately?** No. `pi-mobius` already loads `@tintinweb/pi-subagents` through `extensions/subagents-bridge/`. Installing the standalone package in the same scope causes duplicate `Agent`, `get_subagent_result`, `steer_subagent`, or `/agents` registrations.

## Quick smoke check after install

Start Pi in the scope where you installed the package and confirm these commands work without extra setup:

- `/subagents-info` - should report that the bundled `@tintinweb/pi-subagents` package is loaded through the local bridge
- `/plan status` - should show current planning status
- `/agents` - should be available through the bundled subagent integration
- `/rtk-status` - should report whether an external `rtk` binary is available; if it is not, the extension should say bash execution is safely falling back to normal Pi behavior
- ask Pi to use `code_intel_repo_map` on `extensions/` - should return a bounded symbol summary and ignore `node_modules` / `.git`

If you see duplicate-registration errors for `Agent` or `/agents`, jump to [Troubleshooting duplicate subagent registrations](#troubleshooting-duplicate-subagent-registrations).

## Local clone / contributor workflow

A local path install does **not** install dependencies for you. For a fresh clone, run `npm install` before loading the package with Pi.

```bash
git clone <PUBLISHED_GIT_URL> pi-mobius
cd pi-mobius
npm install
pi install .
```

Other local-path variants follow the same rule:

```bash
npm install
pi install /absolute/path/to/pi-mobius
pi install -l /absolute/path/to/pi-mobius
```

This repo also ships a local `.pi/settings.json` that points back to `..` and selects `opencode-nord`, so opening Pi inside this repo works after `npm install`.

## Recovered baseline

This package rebuilds the behavior that was still observable from the live Pi session and surviving global config:

- plan mode with persisted `opencode-plan-state`
- visible plan panel state (`panelVisible: true`)
- `plan_enter` bootstrap flow
- subagent integration via a local bridge around `@tintinweb/pi-subagents`
- packaged `prompt-master` skill for prompt improvement
- packaged `opencode-nord` theme

## Package contents

- `extensions/opencode-plan-mode/` - recovered planning mode, workflow rail / compact panel, `question`, `plan_enter`, and `plan_exit`
- `extensions/subagents-bridge/` - local wrapper that loads and extends the upstream subagent package
- `extensions/prompt-master-injection/` - prompt improvement helpers around the packaged skill
- `extensions/rtk-integration/` - bash-only RTK integration that rewrites Pi `bash` tool calls through `rtk rewrite` when the external `rtk` binary is installed, and otherwise fails open to normal Pi bash execution
- `extensions/code-intel/` - AST-backed repo mapping / structural search plus the first curated TypeScript LSP workflows
- `skills/prompt-master/` - vendored prompt improvement skill
- `themes/opencode-nord.json` - recovered Nord-based theme

## Usage

### Plan mode

- `/plan` - enter planning mode in the current session
- `/plan <request>` - improve the request with the packaged `prompt-master` skill, then start a fresh planning session with the improved prompt
- `/plan status` - show current plan file, mode, and panel visibility
- `/plan sidebar` - toggle the workflow rail / compact panel
- `Tab` - toggle plan mode when the input editor is empty
- `Ctrl+Alt+P` - toggle plan mode
- `Ctrl+Alt+B` - toggle the workflow rail / compact panel

When the terminal is wide enough, workflow state renders as a compact right-side rail for the overall session UI instead of attaching to the input editor render path. The rail is intentionally height-bounded and summarized so long goals, warnings, blockers, and subagent activity do not overtake the transcript. On narrow terminals, the editor keeps a compact multi-line workflow summary instead of dropping plan context entirely.

`/plan <request>` first runs the packaged `prompt-master` skill in the current session, waits for a paste-ready planning prompt, and only then creates a fresh child session for planning. If prompt extraction fails, Pi still starts a fresh planning session but falls back to the original request.

While planning, the agent is expected to write the plan into `.pi/plans/<session>.md` and then call `plan_exit` for approval. Approval is now explicit, scrollable, and resumable: a bounded review overlay keeps the transcript readable while exposing the full plan, and the approved handoff persists goal, constraints, blockers, files, verification, ready-frontier data, and delegation guidance in session state. The review supports `↑/↓` or `j/k` scrolling, `PgUp/PgDn` plus `Home/End`, `Tab` or `←/→` for action switching, `Enter` to confirm, and `Esc` to keep planning. `/plan` in an approved session starts fresh-session execution, and the workflow rail / compact panel shows approval state, ready-now frontier, blockers, warnings, fan-in progress, and live subagent activity.

### Pi multiline input (`Ctrl+J`)

`pi-mobius` does not change Pi's prompt-input runtime behavior. Pi already exposes newline insertion as the configurable `tui.input.newLine` keybinding, which defaults to `shift+enter`.

If you want `Ctrl+J` as an additional newline key, add this to your Pi user config at `~/.pi/agent/keybindings.json`:

```json
{
  "tui.input.newLine": ["shift+enter", "ctrl+j"]
}
```

Then run `/reload` in Pi to apply the change. This Pi-native config is especially useful in some terminal or tmux setups where `Shift+Enter` is remapped to a raw linefeed that Pi sees as `Ctrl+J`.

### Prompt improvement

- `/prompt-improve <request>`
- `/pm <request>`
- `prompt_improve` tool for agent-driven workflows
- direct skill invocation also works: `/skill:prompt-master ...`

### RTK bash integration

`pi-mobius` now ships an RTK integration extension, but it does **not** install RTK itself. Install the `rtk` binary separately using RTK's own installation instructions, then make sure `rtk` is on the `PATH` seen by the Pi process.

Use `/rtk-status` to verify the current state:

- **RTK available:** Pi's overridden `bash` tool will call `rtk rewrite <command>` before execution.
- **RTK missing or unhealthy:** Pi will fail open and run the original bash command unchanged.

The current integration is intentionally **bash-only**. Pi's built-in `read`, `grep`, `find`, and `ls` tools are not rewritten by this MVP.

Good smoke checks after RTK is installed:

- run `/rtk-status`
- ask Pi to execute a bash-backed command such as `git status` or `rg TODO .`

If `/rtk-status` says RTK is missing after install, restart Pi or run `/reload` after fixing your `PATH`.

### Code intelligence

`pi-mobius` now ships a repo-owned `code-intel` extension.

Current tool families:

- **AST:** `code_intel_repo_map`, `code_intel_ast_search`
- **TypeScript LSP:** `code_intel_definition`, `code_intel_references`, `code_intel_hover`

Quick local-checkout setup:

```bash
npm install
pi install .
```

Then reload Pi:

```text
/reload
```

Recommended usage pattern:

1. start with `code_intel_repo_map` for a bounded overview
2. use `code_intel_ast_search` for JS/TS structural search
3. switch to LSP tools when you need semantic TypeScript navigation
4. fall back to built-in `grep` / `read` when you already know the exact file or need raw text

Examples:

- `Use code_intel_repo_map on extensions/code-intel.`
- `Use code_intel_ast_search with pi.registerTool($$$ARGS) under extensions/.`
- `Use code_intel_definition for extensions/code-intel/lsp.ts at line 487, column 22.`

For full setup notes, decision boundaries, troubleshooting, and example workflows, see [`docs/code-intel-usage.md`](docs/code-intel-usage.md).

For the MVP, **generic MCP bridging remains deferred**. The code-intel tools are Pi-native wrappers, not a general MCP bridge.

### Theme

Select the recovered theme with:

```json
{
  "theme": "opencode-nord"
}
```

## Notes on subagents

`@tintinweb/pi-subagents` stays upstream. Our local `extensions/subagents-bridge/` wrapper imports that package and registers it through `pi-mobius`, which lets this repo extend the behavior without forking the upstream package.

The wrapper also exposes `/subagents-info` as a small local sanity-check command.

In any scope where `pi-mobius` is active, this package should be the single owner of subagent registration. The bridge provides `Agent`, `get_subagent_result`, `steer_subagent`, and `/agents` through the package itself.

## Troubleshooting duplicate subagent registrations

`pi-mobius` should be the only active owner of subagent registration in a given scope. A separate global or project install of `npm:@tintinweb/pi-subagents` in that same scope will conflict with the bridge and produce duplicate-registration errors for `Agent`, `get_subagent_result`, `steer_subagent`, or `/agents`.

Preferred remediation order:

1. Keep `pi-mobius` as the active subagent integration.
2. Remove the standalone `npm:@tintinweb/pi-subagents` package from that scope.
3. If you still want the standalone package installed elsewhere, shadow it in the scope where `pi-mobius` is active by disabling its extensions.

Project-level shadow example:

```json
{
  "packages": [
    "<pi-mobius source>",
    {
      "source": "npm:@tintinweb/pi-subagents",
      "extensions": []
    }
  ]
}
```

That shadow pattern matches this repo's own `.pi/settings.json`: it keeps `pi-mobius` active while preventing duplicate subagent registrations inside this repo.

## Maintainer validation checklist

See `docs/install.md` for the full install matrix, clean-room validation flow, and duplicate-subagent troubleshooting checklist.
