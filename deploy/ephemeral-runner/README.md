# Qorpera ephemeral runner deployment

This package runs one single-lane Qorpera worker as a dedicated systemd user. Each leased job is executed by rootless Podman in a digest-pinned, networkless container. The included image is intentionally a `sandbox_probe` contract, not the future agent runtime: it proves immutable input mounting, private output publication, job completion, and cleanup before model credentials or arbitrary tools are introduced.

## What can be tested on Windows

`npm run pack:ephemeral-runner` bundles the service and container entrypoints. The focused tests exercise strict configuration, one-time credential handoff, durable authority restoration, cooperative shutdown, bounded container input, immutable substrate verification, and private output generation. They do not prove Linux namespaces, cgroups, seccomp, systemd, or rootless Podman.

## Linux host baseline

Use a disposable Linux VM before the NAS. The host must provide:

- Node.js 22.19 or newer at `/usr/bin/node`.
- Podman 5 or newer, local rather than remote, with rootless mode, seccomp, and cgroups v2.
- A dedicated `qorpera-runner` account with subordinate UID/GID ranges and lingering enabled.
- Cosign and registry authentication only on the image build/signing machine.

Podman documents that rootless systemd workloads belong in the user unit search path and that Quadlet/rootless operation requires cgroups v2. The worker follows the same dedicated-user model even though the long-running service is Node and it launches one disposable Podman container per job.

## Headless Linux containment test

No GUI or Computer Use automation is required. `sh scripts/test-ephemeral-runner-linux.sh` packages the two executables, pulls a digest-pinned Node base, builds the local probe image, runs the real `RootlessPodmanSandboxBackend`, and verifies read-only input, read-only image root, network isolation, cgroup CPU/memory/PID limits, private output, and container destruction. It also statically verifies the systemd unit when `systemd-analyze` is available.

`.github/workflows/ephemeral-runner-linux.yml` runs the same harness on the pinned `ubuntu-26.04` GitHub-hosted runner. That image currently supplies Podman 5 and cgroups v2; the harness still performs the runtime preflight and fails closed if the hosted image changes. A hosted workflow run proves the per-job container boundary, but not service-account lingering or recovery across a real host reboot.

## Build and sign the probe image

Choose a Node base image pinned by digest. The script refuses a mutable base image, pushes the result, signs the returned immutable digest, verifies the expected certificate identity and issuer, and prints the only image reference that should enter runner configuration.

```sh
export COSIGN_CERTIFICATE_IDENTITY_REGEXP='^https://github.com/Qorpera/.+/.github/workflows/.+@refs/heads/main$'
export COSIGN_CERTIFICATE_OIDC_ISSUER='https://token.actions.githubusercontent.com'
sh deploy/ephemeral-runner/build-and-sign-image.sh \
  'docker.io/library/node@sha256:BASE_DIGEST' \
  'REGISTRY/qorpera/sandbox-probe:BUILD_TAG'
```

Signing is not tested on Windows and requires a real registry plus an OIDC-capable Linux/CI environment.

## Install the dedicated user service

These commands are a Linux-VM runbook, not commands to run on the current Windows machine or an unprepared NAS.

1. Create the locked service account with home `/var/lib/qorpera-runner`, configure `/etc/subuid` and `/etc/subgid`, and enable lingering for that account.
2. Run `npm run pack:ephemeral-runner`, then install `.artifacts/ephemeral-runner/qorpera-ephemeral-runner.mjs` at `/opt/qorpera-runner/qorpera-ephemeral-runner.mjs`.
3. Install `qorpera-ephemeral-runner.service` in the service account's systemd user unit directory.
4. Copy `config.example.json` to `/var/lib/qorpera-runner/.config/qorpera-runner/config.json`, replace every placeholder, create the configured temporary directory, and set both to mode `0700`/`0600` under the service account.
5. Place the one-time runner activation token at `/var/lib/qorpera-runner/.config/credstore/qorpera-runner-activation` with mode `0600`. It is loaded through `LoadCredential=` and never passed in argv or the ordinary environment.
6. Reload and start the service through the `qorpera-runner` user manager. Once the runner is active and its private authority state exists, delete the credential-store source. Later restarts use rotated session authority from the private state file; the relative `LoadCredential=` declaration intentionally tolerates the now-absent one-time credential.

## Linux acceptance gate

Do not call this production-ready until a disposable Linux VM proves all of the following:

1. `podman info --format json` reports Linux, local service, rootless mode, seccomp, cgroups v2, and Podman 5+ under the service account.
2. The user unit starts at boot through lingering and stops cleanly on `SIGTERM` without losing a leased job.
3. A live `sandbox_probe` job materializes a real hosted substrate and publishes `sandbox-proof.json` into a child substrate.
4. The job container has no network, cannot mutate its input mounts or host filesystem, cannot exceed CPU/memory/PID/time bounds, and is removed after success, failure, cancellation, and worker restart.
5. The configured image digest passes the expected Cosign identity/issuer verification before activation.
6. Revoking the runner prevents the next heartbeat, claim, broker read, and completion.

The NAS remains out of scope until this gate passes on disposable hardware.
