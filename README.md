<div align="center">

# pi-mobius

**Plan mode, subagents, prompt improvement, code intelligence, RTK-aware bash, and `opencode-nord` — bundled for Pi.**

![Pi package](https://img.shields.io/badge/Pi-package-111827?style=for-the-badge)
![Plan mode](https://img.shields.io/badge/plan-mode-7C3AED?style=for-the-badge)
![Subagents](https://img.shields.io/badge/subagents-0EA5E9?style=for-the-badge)
![Code intel](https://img.shields.io/badge/code--intel-059669?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-2563EB?style=for-the-badge)

```bash
pi install <git-or-https-source>
```

*One Pi package for planning, delegation, repo intelligence, and a polished terminal theme.*

[Install](#install) · [Quick start](#quick-start) · [Usage](#usage) · [Package contents](#package-contents)

</div>

---

## What this package adds

- **Plan mode** with persisted state, approval flow, and workflow rail / compact panel
- **Subagent bridge** around `@tintinweb/pi-subagents`, including `/agents` and `/subagents-info`
- **Prompt improvement** via the bundled `prompt-master` skill and helper commands
- **Code intelligence** tools for AST search and TypeScript LSP navigation
- **RTK bash integration** that rewrites Pi `bash` calls through `rtk rewrite` when RTK is installed
- **Theme**: `opencode-nord`

## Requirements

- Pi `0.61.1` or newer
- `npm` for local-checkout installs
- Optional: `rtk` on your `PATH` if you want RTK bash rewriting

## Install

Like other Pi packages, this repo works best when installed from a package source instead of a live working tree.

### Recommended: install from git / URL

For published package sources, prefer a git or HTTPS install. Pi clones the package into a Pi-managed directory and runs `npm install` automatically.

```bash
pi install <git-or-https-source>
```

Project-local install:

```bash
pi install -l <git-or-https-source>
```

### Install from a local checkout

For local path installs, Pi does **not** install dependencies for you. Run `npm install` first.

```bash
git clone <repo-url> pi-mobius
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

### Try without installing

```bash
npm install
pi -e .
```

## Quick start

After install, start Pi in the scope where the package is active and verify:

- `/subagents-info` — confirms the bundled subagent bridge is loaded
- `/plan status` — shows current planning state
- `/agents` — opens the bundled subagent UI
- `/rtk-status` — reports whether RTK rewriting is active
- ask Pi to use `code_intel_repo_map` on `extensions/` — confirms the code-intel tools are available

If Pi is already running when you install the package, run `/reload`.

## Usage

### Plan mode

Commands:

- `/plan` — enter plan mode in the current session
- `/plan <request>` — improve the request with `prompt-master`, then start a fresh planning session
- `/plan status` — show current plan file, mode, and panel visibility
- `/plan sidebar` — toggle the workflow rail / compact panel

Shortcuts:

- `Tab` — toggle plan mode when the input editor is empty
- `Ctrl+Alt+P` — toggle plan mode
- `Ctrl+Alt+B` — toggle the workflow rail / compact panel

Behavior:

- Plans are written to `.pi/plans/<session>.md`
- `plan_exit` opens the explicit approval flow
- Approved sessions persist goal, blockers, files, verification notes, ready-frontier data, and delegation guidance
- On wide terminals, workflow state renders as a compact right-side rail; on narrow terminals, Pi falls back to a compact editor summary

### Prompt improvement

Available entry points:

- `/prompt-improve <request>`
- `/pm <request>`
- `prompt_improve` tool
- `/skill:prompt-master ...`

### Code intelligence

This package includes a repo-owned `code-intel` extension.

Tool families:

- **AST**: `code_intel_repo_map`, `code_intel_ast_search`
- **TypeScript LSP**: `code_intel_definition`, `code_intel_references`, `code_intel_hover`

Recommended workflow:

1. Start with `code_intel_repo_map` for a bounded overview
2. Use `code_intel_ast_search` for JS/TS symbol or structural search
3. Use LSP tools for semantic TypeScript navigation
4. Fall back to built-in `grep` or `read` when you already know the exact file

Examples:

- `Use code_intel_repo_map on extensions/code-intel.`
- `Use code_intel_ast_search with pi.registerTool($$$ARGS) under extensions/.`
- `Use code_intel_definition for extensions/code-intel/lsp.ts at line 487, column 22.`

For setup notes, decision boundaries, troubleshooting, and example workflows, see [`docs/code-intel-usage.md`](docs/code-intel-usage.md).

### RTK bash integration

`pi-mobius` can override Pi's `bash` tool through RTK, but it does **not** install RTK itself.

Install the external `rtk` binary using RTK's own instructions, then verify with:

```text
/rtk-status
```

Behavior:

- **RTK available**: Pi rewrites `bash` commands through `rtk rewrite <command>`
- **RTK missing or unhealthy**: Pi fails open and runs the original bash command unchanged
- The current integration is intentionally **bash-only**; built-in `read`, `grep`, `find`, and `ls` are not rewritten

### Theme

Select the bundled theme in your Pi config:

```json
{
  "theme": "opencode-nord"
}
```

### Pi multiline input (`Ctrl+J`)

`pi-mobius` does not change Pi's input behavior. Pi already exposes newline insertion as the configurable `tui.input.newLine` keybinding, which defaults to `shift+enter`.

If you want `Ctrl+J` as an additional newline key, add this to `~/.pi/agent/keybindings.json`:

```json
{
  "tui.input.newLine": ["shift+enter", "ctrl+j"]
}
```

Then run `/reload`.

## Package contents

- `extensions/opencode-plan-mode/` — plan mode, workflow rail / compact panel, `question`, `plan_enter`, and `plan_exit`
- `extensions/subagents-bridge/` — local wrapper around `@tintinweb/pi-subagents`
- `extensions/prompt-master-injection/` — prompt-improvement helpers around the bundled skill
- `extensions/rtk-integration/` — RTK-backed `bash` rewriting with fail-open fallback
- `extensions/code-intel/` — AST-backed repo mapping / structural search and TypeScript LSP workflows
- `skills/prompt-master/` — bundled prompt-improvement skill
- `themes/opencode-nord.json` — bundled theme

## Troubleshooting

### Local install works differently from git / URL install

A fresh local clone is **not** the same as a git / URL install.

- **Git / URL installs** clone into a Pi-managed directory and run `npm install`
- **Local path installs** (`pi install .`, `pi install /path`, `pi install -l /path`) do not install dependencies

If a local install fails to load `extensions/subagents-bridge/`, run `npm install` in the checkout and reload Pi.

### Duplicate subagent registrations

In any scope where `pi-mobius` is active, it should be the single owner of subagent registration. A separate install of `npm:@tintinweb/pi-subagents` in the same scope can cause duplicate `Agent`, `get_subagent_result`, `steer_subagent`, or `/agents` registrations.

Preferred fix order:

1. Keep `pi-mobius` as the active subagent integration
2. Remove the standalone `npm:@tintinweb/pi-subagents` package from that scope
3. If needed, shadow that package in the active scope by disabling its extensions

Example:

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

## Development notes

For local development inside this repo:

```bash
npm install
```

This repo also ships a local `.pi/settings.json` that points back to `..` and selects `opencode-nord`, so opening Pi inside this repo works after dependencies are installed.

For the full install matrix and maintainer validation checklist, see [`docs/install.md`](docs/install.md).
