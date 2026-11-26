/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export type LabstrideContractRequest =
  | ProviderCapabilitiesRequest
  | ProviderReadSnapshotRequest
  | ProviderSubscribeRequest
  | ProviderReconcileRequest
  | ProviderProjectRequest
  | ConnectorProbeRequest
  | ConnectorExecuteRequest
  | ConnectorUploadRequest
  | ConnectorDownloadRequest
  | ConnectorInspectRequest
  | ConnectorCancelRequest
  | ActionDescribeRequest
  | ActionValidateRequest
  | ActionStartRequest
  | ActionObserveRequest
  | ActionCancelRequest
  | ActionReconcileRequest
  | SessionProviderCapabilitiesRequest
  | SessionProviderStartRequest
  | SessionProviderResumeRequest
  | SessionProviderObserveRequest
  | SessionProviderSendRequest
  | SessionProviderInterruptRequest
  | SessionProviderCloseRequest;
export type LabstrideSessionCommandV1 = {
  schemaVersion: "1.0";
  operationId: string;
  workspaceId: string;
  providerId: string;
  command: "start" | "resume" | "observe" | "send" | "interrupt" | "close";
  sessionId: string | null;
  expectedLastTurnId: string | null;
  expectedHumanActivityRevision: number;
  input: {
    [k: string]: unknown;
  };
};

export interface ProviderCapabilitiesRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "provider";
  method: "capabilities";
  input: ProviderCapabilitiesInput;
}
export interface Protocol {
  major: 1;
  minor: number;
}
export interface ProviderCapabilitiesInput {}
export interface ProviderReadSnapshotRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "provider";
  method: "readSnapshot";
  input: ProviderReadSnapshotInput;
}
export interface ProviderReadSnapshotInput {
  subjectId: string;
}
export interface ProviderSubscribeRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "provider";
  method: "subscribe";
  input: ProviderSubscribeInput;
}
export interface ProviderSubscribeInput {
  cursor: string | null;
}
export interface ProviderReconcileRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "provider";
  method: "reconcile";
  input: ProviderReconcileInput;
}
export interface ProviderReconcileInput {
  subjectId: string;
  cursor: string | null;
}
export interface ProviderProjectRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "provider";
  method: "project";
  input: ProviderProjectInput;
}
export interface ProviderProjectInput {
  subjectId: string;
  expectedVersion: string;
  fields: {
    [k: string]: unknown;
  };
}
export interface ConnectorProbeRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "connector";
  method: "probe";
  input: ConnectorProbeInput;
}
export interface ConnectorProbeInput {
  targetId: string;
}
export interface ConnectorExecuteRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "connector";
  method: "execute";
  input: ActionStartInput;
}
export interface ActionStartInput {
  operation: LabstrideOperationRequestV1;
}
export interface LabstrideOperationRequestV1 {
  schemaVersion: "1.0";
  operationId: string;
  runId: string;
  workspaceId: string;
  actionId: string;
  actionVersion: string;
  configDigest: string;
  requestDigest: string;
  source: {
    repositoryId: string;
    repository: string;
    sha: string;
    issue?: GithubIssue;
  };
  targetId: string;
  deadline: string;
  inputs: {
    [k: string]: unknown;
  };
}
export interface GithubIssue {
  number: number;
  title: string;
}
export interface ConnectorUploadRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "connector";
  method: "upload";
  input: ConnectorUploadInput;
}
export interface ConnectorUploadInput {
  operationId: string;
  targetId: string;
  artifact: Artifact;
  path: string;
}
export interface Artifact {
  sha256: string;
  size: number;
}
export interface ConnectorDownloadRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "connector";
  method: "download";
  input: ConnectorDownloadInput;
}
export interface ConnectorDownloadInput {
  operationId: string;
  targetId: string;
  path: string;
}
export interface ConnectorInspectRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "connector";
  method: "inspect";
  input: ActionCancelInput;
}
export interface ActionCancelInput {
  handle: string;
}
export interface ConnectorCancelRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "connector";
  method: "cancel";
  input: ActionCancelInput;
}
export interface ActionDescribeRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "action";
  method: "describe";
  input: ActionDescribeInput;
}
export interface ActionDescribeInput {}
export interface ActionValidateRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "action";
  method: "validate";
  input: ActionStartInput;
}
export interface ActionStartRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "action";
  method: "start";
  input: ActionStartInput;
}
export interface ActionObserveRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "action";
  method: "observe";
  input: ActionCancelInput;
}
export interface ActionCancelRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "action";
  method: "cancel";
  input: ActionCancelInput;
}
export interface ActionReconcileRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "action";
  method: "reconcile";
  input: ActionReconcileInput;
}
export interface ActionReconcileInput {
  operation: LabstrideOperationRequestV1;
  handle: string | null;
}
export interface SessionProviderCapabilitiesRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "session-provider";
  method: "capabilities";
  input: SessionProviderCapabilitiesInput;
}
export interface SessionProviderCapabilitiesInput {}
export interface SessionProviderStartRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "session-provider";
  method: "start";
  input: LabstrideSessionCommandV1 & {
    command?: "start";
    [k: string]: unknown;
  };
}
export interface SessionProviderResumeRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "session-provider";
  method: "resume";
  input: LabstrideSessionCommandV1 & {
    command?: "resume";
    [k: string]: unknown;
  };
}
export interface SessionProviderObserveRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "session-provider";
  method: "observe";
  input: LabstrideSessionCommandV1 & {
    command?: "observe";
    [k: string]: unknown;
  };
}
export interface SessionProviderSendRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "session-provider";
  method: "send";
  input: LabstrideSessionCommandV1 & {
    command?: "send";
    [k: string]: unknown;
  };
}
export interface SessionProviderInterruptRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "session-provider";
  method: "interrupt";
  input: LabstrideSessionCommandV1 & {
    command?: "interrupt";
    [k: string]: unknown;
  };
}
export interface SessionProviderCloseRequest {
  schemaVersion: "1.0";
  requestId: string;
  extensionId: string;
  protocol: Protocol;
  family: "session-provider";
  method: "close";
  input: LabstrideSessionCommandV1 & {
    command?: "close";
    [k: string]: unknown;
  };
}
