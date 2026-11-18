# Armable as a tool app — interface design

**Status: plan, November 17, 2026.** The look and behaviour of the product in [TOOL_APP_VISION.md](TOOL_APP_VISION.md). None of it is built. Colours, type, and controls continue to come from the existing [design system](DESIGN_SYSTEM.md); this document changes layout and interaction, not the palette.

## The idea

**The drone is the interface.** Armable opens on a drawing of your aircraft, made from its real configuration and alive with its real readings. You see its state instead of reading about it. You touch a part to change it. The assistant does the talking; the screen does the showing.

## Five rules

1. **Show, don't describe.** A state is drawn: an arrow for direction, a fill for charge, a colour for health. Not a sentence.
2. **Motion means something.** There are six motions, each with one meaning. Nothing moves for decoration.
3. **Three words or fewer.** No label is longer. No paragraphs on a working screen. Explanations sit behind a "?" or come from the assistant.
4. **One tap to the control.** Touching a part opens its controls. Each part offers at most three main buttons.
5. **Nothing hidden from experts.** The complete settings table is one step away from every part.

## The Drone view

```text
        ↻ M3                 M1 ↺
           ╲                 ╱
            ╲    ┌──────┐   ╱
   GPS ◉──────── │  FC  │ ────────◍ Receiver
            ╱    └──────┘   ╲
           ╱         │       ╲
        ↺ M2         │        M4 ↻
                 ▮▮▮▯  15.8 V
```

The sketch shows the arrangement only. The real drawing is generated from the aircraft: frame class and type give the motor positions, numbers, and spin directions; port settings give the attached parts. A part Armable cannot identify is drawn dashed and labelled unknown. Nothing is invented.

| Part | Shows | Tap for |
| --- | --- | --- |
| Motor | Spin direction as a turning arrow, output number, temperature if reported | **Test · Reverse · Sound** |
| Battery | Charge as a fill, voltage, cell count | Calibrate |
| Flight controller | Tilts with the real attitude; armed state; firmware | **Level · All settings** |
| Receiver | Signal bars; stick and switch positions as small live bars | Modes |
| GPS | Satellite count; a ring that closes as the fix improves | — |
| Link to the computer | A line that carries a moving pulse while data arrives | Reconnect |

Readings sit on the part they belong to, as a number with a unit. Health is a colour plus an icon, never colour alone.

## Motion vocabulary

| Meaning | What you see |
| --- | --- |
| **Live** | A soft pulse travels along each connection while fresh data arrives. Motor arrows turn slowly in their configured direction. |
| **Assistant is reading** | One ring sweeps around the part being read. |
| **Proposed** | A ghost of the new state appears beside the current one, such as a second arrow pointing the other way, with **Approve** on the part itself. |
| **Changed** | The part pulses once, then keeps a small dot until you dismiss it. |
| **Needs you** | A steady amber outline. It does not flash. |
| **No data** | The part loses its colour and stops moving. |

Stillness is honest: when data stops, motion stops. Movements last 150 to 300 milliseconds and ease in and out. The system setting for reduced motion replaces each one with a static mark. The drawing must hold 60 frames a second on an ordinary laptop.

## Editing by hand

- **Touch the thing.** Tap a motor's arrow to reverse it. Drag a slider or press a stepper for a number. Flip a toggle.
- **Same path as the assistant.** A manual edit to hardware shows the same before-and-after ghost, asks for the same physical confirmations, writes, and reads back. The part shows a tick only when the readback matches.
- **One undo.** Document edits undo with one press. Hardware changes offer "change back", which is a new reviewed change.

## The assistant on screen

- **Presence.** A small chip with the assistant's name sits by the connection control. While it works, the chip's ring sweeps on the part it is reading, so you can see where its attention is.
- **Proposals live on the object.** Motor 3 shows its own ghost arrow and its own Approve button. A count badge leads to any proposal that is off screen.
- **Timeline ribbon.** A thin strip along the bottom replaces a text log. Each action is a dot with an icon: read, test, change. Hover or tap a dot for the before, after, and readback. Drag back along it to see the aircraft as it was.
- **Reference card.** When the assistant finds a relevant video or guide, it opens as a small card docked beside the part it is about, starting at the right moment in the video.
- **Follow.** With Follow on, the view glides to whatever the assistant is working on.

## The other views

Each view follows the same five rules.

| View | What it is |
| --- | --- |
| **Drone** | The living diagram. The home screen once an aircraft is connected. |
| **Signals** | Live gauges and scrolling traces for attitude, power, and radio. |
| **Flights** | Each recorded flight as a strip of charts with marked events, not a report. |
| **Show** | The existing 3D storyboard editor. |
| **Sound** | The existing melody composer. |
| **All settings** | The full searchable parameter table, for exact work. |

## What happens to today's screens

Tools today is a searchable catalogue of 18 areas, each described in text with feature lists. Those areas become parts of the drawing and entries in search. The parameter table stays as All settings. The guided check stays, redrawn as the diagram lighting up part by part as each check passes.

## Build notes

- **SVG for the diagram:** sharp at any size, each part a real element that can take focus and be animated. The 3D stage stays on WebGL.
- **Data-driven:** one aircraft model feeds the drawing, the assistant's tools, and the tests, so they cannot disagree.
- **Accessible:** every part is reachable by keyboard and carries a full spoken label for screen readers. The three-word rule limits what is shown, not what is available to assistive technology.
- **Phone:** the diagram fills the screen; a tapped part opens its controls as a bottom sheet.

## Open design questions

1. **How much aircraft variety can one generated drawing cover?** Start with four-motor frames, which is what the current hardware support covers, and design the layout rules so six and eight motors follow.
2. **How to draw wiring truthfully.** Armable knows port assignments from parameters but not physical wire routes. The drawing should show logical connections and say so.
3. **Density for experts.** Some will want more numbers on screen than the default shows. A density control is likely needed; test with real users before adding it.
