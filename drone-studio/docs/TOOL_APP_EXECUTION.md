# Lucidity as a tool app — execution plan

**Status: plan, November 17, 2026; revised the same day from a local-app design to a hosted one.** How to get from the current code to the product in [TOOL_APP_VISION.md](TOOL_APP_VISION.md), using the design in [TOOL_APP_ARCHITECTURE.md](TOOL_APP_ARCHITECTURE.md). No phase has started.

## Approach

- **Riskiest assumption first.** The hosted design depends on a browser tab talking reliably to a flight controller and its ESCs. That is tested before anything is built on it.
- **Every phase ends in something a non-technical person can use.** No phase is pure plumbing.
- **Read before write, hardware before shows.** The motivating example is a device setting, so the device path is built first. Show editing follows on the same foundation.
- **The current local app keeps working until the hosted one replaces it.** Nothing is deleted until its replacement is proven.
- **Mock aircraft first, bench second.** Every device behaviour is proven against the existing fixtures before a real aircraft, and bench results are reported separately from software results.
- **Sizes, not dates.** Phases are marked small, medium, or large relative to each other. Nothing has been measured that would justify calendar estimates.

## Phase 0 — Prove the risky parts *(small to medium)*

Purpose: find out whether the hosted design holds, before committing to it.

- **Web Serial spike.** A throwaway page in Chrome that connects to the real flight controller, receives a heartbeat, reads the full parameter list, and performs one ESC four-way passthrough read. Run it with the tab in front and in the background. Props off, battery disconnected.
- **MAVLink in the browser.** Try shimming `node-mavlink` and try a small replacement codec, each against the existing decoder tests. Choose one.
- **Assistant connector check.** Deploy the `direction-lab` MCP server to a temporary web address behind a login. Connect it from Claude and from ChatGPT. Record what each requires (plan tier, setup steps, limits on output size and call duration, how each prompts before a tool runs).
- **Baseline.** Record time, tool calls, and screenshots for six fixed tasks done today by an assistant driving the browser: read aircraft status; find one parameter; compare against a backup; summarise a flight log; open a storyboard; change a light cue.
- **Decisions.** Confirm the five decisions at the end of the vision document. Choose the identity provider, database, and host.

**Done when:** the spike either works or shows exactly what does not; the connector flow has been completed by hand in both assistants; baseline numbers are written down.

**If the spike fails:** fall back to a small installed companion that bridges USB to the cloud. The rest of the plan is unchanged; the device runtime runs in the companion instead of the tab.

## Phase 1 — Hosted skeleton and the first door *(medium)*

Purpose: a person with no technical background can sign in, connect their assistant, and ask about a demo drone.

Build:
- The cloud service: sign-in, database, live channel, deployment pipeline.
- The capability registry as a shared package.
- The remote MCP endpoint with OAuth sign-in and the three scopes.
- A synthetic demo aircraft per account, built from the existing fixtures.
- Tools: `get_workspace`, `get_aircraft`, `get_parameters`, `get_escs`, `get_activity`, against the demo aircraft.
- The existing UI deployed as the hosted site, signed-in, still using browser storage for documents.
- UI: Assistant status with the Off / Observe switch; a first Activity dock; the Connect an assistant page.
- Tests: contract tests through an in-memory MCP client; cross-account isolation tests; size-budget test; planted-instruction tests on device text.

**Done when:**
- A tester who has never used a terminal goes from the landing page to an answered question in under five minutes, in Claude and in ChatGPT.
- "What's connected, and is anything off with its failsafe parameters?" is answered correctly in three calls or fewer with no screenshots.
- Each call appears in the Activity dock, and switching to Off blocks the next call.
- One account cannot read another's data by any tool or route.

## Phase 2 — Hardware in the browser *(large)*

Purpose: plug a real drone into the hosted site and have both you and your assistant see it. This is the largest piece of engineering in the plan.

Build:
- Transport interface; Web Serial and mock implementations.
- Port `AircraftService`, decoders, parameter and ESC protocols, and log transfer to a Web Worker, using the MAVLink choice from phase 0.
- State mirror from the bench tab to the cloud; bench-tab presence in `get_workspace`.
- Manual tools working on the hosted site: connection, parameters (read, reviewed single write, backup, compare), ESC read, flight logs, level calibration, motor test, Check my drone.
- ESP flashing on the browser flashing tool.
- Remaining level 0 device tools: `run_diagnostics`, `list_flight_logs`, `analyze_flight_log`.
- Clear UI for unsupported browsers and for "no bench tab open".

Order inside the phase: transport and codec → connection and telemetry → parameters → ESC read → logs → remaining tools. The existing test suites for each area are the acceptance tests for its port.

**Done when:**
- The existing aircraft test suites pass against the ported runtime with the mock transport.
- On the bench, props off: the hosted site connects to the real flight controller, reads all parameters, reads the ESCs, and downloads a log.
- The assistant answers questions about the real aircraft from mirrored state.
- With the bench tab closed, the assistant is told so and says so.
- The local Node backend is no longer needed for any shipped hardware feature.

## Phase 3 — Reviewed device changes *(large)*

Purpose: the motor-direction story works end to end, and no assistant can change hardware without your click.

Build:
- Proposal engine with both enforcement points: the cloud approve action and the bench tab's local approval check.
- Move the confirmation literals (`confirmed`, `propsRemoved`, and the rest) out of request schemas and into proposal conditions.
- `propose_change`, `await_change`, `cancel_change`, `stop_bench_run`.
- Change kinds, in order: `parameter.set` as a batch with automatic snapshot and per-parameter readback; `calibration.level`; `esc.startup_melody`; then `esc.setting`, including direction.
- **New protocol work:** writing individual ESC settings through the four-way passthrough, starting with Bluejay and BLHeli_S direction.
- UI: change cards on the affected page and in a global inbox; receipts; staleness and expiry handling.
- Level 3 hand-off: `run.motor_test`, `run.bench_show`, `firmware.flash` open the existing panel pre-filled and leave Start to you.

**Done when:**
- A test client holding only an assistant token cannot approve a proposal by any route, and a device command without a local approval is refused by the runtime. Both tests are in CI.
- On the demo aircraft: "motor 3 is backwards" leads to one change card, one click, a readback, a receipt, and a confirmed answer in the assistant.
- A proposal goes stale when the value changes underneath it, when the aircraft reconnects, and when it expires; each is tested.
- On the bench, props removed: one parameter change and one ESC direction change are completed and verified by a physical spin check. Recorded separately as bench evidence.

## Phase 4 — Cloud documents and show editing *(large)*

Purpose: an assistant's edit to a show appears in your open editor at once, from any device, and you share one undo history.

Build:
- Document store with revisions and undo; file import from the local app; export and account deletion.
- Storyboards first, then tunes, parameter snapshots, check-up reports, bookmarks.
- UI focus publishing; `get_workspace` includes page, selection, and playhead.
- Level 1 tools: `list_storyboards`, `get_storyboard`, `get_edit_schema`, `sample_show`, `edit_storyboard`, `edit_tune`, `edit_file`, `undo`, `show_in_ui`.
- UI: change marks and pulses; Follow toggle; the "review design edits first" setting.
- Repurpose the evaluation oracles as golden-task tests against the new show tools.
- Delete `harness.ts`, `openai.ts`, checkpoints, and all `OPENAI_*` handling.

**Done when:**
- With a storyboard open, "make the selected drones cyan and move this cue two seconds later" changes the open editor without a reload, as one undo step, marked as the assistant's edit.
- The same request works from a phone with no drone attached.
- An edit based on an old revision is rejected and the assistant recovers in one further call.
- Storyboards exported from the local app import intact.
- The repository contains no model-provider code.

## Phase 5 — From working to great *(medium)*

- `capture_view` for visual questions.
- Scoped grants: pre-approve a narrow class of changes for a limited period.
- Per-aircraft history built from receipts, with comparison between any two points.
- Offline use of manual tools once the site has loaded, with documents syncing on reconnect.
- Command palette and keyboard handling for cards.
- First-run onboarding with the demo aircraft; a privacy notice; a status page.
- Listing in the connector directories of Claude and ChatGPT, subject to each one's review.
- A full pass on empty, loading, error, and disconnected states for every new surface, in both themes and at phone width.

**Done when:** the six baseline tasks meet the targets in the vision document, and a public listing has been submitted to at least one assistant directory.

## Phase 6 — Reach *(open-ended)*

- A second flight stack (Betaflight over MSP) through the same registry, as the test that the design is not ArduPilot-shaped.
- AM32 ESC settings.
- A safe hosted design for mission upload and guarded launch, or a decision to keep those in a packaged desktop version.
- A packaged desktop version for Safari and Firefox users.
- Sharing an aircraft's history read-only with another account.

## Testing strategy

| Layer | What it proves | How |
| --- | --- | --- |
| Contract | Each tool's schema, output, level, and size cap | In-memory MCP client against the registry; runs in CI |
| Isolation | No account can reach another's data | Cross-account attempts on every capability; runs in CI |
| Golden tasks | A scripted assistant completes fixed tasks within a call budget | The repurposed evaluation oracles; no model involved |
| Approval | An assistant token can never approve or supply a physical condition | Negative tests at both enforcement points; runs in CI |
| Untrusted text | Instructions planted in status text, logs, and file names change nothing | Injection fixtures |
| Device runtime | The ported hardware code behaves as the Node version did | Existing aircraft suites against the mock transport |
| Performance | Latency and size budgets hold | Budget tests in CI; baseline comparison per phase |
| Real assistants | Claude and ChatGPT each complete the golden tasks | Manual run per phase, recorded with app version; never claimed from mock results |
| Bench | Device changes behave on real hardware | Props-off procedure; recorded separately from software evidence |

## Risks

| Risk | Effect | Response |
| --- | --- | --- |
| Web Serial cannot hold the link or the ESC passthrough timing | The hosted design does not work for hardware | Phase 0 spike before anything else; fallback is a small installed companion with the rest of the plan unchanged |
| Background tabs are slowed by the browser | Assistant requests to the drone stall | Measured in phase 0; a "keep this tab in front" state and a held lock if needed; level 2 does not ship until this is settled |
| Users on Safari, Firefox, or iPhone cannot use hardware tools | Part of the audience is blocked | Clear message at Connect; everything else works; packaged desktop version in phase 6 |
| Running a service: uptime, cost, support, data responsibility | Ongoing work that a local app did not have | Single small service to start; managed identity and database; minimal stored data; export and deletion from the first release |
| A flaw exposes one account's data to another | Loss of trust; aircraft data leak | Account scoping in one place, not per query; isolation tests on every capability in CI |
| Assistant apps differ in limits, rules, and plan requirements | A flow that works in one fails in another | Measured in phase 0; design to the tightest limit; both tested every phase |
| The tool list grows until models choose badly | Slower, less accurate assistants | Hard budget on tool count and definition size in CI; new behaviour goes into an existing tool's `kind` where it fits |
| Calls that wait on a human outlast an assistant's timeout | Assistant reports failure while the change proceeds | `await_change` returns "still waiting" before the limit and can be called again; the proposal carries the truth |
| Moving documents loses someone's storyboards | Lost work | Import is by file and the local copy is untouched; verified on import |
| ESC setting layouts vary by firmware and version | A wrong write to an ESC | Per-firmware layouts with version checks; refuse unknown versions; read back after every write; props-off bench verification before the kind is enabled |
| No internet at the flying field | Product unusable where drones are flown | Offline manual tools in phase 5; stated plainly until then |

## What to do first

Phase 0, starting with the Web Serial spike on the real flight controller. It is a few days of throwaway work, it needs the bench and not much else, and its result decides whether the browser can be the hardware bridge. The assistant connector check can run alongside it, since it needs only the `direction-lab` server and a temporary web address.
