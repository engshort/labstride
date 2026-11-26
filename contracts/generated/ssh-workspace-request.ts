/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export type TrustedWorkspaceHelperRequestV2 = {
  schemaVersion: "2.0";
  requestId: string;
  installationId: string;
  targetId: string;
  targetRevision: number;
  method: "probe" | "create" | "inspect";
  operation?: LabstrideOperationRequestV1;
  includeRoots?: true;
};

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
