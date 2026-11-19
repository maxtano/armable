import { Bench, type ProposalLike } from '../src/bench/bench';
import { Runtime, type RuntimeOptions } from '../src/device/runtime';
import { ardupilotDemo, betaflightDemo } from '../src/device/sim/demo';
import type { Condition } from '../src/device/types';
import { newId } from './store';
import { ToolError, type Services } from './services';

/**
 * Demo drones that run on the server, so someone can try Armable entirely inside their chat: the panel shows the
 * drone, the assistant works on it, and no Armable tab is needed. Each one joins its account exactly as a browser
 * tab with a drone does, so every tool works on it unchanged.
 *
 * A demo costs the server a little CPU, so there are firm limits: a few at once, stopped after a while unused, and
 * a ceiling on how long any one runs.
 */
export const DEMO_LIMITS = { max: 5, idleMs: 10 * 60_000, maxMs: 30 * 60_000 };

interface Running { tabId: string; runtime: Runtime; bench: Bench; stop(): void; started: number; last: number }

export class CloudDemos {
  private running = new Map<string, Running>();
  private sweeper?: ReturnType<typeof setInterval>;
  /** runtime: timings for the simulated link; tests pass fast ones. */
  constructor(private services: Services, private limits = DEMO_LIMITS, private now: () => number = Date.now, private runtime: RuntimeOptions = {}) {}

  /** Is the drone this account sees one of ours? */
  has(account: string) { return this.running.has(account); }
  /** Anything the person or their assistant does keeps the demo running. */
  touch(account: string) { const r = this.running.get(account); if (r) r.last = this.now(); }

  async start(account: string, stack: 'betaflight' | 'ardupilot' = 'betaflight') {
    const hub = this.services.hub(account);
    if (this.running.has(account)) { this.touch(account); return; }
    if (hub.benchTab()) throw new ToolError('tab_open', 'Armable is already open with a drone in your browser.', 'Use that one, or disconnect it there first.');
    if (this.running.size >= this.limits.max) throw new ToolError('busy', 'Lots of people are trying the demo right now.', 'Try again in a minute, or open Armable in your browser.');
    // The Betaflight demo has its well-known fault: a receiver set up for the wrong protocol, so it won't arm.
    const source = stack === 'ardupilot' ? ardupilotDemo() : betaflightDemo();
    const runtime = new Runtime(this.runtime), tabId = `demo_${newId(6)}`;
    const bench = new Bench(runtime, {
      mirror: mirror => { if (!hub.tabs.has(tabId)) return; hub.mirror = { ...mirror, at: this.now() }; void this.services.observe(account, mirror).catch(() => {}); },
      reply: (id, ok, payload) => hub.settle(id, ok, payload),
    }, { stateEveryMs: 500 });
    hub.attach({ id: tabId, surface: 'bench', bench: true, active: this.now(), send: message => {
      if (message.type === 'rpc') void bench.handle(message.id, message.request);
      // A standing permission approved something: carry it out, as a tab does.
      else if (message.type === 'event' && message.event === 'execute') { const p = message.data as ProposalLike & { id: string; grantConditions?: Condition[] }; void bench.execute(p, p.grantConditions ?? []).then(outcome => this.services.complete(account, p.id, outcome)); }
    } });
    const stop = () => { bench.dispose(); hub.detach(tabId); void runtime.disconnect().catch(() => {}); (source.sim as { stop?: () => void }).stop?.(); };
    this.running.set(account, { tabId, runtime, bench, stop, started: this.now(), last: this.now() });
    try { await runtime.connect(source); bench.flush(); }
    catch (error) { this.stop(account); throw error; }
    this.sweeper ??= setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref?.();
  }

  /** The person approved a change to the demo drone in the panel: carry it out and report, as a tab does. */
  async approve(account: string, proposalId: string, conditions: Condition[]) {
    const r = this.running.get(account);
    // Only ever the demo: if anything else is serving this account's drone, approvals go through Armable.
    if (!r || this.services.hub(account).benchTab()?.id !== r.tabId) throw new ToolError('not_demo', 'Only the demo drone can be approved here.', 'Approve changes to your own drone in Armable.');
    this.touch(account);
    const proposal = await this.services.decide(account, proposalId, true);
    const outcome = await r.bench.execute(proposal, conditions);
    await this.services.complete(account, proposalId, outcome);
    return outcome;
  }

  stop(account: string) { const r = this.running.get(account); if (!r) return; this.running.delete(account); r.stop(); }
  /** Stop demos nobody has used for a while, and any that have run too long. */
  sweep() {
    const now = this.now();
    for (const [account, r] of this.running) if (now - r.last > this.limits.idleMs || now - r.started > this.limits.maxMs) this.stop(account);
  }
  close() { clearInterval(this.sweeper); for (const account of [...this.running.keys()]) this.stop(account); }
}
