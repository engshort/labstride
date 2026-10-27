import { lstatSync } from 'node:fs';
import { compileConfiguration } from '../configuration/compiler.ts';
import { inspectExtension, loadExtension, freezeProfile } from '../extensions/loader.ts';
import { workspaceTargetResolver } from '../connector-ssh/workspaces.ts';
import { readProtected } from '../target-helper/filesystem.ts';
import { validated, validationIssues } from '../storage-sqlite/validation.ts';
import { BridgeClient } from './bridge.ts';
import { isPublic, installationHost, installationDependencies, installationShape, verifyRootMapping } from './installation.ts';
import type { Installation } from './installation.ts';
import type { OperatorDiagnosticReportV1 } from '../../contracts/generated/diagnostic-report.ts';
import { brokerReachable, probeReady } from './runner-probe.ts';
import { readStatus } from './inspection.ts';
import type { ExecutionMode } from '../core/execution.ts';

export type Finding = OperatorDiagnosticReportV1['diagnostics'][number];
const known = new Set(['credential_unavailable','credential_expired','permission_denied','provider_unavailable','invalid_cursor','graphql_errors',
  'unsupported_capability','integrity_mismatch','artifact_unavailable','identity_mismatch','forbidden','configuration_invalid','validation_failed',
  'installation_binding_invalid','separate_project_credential_required','unsupported_field_source','unsupported_workflow','merge_not_enabled',
  'broker_configuration_invalid','probe_policy_mismatch','provider_unavailable','backend_version_mismatch','agent_default_unsupported',
  'agent_default_invalid','root_mapping_mismatch','target_unavailable','transport_unknown','rate_limited','budget_exhausted','unsafe_state_path',
  'unsupported_schema','storage_failure','recovery_required','effect_blocked','service_lock_present','service_lock_unavailable','usage','not_found',
  'backup_exists','backup_invalid','restore_destination_occupied','maintenance_incomplete','migration_failed','release_metadata_invalid','release_metadata_unreadable','operation_failed','identity_conflict','revision_conflict','invalid_transition']);
export function diagnosticCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message : '';
  return known.has(code) ? code : code === 'ENOENT' ? 'missing_file' : 'operation_failed';
}
export function report(enabled: boolean, diagnostics: Finding[]): OperatorDiagnosticReportV1 {
  return validated('diagnostic-report', { schemaVersion: '1.0', ok: !diagnostics.some(item => item.severity === 'error'), enabled, diagnostics });
}
export function invalidInstallation(value: unknown): OperatorDiagnosticReportV1 {
  const name = value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === '2.0' ? 'public-installation' : 'operational-installation';
  return report(false, validationIssues(name, value).map(issue => ({ code: 'configuration_invalid', path: issue.path,
    severity: 'error', status: 'unavailable', message: `Correct the installation schema (${issue.keyword}); rejected values are omitted.` })));
}
export async function checkInstallation(spec: Installation, runtime = true, options: {
  mode?: ExecutionMode;
  route?: boolean; dependencies?: ReturnType<typeof installationDependencies>; transport?: typeof fetch;
  targetProbe?: (id: string) => Promise<unknown>; catalog?: () => Promise<any>; database?: boolean;
} = {}) {
  const diagnostics: Finding[] = [];
  const add = (code: string, path: string, message: string, severity: Finding['severity'] = 'error', status: Finding['status'] = 'unavailable') => diagnostics.push({ code, path, message, severity, status });
  try { installationShape(spec); } catch (error) { add(diagnosticCode(error), '/', 'Correct installation/profile bindings, separate credentials and supported workflow capabilities before enablement.'); }
  // Schema rejection must precede construction of any dependencies or network effects.
  try { validated(isPublic(spec) ? 'public-installation' : 'operational-installation', spec); }
  catch { return { ok: false as const, diagnostics: invalidInstallation(spec).diagnostics }; }
  if (options.mode === 'reconcile-only') {
    if (!isPublic(spec)) add('configuration_invalid', '/profile', 'Reconciliation-only startup requires the public v2 installation profile.');
    try {
      const status = readStatus(spec.stateDirectory, spec.configuration.installationId);
      if (!status.recovery.paused) throw Error('recovery_required');
      add('reconciliation_only', '/stateDirectory', 'The existing recovery fence permits original receipts and independent reads only. Stop this service before recovery resume.', 'info', 'observed');
    } catch (error) { add(diagnosticCode(error), '/stateDirectory', 'Use an existing healthy database for this installation and run recovery begin while the service is stopped.'); }
  }
  const dependencies = options.dependencies ?? installationDependencies(spec, options.transport);
  for (const [reference, binding] of Object.entries(spec.credentials)) {
    try {
      const file = typeof binding === 'string' ? binding : binding.keyFile;
      const bytes = readProtected(file, process.getuid!(), 262144);
      if (!bytes.length || lstatSync(file).mode & 0o077) throw Error('credential_unavailable');
      add('credential_file_available', `/credentials/${reference}`, 'Protected credential material is available; provider checks establish authorization.', 'info', 'observed');
    } catch (error) { add(diagnosticCode(error), `/credentials/${reference}`, 'Provision this selected credential as a private file readable by the coordinator identity.'); }
  }
  for (const reference of new Set([spec.configuration.github.credentialRef, spec.configuration.github.projectCredentialRef])) {
    if (!spec.credentials[reference]) add('credential_unavailable', '/credentials', 'Provision both selected repository and Project credential references; no identity fallback is used.');
  }
  if (isPublic(spec)) for (const [workflow, steps] of Object.entries(spec.configuration.workflows)) {
    for (const step of steps) {
      const target = step.inputs.target;
      const pin = spec.lock.extensions.find(pin => pin.id === step.action);
      const repositoryIds = spec.policy.repositories.map(repository => repository.id);
      if (typeof target !== 'string' || !spec.configuration.targets[target] || !pin || repositoryIds.some(repositoryId =>
        !spec.policy.grants.some(grant => grant.repositoryId === repositoryId && grant.targetId === target && grant.actionId === pin.id && grant.actionVersion === pin.version && grant.effects.includes('execute')))) {
        add('policy_grant_missing', `/configuration/workflows/${workflow}/${step.id}`, 'Use a configured literal target and publish an explicit execute grant for every selected repository/action/version/target.');
      }
    }
  }
  if (isPublic(spec)) {
    const workflowPin = spec.lock.extensions.find(pin => pin.id === 'labstride.github-workflow');
    const enrollments = workflowPin?.configuration.enrollments;
    if (enrollments && typeof enrollments === 'object' && Object.values(enrollments).some(value => value && typeof value === 'object' && 'deployment' in value)) {
      add('unsupported_capability', '/extensions/labstride.github-workflow', 'This installed profile has no registered independent deployment observer. Use a qualified runtime integration before enabling deployment verification.');
    }
  }
  const compilation = await compileConfiguration(spec.configuration, dependencies.compiler);
  if (!compilation.ok) for (const item of compilation.diagnostics) add(item.code, item.path, item.message);
  else for (const [name, binding] of Object.entries(compilation.configuration.snapshot.bindings)) {
    add('field_binding_verified', `/fields/${name}`, `Stable field/option IDs resolved with selected credentials. Writable: ${binding.writable}; transition history: ${binding.history}; actor attribution: ${binding.actorAttribution}.`, 'info', 'observed');
  }
  for (const pin of spec.lock.extensions) {
    try { inspectExtension(pin, installationHost(spec)); add('extension_verified', `/extensions/${pin.id}`, 'Pinned bytes, protocol, permissions and declared capabilities match.', 'info', 'observed'); }
    catch (error) { add(diagnosticCode(error), `/extensions/${pin.id}`, 'Provide the reviewed artifact and exact integrity pin, granting only its required permissions and capabilities.'); }
  }
  if (compilation.ok) try {
    const id = isPublic(spec) ? 'labstride.github.project' : 'labstride.github.native';
    const pin = spec.lock.extensions.find(pin => pin.id === id); if (!pin) throw Error('provider_unavailable');
    await loadExtension(freezeProfile('preflight', compilation.configuration.snapshot.digest, pin, installationHost(spec)), installationHost(spec), { githubReader: dependencies.adapter });
  } catch (error) { add(diagnosticCode(error), '/extensions', 'Verify the selected provider artifact and capability contract.'); }
  if (runtime) {
    try { await dependencies.rest.installationRepositories(spec.policy.repositories.map(repository => repository.id));
      add('repository_scope_verified', '/configuration/github/credentialRef', 'The selected installation grants access to exactly the configured repositories.', 'info', 'observed'); }
    catch (error) { add(diagnosticCode(error), '/configuration/github/credentialRef', 'Use a dedicated App installation on exactly the configured repositories with the required grants.'); }
    for (const [id, target] of Object.entries(spec.configuration.targets)) {
      if (target.connector !== 'labstride.connector.ssh') continue;
      try {
        const pin = spec.lock.extensions.find(pin => pin.id === target.connector); if (!pin) throw Error('target_unavailable');
        const connector = options.targetProbe ? null : await workspaceTargetResolver(installationHost(spec)).resolve(freezeProfile('preflight', compilation.ok ? compilation.configuration.snapshot.digest : '0'.repeat(64), { ...pin, configuration: target.configuration }, installationHost(spec)));
        const raw = options.targetProbe ? await options.targetProbe(id) : await connector!.invoke({ schemaVersion: '2.0', requestId: 'preflight', installationId: spec.configuration.installationId,
          targetId: id, targetRevision: target.configuration.revision as number, method: 'probe', includeRoots: true });
        const response = validated('ssh-workspace-response', raw as import('../../contracts/generated/ssh-workspace-response.ts').TrustedWorkspaceHelperResponseV2);
        if (response.method !== 'probe' || response.requestId !== 'preflight' || response.outcome !== 'ok' || response.targetId !== id || response.installationId !== spec.configuration.installationId || response.targetRevision !== target.configuration.revision ||
          !['workspace.create.v1','workspace.inspect.v1'].every(capability => response.capabilities.some(actual => actual === capability))) throw Error('target_unavailable');
        const requiredRoots = Object.values(spec.configuration.workflows).flat().filter(step => step.action === 'labstride.workspace-create' && step.inputs.target === id).map(step => step.inputs.rootId);
        if (requiredRoots.some(root => typeof root !== 'string' || !response.roots?.some(entry => entry.id === root))) throw Error('root_mapping_mismatch');
        if (!isPublic(spec) && id === spec.targetId) verifyRootMapping(spec, JSON.parse(readProtected(spec.rootMappingFile).toString('utf8')), response);
        add('ssh_target_verified', `/configuration/targets/${id}`, 'Enrolled SSH trust, helper identity, configured roots and workspace capabilities responded.', 'info', 'observed');
      } catch (error) { add(diagnosticCode(error), `/configuration/targets/${id}`, 'Check the enrolled host key, SSH identity, forced helper, target revision, owned roots and declared capabilities. Never auto-accept a changed key.'); }
    }
    if (!isPublic(spec)) {
      try {
        const catalog = options.catalog ? await options.catalog() : await new BridgeClient(spec.agent.bridgeSocket).call({ schemaVersion: '1.0', method: 'catalog' });
        if (catalog.backendVersion !== spec.agent.backendVersion) throw Error('backend_version_mismatch');
        const model = spec.agent.runtimeValues.model[spec.agent.defaults.model], reasoning = spec.agent.runtimeValues.reasoning[spec.agent.defaults.reasoning];
        if (!catalog.models?.some((entry: any) => entry.model === model && entry.reasoning.includes(reasoning))) throw Error('agent_default_unsupported');
        add('session_catalog_observed', '/agent', 'Backend version and model catalog responded. This does not verify authentication, client continuity or atomic human guards.', 'info', 'observed');
      } catch (error) { add(diagnosticCode(error), '/agent', 'Verify the enrolled bridge/backend identity, runtime authentication and configured model/reasoning availability.'); }
      add('session_continuity_unverified', '/agent', 'Interactive continuity requires the enrolled-client proof; catalog success cannot pass that gate.', 'warning', 'unavailable');
      add('session_hooks_disabled', '/agent', 'Hooks are optional. The checked pilot uses bounded backend observation and reconciliation; atomic send guards remain unsupported.', 'info', 'disabled');
    } else add('session_disabled', '/profile', 'Public operation needs no agent or hooks. Project polling and operation reconciliation provide observations.', 'info', 'disabled');
    if (spec.configuration.broker.enabled === false) add('broker_disabled', '/configuration/broker', 'Outbound polling is available; workflow execution requires an enabled and qualified broker.', 'info', 'disabled');
    else if (isPublic(spec)) {
      try { if (options.route !== false && !await brokerReachable(spec, options.transport)) throw Error('broker_configuration_invalid');
        add(options.route === false ? 'broker_route_unchecked' : 'broker_https_observed', '/configuration/broker/url', options.route === false ? 'Startup uses bound runner evidence; Doctor separately checks the HTTPS route.' : 'HTTPS reached this installation diagnostic listener; this alone does not qualify runner authentication.', 'info', options.route === false ? 'unavailable' : 'observed'); }
      catch { add('broker_route_unavailable', '/configuration/broker/url', 'Route the configured HTTPS origin to the loopback broker diagnostics endpoint and preserve TLS verification. Start the disabled diagnostics-only listener first.'); }
      if (!probeReady(spec)) add('runner_probe_required', '/brokerProbe', 'Enroll an exact disposable workflow/run policy, then run the signed OIDC diagnostic client through this broker route. Current matching evidence is required for normal operation.', options.mode === 'reconcile-only' ? 'warning' : 'error');
    }
  }
  if (options.database) {
    try {
      const status = readStatus(spec.stateDirectory);
      if (status.recovery.paused) add('recovery_required', '/stateDirectory', 'Recovery is fenced. Reconcile unresolved operations, sessions and projections before recovery resume.', options.mode === 'reconcile-only' ? 'info' : 'error');
      if (status.projections.pending || status.projections.blocked || status.projections.conflict) add('projection_backlog', '/stateDirectory', 'Inspect run projection identities and blockers; reconcile observations without overwriting manual values.', 'warning', 'observed');
      if (!status.providers.length) add('provider_observations_missing', '/stateDirectory', 'No provider observation is recorded yet. Initial import must establish an inert baseline.', 'warning', 'unavailable');
      if (status.providers.some(provider => provider.lastError || provider.catchupPending || provider.overdue)) add('provider_observation_backlog', '/stateDirectory', 'Inspect provider errors and catch-up state. Invalid cursors and partial errors do not establish successful recovery.', 'warning', 'observed');
      if (status.providers.some(provider => provider.blockedItems > 0)) add('provider_items_blocked', '/stateDirectory', 'Individual items retain provider/history diagnostics. Other items may continue. Explicit rebaseline requires a stopped coordinator, no prior request for the item, and a later fresh authorized transition.', 'warning', 'observed');
      if (status.unknownOperations) add('outcome_unknown', '/stateDirectory', 'Preserve original identities and reconcile external results; an absent reply grants no replay.', 'warning', 'observed');
      add('database_verified', '/stateDirectory', 'Current SQLite schema/checksums and integrity were read without migration.', 'info', 'observed');
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      add(missing ? 'database_uninitialized' : diagnosticCode(error), '/stateDirectory', missing ? 'Prepare a private state directory. The first normal serve initializes SQLite after successful preflight.' : 'Check state ownership, SQLite integrity and supported schema. Back up before an explicit upgrade.', missing ? 'warning' : 'error');
    }
  }
  const ok = !diagnostics.some(item => item.severity === 'error');
  if (!ok || !compilation.ok) return { ok: false as const, diagnostics };
  return { ok: true as const, ...dependencies, compiled: compilation.configuration, diagnostics };
}
