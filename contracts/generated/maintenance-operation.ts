/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export interface InstallationMaintenanceOperationV1 {
  schemaVersion: "1.0";
  operation: "restore" | "upgrade";
  bundle: string;
  installationId: string;
}
