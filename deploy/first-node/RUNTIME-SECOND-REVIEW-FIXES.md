# Runtime Steps 0–3 second review corrections

The v13 candidate corrects the three reproduced second-review defects and reconciles five excess production function grants. Deployment and live acceptance must be recorded separately before this document claims production closure.

| Finding | Correction | Verification |
| --- | --- | --- |
| Routine pause or coworker standing-authority changes do not fence effects already admitted | Every native effect, context access, completion and sponsor handoff rechecks the admitted wake. Source-authority locks remain held through the effect transaction; stale snapshots fail closed. | Routine and coworker revocation before and after handoff; denied file writes, coworker deliveries and completion; routine public-send denial; separate-connection pause/effect ordering and repeatable-read rejection. |
| Replacement sponsors invalidate the routine or coworker wake | Resolve standing authority through the run's recorded handoff chain, while retaining the effective sponsor and current consent/capacity checks. Never rewrite original routine, authority or receipt provenance. | All five wake kinds continue confirmed work and replay an immutable receipt exactly once. Routine and coworker runs survive two successive handoffs and remain revocable. |
| Concurrent wake producers exceed the company ceiling | Serialize every wake insertion through a company admission fence, with producer lock ordering and a changed fence revision to reject stale repeatable-read snapshots. | Two independent scheduled admissions compete for the last slot: one queues and one cancels. A stale admission fails serialization. |
| Five production entrypoints have excess grants | A forward migration reinstates the repository's intended authenticated/service callers; in-function authorization checks remain. | Production-schema rollout rehearsal and deployed function/owner/privilege parity are required rollout gates. |

Successive-handoff coverage exposed a related defect: usage signals were deduplicated for the entire run. Signals now deduplicate per run, sponsor version and signal kind, retaining evidence for every exhausted connection and preserving replay within one version.

Startup diagnostics preserve trusted stage/category metadata through the HTTP host. Request timeouts, cancellation, transport failures and malformed responses receive safe classifications. Tests verify that private provider text, response bodies and forged metadata never enter logs. No automatic retry of uncertain effects was introduced. The two historical v12 startup failures have insufficient retained evidence to establish their original cause; this change addresses the diagnostic gap without claiming a retrospective cause.

Local verification: full repository checks; 183 focused TypeScript tests; four bundle/package tests; 46 SQL acceptance cases across all 144 migrations; SQL-to-TypeScript continuation parity; eight separate-connection concurrency schedules. The disposable database has no network or provider credentials and is removed after verification. Synthetic quota signals in these tests are not live provider acceptance.

The signed v12 checkpoint remains unchanged. v13 rollout must preserve the 18 production-only migrations, pause and drain existing work, install a matching immutable signed guest, execute the frozen guarded packet, reconcile deployed privileges, then reopen admission and collect live acceptance.
