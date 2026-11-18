import type { PartId } from '../device/types';
import { set } from '../web/store';

/**
 * The panel's stand-in for the app's controller. The drawing only needs “select a part”; the panel has no drone
 * connection of its own (that lives in an Armable tab, or on the server for the demo).
 */
export function select(part?: PartId, motor?: number) { set({ part, motor }); }
