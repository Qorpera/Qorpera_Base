# Office guest image installation

`scripts/package-company-computer.mjs` now includes a standalone root installer, `qorpera-office-image-install.cjs`. It installs the complete headless package into an unconfigured Linux guest with a running systemd manager. It requires already prepared OS/browser dependencies; it never downloads packages, changes dependency pins, installs credentials, adopts company state, enables services, creates an LXD image or activates an office.

## The image's dependencies

[`office-image-dependencies.json`](office-image-dependencies.json) is the recipe for those dependencies: the Ubuntu base
by fingerprint, the apt packages, the pinned downloads (Node.js 24, Chrome for Testing at the Playwright build, uv and
mise, each by sha256), the npm tools (`typescript`, `tsx`) and the toolbox. The toolbox is what every computer's shell
runs (the 2026-10-14 amendment's item 7); each entry is a command and the flag that prints its version.
[`install-office-image-dependencies.sh`](install-office-image-dependencies.sh) installs the recipe offline, as root in
the guest being built and before this installer: it checks each download, installs the pushed apt closure, puts one
Node.js at `/usr/bin/node` (apt's `nodejs` is refused), masks the self-update units, turns swap off for good and runs
every toolbox check. `scripts/build-office-image-candidate.sh` fetches the inputs and runs both installers in a nested
VM on node01's test machine, then runs the same toolbox checks from a computer's shell under the office unit's
confinement ([`OFFICE-IMAGE-CANDIDATE.md`](../test-machine/OFFICE-IMAGE-CANDIDATE.md)). Changing the recipe needs a new
image generation.

## Reviewed inputs

The root-owned specification uses schema `qorpera.office-image-installation/v1` and exactly these fields:

| Field | Required value |
| --- | --- |
| `packageRoot` | Canonical absolute local staging directory |
| `packageManifestSha256` | Hash of the exact package manifest bytes |
| `uid`, `gid` | Dedicated guest identity matching the enrolled workbench mapping |
| `architecture` | `x64` or `arm64`, matching the running installer |
| `dependencies` | Explicit OS, package/version, browser-tree and executable digests |

`dependencies` contains `osReleaseSha256`, `dpkgManifestSha256`, `browserTreeSha256` and `executables`. The executable map has exactly the 18 paths in `OFFICE_IMAGE_EXECUTABLES` in `packages/runner-orchestrator/src/lxd-office-image-installation.ts`: Node, flock, Bubblewrap, Tini, Bash, TigerVNC, XFCE session/window manager/configuration, D-Bus, X11 utilities, xdotool, scrot, systemctl, systemd-tmpfiles, the AppArmor parser and the private Chromium executable.

The read-only `--measure-dependencies` command returns measurements for separate review. It hashes the OS release file, the C-locale `dpkg-query -W` package/version inventory, each required executable and the complete bounded `/usr/lib/qorpera-chromium` file tree. It checks local filesystems, root ownership, canonical paths, single-link regular files, write/set-ID permissions and stable metadata. Installation compares those measurements with the supplied pins; it never fills in missing pins or accepts changed measurements automatically. These checks do not measure every OS library byte. The final image fingerprint, provenance and physical acceptance must bind and test the complete OS/browser image.

The package manifest is closed and bounded. Every source artifact, including the running installer, must match its exact length and hash. Paths outside the fixed service/assets inventory or the pinned Playwright subtree, traversal, duplicated entries and missing required files are rejected. Playwright's actual package version must match its manifest. Empty inert dependency files are supported without weakening nonempty credential input checks.

The dependency inventory also pins `/usr/sbin/apparmor_parser`. The installer copies the measured `/usr/bin/bwrap` bytes to the private browser launcher, includes that copy in its installation receipt, installs the packaged enforcing AppArmor profile, and loads it when the kernel enables AppArmor. Ordinary Bubblewrap and system namespace restrictions remain unchanged. The service starts after AppArmor; on an enabled host, its browser startup gate requires the exact enforcing profile before granting execution. Chromium's own nested namespace and seccomp sandbox remain required. Managed policies are mounted at the Chromium, Chrome and Chrome for Testing locations.

## Image state and application

Use `/usr/bin/node <staged-installer> --check --spec <absolute-spec-path>` for a no-effect review. Source files and directory ancestry must be canonical, root-owned and protected from group/other writes. The image must have Node 22.19.0 or later, user namespaces enabled, the pinned executable/browser dependencies and inactive office units. Existing office mounts, credentials, adoption/preparation records, company bytes, known compute-identity paths or running processes under the intended UID prevent image installation.

`--apply --spec <absolute-spec-path>` takes a real kernel flock before publishing files. The internal `--locked` stage requires that inherited lock and cannot be authorized by a flag or an unlocked file. The dedicated `qorpera-office` account has a locked password, no home, a nologin shell and no supplementary groups. The installer refuses an interactive account, shared/reused UID/GID or changed identity. It does not chown NAS state.

Code and Playwright resources go under `/opt/qorpera-office`; the browser child, wrappers, policy and wallpapers go to the exact `/usr/local` and `/usr/share/backgrounds` paths consumed by the runtime. Units are installed under `/etc/systemd/system` and immutable reference copies remain under `/opt/qorpera-office` for root preparation/service control. Existing installed files must be identical and are not replaced. Publication uses root-protected staging, fsync and atomic rename. The receipt records every destination, hash, length and mode, plus the reviewed specification/dependency identity.

Two tmpfiles fragments create empty root-only credential/preparation custody and private service-owned display, browser and capture directories. The existing preparation control lock is never truncated. The ordinary service requires tmpfiles setup. The demand-mounted `run-qorpera\x2doffice-private.mount` supplies `/run/qorpera-office/private` as a 64 MiB tmpfs with `nosuid,nodev,noexec`, `0700` and the selected UID/GID. Explicit ordering avoids a cycle between local filesystem startup and tmpfiles setup and orders unmount at shutdown.

The image must never update itself. Before it installs anything, `--apply` masks `apt-daily.timer`, `apt-daily-upgrade.timer`, `apt-daily.service`, `apt-daily-upgrade.service` and `unattended-upgrades.service` (`systemctl mask`: links from `/etc/systemd/system` to `/dev/null`). It refuses with `OFFICE_IMAGE_APT_JOB_RUNNING` while an apt job is still running; it never stops one mid-upgrade. At the end it proves each link and that systemd reports it `masked` (`OFFICE_IMAGE_SELF_UPDATE_ENABLED` otherwise). Unmasked, the timers catch up on every boot from the build's stamps; unattended-upgrades then has needrestart restart the office under members, and its shutdown inhibitor refuses the VM's stop (run d1f454e2, 2026-09-24). The office service and preparation check the same five links before anything else and refuse with `RUNNER_IMAGE_SELF_UPDATE_ENABLED:<UNIT>`: the service as its first lifecycle stage (`image`), before any credential is read; preparation before it reads the provider's request. An office on an older image must get the masks before it receives v98+ office code: re-image it, or install a service-only or guest-code revision with the install tool version that masks; a code-only package revision still needs a re-image first. See "Before updating an office's code" in [README.md](README.md).

Application verifies the actual units, creates only the declared empty local custody paths, reloads systemd and leaves the office service disabled; preparation and the private mount also remain inactive. It cannot prepare an already configured guest as a new image. An identical unconfigured reinstall preserves installed inodes and the preparation lock. Image creation/sealing, cold-boot validation, dependency acquisition, LXD/KVM/Secure Boot acceptance and signing remain separate steps. Do not infer those from an installer receipt.

## The company folder

A package built with `--folder-program <built qorpera-folder>` carries the company folder (F3 4e-2): the folder
program, the root helper that mounts the folder for each desktop and command
(`qorpera-company-computer-folder-helper.mjs`), its socket and service, and the mount template
`qorpera-office-folder-mount@.service.in`. The packager takes only the program that
[`folder-program-linux-x64.json`](../folder-service/folder-program-linux-x64.json) pins; build it with
`scripts/build-folder-program.mjs`. The installer admits the five files all together or not at all
(`OFFICE_IMAGE_PACKAGE_INCOMPLETE`). The program goes to `/opt/qorpera-folder/qorpera-folder` (`0555`), the helper to
`/opt/qorpera-office` and the units to `/etc/systemd/system`. The mount template is rendered with the office account's
ids, like the private mount. The folder's units must be stopped and unmodified, like the office units. They have no
`[Install]`: the office service wants the helper's socket, and the helper starts one mount per computer.

The helper is root code, so it changes only with a new image. A code package never adds, changes or removes the
folder's files. A code package for a base that carries them is therefore also built with `--folder-program`, and its
provision is prepared with `--folder-mount-template <the base's template>`. The verifier renders that template and
refuses it unless the base carries exactly those bytes.

## Repeatable local acceptance

Run `QORPERA_OFFICE_SYSTEMD_TEST_IMAGE=<prepared-local-image-digest> node scripts/test-office-image-installation-systemd.mjs`. `scripts/fixtures/systemd-test-image.Dockerfile` builds the image (`deploy/test-machine/README.md`). The command packages the checkout and uses a disposable systemd container with private cgroups, no external network, no host cgroup bind and no production paths. Test dependency pins are measured only for that synthetic fixture. It checks exact installation and custody, unchanged reinstall, altered dependency pins, identity conflicts, inherited lock requirements, active mounts, unconfigured startup refusal, configured/company-state preservation and mount overrides. It also invokes the real preparation systemd manager to verify that the installed unit/reference contract is usable. The container runs without AppArmor, so run it on the operator test machine (`deploy/test-machine/README.md`) or a developer's Docker, never on a node that hosts companies.

The actual tmpfs and systemd checks do not emulate NAS durability or a KVM image fingerprint. The existing runtime privacy, work-admission and adoption checks still govern every real guest startup.
