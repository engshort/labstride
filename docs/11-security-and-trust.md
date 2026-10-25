# 11 — Security and trust boundaries

## Assets and boundaries

Protect deployment credentials, source code, workspace content, agent credentials, configuration authority and operation history. Untrusted inputs include public issues/comments, issue forms, PR source, dependencies and remote command output.

| Threat | Required boundary |
| --- | --- |
| Public issue requests privileged work | Resolve actor/repo permission before creating a run; pilot operator allowlist |
| Field contains shell/code/package URL | Typed rule bindings; fixed installed capabilities; no eval/interpolation |
| PR modifies deploy policy/workflow | Pinned trusted policy/workflow revision; reviewed changes before privilege expansion |
| Workflow fabricates success for another run | OIDC identity, operation claim, digest and independent run/target observation |
| SSH endpoint substituted | Enrolled host key; reject mismatch and require explicit key rotation |
| Cleanup points outside workspace root | Target registry, owned marker, safe path resolution and deletion lock |
| Agent reads deployment credentials | Separate identities, files and environments; no secrets in agent prompt |
| Malicious installed extension | Reviewed pinned artifact and least privilege; installed code is trusted, not sandboxed |
| Crash causes repeated effect | Durable intent, claim, fencing where possible and unknown-outcome reconciliation |
| Hook reports forged completion or approval | Enrolled session correlation, bounded observation contract and independent policy/provider checks |

## Identities

Separate coordinator identity, GitHub repository/project credentials, workflow identity, SSH workspace user and privileged target operations. The agent user must not be able to edit coordinator policy, host-key trust or the authoritative ownership registry.

W03.1 implements the [SSH/helper boundary](33-ssh-target-boundary.md) with distinct pilot OS identities, a restricted forced-command helper key, protected policy/registry/code and a clean execution environment. [Actual coding-user access tests](evidence/W03.1-ssh-boundary-2026-10-23.md) use synthetic credential markers and retain the original reservation. This does not qualify deployment credentials, destructive cleanup or the full AC35 integration.

An operator-approved rule grants bounded operations, not a generic terminal with production secrets. Autonomous merge/deploy can be enabled without handing the coding session the credential that enforces policy. A revocation is checked again before each privileged effect. The [W02.2 policy boundary](31-authorization-and-policy.md) separates an enrolled local operator capability from independent actor attribution, snapshots run permissions and applies durable emergency restrictions at effect/cancellation boundaries. A restriction committed after an effect boundary cannot undo the external effect.

Hooks execute within their provider's trust boundary and are not a complete enforcement or audit boundary. Agent-writable scripts cannot hold the coordinator's privileged Project/deployment credentials or become the authority for merge, approval, cleanup ownership or task completion. Use the trusted projection path and reject stale/foreign session observations. Keep agent authentication with its enrolled provider identity; do not distribute personal login caches to CI runners. Do not execute untrusted contributor code on a persistent runner carrying the agent's or deployment operator's credentials.

The [local self-build bootstrap](37-local-self-build.md) adds separate coordinator/helper/coding identities and a coding-user bridge to the existing Codex daemon. Protected installation credentials stay in the coordinator publication environment; source code is transferred as a bounded Git bundle and never executed there. [ADR-007](adr/0007-checked-codex-delivery.md) explicitly retains the race of checked delivery and does not advertise atomic ownership.

The [workflow broker](38-workflow-broker.md) binds OIDC to an independent run attempt and consumes a separate policy-checked effect permission. Its Actions credential remains with the coordinator, while delivery-provider credentials belong only to the reviewed workflow step. Receipts and observation remain available after action revocation; hooks cannot claim or authorize workflow execution. Local boundary coverage does not verify a live deployment identity.

## Data minimization

Store IDs, revisions, hashes, safe status and evidence references in the coordinator. Session transcripts remain with their session provider by default. Do not mirror whole issues, source files, prompts or secret values into audit logs. Logs may contain sensitive repo names/paths; document their access and retention.

Default metadata retention is 90 days as an adjustable design choice. Never expire active, unknown or retained-resource records. Compact only eligible resolved terminal diagnostics according to the [explicit operational retention policy](16-operations-and-cli.md#explicit-diagnostic-retention), preserving the evidence needed for still-live resources. W06.3 uses allowlisted diagnostic codes, minimized observation logs and safe receipt errors; protected execution descriptors and provider-owned transcripts have separate purposes and access boundaries. Existing historical records and backups are not retroactively scrubbed.

## Host access

Secrets are enrolled outside version control through the operator's approved secret store/file permissions or GitHub environment secrets. The SSH connector enforces host identity and a configured user/root boundary. No broad passwordless root shell is part of the default design. Exceptional privileged provisioning belongs to an explicit reviewed recipe.

## Scope of isolation

Separate directories/branches prevent accidental work overlap. They do not sandbox malicious code running under the same OS account. Use separate OS users or stronger isolation when workloads or contributors are untrusted. The pilot runs operator-approved work on a trusted host; stronger tenancy is outside the MVP.

## Release gates

Verify a private reporting route, license/provenance checks, secret scanning and boundary tests before public release. A threat-model checklist does not replace the specified executable failure/recovery tests.
