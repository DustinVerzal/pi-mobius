# Plan Mode Validation Scenarios

This checklist exercises the redesigned workflow end to end.

## Core flow
- `/plan`
  - enters planning mode in the current session
  - creates the session plan file if missing
  - shows the workflow rail on wide terminals or the compact widget/status fallback when the rail is hidden or width is narrow
- `/plan <request>`
  - starts a fresh planning session from the provided request
  - carries the request into the child planning session without replayable plan-only tool results
- `Ctrl+Alt+P`
  - toggles planning mode from a normal session
  - re-primes `/plan` when approved execution is waiting

## Approval and execution
- `plan_exit`
  - shows the dedicated bounded approval review overlay
  - keeps action choices visible while the plan body scrolls inside the viewport
  - supports `↑/↓` or `j/k`, `PgUp/PgDn`, `Home/End`, `Tab` or `←/→`, `Enter`, and `Esc`
  - only offers **Approve** / **Approve and start execution** when the approval contract is complete
  - otherwise limits the user to **Revise in editor** and **Keep planning**
  - blocks approval when numbered steps are malformed or when required contract fields are missing
- approval contract
  - top-level sections must include `## Goal`, `## Success Criteria`, `## Execution Policy`, `## Re-review Triggers`, `## Files`, and `## Verification`
  - each executable step must include `Agent`, `Batch`, `Depends on`, `Scope`, and verification intent
  - optional `Checkpoint`, `Review gate`, and `Review reason` metadata should render cleanly in the approval summary when present
- approved state
  - persists across interruption or session restore
  - shows `approved_waiting_execution` in the rail/widget/status surfaces
  - resumes with `/plan`, `/plan start`, or `/plan resume`
- execution start
  - opens a fresh child session
  - injects execution instructions with the remaining structured steps plus success criteria, scope anchors, pause conditions, execution policy, and checkpoint expectations
  - keeps the workflow summary visible through widget/status fallback until a wide rail render is available
- approval → execution manual pass
  - reproduce `/plan` → approve-and-start or `/plan` → approve → `/plan`
  - repeat once with the rail visible and once after `/plan sidebar off`
  - exercise revise-in-editor before approval, then approve again
  - confirm the approval summary / overlay copy surfaces success criteria, scope anchors, pause conditions, execution policy, and drift explanations without crowding out the transcript

## Runtime robustness
- interrupted resume
  - restore during planning
  - restore while awaiting approval
  - restore after approval but before execution start
  - restore during execution with partial progress already recorded
  - resume approved execution after a session switch without duplicate rails, stale widgets, or orphaned status lines
- repeated UI transitions
  - loop `/plan sidebar`, `/plan sidebar off`, `/plan sidebar on`, and `Ctrl+Alt+B`
  - switch sessions repeatedly during planning, approval, approved-waiting, and execution states
  - run `/plan off` from execution and confirm the rail/widget/status surfaces all clear cleanly
- malformed step numbering
  - duplicate step numbers
  - out-of-order step numbers
  - missing dependency targets
  - dependency cycles
- missing or partial completion summaries
  - fallback natural-language detection updates progress
  - warning appears in the workflow surface
  - `plan_progress` can recover explicit state when needed
  - normalized checkpoints preserve outcome / files / verification / blockers / unblock status when present, and partial checkpoints persist with warnings when some fields are missing
- plan drift after approval
  - editing the approved plan changes the artifact signature
  - execution warnings surface the mismatch with categorized drift reasons (goal, success criteria, scope/files, execution policy, re-review triggers, verification, or steps)
  - users can re-review the plan and operating envelope or explicitly override

## Subagent orchestration
- planning mode
  - only `Explore` and `Plan` subagents are allowed
  - plan instructions discourage defaulting every step to `Explore`
- execution mode
  - main agent handles obvious work directly
  - `general-purpose` subagents handle implementation work
  - delegated prompts require a normalized result summary request covering outcome, files/paths, verification/tests/checks, blockers/risks/issues, and unblock status
  - background subagents launched in parallel surface live activity, checkpoint summaries, and completion state in the workflow panel

## UI surface
- wide terminal
  - compact workflow rail renders on the right side of the overall session UI
  - rail height stays bounded and preserves a complete box frame even with long goals, many steps, warnings, blockers, and subagent activity
  - chat/tool output remains visually primary while the rail still shows phase, progress, active step, warnings, and subagents at a glance
  - routine sidebar-state syncs, approval changes, and execution handoff do not trigger spurious rail hide/show/recreate churn
- narrow terminal
  - compact workflow summary appears as a widget below the editor together with footer status
  - the custom editor does not append fallback workflow lines into its own render output
  - fallback summary stays to a small fixed number of lines instead of repeating long status text indefinitely
- resize checks
  - resize between narrow and wide widths during planning and execution
  - confirm the rail ↔ widget transition stays stable in both directions
  - confirm `Ctrl+Alt+B` / `/plan sidebar` still hides or re-shows the rail without losing compact status visibility
- long-plan approval
  - the approval review stays inside a fixed overlay viewport
  - scrolling the summary never pushes the transcript or action row off-screen

## Debugging residual visual artifacts
- if any approval → execution glitch remains, capture raw writes with `PI_TUI_WRITE_LOG=/tmp/pi-tui.log pi`
- reproduce `/plan` → approval → `/plan` execution start, then inspect the write log around the handoff
- repeat the capture once with the rail visible and once with `/plan sidebar off`

## Competitive UX checks
- compare the result against Codex / OpenCode / Claude Code principles
  - transcript stays primary
  - workflow state is compact secondary context
  - approval / resume contract remains explicit and durable
