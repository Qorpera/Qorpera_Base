# LXD runner guest image contract

This directory defines the Step 2 job-VM payload. It is a full Ubuntu 26.04 VM contract, not a system-container image and not a long-lived Company Computer.

Package the deployable payload by supplying the directory containing the
workflow-produced private OCI archive and Cosign bundle:

```sh
npm run pack:lxd-runner-guest -- \
  --signed-runner-image /absolute/path/to/private-signed-runner-artifact
```

`--contract-only` is reserved for the package-contract test: it emits the
manifest without the two large external files and is not deployable. A real
package emits a checksum manifest containing:

- the assignment-scoped runner, native-provider sidecar, sandbox probe, and root bootstrap bundles;
- three system units with separate `qorpera-runner` and `qorpera-native-provider` identities;
- a fixed shared execution group (`qorpera-native-execution`, GID 42041) used only for the disposable job workspace;
- the locked official Codex CLI 0.147.0 package graph;
- the Claude Code box's parts (slice C2 of `lanes/agent-box-20261113/CLAUDE-HOME-BUILD.md`): the pin of the unmodified
  Claude Code (`native-claude/artifact.json`, a copy of `deploy/first-node/native-claude/linux-x64-artifact.json`), its
  mount stage, its shell prefix (`qorpera-claude-home-shell.mjs`) and its namespace helper's AppArmor profile; and
- the fail-closed image-contract installer; and
- the exact keyless-signed OCI runner archive, its retained Cosign bundle, and
  a contract binding their hashes to the originating workflow identity and
  commit.

The archive is loaded into the `qorpera-runner` rootless Podman store while the
guest image is built. No registry credential is retained. Job execution uses
the immutable `name@sha256` reference with Podman's `--pull=never`, so a job VM
cannot substitute or fetch a different runner image at runtime.

The root bootstrap accepts credentials only after boot through the authenticated local LXD agent file API. The provider writes root-owned mode-0600 bootstrap inputs only after the VM is running; no secret is placed in cloud-init or persisted in LXD instance configuration. The bootstrap verifies that `/var/lib/qorpera/identity` is a distinct custom-volume mount bound to the requested Compute Identity, creates that identity's capsule master key there, installs the runner configuration under the runner account, then starts the native sidecar before the single-lane runner. The native sidecar receives the Supabase service key, bridge capability, and capsule key through systemd credentials. The runner receives only its activation, assignment, and loopback bridge capabilities.

Input material is group-readable but not group-writable. Only the private working copy and output tree are group-writable, allowing the separate native sidecar account to execute the official harness without granting it the runner's control-plane credential files.

The image never updates itself. The installer masks `apt-daily.timer`, `apt-daily-upgrade.timer`, `apt-daily.service`, `apt-daily-upgrade.service` and `unattended-upgrades.service` before it installs anything, refuses to continue while an apt job is still running, and proves at the end that each is a link from `/etc/systemd/system` to `/dev/null` and reported `masked`. Without this, the timers (Persistent=, with the build's stamps) catch up about 30 s after every fresh boot; unattended-upgrades then has needrestart restart the runner and native host mid-turn, and its shutdown inhibitor refuses the VM's poweroff, so the machine allocation is never released (run d1f454e2, 2026-09-24). The runner and login bootstraps check the same five links before reading any run authority and refuse with `RUNNER_IMAGE_SELF_UPDATE_ENABLED:<UNIT>`, which fails the provider's bootstrap step.

The harness package lock pins the official npm packages and their platform packages by registry integrity. Image installation uses `npm ci --ignore-scripts`, so dependency lifecycle scripts are not executed.

There is one Claude Code on the image: the build `native-claude/artifact.json` pins (never older than 2.1.311; older versions leak the sign-in in the box's set-up). The installer fetches its npm tarball, checks the tarball's size and npm integrity (sha512), takes `package/claude` out of it and installs it root-owned, mode 0555, at `/opt/qorpera-harnesses/native-claude/claude` with its `artifact.json` beside it; `/usr/local/bin/claude` (the node's own Claude sign-in path, `QORPERA_CLAUDE_PATH`) is a link to it. The harness package no longer carries Claude Code. Automatic Claude Code updates are disabled wherever it runs, so a running VM cannot drift from the signed image.

The Claude Code box also needs `sshfs` (with `fuse3`), its mount stage at `/opt/qorpera-runner/qorpera-claude-box-stage.sh`, and its namespace helper: `/opt/qorpera-runner/qorpera-claude-box-ns`, a copy of util-linux `unshare`, `root:qorpera-claude-box` mode 0750, with its AppArmor profile `/etc/apparmor.d/qorpera-claude-box-ns` (`userns,` for that one path; loaded by `apparmor.service` at every boot). The installer creates the `qorpera-claude-box` group; the shared execution installer adds each slot's host account to it, and the slot's host unit lets in `/dev/fuse` alone. Before it finishes, the installer checks every part (root's, its mode, every folder above it root's, the helper the same bytes as `unshare`, Claude Code the pin and its version), that the profile is loaded, and the box's own namespace start as an account of the group in a unit hardened like the slot's host: the helper makes the namespaces and mounts there, util-linux's own `unshare` cannot, and an account outside the group cannot run the helper.

The first-node candidate builder is `deploy/first-node/build-lxd-runner-image-candidate.sh`. It starts from the exact official-image fingerprint proven by the hardware smoke test, installs this contract in a temporary full VM, scrubs machine identity and SSH host keys, publishes a local content-addressed image, and deletes only its marker-owned builder VM. `deploy/first-node/verify-lxd-runner-image-candidate.sh` then clean-boots that fingerprint without an identity volume or credentials, verifies KVM plus UEFI Secure Boot, checks the pinned accounts and harness versions, and proves that every runner service remains inactive. Both scripts deliberately label the result `unsigned-candidate`. The provider must remain disabled until that exact accepted fingerprint receives signed provenance.

The NAS can remain offline for packaging, image construction, account/unit verification, and a no-job boot test. It can also remain offline for real Step 2 execution when every object consumer explicitly selects the Supabase-primary acceptance profile. Production remains NAS-primary with Supabase backup; in that profile an unavailable NAS fails closed and never triggers an implicit local or Supabase authority substitution.
