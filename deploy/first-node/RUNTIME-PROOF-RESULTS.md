# Runtime proof results

One row per run of a journey from
[RUNTIME-PROOF-JOURNEYS.md](RUNTIME-PROOF-JOURNEYS.md). Newest last. The
evidence column names the raw record in the operator workspace
(`outputs/runtime-proof/`), which holds the run ids, SQL readbacks and the
full live identity.

Tiers are kept apart for the status matrix:
**node** = real Linux nodes, test company A1 (or an observed live event),
driven through the public API → column "actual-node proof".
**deployed** = the installed web app with a real member on a real company →
column "deployed acceptance".

Live identity shorthand: `v106 0dbf36d4` = active bundle 106, sha256
`0dbf36d45ae5…`, activated 2026-09-24 20:59:55Z, backend 344 migrations (last
`20260924234000`), runner image `ba445e02…`, node release 11 on both nodes,
coding image `929e8d07…` at 4 vCPU / 8 GiB.

## Node tier (actual-node proof)

| When (UTC) | Journey | Live identity | Verdict | What happened | Evidence |
| --- | --- | --- | --- | --- | --- |
| 2026-09-25 02:43 | D09 backend outage (observed 01:20:30–01:30:04) | v106 0dbf36d4 | FAIL (recovery gap) | A worker-completion revival (Co-Founder thread `f032b788`, company Qorpera, wake `5918e47b`, run `096ea4c6`) was created at 01:22:06 during the outage, retried dispatch until 01:30:37 (33 s after the backend returned) and then failed for good: "Runner dispatch failed after the final infrastructure attempt: Runner provider request failed (422)". It was never retried after recovery and no member notification was written. The worker's result (coding worker `2d00aefd`) reached the member only because the member asked again at 01:33. Every other wake in the window completed; new work after 01:33 ran normally. | `D09-20260925T0243Z.json` |
| 2026-09-25 02:47 | J04 read-only todo audit (not the race itself) | v106 0dbf36d4 | PASS (no divergence) | 22 live todos (A1 2, company Qorpera 20): every Company File head equals the version the kernel recorded as published; none unpublished. The race is not provoked by this audit; J04 proper waits for v111. | `J04-audit-20260925T0247Z.json` |

## Deployed tier (deployed acceptance)

| When (UTC) | Journey | Live identity | Verdict | What happened | Evidence |
| --- | --- | --- | --- | --- | --- |

## Findings raised by proof runs

| Id | From | Finding | Owner / next step |
| --- | --- | --- | --- |
| P-D09-1 | D09 | A revival (worker completion) that fails dispatch during a backend outage is never retried once the backend is back, and the member is not told. The parent only sees the result if someone wakes it again. Step 5 doc already lists "a revival whose admission is refused … is not retried" as not built; the outage shows it happens in practice. | Coordinator to route (worker/todo sessions); re-test under D04/D09 after a fix |
