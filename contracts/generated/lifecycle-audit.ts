/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export type LabstrideLifecycleRecord =
  | {
      schemaVersion: "1.0";
      id: string;
      revision: number;
      createdAt: string;
      updatedAt: string;
      kind: "installation";
      configRevision: string;
    }
  | {
      schemaVersion: "1.0";
      id: string;
      revision: number;
      createdAt: string;
      updatedAt: string;
      kind: "request";
      installationId: string;
      providerId: string;
      issueId: string;
      generation: number;
    }
  | {
      schemaVersion: "1.0";
      id: string;
      revision: number;
      createdAt: string;
      updatedAt: string;
      kind: "run";
      requestId: string;
      repositoryId: string;
      configRevision: string;
      paused: boolean;
      checkpoint: string | null;
      state:
        | "queued"
        | "preparing"
        | "ready"
        | "active"
        | "waiting_human"
        | "waiting_ci"
        | "delivering"
        | "completed"
        | "failed"
        | "cancelled"
        | "outcome_unknown";
    }
  | {
      schemaVersion: "1.0";
      id: string;
      revision: number;
      createdAt: string;
      updatedAt: string;
      kind: "workspace";
      runId: string;
      targetId: string;
      locator: string;
      localPath: string | null;
      ownershipRef: string;
      branch: string;
      keep: boolean;
      state:
        | "requested"
        | "creating"
        | "ready"
        | "in_use"
        | "retained"
        | "cleanup_pending"
        | "deleting"
        | "deleted"
        | "error"
        | "outcome_unknown";
    }
  | {
      schemaVersion: "1.0";
      id: string;
      revision: number;
      createdAt: string;
      updatedAt: string;
      kind: "operation";
      runId: string;
      workspaceId: string;
      request: LabstrideOperationRequestV1;
      effectBoundary: "not_crossed" | "crossed";
      state:
        "prepared" | "claimed" | "running" | "succeeded" | "failed" | "cancelled" | "outcome_unknown" | "superseded";
    }
  | {
      schemaVersion: "1.0";
      id: string;
      revision: number;
      createdAt: string;
      updatedAt: string;
      kind: "deployment";
      runId: string;
      operationId: string;
      targetId: string;
      sourceSha: string;
      state: "requested" | "running" | "verified" | "failed" | "outcome_unknown" | "superseded";
    }
  | {
      schemaVersion: "1.0";
      id: string;
      revision: number;
      createdAt: string;
      updatedAt: string;
      kind: "session";
      runId: string;
      workspaceId: string;
      providerId: string;
      sessionId: string;
      lastTurnId: string | null;
      humanActivityRevision: number;
      owner: "human" | "automation" | "unknown";
      state: "ready" | "busy" | "waiting_human" | "closed" | "failed" | "outcome_unknown";
    }
  | {
      schemaVersion: "1.0";
      id: string;
      revision: number;
      createdAt: string;
      updatedAt: string;
      kind: "outbox";
      runId: string;
      operationId: string;
      intentKey: string;
      payload: {
        schemaVersion: "1.0";
        operationId: string;
      };
    }
  | {
      schemaVersion: "1.0";
      id: string;
      revision: number;
      createdAt: string;
      updatedAt: string;
      kind: "projection";
      runId: string;
      providerId: string;
      subjectId: string;
      fieldId: string;
      generation: number;
      payload: {
        schemaVersion: "1.0";
        expectedFingerprint: string;
        value: FieldValue;
      };
      providerTarget?: {
        schemaVersion: "1.0";
        scopeId: string;
        resourceId: string;
      };
    }
  | {
      schemaVersion: "1.0";
      id: string;
      revision: number;
      createdAt: string;
      updatedAt: string;
      kind: "resource";
      runId: string;
      workspaceId: string;
      createdByOperation: string;
      resourceType: string;
      providerId: string;
      locator: string;
      ownershipRef: string;
      cleanupPolicy: string;
    }
  | {
      schemaVersion: "1.0";
      id: string;
      revision: number;
      createdAt: string;
      updatedAt: string;
      kind: "evidence";
      runId: string;
      workspaceId: string;
      operationId: string;
      category: "pr" | "merge" | "deployment" | "cleanup" | "correction";
      subjectId: string;
      sourceSha: string | null;
      targetId: string | null;
      outcome: "observed" | "verified" | "failed" | "outcome_unknown";
      reference: string;
      tombstoneRef: string | null;
      correctsId: string | null;
    };
/**
 * @maxItems 1024
 */
export type FieldValue = string | number | boolean | null | string[];

export interface LabstrideLifecycleAudit {
  schemaVersion: "1.0";
  id: string;
  at: string;
  actorId: string;
  reason: string;
  /**
   * @maxItems 64
   */
  evidenceRefs: string[];
  previousRevision: number | null;
  recovery: boolean;
  record: LabstrideLifecycleRecord;
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
