# Thin Signed Runtime Bundle Layer

Decouples the ~6.5 MB runtime JavaScript bundle (`qorpera-native-provider-host.mjs`
and the 7 companion entrypoints + `run-job`) from the 1.82 GB LXD base runner OS
image (Ubuntu 26.04, Node.js, patched Codex, Claude Code 365 MB binary, bubblewrap,
fuse3/sshfs, and the AppArmor-pinned `/opt/qorpera-runner/qorpera-claude-box-ns`).

## Why

On prompt, tool-wording, or TypeScript runtime releases (`v269`, `#2006`, etc.),
the 1.82 GB base OS image does not change — only `/opt/qorpera-runner/*.mjs`
changes. Rebuilding, gzip-publishing, verifying, exporting, and transferring
1.82 GB across nodes added 7-10 minutes to every cut.

## Architecture & Security Invariants

1. **Packaging (`scripts/package-runtime-bundle-layer.mjs`)**:
   - Builds the exact 9 files (`RUNTIME_LAYER_FILES`) plus `manifest.json`
     (`schema: "qorpera.runtime-bundle-layer/v1"`, `runtimeBundleSha256`,
     per-file byte length and SHA-256) in ~3 seconds.
   - Distributed to nodes inside the existing Ed25519-signed node release
     (`deploy/node-agent/make-release.mjs`, `release.json` + `release.sig`).
2. **Shared execution host (`deploy/shared-execution/rebuild-exec-host.sh`)**:
   - Still executes `lxc rebuild` from the immutable base image (fresh root disk,
     never relabelled, preserving `QORPERA-RUNTIME-CONTRACT.md` §19).
   - When `EXEC_RUNTIME_BUNDLE_DIR` is set, preflight verifies `manifest.json`,
     rejects symlinks or missing/extra files, checks every artifact's SHA-256
     and byte size, and confirms `manifest.runtimeBundleSha256 === EXEC_RUNTIME_BUNDLE_SHA256`
     before stopping any unit.
   - After `install-shared-execution-guest.sh`, pushes the verified artifacts
     with mode `0555` (root:root) to `/opt/qorpera-runner/` and runs `node --check`
     on every `.mjs` file before starting `qorpera-shared-execution.service`.
   - Never touches `/opt/qorpera-runner/qorpera-claude-box-ns` or its AppArmor profile.
3. **Ephemeral LXD runner VMs (`packages/runner-orchestrator/src/lxd-provider.ts`)**:
   - Opt-in `QORPERA_LXD_RUNTIME_BUNDLE_DIR` + `QORPERA_LXD_RUNTIME_BUNDLE_SHA256`
     (required together, validated fail-closed).
   - Attaches a read-only (`readonly: "true"`) LXD disk device `"runtime-bundle"`
     mounted at `/opt/qorpera-runtime-bundle` and records
     `user.qorpera.runtime_bundle_sha256` in instance config.
   - `#assertInstanceAuthority` enforces exact device and config parity on every
     reconcile pass, refusing any drift.
   - Every run still verifies `identity.runtimeBundleSha256 === CLOUD_RUNTIME_BUNDLE_SHA256`
     inside `assertCloudRuntimeBundle` before starting provider work.
4. **Base image rebuilds**:
   - Required only when OS packages, harnesses (Codex/Claude), AppArmor, or
     systemd units change (`baseImageChanged: true` in `scripts/release-prep-plan.mjs`).
