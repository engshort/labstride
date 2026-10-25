/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export interface DiagnosticRetentionResultV1 {
  schemaVersion: "1.0";
  at: string;
  cutoff: string;
  mode: "dry-run" | "apply";
  eligible: number;
  deleted: number;
  remaining: number;
  batchLimit: 500;
  /**
   * @maxItems 4
   */
  blockers:
    | []
    | ["active_or_unresolved" | "retained_resource" | "recent_metadata" | "recovery_evidence"]
    | [
        "active_or_unresolved" | "retained_resource" | "recent_metadata" | "recovery_evidence",
        "active_or_unresolved" | "retained_resource" | "recent_metadata" | "recovery_evidence"
      ]
    | [
        "active_or_unresolved" | "retained_resource" | "recent_metadata" | "recovery_evidence",
        "active_or_unresolved" | "retained_resource" | "recent_metadata" | "recovery_evidence",
        "active_or_unresolved" | "retained_resource" | "recent_metadata" | "recovery_evidence"
      ]
    | [
        "active_or_unresolved" | "retained_resource" | "recent_metadata" | "recovery_evidence",
        "active_or_unresolved" | "retained_resource" | "recent_metadata" | "recovery_evidence",
        "active_or_unresolved" | "retained_resource" | "recent_metadata" | "recovery_evidence",
        "active_or_unresolved" | "retained_resource" | "recent_metadata" | "recovery_evidence"
      ];
}
