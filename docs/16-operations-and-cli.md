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
| labstride metrics --json | Read aggregate operational measurements from the existing database |
| labstride retention --dry-run | Preview eligible diagnostic compaction with the coordinator stopped |
| labstride retention --apply | Explicitly compact one bounded batch of expired resolved diagnostics |

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

`labstride metrics --json` reads a consistent snapshot from an existing compatible database without activating configuration, migrating storage or contacting providers. Its [versioned schema](../schemas/operational-metrics.schema.json) reports oldest queued-run age, non-deleted workspace count, action count and total/maximum elapsed duration, unknown operations, deliveries with failed reconciliation, pending/blocked/conflicted projections, repair attempts, budget holds and blocked cleanup requests. Durations start at the original effect boundary and end at the terminal operation timestamp or snapshot time. `staleLeases` counts active claims whose operation deadline has passed; this is a diagnostic, never permission to reclaim a resource or replay an effect. These are database snapshots, not lifetime counters or a claim that an external metrics server is installed. No issue, repository, prompt or session contents become metric labels.

[Operational events](../schemas/operational-event.schema.json) contain a version, timestamp, allowlisted reason code and optional stable run/operation IDs. Budget holds persist such an event; loop failures emit a safe `tick_failed` event. Arbitrary error strings are never accepted merely because they resemble machine codes. New action error receipts replace provider messages with the validated contract code and omit unverified error evidence IDs; independently bound handles, outcomes, retry classes and result evidence references survive. Workflow receipts retain a digest of the original validated payload for duplicate/conflict detection while storing safe diagnostic fields. The coordinator does not change signed artifacts to redact them. Observation logs omit arbitrary outputs/resources, and session-intent logs contain identity/digest metadata rather than command text. Protected execution descriptors and action-specific outputs remain available for recovery; they are not default diagnostic output. Previously persisted data and backups are not retroactively scrubbed.

Configured `maxRepairs` and `unattendedMs` default to three repairs and 24 hours. Admission starts the unattended interval; explicit budget renewal establishes a new anchor without resetting total repairs. Zero repairs allows the initial non-repair operation, but a repair request durably records `repair_budget` and cannot cross the effect boundary. Scheduling, claiming and effect entry recheck limits. Ordinary resume never clears a budget hold. Expiry does not fabricate cancellation or discard an in-flight result: original observation and explicit cancellation remain available. Repeated failure holds remain independent of operator pause.

## Bounded managed summaries

The coordinator publishes one managed summary per run in both public Project and native issue-field profiles, using the configured repository credential. The existing 16,000-character ceiling, 60-second minimum interval, unchanged-content suppression, compare/readback checks and durable intent apply. Summaries include phase, safe diagnostic/hold codes, repair usage, unattended limit, unknown-operation count and projection-conflict count. Session guidance appears only when a managed session exists. Tool calls, task bodies and transcripts are never mirrored.

A status summary may explain an operator, human, cancellation or budget hold without enabling action or field effects. Emergency policy pause, restore fencing and reconciliation-only service mode still forbid summary writes. Pending field writes take precedence while field effects are enabled. A manually edited comment is preserved. A lost creation acknowledgement never authorizes another comment; a lost update is reconciled by reading the original comment, without resubmitting the mutation.

## Explicit diagnostic retention

`labstride retention --dry-run` and `--apply` require an existing compatible installation database, the exclusive service lock and no active restore fence. Stop the coordinator first. Neither command initializes, upgrades, restores or enables an installation. They use `configuration.limits.metadataRetentionDays` (template default 90 days); a retention interval must be a positive safe integer producing a valid cutoff date. Dry run reports eligibility without changing SQLite records. Apply removes at most 500 diagnostic rows and commits its versioned [batch result](../schemas/retention-result.schema.json) atomically with deletion. `remaining` reports eligible rows left after this batch; repeat the explicit command if needed. Blockers explain broad preservation categories and do not expose task contents.

Only expired retry scheduling and redundant accepted-observation rows belonging to resolved terminal runs are eligible. Both the row and terminal run timestamp must precede the cutoff; the latest observation carrying an original handle is always preserved. SQLite independently enforces eligibility through the migration-21 deletion trigger. An error or process death before commit rolls back the deletion and batch record together; process death after commit leaves the committed batch inspectable and a subsequent invocation considers only remaining rows.

Active/unknown operations, claims, conflicted or pending deliveries, unresolved cancellations or restore checks, retained workspaces, unverified cleanup, live sessions, uncertain managed effects, pending summaries, dispatch conflicts and resource holds prevent compaction. Deleted workspaces need verified cleanup tombstones. Retained resources other than the deleted source checkout, any cleanup correction, and unresolved or verified deployment resources conservatively retain diagnostics. Managed sessions remain retained until a separately qualified reconciliation path can establish their disposition.

Identity/deduplication records, terminal results, lifecycle audit, claims, controls, ownership/resource inventory, cleanup evidence, tombstones and intent/receipt/boundary logs remain intact. This is diagnostic compaction, not a total database size limit. Installation-wide and uncorrelated diagnostics are conservatively retained. No workspace files, unmanaged paths, GitHub comments or provider transcripts are deleted. Session transcript retention remains with its provider. Removed diagnostics require a prior backup to reconstruct. Migration 21 requires the existing explicit backup/upgrade procedure; no down migration is supported.

## Optional cleanup assessment commands

The [W05.1 assessment profile](20-workspace-cleanup.md) adds `runs keep RUN_ID true|false` and `runs cleanup RUN_ID` to the existing CLI configuration-file interface. Keep changes use local-operator authority and expected workspace revisions. Cleanup requests require a frozen `operator_request` cleanup policy; the completion trigger queues its own deduplicated assessments. `runs show` and `runs list` include cleanup requests, selected operations, decisions, evidence and blockers. These commands never set a directory to deleted; #29 owns the qualified removal executor.
