# opencode-plan-mode

Recovered planning mode extension for Pi.

## Implemented features

- `/plan` command, empty-editor `Tab` toggle, and `Ctrl+Alt+P` shortcut
- `/plan <request>` improves the request with the packaged `prompt-master` skill, then starts a fresh planning session with the improved prompt
- `plan_enter` tool that primes `/plan <request>` in the editor from a normal turn
- `plan_exit` tool with summary-first approval, richer execution-readiness review, revision flow, and resumable fresh-session execution handoff
- real plan file stored under `.pi/plans/<session>.md`
- structured plan parsing for `Agent`, `Batch`, `Depends on`, step-level verification, and rationale metadata
- planning mode restricts edits to the active plan file only
- planning mode blocks destructive bash commands
- `question` tool for clarifying questions during planning
- `plan_progress` tool for explicit execution-step recovery when markers need help
- toggleable workflow rail / compact panel with `/plan sidebar`, `/plan panel`, `/plan sidebar on|off`, and `Ctrl+Alt+B`
- execution mode tracks numbered steps via `[DONE:n]` markers plus tolerant fallback detection
- footer/status progress, ready-frontier, blocker, fan-in, warning, and subagent visibility during execution

## Usage

- `/plan` — enter planning mode in the current session
- `/plan <request>` — improve the request first, then start a fresh planning session with the improved planning prompt
- `/plan status` — show current mode, plan file, and panel state
- `/plan sidebar` or `/plan panel` — toggle the workflow rail / compact panel
- `/plan sidebar on|off` — explicitly show or hide the rail / panel
- `/plan off` — leave planning or execution mode
- `Tab` — toggle planning mode when the input editor is empty

`plan_enter` prepares the exact `/plan <request>` command in the editor so the user can submit it into the prompt-improvement bootstrap and then continue in a fresh planning session.

If prompt-master fails to return a paste-ready prompt, `/plan <request>` still opens a fresh planning session but falls back to the original request.

When the terminal is wide enough, workflow state renders as a compact right-side rail for the overall session UI instead of hanging off the input editor render path. On narrow terminals, the editor keeps a compact workflow summary instead of losing the plan surface.

While planning, the agent should write the plan into the current plan file and then call `plan_exit` for approval. Approval now highlights execution-readiness details like verification, blockers, ready-frontier shape, and validation warnings. Users can also run `/plan` while planning to open the same summary-first approval flow directly, and once a plan is approved, `/plan` resumes into fresh-session execution with a persisted handoff packet plus stronger drift re-review / override handling.