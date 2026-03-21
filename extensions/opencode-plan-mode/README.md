# opencode-plan-mode

Recovered planning mode extension for Pi.

## Implemented features

- `/plan` command, empty-editor `Tab` toggle, and `Ctrl+Alt+P` shortcut
- `/plan <request>` starts a fresh planning session and sends the request into plan mode
- `plan_enter` tool that primes `/plan <request>` in the editor from a normal turn
- `plan_exit` tool that reviews the current plan file and switches to execution mode on approval
- real plan file stored under `.pi/plans/<session>.md`
- planning mode restricts edits to the active plan file only
- planning mode blocks destructive bash commands
- `question` tool for clarifying questions during planning
- toggleable right-side plan overlay with `/plan sidebar`, `/plan panel`, `/plan sidebar on|off`, and `Ctrl+Alt+B`
- execution mode tracks numbered steps via `[DONE:n]` markers
- footer/status progress during execution

## Usage

- `/plan` — enter planning mode in the current session
- `/plan <request>` — start a fresh planning session for that request
- `/plan status` — show current mode, plan file, and sidebar state
- `/plan sidebar` or `/plan panel` — toggle the right-side sidebar
- `/plan sidebar on|off` — explicitly show or hide the sidebar
- `/plan off` — leave planning or execution mode
- `Tab` — toggle planning mode when the input editor is empty

`plan_enter` prepares the exact `/plan <request>` command in the editor so the user can submit it into a fresh planning session.

While planning, the agent should write the plan into the current plan file and then call `plan_exit` for approval.
