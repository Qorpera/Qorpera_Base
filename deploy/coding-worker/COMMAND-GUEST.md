# Isolated coding command guest

The installation manifest describes a reviewed image prerequisite. This source
change installs no image or service. The trusted provider must bind each
session's config to the actual worker, machine and Linux boot, and own every
supervisor directory as root with mode 0755. A session's repository is owned by
that session's user. No office mount, member filesystem or provider token
belongs in this guest.

## Sessions on a member's machine

One coding machine per member (company, environment, member) carries all of
that member's sessions. Every path, unit and user of a session derives from its
worker id alone (`cloudCodingSessionLayout` in `@qorpera/contracts`): its NAS
data volume is attached at `/workspace/<workerId>`, its custody volume at
`/var/lib/qorpera-coding/<workerId>`, its boot-local configuration and lease live
under `/run/qorpera-coding/<workerId>`, its commands run in
`qorpera-coding-<worker32>.slice` (a child of `qorpera-coding.slice`) as units
named `qorpera-coding-<worker32>-<commandId>.service`, where `<worker32>` is the
worker id without dashes.

A session is attached only while its turn runs. The executor hot-plugs its two
NAS folders (LXD disk devices `data-<worker32>` and `custody-<worker32>`, virtiofs)
and waits until the guest has mounted both; the storage helper's `prepare`,
`install` and `initialize` actions then set it up. At the end of the turn the
helper's `detach` action stops the session's slice and sees it stopped, syncs,
and removes its boot-local configuration, lease and user; the executor then
unplugs its folders. The NAS folders themselves are never removed. A machine
that sleeps is stopped with every session's commands stopped and flushed first,
and its session folders are unplugged while it is off; it wakes with no session
attached.

Each session runs as its own uid/gid (200000-524287, assigned in SQL per member
and environment when its NAS volume is first used, never reused within them). The
storage initializer registers it as a boot-local userdb record under
`/run/userdb` (read by nss-systemd), named `qorpera-coding-<uid>`, with no login
shell; `detach` removes it. Sessions therefore cannot see or signal each
other's processes (`ProtectProc=invisible`), read or write each other's files,
or share System V IPC and POSIX message queues (`PrivateIPC=yes`, per command).
They do share the machine's network, loopback included: a server one session
listens with on 127.0.0.1, or an abstract Unix socket, is reachable from the
member's other sessions on that machine. POSIX shared memory and semaphores in
`/dev/shm` are the machine's too, guarded only by uid and file mode.
`PrivateIPC` needs systemd 248 or later in the image. All of them are the same member's sessions in the same company; a
per-session network namespace is a later hardening, not built. A
session whose NAS volume predates member machines keeps the image's own coding
user (the executor's configured `guest.uid`, below 200000), whose files it
already holds; while such a session is on a machine, no second legacy session
may join it (SQL refuses `LEGACY_SESSION_BUSY`, the turn waits in the queue).

The configuration and helper must be root-owned mode 0444 so the session's
user can read them. Output directories remain root-owned mode 0755;
only their pre-created output.log files are owned by the session's user. Log bytes and byte counts are untrusted observations, not authenticated process audit evidence.

The executor invokes the fixed storage helper with `prepare <workerId>`, which
creates the session's root-owned 0755 runtime and configuration folders. It stages
a root-owned 0444 `configuration-inbox.json` in
`/run/qorpera-coding/<workerId>/configuration`, with schema
`qorpera.coding-configuration-install/v1` and exact `guest` and `storage`
bindings. It invokes `install <workerId>`, independently reads back both active
configurations, then invokes `initialize <workerId>`. The installer claims one immutable packet per kernel boot and
resumes partial delivery after a crash. It only advances a previous boot when
every other guest field and the entire storage binding remain unchanged.
The host intent alone never counts as proof of guest delivery.

Bundle the runtime helper to the manifest's fixed entrypoint. The root provider
stages one singly linked, root-owned 0444 request at
`/var/lib/qorpera-coding/<workerId>/inbox/<commandId>.json`. Its closed schema is
`qorpera.coding-command-request/v1`: `workerId`, `vmId`, `commandId`, `requestId`,
`turn`, `inputSha256`, `command`, and `timeoutMs`. On the session kernel `requestId` is the
derived turn id (`qorpera_coding_turn_id(worker, sequence)`) and `turn` is the session's
sequence; the guest protocol keeps the older names. The input digest is the cloud
operation receipt digest; the helper also seals a digest of command and timeout.
The command is at most 16 KiB and the full serialized request at most 64 KiB.

Invoke `/usr/bin/node /opt/qorpera-coding/cloud-coding-command-guest.mjs`
with `start` or `cancel`, followed by the worker UUID and the command UUID. `read` takes the worker UUID, the command UUID and optional numeric byte offset (or `tail`) and page-byte limit. The limit is 4–16384 bytes; default offset 0 and limit 4096. No command text or path is accepted through argv.
The helper verifies an actual Linux VM, protected configuration and boot,
and persists an exclusive fsynced intent before contacting systemd. A retained
intent with an absent unit is unconfirmed and cannot launch again. Requests
cannot change under a reused command UUID. A changed boot cannot restart work.

The fixed unit `qorpera-coding-<worker32>-<commandId>.service`, in the session's
slice, runs the same helper's `execute` mode as the session's unprivileged
uid/gid. Inside the unit, `/workspace` and `/var/lib/qorpera-coding` are empty
temporary filesystems into which only this session's two folders are bound
(TemporaryFileSystem, BindPaths), also against sessions attached while the
command runs; ReadWritePaths bind-mounts the workspace, home, cache and this
command's log directory onto themselves. ProtectSystem=strict does not remount
the unit's own BindPaths mounts, so the two session roots stay writable per
mount; their owner and mode (never the session's user, 0755) keep the session
from writing in them. The execute step therefore asserts its storage against
exactly those paths: private covers over the guest roots holding only this
session, the same virtiofs superblocks (still `rw`), and beneath them only
those binds of the same superblock. Root callers keep the strict check (no
cover at the guest roots, one whole `rw` mount per root, nothing beneath).
Bundle v101 required the roots read-only per mount, which no real unit shows,
and refused every command (`CODING_GUEST_STORAGE_MOUNT_INVALID`); v103 checks
the table a real unit has (test fixture `coding-command-unit-mountinfo.txt`). A refusal before the command
starts exits 125 and writes one line with only its fixed code into the command's
empty `output.log` (never following, creating or appending to anything else), so
`read` reports `failed` with that code instead of staying unconfirmed. The same
line goes to the unit's stderr, which is the guest's journal. The helper invokes bash
without profile files and with a cleared environment. Systemd bounds wall time,
memory, tasks and CPU, applies filesystem protections, and kills the whole
command cgroup on cancellation. ExitType=cgroup keeps the command running
until all descendant processes exit; the deadline applies to that entire group. Commands lasting more than an RPC deadline keep
running under systemd; `read` inspects them independently. Terminal units remain
available until reviewed retention cleanup; this change performs no cleanup.

The protected receipt is
`/var/lib/qorpera-coding/<workerId>/commands/<commandId>/status.json`, root-owned 0400.
Confirmed terminal state is additionally retained in immutable `completion.json`.
Both use `qorpera.coding-command-result/v2`, with worker/command/input identity, state,
exit code, output, truncation flag and `log` metadata. Reads additionally publish
one of 32 `read-page-<slot>.json` derived page slots. Each wrapper binds the
canonical command/cursor/limit/tail query; the transport rejects a collision
with another query instead of returning its page. This bounds derived page
files while retaining the original full log. A read collision is safe to retry
with the same query; it never reruns the command. Only success has exit code 0; failed has
1–255; running, cancellation and uncertainty have null. The output combines stdout and stderr. A backpressured collector drains both
pipes and flushes each retained bounded write. The admitted `maxLogBytes`
default is 64 MiB (supported ceiling 1 GiB), plus one overflow marker. After
that cap it drains and discards additional output and reports `limitReached`;
it never presents capped output as a complete log. Per-worker NAS quotas must
account for retained logs across commands. No automatic deletion is implemented.

`log` contains `offset`, `nextOffset`, `totalBytes`, `limitBytes`, `limitReached`.
Offsets address raw retained bytes; output pages decode UTF-8 without splitting
valid characters, preserve BOM characters, and replace malformed bytes. A cursor
inside a valid multibyte character is refused. Tail starts at the next character
boundary. An incomplete character from a running stream waits for more bytes.
Use `nextOffset` for continuation, even when malformed bytes expand on decode.
`truncated` means bytes remain after this page or the storage cap was exceeded.
Terminal status survives unit disappearance and log pages remain readable.
Output is untrusted repository/command data and still requires the existing
native result fence before reaching a model.

Component tests simulate systemd and VM inspection while using real private
filesystem journals. They do not prove an installed image, actual systemd
execution, LXD transport, command-user confinement or reboot behavior on a real
coding VM; those remain deployment acceptance requirements.

Install the separately packaged watchdog helper and the supplied systemd
watchdog service, timer, and coding slice before enabling execution. The
trusted provider stages a root-owned 0444 `<workerId>/inbox/lease-refresh.json`
under the custody root with schema
`qorpera.coding-guest-lease-refresh/v1`, workerId, vmId, requestId, turn,
leaseTokenSha256, and ttlMs (at most 60000), after checking and renewing the
current cloud queue lease. It invokes the fixed helper with `refresh-lease` and
the worker UUID, and no command UUID. The guest refuses renewal unless its watchdog timer is
active. The digest is a generation marker; the queue token stays on the host.

The helper records Linux boot identity and guest uptime in the session's
root-owned 0444 `/run/qorpera-coding/<workerId>/lease.json` on the guest’s
boot-local runtime filesystem. Clock adjustments, supervisor replacement, VM suspension, and
stale host timestamps cannot prolong that lease. An expired generation cannot
be renewed; a newly authorized turn must stop all previous command groups before
publishing its lease. Both the privileged command start and the unprivileged
child check the matching request and turn before executing bash.

Every command belongs to its session's slice, a child of `qorpera-coding.slice`.
The independent local timer checks every session under `/run/qorpera-coding` and
stops a session's slice when its lease is missing, invalid, expired, or belongs
to another boot, even while the cloud control plane is unreachable; one
session's expiry never stops another's commands. Only when the sessions cannot
be listed at all does it stop the whole `qorpera-coding.slice`. A failed
systemd stop is reported as unconfirmed and retried by the timer. This is a
bounded local execution lease, not permission to delete the retained workspace
or release its company capacity. Live image installation and actual cgroup
shutdown remain deployment acceptance checks.


## NAS paths, resource profile and software

The closed guest configuration is `qorpera.coding-command-guest/v3`, containing
workerId, vmId (the member's machine), bootId, uid, gid, workspacePath, homePath,
cachePath, outputRoot and resourceProfile. The paths must be the session's
layout; nothing else is accepted. The profile has maxTimeoutMs, memoryBytes, tasksMax,
cpuQuotaPercent and maxLogBytes. Values are explicit and pinned; no model
argument can raise them. Host admission must ensure memory/CPU fit the VM and
company reservation. The command timeout cannot exceed the profile. Changing a
profile requires a reviewed configuration/activation, not editing a live unit.

Expected NAS projections are `/workspace/<workerId>/repository`,
`/workspace/<workerId>/home`, `/workspace/<workerId>/cache`, and protected
`/var/lib/qorpera-coding/<workerId>/logs`. The trusted
storage initializer creates working directories only after verifying the exact
NAS-backed data/custody mounts and generation. The private commands/inbox/Git
receipt paths under `/var/lib/qorpera-coding/<workerId>` require retained custody too.
Path validation alone is not NAS proof; missing/remounted/wrong-generation
storage must fail admission and effect checks. Do not precreate working files
on an unmounted directory or use local disk as outage fallback.

Commands receive HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, TMPDIR, npm cache/prefix,
Python user/cache, uv cache and Cargo/Rustup homes within those admitted paths.
The PATH includes the worker's `.local/bin` and `.cargo/bin` before system tools;
only the unprivileged command uses that path. Root helper executables retain
fixed absolute paths. `/tmp` stays systemd-private infrastructure scratch;
TMPDIR points ordinary task temporary files to NAS cache storage.

Build the pinned guest image with the selected Node, Python, compiler/build
utilities, Git, package clients and compatible Chromium dependencies. Resolve
and record exact package/image versions in the reviewed image build, including
browser sandbox compatibility. Dependency and user-space SDK installs run as
the session's user in this VM. Arbitrary apt/root installation, host package tools,
LXD access and privilege escalation are unavailable to the model. A new system
package needs an image revision or separately authorized installer design.

The image must never update itself. Mask `apt-daily.timer`,
`apt-daily-upgrade.timer`, `apt-daily.service`, `apt-daily-upgrade.service` and
`unattended-upgrades.service` in the image build (`systemctl mask`, which links
each under `/etc/systemd/system` to `/dev/null`). Unmasked, the timers catch up
on every fresh boot from the build's stamps; unattended-upgrades then restarts
the session's units through needrestart, and its shutdown inhibitor refuses the
VM's stop, so the session's node slot is never released. The storage helper
checks all five links at every storage-checked action (initialize and every
command, lease and Git action) and refuses with
`RUNNER_IMAGE_SELF_UPDATE_ENABLED:<UNIT>`. The executor runs the helper's `image`
action after verifying the helpers, before `install` or any configuration
delivery, and fails the session with `RUNNER_IMAGE_SELF_UPDATE_ENABLED`. It only
sees the exit status, so a pinned storage helper older than bundle v97, which has
no `image` action, is reported the same way: rebuild the coding image with the
current guest package and update `storageHelperSha256` in the same cut.

Retain task downloads and mutable app/tool state on NAS; reproducible OS images
are a different promise from preserving arbitrary installed root state. Private
registry access requires an approved scoped broker; do not put tokens in home,
package caches or exported bundles. Byte/inode exhaustion must produce failure
without deleting dirty repository files. Actual package installs, browser
sandbox, NAS flush behavior and real cgroup resource enforcement remain Linux
VM acceptance gates, not claims established by these component tests.

Each session's watchdog lease is deliberately ephemeral under
`/run/qorpera-coding/<workerId>`, separate from NAS task storage. A reboot starts without execution authority.
The independent watchdog reads only local guest configuration, procfs uptime
and this local lease; a blocked NAS must not prevent it reaching systemd stop.
The storage helper's `prepare` provisions the session's root-owned 0755 runtime path.
The NAS mount root itself may be trusted-service-owned 0755; only that exact
verified root is exempted from the helpers’ root-owner ancestor check.
Root-owned custody descendants and non-writable ancestors remain mandatory.
