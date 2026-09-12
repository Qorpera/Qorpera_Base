# SQL contention lane closeout — 2026-09-12

Base: `fable/sql-contention-hardening` at `51a0f392e` (clean on entry), in
`/Users/jonas/work/Qorpera_Base/.claude/worktrees/agent-ad52569975e804700`.
Prerequisites remain the three existing commits `aa7c7e4df`, `4d1a8387c`,
`51a0f392e`. No main repo, live SQL, node, NAS or provider was changed.
Root owns integration, freeze, deployment and shared Docker recovery.

## Forward migration

`20260913000200_runtime_conflict_fences_and_lock_order.sql` changes 75 effective
functions using their individually reviewed, SHA256-pinned prior definitions.
CREATE OR REPLACE preserves function identity, ACL, owner and existing settings.
No frozen migration, bundle or activation was rewritten.

- Replace all 92 deliberate `40001` raises in 69 effective functions with
  SQLSTATE `PGRST`, JSON message `{code: "QRC01", message: <original message>,
  details: null, hint: null}`, and DETAIL `{"status":409,"headers":{}}`.
  No exception handler intercepts genuine PostgreSQL serialization failures.
- Keep existing `PT409` unchanged: runtime, shell and object gateway interpret
  that code as a separately bounded Company File head rebuild. Reusing PT409
  for arbitrary version/lease fences would authorize unintended retries.
- Assign and release discover a claim read-only, then lock its job before
  locking the claim. Acceptance authenticates the immutable assignment first,
  then locks job → claim → runner → assignment and rechecks runner session
  validity after the runner lock. Claim state/expiry and assignment replay
  semantics remain checked, including accepted replay.
- Assignment locks and revalidates an active, session-valid target runner before
  its preliminary logical-computer update. An expired runner being retired by
  reconciliation is denied immediately, without waiting on its runner lock.
- Revoke and activation reissue authorize first, lock the observed leased jobs
  in UUID order, then lock the runner. A new lease appearing before that runner
  lock causes QRC01 and rollback, so administration cannot miss it or lock it
  in reverse order. Both paths recheck owner authority under the runner lock.
- Reconciler bulk queued-job/assignment/claim updates select available rows
  with ordered FOR UPDATE SKIP LOCKED before mutation. Existing leased-job
  handling and authority predicates remain. Queued-job candidate selection
  repeats the exact invalidity predicate and locks only the candidate job, so
  healthy queued jobs are not incidentally locked. This is not a claim that all
  possible cross-domain database deadlocks are eliminated.
- GC now ends the attempt if candidates disappear or deletion becomes active
  after its first profile fence. The previous hardening's `continue` retained
  that fence while visiting further profiles, contradicting its one-profile
  bound. Normal unfenced candidate skips still continue.

The legacy `qorpera_claim_runner_job` remains non-executable by service_role
(as before). Its two job-locking selections both use SKIP LOCKED, and its
replay read does not acquire a job lock: it cannot form the waiting job/runner
cycle identified here. Its explicit fence is converted; no old API is reopened.

## Consumer audit

Search covered `packages`, `scripts`, effective public qorpera functions, and
SQL regressions. There were no client-side 40001 branches in cloud-client,
runtime, or runner-orchestrator production sources.

- Shell trail synchronization already recognizes the unchanged sequence-conflict
  message; tests now simulate QRC01. Existing genuine engine40001 fallback is
  retained, without classifying every QRC01 as a sequence conflict.
- Object gateway's existing HTTP500/40001 maps a genuine serialization failure
  to a dependency conflict. HTTP409/QRC01 passes through as a terminal dependency
  conflict and never becomes MemberCompanyHeadConflict. Added a regression.
- Runtime Company File control's closed PT409 matcher likewise refuses QRC01;
  added a regression in the shared shell test. Staff sync fixture messages use
  QRC01 and unchanged original human messages.
- `test-company-path-preconditions.mjs` intentionally inspects historical
  pre-cutover function bodies and was not rewritten. Remaining 40001 fixtures
  exercise genuine engine errors or explicitly verify non-head codes.
- Existing SQL fixture expectations now catch PGRST; new catalog regression
  rejects any future explicit40001 raise/blanket serialization handler and
  verifies the required HTTP envelope headers and closed legacy ACLs.
- Production-review and recovery-admission repeatable-read races retain their
  original40001 assertions: these are real PostgreSQL visibility conflicts,
  not deliberate application raises. An initial overly broad fixture edit was
  caught by the production-review rerun and reverted before final proof.

Custom status mechanism: https://docs.postgrest.org/en/stable/references/errors.html#raise-headers
Actual older PostgREST12.2.3 additionally required DETAIL.headers to exist;
this was caught by the local HTTP proof and corrected before closeout.

## Validation and exact limits

Logs copied to the lane evidence directory by the root handoff patch exporter.
Original logs are `/tmp/qorpera-sql-lane-*` and `/tmp/qorpera-sql-http-*`.

Passed:

- Final `node scripts/test-hosted-db.mjs`: 220 migrations /50 SQL test files
  passed, including GC contention, stale-runner retirement and new361. This
  rerun includes the final HTTP envelope and reconciler candidate predicates.
- `node scripts/test-runtime-contention.mjs` final-v2 log: full220-migration fresh,
  network-disabled PostgreSQL; actual held-job two-session accept/assign/release
  tests prove no later claim/runner/assignment lock is held while waiting;
  revoke/reissue tests prove job holders can acquire runner without deadlock.
  Actual repeatable-read conflicting update returns engine SQLSTATE40001;
  stale renewal returns PGRST/QRC01 with original message and no mutation.
  Both new-lease-before-admin-lock races return QRC01 with no partial retirement;
  assignment to an expired runner does not wait on the reconciler's runner lock.
  This driver precedes only the final narrowing of queued reconciler candidates;
  all lifecycle definitions match the final source.
- `node scripts/test-runtime-office-software.mjs`: baseline/plan/stop CAS,
  install challenge, measured activation, ordinary successor and boot successor,
  capability rotation and stale challenge tests all passed (220 migrations).
- Final complete002 definitions reapplied to the disposable baseline with all
  source guards passing. Final361 catalog test passed after correcting its
  own assertion replacement (`final-catalog-v3.log`).
- Actual HTTP POST through pinned PostgREST12.2.3 digest
  `729bf65c733b73f5b52777f0e4b853f22ed73aa67a22d38269d289779b0a8401`
  invokes the real stale `qorpera_renew_runner_job` via a disposable sequence-
  counting wrapper. Final response: HTTP409, codeQRC01, original message
  `runner job lease is unavailable`; exactly one sequence increment per request.
  Two earlier HTTP attempts exposed PGRST121 (missing DETAIL.headers); fixed.
  No active probe backend remained after the corrected response.
- Shell named tests:70/3 passed. Object gateway named test:71/1 passed.
- Final production-review driver: 220 migrations, 71 admission/effect cases and
  13 concurrency cases passed; disposable container and volume cleanup confirmed.
  These include founder stop/resume, wake ceilings, routine pause, consent
  withdrawal and unchanged genuine repeatable-read serialization errors.
- Final recovery-admission driver: 220 migrations and six concurrency cases
  passed; cleanup confirmed. Recovery fences all three work queues, resumes each
  original item once after completion, and preserves true engine40001 aborts.
- `tsgo --noEmit` passed after supplying the same model-data directory used by
  the main checkout. No dependency installation or lockfile change was needed.
- Biome for the four changed TypeScript tests passed; git diff --check passed.

Still required before accepting/integrating as a release candidate:

1. Run root combined migration ordering tests and full `npm run check` after
   coherent new bundle generation. This
   lane's check stopped at expected stale authorization/runtime-bundle hash.
   No generated file was edited to bypass it. The later isolated tsgo check
   passed. No claim of a passing final full check is made.
2. Source0001 documents per-function25s budgets but PostgreSQL cannot re-arm an
   already started8s statement timer from a function SET. Do not assume those
   declarations alone change the hosted request ceiling. Reassess actual
   contention after removing retry storms before changing live role timeouts.
3. Hosted PostgREST, actual concurrency/load and paused GC cron still need root's
   deployment/readback acceptance. A local v12.2.3 HTTP proof is not live proof.

## Disk incident / recovery

At19:08Z host `/System/Volumes/Data` had149Mi free (100%). Docker metadata became
read-only; two disposable PostgreSQL drivers failed fdatasync and their normal
cleanup failed. Root paused Docker/build writes, freed disk space and restarted
Docker, then authorized bounded sequential reruns. The obsolete lane containers
(no user/production data) were removed during that recovery:
`qorpera-sql-fence-http`, `qorpera-hosted-db-21882-81bcfec3`,
`qorpera-production-review-31049-ac3a3c52`,
`qorpera-recovery-admission-31098-12ab337f`.
No Docker restart or global prune was attempted by this lane.

Changes remain uncommitted for root integration because root explicitly chose
patch delivery and forbade temporary frozen bundle edits for the commit hook.
Temporary dependency and model-data symlinks are excluded from the patch;
no dependency files or installs were changed.
