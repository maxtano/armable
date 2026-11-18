# Directory applications: drafts, ready to paste

Listing Armable in Anthropic's Connectors Directory and OpenAI's app directory is what makes setup one click: people find Armable inside Claude or ChatGPT and press **Connect**, with no address to paste and no Developer mode. Apply to both once the [test run](test-run.md) passes.

The same text works for both. Lengths are within Anthropic's limits.

## The listing

**Name** (≤100): Armable

**One-liner** (≤200): Your drone, beside the chat. Armable lets Claude read, test and fix your FPV drone over USB, while you watch every step and approve every change.

**Description** (≤2,000):

> Armable is a drone workbench for FPV and ArduPilot drones. Say "Start Armable" and it opens beside the chat: try the demo drone right there, or plug in your own over USB in Chrome or Edge.
>
> Claude can then read every setting and live value, run checks, analyse flight logs and propose changes. Each proposed change appears on the part of the drone it affects, and nothing is written until you approve it. Every change is read back from the drone to confirm it. Claude can never approve a change, confirm that propellers are off, or arm the drone.
>
> Try it with the demo drone: it won't arm, and finding out why takes about a minute. No drone yet? Armable helps you plan a build, with parts that fit together, prices and where to buy them.
>
> Free and open source (Apache 2.0). Works with Betaflight, ArduPilot and PX4.

**Categories** (1–5): Productivity · Developer tools · Hobbies (or the nearest the portal offers)

**Documentation URL**: https://github.com/maxtano/armable#readme

**Privacy policy URL**: https://app.armable.ai/privacy.html

**Terms**: https://app.armable.ai/terms.html

**Support contact**: *your choice*: a support address, or https://github.com/maxtano/armable/issues

**Icon**: the Armable dial, `drone-studio/public/favicon.svg`. Export a square PNG at the size the portal asks for.

**Slug** (permanent): `armable`

## Connection and authentication

- **Server URL**: `https://app.armable.ai/mcp` (streamable HTTP)
- **Users connect to**: one URL, the same for everyone
- **Authentication**: required. OAuth 2.1 with PKCE and dynamic client registration; the person signs in to Armable (or continues as a guest) and presses Allow
- **Test access for reviewers**: none needed. Allow works without an account (a guest bench), and the demo drone needs no hardware

## Tools

Every tool has a title and a read-only or destructive hint (a test checks this). The 11 the model uses: `get_workspace`, `find`, `read`, `run_test`, `propose_change`, `wait`, `edit`, `undo`, `show`, `capture_view`, `stop`. Three more belong to the panel alone and are hidden from the model: `armable_panel`, `armable_demo`, `armable_approve`.

**Reads or writes**: both. It reads drone data; it writes documents and builds; changes to a drone happen only after the person approves them in Armable.

## Use cases

1. "Start Armable": a guided first run with the demo drone.
2. "My quad won't arm. Why?": find the arming block, propose the fix, approve, done.
3. "Check my drone before I fly": battery, radio link, failsafe, motor order and direction.
4. "Help me build my first quad": a parts list that fits together, with prices.

**What people need first**: nothing for the demo; for their own drone, Chrome or Edge and a USB cable.

## Data handling

- **API**: Armable's own (first party)
- **Personal health data**: no
- **Sponsored content**: no
- **Conversation data**: Armable doesn't receive or store conversations; it keeps a log of the tool calls an assistant makes on the person's bench, which they can see in History. See the privacy page.

## Links the panel opens (allowed link URIs)

- `https://app.armable.ai`

## Carousel screenshots (PNG, ≥1000 px wide, cropped to the app)

In [`screenshots/`](screenshots), 1120 px wide, made by the panel test (`SHOTS=<folder> npm run e2e`):

| File | Prompt to pair it with |
| --- | --- |
| `1-start-armable.png` | Start Armable |
| `2-wont-arm-fix.png` | My new quad won't arm. Why? |
| `3-fixed.png` | Fix it |
| `4-your-drone.png` | Check my drone |

Retake them from Claude itself once the panel runs there, if they look different.

## Anthropic

Submit at **claude.ai/directory/manage → Submit new → MCP connector** (any paid Claude plan). Its steps: Connection, Tools, Listing, Use cases, Company, Authentication, Data handling, Test & launch, Compliance, Review. The text above covers each. New listings are published as **Community** after an automatic scan; **Verified** comes after a review, and is what lets the panel load Armable's full website and skip link warnings.

## OpenAI

OpenAI's app submission asks for much the same: the server URL, OAuth, a listing (name, description, icon, screenshots), privacy policy and terms, and test instructions. Its exact form changes often, so check its current developer documentation when you apply. Everything above applies unchanged; the panel is built on the same MCP Apps standard ChatGPT uses.
