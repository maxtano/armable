/**
 * Regenerates the committed sample run report for the full-show simulation.
 *
 * The report is the deliverable of G1, not the pass/fail bit, so one is kept in
 * the repository as a fixture and checked by `sim-report.test.ts`. If a change
 * to the engine moves a number in it, that test fails and this script is how the
 * fixture is brought back in line -- deliberately, with the diff visible in
 * review rather than regenerated silently in CI.
 *
 * Usage: npx tsx scripts/sim-report.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sampleRunConfig, SAMPLE_REPORT_PATH } from '../src/core/sim/fixtures/sample-run';
import { runShowSimulation } from '../src/core/sim/harness';
import { renderRunReport } from '../src/core/sim/report';

const run = runShowSimulation(sampleRunConfig);
const path = fileURLToPath(new URL(`../${SAMPLE_REPORT_PATH}`, import.meta.url));
writeFileSync(path, renderRunReport(run.report) + '\n');
console.log(
  `${path}\n  verdict ${run.report.verdict} · trace ${run.report.determinism.traceDigest} · ` +
    `${run.report.scale.droneStateUpdates.toLocaleString('en-GB')} drone-state updates · ` +
    `${(run.elapsedMs / 1000).toFixed(1)} s wall clock`
);
