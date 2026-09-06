# Runtime Steps 0–3 acceptance ledger — 2026-09-06

**Steps 0–3 acceptance is complete for the Company41 contract scope below.**
The signed v11 runtime completed an actual usage-limit sponsor handoff on
2026-09-06 at 19:07 UTC. The same run continued on the fallback account, read
the Company File, published progress and final messages, and recorded one
durable result. Both leases were released and both job guests removed.
The [v11 evidence manifest](acceptance/2026-09-06-runtime-v11/MANIFEST.json)
binds 35 witnesses and the unchanged earlier checkpoints. The limitations in
those witnesses remain part of this acceptance.

The [September 5 ledger](RUNTIME-STEPS-0-3-ACCEPTANCE-2026-09-05.md) remains a
historical checkpoint. Its pending deployment and paused-admission statements
no longer describe production. The founder subsequently authorized production
changes, signing, credential diagnostics, and reopening admission.

## Deployed state

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
and timestamps. Table filenames refer to the v9 directory unless labeled v10 or v11.

## Acceptance coverage

| Requirement | Evidence and limits |
| --- | --- |
| Step 0: live Company File and authority | Two real managed members and one native agent exercised private, exact and subtree ACLs; disjoint writes, stale CAS, reviewed publication, source-grant revocation and attribution passed. The temporary member was removed, logged out and banned; grants were revoked and history retained. `TWO-MEMBER-ONE-AGENT-PATH-PROOF.json`. |
| Step 0: organization substrate | Versioned organization, responsibility, project, measure, lifecycle and scope SQL passed migration tests. Actual reviewed member commands created and retired responsibility definitions; an actual hire produced the native first-run. Formation research, workers and later projections retain their contract placement in Orders 5–10. |
| Step 1: model loop and mouth | Native human execution, grounded reads, explicit no-change completion, live mutations and canonical send publication passed. Room execution preserves silence and bounded sends. Missing optional telemetry is identified in each proof; exact native output hashes establish the stated boundary outcomes. |
| Steps 1 and 3: usage-limit notification and handoff | **Passed live on v11.** A real native-adapter usage limit caused a control-plane handoff and founder notification; the same run completed on the other account from fresh canonical context. The existing usage-limit notification was deduplicated. Two nonoverlapping attempts, zero dispatch failures, one file read, progress/final sends, one durable result and complete lease/guest cleanup. V11: `NATIVE-V11-HANDOFF-PROOF.json`, `ACTUAL-ATTEMPT-ISOLATION.json`. |
| Steps 1 and 3: handoff capacity | Isolated regressions prove full-candidate skipping, capacity consumed after selection, rejection before lease/history mutation, retry after release, exact replay, unavailable fallback and inactive authorization. Separate rate-limit/outage cases do not hand off. Production readback confirms both checks and unchanged function owners/ACLs. V10: `HANDOFF-CAPACITY-RED-GREEN-PROOF.json`, `HANDOFF-CAPACITY-PRODUCTION-PROOF.json`. |
| Step 2: input and effect fences | Injected Company File instructions were ignored; unauthorized, stale and revoked effects were denied. Canary capture/use, rotation, reflection withholding, grant/member/secret revocation, restart and encrypted recovery passed. The secret-wide test proves an in-flight fence; it does not claim the denied call began after revocation. |
| Step 2: nonexposure | Post-v10 scans cover 158 public runtime tables, gateway and orchestrator state, node state and selected release logs, and all 411 Company41 Storage objects. Broker persistent roots and journals retain their historical v9 scan. No connector-credential or unclassified match was found within the declared scopes. Thirteen node matches are classified protected platform credentials. Scope, patterns, hash-based reuse and exclusions: v10 `NONEXPOSURE-V10-SCOPE-MATRIX.json`. |
| Step 3: five wake kinds and silence | The same RuntimeAcceptance staff identity has actual first-run, human, routine, coworker and room executions. Silent file-triggered routine, exact replay/deduplication, file self-loop fencing, coworker return-loop fencing, room audience publication and send ceilings passed. The final 135-migration context driver also passes all five real SQL producers through the native context adapter. |
| Step 3: responsibility routing | On v9, two contributions coalesced into one Co-Founder wake; exact replay reused its receipt. The recipient paged both contributions, read the correct source version and resolved silently. Member routing produced no agent wake; self-routing was causally fenced. All three temporary definitions are retired; the original four remain unchanged and no escalation queue is open. `RESPONSIBILITY-ROUTING-V9-PROOF.json`. |
| Step 3: company controls | A live write committed before founder stop; the next read begun after pause returned unconfirmed in 248 ms and no additional write committed. New admission failed with SQLSTATE `55000` and created no input/request. The wake ceiling cancelled the excess occurrence before recipient execution and notified the founder. Pause and normal ceilings were restored; temporary resource and grant are revoked. The underlying SQL error for the paused read was not captured. `FOUNDER-CONTROLS-V9-PROOF.json`. |
| Operational recovery | Deliberately killing a real admitted runner during startup caused poweroff and guest deletion without restart; a subsequent admitted run succeeded. The accepted-claim retry loop was contained by guarded backend termination. The v9 correction preserves successful release/replay and denies stale operations without serialization replay. |

## Validation and scope

The deployed source passed full repository checks, the 135-migration
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

There is no remaining live gate for the stated Steps 0–3 acceptance. Separate
negative rate-limit, outage, full-capacity and unavailable-fallback cases pass.
No production usage signal was fabricated and no quota was deliberately exhausted.

The NAS is reachable at `SynologyNAS.local` / `192.168.0.90`; the previously
recorded `.91` address was stale. The physical NAS mount was not changed. The
separate loopback recovery mount was repaired as described above; neither the
missing mount nor the model failure is attributed to the Synology power outage.
The earlier nonexposure scans retain their original timestamps and are not
claimed to cover this later login or handoff. This ledger does not accept Orders 4–10,
production connector breadth, or deferred Azure overflow.
