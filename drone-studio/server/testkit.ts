import { Bench, type ProposalOutcome } from '../src/bench/bench';
import { Runtime, type RuntimeOptions } from '../src/device/runtime';
import { ardupilotDemo, betaflightDemo } from '../src/device/sim/demo';
import type { Condition } from '../src/device/types';
import { Services, ToolError, type Account } from './services';
import { MemoryStore, type Store } from './store';
import { TOOLS, type ToolContext } from './tools';

/** Fast timings for tests. */
export const FAST: RuntimeOptions = {
  detectMs: 600, reconnectMs: 3000,
  mav: { heartbeatMs: 800, ackMs: 250, paramIdleMs: 60, echoMs: 150, quietMs: 30, restoreMs: 400, logIdleMs: 60, esc: { responseMs: 300, settleMs: 1, retryMs: 1 } },
  bf: { mspMs: 300, cliMs: 2000, cliIdleMs: 15, pollMs: 15, rebootMs: 60, esc: { responseMs: 300, settleMs: 1, retryMs: 1 } },
};
export async function makeAccount(services: Services, email = 'pilot@example.test'): Promise<Account> {
  const account: Account = { id: `acct_${Math.random().toString(36).slice(2, 10)}`, email, passwordHash: 'x', createdAt: Date.now(), assistantMode: 'propose' };
  await services.store.put('accounts', '', account.id, account, { lookup: email });
  return account;
}
/** Call a tool the way the MCP layer does, returning the result or the ToolError. */
export async function callTool(services: Services, account: string, name: string, args: Record<string, unknown> = {}, who = 'Claude'): Promise<any> {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const ctx: ToolContext = { account, who, services, now: Date.now };
  try { return await tool.run(args, ctx); }
  catch (error) { if (error instanceof ToolError) return { error: { code: error.code, message: error.message, hint: error.hint, ...error.extra } }; throw error; }
}

/** A whole bench in one process: a simulated aircraft, the runtime, and the tab link wired straight into a hub. */
export async function openBench(services: Services, account: string, stack: 'ardupilot' | 'betaflight' = 'ardupilot', simOptions: Record<string, unknown> = {}) {
  const source = stack === 'ardupilot' ? ardupilotDemo({ tickMs: 10, ...simOptions }) : betaflightDemo(simOptions);
  const runtime = new Runtime(FAST);
  const hub = services.hub(account);
  const tabId = `tab_${Math.random().toString(36).slice(2, 8)}`;
  const bench = new Bench(runtime, { mirror: m => { hub.mirror = m; }, reply: (id, ok, payload) => hub.settle(id, ok, payload) }, { stateEveryMs: 20 });
  hub.attach({ id: tabId, bench: true, active: Date.now(), send: message => { if (message.type === 'rpc') void bench.handle(message.id, message.request); } });
  await runtime.connect(source);
  bench.flush();
  return {
    runtime, bench, sim: source.sim, tabId,
    /** What the person does: approve in the signed-in tab, confirm conditions, and let the tab carry it out. */
    async approve(proposalId: string, conditions: Condition[] = [], prompt?: Parameters<Bench['execute']>[2]): Promise<ProposalOutcome> {
      const proposal = await services.decide(account, proposalId, true);
      const outcome = await bench.execute(proposal, conditions, prompt);
      await services.complete(account, proposalId, outcome);
      return outcome;
    },
    async close() { bench.dispose(); hub.detach(tabId); await runtime.disconnect(); (source.sim as { stop?: () => void }).stop?.(); },
  };
}
export function makeServices(store: Store = new MemoryStore()) { return new Services(store); }
