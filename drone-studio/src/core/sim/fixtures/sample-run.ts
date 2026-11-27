import type { SimulationConfig } from '../harness';

/**
 * The run the committed sample report describes: the headline row of the
 * per-commit matrix, an hour-long show with 50 aircraft on station.
 *
 * It is pinned here rather than inlined in the script so that the test which
 * checks the fixture and the script which regenerates it cannot drift apart.
 */
export const sampleRunConfig: Partial<SimulationConfig> = {
  seed: 'armable-g1-sample-0001',
  label: 'hour-long show, 50 drones on station, clean fleet and nest',
};

export const SAMPLE_REPORT_PATH = 'src/core/sim/fixtures/sample-run-report.md';
