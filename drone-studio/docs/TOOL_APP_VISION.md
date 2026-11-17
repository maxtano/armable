# Lucidity as a tool app — vision and product

**Status: plan, November 17, 2026.** This document sets the product direction. Nothing here is implemented unless it says so. Companion documents: [architecture](TOOL_APP_ARCHITECTURE.md) and [execution plan](TOOL_APP_EXECUTION.md). This plan supersedes [CHATGPT_BRIDGE_PLAN.md](CHATGPT_BRIDGE_PLAN.md) and narrows the agent section of the [product brief](PRODUCT_BRIEF.md); the brief's audience, principles, and hardware boundaries still stand.

## The one-sentence version

**Lucidity is the drone workbench that your own AI assistant can operate and you can watch.** You bring Claude, ChatGPT/Codex, or any other assistant on the subscription you already pay for. Lucidity gives it fast, exact tools, and gives you a complete interface where every change it makes shows up live.

## The problem with what exists today

Lucidity had the relationship backwards. The app contained the agent: it called a model provider with an API key and paid per token. That has three costs.

1. **You pay twice.** You already have a Claude or ChatGPT subscription, and the app wants a separate metered key.
2. **The app's agent is always worse than your assistant.** Your assistant has your history, your other tools, your preferred model, and a team improving it every week. An embedded chat panel has none of that.
3. **Without the embedded agent, an assistant can only drive the app by looking at it.** Screenshot, find the button, click, wait, screenshot again. That is slow and wrong for a question like "which motor output is mapped to motor 3?"

The embedded assistant was already removed from the app on October 22. What is left is a strong workbench with no fast way for an outside assistant to use it. This plan fills that gap and makes it the centre of the product.

## The inversion

| | Before | After |
| --- | --- | --- |
| Who runs the model | Lucidity, with your API key | Your assistant app, on your subscription |
| What Lucidity is | An app with a chat box | A tool server with a full interface |
| How the assistant works | Reads pixels, clicks controls | Calls typed tools that return exact data |
| How you verify | Trust the chat transcript | Watch the change appear in the UI, with readback |
| Cost to Lucidity per request | Tokens | Nothing |
| Keys stored by Lucidity | A provider key | None, ever |

The connection uses the Model Context Protocol (MCP), which Claude Desktop, Claude Code, Codex, and ChatGPT all speak. Lucidity publishes tools; the assistant decides when to call them.

## Product principles

1. **No model inside.** Lucidity never calls a model provider, never stores a provider key, and never sends aircraft data anywhere on its own. If the assistant is disconnected, nothing is lost but the assistant.
2. **One engine, two front doors.** Every operation is defined once. A button in the UI and a tool call from an assistant run the same code, the same checks, and leave the same record. There are no agent-only shortcuts and no UI-only capabilities, apart from the physical controls in principle 4.
3. **The UI is the shared screen.** Anything an assistant reads or changes is visible in Lucidity as it happens, attributed to that assistant, and undoable where the change is undoable.
4. **Human hands on physical things.** An assistant can observe hardware and propose changes to it. Writing to a device needs your approval in the Lucidity window. Spinning a motor, flashing firmware, and anything in flight are started by you, in the UI. The server enforces this; a model cannot type its way past it.
5. **Evidence over claims.** A tool that changes something returns what was read back afterwards. The assistant reports the readback, and you can see the same evidence in the UI.
6. **Fast by design.** A few small tools, compact answers, no screenshots for facts. Most requests should take one to three tool calls.
7. **Complete without an assistant.** Every workflow stays fully usable by hand. The assistant is a faster way to drive the same workbench.

## Who it is for

The primary user is unchanged from the product brief: an expert builder who runs several aircraft, knows what a parameter is, and cares about exactly what changed. The new assumption is that this person already works with an AI assistant all day and wants it to operate the bench alongside them.

## What it feels like

### The motivating example: a motor spins the wrong way

1. You are on **Tools → Motors**. You run the props-off 5% test on motor 3 and see it turning the wrong way.
2. In Claude, you say: *"Motor 3 is spinning backwards. Fix it."*
3. Claude calls `get_workspace`. One call tells it which aircraft is connected, that it is disarmed, and that you are looking at motor 3 on the Motors page.
4. Claude calls `propose_change` for the direction setting on ESC 3. Lucidity answers with the exact difference, *Normal → Reversed*, and the status *waiting for approval in Lucidity*.
5. A change card appears in Lucidity on the ESC page, where you are already looking: **"Claude proposes: ESC 3 direction, Normal → Reversed."** It lists the physical conditions only you can vouch for: props removed, direct USB. You tick them and press **Approve**.
6. Lucidity writes the setting, reads it back from the ESC, and saves a receipt. The ESC row updates and is marked *changed by Claude, just now*.
7. Claude's waiting call returns with the readback. It tells you the change is confirmed and suggests re-running the spin test, which you start yourself from the Motors page.

You typed one sentence and clicked once. The assistant made three tool calls and took no screenshots.

Honest status: Lucidity can read ESC direction today but cannot write it. Building that write is part of [phase 3](TOOL_APP_EXECUTION.md).

### Three more, briefly

- **"Why did it shake on that last flight?"** The assistant lists the onboard logs, asks Lucidity to analyse the newest one, and gets back the same bounded vibration and rate-error report the Flight logs page shows. It proposes two parameter changes as one reviewable batch.
- **"Make the selected drones fade to cyan over the last two bars."** Lucidity knows your selection and playhead because the UI shares them. The edit lands in the open storyboard as one undo step and the affected drones pulse in the viewport.
- **"What's different between this aircraft and my backup from last week?"** One call returns the changed parameters only, with both values.

## The interface

The existing five apps stay: Home, Tools, Music, Drone Show, and Code, with the current design system. There is no chat box. Six additions make the assistant's work visible and controllable.

| Addition | What it does |
| --- | --- |
| **Assistant status** (sidebar footer, beside the connection control) | Shows which assistants are connected by name. One switch sets what they may do: *Off*, *Observe*, or *Propose* (default). Off is a hard stop that takes effect at once. |
| **Activity** (right-hand dock, where the old chat dock sat) | A running record of everything done by you and by assistants: what was read, what changed, the before and after values, the readback, and an undo control where one applies. Filter by aircraft or project. |
| **Change cards** | A proposed device change appears on the page it affects and in a global inbox with a count badge. Each card shows the exact difference, the target aircraft, the conditions you must confirm, and Approve / Reject. Cards expire, and they go stale if the aircraft reconnects or the value changes underneath them. |
| **Change marks** | A field or object an assistant changed pulses once, then keeps a small mark with who changed it and when, until you dismiss it. |
| **Follow** (toggle) | When on, Lucidity navigates to whatever the assistant is working on. When off, you get a quiet notice with a "show me" link. The assistant can point the UI at something but can never press a control in it. |
| **Connect an assistant** (in Home) | Copy-and-paste setup for each supported assistant, a connection test, and the list of tools Lucidity publishes with a plain description of each. |

Two existing ideas get promoted:

- **Receipts.** Every device change, by anyone, saves a receipt: aircraft, before, after, readback, time, who. Receipts are the start of the per-aircraft history the product brief calls for.
- **Shared focus.** The UI tells the server what you are looking at: page, aircraft, selection, playhead. That is what lets "this motor" and "this cue" mean something to the assistant.

## What an assistant may do

Every tool belongs to one of five levels. The level decides who may run it, and the server enforces the level.

| Level | Examples | Assistant | You |
| --- | --- | --- | --- |
| **0 · Observe** | Aircraft status, parameters, ESC settings, log analysis, storyboard contents | Runs freely | — |
| **1 · Design** | Edit a storyboard, a tune, or a workbench file | Runs freely; applied at once as one undo step | Can undo; can switch on "review design edits first" |
| **2 · Configure** | Parameter write, ESC setting, level calibration, startup melody | Proposes | Approve in Lucidity; Lucidity writes and reads back |
| **3 · Energise** | Motor test, bench show, firmware flash, mission upload | Prepares the panel with the right settings | Confirm the physical conditions and press Start |
| **4 · Fly** | Arm, mission start, LAND | Watches only | Pilot only |

Stopping a bench run is open to everyone, because it only removes energy.

A later refinement, *scoped grants*, lets you pre-approve a narrow class of level 2 changes for a short period. An example is "tuning parameters on this aircraft, while it stays disarmed and connected, for the next 15 minutes." This matches the brief's rule that repeated operations inside an authorised task should not ask about every command.

## What Lucidity will not do

- Hold a model provider key, or run a model.
- Publish a generic shell, file-system, URL-fetch, or raw-MAVLink tool to assistants.
- Accept `confirmed: true` from a model as proof of anything physical.
- Let an assistant arm, launch, or command an aircraft in flight.
- Listen on anything but the local machine by default.

## How we will know it works

| Measure | Target |
| --- | --- |
| Tool calls for a typical request | 3 or fewer |
| Screenshots needed for a factual question | 0 |
| Time from an approved change to its appearance in the UI | Under 100 ms after the device confirms |
| Server time for a read from cached state | Under 50 ms at the median |
| Setup, from a fresh install to the first answered question | Under 5 minutes, with no key entered anywhere |
| Device changes that reach hardware without a UI approval | 0, proven by test |
| Workflows that work with no assistant connected | All of them |

The targets are goals to measure against, not results. The baseline has not been recorded yet; recording it is the first step of the execution plan.

## Decisions for you

These four choices shape the build. The plan assumes the recommended option for each.

1. **Design edits: apply at once, or review first?** Recommended: apply at once with one-step undo and a visible change mark, with review as an opt-in setting. Assistant apps already ask before running a tool, so a second review inside Lucidity would make every show edit take two approvals.
2. **Which assistants first?** Recommended: Claude Desktop, Claude Code, and Codex, through one local server. All three run local tools on a subscription. ChatGPT's chat app expects a server it can reach over the internet, so it comes later and gets levels 0 and 1 only.
3. **How is it packaged?** Recommended: a small local service you start with one command, with the UI in your browser. A double-click desktop app can wrap the same service later.
4. **What happens to `direction-lab`?** Recommended: archive it once phase 1 lands. Its working MCP server is the seed for the real one.
