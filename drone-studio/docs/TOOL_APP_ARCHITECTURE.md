# Lucidity as a tool app — architecture

**Status: plan, November 17, 2026; revised the same day from a local-app design to a hosted one.** Design for the direction in [TOOL_APP_VISION.md](TOOL_APP_VISION.md). Sections marked *exists* describe code in the repository today; everything else is proposed. Build order is in [TOOL_APP_EXECUTION.md](TOOL_APP_EXECUTION.md).

## Where the code is today

| Area | Today | Consequence |
| --- | --- | --- |
| Backend | Two Vite plugins (`src/aircraft/middleware.ts`, `src/platform/middleware.ts`) around one `AircraftService`; about 55 `/api/aircraft/*` and `/api/workbench/*` routes | The backend only exists while `vite dev` runs on the user's machine. |
| Hardware code | Node: `serialport` in one file (`service.ts`), `node-mavlink` imported in 29 places, Node streams, events, and `Buffer` throughout | It cannot run in a browser as written. |
| Show state | Browser `localStorage` (`lucidity.studio.project.v1`, `lucidity.studio.storyboards.v1`); undo history in React memory | No server can see or edit the open storyboard. |
| Other user data | Tunes, parameter backups, check-up reports, viewer bookmarks: all `localStorage` | Same problem; also lost if browser storage is cleared. |
| UI updates | `useAircraft` polls `/api/aircraft/status` every second | A change by anyone else takes up to a second to show. |
| Edit engine | `src/core/commands.ts`: atomic, validated, revision-checked operation batches; pure TypeScript | Already the right shape for tools, and already runs anywhere. |
| Agent code | `src/agent/`: a model loop (`harness.ts`), an OpenAI adapter (`openai.ts`), 15 show tools over a private draft (`tools.ts`), evaluation oracles | The tools and oracles are valuable. The loop and adapter are what this plan removes. |
| Safety checks | Route schemas require fields such as `confirmed: true` and `propsRemoved: true` | Fine for a UI checkbox. Meaningless if a model fills them in. |
| Accounts | None. Single user, loopback only. | Everything about identity and isolation is new. |
| MCP | A working four-tool server against a simulated drone in `direction-lab/plugins/lucidity-lab` | Proves the idea with Codex on a ChatGPT login. Not connected to the real app. |

Roughly 64,000 lines and 1,480 tests exist. The plan keeps most of it. Three things move: the hardware code goes into the browser, documents go to a cloud store, and operations get published through one registry.

## Target shape

```text
   Claude (web, desktop, mobile)        ChatGPT
            │                              │
            └──── remote MCP over HTTPS, signed in with the user's Lucidity account ────┐
                                                                                        ▼
 ┌───────────────────────────── Lucidity cloud (one service) ─────────────────────────────┐
 │  sign-in          MCP endpoint            UI API            live channel (WebSocket)    │
 │     │                  │                    │                        │                  │
 │     ▼                  ▼                    ▼                        │                  │
 │  ┌───────────────── capability registry (shared TypeScript) ──────────────────┐         │
 │  │ one definition per operation: schema, level, where it runs, handler         │         │
 │  └───────┬──────────────────────┬──────────────────────────┬──────────────────┘         │
 │          ▼                      ▼                          ▼                             │
 │   proposal engine        document store           device relay ─────────────────────────┤
 │                     (database, per account)   (forwards to the bench tab)               │
 └─────────────────────────────────────────────────────────────┬───────────────────────────┘
                                                               ▼
 ┌─────────────────────── Lucidity in the user's browser ───────────────────────┐
 │  UI (React, exists)  ◀── live updates ──  publishes focus                     │
 │  device runtime in a worker: aircraft service, protocols, mirrored state      │
 │                         │ Web Serial                                           │
 └─────────────────────────┼────────────────────────────────────────────────────┘
                           ▼
                         Drone (USB)
```

The principle behind the layout: **the cloud owns documents and identity; the browser tab owns the hardware.** A hosted server cannot reach a USB port, and should not try. The tab that has the drone connected is called the **bench tab**.

## The pieces

### 1. Cloud service

One TypeScript service on Node. It handles sign-in sessions, serves the UI API, serves the MCP endpoint, holds a WebSocket to each open tab, and reads and writes the database. It starts as a single deployable unit; nothing about the load justifies more.

It is deliberately not a rewrite in another language. See [Language choice](#language-choice).

### 2. Capability registry: one engine, two front doors

Each operation is declared once, in a package shared by the cloud service and the browser:

```ts
defineCapability({
  id: 'parameters.get',
  level: 0,                              // observe
  runsOn: 'device',                      // 'cloud' for documents, 'device' for the bench tab
  title: 'Read parameters',
  description: 'Values the flight controller reported. Filter by name, prefix, or search text.',
  input: z.object({ aircraftId: z.string().optional(), names: z.array(paramName).max(64).optional(),
                    prefix: z.string().optional(), changedSince: z.string().optional() }),
  output: parameterListSchema,
  handler: (input, ctx) => ctx.aircraft.parameters(...),
});
```

From that single definition the registry generates the MCP tool, the route or message the UI uses, `docs/agent-tools.json`, and a contract test. `ctx` carries the account and the caller: `ui`, or `agent:<client name>`. The registry checks the level against the caller before the handler runs, writes the activity entry, and emits events. A handler cannot skip those steps, because they are not in the handler.

`runsOn` decides where the handler executes. A `cloud` capability runs in the service against the database. A `device` capability runs in the bench tab; the cloud forwards the call and returns the tab's answer.

### 3. Device runtime: the hardware code moves into the browser

`AircraftService` and the protocol code are ported to run in a Web Worker inside the tab, talking to the drone through Web Serial.

- **Transport:** the single `serialport` use becomes a small transport interface with two implementations: Web Serial for the product, and the existing mock for tests. Tests keep running in Node against the mock.
- **MAVLink:** `node-mavlink` depends on Node streams and `Buffer`. Phase 0 decides between shimming those in the browser and replacing the library with a small codec for the message set Lucidity uses. The existing decoder tests define what "working" means either way.
- **Why a worker:** serial reads and protocol timing must not stall when the UI is busy rendering a 3D stage.
- **Mirrored state:** the runtime sends a compact snapshot to the cloud whenever it changes: aircraft identity, link freshness, armed state, the parameter cache, the last ESC read, running jobs. Level 0 device tools are answered from this mirror, with its age, so a read does not wait on a round trip to the tab.
- **What stays in the tab:** continuous telemetry and raw flight-log bytes. Log analysis runs in the tab; only the bounded report travels. A raw log reaches the cloud only if the user saves it.
- **ESP flashing** moves to the browser build of the flashing tool. **Shell commands** have no hosted equivalent and are removed.

The interlocks in `AircraftService` (fresh heartbeat, disarmed, unsigned link, single writer, cooldowns) move with it and still apply to every caller.

### 4. Document store

Storyboards, tunes, parameter snapshots, check-up reports, bookmarks, receipts, and the activity journal move from `localStorage` to a database, each row owned by an account.

- **Revisions:** every document has a monotonic revision. Every write names the revision it was based on. A stale write is rejected, and the rejection includes the current revision and a summary of what changed, so an assistant can retry in one call.
- **Undo:** per-document history lives in the store, so an assistant's edit and your edit sit in one undo stack, and history survives a reload.
- **Import:** data from the current local app lives under a different web address, and browsers do not share storage across addresses. Import is therefore by file: the local app exports, the hosted app imports. Existing parsers (`src/core/storyboards.ts`, `src/core/export.ts`) validate the files.
- **Export and deletion:** every document can be downloaded as a plain file, and an account can be deleted with its data.

### 5. Live channel

One WebSocket per tab carries events down (`document.changed`, `aircraft.changed`, `proposal.changed`, `activity.appended`, `agent.connected`), and device calls and focus up. The one-second status poll goes away.

**Focus** is the small message the UI sends about what you are looking at: route, selected aircraft, selection, playhead, debounced. The service keeps the latest per account and includes it in `get_workspace`. With several tabs open, the most recently active one wins and the answer says so.

### 6. Proposal engine: approval that a model cannot give

Any level 2 or level 3 operation from an assistant creates a **proposal** and stops:

```text
proposal = { id, capability, arguments, target: { aircraftId, linkGeneration },
             before: { ...values read now }, conditions: [ 'propsRemoved', 'directUsb' ],
             expiresAt, status: 'awaiting_approval' }
```

Approval is enforced in two independent places.

1. **In the cloud.** The approve action is not a capability, so it is never published as a tool. It accepts only a signed-in browser session. An assistant's access token is a different kind of credential and is refused.
2. **In the bench tab.** The device runtime will not execute a level 2 or 3 command unless it carries an approval produced by a click in that same tab. Even a request that somehow passed the cloud check would stop here.

Further rules:

- **Physical conditions are not tool arguments.** `propsRemoved` appears in no tool schema. Only the card can supply it, and only the person at the bench tab can tick it.
- On approval, the runtime re-reads the current value, refuses if it no longer matches `before` or if the aircraft has reconnected, writes, reads back, and reports. The cloud saves a receipt.
- The assistant waits with `await_change`, which holds the call open (about 50 seconds per call, repeatable) and returns the outcome.
- Level 3 proposals are not run by approval. Approval opens the existing panel (motor test, bench show, firmware) pre-filled, and you press its own Start control.

This is a stronger boundary than the earlier local design had. There, any program on your computer could have imitated the UI. Here, the assistant holds a token that cannot approve, and the hardware sits behind a tab the assistant cannot reach.

### 7. Sign-in and the MCP endpoint

- **People** sign in through a managed identity provider (email link, Google, Apple). Lucidity stores no passwords.
- **Assistants** connect to one HTTPS address using the MCP streamable-HTTP transport. The first connection sends the user through a standard OAuth sign-in and consent screen ("Allow Claude to use Lucidity: observe, edit designs, propose device changes"). The assistant receives a token for that account with those scopes.
- **Scopes** map to levels: `observe`, `design`, `propose`. There is no scope for approving, energising, or flying.
- **Revocation:** Assistant status in the UI lists each connected assistant and can disconnect it, which revokes its token.

What each assistant app requires for a custom connector (plan tier, registration method, review for a public listing) must be checked against current documentation in phase 0. It is not assumed here.

## The tool surface

Tool definitions are sent to the model with every request, and models choose worse from long lists. So the surface is **small, stable, and generic where the domain allows**. The target is about 20 tools and under 3,000 tokens of definitions in total.

| Tool | Level | Runs on | Purpose |
| --- | --- | --- | --- |
| `get_workspace` | 0 | cloud | The one-call orientation: whether a bench tab is open, connected aircraft, link freshness, armed state, your focus, open document and revision, pending proposals, running jobs |
| `get_activity` | 0 | cloud | Recent activity and receipts, filterable |
| `show_in_ui` | 0 | cloud | Point the UI at a page, parameter, ESC, scene, or time. Navigation only. |
| `capture_view` | 0 | tab | A rendered image of one named view, for questions that are truly visual |
| `get_aircraft` | 0 | mirror | Telemetry snapshot, status messages, pre-arm results |
| `get_parameters` | 0 | mirror | By name, prefix, or search; or the difference against a snapshot |
| `get_escs` | 0 | mirror | ESC identity and settings from the last read; says how old the read is |
| `run_diagnostics` | 0 | device | The read-only automatic part of "Check my drone" |
| `list_flight_logs`, `analyze_flight_log` | 0 | device | Onboard log list; bounded analysis report |
| `list_storyboards`, `get_storyboard` | 0 | cloud | Library; bounded view of a show, scene, or drone set |
| `get_edit_schema` | 0 | cloud | Operation shapes for `edit_storyboard`, fetched only when needed |
| `sample_show` | 0 | cloud | Evaluated frames, audience viewpoint, and validation findings at given times |
| `edit_storyboard` | 1 | cloud | A batch of operations against a base revision; `dryRun` returns the difference without applying |
| `edit_tune`, `edit_file` | 1 | cloud | Motor melody; workspace text file |
| `undo` | 1 | cloud | Undo the caller's own last edit on a document |
| `propose_change` | 2–3 | device | One tool for every device change, selected by `kind`: `parameter.set` (batch), `esc.setting`, `esc.startup_melody`, `calibration.level`, `run.motor_test`, `run.bench_show`, `firmware.flash` |
| `await_change`, `cancel_change` | 0 | cloud | Wait for, or withdraw, a proposal |
| `stop_bench_run` | — | device | Stop a motor test or bench show. Always allowed. |

"Mirror" means the cloud answers from the state the bench tab last sent, and reports its age. Connecting to the drone is not a tool: the browser requires a person to pick the USB device.

The 15 existing show tools in `src/agent/tools.ts` fold into `get_storyboard`, `sample_show`, and `edit_storyboard`. Their inspection code is reused, and it runs in the cloud because `src/core` is pure TypeScript. Their private-draft staging is replaced by `dryRun` plus undo.

Not published: shell commands, arbitrary file access, raw MAVLink, URL fetch, arm, mission start, LAND.

### Making it fast

1. **Orientation in one call.** `get_workspace` answers the questions an assistant otherwise spends five calls on.
2. **Answers sized for a model.** Each tool has a default response of about 2 KB and a hard cap. Lists page. A `detail` argument selects `summary` or `full`. Parameter queries return only what was asked for, never all of the roughly 1,000 parameters.
3. **Typed output.** Every tool declares an output schema and returns structured content, so the assistant parses nothing.
4. **Reads from the mirror.** Device reads are answered in the cloud from mirrored state. Only a fresh read or a write travels to the tab.
5. **Errors that say what to do.** A stale revision returns the current one. A blocked operation names the unmet condition. "No bench tab open" says exactly that. The assistant recovers in one call.
6. **Waiting without polling.** `await_change` and long jobs such as log download hold the call open and send MCP progress notifications.
7. **Safe retries.** Writes take an idempotency key, so a retried call cannot apply twice.
8. **Guidance shipped with the server.** The MCP `instructions` field carries a short operating guide: start with `get_workspace`; never claim a device change without a readback; propose, then wait.
9. **Budgets in CI.** A test fails the build if total tool-definition size, a default response size, or the call count on a golden task grows past its limit.

Where the time actually goes: a model turn takes seconds; a device write takes tens to hundreds of milliseconds on the wire; the network hop between assistant, cloud, and tab adds tens of milliseconds; the service's own work is a few milliseconds. Speed is won by needing fewer model turns, which is what items 1 to 5 do.

## Language choice

**Stay with TypeScript for everything. Do not rewrite in Go or another compiled language.**

- **The engine must run in two places.** Show evaluation, command validation, and the hardware protocols run in the browser, and the same show code runs in the cloud. Browsers run TypeScript (as JavaScript). A Go server would mean maintaining a second copy of that logic and keeping the two in agreement.
- **The server is not the bottleneck.** See "Where the time actually goes" above. A faster language would shave a few milliseconds from a request dominated by model time and device time.
- **The existing code is an asset.** About 64,000 lines and 1,480 tests are TypeScript. Rewriting them is months of work that produces no new capability and risks new bugs in safety-relevant code.
- **The MCP reference SDK is TypeScript.** New protocol features land there first.

If a measured hot spot appears, the remedy is local: move that one computation to a worker or to WebAssembly. The likely candidate is evaluating very large shows, and it can be handled without changing the language of the service.

## Security model

Hosting turns a single-user local tool into an internet service. These are the rules.

- **Account isolation.** Every database query and every live-channel message is scoped to the signed-in account. Tests attempt cross-account reads and writes for every capability.
- **Three credentials, three powers.** A browser session can do everything a person can. An assistant token can observe, design, and propose. The bench tab's local approval is required for anything that writes to hardware.
- **Device text is data.** Status messages from an aircraft, log contents, file names, and parameter-file comments can contain anything. They are returned in clearly bounded fields, never mixed into tool descriptions or guidance. Tests plant instructions in each.
- **Everything is journalled.** Every tool call, proposal, approval, and device command is recorded with the caller's identity.
- **One hard stop.** Setting Assistant status to *Off* rejects every tool call for that account from that moment and cancels open proposals.
- **Standard service hygiene.** HTTPS only, rate limits per account and per token, short-lived access tokens, strict content-security policy on the site, dependency and secret scanning in CI.
- **Data minimisation.** Stored: documents, parameter snapshots, receipts, activity. Not stored unless the user saves them: raw flight logs, continuous telemetry. A privacy notice states this.

## What happens to existing code

| Code | Fate |
| --- | --- |
| `src/core/**` (document model, commands, evaluator, validation) | Kept as is. Runs in the browser and in the cloud. |
| `src/aircraft/**` (service, protocols, decoders) | Ported to the browser worker behind a transport interface. Middleware wrappers are replaced by registry definitions; the confirmation literals move from request schemas to proposal conditions. Tests keep running in Node against the mock transport. |
| Mission and flight code (`mission-*`, `flight-*`, launch gate) | Kept in the repository, not shipped in the first hosted release. |
| `src/platform/**`, `src/components/**`, design system | Kept. Stores switch from `localStorage` and polling to the cloud and the live channel. New: sign-in, Assistant status, Activity, change cards, change marks, Connect page. |
| `src/platform/workbench-service.ts` (shell runner, local files) | Shell runner removed. Files become account documents. ESP flashing moves to the browser tool. |
| `src/agent/tools.ts`, inspection modules (`viewpoint`, `audience-targets`, `review-moments`, `impact`, `draft-preview*`) | Inspection logic is reused behind the three show tools. Draft staging is retired. |
| `src/agent/evaluation*.ts` and oracles | Repurposed as tool-contract and golden-task tests driven by a scripted MCP client. |
| `src/agent/harness.ts`, `openai.ts`, `checkpoint*.ts`, provider types | Deleted once the show tools ship. `.env.example` and all `OPENAI_*` handling go with them. |
| `scripts/agent.ts`, `docs/agent-tools.json` | Generated from the registry. |
| `direction-lab/` | Its MCP server is the starting point for phase 1; the folder is archived afterwards. |
| Public demo (`src/demo`) | Becomes the signed-out landing experience, with a scripted assistant and a synthetic aircraft. |

## Open technical questions

1. **Web Serial against real hardware.** Does a browser tab hold a reliable link to the flight controller, and does the ESC four-way passthrough work through it, with the timing those protocols need? This is the largest technical risk and is tested first, in phase 0.
2. **MAVLink in the browser.** Shim `node-mavlink`'s Node dependencies or replace it with a small codec. Decided in phase 0 by trying both on the existing decoder tests.
3. **Background tabs.** Browsers slow timers in tabs that are not visible. Does a bench tab in the background keep a healthy link and answer assistant requests promptly? If not, the runtime needs a strategy (a held lock, a visible "keep this tab in front" state) before level 2 work ships.
4. **Rendering for `capture_view`.** The simplest route asks the open tab to render and return an image. Start there and return a clear "no tab open" error otherwise.
5. **Large shows.** A 100,000-drone storyboard is tens of megabytes of JSON. Whole-document writes per edit will not hold. Start with whole documents, measure, and move to patches when the measurement says so.
6. **Assistant differences.** Each assistant app has its own limits on tool output size and call duration, and its own rules for custom connectors. Measured per app in phase 0.
7. **ESC setting writes.** Writing an individual setting such as direction needs per-firmware layouts (Bluejay, BLHeli_S, AM32) and bench verification with props off.
8. **Local-network devices.** Whether the DroneBridge Wi-Fi recovery flow can work from a hosted page under current browser rules.
