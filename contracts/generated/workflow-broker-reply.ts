/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export type WorkflowBrokerReplyV1 =
  | {
      schemaVersion: "1.0";
      operation: LabstrideOperationRequestV1;
      enrollment: WorkflowEnrollmentV1;
      claim: AuthenticatedWorkflowClaimV1;
    }
  | {
      schemaVersion: "1.0";
      authorized: true;
      claimId: string;
    }
  | {
      schemaVersion: "1.0";
      received: true;
    }
  | {
      schemaVersion: "1.0";
      error:
        | "invalid_payload"
        | "identity_rejected"
        | "provider_unavailable"
        | "not_found"
        | "claim_conflict"
        | "effect_consumed"
        | "effect_blocked"
        | "receipt_conflict"
        | "broker_unavailable";
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
export interface WorkflowEnrollmentV1 {
  schemaVersion: "1.0";
  repository: {
    name: string;
    nodeId: string;
    id: string;
    ownerId: string;
  };
  workflowId: string;
  workflowPath: string;
  ref: string;
  workflowSha: string;
  targetId: string;
  environment: string;
  credentialRef: string;
  inputs: {
    [k: string]: string;
  };
  deployment?: DeploymentProfileV1;
}
export interface DeploymentProfileV1 {
  schemaVersion: "1.0";
  recipe: {
    id: string;
    version: string;
    digest: string;
  };
  observer: {
    id: string;
    version: string;
    configuration: {
      [k: string]: unknown;
    };
  };
  maxObservationAgeMs?: number;
  observationTimeoutMs?: number;
  recovery: {
    /**
     * @minItems 1
     * @maxItems 4
     */
    methods:
      | ["manual" | "rollback" | "restore_backup" | "forward_fix"]
      | [
          "manual" | "rollback" | "restore_backup" | "forward_fix",
          "manual" | "rollback" | "restore_backup" | "forward_fix"
        ]
      | [
          "manual" | "rollback" | "restore_backup" | "forward_fix",
          "manual" | "rollback" | "restore_backup" | "forward_fix",
          "manual" | "rollback" | "restore_backup" | "forward_fix"
        ]
      | [
          "manual" | "rollback" | "restore_backup" | "forward_fix",
          "manual" | "rollback" | "restore_backup" | "forward_fix",
          "manual" | "rollback" | "restore_backup" | "forward_fix",
          "manual" | "rollback" | "restore_backup" | "forward_fix"
        ];
    /**
     * @minItems 1
     * @maxItems 32
     */
    steps: [string, ...string[]];
    migration: {
      strategy: "compatible" | "backup_restore" | "forward_fix" | "irreversible";
      /**
       * @minItems 1
       * @maxItems 32
       */
      limits: [string, ...string[]];
    };
    rollback: {
      supported: boolean;
      qualification: {
        recipeDigest: string;
        targetId: string;
        environment: string;
        /**
         * @minItems 1
         * @maxItems 32
         */
        evidenceRefs: [string, ...string[]];
      } | null;
    };
  };
}
export interface AuthenticatedWorkflowClaimV1 {
  schemaVersion: "1.0";
  operationId: string;
  requestDigest: string;
  claimId: string;
  fencingNumber: number;
  executor: Executor;
}
export interface Executor {
  provider: "github-actions";
  repositoryId: string;
  workflowPath: string;
  workflowSha: string;
  runId: string;
  runAttempt: number;
}
