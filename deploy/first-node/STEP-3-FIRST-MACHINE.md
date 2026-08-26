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

## LIVE STATE at handoff (updated 2026-08-26 ~20:55Z — READ THIS FIRST)

The old diagnostic VM is still running on `company41-node-01` as
`qorpera-cc-6d9da3a0f09b4d63b79b8a3aad7919d9` at `10.41.0.217`, from
image `efe890d30817243af4466b7a4b00d802c46d55514e3eb7a5ffcb4e9d05229b2f`.
It was hot-patched only to prove the diagnosis and must not be presented as
the immutable result. The provider service remains active.

### Root cause and fixes completed

1. The identity volume is writable. The apparent `EROFS` came from the
   bootstrap unit's `ProtectSystem=strict`; its `ReadWritePaths` omitted
   `/var/lib/qorpera/identity`, `/var/lib/qorpera-runner`, and
   `/var/lib/qorpera-native-provider`.
2. Bootstrap synchronously started units ordered `After=bootstrap`, creating
   a systemd job deadlock. Service starts now use `systemctl start --no-block`.
3. Runner, sync, and screens imported a helper from the executable bootstrap
   entrypoint, so bundled services also ran bootstrap. The error formatter
   now lives in the side-effect-free guest module.
4. The Company Computer runner also imported its signal helper from the
   standalone executable runner entrypoint. It now owns a local signal
   wrapper and bundles no second main program.
5. The sync bundle requires `company-lock-heartbeat.mjs` beside it. The
   company package, installer, manifest, and tests now carry that artifact.
6. The clean-boot operator script now creates the 80 GiB verifier root
   atomically and treats systemd's nonzero `disabled` result as the expected
   state after the guest agent answers.

### Immutable replacement ready

- Guest package manifest:
  `93d06dc159d162e0bb50d433000b51f32aa44f616ea42ebeb5c6f4f2db0bb3a9`.
- New image fingerprint:
  `b75114594b82a76a57585f7c626855788b2be378d816c7e95d1ff788953bb1b0`.
  It exists in both the default and `qorpera-runners` LXD projects; the old
  image remains available for rollback.
- Clean-boot acceptance passed for the final script: all four guest services
  are disabled. Evidence is
  `deploy/first-node/evidence-first-machine-clean-boot.log`, SHA-256
  `f6b8463a31f04de502a8573c2ca4ff95ece984fbbc155fa799e963dcec904f08`,
  tested at `2026-08-26T20:48:00.000Z`.
- The diagnostic hot patch proved bootstrap, native provider, sync, screens,
  and a full Company File poll. Sync applied snapshot
  `11e7e3dd-d08e-490a-bbf6-cb5f00a10966` (`282 applied, 0 skipped`). The
  runner now reaches only the expected dormant-lane `401` because operator
  provisioning intentionally registers no runner session.
- `op-d-activate.sh` now performs a guarded replacement. It stops the
  provider, refuses a live assignment or unexpected image, backs up the
  journal, deletes only the disposable old VM root, preserves the identity
  volume, dataset, credentials, and rollback image, then provisions before
  restarting the service.

### Validation and current gate

- Focused shell tests: 16 passed.
- Packaging/script tests: 13 passed.
- Bash syntax, pinned dependencies, import boundaries, shrinkwrap,
  install-lock, and browser smoke passed.
- `npm run check` is not green on this inherited branch. It stops on five
  pre-existing unrelated Biome warnings; a direct typecheck then exposes the
  branch's pre-existing generated model-catalog failures (`ModelCatalog`/
  provider model data becoming `unknown`/`never`). No Step 3 file appears in
  either failure set.
- Signed provenance is the next gate. The signer correctly refuses a dirty
  tree and must name the commit containing these fixes. Repository rules
  require explicit user permission before committing. After permission:
  commit the explicit Step 3 paths (force-add the intentionally tracked
  `.log` evidence), run `npm run pack:lxd-provider`, sign with the fingerprint,
  evidence SHA, and tested-at above, copy the final `op-d-activate.sh` to the
  node, run it, then perform the watch-proof below.

### Durable identifiers and access

- Compute node: `company41-node-01`; LXD project: `qorpera-runners`.
- Logical computer: `6d9da3a0-f09b-4d63-b79b-8a3aad7919d9`.
- Company computer: `b13c3dc2-2bf0-4be0-8675-52bece89ee1a`.
- Compute identity: `50b6456a-3f13-4cd7-a671-a8619eb758d0`.
- Dataset: `companies/0d2053f0-c1a8-444d-99a8-68c8214e5414`.
- Screen viewer endpoint: `100.75.4.70:18446` over Tailscale.
- The temporary sudoers grant is
  `/etc/sudoers.d/qorpera-step3-first-machine`; remove it after the arc.

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
