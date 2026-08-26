# Step 2 implementation handoff

**NO-FALLBACK LIVE FILE (v38) — active in interim copy mode; live flip
is one command awaiting the NAS export (2026-08-26 late night).**
Founder rejected the fallback: a DECLARED live tree that is missing now
FAILS the run loudly (runner) and instance creation (provider injects
the device unconditionally when configured); with NO declaration the
copy path is the legitimate mode, which is how v38 runs tonight
(fingerprint `6c97fcac…`, manifest `59d3edd2…`, provider bundle
`47be87ce…`, provenance signed; probe turn +16.6s/+52.9s). Every lane
uses the live tree when declared; proposal_review copies BY DESIGN
(hard isolation). NAS: 192.168.0.91 (Synology, SMB+DSM up, NFS OFF) —
no SSH key trust, founder Chrome extension not connected, so DSM
remains founder-clicks: enable NFS + share `qorpera-companies` + rw
for 192.168.0.206 squash map-all-to-admin. THEN:
`sudo -n ~/step2-lxd/activate-signed-image.sh` (the pinned script is
the FULL v38 activation: apt nfs-common done, showmount-discovers
export, fstab-mounts /mnt/qorpera-companies, seeds company41/live from
staged 284M, sets QORPERA_LXD_LIVE_COMPANY_ROOT+_PROFILE_ID, restarts,
healthz). Ops notes: deleting the previous unsigned image alias must
happen AFTER the next activation (I retired v36 early and briefly
broke turns — bridged with an interim v38 activation sans live keys);
node root disk was 100%% (34 stale candidates, 72GB freed); completed
runs still leak VMs (10 more deleted).


**LIVE COMPANY FILE — built, staged, awaiting the NAS share (2026-08-26
night).** Founder ruling sharpened: no copy-in/copy-out at all — "a
company file that is 3TB would be non-functional". Implemented: the
provider passes a host-mounted live tree into each runner VM as a rw
disk device (`company-live` → `/qorpera/company-live`, offered only
while the host path is a present directory; no uid shifting — the NAS
export squashes all writers to admin and the tree carries open modes),
declares it via runner env (QORPERA_LIVE_COMPANY_ROOT +
_PROFILE_ID), and the runner uses it directly for matching-profile
session turns: no materialize, no cp, no input-budget charge, git
repository persists across turns; proposal-review/foreign-profile/
mount-absent all degrade to the immutable copy-in path. Turn-end
capture still publishes snapshots from the live root (member-device
sync unchanged; backgrounding that capture is the next latency step).
Provider env: QORPERA_LXD_LIVE_COMPANY_ROOT=/mnt/qorpera-companies/
company41/live, .._PROFILE_ID=88227549-…. Image v37 built+accepted
(fingerprint `da6268b8…`, manifest `d6758b4b…`, provenance signed
`51f734cf…`); provider bundle v37 staged (sha `403b47cd…`); company
seed (284M, sans trail) staged; activation script v37 (installs
provider bundle, apt nfs-common, showmount-discovers the export,
fstab+mount, seeds once, env keys, restart, healthz) staged at
~/step2-lxd/activate-signed-image-v37.sh — copy over the pinned name
and run once the founder creates the `qorpera-companies` NFS export
(DSM instructions sent: enable NFS, share, rw for 192.168.0.206,
squash Map-all-to-admin). NODE HYGIENE: root disk hit 100% — 34 stale
unsigned image candidates deleted (72GB freed, now 25%); the build
script should delete the previous unsigned alias going forward. Also
moved trail-prelinear-backup out of the company tree on the founder
Mac (it was riding into snapshots) to ~/Companies/company41-backups/.


**TURN LATENCY CUT 190s→53s — image v36 + release 0.20.40 (2026-08-26 evening).**
Founder timed a ~20s queue, then minutes of silence, then everything at
once. Measured breakdown (runner_jobs created→started→finished): claim
+17s constant (LXD VM boot), finish +170-190s — with only 6s of CPU:
the runner spent ~97% waiting on network. Root cause: EVERY company
tree file fetched strictly sequentially (manifest GET + chunk GETs per
file, ~500 round trips through the guest→host-gateway double hop).
Fix: `materializeCloudCompanyTree` now fetches with a 12-worker bounded
pool (image v36, fingerprint `c51c2c94…`, manifest `eb914065…`,
provenance `e95db4fe…`). The publication capture side was already fine
(writeObject skips shas seen at checkout). App side (0.20.40): a staff
leaving the busy set on the 5s activity poll triggers an immediate
trail pull, so replies paint on completion instead of a sync tick
later. Verified live: probe turn created 16:11:58 → started +16.5s →
finished +53.2s, reply rendered seconds after settle. REMAINING: the
~17s claim is VM boot — a warm-standby VM needs a real design pass
(per-run bootstrap credentials are pinned pre-boot in the provenance
journal; injecting post-boot changes the trust story). Also recommend
the founder move `Recovery/` (139MB, 189 files — a pre-reimage dump)
out of the live company file: it is 99% of the tree bytes and the
agents keep getting distracted mapping it.


**CHILDLESS SESSION ANCHORS — ledger item 2 done for the attended lane
(2026-08-26, ~10:30 UTC+2, releases 0.20.35–0.20.39).** Opening a cloud
staff thread spawns NOTHING: `attachStaffChild` binds a process-less
`runtime.sessionAnchor` (a live TrailBinding — sync materializes
through it), `anchoredSessionRpc` answers the renderer's whole session
surface from the trail file (get_messages/get_fork_messages via
`trailSessionMessages` — active-chain walk; get_state from recorded
selections; set_model/set_thinking_level/set_session_name append to the
trail; prompts route through the shared `requestSponsoredCloudTurn`),
and `scheduleStaffThreadRefresh` tells the pane to reload when a cloud
reply materializes — no respawn, since there is no process holding
stale session state. Staff create/bootstrap/archive-next and the
wake/room restore path all anchor instead of spawning for cloud
profiles; `activeCompanyInfo`, the prompt-outbox trio, and connection
request identity derive their session from `attendedSessionBinding`.
Verified hands-off on released 0.20.39: thread history renders, a
composer prompt became cloud turn → "Release" reply auto-rendered, and
`ps` shows zero agent processes throughout. Protocol gotchas burned
into 0.20.36–0.20.38: anchor responses must ride the `rpc-event`
channel with a `type: "response"` envelope, and CDP-side monkey-patching
during verification can mask working signals — clean-boot verification
only. REMAINING of the local executor: wake/rooms/product-worker lanes
and non-cloud profiles still spawn `startLegacyPiSessionAttachment`;
they retire with the outbox consumer (ledger 3) and cloud wakes.

**THREAD IS THE CONVERSATION — founder's second cleanup list shipped
(2026-08-26, ~08:45 UTC+2, releases 0.20.33–0.20.34; image v35 cycle in
flight).** Per founder: the in-thread working avatar now runs for cloud
turns (hosted read model waiting/working + durable prompt queue drive
`syncThreadActivityFromCloud`; the activeRunProgress guard had to go —
history replay leaves it truthy for threads whose legacy-local runs
never settled, verified live via CDP before shipping); provider tags
are gone from bubbles and the thread header (provenance stays in
execution records); the sponsor selector is hidden (first active
connection sponsors); reasoning effort defaults to LOW — composer-side
(explicit member choice tracked via `effortChosen`; replayed
legacy-local levels no longer displace the default) and runner-side
(`codex exec -c model_reasoning_effort=low` in the guest provider
host → image v35). IMAGE v35 IS ACTIVE (fingerprint
`684ed97f5c9f6b9c0bdba1740074d8b5201c08e4797a574cbbc3ceb95eb683f2`,
manifest `65687d0d…`, provenance signed `18120bcc…`, activation script
now restarts the provider itself since the env file is start-time):
verified by live turn — run `12cecdf7` (job `84b13133`) booted from the
v35 fingerprint and completed. Zombie VM hygiene: completed runs keep
their VMs; deleted twice more today — the LxdClient delete op is the
standing fix.

**Incident 2026-08-26 06:03 UTC — apt-daily-upgrade bounced the
provider mid-turn.** The founder's live turn (job `1f80d0b2`) leased,
its VM was booting, and needrestart's service-restart wave (packagekit/
fwupd/ssh/journald batch) stopped `qorpera-lxd-provider` at 06:03:40;
the orphaned VM never renewed and the reaper failed the job with
"Runner lease expired before durable completion" (correct fail-closed
behavior; the durable output actually landed and the thread self-healed
after retry/sync). Mitigations: (1) NEEDS FOUNDER SUDO — pin the
provider against automatic restarts:
`sudo tee /etc/needrestart/conf.d/qorpera.conf` with
`$nrconf{override_rc}{qr(^qorpera-lxd-provider\.service$)} = 0;`
(deploys restart it explicitly); (2) nine zombie runner VMs from
completed/failed runs were deleted (`lxc delete --force --project
qorpera-runners`) — the missing LxdClient delete op keeps minting
these; the cleanup policy item is now urgent, not cosmetic.

**CONVERSATIONS RENDER WHOLE — closeout item 1 done, founder's UI list
verified (2026-08-26, ~08:00 UTC+2, releases 0.20.29–0.20.32).** Trail
materialization is now LINEAR per the founder's transcripts-are-simple-
chats ruling: hosted sequence order IS the conversation, every entry
chains onto the local leaf (`materializeSharedTrailSession`), runner/
peer-authored parent ids are ignored (they fragmented sessions into
parallel roots — the pane showed only the newest fragment, which was the
whole "replies don't render" bug), and identity dedupe compares content
without parentId. Verified live on released 0.20.32 by driving the app:
full New Agent history renders (4-bubble conversation including the
formerly quarantined entry), a fresh composer prompt showed exactly one
clean bubble, the avatar ran its working animation in BOTH sidebar and
thread header with "Working…", and the cloud reply ("Pong pong", Codex-
only provenance) rendered on completion with presence back to "Ready".
Hardening shipped alongside: `appendBoundTrailEntry` refuses to mint a
missing trail file from a live binding (a lingering pre-update process
recreated a session headerless during a cache heal — that class is now
impossible); the queued-prompt bubble hides once its durable copy
renders (compare against message text sans the rewind affordance).
Local trail caches for company41 were rebuilt from hosted truth (old
files + sync state + sessions-v3 read-model caches backed up in
`~/Companies/company41-88227549/trail-prelinear-backup/`); a fresh
device rebuild is exactly this path and produces the linear
conversation. Remaining ledger: items 2–7 below (childless anchors
next — the residual local child still spawns at open/boot and appends
runtime noise; it must go entirely).

**STEP 2 EXECUTION ARCHITECTURE COMPLETE (2026-08-26, 06:00 UTC+2).**
Per the founder's definition — cloud runners and headless execution as the
only execution — the architecture is delivered and verified end to end:
the publication turn closed the gate (run `632b71e2`, published, head
advanced); an attended prompt typed into the released 0.20.27 app became
cloud turn `f69e5228`, executed on the node under the member's Codex
subscription capsule with no local model runtime, completed with
transcript sequence 3, and surfaced as `completed` with presence `Ready`;
the local executor can no longer execute (the composer's local target is
removed, every staff prompt carries a cloud sponsor, and unsendable
prompts fail closed). Closeout list, in order: (1) cloud-turn replies
materializing into the thread pane (sync-down path; control plane and
header already show the truth); (2) childless session anchors — delete
the residual non-executing local child; (3) a control-plane prompt outbox
consumer for device-off staging; (4) conception as a cloud turn;
(5) presence fully cloud-derived; (6) the original acceptance matrix
(Claude login, second member, sponsor switching, revocation, offline
devices, storage/recovery gate); (7) the ratified live-company-file
model. Items 1–5 are the cloud-only ruling's mechanical completion;
6 validates; 7 is the next architecture step.

**FOUNDER RULINGS (2026-08-26, late): cloud-only execution and the live
company file.** (1) The local executor is removed entirely, not demoted:
an agent exists and works whether or not anyone has the app open; the app
is a window onto the agents, never their engine. Every attended prompt
becomes a cloud turn, presence reflects cloud runtime state, and prompts
staged with no device attached execute through a standing cloud consumer.
Headless cloud execution IS Step 2's identity. (2) The light file model is
ratified: agents work live on the company file; continuous background
snapshots (every turn end plus a timer) build the verified chain behind
the work with verification running asynchronously and alerting instead of
blocking; the publication gate survives only at outward effects,
member-device sync anchors, and hard-isolation lanes. The per-turn
materialize/copy/verify/stamp cycle for ordinary work retires. Sequencing:
the gate model remains in force through the remaining acceptance items;
the live model implements immediately after.

**GATE CLOSED (2026-08-26):** the file-changing publication turn completed
end to end. Run `632b71e2-199d-42d1-9a8f-2fa1e893ee73` (marker
STEP2_V34E_PUBLICATION_PROBE_20260826, v34 image, attempt 1, no retries):
`company_disposition=published`, output snapshot
`0ede039c-5d14-4110-9c7d-c335b1647ee6` byte-exact at parent
`aea619f8` + 1 file / 38 bytes, publication row `published`, workspace head
advanced to the output snapshot, transcript sealed at sequence 33, lease
released. The final defect was the broker's internal call to the verifier
omitting its Authorization bearer for new-format service keys — the
runner-side verify had structurally never succeeded before this fix. The
remaining Step 2 gates are the functional acceptance matrix (second member,
Claude login, sponsor switching, revocation, offline devices) and the
storage/recovery production gate; the object-store divergence note below
(NAS-primary clients must dual-write or the stores drift) joins them.

**OPEN DESIGN QUESTION (2026-08-26, founder decision needed): the trail
execution fence vs unbound local content.** The control plane (migration
`20260820001000`) rejects every `shared-trail-entry-part` event lacking a
durable execution, with an explicit anti-smuggling rationale. The client
and its round-trip tests expect the opposite: attended chat drafts and
kernel-signed audit observations upload unbound (they have no execution by
nature). Both intents are deliberate and they contradict; since the fence
landed, every unbound upload has failed in production, and until tonight
the failure jammed all trail synchronization (the client now defers the
affected session's uploads instead — containment, not resolution).
Options: (a) narrow the fence to multi-part assembly only, letting
single-part unbound messages through under event-level validation;
(b) bind all attended turns through the session arbiter and give
kernel audits their own validated envelope, keeping the fence absolute;
(c) keep the fence and accept that unexecuted content stays local-only.
(b) is the strongest long-term shape; (a) is the pragmatic bridge.

**Handoff state:** v33 (image
`6cc1ae8b5d8e2b7bc13856a7d31747f7c4598cb80464bee2c34c2509f1385f75`,
guest manifest
`4d50d5c5eadd13f6f06eefa2f3ab7d8e5e3512d0da98351ac7bc6940e0d6bb27`,
source commit `c3f1125b5cefbef4b1e1e9c09cac7f8cd6739bdf`) is built,
signed, and active, and the image cycle runs fully autonomously through
the pinned sudoers entries. The first live member-sponsored Codex turn
completed end to end on v21 (see evidence below). The 2026-08-25
Supabase platform incident then became an involuntary resilience
acceptance campaign: successive publication probes each exposed exactly
one infrastructure defect, all fixed on this branch — v28 proved the
execution half (normalization passed; candidate tree byte-exact at
parent+1 file) and died to an unretried broker 503; v31 introduced
wall-clock retry budgets (cadence-sensitive actions fail fast, object
and completion paths ride out ~150s) and died to the broker function's
own internal credential resolving through the platform's shedding
key-management service; the runner-broker, runner-control, and
runner-orchestrator functions now prefer the locally-verified legacy
service-role JWT; v32 exposed the orchestrator destroying live workers
when only the delivery acknowledgment timed out (the long-standing
"lease expired with zero renewals" intermittent, caught by the v26
persistent guest journals and the host audit trail) — unknown-outcome
delivery failures now leave the worker running; v32c then executed and
captured **through** an active shedding wave and lost only its
two-minute job lease, so renewed leases now span six minutes
(migration `20260825211000`) and the guest retries renewals until the
lease itself is nearly gone. The v33 publication probe (turn request
`f4fe5078-6991-4a24-bdab-9a580a524e58`) is executing at handoff time:
candidate snapshot `b2f5e3c3` captured byte-exact, lease renewing on
the six-minute window through continuing platform waves, completion
sequence in flight. Step 2's remaining gates are that publication turn
completing, the functional acceptance matrix (second member, Claude
login, sponsor switching, revocation, offline devices), and the
storage/recovery production gate. Fenced `review_pending` runs from the
probe campaign (`86fd6d01`, plus any the campaign adds) and their kept
VMs on the node still need discard-and-delete once their evidence is no
longer wanted.

Publication-probe findings (2026-08-25): a turn that creates a company
file executed correctly but its output capture failed
`EACCES scandir .../work/company/step2-acceptance` and fenced as
`review_pending/partial_attempt_output` — correct fail-closed behavior
against a real defect. Root cause: the native harness runs as the
provider host's user and shares the workspace with the runner only
through the shared execution group, and entries the harness creates
carry no group bits. Fixes on this branch: the sandbox (podman) lane
reclaims workspace ownership through the user namespace after container
removal, and the native lane's provider host grants group read/traversal
over the company root after harness execution (and best-effort after a
failure so fenced review output stays readable). Both are in the v23
guest. Migration history is now in parity with the hosted project (the
pre-handoff product-feedback hotfixes are fetched into the repository,
and the lease-renewal migration content that had been applied without a
version row is recorded); runner lease renewal is confirmed live by
`job_lease_renewed` audit receipts. Three fenced `review_pending` runs
(the v20 smoke and both publication probes) await explicit
resolve-or-discard, and per-run VM cleanup verification on the node
(`lxc list` for lingering `qorpera-*` workers) is still owed.

Image-cycle log for the publication turn (2026-08-25, all signed and
activated in sequence): v23 fixed nothing observable because the host's
group-access walk died EPERM on runner-owned entries; v24 restricted the
walk to host-owned entries but the walk had already been dying on
unreadable runner-owned directories; v25 fixed the actual root cause —
the provider host service ran with UMask=0077, stripping the group bits
the setgid workspace sharing depends on — and made the walk tolerate
unreadable directories; v26 adds persistent guest journals (256M cap)
because volatile journald kept destroying the evidence for an
intermittent early runner exit that still kills roughly half of probe
attempts before the first 45s lease renewal (discovered at the 2-minute
lease expiry by the reconciler). The v26 journals are the instrument for
that remaining defect.

Continuation of the cycle log (2026-08-25, later): v27 gave broker
object reads a bounded transient retry; v28 made the provider host's
group-access walk fully per-entry tolerant and added its
`workspace-normalization` stage to the native service's safe-diagnostic
allowlist (every redacted bridge 422 since v23 had been that stage's own
failure hidden by its absence from the allowlist). The v28 probe then
established that execution, normalization, and capture are correct (see
handoff state) and that the remaining failures were all transport: a
single broker 503 after the candidate snapshot row destroyed the
attempt. v29 extended the same bounded transient retry to every broker
action and object write (safe because every mutating broker action
carries a client-generated identity the control plane dedupes on),
stopped resending object bytes the runner already proved durable in-run
(hash-verified materialization or completed upload; server-side revision
verification still proves reachability before publication), gave
orchestration claim renewals an in-lease retry, and added an image
pre-warm to activation (`lxc init` + delete of a throwaway instance) so
the first lane from a fresh image no longer pays the multi-minute unpack
that had been saturating the node and starving renewals. v30 moved
broker object reads onto short-lived signed URLs (opt-in header;
Supabase-storage primary only; the client verifies the SHA-256 it
addressed) so materializations no longer proxy every object's bytes
through the Edge Function — the load that repeatedly degraded the shared
project compute mid-attempt — and gave the guest runner's job-lease
renewals the same in-lease transient retry. The ephemeral-runner worker
change also ships in the v30 guest; the orchestrator changes are
installed in the management VM (bundle digest
`f4979b60b4b66d374a49c3ec014be45c3584dead93224f76d7f5b4d332013258`).

Poisoned-acquisition postmortem (2026-08-25): when a leased job's
renewals fail, the reconciler's pristine retry requeues the job, but the
LXD provider enforces one acquisition per immutable run id, so every
re-dispatch of the same run answers 422 until the dispatcher's terminal
attempt — runs `197b6745` and `0ba947a3` died this way (the second also
left its instance behind, and its wedged 10-minute dispatch held the
session row lock that blocked new turn submissions until the
orchestrator was restarted). The renewal retries remove the common
trigger, but the design tension between pristine requeue and
one-acquisition-per-run is unresolved; re-keying acquisitions by
assignment would change the runner-identity binding and must not be done
casually. All four fenced `review_pending` runs (v20 smoke, both v21/v22
probes, and `f118f945`) were resolved with
`qorpera_resolve_failed_execution_run(..., 'discard')`, and the node's
leftover run VMs were deleted.

Also on 2026-08-25: the node's accumulated job-VM graveyard (about 25
instances, a dozen still running since 2026-08-24) was deleted, which
also exercised the recovery boundary in anger — the login VM was
destroyed, the per-identity volume survived instance deletion as
designed, a fresh login VM was provisioned against the surviving master
key, and a member re-login resealed the credential capsule (first
attempt lost a race with the 15-minute login expiry; second attempt
completed). Cleanup policy remains unfinished: completed-run VMs were
stopped but kept, fenced-run VMs kept running indefinitely, and nothing
reclaims them.

Live-turn evidence (2026-08-25T00:28-00:33Z): turn/run
`489bfbae-5917-4e5d-b370-053696095c5b`, job `315ddd56`, session `14ea9baa`,
marker `STEP2_LXD_OPENAI_SMOKE_V21_RETRY_20260825`. Queued -> claimed ->
runner assigned (+17s, surviving the activation race via the new assign
retry) -> official Codex response -> canonical transcript sequence 4 with
execution provenance -> run and job `completed` on attempt 1 -> connection
lease released. Company disposition `unchanged`, so the output-publication
verifier path was not exercised by this turn; it is covered by the
producer-verifier golden contract test and by direct member and service
closure verifications of the head snapshot.

Defects found and fixed while reaching this state (all on this branch):
the verifier's user client authenticated storage with the retired legacy
anon key; interrupted checkpoint resumes never re-staged objects; upload
registration left phantom catalog rows when a byte upload died mid-stream
(manual heal applied; durable fix still open); the v21 activation script did
not rewrite the ephemeral runner image env pins; the orchestrator destroyed
freshly booted workers when assignment raced guest activation; and every
boundary redacted failures down to bare status codes, which repeatedly made
diagnosis needlessly hard. The remaining redaction, catalog-before-bytes,
and upload-retry work is listed below.

This file is the operational handoff for continuing Step 2. It does not replace
the architecture or acceptance specifications. Read these files in order:

1. [`STEP-2-ARCHITECTURE.md`](STEP-2-ARCHITECTURE.md) for the authoritative
   system boundary and scope;
2. [`../../supabase/NATIVE-SUBSCRIPTION-ACCEPTANCE.md`](../../supabase/NATIVE-SUBSCRIPTION-ACCEPTANCE.md)
   for the mandatory release gate;
3. this file for the exact implementation checkpoint and continuation order;
4. [`README.md`](README.md) for the first-node build, provenance, activation,
   storage, and recovery runbook.

Do not collapse the documented architecture into a desktop runner, a generic
model gateway, a shared provider credential, a mutable NAS checkout, or a
container-only boundary to shorten the remaining work. Step 3 must extend these
contracts rather than replace them. The ratified design goal for Step 3's
Company Computers — company-level tenancy, NAS-carried storage holding the
whole working Company File, shared agent visibility with per-identity
credential capsules, cloud-authoritative publication — is recorded in
[STEP-3-COMPANY-COMPUTERS.md](STEP-3-COMPANY-COMPUTERS.md).

## Repository checkpoint

- repository: `Qorpera/Qorpera_Base`
- branch: `codex/step2-first-node`
- draft pull request: [#81](https://github.com/Qorpera/Qorpera_Base/pull/81)
- deployed v20 source commit: `e98f7ac5624fe20bccd4e6e242cb070b30c25e32`
- source commits after v20:
  - `2eb7a15436fb9de47af64fb7898069943b27da00` fixes strict Company
    File references and adds regression coverage;
  - `e9a83b03fb2828a133224fc94583038f091c21ed` pins that corrected
    runner guest package in the image recipes;
  - `135b4fc7b40f70a0fd6859fb9400fbb42d820ebc` adds the shared
    producer-verifier golden contract test and runs it plus the full
    verifier suite in step2-lxd CI;
  - `ce721cb02` pins the v21 candidate recipe: the real keyless-signed
    runner image export and the v21 staging, builder, alias, and
    acceptance names.

The branch is clean and synchronized with its remote. Pull request #81 is
open, draft, and mergeable, and its checks pass. The private keyless-signed
image export ran for real via `workflow_dispatch`
([run 32775544896](https://github.com/Qorpera/Qorpera_Base/actions/runs/32775544896))
against source `135b4fc7b`; its Cosign bundle was independently verified
off-node with `cosign verify-blob`. Preserve v20 as the deployed boundary
until the v21 candidate completes every image gate.

## Intended architecture that must remain intact

```text
Windows/macOS cloud clients
        |
        v
Supabase control plane and canonical transcript
        |
        v
standalone Runner Orchestrator in its management VM
        |
        v
narrow first-node provider service (sole LXD administrator)
        |
        v
one isolated LXD full VM per execution lane
        |
        +-- official Codex or Claude native harness
        +-- identity-bound encrypted provider capsule
        +-- immutable Company File materialization
        +-- assignment lease, receipts, events, and output staging
        |
        v
strict Company File verifier -> canonical publication/transcript
```

Supabase remains authoritative for membership, sessions, turns, jobs, leases,
sponsor/provider bindings, transcript order, receipts, runner state, and the
immutable object catalog. The production object topology remains NAS-primary
with durable Supabase backup. Supabase-primary is an explicit acceptance mode,
not an implicit production fallback.

Personal subscription traffic must run through the official Codex or Claude
harness inside the VM. Pi and a generic Qorpera model gateway must not receive
or proxy it. A turn pins one sponsor, provider connection, Compute Identity,
native harness, and immutable Company File revision. Connections are not
pooled, substituted, or multiplied by creating more VMs.

## What deployed v20 proves

The v20 image has signed provenance and passed credential-free clean-boot
acceptance with these immutable values:

| Item | Value |
| --- | --- |
| LXD image fingerprint | `6bac8e025d6e8209129bba729844ee43dc67c5753bdb85c3873f4e55fd03d35d` |
| Base fingerprint | `7ef31bed9834094a06517d63b93434588049efcbe2ab5d67419a6167988b7d4f` |
| Guest manifest SHA-256 | `e05375e8fd4f0fd5fffed85a4de8286d4b5392bddefa58a5a2bafbeab4889144` |
| Acceptance evidence SHA-256 | `f0d36ff369993c3cf1d24e152694aa3f1dd8019c66abffc6cd489224cc7b23e7` |
| Build source | `e98f7ac5624fe20bccd4e6e242cb070b30c25e32`, clean tree |
| Boundary | KVM full VM, UEFI Secure Boot |
| Boot contents | credentials absent, identity volume absent, services fail closed |
| Official harnesses | Codex `0.147.0`, Claude Code `2.1.231` |

The provider service on `company41-node-01` is enabled and active. A real
OpenAI/Codex login was completed for one member, and a live hosted turn passed
through the durable orchestration and VM path:

- marker: `STEP2_LXD_OPENAI_SMOKE_20260824194856`
- turn/run: `8c7395be-3759-41db-8758-0283f97bacbe`
- job: `1858d48a-f94a-4992-b79c-cfd5a9ce680a`
- VM: `qorpera-8c7395be375941db87580283f97bacbe`
- reconstructed workspace: 515 files, about 416 MB
- candidate snapshot: `ef88bb27-29ec-45bc-bd0e-c847f1591ef6`
- reachability graph: `7adbbfe4-2248-4f20-abb2-cbb155a59c7f`
- graph: complete, 156 objects, 145,961,371 bytes

That run proved VM acquisition, assignment delivery, native authority renewal,
workspace reconstruction, native harness execution, candidate upload, durable
event recording, and authority release. It did not produce a canonical
assistant transcript entry. The run terminalized as failed and entered the
durable review path.

## Current blocker and already-committed correction

The v20 runner sent the candidate tree to `company-file-verifier`, which
returned HTTP 422 with `Invalid Company File reference`. Private reachability
metadata named `objects` had leaked into a public tree file reference. The
strict public reference permits exactly:

- `manifestSha256`;
- `fileSha256`;
- `bytes`;
- `mediaType`.

Commit `2eb7a1543` separates the private reachability helper data from the
serialized public reference. Commit `e9a83b03f` pins the resulting guest
package. Commit `135b4fc7b` adds the shared golden contract test
(`packages/shell/test/cloud-company-file-contract.test.ts`) that feeds the
producer's exact serialized tree through the deployed verifier closure and
asserts the v20 leak shape is rejected with `Invalid Company File reference`;
step2-lxd CI runs it and the full verifier suite on every pull request.
Focused Company File tests, verifier tests, package tests, `npm run check`,
and pull-request CI pass.

This correction is not deployed. The v21 candidate containing these commits
is packaged and staged off-node; the remaining work is the node build,
credential-free clean-boot acceptance, off-node signing, activation, and
live-turn evidence gates.

## Deterministic continuation sequence

Do not enable a candidate merely because it builds. Execute these gates in
order and retain redacted evidence for each one.

### 1. Reconfirm source and tests — done for v21

`npm run check`, the step2 focused vitest batches, the packaging tests, and
the verifier `node --test` suites pass at `ce721cb02`. The mandated shared
golden contract test exists (`cloud-company-file-contract.test.ts`) and runs
in step2-lxd CI, so the v20 serialization defect is rejected before any image
build.

### 2. Package and stage a fresh candidate — packaged for v21

The real signed export (run 32775544896) was downloaded, Cosign-verified
off-node, and pinned into `deploy/lxd-runner-guest/runner-image-contract.json`.
The v21 packages rebuild deterministically from the clean tree:

| Artifact | Value |
| --- | --- |
| Guest package manifest SHA-256 | `36aa29c8b5f8fd823e88d8cce6b74f3ae72c1944aa69b5f525f24c2e38e0b045` |
| Runner OCI archive SHA-256 | `c9370c825bdbd589bf0c1391e567b8f5ea8ba36161cc554b32fcfb235f046239` (84,122,624 bytes) |
| Cosign bundle SHA-256 | `98a00fefd625c9aceeadd746ee610682a8787e5ce85ec0a6ac513a354a7491ce` (10,639 bytes) |
| Nested runner image | `localhost/qorpera/sandbox-probe:135b4fc7b40f70a0fd6859fb9400fbb42d820ebc@sha256:adda31f15d111ed8a06d4d773bac9d8d309047e09862642a292068d62b9b60e1` |
| Provider package | unchanged from deployed pins (`cb1efa25…`, provenance tool `316006eb…`) |
| Orchestrator package | unchanged from deployed pins (`ec1378d2…`) |

The provider and orchestrator digests match the already-installed node pins,
so only the guest package changes for v21. The staged copy set (guest package,
v21-pinned build and verify scripts, `SHA256SUMS.v21`) is assembled under
`.artifacts/step2-lxd-staging-v21` on the Mac. Copy it to
`/home/company41-admin/step2-lxd` on `company41-node-01`, replacing any stale
`lxd-runner-guest-v21` directory, and re-verify `SHA256SUMS.v21` on the node.
Never overwrite or relabel v20.

### 3. Build and accept without credentials — next action

On the node, after the staged `SHA256SUMS.v21` re-verifies, run the reviewed
v21-pinned scripts through interactive `sudo`:

```sh
cd /home/company41-admin/step2-lxd
shasum -a 256 -c SHA256SUMS.v21
sudo bash build-lxd-runner-image-candidate.sh
sudo bash verify-lxd-runner-image-candidate.sh
```

Both scripts fail closed on a wrong hostname, staging digest, runner-image
reference, or an existing v21 alias. The acceptance VM must prove:

- full QEMU/KVM VM;
- UEFI Secure Boot;
- exact guest-package and nested OCI image digests;
- no provider credential;
- no Compute Identity volume;
- disabled native services and fail-closed boot.

Do not use the build VM or an earlier acceptance VM as evidence.

### 4. Sign off-node and activate the exact fingerprint

Create and sign provenance on the Mac using the approved off-node Ed25519 key.
The statement must bind the clean source commit, exact image fingerprint, guest
manifest, nested OCI image, keyless Cosign bundle, and retained clean-boot
evidence. Install only the public key and signed envelope on the node. Activate
only after independent verification succeeds.

For v21 the statement values are fixed except the two node build outputs
(image fingerprint and acceptance evidence digest):

```sh
node .artifacts/lxd-provider/qorpera-lxd-image-provenance.mjs create \
  --image-server local \
  --image-fingerprint REPLACE_V21_IMAGE_FINGERPRINT \
  --base-image-fingerprint 7ef31bed9834094a06517d63b93434588049efcbe2ab5d67419a6167988b7d4f \
  --guest-package-manifest-sha256 36aa29c8b5f8fd823e88d8cce6b74f3ae72c1944aa69b5f525f24c2e38e0b045 \
  --runner-image localhost/qorpera/sandbox-probe:135b4fc7b40f70a0fd6859fb9400fbb42d820ebc@sha256:adda31f15d111ed8a06d4d773bac9d8d309047e09862642a292068d62b9b60e1 \
  --runner-image-archive-sha256 c9370c825bdbd589bf0c1391e567b8f5ea8ba36161cc554b32fcfb235f046239 \
  --runner-image-cosign-bundle-sha256 98a00fefd625c9aceeadd746ee610682a8787e5ce85ec0a6ac513a354a7491ce \
  --source-repository https://github.com/Qorpera/Qorpera_Base.git \
  --source-commit "$(git rev-parse HEAD)" \
  --source-tree clean \
  --tested-at REPLACE_CANONICAL_UTC_TIMESTAMP \
  --acceptance-evidence-sha256 REPLACE_V21_ACCEPTANCE_EVIDENCE_SHA256 \
  --output lxd-image-statement.json
```

### 5. Repeat the live Codex turn

Use a new non-secret marker. Confirm all of the following without manual
database repair:

1. queued input becomes a durable run and job;
2. the orchestrator claims it and the provider creates an isolated VM;
3. the native connection lease remains valid throughout execution;
4. the exact Company File revision materializes and verifies;
5. the official Codex harness returns a real provider response;
6. the output snapshot and graph pass `company-file-verifier`;
7. the canonical transcript receives the assistant response and provenance;
8. the run and job reach `completed`;
9. the connection lease is released;
10. the worker is stopped, recycled, or deleted according to the recorded
    cleanup policy.

If the run fails, preserve the candidate and logs, but do not increment images
repeatedly from guesses. Reproduce the failed producer/verifier contract with a
small local fixture first.

## Step 2 work remaining after the immediate fix

The live Codex success is necessary but is not the Step 2 release gate. The
following work remains mandatory:

### Functional acceptance

- Complete one real member-owned Claude login and official Claude request.
- Use two real members and current Windows/macOS clients in one company.
- Execute both sponsors in one shared canonical session.
- Prove sponsor switching reconstructs context from the canonical transcript
  without sharing provider-native session authority.
- Prove both clients synchronize identical transcript content, hashes, run IDs,
  and immutable sponsor/provider provenance.
- Hold a connection lease and prove concurrency one prevents entitlement
  multiplication even when additional VMs are available.
- Revoke a connection before execution and during a held lease; prove future
  broker calls and renewals are denied without sponsor substitution.
- Repeat the real executions while every physical member device is offline.
- Record the required provider-policy/commercial approvals and a redacted
  evidence bundle.

### Storage and recovery production gate

- Verify the restored NAS object gateway and configure production explicitly as
  `QORPERA_OBJECT_STORAGE_PRIMARY=nas`.
- Prove immutable publication to NAS and durable replication to Supabase.
- Prove restore from Supabase to replacement NAS storage.
- Prove NAS failure closes access instead of silently moving authority.
- Test stale, replayed, wrong-company, wrong-identity, and unsigned recovery
  material.
- Perform a replacement-node drill that restores the same Compute Identity
  master key and decrypts existing capsules. Today loss of the persistent
  identity volume can lose capsule access; no fallback key may be synthesized.

### Operational and release gate

- Define and test marker-owned VM cleanup/recycling for success, failure,
  timeout, and ambiguous effects.
- Resolve or explicitly discard the v20 `review_pending` candidate.
- Propagate safe structured failure codes through verifier, broker, runner, and
  observability; the generic v20 broker 503 obscured the actionable 422.
- Reduce the approximately 11-minute, 416 MB workspace execution loop after
  correctness is proven.
- Run the real private keyless-signed image export workflow; a skipped CI job is
  not evidence.
- Update the acceptance documents with redacted immutable evidence.
- Remove draft status, review and merge pull request #81, then cut a release
  from the accepted source commit. Do not release directly from the deployed
  v20 source because it contains the rejected Company File serialization.

## Definition of Step 2 complete

Step 2 is complete only when every assertion in
`supabase/NATIVE-SUBSCRIPTION-ACCEPTANCE.md` passes. In compact form, two real
members must create cloud Member Compute Identities, complete isolated official
Codex and Claude login, run both sponsors in one canonical shared session,
observe identical responses and provenance across devices, switch sponsor while
preserving canonical context, prove concurrency fencing and revocation, and
repeat execution while all member devices are offline.

The NAS-disconnected Supabase-primary profile can prove this functional gate.
It cannot prove the separate NAS-primary production storage, replication,
restore, failover authorization, failback, or Compute Identity recovery gate.

Until both applicable gates pass, describe the system as a deployed control
plane and substantially proven compute boundary, not completed autonomous cloud
execution.
