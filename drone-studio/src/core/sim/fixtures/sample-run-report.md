# Full-show simulation: hour-long show, 50 drones on station, clean fleet and nest

**Verdict: PASS.** No safety invariant was broken and no aircraft was lost.

Engine `1.0.0` · seed `armable-g1-sample-0001` · report format `armable-show-sim-report/1`.

- No separation, reserve or containment breach, no contract violation, and no aircraft lost. Formation slots were 83.7% occupied on average across 36000 ticks, the rest being slot handover.

This run is reproducible from the seed and inputs below and from nothing else: the engine and the simulated fleet and nest contain no wall-clock reads, no unseeded randomness, and no dependence on map or set iteration order. The trace reference at the end is the evidence.

## What this simulates, and what it does not

The harness tests the **show engine's decisions** against the two arm contracts: a fleet that declares a position error volume, reports one of six states and reports energy in usable airborne seconds; and a nest that quotes a rotation capacity and a dock-to-ready latency, and that can refuse. It models no flight dynamics, no aerodynamics, no radio and no battery chemistry. Those are out of scope by design, and conflating the two is how simulation harnesses stop being trusted.

## Inputs

| Input | Value |
| --- | --- |
| Show | Hour show, 3600.0 s, 120 BPM |
| Aircraft on station | 50 |
| Projects / cues | 2 / 88 (the engine caps one project at 1800 s, so an hour is a sequence of them) |
| Choreography envelope | 99.73 m–142.37 m altitude, 49.50 m radius, peak commanded speed 4.00 m/s |
| Roster | 81 airframes |
| Declared position error volume | 0.40 m radius |
| Pack endurance / declared reserve | 778.0 s / 156.0 s usable airborne |
| Declared max_simultaneous_loss | 3 |
| Nest | 7 pads across 5 modules, 65-slot magazine per module |
| Rotation capacity | 1.71/min per module, 8.57/min across the nest |
| Dock → ready | 45.0 s median, log-normal σ 0.18 — a distribution, not a constant |
| Advance notice required | 45.0 s |
| Nest sizing source | tools/show_sizing.py --airborne 50: 7 pads, 5 modules, 65-slot magazine per module, 63 airframes at a 6-minute pack |

Input digests, so a reader can tell whether two reports describe the same run: show `7de2cbda94a002972994be18cd123de4`, fleet `c0883d28667ec1838c659ed4e257ce38`, nest `0c16cba429ecfb789791cfd8992359f5`, geofence `7c873549a9a6dc054bf4a5e29352c3a2`, engine `8ed8507b74f0c31c86cf15383079c8ba`.

## Composability check, before the first tick

| Quantity | Value |
| --- | --- |
| Rotation demand | 6.00 drones/min |
| Nest capacity | 8.57 drones/min |
| Utilisation | 70.0% |
| Transit capacity | 15.50 drones/min |
| On-station seconds per pack | 500.2 s |
| Outbound transit | 51.8 s |
| Roster required / available | 68 / 81 |
| Transit band stack reaches | 67.50 m |

## Separation

The engine's commanded gap is 3.30 m: choreography minimum 2 m + 2 x body radius 0.25 m + 2 x declared error volume 0.4 m. If the fleet delivers its declaration, true centre-to-centre separation cannot fall below 2.5 m.

| Measure | Value |
| --- | --- |
| Minimum separation achieved (ground truth) | **2.79 m** between aircraft 37 and 45 at tick 11360 (1136.0 s) |
| Margin against the guaranteed floor | **+0.29 m** against 2.50 m |
| Against the commanded gap | -0.51 m — negative is expected: aircraft spend their declared error volume, which is what it is for |
| As the engine saw it, from telemetry | 2.79 m |
| Physical contact threshold | 0.50 m |
| Breaches between aircraft under command | **0** — this is the engine's spacing guarantee |
| Forced-descent conflicts | 0 — an aircraft that was faulted, silent or landing on its reserve came inside the floor. The engine cannot command an aircraft that is not taking instructions, so these are counted apart from the figure above rather than scored as the same thing |
| Sampling | 36000 samples, every 1 tick(s) (0.1 s), closest-pair probe 9.90 m |
| Samples with no pair inside the probe | 1 — these contribute no minimum |

## Energy reserve

| Measure | Value |
| --- | --- |
| Declared reserve | 156.0 s |
| Lowest margin above it, by any aircraft | **4.1 s** by aircraft 50 at tick 13069 (1306.9 s) |
| Breaches by an aircraft under command | **0** |
| Samples with an uncommandable aircraft below reserve | 0 — contract 1's promise is that the engine will never *command* an aircraft below its reserve. One that has stopped taking commands flies until its pack is flat, which is a different fact and is counted separately |

The engine may command no aircraft below its declared reserve. When a hold -- for a pad, a transit band or a blocked column -- would take an aircraft past the point where it can still reach the ground and keep that reserve, it lands where it is. That is a dropout, counted below.

## Zone containment

Contract 4's four zones. A soft-fence violation triggers return or autoland; a **hard-fence violation stops the motors**, which is why the Restricted Area is a free-fall calculation and not a navigational boundary.

| Zone | Radius | Closest approach (horizontal) | Ceiling margin | On violation |
| --- | --- | --- | --- | --- |
| flight-area | 160.00 m | 86.47 m (aircraft 10, tick 8331) | 57.24 m | composition error: the choreography was authored outside its own envelope |
| soft-fence | 180.00 m | 106.47 m (aircraft 10, tick 8331) | 77.24 m | return to home or autoland |
| hard-fence | 200.00 m | 126.47 m (aircraft 10, tick 8331) | 97.24 m | motors stop |
| restricted-area | 272.75 m | 199.22 m (aircraft 10, tick 8331) | 97.24 m | ground footprint kept clear of non-participating people; containment is ballistic once motors stop |

| Restricted Area width | Value |
| --- | --- |
| Implied by show altitude | 142.37 m |
| Waiver rule, +10 m per 100 ft | 46.71 m |
| Ballistic: horizontal throw after motors stop | 72.75 m (free fall 5.4 s, with the safety factor applied) |
| Binding figure | **72.75 m** — ballistic |
| Breaches | 0 |

## Dropouts

**19** contingency landings, 0.034 per completed rotation, against a budget of 56 for this run. Contract 4 makes this a reported figure rather than something to grep an incident log for: failsafe return-to-home and land-now events go to the FAA quarterly.

| Tick | Show time | Aircraft | Why |
| --- | --- | --- | --- |
| 5741 | 574.1 s | 42 | held 60 s in phase cruise-in without the band, pad or column it needed |
| 6021 | 602.1 s | 49 | reserve floor reached in phase cruise-in: 20 s above reserve against a 20 s descent from 64 m |
| 6605 | 660.5 s | 52 | held 60 s in phase cruise-in without the band, pad or column it needed |
| 6891 | 689.1 s | 56 | held 60 s in phase cruise-in without the band, pad or column it needed |
| 7659 | 765.9 s | 61 | held 60 s in phase cruise-in without the band, pad or column it needed |
| 8069 | 806.9 s | 8 | held 60 s in phase cruise-in without the band, pad or column it needed |
| 8143 | 814.3 s | 9 | held 60 s in phase cruise-in without the band, pad or column it needed |
| 8232 | 823.2 s | 10 | held 60 s in phase cruise-in without the band, pad or column it needed |
| 10116 | 1011.6 s | 26 | held 60 s in phase cruise-in without the band, pad or column it needed |
| 10122 | 1012.2 s | 27 | held 60 s in phase cruise-in without the band, pad or column it needed |
| 10429 | 1042.9 s | 64 | held 60 s in phase cruise-in without the band, pad or column it needed |
| 11295 | 1129.5 s | 65 | held 60 s in phase cruise-in without the band, pad or column it needed |
| 11496 | 1149.6 s | 36 | held 60 s in phase cruise-in without the band, pad or column it needed |
| 11703 | 1170.3 s | 43 | held 60 s in phase cruise-in without the band, pad or column it needed |
| 11794 | 1179.4 s | 38 | held 60 s in phase cruise-in without the band, pad or column it needed |
| 12954 | 1295.4 s | 50 | reserve floor reached in phase cruise-in: 16 s above reserve against a 16 s descent from 47 m |
| 21241 | 2124.1 s | 28 | held 60 s in phase cruise-in without the band, pad or column it needed |
| 26862 | 2686.2 s | 75 | reserve floor reached in phase cruise-in: 16 s above reserve against a 16 s descent from 47 m |
| 26914 | 2691.4 s | 76 | reserve floor reached in phase cruise-in: 16 s above reserve against a 17 s descent from 50 m |

## Slot handover

An hour-long show outlives any pack, so every formation slot is handed over repeatedly: the engine launches a relief early, parks it beside the slot, releases the holder, and lifts the relief in. Two aircraft cannot occupy one slot, so a rotated show is never gapless. This is a fidelity cost, not a safety one, and it is measured rather than hidden.

| Measure | Value |
| --- | --- |
| Formation slots | 50 |
| Mean slots occupied | **83.7%** |
| Mean slots in handover | 8.17 |
| Peak unfilled | 50 (the mass launch, at tick 0) |
| Reliefs launched ahead of a departure | 119 |
| Slot-ticks with no airframe available | 157604 — every one of these is a slot the roster could not cover |

## Rotation record

| Measure | Value |
| --- | --- |
| Demand / capacity | 6.00 / 8.57 per minute |
| Utilisation | 70.0% |
| Docks requested / accepted / refused | 778 / 553 / 433 |
| Refusals by reason | no-free-pad: 12, no-charged-pack: 421 |
| Late swaps | 182, worst 36.0 s beyond the quoted median |
| Swaps completed | 300 |
| Diversions on short final | 208 of 1277 asked |
| Bookings the nest cancelled as no-shows | 7 |
| Pad utilisation | 83.4% |
| Lowest charged packs staged | 0 |
| Substitutions into vacated slots | 212 |
| Transit holds | 15165 |

## Losses and abort

| Measure | Value |
| --- | --- |
| Declared max_simultaneous_loss | 3 |
| Peak concurrent losses | 0 |
| Aircraft lost in total | 0 |

The engine did not abort.

## Music and motion

| Measure | Value |
| --- | --- |
| Tempo | 120 BPM |
| Beats played | 7200 — the whole show, not a clip |
| Worst cue boundary off the beat grid | 0.00e+0 beats |
| Worst motion-to-audio offset | 0.00e+0 s |
| Locked | yes |

Two things can come apart over an hour and they have different causes. Cue boundaries can fall off the beat grid, which is a composition fault. The show time the engine evaluates motion at can drift from the audio clock, which is an engine fault: it happens when segment-local time is accumulated instead of computed. Both are measured over every tick of the run.

## Determinism and replay

| Measure | Value |
| --- | --- |
| Seed | `armable-g1-sample-0001` |
| Fixed timestep | 10 Hz |
| Trace format | `armable-show-sim-trace/1` |
| Trace digest | `3aaf3c677dedc6f929274e9f630e80ca` |
| Trace rows / lines | 6732 / 6734 |
| Report digest | `598bde68274e2dda5e43f24f98df7988` |
| Collection insertion order | natural |
| Random draws from the run seed | 0 |
| Drone-state updates | 2,916,000 |
| Ticks | 36,000 |

To replay this run, pass the seed and the inputs above to the harness; the trace digest must match. Wall-clock timing is deliberately absent from this report so that two runs of the same seed produce byte-identical output on any machine.

## What this report does not establish

- No flight dynamics, aerodynamics, radio or battery chemistry. Out of scope by design: this harness tests the engine's decisions, not physics.
- Ground-truth safety is sampled every 1 tick(s) (0.1 s). Conflicts between samples are not observed.
- Closest-pair search probes to 9.9 m. 1 sample(s) found no pair inside that radius and contribute no minimum.
- Position error is a drift model inside a sphere, not a GNSS model. It is the right shape for spacing decisions and nothing more.
- A forced descent is not routed. When an aircraft faults, goes quiet or lands on its reserve, the engine reserves the column it is coming down and holds other traffic out of it, but it does not move aircraft that are already on station below it, and a crossing already committed is not re-checked. Conflicts of that kind are counted as forced-descent conflicts, not as spacing failures, and closing that gap needs the engine to re-route commanded aircraft around an uncommanded descent.
- An unfilled formation slot is flown as a gap. The engine does not redistribute drones to close gaps, so the choreography degrades visually before it degrades in safety.
- Geofence zones are cylinders about the show origin. Real waiver boundaries are polygons.
- Contract 4 figures are provisional: the hub records them as waiver excerpts awaiting primary confirmation.
- The restricted-area free-fall calculation ignores drag, so it is conservative for a light airframe and should not be read as a drop test.

If you want to disagree with the verdict above, these are the places to push. The margins are stated so they can be argued with, the sampling interval is stated so the gaps can be challenged, and the inputs are digested so a different run cannot be passed off as this one.

