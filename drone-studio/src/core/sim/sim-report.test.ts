import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { sampleRunConfig, SAMPLE_REPORT_PATH } from './fixtures/sample-run';
import { runShowSimulation } from './harness';
import { renderRunReport } from './report';

// These runs are seconds, not milliseconds: an hour-long show at 10 Hz is
// millions of drone-state updates. The default per-test timeout is for unit
// tests and does not apply here.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * The committed sample report is the artifact a regulator, a customer or a
 * future engineer reads, so it is checked like code: regenerated here and
 * compared byte for byte. If the engine changes a number in it, this test fails
 * and `npx tsx scripts/sim-report.ts` updates it, with the diff visible in
 * review rather than silently regenerated in CI.
 */
describe('the committed sample run report', () => {
  const fixture = readFileSync(
    fileURLToPath(new URL(`../../../${SAMPLE_REPORT_PATH}`, import.meta.url)),
    'utf8'
  );
  const run = runShowSimulation(sampleRunConfig);
  const rendered = renderRunReport(run.report) + '\n';

  it('is exactly what this engine produces from that seed', () => {
    expect(rendered).toBe(fixture);
  });

  it('reads as evidence rather than as a pass bit', () => {
    // Everything the spec asks the report to carry, checked in the rendered text
    // rather than in the object, because the rendered text is what gets read.
    expect(fixture).toContain(`seed \`${sampleRunConfig.seed}\``);
    expect(fixture).toMatch(/Minimum separation achieved \(ground truth\)/);
    expect(fixture).toMatch(/Margin against the guaranteed floor/);
    expect(fixture).toMatch(/Lowest margin above it, by any aircraft/);
    expect(fixture).toMatch(/Closest approach \(horizontal\)/);
    expect(fixture).toMatch(/Restricted Area width/);
    expect(fixture).toMatch(/Rotation record/);
    expect(fixture).toMatch(/Trace digest/);
    expect(fixture).toMatch(/What this report does not establish/);
    expect(fixture).toMatch(/show_sizing\.py/);
    // All four zones, with the behaviour each violation triggers.
    for (const zone of ['flight-area', 'soft-fence', 'hard-fence', 'restricted-area'])
      expect(fixture).toContain(zone);
    expect(fixture).toContain('motors stop');
    // And no wall clock anywhere in it, so the fixture is stable.
    expect(fixture).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(fixture).not.toMatch(/wall clock: \d/);
  });

  it('says what it could not prove', () => {
    const limitations = fixture.slice(fixture.indexOf('What this report does not establish'));
    expect(limitations).toMatch(/not physics|out of scope/i);
    expect(limitations).toMatch(/sampled/i);
    expect(limitations.split('\n- ').length).toBeGreaterThan(6);
    expect(limitations).toMatch(/disagree with the verdict/);
  });
});
