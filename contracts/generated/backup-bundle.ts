/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export interface InstallationBackupBundleV1 {
  schemaVersion: "1.0";
  installationId: string;
  databaseVersion: number;
  databaseSha256: string;
  artifacts: string[];
}
