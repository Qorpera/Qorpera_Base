# Qorpera Runtime Status

**As of:** 2026-09-25 04:30 UTC. Master `0e1ef1238`. Live runtime bundle **v106**.

This file tracks the current status of [the runtime contract](QORPERA-RUNTIME-CONTRACT.md). It lists the requirements in force today for Orders 0–10 and the launch gate. For each requirement it links whatever evidence exists. The contract is still the source of the requirements. Its dated amendments override older text in it. This file changes no requirement and edits no historical record. Where a record is out of date, it is listed in [Out-of-date statements](#out-of-date-statements-in-historical-records) and left unchanged.

## How to read the matrix

Every requirement has four evidence columns, kept separate:

| Column | Counts as evidence | Does not count |
| --- | --- | --- |
| **Source** | Merged on master: PR and merge commit. | Open PRs; branches. |
| **Component tests** | Tests of the master code: SQL tests (run in CI by *Hosted database contract*), TS tests (CI or local), fixture/driver scripts, disposable databases, containers. | Anything described as done but not run. |
| **Real-node proof** | Run on an actual Linux runtime node (node 1 or node 2: LXD, systemd, NAS, real provider), including isolated lanes and backends before they served users (contract §24.1–24.2). | Docker on a Mac, simulated systemd/storage/provider. |
| **Deployed acceptance** | The live bundle on production, through the installed public interfaces (web client, public API, real nodes), in a real company or a test company on production. | Test forks, dry runs, pre-merge proofs. |

Cell vocabulary:

- **current bundle**: accepted on v104–v106, the bundles live since the last cut.
- **earlier bundle**: accepted live on the current backend at an older bundle. Later changes in that area are not covered.
- **historical**: proven only on the earlier production backend (see below). That proof stays valid for what it ran on. It does not certify today's code (§24.4: evidence can be reused only while the code and environment are unchanged).
- **not established**: no evidence was found. This does not mean the behaviour is absent in production. It means nobody has recorded proof of it.
- **withdrawn**: removed by a dated amendment or founder decision. Not a gap.
- **—**: the stage does not apply, or nothing is built yet to prove.
- A real-node cell reading "not established" beside deployed evidence means no separate node-tier record exists. Deployed runs themselves run on the real nodes.
- `RESULTS <id>`: a row of `deploy/first-node/RUNTIME-PROOF-RESULTS.md` on branch `fable/runtime-proof-journeys` (tip `2149dc148`). Its "node tier" runs happen in test company A1, with member posts driven without the web client (REG R1160). They count here as real-node proof, not deployed acceptance.

Evidence references:

- `REG Rnnn`: line *nnn* of the coordinator's bundle registry, `/Users/jonas/Documents/Codex/2026-09-13/take-over-the-qorpera-runtime-work/outputs/BUNDLE-REGISTRY.md`, as read on 2026-09-25 04:20 UTC (1,168 lines). Entries are appended and carry UTC stamps; the stamp identifies the entry if line numbers move. Some "~HH:MMZ" stamps written on 2026-09-22 to 09-24 are really local time. The pause, activation and resume times on the cut lines are exact.
- `OUT/<file>`: a file in the same coordinator outputs folder.
- `REVIEW`: the independent runtime review of 2026-09-25, `/Users/jonas/Documents/Codex/2026-09-25/i-w/outputs/qorpera-runtime-review.md`, with `verification.md` and `evidence/` beside it. It reviewed master `2a5c8f67e` (bundle v106).
- CI runs: [Hosted database contract @72cafa347][ci-db] (391 migrations, 86 SQL tests, pass), [Step 2 LXD contracts @72cafa347][ci-lxd] (pass), [Web client @0e1ef1238][ci-web] (pass). `72cafa347` is the v106 PR head. Its runtime code is identical to the v106 merge `82b34214d` and to today's master (later commits touch only the web client).
- **local only**: no workflow runs the test. Most `packages/shell/test/cloud-*.test.ts` files are in this group. The review ran eight named groups on `2a5c8f67e` and all passed (REVIEW `verification.md`, "Existing focused suites": 471 tests). Other local-only suites cited below have no recorded run on this master. Examples: `cloud-company-path-presence`, `cloud-native-result-fence`, `cloud-native-tool-operations`, `cloud-sidebar-tools`, `cloud-native-company-context`, `cloud-codex-tool-session`.

Two production backends appear in the evidence:

- **Earlier production backend.** The Company41 production of early September, where the v9–v13 ledger ran. It was replaced on 2026-09-18.
- **Current backend.** Proven as the test backend (the V26–V30 records, 2026-09-14 to 09-18), then promoted to production on 2026-09-18. app.qorpera.com moved to it at 23:05 UTC that day (`OUT/CURRENT-SCOPE-AND-CHECKPOINT.md`, "Route A" and the 23:05 UTC section).

V26–V30 records made before the promotion count as real-node proof, not deployed acceptance.

## What is live now

- **Runtime bundle v106.**
  - Digest `0dbf36d45ae53aa647428d04c005b91c7498044b9b9c5161d15c3c9a830f500d`.
  - Active since 2026-09-24 20:59:55.665Z, cut together with v104 and v105 from master `82b34214d`.
  - Companies paused 20:59:39Z, resumed 21:01:28Z (REG R1074–1079).
  - Accepted: v104 and v106 at 21:15Z (REG R1081–1083); v105 on 2026-09-25 01:04Z (REG R1085–1086).
  - `node scripts/generate-cloud-runtime-bundle.mjs --check` on this branch prints the same digest.
- **Runner image** `ba445e02…` with the Codex fence build `a7531592…`. Node release 11 on both nodes (REG R1075–1076).
- **Coding.** Image cut106 `929e8d07…`, executor `926e97c2` (REG R1078). Member coding machines are 4 vCPU / 8 GiB since 2026-09-25 01:56:37Z; proof#10 was opened on one (REG R1114).
- **Master matches live.** The runtime code on master equals the live v106 code. Every commit after `82b34214d` touches only the web client: #293–#298 and #301. #301 changes `packages/cloud-client/src/cloud-routines.ts`, which is not a bundle input (REG R1131). The web client redeploys from master on merge (REG R176).
- **Exact component identities are not held here.** The database, images, provider host, brokers and client build are recorded in the deployment manifest, draft [#307] (`deploy/deployment-manifest/README.md`; the README names where the current manifest lives). This file links acceptance evidence; the manifest says which exact identity each piece of evidence ran on.
  - The manifest's first pass (2026-09-25 03:05Z, staged in the coordinator workspace) lists these live components with no acceptance at their live identity: `node-02-release` (no agent run on node 2 since the cut; coding sessions did run there), `secret-broker-qorpera`, `secret-broker-acceptance`, `object-gateway`, `office-image-test` and `web-client`.
  - It has no recorded identity for `exec-host`, `node-01-observer`, `office-service-test` or `capture-proxy`.
  - The office image and service count as accepted at their live identity because they are unchanged since their last accepted run. That is a different claim from an office journey run on v106.
- **Supabase outage** 2026-09-25, about 01:20:30 to 01:30:04Z. The database was unreachable for every client. It was not caused by Qorpera's workload, and no Postgres restart happened (REG R1090).

## Decisions that are not gaps

These requirements were removed or changed on purpose. Do not report their absence as missing implementation. REVIEW, "Decisions that must not be misreported as missing implementation", covers the first six rows. Its five bullets fold company-owned notebooks into the second. The rest come from later amendments and founder decisions.

| Decision | Where it is written | What it changes |
| --- | --- | --- |
| Responsibility objects, pages, map, measure views and the escalation queue are retired. An agent's responsibilities are its description, and it keeps them alive with routines it creates. | Contract §19 [2026-09-20 amendment](QORPERA-RUNTIME-CONTRACT.md#2026-09-20-amendment-responsibilities-are-the-agents-description); notes in §14.3 and §14.5 | Withdraws §14.3's object model, §14.5 item 2, Order 6 responsibility views, Order 8 responsibility cadences, and the §20 rows about responsibility objects. Launch items 22–25 are read as amended below. Built: [#152], [#161]. The tables were dropped live at the v57 cut (REG R209). |
| No member-private agent conversations. Each agent has one shared thread; a post runs on the posting member's own account (member-bound execution). | [2026-09-17 amendment: agent threads are shared channels](QORPERA-RUNTIME-CONTRACT.md#2026-09-17-amendment-agent-threads-are-shared-channels-bound-by-rooms) | Withdraws §14.2's separate one-to-one Co-Founder conversations and the "separate one-to-one conversations" clause of launch item 20. §4.3's private-to-shared publication rule stays in the kernel but has no conversation surface. |
| Memory is company first: the notebook lives in the Company File under `agents/<id>/memory/`; there is no per-member memory. | §5.4, §15.1, Order 6 row (amended 2026-09-22 and 2026-09-24) | No member shard. Broad company ownership of notebooks is intended, not a privacy regression. |
| Hiring, opening group chats and an agent's own routines need no member approval. | [2026-09-19/20 amendment](QORPERA-RUNTIME-CONTRACT.md#2026-09-1920-amendment-agents-set-themselves-up-hire-and-convene-without-approval), items 1–4 | A *change* to an existing agent or room still goes through a Co-Founder proposal and member approval. |
| No company or run caps; providers enforce their own limits. | §7.4 amendments of 2026-09-24 (v89, v92, v95, v104); §14.6 (v92); §17 "no turn caps" (2026-09-22) | Withdraws the wake-rate, spend, token and machine ceilings and the tripped-ceiling notice. Also withdraws hop, pair and send budgets, turn, deadline and tool-call counts, and the standing counts (32 routines, 64 todos, 4 active workers, 40 sections). The pause is now an operator brake. §7.4 lists what remains: leases, retry limits, per-call size bounds, 50,000 Company File entries, one-day queue expiry. Launch item 30 is read as amended. Consequence: an agent-to-agent loop runs until a member's Stop or the operator pause (REVIEW, same section). |
| Azure backup and overflow come after launch. | §1, §19 "Deferred post-build integration", launch item 31 | Not a gate for Orders 0–10 or launch. |
| A Company File change may wake an agent already earlier in its causal chain; an agent's own write still never wakes itself. | §5.3, Order 3 row, launch item 9 (v95) | Replaces the multi-agent cycle fence. |
| The operator pause replaces the founder stop; a member's Stop ends a run. | §7.4 amendment 2026-09-24 | Launch item 30 now proves the operator pause, not a member-facing company stop. |
| Connections are always shared with every agent. There is no share toggle, and a working connection shows only Disconnect. | Founder decision 2026-09-24 ([Step 7 record](deploy/first-node/RUNTIME-STEP-7-CLOUD-CONNECTORS.md) line 319; [#244]; REG R508). **Not yet written into the contract.** | The kernel unshare path was removed in v88 ([#244]). |
| A Claude subscription is usable for coding sessions only, signed in through Qorpera's cloud login machine. | Founder decision 2026-09-24 (REG R610–613; design `OUT/CLAUDE-CODING-SUBSCRIPTION-DESIGN-20260924.md`). **Not yet written into the contract.** | Not built. Coding runs on Codex today. Launch condition: Anthropic's written confirmation. |
| Fixed routines (`every`, `weekly`, `file_change`) stay. Dynamic routines are added beside them: one scheduled run at a time, after which the agent schedules the next run or concludes. | Founder decision 2026-09-25: REG R1108 for dynamic routines. Jonas confirmed that fixed routines stay the same day (2026-09-25), in his request for this status file; no registry entry records it. **Not yet written into the contract.** | In progress, slot v114 (see [Work in flight](#work-in-flight)). |
| One coding machine per member carries all of that member's sessions. It sleeps when idle and holds no node capacity asleep. It is removed later, and its allocation is released only on a proven delete. | §13.1 and Order 9 row, amended 2026-09-24 | Machine size (4 vCPU / 8 GiB since 2026-09-25) is a policy value, not contract text. |
| Additional Company Computers for one company are later capacity work. | §12, 2026-09-01 amendment placement | Not a gate on Order 4. |
| The failure-model chapter's implementation is deferred until partner testing. | §23, ratified 2026-09-01 | Until then a missing resilience path must be reported as unavailable, never as healthy. |

Other amendments are folded into the per-Order requirements below: first-run sponsor (2026-09-18), multi-node placement (2026-09-16), identity recovery and host reboot (2026-09-17), company browser and kept state (2026-09-17), shared execution service (2026-09-22), routine kickoff and effort (2026-09-22), thread model and effort (2026-09-24), sidebar sections (2026-09-24).

## Contract text that needs a decision, not code

The contract is inconsistent in these places, or behaviour ships that the text forbids. Each needs an amendment or a founder decision. The code alone cannot resolve them.

1. **Company File scale.** §5.5 calls Company File caps defects. The §7.4 amendment keeps "50,000 Company File entries per company". The gateway also keeps a 32 KiB text write, 256 MiB/64-chunk readable storage and an 8 MiB tree manifest (REVIEW `work/authority-review.md`, finding 6). It rebuilds the whole tree on every mutation (REVIEW, "Company File scale"). Decide whether these are accepted bounds or scheduled defects.
2. **Repository credentials.** §11.5 says the broker is the only component that may unwrap a credential. There is "no … service `getSecret`, export". Since v88 ([#244]), the broker returns the company GitHub token to the trusted coding executor (`/v1/repository-credentials`). Either ratify the executor's Git broker as part of the credential boundary, or move Git operations inside the broker (REVIEW, "Decisions that must not be misreported"; `work/authority-review.md` finding 7).
3. **Skills.** §15.2 (catalog, on-demand load, version recorded in the run) is still normative. §3 lists "skill-loading policy" as a bundle part. But the amended Order 6 row covers memory only. Build it, or defer it by amendment.
4. **Worker species.** §13.1 media workers and vendor listener workers are not built and not deferred by any amendment.
5. **Superseded words still in the text.** §20 has rows for responsibility objects and "Ceilings hold without agent cooperation". §12 scales machines "under the kernel-owned spend ceilings". §14.2 names "the responsibility map" and a `responsibility_map` formation stage. §21 items 20 and 22–25 name withdrawn concepts; only items 9 and 30 carry amendment notes in the contract. The §19 "Current implementation checkpoint" still says Order 6 is "not applied live" and Orders 3 and 5 await deployed acceptance. The amendments already govern all of these; this list only names the old text.
6. **Three founder decisions are not yet in the contract:** connections always shared, Claude subscription for coding only, and dynamic routines.

## Orders 0–10: requirements in force and evidence

### Order 0: live Company File, path authority, organization

**Requirement in force:**
- With every client offline, one cloud company stays readable and writable through atomic, versioned path operations.
- Two members and one agent obey exact, private and subtree ACLs.
- Protected paths propose.
- Revocation and stale versions fence effects.
- Receipts keep actor, requester, sponsor and approver.
- One Co-Founder; canonical agent documents; archive is distinct from delete; a default read grant for every agent.
- Agent threads outlive edits: an edit applies from the next run.
- Sidebar sections are company structure.

Governing text: §4, §5.1–5.3, §14.1, the Order 0 row, and the amendments of 2026-09-02 (read grant, in §14.1), 2026-09-17 (threads; edits apply from the next run), 2026-09-20 (responsibility objects retired) and 2026-09-24 (sections).

| Capability | Source | Component tests | Real-node proof | Deployed acceptance |
| --- | --- | --- | --- | --- |
| Versioned path ops, ACLs, proposals, revocation, receipts | Steps 0–4 merged by [#116] (`c31d3d522`); [preconditions](supabase/migrations/20260828019950_company_path_preconditions.sql) | SQL [140](supabase/tests/140_cloud_company_authority.test.sql), [290](supabase/tests/290_company_file_path_gateway.test.sql), [295](supabase/tests/295_member_company_file_commands.test.sql), [345](supabase/tests/345_company_path_admission_errors.test.sql): [CI][ci-db]. TS `cloud-company-path-gateway`, `cloud-company-path-control`: local only | `OUT/V26-TWO-MEMBER-ACCEPTANCE.json` (2026-09-14); `OUT/V28-COMPANY-FILE-TRANSFER-ACCEPTANCE.json` (2026-09-18) | Historical: v9 [two-member/one-agent proof](deploy/first-node/acceptance/2026-09-06-runtime-v9/TWO-MEMBER-ONE-AGENT-PATH-PROOF.json) on the earlier production backend. Current bundle: **not established** as a journey. Gateway writes are exercised by accepted runs, e.g. the v86 notebook write (REG R433) |
| Presence (who is working where; never a lock) | [`cloud-company-path-presence.ts`](packages/runtime/src/cloud-company-path-presence.ts) | TS `cloud-company-path-presence`: local only | not established | not established |
| Co-Founder, agent documents, lifecycle, default read grant | [#116]; [default read grant](supabase/migrations/20260828020700_company_agent_default_read_grant.sql); edits apply next run [#147] (v42) | SQL [310](supabase/tests/310_company_organization_kernel.test.sql), [315](supabase/tests/315_runtime_step0_staff_lifecycle.test.sql), [376](supabase/tests/376_runtime_staff_execution_authority_default.test.sql): [CI][ci-db] | Isolated run: `OUT/TEST-COMPANY-BOOTSTRAP-RESULT.json` (`OUT/RELEASE-ACCEPTANCE-MATRIX.md` row "Step 0") | Agent created by a member: v58 "Mark", first-run wake `b620339a` (REG R214–215). A post to an agent edited since its thread was bound (agent version 26, thread records 24) completed on node 1: v35, 2026-09-20 02:04Z (REG R67). Archive vs delete: **not established** |
| Shared agent threads, member-bound execution | Commit `f41f8904d` (2026-09-17), in [#116] | SQL [300_runtime_wake_bus](supabase/tests/300_runtime_wake_bus.test.sql) (thread routing): [CI][ci-db] | `OUT/V26-AGENT-THREADS-ACCEPTANCE.json` (2026-09-17): two members in one Co-Founder thread, each run on the poster's account | Single member: every accepted thread run, e.g. Co-Founder thread `f032b788` at v103 (REG R1071). Two members at a current bundle: **not established** (skipped 2026-09-18, `OUT/RELEASE-ACCEPTANCE-MATRIX.md` row "two members at the same time") |
| Responsibility objects retired | [#152], [#161]; [migration](supabase/migrations/20260920070000_runtime_retire_responsibility_objects.sql) | SQL 310, rewritten: [CI][ci-db] | — | Withdrawn. Tables dropped live at the v57 cut, 2026-09-22 04:05:05Z, after an export (REG R209) |
| Sidebar sections; agents organize them | [#254] (v90) | SQL [402](supabase/tests/402_company_sidebar_sections.test.sql): [CI][ci-db]. TS `cloud-sidebar-tools`: local only | not established | Accepted at v95, 2026-09-24 15:10–15:15Z: real clicks, and the agent's `organize_sidebar` moved an agent and deleted a section (REG R834) |

Open:
- REVIEW finding 3 (a definite stale version surfaces as an unconfirmed outcome) → [#302] (v108).
- Company File scale, [decision 1](#contract-text-that-needs-a-decision-not-code).

### Order 1: loop and mouth

**Requirement in force:**
- Model input and cloud tools work over an exact Company File read view.
- Only send is visible. Provider thinking and final text never render.
- Completion links a live operation, a proposal or an explicit no-change result.
- The provider's usage-limit signal notifies the member (2026-09-01 placement).
- A conversation's model and effort come from its Model menu (§17, 2026-09-24).
- No cap on turns, tool calls, time or run length (§17 2026-09-22; §7.4 2026-09-24).

Governing text: §6, §7.1–7.3, §17, the Order 1 row.

| Capability | Source | Component tests | Real-node proof | Deployed acceptance |
| --- | --- | --- | --- | --- |
| Mouth, private completion, canonical transcript | [#116]; turn ends at the final send [#191] (v67) | SQL [160](supabase/tests/160_native_subscription_compute_identity.test.sql), [165](supabase/tests/165_cloud_agent_public_mouth_privileges.test.sql), [280](supabase/tests/280_cloud_session_run_control.test.sql), [585](supabase/tests/585_failed_run_acknowledgment.test.sql): [CI][ci-db]. Runner guest and provider tests: [CI][ci-lxd]. TS `cloud-agent-mouth*`, `cloud-native-company-runtime`: local only | `OUT/NATIVE25-ACTUAL-EXECUTION-RESULT.json` (run completed after the client exited); `OUT/V30-RUNTIME-BUNDLE-ACCEPTANCE.json` (2026-09-18). At v106: RESULTS J08 PASS (a retried member post lands once, one run, one reply) and RESULTS R04 PASS (9/9 parallel prompts, each answered exactly once) (REG R1161) | Current bundle: v106 runs `8f94f0c1` (REG R1082) and `b2d7e2dc` (REG R1086). Historical: [Step 1 record](deploy/first-node/RUNTIME-STEP-1.md) lines 538–601, earlier production |
| No turn, call or time caps | [#209] (v66), [#265] (v92), [#273] (v95), [#276] (v104) | SQL [330](supabase/tests/330_company_execution_no_ceilings.test.sql), [332](supabase/tests/332_runtime_no_run_or_machine_caps.test.sql), [333](supabase/tests/333_native_tool_catalog_size.test.sql), [334](supabase/tests/334_native_run_reads_and_requests.test.sql): [CI][ci-db] | Codex fence build `a7531592…` passed its tests on node 2 (REG R996) | v95: one run made 41 tool calls with no deadline (REG R818–827). v104: 148 `company_list` + 9 sends in one turn (REG R1082) |
| Thread model and effort | [#263] (v91) | SQL [580](supabase/tests/580_conversation_model_selection.test.sql): [CI][ci-db] | Pre-merge on the live backend with a temporary row: Sol `d274689f`, Luna `6beea1de` (REG R598–601) | v95: Sol/High `e49d48f7`, Luna/Low `8e1d55a5` (REG R818–827) |
| Usage-limit signal and member notification | [#116] | SQL [583](supabase/tests/583_subscription_recovered_handoff.test.sql), [163](supabase/tests/163_member_session_account_selection.test.sql): [CI][ci-db] | RESULTS D08a PASS at v106, 2026-09-25 03:39Z: the native adapter raised usage-limit signal `035106ad` and the member got the `provider_usage_limit` and `sponsor_handoff` notices. Gap: the notice has `resetsAt: null` (REG R1161) | Historical: v11 [handoff proof](deploy/first-node/acceptance/2026-09-06-runtime-v11/NATIVE-V11-HANDOFF-PROOF.json), earlier production. Current backend, through the installed interfaces: **not established** |

Open: REVIEW's Order 1 row notes that protocol enforcement does not guarantee behavioural success. Behaviour is covered under Order 10.

### Order 2: inbound fences, outbound effect check, secret custody

**Requirement in force:**
- A fake instruction inside a tool or Company File result is ignored.
- An unauthorized, stale, protected or ambiguous write is blocked independently.
- A canary credential survives capture, use, rotation, revocation, response reflection, restart and encrypted recovery without entering any model-visible or company-visible surface.
- Production connectors belong to Order 7.

Governing text: §11, the Order 2 row, and the §19 note on Order 2 versus Order 7.

| Capability | Source | Component tests | Real-node proof | Deployed acceptance |
| --- | --- | --- | --- | --- |
| Result fence and effect check | [#116]; Codex fence patch [#201] (v60), [#276] (v104) | SQL [360](supabase/tests/360_runtime_contention_hardening.test.sql), [361](supabase/tests/361_runtime_conflict_fences.test.sql): [CI][ci-db]. TS `cloud-native-result-fence`, `cloud-native-tool-boundary`, `cloud-native-tool-operations`: local only. Fence Rust tests 12/12 on a Mac (REG R697) | `OUT/V28-STEP2-CUSTODY-ACCEPTANCE.json` (2026-09-18, current backend before promotion, bundle v28) passed three checks: an injected instruction was ignored, a protected write was denied and a stale write was refused. The fence build was also tested on node 2 (REG R996) | Historical: v9 [causal file and input fence proof](deploy/first-node/acceptance/2026-09-06-runtime-v9/CAUSAL-FILE-AND-INPUT-FENCE-PROOF.json) (one bounded injection case), earlier production. Current bundle: the fence carries more than 128 outputs (REG R1082). Injection test at the current bundle: **not established** |
| Secret broker custody | [#116]; per-company routing in [#241] (v87); executor token in [#244] (v88) | SQL [305](supabase/tests/305_cloud_secret_custody.test.sql), [307](supabase/tests/307_cloud_secret_member_authority.test.sql), [398](supabase/tests/398_cloud_secret_broker_company_routing.test.sql): [CI][ci-db]. TS `cloud-secret-broker`, `cloud-secret-broker-http`: [CI][ci-lxd] | `OUT/V28-STEP2-CUSTODY-ACCEPTANCE.json` (2026-09-18, bundle v28). Passed: company-owned capture, normal use, four reflection encodings withheld, lost and stalled responses fail closed, broker restart, rotation and old-key removal, keyring loss and byte-identical restore, grant revoked during a live run, and 0 leaks across backend text, both nodes' journals and node files. This is the full Order 2 proof on real nodes (summary in `OUT/RELEASE-ACCEPTANCE-MATRIX.md` line 37). Not covered: member-removal cascade live; TPM/KMS key custody | Historical, earlier production (v9/v10): [use](deploy/first-node/acceptance/2026-09-06-runtime-v9/NATIVE-CUSTODY-USE-PROOF.json), [rotation](deploy/first-node/acceptance/2026-09-06-runtime-v9/NATIVE-CUSTODY-ROTATION-PROOF.json), [revocation](deploy/first-node/acceptance/2026-09-06-runtime-v9/LIVE-GRANT-REVOCATION-PROOF.json), [encrypted recovery](deploy/first-node/acceptance/2026-09-06-runtime-v9/ENCRYPTED-CUSTODY-RECOVERY-PROOF.json), [non-exposure](deploy/first-node/acceptance/2026-09-06-runtime-v10/NONEXPOSURE-V10-SCOPE-MATRIX.json). Earlier bundle: GitHub capture and use for company Qorpera with "no token anywhere", v87 (REG R480–484). Restart, rotation, recovery and a non-exposure scan at the current bundle: **not established** |

Open: [decision 2](#contract-text-that-needs-a-decision-not-code) (repository credential export). The broker accepts one runtime token. Restricting a connection to chosen agents is not offered to members, although per-agent grants exist in the kernel ([Step 7 record](deploy/first-node/RUNTIME-STEP-7-CLOUD-CONNECTORS.md) lines 429–431 and 445–450).

### Order 3: wake bus

**Requirement in force:**
- One agent enters through all five wake kinds, each with its silence rule.
- A routine can finish with no send.
- An authorized Company File event wakes exactly once, and an agent's own write never wakes itself. Since v95 a chain may revisit an agent.
- Coworker messages go through a pair transcript, with held delivery (§14.6, 2026-09-22).
- A usage limit triggers a recorded sponsor handoff (§17, item 29).
- The first run is sponsored by the creating member (2026-09-18).
- An operator pause and a member's Stop are the only brakes (§7.4 amended).

Governing text: §5.3, §7, §8, §14.6–14.7, §17, the Order 3 row.

| Capability | Source | Component tests | Real-node proof | Deployed acceptance |
| --- | --- | --- | --- | --- |
| Five wake kinds and silence | [#116] | SQL [300_runtime_wake_bus](supabase/tests/300_runtime_wake_bus.test.sql), [130](supabase/tests/130_wake_arbitration.test.sql): [CI][ci-db]. TS `cloud-wake-bus`, `scripts/test-runtime-wake-bus.mjs`: local only | `OUT/V26-SILENT-ROUTINE-ACCEPTANCE.json`, `OUT/V26-COMPANY-FILE-WAKE-ACCEPTANCE.json` (2026-09-14); `OUT/V26-ROOM-WAKE-ACCEPTANCE.json` (the room wake reached one staff member, not all); `OUT/V26-AGENT-WAKE-ACCEPTANCE.json` (2026-09-16) | Historical, earlier production: [Steps 0–3 ledger](deploy/first-node/RUNTIME-STEPS-0-3-ACCEPTANCE.md) (v9–v13, all five kinds on one staff identity); [silent file routine](deploy/first-node/acceptance/2026-09-06-runtime-v9/SILENT-FILE-ROUTINE-PROOF.json). Current backend: human, agent, room and routine wakes each seen live (rows below). All five on one agent with clients closed at a current bundle: **not established** |
| File-change wake once; self-write fence; v95 chain revisit | [#116]; [#273] (v95) | SQL 300_runtime_wake_bus: [CI][ci-db] | `OUT/V26-COMPANY-FILE-WAKE-ACCEPTANCE.json` | Historical v9 (above). Current bundle: **not established**. No live test of the v95 chain revisit is recorded |
| Coworker messaging (pair transcript) | [#213] (v70), [#227] (v79) | SQL [380](supabase/tests/380_runtime_agent_messaging.test.sql), 376: [CI][ci-db] | not established | v70 test company, round trip A→B→A (REG R305–306). Company Qorpera: the first v70 attempts failed (no execution authority at hire, then a provider refusal). The chain passed on v70 at 02:25Z on 2026-09-23, after an operator granted authority and a provider hotfix (#225) was applied by hand (REG R335–344). Later chains: v80 (REG R350), v82 (REG R361), v84 (REG R390, R406). #227 (v79, live with the v80 cut) gives hires authority by default |
| Held delivery (`priority: false`) | [#219] (v73) | SQL [381](supabase/tests/381_runtime_held_peer_messages.test.sql): [CI][ci-db] | not established | **not established**: a live proof was planned (REG R327), none recorded |
| Sponsor handoff on a usage limit | [#116] | SQL 583, 163: [CI][ci-db] | RESULTS D08a PASS at v106: handoff `d1581ac1` moved run `55f862d4` to the same member's other connection (binding version 1→2, reason `usage_limit`). Attempt 2 completed (REG R1161) | Historical, earlier production: v11 [handoff](deploy/first-node/acceptance/2026-09-06-runtime-v11/NATIVE-V11-HANDOFF-PROOF.json); v13 autonomous handoff ([manifest](deploy/first-node/acceptance/2026-09-07-runtime-v13/MANIFEST.json)). Current backend, through the installed interfaces: **not established** |
| First run on the creator's account | Commit `a40082fe5`, in [#116] | SQL 300_runtime_wake_bus: [CI][ci-db] | `OUT/V28-STEP3-LIMITS-ACCEPTANCE.json` (first run fixed and proven) | v58 Mark first-run wake `b620339a` (REG R215); v80 Tina Test startup turn `7c95920a` (REG R350) |
| Operator pause; member Stop | [#251] (v89), [#265] (v92) | SQL 330, 332, 280: [CI][ci-db] | `OUT/V28-STEP3-LIMITS-ACCEPTANCE.json` (pause and the since-withdrawn ceiling) | Operator pause is used at every cut, e.g. pause 20:59:39Z → resume 21:01:28Z (REG R1074). A test that running work is fenced, at the current bundle: **not established**. Member Stop at the current bundle: **not established**. Historical: v9 [founder controls](deploy/first-node/acceptance/2026-09-06-runtime-v9/FOUNDER-CONTROLS-V9-PROOF.json) |

Open: "Try again" on a failed room delivery was never re-tested live on its happy path (REG R98, R174).

### Order 4: Company Computers

**Requirement in force:**
- A persistent cloud workbench, a live Company File mount, a shell, and a browser with the company's sticky sign-ins.
- One company machine and several agent desktops, working with every member device offline.
- Resetting the machine leaves company state intact.
- Nodes are symmetric, with least-loaded placement and standard sizes (2026-09-16).
- Identity recovery inside a login, host reboot as a lifecycle event, and a kept company root (2026-09-17).
- One company browser (2026-09-17).
- Member runs use a shared execution host with sandboxes (2026-09-22).
- Minimum observability records: lifecycle, capacity, usage (§19).
- No machine limit since v92.

Governing text: §12, the Order 4 row, the amendments above, §19 "Minimum operational observability".

| Capability | Source | Component tests | Real-node proof | Deployed acceptance |
| --- | --- | --- | --- | --- |
| Office VM, desktops, screens, shell, browser | [#116]; office PRs [#158], [#159], [#170], [#173], [#176], [#177], [#181] (v43–v53; the office image, browser revision and passthrough went live through office lanes from 2026-09-20, the rest with the v57 cut); [#195] (v57), [#229] (v82), [#233] (v83), [#278] (v97), [#282] (v98) | SQL [350](supabase/tests/350_runtime_office_reset.test.sql), [297](supabase/tests/297_company_path_computer_interlock.test.sql), [306](supabase/tests/306_governed_company_computer_privileges.test.sql): [CI][ci-db]. TS: 3 of 63 `packages/runtime/test/cloud-company-computer-*`, 2 of 92 `packages/runner-orchestrator/test/lxd-office-*` and two `office-*` tests run in [CI][ci-lxd]; the rest are local only. [`scripts/test-runtime-office-linux.mjs`](scripts/test-runtime-office-linux.mjs) runs in a Linux container (not a node) | V26 office series, 2026-09-14 to 17: `OUT/V26-OFFICE-RESET-ACCEPTANCE.json`, `…-SERVICE-RESTART-A1-…`, `…-REBOOT-A1-…`, `…-POWER-OFF-RESUME-A3-…`, `OUT/V26-SIX-SCREENS-GEN15-ACCEPTANCE.json`, `OUT/V26-COMPANY-BROWSER-ACCEPTANCE.json`, `OUT/V26-HOST-REBOOT-NODE1-ACCEPTANCE.json`, `OUT/V28-VIEWER-CONTROL-ACCEPTANCE.json` | Production office power-off and resume passed at 15:21:35Z on 2026-09-20, after its recovery (REG R116). Browser guest revision 1 accepted 2026-09-21 02:54–03:01Z (REG R168). Passthrough 23:17–23:18Z (REG R183). Third concurrent machine on node 1 at v82 (REG R361). Office journey at the current bundle: **not established**. The v98 office image guard has not been rolled to the offices; that production step waits for Jonas (REG R955–956) |
| Placement, capacity and usage records | 2026-09-16 amendment commits (in [#116]); [#279] (v96) | SQL [403](supabase/tests/403_runtime_node_capacity_fits_demand.test.sql), 332, [320](supabase/tests/320_runtime_operational_observability.test.sql): [CI][ci-db]. TS `runtime-node-*`, `lxd-provider`: [CI][ci-lxd] | `OUT/V26-TWO-NODE-PLACEMENT-ACCEPTANCE.json` (2026-09-16) | v96 view shows free CPU and memory (REG R916–919). Launch items 26–28 as operator journeys: **not established** |
| Shared execution host (sandbox per run) | [#197] (no bundle input), [#228] | TS `shared-execution-backend`: [CI][ci-lxd] | Pilot on node 2, 2026-09-22 ([record](deploy/shared-execution/README.md) lines 137–148; REG R208) | As a pilot it served test-company runs at v58 (REG R214–215) and v67 (REG R270–272). Merged code live on node 2 since the v70 cut (REG R305); rebuilt on the v106 image (REG R1079). Later runs on it: the test company at v70 (REG R305–306) and the pre-merge Sol and Luna runs at v88 (REG R598–600). At v106: **not established**. All 20 agent runs since the v106 activation, including every accepted run, were placed on node 1's per-run provider (deployment manifest run placements, 2026-09-25 02:59Z). Node 1 has no shared execution host |
| Identity recovery inside a login | 2026-09-17 amendment commits (in [#116]) | SQL [300_login_recovery_automation](supabase/tests/300_login_recovery_automation.test.sql): [CI][ci-db]. TS `lxd-login-gateway`: [CI][ci-lxd] | `OUT/V26-LOGIN-RECOVERY-AUTOMATION-ACCEPTANCE.json`, `OUT/V26-NODE2-RECOVERY-LOGIN-ACCEPTANCE.json` | v35: stale-copy recovery (epoch 2→3), then a job completed on node 1, 2026-09-21 00:30–00:43Z (REG R146) |

Open (from REVIEW and `OUT/RELEASE-ACCEPTANCE-MATRIX.md` rows "Step 4"):
- A two-agent desktop journey with every client closed.
- Real LXD + NAS reset and durability ([Step 4 acceptance](deploy/first-node/RUNTIME-STEP-4-ACCEPTANCE.md) lines 94–104).
- Nothing notices a dead office service (D-OFFICE-RESTART-2).
- Stopped offices still self-update when started (REG R955).
- The 2026-09-22 shared execution service is on node 2 only. Node 1, where production agent runs land, still boots one machine per run.

### Order 5: workers and todos

**Requirement in force:**
- The parent stays interruptible.
- A blank child receives a complete dispatch.
- Durable completion reaches the parent.
- Todos and accepted worker outputs become Company File state and survive restart.
- Open work appears in composed context (§9.1).
- No standing counts (v95).

Governing text: §13, §9.1, the Order 5 row.

| Capability | Source | Component tests | Real-node proof | Deployed acceptance |
| --- | --- | --- | --- | --- |
| Dispatch, report, parent revival, durable todos | [#157] (v65, `a6e6616c8`); [#273] (v95) | SQL [385](supabase/tests/385_runtime_workers_todos.test.sql): [CI][ci-db]. TS `cloud-worker-tools`: local only. Live-model screen 9/9 with synthetic effects ([Step 5 record](deploy/first-node/RUNTIME-STEP-5-WORKERS-TODOS.md) lines 110–125) | RESULTS J10 at v106, test company A1. Run 1 FAIL: the parent answered a quick question while its two workers ran, both workers reported, but the batch revival `fe35148d` failed before any model turn when context authority checks timed out under concurrent load (finding P-J10-1). Run 2, alone, PASS: revival `d8746ab8` read both results and sent one combined answer. RESULTS J05 baseline FAIL: each `manage_todo` took 5–19 s, then authority checks timed out and run `05b0d505` failed (REG R1161–1163) | v67, test company on the exec host: first live worker `0a1308d5` (644 tool observations). Parent revival `f6129301` was lost (REG R270, R272). **Failure at v106 in company Qorpera:** after the 2026-09-25 database outage, the completion revival `5918e47b` (run `096ea4c6`) of coding worker `2d00aefd` failed for good at 01:30:37Z. The result reached the member only after they asked again. It was never retried and no member was told. This is finding P-D09-1 of the proof runs (REG R1142). An in-house worker completing in a real company, restart survival, and the v95 counts: **not established** |
| Open work in composed context (§9.1) | Not built ([Step 5 record](deploy/first-node/RUNTIME-STEP-5-WORKERS-TODOS.md) lines 156–158) | — | — | — |

Open:
- REVIEW finding 2 (a late todo publication overwrites a newer one) → [#303] (v111).
- Listing pages for todos (32) and workers (16) → [#308] (v112).
- A revival lost to a failed dispatch is never retried and nobody is told. This happened after the database outage (P-D09-1, REG R1142) and under concurrent load (P-J10-1, REG R1163). No fix is assigned yet. It also bears on Order 9's completion listener and on §23: an unavailable path must show as unavailable.
- `manage_todo` takes 5–19 s per change because every change publishes a Company File document, and it slowed authority checks for other runs (RESULTS J05, P-J10-1).

### Order 6: agent memory (and skills)

**Requirement in force (memory):**
- An agent's profile, monthly log and notes are its own Company File objects, in the Grok Bot layout.
- `update_memory` (write, forget) and `recall_memory` go through the versioned gateway, with dedupe, exact-text forget and retry on conflict.
- Every turn composes the profile and the recent log.
- A worker recalls, but writes only with write access.
- Company first; no member memory.
- A Grok Bot export imports unchanged.

Governing text: Order 6 row (amended 2026-09-22 and 2026-09-24), §5.4, §15.1. Skills: §15.2; see [decision 3](#contract-text-that-needs-a-decision-not-code).

| Capability | Source | Component tests | Real-node proof | Deployed acceptance |
| --- | --- | --- | --- | --- |
| Notebook tools and composition | [#216] (v85), [#240] (v86) | SQL [386](supabase/tests/386_runtime_memory_notebook_write.test.sql): [CI][ci-db]. TS `cloud-memory-tools`: local only | not established | v85 failed live (every write refused, REG R424). v86 accepted 2026-09-23 23:18Z: write run `2104df01`, recall run `11b89472` (REG R433) |
| Forget across months, dedupe, conflict retry, whole profile | Defects on master (REVIEW findings 3 and 5). Fix: [#302] (v108) | The existing test simulates the wrong conflict error. The defects were reproduced with the actual memory code and a synthetic transport or in-memory gateway (REVIEW `verification.md`, "New reproductions") | — | not established |
| Grok Bot import | Not built ([Step 6 record](deploy/first-node/RUNTIME-STEP-6-MEMORY.md) lines 48–49) | — | — | — |
| Skill catalog and on-demand loader (§15.2) | Not built. Provider skills are disabled on purpose | Refusal tests only | — | — |

### Order 7: connectors and typed interactions

**Requirement in force:**
- Install, authenticate out of band, call through scoped RPC, and follow the connector-to-browser escalation path (§16.1).
- Distinct typed interaction surfaces; dismissal is never consent (§16.2).
- Connections are always shared (founder decision 2026-09-24; not yet in the contract).

Governing text: §16.1–16.2, the Order 7 row, the §19 note on Order 2 versus Order 7.

| Capability | Source | Component tests | Real-node proof | Deployed acceptance |
| --- | --- | --- | --- | --- |
| Gmail, Drive and GitHub connectors | [#241] (v87, contains [#202]); [#244] (v88) | SQL [397](supabase/tests/397_cloud_connector_catalog.test.sql), 398, [399](supabase/tests/399_coding_repository_connector.test.sql): [CI][ci-db]. TS `cloud-connector-*`: [CI][ci-lxd]. `scripts/generate-cloud-connector-catalog.mjs --check` | not established | GitHub accepted at v87, 2026-09-24 00:40–00:43Z: connected in Jonas's Chrome; the agent created, read and commented on qorpera-coding-proof issue #1 (REG R480–484). v88 read (REG R546). Gmail and Drive: **not established** (not connected, REG R486; Gmail needs Google verification) |
| Connector-to-browser escalation | Not built ([Step 7 record](deploy/first-node/RUNTIME-STEP-7-CLOUD-CONNECTORS.md) lines 9–10) | — | — | — |
| Question cards (`ask_member`) and answers | [#215] (kernel; live with v80), [#217] (v80), [#287] (v100), [#289] (v102), [#291] (v105) | SQL [590](supabase/tests/590_thread_interactions.test.sql), [596](supabase/tests/596_runtime_agent_thread_cards.test.sql), [597](supabase/tests/597_runtime_answer_card_outside_agent_thread.test.sql): [CI][ci-db]. TS `cloud-thread-interactions`: local only | not established | v100 failed (REG R985). In the agent's own thread, accepted at v103, 2026-09-24 20:42–20:44Z (REG R1068–1071). In a plain conversation, accepted at v106, 2026-09-25 01:04Z (REG R1085–1086) |
| Secret cards through custody | [#221] (v81) | SQL 590: [CI][ci-db] | not established | **not established** (REG R334, R351) |
| Other §16.2 surfaces | Office sign-in handoff (viewer control), member upload/download: [#116]. Plugin installation: not built | SQL 295, 296: [CI][ci-db] | `OUT/V28-VIEWER-CONTROL-ACCEPTANCE.json`; `OUT/V28-COMPANY-FILE-TRANSFER-ACCEPTANCE.json` | Dismissal-is-not-consent at the current bundle: **not established** |

Open:
- REVIEW finding 6 (ask keys of 123–128 characters) → [#299] (v110).
- Security items S2 (account-wide `repo` token, open Git egress), S3 and N1 in the [Step 7 record](deploy/first-node/RUNTIME-STEP-7-CLOUD-CONNECTORS.md) lines 423–441.

### Order 8: scheduler, routines, listeners, hiring

**Requirement in force:**
- Company File intent plus one compiled trigger wakes the same agent.
- Deterministic deduplication, time zones, expiry, quiet windows, pause on repeated authorization failure, and consistent projections.
- Agents create and change their own routines without approval (2026-09-19/20).
- Kickoff at the effective instant; the agent chooses a routine's effort (2026-09-22).
- Agents hire and open group chats without approval (2026-09-19/20).
- Dynamic routines are added beside fixed ones (founder decision 2026-09-25; not yet in the contract).

Governing text: §16.3, §17, the Order 8 row, [Step 8 record](deploy/first-node/RUNTIME-STEP-8-SCHEDULER.md).

| Capability | Source | Component tests | Real-node proof | Deployed acceptance |
| --- | --- | --- | --- | --- |
| Scheduled routines (`every`, `weekly`): time zone, kickoff, effort, quiet windows | [#148] (v38), [#209] (v66), [#212] (v84), [#273] (v95) | SQL [370](supabase/tests/370_runtime_agent_routines.test.sql): [CI][ci-db]; also rehearsed on a disposable database on the node 2 cluster before the v57 cut (REG R205–206). TS `cloud-routine-tools`, runner-orchestrator `orchestrator.test.ts`: local only | `OUT/V26-SILENT-ROUTINE-ACCEPTANCE.json` (schedule wake, 2026-09-14; predates kickoff, effort and pause-defer) | v58: an agent created routine `8b5a1bcc` (REG R215). v67 kickoffs `5f19db53`, `6ca78586` (REG R273). The v84 pause-defers behaviour: **not established** (REG R390) |
| Finite watches and expiry | [#148]. Defect on master (REVIEW finding 1). Fix: [#300] (v107) | SQL 370 checks expiry, not execution of the final run. The defect was reproduced on a local PostgreSQL 17.6 with all 391 migrations (REVIEW `evidence/finite-routine-proof.txt`) | — | not established |
| Pause on repeated authorization failure | [#148] | SQL 370 (admission failures only; REVIEW `work/execution-review.md`) | not established | **not established** |
| File-change listeners | [#116], [#148] | SQL 300_runtime_wake_bus, 370: [CI][ci-db] | `OUT/V26-COMPANY-FILE-WAKE-ACCEPTANCE.json` | Current bundle: **not established**. Operation filters: not built ([Step 8 record](deploy/first-node/RUNTIME-STEP-8-SCHEDULER.md) lines 237–238) |
| Vendor listeners (webhooks, channels) | Not built (Step 8 record lines 235–236) | — | — | — |
| Routine intent as a Company File document, with a projection | Not built (Step 8 record lines 228–234) | — | — | — |
| Hiring and group chats without approval | [#148] (v38), [#227] (v79) | SQL [375](supabase/tests/375_runtime_agent_hiring.test.sql), 376: [CI][ci-db]. TS `cloud-hiring-tools`: local only | not established | Agent hires agent at v80: Mark hired Tina Test, and the authority row was created by trigger (REG R350). An agent opening a group chat: **not established** |
| Dynamic routines | Not built. Slot v114 | — | — | — |

Open: REVIEW finding 7 (a lost apply response is reported as "awaiting approval"; a reused hire key returns a mismatched receipt) → [#299] (v110).

### Order 9: coding workers and PRs

**Requirement in force:**
- Worker, repository workspace, branch, follow-up identity, publication and completion listener keep continuity.
- A member's sessions share one coding machine. It holds no node capacity asleep, is removed later, and its allocation is released only on a proven delete (2026-09-24).
- Claude subscriptions for coding only (founder decision 2026-09-24; not built).

Governing text: §13.1, the Order 9 row, [coding worker README](deploy/coding-worker/README.md).

| Capability | Source | Component tests | Real-node proof | Deployed acceptance |
| --- | --- | --- | --- | --- |
| Coding sessions, executor, draft PR publication | [#211] (v71), [#218] (v72), [#241] (v87), [#244] (v88), [#259] (v93), [#290] (v103), [#292] (v106) | SQL [395](supabase/tests/395_runtime_coding_sessions.test.sql), [396](supabase/tests/396_runtime_coding_executor.test.sql), 399: [CI][ci-db]. TS `packages/runtime/test/cloud-coding-*`, `cloud-native-coding-runtime`, and 11 of 12 runner-orchestrator `coding-*`: [CI][ci-lxd] | Node 2 coding infrastructure (REG R325, R332–333). Pre-merge proof#2 (REG R667–720). Read-only session roots on node 2 ([command guest](deploy/coding-worker/COMMAND-GUEST.md) lines 88–92; REG R1056) | proof#3 at v95 (REG R871); proof#4 at v97 (REG R916–919); proof#5–7 at v103 (REG R1046–1049); proof#8 at v106, and a write to an earlier output.log was refused (REG R1083); proof#10 on a 4/8 machine, 2026-09-25 02:00Z (REG R1114) |
| Follow-up continuity (question, answer, retry after executor loss) | Defects on master (REVIEW findings 4 and 8) | No two-turn test | — | **not established**. Fix: v113, no PR yet |
| Member coding machine: sleep, wake, removal, proven release | [#284] (v101), [#290] (v103) | SQL [600](supabase/tests/600_runtime_coding_member_machines.test.sql): [CI][ci-db] | not established | v101: sleep and removal passed, commands failed (REG R1008–1015). v103: sleep, wake and removal seen (REG R1046–1049). Old machine removed when the policy moved at the v106 cut (REG R1083) |
| Installed acceptance of ask, follow-up, cancel and revocation | — | — | — | **not established** ([README](deploy/coding-worker/README.md) lines 104–108) |
| Completion reaching the parent | [#211], [#218] | SQL 395, 396: [CI][ci-db] | not established | At v106 a coding worker's completion revival was lost after the database outage and never retried (P-D09-1, REG R1142; see Order 5) |
| Claude Code adapter (Claude subscription, coding only) | Not built | — | — | — |

### Order 10: constitution and hire overlays

**Requirement in force:** compile a short constitution over the proven loop, then add a name and job specification last, without creating a second brain.

Governing text: §9.3, §18, the Order 10 row.

| Capability | Source | Component tests | Real-node proof | Deployed acceptance |
| --- | --- | --- | --- | --- |
| Constitution, overlays, system prompt | [#135] (v37), [#283] (v99) | TS `cloud-runtime-constitution`, `cloud-native-company-context`, `cloud-codex-tool-session`: local only. Model screen 54/58 on synthetic scenarios ([behaviour pass 4](deploy/first-node/RUNTIME-STEP-10-BEHAVIOR-PASS-4.md)) | not established | v100 thread run `544a0040` on the v99 prompt (REG R981). 16 KiB context: check B passed, check A partial (REG R984). Installed-release behaviour for first run, silent routine, employee and Co-Founder: **not established** ([Step 10 record](deploy/first-node/RUNTIME-STEP-10-INTEGRATION.md) lines 86–87) |

### Cross-cutting

| Area | Source | Component tests | Real-node proof | Deployed acceptance |
| --- | --- | --- | --- | --- |
| Runtime bundle pinning (§3) | [`scripts/generate-cloud-runtime-bundle.mjs`](scripts/generate-cloud-runtime-bundle.mjs) | `--check` passes locally at `0dbf36d4…`. **No CI workflow runs it** | Each cut's image lane re-runs the isolation probe (REG R909, R977; v106 lane receipts `work/cut-v106-a1/image/receipts/isolation-*` in the coordinator workspace) | v106 active with that digest (REG R1074) |
| Clients-closed and headless operation (§2, §24.2, item 12) | [#116] | — | Headless install and call from an installed release on node 1, v29 (`OUT/RELEASE-ACCEPTANCE-MATRIX.md` row "Versioned headless install") | Current bundle: **not established** |
| Failure model (§23) | Deferred to partner testing | — | — | Must be reported as unavailable |

**CI coverage note.** *Hosted database contract* and *Step 2 LXD contracts* run only on pull requests (or by manual dispatch), and only when certain paths change. Most `packages/shell/test/cloud-*.test.ts` files (wake bus, mouth, memory, workers, routines, hiring, cards, constitution, fences) run in no workflow. The `ephemeral-runner-linux.yml` path filter still points at `packages/shell/src/cloud-runner-*.ts`, but that code moved to `packages/runtime/src`. The workflow has not run since 2026-09-18 ([run][ci-runner]).

## Launch acceptance (§21), read with the amendments

The launch gate passes only when a deployed environment proves items 1–30 at the launch candidate's exact identity. Status below is for the **deployed acceptance** column; the component and node evidence is in the Order tables.

The labels follow the vocabulary at the top: **current bundle**, **earlier bundle**, **historical**, **partial** (some parts proven, possibly at different bundles) and **not established**.

| # | Requirement in force (short) | Orders | Deployed status | Evidence |
| --- | --- | --- | --- | --- |
| 1 | The Company File stays usable while every app and Computer is stopped | 0 | Historical | [Steps 0–3 ledger](deploy/first-node/RUNTIME-STEPS-0-3-ACCEPTANCE.md); node: `OUT/TEST-COMPANY-*` |
| 2 | Two members, separate identities, private paths and sponsors, no leakage | 0, 3 | Historical | [v9 two-member proof](deploy/first-node/acceptance/2026-09-06-runtime-v9/TWO-MEMBER-ONE-AGENT-PATH-PROOF.json); node: `OUT/V26-TWO-MEMBER-ACCEPTANCE.json`, `OUT/V26-AGENT-THREADS-ACCEPTANCE.json` |
| 3 | A new company seeds its Company File, one Co-Founder, projections and one silent first run | 0, 3 | Partial | Companies created in the 2026-09-23 browser stress test (REVIEW, "What the available evidence establishes"); no acceptance record at a current bundle |
| 4 | A new agent gets exactly one startup wake, no template artifact, and the default thread policy | 0, 3 | Earlier bundle | v58 (REG R215), v80 (REG R350) |
| 5 | Archive and permanent delete are distinct; delete removes owned artifacts | 0 | Not established | SQL 315 only |
| 6 | Live path operations, stale fails, disjoint succeeds, presence, proposals, revocation, history | 0 | Historical | v9 proofs; presence not established |
| 7 | Archiving a chat keeps company state; a new hire understands it from the Company File | 0 | Not established | — |
| 8 | Only sends appear; no reasoning, assistant text, tool logs or envelopes | 1 | Partial | Seen in every accepted run (e.g. REG R1071, R1086); no dedicated check at a current bundle |
| 9 | All five wakes, a silent routine, one wake per file change, no self-wake (v95: a chain may revisit) | 3 | Historical | [Steps 0–3 ledger](deploy/first-node/RUNTIME-STEPS-0-3-ACCEPTANCE.md); node: V26 series |
| 10 | Injected instructions in connector, browser, Company File, worker and coworker results gain no authority | 2 | Historical (Company File case only) | [v9 fence proof](deploy/first-node/acceptance/2026-09-06-runtime-v9/CAUSAL-FILE-AND-INPUT-FENCE-PROOF.json) |
| 11 | An agent messages a coworker, hires one, creates a routine and uses its Computer, all in the cloud | 3, 4, 8 | Earlier bundle, piecewise | Message and hire at v80 (REG R350); routine at v58 (REG R215); screen at v35 (REG R155). Never as one journey |
| 12 | Messages, fan-out, file events, worker completion, schedules and listeners continue with every client offline | 3, 5, 8 | Not established | Vendor listeners are not built |
| 13 | Several agents on separate desktops of one shared Computer; a reset preserves company state | 4 | Not established | Node: `OUT/V26-SIX-SCREENS-GEN15-ACCEPTANCE.json`, `OUT/V26-OFFICE-RESET-ACCEPTANCE.json` |
| 14 | The parent stays responsive while a worker runs; a coding follow-up returns to the same worker, machine, repo and branch | 5, 9 | Partial | Worker at v67, revival lost (REG R270). Node tier at v106: RESULTS J10 failed under load and passed alone; coding follow-up not established (REVIEW findings 4 and 8) |
| 15 | Memory reads only the agent's own notebook; write, forget and concurrent use keep versions; forgotten facts leave composition | 6 | Partial | Write and recall at v86 (REG R433); forget and concurrency defects: [#302] |
| 16 | Typed surfaces for connector auth, sign-in handoff, approvals, cards, upload/download; dismissal is never consent | 7 | Partial | Connector auth at v87 (REG R480); cards (REG R1071, R1086) |
| 17 | Secrets stay out of every surface; revocation fences use | 2 | Partial | v10 [non-exposure](deploy/first-node/acceptance/2026-09-06-runtime-v10/NONEXPOSURE-V10-SCOPE-MATRIX.json); "no token anywhere" at v87 (REG R484) |
| 18 | Every message, effect and operation exposes complete provenance | all | Not established | — |
| 19 | The native-subscription, control-plane, Company File and storage gates also pass | all | Not established | No consolidated record |
| 20 | *Read with the 2026-09-17 amendment.* One shared Co-Founder for every member; member-private facts are never repeated into a shared thread | 0, 3 | Not established (two members) | Node: `OUT/V26-AGENT-THREADS-ACCEPTANCE.json` |
| 21 | Co-Founder first run for a fresh company and for prior work; research in the background; a protected direction proposal | 3, 5, 10 | Not established | REVIEW, "Company formation" |
| 22 | *Read with the 2026-09-20 amendment.* A founder direction flows through agents' descriptions, hires and projects; the founder gets one coherent result; the Co-Founder flags deviations | 3, 8, 10 | Not established | — |
| 23 | *Read with the 2026-09-20 amendment.* An agent keeps each responsibility in its description alive with its own routines and listeners: an exception wakes only that agent, the work is done once and verified, state is updated, and it speaks up as its description says; this survives restarts | 3, 8 | Not established | The escalation queue is withdrawn |
| 24 | *Read with the 2026-09-20 amendment.* Project, room and agent stay distinct; chats and views are never the source of truth | 0 | Not established | Responsibility objects and views are withdrawn |
| 25 | *Read with the 2026-09-20/24 amendment.* A replacement client rebuilds the Co-Founder, sections, agents and rooms from the cloud | 0 | Partial | Sections survive a reload at v95 (REG R834) |
| 26 | An operator can trace a request through job, model and tool records to its outcome, version and compute | cross | Not established | Operator queries exist ([observability](deploy/first-node/RUNTIME-STEPS-0-2-OBSERVABILITY.md)) |
| 27 | Lifecycle records separate viewer close, shutdown and release; computer-hours are not multiplied | 4 | Not established | [Screen lifecycle](deploy/first-node/RUNTIME-SCREEN-LIFECYCLE.md) (component) |
| 28 | The operational view shows allocations, pending starts, waiting demand and admissible capacity | 4 | Partial | v96 view check (REG R916–919) |
| 29 | Sponsor handoff on a usage limit, same principal only, never on a rate limit or outage | 3 | Historical | v11 and v13 on the earlier production backend. Node tier at v106: RESULTS D08a PASS (REG R1161) |
| 30 | *Read with the 2026-09-24 amendment.* The operator pause stops a company without agent cooperation; there are no wake, spend or machine ceilings | 3 | Partial | Pause and resume at every cut (REG R1074); fencing of running work not tested at a current bundle |
| 31 | Azure overflow | — | Deferred; not a launch gate | §19 |

**In short:**
- No mandatory item has deployed acceptance at the current bundle as a complete journey.
- Items 4 and 11 were accepted live on the current backend at older bundles (item 11 only piece by piece).
- Items 3, 8, 14, 15, 16, 17, 25, 28 and 30 are partial.
- Items 1, 2, 6, 9, 10 and 29 have only historical deployed proof.
- Items 5, 7, 12, 13, 18–24, 26 and 27 are not established.

## Work in flight

All of this is based on master `31ebda4ad` or later. None of it is merged or live. Slots come from the coordinator (REG R1119–1165). Each PR needs an independent review on its exact head before merge.

| Slot | Work | Session | PR | Moves which cells |
| --- | --- | --- | --- | --- |
| v107 | A finite routine's last occurrence runs (REVIEW finding 1) | Fix one-time routines and build dynamic routines | [#300] (draft) | Order 8, finite watches |
| v108 | Typed stale-version results; notebook-wide dedupe, forget and recall; whole profile (findings 3, 5) | Fix memory retries and forget | [#302] (draft) | Order 0 path ops; Order 6 |
| v109 | Coding diagnostics (fixed error codes; the authorization step observed on its own) | Design release of kept coding workspaces | [#309] (draft) | Order 9 |
| v110 | Hiring and ask-member report true outcomes (findings 6, 7) | Make hiring and ask-member report true outcomes | [#299] (ready; waits for v107–v109 to merge first, REG R1165) | Orders 7, 8 |
| v111 | A late todo publication can no longer replace a newer document (finding 2) | Stop old todo lists overwriting newer ones | [#303] (draft) | Order 5 |
| v112 | Todo and worker listing pages (cursor, filters) | Let agents page through all their todos and workers | [#308] (draft) | Order 5 |
| v113 | Coding turn continuity: the question, answer and prior turns; no inherited submission (findings 4, 8) | Keep coding follow-ups aware of the question | [#305] (draft) | Order 9 |
| v114 | Dynamic routines (design goes to Jonas first) | Fix one-time routines and build dynamic routines | none yet | Order 8 |
| v115 | Auto-review rules: Ask first / Allow automatically, with a silent review before every acting step (REG R1138, R1140) | Rule behavior in Qorpera | none yet | New requirement; needs a contract amendment |
| v116 | Drive uploads use a multipart boundary of at most 70 characters (REG R1145, confirmed R1165) | Shorten the Drive upload MIME boundary | [#310] (draft) | Order 7 |
| — | Deployment manifest: exact live identities per component | Create one current deployment manifest | [#307] (draft) | "What is live now" |
| — | Proof runs: journeys J01–J19, stress-test replays R01–R06 and degraded-operation drills D01–D10 (REG R1141–1144) | Run the runtime proof runs on the real nodes | branch `fable/runtime-proof-journeys` @ `c1d17e95e` (`deploy/first-node/RUNTIME-PROOF-JOURNEYS.md`, `RUNTIME-PROOF-RESULTS.md`) | Real-node proof and deployed acceptance columns |

Proof journeys by Order (from the proof-runs session). One journey can cover several Orders:
- O0: J04 J06 J07 J08 J13 D09
- O1: J08 J09 J19 D03 D08
- O2: J06 J14 D07
- O3: J01 J02 J06 J15 D01–D04 D09 D10
- O4: J18 D05 D06 D10
- O5: J04 J05 J10 J15 D01 D09
- O6: J09 J17
- O7: J14 J19 D07
- O8: J01 J02 J03 J06 J09 J15 J16
- O9: J11 J12 D06 D10
- O10: J13 J16

Journeys blocked until a fix is live:
- J01 and J02: v107.
- J17 and the memory part of J09: v108.
- J11: v109 and v113.
- The hiring and card parts of J09: v110.
- J04: v111.
- J05: v112.
- J12: v113.
- J03: v114.
- J18 and D05 wait on the test office self-update lane.

Results so far at v106 (RESULTS at `2149dc148`, REG R1142, R1160–1164):
- D09 failed: a coding worker's completion revival was lost after the database outage (see Order 5).
- J08, R04 and D08a passed. D08a is the first sponsor handoff proven on the current backend.
- J10 failed with two agents working at once, and passed when run alone.
- The J05 baseline failed.
- The J04 read-only audit found no divergence in 22 live todos. That audit does not test the race itself.

## Out-of-date statements in historical records

These records are left unchanged; this file supersedes their status lines. Each line below is the old statement, then what the later record shows.

- [Step 5 record](deploy/first-node/RUNTIME-STEP-5-WORKERS-TODOS.md) lines 4–6: "Not deployed; no live acceptance on the nodes yet."
  - v65 went live in the v67 cut, 2026-09-22 18:34Z (REG R261). One live worker ran in a test company (REG R270).
- [Step 6 record](deploy/first-node/RUNTIME-STEP-6-MEMORY.md) lines 3–5 and 74: "not applied live".
  - v85 was live 2026-09-23 about 22:44Z. v86 was accepted at 23:18Z (REG R421–444).
- [Step 7 record](deploy/first-node/RUNTIME-STEP-7-CLOUD-CONNECTORS.md) lines 5–6: "nothing is deployed". Also lines 394–419 (rollout gates).
  - v87 went live 2026-09-24 00:26:41Z, and GitHub was accepted (REG R477–484).
- [Step 8 record](deploy/first-node/RUNTIME-STEP-8-SCHEDULER.md) lines 4–5 and 244–245: "Not deployed".
  - Live since the v57 cut, 2026-09-22 04:06Z (REG R209). Routines and hiring were seen live (REG R215, R350).
- [Coding worker README](deploy/coding-worker/README.md) line 3 cites migrations `20260922210000` and `20260922220000` for Order 9.
  - The actual files are `20260922230000_runtime_coding_sessions.sql` and `20260922232000_runtime_coding_executor.sql`. Coding has been live since v88/v93 (REG R871).
- [Command guest](deploy/coding-worker/COMMAND-GUEST.md) lines 3–4: "installs no image or service".
  - Image cut106 is live (REG R1078).
- [Step 10 record](deploy/first-node/RUNTIME-STEP-10-INTEGRATION.md) lines 84–86: "No production migration … or live activation".
  - v37 went live in the v57 cut. v99 went live in the v100 cut (REG R975).
- [Client contract](supabase/CLIENT-CONTRACT.md) line 364 ("Routines, memory … later") and lines 366–367 and 472–473 (coding "not yet").
  - Superseded by the entries above.
- Contract §19 "Current implementation checkpoint": the Step 3, 5 and 6 paragraphs say deployed acceptance or live application is still to come.
  - Superseded by the entries above. Those paragraphs record history, not current status.
- [Step 4 acceptance](deploy/first-node/RUNTIME-STEP-4-ACCEPTANCE.md) line 3: "production acceptance and release remain unapproved".
  - Steps 0–4 were released to master and production on 2026-09-18 ([#116]). The Order 4 live evidence is in REG R116, R168 and R183. The actual-host LXD and NAS gates (lines 94–104) are still open.
- [First-node README](deploy/first-node/README.md) "Current deployed acceptance checkpoint" (image v20).
  - Historical.

Paths in records that no longer resolve:
- [Step 1](deploy/first-node/RUNTIME-STEP-1.md) line 65 (`packages/shell/src/cloud-agent-mouth.ts`, now in `packages/runtime/src`).
- [Step 3](deploy/first-node/RUNTIME-STEP-3-WAKE-BUS.md) line 81 (`packages/shell/src/cloud-wake-bus.ts`, now in `packages/runtime/src`).
- [Step 5](deploy/first-node/RUNTIME-STEP-5-WORKERS-TODOS.md) line 44 (the migration is `20260922170000_runtime_workers_todos.sql`).
- [Coding README](deploy/coding-worker/README.md) line 118 (`native-codex/credential-ownership.md` does not exist).

## Keeping this file current

- **After every live cut:** update "What is live now". Move a cell to deployed acceptance only when an acceptance ran on that bundle, and cite the registry entry, the bundle and the run or proof identifiers.
- **After a merge:** add the PR to the Source column. A merge alone never changes the other three columns.
- **Leave historical records unchanged.** Correct status here. Correct a record's facts only when the record itself is wrong about its own time.
- **When the founder changes a requirement:** amend the contract with a dated amendment first, then update [Decisions that are not gaps](#decisions-that-are-not-gaps) and the affected Order requirement.

[ci-db]: https://github.com/Qorpera/Qorpera_Base/actions/runs/36056957639
[ci-lxd]: https://github.com/Qorpera/Qorpera_Base/actions/runs/36056957573
[ci-web]: https://github.com/Qorpera/Qorpera_Base/actions/runs/36092068507
[ci-runner]: https://github.com/Qorpera/Qorpera_Base/actions/runs/35348453110
[#116]: https://github.com/Qorpera/Qorpera_Base/pull/116
[#135]: https://github.com/Qorpera/Qorpera_Base/pull/135
[#147]: https://github.com/Qorpera/Qorpera_Base/pull/147
[#148]: https://github.com/Qorpera/Qorpera_Base/pull/148
[#152]: https://github.com/Qorpera/Qorpera_Base/pull/152
[#157]: https://github.com/Qorpera/Qorpera_Base/pull/157
[#161]: https://github.com/Qorpera/Qorpera_Base/pull/161
[#191]: https://github.com/Qorpera/Qorpera_Base/pull/191
[#195]: https://github.com/Qorpera/Qorpera_Base/pull/195
[#197]: https://github.com/Qorpera/Qorpera_Base/pull/197
[#201]: https://github.com/Qorpera/Qorpera_Base/pull/201
[#202]: https://github.com/Qorpera/Qorpera_Base/pull/202
[#209]: https://github.com/Qorpera/Qorpera_Base/pull/209
[#211]: https://github.com/Qorpera/Qorpera_Base/pull/211
[#212]: https://github.com/Qorpera/Qorpera_Base/pull/212
[#213]: https://github.com/Qorpera/Qorpera_Base/pull/213
[#215]: https://github.com/Qorpera/Qorpera_Base/pull/215
[#216]: https://github.com/Qorpera/Qorpera_Base/pull/216
[#217]: https://github.com/Qorpera/Qorpera_Base/pull/217
[#218]: https://github.com/Qorpera/Qorpera_Base/pull/218
[#219]: https://github.com/Qorpera/Qorpera_Base/pull/219
[#221]: https://github.com/Qorpera/Qorpera_Base/pull/221
[#227]: https://github.com/Qorpera/Qorpera_Base/pull/227
[#228]: https://github.com/Qorpera/Qorpera_Base/pull/228
[#229]: https://github.com/Qorpera/Qorpera_Base/pull/229
[#233]: https://github.com/Qorpera/Qorpera_Base/pull/233
[#240]: https://github.com/Qorpera/Qorpera_Base/pull/240
[#241]: https://github.com/Qorpera/Qorpera_Base/pull/241
[#244]: https://github.com/Qorpera/Qorpera_Base/pull/244
[#251]: https://github.com/Qorpera/Qorpera_Base/pull/251
[#254]: https://github.com/Qorpera/Qorpera_Base/pull/254
[#259]: https://github.com/Qorpera/Qorpera_Base/pull/259
[#263]: https://github.com/Qorpera/Qorpera_Base/pull/263
[#265]: https://github.com/Qorpera/Qorpera_Base/pull/265
[#273]: https://github.com/Qorpera/Qorpera_Base/pull/273
[#276]: https://github.com/Qorpera/Qorpera_Base/pull/276
[#278]: https://github.com/Qorpera/Qorpera_Base/pull/278
[#279]: https://github.com/Qorpera/Qorpera_Base/pull/279
[#282]: https://github.com/Qorpera/Qorpera_Base/pull/282
[#283]: https://github.com/Qorpera/Qorpera_Base/pull/283
[#284]: https://github.com/Qorpera/Qorpera_Base/pull/284
[#287]: https://github.com/Qorpera/Qorpera_Base/pull/287
[#289]: https://github.com/Qorpera/Qorpera_Base/pull/289
[#290]: https://github.com/Qorpera/Qorpera_Base/pull/290
[#291]: https://github.com/Qorpera/Qorpera_Base/pull/291
[#292]: https://github.com/Qorpera/Qorpera_Base/pull/292
[#299]: https://github.com/Qorpera/Qorpera_Base/pull/299
[#300]: https://github.com/Qorpera/Qorpera_Base/pull/300
[#302]: https://github.com/Qorpera/Qorpera_Base/pull/302
[#303]: https://github.com/Qorpera/Qorpera_Base/pull/303
[#158]: https://github.com/Qorpera/Qorpera_Base/pull/158
[#159]: https://github.com/Qorpera/Qorpera_Base/pull/159
[#170]: https://github.com/Qorpera/Qorpera_Base/pull/170
[#173]: https://github.com/Qorpera/Qorpera_Base/pull/173
[#176]: https://github.com/Qorpera/Qorpera_Base/pull/176
[#177]: https://github.com/Qorpera/Qorpera_Base/pull/177
[#181]: https://github.com/Qorpera/Qorpera_Base/pull/181
[#305]: https://github.com/Qorpera/Qorpera_Base/pull/305
[#307]: https://github.com/Qorpera/Qorpera_Base/pull/307
[#308]: https://github.com/Qorpera/Qorpera_Base/pull/308
[#309]: https://github.com/Qorpera/Qorpera_Base/pull/309
[#310]: https://github.com/Qorpera/Qorpera_Base/pull/310
