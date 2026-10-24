# Labstride documentation

Specification version 0.1.0. W01 persistence/execution/session slices and W02 configuration/authorization slices have scoped implementations; the product and live integrations remain incomplete. W00.1 GitHub access discovery (#11) is complete; its provider evidence is distinguished from remaining runtime acceptance in W01/W02/W06 and other open W00 gates.

W00.3 toolchain/contract and client-capability discovery (#13) is complete for the examined environment: #13 is closed as completed and PR #41 merged the foundation. This closeout records the remaining implementation owners. Unsupported atomic guards and the initial hooks-disabled profile remain explicit integration limits.

- [Product and boundaries](01-product-and-scope.md)
- [Existing-system lessons and evidence limits](02-design-context.md)
- [Terminology](03-glossary.md)
- [Generated requirement checklist](04-feature-checklist.md)
- [User journeys](05-user-journeys.md)
- [Runtime and persistence](06-architecture.md)
- [State, concurrency and recovery](07-lifecycle-and-recovery.md)
- [Fields and rule semantics](08-configuration-and-rules.md)
- [GitHub and workflow identity](09-github-and-workflow-contract.md)
- [Extension API and packaging](10-extensions.md)
- [Trust boundaries](11-security-and-trust.md)
- [Testing and evidence](12-test-and-quality-plan.md)
- [Gates and release](13-pilot-and-release.md)
- [Implementation sequence](14-work-packages.md)
- [Current decisions](15-decisions.md)
- [ADR-006: durable hybrid and first continuity proof](adr/0006-hybrid-coordination.md)
- [CLI and runbooks](16-operations-and-cli.md)
- [Primary references](17-sources.md)
- [SSH and workspace creation](18-ssh-workspaces.md)
- [Generic deploy action](19-deploy-and-recipes.md)
- [Cleanup contribution](20-workspace-cleanup.md)
- [Remaining implementation probes](21-readiness-and-open-gates.md)
- [Versioned schemas and broker API](22-api-and-schema-reference.md)

- [Issues and contribution forms](23-issues-and-contribution-forms.md)
- [Pull request templates](24-pull-request-templates.md)
- [Dedicated GitHub App setup](25-github-app-setup.md)
- [Completed W00.1 discovery and W01/W02/W06 handoff](evidence/README.md)
- [W00.1 GitHub access discovery evidence](evidence/W00.1-github-access-2026-10-21.md)
- [W00.1 dedicated App verification](evidence/W00.1-dedicated-app-2026-10-21.md)
- [W00.1 Project-only PAT verification](evidence/W00.1-project-pat-2026-10-21.md)
- [W00.1 App file/PR writes and downstream CI](evidence/W00.1-app-file-pr-ci-2026-10-21.md)
- [W00.1 actor attribution and observation/recovery discovery](evidence/W00.1-actor-observation-2026-10-21.md)
- [W00.3 toolchain, existing-session access and contract gaps](evidence/W00.3-toolchain-session-discovery-2026-10-21.md)
- [Contract fixtures and selected tooling](26-contract-fixtures-and-toolchain.md)
- [W00.3 implemented fixture/type/format evidence](evidence/W00.3-contract-fixtures-2026-10-21.md)
- [W00.3 capability matrix, discovery closeout and runtime handoff](evidence/W00.3-discovery-closeout-2026-10-21.md)
- [Isolated OIDC/HTTPS discovery probe](27-oidc-discovery-probe.md)
- [W00.2 live identity matrix and evidence](evidence/W00.2-live-oidc-2026-10-21.md)

## Machine-readable sources

- [Requirements](backlog.json)
- [Work packages](work-packages.json)
- [Issue mapping](issue-index.json)
- [Acceptance cases](acceptance-cases.json)
- [Agent guide](AGENT-GUIDE.md)

Keep the current specification coherent. Do not append contradictory historical decisions above current rules. The generated checklist is derived from backlog.json.

- [28 — Durable coordinator store](28-durable-coordinator-store.md)

[Installed extensions and durable sessions](29-installed-sessions.md) documents W01.4 runtime behavior, explicit probe use and remaining live gates.

[Installation configuration compiler and admission](30-installation-configuration.md) documents W02.1 typed fields/rules, immutable snapshots and recovery boundaries.

- [Request authorization and trusted policy changes](31-authorization-and-policy.md)
- [GitHub observation, generation recovery and checked projections](32-github-reconciliation.md)
- [Enrolled SSH targets and trusted helper](33-ssh-target-boundary.md)

- [Exact-revision workspaces and creation recovery](34-exact-revision-workspaces.md)

- [Recipe-owned optional application runtimes](36-recipe-owned-runtimes.md)

- [Local issue-to-review installation](37-local-self-build.md)
- [ADR-007: explicitly checked Codex delivery](adr/0007-checked-codex-delivery.md)

- [Authenticated repository workflow execution](38-workflow-broker.md)

- [Current-revision direct merge and recovery](39-current-revision-merge.md)

- [Prepared-host public installation and operator controls](40-public-installation.md)
- [Backup, restore and explicit database upgrade](41-backup-and-upgrade.md)
