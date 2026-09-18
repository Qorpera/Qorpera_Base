# Bundle batching and proposal-review admission

Candidate v14: `01af82981bdd029b9327748743b93686b422cff72890e1da6e8488cd161f28a1`.

The two previously reproduced global claim failures are addressed in
`20260907000858_runtime_bundle_and_review_admission.sql`. The subsequent review
found one remaining P1, so this candidate is **not production-ready**.

## Changes

Ordinary session batches now stop at the first change in author, runtime bundle
ID, or runtime bundle SHA. Inputs retain their original pins and order across
activation and rollback; they are never relabeled to the active bundle. Existing
input count, byte, image, intro-retry, sponsorship ownership, and author-access
boundaries remain in force.

Proposal-review admission now validates the pinned sponsor, current autonomous
consent, and supported runtime before inserting a job. Native harnesses accept
`agent_turn` only, and the governed path runtime has no proposal-review completion
protocol. Such assignments now receive an explicit terminal failure, leaving the
proposal open and creating no incompatible run or reservation. This contains the
SQL failure; it does **not** implement native automated proposal review. There is
no automatic switch to another sponsor or runtime.

Supported API reviews over the whole-tree runtime retain their existing review
and completion path. Managed logical-computer reviews now pin the exact compute
identity and recovery epoch. Unavailable or mismatched authority fails the review
assignment without aborting unrelated claims. Paused reviews remain queued;
contended review admission defers through the existing company stop fence.

## Validation

- Fresh PostgreSQL: 153 migrations and all 46 SQL test files pass. The existing
  named API reviewer test covers broker description, proposal read, decision,
  and publication.
- Queue suite: 21 SQL cases, 8 separate-connection concurrency cases, and 3
  historical-upgrade checks pass.
- Runtime review suite: 71 SQL cases and 13 separate-connection concurrency
  cases pass, including SQL context through the production TypeScript parser
  into the native prompt.
- Bundle generation: 3 tests pass. Focused shell tests: 28 pass.
- Full `npm run check`: passes with no fixes, warnings, or errors.
- Effective catalog: 612 functions; only the two materializer bodies above
  change. Signatures, owners, and ACLs are unchanged. Recorded migration hashes
  match the candidate files.

## Remaining finding: P1 — recovery can still block global claims

The ordinary session materializer resolves a native identity from its active
capsule and inserts a run without first deferring identities fenced for recovery.
The run's recovery-provenance trigger correctly rejects that insert. Because
every orchestrator claim first invokes global reconciliation, the exception
prevents another company's already queued job from being claimed.

The new probe uses actual native-login, key-backup, recovery-target registration,
session-configuration, input-append, and owner recovery-request RPCs. Only public
key shapes and encrypted storage references are disposable fixtures; no native
provider or recovery service is invoked.

- Recovery approved, identity epoch 1, pending recovery present: three real
  claims each fail with `42501: execution identity is fenced for recovery`;
  healthy second-company claims = 0. The blocked input remains pending.
- Otherwise identical active-identity control: all three claim calls succeed;
  the native input is materialized and healthy second-company claims = 1.

The correction should defer ordinary admission under a shared lock on current
identity/recovery authority, preserving pending input and its immutable pins.
The wake materializer uses a similar resolution path and should be included in
that follow-up audit. The recovery guard must remain intact.

## Evidence and scope

Evidence is in the task workspace's
`outputs/bundle-review-admission-fix/`, including `REVIEW.md`, `MANIFEST.json`,
`queue-3.json`, `runtime-review.json`, full logs, the effective function catalog,
and `recovery-review.json` with the diagnostic source and driver. The diagnostic
driver's `passed` flag means the probes executed successfully; the readiness
verdict is separately recorded as not ready.

No production database, signed guest, NAS, provider account, or deployment was
changed. No commit was created. Signed rollout and a live production smoke test
remain unperformed for this candidate.
