# Full-show simulation harness

This is the harness behind the Lucidity program's **G1** gate: *a show engine
that cannot be the reason a show fails*. It exercises the show engine's
**decisions** -- slot assignment, rotation scheduling, loss handling, geofence
awareness and abort -- against simulated implementations of the program's two
arm contracts, and it produces a run report written to be read by a sceptical
human rather than by CI.

It deliberately models no flight dynamics, no aerodynamics, no radio and no
battery chemistry. Confusing those with the engine's decisions is how simulation
harnesses become unmaintainable and stop being trusted.

## Running it

```
npm test -- src/core/sim          # the per-commit matrix: 50 aircraft, one hour
npm run sim:nightly               # 200 and 1,000 aircraft
npm run sim:report                # regenerate the committed sample run report
```

The per-commit suite runs an hour-long 50-aircraft show -- about 2.9 M
drone-state updates -- in roughly 22 seconds in total. The headline test has to
stay in the inner loop: if this suite stops finishing inside two minutes, the
fix is the harness, not the aircraft count.

## What is here

| File | What it is |
| --- | --- |
| `contracts.ts` | The arm boundaries as types: the six-state enum, pad states, the four geofence zones, and the two interfaces the engine may use. |
| `fake-fleet.ts` | Contract 1, implemented against nothing. Declares a position error volume and can under-deliver against its own declaration on purpose. |
| `fake-nest.ts` | Contract 2, implemented against nothing. Books pads forward, quotes a `dock → ready` *distribution*, and refuses explicitly. |
| `nest-sizing.ts` | A port of the subset of the hub's `tools/show_sizing.py` the nest needs, pinned to the script's published figures by a test. |
| `engine.ts` | The decision layer under test. Reads the fleet only through contract 1 and the nest only through contract 2, and never sees ground truth. |
| `show-plan.ts` | Composes the hour-long show, and checks that the choreography itself is flyable and rotatable before the engine is asked to fly it. |
| `geofence.ts` | Contract 4's four zones, and the Restricted Area as a free-fall calculation. |
| `harness.ts` | Owns the clock, the injections and the measurement. The one component that sees ground truth. |
| `report.ts` | Renders the run report. |
| `trace.ts`, `spacing.ts`, `rng.ts` | The byte-stable trace, closest-pair measurement, and the seeded RNG. |
| `fixtures/sample-run-report.md` | A committed run report, checked byte for byte by `sim-report.test.ts`. |

## Determinism

Non-negotiable, because every other test depends on it:

- One seed per run, recorded in the report. Streams are **named**
  (`rng.fork('nest-latency')`), so adding a consumer cannot shift an existing
  one's numbers.
- A fixed 10 Hz timestep. No wall-clock read anywhere in the engine or the
  fakes; `sim-contracts.test.ts` enforces that by reading the source.
- Nothing depends on map or set iteration order. The matrix proves it by
  building the roster and the pad list backwards and requiring a byte-identical
  trace.
- The trace is the artifact. Every number in it is quantised to an integer
  before it is written, so nothing depends on floating-point *formatting*.

## What the harness found

Recorded here because it is the output of the gate, not a footnote.

1. `formation()` does not guarantee the project's own `minimumSeparation`. At
   scale 70, `orbit` places two aircraft 1.61 m apart at any fleet size and
   `heart` places two **2 mm** apart at 1,000. `validateProject()` catches it;
   nothing stops a composer authoring it.
2. A transition between two safe formations is not automatically safe. A stable
   array index is drone identity, so drone *i* flies A[i] → B[i] and paths cross.
3. A rotated show needs a clear vertical ingress corridor beneath every slot.
   `sphere` leaves 2 cm at 1,000 aircraft. An aircraft hovering under another
   cannot be rotated out, and no runtime cleverness fixes it.
4. `projectSchema` caps a project at 1,800 s, so an hour-long show is a sequence
   of projects.
5. The hub's sizing script treats `air_minutes` as time *on station*. It is not:
   a reserve, the outbound transit and a dock cycle of notice come out of it
   first.
6. Contract 2's advance-notice requirement and its `rotation_capacity` figure are
   only consistent if notice books a pad **forward** rather than occupying it.
7. `rotation_capacity` has to include the corridor-clear time, not just the swap.
8. Contract 2 has no provision for a **diversion**: an aircraft on short final
   whose booked pad was re-let cannot give a dock cycle of notice and does not
   need to.
9. The airframe count needs slack beyond the rotation-period arithmetic, because
   handover waits are not in it.
10. Transit altitude is the binding constraint on fleet size. Every ingress band
    costs `transitLaneSpacing` metres, and rotation demand needs one band per
    band-hold's worth of traffic; at 1,000 aircraft the stack does not fit under
    a sane ceiling, and the engine refuses to compose.
