# Lucidity as a tool app — architecture

**Status: plan, November 17, 2026.** Design for the direction in [TOOL_APP_VISION.md](TOOL_APP_VISION.md). Sections marked *exists* describe code in the repository today; everything else is proposed. Build order is in [TOOL_APP_EXECUTION.md](TOOL_APP_EXECUTION.md).

## Where the code is today

| Area | Today | Consequence |
| --- | --- | --- |
| Backend | Two Vite plugins (`src/aircraft/middleware.ts`, `src/platform/middleware.ts`) around one `AircraftService`; about 55 `/api/aircraft/*` and `/api/workbench/*` routes | The backend only exists while `vite dev` or `vite preview` runs. Nothing else can attach to it. |
| Show state | Browser `localStorage` (`lucidity.studio.project.v1`, `lucidity.studio.storyboards.v1`); undo history in React memory | The server cannot see or edit the open storyboard. |
| Other user data | Tunes, parameter backups, check-up reports, viewer bookmarks: all `localStorage` | Same problem; also lost if browser storage is cleared. |
| Aircraft state | Server memory, in `AircraftService` | Already in the right place. |
| UI updates | `useAircraft` polls `/api/aircraft/status` every second | A change by anyone else takes up to a second to show, and only for aircraft state. |
| Edit engine | `src/core/commands.ts`: atomic, validated, revision-checked operation batches | Already the right shape for tools. |
| Agent code | `src/agent/`: a model loop (`harness.ts`), an OpenAI adapter (`openai.ts`), 15 show tools over a private draft (`tools.ts`), evaluation oracles | The tools and oracles are valuable. The loop and adapter are what this plan removes. |
| Safety checks | Route schemas require fields such as `confirmed: true` and `propsRemoved: true` | Fine for a UI checkbox. Meaningless if a model fills them in. |
| MCP | A working four-tool server against a simulated drone in `direction-lab/plugins/lucidity-lab` | Proves the route with Codex on a ChatGPT login. Not connected to the real app. |

Roughly 64,000 lines and 1,480 tests exist. The plan keeps almost all of it. The change is in where the backend lives, who owns state, and how operations are published.

## Target shape

```text
 Claude Desktop      Claude Code / Codex        ChatGPT app (later)
       │ stdio              │ local HTTP               │ tunnel, levels 0–1 only
       ▼                    ▼                          ▼
 ┌─ lucidity mcp ─┐   ┌──────────────── lucidityd (one local process) ───────────────┐
 │ thin stdio     │──▶│  MCP endpoint            UI endpoint (HTTP + event stream)   │
 │ bridge         │   │        │                          │                          │
 └────────────────┘   │        ▼                          ▼                          │
                      │  ┌──────────── capability registry ────────────┐             │
                      │  │ one definition per operation: schema, level, │             │
                      │  │ preconditions, handler                       │             │
                      │  └───────┬──────────────┬──────────────┬────────┘             │
                      │          ▼              ▼              ▼                      │
                      │   proposal engine   state store    aircraft service (exists)  │
                      │          │         (on disk)           │                      │
                      │          └────── event bus ────────────┘                      │
                      └──────────────────────┬───────────────────────────────────────┘
                                             ▼
                                   Lucidity UI in the browser
                                   (live updates; publishes your focus)
```

Six pieces carry the design.

### 1. `lucidityd`: the backend as its own process

Lift the two Vite plugins into a plain Node HTTP server. It owns the serial port, the state store, and the event bus, and it serves the built UI. In development, Vite proxies `/api` and `/mcp` to it, so hot reload keeps working. `npm run dev` starts both.

This is mostly a move. `AircraftService` and the workbench code do not depend on Vite; only the thin middleware wrappers do.

### 2. Capability registry: one engine, two front doors

Each operation is declared once:

```ts
defineCapability({
  id: 'parameters.get',
  level: 0,                              // observe
  title: 'Read parameters',
  description: 'Values the flight controller reported. Filter by name, prefix, or search text.',
  input: z.object({ aircraftId: z.string().optional(), names: z.array(paramName).max(64).optional(),
                    prefix: z.string().optional(), changedSince: z.string().optional() }),
  output: parameterListSchema,
  handler: (input, ctx) => ctx.aircraft.parameters(...),
});
```

From that single definition the registry generates:

- the MCP tool (name, description, input and output schema, read-only and destructive hints);
- the HTTP route the UI calls;
- the CLI command, replacing the hand-written `scripts/agent.ts`;
- `docs/agent-tools.json`, which becomes generated instead of hand-maintained;
- a contract test that the schema and handler agree.

`ctx` carries who is calling: `ui`, or `agent:<client name>`. The registry checks the level against the caller before the handler runs, writes the activity entry, and emits events. A handler cannot skip those steps, because they are not in the handler.

### 3. State store: the server owns the documents

Storyboards, tunes, parameter backups, check-up reports, bookmarks, receipts, and the activity journal move from `localStorage` to files in a workspace folder (default `~/Lucidity/`).

- **Format:** one JSON file per document, plus an append-only `activity.jsonl`. Plain files match the brief's requirement for portable artefacts and are easy to back up, diff, and put under Git.
- **Revisions:** every document has a monotonic revision. Every write names the revision it was based on. A stale write is rejected, and the rejection includes the current revision and a summary of what changed, so an assistant can retry in one call.
- **Undo:** per-document history lives on the server, so an assistant's edit and your edit sit in the same undo stack. This also removes the current limit that history is lost on reload.
- **Migration:** on first run, the UI offers to import what is in `localStorage`. The import copies; it never deletes the browser copy. Existing storage parsers (`src/core/storyboards.ts` and others) already validate these envelopes and are reused.

### 4. Event stream: the UI stops polling

The server pushes events to the UI over one Server-Sent Events connection: `document.changed`, `aircraft.changed`, `proposal.changed`, `activity.appended`, `agent.connected`. The UI applies them to its stores. The one-second status poll goes away. Telemetry is coalesced to about 10 updates a second so a busy link cannot flood the browser.

The UI sends one small message back: **focus**. It contains the current route, the selected aircraft, the selection, and the playhead, debounced to at most a few a second. The server keeps the latest focus with a timestamp and includes it in `get_workspace`. If several tabs are open, the most recently active one wins and the answer says so.

### 5. Proposal engine: approval that a model cannot fake

Any level 2 or level 3 operation from an assistant creates a **proposal** and stops:

```text
proposal = { id, capability, arguments, target: { aircraftId, linkGeneration },
             before: { ...values read now }, conditions: [ 'propsRemoved', 'directUsb' ],
             expiresAt, status: 'awaiting_approval' }
```

- The UI shows it as a change card. Approving sends the proposal id and the ticked conditions to an approve route.
- **The approve route is not a capability.** It is not in the registry, so it is never published as a tool. It accepts only requests carrying the UI session token, which the server issues to the page it serves and to nothing else.
- **The physical conditions are not tool arguments.** `propsRemoved` does not appear in any tool schema. Only the card can supply it.
- On approval the server re-reads the current value, refuses if it no longer matches `before` or if the aircraft has reconnected since, performs the write through the existing service method, reads back, saves a receipt, and emits events.
- The assistant waits with `await_change`, which holds the call open (up to about 50 seconds per call, repeatable) and returns the outcome. No polling loop, no wasted calls.
- Level 3 proposals differ in one way: approval does not run them. It opens the existing panel (motor test, bench show, firmware, mission) pre-filled, and you press its own Start control.

**What this does and does not protect against.** It stops a model from confirming its own request, whether by mistake or because text in a log or status message told it to. It does not stop a hostile program already running as you on your machine; such a program could drive the browser directly. Lucidity is a single-user local tool and the design says so plainly instead of claiming more.

### 6. MCP endpoint

- **Local HTTP** (`http://127.0.0.1:<port>/mcp`, the MCP streamable-HTTP transport) served by `lucidityd`, for assistants that connect to a local URL.
- **stdio bridge** (`lucidity mcp`): a tiny process that forwards to the running service and starts it if needed. This is what Claude Desktop launches.
- **Remote, later:** an outbound tunnel for ChatGPT's chat app, limited to levels 0 and 1. Off by default. What that route needs on the OpenAI side must be checked at build time; the superseded bridge plan found it may require a platform key for the tunnel itself.

Each connection gets a session: client name (from the MCP handshake), start time, and current permission mode. The Assistant status control in the UI lists sessions and can cut any of them.

## The tool surface

Tool definitions are sent to the model with every request, and models choose worse from long lists. So the surface is **small, stable, and generic where the domain allows**. The target is about 20 tools and under 3,000 tokens of definitions in total.

| Tool | Level | Purpose |
| --- | --- | --- |
| `get_workspace` | 0 | The one-call orientation: connected aircraft, link freshness, armed state, your focus, open document and revision, pending proposals, running jobs |
| `get_activity` | 0 | Recent activity and receipts, filterable |
| `show_in_ui` | 0 | Point the UI at a page, parameter, ESC, scene, or time. Navigation only. |
| `capture_view` | 0 | A rendered image of one named view, for questions that are truly visual |
| `get_aircraft` | 0 | Telemetry snapshot, status messages, pre-arm results |
| `get_parameters` | 0 | By name, prefix, or search; or the difference against a backup |
| `get_escs` | 0 | ESC identity and settings from the last read; says how old the read is |
| `run_diagnostics` | 0 | The read-only automatic part of "Check my drone" |
| `list_flight_logs`, `analyze_flight_log` | 0 | Onboard log list; bounded analysis report |
| `list_storyboards`, `get_storyboard` | 0 | Library; bounded view of a show, scene, or drone set |
| `get_edit_schema` | 0 | Operation shapes for `edit_storyboard`, fetched only when needed |
| `sample_show` | 0 | Evaluated frames, audience viewpoint, and validation findings at given times |
| `edit_storyboard` | 1 | A batch of operations against a base revision; `dryRun` returns the difference without applying |
| `edit_tune`, `edit_file` | 1 | Motor melody; workbench text file |
| `undo` | 1 | Undo the caller's own last edit on a document |
| `connect_aircraft` | 1 | Open or close a listed serial port. No command is sent to the aircraft. |
| `propose_change` | 2–3 | One tool for every device change, selected by `kind`: `parameter.set` (batch), `esc.setting`, `esc.startup_melody`, `calibration.level`, `run.motor_test`, `run.bench_show`, `firmware.flash`, `mission.upload` |
| `await_change`, `cancel_change` | 0 | Wait for, or withdraw, a proposal |
| `stop_bench_run` | — | Stop a motor test or bench show. Always allowed. |

The 15 existing show tools in `src/agent/tools.ts` fold into `get_storyboard`, `sample_show`, and `edit_storyboard`. Their inspection code is reused. Their private-draft staging is replaced by `dryRun` plus server-side undo.

Not published: shell commands, arbitrary file access outside the workbench folder, raw MAVLink, URL fetch, arm, mission start, LAND.

### Making it fast

1. **Orientation in one call.** `get_workspace` answers the five questions an assistant otherwise spends five calls on.
2. **Answers sized for a model.** Each tool has a default response of about 2 KB and a hard cap. Lists page. A `detail` argument selects `summary` or `full`. Parameter queries return only what was asked for, never all of the roughly 1,000 parameters.
3. **Typed output.** Every tool declares an output schema and returns structured content, so the assistant parses nothing.
4. **Reads from memory.** Level 0 tools answer from the server's cached state and report its age. A tool never blocks on the device unless asked for a fresh read.
5. **Errors that say what to do.** A stale revision returns the current one. A blocked operation names the unmet condition. The assistant recovers in one call.
6. **Waiting without polling.** `await_change` and long jobs such as log download hold the call open and send MCP progress notifications.
7. **Safe retries.** Writes take an idempotency key, so a retried call cannot apply twice.
8. **Guidance shipped with the server.** The MCP `instructions` field carries a short operating guide: start with `get_workspace`; never claim a device change without a readback; propose, then wait. Each assistant gets it automatically.
9. **Budgets in CI.** A test fails the build if total tool-definition size, a default response size, or the call count on a golden task grows past its limit.

## Security model

- **Loopback only.** The service binds to `127.0.0.1`. The existing Host and Origin checks (protection against DNS rebinding and cross-site requests) move with the routes.
- **Three credentials, three powers.** The UI session token can approve. An MCP session token can call tools. Neither is written into the repository or logs. The tunnel, when it exists, gets a third class limited to levels 0 and 1.
- **Device text is data.** Status messages from an aircraft, log contents, file names, and parameter-file comments can contain anything. They are returned in clearly bounded fields, never mixed into tool descriptions or guidance. Tests include injected instructions in each of these.
- **Everything is journalled.** Every tool call, proposal, approval, and device command is written to the activity journal with the caller's identity.
- **One hard stop.** Setting Assistant status to *Off* rejects every tool call from that moment and cancels open proposals.
- **Existing interlocks stay.** Fresh-heartbeat, disarmed, unsigned-link, single-writer, cooldown, and mission-gate checks in `AircraftService` are untouched and still apply to every caller. See [MISSION_LAUNCH_GATE.md](MISSION_LAUNCH_GATE.md).

## What happens to existing code

| Code | Fate |
| --- | --- |
| `src/core/**` (document model, commands, evaluator, validation) | Kept as is. Runs on the server as well as in the browser. |
| `src/aircraft/**` (service, protocols, decoders) | Kept. Middleware wrappers are replaced by registry definitions; the confirmation literals move from request schemas to proposal conditions. |
| `src/platform/**`, `src/components/**`, design system | Kept. Stores switch from `localStorage` and polling to the server and the event stream. New: Assistant status, Activity, change cards, change marks, Connect page. |
| `src/agent/tools.ts`, inspection modules (`viewpoint`, `audience-targets`, `review-moments`, `impact`, `draft-preview*`) | Inspection logic is reused behind the three show tools. Draft staging is retired. |
| `src/agent/evaluation*.ts` and oracles | Repurposed as tool-contract and golden-task tests driven by a scripted MCP client. |
| `src/agent/harness.ts`, `openai.ts`, `checkpoint*.ts`, provider types | Deleted once the show tools ship. `.env.example` and all `OPENAI_*` handling go with them. |
| `scripts/agent.ts`, `docs/agent-tools.json` | Generated from the registry. |
| `direction-lab/` | Its MCP server is the starting point for phase 1; the folder is archived afterwards. |
| Public demo (`src/demo`) | Updated to show the new flow with a scripted assistant and synthetic aircraft. |

## Open technical questions

1. **Server-side rendering for `capture_view`.** The simplest route asks the open browser tab to render and return an image. That needs a tab open. A headless renderer is heavier. Start with the open tab, and return a clear "no UI open" error otherwise.
2. **Large shows.** A 100,000-drone storyboard is tens of megabytes of JSON. Whole-file writes per edit will not hold. Start with whole files, measure, and move to patches when the measurement says so.
3. **Assistant differences.** Each assistant app has its own limits on tool output size, call duration, and how it asks the user before running a tool. These must be measured per app in phase 1, not assumed.
4. **ESC setting writes.** The four-way passthrough used for reading settings and installing a startup melody exists. Writing an individual setting such as direction needs per-firmware layouts (Bluejay, BLHeli_S, AM32) and bench verification with props off.
