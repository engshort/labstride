# 04 — Feature checklist

Generated from backlog.json. Edit the JSON and regenerate; do not maintain a second independent status list.

## LS-CORE-001 — Persist runs and independent lifecycles

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W01 |

Specification: [07-lifecycle-and-recovery.md](07-lifecycle-and-recovery.md).

- A coordinator restart retains run, workspace, operation and deployment facts without collapsing them into one phase.
- Recovery retains the original issue generation, workspace and enrolled session identities; GitHub remains the task/human-decision interface.

Verification evidence: evidence/W01.1-lifecycles-2026-10-21.md, evidence/W01.1-retention-2026-10-21.md

Implementation issue: [#14](https://github.com/alex-engvall/labstride/issues/14).

## LS-CORE-002 — Commit intent before side effects

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W01 |

Specification: [06-architecture.md](06-architecture.md).

- Crash tests prove effects are never initiated before their intent is durable.

Verification evidence: evidence/W01.2-inbox-2026-10-21.md, evidence/W01.2-effects-2026-10-21.md, evidence/W01.2-observations-2026-10-21.md, evidence/W04-W06-local-self-build-2026-10-24.md, evidence/W04-W06-shallow-publication-2026-10-24.md

Implementation issue: [#15](https://github.com/alex-engvall/labstride/issues/15).

## LS-CORE-003 — Deduplicate events and operation claims

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W01 |

Specification: [07-lifecycle-and-recovery.md](07-lifecycle-and-recovery.md).

- Concurrent delivery/claim attempts produce one authorized active operation.
- Duplicate or late session/hook observations cannot create another run, cross a privileged effect boundary or regress a newer generation.

Verification evidence: evidence/W01.2-inbox-2026-10-21.md, evidence/W01.2-effects-2026-10-21.md, evidence/W01.2-observations-2026-10-21.md

Implementation issue: [#15](https://github.com/alex-engvall/labstride/issues/15).

## LS-CORE-004 — Preserve unknown outcomes

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W01 |

Specification: [07-lifecycle-and-recovery.md](07-lifecycle-and-recovery.md).

- A lost effect response blocks blind repetition and retains enough identity for reconciliation.

Verification evidence: evidence/W01.2-inbox-2026-10-21.md, evidence/W01.2-effects-2026-10-21.md, evidence/W01.2-observations-2026-10-21.md, evidence/W04-W06-local-self-build-2026-10-24.md, evidence/W04-W06-shallow-publication-2026-10-24.md

Implementation issue: [#15](https://github.com/alex-engvall/labstride/issues/15).

## LS-CORE-005 — Bound concurrency and preserve separate workspaces

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W01 |

Specification: [07-lifecycle-and-recovery.md](07-lifecycle-and-recovery.md).

- Two issues run independently within configured limits; a second active run for the same issue is rejected or queued.

Verification evidence: evidence/W01.3-capacity-2026-10-21.md, evidence/W01.3-automation-2026-10-21.md

Implementation issue: [#16](https://github.com/alex-engvall/labstride/issues/16).

## LS-CORE-006 — Keep metadata outside disposable directories

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W01 |

Specification: [06-architecture.md](06-architecture.md).

- Deleting a workspace leaves run, merge, deployment and cleanup evidence available.

Verification evidence: evidence/W01.1-retention-2026-10-21.md

Implementation issue: [#14](https://github.com/alex-engvall/labstride/issues/14).

## LS-CORE-007 — Pause and cancel truthfully

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W01 |

Specification: [07-lifecycle-and-recovery.md](07-lifecycle-and-recovery.md).

- Pause prevents new effects; cancellation reports actual/unknown target state rather than assumed rollback.
- A human interruption or takeover cannot be reversed by hook-driven continuation; stale automated sends are rejected or safely blocked when guards are unsupported.

Verification evidence: evidence/W01.3-controls-2026-10-21.md, evidence/W01.3-automation-2026-10-21.md

Implementation issue: [#16](https://github.com/alex-engvall/labstride/issues/16).

## LS-CFG-001 — Validate and snapshot configuration

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W02 |

Specification: [08-configuration-and-rules.md](08-configuration-and-rules.md).

- Unknown keys, missing bindings and incompatible capabilities fail preflight; enabled runs retain a configuration digest.

Verification evidence: evidence/W02.1-configuration-2026-10-23.md

Implementation issue: [#18](https://github.com/alex-engvall/labstride/issues/18).

## LS-CFG-002 — Configure arbitrary supported fields and values

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W02 |

Specification: [08-configuration-and-rules.md](08-configuration-and-rules.md).

- Two installations use different field/option names and IDs without core edits; type mismatches are rejected.

Verification evidence: evidence/W02.1-configuration-2026-10-23.md, evidence/W04-W06-local-self-build-2026-10-24.md

Implementation issue: [#18](https://github.com/alex-engvall/labstride/issues/18).

## LS-CFG-003 — Evaluate typed rules without code execution

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W02 |

Specification: [08-configuration-and-rules.md](08-configuration-and-rules.md).

- Shell syntax and executable text remain literal data and cannot select uninstalled operations.

Verification evidence: evidence/W02.1-configuration-2026-10-23.md, evidence/W03.2-native-fields-2026-10-24.md

Implementation issue: [#18](https://github.com/alex-engvall/labstride/issues/18).

## LS-CFG-004 — Use trusted policy revisions

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W02 |

Specification: [08-configuration-and-rules.md](08-configuration-and-rules.md).

- A PR or issue cannot expand permissions; emergency revocation blocks the next privileged action in an active run.

Verification evidence: evidence/W02.2-authorization-2026-10-23.md, evidence/W02.2-live-authorization-receipt-2026-10-23.json

Implementation issue: [#19](https://github.com/alex-engvall/labstride/issues/19).

## LS-CFG-005 — Handle conflicting and historical matches

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W02 |

Specification: [08-configuration-and-rules.md](08-configuration-and-rules.md).

- Conflicting start rules block effects; initial sync does not automatically start historical matching issues.

Verification evidence: evidence/W02.1-configuration-2026-10-23.md

Implementation issue: [#18](https://github.com/alex-engvall/labstride/issues/18).

## LS-GH-001 — Prove provider credential capabilities

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | in_progress | W00 |

Specification: [09-github-and-workflow-contract.md](09-github-and-workflow-contract.md).

- Personal Project and repository operations are verified with the selected minimal credentials or reported unsupported.
- Record personal-Project observation/actor capabilities separately from repository Actions triggers and verify token-dependent downstream CI behavior.

Verification evidence: [Completed W00.1 discovery (#11, merged PR #39); runtime handoff to W01/W02/W06](evidence/README.md), [Initial broad-credential probes](evidence/W00.1-github-access-2026-10-21.md), [Dedicated App repository reads/issue writes; Project write rejected](evidence/W00.1-dedicated-app-2026-10-21.md), [Project-only PAT draft/public-issue field writes and cleanup](evidence/W00.1-project-pat-2026-10-21.md), [App file/PR writes, CI receipts, cleanup and later association limits](evidence/W00.1-app-file-pr-ci-2026-10-21.md), [PAT Status/membership actors; disposable cursor/crash/overlap probes and explicit limits](evidence/W00.1-actor-observation-2026-10-21.md)

Implementation issue: [#11](https://github.com/alex-engvall/labstride/issues/11).

## LS-GH-002 — Authorize field-triggered requests

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W02 |

Specification: [09-github-and-workflow-contract.md](09-github-and-workflow-contract.md).

- An unapproved actor cannot start a workspace even if a signed event or field edit is received.

Verification evidence: evidence/W02.2-authorization-2026-10-23.md, evidence/W02.2-live-authorization-receipt-2026-10-23.json

Implementation issue: [#19](https://github.com/alex-engvall/labstride/issues/19).

## LS-GH-003 — Reconcile missed and duplicate events

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W02 |

Specification: [09-github-and-workflow-contract.md](09-github-and-workflow-contract.md).

- The same current request is recovered after a missed event and produces no duplicate run.
- Missing hooks and failed GitHub progress writes recover through provider observation and the durable projection outbox after coordinator restart.

Verification evidence: evidence/W02.3-reconciliation-2026-10-23.md, evidence/W02.3-live-reconciliation-receipt-2026-10-23.json, evidence/W03.2-native-fields-2026-10-24.md, evidence/W04-W06-local-self-build-2026-10-24.md, evidence/W02.3-history-isolation-2026-10-27.md

Implementation issue: [#20](https://github.com/alex-engvall/labstride/issues/20).

## LS-GH-004 — Preserve human edits and unrelated fields

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W02 |

Specification: [08-configuration-and-rules.md](08-configuration-and-rules.md).

- Projection updates only its mapped field; a concurrent human change creates a visible conflict.
- Only the coordinator projection adapter writes managed technical fields/summaries; hook/workflow observations preserve human-owned fields and decisions.

Verification evidence: evidence/W02.3-reconciliation-2026-10-23.md, evidence/W02.3-live-reconciliation-receipt-2026-10-23.json, evidence/W04-W06-local-self-build-2026-10-24.md

Implementation issue: [#20](https://github.com/alex-engvall/labstride/issues/20).

## LS-GH-005 — Separate progress from start intent

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W02 |

Specification: [08-configuration-and-rules.md](08-configuration-and-rules.md).

- Coordinator status writes and stale events cannot retrigger work.
- Agent turn-stop/session-end reports cannot imply task completion, human approval or a new start request.

Verification evidence: evidence/W02.3-reconciliation-2026-10-23.md, evidence/W02.3-live-reconciliation-receipt-2026-10-23.json, evidence/W04-W06-local-self-build-2026-10-24.md

Implementation issue: [#20](https://github.com/alex-engvall/labstride/issues/20).

## LS-GH-006 — Gate delivery on current-revision CI

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W04 |

Specification: [09-github-and-workflow-contract.md](09-github-and-workflow-contract.md).

- Missing/pending/failed required checks block merge; a new head invalidates earlier green evidence.

Verification evidence: evidence/W04-W06-local-self-build-2026-10-24.md, evidence/W04-W06-native-history-2026-10-24.md, evidence/W04-W06-report-journal-2026-10-24.md, evidence/W04-W06-shallow-publication-2026-10-24.md, evidence/W04-W06-bounded-report-observation-2026-10-24.md, evidence/W04.3-merge-gate-2026-10-24.md

Implementation issue: [#26](https://github.com/alex-engvall/labstride/issues/26).

## LS-GH-007 — Perform authorized merge without bypass

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W04 |

Specification: [09-github-and-workflow-contract.md](09-github-and-workflow-contract.md).

- Merge uses the expected head and records the merge SHA while respecting active repository protections.

Verification evidence: evidence/W04.3-merge-gate-2026-10-24.md

Implementation issue: [#26](https://github.com/alex-engvall/labstride/issues/26).

## LS-EXT-001 — Version manifests and shared schemas

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | in_progress | W00 |

Specification: [10-extensions.md](10-extensions.md).

- Unknown major versions fail before loading; optional minor capabilities are negotiated.
- Define and validate any provider hook normalization/acknowledgement envelope before enabling it; raw hook payloads are not implicitly trusted Labstride events.

Verification evidence: [Partial W00.3 toolchain/session discovery; contract and format-validation gaps](evidence/W00.3-toolchain-session-discovery-2026-10-21.md), [Reviewed contract/hook fixtures, host-profile gates, safe type generation and enforced formats](evidence/W00.3-contract-fixtures-2026-10-21.md), [Completed W00.3 discovery (#13 closed; PR #41 merged): capability matrix, hooks-disabled profile and W01.4/runtime handoff](evidence/W00.3-discovery-closeout-2026-10-21.md)

Implementation issue: [#13](https://github.com/alex-engvall/labstride/issues/13).

## LS-EXT-002 — Support public and private extensions equally

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | planned | W07 |

Specification: [10-extensions.md](10-extensions.md).

- An out-of-repo extension passes conformance without private-name branches in core.

Verification evidence: None; not implemented.

Implementation issue: [#33](https://github.com/alex-engvall/labstride/issues/33).

## LS-EXT-003 — Pin installed extension identity

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W01 |

Specification: [10-extensions.md](10-extensions.md).

- Issue content cannot install/upgrade an extension; an integrity mismatch prevents loading.

Verification evidence: evidence/W01.4-installed-sessions-2026-10-23.md, evidence/W01.4-client-continuity-2026-10-23.md, evidence/W04-W06-local-self-build-2026-10-24.md

Implementation issue: [#17](https://github.com/alex-engvall/labstride/issues/17).

## LS-EXT-004 — Publish a conformance suite

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | planned | W07 |

Specification: [10-extensions.md](10-extensions.md).

- A fixture extension passes start/observe/cancel/reconcile and malformed-output cases.

Verification evidence: None; not implemented.

Implementation issue: [#33](https://github.com/alex-engvall/labstride/issues/33).

## LS-SSH-001 — Verify SSH host identity

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W03 |

Specification: [18-ssh-workspaces.md](18-ssh-workspaces.md).

- A host-key mismatch fails before any command; explicit enrollment/rotation is documented.

Verification evidence: [Enrolled SSH/helper boundary, actual pilot identity separation and crash/transport recovery](evidence/W03.1-ssh-boundary-2026-10-23.md)

Implementation issue: [#21](https://github.com/alex-engvall/labstride/issues/21).

## LS-SSH-002 — Use a fixed helper with structured input

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W03 |

Specification: [18-ssh-workspaces.md](18-ssh-workspaces.md).

- Host, path and issue metacharacters cannot escape enrolled targets or create injected commands.

Verification evidence: [Enrolled SSH/helper boundary, actual pilot identity separation and crash/transport recovery](evidence/W03.1-ssh-boundary-2026-10-23.md)

Implementation issue: [#21](https://github.com/alex-engvall/labstride/issues/21).

## LS-SSH-003 — Create an owned exact-revision checkout

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | verified | W03 |

Specification: [18-ssh-workspaces.md](18-ssh-workspaces.md).

- The workspace contains the requested SHA on a dedicated branch and is recorded in the target registry.

Verification evidence: evidence/W03.2-workspaces-2026-10-23.md, evidence/W03.2-continuity-2026-10-23.md, evidence/W03.2-live-continuity-receipt-2026-10-23.json, evidence/W03.2-native-fields-2026-10-24.md, evidence/W03.2-private-source-2026-10-24.md, evidence/W03.2-private-source-receipt-2026-10-24.json

Implementation issue: [#22](https://github.com/alex-engvall/labstride/issues/22).

## LS-SSH-004 — Recover creation after lost acknowledgement

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | verified | W03 |

Specification: [18-ssh-workspaces.md](18-ssh-workspaces.md).

- Reconnect adopts the same owned directory; conflicting pre-existing paths are preserved and reported.

Verification evidence: evidence/W03.2-workspaces-2026-10-23.md, evidence/W03.2-continuity-2026-10-23.md, evidence/W03.2-live-continuity-receipt-2026-10-23.json, evidence/W03.2-native-fields-2026-10-24.md, evidence/W03.2-private-source-2026-10-24.md, evidence/W03.2-private-source-receipt-2026-10-24.json

Implementation issue: [#22](https://github.com/alex-engvall/labstride/issues/22).

## LS-SSH-005 — Keep app runtimes optional and isolated

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | verified | W03 |

Specification: [18-ssh-workspaces.md](18-ssh-workspaces.md).

- Source-only workspace creation works; two runtime recipes have distinct resource namespaces.

Verification evidence: [Real Linux/SSH SQLite/HTTP recipes, exact pinned actions, actual role isolation and reply-loss/process recovery; retained partial outcomes and scope limits recorded](evidence/W03.3-runtimes-2026-10-24.md), evidence/W03.3-runtime-receipt-2026-10-24.json

Implementation issue: [#23](https://github.com/alex-engvall/labstride/issues/23).

## LS-DEP-001 — Invoke repository-owned deployment workflows

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W04 |

Specification: [19-deploy-and-recipes.md](19-deploy-and-recipes.md).

- Replace the example workflow/target without core changes and record source SHA separately from workflow SHA.

Verification evidence: evidence/W04.1-workflow-broker-2026-10-24.md

Implementation issue: [#24](https://github.com/alex-engvall/labstride/issues/24).

## LS-DEP-002 — Authenticate and atomically claim execution

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W04 |

Specification: [09-github-and-workflow-contract.md](09-github-and-workflow-contract.md).

- Wrong audience/repository/workflow/run identity is denied; only one claim may cross the effect boundary.

Verification evidence: Historical W00.2 preparation: [fixture/preflight evidence](evidence/W00.2-oidc-probe-2026-10-21.md)., Completed bounded W00.2 discovery: [live OIDC/HTTPS matrix, two attempts and renewal after expiry](evidence/W00.2-live-oidc-2026-10-21.md). This discovery supports identity verification only. At the discovery handoff status remained planned; subsequent W04.1 atomic claim/effect authorization and recovery evidence is recorded separately. Full AC10/AC11/AC12 remain not_run., evidence/W04.1-workflow-broker-2026-10-24.md

Implementation issue: [#24](https://github.com/alex-engvall/labstride/issues/24).

## LS-DEP-003 — Validate bound receipts and target health

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W04 |

Specification: [09-github-and-workflow-contract.md](09-github-and-workflow-contract.md).

- Mismatched operation/digest/source/run/attempt results are rejected; required health failure cannot produce verified deploy.

Verification evidence: evidence/W04.2-deployment-verification-2026-10-24.md

Implementation issue: [#25](https://github.com/alex-engvall/labstride/issues/25).

## LS-DEP-004 — Reconcile dispatch and deploy uncertainty

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W04 |

Specification: [07-lifecycle-and-recovery.md](07-lifecycle-and-recovery.md).

- Lost dispatch/reply does not produce a second effect; ambiguous runs remain unknown until verified.

Verification evidence: evidence/W04.1-workflow-broker-2026-10-24.md

Implementation issue: [#24](https://github.com/alex-engvall/labstride/issues/24).

## LS-DEP-005 — Serialize environment delivery

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W04 |

Specification: [07-lifecycle-and-recovery.md](07-lifecycle-and-recovery.md).

- Older pending work cannot overwrite a newer verified target revision.

Verification evidence: evidence/W04.4-deployment-ordering-2026-10-24.md

Implementation issue: [#27](https://github.com/alex-engvall/labstride/issues/27).

## LS-DEP-006 — Report recipe-specific recovery

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W04 |

Specification: [19-deploy-and-recipes.md](19-deploy-and-recipes.md).

- Rollback is used only for a tested supported recipe; irreversible migration limits remain visible.

Verification evidence: evidence/W04.2-deployment-verification-2026-10-24.md

Implementation issue: [#25](https://github.com/alex-engvall/labstride/issues/25).

## LS-CLN-001 — Make cleanup a replaceable action

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W05 |

Specification: [20-workspace-cleanup.md](20-workspace-cleanup.md).

- Selecting another cleanup action/trigger changes behavior without editing core; no fixed retention timer exists.

Verification evidence: evidence/W05.1-cleanup-2026-10-24.md

Implementation issue: [#28](https://github.com/alex-engvall/labstride/issues/28).

## LS-CLN-002 — Require completion and honor keep

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W05 |

Specification: [20-workspace-cleanup.md](20-workspace-cleanup.md).

- Failed/unknown deploy, active use or keep blocks cleanup even if the PR is merged.

Verification evidence: evidence/W05.1-cleanup-2026-10-24.md

Implementation issue: [#28](https://github.com/alex-engvall/labstride/issues/28).

## LS-CLN-003 — Protect unsaved and unpushed work

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W05 |

Specification: [20-workspace-cleanup.md](20-workspace-cleanup.md).

- Tracked changes, untracked/undeclared ignored files and unpushed commits preserve the directory.

Verification evidence: evidence/W05.1-cleanup-2026-10-24.md

Implementation issue: [#28](https://github.com/alex-engvall/labstride/issues/28).

## LS-CLN-004 — Delete only the proven owned directory

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W05 |

Specification: [20-workspace-cleanup.md](20-workspace-cleanup.md).

- Root/parent/symlink/mount substitution and foreign paths are rejected before removal.

Verification evidence: evidence/W05.2-deletion-2026-10-24.md

Implementation issue: [#29](https://github.com/alex-engvall/labstride/issues/29).

## LS-CLN-005 — Recover interrupted deletion

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W05 |

Specification: [20-workspace-cleanup.md](20-workspace-cleanup.md).

- A durable target tombstone permits reconciliation without deleting another resource; duplicate requests return the original result.

Verification evidence: evidence/W05.2-deletion-2026-10-24.md

Implementation issue: [#29](https://github.com/alex-engvall/labstride/issues/29).

## LS-OPS-001 — Provide installation and diagnostics CLI

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | in_progress | W06 |

Specification: [16-operations-and-cli.md](16-operations-and-cli.md).

- A fresh operator gets actionable errors for unresolved fields, permissions, SSH and broker routing.
- The intended distribution supplies one CLI/service installation with local SQLite and configurable paths/limits; diagnostics explain optional hook fallback and actual session compatibility.
- Version JSON reports the packaged source revision and actual Node runtime without credentials, coordinator or writable state; development checkouts explicitly report no installed revision.

Verification evidence: evidence/W04-W06-local-self-build-2026-10-24.md, Bounded installed pilot: doctor, dedicated credential scope, negative access checks, idle process restart and two isolated No agent runs passed. Native approval/PR canary and full operational acceptance remain open., evidence/W04-W06-native-history-2026-10-24.md, evidence/W06-version-canary-2026-10-24.md, evidence/W04-W06-report-journal-2026-10-24.md, evidence/W04-W06-shallow-publication-2026-10-24.md, evidence/W04-W06-bounded-report-observation-2026-10-24.md, evidence/W06.1-public-operations-2026-10-24.md, evidence/W06.1-recovery-inspection-2026-10-24.md, evidence/W02.3-history-isolation-2026-10-27.md

Implementation issue: [#30](https://github.com/alex-engvall/labstride/issues/30).

## LS-OPS-002 — Back up and restore consistently

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W06 |

Specification: [16-operations-and-cli.md](16-operations-and-cli.md).

- Restored state reconciles live external effects before resuming; no stale outbox is blindly replayed.

Verification evidence: evidence/W04-W06-local-self-build-2026-10-24.md, evidence/W06.2-backup-upgrade-2026-10-24.md

Implementation issue: [#31](https://github.com/alex-engvall/labstride/issues/31).

## LS-OPS-003 — Upgrade while preserving active handles

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W06 |

Specification: [13-pilot-and-release.md](13-pilot-and-release.md).

- Pinned versions required by active operations survive upgrade, and migration failure leaves recoverable state.

Verification evidence: evidence/W06.2-backup-upgrade-2026-10-24.md

Implementation issue: [#31](https://github.com/alex-engvall/labstride/issues/31).

## LS-OPS-004 — Provide redacted operational evidence

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W06 |

Specification: [11-security-and-trust.md](11-security-and-trust.md).

- Logs/metrics contain IDs and safe reasons but no credentials, issue bodies or transcripts by default.
- Publish bounded relevant progress summaries through the coordinator instead of mirroring every tool call or full session transcripts into GitHub.

Verification evidence: evidence/W04-W06-local-self-build-2026-10-24.md, evidence/W06.3-bounded-evidence-2026-10-25.md

Implementation issue: [#32](https://github.com/alex-engvall/labstride/issues/32).

## LS-OPS-005 — Apply bounded retention and budgets

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W06 |

Specification: [16-operations-and-cli.md](16-operations-and-cli.md).

- Configured budgets stop indefinite repairs; retention does not remove unresolved-resource records.

Verification evidence: evidence/W04-W06-local-self-build-2026-10-24.md, evidence/W06.3-bounded-evidence-2026-10-25.md

Implementation issue: [#32](https://github.com/alex-engvall/labstride/issues/32).

## LS-SEC-001 — Separate policy and workspace identities

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W03 |

Specification: [11-security-and-trust.md](11-security-and-trust.md).

- The coding/workspace user cannot change trusted target ownership or coordinator policy.
- Agent-writable hook reports cannot change trusted policy/ownership, obtain privileged projection/deploy credentials or grant approval/completion authority.

Verification evidence: [Enrolled SSH/helper boundary, actual pilot identity separation and crash/transport recovery](evidence/W03.1-ssh-boundary-2026-10-23.md)

Implementation issue: [#21](https://github.com/alex-engvall/labstride/issues/21).

## LS-SEC-002 — Separate deploy credentials from coding sessions

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | in_progress | W04 |

Specification: [11-security-and-trust.md](11-security-and-trust.md).

- Agent prompts/repos lack deployment credentials; the privileged executor rechecks permission before effects.

Verification evidence: evidence/W04-W06-local-self-build-2026-10-24.md, evidence/W04-W06-native-history-2026-10-24.md, evidence/W04.1-workflow-broker-2026-10-24.md

Implementation issue: [#24](https://github.com/alex-engvall/labstride/issues/24).

## LS-SEC-003 — Verify the security-reporting route

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | planned | W07 |

Specification: [11-security-and-trust.md](11-security-and-trust.md).

- A real private vulnerability report path is configured and documented before public release.

Verification evidence: None; not implemented.

Implementation issue: [#35](https://github.com/alex-engvall/labstride/issues/35).

## LS-OSS-001 — Ship public functionality without private dependencies

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | planned | W07 |

Specification: [01-product-and-scope.md](01-product-and-scope.md).

- Clean installation can create/deploy/clean a workspace using only public packages.
- Public workspace/deploy/cleanup installation requires no agent hooks, personal Codex login, private packages or particular hosting/control-panel product.

Verification evidence: None; not implemented.

Implementation issue: [#33](https://github.com/alex-engvall/labstride/issues/33).

## LS-OSS-002 — Apply Apache-2.0 and DCO

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | planned | W07 |

Specification: [17-sources.md](17-sources.md).

- License, attribution and DCO contribution checks exist; external copyright is not misrepresented as assigned.

Verification evidence: None; not implemented.

Implementation issue: [#35](https://github.com/alex-engvall/labstride/issues/35).

## LS-OSS-003 — Publish honest examples and support scope

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | planned | W07 |

Specification: [13-pilot-and-release.md](13-pilot-and-release.md).

- Laravel example and Linux support have evidence or explicit illustrative/unverified labels.

Verification evidence: None; not implemented.

Implementation issue: [#34](https://github.com/alex-engvall/labstride/issues/34).

## LS-OSS-004 — Keep docs and implementation traceable

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | planned | W07 |

Specification: [12-test-and-quality-plan.md](12-test-and-quality-plan.md).

- Every completed requirement links acceptance evidence; generated checklist matches backlog.

Verification evidence: None; not implemented.

Implementation issue: [#34](https://github.com/alex-engvall/labstride/issues/34).

## LS-EXT-005 — Coordinate provider-neutral sessions

| Phase | Priority | Status | Work package |
| --- | --- | --- | --- |
| MVP | P0 | implemented | W01 |

Specification: [22-api-and-schema-reference.md](22-api-and-schema-reference.md).

- Start/resume/observe/send/interrupt/close preserve provider identity, reject stale human/turn revisions and explicitly report missing atomic backend guards.
- Optional hooks are correlated, deduplicated observations with backend reconciliation when missing; the existing interactive client resumes the same enrolled session, not a substituted daemon.

Verification evidence: evidence/W01.4-installed-sessions-2026-10-23.md, evidence/W01.4-backend-upgrade-2026-10-23.md, evidence/W01.4-client-continuity-2026-10-23.md, evidence/W04-W06-local-self-build-2026-10-24.md, evidence/W04-W06-native-history-2026-10-24.md, evidence/W04-W06-report-journal-2026-10-24.md, evidence/W04-W06-bounded-report-observation-2026-10-24.md

Implementation issue: [#17](https://github.com/alex-engvall/labstride/issues/17).
