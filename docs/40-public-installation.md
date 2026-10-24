# 40 — Prepared-host public installation

W06.1 / #30 adds the public CLI/coordinator profile for a prepared Linux host and Node 24.22.0. It uses one installation file and the existing local coordinator SQLite store. Personal Project observation, SSH workspaces and operator controls require no agent, native organization fields, coding-user bridge or hosting control panel. The v1 [native issue-to-review profile](37-local-self-build.md) remains supported. [Evidence](evidence/W06.1-public-operations-2026-10-24.md) distinguishes local behavior from installed and live acceptance.

## Prepare the host and bundle

The operator supplies a dedicated coordinator account, protected release/configuration directories, private durable state directory, selected credentials and an independently enrolled SSH helper. Existing [SSH enrollment](33-ssh-target-boundary.md), [workspace ownership](34-exact-revision-workspaces.md), [Project qualification](32-github-reconciliation.md) and [workflow enrollment](38-workflow-broker.md) contracts apply. Helper provisioning, host-key acquisition, accounts, credentials, ingress and service installation are administrative work; these commands do not perform them.

Build the exact committed source with `python3 scripts/package_local.py NEW_BUNDLE_DIRECTORY`. The bundle contains the CLI/coordinator, locked dependencies, Node/license, existing public actions and both provider artifacts. It downloads nothing, refuses dirty source and prints the manifest SHA-256. Retain that digest through a trusted operator channel.

Create a disabled configuration with `labstride init /operator/installation.json --profile public`. This produces the [public template](../examples/public-installation.json), validated by the [public installation v2 schema](../schemas/public-installation.schema.json). Inner configuration/policy/extension contracts remain version 1.0. Replace synthetic identities, credential references, artifact locations and pins, field/option IDs, independently observed history qualifications, target enrollment and policy grants. The repository credential must be a dedicated selected-repository App installation. The Project credential has its own explicit reference; no credential fallback is used.

Render a new prepared directory:

```bash
python3 scripts/prepare_public.py \
  --bundle /operator/labstride-bundle \
  --manifest-sha256 REVIEWED_MANIFEST_SHA256 \
  --configuration /operator/installation.json \
  --service-user labstride_operator \
  --destination /operator/new-prepared-installation
```

The renderer verifies the manifest and every packaged file before staging a release. It writes a launcher and disabled service-unit example without creating accounts, copying credentials, installing units, reloading systemd or starting services. Existing output is preserved. `--release` instead accepts a previously reviewed, protected release directory. The bundle form stages release metadata with the application so `labstride version --json` identifies that source revision; version needs no configuration access.

Point artifact pins at the staged release's `artifacts` directory and use the actual artifact hashes. Review filesystem ownership/access before service activation: the coordinator must read/execute the release and read configuration/credentials, while untrusted coding users must not modify them or access secrets/state. Staging initially creates private directories owned by the invoking operator; selecting `--service-user` does not change their ownership. The unit uses `ProtectHome=true`; choose accessible protected release/configuration locations outside home directories. Configured coordinator state and SSH enrollment directories are writable unit paths. The unit has no automatic enablement section. Administrative installation and activation remain explicit operator steps.

## Validate, diagnose and start

```bash
labstride config show --config /operator/installation.json --human
labstride extensions inspect --config /operator/installation.json --json
labstride config validate --config /operator/installation.json --json
labstride state init --config /operator/installation.json
labstride doctor --config /operator/installation.json --human
```

`config validate` collects schema/profile, credential-file, extension, provider binding and policy-grant diagnostics. Doctor additionally probes repository scope, SSH/helper roots/capabilities, optional session compatibility and broker readiness, then reads database integrity, projection backlog, provider catch-up/errors and recovery blockers. Independent failures are collected; missing dependencies cannot be interpreted as success. Messages identify corrective work without echoing rejected values, credential contents or arbitrary upstream diagnostics. Configuration/extension inspection is an allowlisted view, excluding arbitrary extension settings and credential paths/material.

JSON remains the default; `--human` formats diagnostics and inspection output. `--json` and `--human` are mutually exclusive. Commands exit 0 on success and 1 on blockers/failure. Diagnostic, configuration, extension, recovery and probe evidence objects have versioned schemas. Read-only run/status/Doctor commands do not initialize or migrate SQLite; missing state is reported explicitly. `state init` initializes disabled, prepared state. Existing unsupported or corrupt databases are preserved and require an explicit qualified upgrade/recovery procedure.

After successful checks, the operator reviews and changes `configuration.enabled`, then explicitly starts the prepared service. `serve` takes the kernel process lock, re-runs admission checks, and composes existing provider/action/cleanup workers. Initial Project import is inert. A newly observed, authorized qualified transition can prepare one registered workspace. Existing runs keep their original configuration and pins. Enabled flags, projection values and issue content cannot grant permissions or replay effects.

The public profile supports installed first-party workspace/reservation/runtime, workflow and merge actions, beginning with workspace creation. Action targets are configured literals with explicit policy grants. Missing action adapters, unsupported field/history sources and missing independent deployment observers block enablement. Generic automated sessions and arbitrary deployment-observer loading are not supplied by this installation profile; the existing explicitly configured session/pilot interfaces retain their own qualification. A prepared workspace is readiness evidence, not task completion or cleanup permission.

## Qualify a workflow broker

Keep `broker.enabled:false` for outbound workspace-only operation. Workflow execution requires a configured HTTPS broker, listener and `brokerProbe` with an [operator-enrolled exact-run policy](../schemas/runner-probe-policy.schema.json). The probe audience must match the broker and its repository must be configured. Its bounded push-workflow qualification is separate from production workflow-dispatch/environment authorization.

While installation enablement remains false, run `labstride serve --diagnostics-only --config FILE` under the same service lock. This starts only the configured loopback diagnostic listener; it creates no execution database or workers. Route the configured HTTPS origin to that listener. The existing [OIDC runner client and inactive recipe](27-oidc-discovery-probe.md) can exercise `POST /v1/discovery/oidc-probe`. Policy, workflow, ingress and job activation require the operator's own reviewed setup. No request can supply or change probe policy.

`GET /v1/diagnostics/status` proves only HTTPS reachability to a matching configuration digest. A positive probe additionally verifies GitHub's signature, audience, exact repository/workflow/run/attempt, validity and an independent current run read. Negative cases never qualify readiness. Before acknowledging success, the listener durably stores only bounded redacted evidence in private `runner-probe.json`, using a synced atomic replacement. No operation, claim, receipt or command is created.

Evidence binds the installation, configuration, identities, artifact pins, broker route settings and probe policy. Enablement alone is excluded so the same qualification can activate the reviewed installation. Maximum age defaults to 86,400 seconds, configurable from 60 to 604,800. Missing, corrupt, future, stale or mismatched evidence blocks normal startup and new workflow dispatch/claim/effect authorization. An already-running broker still accepts original authenticated receipts and independent reconciliation. After restart, explicitly use the fenced `serve --reconcile-only` flow below to retain that access without runner readiness. Stop diagnostics-only mode before starting another coordinator mode; normal startup uses saved bound evidence so it does not require its own listener to be running first. Doctor separately checks the HTTPS route. Live route, production workflow compatibility and independent target verification remain distinct gates.

## Controls and recovery

`runs list/show` expose operation identities, outcomes, workflow run IDs, projection states/conflicts, cleanup blockers, holds, effective capacities and installation recovery status. The additive `startup` array contains validated frozen session choices, or is empty for runs without a saved selection; it includes no prompt or arbitrary effect payload. `runs pause/resume/cancel`, `runs keep RUN true|false`, `runs cleanup RUN` and `runs reconcile RUN` retain local operating-system/file authority and existing revision/audit checks. Reconcile re-enables blocked operation/projection/session observations; it does not restart uncertain effects or clear conflicts. Cancellation acceptance is distinct from observed cancellation.

For an already-restored database or recovery of original effects after runner qualification expires:

1. Keep the coordinator stopped and preserve the backup, original pins and unresolved resources.
2. Run `recovery begin`; it requires the service lock and fences new effects while retaining operation identities. Repeating it while paused preserves the epoch/checks.
3. Inspect `recovery status` and `runs show`. Run `serve --reconcile-only --config FILE` for receipt/read recovery. It requires a healthy existing database for this installation and the active fence; no database initialization, migration or configuration/policy activation occurs. Configuration, credential, field/history, extension and SSH checks remain required. `runs reconcile` can re-enable blocked reads. Unknown results and conflicts remain unresolved until independent evidence establishes their outcomes.
4. Stop the reconciliation service, then run `recovery resume` only after independent observations resolve every required check. Resume also requires the service lock. Ordinary run resume cannot clear the installation fence.
5. Qualify normal readiness, including current bound runner evidence, then explicitly restart normal `serve`.

Reconciliation-only startup is exclusive to public v2 and cannot be combined with `--diagnostics-only`. It runs operation reconciliation and projection reads, without Project admission, workflow advancement, action starts, cancellations, projection writes, summaries or cleanup. The existing durable fence also blocks new dispatch/merge intents from adapters that can initiate effects inside `reconcile`. Broker receipts retain their signed identity, original run/configuration and conflict checks; claims and effect authorization are always denied in this mode. Renewing runner evidence does not automatically resume work. Stop the process before clearing the fence; clearing or replacing its recovery epoch makes further reconciliation ticks fail closed.

Installed inspection/startup refuses unsupported schemas and performs no automatic down-migration. [W06.2](41-backup-and-upgrade.md) adds migration 20, complete backup bundles, fresh-directory restore and explicit database upgrades with paused reconciliation. Complete installed/live qualification remains open. Preserve probe evidence when rolling back; an older version cannot use that evidence as permission to replay effects. Rollback does not undo external resources, credentials, actions or GitHub changes.
