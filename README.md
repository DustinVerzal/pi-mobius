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

### Prompt improvement

- `/prompt-improve <request>`
- `/pm <request>`
- `prompt_improve` tool for agent-driven workflows
- direct skill invocation also works: `/skill:prompt-master ...`

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
