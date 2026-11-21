# Thin Runtime Bundle Layer for Shared Execution Hosts

Decouples the ~6.5 MB runtime JavaScript bundle from the 1.82 GB LXD base OS
image on shared execution hosts (`qorpera-exec-node01`, `qorpera-exec-node02`)
so runtime-JS-only releases (prompt updates, tool wiring, orchestrator /
company-runtime logic) no longer spend ~13 minutes rebuilding, compressing,
uploading, importing, and deleting a full 1.82 GB LXD image.

## Architecture (Phase 1: Shared Execution Hosts)

1. **Base OS image (~1.82 GB, changes rarely):** Contains Ubuntu, Node.js,
   patched Codex binary (`/opt/qorpera-harnesses/native-company/codex`), Claude
   Code binary, AppArmor profiles (`/etc/apparmor.d/qorpera-claude-box-ns`),
   and `/opt/qorpera-runner/qorpera-claude-box-ns` + `qorpera-claude-box-stage.sh`.
2. **Thin host runtime bundle layer (`scripts/package-runtime-bundle-layer.mjs`):**
   Produces a verified directory (`qorpera.runtime-bundle-layer/v1`) holding
   `manifest.json` (`0444`) and the exact 7 `/opt/qorpera-runner/*.mjs` host and
   bootstrap artifacts (`0555`) installed by
   `deploy/lxd-runner-guest/install-image-contract.sh`, plus `manifestSha256`.
   (`qorpera-sandbox-probe.mjs` and `run-job` live inside the OCI container
   image, not `/opt/qorpera-runner/`.)
3. **Fail-closed shared execution host rebuild (`deploy/shared-execution/rebuild-exec-host.sh`):**
   - Continues to run `lxc rebuild` from the immutable base OS image (fresh root
     disk, never relabelling an existing host; `QORPERA-RUNTIME-CONTRACT.md` §19).
   - Accepts `EXEC_RUNTIME_BUNDLE_DIR` ONLY together with a mandatory external
     64-hex cryptographic pin `EXEC_RUNTIME_BUNDLE_MANIFEST_SHA256` (independent
     of `EXEC_RUNTIME_BUNDLE_SHA256`, so pre-activation rolling-update rebuilds
     where `EXEC_RUNTIME_BUNDLE_SHA256` is intentionally unset remain
     cryptographically pinned). When `EXEC_RUNTIME_BUNDLE_SHA256` is also set,
     `manifest.runtimeBundleSha256` must match it as well.
   - Preflight verifies physical path parity (no symlinked directory or parent
     components), ownership, non-group/world-writable modes, exact directory
     contents (`manifest.json` + the 7 `.mjs` files, rejecting extra files),
     `manifest.json` SHA-256 against `EXEC_RUNTIME_BUNDLE_MANIFEST_SHA256`,
     every artifact's byte length and SHA-256 via `O_NOFOLLOW`, and that both
     `qorpera-native-provider-host.mjs` and `qorpera-ephemeral-runner.mjs`
     embed `manifest.runtimeBundleSha256`.
   - Preflight snapshots the verified bytes into a root-only `0700` temporary
     directory (cleaned up on `EXIT`), then after `lxc rebuild` pushes only from
     that snapshot with `--mode 0555 --uid 0 --gid 0`, re-verifies every
     artifact's SHA-256 inside the guest (`sha256sum`), and runs `node --check`.
   - Never touches `/opt/qorpera-runner/qorpera-claude-box-ns`,
     `/opt/qorpera-runner/qorpera-claude-box-stage.sh`, or AppArmor profiles.
   - `deploy/shared-execution/create-exec-host.sh` explicitly unsets both
     `EXEC_RUNTIME_BUNDLE_DIR` and `EXEC_RUNTIME_BUNDLE_MANIFEST_SHA256` so
     caller environment variables never leak into new host creation.

Note: `deploy/node-agent/make-release.mjs` currently signs flat files only;
staging the verified directory on the node host and pinning it externally via
`EXEC_RUNTIME_BUNDLE_MANIFEST_SHA256` works today without changing the node
agent wire format.

## Deferred Phase 2: Ephemeral LXD VMs

Ephemeral per-run LXD VMs (`packages/runner-orchestrator/src/lxd-provider.ts`)
are intentionally NOT changed in this PR. Mounting a host directory into
governed LXD VMs requires a coordinated base-image and guest-bootstrap update
(allowlisting the read-only mount in `verifyCompanyGuest`, updating guest
systemd units and digest verification to execute from the overlay, recording
overlay authority in `LxdProviderJournal.lxd` for rolling upgrades, and
re-pinning `deploy/first-node/install-lxd-provider-host.sh`).

## When a Full Base OS Image Rebuild Is Still Required

Any diff touching `deploy/lxd-runner-guest/`, `deploy/claude-box/` (including
`qorpera-claude-box-stage.sh` and `qorpera-claude-box-ns`),
`deploy/first-node/native-codex/` (Codex binary / patch),
`deploy/first-node/native-claude/`, `deploy/ephemeral-runner/`, or
`package-lock.json` requires a full base OS image rebuild (`lxc publish
--compression zstd`).
