# opencode-plan-mode

Recovered planning mode extension for Pi.

## Implemented features

- `/plan` command, empty-editor `Tab` toggle, and `Ctrl+Alt+P` shortcut
- `/plan <request>` improves the request with the packaged `prompt-master` skill, then starts a fresh planning session with the improved prompt
- `plan_enter` tool that primes `/plan <request>` in the editor from a normal turn
- `plan_exit` tool with a dedicated bounded approval review surface, richer execution-readiness review, revision flow, and resumable fresh-session execution handoff
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

When the terminal is wide enough, workflow state renders as a compact right-side rail for the overall session UI instead of hanging off the input editor render path. The rail is intentionally height-bounded, non-capturing, and summarized so transcript/tool output stays visually primary even with long goals, many steps, blockers, warnings, or subagent activity. Routine state syncs, approval review, fresh-session execution handoff, session switches, and sidebar toggles all reuse the same rail handle unless there is a real layout change.

On narrow terminals, during first-render handoff moments, or whenever the rail is hidden, the extension follows the documented Pi pattern of keeping persistent workflow state on supported surfaces: `setStatus()` plus a compact `setWidget(..., { placement: "belowEditor" })` summary. The custom editor no longer appends fallback workflow text into its own render output, which keeps the input area stable when `/plan` approval transitions into execution.

While planning, the agent should write the plan into the current plan file and then call `plan_exit` for approval. Approval now opens a dedicated bounded review overlay so long plans stay inside a fixed viewport while the transcript remains readable. The review supports `↑/↓` or `j/k` to scroll, `PgUp/PgDn` plus `Home/End` for faster movement, `Tab` or `←/→` to switch actions, `Enter` to confirm, and `Esc` to cancel back into planning. Users can also run `/plan` while planning to open the same approval flow directly, and once a plan is approved, `/plan` resumes into fresh-session execution with a persisted handoff packet plus stronger drift re-review / override handling.

## Workflow UI contract

- Wide terminals: stable right rail + footer status. The rail should not be hidden or recreated just because sidebar data changed.
- Narrow terminals or hidden rail: compact widget + footer status. Progress must remain visible without injecting fallback text into the editor render path.
- Approval → execution handoff: the widget may carry state before the first render, then yield to the rail once a wide layout is known.
- Session switch / shutdown: the rail/widget/status surfaces are updated or cleared exactly once per transition.

## Regression coverage

- `tests/opencode-plan-mode.rail.test.mjs` covers rail-handle stability, approval/execution handoff, narrow-terminal widget fallback, sidebar toggle loops, `/plan off`, repeated session switches, and session shutdown cleanup.
- `tests/opencode-plan-mode.integration.test.mjs` and `tests/opencode-plan-mode.test.mjs` continue to cover plan parsing, execution handoff policy, sidebar summaries, and approval/execution drift handling.