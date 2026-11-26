import { validated } from '../storage-sqlite/validation.ts';
import { requestDigest, digest } from '../storage-sqlite/execution.ts';
import { locatorFor } from './registry.ts';
import { TargetError } from './filesystem.ts';
import { issueBranchName } from '../core/issue-naming.ts';
import type { TrustedWorkspaceHelperPolicyV2 } from '../../contracts/generated/ssh-workspace-policy.ts';
import type { TrustedWorkspaceHelperRequestV2 } from '../../contracts/generated/ssh-workspace-request.ts';
import type { TrustedWorkspaceHelperResponseV2 } from '../../contracts/generated/ssh-workspace-response.ts';
import type { OwnedWorkspaceCreationReceiptV1 } from '../../contracts/generated/ssh-workspace-receipt.ts';
export type WorkspacePolicy = TrustedWorkspaceHelperPolicyV2;
export type WorkspaceRequest = TrustedWorkspaceHelperRequestV2;
export type WorkspaceResponse = TrustedWorkspaceHelperResponseV2;
export type WorkspaceReceipt = OwnedWorkspaceCreationReceiptV1;
export const workspaceAction = 'labstride.workspace-create';
export const workspaceVersion = '1.0.0';
export const workspaceCapabilities = ['workspace.probe.v1','workspace.create.v1','workspace.inspect.v1'] as const;
export function workspaceIdentity(installationId: string, targetId: string, workspaceId: string, issue?: WorkspaceReceipt['source']['issue']) {
  const locator = locatorFor(installationId, targetId, workspaceId);
  return { locator, branch: issue ? issueBranchName(locator, issue) : `labstride/${locator}`, ownershipRef: `workspace:${locator}` };
}
export function validateWorkspaceRequest(policy: WorkspacePolicy, input: unknown): WorkspaceRequest {
  const request = validated<WorkspaceRequest>('ssh-workspace-request', input as WorkspaceRequest);
  if (request.installationId !== policy.installationId || request.targetId !== policy.targetId || request.targetRevision !== policy.targetRevision)
    throw new TargetError('identity_mismatch');
  if (request.method === 'probe') return request;
  const op = request.operation!;
  validated('workspace-create-input', op.inputs);
  if (op.actionId !== workspaceAction || op.actionVersion !== workspaceVersion || op.targetId !== request.targetId ||
    request.requestId !== op.operationId || op.requestDigest !== requestDigest(op) || op.inputs.target !== op.targetId || digest(op.inputs.source) !== digest(op.source))
    throw new TargetError('validation_failed');
  if (!policy.roots.some(root => root.id === op.inputs.rootId) || !policy.sources.some(source => source.repositoryId === op.source.repositoryId && source.repository === op.source.repository))
    throw new TargetError('forbidden');
  return request;
}
