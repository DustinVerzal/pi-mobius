# Plan Mode Validation Scenarios

This checklist exercises the redesigned workflow end to end.

## Core flow
- `/plan`
  - enters planning mode in the current session
  - creates the session plan file if missing
  - shows the workflow rail or compact fallback summary
- `/plan <request>`
  - runs prompt-master first
  - starts a fresh planning session with the improved prompt when available
  - falls back to the original request if extraction fails

## Approval and execution
- `plan_exit`
  - shows the dedicated bounded approval review overlay
  - keeps action choices visible while the plan body scrolls inside the viewport
  - supports `↑/↓` or `j/k`, `PgUp/PgDn`, `Home/End`, `Tab` or `←/→`, `Enter`, and `Esc`
  - offers **Approve**, **Revise in editor**, and **Keep planning**
  - blocks approval when numbered steps are malformed
- approved state
  - persists across interruption or session restore
  - shows `approved_waiting_execution` in the sidebar/status line
  - resumes with `/plan`
- execution start
  - opens a fresh child session
  - injects execution instructions with the remaining structured steps

## Runtime robustness
- interrupted resume
  - restore during planning
  - restore while awaiting approval
  - restore after approval but before execution start
  - restore during execution with partial progress already recorded
- malformed step numbering
  - duplicate step numbers
  - out-of-order step numbers
  - missing dependency targets
  - dependency cycles
- missing completion markers
  - fallback natural-language detection updates progress
  - warning appears in the workflow surface
  - `plan_progress` can recover explicit state when needed
- plan drift after approval
  - editing the approved plan changes the artifact signature
  - execution warnings surface the mismatch

## Subagent orchestration
- planning mode
  - only `Explore` and `Plan` subagents are allowed
  - plan instructions discourage defaulting every step to `Explore`
- execution mode
  - main agent handles obvious work directly
  - `general-purpose` subagents handle implementation work
  - background subagents launched in parallel surface live activity and completion state in the workflow panel

## UI surface
- wide terminal
  - compact workflow rail renders on the right side of the overall session UI
  - rail height stays bounded and preserves a complete box frame even with long goals, many steps, warnings, blockers, and subagent activity
  - chat/tool output remains visually primary while the rail still shows phase, progress, active step, warnings, and subagents at a glance
- narrow terminal
  - compact workflow summary remains visible below the editor
  - fallback summary stays to a small fixed number of lines instead of repeating long status text indefinitely
- long-plan approval
  - the approval review stays inside a fixed overlay viewport
  - scrolling the summary never pushes the transcript or action row off-screen

## Competitive UX checks
- compare the result against Codex / OpenCode / Claude Code principles
  - transcript stays primary
  - workflow state is compact secondary context
  - approval / resume contract remains explicit and durable
