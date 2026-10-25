import { readFileSync } from 'node:fs';
import type { OperationalDiagnosticEventV1 } from '../../contracts/generated/operational-event.ts';
import { validated } from '../storage-sqlite/validation.ts';

type Code = OperationalDiagnosticEventV1['code'];
const codes = new Set<string>(JSON.parse(readFileSync(new URL('../../schemas/operational-event.schema.json', import.meta.url), 'utf8')).$defs.code.enum);
// Pattern matching is insufficient: a secret can also look like a machine code.
export function safeReason(value: unknown, fallback: Code = 'operation_failed'): Code {
  return typeof value === 'string' && codes.has(value) ? value as Code : fallback;
}
export function safeError(error: unknown): Code {
  const value = error && typeof error === 'object' && 'code' in error ? error.code : error instanceof Error ? error.message : null;
  return safeReason(value);
}
export function diagnosticEvent(code: Code, at: string, runId: string | null = null, operationId: string | null = null): OperationalDiagnosticEventV1 {
  return validated('operational-event', { schemaVersion: '1.0', at, code, runId, operationId });
}
export function safeResult<T extends { result: { error: { code: string; message: string; evidenceId?: string | null } | null } }>(value: T): T {
  if (value.result.error) {
    value.result.error.message = value.result.error.code;
    if ('evidenceId' in value.result.error) value.result.error.evidenceId = null;
  }
  return value;
}
