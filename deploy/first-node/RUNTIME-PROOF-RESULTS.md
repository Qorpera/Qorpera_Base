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
| 2026-09-25 03:35 | J08 retried member post lands once | v106 0dbf36d4 | PASS | Owner fixture posted to the Research Analyst thread with client input id `3fcb1b3c` three times: the exact replay returned the same input `def2a8bf` and the same single occurrence `3c8c5ce1`; the same id with changed text was refused (`23505 Room input id is bound to different content`). One run `394ea508` (room wake) completed in 11 s; exactly one reply "J08-033505 OK". | `J08-20260925T0335Z.json` |
| 2026-09-25 03:36 | R04 parallel prompts (stress finding 11) | v106 0dbf36d4 | PASS | Three rounds, each posting to Co-Founder, Research Analyst and Ledger within 1.0–2.2 s: 9/9 runs completed (each ~10 s, started within 1 s of each other), each agent replied exactly once with its exact marker, no stuck or duplicate turn. Runs round 1 `c9aff472` `0484c9a4` `9f293e4a`, round 2 `ce4b3827` `506519b3` `a457e423`, round 3 `1b42f0a8` `f08d1307` `7982362c`. The unanswered parallel prompt of 23 Sep did not recur. | `R04-20260925T0338Z.json` |
| 2026-09-25 03:39 | D08a sponsor at its usage limit (launch item 29) | v106 0dbf36d4 | PASS (first live handoff) | Owner fixture posted on sponsor `13f2e314` whose connection `cb29f1d4` is at 100 % of its weekly window. Run `55f862d4`: the native adapter reported `usage_limit` (signal `035106ad`, 03:39:43.7Z); the control plane recorded handoff `d1581ac1` to the same member's connection `6b3d3284` (binding version 1→2, reason `usage_limit`, 03:39:44.5Z); attempt 2 completed at 03:40:08 with the exact reply. The member got two notifications (`provider_usage_limit`, `sponsor_handoff`). First row ever in `qorpera_execution_sponsor_handoffs`. Gap: the notice carries `resetsAt: null` (the member is not told when the limit lifts). Side effect: binding `13f2e314` now points at `6b3d3284` (by design). | `D08a-20260925T0340Z.json` |
| 2026-09-25 02:47 | J04 read-only todo audit (not the race itself) | v106 0dbf36d4 | PASS (no divergence) | 22 live todos (A1 2, company Qorpera 20): every Company File head equals the version the kernel recorded as published; none unpublished. The race is not provoked by this audit; J04 proper waits for v111. | `J04-audit-20260925T0247Z.json` |

## Deployed tier (deployed acceptance)

| When (UTC) | Journey | Live identity | Verdict | What happened | Evidence |
| --- | --- | --- | --- | --- | --- |

## Findings raised by proof runs

| Id | From | Finding | Owner / next step |
| --- | --- | --- | --- |
| P-D09-1 | D09 | A revival (worker completion) that fails dispatch during a backend outage is never retried once the backend is back, and the member is not told. The parent only sees the result if someone wakes it again. Step 5 doc already lists "a revival whose admission is refused … is not retried" as not built; the outage shows it happens in practice. | Coordinator to route (worker/todo sessions); re-test under D04/D09 after a fix |
