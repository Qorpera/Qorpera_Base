# Step 3 Company Computers — session report (2026-08-26)

Produced by the dedicated Step 3 session continuing from
`STEP-3-SESSION-REPORT-2026-08-25.md`. Branch `step3/company-computers` at
`8975d0146` (21 commits on `439fadc1c`, all pushed to `github`); tsgo clean,
biome clean; the four company-computer shell suites hold 36 tests (12 sync +
12 screens + 8 guest composition + 4 member view), the full
runner-orchestrator suite is 66 passing, and `npm run test:scripts` is green
(13 passing — two package-pin tests were failing at this branch's base and
are repinned). Nothing applied to any Supabase project, no PR opened.
`github/master` moved ahead during the session (10 commits, none touching
the scope-3 base files); the branch was deliberately not rebased mid-work.

## What was built

**1. Delta-sync agent (scope 3 — complete).** `0ca6465f5`
`packages/shell/src/cloud-company-computer-sync.ts` + colocated test.
- `syncCloudCompanyComputerCheckout`: one-directional fast-forward of the
  standing checkout toward the verified head over a caller-supplied
  `CloudContentAddressedStore`, diffed with the additively exported
  `sameEntry`/`entryMap`/`comparePath` from `cloud-company-merge.ts`.
- Head resolver interface + `hostedCompanyComputerHeadResolver` enforcing
  head = `qorpera_company_files.head_snapshot_id`, ready-state only, and
  `publicationState === "published"` (a non-published head throws).
- Divergence guard: destructive transitions (overwrite, delete) require the
  disk state to match the last-applied record exactly; diverged paths are
  skipped and reported; reconciliation stays with capture/proposal.
- Schema-tagged atomic state (`qorpera.company-computer-sync/v1`) at the
  bootstrap-supplied `state_path`; staging under
  `companyRoot/.qorpera/w/cloud-sync-*` with stale-staging cleanup that never
  touches `cloud-merge-*` recovery journals; optional runtime-lock pattern
  mirrored from the merge path.
- `parseCloudCompanyComputerSyncConfig` + `runCloudCompanyComputerSyncAgent`
  consume exactly the `sync` block of `qorpera.company-computer-bootstrap/v1`
  (`company_root`, `state_path`, `poll_seconds`); unknown keys ignored for
  rolling upgrades. `initializeCloudCompanyComputerCheckout` prepares the
  checkout leaf (mkdir leaf-only + `git init`, required by the runtime lock)
  and fails closed when the dataset parent is not mounted.

**2. NAS dataset snapshot in the snapshotting window.** `2473e290c`
- `CompanyDatasetSnapshotClient` contract; the provider's `snapshotComputer`
  captures the dataset before the LXD root snapshot and fails closed if the
  working world cannot be captured; the closing lifecycle event records
  `dataset_captured` so a root-only snapshot never poses as a recovery point.
- `ExecCompanyDatasetSnapshotClient`: deployment-agnostic adapter running a
  command template (`{dataset}`/`{snapshot}` substituted per argument, no
  shell, both values pattern-locked). Client is optional; deployed behavior
  without it is unchanged byte-for-byte.

**3. Member read policies (draft migration, applied nowhere).** `763d8cf35`
`supabase/migrations/20260826120000_company_computer_read_policies.sql` —
member SELECT on `qorpera_company_computers` and
`qorpera_company_computer_events` via `qorpera_can_read_profile` (charter's
shared-visibility default); writes stay behind the RPCs; the node registry
stays service-plane only.

**4. Screens decision — prepared, then RATIFIED.** `5fabd89d3`, `d61cc2afe`
`deploy/first-node/STEP-3-SCREENS-DECISION.md` laid out transport and audit
options; the founder ratified the Grok model the same day (2026-08-26):
shared computer, individual screen per staff agent — transport option A
(per-screen TigerVNC/XFCE + noVNC embedding over capability-gated paths,
never public) and audit option 2 (transcript events + periodic
content-addressed keyframes). The audit option constrains only the durable
record: members always keep the direct, real-time watch-and-take-over path
into every screen. Mirrored in the charter's "Ratified decisions".

**5. Screens registry (first slice of the ratified build).** `2cf3145b4`
`supabase/migrations/20260826130000_company_computer_screens.sql` — draft
migration, applied nowhere: `qorpera_company_computer_screens` (one screen
per staff agent per computer, partial unique index), member RPCs
register/attach/detach/retire (staff validated against the
`qorpera_profile_staff` roster; unknown ids and missing authority answer
identically), and service-role `qorpera_claim_company_computer_screen` /
`qorpera_release_company_computer_screen` — the one-task-per-screen fence:
the claiming run must belong to the attached staff agent and target the
screen's computer; re-claims renew expiry silently; expired fences are
replaceable; release is goal-state idempotent. Registry events extend the
company-computer audit trail. Dispatch admission is untouched — the claim
RPC is the runtime fence, to be wired by the execution path.

**6. Guest screen agent (second stage of the ratified build).** `8754e8d9e`
`packages/shell/src/cloud-company-computer-screens.ts` + 8 colocated tests.
- `CloudCompanyComputerScreenManager` converges live desktop sessions to the
  registry via the new service-role `qorpera_list_company_computer_screens`
  RPC (`supabase/migrations/20260826140000_...`, draft, applied nowhere);
  crashed sessions relaunch on the next reconcile.
- `ExecCompanyComputerScreenLauncher` runs the image's per-screen desktop
  command ({ordinal}/{display}/{vnc_port} substituted per argument, no
  shell, SIGTERM with SIGKILL escalation); VNC convention: display :N,
  loopback port 5900+N.
- The viewer listener is the guest's only way in: raw TCP, one JSON attach
  handshake, connections accepted solely from the trusted host bridge
  address holding the provider-delivered viewer token (timing-safe compare),
  then a byte-for-byte pipe to the screen's loopback VNC socket. Live
  attachments are severed on shutdown so close never hangs.
- Provider: `screens` block added to `qorpera.company-computer-bootstrap/v1`
  (viewer_host/viewer_port/viewer_trusted_source/poll_seconds; viewer port
  default 8446, validated distinct from the assignment and native-bridge
  ports), plus a fourth per-computer credential `qorpera-screen-viewer`
  journaled and delivered like the assignment token.

**7. Image packaging pass (third stage of the ratified build).** `ce0d9a925`
(+ `a726ee2d5` repinning the provider/orchestrator install checksums that
were already stale at the branch base).
- The Company Computer image is a strict superset of the runner image:
  `scripts/package-lxd-company-computer-guest.mjs` nests the complete runner
  guest package under `runner/` (pinned by manifest hash) and layers the
  XFCE/TigerVNC desktop stack plus the guest services;
  `deploy/first-node/build-lxd-company-computer-image-candidate.sh` mirrors
  the runner candidate recipe, pin enforced in lockstep by the packer test.
- `packages/shell/src/cloud-company-computer-guest.ts` + three bundled
  mains: a root bootstrap oneshot (verifies delivered authority, refuses an
  unmounted dataset, hands working directories to the work account, starts
  the agents — the single entry point the provider enables), and the sync
  and screen agents running unprivileged with every input delivered through
  systemd `LoadCredential=`.
- Head resolution for the standing guest: new service-role
  `qorpera_company_computer_sync_head` RPC
  (`supabase/migrations/20260826150000_...`, draft, applied nowhere) —
  member head RPCs require a member session the guest does not have; the
  RPC is computer-scoped and published-only, and the agent re-checks.
- Object backend selection is explicit and fails closed:
  `QORPERA_OBJECT_STORAGE_PRIMARY=supabase` (service-key storage client,
  shipped in the unit for the acceptance profile) or `nas` (gateway URL +
  token via drop-in); anything else refuses.
- One deliberate sharing decision: the screens unit does NOT use PrivateTmp
  so runner-lane computer-use tasks can reach the screens' X sockets in
  `/tmp/.X11-unix` — one trust domain, per charter principle 2. The
  per-screen wrapper binds VNC to loopback only with `SecurityTypes None`
  inside that boundary; the token-gated viewer listener stays the sole
  remote path.

**8. Host-side screen viewer leg.** `8e0f022d3`
Members mint short-lived single-use view capabilities
(`qorpera_mint_company_computer_screen_view`, write access — the live
screen is take-over-able by design; hashed at rest, 120s expiry, redemption
audited). The host viewer gateway
(`packages/runner-orchestrator/src/lxd-screen-viewer-gateway.ts`) redeems
with provider authority, resolves the guest target from the provider
journal, opens the guest attach leg with the per-computer viewer token, and
pipes. The company-computer lane is now wired into the provider service:
`QORPERA_RUNNER_PROVIDER_BACKEND=lxd-company-computer` composes backend +
dataset-snapshot client + viewer gateway behind the same provenance checks.

**9. Turn execution on the shared machine.** `4f51c82de`
`parseCompanyComputerRunnerServiceConfig` maps the company service flavor
onto the reviewed ephemeral pipeline (dataset workbench as execution root —
per-job workspaces shared-visible and NAS-carried; job types default
`agent_turn`); `qorpera-company-computer-runner.service` runs it
LoadCredential-fed. The bootstrap oneshot prepares the full runner lane
(boundary enforcement, native-provider environment against the computer's
own compute identity, Compute Identity volume marker + master key, runner
config install) and starts native provider → runner → sync → screens.
Executing turns directly inside the standing checkout stays a deliberate
later execution-mode decision, entangled with the open publication-cadence
question — recorded, not silently decided.

**10. One-task-per-screen fence wiring + keyframe audit.** `13d9e9824`
A loopback occupancy broker on the guest hands the execution side its staff
agent's screen (DISPLAY coordinates; renewable lease; the control plane's
claim RPC stays the enforcement point). Each screen-agent poll tick
captures one screenshot per occupied live screen (scrot, no shell) and
records it via service-role
`qorpera_record_company_computer_screen_keyframe` as an ordinary artifact —
inheriting artifact retention/GC, attributed to the occupying run's
requesting user, bound run↔screen↔artifact in the registry trail.

**11. Member watch/drive path (below the renderer).** `eb46ccb39`
`packages/shell/src/cloud-company-computer-view.ts`:
`qorpera_describe_company_computer_screens` member RPC, capability mint
with the member session, the gateway view handshake handing over the raw
VNC session, and a loopback single-connection WebSocket bridge (hand-rolled
RFC 6455 server side) so a stock noVNC client can attach at a local URL.
The renderer embed itself is the remaining UI pass.

**12. Renderer UI pass: screen cards, live noVNC viewer, wallpaper.**
`eefaee298` (founder-directed). The agent sidepanel's computer section
upgrades to a screen card — the guest desktop's own wallpaper surface (grey
field, the agent's creature debossed letterpress-style), task dot, hover
Open pill, and a one-click attach card for agents without a screen. Opening
runs mint→gateway→bridge in the main process (screens:* IPC, per-window
bridge lifecycle) and the vendored noVNC (@novnc/novnc 1.7.0, MPL license
shipped) renders the live take-over session in a near-borderless overlay.
Guest desktops wear the matching qorpera-screen-wallpaper.svg (folio
debossed), rasterized at image build and applied inside each session's
D-Bus. The shell resolves the node's viewer gateway from the registry
(qorpera_compute_nodes.screen_viewer_endpoint, draft migration). Verified
end to end in a browser harness: live RFB framebuffer pixels through the
real guest listener → gateway → member connect → WebSocket bridge → noVNC.

**13. Chrome in the dock; per-agent creature wallpapers.** `8975d0146`
(founder-directed). google-chrome-stable installs from Google's signed apt
repository with the repository key shipped pinned in the guest package and
its primary fingerprint asserted at install; the dock defaults are Chrome /
files / terminal, and qorpera-chrome keeps one browser profile per screen
on the NAS dataset. Every screen's desktop wallpaper carries its owning
agent's creature — the cast is generated at package time from the shell's
own creature art, the derivation (template mapping, else stable identity
hash) is shared with the renderer via staffCharacterForIdentity, the
service screen listing carries the roster's template id (draft migration
20260826200000), and the screen agent keeps per-screen wallpaper files on
the dataset current with attachments; unowned screens get a stable
pseudo-random creature.

**14. Harness computer-use via the occupancy broker.** `ecac1c78e`
(founder-directed). A turn executing on the shared machine gets `DISPLAY`
(plus `QORPERA_SCREEN_ORDINAL`/`QORPERA_SCREEN_VNC_PORT`) automatically
whenever its staff agent has a screen attached. The chain: the worker
grew an optional `screenLease` provider seam (acquire after run
description is available, release in the outer finally);
`CompanyComputerScreenLeaseClient` occupies through the loopback broker,
renews every 4 minutes against the 10-minute fence TTL, and treats every
failure as headless (`undefined`) rather than failing the turn; the
native bridge serializes an `environment` field omit-when-empty so
ephemeral wire bytes are unchanged; the native provider service
validates it (uppercase names, ≤32 entries, values ≤4096 bytes, nothing
credential-shaped — the tolerant parser means old services ignore the
field, new services accept old requests); and the harness driver merges
it under an identity-boundary rule — any collision with HOME, the
capsule directories, or PATH is a hard error, never a shadow. Wired only
in the company runner main; the ephemeral lane has no lease provider and
is byte-identical. Runner-guest and company-computer image manifest pins
moved in lockstep (repin now covers build+verify runner recipes). Gate
battery: scripts 13/13, tsgo clean, 69 shell tests across the touched
suites, 66 runner-orchestrator, biome clean on shell src+test except one
pre-existing warning in `cloud-runner-container.test.ts` untouched by
this branch.

**15. Master merge + screens on demand.** `2868b1fa9`, then this stage
(founder-directed: "make sure any agent can use their computer/screen as
they need to"). First the merge: `github/master` landed the Step 2
session's cloud-only execution arc (releases 0.20.17–0.20.27, local
executor removal, live-file rulings recorded); only the two runner-image
pin lines conflicted (recomputed from the merged tree), and master's
applied trail migrations had taken 20260826020000/040000, so the
branch's draft migrations — applied nowhere — moved to
20260826110000–200000 keeping their internal order. Then the feature:
an agent without a screen is no longer turned away. The broker's occupy
path falls back to on-demand provisioning — new service-role
`qorpera_ensure_company_computer_screen`
(migration 20260826210000, draft): an existing attachment is returned,
a free screen is attached, or a new screen is registered directly
attached, bounded by the machine's declared capacity
(`screens.max_screens` in the bootstrap block, default 8, ordinals never
reused after retirement). On-demand attachments carry no member actor —
the registry's actor columns went nullable to model the execution plane
acting (base screens migration revised in place; it is a draft). The
screen agent provisions, converges the desktop inside a serialized
converge lock shared with the poll loop, and answers the grant only
once the display's loopback VNC socket accepts
(`waitForCompanyComputerScreenReady`, 10s bound), so a turn handed
DISPLAY never races the X server. Every failure — capacity, cloud,
session — still degrades to headless, never fails the turn. Wallpaper
identity follows automatically: the attachment makes the screen the
agent's, so the next converge dresses it in the agent's creature. 18
screens-suite tests (4 new), scripts 13/13, tsgo clean, company image
pin repinned.

**16. Screen power, machine power.** `7ae33c823` (founder model, this
stage: "they don't power on/off the company computer, but their own
screen/computer. when no screen is open, the company computer powers
off... agents work headlessly and can open their computer whenever they
want"). Screens gained a power state: `open` means the desktop session
should be live, `closed` keeps the row, attachment, and identity while
the desktop is down — nothing is lost across a close. The guest
converges desktops for open screens only, and every poll tick sweeps
untouched screens closed after the idle window
(`screens.idle_close_seconds`, default 900;
`qorpera_sweep_idle_company_computer_screens`, draft migration
20260826220000 alongside member `qorpera_open_company_computer_screen` /
`qorpera_close_company_computer_screen`; base screens draft revised for
the power columns, the claim fence now requires an open screen, and the
ensure RPC reopens on demand). On the host, the provider's reconcile
derives the machine's power from its screens: any open screen or live
assignment keeps the VM up; after `idlePowerOffSeconds` (default 300) of
none it stops with journal reason `idle`; a screen opening later powers
it back on, and a maintenance stop stays down until the operator acts —
power is a node-local physical fact in the journal, placement lifecycle
untouched. In the app, a closed screen's card dims with an Off chip, and
Open wakes it: power-open RPC, then the viewer keeps dialing while the
machine boots (up to 90s) before connecting. Suites: shell 618
(21 screens tests), orchestrator 68 (2 new power tests), scripts 13/13,
tsgo clean; orchestrator artifact and both image pins repinned. Noted
gap, deliberately untouched: runner-session re-activation across power
cycles rides the frozen runner-registration lease semantics — the
screens/viewer path is unaffected, but turn execution after a power
cycle needs that follow-up once Step 2 acceptance closes.

## Design decisions (charter trace)

- Sync is strictly one-directional; the working copy is never authority
  (principle 4). The divergence guard doubles as crash recovery: adopt-first
  ordering means an interrupted apply self-heals on the next poll with no
  journal or rollback machinery.
- Deletions are gated by `cloudCompanyPathBelongsToLogicalTree`: paths the
  current tree contract omits are machine-local state and are dropped from
  tracking, never deleted from disk. A head with an older tree contract than
  the applied state refuses to sync (would read omissions as mass deletions).
- Any sync-state corruption or loss degrades to adopt-or-skip — it can never
  cause local work to be overwritten.
- Dataset-first snapshot ordering inside the lifecycle window (principle 3:
  the dataset is the working world; the VM root is disposable).

## Blocked / deferred (with reasons)

- **Member subscriptions on the shared machine** (pickup item 4, founder-
  ratified 2026-08-25): extend the turn-RPC capsule rule (migration
  `20260821001000` ~lines 1024/1039) and `validateCloudRunnerWork`
  (orchestrator.ts ~line 1117) — **strictly after Step 2 acceptance closes**;
  payment structure stays out of the contracts.
- **Harness-side computer-use integration**: the harness resolving DISPLAY
  through the guest occupancy broker at 127.0.0.1:8447 is the matching
  execution-side follow-on to the now-complete member watch/drive surface.
- **Standing-checkout execution mode**: running turns inside the live
  `company/` checkout (instead of per-job workspaces on the workbench)
  removes per-turn materialization per charter principle 4, but requires
  the publication-cadence founder decision (charter open question) plus
  runtime-lock/capture semantics in the execution pipeline. Deliberately
  not decided silently.
- The image build now reaches dl.google.com for Chrome; the candidate
  recipe's builder VM already has network for apt, so no recipe change,
  but a fully offline build would need a vendored .deb.
- **Runner session re-activation after VM reboot past `pending`** — deferred
  deliberately this session: it changes runner-registration lease semantics
  shared with the Step 2 acceptance currently in flight in the parallel
  session; touching those contracts now risks the acceptance run.
- Idle power management for persistent VMs; pgTAP for the migrations
  (unrunnable until applied somewhere).

## NEXT SESSION PICKUP

1. Read this report; charter and Step 2 architecture as before. Built and
   pushed this session: delta-sync agent, dataset snapshots, screens
   registry + guest screen agent, image packaging, the runner lane on the
   shared machine, the host viewer leg wired into the provider service, the
   one-task-per-screen fence + keyframe audit, and the member watch/drive
   path down to a tested local noVNC bridge URL.
2. Harness computer-use is in (stage 14): DISPLAY lands in the turn's
   environment via the occupancy broker lease; Chrome and the dock are in.
   Remaining in-image niceties only (vendored Chrome .deb for offline
   builds; the nested native-host unit's PrivateTmp setting if X-socket
   access from that unit is ever needed).
3. If Step 2 acceptance has closed: the capsule rule + work validator
   extension as its own migration/PR (payment structure excluded), and
   runner reboot re-activation.
4. With the founder: the publication-cadence decision, which unlocks the
   standing-checkout execution mode.
5. Consider folding `github/master` (10 commits ahead) into the branch before
   the next build block; nothing upstream conflicts with scope-3 files today.
6. Deployment note: the first Company Computer image candidate can now be
   built end to end (package → stage → build-lxd-company-computer-image-
   candidate.sh) once a signed runner image directory is available; the
   provider service runs the lane with
   QORPERA_RUNNER_PROVIDER_BACKEND=lxd-company-computer.
