/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export interface OperationalMetricSnapshotV1 {
  schemaVersion: "1.0";
  at: string;
  queueAgeMs: number;
  activeWorkspaces: number;
  actionCount: number;
  actionDurationTotalMs: number;
  actionDurationMaxMs: number;
  unknownOutcomes: number;
  failedReconciliation: number;
  projectionPending: number;
  projectionBlocked: number;
  projectionConflicts: number;
  staleLeases: number;
  repairAttempts: number;
  budgetHolds: number;
  cleanupBlockers: number;
}
