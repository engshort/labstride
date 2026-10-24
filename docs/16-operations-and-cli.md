# 16 — Operations and CLI

## CLI scope

The [prepared-host public profile](40-public-installation.md) implements personal Project polling, agent-free workspaces, shared diagnostics, safe inspection and recovery controls. The [local issue-to-review profile](37-local-self-build.md) retains its native-field/Codex integration. Both use the CLI and one locked coordinator loop. [Bundle restore and explicit database upgrade](41-backup-and-upgrade.md) preserve active state behind reconciliation fences; installed/live qualification remains open.

## Full command targets

| Command | Intended outcome |
| --- | --- |
| labstride version --json | Report packaged source revision and running Node.js version without operational configuration |
| labstride init | Produce disabled installation template with no embedded credentials |
| labstride config validate | Validate schemas and produce a resolved binding report |
| labstride doctor | Check DB, credentials, provider capabilities, SSH and broker reachability |
| labstride serve | Run coordinator with configured persistent state |
| labstride serve --reconcile-only | Reconcile an existing fenced public installation without new external effects |
| labstride runs list/show | Explain current phase, blocking reason and evidence |
| labstride runs pause/resume/cancel | Apply authenticated control intent and report actual state |
| labstride runs reconcile | Re-observe a run without blindly replaying effects |
| labstride workspaces keep/release | Set or remove cleanup hold with audit |
| labstride extensions inspect | Report pinned versions, capabilities and integrity |
| labstride backup/restore | Controlled consistent backup and recovery workflow |
| labstride backup --bundle DIRECTORY | Create a complete SQLite and pinned-artifact bundle |
| labstride restore DIRECTORY | Restore a complete bundle into the configured fresh state directory, paused |
| labstride upgrade --backup DIRECTORY | Back up and transactionally migrate SQLite into paused recovery |

Commands offer versioned JSON by default, explicit `--json`, optional `--human` formatting and exit codes 0/1. The credential-free version command retains its strict version-only arguments. No command implies success when only an asynchronous request was accepted.

## Version output

`labstride version --json` writes one [versioned JSON object](../schemas/cli-version.schema.json) to stdout and exits 0. `labstride version` currently returns the same JSON. It does not load installation configuration, resolve credentials, contact GitHub or a coordinator, invoke Git, or create state. It works from an unrelated working directory with no writable state directory. Other arguments, including `--config`, are rejected with `usage` and exit 1.

A packaged release returns `{"schemaVersion":"1.0","source":"release","installedRevision":"<40-character source SHA>","nodeVersion":"v24.22.0"}`. The revision comes only from `release-manifest.json` at the executing application's root, resolved relative to its module. The existing administrative installer verifies the manifest against an operator-supplied SHA-256, verifies packaged file hashes, and installs protected release files. That installation boundary supplies trust; the version command does not authenticate arbitrary user-created manifests or recheck the complete release inventory. `nodeVersion` is always the actual running `process.version`, not the toolchain version declared in the manifest.

When that metadata is absent, a development checkout returns `{"schemaVersion":"1.0","source":"development","installedRevision":null,"nodeVersion":"v24.22.0"}`. This explicitly reports no installed revision; checkout HEAD and package version are not substitutes. A copied release with missing metadata is likewise unidentified and reports development, not a claimed release revision.

Metadata must contain `schemaVersion: "1.0"` and a lowercase 40-character hexadecimal `revision`. Invalid JSON/version/revision returns `release_metadata_invalid`; unreadable metadata returns `release_metadata_unreadable`. Errors use the existing `{ "schemaVersion": "1.0", "code": "..." }` shape on stderr, leave stdout empty and exit 1. Only absent metadata yields the successful development result. No state migration or coordinator restart is required by this command.

## Installation

Select a dedicated service identity and durable local state directory. Configure repositories/targets and references to credentials. Enroll host keys. Bind the control API locally. Configure authenticated HTTPS integration ingress or a private network route for runner claims; verify it before enabling workflows. Resolve field IDs and run dry validation first.

The intended distribution contains the CLI and one coordinator service, with one installation configuration and local SQLite; package boundaries are not a fleet of services. Start GitHub observation with bounded outbound polling, so reading a personal Project does not require public webhook ingress. The authenticated runner-claim route remains a separate required gate for workflow execution. A hosting provider/control panel, hardcoded filesystem root or maintainer account is never an installation prerequisite.

Doctor reports the task/decision versus operational-state boundary, managed projection ownership, configured development/CI-review limits, projection backlog and stale/missing provider observations. When a session extension is enabled, it checks the actual runtime identity, authentication availability, interactive continuity and supported human/turn guards. Hook support is optional; disabled or unavailable hooks must have an advertised observation/reconciliation fallback. Installing tools or signing in does not by itself verify these runtime contracts.

OS service definitions belong to packaging examples (Linux first). Containers may be provided later; they must not disrupt the existing native agent daemon's identity or filesystem/session mapping.

## Recovery runbook

1. Stop the coordinator and preserve the database, original pins and outstanding resources. To replace lost/older state, follow the [fresh-directory bundle restore procedure](41-backup-and-upgrade.md); it enters recovery before publication.
2. Run `recovery begin` under the installation's local operator authority. Entering and resuming recovery both require the service lock.
3. For a public v2 installation, start `serve --reconcile-only`. This requires the existing healthy, matching database and active recovery fence. Missing or stale runner qualification blocks normal startup but does not prevent this explicit receipt/read recovery mode. Other configuration, credential, extension and SSH checks still apply.
4. Identify outstanding operations and claims with `recovery status` and `runs show`; use `runs reconcile RUN` for blocked reads. Re-observe actual GitHub run/PR/deploy and target resource state. Accept verified original results while retaining unresolved items and conflicts.
5. Stop the reconciliation service before `recovery resume`. The command rejects unresolved operation, session and projection checks and cannot clear the fence while the service owns the lock. `recovery status` adds `unresolvedSessions` and `unresolvedProjections` alongside original operation IDs.
6. Complete readiness checks and explicitly start normal `serve`. Renewed runner evidence cannot change a running reconciliation-only process into normal operation.

Reconciliation-only mode does not initialize/migrate storage or activate a new configuration/policy. It permits original authenticated receipts, operation reconciliation and projection reads; it does not admit Project requests, advance workflows, start actions, dispatch/merge, write projections, send cancellations, publish summaries or run cleanup. Claims and effect authorization remain denied even after runner evidence is renewed. V1 pilot runtime behavior is retained; its separate qualification and recovery limits still apply.

Run inspection includes `startup`, an array of validated frozen session selections. It remains available when a native creation response was lost and no registered session exists. It is empty when no startup selection was recorded; later field edits cannot replace the saved mode/model/reasoning choices.

Do not delete the database as a reset method while external resources still exist.

Observation history may be read again with deduplication, but rebuilding an observation store is not recovery of operation intent, claims, workspace/session identity or ownership. The [W00.1 disposable observer probe](evidence/W00.1-actor-observation-2026-10-21.md) verified cursor catch-up and crash/overlap behavior only in its own harness. Doctor must distinguish those provider capabilities from an implemented and verified coordinator recovery path, report unsupported field/actor history, and reject invalid-cursor/partial-error results as evidence of successful catch-up.

## Metrics and logs

Measure queue age, active workspaces, action duration, unknown outcomes, failed reconciliation, projection conflicts, stale leases, CI repair attempts and cleanup blockers. Avoid issues/prompts as metric labels. Logs have stable codes, operation IDs and redacted safe messages.

Default redacted metadata retention is 90 days, configurable. Session transcript retention is controlled by its provider. Preserve records needed to reconcile unresolved work even if their normal retention date passes.

## Optional cleanup assessment commands

The [W05.1 assessment profile](20-workspace-cleanup.md) adds `runs keep RUN_ID true|false` and `runs cleanup RUN_ID` to the existing CLI configuration-file interface. Keep changes use local-operator authority and expected workspace revisions. Cleanup requests require a frozen `operator_request` cleanup policy; the completion trigger queues its own deduplicated assessments. `runs show` and `runs list` include cleanup requests, selected operations, decisions, evidence and blockers. These commands never set a directory to deleted; #29 owns the qualified removal executor.
