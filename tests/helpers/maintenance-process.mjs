import { readFileSync } from 'node:fs';
import { upgradeDatabase, restoreBundle } from '../../packages/operations/recovery.ts';
const [config, operation, bundle, stage] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(config));
const boundary = name => {
  if (name !== stage) return;
  process.send({ stage: name });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
await (operation === 'restore' ? restoreBundle : upgradeDatabase)(spec, bundle, { boundary });
process.disconnect();
