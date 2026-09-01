# Runtime Step 5 — workers and durable todos

Updated: 2026-08-30 (initial implementation: 2026-08-28). Assigned worktree: `/Users/jonas/.codex/worktrees/078f/Qorpera_Base-step2`.

## Delivery status

The independent component track is implemented and verified: closed contracts, a Company File todo store, in-house worker lifecycle, explicit acceptance, private continuation intent, and recovery. It is deliberately inactive: no application entry point, native provider, runner, mouth, authority gateway, Company File gateway, or wake consumer has been changed.

The original four review findings and the subsequent reassessment findings are addressed: admission acknowledgement cannot bypass live-authority status publication; blocked work has an explicit, versioned same-worker continuation protocol; and persistence coverage includes actual Company File artifact and proposal bytes. The 2026-08-30 remediation also rejects the actual `send_coworker_message` tool even under an explicit private grant and refreshes the current main interface requirements. Final verification: **84 fast tests, 17 disposable PostgreSQL tests, and a clean full repository check**.

**This is not deployed Step 5 acceptance.** No real child has executed, no parent has been interrupted or revived, and no real private continuation has been consumed. Those integrations remain main-owned and fail closed when their adapters are absent. The database tests exercise genuine persistence and existing run admission, with explicit execution/continuation test doubles.

No other session was contacted or created. No subagents, automations, real provider calls, paid tokens, real credentials, production access, live migrations, deployments, commits, pushes, or merges were used. Distinct skills loaded: **0**.

## Baseline and read-only audit

The start-of-task capture is `deploy/first-node/RUNTIME-STEP-5-BASELINE.json`, captured at **2026-08-28T16:32:05.319Z**, before implementation. It records Git revisions, complete working-tree status and **419 working-file SHA-256 hashes**. Revisions alone do not describe the dirty reference worktrees.

| Reference | Start revision | Start state |
| --- | --- | --- |
| Assigned `/Users/jonas/.codex/worktrees/078f/Qorpera_Base-step2` | `a0b692947d5c867353591b36172afcc997f0521e` | Clean, detached |
| Contract `/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2` | `18181de7f2698c9f44347a7ee141eebead84bc35` | Dirty; contract untracked |
| Main `/private/tmp/qorpera-step2-resume.rN3rbf/source` | `a20dd1ef0dbdcce31166789053b2d7bb5ab2a929` | Clean |
| Step 3 `/Users/jonas/.codex/worktrees/3c4c/Qorpera_Base-step2` | `2823637c0fd6def4cf21d3bc8e21f5f472f9d6b1` | Dirty; frozen handoff read |
| Step 4 `/Users/jonas/.codex/worktrees/5ced/Qorpera_Base-step2` | `a0b692947d5c867353591b36172afcc997f0521e` | Dirty; component handoff read |

Critical working-file hashes from that capture:

| File at its reference root | SHA-256 |
| --- | --- |
| Contract: `QORPERA-RUNTIME-CONTRACT.md` | `f6c9836df26c313bab133b6d77465749ecb14b023e6b71f44fb850a25d919ede` |
| Main: `packages/shell/src/cloud-company-path-gateway.ts` | `0307031c56c7537f62c639effeab5c4adf5bfee52bfd4696802a35ae3cdced27` |
| Main: `packages/shell/src/cloud-native-tool-operations.ts` | `a8878a3f5e85433ac8666045c74ab8157efc44e1a119b317437ae93278cbe4ac` |
| Main: `packages/shell/src/cloud-native-run-tool-session.ts` | `e0c28f67deb4b3fb635f86d1a40089e0c1b259921d2c5cc8b5cd39dd6c3e8302` |
| Main: `packages/shell/src/cloud-runner-worker.ts` | `60ca21427b744ded766794a66b616cdf8198fcc9e25ec5f2f8c05bf7e311dfe5` |
| Step 3: `.artifacts/step3-wake-bus/deploy/first-node/RUNTIME-STEP-3-WAKE-BUS.md` | `0f4edfa279e376c4cacdcf839ebda0f541796fd887da691f73c80aeb8c61023a` |
| Step 4: `deploy/first-node/RUNTIME-STEP-4-COMPUTERS-SCREENS.md` | `520c57372f2a66ac89a1695a0acb8034e42cbb260f5ec7f80b1abae70f902da0` |

Applicable `/Users/jonas/.codex/AGENTS.md` and repository `AGENTS.md` were read. All four requested references were read before coding; reference worktrees were never edited. The audit covered cloud run admission, operation receipts, assignment/lease recovery, session arbitration, delegation, task state, Company File publication and the main native tool/path adapters.

### Findings and reused machinery

- `EphemeralCloudRunnerWorker` and runner-worker state manage infrastructure assignments, leases and infrastructure recovery. They are **not** the contract's delegated child workers. This track neither modifies nor instantiates that infrastructure worker.
- Existing execution runs, runner jobs, immutable operation keys/receipts and explicit ambiguous-operation resolution already supply execution admission and recovery. The new lifecycle delegates to those systems; it has no agent engine, execution loop or execution queue.
- `send_coworker_message`, `delegate_to_staff` and room delegation are coworker delivery, not private child completion. They are excluded from worker tools. A private coworker audience is not the worker's parent-only reporting channel. No coworker message, room fan-out, fabricated human input or public mouth operation is used for completion.
- Existing local company-execution workspaces/checkouts are not a canonical todo store. No existing durable todo/child-handle schema was found in the audited baseline. The live Company File is the sole durable work description and accepted-result store here.
- Main's Company File path gateway provides governed reads, single-path CAS writes, immutable receipts and protected-write proposals. Its read pages are 4 KiB and writes are bounded to 32 KiB. It does not yet expose the worker-specific atomic authority/fence guard required below. One todo aggregate is therefore one Company File object; no multi-object atomicity or second task table is assumed.
- Main's native operation ledger distinguishes a fresh reservation from an existing/ambiguous operation. Reconciliation retains the same logical command identity and must use that distinction, never a new key to retry uncertain effects.
- Step 3 supplies wake infrastructure, not a ready worker-continuation adapter. Step 4 supplies a separate computer track; nothing here provisions or controls a computer.

### Review-fix baseline and scope

The review-fix pass began at assigned revision `a0b692947d5c867353591b36172afcc997f0521e`; all 12 original delivery checksums matched before edits. The original 419-file reference capture remains unchanged. Relevant pre-fix working hashes (these are not the final delivery hashes):

```text
4b76ffd6005adc382474f96440ad99d8e9725bc504d192695d651fb0c12df4a4  packages/shell/src/cloud-worker-contract.ts
0b5ea3d744195ec7a38ada9691468a57173a3302a27472fae73928bf34dcf5c3  packages/shell/src/cloud-worker-ports.ts
55bb9dd78d96b44ab0f3021ca75d85fa4545442c278358d82b921f660efe8ab5  packages/shell/src/cloud-worker-lifecycle.ts
aa4f4a8bc80510639a59e37f76a49aec78544508e80eb22839f3e2cf5cde486a  packages/shell/test/cloud-worker-lifecycle.test.ts
70689eaf86eb98640584170879ebde80835644d201553c615d4af4a5aa128807  packages/shell/test/cloud-worker-persistence.test.ts
32e83ea01f86784447e78e738642e0b5d16ce63d6336d0286452abf060e65313  packages/shell/test/fixtures/cloud-worker-fixture.ts
18fc6c1f9faea522c7d85e40a8046b423f0364c8213afc869edc62f17fc81a8a  packages/shell/test/fixtures/cloud-worker-postgres.ts
```

The remediation changes only the existing independent component files, their tests/fixtures, the unreleased changelog entry and this delivery documentation/checksum. It does not modify the Company File store adapter, test launcher, reference capture, or any shared/main-owned integration.

| Review finding | Component fix and evidence |
| --- | --- |
| Admitted work could exhaust completion/acceptance space | Required `destination.maxResultBytes`; admission reserves maximum result and acceptance copies, continuation, command receipts, cancellation and revision growth. Saturated-todo tests cover full-budget results, multiple workers, pending acknowledgements, escaped/UTF-8 context and an unclean database restart. |
| One worker failure prevented recovery of others | Per-worker failure isolation for reconciliation, todo cancellation and parent-end cleanup. `WorkerReconciliationBatchError.failures` reports worker IDs and errors after independent handles are processed; caller abort still stops the batch. Tests cover execution lookup, authority outage, continuation and stop failures, including real Company File persistence. |
| Enum coercion admitted arrays and other non-strings | Shared exact-string enum validation; no `String(...)` coercion for tool effects, outcomes, phases, todo states, command kinds or delivery states. Negative tests also assert coercion hooks never execute. |
| Confirmed-active executions remained reconciling | A live-authority `status` CAS restores `running` only for the observed Company File version, execution, epoch and sequence with all commands confirmed. No stale rebase over newer work; tests race cancellation, revocation and follow-up, and verify database authority during publication. |

### Reassessment-remediation baseline and scope

This pass captured its baseline at **2026-08-28T18:13:31.860Z**, at the same assigned revision. All 12 preceding delivery checksums matched before edits. Relevant pre-remediation hashes:

```text
b29024a70e8881140ffcb2d3437704ddb0d8928ddf2860e7e573a84ad3683aa9  packages/shell/src/cloud-worker-contract.ts
b4d78fb909ad967194e7b4587e4600e2f54896c57f9d306960c9290e66f612d8  packages/shell/src/cloud-worker-ports.ts
d9e22a703e3a030971ff1f6a77978ccc5959d7f034dbea9228e02a36261d2cd6  packages/shell/src/cloud-worker-lifecycle.ts
6fb23a8b26cf546700153176e51e022f840414fd05105a3602551b2dfd2d01d0  packages/shell/test/cloud-worker-lifecycle.test.ts
0b28f1dc021cd832a704fecd32fcd8265c9df3b9734879be3dc208ec53c98840  packages/shell/test/cloud-worker-persistence.test.ts
bffa84bafcfcfa3a699e63cfadff9209aa1ff075e84a7e9a58357e42d2e2545b  packages/shell/test/fixtures/cloud-worker-fixture.ts
d3cf65251443169e9bc839b177a6a2cd05c9ea49a6d1dd9d69be100c42d2e5be  packages/shell/test/fixtures/cloud-worker-postgres.ts
```

At the 2026-08-28 reassessment, the contract, two critical main gateway/operation files and frozen Step 3 handoff still matched their captured hashes. The independently updated Step 4 handoff was reread read-only; its SHA-256 at that pass was `db1bb63039384142dd8c113edb74254872da80753602fb05f8b99083ccfb3a17`. The original capture is historical and remains unchanged. No reference worktree was edited or contacted.

| Reassessment finding | Remediation |
| --- | --- |
| Admission receipt acknowledgement used cleanup privileges to publish `running` | Acknowledgement records the confirmed receipt/execution and leaves an active worker `reconciling`. A separate `status` CAS requires live authority and the exact observed version/epoch/sequence/execution. Both admission and active-inspection recovery use this guard. Revocation fences; an outage does not invent consent or force resubmission. |
| `blocked` permanently prevented same-worker continuation | V2 dispatch/todo/handle/context/command contracts require `completion.onBlocked: "parent-followup"`. `resumeBlocked` names the exact blocked completion and supplies bounded explicit context; it archives the immutable checkpoint, suppresses its old intent, reserves the next result and appends a same-worker/run/stream follow-up. Success, failure and cancellation/revocation fences cannot be reopened. |
| Durable output tests exercised only no-change results | Real immutable artifact and proposal-candidate bytes, existing publication/proposal rows and existing operation receipts are now tested across unclean PostgreSQL restarts. Tests reject missing/substituted/cross-worker output receipts, stale live artifacts and rejected proposals, including publication races. Parent acceptance of a proposal result does not approve or publish its proposed bytes. |

Related regressions cover late acknowledgements for an old private intent after blocked resume, history identity validation, same-checkpoint concurrent resume, lost resume acknowledgements, and history capacity exhaustion before further admission. Old intents cannot confirm a newer completion. The remediation remains confined to the independent component files, tests/fixtures, unreleased changelog and handoff/checksums; the store, launcher and original reference capture are unchanged.

### 2026-08-30 boundary remediation and reference refresh

This pass captured reference revisions at **2026-08-30T21:04:37.805Z**, before the fixes, at assigned HEAD `a0b692947d5c867353591b36172afcc997f0521e`. All 12 preceding delivery checksums matched. Relevant pre-fix working hashes:

```text
a8cb24f2564fd391d8ee80eec817c8faf31f598a4ee9521603f6fba2a82e8fb8  packages/shell/src/cloud-worker-contract.ts
846991b3d9e38dd182d9143f5fc2ed074c7cd3cd781835820faba4d73851456c  packages/shell/src/cloud-worker-ports.ts
48a571529e17aaf79ef89f1df129cd55596f77a44bc2f2e8751af5e7afedc863  packages/shell/test/cloud-worker-lifecycle.test.ts
c7d00ce4b9178a1a2815a70585ed7a47487d7a6073bfe230777f81ec999f6013  packages/shell/CHANGELOG.md
26f2ded15dbaaf2c8b9403be030b59defeafbf0428265c8c50725454c7ad06dc  deploy/first-node/RUNTIME-STEP-5-WORKERS-TODOS.md
```

The read-only main reference is now HEAD `2e1493aecc8bf59226943e0cc714cf98284204d4` with unrelated working changes. Contract, Step 3 and Step 4 reference HEADs remain respectively `18181de7f2698c9f44347a7ee141eebead84bc35`, `2823637c0fd6def4cf21d3bc8e21f5f472f9d6b1` and `a0b692947d5c867353591b36172afcc997f0521e`. Their working files have evolved since the initial capture. Current relevant SHA-256 hashes:

| Reference file | SHA-256 |
| --- | --- |
| Contract: `QORPERA-RUNTIME-CONTRACT.md` | `a8a68b8605dc2a8ad01148ad6697e3a58b813b305b7b65286e8054d0895c8245` |
| Main: `packages/shell/src/cloud-company-path-gateway.ts` | `8c5077e9412e61b14b5127fc0b8ca4acd0201a82bd2a095560c533ecf4983716` |
| Main: `packages/shell/src/cloud-native-tool-operations.ts` | `a27ad337da2520c6cb9ef2445a24fff20f8ec740725b5f10da965ec2408dcd9a` |
| Main: `packages/shell/src/cloud-native-run-tool-session.ts` | `bd419bdc57f7472f33373e6e8675a0a4d8f6b2b13613069ca5bf964599e4e094` |
| Main: `packages/shell/src/cloud-runner-worker.ts` | `60ca21427b744ded766794a66b616cdf8198fcc9e25ec5f2f8c05bf7e311dfe5` |
| Step 3: `.artifacts/step3-wake-bus/deploy/first-node/RUNTIME-STEP-3-WAKE-BUS.md` | `1da8871ef3962bdbe798334f528cee5e5c97ad110afab0f9b6c8ccedfbe9a1dc` |
| Step 3: `.artifacts/step3-wake-bus/packages/shell/src/cloud-wake-bus.ts` | `072e052be47c4688b5c98a721176a7199b06319433a9398108920316f0e02094` |
| Step 4: `deploy/first-node/RUNTIME-STEP-4-COMPUTERS-SCREENS.md` | `90132679deebb37c728ecdcdbb8a703b29ca014f5dfd72d652cad46a8a40a939` |

The initial 419-file capture remains unchanged as historical evidence. The current contract's organizational additions do not extend this original independent worker/todo assignment into formation or shared runtime work. Step 3's actual coworker tool was inspected read-only; it is not a worker continuation adapter. The updated Step 4 handoff was also reread; no computer implementation is imported or claimed here.

| Finding | Fix or corrected integration requirement |
| --- | --- |
| The tool denylist omitted Step 3's actual `send_coworker_message` name | The shared worker-tool parser now rejects it regardless of private audience or matching grant. Regressions cover dispatch parsing, explicitly granted blank context, forbidden tools in the allowed scope, a supplied router context containing the tool, and lifecycle rejection before Company File mutation or run admission. All previously forbidden names receive the strengthened context/router checks too. |
| The handoff described the historical Company File read envelope as current | The port and integration guidance now distinguish the pinned component read shape from main's provenance-bearing envelope. New file/absent-envelope tests reject direct composition before todo creation or dispatch; the strict store is unchanged. A provenance-preserving production bridge remains a main-owned activation dependency, not an implemented compatibility fallback. |
| Native composition guidance omitted main's required context-view callback | The hooks below now specify `recordContextView`, `beginExecution(specification, signal)` and the operation callback's `inputSha256`. No shared native session, provider, context composer or gateway is edited, and a no-op provenance callback is not an acceptable adapter. |

This pass changes only the contract, port documentation, fast tests, unreleased changelog, handoff and checksum manifest. Lifecycle/store implementation, database fixtures, test launcher and all reference worktrees remain unchanged. Existing schema versions stay fixed: this closes an unintended tool surface in the inactive contract; it does not add a new envelope or migrate data.

## Changed-file manifest

All paths below are relative to the assigned worktree. Exact final hashes are in `deploy/first-node/RUNTIME-STEP-5-FILES.sha256` (all listed files except the checksum file itself).

| Path | Change |
| --- | --- |
| `packages/shell/src/cloud-worker-contract.ts` | New closed, versioned dispatch/result/todo/handle/continuation contracts and coding continuity seam |
| `packages/shell/src/cloud-worker-ports.ts` | New mandatory authority, guarded Company File, run and private continuation ports; blank-context/tool narrowing |
| `packages/shell/src/cloud-worker-todo-store.ts` | New live Company File paginated reader and receipt-validated CAS store |
| `packages/shell/src/cloud-worker-lifecycle.ts` | New dispatch, status, follow-up, cancellation, parent-end, completion, acceptance and reconciliation components |
| `packages/shell/test/cloud-worker-lifecycle.test.ts` | New 84-test fast contract/race/integration-boundary suite |
| `packages/shell/test/cloud-worker-persistence.test.ts` | New 17-test disposable PostgreSQL persistence suite |
| `packages/shell/test/fixtures/cloud-worker-fixture.ts` | New explicitly in-memory fast-test fixtures |
| `packages/shell/test/fixtures/cloud-worker-postgres.ts` | New test-only existing-DB/object-store adapters, not production adapters |
| `scripts/test-runtime-workers.mjs` | New isolated persistence-test launcher reusing hosted DB bootstrap, pinned image and migration ordering |
| `packages/shell/CHANGELOG.md` | Unreleased Added entry only |
| `deploy/first-node/RUNTIME-STEP-5-BASELINE.json` | Start-of-task reference capture |
| `deploy/first-node/RUNTIME-STEP-5-WORKERS-TODOS.md` | This handoff |
| `deploy/first-node/RUNTIME-STEP-5-FILES.sha256` | Delivery checksum manifest |

No dependency metadata, lockfile, production migration, existing gateway, provider, context composer, runner, sandbox, authority implementation, UI or application entry point changed. Generated ignored model catalog files were hydrated for local checks as described below.

## Lifecycle and persistence contracts

### Closed, independently versioned envelopes

- Dispatch: `qorpera.worker-dispatch/v2`, species `in-house`; worker and logical operation identity; Company File company/environment/todo/path; immutable parent run/staff/session/requester/bundle identity; goal and definition of done; explicit bounded blank context and pinned source references; delegated grant and exact tool grants; output destination including required `maxResultBytes`; cancellation and private completion policy with required `onBlocked: "parent-followup"`. The budget measures canonical UTF-8 JSON bytes of the entire result envelope, not just its summary. It is an integer up to 32 KiB and must fit the minimum terminal envelope for that identity. There is no runtime default; 2 KiB is the test fixture's explicit choice.
- Result: `qorpera.worker-result/v1`; completion/receipt identity; exact worker/todo/parent/run/stream/delegation/epoch/sequence binding; `succeeded`, `blocked` or `failed`; bounded summary; `no-change`, `company-file` references/receipts, or `proposal` references/receipt. Receipt authenticity is checked by the run adapter, not inferred from the result text.
- Todo and handle use `qorpera.worker-todo/v2` and `qorpera.worker-handle/v2`; the unchanged private-intent shape remains `qorpera.worker-continuation/v1`. Handles contain required immutable blocked-checkpoint `history`; every archived result must match one explicit resume command and suppressed intent. Unknown fields/species/schema versions, malformed identity, path aliases, lossy JSON values and inconsistent state bindings fail closed.
- A worker receives only the explicitly constructed `qorpera.worker-context/v2`, including the explicit cancellation/completion policy. Allowed scope is not automatically included. No parent transcript, provider session, environment, credentials, filesystem root or ambient tool catalog is copied. Results remain `untrusted-worker-data`, including after receipt verification.
- Run commands use `qorpera.worker-run-command/v2`. Every command has `resumeCompletionId`, null except an explicit blocked-checkpoint follow-up. It is part of the immutable command digest. Receipt envelopes remain v1 because their fields are unchanged; old command digests cannot acknowledge v2 commands.
- Public-send, coworker-send and delegation tool names and non-private tool metadata are rejected, including Step 3's `send_coworker_message` even when marked private and explicitly granted; `assertWorkerToolAllowed` revalidates the supplied tool references and checks exact tool name/version. This is a component guard, not proof of native tool isolation: the production catalog must correctly classify effects and enforce the referenced resource grants on every call. A tool alias or private metadata cannot authorize a non-parent reporting destination.

V2 deliberately rejects the earlier v1 dispatch/todo/handle draft; it does not silently reinterpret old terminal results or migrate live data. Missing blocked policy, history, command checkpoint identity or result budget fails closed. No compatibility fallback or default authority/budget is inferred. `workerBlankContext(...).output` carries the same explicit result budget to the child. Main must explicitly support v2 before activating the component.

### One Company File aggregate

The immutable todo identity and parent, durable goal/definition/sources, worker dispatches, command history, immutable blocked checkpoints, execution references, current results, acceptance records and private continuation intents live together in a single JSON Company File object. Execution tables are tied projections only.

Every successful mutation advances the semantic todo revision by one and requires a fresh object-version CAS. The store validates the applied/proposed receipt and new version. A proposal is not an applied mutation and cannot authorize dispatch. Reads have no authoritative local cache; cross-version pages retry with a bounded budget, and a tombstoned object cannot silently be recreated.

The adapter must preserve the normal Company File ACL, protection/proposal, receipt and change-event semantics. A stale CAS alone permits retrying a pure transition. A lost or ambiguous mutation response is not converted into an execution retry.

V2 bounds: 32 KiB aggregate; at most eight handles; 24 command slots per handle, with one reserved for cancellation; bounded context, sources and tools. The admission calculation sizes a conservative future-complete aggregate: each possible successful result at its declared budget, its acceptance copy and maximum-length acceptance key, the exact private-intent envelope, every outstanding command acknowledgement, a maximum-key cancellation and stop receipt, possible execution identity, and revision/state growth. All immutable checkpoint history remains included in that size. These are byte-accounting projections only; placeholder identities are never persisted or dispatched.

Dispatch and follow-up fail before their state/effect is admitted if that future aggregate would exceed 32 KiB. Already-admitted, in-budget completions and acceptance retain their reserved space across other workers' transitions. Fenced or completed outcomes release only capacity that can no longer grow. The eight-handle ceiling does not promise eight large dispatches fit; rejection happens before admitting excess work. Out-of-budget results are rejected before receipt verification or persistence, never truncated, assigned another worker's capacity or automatically re-executed. Use small durable artifact references; archive/compaction remains an integration decision.

Blocked resume is a new admission: it retains all prior checkpoint bytes and must reserve a new maximum result, acceptance and intent before clearing the current blocked result or submitting follow-up. Capacity exhaustion leaves the blocked checkpoint unchanged and still permits its pending continuation and cancellation. History is never discarded to make room.

### State transitions

| Action | Durable transition and effect rule |
| --- | --- |
| Create | Creates `open` todo; replay must match its original durable work description |
| Dispatch | Reserves completion/control capacity, then persists the complete handle and pending command before run admission; identical dispatch reuses the handle, conflicting work under the same identity is rejected |
| Submit | Claims command `pending → inflight`; only the fresh claimant calls admission; other callers use receipt lookup |
| Admission acknowledgement | Confirms the command and records a distinct child run/stream under cleanup privileges; leaves a nonterminal handle `reconciling`. Only a separate live-authority `status` CAS may mark it `running` |
| Follow-up | Preserves reserved result/control capacity; reuses worker and run/stream, appends bounded explicit input and increments sequence; earlier-sequence results are superseded |
| Resume blocked | Requires the exact current `completionId`, explicit bounded parent input and current unchanged grants; archives the blocked checkpoint, suppresses its old intent, reserves future capacity and appends one follow-up on the same worker/run/stream with incremented sequence |
| Complete | Authenticates the bound completion and current grant, then atomically records one result and one deterministic private parent intent for that sequence; does not accept output |
| Accept | Separate authorized parent action; verifies current successful result/grant/receipt and records acceptance, including the host-bound accepting run |
| Finish todo | Requires an accepted result, terminal workers, accepted successful outputs and resolved cancellation commands; parent explicitly marks `done` |
| Cancel/revoke | Advances fence epoch from 1 to 2, prevents future work, suppresses continuation and persists a stop command; `cancelled`/`revoked` does not by itself claim the physical child has stopped |
| Parent ended | Main calls `parentEnded`; default workers are fenced/stopped. `retain-grant` requires that explicit live delegation policy and never implies retained credentials |
| Active recovery | Restores `reconciling → running` only for a fresh, authorized active observation with unchanged object version, execution, epoch and sequence and no unacknowledged commands; no run resubmission |

Ordinary `followup` remains limited to nonterminal in-house streams. `resumeBlocked(workerId, { operationKey, completionId, text, sources }, signal)` is the only reopening path, and only for a current blocked checkpoint. It retains worker/todo/parent identity, goal, definition of done, run, stream, grant references and epoch; it adds no automatic context or authority. Identical replay deduplicates; conflicting input or a different new key naming an old checkpoint fails. A new result needs fresh completion/receipt IDs. Success, failure, cancelled/revoked handles and closed todos cannot be reopened. A native adapter that cannot continue the same execution must fail closed, not substitute a new child.

### Recovery and private continuation

- Pending dispatch survives interruption before admission. An interrupted `inflight` marker is uncertain even if no receipt is visible: another sender may still act.
- Lost admission responses reconcile against the existing immutable receipt. `not-started` is accepted only with a durable reconciliation receipt proving the old sender cannot still execute. Mere absence never permits retry.
- `reconcile` performs a bounded pass when invoked by the existing cloud reconciler. It contains no scheduler/timer, polls no model and never reruns an uncertain execution. It can recover terminal results from the run adapter, stop fenced work and deliver an outstanding private intent.
- A worker-specific failure does not prevent the rest of that pass from progressing. Reconciliation, todo cancellation and parent-end cleanup collect `{ workerId, error }` failures and throw `WorkerReconciliationBatchError` after visiting independent handles. The error is also a `WorkerReconciliationRequired`; it is not permission to repeat ambiguous effects. Abort signals propagate immediately rather than being aggregated. An authority outage remains an error, not a fabricated revocation or grant.
- A positive active-status observation uses the distinct guarded `status` mutation purpose, which requires live authority inside publication and must not receive cleanup privileges. A changed Company File version invalidates the observation instead of rebasing it over newer state. Cancellation/revocation/new follow-up cannot be undone by a late active response.
- Admission receipt recovery uses that same positive-status guard. A confirmed receipt is cleanup identity, not continuing authority. If status publication fails, the receipt stays confirmed and the handle remains reconciling; no new dispatch is warranted.
- Stable command identity/digest excludes the changing Company File CAS version. Rebase/restart therefore cannot invent a new logical effect. Native external operations still require the existing per-operation ambiguity ledger.
- Duplicate completions produce no second intent or acceptance. Late/superseded completions do not override newer instructions. Cancellation winning during admission, result verification or continuation acknowledgement cannot reopen the worker or restore authority.
- Continuation contains immutable parent/todo/worker/completion/grant/fence references, not a human author or public message. Admission is idempotent by intent ID. A lost acknowledgement uses lookup, not a fresh intent.
- Resuming blocked work suppresses the archived intent, including one already queued. Its late success/uncertain response is matched by intent ID and cannot update the new checkpoint's intent. Consumers must reject its superseded sequence even if its earlier admission receipt was valid.
- The continuation queue must also deduplicate consumption and recheck current authority/fences atomically. `resolveContinuation` revalidates and returns the same untrusted result; it is a read helper, **not** proof of exactly-once parent execution or authority to create a replacement parent.
- Revocation must be terminal for a grant identity/version. Regrant requires a new authorization generation; the same old grant must not become valid again merely because a worker receipt exists. Observed revocation is additionally persisted as an irreversible worker fence.

## Main-owned integration hooks and decisions

All four adapter surfaces are mandatory. There is no local, legacy, public-message or broad-authority fallback. The following interface guidance reflects the 2026-08-30 working-file hashes above, not an assumption that the initial main revision is still current.

1. **Guarded Company File adapter.** `WorkerCompanyFilePort.read` is pinned to the closed baseline file-page fields `{ path, version, kind, offset, bytesRead, totalBytes, text, nextOffset }` or absent fields `{ path, version, kind }`; commit receipts use `qorpera.company-path-result/v1`. Current main reads additionally return `snapshotId` and `readObservationId`, after `qorpera_read_company_path_v2` and `qorpera_confirm_company_path_read`. Direct composition now fails closed for both file and absent responses. Before activation, main must choose an explicit versioned bridge that validates the read observations and preserves their snapshot/page/byte provenance through any native context projection and recording. Do not strip fields merely to satisfy the old parser or return a bare aggregate that loses its source observations. The store and tests do not implement that bridge. `commit` must atomically validate host-bound `actorRunId`, parent relationship, live path ACL/protection policy, delegation and current worker epoch/sequence with the CAS/publication/receipt/event. Completion, acceptance and blocked resume must also revalidate the bound result/output receipts against the CAS head and current proposal state; successful preflight alone does not close that race. A worker ID with null epoch is an expected-absent insertion: validate the proposed dispatch's grant in the transaction. The `status` purpose is a positive-authority mutation for both admission and active-inspection recovery, never a cancellation/reconciliation cleanup exemption. An unguarded gateway is not a drop-in adapter. No production bridge or schema migration was added.
2. **Delegation authority.** Implement `WorkerAuthorityPort.assertParent/resolve` through the current authority spine. `resolve` returns an exact bounded worker scope, including `parentEnd`; positive revocation is `null`, whereas an outage throws. Resolve capability references without disclosing or copying credentials. Tool grants must forbid public sends, inappropriate Company File/control-path writes and unauthorized subdelegation. Sponsor, requester and parent IDs alone are not delegated authority.
3. **Existing run admission/receipts.** Implement `WorkerRunPort.submit/lookup/inspect/verifyResult` on existing execution admission, immutable command receipts and recovery. Submission returns admission promptly, not the model's result. Map the worker identity to a private bounded native stream and enforce its epoch/sequence/grants on every effect. The parent must choose `destination.maxResultBytes`, and the child/adapter must produce a result within that canonical-envelope budget. V2 follow-up must add explicit private input to the same stream/run; `resumeCompletionId` names the exact blocked checkpoint. Supporting that continuity is mandatory before activation, not permission to substitute another run. A stopped receipt must prove actual drain/fencing, including a dispatch still in flight or an already-terminal run; preserve its actual terminal outcome. Authenticate result and Company File/proposal receipts against the actual child and current authority.
4. **Native composition.** Current main's native tool-session factory is `(identity, operations) => { tools, assertContext, recordContextView }`. The required callback is `recordContextView(frame: CloudNativeFenceRequest, outputs: readonly CloudNativeFencedResult[], signal: AbortSignal): Promise<void>`; bind it to the existing gateway/context-provenance machinery and retain the native authority checks before and after recording. A missing or no-op callback must not enable workers. `beginExecution(specification: JsonValue, signal: AbortSignal)` receives the child's actual boundary specification, not a parent's reused catalog. The existing operation `perform` context now includes `inputSha256` alongside identity, receipt ID, idempotency key and signal; preserve those host-bound receipt/digest bindings. Attach a worker-specific tool/context policy through a main-owned hook; do not pass the parent's native context or provider session. `workerBlankContext` and `assertWorkerToolAllowed` are the component entry points. Neither the callback/provenance bridge, actual provider execution nor interruptible-parent wiring is implemented here.
5. **Private parent continuation.** Implement `WorkerContinuationPort.submit/lookup` in the existing wake/continuation system with an authenticated machine-origin `worker-result` kind. Do not put it into the old human `user_message` path or Step 3 coworker delivery. Admission and consumption must serialize with cancellation/revocation and deduplicate by immutable intent ID. Main must decide how a terminal original parent maps to an explicitly authorized continuation run; `actorRunId` can identify that host-bound run, but the component never chooses it or restores its authority.
6. **Cloud recovery entry points.** Invoke `reconcile` from existing recovery/event processing and `parentEnded` from verified main run termination. A `WorkerReconciliationBatchError` means other handles may already have progressed: inspect its per-worker failures and current Company File state, retaining all original logical operation keys. Enumerate todo documents through the live Company File/catalog; do not create another canonical task database. Uncertain operations require existing operator/recovery evidence, not automatic repetition.
7. **Species continuity.** In-house dispatch rejects coding/media/listener/runner species. `CodingWorkerContinuity` and `assertCodingWorkerFollowup` preserve worker, todo, VM, repository, branch and callback-or-durable-listener reference exactly. No VM, coding execution, branch, PR, media or listener implementation is present. A coding provider without callbacks must not use the in-house bus by assumption.

Other explicit integration decisions: allocate narrowly governed todo/output paths; preserve object identity across path changes or reject moves; choose per-dispatch result budgets and any archive policy; map proposal-submission acceptance to the parent's definition of done without implicitly approving the proposal; and enforce current ACLs when resolving accepted output references. The component's blocked policy is now explicit, but real native support for same-run/stream continuation and authorized parent revival is still main-owned. Success/failure reopening and grant replacement are not supported. Missing decisions are dependencies, not permissions to use broader authority.

## Verification and exact commands

Environment: Node `v24.18.0`, npm `11.12.1`, Docker `29.7.2`. No build or full test suite was run.

From the assigned repository root:

```sh
npm ci --ignore-scripts
cp -R /private/tmp/qorpera-step2-resume.rN3rbf/source/packages/ai/src/providers/data packages/ai/src/providers/data
npm run check:model-data
```

Results: dependency hydration passed (602 added, 625 audited, zero vulnerabilities; existing transitive deprecation notices). No lifecycle scripts ran and no lockfile changed. The copy hydrated ignored generated model catalogs only, using the read-only main checkout; it did not copy credentials or run a remote model-data generator. Model-data validation passed.

From `packages/shell`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/cloud-worker-lifecycle.test.ts
```

Result: **84 tests passed** (2026-08-30 final post-formatting run, 2.49 seconds, starting 23:10:07 local time; the earlier full run also passed). Covers blank context, exact scope narrowing, prohibited public/coworker sends, closed/future schemas and enum types, species separation, concurrent dispatch/workers, idempotency, follow-up identity/sequences, terminal outcomes, explicit acceptance, parent-end retention grants, full result/acceptance/control reservations, pending acknowledgement capacity, cancellation/admission/completion/continuation races, revocation, replay, failure-isolated recovery, caller abort and guarded active-state restoration. The reassessment regressions add guarded admission acknowledgement, explicit blocked resume/history, concurrent resume, old-intent acknowledgement races, history capacity and restart reconstruction. Current integration regressions additionally reject the real coworker tool despite an explicit grant and reject main's new read envelope without a provenance bridge. These fast fixtures are explicitly in memory and are not the durability evidence or a native integration test.

Before the fixes, the four newly added regression cases were run with:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/cloud-worker-lifecycle.test.ts -t 'Step 5 review regressions'
```

Initial result: **4 failed, 42 skipped**, reproducing all four review findings. After implementation the complete suite passed; the review regression group was then expanded to 19 cases. One intermediate formatter info about string concatenation in a test was corrected; no diagnostics remain.

Before the 2026-08-28 reassessment remediation, two new regressions were run with:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/cloud-worker-lifecycle.test.ts -t 'Step 5 reassessment regressions'
```

Initial result: **2 failed, 61 skipped**, reproducing the revoked-admission status bypass and missing blocked-resume API. After implementation the full fast suite passed, and the reassessment group was expanded to 19 cases (80 total).

The 2026-08-30 regressions were run before and after the tool fix with:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/cloud-worker-lifecycle.test.ts -t 'send_coworker_message|Step 5 current integration regressions'
```

Before the fix: **2 failed, 2 passed, 80 skipped** (23:06:28 local time): the dispatch parser accepted the forbidden tool and the lifecycle admitted its explicitly granted dispatch; the new read-envelope refusal tests already passed. After the fix: **4 passed, 80 skipped** (23:06:51). No coworker message, provider call or native execution was performed in either run.

From the repository root:

```sh
node scripts/test-runtime-workers.mjs
npm run check
git diff --check
shasum -a 256 -c deploy/first-node/RUNTIME-STEP-5-FILES.sha256
```

Results: **17 persistence tests passed** (2026-08-30 final run: **127.56 seconds**, starting 23:07:23 local time). The final full repository check passed with **no errors, warnings or infos** and no formatting changes, checking 1,347 files, pinned dependencies, relative TypeScript imports, cloud boundaries, shrinkwrap/install-lock freshness, TypeScript and browser-smoke checks. The first check normalized formatting in the expanded fast-test table; the second check applied no fixes. Whitespace and refreshed delivery checksum checks passed.

The persistence launcher reuses `scripts/test-hosted-db.mjs`'s pinned PostgreSQL image and migration ordering plus `supabase/tests/bootstrap.sql`; all **74 existing migrations** apply only inside a disposable, labelled, network-disabled container, with no published ports. A durable Docker volume replaces the hosted harness's tmpfs so an actual SIGKILL/restart tests WAL recovery. Object bytes use the existing `CloudContentAddressedStore`, immutable on-disk files and fsync, not a memory map.

The fixture uses real Company File snapshot preparation, content-addressed tree restore/closure verification, reachability graph/proof and publication APIs. It uses real `qorpera_enqueue_execution_run`, existing job cancellation and `qorpera_run_operation_receipts`; it adds no todo, task or queue table. Snapshot publication IDs stand in for main path receipts in this **test adapter only**. Delegation is a deliberately narrow test grant backed by the existing sponsor lifecycle, not an implementation of the main multiplayer delegation spine. Provider metadata is inert test data and is never resolved or used.

The output fixture writes actual immutable files and verified snapshots. Its private output receipt binds child run/stream, worker/todo/parent, grant/epoch/sequence, exact tool, file entry and source reference in the existing operation ledger. Proposal candidates use `qorpera_prepare_company_file_proposal` and the existing run-kind proposal table/revision triggers; no session/turn or fabricated human input is introduced. Empty reviewer lists create no review execution. The baseline's older turn/wake submission API is not misrepresented as a native worker API. Snapshot IDs and deterministic logical path IDs are test reference mappings, not a production path-gateway bridge. Output authority is explicitly opted into per dispatch and fixed to that worker's fixture path.

Completion/acceptance checks verify receipt bindings, immutable object bytes and the current live artifact or proposal candidate. File publication's head CAS protects artifact races, and a proposal-row lock rechecks current candidate/status inside acceptance publication. Accepting a `proposal` result records only the parent's acceptance of that submitted-work result; the proposal remains open and its candidate file is absent from the live Company File.

Persistence cases prove:

1. Live database authority is rechecked during acceptance publication after a successful preflight.
2. After capacity rejects additional follow-up before admission, a maximum-budget result, its maximum-key acceptance and pending parent intent fit and survive an unclean database restart; receipt reconciliation creates only one child run and one continuation admission receipt.
3. Concurrent children and acceptance updates retain both workers, the original Company File content and stable follow-up run/stream identity.
4. Interruption before Company File publication rolls back the candidate revision and admits no child.
5. An interrupted inflight marker stays uncertain across reconstruction until explicit durable not-started resolution exists.
6. Cancellation after a lost admission response finds/stops the existing queued child and ignores its late result.
7. Lost continuation acknowledgement reconciles once, and consumption is denied after real sponsor revocation.
8. Repeated lookup failure for one child does not prevent another child's completion/private intent from becoming durable; reconstruction preserves that progress without duplicate continuation receipts.
9. An uncertain execution becomes durably `running` when confirmed active, without another run; live sponsor revocation inside a subsequent status publication prevents the positive state transition.
10. Revocation during admission acknowledgement retains the receipt/cleanup identity but never publishes `running`; existing sponsor termination and the worker fence remain durable.
11. Revocation inside admission's separate `status` publication prevents promotion and recovery acknowledges the already-terminal execution without changing its failure outcome or dispatching again.
12. A blocked checkpoint, suppressed old intent and uncertain explicit resume survive SIGKILL/restart; recovery reuses the exact run/stream and one resume command, rejects the old continuation and accepts a later success.
13. Actual accepted Company File artifact bytes, references, acceptance and pending intent survive SIGKILL/restart; duplicate output/completion/acceptance does not produce another run, output receipt or acceptance.
14. Actual proposal-candidate bytes and proposal/revision receipts survive SIGKILL/restart; accepting the worker result neither approves the proposal nor publishes its candidate bytes.
15. Missing/substituted artifact receipts, wrong object/version/path and cross-worker output references fail even when the enclosing test completion receipt is authentic. A read-only worker cannot publish output.
16. An artifact change after successful preflight but before acceptance publication causes CAS retry and current-artifact validation to reject acceptance.
17. A substituted proposal ID or rejection after preflight cannot be accepted; proposal status/candidate is rechecked inside publication without promoting proposed bytes.

Important limits: model execution, private native stream input (including blocked resume), completion production and parent queue consumption are test doubles. The durable continuation receipt is **not** a real wake or parent revival. Artifact/proposal storage and receipt-binding checks are genuine persistence tests, but output calls originate in a test bridge, not a native child, and do not prove production path ACLs, proposal approval or native receipt integration. No real worker process drain, parent responsiveness, provider-session isolation or native public-send prohibition has been accepted.

The initial implementation's database run found two fixture API mistakes (session inputs require a session join for company scope; sponsor status takes company, binding and status). Both were corrected before the original seven-case pass, followed by the nine-case review-remediation pass. The 2026-08-28 reassessment's first 17-case database run produced **15 passes, 2 failures**: both new revocation races exposed a fixture cancellation mismatch, because the real sponsor-revocation API already terminalizes jobs as `failed` and the cancellation RPC rejects finished jobs. The fixture now reads/locks that existing terminal lease fence, preserving the actual failure outcome; it does not rerun or overwrite the job. The complete 17-case rerun passed, including four unclean database restarts. Early diagnostics were corrected before verification; the 2026-08-30 persistence run passed all 17 cases without fixture changes.

Cleanup verification from the repository root:

```sh
docker ps -a --filter label=qorpera.test=runtime-workers --format '{{.Names}}'
docker volume ls --filter label=qorpera.test=runtime-workers --format '{{.Name}}'
```

Both returned no entries after the launcher removed its owned disposable containers, volumes and temporary object directories. No user or production data was removed.

## Remaining cloud acceptance

Do not mark deployed Step 5 complete until main integration demonstrates all of the following:

- An authorized parent dispatches a **real in-house child**, returns from admission promptly and responds to a new human message while that child is still working. Exercise actual interruption/continuation, not a sleeping or simulated provider.
- Inspect the native child's initial context and tool surface: only explicit bounded sources/tools; no parent transcript, session, credentials, full company authority or public mouth. Attempt public sends, the actual `send_coworker_message` surface and aliases, and unauthorized reads/writes at the real effect boundary; private coworker metadata must not bypass parent-only reporting.
- Accept the explicit bridge for current provenance-bearing Company File reads and the required native `recordContextView` callback. Verify paginated todo/source reads, exact read observations, snapshot/byte bindings, context projections, authority revocation and failed recording at the real native boundary. No field stripping, no-op callback or missing adapter may release model context or admit work.
- Two real children work concurrently with separate private streams. An authorized follow-up reaches the original child/stream, with no duplicate run, leaked context or stale-sequence effect.
- A real child reports `blocked`; the exact authorized parent supplies bounded missing information through the v2 checkpoint API, and the same child run/stream continues. Race the old queued completion and its acknowledgement with resume and the new result; old consumption must be rejected. A native adapter without same-stream blocked continuity must reject activation, not clone the worker.
- Real output/proposal receipts authenticate the child and live grant. Receipt arrival alone is not acceptance or approval. Accepted output and the todo remain live Company File state after process, node and database restart and are subject to current ACLs.
- Completion atomically persists its private intent, wakes or continues the exact authorized parent through the real queue, and never fabricates a human/coworker message or public output. Duplicate delivery and consumer restarts cause no duplicate parent work.
- Race cancellation, parent termination and authority revocation with dispatch, native effects, completion, acceptance and queue consumption. Existing workers stop or are safely fenced; late acknowledgements/results and regrant cannot restore old authority. Exercise both default cancellation and explicitly authorized retention.
- Kill cloud components before/after each persistence/admission boundary. Resolve ambiguous external effects through existing durable receipts/operator proof; do not automatically re-execute them. Verify safe cancellation of an admission whose response was lost.
- Verify protected-path proposals, unreadable/moved/tombstoned todo objects, capacity exhaustion, cross-company/parent routing attempts, authority outages, snapshot GC/reachability and current access to accepted references.
- Saturate a real todo with bounded work and immutable blocked history: excess dispatch/follow-up/resume must be refused before admission, while every admitted in-budget result, acceptance, continuation and cancellation remains writable. Verify the native child receives and obeys the explicit result budget.
- Keep one real worker's lookup, continuation or stop service unavailable while independent workers complete and cancel. Verify per-worker failure reporting and guarded active-state recovery without repeat execution or authority restoration.
- Separately accept coding continuity in Step 9 against a real VM/repository/branch and explicit callback or durable listener. This handoff only defines that seam.

This file is the handoff to the user in the assigned session. It does not request or signal work in another session.
