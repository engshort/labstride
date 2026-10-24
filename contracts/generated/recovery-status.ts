/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export interface RecoveryControlStatusV1 {
  schemaVersion: "1.0";
  paused: boolean;
  epoch: number;
  unresolved: string[];
  unresolvedSessions?: string[];
  unresolvedProjections?: string[];
}
