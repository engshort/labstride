# 13 — Pilot and release

## Delivery order

First prove the public foundation using an owned test repository and disposable target. In parallel, an external/private session-provider implementation exercises the same extension interface. Bring both together for the operator's pilot, then prepare a public prerelease.

An initial private adoption does not make the public core incomplete: the core must perform workspace/deployment/cleanup workflows without that private agent.

## Gates

| Gate | Observable exit condition |
| --- | --- |
| G00: integration feasibility | Actual GitHub/Project identity, broker route and workflow identity are verified; incompatible capabilities are reported |
| G01: durable core | Duplicate/concurrent/restarted work does not create uncontrolled duplicate effects |
| G02: workspace | Real SSH workspace creation, independent parallel work and recovery pass |
| G03: workflow | Own CI/deploy workflow produces a bound receipt and verified revision/health result |
| G04: cleanup | Owned directory is removed; keep, dirty, unpushed and busy cases preserve it |
| G05: agent integration | Same session can be opened/continued in the operator's existing client; exact plan approval and takeover behavior pass |
| G06: owner pilot | One complete real issue and two concurrent issues pass with retained evidence and a recovery exercise |
| G07: public prerelease | Clean installation, license/DCO, reporting route, docs, examples and versioned artifacts pass |

W00.1/W00.3 and the [live W00.2 OIDC/HTTPS matrix](evidence/W00.2-live-oidc-2026-10-21.md) provide G00's bounded feasibility evidence for the examined profile and report unsupported capabilities. No integrated application/delivery gate is passed: installed capability enforcement, durable effects, workspace/session continuity and production broker behavior remain with their implementation packages. Activation of the isolated discovery probe was not an application deployment.

## Public release

Use semantic versions for packages and schema/protocol versions separately. First release is a prerelease with Linux-only verified support. Pin dependency and action revisions, publish release notes, include migration/backup notes and provide checksums. Record source provenance and licenses.

## Upgrade and rollback

Drain or pause new effects, back up SQLite with a consistent backup procedure, keep old extension versions needed by active runs, and apply schema migrations transactionally where possible. Restoration must reconcile provider/target state before effects resume. Do not roll a database back and blindly replay its older outbox.

Application rollback belongs to the deploy recipe. Not every database migration is reversible. Report restore/forward-fix requirements explicitly rather than promising universal rollback.

[W06.2 backup and upgrade](41-backup-and-upgrade.md) implements complete SQLite/artifact bundles, fresh-directory restore and the explicit `upgrade --backup` database command. A maintenance marker prevents interrupted publication from activating; migrations and the recovery fence commit atomically. [Local evidence](evidence/W06.2-backup-upgrade-2026-10-24.md) does not pass installed/live AC21/AC27 or native self-build recovery qualification. Release installation remains operator-managed.
