import test from 'node:test';
import { observeRestoreProjections } from './helpers/observation-fixture.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, chmodSync, cpSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync, fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { publicFixture } from './helpers/public-installation-fixture.mjs';
import { workspaceFixture } from './helpers/workspace-fixture.mjs';
import { WorkspaceRegistry } from '../packages/target-helper/workspaces.ts';
import { cli } from '../apps/cli/main.ts';
import { checkInstallation, report } from '../packages/operations/diagnostics.ts';
import { configurationView, extensionView, readStatus } from '../packages/operations/inspection.ts';
import { loadInstallation, installationShape } from '../packages/operations/installation.ts';
import { openOperationalRuntime, openDiagnosticsOnly } from '../packages/operations/runtime.ts';
import { validated } from '../packages/storage-sqlite/validation.ts';
import { startCoordinator } from '../apps/coordinator/main.ts';
import { createLocalPolicyAuthority } from '../packages/core/policy.ts';
import { seed, schedule, startPlan, context } from './helpers/execution-fixture.mjs';
import { createWorker, actionKey } from '../packages/core/worker.ts';

const privateUmask = process.umask(0o077);
process.on('exit', () => process.umask(privateUmask));

test('public init is disabled and structurally valid without Codex fields, bridge or local workspace mapping', async t => {
  const f = publicFixture(t), output = [];
  await cli(['init', f.path, '--profile', 'public'], value => output.push(value));
  const spec = loadInstallation(f.path); installationShape(spec);
  assert.equal(spec.schemaVersion, '2.0'); assert.equal(spec.configuration.enabled, false);
  for (const key of ['agent','sourceRoot','rootMappingFile']) assert.equal(Object.hasOwn(spec, key), false);
  assert.equal(existsSync(join(f.spec.stateDirectory, 'state.sqlite')), false);
  await assert.rejects(cli(['init', f.path, '--profile', 'public']), { code: 'EEXIST' });
});

test('AC29 local: Doctor collects independent Project, credentials, artifacts, SSH and broker blockers and denies startup', async t => {
  const f = publicFixture(t); f.spec.configuration.enabled = true;
  delete f.spec.credentials['secret:project']; f.spec.lock.extensions[1].integrity = 'f'.repeat(64);
  f.spec.configuration.broker = { url: 'https://broker.example.test', oidcAudience: 'labstride:test' }; f.spec.brokerListener = { port: 8789 };
  f.fail('FORBIDDEN');
  const checked = await checkInstallation(f.spec, true, { transport: f.transport, database: true });
  const result = report(true, checked.diagnostics); assert.equal(result.ok, false);
  for (const code of ['credential_unavailable','integrity_mismatch','broker_route_unavailable','runner_probe_required']) assert(result.diagnostics.some(item => item.code === code), code);
  assert(result.diagnostics.some(item => item.path.startsWith('/fields/')));
  assert(result.diagnostics.some(item => item.path.startsWith('/configuration/targets/')));
  assert.equal(JSON.stringify(result).includes('synthetic-project-token'), false);
  await assert.rejects(openOperationalRuntime(f.spec, { transport: f.transport }), /configuration_invalid/);
  assert.equal(existsSync(join(f.spec.stateDirectory, 'state.sqlite')), false);
});

test('selected personal Project credential alone qualifies field/history access; no repository token fallback', async t => {
  const f = publicFixture(t);
  const checked = await checkInstallation(f.spec, false, { transport: f.transport }); assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
  assert(f.queries.length > 0); assert(f.queries.every(call => call.authorization === 'Bearer synthetic-project-token'));
  const grants = f.spec.policy.grants; f.spec.policy.grants = [];
  const unauthorized = await checkInstallation(f.spec, false, { transport: f.transport });
  assert.equal(unauthorized.ok, false); assert(unauthorized.diagnostics.some(item => item.code === 'policy_grant_missing'));
  f.spec.policy.grants = grants;
  f.fail('INVALID_CURSOR_ARGUMENTS');
  const invalidCursor = await checkInstallation(f.spec, false, { transport: f.transport });
  assert(invalidCursor.diagnostics.some(item => item.code === 'invalid_cursor'));
  f.fail(null);
  f.spec.historyQualifications = [];
  const unqualified = await checkInstallation(f.spec, false, { transport: f.transport });
  assert.equal(unqualified.ok, false); assert(unqualified.diagnostics.some(item => item.code === 'unsupported_capability'));
});

test('malformed installation yields safe schema diagnostics; config and extension inspection omit secrets/settings', async t => {
  const f = publicFixture(t), output = []; f.write();
  const originalExit = process.exitCode; t.after(() => { process.exitCode = originalExit; });
  writeFileSync(f.path, JSON.stringify({ schemaVersion: '2.0', profile: 'public', credentials: { token: 'never-print-private-value' } }), { mode: 0o600 });
  await cli(['doctor', '--config', f.path], value => output.push(value));
  assert.equal(output[0].ok, false); assert.equal(JSON.stringify(output).includes('never-print-private-value'), false);
  f.spec.configuration.broker = { url: 'https://user:private-password@broker.example.test/?token=private-value', oidcAudience: 'labstride:test' };
  f.spec.lock.extensions[0].configuration.privateSetting = 'never-print-private-value';
  const safe = JSON.stringify([configurationView(f.spec), extensionView(f.spec)]);
  for (const secret of ['private-password','private-value','never-print-private-value', 'BEGIN PRIVATE KEY']) assert.equal(safe.includes(secret), false);
});

test('read-only CLI inspection neither initializes missing state nor migrates an older database', async t => {
  const f = publicFixture(t); f.write();
  await assert.rejects(cli(['runs', 'list', '--config', f.path]));
  assert.deepEqual(readdirSync(f.spec.stateDirectory), []);
  const file = join(f.spec.stateDirectory, 'state.sqlite'), db = new DatabaseSync(file); db.exec('PRAGMA user_version=1; CREATE TABLE preserved(value TEXT)'); db.close();
  const before = readFileSync(file);
  await assert.rejects(cli(['runs','list','--config',f.path]));
  assert.deepEqual(readFileSync(file), before); assert.deepEqual(readdirSync(f.spec.stateDirectory), ['state.sqlite']);
});

test('public config rejects unsupported workflows and mixed credential bindings before activation', t => {
  const f = publicFixture(t);
  f.spec.configuration.github.projectCredentialRef = f.spec.configuration.github.credentialRef;
  assert.throws(() => installationShape(f.spec), /separate_project_credential_required/);
  f.spec.configuration.github.projectCredentialRef = 'secret:project';
  f.spec.configuration.workflows.prepare.push({ id: 'unknown', action: 'labstride.unavailable', inputs: {} });
  assert.throws(() => installationShape(f.spec), /unsupported_workflow/);
});

const connectorModule = `export function createExtension(configuration) { return {async validate(){},async invoke(request){const response=await fetch(configuration.endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});return response.json();}};}`;
test('public installed runtime polls the Project, imports inertly, authorizes one transition and prepares one real checkout across restart', async t => {
  const workspace = workspaceFixture(t); workspace.policy.targetId = 'development';
  const registry = new WorkspaceRegistry(workspace.policy, workspace.dependencies); t.after(() => registry.close());
  const server = createServer(async (request, response) => { const chunks = []; for await (const part of request) chunks.push(part); try { const input = JSON.parse(Buffer.concat(chunks)); const value = await registry.handle(input); response.end(JSON.stringify(value)); } catch { response.statusCode = 500; response.end('{}'); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const f = publicFixture(t, { sourceSha: workspace.operation.source.sha, connectorModule, connectorConfiguration: { revision: 1, endpoint: `http://127.0.0.1:${server.address().port}` } });
  f.spec.configuration.enabled = true;
  let runtime = await openOperationalRuntime(f.spec, { transport: f.transport });
  t.after(async () => { if (runtime) await runtime.close(); });
  await runtime.tick(); assert.equal(runtime.store.runs().length, 0);
  f.change(); runtime.store.receiveGitHubWebhook(f.spec.configuration.installationId, 'fresh-project-change', 'a'.repeat(64));
  await runtime.tick(); assert.equal(runtime.store.runs().length, 1);
  const run = runtime.store.runs()[0], first = runtime.store.operations(run.id)[0];
  runtime.store.pauseRun({ schemaVersion: '1.0', id: 'public-pause', runId: run.id, expectedRevision: run.revision, command: 'pause' }, context, runtime.authority);
  await runtime.tick(); assert.equal(workspace.fetches(), 0);
  const paused = runtime.store.get('run', run.id);
  runtime.store.resumeRun({ schemaVersion: '1.0', id: 'public-resume', runId: run.id, expectedRevision: paused.revision, command: 'resume' }, context, runtime.authority);
  await runtime.tick(); await runtime.tick();
  assert.equal(runtime.store.get('operation', first.id).state, 'succeeded');
  const receipt = runtime.store.workspaceReceipt(run.id); assert.equal(existsSync(workspace.sourcePath(receipt)), true); assert.equal(workspace.fetches(), 1);
  await runtime.close(); runtime = null;
  runtime = await openOperationalRuntime(f.spec, { transport: f.transport }); await runtime.tick();
  assert.equal(runtime.store.runs().length, 1); assert.equal(runtime.store.operations(run.id)[0].id, first.id); assert.equal(workspace.fetches(), 1);
  const status = readStatus(f.spec.stateDirectory); assert.equal(status.providers.length, 1); assert.equal(status.unknownOperations, 0);
});

test('recovery CLI retains the fence across ordinary resume and reconciles original operations without another start', async t => {
  const f = publicFixture(t); f.write();
  let authority = createLocalPolicyAuthority(); let { store } = startCoordinator(f.spec.stateDirectory, { policyAuthority: authority });
  seed(store); schedule(store); store.close();
  const output = [];
  await cli(['recovery','begin','--config',f.path], value => output.push(value));
  assert.equal(output.at(-1).paused, true);
  await assert.rejects(cli(['recovery','resume','--config',f.path]), error => error.code === 'recovery_required');
  const runId = startPlan().run.id;
  await cli(['runs','resume',runId,'--config',f.path], value => output.push(value));
  assert.equal(output.at(-1).recovery.paused, true);
  authority = createLocalPolicyAuthority(); ({ store } = startCoordinator(f.spec.stateDirectory, { policyAuthority: authority }));
  let starts = 0, reads = 0;
  const op = startPlan().operation;
  const adapter = { async validate(){}, async start(){ starts++; throw Error(); }, async reconcile(request){ reads++; return { schemaVersion: '1.0', kind: 'result', operationId: request.operationId, requestDigest: request.requestDigest, result: { status: 'succeeded', handle: request.operationId, resources: [], outputs: {}, evidenceRefs: ['test:independent-observation'], error: null } }; } };
  const worker = createWorker(store, { executorId: 'recovery-test', nextAttempt: () => 'attempt', adapters: new Map([[actionKey(op.request.actionId,op.request.actionVersion), adapter]]) });
  await worker.tick(); await worker.drain();
  await observeRestoreProjections(store, join(f.root, 'restore-provider')); store.close();
  assert.equal(starts, 0); assert.equal(reads, 1);
  await cli(['recovery','resume','--config',f.path], value => output.push(value)); assert.equal(output.at(-1).paused, false);
});

test('entering recovery preserves conflicting deliveries and repeated begin preserves its original epoch', async t => {
  const f = publicFixture(t); f.write(); const { store } = startCoordinator(f.spec.stateDirectory); seed(store); schedule(store);
  const op = startPlan().operation; const claim = store.claim(op.id, 'fixture','attempt'); store.beginEffect(claim); store.markUnknown(op.id);
  store.close();
  const db = new DatabaseSync(join(f.spec.stateDirectory, 'state.sqlite')); db.prepare("UPDATE deliveries SET state='conflict' WHERE operation_id=?").run(op.id); db.close();
  const output = []; await cli(['recovery','begin','--config',f.path], value => output.push(value)); await cli(['recovery','begin','--config',f.path], value => output.push(value));
  assert.equal(output[0].epoch, output[1].epoch);
  const read = new DatabaseSync(join(f.spec.stateDirectory, 'state.sqlite'), { readOnly: true }); assert.equal(read.prepare('SELECT state FROM deliveries WHERE operation_id=?').get(op.id).state, 'conflict'); read.close();
});

test('prepared-host renderer writes configurable disabled launchers/units and the copied CLI works from an unrelated directory', t => {
  const f = publicFixture(t); f.write();
  const checkout = new URL('../', import.meta.url).pathname;
  const release = join(f.root, 'release'); mkdirSync(release); mkdirSync(join(release, 'bin'));
  copyFileSync(process.execPath, join(release, 'bin/node')); chmodSync(join(release, 'bin/node'), 0o700);
  for (const name of ['apps','packages','schemas','contracts','tools','examples','package.json']) cpSync(join(checkout, name), join(release, name), { recursive: true });
  symlinkSync(join(checkout, 'node_modules'), join(release, 'node_modules'), 'dir');
  const destination = join(f.root, 'prepared');
  const args = ['scripts/prepare_public.py','--release',release,'--configuration',f.path,'--service-user','operator_test','--destination',destination];
  const result = spawnSync('python3',args,{encoding:'utf8'}); assert.equal(result.status, 0, result.stderr);
  const unit = readFileSync(join(destination,'labstride.service'),'utf8');
  assert(unit.includes('User=operator_test')); assert(unit.includes(f.spec.stateDirectory)); assert(!unit.includes('[Install]')); assert(!unit.includes('bridge'));
  assert.notEqual(spawnSync('python3',args,{encoding:'utf8'}).status,0);
  const unrelated = join(f.root,'unrelated'); mkdirSync(unrelated);
  const show = spawnSync(join(destination,'labstride'),['config','show','--json'],{cwd:unrelated,encoding:'utf8'});
  assert.equal(show.status,0,show.stderr); assert.equal(JSON.parse(show.stdout).profile,'public');
  const version = spawnSync(join(destination,'labstride'),['version','--json'],{cwd:unrelated,encoding:'utf8'});
  assert.equal(version.status,0,version.stderr);assert.equal(JSON.parse(version.stdout).source,'development');
  writeFileSync(f.path,'{}');
  const readable = spawnSync(join(destination,'labstride'),['doctor','--human'],{cwd:unrelated,encoding:'utf8'});
  assert.equal(readable.status,1);assert(readable.stdout.startsWith('Blocked\n'));
  const init = spawnSync(join(destination,'labstride'),['init',join(unrelated,'new.json'),'--profile','public'],{cwd:unrelated,encoding:'utf8'});
  assert.equal(init.status,0,init.stderr); assert.equal(JSON.parse(readFileSync(join(unrelated,'new.json'))).configuration.enabled,false);
  assert.equal(existsSync(join(f.spec.stateDirectory,'state.sqlite')),false);
});

test('actual process death after recovery fencing retains its epoch and unresolved identities', async t => {
  const f=publicFixture(t);f.write();const {store}=startCoordinator(f.spec.stateDirectory);seed(store);schedule(store);store.close();
  const child=fork(new URL('./helpers/recovery-process.mjs',import.meta.url),[f.path],{stdio:['ignore','ignore','pipe','ipc']});
  const exited=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}});
  const saved=(await once(child,'message',{signal:AbortSignal.timeout(10000)}))[0];assert.equal(saved.paused,true);
  child.kill('SIGKILL');await exited;
  const output=[];await cli(['recovery','status','--config',f.path],value=>output.push(value));
  assert.deepEqual(output[0],saved);assert.deepEqual(saved.unresolved,[startPlan().operation.id]);
});

test('installed startup preserves an older or corrupt database instead of performing an automatic upgrade',async t=>{
  const f=publicFixture(t);f.write();const file=join(f.spec.stateDirectory,'state.sqlite');
  const db=new DatabaseSync(file);db.exec('PRAGMA user_version=1; CREATE TABLE preserve(value TEXT)');db.close();chmodSync(file,0o600);
  const original=readFileSync(file);
  await assert.rejects(cli(['state','init','--config',f.path]),error=>error.code==='unsupported_schema');
  assert.deepEqual(readFileSync(file),original);
  writeFileSync(file,'corrupt database',{mode:0o600});const corrupt=readFileSync(file);
  await assert.rejects(cli(['runs','list','--config',f.path]));assert.deepEqual(readFileSync(file),corrupt);
});
