# The coding machine image (5f)

Every coding machine starts from this image: one LXD VM per member, coding agent, repository and setup digest
(`deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md`). `build-coding-image.sh` builds it on a node and
`test/prove-coding-image.sh` proves it on a test machine. Nothing makes a coding machine from it before 5g, which
installs the guest agent, makes the machines and runs the sessions.

## What the image holds

| Part | Why |
|---|---|
| Ubuntu 26.04 without cloud-init | A coding machine has no `/dev/lxd` (`security.devlxd=false`), so cloud-init would wait for it at every boot. The image brings what cloud-init gave: `10-qorpera-coding.yaml` (IPv4 by DHCP on the one card, no IPv6, no router advertisements), the hostname `qorpera-coding`, and `qorpera-grow-root.service`, which grows the root file system to the machine's disk at boot. The LXD agent runs without cloud-init. |
| Toolchains | The toolbox of every machine and the languages of a coding machine (the contract's 2026-10-14 amendment, items 7 and 11): C and C++ (`build-essential`, clang, CMake, autotools), Python 3 (venv, pip, pipx) with uv 0.13.1, Go, Rust and Cargo, Java (the default headless JDK), Ruby (gem, bundler), Node.js 24.21.0 with TypeScript 7.0.2 (`tsc`) and tsx 4.23.15, mise 2026.10.10 for any other language or version (into the user's home), LibreOffice (`soffice`, no GUI) and the usual command-line tools (ripgrep, fd, jq, sqlite3, curl, zip, unzip, rsync, strace and so on). The setup file installs the rest (5h). |
| git 2.56.0, the only git | Built from the pinned tarball into `/usr/local`, with its Rust parts. There is no `/etc/gitconfig`: the executor hands each command its git settings in the environment (`GIT_CONFIG_COUNT`, the plan's "The environment is the host's"). Its build libraries stay for agents. |
| Chromium 151.0.7922.34 | Chrome for Testing in `/usr/lib/qorpera-chromium`, `chromium` on the path. It runs with its sandbox as a session's user: `60-qorpera-coding.conf` lets unprivileged users make user namespaces (`kernel.apparmor_restrict_unprivileged_userns = 0`), which rootless Docker needs too. |
| tmux | Terminals the member watches (5g). |
| iproute2, nftables, fuse3 | Each session's network namespace (`ip netns`) and its rules (`nft`), and the folder program's mounts (5g). The image loads no rules of its own. |
| Docker for root | `docker.service` and `containerd.service`, enabled: `sudo docker` reaches this daemon. |
| Docker per session, rootless | Three user units, so every session's user manager has its own daemon, started on first use: `qorpera-docker.socket` (enabled for every user) listens at `/run/user/<uid>/docker.sock` (mode 0600), `qorpera-docker-proxy.service` carries each connection to `qorpera-dockerd.service`, which runs `dockerd-rootless.sh` (rootlesskit, slirp4netns) with its own socket under `/run/user/<uid>/docker-rootless/`. Compose v2 and buildx are installed. |
| Delegated controllers | `qorpera-delegate.conf` gives every `user@.service` the cpu, cpuset, io, memory and pids controllers, so a rootless container's `--memory` and `--cpus` hold. |
| NOPASSWD sudo | `qorpera-coding.sudoers`: the system group `qorpera-coding` may run anything as root without a password. 5g makes each session's user a member. |
| `qorpera-coding.slice` | From `../coding-worker/`: every session's slice (`qorpera-coding-<worker32>.slice`) sits under it, below 90% of memory and tasks. |
| Places for 5g | `/opt/qorpera-guest` (the guest agent), `/company` (empty; each unit binds the session's mount there), `/run/qorpera-folder/mounts` (the folder programs' mounts, made at boot by `qorpera-coding.tmpfiles`). |
| What is gone | apt's five self-update units are masked (the guest refuses an image where one is not). snapd, openssh-server, the cloud image's own git, the `ubuntu` account and cloud-init's sudoers file are removed, and so are the cloud image's LXD metadata templates, which would write `/etc/hostname`, `/etc/hosts` and cloud-init's seed into every machine made from the image, naming each after its instance. The build's logs, caches, apt lists, machine id and SSH host keys are cleared before the image is published. |

`coding-image.json` pins Node.js, git, Chromium, uv and mise by version, URL and sha-256, and TypeScript and tsx by
their exact npm versions (the company machine image's pins, `../machine/build-machine-image.sh`). To move one, change
its pin, build, and run the proof again. The code host (5e) builds its git from the same pin.

### Why socat carries the socket

`qorpera-docker-proxy.service` uses `socat` rather than `systemd-socket-proxyd`. When a client closes only its
sending side (`docker run -i` when its stdin ends), the daemon must see that half-close and still send the rest:
`systemd-socket-proxyd` closes the whole connection instead, and the output after it is lost. socat's `-t` is how long
a half-closed connection waits for the other side; its default is half a second, the unit's is 23 days.

## What 5g does for each session

The image expects this per session; `test/prove-in-coding-machine.sh` does exactly this, so it is a working example.

1. **The user.** A plain `/etc/passwd` user `qorpera-<uid>` with its own group (`groupadd -g <uid>`, then
   `useradd -u <uid> -g <uid> -G qorpera-coding -m -s /bin/bash -K SUB_UID_COUNT=0 -K SUB_GID_COUNT=0`): the login
   shell for tmux and terminals, the home on the machine's disk (`/home/qorpera-<uid>`, mode 0700), and the sudo group.
   It is made when missing and never deleted, so a uid that comes back finds its user. Not a `/run/userdb` record:
   with one, `pam_unix` refused the user's `user@<uid>.service` in the proof (`unix_chkpwd`: "could not obtain user
   info"); Ubuntu's AppArmor profile for `unix_chkpwd` reads `/run/host/userdb` but not `/run/userdb`.
2. **Sub-ids.** One 65536-wide range in `/etc/subuid` and `/etc/subgid`, the lowest free one from 1048576, above every
   session uid (`usermod --add-subuids <start>-<end> --add-subgids <start>-<end>`). Rootless Docker maps its
   containers' users there. No two users share a range. The image has none, and the `-K` options above keep useradd
   from handing out its own, which start at 100000, among the session uids.
3. **`/company` for the user manager.** A drop-in `/run/systemd/system/user@<uid>.service.d/qorpera-company.conf` with
   `[Service]` and `BindPaths=/run/qorpera-folder/mounts/<worker32>:/company`, written after the folder program's mount
   is up (an earlier bind holds the empty folder under it). Then the session's rootless containers bind the session's
   `/company`.
4. **The user manager.** `loginctl enable-linger qorpera-<uid>` starts `user@<uid>.service` and
   `/run/user/<uid>`; `disable-linger` stops them when the session leaves.
5. **Each command.** As the plan's units: the uid and gid, the session's slice, `ProtectProc=invisible`,
   `PrivateIPC=yes`, `BindPaths=<mount>:/company`, and in its environment `HOME`, `XDG_RUNTIME_DIR=/run/user/<uid>`,
   `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus` and `DOCKER_HOST=unix:///run/user/<uid>/docker.sock`.
6. **The session's network namespace.** Rootless Docker publishes a container's ports in its user manager's network
   namespace (rootlesskit's parent). For a published port to be on the session's own localhost, `user@<uid>.service`
   joins the session's namespace (a `NetworkNamespacePath=` line in the same drop-in). The proof runs without session
   namespaces, so 5g proves this.
7. **`security.devlxd=false`.** `coding-machine.ts` does not set it yet; 5g adds it to the machine's configuration (the
   proof makes its machine with it).

## Build it on a node

The coordinator runs these, with the coding project in place on the node (Q8: `coding`, listed in the node's
`codingMachineProjects`).

1. Build in the node's image build space while it is empty (on node 2, `qorpera-build` and `qorpera0`):
   `deploy/coding-machine/build-coding-image.sh qorpera-build qorpera0 qorpera-vm coding > image-build.json`
   - The builder is a build machine as `build-machine-image.sh`'s is: no profiles, its own 16 GiB root (the smallest
     coding machine disk, since a machine's root can't be smaller than its image), 4 CPUs and 4 GiB, the isolation NIC
     (its IPv6 filter needs `br_netfilter`, which nodes load at bootstrap), `boot.autostart=false`,
     `user.qorpera.image_builder=true`, and it is deleted on every exit path. The script refuses while the space holds
     anything else.
   - The image goes into the store of every coding project named, by export and import (same fingerprint) where that
     store is not the build space's. The build space keeps no copy unless it shares a coding project's store.
   - It takes about 10 minutes on the test machine (the git build, with Rust, is most of it).
2. The record (`qorpera.coding-image-build/v1`) names the alias, the image's fingerprint, the bootstrap digest (this
   script, the pins and every file it installs), the projects, the pinned versions and the 16 GiB root minimum. 5g's
   machine policy takes the fingerprint.

## Proof on the test machine

```
node scripts/run-on-node.mjs --machine node02 --sudo --no-install --no-status -- \
  bash deploy/coding-machine/test/prove-coding-image.sh </dev/null
```

It runs only on a test machine (`qorpera-testvm-*`). It claims two throwaway LXD projects (each with its own image
store), builds the image there with the builder's NIC filters off (`QORPERA_BUILDER_NIC=plain`, so LXD adds no nft
rule; a node's observer refuses such a builder), makes a coding machine from it on the test machine's own bridge
with `security.devlxd=false`, and runs `test/prove-in-coding-machine.sh` inside. The test machine's modules, sysctls,
nft ruleset, links and LXD state are listed before, while the machine runs and after both projects are deleted; any
difference between before and after fails the run. Other runs come and go on the same test machine, so Docker's rules
and links, the sysctls of links that come and go, and LXD projects that come and go are left out.

A test machine's bridge forwards nothing: Docker's `FORWARD` chain there drops by policy, and the proof may not change
the test machine's nft rules. So the builder and the machine reach the internet through `test/proof-proxy.py`, which
the proof runs as `nobody` on the bridge's own address for the run's length. It serves clients on the bridge only and
public addresses only: HTTPS by `CONNECT` to port 443, and plain HTTP to port 80 for apt. The build takes it as
`QORPERA_BUILD_PROXY` (apt options and the environment of the download step, so the image keeps none of it); inside
the machine, the proof gives both Docker daemons runtime drop-ins with it, and the compose build's client the same
environment (BuildKit has its client fetch registry tokens). A node's coding machine has no proxy: its traffic leaves
through its own card.

Result on node 2's test machine (15 Oct 2026, run `20261015T190638-82463-47437557`, 13 min with the build), ALL PASSED:
- the image (1761 MiB, `8c00dee8f8aa…`) built in 10 min and was in the coding project's store;
- a machine from it booted to running in 68 s, its LXD agent answering without cloud-init; no `/dev/lxd`; the root
  grew to the disk; IPv4 by DHCP on its one card, no IPv6, DNS and HTTPS; apt's self-update units masked, no snapd,
  no failed unit;
- git 2.56.0 without system configuration, Node 24.21.0, Chromium 151.0.7922.34, Python 3.14.4, Go 1.26.8, Rust
  1.93.1, OpenJDK 25.0.4.1, tmux 3.6, Docker 29.1.3 with compose 2.40.3 and buildx 0.30.1;
- a session user `qorpera-200001` in `qorpera-coding` with its user manager, `/company` and the cpuset, cpu, io,
  memory and pids controllers; its commands run as uid 200001, and `sudo -n` gives root;
- its rootless daemon started on first use, `sudo docker` reached the system daemon, compose built and ran redis +
  web, stdin's end reached a container through the socket, a rootless container's memory and processor limits held,
  and `sudo docker` bound `/company` and the session's mount path;
- headless Chromium rendered as the session with its sandbox on; tmux and git ran as the session;
- the test machine's modules, sysctls, nft rules, links and LXD state were the same before and after.
