# 41 — Backup, restore and database upgrade

W06.2 implements LS-OPS-002/003 for operator-owned local SQLite state. The CLI and coordinator remain one installation. These commands do not install releases, restart services, change credentials, or undo external effects.

## Accepted scope and adopted design

Complete backups include pinned extension artifacts. Restore uses a fresh prepared state directory and preserves the previous installation. Raw SQLite export remains compatible. Public v2 supplies the executable reconciliation-only service; native self-build state is preserved, but its separate session/publication recovery gate remains open.

All examples below use synthetic paths. Run commands with the installation's service identity and protected configuration. Prepare the destination parent/directories with that identity; state and bundle directories require mode 0700, files mode 0600. Existing protected paths and their contents are preserved.

## Backup

`labstride backup --bundle /protected/backups/snapshot --config CONFIG` exclusively creates a new bundle directory. SQLite's online backup API captures committed WAL state without requiring service shutdown. Artifact inventory comes from the completed database snapshot's saved configurations and session profiles, plus the reviewed installation lock needed for startup. All retained snapshots are included, conservatively preserving older pins.

The bundle contains `state.sqlite`, `artifacts/SHA256.json` and a versioned `manifest.json`. The manifest records installation identity, database schema/checksum and unique artifact hashes; it is written last as the completion record. Every artifact's exact bytes, integrity and manifest identity are checked without importing its code. Incomplete attempts remain preserved and cannot be reused as destinations. SQLite sidecars are forbidden in complete bundles. Checksums detect corruption; they do not authenticate an untrusted bundle.

`labstride backup FILE --config CONFIG` retains the existing database-only export. Preserve its original extension artifact paths separately; the new `restore` command accepts complete bundles, not raw exports.

Backups contain operational handles and configuration records. Protect them as installation state. Credential files, application data, source checkouts, helper registries and provider-owned session storage are not copied. Preserve them through their own supported procedures.

## Restore

1. Stop the original coordinator and preserve its current database, resources and pins. Restoring into a different directory does not lock or stop the original service.
2. Prepare an empty protected state directory. Prepare a reviewed configuration with the same installation identity and that destination `stateDirectory`; retain target/backend identities and credential references.
3. Run `labstride restore BUNDLE --config CONFIG`. Restore validates checksums, installation identity, SQLite integrity/foreign keys and the exact known migration-history prefix before publication. Occupied destinations are rejected; only an existing `service.lock` is allowed.
4. Restore holds the destination service lock, creates a durable maintenance marker, copies into protected staging, migrates supported older schemas and commits the recovery fence. It retains artifacts before exclusively publishing the fenced database. Staging remains available for inspection.
5. Inspect `recovery status` and `runs show`. For public v2, use `serve --reconcile-only`; stop that service before `recovery resume`, then complete readiness checks before starting normal `serve`.

Restoration keeps frozen configuration digests, original operation IDs, opaque handles, session ownership and projection tokens unchanged. The installation-scoped loader prefers retained artifacts by their exact integrity hash and applies its existing protocol, capability and permission checks. A current extension version never substitutes for a missing old pin.

## Explicit database upgrade

Stop the coordinator, select the reviewed executable release through the operator's existing installation process, and run `labstride upgrade --backup NEW_BUNDLE --config CONFIG` with that executable. The command holds the service lock, completes and validates its mandatory pre-upgrade bundle, retains the required artifacts, then applies migrations and the recovery fence in one SQLite transaction. It also works on the current schema as an explicit fenced maintenance exercise. Normal installed startup still refuses older schemas instead of silently upgrading them.

Failed migration DDL and schema/version records roll back together. Active handles, claims, observations and frozen profiles remain in the original database and the backup. Successful upgrade stays paused until reconciliation and explicit resume. No down-migration or universal application rollback is promised.

## Recovery gates and interruption

The recovery epoch requires independent observations for every saved operation, enrolled session and pending/blocked/conflicting projection. Session hooks remain durable advisory data; only a fresh conclusive backend observation clears a session check. Projection reads preserve human edits and original uncertain write tokens. A classified conflict without an uncertain attempt remains held on its field, while an unresolved write attempt continues to block installation resume. Pre-fence responses and delayed receipts cannot satisfy fresh checks.

Missing adapters, unavailable providers, unsupported retained versions and unknown effects remain blockers. Recovery never treats an absent reply as permission to dispatch again. Operations created after the backup whose identities are absent require separate comparison with the preserved current database and live provider/target inventories before operator resume; an older backup alone cannot establish their absence.

If restore or upgrade fails after creating `maintenance.json`, retain that directory and its staging files. Initialization, store startup, status inspection and service startup report `maintenance_incomplete`. Even a transaction that rolled back leaves the maintenance marker in place. Its protected versioned contents identify the operation and source/pre-upgrade bundle. Recover by restoring that complete bundle into another fresh state directory; do not delete the marker to force activation or rerun against an occupied destination. An interrupted backup without a manifest is incomplete and requires a new bundle destination.

Public recovery still enforces configuration/credential/SSH checks and original receipt identities. Native self-build recovery does not acquire new authority from these commands; its state remains paused where independent read recovery is unavailable. This slice provides no live native-client continuity claim.

## Evidence and remaining gates

[W06.2 evidence](evidence/W06.2-backup-upgrade-2026-10-24.md) records real SQLite, durable local peers and process-death tests. Full installed/live AC21/AC27 remain unexecuted; W06/#9 and W07/#10 retain that qualification work. AC35/AC36 retain their existing owning packages and evidence.
