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

## LIVE STATE at handoff (2026-08-26 ~16:00Z — read this first)

The deployment is mid-flight and hands-free. Everything below the operator
section describes the original plan; this block is what has ACTUALLY
happened and exactly what remains.

**Done:**
1. Control plane applied + seeded (see "Already done" below; ids there).
2. Rounds A ran clean: dataset root, provider service installed
   (`qorpera-lxd-company-provider.service`, disabled until provenance),
   `/etc/qorpera/lxd-company-provider.env` filled — fingerprint and the
   corrected manifest sha are patched in by op-c when it succeeds.
3. **Image built**: fingerprint
   `efe890d30817243af4466b7a4b00d802c46d55514e3eb7a5ffcb4e9d05229b2f`,
   built at commit `ccd357180` (the install-ordering fix: the nested
   runner layer installs node BEFORE the node-based verification — found
   by the first real build).
4. Guest package manifest is now
   `acd2cd013361a66fdd56e61b30ecaa3807c8da0610db33ba48b3c6a660fbb1f0`
   (recipe pin, env pin, and signer all updated).
5. **Sudo grant is live**: `/etc/sudoers.d/qorpera-step3-first-machine`
   lets `company41-admin` run the three op scripts NOPASSWD (the Step 2
   flow's grant also allows `/usr/sbin/lxc` and `journalctl` as root).
   Remove after activation:
   `sudo rm /etc/sudoers.d/qorpera-step3-first-machine`.

**In flight / remaining (in order):**
1. `sudo -n bash ~/step3-lxd/op-c-image.sh` — clean-boot acceptance
   (was running at handoff; check
   `/var/log/qorpera-cc-image-verify.log` and rerun if needed — it is
   idempotent). Success ends with `evidence sha256: <64hex>` and
   `OP-C-DONE`, and patches fingerprint+manifest sha into the env file.
   First fix applied mid-flight: the verify instance now declares its own
   root disk (the NIC-only profile has none; the provider adds root
   itself).
2. Sign the provenance from the Mac (clean committed tree required):
   `npm run pack:lxd-provider` then
   `node deploy/first-node/sign-company-image-provenance.mjs <fingerprint> <evidence-sha256> <tested-at-iso>`
   — reads the Ed25519 key from Keychain
   `com.qorpera.company41.lxd-image-provenance` (the stored value is
   base64url PKCS8 DER, reconstructed in-process), signs, and scp's the
   envelope to `~/step3-lxd/lxd-company-image-provenance.json` on the
   node.
3. `sudo -n bash ~/step3-lxd/op-d-activate.sh` — installs provenance,
   enables the service, provisions logical computer
   `6d9da3a0-f09b-4d63-b79b-8a3aad7919d9` via systemd-run, lists the VM.
4. The watch-proof below ("The proof").

**Session-local knowledge now committed:**
- `scripts/repin-deploy.mjs` — recomputes every deploy pin after any
  bundle-affecting change (run it, then `npm run test:scripts`).
- `deploy/first-node/first-machine-ops/` — the three op scripts (also
  staged on the node at `~/step3-lxd/`).
- `deploy/first-node/sign-company-image-provenance.mjs` — the signer.
- Supabase apply path: the CLI's own keyring login works
  (`npx supabase@latest …` with NO SUPABASE_ACCESS_TOKEN env — the
  Keychain item `supabase-cli-step2-temporary` is STALE and overrides the
  working login if exported). Management SQL endpoint works with the CLI
  keyring token (`api.supabase.com/v1/projects/wovsmjvghnbcbfazdtvr/database/query`).
- The Step 2 session works the same node concurrently (built runner v35
  during this arc); builds coexist but watch disk/load.
- Dev app for the visual proof: `packages/shell/dist` is built on this
  branch; run per the Step 2 dev-client convention
  (`QORPERA_RUNTIME_NODE=$(command -v node) npx electron dist/main.js`
  from `packages/shell`).

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
