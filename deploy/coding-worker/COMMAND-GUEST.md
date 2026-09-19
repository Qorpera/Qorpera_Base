# Isolated coding command guest

The installation manifest describes a reviewed image prerequisite. This source
change installs no image or service. The trusted provider must bind the config
to the actual worker, VM and Linux boot, create the dedicated coding uid/gid,
and own every supervisor directory as root with mode 0755. The repository is
owned by the coding user. No office mount, member filesystem or provider token
belongs in this guest.

The configuration and helper must be root-owned mode 0444 so the dedicated
coding user can read them. Output directories remain root-owned mode 0755;
only their pre-created output.log files are owned by the coding user.

Bundle the runtime helper to the manifest's fixed entrypoint. The root provider
stages one singly linked, root-owned 0444 request at
`/var/lib/qorpera-coding/inbox/<commandId>.json`. Its closed schema is
`qorpera.coding-command-request/v1`: `workerId`, `vmId`, `commandId`, `requestId`,
`turn`, `inputSha256`, `command`, and `timeoutMs`. The input digest is the cloud
operation receipt digest; the helper also seals a digest of command and timeout.
The command is at most 16 KiB and the full serialized request at most 64 KiB.

Invoke `/usr/bin/node /opt/qorpera-coding/cloud-coding-command-guest.mjs`
with exactly `start`, `read`, or `cancel`, followed by the command UUID.
The helper verifies an actual Linux VM, protected configuration and boot,
and persists an exclusive fsynced intent before contacting systemd. A retained
intent with an absent unit is unconfirmed and cannot launch again. Requests
cannot change under a reused command UUID. A changed boot cannot restart work.

The fixed unit `qorpera-coding-<commandId>.service` runs the same helper's
`execute` mode as the configured unprivileged uid/gid. The helper invokes bash
without profile files and with a cleared environment. Systemd bounds wall time,
memory, tasks and CPU, applies filesystem protections, and kills the whole
command cgroup on cancellation. ExitType=cgroup keeps the command running
until all descendant processes exit; the deadline applies to that entire group. Commands lasting more than an RPC deadline keep
running under systemd; `read` inspects them independently. Terminal units remain
available until reviewed retention cleanup; this change performs no cleanup.

The protected receipt is
`/var/lib/qorpera-coding/commands/<commandId>/status.json`, root-owned 0400.
Confirmed terminal state is additionally retained in immutable `completion.json`.
Both use `qorpera.coding-command-result/v1`, with worker/command/input identity, state,
exit code, output and truncation flag. Only success has exit code 0; failed has
1–255; running, cancellation and uncertainty have null. The output combines
stdout and stderr, drains both pipes, and captures at most 4096 UTF-8 bytes.
Output is untrusted repository/command data and still requires the existing
native result fence before reaching a model.

Component tests simulate systemd and VM inspection while using real private
filesystem journals. They do not prove an installed image, actual systemd
execution, LXD transport, command-user confinement or reboot behavior on a real
coding VM; those remain deployment acceptance requirements.

Install the separately packaged watchdog helper and the supplied systemd
watchdog service, timer, and coding slice before enabling execution. The
trusted provider stages a root-owned 0444 `inbox/lease-refresh.json` with schema
`qorpera.coding-guest-lease-refresh/v1`, workerId, vmId, requestId, turn,
leaseTokenSha256, and ttlMs (at most 60000), after checking and renewing the
current cloud queue lease. It invokes the fixed helper with `refresh-lease`
and no command UUID. The guest refuses renewal unless its watchdog timer is
active. The digest is a generation marker; the queue token stays on the host.

The helper records Linux boot identity and guest uptime in root-owned 0444
`lease.json`. Clock adjustments, supervisor replacement, VM suspension, and
stale host timestamps cannot prolong that lease. An expired generation cannot
be renewed; a newly authorized turn must stop all previous command groups before
publishing its lease. Both the privileged command start and the unprivileged
child check the matching request and turn before executing bash.

Every command belongs to `qorpera-coding.slice`. The independent local timer
stops that entire slice when the lease is missing, invalid, expired, or belongs
to another boot, even while the cloud control plane is unreachable. A failed
systemd stop is reported as unconfirmed and retried by the timer. This is a
bounded local execution lease, not permission to delete the retained workspace
or release its company capacity. Live image installation and actual cgroup
shutdown remain deployment acceptance checks.
