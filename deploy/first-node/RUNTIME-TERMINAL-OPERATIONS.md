# Terminal runtime operation errors

Releasing a claim already accepted by a runner raised SQLSTATE `40001`.
PostgREST treated that application-state denial as a serialization failure and
retried the same request. A production log sample on 2026-09-06 contained 3,000
such errors in 30 seconds. The release request cannot become valid through
transaction retry.

The v9 migration changes only the error classification to `55000` for missing
claims, accepted claims, and unavailable release assignments. Every release
guard, state transition, permission, and successful replay remains intact.
The migration checks each old statement before replacing the function body.

Responsibility contributions are append-only. A stale contribution count also
cannot become current through transaction retry. The same migration changes
the two stale-count page/resolution denials to `55000`, requiring a fresh read.

The accepted-claim regression reproduced `40001` before the correction and
passes afterward. Tests assert denied releases leave the complete claim,
assignment, job, and event count unchanged. A real disposable admission and
orchestrator claim still release successfully; exact release replay preserves
the resulting claim, job, and events. Responsibility tests retain coalescing,
concurrent contributions, receipt replay, current source checks, and stale-count
rejection before resolution.

The full context-parity database test passed after all 131 migrations, covering
the same agent's five wake kinds through real SQL producers and the native
context adapter. The bundle-generator tests and repository checks passed.
The runtime bundle is `c90ab35c33b6af3a3fecbf0f9d1f06210a94a4769746c54c8a3ad94bbd87fab6`.

The v9 bundle and matching signed guest were deployed on 2026-09-06. The founder
paused admission and active work drained before guarded termination of the exact
retrying backend. The production ledger retains all 149 migration records,
including v8. Independent readback confirms the corrected functions retain
their owners and ACLs and no longer contain the replaced `40001` denials.

Live v9 responsibility acceptance then passed: two contributions and an exact
replay produced one Co-Founder wake; the recipient paged both contributions,
read the correct source version and resolved the queue silently. Member routing
and self-loop fencing also passed. The three temporary definitions were retired.
See the [current acceptance ledger](RUNTIME-STEPS-0-3-ACCEPTANCE.md) and its
bound evidence for the remaining provider handoff gate and exact proof limits.
