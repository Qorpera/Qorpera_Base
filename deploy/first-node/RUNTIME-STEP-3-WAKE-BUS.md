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
| `packages/shell/test/cloud-wake-bus.test.ts` | Policy, mouth, identity, post-I/O authority, receipt, native tool boundary and transport tests. |
| `packages/shell/test/fixtures/wake-policies.json` | Eight exact SQL/TypeScript policy fixtures, including all five kinds and closed fallback. |
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

# packages/shell
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
