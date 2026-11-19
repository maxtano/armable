import { describe, expect, it } from 'vitest';
import { Hub } from './services';

/** A tab says which Armable workspace it is. Only the bench can answer anything about the aircraft. */
describe('open tabs', () => {
  const tab = (id: string, surface: 'bench' | 'show', active: number, seen: unknown[]) =>
    ({ id, surface, bench: false, active, send: (message: unknown) => { seen.push(message); } });

  it('asks the bench for a picture of the drone, even when a Shows tab is newer', async () => {
    const hub = new Hub();
    const bench: unknown[] = [], show: unknown[] = [];
    hub.attach(tab('bench', 'bench', 1, bench));
    hub.attach(tab('show', 'show', 2, show));
    await expect(hub.call({ op: 'capture', view: 'drone' }, 20)).rejects.toThrow();
    expect(bench).toHaveLength(1);
    expect(show).toEqual([]);
  });

  it('says Armable is not open when only a Shows tab is', async () => {
    const hub = new Hub();
    const show: unknown[] = [];
    hub.attach(tab('show', 'show', 1, show));
    await expect(hub.call({ op: 'capture', view: 'drone' }, 20)).rejects.toMatchObject({ code: 'no_bench' });
    expect(show).toEqual([]);
  });
});
