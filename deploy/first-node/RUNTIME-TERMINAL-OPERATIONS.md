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

Deployment is pending. This requires the v9 bundle and a matching signed guest;
the v8 activation history must remain intact. An existing backend executing an
old function body may need separate guarded termination after admission is
paused and active work has drained. These local results do not establish live
responsibility routing acceptance.
