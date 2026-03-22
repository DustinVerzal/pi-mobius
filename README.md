# pi-mobius

Repo-owned Pi package that replaces the lost symlink/global setup with a versioned package.

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

## Install

### Local development from this repo

Because this package loads the upstream subagent package from the bundled dependency, install dependencies first:

```bash
npm install
pi install /absolute/path/to/pi-mobius
```

For a one-off run without installing globally:

```bash
pi -e /absolute/path/to/pi-mobius/extensions/opencode-plan-mode/index.ts
```

### Project-local install

From another project:

```bash
pi install -l /absolute/path/to/pi-mobius
```

Or add the repo path to `.pi/settings.json` manually:

```json
{
  "packages": ["/absolute/path/to/pi-mobius"]
}
```

This repo also ships a local `.pi/settings.json` that points back to `..` and selects `opencode-nord`, so opening Pi inside this repo uses the package directly after `npm install`. The subagent tools are loaded through `extensions/subagents-bridge/`, so the upstream package stays managed as a dependency instead of a separate top-level extension. That local settings file also shadows any standalone `npm:@tintinweb/pi-subagents` package with `extensions: []` to prevent duplicate `Agent` / `/agents` registrations while working in this repo.

## Usage

### Plan mode

- `/plan` - enter planning mode in the current session
- `/plan <request>` - improve the request with the packaged `prompt-master` skill, then start a fresh planning session with the improved prompt
- `/plan status` - show current plan file, mode, and panel visibility
- `/plan sidebar` - toggle the workflow rail / compact panel
- `Tab` - toggle plan mode when the input editor is empty
- `Ctrl+Alt+P` - toggle plan mode
- `Ctrl+Alt+B` - toggle the workflow rail / compact panel

When the terminal is wide enough, workflow state renders as a compact right-side rail for the overall session UI instead of attaching to the input editor render path. On narrow terminals, the editor keeps a compact workflow summary instead of dropping plan context entirely.

`/plan <request>` first runs the packaged `prompt-master` skill in the current session, waits for a paste-ready planning prompt, and only then creates a fresh child session for planning. If prompt extraction fails, Pi still starts a fresh planning session but falls back to the original request.

While planning, the agent is expected to write the plan into `.pi/plans/<session>.md` and then call `plan_exit` for approval. Approval is now explicit and resumable: the approved handoff persists goal, constraints, blockers, files, verification, ready-frontier data, and delegation guidance in session state. `/plan` in an approved session starts fresh-session execution, and the workflow rail / compact panel shows approval state, ready-now frontier, blockers, warnings, fan-in progress, and live subagent activity.
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

`@tintinweb/pi-subagents` is kept as an upstream dependency rather than being forked into this repo. Our local `extensions/subagents-bridge/` wrapper imports the upstream package and registers it through our package, which lets us extend the behavior without maintaining a fork. Add any local custom commands, hooks, or policy tweaks in that bridge file after the upstream call.

The wrapper also exposes `/subagents-info` as a small local sanity-check command.

When running inside this repo, `.pi/settings.json` loads the package normally and the bridge extension handles the upstream subagent tools, so `Agent`, `get_subagent_result`, `steer_subagent`, and `/agents` are provided once through the wrapper.

### Troubleshooting duplicate subagent registrations

`pi-mobius` should be the single owner of subagent registration in any scope where this package is active. A separate global or project install of `npm:@tintinweb/pi-subagents` in the same scope will conflict with the bridge and produce duplicate tool/command errors for `Agent`, `get_subagent_result`, `steer_subagent`, or `/agents`.

Preferred remediation order:

1. Keep `pi-mobius` as the active subagent integration.
2. Remove the standalone `npm:@tintinweb/pi-subagents` package from that scope, or shadow it with `extensions: []`.

Project-level shadow example:

```json
{
  "packages": [
    "/absolute/path/to/pi-mobius",
    {
      "source": "npm:@tintinweb/pi-subagents",
      "extensions": []
    }
  ]
}
```

That override is the approach used by this repo's own `.pi/settings.json`, which lets you keep a standalone global install for other projects while preventing conflicts here.
