Third review fixes and source re-review — 7 September 2026

Subsequent SQL review: the broader SQL-suite gate described below is now closed. The current candidate and full cause/fix evidence are recorded in [RUNTIME-SQL-FAILURE-FIXES.md](RUNTIME-SQL-FAILURE-FIXES.md). The remaining text preserves the outcome and bundle identity of this earlier review.

The three findings from review three are fixed in the local v14 candidate. The subsequent review found no further actionable issue in the changed paths. This is a source/test result: production is still on signed v13, and this candidate has not been committed, signed, or deployed.

The candidate bundle is `3263adee97ba59b80d8bfc5035f43a8db8eac9f9ccc041a451249c4a30f63dc5`. The forward migration sequence is `20260907000600` through `20260907000900`; historical activations remain unchanged.

| Finding | Correction | Verification |
| --- | --- | --- |
| Restricted secret broker rejects valid native wakes | A private policy helper shares the existing policy calculation with trusted wake/ancestry validators. The public policy RPC retains its service-role check, and the broker retains exactly three callable custody functions. | The actual broker login authorizes human, first-run, routine, coworker and room wakes. Routine pause, coworker authority replacement, consent withdrawal, founder stop and final output still prevent secret use. |
| Founder stop misses older snapshots | The shared profile fence also locks the existing company admission revision; stop/resume changes that revision. Native validation and direct public sends check pause after acquiring the fence. | Stop waits for a previously admitted effect. An older repeatable-read effect fails serialization. An effect waiting behind stop observes the committed pause. Older snapshots retry after resume, and a fresh effect succeeds. |
| Native monetary sentinel limits concurrency to one | Monetary quota enforcement applies to billing modes other than native subscriptions. The connection concurrency limit and native lease limits remain enforced. | The exact native login policy admits 64 independent wakes and rejects the 65th. The API-billing quota test still refuses admission with spare concurrency and a higher company budget. |

The expanded tests also exposed related gaps: coworker ancestry used the same service-only policy RPC, and the broker did not recheck stop/final-output state after receipt creation. Public sends waiting behind stop also needed an explicit pause check; the original review reproduced the older-snapshot case without establishing this additional read-committed case. These paths are now corrected and covered.

Verification passed: the full repository check; 59 SQL acceptance cases over 148 migrations; 13 separate-connection concurrency checks; continuation SQL → production TypeScript parser → native prompt parity; 22 focused TypeScript tests; three bundle/package tests; and the extended company/API quota component test. All database tests used disposable local PostgreSQL and no native provider or connector request. Test containers were removed.

The source upgrade review checks all 611 existing function owners and ACLs are preserved, exactly the intended ten existing function bodies change, and the only added function is the private policy helper. Its calculation matches the original policy body exactly after extracting the API role guard. The broker's direct function surface remains three. The final review also checked profile/fence lock ordering, stop/resume ordering, negative authorization paths, native concurrency and retained API monetary limits.

The complete historical SQL suite is not green: its first failure, `100_session_arbiter.test.sql` reporting `session event schema is invalid`, reproduces on unchanged v13. A diagnostic continuation through the remaining files reports additional baseline failures, some potentially cascading after earlier failed fixtures. They are not represented as passing production acceptance. The modified quota test also had a stale four-argument function-privilege reference; it now names the current five-argument signature and passes independently.

The earlier signed-v13 acceptance records retain their original scope. Deploying this candidate still requires a matching signed guest, the guarded migration packet, and production verification; the source re-review does not substitute for those rollout gates.
