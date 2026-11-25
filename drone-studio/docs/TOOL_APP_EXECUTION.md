# Armable as a tool app — execution plan

**Status: plan, November 17, 2026; revised the same day from a local-app design to a hosted one.** How to get from the current code to the product in [TOOL_APP_VISION.md](TOOL_APP_VISION.md), with the interface in [TOOL_APP_DESIGN.md](TOOL_APP_DESIGN.md) and the design in [TOOL_APP_ARCHITECTURE.md](TOOL_APP_ARCHITECTURE.md). No phase has started.

## Build status, November 17, 2026

Decisions taken: design edits apply at once with undo; Postgres for storage; simple email and password sign-in; hosted only; `direction-lab` archived.

| Area | Built | Proven against |
| --- | --- | --- |
| Device layer (`src/device`) | MAVLink codec (51 messages, cross-checked against `node-mavlink`), MSP v1/v2, ArduPilot/PX4 driver, Betaflight/INAV driver (MSP plus console), BLHeli_S, Bluejay and AM32 ESCs over the four-way interface (read, write, flash), STM32 DFU, PX4 bootloader and ESP (ExpressLRS receiver) flashing, ELRS bootloader and bind through Betaflight passthrough, Betaflight blackbox download and full decoder, VTX tables with presets, OSD element positions, Web Serial and WebUSB adapters, runtime with detection, reconnection, queued operations, readback after reboots and single-use approvals | Simulated flight controllers, ESC banks, dataflash and bootloaders that speak the real bytes; blackbox decoder cross-checked against logs encoded by an independent encoder |
| Map and tools (`src/map`, `server/tools.ts`) | Readings, tests, settings, 13 playbooks, 29 references; the eleven tools, including `read` of past changes, tests and connections | Tool tests against simulated aircraft on both stacks |
| Cloud (`server`) | Postgres and memory stores with numbered migrations, sign-in, OAuth with PKCE for assistants, stateless MCP endpoint, live WebSocket, documents, proposals, scoped grants (standing permissions), activity | Integration tests over real HTTP, MCP and WebSocket, on Postgres 16 |
| Tracking (`server/tracker.ts`) | Postgres tables `aircraft`, `aircraft_connections`, `tool_calls`, `proposal_events`, `setting_changes`, `test_runs`, `telemetry_samples`; views `tool_usage_daily`, `proposal_outcomes`; read back at `/api/data` | Tracker tests on Postgres and in memory |
| Interface (`src/web`) | Start screen, living diagram, part panels, on-the-part approval, timeline, Signals, Flights (ArduPilot and Betaflight logs), OSD editor, VTX presets, radio firmware, History, Permissions, all settings with backups, Sound, Show, offline use with sync, assistant connection and consent | Playwright end-to-end tests in Chromium (9), desktop and phone width |

Hosting: Terraform for Google Cloud in `infra/gcp` (one always-free e2-micro running the app, Postgres and Caddy, behind Cloudflare, with a spending guard and nightly backups). This is what `app.armable.ai` runs on. The server follows release tags, checking every ten minutes, so a push to `main` reaches it only once a `v*.*.*` tag is pushed.

Tests: 1,674 unit and integration tests and 9 browser end-to-end tests pass.

Deliberately not built yet: mission upload and flight, and drone-show flying. **No new driver has run on real hardware yet.** Phase 0's hardware spike is still the first thing to do with a real aircraft.

## Approach

- **Riskiest assumption first.** The hosted design depends on a browser tab talking reliably to a flight controller and its ESCs. That is tested before anything is built on it.
- **Every phase ends in something a non-technical person can use.** No phase is pure plumbing.
- **Design leads.** The diagram and its motion are prototyped before the screens are built, and each phase ships its part of the diagram, not a temporary text screen to be replaced later.
- **Read before write, hardware before shows.** The motivating example is a device setting, so the device path is built first. Show editing follows on the same foundation.
- **The old local app is archived, not deleted.** It now lives in `archive/local-workspace/` with its tests and documents; its storyboard editor, 3D stage and sound tools carry on inside the hosted app.
- **Mock aircraft first, bench second.** Every device behaviour is proven against the existing fixtures before a real aircraft, and bench results are reported separately from software results.
- **Sizes, not dates.** Phases are marked small, medium, or large relative to each other. Nothing has been measured that would justify calendar estimates.

## Phase 0 — Prove the risky parts *(small to medium)*

Purpose: find out whether the hosted design holds, before committing to it.

- **Web Serial spike.** A throwaway page in Chrome that connects to the real flight controller, receives a heartbeat, reads the full parameter list, and performs one ESC four-way passthrough read. Run it with the tab in front and in the background. Props off, battery disconnected.
- **MAVLink in the browser.** Try shimming `node-mavlink` and try a small replacement codec, each against the existing decoder tests. Choose one.
- **Assistant connector check.** Deploy the `direction-lab` MCP server to a temporary web address behind a login. Connect it from Claude and from ChatGPT. Record what each requires (plan tier, setup steps, limits on output size and call duration, how each prompts before a tool runs).
- **Diagram prototype.** A clickable Drone view on the demo aircraft: the generated drawing, the six motions, tap-a-part controls, a ghosted proposal on a motor, the timeline ribbon. Shown to a few pilots who are not software people. This is where "simple and beautiful" is judged, before it is expensive to change.
- **Tool-shape trial.** Run the same six tasks with real assistants against two mock servers: eleven id-driven tools with a map, and a longer list of specific tools. Compare accuracy and number of calls.
- **Baseline.** Record time, tool calls, and screenshots for six fixed tasks done today by an assistant driving the browser: read aircraft status; find one parameter; compare against a backup; summarise a flight log; open a storyboard; change a light cue.
- **Decisions.** Confirm the five decisions at the end of the vision document. Choose the identity provider, database, and host.

**Done when:** the spike either works or shows exactly what does not; the connector flow has been completed by hand in both assistants; the diagram prototype has been used by people outside the project and revised; the tool shape is chosen from measured results; baseline numbers are written down.

**If the spike fails:** fall back to a small installed companion that bridges USB to the cloud. The rest of the plan is unchanged; the device runtime runs in the companion instead of the tab.

## Phase 1 — Hosted skeleton and the first door *(medium)*

Purpose: a person with no technical background can sign in, connect their assistant, and ask about a demo drone.

Build:
- The cloud service: sign-in, database, live channel, deployment pipeline.
- The capability registry as a shared package.
- The remote MCP endpoint with OAuth sign-in and the three scopes.
- A synthetic demo aircraft per account, built from the existing fixtures.
- The aircraft model and the map, with readings, level 0 tests, and settings for the demo aircraft, plus the first three playbooks: motor spins the wrong way, won't arm, shakes in flight.
- Tools: `get_workspace`, `find`, `read`, `run_test` (level 0 only), `show`.
- The existing UI deployed as the hosted site, signed-in, still using browser storage for documents.
- UI: the Drone view driven by the demo aircraft, with readings on parts, the live and no-data motions, and the reading ring when the assistant looks at a part; the assistant chip with the Off / Observe switch; the timeline ribbon; the Connect an assistant page.
- Tests: contract tests through an in-memory MCP client; cross-account isolation tests; size-budget test; planted-instruction tests on device text.

**Done when:**
- A tester who has never used a terminal goes from the landing page to an answered question in under five minutes, in Claude and in ChatGPT.
- "What's connected, and is anything off with its failsafe parameters?" is answered correctly in three calls or fewer with no screenshots.
- "What can you check on this drone?" is answered from one `find` call, and it lists only what the demo aircraft supports.
- Each call appears as a dot on the timeline ribbon and a ring on the part concerned, and switching to Off blocks the next call.
- No working screen breaks the three-word, three-button rules.
- One account cannot read another's data by any tool or route.

## Phase 2 — Hardware in the browser *(large)*

Purpose: plug a real drone into the hosted site and have both you and your assistant see it. This is the largest piece of engineering in the plan.

Build:
- Transport interface; Web Serial and mock implementations.
- Port `AircraftService`, decoders, parameter and ESC protocols, and log transfer to a Web Worker, using the MAVLink choice from phase 0.
- State mirror from the bench tab to the cloud; bench-tab presence in `get_workspace`.
- Manual tools working on the hosted site: connection, parameters (read, reviewed single write, backup, compare), ESC read, flight logs, level calibration, motor test, Check my drone.
- ESP flashing on the browser flashing tool.
- The diagram generated from the real aircraft: frame, motor order and direction, attached parts; unknown parts drawn dashed.
- Map entries for the real aircraft: log readings, full diagnostics, radio channels; firmware-matched parameter documentation; the first reference library of guides and videos with timestamps, shown as cards beside the part.
- The Signals and Flights views.
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
- `propose_change`, `wait`, `stop`, and level 3 tests through `run_test`.
- Change kinds, in order: `parameter.set` as a batch with automatic snapshot and per-parameter readback; `calibration.level`; `esc.startup_melody`; then `esc.setting`, including direction.
- **New protocol work:** writing individual ESC settings through the four-way passthrough, starting with Bluejay and BLHeli_S direction.
- UI: proposals drawn on the part as a ghost of the new state with Approve beside it; a count badge for proposals off screen; the changed pulse and mark; direct manual edits on the diagram through the same path; receipts on the timeline; staleness and expiry handling.
- Level 3 hand-off: `run.motor_test`, `run.bench_show`, `firmware.flash` open the existing panel pre-filled and leave Start to you.

**Done when:**
- A test client holding only an assistant token cannot approve a proposal by any route, and a device command without a local approval is refused by the runtime. Both tests are in CI.
- On the demo aircraft: "motor 3 is backwards" leads to a ghost arrow on motor 3, one click, the arrow flipping, a readback, a receipt, and a confirmed answer in the assistant.
- Tapping the arrow by hand produces the same reviewed change with no assistant connected.
- A proposal goes stale when the value changes underneath it, when the aircraft reconnects, and when it expires; each is tested.
- On the bench, props removed: one parameter change and one ESC direction change are completed and verified by a physical spin check. Recorded separately as bench evidence.

## Phase 4 — Cloud documents and show editing *(large)*

Purpose: an assistant's edit to a show appears in your open editor at once, from any device, and you share one undo history.

Build:
- Document store with revisions and undo; file import from the local app; export and account deletion.
- Storyboards first, then tunes, parameter snapshots, check-up reports, bookmarks.
- UI focus publishing; `get_workspace` includes page, selection, and playhead.
- Level 1 tools: `edit` and `undo`; storyboards, scenes, and tunes as map entries for `find` and `read`; show sampling as a level 0 test.
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
- A wider playbook and reference library, shaped by what people actually ask.
- A motion and performance pass: 60 frames a second on an ordinary laptop, and the reduced-motion alternative for every motion.
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
| Generic id-driven tools confuse models more than specific ones | Wrong calls, extra turns | Measured against the alternative in phase 0 before committing; every `find` hit carries the exact next call; wrong ids return the nearest valid ones |
| The diagram looks beautiful but hides what experts need | Experts leave for older tools | All settings is one step from every part; tested with expert users in phase 0; a density control if testing calls for it |
| A playbook or reference gives wrong advice | A user makes a bad change on good authority | Playbooks are reviewed data with sources; references are tagged by firmware version; every change still needs approval and readback |
| Motion costs performance or distracts | A sluggish or noisy screen | Six motions only, each with a meaning; frame-rate budget in CI; reduced-motion alternative |
| Calls that wait on a human outlast an assistant's timeout | Assistant reports failure while the change proceeds | `wait` returns "still waiting" before the limit and can be called again; the proposal carries the truth |
| Moving documents loses someone's storyboards | Lost work | Import is by file and the local copy is untouched; verified on import |
| ESC setting layouts vary by firmware and version | A wrong write to an ESC | Per-firmware layouts with version checks; refuse unknown versions; read back after every write; props-off bench verification before the kind is enabled |
| No internet at the flying field | Product unusable where drones are flown | Offline manual tools in phase 5; stated plainly until then |

## What to do first

Phase 0, as two tracks side by side.

- **Can it work?** The Web Serial spike on the real flight controller. It is throwaway work that needs the bench and little else, and it decides whether the browser can be the hardware bridge.
- **Is it simple and beautiful?** The clickable Drone view on the demo aircraft. It needs no hardware and no server, and it is the fastest way to see and judge the product.

The assistant connector check and the tool-shape trial can follow once either track is under way.
