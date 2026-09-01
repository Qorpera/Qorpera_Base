# Runtime Step 8 — scheduler policy and external listeners

## Status and scope

**The independent components are implemented and locally verified. Deployed Step 8 acceptance is not complete.** Shared runtime wiring, real connector authority, an external Step 3 wake source, and live cloud acceptance remain with the main implementation.

**Latest correction, 2026-08-30:** the seventh review's intent-path authorization finding is fixed in the scoped occurrence guard. It now rechecks the current projected path through Step 3's existing authority helper using the occurrence's pinned requester/staff identities. Permanent regressions cover queued/materialized work, grant revocation, private scope, explicit grant restoration and unchanged occurrence/epoch/state/cursor/projection snapshots after database restart. **192 focused tests**, the complete disposable PostgreSQL harness and repository checks pass. Shared materialization/effect wiring and its revocation races remain unimplemented here.

**Review corrections, 2026-08-28:** the fifth review's expiry reconciliation defect is fixed. The public schedule RPC now commits expiry without ambiguous column references, with permanent coverage for empty/populated queues, replay, rollback, concurrency and restart. All earlier corrections remain intact. **192 focused tests**, the disposable PostgreSQL harness, all **14 transition sequences / 102 actions**, and repository checks pass. Shared File-drain integration, positive external wake admission and authentication recovery remain main-owned and unapplied. Evidence for each review and correction round is preserved separately below.

All implementation changes are new, scoped files in `/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2`. No existing tracked file, shared provider, mouth, context composer, Company File gateway, runner, or authority implementation was changed. No other session was contacted. No subagents, sessions, automations, provider requests, production access, live migrations, deployments, commits, pushes, or merges were used. Distinct skills used: **0**.

| Component | Verified result | Remaining dependency |
| --- | --- | --- |
| Schedule policy, UTC identities, DST and previews | Pure TypeScript implementation and SQL admission validation pass | Route the existing cloud reconciler through these components |
| File-bound policy, edits, pause/resume, expiry | Real File publication receipts, transactional projections, CAS, rollback, cancellation and restart pass; queued/materialized intent-path rechecks reject revoked/private authority; real File-admission contract test confirms the epoch requirement | Integrate the admitted routine writer, atomic File occurrence epoch attachments, and materialization/effect guards |
| Authentication suspension | Canonical terminal evidence, configurable reset policy, durable deduplicated intent and concurrent threshold transition pass | Trusted failure classification and authorized recovery receipt producer |
| Notification delivery boundary | Real native send receipt is acknowledged after database restart without appending another event | Main must supply an authorized sender and pin its execution identity across retries |
| GitHub HTTP ingestion and receipts | Raw-byte HMAC, bounded parsing, normalization, eligibility decisions, duplicate/reordered receipts and restart pass | Step 7 authorization and Step 3 external wake admission intentionally fail closed |

## Frozen baseline and audit

Runtime references were frozen at **2026-08-28T16:33:11.276Z**, before implementation. Working-file hashes, not repository revision alone, define the audited inputs. The full 1,009-file inventory is in [baseline.json](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/deploy/first-node/step8/baseline.json).

| Reference | Revision at capture | Files hashed |
| --- | --- | ---: |
| Assigned worktree, initially clean | `a0b692947d5c867353591b36172afcc997f0521e` | 297 |
| Read-only main at `/private/tmp/qorpera-step2-resume.rN3rbf/source` | `a20dd1ef0dbdcce31166789053b2d7bb5ab2a929` | 361 |
| Step 3 artifact in worktree `3c4c` | Parent repository `2823637c0fd6def4cf21d3bc8e21f5f472f9d6b1` | 349 |
| Contract in worktree `27d4` | `18181de7f2698c9f44347a7ee141eebead84bc35` | 2 |

Selected working-file SHA-256 values:

| Frozen file | SHA-256 |
| --- | --- |
| Runtime contract | `f6c9836df26c313bab133b6d77465749ecb14b023e6b71f44fb850a25d919ede` |
| Main/local `packages/runner-orchestrator/src/orchestrator.ts` | `c01cfeeb729e70134bb4b3fa78df3776503c79805949da17fe8d7ab796e6a8af` |
| Main gateway `20260828005000_company_file_path_gateway.sql` | `f312180efc6a5d20df523c86a3c40bba7f1585f533032aee2165727ccbab22bc` |
| Step 3 `20260828020000_runtime_wake_bus.sql` | `3536aa777fc41f069d64c89144f5364e10f298ae041363851f67624decc6115c` |
| Step 3 handoff | `0f4edfa279e376c4cacdcf839ebda0f541796fd887da691f73c80aeb8c61023a` |

The Step 3 handoff identifies patch tree `3d50211ce71075a86b5328897aea233077eafc49` and Step 2 patch SHA-256 `1d92d0aef8f5a9028cb3752ef97adf1ba828dee637c795d3004fa17a7f71461d`. Its artifact is an overlay, not the parent repository commit. No runtime implementation reference was refreshed during development. A verified copy of the frozen inputs is preserved under `.artifacts/step8-verification/references` in this worktree.

Before the review fixes, the delivered files and evidence were verified against their manifest and copied locally at **2026-08-28T18:00:46.607Z**. [Review-fix baseline](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/review-fixes/start.json) records the unchanged assigned-worktree revision, previous manifest hash and all prior working-file hashes. The snapshot is under `.artifacts/step8-verification/review-fixes/before`; no other worktree was reread or updated for these fixes.

One separately recorded prerequisite was restored later: 39 ignored public model-catalog JSON files, including their manifest, were copied from the supplied main reference at **2026-08-28T17:19:10.317Z**. The repository validator accepted them. [model-data-inputs.json](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/deploy/first-node/step8/model-data-inputs.json) records every hash; a verified copy is retained under `.artifacts/step8-verification/model-data`. This was an ignored build-input restoration, not a runtime reference update, dependency change, provider call, or edit to generated TypeScript.

Before addressing the second review, all delivered files and prior evidence again matched their manifest. [Validation-fix baseline](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/validation-fixes/start.json), captured at **2026-08-28T18:21:08.718Z**, records the unchanged assigned-worktree revision and the hashes of all 17 existing delivery files, including the previous manifest. Their snapshot and previous logs are under `.artifacts/step8-verification/validation-fixes/before`. Only this worktree's frozen reference copies were used.

Before this third correction round, [start.json](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/third-review-fixes/start.json), captured at **2026-08-28T19:01:03.069Z**, verified all 18 delivery files including the manifest, 17 prior implementation evidence files, and 18 third-review evidence files including its separate manifest. The original delivery is copied under `.artifacts/step8-verification/third-review-fixes/before`. HEAD remains `a0b692947d5c867353591b36172afcc997f0521e`; only the existing frozen reference copies were used. The [third reassessment](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/reassessment-3/REASSESSMENT.md) remains an unchanged historical record of the defects before these corrections.

The fourth correction round began with [start.json](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fourth-review-fixes/start.json), captured at **2026-08-28T19:36:50.474Z**. All 19 delivery files, 29 prior implementation evidence files and 20 fourth-review evidence files matched their recorded hashes. The starting delivery is copied under `.artifacts/step8-verification/fourth-review-fixes/before`. HEAD and all frozen references remain unchanged; no other worktree was reread. The [fourth reassessment](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/reassessment-4/REASSESSMENT.md) remains an unchanged record of the defects before correction.

The fifth correction round began with [start.json](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fifth-review-fixes/start.json), captured at **2026-08-28T20:13:56.262Z**. All 19 delivery files, 40 prior evidence entries, 23 fifth-review files including its manifest, and all 1,009 frozen reference files matched their recorded hashes. The starting delivery is copied under `.artifacts/step8-verification/fifth-review-fixes/before`. HEAD is unchanged. Only owned frozen copies were read; the [fifth reassessment](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/reassessment-5/REASSESSMENT.md) remains an unchanged historical record of the defect.

The seventh-review correction began with [start.json](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/seventh-review-fixes/start.json), captured at **2026-08-30T21:11:08.379Z**. All **20 delivery files**, **59 prior evidence entries** (including the sixth and seventh review manifests), their nested review inventories, and all **1,009 frozen reference files** matched their hashes before edits. The complete starting delivery is copied under `.artifacts/step8-verification/seventh-review-fixes/before`. HEAD and the frozen references remain unchanged. The [seventh reassessment](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/reassessment-7/REASSESSMENT.md) retains its original failing results; this correction does not rewrite historical evidence or refresh another worktree.

### Existing implementation audited and reused

Paths in the following audit refer to the frozen repository inputs.

| Existing piece | Finding and reuse |
| --- | --- |
| `packages/runner-orchestrator/src/orchestrator.ts` | Reuse the cloud orchestrator, `CloudRoutineScheduleReconciler` integration point and `SupabaseCloudRunnerOrchestratorControlPlane` transport. Existing interval/calendar grammar and occurrence identity are preserved. The old catch-up loop walks elapsed history and coalesces beyond 32; the new planner bounds the scanned history and preserves each selected slot's identity. |
| `supabase/migrations/20260820002000_runner_orchestrator_contracts.sql` | Reuse `qorpera_cloud_routines`, immutable-version contract, `qorpera_cloud_routine_schedule_cursors`, `qorpera_enqueue_routine_wake`, `qorpera_wake_occurrences`, existing jobs, execution runs and terminal events. The enqueue RPC already combines cursor CAS and queue insertion, but does not prove the complete new policy. |
| Existing routine upsert | `qorpera_upsert_cloud_routine` has client-version identity/retry handling, but no expected-head CAS argument and no admitted File/status transaction for this policy. Do not expose it as a bypass around the new projection. |
| `packages/shell/src/routine-triggers.ts`, `staff-routines.ts`, `wake-scheduler.ts`, `webhook-listener.ts`, `cloud-wake-arbiter.ts`, `github-company-connector.ts` | Audited trigger, listener and connector machinery. The existing webhook listener starts a loopback server; it is not reused as a cloud listener. No desktop execution or secret store was introduced. Connector RPC and credential authority remain Step 7 responsibilities. |
| Company File path gateway | Reuse the actual path entry/version, file SHA, revision, and completed `qorpera_run_operation_receipts` result. A projection must accompany the same admitted File transaction. No alternate File writer or manifest authority was added. |
| Step 3 wake bus | Reuse `qorpera_pin_wake_occurrence`, `qorpera_wake_path_authorized`, `qorpera_wake_authorized`, existing causal fencing, policy, Company File change delivery and `qorpera_materialize_wake_execution_runs`. Step 8 never supplies a replacement materializer or File listener. |
| Native mouth / send receipts | Reuse `qorpera_send_native_agent_message`, canonical `qorpera_session_events` and `qorpera_agent_sends`. An intent is not a public message; acknowledgment requires an actual authorized send receipt. |

## Changed-file manifest

[changed-files.json](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/deploy/first-node/step8/changed-files.json) lists every added file, byte count and SHA-256, plus hashes of verification logs. It excludes its own hash. Existing tracked files modified: **none**.

| New file, relative to this worktree | Purpose |
| --- | --- |
| `packages/runner-orchestrator/src/routine-policy.ts` | Closed policy/trigger compiler, timezone resolver, schedule planner, preview, occurrence identity and admission decision |
| `packages/runner-orchestrator/src/routine-policy-adapters.ts` | Concrete RPC control adapter, one reconciler invocation and authorized notification sender adapter |
| `packages/runner-orchestrator/src/github-routine-listener.ts` | Stateless raw HTTP webhook verification, parsing bounds and normalized ingress adapter |
| `deploy/first-node/step8/runtime-scheduler.sql` | Transactional File projections, schedule admission, epochs, expiry, auth observations and notification intents |
| `deploy/first-node/step8/runtime-listener-receipts.sql` | Durable external event/delivery receipts, resource reorder watermarks and a monotone cloud clock; closed Step 3/7 hooks |
| `packages/runner-orchestrator/test/routine-policy.test.ts` | Deterministic policy, identity, preview and adapter tests |
| `packages/runner-orchestrator/test/github-routine-listener.test.ts` | Signature, bounds, normalization, identity and adapter tests |
| `packages/runner-orchestrator/test/fixtures/routine-policy.json` | Explicit example policy shared by TypeScript and PostgreSQL tests; not a product default |
| `packages/runner-orchestrator/test/fixtures/routine-validation.json` | Shared GitHub/File trigger schema, timezone normalization, canonical instant and schedule-anchor cases consumed by TypeScript and actual PostgreSQL validators |
| `packages/runner-orchestrator/test/fixtures/github-pull-request.json` | Synthetic GitHub App payload with realistic IDs, PR shape and hostile free text |
| `deploy/first-node/step8/runtime-fixture.sql` | Disposable authority fixture extension; never a production migration |
| `deploy/first-node/step8/runtime-scheduler.test.sql` | File, queue, epoch, auth and notification persistence assertions; current intent-path authority and identity-preserving restart regressions |
| `deploy/first-node/step8/runtime-scheduler-expiry.test.sql` | Public schedule-commit expiry, immutable occurrence evidence, replay, exact boundary, rollback, concurrency and restart assertions |
| `deploy/first-node/step8/runtime-listener-receipts.test.sql` | Durable duplicate/reorder handling and closed-gate assertions |
| `deploy/first-node/step8/runtime-file-listener-policy.test.sql` | Real Step 3 File admission plus explicit test-only epoch writes demonstrating the required main-owned transaction contract |
| `scripts/test-runtime-scheduler-listeners.mjs` | Isolated PostgreSQL install, backend interruption, concurrent consumers and database restart harness |
| `deploy/first-node/step8/baseline.json`, `model-data-inputs.json` | Audit and prerequisite provenance |
| This handoff; `deploy/first-node/step8/changed-files.json` | Integration contract and delivery manifest |

The two implementation SQL files are **not** in the migrations directory and are not applied automatically. The main implementation must review/order them after the gateway and Step 3, then include them in one reviewed migration transaction. Fixture/test SQL must never be deployed. Package exports and shared changelogs were intentionally left unchanged.

## Component contracts

### File intent and enforcement projection

The File document schema is `qorpera.routine-intent/v1`, with exactly `schema`, `routineId`, `version`, `definition`, `status`, and `policy`. `definition` is the existing compiled routine definition, including explicit null fields where the existing digest requires them. Its PostgreSQL `jsonb::text` SHA-256 must match the immutable routine version's `content_sha256`; its trigger must equal that version's trigger. The document's raw UTF-8 SHA must match the actual admitted File entry.

The admitted routine writer must perform this sequence in **one database transaction**:

1. Authorize the existing native/member operation, validate expected File and routine versions, and call private `qorpera_step8_lock_intent(environment_id)` **before** changing an existing routine head/version/status. Lock order is profile GC fence → Company File → routine → enforcement state.
2. Run `parseRoutinePolicy`, then `compileRoutineTrigger` with that parsed policy. Store those returned values in the File document and compiled version, including canonical timezone names and resolved calendar weekday defaults. Create/update the existing version/head through its authorized path; do not validate and then persist the uncompiled input.
3. Publish the actual intent document through the existing File gateway. Require an applied result, not a proposal.
4. Call private `qorpera_step8_project_routine(routine_id, expected_version, path, result, document_text)` with that operation's result and bytes.
5. Commit the File revision, routine head and projection together. Retry a lost response using the original operation identity. A matching committed projection replay does not reactivate the routine.

The projection verifies a visible, still-in-progress File revision, its receipt/result, content hash, current path entry and notification audience. Savepoint/subtransaction publication is supported. Deferred constraints reject enrolled head/File drift at commit. Policy-body or path changes require a new routine version. Status transitions can retain the version but advance an enforcement epoch and set future-only activation. The epoch is **not** part of occurrence identity.

Queued old work is cancelled without rewriting its identity or run. Cancellation skips rows already owned by another transaction; those rows require the materialization/effect guard described below. Authentication suspension survives edits and ordinary resume. Expiry is sticky for the same version, including clock rollback; a new admitted version can extend the expiry. No enforcement transition silently rewrites File intent.

Private `qorpera_step8_occurrence_allowed_at` retains the policy row's path and conjuncts `coalesce(qorpera_wake_path_authorized(w.environment_id,w.requested_by_user_id,w.staff_agent_id,intent_path),false)` with its existing projection, version/epoch, time and generic wake checks. A consistent File entry/hash does not establish current path access; scheduled wake authority does not know the intent path, and a File wake's changed path can differ from its routine intent. Revoked grants or private scope therefore deny already queued/materialized work without rewriting its identity or attachment. Explicitly restoring an owner-authorized read grant can restore this predicate's eligibility if the other checks still pass. The Step 3 helper takes the existing profile/File locks; callers must establish the common lock order before routine/state/occurrence locks, as specified in the main-owned wiring below.

This projection currently consumes a **native run-operation File receipt**. A main-owned member-command receipt path needs an equivalent admitted receipt adapter; a service JWT or synthetic result is insufficient. Deletion/retirement, path moves, GC and all other routine writers must be brought under the same transaction contract before rollout.

### Scheduler and preview

`createRoutinePolicyControl(rpc)` uses the existing authenticated RPC transport. `reconcileRoutinePolicy(control, routineId, now, signal)` reads a bounded current context, makes one pure plan and atomically commits it. It owns no timer, daemon, credential or execution queue, and performs no blind retry on stale CAS.

Service RPCs are `qorpera_step8_read_schedule_context(uuid)`, `qorpera_step8_commit_schedule(jsonb)` and `qorpera_step8_expire(uuid,bigint,bigint)`. Production admission samples the database clock after locks. SQL checks File authority, current version/epoch, observed watermark, existing schedule cursor, exact slots/keys, catch-up age/count, quiet windows and expiry, then uses the existing enqueue RPC. Cursor, queue, epoch attachments and watermark commit together. Exact last-plan replay is a receipt-only duplicate; a backward clock cannot rewind a watermark or admit new work.

A valid empty schedule plan at or after expiry commits suspension, cancellation of unlocked queued occurrences, watermark, cursor and replay receipt atomically through the same public schedule RPC. Cancellation preserves existing occurrence identity and epoch data, retains `FOR UPDATE SKIP LOCKED`, and never rewrites already terminal rows. The public RPC and separate expiry RPC are both covered; testing only the latter does not exercise schedule reconciliation's expiry branch.

The shared locked-state boundary requires a non-null routine ID and positive, non-null version/epoch. Missing or null bindings fail with SQLSTATE `22023`; stale complete bindings fail with `40001`. Comparisons use `IS DISTINCT FROM`, including stored authentication-recovery receipt bindings, so SQL null cannot suppress a rejection. An existing recovery receipt with a different or null binding fails with `23505`. These checks apply to schedule admission, listener ingestion, expiry and recovery without changing occurrence identity.

Every schedule-plan timestamp must use canonical UTC millisecond text. This includes `expectedObservedThrough`, `through`, `nextDueAt`, nullable `expectedLastScheduledFor`/`truncatedBefore`, and each occurrence's `scheduledFor`. SQL rejects microseconds, alternate timestamp spellings, invalid dates and other JSON types with `22023` before recording a plan or admitting work. It never rounds a caller's identity or CAS value. State constraints also prevent submillisecond activation/watermark writes.

Any supplied schedule `startAt` must pass the same canonical instant validator, including the inclusive Unix-epoch lower bound, before SQL delegates the remaining schedule grammar to Step 3. An invalid anchor cannot commit an intent/projection that the TypeScript planner cannot consume. Omission retains the existing anchor behavior; values are never rounded or rewritten.

The identity remains exactly:

```text
routine:<routine UUID>:v<version>:<trigger ID>:<scheduledFor UTC ISO with milliseconds>
```

The UUID retains the existing SHA-256 seed `qorpera.routine-occurrence/v1:<key>` and existing UUID bit layout. Policy, resume epoch, catch-up batch and receipt IDs are never added to the key. A test invokes the original reconciler to compare its identity byte for byte.

`previewRoutineSchedule` requires an explicit UTC interval, viewer timezone and limit. It returns UTC/local/viewer times and eligible/quiet/expired annotations; it does not imply current authority or incorporate pause state. Bounds are 370 days, 8,192 candidate local slots, and 256 returned rows. Oversized requests fail rather than silently changing policy. `nextDueAt` is the next schedule candidate, even if quiet or expired; admission remains authoritative. SQL bounds `nextDueAt` but does not independently prove it is the earliest candidate: the trusted planner remains responsible for liveness and the selected newest subset.

### GitHub ingestion

The trigger validator checks JSON types before reading text identities or event names. Numeric/boolean trigger IDs and null/mixed event arrays are invalid; a numeric string trigger ID remains valid. Shared TypeScript/SQL fixtures also cover optional reply policy, actor IDs, delivery bounds, missing fields and unknown fields. Company File `match` must be the scalar string `exact` or `subtree`; the compiler never coerces an array or returns it under a string assertion. SQL still delegates File and schedule grammar to Step 3's unchanged validator after the Step 8 schedule-anchor check.

`handleGitHubRoutineWebhook(request, binding, adapters, now)` is a stateless cloud HTTP adapter. The existing cloud ingress must provide an opaque route-to-routine binding, an unconsumed raw request and the Step 7 secret bridge. It does not start a server.

It verifies SHA-256 HMAC over exact raw bytes before JSON parsing, rejects compressed bodies and ambiguous headers, and limits the body to 256 KiB, depth to 32, nodes to 16,384 and adapter/body waits to eight seconds. Signature comparison is constant-time. Errors have empty bodies; raw payload, secret, title, description, login and supplied URLs are excluded from the normalized event. GitHub specifies verification over the payload bytes with `X-Hub-Signature-256`. [GitHub signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)

Supported events are PR opened, updated (`edited`, `reopened`, `synchronize`), merged (`closed` plus `merged=true`), and review requested. The signed PR `action` must be a scalar string: malformed types return HTTP 400 before admission, while unsupported string actions retain HTTP 204. Binding uses numeric installation, base repository and sender IDs; unsafe JSON numeric IDs, mismatched base repositories and the ghost sender fail. Review requests identify a user or team target separately. The normalized schema is `qorpera.github-event/v1`, always `trust: external`.

Title/body `edited` events are updates for open, closed-unmerged and merged PRs. Editing a merged PR does not become another merge event. Opened/reopened/synchronize/review-requested actions require an open, unmerged PR; a `closed` action requires closed state. Inconsistent action/state combinations return HTTP 400. A valid closure without a merge still returns HTTP 204. This follows the [edited-event schema](https://raw.githubusercontent.com/octokit/webhooks/main/payload-schemas/api.github.com/pull_request/edited.schema.json), which references the [common PR schema](https://raw.githubusercontent.com/octokit/webhooks/main/payload-schemas/api.github.com/common/pull-request.schema.json) permitting both open and closed states; it adds no implicit product filter for edits after closure.

`qorpera_step8_ingest_github(jsonb)` is the durable service boundary. The service-only normalized RPC is **not** a public webhook endpoint or a replacement for HMAC verification. SQL independently requires supported scalar `action`/`event` strings and their exact mapping; null pairs, unknown values and mismatched pairs raise `22023` before fresh or duplicate receipt processing, without changing either clock or any ledger. SQL locks current File/routine state and rechecks routing, actor, activation, status/suspension, expiry, event selection, received/admission weekday and quiet policy, event age and configured future skew. A valid known but unselected, paused, quiet or expired event receives a durable ignored decision. Unsupported provider event names or string actions return HTTP 204 without admission.

The normalized `bodySha256`, `eventKey` and `headSha` fields must be JSON strings before their hexadecimal length checks. Numeric values are rejected even if PostgreSQL's text conversion would resemble a valid hash; valid hashes containing only decimal digits remain accepted strings. `receivedAt` uses `qorpera_step8_instant_valid`, matching the compiler's canonical UTC millisecond spelling and inclusive Unix-epoch lower bound. The separate receive-time check against the database clock remains. Invalid hash or receipt-time values raise `22023` before fresh/duplicate receipt writes, leaving state, both clocks, ledgers and queue unchanged.

Every valid terminal receipt, including ignored events and duplicate deliveries, commits `observed_through = greatest(previous, database admission clock)` at millisecond precision in that same transaction. Delivery clocks are validated before the duplicate path. Provider `updatedAt` never advances this cloud clock; it only participates in the separate resource ordering policy. A new event observed while the database clock is behind the persisted watermark is ignored; an existing receipt can still replay without admitting work. Pause/resume uses the persisted clock as the activation floor. Missing authority, malformed input or transaction interruption cannot leave a partial clock advance.

The event key is SHA-256 of recursively canonicalized signed JSON; the delivery receipt separately stores the raw-body SHA and GitHub delivery GUID. The ledger deduplicates by `(routine,eventKey)` across versions/epochs and binds `(routine,deliveryGuid)` to content. Changing an unsigned GUID or JSON object-key order cannot manufacture a new logical event. A conflicting GUID/content pair fails. Receipt replay never recreates cancelled work. GitHub redelivery retains the delivery ID, and deliveries must not be treated as an ordered stream. [GitHub webhook practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)

The configured reorder policy is `accept` or `drop-older`, using PR `updatedAt` as a per-resource watermark, not a fabricated vendor sequence. Equal timestamps with different bodies remain distinct. Ignored known actions can advance this watermark; denied or future-dated events cannot. Choose `accept` when every distinct action matters: `drop-older` intentionally loses older actions. The ledger stores terminal ingestion decisions, not runnable work.

Eligible admission calls two private hooks in the same transaction:

- `qorpera_step8_github_authorized(jsonb)` — Step 7 must check and lock live connection, installation/repository access, actor/audience, staff, credential/grant and revocation authority.
- `qorpera_step8_admit_github_wake(jsonb)` — Step 3 must insert its typed `github` wake in the existing queue with its source identity, policy, sponsor and causal rules.

Both hooks currently raise SQLSTATE `55000`. Missing authority/admission rolls back all receipt and watermark changes and yields HTTP 503. The component never substitutes a schedule, Company File event, public message or fake execution for a GitHub wake. A completed RPC returns admitted/duplicate/ignored/denied; the HTTP adapter validates that receipt before returning 202 or 403. The public GitHub service does not automatically redeliver failed deliveries, so production recovery needs an explicit bounded redelivery strategy in the existing cloud integration. [GitHub delivery troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks)

### Authentication suspension and authorized notification

`qorpera_step8_record_auth_outcome(event_id)` accepts canonical terminal run events only when the real job and occurrence agree on terminal status. `failureClass: authentication` must come from a trusted main/Step 7 producer; error-string matching and client assertions are not accepted substitutes.

Observations are unique by event/run/occurrence. Counts use admission order after the newest observed reset outcome, not callback arrival or wall-clock order. The explicit `resetOn` setting chooses success-only or any non-authentication terminal outcome. Older late successes cannot erase newer failures. Old version/epoch evidence is recorded as stale without affecting the current policy. Crossing the configured threshold makes suspension sticky, cancels queued work and inserts one intent per `(routine,epoch)` in the same transaction. Late success does not automatically recover a suspended routine.

`qorpera_step8_list_notification_intents(limit,after_created_at,after_id)` provides bounded pending-intent discovery for the existing authorized delivery machinery. `deliverRoutineSuspensionNotification` uses the stable key `routine-auth:<intent UUID>` and fixed suspension text. An absent sender throws and leaves the intent pending.

`qorpera_step8_ack_notification(intent_id,message_id)` requires the real `qorpera_agent_sends` receipt, canonical event, matching session/company/environment/staff, exact key/text hash and currently authorized recipient. It cannot create a public event. The currently accepted recipient is an owner/admin with File path authority and a matching staff session.

**Existing send idempotence is scoped to `(run_id,idempotency_key)`.** The main sender must durably pin one authorized execution/assignment to an intent before sending, reuse that run/key on response loss, and reconcile an existing canonical send before considering another run. This track does not claim exactly-once public delivery across independently created notification runs. The failed routine's expired lease is not a notification authority, and `memberId` must never be impersonated.

`qorpera_step8_resume_after_auth` has receipt deduplication and a future-only epoch transition, but calls the closed `qorpera_step8_auth_recovered` hook. Main/native/Step 7 must verify a durable recovery receipt for the failed credential, newer than the suspension cause. Positive recovery is deliberately not claimed or tested using an authority stub. Recovering a File-paused routine does not activate it.

## Explicit policy choices and unresolved decisions

Every required policy field must be supplied in the File. Missing policy fails. The test fixture's all-days/threshold-three/one-day-catch-up values are examples, **not shipping defaults**.

| Topic | Implemented semantics |
| --- | --- |
| Timezone | Explicit `UTC` or recognized IANA zone; no device zone, abbreviation or numeric-offset fallback. The compiler normalizes casing/aliases using `Intl.DateTimeFormat.resolvedOptions().timeZone` for policy, trigger and preview labels. Store its output; SQL and Step 3 validate exact installed zone names. UTC instants use canonical millisecond ISO format, from 1970 onward. |
| Elapsed interval | Existing 5–10,080 minute range, anchored to explicit `startAt` or the existing Unix-epoch anchor. Local weekday policy still filters candidate instants. |
| Calendar schedule | Explicit local point or existing inclusive same-day schedule window, optional months; calendar weekdays are compiled from explicit policy defaults when omitted. This schedule-window convention is separate from quiet-window boundaries. |
| DST | Nonexistent local minutes/dates are skipped. Fold choice is explicitly `earlier`, `later` or `both`. No fixed-offset assumption; half-hour transitions and historical second offsets are covered. |
| Quiet windows | Up to 14 windows, `[start,end)`. Overnight windows belong to the weekday on which they start. `quietMode: skip` is required; deferral is unsupported. Both fold instants of a quiet local minute are quiet. |
| Missed occurrences | Explicit maximum age 0–604,800 seconds and newest-count limit 1–256. Discarded slots are passed by a monotone observed watermark; no synthetic coalesced identity. Age zero permits only the exact slot and leaves no scheduling/transport-latency tolerance. |
| Pause/resume | `resume: future-only` is required. Activation is at least the last persisted cloud observation. Valid listener receipts, including ignored and duplicate deliveries, advance that observation monotonically; new listener events during clock regression are ignored. The tested pause/resume and restart cases cannot reopen older work. |
| Expiry | Canonical instant or explicit null. No admission at or after expiry, including catch-up of an older slot. A finite watch must be authored with a non-null expiry. |
| Authentication failures | Explicit threshold 1–100 and reset policy. Suspension is conservative and sticky even if reordered later evidence changes the count. Recovery requires the closed authority hook. |
| GitHub freshness/order | Explicit max age 1–604,800 seconds, future skew 0–3,600 seconds and `accept`/`drop-older`. An ingress receive timestamp later than the DB admission clock is rejected. All clocks must be trusted cloud clocks. |

Main/product decisions still required: actual authoring defaults; finite-watch representation; approved notification recipient/route and durable sender-run pin; native provider versus connector authentication-failure classification; recovery receipt authority; ledger retention without reopening old deliveries; required GitHub redelivery SLA; desired treatment of older distinct PR actions; and whether unsupported quiet deferral/calendar-midnight behavior is needed. No arbitrary implementation fallback should settle those decisions.

Local Node used ICU 78.3 / tzdata 2026b. The PostgreSQL image is pinned below. Tests demonstrate the named transition cases, not equivalence of every installed timezone database. Production must pin/compare Node and PostgreSQL timezone data and test relevant future transitions after updates; an SQL/planner disagreement must fail closed and be observable.

## Exact remaining integration work — main-owned

No item below was applied to shared code in this track.

1. **Routine authoring and File gateway:** integrate the transaction sequence above into the admitted native/member routine operation around `qorpera_upsert_cloud_routine` and the path gateway (`20260828005000_company_file_path_gateway.sql`). Require expected File/head versions, enforce exactly one trigger for every routine, preserve the existing digest format, and deny out-of-band projection writes. Add deletion/retirement/path-move handling and member-receipt support. Do not manufacture an internal member JWT to reuse the old RPC.
2. **Existing orchestrator:** change `CloudRoutineScheduleReconciler` in `packages/runner-orchestrator/src/orchestrator.ts` to use bounded discovery plus `createRoutinePolicyControl`/`reconcileRoutinePolicy` for enrolled routines. Bind RPC calls in `SupabaseCloudRunnerOrchestratorControlPlane`. Include listeners in bounded expiry discovery. The orchestrator constructor currently always prepends the old reconciler; merely adding `occurrenceReconcilers` would leave a policy-bypassing admission path. Remove that bypass for enrolled routines without adding another daemon. Handle stale CAS by a later fresh read, not reusing the old plan.
3. **Step 3 typed wake integration:** in the wake-bus migration/types, extend source validation, `qorpera_cloud_routine_trigger_valid`, `qorpera_pin_wake_occurrence`, envelope validation and wake policy for the chosen `github` source. `qorpera_activate_company_file_listener` currently treats every listener as Company File; branch by `source` so only File listeners enter that existing cursor/delivery path. Do not duplicate or replace it. Define stable external occurrence/source identity in Step 3 and implement the closed admit hook there. For elapsed schedules, pin timezone from the File policy: existing pinning otherwise falls back to UTC because the legacy interval trigger has no `timeZone` field.
4. **Company File admission:** integrate the epoch attachment and policy checks below into the existing `qorpera_drain_company_file_wakes` transaction. Installing only the later guard would block every enrolled File occurrence and leave its terminal failures without evidence bindings. Do not add another File listener or backfill epochs at execution time.
5. **Materialization and effects:** conjunct private `qorpera_step8_occurrence_allowed_at(occurrence_id,clock_timestamp())` with existing Step 3/native authorization for enrolled occurrences in `qorpera_materialize_wake_execution_runs` and immediately before effects. Establish profile GC fence → File → routine → enforcement state → occurrence locks in the shared transaction before the predicate; its reused Step 3 intent-path helper takes the File lock, so calling it after acquiring an occurrence first would invert that order. It remains a predicate, not a lease or independent lock protocol. Cover rows skipped by cancellation, already materialized runs, revoked intent-path grants/private scope and other authority revocation. Preserve Step 3's identity, silence policy and causal fencing. The permanent intent-path tests exercise this predicate under the documented locks, including fresh backends and database restart; they do not install it in shared materialization/effect code or prove an integrated revocation race. Existing concurrency tests cover scheduler pause/admission, not the complete integrated File-listener drain race.
6. **Cloud webhook route and Step 7:** mount the stateless handler in the existing cloud HTTP ingress, preserve raw bytes, bind the route to current File policy, and supply the trusted webhook-secret resolver. Implement `qorpera_step8_github_authorized` using existing connection/native authority, not a new credential store. In the same transaction, invoke the Step 3 external admit hook. Bound routing fan-out, retry/redelivery and retention in that service. No desktop listener or provider HTTP call was added here.
7. **Terminal evidence and notification:** the frozen canonical event producer has no `failureClass` contract. Add trusted terminal classification, consume its existing durable events through `qorpera_step8_record_auth_outcome`, and rediscover pending intents after restart. Bind the authorized recipient and a durable sender-run identity before calling the existing native send machinery, then acknowledge only the canonical receipt. Implement recovery receipt authorization. Shared mouth/snapshot pin issues noted below remain main-owned.
8. **Packaging and rollout:** review these modules into the shared migration order, expose only required service RPCs, retain RLS/revoked direct table access and keep time-injected/private helpers inaccessible. Add package exports and an Unreleased changelog entry when integrating. Re-run the checks against the integrated revision; this frozen overlay cannot certify later main changes.

### Company File epoch attachment and admission

The frozen Step 3 drain creates a real `company-file` occurrence and durable claim/cursor decision, but no `qorpera_step8_occurrence_epochs` row. Both the Step 8 execution guard and authentication evidence consumer require that row. The attachment is enforcement metadata; it supplies no File, sponsor or wake authority.

Main must make the following changes inside the existing drain, together with its activation/status writers:

1. Preserve bounded, fair cursor discovery and Step 3's indexed successor lookup. Establish one common lock order for profile GC fence, File, routine, enforcement state and listener cursor before processing an enrolled routine. Step 3 currently locks cursor → File; the projection locks File → routine → state. Simply adding the state lock inside that existing lane is insufficient. Under the reconciled locks, obtain the current projection/version/epoch and validate the complete binding with `qorpera_step8_locked_state`. Missing enrollment metadata or stale bindings must not fall through to legacy admission.
2. Before allocating a new occurrence, apply the live policy to trusted database admission time and `v_revision.created_at`. Require the active current version/epoch, no suspension, admission time at least `observed_through`, revision strictly after `active_since` and no later than admission, and exclusive expiry. Check `defaultWeekdays` and `qorpera_step8_clock_allowed` at both revision and admission time. Retain the existing selector, File-path authority and causal checks. A policy-ineligible matching revision gets an existing terminal denied claim and cursor advancement, with no occurrence or public event. Quiet mode is skip; do not reinterpret skipped history after resume.
3. For a newly admitted occurrence, insert the attachment below beside the existing occurrence/claim writes. `v_step8_state` is the locked state from step 1. Keep the original occurrence UUID, `file:<version>:<trigger>:<revision>` key, revision timestamp, payload and Step 3 pinning unchanged.

```sql
insert into public.qorpera_step8_occurrence_epochs
  (occurrence_id, routine_id, routine_version, epoch)
values
  (v_occurrence, v_cursor.routine_id, v_cursor.routine_version,
   v_step8_state.epoch);
```

4. Persist `observed_through = greatest(observed_through, date_trunc('milliseconds', database_admission_time))` with each terminal File decision, including denied, unmatched and duplicate observations. Revision time is not the cloud watermark. Commit the policy decision, occurrence/attachment if any, claim and cursor together; failure rolls them all back. Resample the database clock before returning an admitted batch and recheck clock, weekday, quiet and expiry boundaries under the same locks. The occurrence guard can then be used as an additional check; it cannot replace pre-insert admission or the explicit weekday/clock checks.
5. Duplicate claims reuse the original attachment unchanged. Never upsert an old occurrence into the current epoch, and never lazily add a missing epoch at materialization or effects. Pause/resume/edit must leave old attachments stale. A pre-integration occurrence without an attachment stays blocked; retiring such work requires an explicit rollout decision, not inferred authority.
6. Apply the materialization/effect integration described above and consume canonical terminal evidence through the existing auth-outcome RPC. Use the preserved admission attachment to reject stale version/epoch outcomes. Test concurrent drain/status/expiry/revocation, backend interruption and restart against the actual integrated shared transaction before rollout.

[runtime-file-listener-policy.test.sql](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/deploy/first-node/step8/runtime-file-listener-policy.test.sql) exercises actual admitted File revisions and the unchanged Step 3 drain/materializer. Its explicit test-only attachment writes demonstrate the required transaction: absent attachment is denied; current attachment plus real authority passes; duplicate delivery preserves identity; exact expiry and pause/resume invalidate work; stale terminal evidence is ignored and a current failure produces one suspension intent. This is a contract regression, **not an installed File adapter or proof of the shared drain's policy/locking integration**.

## Initial verification commands and evidence

Environment: macOS arm64, Node **v24.18.0**, npm **11.12.1**, Docker server **29.7.2**, Vitest **4.1.9**. Full versions are in [environment.json](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/environment.json).

Disposable database image:

```text
docker.io/library/postgres:17.6-alpine3.22@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94
```

Commands below were run from this worktree, except the focused tests from `packages/runner-orchestrator`:

```bash
npm ci --ignore-scripts
```

Exit 0; 602 packages added, 625 audited, zero vulnerabilities. Existing dependency deprecation notices were reported. No lockfile/dependency metadata changed and no lifecycle scripts were run.

```bash
node /tmp/qorpera-step8-restore-model-data.mjs
```

Exit 0; restored/validated the 39 ignored catalog inputs described above. This temporary helper was removed after use. The first check attempt had failed on absent ignored catalog JSON and three new TypeScript errors/three formatter infos. The local inputs were restored and the component errors fixed; no dependency or functional downgrade was used.

```bash
zsh -o pipefail -c 'node ../../node_modules/vitest/dist/cli.js --run test/routine-policy.test.ts test/github-routine-listener.test.ts 2>&1 | tee ../../.artifacts/step8-verification/vitest.log'
```

Exit 0: **49 tests, two files passed**. Coverage includes gaps/folds in Copenhagen and New York, Lord Howe's half-hour fold, Apia's skipped date, Monrovia's historical second offset, viewer timezone, quiet boundaries, expiry, decades of missed time, backward clock, exact identity, absent/stale adapters, HMAC, malformed/oversized payloads, stalled streams/bridges, unsafe IDs and duplicate normalization. [Full focused-test output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/vitest.log)

```bash
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/postgres.log'
```

Exit 0. The harness hashes every loaded reference, applies **84 frozen main migrations**, the actual Step 3 wake migration and both new modules to an isolated container with `--network none`, no host ports, and a unique disposable volume. It exercises actual SQL, separately connected consumers, a terminated uncommitted backend, and a database restart retaining the volume. Container and volume are removed in `finally`. [Full PostgreSQL output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/postgres.log)

Verified assertions include atomic File/projection publication, deferred drift rejection, exact queue identities, stale versions/epochs, expired/paused cancellation, catch-up limits, quiet batch rollback, clock rollback, auth evidence ordering/reset, one concurrent suspension intent, real authorized send receipt after restart, concurrent identical plans, concurrent duplicate deliveries and concurrent pause/admission. The concrete TypeScript RPC adapter commits through real PostgreSQL entrypoints. A signed raw GitHub fixture passes HTTP verification → normalization → SQL ignored decision → durable duplicate receipt; **no successful external wake adapter is stubbed in**.

```bash
zsh -o pipefail -c 'npm run check 2>&1 | tee .artifacts/step8-verification/npm-run-check.log'
```

Exit 0; full output retained. Biome checked 1,344 files with no final fixes, warnings or infos; pinned dependency checks, relative import checks, cloud boundaries, shrinkwrap/install-lock verification, `tsgo --noEmit` and browser-smoke checks passed. No `npm run build`, `npm test` or full Vitest suite was run. [Full repository-check output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/npm-run-check.log)

## Review fixes and re-verification — 2026-08-28

The corrections change only the two scoped SQL components, their two SQL test files, the disposable harness, this handoff and its manifest. No shared implementation, fixture authority hook, dependency, occurrence identity or runtime reference changed.

1. **Null bindings:** explicit input checks and null-safe comparisons close the stale-epoch bypass. Regression coverage uses equal wall clocks across a real File pause/resume so the epoch is the remaining fence; checks null, omitted and nonpositive bindings through public RPCs; verifies no queue, cursor or state changes; and confirms a complete current binding still admits and replays. Negative recovery-receipt replay cases also reject null version/epoch.
2. **Listener clock retention:** a validated receipt and its trusted clock observation commit together. Tests cover ignored/paused events, duplicate replay, millisecond precision, future provider timestamps, distinct resources during clock regression, activation boundaries, rollback pause/resume, malformed duplicate clocks and missing-authority rollback. Separate database connections race different clock samples; a terminated backend loses both receipt and clock; database restart preserves the maximum clock and subsequent pause/resume retains it.

The previous delivery snapshot was captured with `node /tmp/qorpera-step8-fix-evidence.mjs capture` (exit 0). The manifest was refreshed after verification with `node /tmp/qorpera-step8-fix-evidence.mjs refresh` (exit 0). This temporary helper was removed after use.

The following regressions were run **before** their corresponding fixes:

```bash
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/review-fixes/null-binding-before.log'
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/review-fixes/listener-watermark-before.log'
```

Both exited 1 as expected. The first detected that `epoch: null` admitted a stale plan instead of raising `22023`; the second, after the binding fix, detected the missing persisted listener clock. [Null-binding failure](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/review-fixes/null-binding-before.log), [listener-clock failure](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/review-fixes/listener-watermark-before.log).

After both fixes:

```bash
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/review-fixes/postgres.log'
```

Exit 0: all original and new SQL, interruption, concurrency, restart and concrete-adapter assertions passed against the same 84 frozen main migrations and real Step 3 migration. No positive external admission or recovery authority was stubbed in. [Post-fix PostgreSQL output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/review-fixes/postgres.log).

From `packages/runner-orchestrator`:

```bash
zsh -o pipefail -c 'node ../../node_modules/vitest/dist/cli.js --run test/routine-policy.test.ts test/github-routine-listener.test.ts 2>&1 | tee ../../.artifacts/step8-verification/review-fixes/vitest.log'
```

Exit 0: **49 tests, two files passed**. The added regressions are PostgreSQL tests, not additional Vitest cases. [Post-fix focused-test output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/review-fixes/vitest.log).

From this worktree root:

```bash
zsh -o pipefail -c 'npm run check 2>&1 | tee .artifacts/step8-verification/review-fixes/npm-run-check.log'
```

Exit 0: Biome checked 1,344 files with no fixes; all repository checks passed without warnings or infos. [Post-fix repository-check output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/review-fixes/npm-run-check.log). The refreshed manifest hashes both original and post-fix evidence. Disposable containers/volumes were removed after every run, including the expected failures.

## Second review: validation fixes — 2026-08-28

All three findings from the reassessment are addressed. This round changes only `routine-policy.ts`, its focused test, `runtime-scheduler.sql`, its SQL test, the disposable harness, this handoff and its manifest, and adds `routine-validation.json`. The previous listener-clock and null-binding fixes remain intact. No shared implementation, authority hook, dependency or frozen reference changed.

1. **Timestamp precision:** the service schedule RPC rejects noncanonical timestamp fields before plan receipt or occurrence insertion. A shared SQL instant validator matches TypeScript's `routineInstant`; table constraints also preserve activation/watermark precision. The regression submits the formerly accepted microsecond watermark through the real public RPC, verifies unchanged state/cursor/queue after rejection, and then commits and replays canonical plans from fresh context reads. Nullable cursor/diagnostic timestamps and malformed later occurrences are covered.
2. **GitHub schema parity:** explicit JSON type checks close both the numeric/boolean ID coercion and null event-element holes. All **43 shared trigger cases** run through TypeScript and the actual SQL validator, including valid numeric string IDs, mixed/null arrays, optional fields, actor IDs, missing fields and delivery bounds.
3. **Timezone casing:** the compiler returns canonical ICU names in parsed policy, compiled triggers and preview labels. The harness passes those actual compiled values to PostgreSQL for schedule, Company File and GitHub triggers. **18 shared timezone cases** cover casing, aliases and invalid zones; **18 shared instant cases** cover millisecond boundaries, alternate spellings and malformed dates. Persist compiler output rather than the raw authoring input. Canonical alias names depend on the pinned ICU release; production timezone-data parity remains an acceptance gate.

The starting delivery and prior evidence were copied with `node /tmp/qorpera-step8-validation.ZTzdeZ/evidence.mjs start` (exit 0). The resulting baseline is linked above. The temporary helper and timezone probe were removed after verification.

The permanent regressions were run before their corresponding fixes. From `packages/runner-orchestrator`:

```bash
zsh -o pipefail -c 'node ../../node_modules/vitest/dist/cli.js --run test/routine-policy.test.ts test/github-routine-listener.test.ts 2>&1 | tee ../../.artifacts/step8-verification/validation-fixes/timezone-before.log'
```

Exit 1 as expected: eight timezone normalization cases failed; 120 other tests passed. [Timezone failure output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/validation-fixes/timezone-before.log).

From this worktree root:

```bash
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/validation-fixes/timestamp-before.log'
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/validation-fixes/github-before.log'
```

Both exited 1 as expected. The timestamp test showed that a microsecond watermark committed instead of raising `22023`. The GitHub test, after the timestamp fix but before the trigger fix, showed SQL accepting a numeric trigger ID. [Timestamp failure output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/validation-fixes/timestamp-before.log), [GitHub failure output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/validation-fixes/github-before.log).

After all three fixes, from `packages/runner-orchestrator`:

```bash
zsh -o pipefail -c 'node ../../node_modules/vitest/dist/cli.js --run test/routine-policy.test.ts test/github-routine-listener.test.ts 2>&1 | tee ../../.artifacts/step8-verification/validation-fixes/vitest.log'
```

Exit 0: **128 tests, two files passed**. [Focused-test output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/validation-fixes/vitest.log).

From this worktree root:

```bash
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/validation-fixes/postgres.log'
zsh -o pipefail -c 'npm run check 2>&1 | tee .artifacts/step8-verification/validation-fixes/npm-run-check.log'
```

Both exited 0. PostgreSQL passed all shared validation cases, public-RPC precision regressions and prior transaction, authority, interruption, concurrent transition, restart and concrete-adapter tests against the same 84 frozen main migrations and Step 3. All test containers and volumes were removed, including after expected failures. Repository checks passed; Biome checked 1,344 files with no fixes, warnings or infos. [PostgreSQL output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/validation-fixes/postgres.log), [Repository-check output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/validation-fixes/npm-run-check.log).

Final manifest refresh and boundary verification:

```bash
node /tmp/qorpera-step8-validation.ZTzdeZ/evidence.mjs refresh packages/runner-orchestrator/test/fixtures/routine-validation.json .artifacts/step8-verification/validation-fixes/{start.json,timestamp-before.log,timezone-before.log,github-before.log,postgres.log,vitest.log,npm-run-check.log}
node /tmp/qorpera-step8-validation.ZTzdeZ/evidence.mjs verify
```

Exit 0: 18 delivery files including the manifest, 17 evidence files, matching hashes and valid handoff links; no tracked/shared file changes. The manifest preserves hashes for all three verification rounds. This remains component completion, not deployed Step 8 acceptance.

## Third review: scalar validation and File epoch contract — 2026-08-28

All four findings are addressed within this track's boundaries. Three validation defects are fixed in the scoped components. The missing File-epoch handoff is corrected above and covered by a permanent contract test; applying that integration to the shared drain is still main-owned. No shared implementation, authority hook, dependency, occurrence identity or frozen reference changed. [changes.json](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/third-review-fixes/changes.json) compares the corrected delivery files with their starting hashes.

1. **Normalized SQL events:** explicit scalar type, supported-value and action/event mapping checks reject malformed input through the real service RPC before fresh or duplicate receipts. Tests cover null pairs, unknown/mismatched values, arrays, nested arrays, objects and omitted fields. Rejections leave the complete policy state/cloud clock, resource watermark, event/delivery ledgers and wake queue unchanged. A valid unselected action still records/replays its receipt; a selected action still reaches the unchanged, closed Step 7 hook rather than being suppressed by an invalid watermark.
2. **Company File epoch contract:** the new SQL test publishes through the actual File gateway, replays the fixture human run's canonical queued event through Step 3's existing capture trigger, and uses the unchanged File drain and materializer. It verifies missing-attachment denial, a valid attachment with real authority, duplicate identity, exact expiry, pause/resume invalidation, stale terminal evidence and one current-epoch suspension intent. Its explicit metadata INSERTs represent the required same-transaction wiring; they are not a replacement File listener or evidence that main's drain already implements it. The test rolls back and does not claim an integrated File-drain concurrency/restart proof.
3. **Scalar compiler and webhook values:** File `match` and signed PR `action` retain narrowed scalar types without `String(...)` coercion or unsound assertions. There are **17 shared File-selector cases**, **10 signed malformed-action cases**, and **four unsupported-string action cases** preserving intentional HTTP 204 behavior. Malformed actions return HTTP 400 and never reach the admission adapter.
4. **Schedule anchors:** SQL applies the same canonical instant range as TypeScript to supplied `startAt` before Step 3 grammar validation. **36 shared cases** cover elapsed and calendar-point schedules. A real File projection attempt with the pre-epoch millisecond is rejected atomically without retaining a routine, File revision, changed head or policy; the exact Unix epoch remains publishable and readable through the schedule-context RPC.

Baseline capture, from this worktree root:

```bash
node /tmp/qorpera-step8-third-fixes.FvLBSD/evidence.mjs start
```

Exit 0; all previous delivery and evidence hashes matched. The starting inventory is linked above. The three defect regressions were run before their corresponding fixes. From `packages/runner-orchestrator`:

```bash
zsh -o pipefail -c 'node ../../node_modules/vitest/dist/cli.js --run test/routine-policy.test.ts test/github-routine-listener.test.ts 2>&1 | tee ../../.artifacts/step8-verification/third-review-fixes/scalars-before.log'
```

Exit 1 as expected: **13 failed, 164 passed**. Three File-array selector cases compiled instead of rejecting; ten malformed signed action cases returned 204/202 instead of 400. [Scalar failure output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/third-review-fixes/scalars-before.log).

From this worktree root:

```bash
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/third-review-fixes/anchor-before.log'
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/third-review-fixes/normalized-event-before.log'
```

Both exited 1 as expected. The first found the pre-epoch anchor validator mismatch. After the anchor fix, the second passed the anchor/projection and new File contract tests, then detected that null normalized `action`/`event` committed instead of raising `22023`. [Anchor failure output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/third-review-fixes/anchor-before.log), [normalized-event failure output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/third-review-fixes/normalized-event-before.log).

After the fixes, the focused tests and complete disposable harness passed. The first repository check passed and formatted two scoped files. Those first passing logs were retained before the final repetitions:

```bash
mv .artifacts/step8-verification/third-review-fixes/npm-run-check.log .artifacts/step8-verification/third-review-fixes/npm-run-check-initial.log
mv .artifacts/step8-verification/third-review-fixes/vitest.log .artifacts/step8-verification/third-review-fixes/vitest-initial.log
mv .artifacts/step8-verification/third-review-fixes/postgres.log .artifacts/step8-verification/third-review-fixes/postgres-initial.log
```

Final focused command from `packages/runner-orchestrator`:

```bash
zsh -o pipefail -c 'node ../../node_modules/vitest/dist/cli.js --run test/routine-policy.test.ts test/github-routine-listener.test.ts 2>&1 | tee ../../.artifacts/step8-verification/third-review-fixes/vitest.log'
```

Exit 0: **177 tests, two files passed**. [Final focused-test output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/third-review-fixes/vitest.log).

Final commands from this worktree root:

```bash
zsh -o pipefail -c 'npm run check 2>&1 | tee .artifacts/step8-verification/third-review-fixes/npm-run-check.log'
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/third-review-fixes/postgres.log'
```

Both exited 0. The repository check examined **1,344 files**, applied no fixes and reported no warnings or infos; every check stage passed. PostgreSQL passed all shared validators, new malformed-event/anchor/File contract assertions, and the existing interruption, concurrent transition, persistent-volume restart and real RPC/HTTP adapter tests against the same 84 frozen main migrations and real Step 3. No positive external admission or recovery authority was substituted. [Final repository-check output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/third-review-fixes/npm-run-check.log), [Final PostgreSQL output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/third-review-fixes/postgres.log).

Final manifest and boundary verification:

```bash
node /tmp/qorpera-step8-third-fixes.FvLBSD/evidence.mjs refresh deploy/first-node/step8/runtime-file-listener-policy.test.sql .artifacts/step8-verification/reassessment-3/review-manifest.json .artifacts/step8-verification/third-review-fixes/{start.json,scalars-before.log,anchor-before.log,normalized-event-before.log,vitest-initial.log,vitest.log,postgres-initial.log,postgres.log,npm-run-check-initial.log,npm-run-check.log,changes.json}
node /tmp/qorpera-step8-third-fixes.FvLBSD/evidence.mjs verify
```

All earlier review/implementation evidence remains unchanged. The refreshed manifest contains current delivery hashes and the new verification evidence; all handoff links resolve and no tracked/shared file changed. Disposable containers/volumes were removed after success and expected failures. The temporary evidence helper was removed after verification. No build, full Vitest suite, provider call, production access or session coordination was used. This remains component verification, not deployed Step 8 acceptance.

## Fourth review: PR edits and normalized envelopes — 2026-08-28

All three findings are addressed. This round changes only the scoped GitHub normalizer, external receipt SQL, their tests, the disposable harness, this handoff and its manifest. No shared implementation, authority hook, dependency, scheduler policy or occurrence identity changed. [changes.json](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fourth-review-fixes/changes.json) records the delivery changes against the captured baseline.

1. **PR edits after closure:** signed `edited` payloads for open, closed-unmerged and merged PRs normalize as `pull_request.updated`. Fifteen new focused cases cover these states, inconsistent action/state combinations, and preservation of valid unmerged-closure HTTP 204 behavior. The new normalization tests capture the delivery and deliberately throw; they do not substitute successful authority or wake admission.
2. **Hash types:** explicit JSON string checks reject numeric, null, boolean, array, object, missing and malformed hash values before receipt writes. The SQL regression covers both fresh and known event keys, including the former large-number coercion. Valid string hashes consisting only of decimal digits still record and replay real ignored receipts.
3. **Receipt instant domain:** the existing shared validator now checks `receivedAt` before parsing/replay. Tests reuse all 18 instant fixtures, including the exact epoch, its one-millisecond predecessor, alternate spellings and malformed types, plus missing/boolean/future receipt times. A complete state/ledger/watermark/queue snapshot remains unchanged after invalid inputs. Valid old canonical timestamps still receive and replay policy decisions.

The envelope tests run through the actual public service RPC in rolled-back test transactions before and after PostgreSQL restart. The raw HTTP test separately commits four real receipts—opened, open edit, closed edit and merged-PR edit—then restarts PostgreSQL and verifies all four return duplicate receipts. These are ignored policy decisions on the existing fixture, not positive external wake admission. The Step 3/7 hooks remain closed.

Baseline capture from this worktree root:

```bash
node /tmp/qorpera-step8-fourth-fixes.qthF8o/evidence.mjs capture
```

Exit 0; the starting hashes and snapshot are linked above. Regressions ran before their corresponding fixes. From `packages/runner-orchestrator`:

```bash
zsh -o pipefail -c 'node ../../node_modules/vitest/dist/cli.js --run test/routine-policy.test.ts test/github-routine-listener.test.ts 2>&1 | tee ../../.artifacts/step8-verification/fourth-review-fixes/normalization-before.log'
```

Exit 1 as expected: **3 failed, 189 passed**. The two edits after closure never reached normalization's admission boundary, and an inconsistent `closed` action with open/unmerged state returned 204 instead of 400. [Failure output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fourth-review-fixes/normalization-before.log).

From this worktree root:

```bash
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/fourth-review-fixes/hash-before.log'
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/fourth-review-fixes/clock-before.log'
```

Both exited 1 as expected. The first accepted a numeric body digest instead of raising `22023`. After the hash checks were fixed, all hash regressions passed and the second run detected acceptance of `1969-12-31T23:59:59.999Z`. [Hash failure](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fourth-review-fixes/hash-before.log), [receipt-clock failure](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fourth-review-fixes/clock-before.log).

An intermediate focused run passed after the normalization fix; the first full repository check after all implementation fixes also passed without changes:

```bash
zsh -o pipefail -c 'node ../../node_modules/vitest/dist/cli.js --run test/routine-policy.test.ts test/github-routine-listener.test.ts 2>&1 | tee ../../.artifacts/step8-verification/fourth-review-fixes/vitest-initial.log'
zsh -o pipefail -c 'npm run check 2>&1 | tee .artifacts/step8-verification/fourth-review-fixes/npm-run-check-initial.log'
```

The first command ran from `packages/runner-orchestrator`, the second from the root. Both exited 0. [Intermediate focused output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fourth-review-fixes/vitest-initial.log), [first check output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fourth-review-fixes/npm-run-check-initial.log).

Final focused command from `packages/runner-orchestrator`:

```bash
zsh -o pipefail -c 'node ../../node_modules/vitest/dist/cli.js --run test/routine-policy.test.ts test/github-routine-listener.test.ts 2>&1 | tee ../../.artifacts/step8-verification/fourth-review-fixes/vitest.log'
```

Exit 0: **192 tests, two files passed**. [Final focused output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fourth-review-fixes/vitest.log).

Final verification from this worktree root:

```bash
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/fourth-review-fixes/postgres.log'
zsh -o pipefail -c 'npm run check 2>&1 | tee .artifacts/step8-verification/fourth-review-fixes/npm-run-check.log'
```

Both exited 0. PostgreSQL passed the new envelope and signed-edit regressions plus every previous File, policy, expiry, authentication, interruption, concurrency and restart assertion against the same 84 frozen main migrations and real Step 3. The repository check examined **1,344 files**, applied no fixes and reported no warnings or infos; every check stage passed. [PostgreSQL output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fourth-review-fixes/postgres.log), [repository-check output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fourth-review-fixes/npm-run-check.log).

Final delivery inventory and verification use:

```bash
node /tmp/qorpera-step8-fourth-fixes.qthF8o/evidence.mjs changes
node /tmp/qorpera-step8-fourth-fixes.qthF8o/evidence.mjs refresh .artifacts/step8-verification/reassessment-4/review-manifest.json .artifacts/step8-verification/fourth-review-fixes/{start.json,normalization-before.log,hash-before.log,clock-before.log,vitest-initial.log,vitest.log,postgres.log,npm-run-check-initial.log,npm-run-check.log,changes.json}
node /tmp/qorpera-step8-fourth-fixes.qthF8o/evidence.mjs verify
```

All three commands exited 0: **19 delivery files and 40 evidence files** match their manifest, all **41 local handoff links** resolve, and no tracked/shared file changed. The 29 prior implementation evidence files and 20 fourth-review evidence files remain unchanged. No Step 8 test container or volume remains. All disposable databases use the original pinned image, `--network none`, no host ports and cleanup on success or failure. No build, full Vitest suite, provider call, production access or session coordination was used. The temporary evidence helper is removed after verification. **These corrections complete the reviewed component work; deployed Step 8 acceptance remains pending.**

## Fifth review: public schedule expiry — 2026-08-28

The single P2 finding is addressed. The implementation change qualifies the outer/inner occurrence IDs and the queued-status predicate in `qorpera_step8_commit_schedule_at`. This removes PostgreSQL error `42702` without changing global PL/pgSQL conflict resolution, function signatures, policy, identity, lock order, or `FOR UPDATE SKIP LOCKED`. No other implementation module changed.

The new `runtime-scheduler-expiry.test.sql` is loaded by the existing disposable harness after the other SQL tests. It covers public database-clock commits with zero and one queued occurrence, exact receipt replay, fresh reconciliation of an already expired routine, stale-plan rejection and unchanged cancellation timestamps. A private clock seam covers the exact exclusive boundary and clock rollback through pause/resume. Real File publication and the existing enqueue RPC create the fixtures; no authority hook or materializer is replaced.

The harness then interrupts a backend after public expiry reconciliation but before transaction commit, verifies the complete state/cursor/queue/epoch snapshot rolled back, and runs two fresh concurrent backends against the same plan. One returns `committed`, the other `duplicate`. After a persistent-volume PostgreSQL restart, three committed fixtures retain their suspension, cancellation timestamps, occurrence identities, epochs and cursors; their public RPC replays return `duplicate`. These are durable database tests, not in-memory substitutes.

Baseline and failure reproduction from this worktree root:

```bash
node /tmp/qorpera-step8-fifth-fixes.rMo3K9/evidence.mjs capture
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/fifth-review-fixes/expiry-before.log'
```

Capture exited 0. The new regression ran before the SQL correction and exited 1 as expected: the first public expiry commit raised `column reference "id" is ambiguous`, including the public/private RPC stack. [Failure output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fifth-review-fixes/expiry-before.log).

After the correction, from `packages/runner-orchestrator`:

```bash
zsh -o pipefail -c 'node ../../node_modules/vitest/dist/cli.js --run test/routine-policy.test.ts test/github-routine-listener.test.ts 2>&1 | tee ../../.artifacts/step8-verification/fifth-review-fixes/vitest.log'
```

Exit 0: **192 tests, two files passed**. No TypeScript implementation or test changed in this round. [Focused output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fifth-review-fixes/vitest.log).

Verification from this worktree root:

```bash
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/fifth-review-fixes/postgres.log'
zsh -o pipefail -c 'npm run check 2>&1 | tee .artifacts/step8-verification/fifth-review-fixes/npm-run-check.log'
node /tmp/qorpera-step8-fifth-fixes.rMo3K9/prepare-transition-check.mjs
zsh -o pipefail -c 'node /tmp/qorpera-step8-fifth-fixes.rMo3K9/transition-harness.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/fifth-review-fixes/transition-check.log'
```

All exited 0. The [permanent PostgreSQL harness](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fifth-review-fixes/postgres.log) passed the new regressions and all existing assertions against the 84 frozen main migrations, actual Step 3 and both Step 8 modules. The [repository check](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fifth-review-fixes/npm-run-check.log) examined **1,344 files**, applied no fixes and reported no warnings or infos; every stage passed.

The [supplemental run](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fifth-review-fixes/transition-check.log) reran the fifth review's TypeScript-plan/SQL transition matrix with success now required for every case. **14/14 sequences and all 102 actions passed**, including the formerly failing `exclusive-sticky-expiry` case; **27 table-role and 84 function-role checks passed**. It also reran the complete permanent harness, including the new expiry restart assertions. The transition matrix itself uses rolled-back transactions; restart durability comes from the permanent tests. [Transition results](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fifth-review-fixes/transition-results.json), [privilege results](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fifth-review-fixes/privileges.json).

Final inventory and verification commands:

```bash
node /tmp/qorpera-step8-fifth-fixes.rMo3K9/evidence.mjs finalize
node /tmp/qorpera-step8-fifth-fixes.rMo3K9/evidence.mjs verify
```

Both commands exited 0. The inventory contains **20 delivery files including the manifest and 57 evidence entries**; all **52 local handoff links** resolve. [changes.json](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fifth-review-fixes/changes.json) records the scoped changes against the captured delivery; [final-verification.json](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/fifth-review-fixes/final-verification.json) records hash verification, unchanged references and prior evidence, unchanged tracked files and disposable resource cleanup. Probe sources and the evidence helper are retained with the logs; the recorded `/tmp` directory is removed after verification. To repeat the supplemental checks, copy its retained helper sources into a disposable directory, run `prepare-transition-check.mjs` there, and invoke the generated harness from this worktree root with the same `--references` argument.

All database runs used the original pinned PostgreSQL image, a disposable volume, `--network none` and no exposed ports. No production access, provider calls, real credentials, shared implementation changes, session contact, commits or deployments occurred. There is no new product-policy decision or main-owned wiring in this fix. **The reviewed component defect is corrected; deployed Step 8 acceptance and the existing live gates remain pending.**

## Seventh review: current routine-intent authority — 2026-08-30

The single **P1** finding is corrected. The only production change is inside `qorpera_step8_occurrence_allowed_at`: retain the current projected policy path and require Step 3's existing path authority for the occurrence's pinned environment/requester/staff. Null authority is false. Projection consistency, stale version/epoch rejection, status/suspension, expiry/quiet checks and generic wake authority are unchanged. No shared authority implementation, materializer, queue, occurrence identity, policy choice or dependency changed.

The existing SQL test file now creates four real scheduled occurrences through admitted File publication and the public schedule RPC: queued/materialized crossed with staff-grant revocation/private intent scope. Materialized cases use the actual Step 3 materializer before authority changes. The owner uses the unchanged public resource/grant/revocation APIs. Each case first passes the guard, then loses path authority and is denied by both the guard and fresh scheduler context (`42501`), while generic scheduled wake authority stays true. For the two grant cases, a new explicit owner grant restores eligibility without changing the occurrence; revoking that new grant closes it again. No authority result or hook is stubbed.

The four fixtures commit their real ACL state and complete occurrence/epoch/state/cursor/projection snapshots. Fresh backend rechecks and a persistent-volume PostgreSQL restart retain every denial and snapshot, including original identity, status and run binding. These are predicate/authority persistence regressions. They do not prove that an unmodified shared materializer/effect path calls this guard, or that its concurrent revocation integration is complete.

Commands ran from `/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2`, except the focused tests from `packages/runner-orchestrator`:

```bash
node /tmp/qorpera-step8-seventh-fixes.QZsJgv/evidence.mjs capture
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/seventh-review-fixes/authority-before.log'
```

Capture exited **0**. The new permanent regression ran before the implementation correction and exited **1 as expected**: `Intent-path occurrence guard: materialized / staff-grant-revoked must return f`. The actual path-authority control had already rejected access; the old guard incorrectly allowed it. [Failure-before output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/seventh-review-fixes/authority-before.log).

After the correction:

```bash
zsh -o pipefail -c 'npm run check 2>&1 | tee .artifacts/step8-verification/seventh-review-fixes/npm-run-check.log'
zsh -o pipefail -c 'node scripts/test-runtime-scheduler-listeners.mjs --references .artifacts/step8-verification/references 2>&1 | tee .artifacts/step8-verification/seventh-review-fixes/postgres.log'
```

Both exited **0**. The [repository check](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/seventh-review-fixes/npm-run-check.log) checked **1,344 files**, applied no fixes and reported no warnings or infos; all stages passed. The [complete PostgreSQL harness](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/seventh-review-fixes/postgres.log) passed the four authority cases, two restoration controls, fresh-backend/restart assertions and all existing validation, File, schedule, expiry, auth, receipt, interruption, concurrent transition and concrete-adapter tests against the same 84 frozen main migrations and actual Step 3. Positive external admission and authentication recovery still fail closed.

From `packages/runner-orchestrator`:

```bash
zsh -o pipefail -c 'node ../../node_modules/vitest/dist/cli.js --run test/routine-policy.test.ts test/github-routine-listener.test.ts 2>&1 | tee ../../.artifacts/step8-verification/seventh-review-fixes/vitest.log'
```

Exit **0**: **192 tests, two files passed**. No TypeScript implementation or test changed in this correction; the new regressions are in PostgreSQL. [Focused-test output](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/seventh-review-fixes/vitest.log). The earlier supplemental timezone/transition matrices remain historical evidence and were not rerun in this scoped authority correction.

Final inventory and integrity commands:

```bash
node /tmp/qorpera-step8-seventh-fixes.QZsJgv/evidence.mjs verify-baseline
node /tmp/qorpera-step8-seventh-fixes.QZsJgv/finalize.mjs finalize
node /tmp/qorpera-step8-seventh-fixes.QZsJgv/finalize.mjs verify
```

The first `finalize` attempt exited **1** before writing the manifest: the inventory helper's JavaScript replacement string collapsed SQL `$$` delimiters in its expected comparison text. Returning literal text from a replacement callback corrects the helper; no implementation file changed. The [helper correction record](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/seventh-review-fixes/inventory-helper-correction.json) and original helper are retained with the evidence.

[changes.json](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/seventh-review-fixes/changes.json) records the scoped changes against the starting delivery. [final-verification.json](/Users/jonas/.codex/worktrees/13c5/Qorpera_Base-step2/.artifacts/step8-verification/seventh-review-fixes/final-verification.json) records command results, delivery/evidence/reference hashes, resolved handoff links and disposable resource cleanup. The delivery manifest includes these correction artifacts and the previously separate sixth/seventh review manifests. Historical evidence remains unchanged. Retained helper sources reproduce the inventory checks; the temporary directory is removed after verification.

All database runs used the original pinned image, a disposable persistent volume, `--network none` and no exposed ports. No other session was contacted, and no subagent, new session, automation, provider call, real credential, production access, live migration, deployment, commit, push or merge was used. **The component finding is corrected; main-owned wiring and deployed Step 8 acceptance remain pending.**

## What the disposable fixture does not prove

The harness reuses the frozen Step 3 fixture's real authorization/publisher/send APIs. It renames only fixture helpers from `pg_temp` into `step8_test` to allow fresh backend connections. It does not disable or replace production security triggers.

The File-epoch contract test explicitly inserts enforcement attachments in the same test transaction as real Step 3 File admission. That demonstrates how the guard and terminal evidence consumer depend on admission metadata; it does not install policy checks or epoch writes into the shared drain. That drain's complete lock ordering, policy-boundary races and restart behavior must be verified after main integrates the documented changes.

There is no native autonomous routine-consent producer in the frozen reference. As in Step 3, the fixture seeds a consented routine version. For the external receipt tests only, a future GitHub compiled-version shape is seeded before Step 3 installs its File-only listener activation; this is not a successful external authoring/admission test.

Provider terminal outcomes are synthetic fixtures on real materialized jobs/runs. For successful terminal fixtures, the frozen main mouth still requires a final message, and the shared session snapshot predates the routine File publication. The fixture pins that session to the admitted run snapshot and uses a real authorized final send before marking completion. It does not prove silent routine completion or the missing shared session-pin wiring. These main-owned gaps were not patched around in production code.

The notification restart test persists one actual native send and then acknowledges its existing receipt after restart. It proves durable intent/receipt recovery, not cross-run notification sending, delivery to a real member device, positive authentication recovery, or positive GitHub wake execution.

The negative recovery replay regression seeds a stored receipt binding only to verify rejection of missing caller identity fields. It does not invoke or replace the closed recovery authority, and does not establish a valid production recovery producer.

## Live cloud acceptance gates — not run

- With every member device offline, the single cloud orchestrator discovers File intent, schedules it, drains File and external events, materializes the same staff agent and uses the existing receipt path. No desktop process participates.
- Real native/member routine creation, edit, pause, resume, expiry, path retirement and rollback leave File intent and enforcement projections consistent. A plain table update, old version, stale File receipt or missing adapter cannot admit work.
- Pin production timezone data; exercise target DST boundaries, clock forward/backward correction, restart and bounded catch-up. Verify old identities do not execute twice.
- Race pause/edit/expiry and connection revocation with queue materialization and effects, including File-listener drain locks and skipped locked rows. Prove File occurrences, current epoch attachments, claims, cursors and cloud watermark commit together and survive restart; duplicate/old work must never be relabeled into a new epoch. Already admitted identity/causality remains unchanged; invalid work cannot perform effects.
- Admit a real GitHub App event using live Step 7 eligibility and the Step 3 typed source; test changed installation/repository grants, actor denial, duplicate GUID/content, redelivery, reorder and provider outages. Prove one existing occurrence/run, not a second queue or synthetic File event.
- Produce real trusted authentication failures; cross the configured threshold concurrently; restart delivery workers; send exactly one canonical authorized notification with its pinned execution identity. Test revoked recipient authority and sender lease expiration without impersonation or duplicate public delivery.
- Consume a real authorized recovery receipt and explicitly resume as required by File status. Test lost response, duplicate/concurrent receipt consumption, stale recovery, expiry during recovery and subsequent authentication failure.
- Resolve native routine consent, shared session snapshot pinning and Step 3 silent completion in the main runtime. Review migration privileges, ledger retention and observations for blocked admissions without logging secrets or raw webhook prose.

Until these gates pass on the integrated cloud revision, this delivery is **verified component work only**, not deployed Step 8 acceptance.
