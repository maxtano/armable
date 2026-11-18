# Connector listing

Materials for listing Armable in assistant connector directories. Submission is done by the project owner in each directory's own process; this file holds what they ask for. Check each directory's current requirements before submitting; they change.

## Name and one line

**Armable** — Read, test and change your drone's setup from your assistant. You approve every change.

## Description (short)

Armable connects your assistant to the drone plugged into your computer. It can read live readings and every setting, run checks, analyse flight logs and propose changes. Nothing reaches the aircraft until you approve it in Armable, and the change is read back from the aircraft before your assistant reports it.

## Description (long)

Armable is a drone workbench in the browser. Plug a Betaflight, INAV, ArduPilot or PX4 flight controller in over USB, and your assistant gets eleven tools and one searchable map of everything that aircraft offers: readings, tests, settings, guides and playbooks for common problems such as a motor spinning the wrong way or a drone that will not arm.

Your assistant can read and test freely. It can propose changes, which appear on the part they affect in Armable, with the before and after. You approve with one click, after confirming anything physical such as "props removed". Armable writes the change, reads it back from the aircraft, and only then tells your assistant it is done. Motor spins and firmware flashing are always started by you. Armable never arms or flies an aircraft.

## Server

| | |
| --- | --- |
| Address | `https://<your domain>/mcp` |
| Transport | Streamable HTTP, stateless |
| Sign-in | OAuth 2.1 with PKCE and dynamic client registration. Discovery at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` |
| Permissions | `observe` (read and run checks), `design` (edit shows, tunes and files), `propose` (propose changes to the aircraft). There is no permission to approve. |
| Privacy | `https://<your domain>/privacy.html` |

## Tools

| Tool | Read only | What it does |
| --- | --- | --- |
| `get_workspace` | yes | Where things stand: connected aircraft, what the person is looking at, pending proposals |
| `find` | yes | Search readings, tests, settings, guides, playbooks and documents |
| `read` | yes | Read up to 32 values, documents, history or proposals |
| `run_test` | no | Run a check; anything touching hardware becomes a proposal |
| `propose_change` | no | Propose new setting values; nothing is written until the person approves |
| `wait` | yes | Wait for a proposal's outcome and readback |
| `edit` | no | Create or edit a show, tune or file, as one undo step |
| `undo` | no | Undo the assistant's own last edit |
| `show` | yes | Point the person's screen at something |
| `capture_view` | yes | An image of the drone view |
| `stop` | no | Stop a motor test or withdraw a proposal |

## Test account for reviewers

Create an account on the site, then press **Try a Betaflight demo** or **ArduPilot demo** on the drone screen. The demo aircraft are simulated and respond to every tool. No hardware is needed.

## Suggested first prompts

- "Check my drone."
- "Motor 3 spins the wrong way. Fix it."
- "Why did my last flight shake?"
- "Put my receiver in bind mode."
