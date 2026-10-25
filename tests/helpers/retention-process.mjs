import { retainDiagnostics } from '../../packages/operations/retention.ts';
const [stateDirectory,at]=process.argv.slice(2);
await retainDiagnostics({stateDirectory,configuration:{installationId:'installation-test',limits:{metadataRetentionDays:90}}},'apply',{
  at,beforeCommit(){process.send({stage:'before-commit'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);},
});
