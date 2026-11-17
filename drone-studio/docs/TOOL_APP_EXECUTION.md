# Lucidity as a tool app — execution plan

**Status: plan, November 17, 2026.** How to get from the current code to the product in [TOOL_APP_VISION.md](TOOL_APP_VISION.md), using the design in [TOOL_APP_ARCHITECTURE.md](TOOL_APP_ARCHITECTURE.md). No phase has started.

## Approach

- **Every phase ends in something you can use from your own assistant.** No phase is pure plumbing.
- **Read before write, documents before devices.** Risk rises one step at a time: observe, then edit designs, then propose device changes.
- **The app keeps working throughout.** Each phase leaves the full UI usable by hand and the test suite green.
- **Mock aircraft first, bench second.** Every device behaviour is proven against the existing injected fixtures before a real aircraft, and bench results are reported separately from software results, as the existing docs already do.
- **Sizes, not dates.** Phases are marked small, medium, or large relative to each other. Nothing has been measured that would justify calendar estimates.

## Phase 0 — Baseline and contract *(small)*

Purpose: know the starting point and freeze the first tool list before writing server code.

- Record the baseline for six fixed tasks, done today by an assistant driving the browser: read aircraft status; find one parameter; compare against a backup; summarise a flight log; open a storyboard; change a light cue. Capture time, tool calls, and screenshots for each.
- Confirm the four decisions listed at the end of the vision document.
- Write the phase 1 tool contract (names, inputs, outputs, size caps) as a reviewed document.
- Test each target assistant with the `direction-lab` MCP server to learn its limits: maximum tool output, maximum call duration, how it prompts before a tool runs.

**Done when:** baseline numbers are written down, and the limits of each assistant are known from a real run.

## Phase 1 — The first door: observe *(medium)*

Purpose: your assistant can answer questions about the bench instantly, and you can see it doing so.

Build:
- `lucidityd`: move the two Vite plugins into a standalone Node server; Vite proxies to it in development.
- The capability registry, with the existing read routes re-declared through it.
- MCP endpoint over local HTTP, plus the `lucidity mcp` stdio bridge.
- Level 0 tools: `get_workspace` (without UI focus yet), `get_aircraft`, `get_parameters`, `get_escs`, `run_diagnostics`, `list_flight_logs`, `analyze_flight_log`, `get_activity`.
- A synthetic-aircraft mode (`lucidityd --demo`) built from the existing fixtures, so everything is testable with no hardware.
- UI: Assistant status in the sidebar footer with the Off / Observe switch; a first Activity dock listing tool calls; the Connect an assistant page with setup for Claude Desktop, Claude Code, and Codex.
- Tests: contract tests through an in-memory MCP client; size-budget test; injected-instruction tests on device text.

**Done when:**
- From Claude Desktop, Claude Code, and Codex, "what's connected, and is anything off with its failsafe parameters?" is answered correctly in three calls or fewer with no screenshots, on the demo aircraft.
- Each call appears in the Activity dock, and switching to Off blocks the next call.
- The six baseline tasks that are read-only are re-measured and compared.
- No model key exists anywhere in the setup.

## Phase 2 — Server-owned state and a live UI *(large)*

Purpose: an assistant's edit to a show appears in your open editor at once, and you and the assistant share one undo history. This is the largest phase because it changes where state lives.

Build:
- State store on disk with revisions and server-side undo.
- One-time import from `localStorage` that copies and never deletes. Storyboards first, then tunes, parameter backups, check-up reports, bookmarks.
- Event stream to the UI; remove the one-second poll.
- UI focus publishing; `get_workspace` now includes page, selection, and playhead.
- Level 1 tools: `list_storyboards`, `get_storyboard`, `get_edit_schema`, `sample_show`, `edit_storyboard`, `edit_tune`, `edit_file`, `undo`, `connect_aircraft`, `show_in_ui`.
- UI: change marks and pulses; attribution in Activity; Follow toggle; the "review design edits first" setting.
- Repurpose the evaluation oracles as golden-task tests against the new show tools.
- Delete `harness.ts`, `openai.ts`, checkpoints, and all `OPENAI_*` handling.

Order inside the phase, to keep the app working: store and import → event stream → storyboards read through the server → storyboards written through the server → tools → remaining document types → deletion of the old agent code.

**Done when:**
- With a storyboard open, "make the selected drones cyan and move this cue two seconds later" changes the open editor without a reload, as one undo step, marked as the assistant's edit.
- An edit based on an old revision is rejected and the assistant recovers in one further call.
- After a reload, and after a server restart, the UI and the assistant report the same document and revision.
- Existing storyboards survive the import, checked against the browser copy.
- The repository contains no model-provider code.

## Phase 3 — Reviewed device changes *(large)*

Purpose: the motor-direction story works end to end, and no assistant can change hardware without your click.

Build:
- Proposal engine, UI session token, the approve route outside the registry.
- Move the confirmation literals (`confirmed`, `propsRemoved`, and the rest) out of request schemas and into proposal conditions.
- `propose_change`, `await_change`, `cancel_change`, `stop_bench_run`.
- Change kinds, in order: `parameter.set` as a batch with automatic backup and per-parameter readback; `calibration.level`; `esc.startup_melody`; then `esc.setting`, including direction.
- **New protocol work:** writing individual ESC settings through the existing four-way passthrough, starting with Bluejay and BLHeli_S direction.
- UI: change cards on the affected page and in a global inbox; receipts; staleness and expiry handling.
- Level 3 hand-off: `run.motor_test`, `run.bench_show`, `firmware.flash`, `mission.upload` open the existing panel pre-filled and leave Start to you.

**Done when:**
- A test client holding only an MCP session cannot approve a proposal by any route. This test is part of CI.
- On the demo aircraft: "motor 3 is backwards" leads to one change card, one click, a readback, a receipt, and a confirmed answer in the assistant.
- A proposal goes stale when the value changes underneath it, when the aircraft reconnects, and when it expires; each is tested.
- On the bench, props removed: one parameter change and one ESC direction change are completed and verified by a physical spin check. These results are recorded separately as bench evidence.

## Phase 4 — From working to great *(medium)*

Purpose: polish, packaging, and the features that make it pleasant every day.

- `capture_view` for visual questions.
- Scoped grants: pre-approve a narrow class of changes for a limited period.
- Per-aircraft history built from receipts, with comparison between any two points.
- Command palette and keyboard handling for cards (approve, reject, next).
- One-command install and start; then installable bundles for each assistant (a Claude Desktop extension, a Claude Code plugin, a Codex plugin).
- Updated public demo with a scripted assistant walk-through.
- A full pass on empty, loading, error, and disconnected states for every new surface, in both themes and at phone width.

**Done when:** a new user goes from install to a first answered question in under five minutes, and the six baseline tasks meet the targets in the vision document.

## Phase 5 — Reach *(open-ended)*

- ChatGPT's chat app through a tunnel, levels 0 and 1 only, after checking what that route requires.
- A second flight stack (Betaflight over MSP) declared through the same registry, as the test that the design is not ArduPilot-shaped.
- AM32 ESC settings.
- Team use: read-only sharing of an aircraft's history.

## Testing strategy

| Layer | What it proves | How |
| --- | --- | --- |
| Contract | Each tool's schema, output, level, and size cap | In-memory MCP client against the registry; runs in CI |
| Golden tasks | A scripted assistant completes fixed tasks within a call budget | The repurposed evaluation oracles; no model involved |
| Approval | An MCP session can never approve or supply a physical condition | Negative tests in CI |
| Untrusted text | Instructions planted in status text, logs, and file names change nothing | Injection fixtures |
| Performance | Latency and size budgets hold | Budget tests in CI; baseline comparison per phase |
| Real assistants | Claude Desktop, Claude Code, and Codex each complete the golden tasks | Manual run per phase, recorded with app version; never claimed from mock results |
| Bench | Device changes behave on real hardware | Props-off procedure; recorded separately from software evidence |

## Risks

| Risk | Effect | Response |
| --- | --- | --- |
| Moving state out of the browser loses someone's storyboards | Lost work | Import copies and never deletes; verified against the browser copy; old keys kept until the user removes them |
| Assistant apps differ in limits and prompting | A flow that works in one fails in another | Measure in phase 0; design to the tightest limit; test all three every phase |
| The tool list grows until models choose badly | Slower, less accurate assistants | Hard budget on tool count and definition size, enforced in CI; new behaviour goes into an existing tool's `kind` where it fits |
| A local program imitates the UI to approve changes | A device change you did not approve | Stated limit of a single-user local tool; UI session token raises the bar; all approvals journalled; physical interlocks unchanged |
| Calls that wait on a human outlast an assistant's timeout | Assistant reports failure while the change proceeds | `await_change` returns "still waiting" before the limit and can be called again; the proposal carries the truth |
| Two browser tabs disagree about focus | "This cue" resolves to the wrong one | Most recently active tab wins; `get_workspace` reports which tab and how old the focus is |
| ChatGPT's chat app needs a remote server | That audience waits | Codex covers ChatGPT subscribers locally from phase 1; the tunnel is phase 5 and limited to safe levels |
| Phase 2 is large and touches every store | Long period with a half-moved app | Fixed internal order, one document type at a time, app usable after each step |
| ESC setting layouts vary by firmware and version | A wrong write to an ESC | Per-firmware layouts with version checks; refuse unknown versions; read back after every write; props-off bench verification before the kind is enabled |

## What to do first

Phase 0, then the first slice of phase 1: `lucidityd` with the demo aircraft, `get_workspace` and `get_aircraft` over the stdio bridge, and the Activity dock. That slice is small, needs no hardware, and puts the central idea in your hands: ask your own assistant about the drone and watch Lucidity show the call.
