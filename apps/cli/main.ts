#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { versionInfo } from '../../packages/operations/version.ts';

function human(value: unknown): string {
  const report = value as { ok?: boolean; diagnostics?: { severity: string; code: string; path: string; message: string }[] };
  if (report?.diagnostics) return `${report.ok ? 'Ready' : 'Blocked'}\n` + report.diagnostics.map(item => `${item.severity.toUpperCase()} ${item.code} ${item.path}\n  ${item.message}`).join('\n') + '\n';
  return JSON.stringify(value, null, 2) + '\n';
}
export async function cli(argv: string[], output?: (value: unknown) => void) {
  const emit = output ?? (value => process.stdout.write(argv.includes('--human') ? human(value) : JSON.stringify(value) + '\n'));
  if (argv[0] === 'version') {
    if (!(argv.length === 1 || (argv.length === 2 && argv[1] === '--json'))) throw Error('usage');
    emit(versionInfo()); return;
  }
  const { loadInstallation, installationShape, preflight, openOperationalRuntime, openDiagnosticsOnly, initializePrivateState, backupDatabase } = await import('../../packages/operations/runtime.ts');
  const { isPublic } = await import('../../packages/operations/installation.ts');
  const { report, invalidInstallation } = await import('../../packages/operations/diagnostics.ts');
  const { configurationView, extensionView, readStatus, runView } = await import('../../packages/operations/inspection.ts');
  const { acquireServiceLock, serviceLoop } = await import('../../packages/operations/loop.ts');
  const { createLocalPolicyAuthority } = await import('../../packages/core/policy.ts');
  const { CleanupStore } = await import('../../packages/storage-sqlite/cleanup.ts');
  const { serveBridge } = await import('../../packages/operations/bridge.ts');
  const { readProtected, assertPrivateDatabase } = await import('../../packages/target-helper/filesystem.ts');
  const args = [...argv], configIndex = args.indexOf('--config');
  let path = '/etc/labstride/installation.json';
  if (configIndex >= 0) { if (!args[configIndex + 1]) throw Error('usage'); path = resolve(args[configIndex + 1]); args.splice(configIndex, 2); }
  if (args.includes('--human') && args.includes('--json')) throw Error('usage');
  for (const flag of ['--json', '--human']) { const index = args.indexOf(flag); if (index >= 0) args.splice(index, 1); }
  if (args[0] === 'init') {
    const publicProfile = args.length === 4 && args[2] === '--profile' && args[3] === 'public';
    if (!(args.length === 2 || publicProfile)) throw Error('usage');
    const example = readFileSync(new URL(publicProfile ? '../../examples/public-installation.json' : '../../examples/operational-installation.json', import.meta.url));
    writeFileSync(args[1], example, { mode: 0o600, flag: 'wx' }); emit({ schemaVersion: '1.0', enabled: false, code: 'configure_before_activation' }); return;
  }
  if (args[0] === 'bridge' && args.length === 2) {
    const bridge = await serveBridge(JSON.parse(readProtected(resolve(args[1])).toString('utf8'))), controller = new AbortController();
    const stop = () => controller.abort(); process.once('SIGTERM', stop); process.once('SIGINT', stop);
    try { await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true })); }
    finally { await bridge.close(); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); } return;
  }
  const diagnostic = args.length === 1 && args[0] === 'doctor' || args.length === 2 && args[0] === 'config' && args[1] === 'validate';
  let spec;
  try { spec = loadInstallation(path); }
  catch (error) {
    if (!diagnostic) throw error;
    let result;
    try { result = invalidInstallation(JSON.parse(readProtected(path).toString('utf8'))); } catch { /* File/JSON is unavailable. */ }
    if (!result || result.ok) result = report(false, [{ code: 'installation_unreadable', path: '/', severity: 'error', status: 'unavailable', message: 'Provide a protected readable installation file containing valid versioned JSON.' }]);
    emit(result); process.exitCode = 1; return;
  }
  if (diagnostic) {
    const checked = await preflight(spec, args[0] === 'doctor', { database: args[0] === 'doctor' });
    const result = report(spec.configuration.enabled, checked.diagnostics); emit(result); if (!result.ok) process.exitCode = 1; return;
  }
  if (args[0] === 'metrics' && args.length === 1) {
    const { operationalMetrics } = await import('../../packages/operations/metrics.ts');
    emit(operationalMetrics(spec.stateDirectory, spec.configuration.installationId)); return;
  }
  if (args[0] === 'retention' && args.length === 2 && ['--dry-run','--apply'].includes(args[1])) {
    const { retainDiagnostics } = await import('../../packages/operations/retention.ts');
    emit(await retainDiagnostics(spec, args[1] === '--apply' ? 'apply' : 'dry-run')); return;
  }
  if (args[0] === 'config' && args[1] === 'show' && args.length === 2) { emit(configurationView(spec)); return; }
  if (args[0] === 'extensions' && args[1] === 'inspect' && args.length === 2) {
    const view = extensionView(spec); emit(view); if (view.extensions.some(extension => !extension.ok)) process.exitCode = 1; return;
  }
  if (args[0] === 'backup' && args.length === 2) { await backupDatabase(spec.stateDirectory, args[1]); emit({ schemaVersion: '1.0', code: 'backup_created', restoreRequiresReconciliation: true }); return; }
  if (args[0] === 'backup' && args.length === 3 && args[1] === '--bundle') {
    const { createBackupBundle } = await import('../../packages/operations/recovery.ts'); emit(await createBackupBundle(spec, args[2])); return;
  }
  if (args[0] === 'restore' && args.length === 2) {
    const { restoreBundle } = await import('../../packages/operations/recovery.ts'); emit(await restoreBundle(spec, args[1])); return;
  }
  if (args[0] === 'upgrade' && args.length === 3 && args[1] === '--backup') {
    const { upgradeDatabase } = await import('../../packages/operations/recovery.ts'); emit(await upgradeDatabase(spec, args[2])); return;
  }
  if (args[0] === 'serve' && (args.length === 1 || args.length === 2 && ['--diagnostics-only','--reconcile-only'].includes(args[1]))) {
    const { assertNoMaintenance } = await import('../../packages/storage-sqlite/maintenance.ts'); assertNoMaintenance(spec.stateDirectory);
    const release = await acquireServiceLock(spec.stateDirectory), controller = new AbortController();
    const stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const runtime = args[1] === '--diagnostics-only' ? await openDiagnosticsOnly(spec) : await openOperationalRuntime(spec, { mode: args[1] === '--reconcile-only' ? 'reconcile-only' : 'normal' });
      await serviceLoop(runtime, controller.signal);
    } finally { await release(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); } return;
  }
  if (args[0] === 'state' && args[1] === 'init' && args.length === 2) {
    if (spec.configuration.enabled) throw Error('effect_blocked');
    assertPrivateDatabase(spec.stateDirectory, 'state.sqlite');
    const release = await acquireServiceLock(spec.stateDirectory);
    try { initializePrivateState(spec.stateDirectory); const store = new CleanupStore(spec.stateDirectory); store.close(); emit({ schemaVersion: '1.0', code: 'state_initialized' }); }
    finally { await release(); } return;
  }
  if (args[0] === 'recovery' && args.length === 2 && ['status','begin','resume'].includes(args[1])) {
    if (args[1] === 'status') { emit(readStatus(spec.stateDirectory).recovery); return; }
    readStatus(spec.stateDirectory);
    const release = await acquireServiceLock(spec.stateDirectory);
    const authority = createLocalPolicyAuthority();
    try {
      const store = new CleanupStore(spec.stateDirectory, { policyAuthority: authority });
      try {
        const context = { actorId: 'local-operator', reason: `CLI recovery ${args[1]}`, evidenceRefs: ['operator:local-file-authority'] };
        if (args[1] === 'begin') { if (!store.recoveryStatus().paused) store.enterRestore(context); }
        else store.resumeAfterRestore(context);
        emit(store.recoveryStatus());
      } finally { store.close(); }
    } finally { await release?.(); } return;
  }
  if (args[0] === 'runs') {
    const readOnly = args[1] === 'list' && args.length === 2 || args[1] === 'show' && args.length === 3;
    const valid = readOnly || ['pause','resume','cancel','reconcile','cleanup'].includes(args[1]) && args.length === 3 || args[1] === 'keep' && args.length === 4 && ['true','false'].includes(args[3]);
    if (!valid) throw Error('usage');
    readStatus(spec.stateDirectory); // Inspect without silently creating/upgrading a database.
    const authority = createLocalPolicyAuthority(), store = new CleanupStore(spec.stateDirectory, { readOnly, policyAuthority: authority, localWorkspaceRoots: isPublic(spec) ? [] : [spec.sourceRoot] });
    try {
      if (args[1] === 'list') { emit({ schemaVersion: '1.0', runs: store.runs().map(run => runView(store, run.id)) }); return; }
      if (args[1] === 'show') { emit(runView(store, args[2])); return; }
      const context = { actorId: 'local-operator', reason: `CLI ${args[1]}`, evidenceRefs: ['operator:local-file-authority'] };
      if (args[1] === 'keep') { const workspace = store.workspace(args[2]); store.setWorkspaceKeep(workspace.id, args[3] === 'true', workspace.revision, authority, context); }
      else if (args[1] === 'cleanup') store.requestCleanup(args[2], `cleanup-request-${randomUUID()}`, authority, context);
      else if (args[1] === 'reconcile') store.reconcileRunObservations(args[2], context, authority);
      else {
        const run = store.get('run', args[2]), command = args[1] as 'pause' | 'resume' | 'cancel';
        const input = { schemaVersion: '1.0' as const, id: `control:${randomUUID()}`, runId: run.id, expectedRevision: run.revision, command };
        if (command === 'pause') store.pauseRun(input, context, authority);
        else if (command === 'resume') store.resumeRun(input, context, authority);
        else store.cancelRun(input, context, authority);
      }
      emit(runView(store, args[2])); return;
    } finally { store.close(); }
  }
  throw Error('usage');
}
export function safeCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message : '';
  return new Set(['usage','release_metadata_invalid','release_metadata_unreadable','configuration_invalid','effect_blocked','recovery_required','identity_conflict','revision_conflict','invalid_transition','not_found','storage_failure','unsupported_schema','unsafe_state_path','service_lock_present','service_lock_unavailable','backup_exists','backup_invalid','restore_destination_occupied','maintenance_incomplete','migration_failed','installation_binding_invalid','broker_configuration_invalid','probe_policy_missing','probe_policy_mismatch','forbidden']).has(code) ? code : 'operation_failed';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  cli(process.argv.slice(2)).catch(error => { process.stderr.write(JSON.stringify({ schemaVersion: '1.0', code: safeCode(error) }) + '\n'); process.exitCode = 1; });
}
