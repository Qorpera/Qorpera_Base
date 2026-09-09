# Session queue fixes and production-readiness review

Reviewed 2026-09-07 on `fable/runtime-step3-wake-bus`, based on HEAD
`6286ac52c60444bed3f42757557d316426bbf0b8` with the preserved, uncommitted runtime fixes.
The source candidate passes the reviewed gates. Both reported P1 findings are fixed;
the follow-up review found no remaining blockers in these changes. This is local
candidate validation, not deployed production acceptance.

Candidate bundle: `0019b2a49c8af7cf7c39193ff1a52b89720298761270d9249c18f0ba932f7fab`.

## Fixes

`20260907000857_runtime_session_queue_isolation.sql` replaces four existing functions
and adds the original execution selection to session turn requests.

- **Sponsored input ownership:** both configured-session selectors exclude every
  input referenced by a turn request, regardless of request status. A pending request
  cannot run under the session's automatic publication policy. An approved request
  is materialized once, with its approved sponsor, compute identity and review policy.
- **Removed or demoted authors:** both materializers check current session write
  access and retain a shared membership lock through admission. Stale inputs receive
  a failure reason without producing a run, reservation or wake. Their original
  content and author remain intact. Valid work in another company can still be claimed.
- **Concurrent work and founder pause:** admission uses the existing company wake
  fence. Contended company, session or membership locks defer work using NOWAIT;
  they do not masquerade as revoked authority. Paused inputs remain pending for resume.
  Existing wake identity, publication, sponsor and privacy checks remain enforced.
- **Competing requests and retries:** a new request cannot adopt an input already
  claimed or completed by ordinary execution. Original request parameters are saved
  before sponsorship approval changes execution pins. Replaying that same request
  remains idempotent after approval and materialization; changed parameters still fail.

The retry issue was found while testing the first two fixes. Historical approved
sponsorship requests have no recoverable record of their original placement. They
retain the prior strict comparison against stored approved pins. Pending requests
are backfilled, and new requests preserve their original selection. Upgrade tests
cover this compatibility behavior; no original values are guessed.

## Validation

| Gate | Result |
| --- | --- |
| Fresh hosted database suite | 152 migrations, 46 SQL test files passed |
| New queue regressions | 12 SQL cases passed |
| New queue concurrency | 6 cases using separate PostgreSQL connections passed |
| Existing-data upgrade | 3 checks passed, including legacy replay compatibility |
| Existing runtime production review | 71 SQL cases and 13 concurrency cases passed |
| Continuation projection | Real SQL output passed the production TypeScript parser and prompt composer |
| Focused shell tests | 28 tests in 3 files passed |
| Bundle generation and packaging tests | 3 tests passed |
| Full `npm run check` | Passed; no fixes, warnings or errors |
| Effective function catalog | 612 functions; only the intended 4 bodies changed; no signature, owner or ACL changes |

The review traced request creation, approval, both materializers, reconciliation and
actual orchestrator claims. It covered pending, queued and terminal requests, mixed
ordinary/sponsored inputs, requester removal and demotion, private audiences,
pause/resume, and both orderings of request/admission and removal/admission races.
The previous 45 test files and historical migrations were preserved. Only the
unshipped v14 activation was regenerated alongside the new migration.

The dedicated queue and runtime drivers used disposable PostgreSQL with networking
disabled. No model/provider was invoked. All disposable containers and volumes were
removed. Production, signing state and deployed guests were not changed, and no
commit was created. Deployment and a smoke test of this exact candidate remain the
next production gate; the prior production readback was still v13.

Full evidence, failed fixture-development attempts, effective function diffs and
hashes are retained in the task's `outputs/session-queue-fix-and-review/` directory.
Use `queue-final-2.json`, `runtime-review.json`, `hosted-db.log`, `check-final-2.log`
and `MANIFEST.json` for the final validation record.
