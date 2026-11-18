import { loopback, type ByteTransport } from '../transport';
import { ArdupilotSim, type ArdupilotSimOptions } from './ardupilot';
import { BetaflightSim, type BetaflightSimOptions } from './betaflight';

/** Where a connection comes from. USB in the product; a simulated aircraft for the demo and for tests. */
export interface PortSource { label: string; demo: boolean; open(): Promise<ByteTransport> }

export function ardupilotDemo(options: ArdupilotSimOptions = {}): PortSource & { sim: ArdupilotSim } {
  const sim = new ArdupilotSim(undefined, options);
  return { sim, label: 'Demo drone · ArduPilot', demo: true, async open() { const [host, device] = loopback('Demo drone · ArduPilot'); sim.inBootloader = false; sim.attach(device); return host; } };
}
/**
 * The Betaflight demo has the most common new-build problem: it will not arm. Its ExpressLRS receiver speaks CRSF,
 * but the flight controller is set to SBUS, so there is no signal. Fix the receiver protocol, save, and it arms.
 */
export const DEMO_FAULT = { receiver: 'CRSF', stored: { serialrx_provider: 'SBUS' } };
export function betaflightDemo(options: BetaflightSimOptions = DEMO_FAULT): PortSource & { sim: BetaflightSim } {
  const sim = new BetaflightSim(options);
  return { sim, label: 'Demo drone · Betaflight', demo: true, async open() { const [host, device] = loopback('Demo drone · Betaflight'); sim.inBootloader = false; sim.attach(device); return host; } };
}
