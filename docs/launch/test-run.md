# Test run: setup and the panel, with real accounts

About 10 minutes, once. It checks the steps only Claude's and ChatGPT's own screens can show, so the instructions in Armable match them word for word. Use a fresh guest bench each time: open app.armable.ai in a private window.

For each step, note **what you clicked** and **what you saw**. A screenshot wherever something differs from what's written here.

## A. Claude in the browser (Chrome or Edge)

1. Open **app.armable.ai** in a private window. Click **Claude**.
   - Expected: a Claude window opens on the left; Armable's checklist sits on the right.
2. If Claude asks you to sign in, do.
   - Expected afterwards: Claude's **Add custom connector** box, with **Armable** and `https://app.armable.ai/mcp` filled in, and a note that the values came from a link.
   - Note: is the button **Add**, or **Continue** then **Add**? Any options marked **Detected**?
3. Click it. Then **Connect** next to Armable.
   - Expected: a small Armable window: **Let Claude use Armable?**
4. Click **Allow**.
   - Expected: the small window closes. Claude shows Armable as connected. Within a few seconds Armable's checklist turns green: **Claude is connected**.
5. Click **Open Claude**.
   - Expected: a new Claude tab, a new chat, with **Start Armable** typed in. The extra window closes.
   - Note: is the text typed in? (This is the one part not documented for the web.)
6. Press **Enter**.
   - Expected: Claude calls Armable, and **the Armable panel** opens beside the chat (or as a card in the chat): "Armable is ready".
   - Note: side panel, card, or nothing? Did Claude ask permission to show it?
7. In the panel, click **Try the demo drone**.
   - Expected: the drone appears in the panel; Claude carries on by itself ("I started the demo drone…") and finds why it won't arm.
8. When Claude suggests the fix, click **Approve** in the panel.
   - Expected: Claude reports it done, with the value read back.

## B. The Claude desktop app

1. Same account as A. In a new private window, open app.armable.ai, click **Claude**, and finish setup (or reuse A's).
2. At the end, click **Open the Claude app instead**.
   - Expected: the Claude app opens a new chat with **Start Armable** typed.
3. Press **Enter**. Note where the panel shows, if at all.

## C. ChatGPT (needs Plus or Pro)

1. Private window, app.armable.ai, click **ChatGPT**.
   - Expected: ChatGPT's settings open on the left; the address is copied.
2. Follow the checklist: **Apps & Connectors → Advanced settings → Developer mode** on, then **Create**.
   - Note: the exact menu names, and every field on the Create form.
3. Name **Armable**, paste the address, choose **OAuth**, tick the trust box, **Create**. Then **Allow** in the small Armable window.
   - Expected: Armable's checklist turns green.
4. Click **Open ChatGPT**.
   - Note: is **Start Armable** typed in, or sent straight away?
5. Send it. Note: does ChatGPT use Armable without turning it on in the chat? Does the panel show (inline, full screen)? Does **Try the demo drone** work there, and does ChatGPT carry on by itself?

## D. Coming back later

1. In a new chat (Claude or ChatGPT), type **Start Armable**.
   - Expected: the panel opens again, straight to the drone if one is connected.
2. In Armable (app.armable.ai), the light at the top reads **Claude connected** (or ChatGPT).

## What to send back

The notes for each "Note:" line, and screenshots of anything that looked different. Every instruction in Armable is then set to match.
