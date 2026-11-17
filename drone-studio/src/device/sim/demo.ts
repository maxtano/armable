import { loopback, type ByteTransport } from '../transport';
import { ArdupilotSim, type ArdupilotSimOptions } from './ardupilot';
import { BetaflightSim, type BetaflightSimOptions } from './betaflight';

/** Where a connection comes from. USB in the product; a simulated aircraft for the demo and for tests. */
export interface PortSource { label: string; demo: boolean; open(): Promise<ByteTransport> }

export function ardupilotDemo(options: ArdupilotSimOptions = {}): PortSource & { sim: ArdupilotSim } {
  const sim = new ArdupilotSim(undefined, options);
  return { sim, label: 'Demo drone · ArduPilot', demo: true, async open() { const [host, device] = loopback('Demo drone · ArduPilot'); sim.inBootloader = false; sim.attach(device); return host; } };
}
export function betaflightDemo(options: BetaflightSimOptions = {}): PortSource & { sim: BetaflightSim } {
  const sim = new BetaflightSim(options);
  return { sim, label: 'Demo drone · Betaflight', demo: true, async open() { const [host, device] = loopback('Demo drone · Betaflight'); sim.inBootloader = false; sim.attach(device); return host; } };
}
