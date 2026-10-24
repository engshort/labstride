import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readProtected } from '../target-helper/filesystem.ts';
import { createRequire, isBuiltin, registerHooks } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { validated } from '../storage-sqlite/validation.ts';
import { digest } from '../storage-sqlite/execution.ts';
import type { ExtensionLock } from '../../contracts/generated/extension-lock.ts';
import type { RunExtensionProfile } from '../../contracts/generated/extension-profile.ts';
import type { InstalledExtensionArtifact } from '../../contracts/generated/extension-artifact.ts';

export type Pin = ExtensionLock['extensions'][number];
export type Profile = RunExtensionProfile;
export class ExtensionError extends Error {
  readonly code: string;
  constructor(code: 'configuration_invalid' | 'integrity_mismatch' | 'identity_mismatch' |
    'unsupported_capability' | 'forbidden' | 'validation_failed' | 'artifact_unavailable') { super(code); this.code = code; }
}
export interface HostProfile { protocol: { major: number; minor: number }; capabilities: string[]; permissions: string[]; artifactDirectory?: string }
const sources = new Set<string>();
const addFormats: FormatsPlugin = createRequire(import.meta.url)('ajv-formats');
// Restrict module resolution for the verified bundles. This is not a sandbox for trusted extension code.
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && sources.has(context.parentURL) && !(specifier.startsWith('node:') && isBuiltin(specifier)))
    throw new ExtensionError('forbidden');
  return next(specifier, context);
} });
function localSchema(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (['$id', '$async', '$dynamicRef', '$recursiveRef'].includes(key) || (key === '$ref' && (typeof item !== 'string' || !item.startsWith('#'))))
      throw new ExtensionError('configuration_invalid');
    localSchema(item);
  }
}
export function readLock(path: string): ExtensionLock {
  const lock = validated<ExtensionLock>('extension-lock', JSON.parse(readFileSync(path, 'utf8')));
  if (new Set(lock.extensions.map(pin => pin.id)).size !== lock.extensions.length) throw new ExtensionError('identity_mismatch');
  return lock;
}
export function readPinnedArtifact(pin: Pin, artifactDirectory?: string): Buffer {
  validated('extension-lock', { schemaVersion: '1.0', extensions: [pin] });
  if (!isAbsolute(pin.artifactPath)) throw new ExtensionError('configuration_invalid');
  let bytes: Buffer;
  let retained: Buffer | undefined;
  if (artifactDirectory) {
    try { retained = readProtected(join(artifactDirectory, pin.integrity + '.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ExtensionError('artifact_unavailable'); }
  }
  try {
    if (retained) bytes = retained;
    else {
      const fd = openSync(pin.artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 262144) throw new Error();
        const buffer = Buffer.alloc(262145);
        let count = 0;
        while (count < buffer.length) {
          const read = readSync(fd, buffer, count, buffer.length - count, null);
          if (!read) break;
          count += read;
        }
        if (count > 262144) throw new Error();
        bytes = buffer.subarray(0, count);
      } finally { closeSync(fd); }
    }
  } catch { throw new ExtensionError('artifact_unavailable'); }
  if (createHash('sha256').update(bytes).digest('hex') !== pin.integrity) throw new ExtensionError('integrity_mismatch');
  const artifact = validated<InstalledExtensionArtifact>('extension-artifact', JSON.parse(bytes.toString('utf8')));
  const manifest = artifact.manifest;
  if (manifest.entrypoint !== 'module') throw new ExtensionError('configuration_invalid');
  if (manifest.id !== pin.id || manifest.version !== pin.version || manifest.kind !== pin.kind) throw new ExtensionError('identity_mismatch');
  return bytes;
}
export function inspectExtension(pin: Pin, host: HostProfile) {
  if (!Number.isSafeInteger(host.protocol.major) || host.protocol.major !== 1 || !Number.isSafeInteger(host.protocol.minor) ||
    host.protocol.minor < 0 || host.protocol.minor > 65535 || [host.capabilities, host.permissions].some(list =>
      !Array.isArray(list) || list.some(x => typeof x !== 'string' || !x))) throw new ExtensionError('configuration_invalid');
  const artifact = validated<InstalledExtensionArtifact>('extension-artifact', JSON.parse(readPinnedArtifact(pin, host.artifactDirectory).toString('utf8')));
  const manifest = artifact.manifest;
  if (manifest.protocol.major !== host.protocol.major) throw new ExtensionError('unsupported_capability');
  if (manifest.requiredCapabilities.some(c => !host.capabilities.includes(c)) ||
    pin.capabilities.some(c => !manifest.capabilities.includes(c))) throw new ExtensionError('unsupported_capability');
  if (manifest.permissions.some(p => !pin.permissions.includes(p) || !host.permissions.includes(p))) throw new ExtensionError('forbidden');
  const validators = new Map<string, ReturnType<Ajv2020['compile']>>();
  for (const [key, schema] of Object.entries(artifact.schemas)) {
    localSchema(schema);
    const ajv = new Ajv2020({ strict: true }); addFormats(ajv, { mode: 'full' });
    validators.set(key, ajv.compile(schema));
  }
  for (const key of [manifest.inputSchema, manifest.outputSchema, 'configuration'])
    if (!validators.has(key)) throw new ExtensionError('configuration_invalid');
  const check = (key: string, value: unknown) => {
    if (!validators.get(key)?.(value)) throw new ExtensionError('validation_failed');
  };
  check('configuration', pin.configuration);
  return { artifact, check, protocol: { major: 1 as const, minor: Math.min(host.protocol.minor, manifest.protocol.minor) },
    capabilities: [...pin.capabilities].sort() };
}
export function freezeProfile(runId: string, configRevision: string, pin: Pin, host: HostProfile): Profile {
  const inspected = inspectExtension(pin, host);
  return validated<Profile>('extension-profile', { schemaVersion: '1.0', runId, configRevision, pin: structuredClone(pin),
    protocol: inspected.protocol, capabilities: inspected.capabilities });
}
export async function loadExtension(profile: Profile, host: HostProfile, services?: object) {
  profile = validated('extension-profile', profile);
  const inspected = inspectExtension(profile.pin, host);
  if (digest(inspected.protocol) !== digest(profile.protocol) || digest(inspected.capabilities) !== digest(profile.capabilities))
    throw new ExtensionError('identity_mismatch');
  const url = `data:text/javascript;base64,${Buffer.from(inspected.artifact.module).toString('base64')}`;
  sources.add(url);
  const module = await import(url) as { createExtension?: (configuration: object, services?: object) => unknown };
  if (typeof module.createExtension !== 'function') throw new ExtensionError('validation_failed');
  return { profile, checkInput: (input: unknown) => inspected.check(inspected.artifact.manifest.inputSchema, input),
    checkOutput: (output: unknown) => inspected.check(inspected.artifact.manifest.outputSchema, output),
    instance: module.createExtension(structuredClone(profile.pin.configuration), services) };
}
