import { DeviceError } from '../device/bytes';
import type { RemoteRequest, Runtime } from '../device/runtime';
import type { ChangeResult, Condition, PromptRequest, TestResult } from '../device/types';
import type { Mirror } from '../map/map';

/**
 * The bench tab's side of the conversation with the cloud. It mirrors the aircraft's state up, answers
 * observe-level requests coming down, and carries out a proposal only when a person in this tab approved it.
 * The same class runs in the browser and, in tests, in-process.
 */
export interface CloudLink { mirror(mirror: Mirror): void; reply(id: string, ok: boolean, payload: unknown): void }
export interface ProposalLike { id: string; kind: 'change' | 'test'; needs: Condition[]; changes?: { id: string; value: string | number; expected?: string | number; before?: unknown }[]; test?: { id: string; args?: Record<string, unknown> } }
export interface ProposalOutcome { ok: boolean | null; summary: string; changes?: ChangeResult[]; test?: TestResult }

export class Bench {
  private timer?: ReturnType<typeof setTimeout>;
  private lastSent = 0;
  private off: () => void;
  constructor(readonly runtime: Runtime, private link: CloudLink, private options: { stateEveryMs?: number; now?: () => number; capture?: (view: string) => Promise<{ png?: string; note?: string }> } = {}) {
    this.off = runtime.on(event => this.schedule(event.type === 'state' ? this.options.stateEveryMs ?? 1000 : 60));
    this.schedule(0);
  }
  dispose() { this.off(); clearTimeout(this.timer); }
  private now() { return (this.options.now ?? Date.now)(); }
  current(): Mirror { return { at: this.now(), snapshot: this.runtime.snapshot(), settings: this.runtime.settings(), log: this.runtime.lastLogAnalysis() }; }
  private schedule(withinMs: number) {
    const due = Math.max(0, this.lastSent + withinMs - this.now());
    if (this.timer && withinMs >= 1000) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), Math.min(due, withinMs));
  }
  /** Send the mirror now. */
  flush() { clearTimeout(this.timer); this.timer = undefined; this.lastSent = this.now(); this.link.mirror(this.current()); }

  /** A request relayed from an assistant. It can observe; it cannot carry an approval. */
  async handle(id: string, request: RemoteRequest | { op: 'capture'; view: string }) {
    try {
      const result = request.op === 'capture'
        ? await (this.options.capture?.(request.view) ?? Promise.resolve({ note: 'This tab cannot capture images.' }))
        : await this.runtime.remote(request);
      this.flush();
      this.link.reply(id, true, result);
    } catch (error) {
      this.link.reply(id, false, error instanceof DeviceError ? { code: error.code, message: error.message, hint: error.hint } : { code: 'device_error', message: error instanceof Error ? error.message : 'The operation failed.' });
    }
  }

  /**
   * Carry out an approved proposal. Call this only from the approve button's click handler: this is where the
   * single-use grant is minted, and nothing else in the system can mint one.
   */
  async execute(proposal: ProposalLike, confirmed: Condition[], prompt?: (request: PromptRequest) => Promise<unknown>): Promise<ProposalOutcome> {
    const missing = proposal.needs.filter(n => !confirmed.includes(n));
    if (missing.length) return { ok: false, summary: `Not confirmed: ${missing.join(', ')}.` };
    try {
      if (proposal.kind === 'change') {
        const changes = await this.runtime.write(proposal.changes!.map(c => ({ id: c.id, value: c.value, expected: c.expected })), this.runtime.approve('write', confirmed));
        const failed = changes.filter(c => !c.ok);
        this.flush();
        return { ok: failed.length === 0, changes, summary: failed.length ? `${changes.length - failed.length} of ${changes.length} written. ${failed[0].note ?? ''}`.trim() : `${changes.length === 1 ? 'Written' : `${changes.length} written`} and confirmed by reading back.` };
      }
      const test = await this.runtime.run(proposal.test!.id, proposal.test!.args ?? {}, this.runtime.approve(proposal.test!.id, confirmed), prompt);
      this.flush();
      return { ok: test.ok, summary: test.summary, test: slim(test) };
    } catch (error) {
      this.flush();
      return { ok: false, summary: error instanceof DeviceError && error.hint ? `${error.message} ${error.hint}` : error instanceof Error ? error.message : 'It failed.' };
    }
  }
}
/** Results go to the cloud and on to an assistant. Keep them small. */
function slim(result: TestResult): TestResult {
  const data = result.data as { analysis?: unknown; values?: Record<string, unknown> } | undefined;
  if (data?.analysis) return { ...result, data: { note: 'Read log.latest.* for the findings.' } };
  if (data?.values) return { ...result, data: { settings: Object.keys(data.values).length } };
  return result;
}
