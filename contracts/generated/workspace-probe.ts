/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export interface WorkspaceOperatorProbeV1 {
  schemaVersion: "1.0";
  installationId: string;
  configuration: {
    enrollmentDirectory: string;
    targetId: string;
    revision: number;
    digest: string;
  };
  artifactPath: string;
  artifactIntegrity: string;
  stateDirectory: string;
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
