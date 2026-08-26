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
     `provisioning`, dataset `companies/0d2053f0-c1a8-444d-99a8-68c8214e5414`
   - `qorpera_describe_company_computer` and the screens list RPC verified
     with the real service key.
3. **Staged to `~/step3-lxd/` on the node**: complete guest package
   `lxd-company-computer-guest-v1` (manifest `3f142af5…fcb89f`, signed v34
   runner image nested, archive sha `c9370c82…46239` verified), provider
   artifact, unit, env example, installer, and the image build script.

## LIVE STATE at handoff (updated 2026-08-26 ~21:35Z — READ THIS FIRST)

The full first-machine watch proof passed. The immutable replacement is live
on `company41-node-01` as
`qorpera-cc-6d9da3a0f09b4d63b79b8a3aad7919d9`, at `10.41.0.218` while
running, from signed image
`b75114594b82a76a57585f7c626855788b2be378d816c7e95d1ff788953bb1b0`.
The old diagnostic VM root was deleted by the guarded activation; its image,
identity volume, dataset, credentials, and provider-journal backup remain.

### Signed immutable result

- Source commit: `e21a78e504396e823ff70cb6825baa2068465a65`.
- Guest package manifest:
  `93d06dc159d162e0bb50d433000b51f32aa44f616ea42ebeb5c6f4f2db0bb3a9`.
- Clean-boot evidence:
  `deploy/first-node/evidence-first-machine-clean-boot.log`, SHA-256
  `f6b8463a31f04de502a8573c2ca4ff95ece984fbbc155fa799e963dcec904f08`,
  tested at `2026-08-26T20:48:00.000Z`.
- Signed provenance SHA-256:
  `717d2927972e24c98d73027caee7a048b826be7f411e6b37a571bc30d1aaecb8`.
- Bootstrap, native provider, sync, and screens are active after boot. The
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

### Validation and remaining cleanup

- Original focused shell tests: 16 passed; packaging/script tests: 13 passed.
- Viewer-boundary regression tests: 11 passed across two focused files.
- `npm run check` still stops on the same five unrelated inherited Biome
  warnings. Direct typecheck still exposes only the inherited generated
  model-catalog `unknown`/`never` failures; neither changed Step 3 file appears
  in the error output.
- The temporary sudoers grant still needs an interactive owner removal:
  `sudo rm /etc/sudoers.d/qorpera-step3-first-machine` on
  `company41-node-01`.
- The proof used the current Step 3 development shell because the installed
  `/Applications/Qorpera Base.app` predates the screen IPC handlers. Package
  and install a fresh shell build before treating the installed app as the
  shipped surface.

### Durable identifiers and access

- Compute node: `company41-node-01`; LXD project: `qorpera-runners`.
- Logical computer: `6d9da3a0-f09b-4d63-b79b-8a3aad7919d9`.
- Company computer: `b13c3dc2-2bf0-4be0-8675-52bece89ee1a`.
- Compute identity: `50b6456a-3f13-4cd7-a671-a8619eb758d0`.
- Dataset: `companies/0d2053f0-c1a8-444d-99a8-68c8214e5414`.
- Screen viewer endpoint: `100.75.4.70:18446` over Tailscale.
- Current state: VM running and the rewoken Research Lead viewer left open.

The original operator plan below is historical. Use the live scripts in
`deploy/first-node/first-machine-ops/`, not the stale literal digests in the
copy-paste examples.

## Operator steps on the node (need sudo — Jonas)

Run in order; each is copy-paste.

**1. Dataset root** (local disk stands in for the NAS on this candidate;
moving to a real NAS later is rsync + one env change):

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

**4. Clean-boot acceptance evidence** (all four units must answer
`disabled`; the log file becomes the provenance evidence):

```bash
sudo bash -c 'lxc launch <FP> qorpera-cc-verify --vm --project qorpera-runners -p qorpera-company-computer-v1 2>&1 | tee /var/log/qorpera-cc-image-verify.log'
```

```bash
sleep 75 && sudo bash -c 'lxc exec qorpera-cc-verify --project qorpera-runners -- systemctl is-enabled qorpera-company-computer-bootstrap.service qorpera-company-computer-runner.service qorpera-company-computer-sync.service qorpera-company-computer-screens.service 2>&1 | tee -a /var/log/qorpera-cc-image-verify.log'
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
   list RPC with `[]` and the sync agent starts tracking the head.
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

- Dataset ownership over virtiofs: the guest bootstrap chowns the working
  directories from inside the VM; if virtiofs refuses, this surfaces in the
  bootstrap journal and we adjust host-side ownership.
- The screen viewer gateway binds `0.0.0.0:18446`; reachability from the
  Mac is over Tailscale (probed, 3 ms).
- The build script's builder needs outbound network (apt, Google's Chrome
  repository).
