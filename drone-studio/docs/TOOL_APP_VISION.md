# Lucidity as a tool app — vision and product

**Status: plan, November 17, 2026; revised the same day from a local-app design to a hosted one.** This document sets the product direction. Nothing here is implemented unless it says so. Companion documents: [interface design](TOOL_APP_DESIGN.md), [architecture](TOOL_APP_ARCHITECTURE.md), and [execution plan](TOOL_APP_EXECUTION.md). This plan supersedes [CHATGPT_BRIDGE_PLAN.md](CHATGPT_BRIDGE_PLAN.md) and narrows the agent section of the [product brief](PRODUCT_BRIEF.md); the brief's audience, principles, and hardware boundaries still stand, except where "local service" is replaced below.

## The one-sentence version

**Lucidity is the drone workbench that your own AI assistant can operate and you can watch.** You open a website, sign in, and plug in your drone. You connect Claude or ChatGPT, on the subscription you already pay for, by pasting one link. Lucidity gives the assistant a map of everything it can read, test, and change on your aircraft, and gives you a living diagram of the drone where every change shows up as it happens.

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

1. **Simple and beautiful.** The screen is a living diagram of your drone, not pages of text. Fewer words, fewer tools, fewer steps. When a choice is between more features and a clearer product, clearer wins.
2. **The assistant knows what it can do.** Everything the aircraft offers is in one searchable map: readings, tests, settings, and references. The assistant finds the right one in a single call instead of guessing.
3. **Fast by design.** A handful of tools, compact answers, no screenshots for facts. Most requests take one to three tool calls.
4. **No model inside.** Lucidity never calls a model provider and never stores a provider key.
5. **Nothing to install.** A browser, a login, and a USB cable are the whole setup.
6. **One engine, two front doors.** Every operation is defined once. A button in the UI and a tool call from an assistant run the same code, the same checks, and leave the same record.
7. **The screen shows; the assistant tells.** Anything an assistant reads or changes is visible on the diagram as it happens. Explanations come from the assistant, not from paragraphs in the UI.
8. **Human hands on physical things.** An assistant can observe hardware and propose changes to it. Writing to a device needs your approval in the Lucidity tab that the drone is plugged into. Spinning a motor, flashing firmware, and anything in flight are started by you. The assistant's login does not carry the power to approve.
9. **Evidence over claims.** A tool that changes something returns what was read back afterwards.
10. **Complete without an assistant.** Every workflow stays usable by hand, with simple direct controls.
11. **Your data is yours.** Lucidity stores what the product needs, says what that is, and lets you export or delete it.

## Who it is for

The product brief names an expert builder as the first user. That stands for depth: the tools must satisfy someone who knows what a parameter is. What changes is the assumption about setup. **Users are not software people.** They may be expert pilots and builders who have never opened a terminal. Everything about getting started has to work for them.

## What it feels like

### Getting started

1. Open the Lucidity site in Chrome or Edge and sign in.
2. Plug in the drone and press **Connect**. The browser asks which USB device to use; you pick it.
3. On **Connect an assistant**, press the button for Claude or ChatGPT, follow the link into that app, and sign in to Lucidity when it asks.

That is the whole setup. A demo aircraft is available from the first screen for anyone without a drone to hand.

### The motivating example: a motor spins the wrong way

1. You are looking at the drone diagram. You tap motor 3, press **Test**, and see it turning the wrong way.
2. In Claude, you say: *"Motor 3 is spinning backwards. Fix it."*
3. Claude calls `get_workspace`. One call tells it which aircraft is connected, that it is disarmed, and that you have motor 3 selected.
4. Claude calls `propose_change` for the direction setting on ESC 3. Lucidity answers with the exact difference, *Normal → Reversed*, and the status *waiting for approval in Lucidity*.
5. On the diagram, motor 3 grows a second, ghosted arrow pointing the other way, with **Approve** beside it. Two ticks ask for what only you can vouch for: props removed, direct USB. You tick them and press Approve.
6. Lucidity writes the setting over USB, reads it back from the ESC, and saves a receipt. Motor 3's arrow flips and pulses once.
7. Claude's waiting call returns with the readback. It tells you the change is confirmed and suggests re-running the spin test, which you start yourself by tapping the motor.

You typed one sentence and clicked once. The assistant made three tool calls and took no screenshots.

Honest status: Lucidity can read ESC direction today but cannot write it. Building that write is part of [phase 3](TOOL_APP_EXECUTION.md).

### Three more, briefly

- **"Why did it shake on that last flight?"** The assistant searches the map for "shake" and gets back a ready-made playbook: which log readings to check, which test to run, which settings usually matter. It follows the playbook, shows you the vibration chart, and proposes two changes as one batch.
- **"How do I set up my failsafe?"** The assistant finds the reference for your firmware version and a video that covers it. The video opens as a small card beside the receiver on the diagram, at the right moment.
- **"Make the selected drones fade to cyan over the last two bars."** Lucidity knows your selection and playhead. The edit lands in the open storyboard as one undo step. This works from a phone, with no drone attached.

## What the assistant can see and do

The assistant does not get a long list of tools. It gets about ten simple actions and **one map of the aircraft** to use them on. The map has five kinds of entry, and it lists only what the connected aircraft actually supports.

| Kind | What it is | Examples |
| --- | --- | --- |
| **Reading** | A value Lucidity can read, with its unit and age | Battery voltage, roll angle, any parameter, ESC 3 direction, vibration in the last flight |
| **Test** | A procedure with a result, what it proves, and what it needs | Link check, pre-arm checks, full diagnostics, radio channels, motor spin |
| **Setting** | Something that can be changed, with its allowed values | Any parameter, ESC direction, startup melody, level trim |
| **Reference** | Help matched to your firmware version | Parameter documentation, setup guides, videos with timestamps |
| **Playbook** | A symptom and the steps to investigate it | "Motor spins the wrong way", "Shakes in flight", "Won't arm", "Drifts" |

The assistant asks the map one question, such as "motor direction" or "why won't it arm", and gets back the matching entries with exactly how to use each one. Adding support for a new sensor or firmware adds entries to the map; it does not add tools.

Playbooks are what make the assistant good at this and not merely fast. They hold the knowledge an expert would apply: check these three readings, run this test, then consider these settings. The same playbooks drive the guided checks in the UI.

References are links, titles, timestamps, and Lucidity's own short notes. Lucidity does not copy other people's videos or transcripts.

## The interface

**The drone is the interface.** Lucidity opens on a drawing of your aircraft, generated from its real configuration and alive with its real readings: motors with arrows turning in their set direction, a battery that fills, a flight controller that tilts as the real one does. You tap a part to get its few controls. The full design is in [TOOL_APP_DESIGN.md](TOOL_APP_DESIGN.md). In brief:

| Element | What it does |
| --- | --- |
| **Living diagram** | The aircraft, drawn from its own settings. Readings sit on the part they belong to. Tap a part for up to three buttons, such as **Test · Reverse · Sound** on a motor. |
| **Motion with meaning** | Six motions, one meaning each: live data, assistant reading, proposed, changed, needs you, no data. When data stops, motion stops. |
| **Proposals on the object** | A proposed change appears as a ghost of the new state on the part itself, with Approve beside it. |
| **Timeline ribbon** | A thin strip of dots along the bottom, one per action by you or an assistant. Tap a dot for before, after, and readback. It replaces a text log. |
| **Assistant chip** | Shows which assistants are connected, with one switch: *Off*, *Observe*, or *Propose*. A ring sweeps on whatever part the assistant is reading. |
| **Reference card** | A video or guide the assistant found, docked beside the part it concerns. |
| **All settings** | The complete searchable parameter table, one step from any part, for exact work. |

Three rules keep it simple: no label longer than three words, no paragraphs on a working screen, and no more than three main buttons per part. Manual editing is direct: tap the arrow to reverse the motor.

Other views follow the same rules: **Signals** (live gauges), **Flights** (each flight as charts), **Show** (the existing 3D editor), and **Sound** (the melody composer).

Hardware is reachable only while a Lucidity tab with the drone connected is open. This is the **bench tab**. If an assistant asks for something on the drone and no bench tab is open, it is told so and tells you: "Open Lucidity and plug in the drone."

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
| Calls for the assistant to find the right reading, test, or setting | 1 |
| Tools the assistant has to choose between | About 10 |
| Longest label on a working screen | 3 words |
| Taps from the diagram to any common control | 2 or fewer |
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
