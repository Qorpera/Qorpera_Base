# Recovery queue admission

The recovery-related global claim failure is fixed in
`20260907000859_runtime_recovery_queue_admission.sql`. Local regression and
concurrency checks pass. This closes the P1 recorded in
`RUNTIME-BUNDLE-REVIEW-ADMISSION.md`; it is not a production deployment or a
fresh certification of the complete runtime contract.

Candidate v14: `9b93bfaf4b605102273b6514bad8b299362066df8aef556ea0a8948925c2eda3`.

## Cause and correction

Ordinary native input admission resolved its compute identity, then attempted
to create a run while that identity was fenced for recovery. The existing run
insert guard correctly raised `42501`. Global reconciliation propagated that
exception, preventing claims for healthy companies. Sponsored turns and queued
wakes had the same missing preflight.

All three queues now check current identity status and recovery state under a
shared row lock acquired with `NOWAIT`. Recovering or contended identities defer
before job creation. Successful admission retains the lock through commit, and
the existing insert and lease guards still enforce the recovery epoch. The
helper is private; API roles cannot execute it directly.

Wake admission and Company File listener draining now use the existing company
admission fence without waiting behind recovery's profile lock. A contended
listener leaves its durable cursor unchanged. Selection remains bounded, and
serialization errors remain errors rather than being swallowed as deferrals.

Pending inputs, sponsorship selections, and wake identity fields remain intact.
Completed recovery admits each original work item once with the new epoch.
Cancellation and expiry retain the recovery fence, so neither silently resumes
work. No recovery guard was relaxed and no sponsor is substituted.

## Verification

- Fresh PostgreSQL: 154 migrations and all 46 SQL test files pass.
- Queue suite: 37 SQL cases, 8 separate-connection races, and 3 historical
  upgrade checks pass. The new cases cover active, pending, cancelled, expired,
  and completed recovery for ordinary inputs, sponsored turns, and wakes.
- Recovery driver: all 6 separate-connection cases pass. They cover identity
  lock contention, recovery holding profile and identity locks, committed
  recovery, completion, admission preceding recovery, and stale repeatable-read
  claims. A healthy company receives a fresh claim while locks are held and
  while recovery remains pending; claim statements have a five-second timeout.
- Runtime review suite: 71 SQL cases and 13 separate-connection races pass,
  including SQL continuation context through the production TypeScript parser
  into the native prompt.
- Bundle generator: 3 tests pass. Targeted shell tests: 28 pass.
- Full `npm run check`: passes without fixes, warnings, or errors.
- Effective catalog: 613 functions; four existing bodies change and one private
  helper is added. All existing signatures, owners, and ACLs are unchanged.
  All recorded migration and regression-source hashes match the tested files.

Run the added concurrency coverage with
`node scripts/test-runtime-recovery-admission.mjs --report /absolute/path/report.json`.
Use a new report path; the driver refuses to overwrite evidence.

## Evidence and limits

The task workspace contains `outputs/recovery-admission-fix/`, including
`MANIFEST.json`, `queue-3.json`, `concurrency-final.json`, `runtime-review.json`,
the effective catalogs, function diffs, and full command logs. Early failed
fixture-development runs are retained separately; the files named above are
the passing evidence.

The tests use disposable PostgreSQL with networking disabled and real admission,
claim, native-login, sponsorship, and recovery RPCs. Public key shapes, encrypted
storage references, and an empty File projection are fixtures; no external
provider, recovery service, NAS, or production database is exercised. Temporary
containers and volumes were removed.

The previously documented lack of native automated proposal-review completion
remains: unsupported review assignments fail explicitly without creating an
incompatible job. No deployment, signed guest update, or production acceptance
was performed in this fix.
