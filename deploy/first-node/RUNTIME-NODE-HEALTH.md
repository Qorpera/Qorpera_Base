# Node health diagnostics

Migration `20260909000700_runtime_node_health.sql` adds independent, service-only
node health receipts and the `qorpera_runtime_node_health(node_id)` and
`qorpera_runtime_node_health_history(node_id, before_time, before_id, limit)`
queries. These measurements never authorize admission or release capacity.

The unprivileged installed observer starts one fixed child process per sample.
It checks protected machine identity, boot/mount namespace, inventory policy and
the installed package receipt before reporting:

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
