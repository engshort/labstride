import { lstatSync } from 'node:fs';
import { join } from 'node:path';

// A process interruption must never turn an incomplete restore into fresh state.
export function assertNoMaintenance(directory: string): void {
  try { lstatSync(join(directory, 'maintenance.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw Error('maintenance_incomplete');
}
