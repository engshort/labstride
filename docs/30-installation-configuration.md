# 30 — Installation configuration compiler and admission

W02.1 / [#18](https://github.com/alex-engvall/labstride/issues/18) implements configuration compilation and a trusted coordinator embedding API. [Configuration semantics](08-configuration-and-rules.md) remain normative. This compiler slice supplies no GitHub listener/poller, operator CLI or workflow orchestration loop. W02.2 now adds the [separate actor/policy boundary](31-authorization-and-policy.md). The [evidence report](evidence/W02.1-configuration-2026-10-23.md) distinguishes local behavior from those integration gates.

## Compile and inspect

`compileConfiguration(input, dependencies)` accepts an unknown parsed JSON value and returns a versioned success/failure union. Failure diagnostics contain a stable code, configuration path and corrective message; rejected values and resolved secrets are not echoed. Success contains an immutable `CompiledConfiguration` with its snapshot and typed step/workflow binding methods. Activation accepts only an object produced by this compiler, not an externally supplied object with the same properties.

Dependencies are reviewed installation code: an explicit extension lock, host protocol/capabilities/permissions, `secrets.exists(reference)` and `provider.describeField(field, credentialRef)`. The secret interface returns only availability, never secret material. Credential settings use `secret:` references. Inline credentials do not belong in configurations or pins. Other extension settings must follow their reviewed schema and reference-based secret convention.

The compiler checks the local config/lock schemas, exact installed extension identities/versions/integrities, protocol, permissions, capabilities and schemas through the existing loader's inspection API. It checks target configurations against the selected connector schema, rules and field/option references, control values, projections, action selection and known input types. It does not import extension modules or invoke actions. A real credential-free HTTPS broker URL is required; the shipped `example.invalid` template is deliberately not enableable.

The provider returns a [qualified field binding](../schemas/provider-binding.schema.json) for the selected credential and exact source/container/field/type. It declares readability, writability, supported operators, transition history and actor attribution, with evidence references. `changedTo` requires its declared operator, history and actor-attribution support. These descriptions are supplied by the trusted adapter; they are not proof derived from issue content or generic API readability. W02.3 supplies and refreshes [credential-specific GitHub descriptions](32-github-reconciliation.md), including the W00 history limitations. No provider or credential is silently substituted.

Logical select keys resolve to configured external option IDs. Unknown, deleted, duplicated or wrong-type options fail. Optional provider display names are excluded from the frozen identity, so renaming fields/options without changing IDs preserves bindings and the digest. Managed projection fields cannot alias start-predicate or control fields, including through different logical names.

## Binding inputs and evaluating rules

| Input notation | Meaning |
| --- | --- |
| `"context.source"`, `"context.mergeSha"`, `"context.workspaceId"` | Existing reserved typed tokens |
| `{"binding":"context","context":"source"}` | Explicit typed recorded-context binding |
| `{"binding":"field","field":"logicalName"}` | Validated observed field value; select values are external IDs |
| `{"binding":"literal","value":"context.source"}` | Literal JSON, including reserved tokens/objects |
| Other JSON strings/objects/arrays | Literal structure with recursively compiled bindings |

Single-select field bindings may include an explicit option-ID-to-string `mapping`. Unmapped choices block binding; runtime model/reasoning choices have no implicit fallback. Registered path/session projection outputs use the [native field contract](35-native-issue-fields.md).

Unknown `context.*` tokens fail compilation. Data retrieved from fields is never interpreted again as a binding, code, extension URL or shell expression. Actions are selected by trusted workflow IDs and exact installed versions. A step's `target`, when supplied, is a configured literal target ID. Paths and action-specific root enforcement remain connector/action responsibilities.

`bindStep(workflow, stepId, fields, recordedContext)` resolves one step and validates its complete inputs against the original pinned action schema. It rechecks artifact integrity before binding. `bindWorkflow` does the same for all steps when all required context already exists. Static preflight catches known type/reference/shape mismatches; context-dependent and other schema constraints are enforced on the fully materialized input before scheduling. Later steps retain their binding descriptors until their context is recorded. W04 owns ordered advancement and effects for those steps.

`evaluateRules(snapshot, observation)` consumes the [versioned normalized observation](../schemas/rule-observation.schema.json) and returns a [rule decision](../schemas/rule-evaluation.schema.json): `matched`, `no_match`, `blocked` or `rule_conflict`. Observations identify the configuration digest and preserve the normalized event, request generation, initial-sync flag and current/previous field states. The trusted adapter must resolve those states against the recorded binding IDs and refresh provider facts. This evaluator does not authenticate a caller's claim of human origin or initial-sync provenance. W02.2 admission separately requires evidence from an enrolled actor verifier; W02.3 owns initial-sync and history provenance.

Field states distinguish an unavailable observation (missing map entry), confirmed absence (`{"present":false}`) and an observed value (`{"present":true,"value":null}` is explicit null). `exists` tests presence, including null. Other comparisons on confirmed absence return false. Unavailable values, malformed dates, wrong types and unknown select IDs block evaluation; `not` and `any` cannot hide an invalid operand. Multi-select equality ignores option order. `contains` supports strings or one multi-select option. No scalar coercion or model fallback occurs.

Every branch of a `field.changed` start condition must require a positive `changedTo`. It compares known previous/current states, not continuous matching of a retained value. Initial sync is inert; non-human origins cannot start work. Duplicate condition trees are rejected in preflight. All candidate rules are evaluated before choosing a workflow; multiple matches produce `rule_conflict` with all matching IDs and no selected workflow. No rule-order precedence is inferred.

## Activate, admit and recover

`startCoordinator` now exposes `ConfigurationStore`. These are trusted local embedding APIs; W02.2 requires an enrolled operator capability for activation and independent actor evidence plus bounded policy for admission. Audit context alone grants no permission. They are not authenticated network endpoints:

- `activateConfiguration(compiled, expectedRevision, authorization, authority)` writes the immutable snapshot, installation revision, active pointer, scheduling limits and audit atomically. A lost acknowledgement can be read/replayed without advancing the same revision twice. `enabled:false` suppresses new configured starts; it does not infer an emergency revocation of active runs.
- `requestConfiguredStart(compiled, observation, recordedContext, buildPlan, authorization)` persists the observation and rule decision. For one match it binds the first step, checks the reviewed local builder's first operation, then commits the run/snapshot association and original lifecycle/outbox records in the same SQLite transaction. Historical, invalid, unchanged and conflicting inputs produce no execution graph. Binding failures become durable blocked decisions.
- `configurationReceipt(inboxId)` reads the original decision/run identity. Repeated external event IDs return that receipt; changed content under an existing ID conflicts. Acquisition timestamps do not create a new request.
- `runConfiguration(runId)` retrieves the original [configuration snapshot](../schemas/configuration-snapshot.schema.json). Its digest is checked against the payload and run. Operations must retain that digest, configured source repository/target and pinned action/version before new effects. Missing or changed snapshots block new action, cancellation and projection effects while retaining the original records for investigation and read-only reconciliation.

The builder creates ordinary W01 identities and operation descriptors; it receives the first bound step as a one-element array and cannot redirect the action, input payload or literal target. Only trusted local code may provide this builder. W02.2 enforces actor allowlists, policy changes and emergency controls at the separate policy boundary. W02.3 owns actual GitHub observations, ordering, generations, bootstrap classification and projection capabilities. Low-level legacy W01 fixture APIs remain trusted embedding APIs; configured installations cannot omit a required snapshot to use those APIs as a bypass.

Ordinary configuration activation changes the current revision for new runs. Existing runs keep their immutable revision, extension pins and recorded bindings through restart and subsequent state changes. Snapshots contain reference strings, not secret values or extension module source. Digests use the existing deterministic SHA-256 JSON serialization and include effective configuration, qualified ID/capability bindings and extension lock. Multi-select projection envelopes now retain strings, booleans, numbers, dates, nulls and option-ID arrays without coercion; actual provider support still requires qualification.

## Migration and limits

Migration v10 appends snapshot storage, an active installation pointer, nullable run snapshot marker and append-only rule decisions. Earlier migration text/checksums stay unchanged. Existing v9 runs retain their records and handles; their marker remains null, and `runConfiguration` reports null instead of inventing missing evidence. Installing the new configuration path cannot rebind an old run to current settings.

Pause effects and take a consistent SQLite backup before upgrading. There is no automatic down-migration. Restoring an earlier database requires reconciliation against any external effects completed since the backup. Preserve pinned artifacts and secret references required by active runs. Snapshot absence/corruption is an explicit blocked condition, not permission to replay an uncertain effect.

The W02.1 tests use Linux/Node 24.22.0, owned temporary databases, synthetic provider descriptions, an installed public test action and actual process death. Their compiler coverage alone does not establish GitHub polling/rename/permission behavior, SSH root enforcement, distribution, a public CLI or production readiness. The later [W02.3 evidence](evidence/W02.3-reconciliation-2026-10-23.md) passes AC04 for its tested GitHub profile. Full AC06/AC26 and AC35/AC36 retain their documented target/integration gates.

The native self-build installation additionally requires all selectable agent
option IDs to have explicit runtime mappings, with no orphan runtime keys. Modes
must resolve to `plan`, `default` or `none`. Runtime doctor checks the default
model/reasoning pair and confirms every configured model and reasoning value is
usable in the observed catalog. It does not promise that every model supports
every reasoning effort; an explicit unsupported pair remains blocked at startup.
