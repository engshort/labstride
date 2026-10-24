# 14 — Work packages

Build small vertical slices. Dependencies are technical sequencing, not permission to skip acceptance. The private session-provider work can begin with W00 and join W04–W06 after its own compatibility gate.

The adopted [hybrid architecture](adr/0006-hybrid-coordination.md) retains one durable coordinator, GitHub task/human authority, Actions CI/delivery and optional agent observations. The first integrated continuity proof follows W00 discovery and W01 recovery, then joins W02/W03 with the independently installed session adapter. Prove duplicate-start recovery, connection loss, missing hook/projection recovery and human takeover before expanding all delivery/cleanup subsystems. This order preserves the full MVP scope and existing dependency graph.

## W00 — Resolve integration and toolchain gates

Tracker: [#3](https://github.com/alex-engvall/labstride/issues/3).

**Prerequisites:** None.

- Record supported runtime/dependency versions and licenses.
- Prove personal Project access, workflow OIDC identity and broker reachability with synthetic fixtures.
- Probe the actual interactive client's session identity/atomic guards and optional hook availability; define versioned hook-to-event normalization without making hooks mandatory.

**First verifiable outcome:** A recorded capability matrix and reproducible discovery commands; no real deploy.

**Requirements:** LS-GH-001, LS-EXT-001

**Discovery closeout:** W00.1 / [#11](https://github.com/alex-engvall/labstride/issues/11) is completed; [PR #39](https://github.com/alex-engvall/labstride/pull/39) merged its scoped provider evidence. See the [capability and handoff matrix](evidence/README.md). W00 and LS-GH-001 remain `in_progress` for cross-package acceptance; the unrun runtime cases do not keep discovery #11 open.

**Toolchain/contract closeout:** W00.3 / [#13](https://github.com/alex-engvall/labstride/issues/13) discovery is complete for the examined environment; #13 is closed as completed and [PR #41](https://github.com/alex-engvall/labstride/pull/41) merged the foundation. This documentation follow-up records the [capability matrix and handoff](evidence/W00.3-discovery-closeout-2026-10-21.md), distinguishing operator verification, backend reads, executable fixtures and the adopted initial hooks-disabled profile. LS-EXT-001 remains `in_progress`; At that discovery handoff AC22/AC31/AC35/AC36 were `not_run`; subsequent W01.4 and W03.2 evidence is recorded below. Missing atomic guards block dependent effects and remain W01.4 work; they do not require reopening bounded discovery. Workflow OIDC/route evidence is recorded separately in W00.2; runtime acceptance stays with its owning packages.

**Workflow/route closeout:** W00.2 / [#12](https://github.com/alex-engvall/labstride/issues/12) has completed bounded discovery with the [isolated OIDC probe](27-oidc-discovery-probe.md) and [live evidence](evidence/W00.2-live-oidc-2026-10-21.md): genuine GitHub tokens, independent attempt identity, runner HTTPS, negative cases and renewal after expiry passed in two actual attempts. The temporary test service was stopped and its read token revoked. W04 still owns authenticated atomic claims/effect authorization; W01/W06 own durable recovery and installation/diagnostics. No application deploy or integrated acceptance was passed.

## W01 — Durable coordinator and operation model

Tracker: [#4](https://github.com/alex-engvall/labstride/issues/4).

**Prerequisites:** W00.

- Implement migrations, typed states, intent/outbox and atomic claims.
- Kill/restart a real process around each effect boundary.
- Apply the completed W00.1 discovery to atomic observation/checkpoint and intent/outbox persistence; preserve original operation identities and uncertain outcomes across actual coordinator crashes.
- Persist session observation and projection identity; prove missing/duplicate/late hook recovery and outbox retries without stale human-state overwrites.
- In W01.4 / #17, apply W00.3's pinned loading/profile contracts and session capability limits; preserve handle ownership, reject effects requiring unsupported atomic guards and complete AC31 plus production AC22 coverage with W07. Define/validate provider-specific question/answer payloads and verify actual client correlation/recovery.

**First verifiable outcome:** A queued synthetic operation resumes with its original ID after restart.

**Requirements:** LS-CORE-001, LS-CORE-002, LS-CORE-003, LS-CORE-004, LS-CORE-005, LS-CORE-006, LS-CORE-007, LS-EXT-003, LS-EXT-005

**W01.1 progress:** The first [durable lifecycle slice](28-durable-coordinator-store.md) has [process-crash and revision-conflict evidence](evidence/W01.1-lifecycles-2026-10-21.md). LS-CORE-001 and LS-CORE-006 are implemented locally with [resource/evidence retention coverage](evidence/W01.1-retention-2026-10-21.md). #14 closes after its two scoped PRs merge. AC01 subsequently passed in W01.2; AC20/AC36 remain integration gates and W01 stays in progress.

**W01.2 progress:** LS-CORE-002/003/004 are implemented with [local execution and observation evidence](evidence/W01.2-observations-2026-10-21.md). AC01 passed with actual process death and a separate durable effect receiver. #15 closes after all three scoped PRs merge. AC02/AC09/AC21/AC35/AC36 remain integrated gates with their owning issues; W01 remains in progress.

**W01.3 progress:** LS-CORE-005/007 have local [capacity](evidence/W01.3-capacity-2026-10-21.md), [pause/cancel](evidence/W01.3-controls-2026-10-21.md) and [automation safety](evidence/W01.3-automation-2026-10-21.md) implementation evidence. Issue #16 closes only after all three scoped PRs merge. Full AC08/AC24/AC31/AC36 and W01's remaining session integration stay open.

**W01.4 progress:** LS-EXT-003/005 are implemented with pinned loading, profile-bound session operations, an independent durable fixture and a public Codex example. After the [authorized backend upgrade](evidence/W01.4-backend-upgrade-2026-10-23.md), the [actual enrolled-client proof](evidence/W01.4-client-continuity-2026-10-23.md) retained the original identities through coordinator process death and transport loss, then observed the operator's same-client resumption and human turn. AC31 passed for the tested fixture/Codex profiles. #17's scoped implementation is ready for review and closure on merge. Full AC22 distribution and AC35 integration remain with W07/W02; W03.2 below now records the completed AC36 profile.

## W02 — Configuration and GitHub request/projection adapter

Tracker: [#5](https://github.com/alex-engvall/labstride/issues/5).

**Prerequisites:** W01.

- Compile configurable fields/rules and operator permissions.
- Implement current-state reconciliation and non-destructive projections.
- Use bounded personal-Project polling and one managed projection writer; keep human task/decision authority separate from operational records.
- Apply the completed W00.1 discovery to credential/container preflight, supported history reconciliation, actor/binding/generation authorization and safe cursor/error/budget/expiry handling; reject unsupported bindings and historical starts on initial import.
- Apply W00.3's session observation boundary to authorized, generation-bound projections; optional hooks cannot grant human intent or replace backend reconciliation.

**First verifiable outcome:** A test Project field transition creates exactly one queued run.

**Requirements:** LS-CFG-001, LS-CFG-002, LS-CFG-003, LS-CFG-004, LS-CFG-005, LS-GH-002, LS-GH-003, LS-GH-004, LS-GH-005

**W02.1 progress:** LS-CFG-001/002/003/005 have [compiler/admission implementation evidence](evidence/W02.1-configuration-2026-10-23.md): two mappings, typed rules/inputs, pinned preflight, transactional snapshots, inert initial observations, conflicts and actual process-loss recovery. This trusted local slice is ready for scoped review. Actor/policy authority remains with #19; actual GitHub polling, binding refresh, bootstrap classification and projection reconciliation remain with #20. Full AC04/AC06/AC26 and AC35/AC36 retain their documented integration gates.

**W02.2 progress:** LS-CFG-004/LS-GH-002 are implemented with [authorization and policy evidence](evidence/W02.2-authorization-2026-10-23.md): independent actor attribution, bounded policy, explicit active-run policy renewal, durable emergency restrictions, effect/cancellation gates and process-loss recovery. A fresh live GitHub actor event was denied with zero executable records. Production polling/bootstrap remains #20; production broker/deploy acceptance remains W04. Full AC03/AC23/AC35 remain integration gates.

**W02.3 progress:** LS-GH-003/004/005 are implemented with [coordinator recovery and live GitHub evidence](evidence/W02.3-reconciliation-2026-10-23.md): qualified bounded polling, inert bootstrap, actor/generation-bound admission, signed webhook persistence, one checked projection writer and visible conflicts. A missed live transition created one queued run/workspace record; stable-ID renames, lost-write acknowledgement and restart did not retrigger it. AC02/AC04/AC05 have scoped evidence; actual SSH/session continuity in full AC35/AC36 remains with W03 and its session integration. #20 closes on merge of its scoped delivery; W02 and cross-package requirements are not declared fully verified.

## W03 — SSH and independent workspace action

Tracker: [#6](https://github.com/alex-engvall/labstride/issues/6).

**Prerequisites:** W01.

- Implement host enrollment, trusted helper and resource registry.
- Create and reconcile independent source workspaces.
- Qualify W00.3's observed SSH prerequisite through real enrolled target/workspace effects and direct results without fabricated workflow identity.

**First verifiable outcome:** Two issues have separate branches/directories and recover after connection loss.

**Requirements:** LS-SSH-001, LS-SSH-002, LS-SSH-003, LS-SSH-004, LS-SSH-005, LS-SEC-001

**W03.1 progress:** LS-SSH-001/002 and LS-SEC-001 have [installed SSH/helper and pilot evidence](evidence/W03.1-ssh-boundary-2026-10-23.md): explicit audited enrollment/rotation, strict host identity, structured forced-command requests, separate protected identities and durable reservation recovery after actual SSH reply loss/coordinator death. AC06/AC07 passed for the tested Linux profile. #21's boundary delivery is ready for scoped review and closure on merge. W03.2 below supplies source workspaces and AC36; #23 owns optional runtime resources. Full AC19 and AC35 remain with W05 and their owning integration packages. W03 stays `in_progress`.

**W03.2 progress:** LS-SSH-003/004 have an implemented public action/helper path with real Git, authenticated HTTPS, process-kill, durable-worker and installed Linux/SSH coverage (466 passing pilot tests). [Evidence and remaining gates](evidence/W03.2-workspaces-2026-10-23.md) distinguish local/isolated transport tests from the enrolled pilot and actual client. The [continuity integration](evidence/W03.2-continuity-2026-10-23.md) adds the managed session action and an explicit owned-fixture probe; its authorized GitHub/SSH fault and recovery phases passed on the pilot, with all 478 final regression tests passing. AC08/AC09 passed for the tested Linux source-checkout profile. AC36 also passed after the actual same-client human turn and stale-continuation refusal across another restart. [Native issue-field integration](35-native-issue-fields.md) preserves the operator-selected permanent source/field configuration. The [real private-source qualification](evidence/W03.2-private-source-2026-10-24.md) now proves separately authorized HTTPS fetching, actual SSH reply loss/coordinator death, same-resource recovery without valid source authorization and credential isolation. LS-SSH-003/004 are verified for the tested Linux profile; #22 is ready for closure. W03 runtime resources remain with W03.3.

**W03.3 progress:** LS-SSH-005 is verified for the tested installed Linux/SSH profile through the separate pinned runtime action, protected recipe drivers and generated per-workspace resource namespaces. [Actual SQLite/HTTP, role isolation, reply-loss and coordinator-SIGKILL evidence](evidence/W03.3-runtimes-2026-10-24.md) records 509 passing pilot tests with no skips, plus 30 passing helper-UID tests. Two independent complete cases retain the original operations/resources and coding edits across recovery; earlier partial operator cases remain unknown and preserved. The original five pilot workspaces, registry, policy and launcher remain unchanged. #23 closes on merge of [PR #63](https://github.com/engshort/labstride/pull/63). Full AC30 cleanup execution stays with W05; W04 owns general workflow advancement and W06 installed continuous operation.

## W04 — Workflow broker, CI and delivery action

Tracker: [#7](https://github.com/alex-engvall/labstride/issues/7).

**Prerequisites:** W02, W03.

- Implement authenticated claims, receipt validation and dispatch reconciliation.
- Recheck exact-revision CI/merge permissions; invoke own test deploy workflow.

**First verifiable outcome:** A test deployment is tied to the correct source and workflow revisions and verified target.

**Requirements:** LS-GH-006, LS-GH-007, LS-DEP-001, LS-DEP-002, LS-DEP-003, LS-DEP-004, LS-DEP-005, LS-DEP-006, LS-SEC-002

**Bounded local delivery:** [The issue-to-review profile](37-local-self-build.md) adds ordered checkout/coding/publication and current-head CI observation. [Evidence](evidence/W04-W06-local-self-build-2026-10-24.md) distinguishes controlled local integration from live acceptance. The first live agent canary exposed a native history-profile mismatch; the [bounded correction](evidence/W04-W06-native-history-2026-10-24.md) preserves its unknown delivery and qualifies a separate legacy-history Plan probe. The [report-journal correction](evidence/W04-W06-report-journal-2026-10-24.md) addresses native tool calls omitted by legacy history; installation and live publication remain separate gates. The [shallow-publication correction](evidence/W04-W06-shallow-publication-2026-10-24.md) separates local preparation from remote intent and adds evidence-bound lost-acknowledgement recovery. The [bounded-report observation correction](evidence/W04-W06-bounded-report-observation-2026-10-24.md) avoids reloading large native transcripts for journaled reports and later ordinary conversation. The opt-in W04.1 broker is described below; live automatic merge and verified deployment remain open. W04 stays `in_progress`.

**W04.1 progress:** [Authenticated workflow execution](38-workflow-broker.md) implements pinned enrollment, independent OIDC/run-attempt verification, atomic runner claims and one-time effect permission, dispatch/receipt recovery and target serialization. [Local evidence](evidence/W04.1-workflow-broker-2026-10-24.md) covers actual HTTP, independent durable effects and coordinator process death. Live Actions/HTTPS, dedicated dispatch credentials and installed credential separation remain open. #25 owns target health/revision and recipe recovery; full AC10/11/12/23/34/35 are not declared passed.

**W04.2 progress:** Optional [deployment profiles](19-deploy-and-recipes.md) combine bound receipts and exact GitHub attempt conclusions with independent target revision/health observations. [Local evidence](evidence/W04.2-deployment-verification-2026-10-24.md) covers target/service state, atomic finalization, coordinator process death, retained failure/uncertainty and explicit recipe recovery limits. LS-DEP-003/006 are implemented for that controlled profile, not verified for a live installed delivery environment. #25 remains incomplete; AC11/AC16 retain live/integrated gates, W05 owns cleanup execution and #27 owns stale-release ordering.

**W04.3 progress:** The opt-in [current-revision merge action](39-current-revision-merge.md) implements LS-GH-006/007 for a strict direct-merge profile with configurable enrollment, independent protection/CI inventory, expected-head enforcement, actual merge-SHA readback and durable branch serialization. [Local evidence](evidence/W04.3-merge-gate-2026-10-24.md) covers stale heads, absent checks, policy revocation, response loss and actual coordinator death. Dedicated live protection/credential and downstream-trigger qualification remain open; AC13/AC14 remain `not_run` at their full/live level and #26 stays incomplete. Existing AC35/AC36 evidence is unchanged.

**W04.4 progress:** LS-DEP-005 adds queue-time deployment identity, transactional target ordering and explicit supersession before dispatch. Confirmed merge containment and fresh independent target evidence can fulfill an earlier superseded step without rewriting it as a verified deployment. [Local evidence](evidence/W04.4-deployment-ordering-2026-10-24.md) covers AC15's bounded newer-wins slice, negative successor cases, independent environments, reply loss and coordinator death. Full live AC15, installed recovery and legacy-target qualification remain open; #27 remains incomplete. AC35/AC36 are unchanged and W05 retains cleanup execution.

## W05 — Directory cleanup action

Tracker: [#8](https://github.com/alex-engvall/labstride/issues/8).

**Prerequisites:** W03, W04.

- Implement policy eligibility, keep/quiescence and dirty/unpushed checks.
- Implement safe target deletion with durable tombstones.

**First verifiable outcome:** One eligible directory is removed; blocked and unrelated paths remain intact.

**Requirements:** LS-CLN-001, LS-CLN-002, LS-CLN-003, LS-CLN-004, LS-CLN-005

**W05.1 progress:** LS-CLN-001/002/003 are implemented for the bounded local assessment profile. [Cleanup specification](20-workspace-cleanup.md) and [local evidence](evidence/W05.1-cleanup-2026-10-24.md) cover configurable triggers/pinned actions, independent completion/retention/session gates, read-only Git preservation and durable assessment recovery across actual coordinator death. This slice reports pending handoff or retention, never deletion. Full AC17/AC18/AC30 remain `not_run` for installed/removal integration; #29 owns filesystem fencing, deletion and tombstones. AC35/AC36 are unchanged.

**W05.2 progress:** LS-CLN-004/005 add the optional qualified deletion action, protected target fencing/move/removal, immutable tombstones and independent coordinator reconciliation. [Local evidence](evidence/W05.2-deletion-2026-10-24.md) covers actual removal, substituted-path preservation, lost acknowledgements and actual helper/coordinator SIGKILL boundaries. Successful removal uses an injected quiescence seam; privileged process/mount/ownership and installed SSH qualification remain open. Requirements are `implemented`, full AC19/AC20 remain `not_run`, and W05 remains `in_progress`. Runtime disposal and broader AC17/AC18/AC30 plus AC35/AC36 gates retain their owners.

## W06 — CLI, installation and operations

Tracker: [#9](https://github.com/alex-engvall/labstride/issues/9).

**Prerequisites:** W02, W03, W04.

- Implement operator diagnostics and pause/reconcile controls.
- Exercise backup, upgrade and restore with unresolved external effects.
- Complete W00.1's runtime handoff through Doctor diagnostics for missing capabilities, invalid cursors, expired credentials and unknown outcomes; verify AC29 using the owning GitHub/broker/host slices.
- Package the CLI and single service together; diagnose optional hook/session compatibility without a hosting/control-panel dependency.
- Apply W00.3's capability matrix: diagnose hooks-disabled, missing/untrusted hooks and unsupported atomic guards. Support W01.4 / #17's session-provider enablement/continuity gates operationally; manual client verification and fixture success do not pass AC31/AC35/AC36.

**First verifiable outcome:** A fresh operator can diagnose and recover a run without editing database rows.

**Requirements:** LS-OPS-001, LS-OPS-002, LS-OPS-003, LS-OPS-004, LS-OPS-005

**Bounded local delivery:** [The operational CLI/bootstrap](37-local-self-build.md) implements disabled installation, a locked persistent loop, dedicated App preflight, controls, summaries and SQLite backup. Installed doctor, scoped credentials, negative access probes, idle process restart and two isolated No agent runs passed the bounded pilot. The [version canary slice](evidence/W06-version-canary-2026-10-24.md) adds credential-free release/development identity output; it does not close the native publication gate. Full recovery/upgrade and clean-install acceptance remain open. W06 stays `in_progress`; W07 is not completed by this slice.

**W06.1 public delivery:** [Prepared-host installation and diagnostics](40-public-installation.md) add a v2 public profile, personal Project/no-agent composition, independent safe diagnostics, signed runner qualification, inspection and restore fencing controls. [Local evidence](evidence/W06.1-public-operations-2026-10-24.md) covers AC29 blockers and actual temporary checkout/recovery behavior. Installed SSH/systemd/runner and session qualification remain open; LS-OPS-001 and W06 remain `in_progress`, AC29 remains `not_run`, and AC35/AC36 are unchanged.

**W06.1 recovery/inspection correction:** [Follow-up evidence](evidence/W06.1-recovery-inspection-2026-10-24.md) covers explicit fenced reconciliation after runner qualification expires, service exclusion before recovery resume and retained frozen startup choices after an uncertain session create. It separates earlier privileged verification at `6367981` from this revision's local regression evidence. The requirement/scenario statuses above remain unchanged.

**W06.2 delivery:** [Backup and upgrade](41-backup-and-upgrade.md) add complete SQLite/pinned-artifact bundles, fresh-directory restore, transactional explicit database upgrade, interruption markers and session/projection recovery checks. [Evidence](evidence/W06.2-backup-upgrade-2026-10-24.md) covers older-backup recovery against a durable effect peer, migration failure with handles, retained versions and actual SIGKILL boundaries. LS-OPS-002/003 are implemented locally; full installed/live AC21/AC27 remain `not_run` with W06/#9 and W07/#10. Native self-build recovery remains separately gated. W06 remains `in_progress`.

## W07 — Public examples and prerelease

Tracker: [#10](https://github.com/alex-engvall/labstride/issues/10).

**Prerequisites:** W05, W06.

- Validate a clean public install without private extensions.
- Finish DCO, reporting route, contract SDK, examples and release evidence.
- Complete W00.3's runtime/package dependency integrity, notices and clean-install qualification with W01, preserving the agent-independent public path.

**First verifiable outcome:** A versioned prerelease with all P0 acceptance evidence and explicit platform limits.

**Requirements:** LS-EXT-002, LS-EXT-004, LS-SEC-003, LS-OSS-001, LS-OSS-002, LS-OSS-003, LS-OSS-004

## PR handoff

State the problem and observable result, relevant LS/AC IDs, dependencies, contract changes, verification evidence, untested limits and recovery plan. A work package may need several small PRs. Do not use a requirement count as a reason for one oversized PR.
