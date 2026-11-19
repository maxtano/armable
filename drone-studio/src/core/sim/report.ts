/**
 * The run report, rendered for a reader who is allowed to disagree.
 *
 * This is the deliverable, not the pass/fail bit. Some FAA waivers require
 * simulation-based testing before operations, so the output has to be legible to
 * a sceptical human: every headline number appears as a *margin* against the
 * figure it is measured from, every assumption that produced it is printed next
 * to it, and the limitations section is not an afterthought.
 *
 * A report that only says "passed" is worth nothing to a waiver application.
 */

import { TICK_SECONDS } from './show-plan';
import type { RunReport } from './harness';

const metres = (value: number) => `${value.toFixed(2)} m`;
const seconds = (value: number) => `${value.toFixed(1)} s`;
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

const VERDICT_MEANING: Record<RunReport['verdict'], string> = {
  pass: 'No safety invariant was broken and no aircraft was lost.',
  degraded:
    "No safety invariant was broken, but the show lost fidelity: aircraft had to land out of turn, or formation slots went unfilled beyond this run's budget.",
  fail: 'A safety invariant was broken. The numbers below say which.',
  aborted: 'The engine stopped the show. Whether that was correct is stated below.',
  'contract-violation':
    "The fleet did not deliver what it declared. The engine's separation guarantee is computed from that declaration, so it never applied. This is not a software defect.",
  'refused-to-compose':
    'The engine refused to fly this show against this ground system before the first tick. The reasons are below, with the arithmetic.',
};

export function renderRunReport(report: RunReport): string {
  const r = report;
  const out: string[] = [];
  const h = (level: number, text: string) => out.push(`${'#'.repeat(level)} ${text}`, '');
  const p = (text: string) => out.push(text, '');
  const table = (headers: string[], rows: (string | number)[][]) => {
    out.push(`| ${headers.join(' | ')} |`);
    out.push(`| ${headers.map(() => '---').join(' | ')} |`);
    for (const row of rows) out.push(`| ${row.join(' | ')} |`);
    out.push('');
  };

  h(1, `Full-show simulation: ${r.label}`);
  p(
    `**Verdict: ${r.verdict.toUpperCase()}.** ${VERDICT_MEANING[r.verdict]}` +
      `\n\nEngine \`${r.engineVersion}\` · seed \`${r.seed}\` · report format \`${r.format}\`.`
  );
  for (const reason of r.verdictReasons) p(`- ${reason}`);
  p(
    'This run is reproducible from the seed and inputs below and from nothing else: the engine and ' +
      'the simulated fleet and nest contain no wall-clock reads, no unseeded randomness, and no ' +
      'dependence on map or set iteration order. The trace reference at the end is the evidence.'
  );

  h(2, 'What this simulates, and what it does not');
  p(
    "The harness tests the **show engine's decisions** against the two arm contracts: a fleet that " +
      'declares a position error volume, reports one of six states and reports energy in usable ' +
      'airborne seconds; and a nest that quotes a rotation capacity and a dock-to-ready latency, and ' +
      'that can refuse. It models no flight dynamics, no aerodynamics, no radio and no battery ' +
      'chemistry. Those are out of scope by design, and conflating the two is how simulation ' +
      'harnesses stop being trusted.'
  );

  h(2, 'Inputs');
  table(
    ['Input', 'Value'],
    [
      [
        'Show',
        `${r.inputs.show.name}, ${seconds(r.inputs.show.durationSeconds)}, ${r.inputs.show.bpm} BPM`,
      ],
      ['Aircraft on station', r.inputs.show.droneCount],
      [
        'Projects / cues',
        `${r.inputs.show.segments} / ${r.inputs.show.cues} (the engine caps one project at ` +
          `${r.inputs.show.projectCapSeconds} s, so an hour is a sequence of them)`,
      ],
      [
        'Choreography envelope',
        `${metres(r.inputs.show.minAltitude)}–${metres(r.inputs.show.maxAltitude)} altitude, ` +
          `${metres(r.inputs.show.maxRadius)} radius, peak commanded speed ` +
          `${r.inputs.show.peakCommandedSpeed.toFixed(2)} m/s`,
      ],
      ['Roster', `${r.inputs.fleet.roster} airframes`],
      [
        'Declared position error volume',
        `${metres(r.inputs.fleet.declaredErrorVolume)} radius` +
          (r.inputs.fleet.deliveredErrorVolume !== r.inputs.fleet.declaredErrorVolume
            ? ` — **delivering ${metres(r.inputs.fleet.deliveredErrorVolume)}**`
            : ''),
      ],
      [
        'Pack endurance / declared reserve',
        `${seconds(r.inputs.fleet.airSeconds)} / ${seconds(r.inputs.fleet.reserveSeconds)} usable airborne`,
      ],
      ['Declared max_simultaneous_loss', r.inputs.fleet.maxSimultaneousLoss],
      [
        'Nest',
        `${r.inputs.nest.pads} pads across ${r.inputs.nest.modules} modules, ` +
          `${r.inputs.nest.packSlotsPerModule}-slot magazine per module`,
      ],
      [
        'Rotation capacity',
        `${r.inputs.nest.rotationCapacityPerModulePerMinute.toFixed(2)}/min per module, ` +
          `${r.inputs.nest.rotationCapacityPerMinute.toFixed(2)}/min across the nest`,
      ],
      [
        'Dock → ready',
        `${seconds(r.inputs.nest.medianDockToReadySeconds)} median, log-normal σ ` +
          `${r.inputs.nest.dockToReadySigma} — a distribution, not a constant`,
      ],
      ['Advance notice required', seconds(r.inputs.nest.requiredNoticeSeconds)],
      ['Nest sizing source', r.inputs.nest.sizingSource],
    ]
  );
  p(
    `Input digests, so a reader can tell whether two reports describe the same run: show ` +
      `\`${r.inputs.digests.show}\`, fleet \`${r.inputs.digests.fleet}\`, nest ` +
      `\`${r.inputs.digests.nest}\`, geofence \`${r.inputs.digests.geofence}\`, engine ` +
      `\`${r.inputs.digests.engine}\`.`
  );

  h(2, 'Composability check, before the first tick');
  table(
    ['Quantity', 'Value'],
    [
      ['Rotation demand', `${r.composability.rotationDemandPerMinute.toFixed(2)} drones/min`],
      ['Nest capacity', `${r.composability.rotationCapacityPerMinute.toFixed(2)} drones/min`],
      ['Utilisation', pct(r.composability.utilisation)],
      ['Transit capacity', `${r.composability.transitCapacityPerMinute.toFixed(2)} drones/min`],
      ['On-station seconds per pack', seconds(r.composability.onStationSeconds)],
      ['Outbound transit', seconds(r.composability.outboundSeconds)],
      [
        'Roster required / available',
        `${r.composability.rosterRequired} / ${r.composability.rosterAvailable}`,
      ],
      ['Transit band stack reaches', metres(r.composability.transitCeiling)],
    ]
  );
  if (r.composability.reasons.length) {
    p('**The engine refused to compose this show.** Its reasons:');
    for (const reason of r.composability.reasons) p(`- ${reason}`);
  }
  for (const warning of r.composability.warnings) p(`> Warning: ${warning}`);

  h(2, 'Separation');
  p(
    `The engine's commanded gap is ${metres(r.separation.requiredSpacing)}: ${r.separation.spacingSource}`
  );
  table(
    ['Measure', 'Value'],
    [
      [
        'Minimum separation achieved (ground truth)',
        `**${metres(r.separation.minimumAchieved)}** between aircraft ${r.separation.droneA} and ` +
          `${r.separation.droneB} at tick ${r.separation.atTick} (${seconds(r.separation.atShowSeconds)})`,
      ],
      [
        'Margin against the guaranteed floor',
        `**${r.separation.margin >= 0 ? '+' : ''}${metres(r.separation.margin)}** against ` +
          `${metres(r.separation.truthFloor)}`,
      ],
      [
        'Against the commanded gap',
        `${r.separation.marginAgainstCommanded >= 0 ? '+' : ''}${metres(r.separation.marginAgainstCommanded)} — ` +
          'negative is expected: aircraft spend their declared error volume, which is what it is for',
      ],
      [
        'As the engine saw it, from telemetry',
        metres(r.separation.engineViewMinimum) +
          (Math.abs(r.separation.engineViewMinimum - r.separation.minimumAchieved) > 0.01
            ? ' — it differs from ground truth, which is the point of measuring both'
            : ''),
      ],
      ['Physical contact threshold', metres(r.separation.collisionThreshold)],
      [
        'Breaches between aircraft under command',
        `**${r.separation.breaches}** — this is the engine\'s spacing guarantee`,
      ],
      [
        'Forced-descent conflicts',
        `${r.separation.descentConflicts} — an aircraft that was faulted, silent or landing on its ` +
          'reserve came inside the floor. The engine cannot command an aircraft that is not taking ' +
          'instructions, so these are counted apart from the figure above rather than scored as the same thing',
      ],
      [
        'Sampling',
        `${r.separation.samples} samples, every ${r.separation.sampleEveryTicks} tick(s) ` +
          `(${seconds(r.separation.sampleEveryTicks * TICK_SECONDS)}), closest-pair probe ` +
          `${metres(r.separation.probeMetres)}`,
      ],
      [
        'Samples with no pair inside the probe',
        `${r.separation.ticksWithNoPairInProbe} — these contribute no minimum`,
      ],
    ]
  );

  h(2, 'Energy reserve');
  table(
    ['Measure', 'Value'],
    [
      ['Declared reserve', seconds(r.reserve.declaredReserveSeconds)],
      [
        'Lowest margin above it, by any aircraft',
        `**${seconds(r.reserve.lowestMarginSeconds)}** by aircraft ${r.reserve.droneId} at tick ` +
          `${r.reserve.atTick} (${seconds(r.reserve.atShowSeconds)})`,
      ],
      ['Breaches by an aircraft under command', `**${r.reserve.breaches}**`],
      [
        'Samples with an uncommandable aircraft below reserve',
        `${r.reserve.uncommandedBreaches} — contract 1's promise is that the engine will never ` +
          '*command* an aircraft below its reserve. One that has stopped taking commands flies until ' +
          'its pack is flat, which is a different fact and is counted separately',
      ],
    ]
  );
  p(
    'The engine may command no aircraft below its declared reserve. When a hold -- for a pad, a ' +
      'transit band or a blocked column -- would take an aircraft past the point where it can still ' +
      'reach the ground and keep that reserve, it lands where it is. That is a dropout, counted below.'
  );

  h(2, 'Zone containment');
  p(
    "Contract 4's four zones. A soft-fence violation triggers return or autoland; a **hard-fence " +
      'violation stops the motors**, which is why the Restricted Area is a free-fall calculation and ' +
      'not a navigational boundary.'
  );
  table(
    ['Zone', 'Radius', 'Closest approach (horizontal)', 'Ceiling margin', 'On violation'],
    r.containment.margins.map((m) => [
      m.zone,
      metres(m.zoneRadius),
      `${metres(m.horizontal)} (aircraft ${m.droneId}, tick ${m.atTick})`,
      metres(m.vertical),
      m.behaviour,
    ])
  );
  table(
    ['Restricted Area width', 'Value'],
    [
      ['Implied by show altitude', metres(r.containment.impliedByAltitude)],
      ['Waiver rule, +10 m per 100 ft', metres(r.containment.restrictedArea.waiverRuleMetres)],
      [
        'Ballistic: horizontal throw after motors stop',
        `${metres(r.containment.restrictedArea.ballisticMetres)} ` +
          `(free fall ${seconds(r.containment.restrictedArea.fallSeconds)}, with the safety factor applied)`,
      ],
      [
        'Binding figure',
        `**${metres(r.containment.restrictedArea.metres)}** — ${r.containment.restrictedArea.binding}`,
      ],
      ['Breaches', String(r.containment.breaches)],
    ]
  );

  h(2, 'Dropouts');
  p(
    `**${r.dropouts.count}** contingency landings, ${r.dropouts.ratePerRotation.toFixed(3)} per ` +
      `completed rotation, against a budget of ${r.dropouts.budget} for this run. Contract 4 makes ` +
      `this a reported figure rather than something to grep an incident log for: failsafe ` +
      `return-to-home and land-now events go to the FAA quarterly.`
  );
  if (r.dropouts.log.length)
    table(
      ['Tick', 'Show time', 'Aircraft', 'Why'],
      r.dropouts.log
        .slice(0, 20)
        .map((d) => [d.tick, seconds(d.tick * TICK_SECONDS), d.droneId, d.reason])
    );

  h(2, 'Slot handover');
  p(
    'An hour-long show outlives any pack, so every formation slot is handed over repeatedly: the ' +
      'engine launches a relief early, parks it beside the slot, releases the holder, and lifts the ' +
      'relief in. Two aircraft cannot occupy one slot, so a rotated show is never gapless. This is a ' +
      'fidelity cost, not a safety one, and it is measured rather than hidden.'
  );
  table(
    ['Measure', 'Value'],
    [
      ['Formation slots', r.handover.slots],
      ['Mean slots occupied', `**${pct(r.handover.slotFillRate)}**`],
      ['Mean slots in handover', r.handover.meanVacantSlots.toFixed(2)],
      ['Peak unfilled', `${r.handover.peakVacantSlots} (the mass launch, at tick 0)`],
      ['Reliefs launched ahead of a departure', r.handover.reliefLaunches],
      [
        'Slot-ticks with no airframe available',
        `${r.handover.reliefUnavailable} — every one of these is a slot the roster could not cover`,
      ],
    ]
  );

  h(2, 'Rotation record');
  table(
    ['Measure', 'Value'],
    [
      [
        'Demand / capacity',
        `${r.rotation.demandPerMinute.toFixed(2)} / ${r.rotation.capacityPerMinute.toFixed(2)} per minute`,
      ],
      ['Utilisation', pct(r.rotation.utilisation)],
      [
        'Docks requested / accepted / refused',
        `${r.rotation.requested} / ${r.rotation.accepted} / ${r.rotation.refused}`,
      ],
      [
        'Refusals by reason',
        Object.entries(r.rotation.refusalsByReason)
          .filter(([, n]) => n > 0)
          .map(([reason, n]) => `${reason}: ${n}`)
          .join(', ') || 'none',
      ],
      [
        'Late swaps',
        `${r.rotation.late}, worst ${seconds(r.rotation.worstLatenessSeconds)} beyond the quoted median`,
      ],
      ['Swaps completed', r.rotation.swapsCompleted],
      [
        'Diversions on short final',
        `${r.rotation.diversions} of ${r.rotation.diversionsRequested} asked`,
      ],
      ['Bookings the nest cancelled as no-shows', r.rotation.noShows],
      ['Pad utilisation', pct(r.rotation.padUtilisation)],
      ['Lowest charged packs staged', r.rotation.lowestChargedPacks],
      ['Substitutions into vacated slots', r.rotation.substitutions],
      ['Transit holds', r.rotation.transitHolds],
    ]
  );

  h(2, 'Losses and abort');
  table(
    ['Measure', 'Value'],
    [
      ['Declared max_simultaneous_loss', r.losses.declaredMax],
      ['Peak concurrent losses', r.losses.peakConcurrent],
      ['Aircraft lost in total', r.losses.total],
    ]
  );
  if (r.abort)
    p(
      `**Abort at tick ${r.abort.tick} (${seconds(r.abort.showSeconds)}), mode \`${r.abort.mode}\`.** ` +
        `${r.abort.reason}\n\nWas stopping correct here? **${r.abort.correct ? 'Yes' : 'No'}** — ` +
        `${
          r.abort.correct
            ? 'losses exceeded the declared maximum, or the fleet broke its contract. This is the one case in the matrix where stopping is the right answer.'
            : 'the engine stopped a show that did not need stopping. That is a defect.'
        }`
    );
  else p('The engine did not abort.');

  if (r.faultTimeline.length) {
    h(2, 'Fault timeline');
    p('What was injected, when, and what the engine did about it in the following 30 seconds.');
    for (const entry of r.faultTimeline) {
      p(
        `**Tick ${entry.tick} (${seconds(entry.showSeconds)}) · \`${entry.injection}\`` +
          `${entry.droneId ? ` · aircraft ${entry.droneId}` : ''}** — ${entry.note}`
      );
      for (const line of entry.response) out.push(`- ${line}`);
      if (!entry.response.length) out.push('- (the engine recorded nothing in this window)');
      out.push('');
    }
  }

  if (r.contractViolations.length) {
    h(2, 'Contract violations');
    p(
      'These are not software defects and must not be filed as such. A fleet that does not deliver ' +
        'what it declares invalidates every separation figure above, because the engine computes its ' +
        'spacing from the declaration.'
    );
    for (const violation of r.contractViolations)
      p(
        `- **Tick ${violation.tick}, aircraft ${violation.droneId}, observed by the ` +
          `${violation.observer}.** ${violation.detail}`
      );
  }

  h(2, 'Music and motion');
  table(
    ['Measure', 'Value'],
    [
      ['Tempo', `${r.audio.bpm} BPM`],
      ['Beats played', `${r.audio.beatsPlayed} — the whole show, not a clip`],
      [
        'Worst cue boundary off the beat grid',
        `${r.audio.maxCueBoundaryBeatError.toExponential(2)} beats`,
      ],
      ['Worst motion-to-audio offset', `${r.audio.maxMotionAudioOffsetSeconds.toExponential(2)} s`],
      ['Locked', r.audio.locked ? 'yes' : '**no**'],
    ]
  );
  p(
    'Two things can come apart over an hour and they have different causes. Cue boundaries can fall ' +
      'off the beat grid, which is a composition fault. The show time the engine evaluates motion at ' +
      'can drift from the audio clock, which is an engine fault: it happens when segment-local time ' +
      'is accumulated instead of computed. Both are measured over every tick of the run.'
  );

  h(2, 'Determinism and replay');
  table(
    ['Measure', 'Value'],
    [
      ['Seed', `\`${r.determinism.seed}\``],
      ['Fixed timestep', `${r.determinism.fixedTimestepHz} Hz`],
      ['Trace format', `\`${r.determinism.traceFormat}\``],
      ['Trace digest', `\`${r.determinism.traceDigest}\``],
      ['Trace rows / lines', `${r.determinism.traceRows} / ${r.determinism.traceLines}`],
      ['Report digest', `\`${r.determinism.reportDigest}\``],
      ['Collection insertion order', r.determinism.insertionOrder],
      ['Random draws from the run seed', r.determinism.rngDraws],
      ['Drone-state updates', r.scale.droneStateUpdates.toLocaleString('en-GB')],
      ['Ticks', r.scale.ticks.toLocaleString('en-GB')],
    ]
  );
  p(
    'To replay this run, pass the seed and the inputs above to the harness; the trace digest must ' +
      'match. Wall-clock timing is deliberately absent from this report so that two runs of the same ' +
      'seed produce byte-identical output on any machine.'
  );

  h(2, 'What this report does not establish');
  for (const limitation of r.limitations) out.push(`- ${limitation}`);
  out.push('');
  p(
    'If you want to disagree with the verdict above, these are the places to push. The margins are ' +
      'stated so they can be argued with, the sampling interval is stated so the gaps can be ' +
      'challenged, and the inputs are digested so a different run cannot be passed off as this one.'
  );
  return out.join('\n');
}
