import { join } from 'node:path';
import type { OperationalInstallationV1 } from '../../contracts/generated/operational-installation.ts';
import type { PublicInstallationV2 } from '../../contracts/generated/public-installation.ts';
import { GitHubAdapter } from '../provider-github/adapter.ts';
import { GitHubIssueFieldsAdapter } from '../provider-github/issue-fields.ts';
import { GitHubClient } from '../provider-github/client.ts';
import { credentialResolver, GitHubRest } from './github.ts';
import { validated } from '../storage-sqlite/validation.ts';
import { readProtected, rootIdentity, sameIdentity } from '../target-helper/filesystem.ts';
import { assertSeparate } from '../storage-sqlite/paths.ts';
import { digest } from '../configuration/json.ts';

export type Installation = OperationalInstallationV1 | PublicInstallationV2;
export function isPublic(spec: Installation): spec is PublicInstallationV2 { return spec.schemaVersion === '2.0'; }
export function loadInstallation(path: string): Installation {
  const value = JSON.parse(readProtected(path).toString('utf8'));
  return validated(value?.schemaVersion === '2.0' ? 'public-installation' : 'operational-installation', value) as Installation;
}
export function installationShape(spec: Installation) {
  if (isPublic(spec)) { publicShape(spec); return; }
  validated('operational-installation', spec); assertSeparate(spec.stateDirectory, spec.sourceRoot);
  const config = spec.configuration, selfBuild = spec.lock.extensions.find(pin => pin.id === 'labstride.self-build');
  const workflows = Object.values(config.workflows).flat().some(step => step.action === 'labstride.github-workflow');
  const merges = Object.values(config.workflows).flat().some(step => step.action === 'labstride.github-merge');
  if (merges && spec.mergeEnabled !== true) throw Error('merge_not_enabled');
  if ((spec.brokerListener && config.broker.enabled === false) || (workflows && !spec.brokerListener)) throw Error('broker_configuration_invalid');
  const expected = { agent: spec.agent, sourceRoot: spec.sourceRoot, rootId: spec.rootId, baseBranch: spec.baseBranch, requiredWorkflows: spec.requiredWorkflows };
  if (!selfBuild || digest(selfBuild.configuration) !== digest(expected) || config.installationId !== spec.policy.installationId ||
    !config.github.repositories.every(repository => spec.policy.repositories.some(entry => entry.name === repository))) throw Error('installation_binding_invalid');
  const fields = config.fields;
  if (['request', 'aiMode', 'model', 'reasoning', 'session', 'path'].some(name => fields[name]?.source !== 'organization_issue_field') ||
    new Set(['request', 'aiMode', 'model', 'reasoning', 'session', 'path'].map(name => fields[name].fieldId)).size !== 6) throw Error('installation_binding_invalid');
  for (const name of ['aiMode', 'model', 'reasoning'] as const) {
    const defaultId = spec.agent.defaults[name];
    if (!Object.values(fields[name].options ?? {}).includes(defaultId) || !Object.hasOwn(spec.agent.runtimeValues[name], defaultId)) throw Error('agent_default_invalid');
    const projection = config.projections.find(entry => entry.fact === `self-build.default-${name}`);
    if (!projection || projection.field !== name || fields[name].options?.[String(projection.value)] !== defaultId) throw Error('agent_default_invalid');
  }
}
export function installationHost(spec: Installation) { return { ...spec.host, artifactDirectory: join(spec.stateDirectory, 'artifacts') }; }
export function installationDependencies(spec: Installation, transport: typeof fetch = fetch) {
  const credential = credentialResolver(spec, transport), client = new GitHubClient({ credential, fetch: transport, requestsPerTick: 256 });
  const options = { configuration: spec.configuration, client, historyQualifications: spec.historyQualifications };
  const adapter = isPublic(spec) ? new GitHubAdapter({ ...options, providerId: 'labstride.github.project' }) : new GitHubIssueFieldsAdapter({ ...options, providerId: 'labstride.github.native' });
  const rest = new GitHubRest(credential, spec.configuration.github.credentialRef, transport);
  const compiler = { lock: spec.lock, host: installationHost(spec), secrets: { exists: (reference: string) => Boolean(spec.credentials[reference]) }, provider: adapter };
  return { credential, client, adapter, rest, compiler };
}
export function verifyRootMapping(spec: Pick<OperationalInstallationV1, 'sourceRoot' | 'targetId' | 'rootId'>, mapping: any, input: unknown) {
  const proof = validated('ssh-workspace-response', input as import('../../contracts/generated/ssh-workspace-response.ts').TrustedWorkspaceHelperResponseV2);
  const root = proof.roots?.find(root => root.id === spec.rootId);
  if (mapping.schemaVersion !== '1.0' || mapping.sourceRoot !== spec.sourceRoot || mapping.targetId !== spec.targetId || mapping.rootId !== spec.rootId ||
    proof.outcome !== 'ok' || proof.method !== 'probe' || proof.targetId !== spec.targetId || !(proof.capabilities as readonly string[]).includes('workspace.root-map.v1') ||
    !root || root.path !== spec.sourceRoot || !sameIdentity(root.identity, mapping.identity)) throw Error('root_mapping_mismatch');
  // The authenticated helper checks the FULL mount identity in the target's
  // namespace. A systemd sandbox sees another mount ID for that same inode.
  const local = rootIdentity(spec.sourceRoot, mapping.identity.uid);
  if (local.device !== root.identity.device || local.inode !== root.identity.inode || local.uid !== root.identity.uid) throw Error('root_mapping_mismatch');
}

export function publicShape(spec: PublicInstallationV2): void {
  validated('public-installation', spec);
  const config = spec.configuration;
  if (config.installationId !== spec.policy.installationId ||
    !config.github.repositories.every(name => spec.policy.repositories.some(repository => repository.name === name))) throw Error('installation_binding_invalid');
  if (config.github.credentialRef === config.github.projectCredentialRef) throw Error('separate_project_credential_required');
  if (Object.values(config.fields).some(field => !['project_v2','native_issue','native_pr'].includes(field.source))) throw Error('unsupported_field_source');
  if (!spec.lock.extensions.some(pin => pin.id === 'labstride.github.project' && pin.kind === 'provider')) throw Error('provider_unavailable');
  const supported = new Set(['labstride.workspace-create','labstride.target-reserve','labstride.runtime-create','labstride.github-workflow','labstride.github-merge']);
  for (const steps of Object.values(config.workflows)) {
    if (!steps.length || steps[0].action !== 'labstride.workspace-create' || steps.some(step => !supported.has(step.action))) throw Error('unsupported_workflow');
  }
  const workflows = Object.values(config.workflows).flat().some(step => step.action === 'labstride.github-workflow');
  const merges = Object.values(config.workflows).flat().some(step => step.action === 'labstride.github-merge');
  if (merges && !spec.mergeEnabled) throw Error('merge_not_enabled');
  if ((spec.brokerListener && config.broker.enabled === false) || (workflows && !spec.brokerListener)) throw Error('broker_configuration_invalid');
  if (spec.brokerProbe && (config.broker.enabled === false || spec.brokerProbe.policy.audience !== config.broker.oidcAudience ||
    !config.github.repositories.includes(spec.brokerProbe.policy.repository))) throw Error('probe_policy_mismatch');
}
