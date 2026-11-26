import type { LabstrideInstallationConfigurationV1 as Configuration } from '../../contracts/generated/config.ts';
import type { InstalledExtensionPin } from '../../contracts/generated/extension-lock.ts';
import type { HostProfile } from '../extensions/loader.ts';
import { inspectExtension } from '../extensions/loader.ts';
import { ConfigurationError, fieldValue, invalid, own } from './values.ts';
import type { Value } from './values.ts';
import type { LabstrideOperationRequestV1 } from '../../contracts/generated/operation.ts';

export interface BindingContext {
  source?: LabstrideOperationRequestV1['source'];
  mergeSha?: string; workspaceId?: string;
}
export interface BoundStep { id: string; actionId: string; actionVersion: string; inputs: Record<string, unknown> }
type Node = unknown;
export function visitBindings(node: Node, configuration: Configuration, path: string): void {
  if (typeof node === 'string' && node.startsWith('context.')) {
    if (!['context.source', 'context.mergeSha', 'context.workspaceId'].includes(node)) invalid(path, 'Use a supported context token or an explicit literal.');
  } else if (node && typeof node === 'object') {
    const object = node as Record<string, unknown>;
    if (object.binding === 'literal') return;
    if (object.binding === 'context') return;
    if (object.binding === 'field') {
      const field=own(configuration.fields,String(object.field));
      if(!field)invalid(path,'Configure the referenced field.');
      if(object.mapping){
        if(field.type!=='single-select'||Object.keys(object.mapping as object).some(id=>!Object.values(field.options??{}).includes(id)))
          invalid(path,'Map only configured single-select option IDs to reviewed runtime values.');
      }
      return;
    }
    for (const [key, value] of Object.entries(object)) visitBindings(value, configuration, `${path}/${key}`);
  }
}
function contextValue(key: string, context: BindingContext): unknown {
  if (!Object.hasOwn(context, key) || context[key as keyof BindingContext] === undefined)
    throw new ConfigurationError('binding_invalid', '/context', 'Provide the recorded context value required by this step.');
  const value = context[key as keyof BindingContext];
  if (key === 'source') {
    const source = value as BindingContext['source'];
    if (!source || typeof source.repositoryId !== 'string' || !source.repositoryId || typeof source.repository !== 'string' ||
      !source.repository || typeof source.sha !== 'string' || !/^[a-f0-9]{40}$/.test(source.sha) ||
      Object.keys(source).some(k => !['repositoryId','repository','sha','issue'].includes(k)))
      throw new ConfigurationError('binding_invalid', '/context/source', 'Provide a validated source identity and revision.');
  } else if (typeof value !== 'string' || !value || (key === 'mergeSha' && !/^[a-f0-9]{40}$/.test(value)))
    throw new ConfigurationError('binding_invalid', '/context', 'Provide the recorded typed context value.');
  return structuredClone(value);
}
function materialize(node: Node, configuration: Configuration, fields: Record<string, { present: boolean; value?: Value }>, context: BindingContext): unknown {
  if (typeof node === 'string' && node.startsWith('context.')) return contextValue(node.slice(8), context);
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(value => materialize(value, configuration, fields, context));
  const object = node as Record<string, unknown>;
  if (object.binding === 'literal') return structuredClone(object.value);
  if (object.binding === 'context') return contextValue(String(object.context), context);
  if (object.binding === 'field') {
    const name = String(object.field), field = own(configuration.fields, name), state = own(fields, name);
    if (!field || !state?.present || state.value === undefined)
      throw new ConfigurationError('binding_invalid', '/inputs', 'Refresh the required field before binding inputs.');
    // No second pass: text retrieved from a field remains literal, including context.*.
    const value=fieldValue(field,state.value);
    if(object.mapping){
      const mapped=typeof value==='string'?own(object.mapping as Record<string,string>,value):undefined;
      if(mapped===undefined)throw new ConfigurationError('binding_invalid','/inputs','The selected option has no qualified runtime mapping.');
      return mapped;
    }
    return value;
  }
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, materialize(value, configuration, fields, context)]));
}
export function bindWorkflow(configuration: Configuration, pins: InstalledExtensionPin[], host: HostProfile,
  workflow: string, fields: Record<string, { present: boolean; value?: Value }>, context: BindingContext, stepId?: string): BoundStep[] {
  const steps = own(configuration.workflows, workflow);
  if (!steps) invalid('/workflows', 'Select a configured workflow.');
  if (stepId !== undefined && !steps.some(step => step.id === stepId)) invalid('/workflows', 'Select a configured step in this workflow.');
  // Bind only the selected step when later recorded context is not available yet.
  // A full bind validates every ordered step before returning any of them.
  return steps.filter(step => stepId === undefined || step.id === stepId).map(step => {
    const pin = pins.find(p => p.id === step.action && p.kind === 'action');
    if (!pin) invalid('/workflows', 'Install and pin the configured action.');
    const inspected = inspectExtension(pin, host);
    const inputs = materialize(step.inputs, configuration, fields, context) as Record<string, unknown>;
    inspected.check(inspected.artifact.manifest.inputSchema, inputs);
    return { id: step.id, actionId: pin.id, actionVersion: pin.version, inputs };
  });
}
