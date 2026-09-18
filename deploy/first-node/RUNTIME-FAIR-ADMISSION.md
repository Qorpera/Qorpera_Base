# Fair queue admission and production review

The queue-starvation finding is fixed by
`20260907000860_runtime_fair_queue_admission.sql`. Re-review found no new
actionable code blockers in the tested candidate. This is local verification;
production remains on v13 and the candidate has not received fresh deployed
or signed-node acceptance.

Candidate v14: `473052fc6bebba091fc8397eeaa3cb621c5d6d97273bfa586a80ccd832a24056`.

## Cause and correction

Admission selected the oldest 32 candidates repeatedly. When all 32 deferred
for recovery, contention, or unavailable execution authority, healthy work
behind them never reached admission. Successful SQL calls concealed the lack
of progress.

Ordinary session bindings, sponsored requests, wakes, and proposal-review
assignments now have an indexed operational scan position. Each visited entry
moves behind waiting work. The update survives a caught lock conflict, while
a transaction rollback restores it. Candidate limits remain 1–64, with a
default of 32. This gives finite waiting backlogs another opportunity on later
scans; it does not promise a wall-clock completion deadline or provider capacity.

Sponsored admission selects only the earliest eligible queued request in each
session, then rechecks that order under the session lock. Rotation therefore
cannot let a later sponsorship overtake a deferred earlier request. Ordinary
input ordering and homogeneous bundle/author batching remain unchanged.

Company File listeners retain their existing scan timestamp, but now update it
outside the per-cursor contention handler. Their processed heads, event claims,
and emitted wakes remain atomic. Wake immutability excludes only the added
operational timestamp; requester, sponsor, bundle, payload, scheduling, and
source identity remain protected.

## Verification

- Fresh PostgreSQL: all 155 migrations and 46 SQL test files pass.
- Queue suite: 53 cases, 8 separate-connection races, and 3 historical upgrade
  checks pass. New cases cover recovering backlogs of 31, 32, and 65 entries;
  scan limits of 1, 32, and 64; exact pending-input and wake preservation;
  sponsored ordering; and actual healthy orchestrator claims.
- The original six 31/32-entry global-claim reproductions now pass with zero
  SQL errors, one healthy claim each, and all recovering work still pending.
  Six further independent transactions preserve the same single healthy claim.
- Fair-admission driver: 8 checks pass, covering upgrade of populated queues,
  unchanged function permissions, private scan metadata, all four queues behind
  32 contended entries across independent transactions, rollback, and File
  listener scan progress without changing processed heads.
- Recovery suite: all 6 separate-connection cases pass, including both
  admission/recovery orderings and stale repeatable-read rejection.
- Runtime review: 71 cases and 13 concurrency cases pass, including founder
  stop, withdrawal, sponsor handoff, durable completion, and SQL continuation
  parsing through the native prompt.
- Bundle generator: 3 tests pass. Targeted shell tests: 28 pass.
- Full `npm run check` passes without warnings, errors, or fixes.
- Effective catalog: exactly 6 function bodies change among 613 functions;
  all existing signatures, owners, and ACLs are preserved.

Run the added driver with
`node scripts/test-runtime-fair-admission.mjs --report /absolute/path/report.json`.
It refuses to overwrite a report. Tests use disposable PostgreSQL with network
access disabled; no real provider or recovery service is called.

## Production boundary

The read-only production check at 2026-09-07 04:50:44 UTC reports bundle v13
(`4d988b5f47e6219b2f44bae3cbc0b7363c411738ddfc32774a5d487025d483bb`),
162 migration records through `20260907000500`, and no active jobs, assignments,
or native leases. Native admission is enabled and Company41 is not paused.

Deployment, signed guest rollout, and production acceptance for this candidate
remain outstanding. The previously documented native/path-runtime automated
proposal-review limitation also remains; unsupported assignments fail explicitly
without creating an incompatible job. This review does not certify that missing
completion capability or every clause of runtime contract steps 0–3.

Evidence is in the task workspace under `outputs/fair-admission-fix/`, including
source hashes, full logs, effective-function diffs, and the production readback.
Prior failed fixture-development attempts are retained separately from the
passing reports named in its `MANIFEST.json`.
