# Installation and managed-workflow recovery follow-up

Scope: W01, W02 and W06; LS-CORE-005/007, LS-GH-003,
LS-EXT-005 and LS-OPS-001/004. This is repository regression evidence,
not a claim of clean-host distribution or general production acceptance.

## Changed behavior

- An occupied issue's new candidate keeps its original actor, generation and
  configuration. Its admission error and bounded backoff are persisted separately
  from provider polling. A later unrelated candidate can start within the same
  tick; new/unattempted candidates precede retried candidates across the bounded
  16-candidate batch. History-blocked items remain retained and cannot start.
- Explicit native self-build cancellation observes stable inactivity through the
  bridge's double-read cleanup observation and returns an ordinary cancelled
  action result. This can finish an idle completed plan without approving it.
  An acknowledged interrupt is observed by the normal reconciliation lane;
  interruption itself is not terminal cancellation. All uncertain managed
  effects, including a lost interrupt acknowledgement, continue to block terminal
  cancellation. Session, checkout, receipts and keep protection are retained.
- Existing native sessions accept explicit legacy or paginated history for
  observation, cleanup observation and interruption. Creation and initial
  automatic input still require the legacy profile and original freshness guards.
  Reattachment is metadata-only and never supplies plan approval.
- A latest completed ready report can acknowledge its original operation after
  the exact durably acknowledged PR has merged. Number, node ID, run marker,
  both repository IDs, branches, report SHA and a second native observation must
  match. This read path performs no publication or native input. Ordinary
  executor/runtime lifecycle guards still own completion.
- Optional issue-derived chat names are journaled separately from task/report
  delivery. Only the generated header before `Task data` is parsed and checked
  against the registered repository. Unicode labels are bounded, manual names
  are preserved, uncertain metadata writes are read-reconciled without replay.
  The backend has no atomic compare-and-set for names: a simultaneous user
  rename between the read and write cannot be perfectly protected.
- A separate root activation command verifies immutable release files, protected
  configuration, unit identities/absence of overrides, enrolled socket and
  positive/negative permissions using service users. Config validation and doctor
  gate enablement. Atomic replacement preserves owner/group and mode 0640 even
  under umask 0077; a private original-config backup survives interruption.
  Repeating activation starts existing units without restarting a coding daemon,
  replacing execution state or replaying provider mutations.
- Read-only `status --json` and `runs explain RUN_ID` expose candidate backoff,
  blocking run IDs, unresolved effect identities, capacity/budgets, manual field
  conflicts and the last observed workflow phase. They never print effect
  requests, issue bodies or transcripts, and never migrate or initialize state.

## Reproducible checks

Use the supported Node 24.22.0 runtime and locked dependencies:

```bash
npm ci --ignore-scripts
npm run check:types
npm test
python3 scripts/render_docs.py --check
python3 scripts/validate_docs.py
python3 -m unittest discover -s tests -p 'test_*.py'
```

Targeted coverage is in `github-reconciliation.test.mjs`,
`self-build-workflow.test.mjs`, `managed-codex-bridge.test.mjs`,
`installed-operations.test.mjs` and `test_install_activation.py`.
The workflow fixtures use real local Git checkouts, bundles, pushes and SQLite;
provider/native replies are controlled fixtures. Naming includes an actual writer
SIGKILL, journal reopen and lost-acknowledgement cases. Activation tests cover
preflight failure, interrupted resume, concurrent config edits, symlink
preservation, service identity arguments, secret-safe errors and group-readable
atomic writes.

## Migration and remaining gates

Migration 22 appends only candidate retry metadata. Earlier migration bytes and
checksums are unchanged. Stop the coordinator, take a complete backup and run
`labstride upgrade --backup DIRECTORY` before switching an existing installation;
resolve its recovery fence before normal startup. Retain original pinned artifacts
for existing runs. There is no automatic down-migration or patching of active
immutable releases.

The activation script intentionally supports the native Linux bootstrap profile
and unmodified generated units; it refuses unknown service overrides. The public
v2 profile keeps its prepared-host procedure. A fresh systemd VM install/activate,
actual enrolled-client continuity and a live owner-approved end-to-end issue on
this new release remain unrun. AC08/AC24/AC26/AC29 and the broader W06/W07 release
gates are not promoted by fixture success. No live installation is modified by
these repository tests.
