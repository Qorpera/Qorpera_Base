# Current allocated computers

Migration `20260909000600_runtime_node_computers.sql` adds the operator-only
`qorpera_runtime_node_computers(node_id, after_allocation_id, limit)` query.
It pages current node demands whose company or reserved node allocation remains
unreleased. Each page is a consistent statement snapshot. Pages use live UUID
ordering, not a cross-page snapshot; the response declares that limitation.
Limits are 1–1,000 computers and 4 MiB. Node demand and company allocation
identities are retained even when the request is still waiting for capacity.

Each computer exposes its company, office/run/login identity, generation,
immutable local placement/provider/policy/physical binding and configured
resource costs. Original company/node reservation/release times and the last
admission check/refusal remain separate. A refusal is the last recorded
admission outcome, not a provisioning-failure history or an inferred VM error.

Physical state requires the current complete inventory receipt, its matching
node policy/version, original observation freshness (60 seconds), hardware
bounds, exact managed physical identity and CPU/RAM configuration. Missing,
stale, unavailable or mismatched evidence produces `unknown` with a reason.
Absent VMs are unknown rather than implicitly released. The state vocabulary
comes from the existing observer: starting, running, stopping, suspended,
failed or unavailable. Stopped/frozen VMs are represented as suspended.

`jobActivity` joins native run/job identity and shared-office screen/resource
links, counting each linked run once. Current leased/running jobs with fresh
leases supply known active-job counts. Expired/mismatched job leases, expired
resource records and pending screen drains retain uncertainty. A running
computer is classified as `with_active_jobs`, `without_recorded_active_jobs`
or `unknown`. Other physical states are `not_classified`. A partial count is
marked with `countComplete: false` and an uncertain-record count; that count
is diagnostic records, not distinct additional jobs.

No-job classification is not a CPU-idle measurement and never changes capacity.
Use `qorpera_runtime_node_capacity` for free CPU/RAM (`freeCpuMillis`,
`freeMemoryBytes`), whole admissible slots and its own observation time. This allocation query cannot authorize work, release capacity,
or turn unused CPU into spare computer slots. Overflow remains unavailable.

Hardware totals and VM inventory remain separate from diagnostic measurements.
This view points to `qorpera_runtime_node_health` for CPU utilization, available
RAM, root filesystem space and network counters, each with original freshness
and explicit unknown states. See `RUNTIME-NODE-HEALTH.md`. The separate
`qorpera_runtime_compute_users` query supplies current distinct computer/company/
member counts and windowed observed human activity from viewer redemption and
admitted control inputs; see `RUNTIME-COMPUTE-USERS.md`. Continuous human presence,
NAS health and network reachability remain unobserved. Retained demand and typed
dispatch failures are available through `qorpera_runtime_compute_requests`; see
`RUNTIME-COMPUTE-REQUESTS.md`. Physical provisioning outcomes remain in protected
provider diagnostics. The separate `qorpera_runtime_host_inventory` query includes
infrastructure and unmanaged entries, with observation-pinned pagination and
explicit stale/missing states; see `RUNTIME-HOST-INVENTORY.md`.

Only `service_role` can execute the public query. Its job helper is private,
including to that role; raw table permissions and guest RPC allowlists are
unchanged. No payloads, messages, credentials, browser challenges, viewer inputs
or file contents enter the response. Existing records retain their existing
durability and retention; querying creates no new export dependency.

The disposable node inventory probe applies all 205 migrations and uses the
actual observer, Unix HTTP adapter, SQL admission and release functions.
It checks live native job linkage, pending office capacity/refusal, pagination,
stopped/absent charging, unknown states, confirmed release and database restart.
Rolled-back record fixtures test no-job/expired-job classification, shared
screen linkage, pending drains, stale observations and access/limit refusal.
Physical host/LXD values remain fixtures. These checks do not prove deployed
host health, human activity or the combined ordinary desktop workload.
