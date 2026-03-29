# pi-mobius install validation

Maintainer-facing install/onboarding checklist for validating `pi-mobius` in a clean scope before sharing it with other users.

## Prerequisites

- Pi `0.61.1` or newer
- `git`
- `npm`
- A real public repo URL to replace `<PUBLISHED_GIT_URL>` once the repo is published

## Core rule to document

A fresh local clone is **not** equivalent to a git/URL install.

- **Local path installs** (`pi install .`, `pi install /path`, `pi install -l /path`) are added to settings without copying and without installing dependencies.
- **Git/URL installs** (`pi install <git-or-https-source>`, optionally with `-l`) clone into a Pi-managed directory and run `npm install` automatically.

That distinction matters here because `extensions/subagents-bridge/index.ts` imports `@tintinweb/pi-subagents` at runtime.

## Short answers the docs must keep explicit

- **Is `pi install .` enough?** No, not for a fresh clone. Run `npm install` first.
- **When is `npm install` required?** Whenever `pi-mobius` is loaded from a local checkout or local path.
- **Do users need to install the subagent extension separately?** No. `pi-mobius` already owns the subagent integration through `extensions/subagents-bridge/`.

## Bootstrap utility for the full ecosystem

This repo also ships a convenience installer for the broader Pi package stack currently used alongside `pi-mobius`:

- `pi-mobius`
- `npm:pi-tool-display`
- `npm:pi-context`
- `npm:pi-web-access`
- `npm:pi-mcp-adapter`

It runs `npm install` for a local `pi-mobius` checkout when needed, installs each package with `pi install`, and then patches Pi settings with the repo's shared UI defaults (`opencode-nord`, `quietStartup`, `collapseChangelog`, and related display tweaks).

Examples:

```bash
npm install
npm run install:ecosystem
npm run install:ecosystem -- --dry-run
npm run install:ecosystem -- --scope local --project /path/to/consumer-project
npm run install:ecosystem -- --self-source <PUBLISHED_GIT_URL>
```

The installer intentionally does **not** modify model/provider configuration or API-key setup.

## Supported install matrix

| Scenario | Command pattern | Manual `npm install` required? | Expected package location | Expected result |
| --- | --- | --- | --- | --- |
| Local clone before dependencies | `git clone ... && cd pi-mobius && pi install .` | Yes | Original clone directory | Fails to load `subagents-bridge` because `@tintinweb/pi-subagents` is missing |
| Local clone after dependencies | `git clone ... && cd pi-mobius && npm install && pi install .` | Yes | Original clone directory | Package loads and exposes plan/subagent commands |
| Global git/URL install | `pi install <PUBLISHED_GIT_URL>` | No | `~/.pi/agent/git/<host>/<path>/` | Pi clones the repo, runs `npm install`, and the package works without extra setup |
| Project-local git/URL install | `pi install -l <PUBLISHED_GIT_URL>` | No | `.pi/git/<host>/<path>/` | Same as above, but scoped to the current project |

## Smoke checks for the recommended install path

Run these after the recommended git/URL install, or after a local clone has already run `npm install`.

1. Start Pi in the scope where the package is active.
2. Run `/subagents-info`.
   - **Pass:** Pi reports that bundled `@tintinweb/pi-subagents` is loaded through the local bridge.
3. Run `/plan status`.
   - **Pass:** Pi shows the current planning status instead of treating `/plan` as plain text.
4. Run `/agents`.
   - **Pass:** The command is available through the bundled subagent integration.
   - **Fail:** You see duplicate-registration errors for `Agent`, `get_subagent_result`, `steer_subagent`, or `/agents`.

## Clean-room validation checklist

Use disposable scopes when validating these scenarios. Keep the resulting temp directories out of git.

### 1. Local clone before `npm install`

Purpose: prove that `pi install .` does not install dependencies for a fresh clone.

```bash
git clone <PUBLISHED_GIT_URL> pi-mobius
cd pi-mobius
pi install .
pi -p "/agents"
```

Pass/fail expectations:

- `node_modules/` is still absent in the clone unless you ran `npm install` yourself.
- Pi fails to load `extensions/subagents-bridge/index.ts` because `@tintinweb/pi-subagents/dist/index.js` is missing.
- `/agents` is not available because the bridge never loaded.

### 2. Local clone after `npm install`

Purpose: verify the documented local-contributor workflow.

```bash
git clone <PUBLISHED_GIT_URL> pi-mobius
cd pi-mobius
npm install
pi install .
pi -p "/subagents-info"
pi -p "/plan status"
pi -p "/agents"
```

Pass/fail expectations:

- `node_modules/@tintinweb/pi-subagents/` exists in the clone.
- Pi starts without extension-load errors.
- `/subagents-info`, `/plan status`, and `/agents` are available without extra setup.

### 3. Global git/URL install

Purpose: verify the recommended share-with-friends path.

```bash
pi install <PUBLISHED_GIT_URL>
```

Pass/fail expectations:

- Pi clones the repo into `~/.pi/agent/git/<host>/<path>/`.
- That cloned package contains `node_modules/` without any manual `npm install` step.
- The smoke checks above pass in a directory where the global install is active.

### 4. Project-local git/URL install

Purpose: verify the project-scoped version of the recommended path.

```bash
mkdir consumer-project
cd consumer-project
pi install -l <PUBLISHED_GIT_URL>
```

Pass/fail expectations:

- Pi clones the repo into `.pi/git/<host>/<path>/`.
- That cloned package contains `node_modules/` without any manual `npm install` step.
- The smoke checks above pass inside that project.

## Duplicate subagent troubleshooting

### Expected conflict

If `pi-mobius` and a standalone `npm:@tintinweb/pi-subagents` package are both active in the same scope, Pi will report duplicate registrations such as:

- `Tool "Agent" conflicts with .../extensions/subagents-bridge/index.ts`
- `Tool "get_subagent_result" conflicts with .../extensions/subagents-bridge/index.ts`
- `Tool "steer_subagent" conflicts with .../extensions/subagents-bridge/index.ts`
- `Command "/agents" conflicts with .../extensions/subagents-bridge/index.ts`

This is expected. The bridge is designed to be the single owner of upstream subagent registrations when `pi-mobius` is active.

### Preferred fix order

1. Keep `pi-mobius` as the active subagent integration.
2. Remove `npm:@tintinweb/pi-subagents` from that same scope.
3. If you still want it installed in another scope, shadow it where `pi-mobius` is active by disabling its extensions.

Shadow example:

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

That is the same pattern used by this repo's own `.pi/settings.json`, which lets a standalone global install exist elsewhere while preventing duplicate subagent registrations in this repo.

## Publishing-time placeholder

`<PUBLISHED_GIT_URL>` is still a placeholder in this repo until the final public remote exists. This checkout currently has no configured git remote, so the literal recommended command cannot be copy-pasted yet. Replace the placeholder before handing the README to other users.
