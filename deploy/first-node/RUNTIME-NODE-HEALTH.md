# Node health diagnostics

Migration `20260909000700_runtime_node_health.sql` adds independent, service-only
node health receipts and the `qorpera_runtime_node_health(node_id)` and
`qorpera_runtime_node_health_history(node_id, before_time, before_id, limit)`
queries. These measurements never authorize admission or release capacity.

The unprivileged observer starts one child process per sample: its own file
(`process.argv[1]`) with `--health-probe`, so the child reads the same
configuration as the observer. It checks protected machine identity, boot/mount
namespace and inventory policy, and names its software, before reporting. The
first installation (`/opt/qorpera/node-observer/qorpera-node-observer.cjs`) is
named by its installed package receipt, which must name the policy and the
observer's account. A cut's observer file (`deploy/agent-exit/ROLLOUT.md` step
4) has no receipt and is named by the SHA-256 of its own bytes, read only when
the file and every directory above it are root-owned and not group- or
world-writable. Until v180 the probe always ran the first installation's path,
which the cuts' observers do not use, so every sample was
`COLLECTION_UNCONFIRMED`. Run by hand, a failed probe prints
`NODE_HEALTH_COLLECTION_UNCONFIRMED` and the closed code that stopped it, never
an error's text or a path; the observer ignores the probe's stderr. It reports:

- CPU busy basis points over a one-second sample of Node's OS CPU time counters,
  summed across CPUs and excluding idle time; the original interval is retained.
- Total RAM and Linux `MemAvailable`, in bytes. This is available system memory,
  not a VM reservation or a measurement of one company's consumption.
- Total, free and unprivileged-available bytes from `statfs` of the root filesystem.
- Cumulative receive/send bytes, errors and drops across currently present
  non-loopback interfaces from `/proc/net/dev`. Interface names are not exported.

Network counters include inert tunnel interfaces when present. Zero counters do
not prove reachability. Interface changes or reboot can reset aggregate counters;
the query does not derive traffic rates or attribute traffic to Company File/NAS.
Root filesystem measurements do not establish NAS health, free space or durability.
Those fields remain explicitly unknown and require separate live acceptance.

Each metric has a closed nullable shape and an explicit failure reason. Overall
collection failure emits `COLLECTION_UNCONFIRMED` with no asserted boot, package
or measurements. A five-second child deadline sends SIGKILL; ownership is retained
until the child closes, preventing overlapping unreaped probes. A kernel-blocked
child can remain pending after that signal. Inventory polling uses its own loop
and HTTP adapter, so pending collection or export does not occupy admission's
inventory publisher. Both loops wait five seconds after each settled attempt.

The registry retains immutable original observations, receipt times, policy and
package hashes. Exact replay returns the original receipt. Conflicting replay is
refused; out-of-order delivery cannot replace a newer observation. The latest
query uses original observation time, a 60-second age bound, a two-second future
bound and the current enrolled policy. Missing, stale, mismatched or entirely
unavailable samples return unknown current measurements while retaining the last
observation. Partial samples expose their individual missing metrics.

History uses descending observation-time/UUID cursors, at most 1,000 records and
4 MiB per page. Pages are live snapshots, not a cross-page snapshot. Retained
samples do not promise continuous coverage. Failed publication is not retried by
the observer: a later attempt measures a new sample; committed receipts survive
lost replies. There is no automatic receipt deletion. Tables and validation
helpers remain private; only the three explicit RPCs are granted to service role.
Member and guest APIs receive no additional access or authority.

Local validation separates real PostgreSQL persistence/admission tests with
fixture measurements from actual Linux/systemd kernel collection with a fixture
TLS registry and LXD daemon. The latter also stalls diagnostic export and hangs a
child while checking independent inventory progress and recovery. Neither probe
establishes a deployed host, real LXD/NAS behavior or the combined office workload.
