# Runtime Step 3: wake bus integration handoff

Status: component implementation for integration review. This is not deployed
cloud acceptance, complete room support, or approval of the Step-2 baseline.
No production deployment, infrastructure changes, commits, or provider calls
were performed.

## Revision 4

This revision addresses the reassessment findings with a forward migration:
`20260828020500_runtime_wake_policy_admission.sql`. Omitted immutable routine
`replyPolicy` now requires a final report. Only explicit `optional` or `silent`
reporting permits zero public sends. Required-report occurrences cannot pin a
missing or ineligible public session. File-event candidates with that missing
audience receive a private denied claim; they cannot stall the revision drain.
Historical occurrences with an unsatisfiable public obligation are fenced
before materialization and context delivery without rebinding their identity.

The component negative-path test no longer assumes that a human final before
acknowledgement is admitted. Strict send-admission rejection remains a separate
acceptance requirement. Verification now checks actual SQL envelopes through
the TypeScript parser and exercises concurrent and interrupted coworker delivery.
Integration mode replays the component and recovery checks after the integration
migrations, rather than testing only the earlier component schema.

The scheduler review also found that one rejected enqueue could abort the
whole poll. Schedule failures now remain observable while being isolated from
other triggers and subsequent control-plane work. Existing missed-slot and
catch-up behavior is retained; an unadmitted schedule slot is not promised
indefinite replay.

The public helper signatures, policy/envelope schemas, native binding and
receipt schema are unchanged. The new audience helper is private. No shared
security or native-runner implementation is changed to make acceptance pass.
**Successful zero-send routine completion and five live wake entrypoints remain
acceptance gates**, not claims made by the component checks.

The v1, v2 and v3 exports remain unchanged. The v3 implementation tree is
`868e7ec8ae10ea4e49030bb25d249dc9e65d8dff`; its full patch SHA-256 is
`75f4d198839fd141769ceae198ed60bfce29ba76caaea552214a2cb5ef749ff6`.
This export contains `runtime-step3.patch` against the same Step-2 baseline
and `runtime-step3-from-v3.patch` against v3. Apply only the matching patch,
after `git apply --check` and hash verification. Review a partial previous
import per file; do not force either patch over it.

Migration `20000` is byte-for-byte unchanged from v3. Apply `20000` then `20500`
for a fresh component database; a database already using the v2/v3 `20000`
applies only the new forward migration. Shared enforcement may follow in the
main-owned `21000` migration. Review already-integrated function changes before
applying the forward migration; do not overwrite modifications from another
track. A database using v1 still needs the separately reviewed timezone
backfill correction described by the earlier handoff. All checks here use
fresh disposable databases; no deployed migration or runtime rollout occurred.

## Baseline

- Released Step-1 commit: `a0b692947d5c867353591b36172afcc997f0521e`.
- Frozen development patch: `/tmp/qorpera-step2-gates.tmNEHY/handoff/runtime-step2.patch`.
- Step-2 patch SHA-256: `1d92d0aef8f5a9028cb3752ef97adf1ba828dee637c795d3004fa17a7f71461d`.
- Verified 106-file baseline tree: `3d50211ce71075a86b5328897aea233077eafc49`.
- Task checkout: `/Users/jonas/.codex/worktrees/3c4c/Qorpera_Base-step2/.artifacts/step3-wake-bus`.

The original dirty assigned checkout was preserved. All 106 baseline files
retain their pinned hashes. This patch depends on the existing occurrence,
routine-version, canonical input, sponsor, native run, receipt, path gateway,
read-set, immutable File revision, and runner assignment interfaces.

The separate Step-2 supplement
`/tmp/qorpera-step2-supplement.M0R9uO/runtime-step2-supplement.patch`,
SHA-256 `eaf2b08931fec1254fce99ba4fcc9c14341b07084440c2a70670e9249926e30b`,
is not incorporated here. Integration must apply and verify it separately.
The exported manifest records this patch's hash, exact file hashes, commands,
results, and private Git trees. No Git commit is needed to apply the patch.

## Files

| File | Change |
| --- | --- |
| `supabase/migrations/20260828020000_runtime_wake_bus.sql` | Occurrence identity, policies, queued-input admission, private listener cursors/claims, coworker delivery, authorized envelope, existing materializer replacement. |
| `supabase/migrations/20260828020500_runtime_wake_policy_admission.sql` | Forward correction for required reporting on omitted policy, current public-session eligibility, private File-event denial, and historical occurrence fencing. |
| `packages/shell/src/cloud-wake-bus.ts` | Closed immutable policy/envelope parsers, native binding adapter, coworker tool registration factory, bounded service RPC transport. |
| `packages/runtime/test/cloud-wake-bus.test.ts` | Policy, mouth, identity, post-I/O authority, receipt, native tool boundary and transport tests. |
| `packages/runtime/test/fixtures/wake-policies.json` | Eight exact SQL/TypeScript policy fixtures, including all five kinds and closed fallback. |
| `supabase/tests/300_runtime_wake_bus.test.sql` | Real admission/receipt/path component cases and disposable native fixtures. |
| `supabase/acceptance/runtime_wake_bus.sql` | Actual database completion, send and effect acceptance; missing shared enforcement fails. |
| `scripts/test-runtime-wake-bus.mjs` | Isolated PostgreSQL upgrade, audience contention, concurrent/interrupted delivery, queue and admitted-start recovery; replay against integrated migrations and actual acceptance with JSON reports. |
| `scripts/test-runtime-wake-envelope.mjs` | Actual SQL-produced authority and envelopes checked by the production TypeScript parsers; unsupported room envelopes stay rejected. |
| `packages/runner-orchestrator/src/orchestrator.ts` | Accept the three closed `replyPolicy` values without forwarding job authority; isolate enqueue failures so one denied schedule cannot stop unrelated work. |
| `packages/runner-orchestrator/test/orchestrator.test.ts` | Schedule policy parsing, failure isolation, continued dispatch, and the existing deterministic-key/catch-up rules. |
| This document | Integration contracts, verification and gates. |

No shared native, mouth, completion, Company File security, login, or receipt
implementation was edited. No dependencies or lockfiles changed.

## Policies and delivery

The policy schema is independently pinned as `qorpera.wake-policy/v1`.
The envelope schema is `qorpera.wake-envelope/v1`. Neither is a full runtime
bundle pin.

| Admitted wake | Initial public send | Final public send | Zero sends allowed | Maximum public sends |
| --- | --- | --- | --- | --- |
| Human | Required | Required | No | 64 |
| First run | Required | Required | No | 64 |
| Routine, explicit optional reporting | Optional | Optional | Yes | 64 |
| Routine, required or omitted reporting | Optional | Required | No | 64 |
| Routine, silent reporting | Forbidden | Forbidden | Yes | 0 |
| Agent | Forbidden | Forbidden | Yes | 0 |
| Room, policy branch only | Optional | Optional | Yes | 3 |
| Missing, malformed, unknown or mismatched admission | Required | Required | No | 64 |

An initial acknowledgement is a durable canonical `progress` send. Progress
alone never completes a run, even with optional final delivery. Any final send
closes further work. Agent wakes have no approved human audience in this slice;
addressed coworker effects remain possible subject to current authority and
the causal fence. Room admission is explicitly rejected.

For a valid admitted routine, omitted `replyPolicy` retains required final
delivery; it does not grant silence. A malformed value, missing routine
trigger, missing occurrence, or incorrect occurrence/run binding retains the
closed fallback with both acknowledgement and final delivery required. Policy
comes from the immutable admitted occurrence and routine version, never
job/prompt flags.

Required reporting needs an existing open company session for the same
environment, staff identity and current staff version. Room, autonomous, group
and child-session labels are excluded. The trusted selector ignores a supplied
session ID and holds the eligible session while pinning the occurrence.
That lock never waits: contention raises SQLSTATE `55P03`, rolling back the
whole admission/drain transaction without advancing its stored cursor. The
File drain retries the same revision successor. Schedules use the existing
catch-up/coalescing rules: an empty cursor can select a newer slot after a
boundary, and a long gap can coalesce missed slots. Already admitted identity
and dedupe do not change. A busy session is not treated as a missing audience
or denied event.
Missing audience denies a new scheduled occurrence with SQLSTATE `42501`
(`Wake public audience is unavailable`), without an occurrence or sponsor
reservation. File listeners make a private terminal denied claim and advance
their cursor; no candidate metadata enters the execution queue. There is no
automatic replay when a session later appears. Existing pinned occurrences
are not attached to that later session: materialization cancels unusable
historical bindings, and current context delivery rechecks session eligibility.
An explicit optional/silent routine can still have no public session.

Human and typed kickoff inputs are admitted on the existing durable run
`queued` event, after canonical input claims and sponsor reservation in the
same transaction. Every input ID must match the run, session and requester;
partial matches fail. A batch containing human input remains a human wake,
even alongside kickoff input. Duplicate queued events do not create another
occurrence. A first-run occurrence is unique per environment and staff.
Startup assignment content still requires an authorized hire/input producer;
payload flags cannot supply that authority.

## Identity, causality and current authority

`qorpera_wake_occurrences` remains the sole execution queue. Schedule IDs and
keys retain the existing deterministic routine identity. Input identity uses
the stored canonical input. File delivery identity is the immutable revision
`snapshot_id` plus routine/version/trigger. Coworker identity uses the existing
native operation receipt with `coworker:<operationKey>` scoped to the sender run.

The occurrence pins staff/version, requester, sponsor binding/version, logical
computer, session, source, causal root and visited staff IDs. Identity cannot
be updated; attaching its run is one-way. The policy accessor validates the
full occurrence-to-run binding, including source kind/ID, staff version,
sponsor version and session. Unknown historical input runs are not assigned
invented ancestry.

The upgrade backfill handles each occurrence independently, including a pending
occurrence whose routine version already has another materialized run. It
preserves the matching immutable trigger's timezone, defaulting to UTC only
when that trigger has no stored timezone. The forward migration then fences
pending required-report occurrences that have no pinned audience: the existing
materializer cancels them without creating a job, run or sponsor reservation.
It does not attach a later session or change an already bound occurrence.

Every derived wake retains the parent's causal root and visited staff list.
A repeated recipient or a chain already containing 16 agents is fenced.
Unknown or inconsistent parent provenance is fenced, not reset. File changes
inherit the publishing run's ancestry, so message-to-file and file-to-message
cycles cannot create a fresh root. The fence is conservative: it also prevents
potentially useful repeated visits. There is no automatic acknowledgement
exception or new recovery/attempt ledger.

Policy lookup is not authorization. Materialization and native context delivery
recheck current requester membership, staff employment/version, routine/source
state and execution authority. File events require current shared-path read
permission for both the stored requester and recipient staff. Coworker messages
inherit the sender's existing durable Company File read set, and both principals
must be able to read those paths. That set is also rechecked at context delivery.
Prior actors, receipts and resource versions do not authorize recipients.

## Company File listener semantics

Use the existing authorized routine-version writer with exactly one trigger:

```json
{
  "id": "changes",
  "kind": "listener",
  "source": "company-file",
  "path": "projects",
  "match": "subtree",
  "timeZone": "Europe/Copenhagen",
  "replyPolicy": "optional"
}
```

`match` supports only `exact` and `subtree`; empty path is allowed only for a
subtree selector. No semantic matching is implemented. A listener cannot also
be a schedule. Existing schedules accept optional `replyPolicy` metadata.

Creation and editing capture the current File head under the same File lock
as governed publication. Activation is future-only. A status-only resume of
the same version also captures the current head and skips the paused interval.
There is no backfill option, timestamp watermark or UUID commit-order cursor.
The linear successor index on `(environment_id,parent_snapshot_id)` enforces
the already agreed single-successor publication contract. The first governed
revision can point to an enrollment baseline with no revision row. A missing
successor before the live head is an error, never a repair/reset branch.

Two new private delivery projections are added:

- `qorpera_company_file_wake_cursors`: one row per immutable listener version,
  with activation/processed heads, active flag and scan fairness timestamp.
- `qorpera_company_file_wake_claims`: terminal admitted, denied or causal-fence
  decision per revision/listener; admitted claims reference the existing queue.

They are not another Company File ledger or execution queue. Direct access is
revoked from public, anon, authenticated and service_role. Denied candidates
never produce a visible occurrence or leak path metadata. Proposed-only
changes do not appear in the committed revision source.

Each drain selects at most `p_limit` active cursors from a partial index before
examining revisions. Each cursor examines at most one indexed successor.
Denied and unmatched candidates consume this bound; old/inactive versions are
outside the scan index. Claim, occurrence and cursor advancement commit
atomically. Unmatched revisions advance without a claim. Fairness timestamps
order listener polling only; they do not identify or order committed events.

## Exact service helper contracts

All externally callable helpers below require the existing service role.
Native helpers additionally require the unmodified live native run binding.
Private policy, ancestry, trigger and projection helpers are not client RPCs.

### Reply policy and guards

```sql
qorpera_runtime_wake_policy(p_run_id uuid) returns jsonb
qorpera_assert_wake_work_allowed(p_run_id uuid) returns void
qorpera_assert_wake_completion(p_run_id uuid) returns void
```

Example explicitly optional routine policy; every response has exactly these fields:

```json
{
  "schema": "qorpera.wake-policy/v1",
  "kind": "routine",
  "initial": "optional",
  "final": "optional",
  "silenceAllowed": true,
  "maxPublicSends": 64
}
```

Fallback has `kind:null`, `initial:"required"`, `final:"required"`,
`silenceAllowed:false`, `maxPublicSends:64`. The fixture JSON contains the
complete matrix. Work/completion guards raise SQLSTATE `55000` when their
obligation is unsatisfied; they do not replace current authority checks.

### Authorized wake context

```sql
qorpera_read_native_wake(p_binding jsonb) returns jsonb
```

Exact File-wake shape below; angle-bracket strings denote IDs, not executable
fixture values:

```json
{
  "schema": "qorpera.wake-envelope/v1",
  "id": "<occurrence UUID>",
  "runId": "<run UUID>",
  "kind": "routine",
  "companyId": "<profile UUID>",
  "environmentId": "<environment UUID>",
  "staffAgentId": "<recipient UUID>",
  "requesterUserId": "<requester UUID>",
  "actorStaffId": "<publishing staff UUID>",
  "actorUserId": "<publishing requester UUID>",
  "audience": { "kind": "company", "sessionId": "<session UUID>" },
  "source": {
    "kind": "company-file",
    "id": "<revision UUID>",
    "occurrenceKey": "file:3:changes:<revision UUID>"
  },
  "policy": {
    "schema": "qorpera.wake-policy/v1",
    "kind": "routine",
    "initial": "optional",
    "final": "optional",
    "silenceAllowed": true,
    "maxPublicSends": 64
  },
  "time": {
    "utc": "2026-08-28T08:00:00.000000Z",
    "local": "2026-08-28T10:00:00.000000",
    "timeZone": "Europe/Copenhagen"
  },
  "pins": {
    "companySnapshotId": "<snapshot UUID>",
    "staffVersion": 1,
    "wakeSchema": "qorpera.wake-envelope/v1",
    "runtimeBundleVersion": null
  },
  "routine": { "id": "<routine UUID>", "version": 3, "intent": "Inspect the changed project." },
  "payload": {
    "eventId": "<revision UUID>",
    "path": "projects/note.md",
    "previousVersion": null,
    "version": "<path version UUID>",
    "operation": "upsert",
    "receiptId": "<publication receipt UUID>",
    "proposalId": null
  },
  "parentRunId": "<publishing run UUID>",
  "causal": { "rootId": "<causal root UUID>", "agentIds": ["<publishing staff UUID>", "<recipient UUID>"] }
}
```

Actor IDs, session and parent may be null when appropriate. `routine` is null
for nonroutine wakes. The other closed payload shapes are
`{"inputIds":["<canonical input UUID>"]}` and
`{"text":"...","senderStaffId":"<UUID>","receiptId":"<UUID>"}`.
Scheduled wakes preserve the existing bounded schedule payload.
File metadata contains no object hashes or direct object URLs.

SQL limits the envelope to 49,152 bytes in PostgreSQL representation. The
transport/parser limits JSON responses to 96 KiB and payload JSON to 16 KiB.
The adapter verifies run/company/environment/staff/requester/session/version,
copies and deeply freezes the result, and rechecks the existing durable read
set after I/O before releasing context. A room envelope is rejected even when
its policy shape is recognized.

### Durable coworker send

```sql
qorpera_send_coworker_message(
  p_binding jsonb,
  p_recipient_staff_id uuid,
  p_operation_key text,
  p_text text
) returns jsonb
```

```json
{
  "schema": "qorpera.coworker-send/v1",
  "runId": "<sender run UUID>",
  "receiptId": "<operation receipt UUID>",
  "occurrenceId": "<recipient occurrence UUID>",
  "recipientStaffId": "<recipient UUID>",
  "status": "queued"
}
```

A causal fence returns the same shape with `occurrenceId:null` and
`status:"causal-fence"`. Keys match `[A-Za-z0-9][A-Za-z0-9._:-]{0,95}`;
nonblank text is at most 4,096 UTF-8 bytes. Receipt completion and occurrence
admission are one SQL transaction. Repeating a completed operation returns its
stored result under current authority; changing its content is rejected with
`23505`. Uncertain receipt state requires reconciliation (`55000`), not a new
message ID or another queue.

### Native coworker tool registration

The cloud adapter exposes these methods on the existing native run:

```ts
read(signal: AbortSignal): Promise<CloudWakeEnvelope>
sendCoworker(message: CloudCoworkerMessage, signal: AbortSignal): Promise<CloudCoworkerReceipt>
coworkerTool(): CloudNativeTool
```

For the existing `runCloudNativeRunToolSession` factory, use the standalone
adapter instead:

```ts
cloudCoworkerMessageTool(
  binding: CloudNativeToolBinding,
  identity: CloudNativeToolIdentity,
  control: CloudWakeControl,
): CloudNativeTool
```

The host closes over its existing binding and wake control, then adds this
tool in its unchanged `tools(identity, operations)` callback. No third run
argument, new run handle or native-session signature change is required.
The focused test factory is checked against that exact existing callback type
and executes through `CloudNativeToolBoundary`. Code that already owns a
`CloudNativeToolRun` can also register `bus.coworkerTool()` there.

The tool is named `send_coworker_message`, has source `runtime`, and
describes the `qorpera.coworker-message/v1` delivery contract. Its closed model
arguments are exactly:

```json
{ "recipientStaffId": "<staff UUID>", "operationKey": "review-note-1", "text": "Please review the note." }
```

The existing session retains the `CloudNativeToolRun` and cancellation signal;
the factory closes over the host's service control. Neither the model nor a
job payload supplies the run binding, company,
requester, sponsor, room or policy. The adapter checks every admitted native
identity field against the boundary context before dispatch, rejects additional
arguments, enforces the UTF-8 byte limit, and canonicalizes the recipient UUID
to match PostgreSQL receipt serialization. It delegates the effect to the same
durable coworker RPC; there is no additional delivery queue or local executor.

The returned receipt uses the boundary's existing `untrusted_data` result
envelope and host provenance. `queued` confirms delivery admission, not that
the recipient has executed. A failed or cancelled request may already have
committed. The existing boundary marks backend failures unconfirmed while
authority remains live; if authority closes, it denies receipt release with
`AUTHORITY_UNAVAILABLE`. Neither outcome proves that the effect did not commit.
It does not leak backend errors or automatically retry. Its call-ID cache is not
durable deduplication: a fresh tool session still sends the same operation key
to the existing operation ledger for reconciliation. Native host registration
and its current wake/work authority checks remain integration work.

The standalone factory freezes copies of its host binding and identity and
rejects mismatched run/job/runner/assignment/lease/compute/provider/harness/model
fields before registration. The existing boundary must still own execution:
it checks live run and context authority before and after tool dispatch. The
SQL coworker RPC independently checks current effect and recipient authority.
The copied identity is provenance, not permission. Shared host wiring remains
an integration action, but no shared interface change is requested.

### Drain and materialization

```sql
qorpera_drain_company_file_wakes(p_limit integer default 32) returns jsonb
qorpera_materialize_wake_execution_runs(p_limit integer default 32) returns jsonb
```

Both accept bounds 1 through 64. Drain returns exactly:

```json
{ "schema": "qorpera.file-wake-drain/v1", "scanned": 2, "examined": 2, "admitted": 1 }
```

Materialization returns the existing array of execution-run JSON objects,
at most `p_limit`, and calls the bounded File drain first. It reuses existing
jobs, sponsor reservation, compute provenance, claims, assignments, leases and
status projection. Revoked recipients are cancelled; quota denial leaves the
occurrence queued without an orphan job/run. Its new job payload is only:

```json
{ "schema": "qorpera.wake-run/v1", "occurrenceId": "<occurrence UUID>" }
```

There is no job prompt or policy authority to consume. The host must read the
authorized envelope.

### Scheduler error isolation

The local `CloudRunnerOrchestratorResult` has one additive optional field:

```ts
reconciliationErrors?: readonly unknown[]
```

`runOnce()` returns the original enqueue errors beside its idle or dispatch
result. The ongoing `run()` loop reports each through its existing `onError`
hook. A failed enqueue stops later dependent slots for that trigger; other
triggers, routine pages, reconcilers, expiry processing and dispatch continue.
Cancellation, schedule-discovery failure and unrelated control-plane errors
retain their existing failure behavior. There is no new HTTP error contract:
the current edge maps missing-audience `42501` to HTTP 401 and lock contention
`55P03` to HTTP 503, without forwarding SQLSTATE.

The deterministic key calculations and bounded catch-up/coalescing rules are
unchanged. Repeating the same slot uses the same key; a later poll may select a
new slot under those existing rules. This does not promise lossless replay of
every unadmitted wall-clock schedule slot.

## Required main-task integration

1. Register `cloudCoworkerMessageTool(binding, identity, wakeControl)` in the
   existing native session's trusted tool factory, using `HttpCloudWakeControl`
   and its existing host binding. The model supplies only recipient/key/text
   for addressed coworker delivery. No shared host/tool registry is changed
   by this patch, and no new native-run factory parameter is needed.
2. Load `read_native_wake` during context composition and retain current
   routine/source/recipient rechecks before subsequent context and effects.
   The policy accessor alone is not permission. Continue existing read-set
   checks before model requests, path effects and canonical sends.
3. Apply `assert_wake_work_allowed` before model-requested tools/effects,
   including path/object operations, native operation start/completion and
   coworker effects. Exclude initial trusted context assembly, the first model
   request and the explicit public send itself.
4. Enforce phase and public-send budget in durable canonical send admission,
   under existing serialization. Required initial acknowledgement precedes
   work; forbidden public output is rejected; final closes subsequent work.
5. Use server-owned policy in both governed completion and the existing final
   send/completion trigger. Call `assert_wake_completion`; local mouth
   `finish(policy.final === "required")` is useful but not sufficient.
   Zero-send success must reach the existing run/job/occurrence terminal
   projection without manufacturing a public final message.
6. Keep envelopes/cues as typed trusted runtime context, not fabricated human
   transcript input. Compose routine intent only for that routine, coworker
   provenance for agent wakes, and the greet/learn versus startup-assignment
   first-run behavior only from an authorized producer.
7. Ship both component migrations, scheduler parser and host integrations
   together after review. The existing orchestrator calls the replaced
   materializer; do not add a second worker, queue or desktop fan-out path.

No further SQL helper signature changes are pending in this slice. The
scheduler accepts closed policy metadata and isolates failed admissions using
the additive local result field above; it does not change native binding or
mouth interfaces. The additive coworker factory does not install itself in a
shared host.

The new database regression advances the File through an authorized prior run,
admits a routine against the new head in the existing conversation, applies a
routine mutation, then attempts final delivery and completion. It reproduces
`qorpera_append_runner_transcript_event` rejecting different session/run snapshot
pins (`40001`). It does not fabricate or null those pins. The transcript fix
remains main-owned and must preserve company/environment/staff identity,
current native/path/wake authority and transcript event/hash checks.

## Verification

Run from the task checkout with Node 24.19.0, npm 11.17.0 and Docker available.
Dependencies were hydrated with `npm ci --ignore-scripts`. The baseline's
ignored model catalog data was copied from the pinned release source and
validated with `npm run check:model-data`; no tracked model, dependency or
lockfile was changed.

Exact commands and working directories:

```sh
# Repository root
npm run check
npm run check:model-data
node scripts/test-runtime-wake-bus.mjs

# Explicit integration acceptance; exits nonzero on this pinned baseline.
node scripts/test-runtime-wake-bus.mjs --integration --report /tmp/qorpera-step3-v4-integration.json

# packages/runtime
node ../../node_modules/vitest/dist/cli.js --run test/cloud-wake-bus.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/cloud-native-tool-boundary.test.ts

# packages/runner-orchestrator
node ../../node_modules/vitest/dist/cli.js --run test/orchestrator.test.ts
```

Component results: `npm run check` and model catalog validation passed;
51 wake tests, 28 native boundary tests and 37 scheduler tests passed. The
PostgreSQL driver passed three historical upgrade checks and fifteen component
groups, including SQL behavior, policy/envelope parity, audience contention,
interruption, concurrent consumers and database restart. The export
manifest and logs record the final commands and output. These totals are not
proof of five live wake entrypoints or successful silent routine completion.
The PostgreSQL harness uses the existing pinned PostgreSQL 17.6 image, no network and no published
ports; its task-owned container and volume are deleted. It applies 81 baseline
migrations, tests upgrade of pending and already bound routine occurrences
including their stored IANA timezone, and proves old required/omitted admissions
without an audience are cancelled under the forward correction. Historical
upgrade checks are reported separately from current component checks.

After applying both component migrations, it runs the SQL cases, exact policy
fixtures and eight SQL-produced envelope/authority scenarios through the actual
TypeScript parsers. It sends concurrent coworker messages with the same key,
terminates a sender transaction before commit, and verifies receipt/occurrence
rollback and stable-key replay. A held audience row must raise `55P03` before a
two-second deadline, retain the whole cursor and leave no claim; releasing that
lock then admits the same event exactly once.

Controlled File-lock barriers test publication before listener creation and
publication after a listener edit. They prove future-only activation and one
delivery to the new version. Six more cases commit recipient or path revocation
while a contender waits at drain, materialization or context delivery. Context
is read successfully through a real native lease before revocation and is
denied after the committed change. Lock observation and SQL waits have explicit
deadlines; no security helper is substituted.

The driver also interrupts drains and materialization, runs concurrent
consumers, and restarts PostgreSQL before replaying a receipt and recovering
queued work. A second restart occurs after a real native lease and durable
native-start admission. Terminalization preserves the occurrence/run identity,
releases native authority and records one reconciliation requirement, even
when invoked twice. It does not restart the admitted attempt. This verifies
database recovery of admitted execution state, not a running provider process
or a deployed worker.

Focused coverage includes all five policy branches; zero-send acceptance by the
routine mouth and SQL completion guard; required acknowledgement; first-run
acknowledgement/final sequencing; omitted/required/silent routine reporting and
the send budget backstop; required-report audience rejection and cancellation;
progress without final rejection; duplicate input/event/message delivery; mixed
and partially bound inputs; sponsor denial without occurrence; full policy/run
binding mismatches; direct and cross-source causal cycles; revoked staff,
requester and path access; private audiences; future-only listener edits;
bounded denied candidate scanning; upgrade, interruption and restart recovery.
The timezone regression was observed failing before the backfill fix and passing
after it. Adapter cases additionally cover every native identity field, injected
authority, UTF-8 bounds, canonical UUID receipt matching, closed runs, receipt
fencing, uncertain outcomes and stable keys across tool sessions. Only the real
PostgreSQL driver is evidence of durable recovery; mocked adapter calls are not.

### Disposable clone correction

The final restart rerun exposed a failure in the pinned PostgreSQL fixture:
after a default `WAL_LOG` database clone, committed event IDs 110 through 113
survived restart while their identity sequence reverted from 114 to 109.
The next materialization therefore failed on duplicate event ID 110. Read-only
diagnostics confirmed a logged sequence, cache size 1, and enabled `fsync`,
`full_page_writes` and `synchronous_commit`. The failure and diagnostics remain
in `reports/sequence-clone-before-correction.json` and its matching log.

This matches the [upstream report](https://www.postgresql.org/message-id/CAEVT6c9mOHUR9N4UPryq%3Dj997Az00SFO3zjgD5-a4R500tDCkA%40mail.gmail.com)
about sequence state copied by `WAL_LOG` template creation. The driver now
explicitly uses `FILE_COPY` only when cloning disposable fixtures; PostgreSQL
documents that this strategy checkpoints around the clone in its
[CREATE DATABASE reference](https://www.postgresql.org/docs/17/sql-createdatabase.html).
No sequence is reset, no checkpoint is added before the tested restart, and no
engine, deployed database or runtime ledger is changed.

All interruption and concurrent recovery assertions remain. Read-only checks
also reject any sequence that falls behind a committed event ID after either
restart. The final reports record the fixture-cloning strategy. Passing these
tests does not certify production `WAL_LOG` cloning or database failover.

### Database integration acceptance

`--integration` clones the clean component database, applies migrations after
`20500` present in the current checkout, and records their names/hashes in the
JSON report. It then replays all current component, parser, concurrency and
recovery checks against that schema before running acceptance. Both component
migration hashes and the separate historical upgrade results are recorded.
This checkout has no shared enforcement migration to apply, so its integration
migration list is empty. No code is imported from another task. Actual
acceptance stays outside automatic component-test discovery because it requires
shared integration. Failed regressions or acceptance cases make this command
exit 1; they are not expected-fail tests counted as passes.

Each case uses the real effect/send/completion functions and terminal ledgers
inside an isolated, rolled-back test transaction. No security helper is
substituted. Routine cases retain their conversation and nonzero transcript
start. Native-start markers and result bodies are explicit disposable fixtures,
not evidence of a provider invocation. Positive completion cases assert the
job, run-event projection, occurrence, result row and released native lease.

The pinned baseline passes seven of fifteen cases: trusted initial context/native start,
human completion and receipt replay, canonical first-run completion with the
explicit input fixture, agent zero-public-send completion, explicit-required and
omitted-policy routine reporting, and optional progress-only rejection followed
by a final report.

It fails these eight acceptance cases:

| Missing integration | Cases | Observed baseline result |
| --- | --- | --- |
| Human acknowledgement before mutation and before final delivery | 2 | Both entrypoints still accept the operation. |
| Final delivery closes further Company File work | 1 | Mutation still succeeds after final. |
| Optional and silent routine zero-send terminal completion | 2 | Completion rejects the absent public final. |
| Silent public-output prohibition and public-send budget at admission | 2 | Canonical send still admits forbidden/excess output. |
| Canonical final after the File head advances and a routine mutates it | 1 | Transcript rejects different session/run snapshot pins. |

These are required source-integration gates, not deployed acceptance. Re-run
the same command after the shared enforcement is incorporated; do not remove
the conversation, alter the policy, synthesize a final send or skip these cases
to make it pass.

| Wake | Component evidence | Still required for product acceptance |
| --- | --- | --- |
| Human | Existing v2 producer, atomic claim/admission, acknowledgement/final policy, duplicate queued delivery and sponsor denial. | Shared host, public-send and completion enforcement with deployed canonical input. |
| First run | Typed kickoff admission, unique identity, mixed-batch obligations, reply sequencing and database completion using explicit native fixtures. | Authorized native hire/startup producer and greet/learn versus assignment context behavior. |
| Routine | Existing queue/materializer, schedules, authorized File listeners, silent completion guards and crash/restart recovery. | Human-owned autonomous consent, shared host enforcement and silent terminal projection in cloud acceptance. |
| Agent | Atomic addressed receipt/occurrence, current audience checks, causal fencing, native tool adapter and database completion without public sends. | Tool registration in the admitted host and deployed sender/recipient execution with current authority. |
| Room | Closed policy branch and explicit rejection of unsupported ingress. | Authoritative versioned membership and atomic cloud fan-out producer; this is not live room support. |

## Remaining acceptance gates

- Shared native context, work/effect, canonical send and both completion
  integrations above remain main-owned and are not claimed as implemented here.
  This includes coworker tool registration and canonical sends after a Company
  File mutation. The new acceptance checks expose the eight failures above.
- Full runtime-bundle admission/host pinning is absent. The envelope explicitly
  returns `runtimeBundleVersion:null`; no parallel registry was invented.
- Cloud room membership and atomic fan-out are absent. A versioned human and
  staff membership projection is required; filesystem rooms and
  `execution_scope.roomId` are not authority. Only the closed room policy and
  explicit ingress rejection are verified.
- Native login still defaults `allow_autonomous=false`. No human-owned consent
  version producer/UI exists in the frozen baseline or supplement. Disposable
  tests seed an explicit immutable consent version; this is not live consent
  or proof of product autonomous admission.
- The legacy batch input materializer omits native compute identity. First-run
  and mixed-input component fixtures provide real native provenance,
  reservation, canonical claims and queued event without replacing security
  functions. The unchanged v2 human producer is exercised. Native first-run,
  hire/startup assignment and explicit recovery producers still need acceptance.
- Legacy recovery releases inputs for a new run. Canonical input dedupe is not
  weakened to accommodate that; the main admission/native track must decide the
  authorized recovery/attempt seam.
- Deployed cloud verification must prove these paths with clients closed,
  current authorization revocation, real worker restart and reconnect,
  canonical public output and successful silent terminal completion. No such
  deployed acceptance was performed by this track.

## Integration on the runtime line — 2026-09-02

Integrated by the Fable session on branch `fable/runtime-step3-wake-bus`
(from `codex/steps-0-2-fable-handoff` at `ed3ee9fc4`, the production line
after the Company41 canary). The v4 component (commit `0a4dd6e51`) was
cherry-picked unchanged; everything below is the main-owned integration the
handoff left open.

### What changed

- **Shared enforcement** `20260828021000_runtime_wake_enforcement.sql`
  (generated from the current function bodies, exact replacements):
  canonical send admission applies the wake policy (forbidden phases,
  required acknowledgement before the final report, public-send budget);
  every governed native operation start and every model-requested Company
  File read or list calls `qorpera_assert_wake_work_allowed`; governed
  completion calls `qorpera_assert_wake_completion` and stores a silent
  completion without inventing a transcript event; the job-terminal trigger
  consults the policy; the transcript append accepts a wake run whose pinned
  head follows the conversation's pin through the linear successor chain;
  the envelope reports the run's real audience (`company` or
  `member_private` with its member) and a required-report routine may use
  the open member-private conversation of the member who created it when no
  company conversation exists.
- **Founder decision 2026-09-02** `20260828020700_company_agent_default_read_grant.sql`
  (contract 14.1): staff agents receive a default read grant on the shared
  root at creation, reactivation, genesis and migration; carried forward
  across root versions until revoked; existing companies backfilled.
- **Host**: the governed runtime reads `qorpera_read_native_wake` for every
  run, composes the typed wake and reply policy into the context, registers
  `send_coworker_message`, offers `send_message` only when the policy allows
  public output, and finishes by policy. The path-control allowlists carry
  the wake RPCs. The envelope parser accepts a missing audience member for
  the component-era shape.
- **Bundle**: a new activation migration
  `20260828029900_runtime_bundle_activation_v3.sql` at the end of the chain;
  the shipped v2 activation is untouched. Harness fixtures revoke every
  active grant of the recipient (the default grant is a second row).

### Verification (disposable PostgreSQL 17.6, Docker; Node 24.19.0)

- `node scripts/test-runtime-wake-bus.mjs --integration`: 110 baseline
  migrations plus the five new ones; component, parser, concurrency and
  recovery checks pass in both stages; **all fifteen integration acceptance
  cases pass**, including the eight the handoff reported failing.
- `npm run check` passes (bundle pinned, lint, types, boundaries).
- Focused vitest: wake bus, governed runtime, context composer and path
  control, 132 tests.

### Order 3 scope beyond the handoff — 2026-09-02, same branch

- **Rooms** `20260828022000_runtime_company_rooms.sql`: a room is a canonical
  organization object (`organization/rooms/<roomId>.json`,
  `qorpera.company-room/v1`: key, name, purpose, status, optional project,
  explicit member list of humans and agents, version) projected into
  `qorpera_company_rooms` and `qorpera_company_room_members` by the same
  founder-authorized projection as projects, with the deferred projection
  assertion extended. Each active room owns one group conversation (a shared
  session with `execution_scope.roomId`, no single staff agent, company
  audience). `qorpera_post_company_room_message` lets a human member post:
  one durable input, one room wake per active agent member, sponsored by the
  poster's own binding; the post enters the conversation once at
  materialization; runs carry source kind `room_delivery`, which the
  orchestrator treats as member-initiated (no autonomous consent). The room
  policy (optional/optional, three sends, silence allowed) is enforced by the
  same admission, work and completion seams. Group conversations admit every
  active agent member (actor, context, run audience, transcript pins).
  `qorpera_list_company_rooms` serves clients. The envelope parser, the
  composer's instructions and the fixtures carry the room kind.
- **Wake-rate ceiling and founder stop**
  `20260828023000_runtime_wake_ceiling_founder_stop.sql` (contract 7.4):
  `wakes_per_hour` (default 240) beside spend and tokens; enforced at wake
  admission for routine, agent and room wakes: a wake beyond the ceiling is
  admitted only as a cancelled occurrence with its reason, a `wakes` trip is
  recorded and the founders are notified from the control plane.
  `qorpera_set_company_execution_pause` is the founder stop: no new
  autonomous wakes (cancelled with reason), no new turns or posts (refused at
  request), running work fenced at its next governed effect or read, queued
  wakes wait; resuming lifts it; founders are notified either way. The
  ceiling view reports the wake ceiling, the last hour and the pause.
- **Sponsor handoff** `20260828024000_runtime_sponsor_handoff.sql`
  (contract 17, acceptance 29): when a run's sponsoring connection reports
  `usage_limit` and the attempt produced no governed effect, job failure
  turns into a handoff: a new version of the run's own sponsor binding on
  the next eligible connection of the same principal (same company,
  provider and authentication mode; the run's compute identity for native
  subscriptions; autonomous consent for autonomous runs; no standing usage
  limit), the exhausted attempt's native authority revoked, the job requeued
  as a fresh attempt whose context is rebuilt from the transcript, a durable
  handoff record and run event, and a member notification. The admitted wake
  follows its run to the new version (the identity guard admits exactly that
  recorded move); the earlier launch and lease bindings are kept in history;
  one native start per run and handoff epoch replaces the former
  one-start-per-run index. Rate limits and outages stay retries or failures.
- **Autonomous consent** `20260828025000_runtime_autonomous_consent.sql`
  (contract 16.2): `qorpera_consent_provider_connection_autonomous` lets a
  connection's owner grant or withdraw consent as a new immutable connection
  version; sponsors that allow autonomous work reference it. This is the
  producer the handoff noted as missing for routine admission on a
  subscription.
- Verification: the harness with all runtime migrations passes its
  component, parser, concurrency and recovery checks and **nineteen
  integration acceptance cases** (the fifteen from the handoff plus room
  fan-out with bounded sends and silent completion, the ceiling and the
  stop, the sponsor handoff continuation, and member consent);
  `npm run check` passes.

### Still open for Order 3

- Deployed acceptance on the production node with clients closed: the five
  live entrypoints on Jonas's Company41 computer, a silent routine, one
  Company File event wake without a causal loop, a room post, the ceiling
  and the stop, and a real usage-limit handoff — after candidate 3 is built,
  signed and rolled out with founder approval (production SQL, signing,
  release).
- Client surfaces for rooms, consent, ceilings and the stop are product UX
  over these RPCs; Order 3 proves the machinery, not the screens.

## Candidate 3 rollout and deployed acceptance — 2026-09-02

### Rollout (approved by the founder, "YESYES, approved")

- Source `7b9214d0ce7554e6431befced21d141d617f5864`, runtime bundle `a2d4a529…` (version 3). Guest package
  manifest `ee066697…`, image `f256da2e…` built and verified on `company41-node-01`, signed with the
  `com.qorpera.company41.lxd-image-provenance` key (envelope `2d4f10d3…`), clean-boot evidence `6fe2d1f3…`.
- Production SQL packet v5 (`b4414837…`, frozen `7eeb9367…`): preflight, pause (policy version 5), nine
  migrations `20260828020000` through `20260828029900` (ledger 128 → 137, bundle version 3 active), all
  mutations durable PASS. The packet's final readback reported `STEP_UNCONFIRMED` only because it expected the
  secret-broker role not to log in, which production's re-pointed broker legitimately does; an independent
  read-only verification recorded every other final expectation true, including eight default agent read grants.
- Node activation: provider on the candidate-3 image and provider package `9e8d313f…`, orchestrator package
  updated (`25fc38ad…`), the founder's custody host re-provisioned from the candidate-3 host bundle
  (`c8f23d22…`). Admission reopened (policy version 6).
- Human entrypoint proven live on the new runtime (run `f751833a…`, occurrence `fdf07ec5…` kind `human`):
  acknowledgement before work, `company_read` through the default read grant, `company_write` refused because
  the default grant is read-only (reported by the agent as unconfirmed, head unchanged), final message with the
  marker, occurrence completed.

### Deployed acceptance with clients closed (Company41, the founder acting through a managed magic link)

Operator: `cloud-c3-acceptance.mjs` in the gateway guest (allow-listed member RPCs and the object gateway's
member edit route). Evidence: scratchpad `c3/evidence/deployed-acceptance/` (35 files, `SHA256SUMS`).

| Item | Result |
|---|---|
| Autonomous consent | Connection `2e55091d…` version 2 (`allow_autonomous` true, capsule carried forward); sponsor binding `0c2c8103…` version 1 autonomous |
| Silent routine | Routine `0547f21a…` (5-minute schedule, `replyPolicy: silent`) woke at 12:50:03Z, materialized on the founder's custody host, and the job failed after 13 s: "Native harness returned an invalid private completion receipt" (occurrence `709cc782…` now `requires_review`). Cause below. Routine paused afterwards |
| Company File listener | Routine `aaeb4582…` (listener on `inbox`, subtree, silent) accepted; no file event was raised because the runner gap would have failed its run |
| Room | The founder's room edit through the member route reached the projection with no document text ("Organization document bytes do not match the Company File mutation"); the `organization/rooms` directory was created first (head `7e2ef44c…`). Cause below. Two approved commands expired unapplied |
| Agent wake | Not reachable: `qorpera_configure_staff_execution_authority` refuses because staff carry `model_provider = 'openai-codex'` while every connection carries `provider = 'openai'` (and the Co-Founder has no model at all). A data or contract decision for the founder |
| Wake ceiling | Ceiling set to one wake per hour (version 1); the next routine wake `209f7db4…` was cancelled with "Company wake ceiling tripped" and no run was created |
| Founder stop | Execution paused; the next wake `9581ef91…` was cancelled with "Company execution is paused"; resumed afterwards; ceiling restored to 240 wakes per hour (version 3) |
| Usage-limit handoff | Not reproducible live without exhausting a real subscription; the SQL acceptance case remains the proof |

### Two gaps the offline proof could not reach (fixed on this branch)

1. **Guest runner** (`cloud-native-company-runner.ts`): the private completion receipt was required to carry
   at least one send whenever the run had a session, so a silent wake that correctly sent nothing was refused by
   the runner before the cloud could judge it. Wake runs (`qorpera.wake-run/v1` job payload) now leave reply
   obligations to `qorpera_assert_wake_completion`; conversation turns keep the requirement. Unit test added.
2. **Object gateway** (`member-company-file.ts`): `organization/rooms/<id>.json` was not an organization
   document, so no `p_document_text` reached the projection. Fixed; `scripts/package-object-gateway.mjs` added so
   the gateway ships like the other cloud services. Unit test added.

Commits `6222f663e`, `0ba2d10bc` (runtime bundle version 4 `c6b31877…`, activation migration
`20260828030000`), `3f3829f5a`, `2f609e404`.

### Candidate 3.1 preparation (offline; nothing signed, installed or applied)

- Guest package manifest `ec13e262…` (only `qorpera-ephemeral-runner.mjs` and `qorpera-native-provider-host.mjs`
  changed; provider, orchestrator and broker packages identical to candidate 3). Unsigned image
  `bfb19e81…` built on the node from `lxd-runner-guest-2f609e404.tar.gz` (`a381a177…`) and accepted by the
  clean-boot verify recipe at 13:21:16Z (evidence `f0684fec…`; the same benign host self-probe timeout as
  candidate 3).
- Production SQL packet v6 (`8ec337fc…`, frozen `eb20cee9…`, rehearsed 4/4 in network-isolated PostgreSQL 17
  against the 13:13Z schema dump `369e5648…`): preflight, pause (policy version 7), `20260828030000`, final
  readback; baseline the 13:07Z read-only inventory (137 ledger versions, bundle version 3 active, head
  `7e2ef44c…`). Its final readback expects bundle versions 4 and 3 and no longer requires the secret-broker role
  to be login-less, which is what made the candidate-3 final readback over-strict.
- Object gateway bundle `0e84a094…` and its install script staged under `/opt/qorpera-company41-gateway/staging`
  in the gateway guest. The activation script also corrects `QORPERA_EPHEMERAL_RUNNER_VERSION`, which still
  labelled candidate-3 runners `7c8e69d05-production`.
- Still needs the founder's approval: signing, packet v6 dispatch, node activation, gateway update, custody host
  re-provision (host bundle `d7ed3158…`), then the silent routine, listener, room and ceiling items rerun live.

### Candidate 3.1 rollout — 2026-09-02 16:12–16:29Z (founder: "approved")

- Signed image `bfb19e81…` (envelope `2aa45324…`, clean-boot evidence `f0684fec…`), staged and verified on the node.
- Clients closed at 16:15:58Z (orchestrator guest, provider service and the founder's custody guest stopped; the
  gateway kept serving); the two finished job guests of the earlier acceptance runs deleted; the two expired
  job-guest runners revoked by the administrative drain (readback `qorpera.company41-production-drain-readback/v3`,
  stale runners 0).
- Packet v6 (`8ec337fc…`, window 16:18–18:08Z, four receipts bound): preflight, pause (policy version 7),
  `20260828030000`, final readback — all PASS with one CLI invocation each; ledger 137 → 138, bundle version 4
  `c6b31877…` active, final interfaces matched.
- Node activated on the candidate-3.1 image (provider package unchanged, runner label now
  `2f609e404-production`); orchestrator guest restarted (heartbeat 16:24:20Z); the founder's custody host
  re-provisioned from the new image (`runtimeReady: true`, signed pins unchanged); object gateway bundle
  `0e84a094…` installed and ready; admission reopened at 16:24:01Z (policy version 8).
- Live reruns, all as separate runs on the founder's custody host, all completed, no wake after the last one:

| Item | Result |
|---|---|
| Silent routine | Wake `9ae0b04c…` at 16:25:00Z, run `960d456b…`, job completed 16:25:35Z with no message appended, occurrence completed |
| Company File listener | Routine re-targeted to `notes/` (the `inbox/` layer belongs to a dedicated adapter and refuses member edits). Folder creation and one file write raised wakes `20fbd9ac…` and `25621601…`; both completed silently |
| Room | Room document applied through the updated gateway (head `400f9774…`), group session `15bd6492…` created with the founder and two agents. One founder post produced wakes `4c8e723a…` and `5c1520f7…`, one run per agent, both completed; both agents chose silence as the post allowed, so the room holds exactly the founder's message and no reply loop |
| Sponsor concurrency | While one run held the sponsor's reservation the other wakes stayed queued with "Execution sponsor authority or quota is unavailable" and materialized on later heartbeats |
| Agent wake | Still not configurable: the staff provider label mismatch (`openai-codex` vs `openai`) is unchanged and awaits the founder's decision |

- Housekeeping: the provider leaves finished job guests running; five were deleted after the reruns and seventeen
  stopped ones remain from earlier days. The five-minute silent routine is paused again (version 6); the listener
  routine stays active on `notes/`.
- Evidence: scratchpad `c31/evidence/` (71 files, `SHA256SUMS`), including the packet evidence, receipts, drain,
  reopen, node activation, custody re-provision and gateway install outputs.

## Staff provider label, job-guest teardown and the candidate 3.2 attempt — 2026-09-03

### Staff provider label aligned to `openai` (founder decision: "i'd assume just openai")

The four active staff records carried `model_provider = 'openai-codex'` while every provider connection carries
`provider = 'openai'`, so `qorpera_configure_staff_execution_authority` refused and no coworker wake could be
configured. These rows predate the Company File staff lifecycle (no `source_path`), so neither the member RPC
(guarded once bootstrap has completed) nor the agent-document projection could change them. One reviewed
serializable transaction by the deployment administrator set the label on Software Developer, Financial Officer,
Research Lead and Superman; the primary provider-model sync trigger recorded the new mapping. The Co-Founder and
`that agent` still have no model at all and cannot receive agent wakes.

With the label aligned, the **agent (coworker) entrypoint was proven live**: the Research Lead received execution
authority on the autonomous sponsor, the Co-Founder was asked through a human turn to send one coworker message,
and both runs completed. Occurrence `915070ec…` kind `agent`, source `coworker`, sponsor version 1; the sender
reported a queued receipt and the recipient chose silence. That closes the last unproven Order 3 entrypoint.

### Job-guest teardown (founder decision: "routine work should perhaps just close … set it up how you think it makes the most sense")

Implemented as: a job guest serves exactly one run, so the runner units carry
`ExecStopPost=+/usr/bin/systemctl poweroff --no-block` with `Restart=no`, and the provider deletes a powered-off
guest under a registered or assigned journal, deletes on every stop, and removes guests left behind under stopped
journals. Retained identity and recovery volumes are devices and survive. The conversation itself is never in the
guest: the canonical transcript is in the cloud and the provider session on the identity host, so nothing is lost
when the guest closes.

Three earlier provider builds are **rejected and must not be revived**: `c00b263b3`, `7993748a7` and `0363f7674`
probed the guest's runner unit from the host (`systemctl is-active`, then a unit-journal probe) inside the
provider mutex. They also mis-read a unit that had not started yet as finished, and two live runs died at the
native bridge while they were installed. The self-poweroff design replaces host-side probing entirely.

The seventeen stopped job guests from earlier days and the ten expired job-guest runner registrations were
removed (drain readback `qorpera.company41-production-drain-readback/v4`, stale runners 0).

### Candidate 3.2 rolled out, then rolled back

Source `fd33e05d65b54b4db823c2e05ff579afd7a34962`, runtime bundle v5
`a881b7604cdd49b1da1b7d8ddf7934c2a37b583d67c122f8746ca93c1d47a962`, activation migration `20260828030100`.
Signed image `4fec3348…` (envelope `011672da…`, clean-boot evidence `af5e416d…`), provider package `3a7dc4c5…`,
guest manifest `5d07b087…`. Packet v7 (`b05d6db4…`, frozen `fda7a367…`, rehearsed 4/4) ran all four steps PASS on
production: ledger 138 → 139, bundle version 5 active, final interfaces matched. The node was activated on the
candidate-3.2 image and admission was reopened at policy version 10.

The first live run on candidate 3.2 failed, and so did a run after rolling the node back to candidate 3.1. The
node is therefore back on the **candidate-3.1 runtime** (image `bfb19e81…`, provider `9e8d313f…`, guest manifest
`ec13e262…`, runner label `2f609e404-production`, envelope `2aa45324…`) and **admission is closed** at policy
version 11 with the reason recorded in the policy row.

### The blocker: native runs fail in the guest at the harness-execution stage

Since 07:50Z every native run fails within seconds. The cloud records
`Native provider bridge request failed (422)`; the guest's own native company host records
`Native provider execution harness-execution stage failed (unknown) [mouth=uninitialized]`, meaning the harness
died before any message was produced. The host deliberately never logs the underlying error, because it can carry
credentials.

This is **not** the teardown change: the failure reproduces on two different signed images (`4fec3348…` and
`bfb19e81…`) and two different provider builds (`3a7dc4c5…` and `9e8d313f…`), and the runtime-bundle mismatch is
also eliminated because runs failed while image and cloud bundle matched. No provider usage signal and no sponsor
handoff was recorded. The last successful runs were 07:19:06Z, 07:19:34Z and 07:39:38Z. The leading hypothesis is
the OpenAI Codex subscription behind connection `2e55091d…`, which sits outside the runtime and needs the founder.

Evidence: scratchpad `c32/evidence/` (76 files, `SHA256SUMS` `4d64ee84…`).
