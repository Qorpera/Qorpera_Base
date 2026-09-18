# Runtime Step 3 — current handoff, 2026-09-06 19:08Z

Steps 0–3 acceptance is complete for the Company41 contract scope documented in
the [current acceptance ledger](RUNTIME-STEPS-0-3-ACCEPTANCE.md). Signed runtime
v11 (`759e44f36`) and its matching database bundle are deployed. Admission is
enabled at policy 23, the founder pause is cleared, and the ceiling remains
240 wakes/hour. All 153 migration records are retained. No job guests, active
jobs, assignments or native leases remain.

Actual run `94541e40-e197-4f85-bddf-441be0a4766b` received a provider usage limit,
notified the founder, handed the same run to the other Pro account, and completed
its file read, progress/final sends and durable result. The former harness,
provenance mismatch and teardown blockers below are resolved. The rollout
tooling is now versioned under `scripts/runtime-rollout/`.

The [v11 evidence manifest](acceptance/2026-09-06-runtime-v11/MANIFEST.json)
records exact pins, deployed state, regression tests, historical proof chains
and limitations. Gmail still returned usage_limit despite refreshed Pro claims;
the Qorpera account completed the continuation. No further login or quota
exhaustion is needed for this acceptance. The founder authorized the production
changes, signing, diagnostics and reopening used in this rollout.

Everything below is the preserved September 3 checkpoint and describes historical
state, not the current deployment.

## Historical handoff — 2026-09-03 08:20Z

Written at the end of the session that rolled out Order 3 (the wake bus) to Company41. It states exactly where
production, the node and this branch stand, what is blocked, and the rules the next session must keep. The full
narrative is in `RUNTIME-STEP-3-WAKE-BUS.md`; this file is the operational picture.

## Where things stand

**Order 3 is functionally complete and proven live.** All five entrypoints have executed on production against the
founder's own company: the human turn, the silent routine, the Company File listener, the room post and the agent
(coworker) message. The wake ceiling trip and the founder stop were both proven. The usage-limit sponsor handoff
is proven only by its SQL acceptance case, because it cannot be forced live without exhausting a real subscription.

**Production is deliberately quiesced.** OpenAI native admission is closed. Nothing executes until the blocker
below is resolved.

### Production (project `wovsmjvghnbcbfazdtvr`, company `88227549-9724-43c2-8966-9fafb3e855d6`)

| Item | State |
|---|---|
| Migration ledger | 139 entries, last `20260828030100` |
| Active runtime bundle | v5 `a881b7604cdd49b1da1b7d8ddf7934c2a37b583d67c122f8746ca93c1d47a962` |
| Admission | **closed**: `openai/native_subscription/codex-cli` disabled, policy version 11, reason in the row |
| Execution ceiling | version 3, 240 wakes per hour, no founder stop in force |
| Routines | silent five-minute routine `0547f21a…` paused (version 6); Company File listener `aaeb4582…` active on `notes/` |
| Room | `3fd81a40…` active, group session `15bd6492…`, founder plus two agents |
| Staff | four active agents on provider label `openai`; Co-Founder `52874779…` and `that agent` `3bd9862b…` still have no model |
| Authority | Research Lead `73757922…` configured on autonomous sponsor binding `0c2c8103…` version 1 |
| Runners | none active; all drained |
| Open occurrence | `709cc782…` from 2026-09-02 remains `requires_review` |

### Node `company41-node-01`

Running the **candidate-3.1 runtime**. Company provider service active.

| Pin | Value |
|---|---|
| Image fingerprint | `bfb19e81edb56e466176a8348480bb9a34aa51571f4dd42d4b16373192780c42` |
| Guest package manifest | `ec13e262821bce1b3853c94eb0f2f65601f3e20714a2d7ebb47329258337cd74` |
| Provider bundle | `9e8d313f7463f12bd071db3a3b93ab1af1fe3e040ccb4dba348b8773eb2e4869` |
| Provenance envelope | `2aa453249529b6e19d895e6881527d9d1366cd82785c44cedd286e7285fe06bb` |
| Runner version label | `2f609e404-production` |

Guests: orchestrator, the founder's custody host, the object gateway and the package build guest are running.
Zero job guests. The object gateway carries the room-aware bundle `0e84a094…`.

Candidate 3.2 is **staged but not active**: signed image `4fec3348…` (envelope `011672da…`), provider
`3a7dc4c5…` under `steps03-c32-fd33e05d6/`, activation script `activate-signed-image-fd33e05d6.sh`.

### Branch `fable/runtime-step3-wake-bus` (`~/work/Qorpera_Base-step3`)

Pushed and clean. `npm run check` passes. Candidate 3.1 is `2f609e404`; candidate 3.2 is `fd33e05d6`. The three
rejected provider builds `c00b263b3`, `7993748a7` and `0363f7674` remain in history and must not be revived.

## What is blocked, in priority order

**1. Every native run dies at the harness-execution stage.** The cloud records
`Native provider bridge request failed (422)`; the guest's native company host records
`Native provider execution harness-execution stage failed (unknown) [mouth=uninitialized]`. The harness dies
before producing anything, and the host never logs the underlying error by design.

Already eliminated: the teardown change (fails on both signed images and both provider builds), and the
runtime-bundle mismatch (runs failed while image and cloud bundle matched). No provider usage signal and no
sponsor handoff was recorded. Last successes were 07:19:06Z, 07:19:34Z and 07:39:38Z.

Leading hypothesis is the OpenAI Codex subscription behind provider connection `2e55091d…`. Ask the founder
first, because it costs nothing. If the subscription is healthy, capture the harness's own stderr by running the
pinned codex binary inside a job guest against the mounted credential; that is a credential-sensitive operator
step and needs founder approval before it touches a live identity.

**2. The deployed image and the active bundle disagree.** The cloud's active bundle is v5, whose content includes
the new runner units, but the node runs the candidate-3.1 image, whose guest package embeds v4
`c6b31877…`. No run has completed since v5 was activated, so no false provenance has been recorded yet, and
admission is closed to keep it that way. Resolve before reopening admission, by either activating the
candidate-3.2 image (which embeds v5) or shipping a bundle whose content matches the deployed image. Do not
revert the v5 ledger record.

**3. The job-guest teardown is implemented but unproven live.** The design is in place, but item 1 stopped its
acceptance. Note that `Restart=on-failure` became `Restart=no` on both runner units: a transient runner start
failure that used to be retried now powers the guest off instead. Exercise that path deliberately.

## Rules that carry forward

- Founder approval is required for production SQL, signing, releases, infrastructure changes, spend beyond
  ceilings, and any contract change.
- No patching a signed guest in place. No fabricated admissions. Never delete or mark reverted the
  production-only migration records. Keep admission paused until it is approved.
- Signing takes the passphrase from the macOS Keychain item `com.qorpera.company41.lxd-image-provenance`, piped
  to the signer's stdin only. Never print key or passphrase material, and redact long tokens from any output.
- Rollout packets are frozen and self-checking: the controller refuses to run unless the worktree is detached at
  the packet's own commit, the packet files match their pins, and all four release receipts are bound.
- The node's root path is the sudoers activation script: copy a script over `activate-signed-image.sh`, run it
  with `sudo -n`, then restore the canonical `activate-signed-image-2f609e404.sh` (`b7688b62…`) immediately.
- Reading production is read-only through the management API; writing production goes through the pinned
  Supabase CLI with a durable intent record beside every mutation.

## Where the artefacts are

**The session scratchpad has already been cleared.** It held the rollout packets v5 to v7 with their release
receipts, the three evidence bundles and their checksums, local copies of the signed envelopes, and the query and
packaging helpers. Do not look for it. What remains, and where:

- **This repository** is the durable record. Every artefact is identified by digest here and in
  `RUNTIME-STEP-3-WAKE-BUS.md`, and each one can be rebuilt from its pinned commit.
- **The node `company41-node-01`**, under `/home/company41-admin/step2-lxd`, still holds the guest tarballs, the
  build and verify recipe for every candidate, the proof directories `steps03-c3-7b9214d0c`,
  `steps03-c31-2f609e404` and `steps03-c32-*` with their provider packages, the signed provenance envelopes
  `lxd-image-provenance-2f609e404.json` and `lxd-image-provenance-fd33e05d6.json`, the activation scripts, and the
  build and verify logs. The active envelope is installed at `/etc/qorpera/lxd-company-image-provenance.json`, and
  the image acceptance state logs are under `/var/log/qorpera-lxd-runner-image-*.txt`.
- **Production** holds the effects that matter: the migration ledger, the runtime bundle rows, the runs and wake
  occurrences, the runner audit receipts from each drain, and the policy row whose reason names why admission is
  closed.
- **The rollout packet tooling** (`contract.mjs`, `controller.mjs`, `sql-packet.mjs`, `build-packet.mjs`,
  `freeze-packet.mjs`, `transport.mjs`) has never lived in this repository, which is why it did not survive.
  Earlier generations remain under
  `~/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/`
  as packets v2 to v4; v5 to v7 were derived from v4. The session transcript at
  `~/.claude/projects/-Users-jonas/cfb9d03e-6b15-43a6-8290-bb6d8b45b0ad.jsonl` carries the full text of the later
  packets and their receipts. **Whoever runs the next packet should put this tooling under version control
  first**, so a cleared scratchpad can never take the release path with it again.
