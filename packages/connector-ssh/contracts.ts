import type { LabstrideContractRequest } from '../../contracts/generated/contract-request.ts';
import type { LabstrideContractResult } from '../../contracts/generated/contract-result.ts';
import type { RecordOf } from '../core/lifecycle.ts';
import type { TargetConnector } from './runtime.ts';
import { validated } from '../storage-sqlite/validation.ts';
import { TargetError } from '../target-helper/filesystem.ts';

// Provider-neutral connector facade. Inspect resolves the original immutable
// operation from the caller's trusted store; a remote handle cannot choose a path.
export function connectorContracts(options: { connector: TargetConnector; installationId: string; targetId: string; revision: number;
  operation: (handle: string) => RecordOf<'operation'>['request'] }) {
  return async (input: LabstrideContractRequest): Promise<LabstrideContractResult> => {
    const request = validated('contract-request', input);
    if (request.family !== 'connector' || request.extensionId !== 'labstride.connector.ssh') throw new TargetError('identity_mismatch');
    const { input: _input, ...base } = request;
    const result = (value: object) => validated<LabstrideContractResult>('contract-result', { ...base, ...value } as LabstrideContractResult);
    let crossed = false;
    try {
      if (!['probe','execute','inspect'].includes(request.method)) throw new TargetError('unsupported_capability');
      const operation = request.method === 'execute' ? request.input.operation : request.method === 'inspect' ? options.operation(request.input.handle) : undefined;
      if (request.method === 'probe' && request.input.targetId !== options.targetId || operation && operation.targetId !== options.targetId ||
        request.method === 'inspect' && operation?.operationId !== request.input.handle) throw new TargetError('identity_mismatch');
      const helper = validated('ssh-helper-request', { schemaVersion: '1.0' as const, installationId: options.installationId,
        targetId: options.targetId, targetRevision: options.revision, requestId: operation?.operationId ?? request.requestId,
        method: request.method === 'execute' ? 'reserve' as const : request.method === 'inspect' ? 'inspect' as const : 'probe' as const,
        ...(operation ? { operation } : {}) });
      await options.connector.validate(helper);
      crossed = request.method === 'execute';
      const reply = validated('ssh-helper-response', await options.connector.invoke(helper));
      if (reply.error) { reply.error.message = reply.error.code; reply.error.evidenceId = null; }
      if (reply.outcome !== 'ok') return result({ outcome: reply.outcome, result: null, error: reply.error });
      return result({ outcome: 'ok', error: null, result: request.method === 'probe' ?
        { targetId: options.targetId, capabilities: reply.capabilities, evidenceRefs: ['target:probe'] } :
        { status: 'succeeded', handle: operation!.operationId, resources: [], outputs: { reservation: reply.reservation },
          evidenceRefs: [`target:registry:${operation!.operationId}`], error: null } });
    } catch (error) {
      const code = crossed ? 'outcome_unknown' : error instanceof TargetError ? error.code : 'validation_failed';
      return result({ outcome: code === 'outcome_unknown' ? 'outcome_unknown' : 'error', result: null,
        error: { code, message: code, evidenceId: null, retryClass: code === 'outcome_unknown' ? 'reconcile' : 'none' } });
    }
  };
}
