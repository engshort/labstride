import { loadExtension, freezeProfile, ExtensionError } from '../extensions/loader.ts';
import type { HostProfile, Profile } from '../extensions/loader.ts';
import type { RecordOf } from '../core/lifecycle.ts';
import type { ActionAdapter, BoundResult } from '../core/execution.ts';
import type { ConfigurationSnapshot } from '../configuration/snapshot.ts';
import { checkedSnapshot } from '../configuration/snapshot.ts';
import { validated } from '../storage-sqlite/validation.ts';
import { digest } from '../storage-sqlite/execution.ts';
import { workspaceIdentity, workspaceAction, workspaceVersion } from '../target-helper/workspace-contracts.ts';
import type { WorkspaceRequest, WorkspaceResponse } from '../target-helper/workspace-contracts.ts';
import { TargetError } from '../target-helper/filesystem.ts';
export interface WorkspaceConnector {
  validate(request:WorkspaceRequest):Promise<void>;
  invoke(request:WorkspaceRequest):Promise<WorkspaceResponse>;
}
export function workspaceTargetResolver(host:HostProfile) {
  const instances=new Map<string,Promise<WorkspaceConnector>>();
  return {resolve(profile:Profile):Promise<WorkspaceConnector> {
    const key=digest(profile);let instance=instances.get(key);
    if(!instance) {
      instance=(async()=>{
        if(profile.pin.id!=='labstride.connector.ssh'||profile.pin.kind!=='connector')throw new ExtensionError('identity_mismatch');
        const loaded=await loadExtension(profile,host),raw=loaded.instance as WorkspaceConnector;
        if(typeof raw?.validate!=='function'||typeof raw?.invoke!=='function')throw new ExtensionError('validation_failed');
        const safe=(error:unknown):never=>{
          const message=error instanceof Error?error.message:'';
          const code=['validation_failed','forbidden','identity_mismatch','configuration_invalid','unsupported_capability','resource_busy','outcome_unknown','operation_failed','authentication_failed','transient_unavailable'].includes(message)?message as TargetError['code']:'validation_failed';
          throw new TargetError(code);
        };
        const validate=async(request:WorkspaceRequest)=>{
          validated('ssh-workspace-request',request);loaded.checkInput(request);
          if(!profile.capabilities.includes(`workspace.${request.method}.v1`))throw new ExtensionError('unsupported_capability');
          try{await raw.validate(request);}catch(error){safe(error);}
        };
        return {validate,async invoke(request:WorkspaceRequest) {
          await validate(request);let response;
          try{response=await raw.invoke(structuredClone(request));}catch(error){safe(error);}
          const reply=validated<WorkspaceResponse>('ssh-workspace-response',response!);loaded.checkOutput(reply);
          for(const field of ['schemaVersion','requestId','installationId','targetId','targetRevision','method'] as const)
            if(reply[field]!==request[field])throw new ExtensionError('identity_mismatch');
          const receipt=reply.workspace,op=request.operation;
          if(receipt&&op) {
            const expected={...workspaceIdentity(request.installationId,request.targetId,op.workspaceId,op.source.issue),installationId:request.installationId,
              targetId:request.targetId,targetRevision:request.targetRevision,runId:op.runId,workspaceId:op.workspaceId,
              operationId:op.operationId,handle:op.operationId,requestDigest:op.requestDigest,rootId:op.inputs.rootId,source:op.source};
            for(const field of Object.keys(expected) as (keyof typeof expected)[])
              if(digest(receipt[field])!==digest(expected[field]))throw new ExtensionError('identity_mismatch');
          }
          return {...reply,capabilities:reply.capabilities.filter(capability=>profile.capabilities.includes(capability)) as WorkspaceResponse['capabilities']};
        }};
      })();
      instances.set(key,instance);instance.catch(()=>instances.delete(key));
    }
    return instance;
  }};
}
export function configuredWorkspaceAction(store:{runConfiguration(runId:string):ConfigurationSnapshot|null},host:HostProfile):ActionAdapter {
  const connectors=workspaceTargetResolver(host),actions=new Map<string,Promise<ActionAdapter>>();
  const binding=async(op:RecordOf<'operation'>['request'])=>{
    const saved=store.runConfiguration(op.runId);if(!saved)throw new ExtensionError('configuration_invalid');
    const snapshot=checkedSnapshot(saved),target=snapshot.configuration.targets[op.targetId];
    const connector=snapshot.extensionLock.extensions.find(pin=>pin.id===target?.connector&&pin.kind==='connector');
    const action=snapshot.extensionLock.extensions.find(pin=>pin.id===op.actionId&&pin.version===op.actionVersion&&pin.kind==='action');
    if(op.configDigest!==snapshot.digest || op.actionId!==workspaceAction || op.actionVersion!==workspaceVersion || !target || !connector || !action)
      throw new ExtensionError('identity_mismatch');
    validated('workspace-create-input',op.inputs);
    if(op.inputs.target!==op.targetId || digest(op.inputs.source)!==digest(op.source))throw new ExtensionError('identity_mismatch');
    const revision=target.configuration.revision;if(typeof revision!=='number')throw new ExtensionError('configuration_invalid');
    const profile=freezeProfile(op.runId,snapshot.digest,{...connector,configuration:target.configuration},host);
    return {installationId:snapshot.configuration.installationId,revision,profile,action,snapshot};
  };
  const resolve=async(op:RecordOf<'operation'>['request'])=>{
    const original=await binding(op),key=digest([op.runId,original.action]);let action=actions.get(key);
    if(!action) {
      action=(async()=>{
        const target={
          async binding(operation:RecordOf<'operation'>['request']) {const b=await binding(operation);return{installationId:b.installationId,revision:b.revision};},
          async validate(request:WorkspaceRequest) {
            const b=await binding(request.operation!),connector=await connectors.resolve(b.profile);await connector.validate(request);
            const probe=await connector.invoke({schemaVersion:'2.0',requestId:request.requestId,installationId:b.installationId,
              targetId:request.targetId,targetRevision:b.revision,method:'probe'});
            if(probe.outcome!=='ok'||!['workspace.create.v1','workspace.inspect.v1'].every(capability=>probe.capabilities.some(actual=>actual===capability)))
              throw new ExtensionError('unsupported_capability');
          },
          async invoke(request:WorkspaceRequest) {const b=await binding(request.operation!);return(await connectors.resolve(b.profile)).invoke(request);},
        };
        const loaded=await loadExtension(freezeProfile(op.runId,op.configDigest,original.action,host),host,{target});
        const instance=loaded.instance as ActionAdapter;
        if(typeof instance?.validate!=='function'||typeof instance?.start!=='function'||typeof instance?.reconcile!=='function')throw new ExtensionError('validation_failed');
        return {createsWorkspace:true,async validate(operation) {loaded.checkInput(operation.inputs);await instance.validate(operation);},
          async start(operation,claim) {const result=await instance.start(operation,claim);loaded.checkOutput(result);return validated<BoundResult>('execution-record',result);},
          async reconcile(operation,handle) {const result=await instance.reconcile(operation,handle);loaded.checkOutput(result);return validated<BoundResult>('execution-record',result);}};
      })();actions.set(key,action);action.catch(()=>actions.delete(key));
    }
    return action;
  };
  return {createsWorkspace:true,async validate(op){await(await resolve(op)).validate(op);},async start(op,claim){return(await resolve(op)).start(op,claim);},
    async reconcile(op,handle){return(await resolve(op)).reconcile(op,handle);}};
}
// Trusted admission composition. Compute stable identities before registering
// immutable lifecycle descriptors; duplicate provider generations reuse their run.
export function prepareWorkspaceStart<T extends {workspace:RecordOf<'workspace'>;operation:RecordOf<'operation'>}>(plan:T,installationId:string):T {
  const next=structuredClone(plan),op=next.operation.request;
  validated('workspace-create-input',op.inputs);
  if(op.actionId!==workspaceAction || op.actionVersion!==workspaceVersion || next.workspace.id!==op.workspaceId || next.workspace.targetId!==op.targetId)
    throw new ExtensionError('identity_mismatch');
  Object.assign(next.workspace,workspaceIdentity(installationId,op.targetId,op.workspaceId,op.source.issue));
  return next;
}
