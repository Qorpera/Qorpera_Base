# Office guest image installation

`scripts/package-company-computer.mjs` now includes a standalone root installer, `qorpera-office-image-install.cjs`. It installs the complete headless package into an unconfigured Linux guest with a running systemd manager. It requires already prepared OS/browser dependencies; it never downloads packages, changes dependency pins, installs credentials, adopts company state, enables services, creates an LXD image or activates an office.

## Reviewed inputs

The root-owned specification uses schema `qorpera.office-image-installation/v1` and exactly these fields:

| Field | Required value |
| --- | --- |
| `packageRoot` | Canonical absolute local staging directory |
| `packageManifestSha256` | Hash of the exact package manifest bytes |
| `uid`, `gid` | Dedicated guest identity matching the enrolled workbench mapping |
| `architecture` | `x64` or `arm64`, matching the running installer |
| `dependencies` | Explicit OS, package/version, browser-tree and executable digests |

`dependencies` contains `osReleaseSha256`, `dpkgManifestSha256`, `browserTreeSha256` and `executables`. The executable map has exactly the 16 paths in `OFFICE_IMAGE_EXECUTABLES` in `packages/runner-orchestrator/src/lxd-office-image-installation.ts`: Node, Bubblewrap, Tini, Bash, TigerVNC, XFCE session/window manager/configuration, D-Bus, X11 utilities, xdotool, scrot, systemctl, systemd-tmpfiles and the private Chromium executable.

The read-only `--measure-dependencies` command returns measurements for separate review. It hashes the OS release file, the C-locale `dpkg-query -W` package/version inventory, each required executable and the complete bounded `/usr/lib/qorpera-chromium` file tree. It checks local filesystems, root ownership, canonical paths, single-link regular files, write/set-ID permissions and stable metadata. Installation compares those measurements with the supplied pins; it never fills in missing pins or accepts changed measurements automatically. These checks do not measure every OS library byte. The final image fingerprint, provenance and physical acceptance must bind and test the complete OS/browser image.

The package manifest is closed and bounded. Every source artifact, including the running installer, must match its exact length and hash. Paths outside the fixed service/assets inventory or the pinned Playwright subtree, traversal, duplicated entries and missing required files are rejected. Playwright's actual package version must match its manifest. Empty inert dependency files are supported without weakening nonempty credential input checks.

## Image state and application

Use `/usr/bin/node <staged-installer> --check --spec <absolute-spec-path>` for a no-effect review. Source files and directory ancestry must be canonical, root-owned and protected from group/other writes. The image must have Node 22.19.0 or later, user namespaces enabled, the pinned executable/browser dependencies and inactive office units. Existing office mounts, credentials, adoption/preparation records, company bytes, known compute-identity paths or running processes under the intended UID prevent image installation.

`--apply --spec <absolute-spec-path>` takes a real kernel flock before publishing files. The internal `--locked` stage requires that inherited lock and cannot be authorized by a flag or an unlocked file. The dedicated `qorpera-office` account has a locked password, no home, a nologin shell and no supplementary groups. The installer refuses an interactive account, shared/reused UID/GID or changed identity. It does not chown NAS state.

Code and Playwright resources go under `/opt/qorpera-office`; the browser child, wrappers, policy and wallpapers go to the exact `/usr/local` and `/usr/share/backgrounds` paths consumed by the runtime. Units are installed under `/etc/systemd/system` and immutable reference copies remain under `/opt/qorpera-office` for root preparation/service control. Existing installed files must be identical and are not replaced. Publication uses root-protected staging, fsync and atomic rename. The receipt records every destination, hash, length and mode, plus the reviewed specification/dependency identity.

Two tmpfiles fragments create empty root-only credential/preparation custody and private service-owned display, browser and capture directories. The existing preparation control lock is never truncated. The ordinary service requires tmpfiles setup. The demand-mounted `run-qorpera\x2doffice-private.mount` supplies `/run/qorpera-office/private` as a 64 MiB tmpfs with `nosuid,nodev,noexec`, `0700` and the selected UID/GID. Explicit ordering avoids a cycle between local filesystem startup and tmpfiles setup and orders unmount at shutdown.

Application verifies the actual units, creates only the declared empty local custody paths, reloads systemd and leaves the office service disabled; preparation and the private mount also remain inactive. It cannot prepare an already configured guest as a new image. An identical unconfigured reinstall preserves installed inodes and the preparation lock. Image creation/sealing, cold-boot validation, dependency acquisition, LXD/KVM/Secure Boot acceptance and signing remain separate steps. Do not infer those from an installer receipt.

## Repeatable local acceptance

Run `QORPERA_OFFICE_SYSTEMD_TEST_IMAGE=<prepared-local-image-digest> node scripts/test-office-image-installation-systemd.mjs`. The command packages the checkout and uses a disposable systemd container with private cgroups, no external network, no host cgroup bind and no production paths. Test dependency pins are measured only for that synthetic fixture. It checks exact installation and custody, unchanged reinstall, altered dependency pins, identity conflicts, inherited lock requirements, active mounts, unconfigured startup refusal, configured/company-state preservation and mount overrides. It also invokes the real preparation systemd manager to verify that the installed unit/reference contract is usable.

The actual tmpfs and systemd checks do not emulate NAS durability or a KVM image fingerprint. The existing runtime privacy, work-admission and adoption checks still govern every real guest startup.
