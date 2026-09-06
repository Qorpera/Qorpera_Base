# Runtime Steps 0–3 acceptance ledger — 2026-09-06

The signed v9 runtime is deployed and executing successfully. **Full Steps 0–3
acceptance remains open:** actual provider usage-limit notification and automatic
sponsor handoff have not been demonstrated. Local adapter and SQL tests do not
close that live gate.

The [September 5 ledger](RUNTIME-STEPS-0-3-ACCEPTANCE-2026-09-05.md) remains a
historical checkpoint. Its pending deployment and paused-admission statements
no longer describe production. The founder subsequently authorized production
changes, signing, credential diagnostics, and reopening admission.

## Deployed state

Runtime source: `8424d35c18546cabee8a080a63eb6ab71f5f59f8`.
Active bundle v9:
`c90ab35c33b6af3a3fecbf0f9d1f06210a94a4769746c54c8a3ad94bbd87fab6`.
Image:
`a6c17ca322a4d7f5e533db0bc46ed7d8082c81afd0da197bdd9bb25426510214`.
Guest manifest:
`b02d2d613affd0c6124537bdde58d9c27f22922faca808bf87cd1fe2f63a5948`.

Final readback confirms 149 retained migration records, admission enabled at
policy version 19, founder pause cleared, and the normal 240 wakes/hour ceiling
restored at version 5. There are no active jobs, assignments, native leases, or
job guests. The provider and orchestrator are active; the legacy provider is
inactive. Signature, artifact pins, HTTPS health and source restrictions pass.

The [evidence manifest](acceptance/2026-09-06-runtime-v9/MANIFEST.json) binds 24
bounded summaries and current node/database readbacks. Referenced raw witnesses
remain in the recorded workspace. Older proofs retain their actual bundle
versions; they are not presented as new v9 executions. The filenames below
refer to that evidence directory.

## Acceptance coverage

| Requirement | Evidence and limits |
| --- | --- |
| Step 0: live Company File and authority | Two real managed members and one native agent exercised private, exact and subtree ACLs; disjoint writes, stale CAS, reviewed publication, source-grant revocation and attribution passed. The temporary member was removed, logged out and banned; grants were revoked and history retained. `TWO-MEMBER-ONE-AGENT-PATH-PROOF.json`. |
| Step 0: organization substrate | Versioned organization, responsibility, project, measure, lifecycle and scope SQL passed migration tests. Actual reviewed member commands created and retired responsibility definitions; an actual hire produced the native first-run. Formation research, workers and later projections retain their contract placement in Orders 5–10. |
| Step 1: model loop and mouth | Native human execution, grounded reads, explicit no-change completion, live mutations and canonical send publication passed. Room execution preserves silence and bounded sends. Missing optional telemetry is identified in each proof; exact native output hashes establish the stated boundary outcomes. |
| Steps 1 and 3: usage-limit notification and handoff | **Open.** The current connection executes successfully. Older stored credentials belong to a different account, but its governed probe failed at `codex-turn-completion / provider_failed`, with no sends, result, usage signal or handoff. The underlying cause is unknown. Its temporary sponsor binding is revoked; the current sponsor is unchanged. `SPONSOR-HANDOFF-V9-STATUS.json`. |
| Step 2: input and effect fences | Injected Company File instructions were ignored; unauthorized, stale and revoked effects were denied. Canary capture/use, rotation, reflection withholding, grant/member/secret revocation, restart and encrypted recovery passed. The secret-wide test proves an in-flight fence; it does not claim the denied call began after revocation. |
| Step 2: nonexposure | Final scans cover broker persistent roots and journals, 158 public runtime tables, gateway and orchestrator state, node state and selected release logs, and all 411 Company41 Storage objects. No connector-credential or unclassified match was found. Twelve node matches are explicitly classified protected platform credentials. Scope, patterns, hash-based reuse and exclusions: `NONEXPOSURE-V9-SCOPE-MATRIX.json`. |
| Step 3: five wake kinds and silence | The same RuntimeAcceptance staff identity has actual first-run, human, routine, coworker and room executions. Silent file-triggered routine, exact replay/deduplication, file self-loop fencing, coworker return-loop fencing, room audience publication and send ceilings passed. The final 131-migration context driver also passes all five real SQL producers through the native context adapter. |
| Step 3: responsibility routing | On v9, two contributions coalesced into one Co-Founder wake; exact replay reused its receipt. The recipient paged both contributions, read the correct source version and resolved silently. Member routing produced no agent wake; self-routing was causally fenced. All three temporary definitions are retired; the original four remain unchanged and no escalation queue is open. `RESPONSIBILITY-ROUTING-V9-PROOF.json`. |
| Step 3: company controls | A live write committed before founder stop; the next read begun after pause returned unconfirmed in 248 ms and no additional write committed. New admission failed with SQLSTATE `55000` and created no input/request. The wake ceiling cancelled the excess occurrence before recipient execution and notified the founder. Pause and normal ceilings were restored; temporary resource and grant are revoked. The underlying SQL error for the paused read was not captured. `FOUNDER-CONTROLS-V9-PROOF.json`. |
| Operational recovery | Deliberately killing a real admitted runner during startup caused poweroff and guest deletion without restart; a subsequent admitted run succeeded. The accepted-claim retry loop was contained by guarded backend termination. The v9 correction preserves successful release/replay and denies stale operations without serialization replay. |

## Validation and remaining work

The deployed source passed full repository checks, the 131-migration
context/provenance driver including concurrent responsibility coalescing and
terminal-release regressions, three bundle-generator tests, guest packaging,
and exact Linux x64 reproduction of all 27 package files. The frozen rollout
packet passed 59 controller/transport tests and all five PostgreSQL wrapper
steps. Production activation retained all historical migration records.

To close the remaining live gate, obtain a working eligible fallback connection
through the normal reconnect flow, then observe an actual adapter usage limit,
member notification, same-run sponsor-version handoff and successful continuation
from canonical context. Preserve the separate negative rate-limit/outage cases.
No production usage signal was fabricated and no quota was deliberately exhausted.

The NAS is reachable at `SynologyNAS.local` / `192.168.0.90`; the previously
recorded `.91` address was stale. No NAS mount was changed. The probe failure is
not attributed to the NAS. This ledger does not accept Orders 4–10, production
connector breadth, or deferred Azure overflow.
