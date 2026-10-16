# Compute requests and recorded failures

`qorpera_runtime_compute_requests(company_id, after_kind, after_id, limit)` is a
service-only operator query. It reads retained office start intents, login
sessions, runner jobs, unallocated company-capacity refusals and the company's
current machines. It includes requests before a machine allocation exists. It
never retries admission, changes authority or releases capacity.

Each record has its original source creation time and current recorded state.
Office provider configuration is explicitly a target, separate from placements.
Placements contain exact company allocations and their node demands, original
reservation/release times, and the last recorded node check/refusal. A requested
node is not a reserved node. A company allocation without node demand is
unassigned. These records do not prove VM creation, current physical health or
physical deletion; consult `qorpera_runtime_node_computers` and the node health
and inventory views for their separately timed observations.

Login sessions appear before the provider requests a machine. After a machine
request, retained admission refusals are included even without an allocation.
An unallocated company-capacity refusal identifies only its allocation request,
original refusal time, and counts recorded at refusal. Its source and current
wait state are unknown: the existing record cannot establish an office/native
intent link or prove that a caller is still waiting. Once allocated, it leaves
the unallocated-refusal list. Cancellation or expiry never implies released
resources; existing charged allocations remain visible.

Native job records include retained assignment and delivery-failure counts, plus
the latest recorded delivery failure's assignment, runner, run, typed reason and
time source. Runtime-bundle identity comes from the linked execution run. Raw
backend errors, job payloads, results, credentials and capabilities are excluded.
A dispatch-delivery failure is not necessarily a physical provisioning failure.
Office and login physical failures remain in the protected provider's diagnostic
records; this SQL query leaves `provisioningFailure` null and identifies the
diagnostic source. It does not introduce an export dependency into provider work.

Migration `20260930494000_runtime_operator_views_machines.sql` adds the kind
`machine`, ordered between `login` and `native`. `details.machineSource` names
its two sources:

- `company_machine`: each folder-v2 company machine that is not removed
  (`qorpera_company_machines`), including coding machines started in the folder
  (`codingWorkerId`). The request ID is the machine ID, its time the machine's
  creation, and its state the one members see: `waiting`, `starting`,
  `running`, `stopping`, `stopped` or `deleting`. A waiting machine has its
  `queuePosition` in the shared line of waiting machines (earliest `wantedAt`
  first) and its `reason`, the node's last refusal or `NODE_CAPACITY_EXHAUSTED`.
  While the company has no computer hours left, its waiting machine's `reason`
  is `COMPUTER_HOURS_EXHAUSTED` and its `queuePosition` is null: it holds no
  place in line until hours are available. Both are null in every other state.
  The details also carry the name, size
  (`cpuMillis`, `memoryBytes`, `diskBytes`), lifetime, desired state, starting
  run and last error.
- `coding_machine`: each unreleased coding-machine allocation (a coding worker's
  or coding machine's VM). The request ID is the allocation ID and its time the
  company reservation. Its state is `unassigned` (no node demand), `requested`,
  `refused` (`reason` is the node's last refusal), `reserved` or `released`
  (the node demand is released, the company allocation not yet).
  `queuePosition` is null.

A machine's `placements` hold its current allocation and node demand in the
same shape as the other kinds, and `details.allocationId` names that
allocation. A machine waiting in line without a node has an empty list and a
null `allocationId`: it is on no node, so `qorpera_runtime_node_computers` does
not list it and no node's `pendingRequests` counts it. A waiting machine that
is asleep on a node (waiting for capacity to wake) keeps its placement there:
its `placements` name that node, and the node's inventory reports it (for
example as `suspended`). Unlike the other kinds,
machine records are current only: a removed company machine or a released coding
allocation leaves the list. The response's `machineCoverage`
(`current_company_machines_and_unreleased_coding_machines`) says what the kind
covers; `coverage` is unchanged. SQL test `433_runtime_operator_views_machines`
checks both sources, the placements, paging and access.

Migration `20260909000900_runtime_compute_requests.sql` preserves the first
future transition of an assignment into `delivery_failed` using database time.
Existing failed rows remain null. Replay or unrelated updates cannot restamp the
time. The time means a database status transition, not the physical failure or
commit time. Latest failure orders known times first, then creation time and ID;
historical failures with unknown times are not assigned a reconstructed chronology.

Pages use the returned `(nextKind, nextId)` cursor, with limits of 1–1,000
requests, 1,000 placements per request and 4 MiB per response. Overflow raises
`54000`; it does not silently truncate placement history. Pages are live and do
not promise one snapshot across calls. Retained terminal requests remain in the
view (machines excepted, above); no automatic deletion or new retention policy
is added. Member, anonymous,
guest and secret-broker access remain unavailable.

Run `node scripts/test-runtime-compute-requests.mjs` (deleted in the legacy sweep) for the disposable PostgreSQL
proof. Actual member start/login, company/node reservation, cancellation and
dispatch-release RPCs are exercised. Extra offered dispatch rows and host
measurements are explicit fixtures. The proof creates a failure before applying
the migration, checks a new failure and replay afterward, verifies authority,
pagination, identity, original refusal times and read-only behavior, then compares
the retained response across database restart. It performs no model calls or
physical VM provisioning.
