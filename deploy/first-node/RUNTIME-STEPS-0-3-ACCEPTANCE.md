# Runtime Steps 0–3 acceptance ledger — 2026-09-07

**The second production review's three defects are closed on signed v13.**
Current runtime source is `0ed9e490feebd6d602ffb5f4b7c83471cec15657`;
bundle v13 is `4d988b5f47e6219b2f44bae3cbc0b7363c411738ddfc32774a5d487025d483bb`.
The [second-review corrections](RUNTIME-SECOND-REVIEW-FIXES.md) cover effect-time
standing authority, autonomous sponsor continuation, concurrent wake ceilings,
successive usage signals, startup diagnostics and six privilege differences.
The [v13 manifest](acceptance/2026-09-07-runtime-v13/MANIFEST.json) binds 42 witnesses
and verifies the previous v12 checkpoint unchanged.

Live silent routine `5971ddfd-a4d7-405c-95bd-714b606d9270` completed at 00:25 UTC
after a real usage limit and sponsor handoff. The original routine's standing
sponsor remained version 1 while effective execution advanced to version 2.
It read one Company File, recorded one durable result and sent no public
messages. Both leases and guests were cleaned up without overlap. There were
two attempts and zero dispatch failures. The temporary routine is paused.
Canonical continuation bytes/hash are independently verified; the requested
read correlates with a successful span but exact arguments were not retained.

Current signed image: `1026b6a5185d047e713b447f1e2d1965069902b291eef55d1a5edf3cfcbf0ee7`.
Guest manifest: `ed4a263159da74c661d21324e1f43df2518f60d73a71dcec6c65a36389a0c49f`.
Final readback at 00:27 UTC confirms 162 migration records, including all 18
production-only records; policy 27 enabled; founder pause cleared; normal
ceiling version 5; and no active jobs, assignments, leases, escalations or job
guests. All 26 checked function bodies, owners and privileges match source.
Signature, provider/orchestrator health and source restrictions pass.

v13 passed full repository checks, 183 focused TypeScript tests, four bundle
and package tests, 46 SQL cases over 144 migrations, eight separate-connection
concurrency schedules, SQL-to-TypeScript context parity and exact Linux package
reproduction. The frozen rollout passed 62 tests and all eight wrapper steps.
Historical startup failures, incomplete native-result-fence telemetry, earlier
scan scopes and physical NAS recovery limits remain explicitly preserved.

## Historical v12 checkpoint

**The three Steps 0–3 production review findings are closed on signed v12.**
The v12 runtime source is `53e8fd0efc0c639cf96802e72fafacdf50ebe8d6`;
bundle v12 is `229ceb4522bbaad4a6dcf38d69b9cb6e1b93f394ddd405be6f250e90941da6e7`.
The [v12 evidence manifest](acceptance/2026-09-06-runtime-v12/MANIFEST.json)
binds 35 witnesses for the corrections, rollout, live checks and retained failed
canaries. The [corrections report](RUNTIME-PRODUCTION-REVIEW-FIXES.md) describes
the consent, lease lifecycle and receipt-aware continuation fixes.

Live run `dca1a05e-6de1-44bc-bc72-23437d8ad68a` completed at 20:34 UTC after
an actual usage limit and sponsor handoff. The replacement attempt read the
202-byte canonical continuation with its exact hash, read the evidence file
once, published two progress messages and one final, and recorded one durable
result. Both leases were released; the first guest was removed before the
second was created, and both are now removed. One dispatch failure recovered
automatically. The company default sponsor was unchanged.

Actual owner consent withdrawal and re-consent denied the old connection
version both times; a fresh version 4 sponsor was accepted. Consent is restored.
Completed effects before quota, including a file write and coworker delivery
without duplication, are proved by isolated SQL regressions. The real provider
limit occurred before any effect. Three earlier v12 canaries failed acceptance;
two failed during startup without an established root cause. Their evidence is
retained. This closes the reviewed defects and does not certify general
availability, disaster recovery or product launch readiness.

The [September 5 ledger](RUNTIME-STEPS-0-3-ACCEPTANCE-2026-09-05.md) remains a
historical checkpoint. Its pending deployment and paused-admission statements
no longer describe production. The founder subsequently authorized production
changes, signing, credential diagnostics, and reopening admission.

## Historical v12 deployed state

Signed image: `6dd05d71f82db5cfaa5440389fb2b21753fea6d5efb3cbfa142e0b53f7f86f91`.
Guest manifest: `bf249d12e0f91fd9a6f1128da95de650dd55406a50e7ab3191981308d27d58d5`.
The provider remains at source `bf08dd923d61ba8432d86559a71cf473ac72f9b9` and
artifact `15f8cdb8812bde6192bc7d6dd40463dec76ccbf58fb08a439d2d1390375a3ad0`.
Final readback at 20:34 UTC confirms 157 migration records, policy 25 enabled,
founder pause cleared, the normal version 5 ceiling and no active jobs,
assignments, leases, escalations or job guests. Signature, artifact hashes,
provider/orchestrator health and source restrictions pass.

All 16 relevant function definitions, owners and execution privileges match
the isolated source database. Seven pre-existing excess grants were restored
to the checked-in privileges in one separately guarded and rehearsed repair;
no function body or migration record changed in that operation. The original
v11 journals and historical evidence remain unchanged.

## Historical v11 checkpoint

The following v11 state was accepted at 19:07 UTC before the production review
found additional gaps. It is preserved for provenance and is superseded by
the v12 correction evidence above.

Runtime source: `759e44f36d54e4660159c7c8a378499cdb4e593f`.
Active bundle v11:
`ef0f569327e34673b8cfbd80541864ab116ca688c2eca79beb4bc0f3550e84ad`.
Image:
`346af793885aa7bf879d8774c2e194f02120911bd951d8b25a93a6b60ae90b8d`.
Guest manifest:
`44a914f84019e5623fc01714488c5987989f26fef272b457ed999aff2d0cab55`.
Provider source: `bf08dd923d61ba8432d86559a71cf473ac72f9b9`;
artifact `15f8cdb8812bde6192bc7d6dd40463dec76ccbf58fb08a439d2d1390375a3ad0`.

Final readback confirms 153 retained migration records, admission enabled at
policy version 23, founder pause cleared, and the normal 240 wakes/hour ceiling
at version 5. There are no active jobs, assignments, native leases, open
escalations or job guests. Five old runner registrations were retired through
the founder operation before deployment. The five journals in the previous
v10 configuration directory retain their exact hashes; earlier directories
remain preserved. The provider and orchestrator are active; the legacy provider
is inactive. Signature, artifact pins, HTTPS health and source restrictions pass.

Run `94541e40-e197-4f85-bddf-441be0a4766b` received actual native-adapter signal
`b8ed2df4-ab57-4c69-a0bb-ba11c3fc84bd` on Gmail connection `2bd8e0ae…`.
The control plane recorded handoff `a58ea923-1c5e-4391-bac1-5fe89fd208f1`,
advancing member sponsor `d3f2e5d3…` from version 1 to 2 and selecting Qorpera
connection `2e55091d…`. A founder handoff notification was created; the existing
unacknowledged usage-limit notification for the same connection/version was
deduplicated. The company default sponsor remains unchanged.

The continuation used fresh canonical context, a distinct runner, assignment,
credential capsule and recovery volume. The first guest was removed before the
second was created. The second native launch archived the first launch's exact
provenance. It completed after two total attempts with zero dispatch failures,
one successful Company File read, progress/final sends and one durable result.
Native-result-fence telemetry still reports unconfirmed; this proves completed
governed execution, not complete fence telemetry.

Two earlier live attempts exposed defects now fixed. Physical acquisition had
been keyed only by run ID, so a new sponsor's changed authority collided with
the previous immutable journal. The provider now uses stable identities per
attempt and forbids overlapping guests. The next attempt then reached native
launch but hit an unconditional immutable-row trigger. Migration
`20260906000500` permits replacement only for a superseding handoff with an
active matching lease and an exact archived old launch. Other updates and
deletes remain denied. Both failed runs remain terminal with their history
retained. The earlier [capacity correction](RUNTIME-SPONSOR-HANDOFF-CAPACITY.md)
also remains deployed.

## Earlier login and recovery checkpoints

The historical [fallback login checkpoint](acceptance/2026-09-06-runtime-v10-fallback/MANIFEST.json)
records a successful member sign-in and encrypted backup, followed by an
unsuccessful native execution. Connection `2bd8e0ae-fc58-449a-b680-e58ff4784744`
belongs to a different provider account from the working connection. The new
issued tokens initially identified it as Free and used a different email from
the working Pro account. The [account status checkpoint](acceptance/2026-09-06-runtime-v10-account-status/MANIFEST.json)
confirms that both emails match the founder's intended Qorpera/Gmail pair.
The founder subsequently upgraded Gmail to Pro. Both accounts' refreshed token
claims now report Pro and match the intended emails. Gmail still returned an
actual usage limit with no reset timestamp during the successful handoff test;
token plan metadata does not establish available quota or billing state.
Run `b5035896-8561-4756-8e3e-946386780af8` used its new connection version 2 and
failed at `model_turn / provider_failed` in one attempt, before any send or
durable result. Its lease was released and job guest removed. The temporary
login VM is stopped with its volumes retained. The normal company sponsor is
unchanged. Gmail was temporarily disabled after that failed test, then normally
reactivated for the approved Pro retry. Two superseded, unproven old connections
`82d6bc44…` and `053fad17…` are now disabled. Encrypted credentials, consent
versions and sponsor history are retained. Two abandoned expired login sessions
were reconciled to expired status without changing their other fields.

That sign-in exposed a missing identity-recovery NFS mount after restart. The
existing encrypted backup was recovered unchanged, and the existing loopback
NFS mount now has a persistent systemd unit and a recovery-service storage
dependency. Verification used the opened directory's mount ID inside the
service namespace; the service is stable and both storage paths are writable.
A real prepare/backup operation returned the existing ready receipt before
the successful native login. This proves restoration of the configured
`127.0.0.1:/` recovery replica on Azure, not a physical Synology recovery or
an independent physical NAS replica. The earlier secret-keyring recovery
proof remains a separate test.

The [v10 evidence manifest](acceptance/2026-09-06-runtime-v10/MANIFEST.json) binds
26 bounded summaries and node/database readbacks. It also binds the unchanged
[v9 evidence manifest](acceptance/2026-09-06-runtime-v9/MANIFEST.json), whose 24
summaries retain the earlier acceptance coverage. Referenced raw witnesses remain
in the recorded workspace. Earlier proofs retain their actual bundle versions
and timestamps. Table filenames refer to the v9 directory unless labeled v10, v11 or v12.

## Acceptance coverage

| Requirement | Evidence and limits |
| --- | --- |
| Step 0: live Company File and authority | Two real managed members and one native agent exercised private, exact and subtree ACLs; disjoint writes, stale CAS, reviewed publication, source-grant revocation and attribution passed. The temporary member was removed, logged out and banned; grants were revoked and history retained. `TWO-MEMBER-ONE-AGENT-PATH-PROOF.json`. |
| Step 0: organization substrate | Versioned organization, responsibility, project, measure, lifecycle and scope SQL passed migration tests. Actual reviewed member commands created and retired responsibility definitions; an actual hire produced the native first-run. Formation research, workers and later projections retain their contract placement in Orders 5–10. |
| Step 1: model loop and mouth | Native human execution, grounded reads, explicit no-change completion, live mutations and canonical send publication passed. Room execution preserves silence and bounded sends. Missing optional telemetry is identified in each proof; exact native output hashes establish the stated boundary outcomes. |
| Steps 1 and 3: usage-limit notification and handoff | **Passed live on v12.** An actual native usage limit caused handoff and a founder notification. The same run read the exact canonical continuation and one Company File, published progress/final sends and one durable result, with complete lease/guest cleanup. Two nonoverlapping attempts; one recovered dispatch failure. Completed write/coworker replay across the sponsor boundary is separately proved in isolated SQL. V12: `NATIVE-CONTINUATION-PROOF.json`, `REGRESSION-RESULTS.json`, `ACTUAL-ATTEMPT-ISOLATION.json`. |
| Steps 1–3: review authority corrections | Withdrawal fences queued and admitted autonomous authority, including three concurrent transaction schedules. Released/revoked/expired leases cannot revive through replay or overbook capacity. Actual owner withdrawal/re-consent rejects the old pin and accepts a fresh one. V12: `CONSENT-PROOF.json`, `REGRESSION-RESULTS.json`, `FINAL-FUNCTION-PINS.json`. |
| Steps 1 and 3: handoff capacity | Isolated regressions prove full-candidate skipping, capacity consumed after selection, rejection before lease/history mutation, retry after release, exact replay, unavailable fallback and inactive authorization. Separate rate-limit/outage cases do not hand off. Production readback confirms both checks and unchanged function owners/ACLs. V10: `HANDOFF-CAPACITY-RED-GREEN-PROOF.json`, `HANDOFF-CAPACITY-PRODUCTION-PROOF.json`. |
| Step 2: input and effect fences | Injected Company File instructions were ignored; unauthorized, stale and revoked effects were denied. Canary capture/use, rotation, reflection withholding, grant/member/secret revocation, restart and encrypted recovery passed. The secret-wide test proves an in-flight fence; it does not claim the denied call began after revocation. |
| Step 2: nonexposure | Post-v10 scans cover 158 public runtime tables, gateway and orchestrator state, node state and selected release logs, and all 411 Company41 Storage objects. Broker persistent roots and journals retain their historical v9 scan. No connector-credential or unclassified match was found within the declared scopes. Thirteen node matches are classified protected platform credentials. Scope, patterns, hash-based reuse and exclusions: v10 `NONEXPOSURE-V10-SCOPE-MATRIX.json`. |
| Step 3: five wake kinds and silence | The same RuntimeAcceptance staff identity has actual first-run, human, routine, coworker and room executions. Silent file-triggered routine, exact replay/deduplication, file self-loop fencing, coworker return-loop fencing, room audience publication and send ceilings passed. The final 135-migration context driver also passes all five real SQL producers through the native context adapter. |
| Step 3: responsibility routing | On v9, two contributions coalesced into one Co-Founder wake; exact replay reused its receipt. The recipient paged both contributions, read the correct source version and resolved silently. Member routing produced no agent wake; self-routing was causally fenced. All three temporary definitions are retired; the original four remain unchanged and no escalation queue is open. `RESPONSIBILITY-ROUTING-V9-PROOF.json`. |
| Step 3: company controls | A live write committed before founder stop; the next read begun after pause returned unconfirmed in 248 ms and no additional write committed. New admission failed with SQLSTATE `55000` and created no input/request. The wake ceiling cancelled the excess occurrence before recipient execution and notified the founder. Pause and normal ceilings were restored; temporary resource and grant are revoked. The underlying SQL error for the paused read was not captured. `FOUNDER-CONTROLS-V9-PROOF.json`. |
| Operational recovery | Deliberately killing a real admitted runner during startup caused poweroff and guest deletion without restart; a subsequent admitted run succeeded. The accepted-claim retry loop was contained by guarded backend termination. The v9 correction preserves successful release/replay and denies stale operations without serialization replay. |

## Validation and scope

The v12 source passed full repository checks, 139 focused TypeScript
tests, 35 SQL cases over 139 migrations, three real consent concurrency
schedules and actual SQL context through the production TypeScript parser.
The clean Linux x64 package reproduced all 27 files. The signed image passed
clean boot and isolation checks. The frozen rollout passed 61 tests and all
seven PostgreSQL wrapper steps; all 157 production migration records remain.
The ACL repair separately passed exact privileges, denied API access and
replay rejection checks. Final deployment parity covers 16 functions.

The preceding v11 source passed full repository checks, the 135-migration
context/provenance driver including concurrent responsibility coalescing and
terminal-release checks, all 25 wake integration cases including handoff through
the actual v2 native-launch entrypoint, three bundle-generator tests, guest packaging, and
exact Linux x64 reproduction of all 27 package files. The provider correction
passed all 42 targeted tests and Linux reproduction against its clean commit.
The new launch regression failed with SQLSTATE `42501` before the fix and
passed afterward, including update/delete and duplicate-launch denials.
The frozen rollout
packet passed 59 controller/transport tests and all five PostgreSQL wrapper
steps, including mutation replay rejection. Production activation retained all
historical migration records. The signed image passed clean boot and isolation
checks before activation, followed by the successful actual native handoff.
Earlier restart, authority, secret-custody and wake proofs retain their actual
versions and timestamps; they were not all rerun on v11.

The v11 statement that no Steps 0–3 gates remained was too broad: its canary
did not cover the three subsequent review findings. Those findings are now
closed with the v12 evidence and limits above. Separate negative rate-limit,
outage, full-capacity and unavailable-fallback cases pass. No production usage
signal was fabricated and no quota was deliberately exhausted. The retained
startup failures are not claimed to have an established cause or fix.

The NAS was reachable at the earlier checkpoint at `SynologyNAS.local` / `192.168.0.90`; the previously
recorded `.91` address was stale. The physical NAS mount was not changed. The
separate loopback recovery mount was repaired as described above; neither the
missing mount nor the model failure is attributed to the Synology power outage.
The earlier nonexposure scans retain their original timestamps and are not
claimed to cover this later login or handoff. This ledger does not accept Orders 4–10,
production connector breadth, or deferred Azure overflow.
