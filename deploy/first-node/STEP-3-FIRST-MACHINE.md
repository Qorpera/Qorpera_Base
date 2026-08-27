# Step 3 — the first live Company Computer

Goal (founder-directed 2026-08-26): build and prove the Company Computer
works, **without agents controlling it**. The proof is watching: machine
provisions from the control plane, screens come up on demand, the viewer
shows live pixels in the app, idle screens close themselves, and the
machine powers off when the last screen closes — then wakes when one opens.
The runner lane stays dormant (no runner session is registered by operator
provisioning), which also sidesteps the frozen lease-semantics follow-up.

## Already done (2026-08-26, from the Mac)

1. **Control plane applied**: draft migrations `20260826110000`–`220000`
   pushed to hosted project `wovsmjvghnbcbfazdtvr` — remote history was in
   exact parity, exactly the 12 drafts pending, all applied first-try.
2. **Registry seeded** (atomic operator insert, binding guard enforced):
   - compute node `company41-node-01`, adapter `lxd-company-computer`,
     `screen_viewer_endpoint=100.75.4.70:18446` (Tailscale)
   - company-owned compute identity `50b6456a-3f13-4cd7-a671-a8619eb758d0`
   - logical computer `6d9da3a0-f09b-4d63-b79b-8a3aad7919d9`
     (class `company_computer`, template `qorpera-company-computer-linux` v1)
   - company computer `b13c3dc2-2bf0-4be0-8675-52bece89ee1a`, lifecycle
     `provisioning`, initially registered against the local candidate dataset
     `companies/0d2053f0-c1a8-444d-99a8-68c8214e5414`
   - `qorpera_describe_company_computer` and the screens list RPC verified
     with the real service key.
3. **Staged to `~/step3-lxd/` on the node**: complete guest package
   `lxd-company-computer-guest-v1` (manifest `3f142af5…fcb89f`, signed v34
   runner image nested, archive sha `c9370c82…46239` verified), provider
   artifact, unit, env example, installer, and the image build script.

## LIVE STATE at handoff (verified 2026-08-27 — READ THIS FIRST)

The full first-machine watch proof passed and the direct-NAS activation is
complete. The current instance on `company41-node-01` is
`qorpera-cc-6d9da3a0f09b4d63b79b8a3aad7919d9`; it was `STOPPED` at the latest
read-only audit. Its expanded LXD configuration mounts
`/mnt/qorpera-companies/company41` directly at `/srv/qorpera/dataset`, and
its immutable base image is
`614dce363812ca0f32f39cb7eb7e6d2d4439a4c5b3fca633d2a2afa8f4a15ec2`.
The guarded relocation preserved the Compute Identity volume and deleted
only the disposable prior VM root.

### Historical first-machine signed result

- Source commit: `e21a78e504396e823ff70cb6825baa2068465a65`.
- Guest package manifest:
  `93d06dc159d162e0bb50d433000b51f32aa44f616ea42ebeb5c6f4f2db0bb3a9`.
- Clean-boot evidence:
  `deploy/first-node/evidence-first-machine-clean-boot.log`, SHA-256
  `f6b8463a31f04de502a8573c2ca4ff95ece984fbbc155fa799e963dcec904f08`,
  tested at `2026-08-26T20:48:00.000Z`.
- Signed provenance SHA-256:
  `717d2927972e24c98d73027caee7a048b826be7f411e6b37a571bc30d1aaecb8`.
- In that historical signed image, bootstrap, native provider, sync, and
  screens are active after boot. The direct-NAS replacement described below
  deliberately removes sync. The
  runner reaches only the expected dormant-lane `401`; operator provisioning
  intentionally registers no runner session.

### Screen and lifecycle proof

- Screen `a34c0c41-4e6a-45af-85bc-3035b9942abe` (Screen 1) is attached to
  Research Lead `73757922-d355-4eba-91aa-edf808a3124e`.
- The app resolved the assignment, redeemed a single-use view capability,
  and rendered live XFCE pixels through `100.75.4.70:18446`. The viewer title
  was `Research Lead's screen · Live · you can take over at any time`.
- A renderer-boundary defect initially canceled the main process's own random
  loopback WebSocket. The bridge now registers one exact 256-bit path URL,
  consumes it on the first upgrade, and leaves every other local request
  blocked. The focused boundary/view tests pass (11 tests).
- At `2026-08-26T21:26:18.349365Z`, the 15-minute idle sweep emitted
  `company_computer_screen_closed` with `source=idle`; Xvnc exited.
- At `2026-08-26T21:31:52Z`, five minutes later, LXD reported the VM
  `STOPPED` without an operator power command.
- The app emitted `company_computer_screen_opened` at
  `2026-08-26T21:32:42.685576Z`; LXD reported `RUNNING` at `21:33:51Z`,
  Screen 1 relaunched, and the live viewer reconnected at `21:33:53Z`.
- Migration `20260826230000_company_computer_screen_power_events.sql` is
  applied to hosted project `wovsmjvghnbcbfazdtvr`. It restores the complete
  Company Computer audit-event constraint after the earlier view/keyframe
  migrations accidentally omitted the later open/close event types.

### Desktop correction and current proof

The first live pixels above were only an XFCE background. That was not the
intended Company Computer desktop: the panel had rejected its invalid
`double` length value, GTK's image loader could not create its nested sandbox
because the screen service omitted `AF_NETLINK`, all displays shared one XFCE
state directory, and the stock terminal inherited a non-login account that
exited immediately.

The live machine is now hot-patched from the corrected source contract and
the complete product flow was repeated at `2026-08-26T22:37Z`:

- opening Research Lead's screen immediately renders the full-screen
  `Starting desktop` surface with an indeterminate progress bar;
- the exact-path loopback WebSocket allowlist hands that surface to the live
  noVNC session once the guest is ready;
- the resulting desktop has the attached Research Lead creature wallpaper,
  no raw XFCE icons, and a bottom Chrome / Files / Terminal dock;
- Chrome opened a real browser window and Files opened Thunar at the then-
  current `/srv/qorpera/dataset/workbench/` candidate path in the same
  viewer. The corrected image instead opens `/srv/qorpera/dataset/live`;
- the canonical `/usr/local/bin/qorpera-screen-session` was restored on the
  VM (no diagnostic wrapper remained) with SHA-256
  `a692db6ce579d86d52e3f731a4442f7d24de7a24dade8a94c06cf7fd384bb0e7`.
  The direct-NAS image below supersedes that historical proof-point script.

The direct-NAS guest package contract hashes to
`a18cbb67634c6f6bd88235c25b858466bff4b786d39ae6f7fa265b4bf11e237e`.
That generation was built, signed, and activated as the current image:

- source commit:
  `6854fb643551dc23e564cf606da342a7f11f46dd` (pushed to
  `origin/step3/company-computers`);
- image fingerprint:
  `614dce363812ca0f32f39cb7eb7e6d2d4439a4c5b3fca633d2a2afa8f4a15ec2`;
- clean-boot evidence SHA-256:
  `8b4e085ecb0597d370a05456422fe08262038f3b0557df13249e53410a24bd57`;
- signed provenance SHA-256:
  `06791a4535f1d58d62a7c9f26df3cf637bf46ac7d496201f6c64daa9a1442412`.

The provenance signature was verified off-node against the installed public
key and binds the exact fingerprint, guest manifest, runner pins, evidence,
and source commit above.

The later desktop and viewer corrections produce guest manifest
`12a62029aa35bc610965ad57944cca0fa85b8d3b045eb9e66b18cec356aa8721`.
They are now baked into the immutable v3 candidate:

- alias: `qorpera-company-computer-ubuntu-26.04-v3-unsigned`;
- fingerprint:
  `ec5821bef522ef95e820be7692833ac359b6d18b990a4310a214ca1087417c11`;
- clean-boot evidence:
  `deploy/first-node/evidence-first-machine-clean-boot-v3.log`, SHA-256
  `f7e46f4e97bd15550f603c7b0ad72b94bd9a2eac55874adefcdf144a00c92d51`,
  tested at `2026-08-27T06:16:08+00:00`;
- the image marker binds the guest manifest above, nested runner manifest
  `a0990ae7ddce3312a0213782892c8f7aee554c9a8e7fca4d03b0444e716d6b42`,
  Chrome `152.0.7977.64`, and desktop stack `xfce4-tigervnc-chrome`.

The clean VM booted with no failed systemd units; bootstrap, runner, and
screens remained disabled in the immutable image; Chrome, Thunar, Xfce
Terminal, and all three Qorpera launchers were executable. The uniquely named
verification VM was deleted after evidence capture. The live v2 VM remained
stopped and untouched. The v3 candidate is still unsigned and is not yet the
live machine root.

The post-merge correction also adds a first-class `refresh-image` provider
operation plus guarded `op-e-refresh-image.sh` procedure. It transitions an
idle machine through recovery while retaining the exact `company41` NAS
dataset and Compute Identity volume. Before lifecycle mutation it proves the
current root matches its journal, rejects a live assignment or open screen,
and confirms the signed target image exists in the LXD project. The old
`op-d` dataset relocation must not be replayed for this image update.
Migration `20260827010000_company_computer_image_refresh.sql` makes the idle
admission atomic against the existing screen-open and runner-lease row-lock
guards; it must be applied before the refresh operator is staged.

### Direct NAS correction (2026-08-27)

Step 2's honest NAS path is already live; no new point-to-point Ethernet
cable is required:

- Synology `192.168.0.91:/volume1/qorpera-companies` is mounted over the
  wired LAN on `company41-node-01` at `/mnt/qorpera-companies`;
- the existing company tree is `/mnt/qorpera-companies/company41/live` on
  the roughly 7 TB NAS volume;
- the NFS export maps shared access through GID 100 (`users`), matching the
  Step 2 service-account/`UMask=0007` contract.

The corrected Step 3 contract adopts `company41` as the registry dataset and
mounts that directory at `/srv/qorpera/dataset`; desktops, Thunar, terminals,
Podman turns, and native-harness turns all work directly in its `live`
subdirectory. The old publication-head sync service is retired, and ordinary
turn completion skips Company File capture/publication; the correction
migration also drops the obsolete service-only sync-head RPC. The provider has a
recovery-only `relocate-dataset` operation that requires no open screen or
live assignment, preserves the Compute Identity volume, deletes only the
disposable VM root, and recreates it from the newly signed image against the
existing NAS tree.

Rollback protection is active on the NAS itself. A read-only DSM audit on
2026-08-27 verified Synology Snapshot Replication 7.5.1-1915 schedules a
local snapshot of the complete `qorpera-companies` Btrfs shared folder every
six hours. One restore point was present, the next run was scheduled, and the
retention policy kept the first day plus hourly, daily, weekly, monthly, and
latest restore-point tiers. The optional provider-side snapshot command stays
unset intentionally: it would duplicate the authoritative NAS schedule. This
creates no per-turn latency and never substitutes a VM-root-only snapshot for
a real dataset rollback point.

Migration `20260827000000_company_computer_live_nas.sql` and the guarded
dataset relocation have already completed. The hosted registry and the live
instance now use dataset `company41`; do not rerun the prepare or relocate
phases. `op-d-phases/recover` remains a recovery procedure only for an
interrupted future relocation. Never edit the provider journal or delete the
identity volume manually.

### Validation and remaining cleanup

- Local review of the current correction passed `npm run check`, deployment
  shell and workflow-YAML validation, 51 provider/viewer tests, 121
  shell/desktop tests, and all four deterministic packaging contracts. The
  expanded Step 2 LXD workflow must repeat those checks after the PR update.
- Automatic rollback points are active through the independent six-hour
  Synology Snapshot Replication schedule on `qorpera-companies`; the optional
  provider-side snapshot command remains intentionally unconfigured.
- Signing and activating the clean-boot-accepted v3 immutable image remains
  release work. The already-live v2 image and direct NAS dataset must stay
  available until provenance verification and the guarded image refresh pass.
- The new atomic image-refresh migration is local and reviewed but not yet
  applied to hosted project `wovsmjvghnbcbfazdtvr`.
- The proof used the current Step 3 development shell because the installed
  `/Applications/Qorpera Base.app` predates the screen IPC handlers. Package
  and install a fresh shell build before treating the installed app as the
  shipped surface.

### Durable identifiers and access

- Compute node: `company41-node-01`; LXD project: `qorpera-runners`.
- Logical computer: `6d9da3a0-f09b-4d63-b79b-8a3aad7919d9`.
- Company computer: `b13c3dc2-2bf0-4be0-8675-52bece89ee1a`.
- Compute identity: `50b6456a-3f13-4cd7-a671-a8619eb758d0`.
- Registry and instance dataset: `company41`, backed by
  `/mnt/qorpera-companies/company41` on the NAS.
- Screen viewer endpoint: `100.75.4.70:18446` over Tailscale.
- Current observed state during the correction audit: VM stopped.

The original operator plan below is historical. `op-a-prepare.sh` still fails
closed because it encodes the obsolete local dataset/workbench cutover. The
guarded `op-d-activate.sh` direct-NAS activation has completed and must not be
replayed as an ordinary setup step.

## Historical operator transcript (do not run)

These commands document the original candidate. They are not the corrected
activation procedure.

**1. Historical candidate dataset root** (obsolete; do not recreate it for
the corrected image — use the already-mounted `company41` NAS root):

```bash
sudo install -d -o root -g root -m 0755 /srv/qorpera-nas /srv/qorpera-nas/companies /srv/qorpera-nas/companies/0d2053f0-c1a8-444d-99a8-68c8214e5414
```

**2. Build the image candidate** (apt + Chrome download inside the builder;
prints `fingerprint=<64 hex>` at the end — save it):

```bash
sudo bash ~/step3-lxd/build-lxd-company-computer-image-candidate.sh
```

**3. Copy the image into the runners project and create the profile**
(replace `<FP>` with the fingerprint):

```bash
sudo lxc image copy local:<FP> local: --project default --target-project qorpera-runners
```

```bash
sudo lxc profile create qorpera-company-computer-v1 --project qorpera-runners
```

```bash
sudo lxc profile device add qorpera-company-computer-v1 eth0 nic network=qorpera0 name=enp5s0 --project qorpera-runners
```

**4. Clean-boot acceptance evidence** (all three units must answer
`disabled`; the log file becomes the provenance evidence):

```bash
sudo bash -c 'lxc launch <FP> qorpera-cc-verify --vm --project qorpera-runners -p qorpera-company-computer-v1 2>&1 | tee /var/log/qorpera-cc-image-verify.log'
```

```bash
sleep 75 && sudo bash -c 'lxc exec qorpera-cc-verify --project qorpera-runners -- systemctl is-enabled qorpera-company-computer-bootstrap.service qorpera-company-computer-runner.service qorpera-company-computer-screens.service 2>&1 | tee -a /var/log/qorpera-cc-image-verify.log'
```

```bash
sudo lxc delete -f qorpera-cc-verify --project qorpera-runners && sudo sha256sum /var/log/qorpera-cc-image-verify.log
```

**5. Hand the fingerprint + evidence sha back** — the provenance statement
is created and signed on the Mac (Keychain signing key), and the signed
`lxd-company-image-provenance.json` comes back over scp; then:

```bash
sudo install -o root -g qorpera-provider -m 0640 ~/step3-lxd/lxd-company-image-provenance.json /etc/qorpera/lxd-company-image-provenance.json
```

**6. Install the company provider service** (separate artifact path, unit,
env, and state root — the Step 2 acceptance lane's provider is untouched):

```bash
sudo bash ~/step3-lxd/install-lxd-company-provider-host.sh
```

**7. Fill the environment** (secrets copied node-locally from the existing
provider env; nothing transits anywhere):

```bash
sudo cp /etc/qorpera/lxd-company-provider.env.example /etc/qorpera/lxd-company-provider.env
```

```bash
sudo bash -c 'set -a; source /etc/qorpera/lxd-provider.env; set +a; sed -i "s|https://REPLACE.supabase.co|https://wovsmjvghnbcbfazdtvr.supabase.co|; s|REPLACE_WITH_SERVICE_ROLE_SECRET|$QORPERA_SUPABASE_SERVICE_KEY|; s|REPLACE_WITH_PUBLISHABLE_KEY|$QORPERA_SUPABASE_PUBLISHABLE_KEY|" /etc/qorpera/lxd-company-provider.env'
```

```bash
sudo sed -i "s|REPLACE_WITH_ORCHESTRATOR_TO_PROVIDER_CAPABILITY|$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')|" /etc/qorpera/lxd-company-provider.env
```

```bash
sudo sed -i "s|REPLACE_AFTER_IMAGE_SIGNING|<FP>|; s|REPLACE_WITH_64_HEX_GUEST_PACKAGE_MANIFEST_DIGEST|3f142af55d20862413dc03143a384d8329802b732d03549fa2fbd760fcfcb89f|; s|REPLACE_WITH_DIGEST_PINNED_RUNNER_IMAGE|localhost/qorpera/sandbox-probe:135b4fc7b40f70a0fd6859fb9400fbb42d820ebc@sha256:adda31f15d111ed8a06d4d773bac9d8d309047e09862642a292068d62b9b60e1|; s|REPLACE_WITH_64_HEX_ARCHIVE_DIGEST|c9370c825bdbd589bf0c1391e567b8f5ea8ba36161cc554b32fcfb235f046239|; s|REPLACE_WITH_64_HEX_BUNDLE_DIGEST|98a00fefd625c9aceeadd746ee610682a8787e5ce85ec0a6ac513a354a7491ce|" /etc/qorpera/lxd-company-provider.env
```

**8. Start the service and provision the machine**:

```bash
sudo systemctl enable --now qorpera-lxd-company-provider.service && sudo journalctl -u qorpera-lxd-company-provider.service -n 20 --no-pager
```

```bash
sudo systemd-run --wait --pipe --property=User=qorpera-provider --property=Group=qorpera-provider --property=SupplementaryGroups=lxd --property=EnvironmentFile=/etc/qorpera/lxd-company-provider.env /usr/bin/node --jitless /opt/qorpera/company-provider/qorpera-lxd-provider.mjs provision 6d9da3a0-f09b-4d63-b79b-8a3aad7919d9
```

Expected: `provisioned 6d9da3a0-f09b-4d63-b79b-8a3aad7919d9`; the registry
lifecycle flips to `active` with `reason=operator_provision`.

## The proof (from the Mac, after provisioning)

1. Registry shows lifecycle `active`; the guest's screen agent answers the
   list RPC, and `/srv/qorpera/dataset/live` is the mounted `company41/live`
   tree with no sync service.
2. Open a screen (member RPC / app): the desktop launches, the wallpaper is
   the agent's creature, the viewer shows live pixels through
   `100.75.4.70:18446`.
3. Leave it idle 15 minutes → the screen closes itself (`source: idle`
   event); 5 minutes later the provider's self-reconcile powers the VM off
   (journal `lastStopReason: idle`).
4. Open a screen again → the machine powers back on, the screen comes up.
5. Runner lane: expected dormant — activation fails without a registered
   runner session (known, documented; real work later registers it via
   acquire). Not part of this proof.

## Watch-points

- Dataset sharing over the NFS-backed LXD disk device: the guest verifies GID
  100 and group access but never chowns, chmods, or creates the existing live
  tree. Hidden machine-state directories use setgid modes. Provider startup
  requires the configured root to be a mountpoint, and each create/recovery
  proves the target is an accessible read-write NFS directory before touching
  the VM. Any mount or group mismatch fails closed instead of creating local
  state.
- The screen viewer gateway binds `0.0.0.0:18446`; reachability from the
  Mac is over Tailscale (probed, 3 ms).
- The build script's builder needs outbound network (apt, Google's Chrome
  repository).
