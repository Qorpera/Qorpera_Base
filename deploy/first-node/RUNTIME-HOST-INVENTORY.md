# Host inventory for operators

`qorpera_runtime_host_inventory(node_id, observation_id, after_project,
after_name, limit)` exposes retained physical inventory for an enrolled local
node. Only `service_role` can execute it. It includes managed company machines,
reviewed infrastructure and unmanaged machines, including stopped unmanaged
containers that prevent admission. Raw LXD configuration, host socket paths,
credentials and cloud-init contents are excluded. No new telemetry writer,
retention policy, guest permission or admission dependency is introduced.

Omit the optional arguments to read the latest observation. For another page,
pass the returned `observationId`, `nextProject` and `nextName`. A cursor requires
an observation ID, so concurrent polling cannot splice two physical inventories
into one traversal. Limits are 1–1,000 entries and 4 MiB per response; the source
receipt already limits the complete observation to 4,096 entries. Historical
observations can be read by their retained ID. Wrong-node or missing IDs are
refused. Raw receipt tables remain private, including to the service role.

Every entry retains its reported state/reason, physical identity, configuration
hash, measured resource limits and original recorded allocation, where present.
Company identity is joined through the retained allocation. No company or job is
invented for infrastructure or unmanaged machines. The separate
`qorpera_runtime_node_computers` query supplies current allocation and job activity;
the host inventory query does not interpret absence from this physical snapshot
as a released allocation or the absence of work.

Original observation and receipt times, boot ID, node version and inventory
policy hash identify the evidence. The inventory receipt does not record the
observer package hash; it remains explicitly unknown rather than borrowing a
package identity from a separately timed health sample. Current physical state
requires the latest observation, a matching current policy/version, a ready node,
hardware bounds and a timestamp newer than 60 seconds and no more than two
seconds in the future. Other evidence produces `currentState: unknown` with a
reason while preserving the historical `reportedState`.

An unmanaged or substituted instance makes the node unavailable. Its reported
entry remains visible for investigation, alongside the known infrastructure and
managed entries. A failed daemon scan produces no inventory receipt:
`reportedEntryCount` is null, not zero, and an empty response does not establish
an empty host. Unavailable observations have unconfirmed coverage. A ready
historical observation remains a complete observation at its original time,
but superseded or stale records cannot claim current physical state.

Entry snapshots are stable across pages; current-state validity is rechecked
on every page. Node enablement is reported separately from physical state.
Disabled, stopped, idle, absent or unobserved resources never become free slots
through this query. Use `qorpera_runtime_node_capacity` for admission and
`qorpera_runtime_node_health` for separately timed health measurements. Overflow
remains unavailable.

`node scripts/test-runtime-node-inventory.mjs` exercises the production inventory
reader and publisher through Unix HTTP and disposable PostgreSQL. The added
host view cases cover infrastructure, managed allocation identity, unmanaged
stopped instances, physical substitution, failed scans, historical pagination,
staleness, private configuration exclusion, access/limits and database restart.
Host and daemon responses remain explicit fixtures; stale receipts are created
only inside a rolled-back SQL fixture. Existing capacity, job-activity, health
and history regressions run in the same probe. This is not a live LXD or deployed
host acceptance claim.
