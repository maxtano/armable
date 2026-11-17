# Lucidity as a tool app — vision and product

**Status: plan, November 17, 2026; revised the same day from a local-app design to a hosted one.** This document sets the product direction. Nothing here is implemented unless it says so. Companion documents: [architecture](TOOL_APP_ARCHITECTURE.md) and [execution plan](TOOL_APP_EXECUTION.md). This plan supersedes [CHATGPT_BRIDGE_PLAN.md](CHATGPT_BRIDGE_PLAN.md) and narrows the agent section of the [product brief](PRODUCT_BRIEF.md); the brief's audience, principles, and hardware boundaries still stand, except where "local service" is replaced below.

## The one-sentence version

**Lucidity is the drone workbench that your own AI assistant can operate and you can watch.** You open a website, sign in, and plug in your drone. You connect Claude or ChatGPT, on the subscription you already pay for, by pasting one link. Lucidity gives the assistant fast, exact tools and gives you a complete interface where every change it makes shows up live.

## The problem with what exists today

Lucidity had the relationship backwards. The app contained the agent: it called a model provider with an API key and paid per token. That has three costs.

1. **You pay twice.** You already have a Claude or ChatGPT subscription, and the app wants a separate metered key.
2. **The app's agent is always worse than your assistant.** Your assistant has your history, your other tools, your preferred model, and a team improving it every week. An embedded chat panel has none of that.
3. **Without the embedded agent, an assistant can only drive the app by looking at it.** Screenshot, find the button, click, wait, screenshot again. That is slow and wrong for a question like "which motor output is mapped to motor 3?"

There is a fourth problem, separate from the agent: **Lucidity today needs a terminal.** You clone a repository, install Node, and run a development server. That excludes most of the people who fly drones.

The embedded assistant was already removed from the app on October 22. This plan replaces it with a tool interface for outside assistants, and moves the whole product to a hosted site so that nobody has to install anything.

## The inversion

| | Before | After |
| --- | --- | --- |
| Who runs the model | Lucidity, with your API key | Your assistant app, on your subscription |
| What Lucidity is | A local developer app with a chat box | A website with a full interface and a tool server behind one login |
| How you start | Clone, install, run a server | Open the site and sign in |
| How the assistant connects | It could not, except by clicking | Paste a link into the assistant, sign in once |
| How the assistant works | Reads pixels, clicks controls | Calls typed tools that return exact data |
| How the drone connects | USB to a local server process | USB straight to the browser tab |
| How you verify | Trust the chat transcript | Watch the change appear in the UI, with readback |
| Model keys stored by Lucidity | A provider key | None, ever |

The assistant connection uses the Model Context Protocol (MCP). Lucidity publishes tools at a web address; the assistant decides when to call them. The drone connection uses Web Serial, the browser feature that the Betaflight web app and ESC Configurator already rely on.

## Product principles

1. **No model inside.** Lucidity never calls a model provider and never stores a provider key. If the assistant is disconnected, nothing is lost but the assistant.
2. **Nothing to install.** A browser, a login, and a USB cable are the whole setup. No terminal, no configuration file.
3. **One engine, two front doors.** Every operation is defined once. A button in the UI and a tool call from an assistant run the same code, the same checks, and leave the same record. There are no agent-only shortcuts and no UI-only capabilities, apart from the physical controls in principle 5.
4. **The UI is the shared screen.** Anything an assistant reads or changes is visible in Lucidity as it happens, attributed to that assistant, and undoable where the change is undoable.
5. **Human hands on physical things.** An assistant can observe hardware and propose changes to it. Writing to a device needs your approval in the Lucidity tab that the drone is plugged into. Spinning a motor, flashing firmware, and anything in flight are started by you, in the UI. The assistant's login does not carry the power to approve.
6. **Evidence over claims.** A tool that changes something returns what was read back afterwards. The assistant reports the readback, and you can see the same evidence in the UI.
7. **Fast by design.** A few small tools, compact answers, no screenshots for facts. Most requests should take one to three tool calls.
8. **Complete without an assistant.** Every workflow stays fully usable by hand.
9. **Your data is yours.** Lucidity stores what the product needs, says what that is, and lets you export or delete it.

## Who it is for

The product brief names an expert builder as the first user. That stands for depth: the tools must satisfy someone who knows what a parameter is. What changes is the assumption about setup. **Users are not software people.** They may be expert pilots and builders who have never opened a terminal. Everything about getting started has to work for them.

## What it feels like

### Getting started

1. Open the Lucidity site in Chrome or Edge and sign in.
2. Plug in the drone and press **Connect**. The browser asks which USB device to use; you pick it.
3. On **Connect an assistant**, press the button for Claude or ChatGPT, follow the link into that app, and sign in to Lucidity when it asks.

That is the whole setup. A demo aircraft is available from the first screen for anyone without a drone to hand.

### The motivating example: a motor spins the wrong way

1. You are on **Tools → Motors**. You run the props-off 5% test on motor 3 and see it turning the wrong way.
2. In Claude, you say: *"Motor 3 is spinning backwards. Fix it."*
3. Claude calls `get_workspace`. One call tells it which aircraft is connected, that it is disarmed, and that you are looking at motor 3 on the Motors page.
4. Claude calls `propose_change` for the direction setting on ESC 3. Lucidity answers with the exact difference, *Normal → Reversed*, and the status *waiting for approval in Lucidity*.
5. A change card appears in Lucidity on the ESC page, where you are already looking: **"Claude proposes: ESC 3 direction, Normal → Reversed."** It lists the physical conditions only you can vouch for: props removed, direct USB. You tick them and press **Approve**.
6. Lucidity writes the setting over USB, reads it back from the ESC, and saves a receipt. The ESC row updates and is marked *changed by Claude, just now*.
7. Claude's waiting call returns with the readback. It tells you the change is confirmed and suggests re-running the spin test, which you start yourself from the Motors page.

You typed one sentence and clicked once. The assistant made three tool calls and took no screenshots.

Honest status: Lucidity can read ESC direction today but cannot write it. Building that write is part of [phase 3](TOOL_APP_EXECUTION.md).

### Three more, briefly

- **"Why did it shake on that last flight?"** The assistant lists the onboard logs, asks Lucidity to analyse the newest one, and gets back the same bounded vibration and rate-error report the Flight logs page shows. It proposes two parameter changes as one reviewable batch.
- **"Make the selected drones fade to cyan over the last two bars."** Lucidity knows your selection and playhead because the UI shares them. The edit lands in the open storyboard as one undo step and the affected drones pulse in the viewport. This works from a phone, with no drone attached, because storyboards live in your account.
- **"What's different between this aircraft and my backup from last week?"** One call returns the changed parameters only, with both values.

## The interface

The existing apps stay: Home, Tools, Music, Drone Show, and Code, with the current design system. There is no chat box. Six additions make the assistant's work visible and controllable.

| Addition | What it does |
| --- | --- |
| **Assistant status** (sidebar footer, beside the connection control) | Shows which assistants are connected by name. One switch sets what they may do: *Off*, *Observe*, or *Propose* (default). Off takes effect at once. Each assistant can be disconnected for good from here. |
| **Activity** (right-hand dock, where the old chat dock sat) | A running record of everything done by you and by assistants: what was read, what changed, the before and after values, the readback, and an undo control where one applies. Filter by aircraft or project. |
| **Change cards** | A proposed device change appears on the page it affects and in a global inbox with a count badge. Each card shows the exact difference, the target aircraft, the conditions you must confirm, and Approve / Reject. Cards expire, and they go stale if the aircraft reconnects or the value changes underneath them. |
| **Change marks** | A field or object an assistant changed pulses once, then keeps a small mark with who changed it and when, until you dismiss it. |
| **Follow** (toggle) | When on, Lucidity navigates to whatever the assistant is working on. When off, you get a quiet notice with a "show me" link. The assistant can point the UI at something but can never press a control in it. |
| **Connect an assistant** (in Home) | One button per supported assistant, a connection test, and the list of tools Lucidity publishes with a plain description of each. |

Two existing ideas get promoted:

- **Receipts.** Every device change, by anyone, saves a receipt: aircraft, before, after, readback, time, who. Receipts are the start of the per-aircraft history the product brief calls for.
- **Shared focus.** The UI tells the server what you are looking at: page, aircraft, selection, playhead. That is what lets "this motor" and "this cue" mean something to the assistant.

One clear state is new with hosting: **the bench tab.** Hardware is reachable only while a Lucidity tab with the drone connected is open. If an assistant asks for something on the drone and no bench tab is open, it is told so and tells you: "Open Lucidity and plug in the drone."

## What an assistant may do

Every tool belongs to one of five levels. The level decides who may run it, and the server enforces the level.

| Level | Examples | Assistant | You |
| --- | --- | --- | --- |
| **0 · Observe** | Aircraft status, parameters, ESC settings, log analysis, storyboard contents | Runs freely | — |
| **1 · Design** | Edit a storyboard, a tune, or a workspace file | Runs freely; applied at once as one undo step | Can undo; can switch on "review design edits first" |
| **2 · Configure** | Parameter write, ESC setting, level calibration, startup melody | Proposes | Approve in the bench tab; Lucidity writes and reads back |
| **3 · Energise** | Motor test, bench show, firmware flash | Prepares the panel with the right settings | Confirm the physical conditions and press Start |
| **4 · Fly** | Arm, mission start, LAND | Watches only | Pilot only |

Stopping a bench run is open to everyone, because it only removes energy.

A later refinement, *scoped grants*, lets you pre-approve a narrow class of level 2 changes for a short period. An example is "tuning parameters on this aircraft, while it stays disarmed and connected, for the next 15 minutes."

## What changes for existing features

Hosting costs a few things. They are stated here so nobody discovers them later.

| Feature | In the hosted product |
| --- | --- |
| Hardware tools | Need desktop Chrome or Edge. Safari, Firefox, and iPhones cannot open a USB serial device. The rest of the product works in any browser. |
| Code workspace: shell commands | Removed. A website cannot and should not run commands on your computer. The file editor stays. |
| ESP firmware flashing | Kept, rebuilt on the browser version of the flashing tool. |
| DroneBridge Wi-Fi recovery | Uncertain. Browsers restrict a website's access to devices on a local network. To be tested; the fallback is written instructions. |
| Mission upload and guarded launch | Not in the first hosted release. Browsers slow down background tabs, which is the wrong foundation for supervising a flight. The existing code stays in the repository until a safe hosted design exists. |
| Use with no internet, such as at a flying field | Manual tools are planned to work offline once loaded, because the hardware code runs in the browser. Assistants need internet regardless. Offline is a later phase, not the first release. |

## What Lucidity will not do

- Hold a model provider key, or run a model.
- Publish a generic shell, file-system, URL-fetch, or raw-MAVLink tool to assistants.
- Accept `confirmed: true` from a model as proof of anything physical.
- Let an assistant arm, launch, or command an aircraft in flight.
- Upload raw flight logs or continuous telemetry without you choosing to save them.
- Let one account see another account's aircraft or documents.

## How we will know it works

| Measure | Target |
| --- | --- |
| Setup, from first visit to the first answered question | Under 5 minutes, with nothing installed and no key entered |
| Tool calls for a typical request | 3 or fewer |
| Screenshots needed for a factual question | 0 |
| Server time for a read from mirrored state | Under 50 ms at the median |
| Time from device confirmation to the change showing in the UI | Under 100 ms |
| Device changes that reach hardware without an approval in the bench tab | 0, proven by test |
| Workflows that work with no assistant connected | All of them |

The targets are goals to measure against, not results. The baseline has not been recorded yet; recording it is the first step of the execution plan.

## Decisions for you

The plan assumes the recommended option for each.

1. **Design edits: apply at once, or review first?** Recommended: apply at once with one-step undo and a visible change mark, with review as an opt-in setting. Assistant apps already ask before running a tool, so a second review inside Lucidity would make every show edit take two approvals.
2. **What is stored in the cloud?** Recommended: storyboards, tunes, parameter snapshots, receipts, and activity. Raw flight logs and live telemetry stay in the browser unless you choose to save a log to your account.
3. **How do people sign in?** Recommended: email link plus Google and Apple sign-in, through a managed identity provider. Running our own password system adds risk and no value.
4. **Is hosted the only way to run it?** Recommended: yes for the first release. The engine runs in the browser, so a packaged desktop version for Safari and Firefox users or for offline work can wrap the same code later.
5. **What happens to `direction-lab`?** Recommended: archive it once phase 1 lands. Its working MCP server is the seed for the real one.
