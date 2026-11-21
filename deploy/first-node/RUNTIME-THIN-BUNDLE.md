# Thin Runtime Bundle Layer for Shared Execution Hosts

Decouples the ~6.5 MB runtime JavaScript bundle (~1.5 MB compressed) from the
1.82 GB LXD base OS image on shared execution hosts (`qorpera-exec-node01`,
`qorpera-exec-node02`) so runtime-JS-only releases no longer spend ~13 minutes
rebuilding, compressing, uploading, importing, and deleting a full 1.82 GB LXD
image.

## Architecture (Phase 1: Shared Execution Hosts)

1. **Base OS image (~1.82 GB, changes rarely):** Contains Ubuntu, Node.js,
   patched Codex binary (`/opt/qorpera-harnesses/native-company/codex`), Claude
   Code binary, AppArmor profiles (`/etc/apparmor.d/qorpera-claude-box-ns`),
   and `/opt/qorpera-runner/qorpera-claude-box-ns` + `qorpera-claude-box-stage.sh`.
2. **Thin host runtime bundle layer (`scripts/package-runtime-bundle-layer.mjs`):**
   Packages the exact 7 `/opt/qorpera-runner/*.mjs` host and bootstrap artifacts
   (`0555`) installed by `deploy/lxd-runner-guest/install-image-contract.sh` plus
   `manifest.json` (`0444`) in either form:
   - **Signed node-release flat archive (recommended):**
     `node scripts/package-runtime-bundle-layer.mjs --archive qorpera-runtime-bundle-layer.tar.gz`
     writes a flat POSIX ustar `.tar.gz` (~1.5 MB, deterministic tar stream and
     gzip header for a given Node/zlib build, flat filename matching
     `deploy/node-agent/qorpera-node-agent.mjs`'s `FILE_NAME` and well under
     `MAX_FILE_BYTES = 64 MiB`). `deploy/node-agent/make-release.mjs` hashes and
     Ed25519-signs the built archive bytes directly inside `release.json` +
     `release.sig`, and `qorpera-node-agent.mjs stage` verifies and installs it
     at `/opt/qorpera-node/releases/<revision>/qorpera-runtime-bundle-layer.tar.gz`.
   - **Verified directory:**
     `node scripts/package-runtime-bundle-layer.mjs --out <dir>` writes the
     unpacked directory plus `manifestSha256`.
   (`qorpera-sandbox-probe.mjs` and `run-job` live inside the OCI container
   image, not `/opt/qorpera-runner/`.)
3. **Fail-closed shared execution host rebuild (`deploy/shared-execution/rebuild-exec-host.sh`):**
   - Continues to run `lxc rebuild` from the immutable base OS image (fresh root
     disk, never relabelling an existing host; `QORPERA-RUNTIME-CONTRACT.md` §19).
   - Accepts EITHER:
     - `EXEC_RUNTIME_BUNDLE_ARCHIVE` + mandatory 64-hex pin
       `EXEC_RUNTIME_BUNDLE_ARCHIVE_SHA256` (from the Ed25519-signed node
       release's `release.json`), OR
     - `EXEC_RUNTIME_BUNDLE_DIR` + mandatory 64-hex pin
       `EXEC_RUNTIME_BUNDLE_MANIFEST_SHA256`.
     Both pins are independent of `EXEC_RUNTIME_BUNDLE_SHA256`, so pre-activation
     rolling-update rebuilds (where `EXEC_RUNTIME_BUNDLE_SHA256` is intentionally
     unset) remain cryptographically pinned. When `EXEC_RUNTIME_BUNDLE_SHA256` is
     also set, `manifest.runtimeBundleSha256` must match it as well. Setting both
     directory and archive modes is refused.
   - Preflight verifies physical path parity (no symlinked path or parent
     components), ownership, non-group/world-writable modes, exact 8-entry
     contents (`manifest.json` + the 7 `.mjs` files; archive mode rejects
     non-regular members, path separators, `..`, and >64 MiB compressed or
     uncompressed payloads via a bounded streaming reader), every artifact's
     byte length and SHA-256, and that `qorpera-native-provider-host.mjs` embeds
     `manifest.runtimeBundleSha256`.
   - Preflight snapshots the verified bytes into a root-only `0700` temporary
     directory (cleaned up on `EXIT`), then after `lxc rebuild` pushes only from
     that snapshot with `--mode 0555 --uid 0 --gid 0`, re-verifies every
     artifact's SHA-256 inside the guest (`sha256sum`), and runs `node --check`.
   - Never touches `/opt/qorpera-runner/qorpera-claude-box-ns`,
     `/opt/qorpera-runner/qorpera-claude-box-stage.sh`, or AppArmor profiles.
   - `deploy/shared-execution/create-exec-host.sh` explicitly unsets
     `EXEC_RUNTIME_BUNDLE_DIR`, `EXEC_RUNTIME_BUNDLE_MANIFEST_SHA256`,
     `EXEC_RUNTIME_BUNDLE_ARCHIVE`, and `EXEC_RUNTIME_BUNDLE_ARCHIVE_SHA256` so
     caller environment variables never leak into new host creation.

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
