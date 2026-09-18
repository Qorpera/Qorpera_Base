# Compute requests and recorded failures

`qorpera_runtime_compute_requests(company_id, after_kind, after_id, limit)` is a
service-only operator query. It reads retained office start intents, login
sessions, runner jobs and unallocated company-capacity refusals. It includes
requests before a machine allocation exists. It never retries admission,
changes authority or releases capacity.

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
view; no automatic deletion or new retention policy is added. Member, anonymous,
guest and secret-broker access remain unavailable.

Run `node scripts/test-runtime-compute-requests.mjs` for the disposable PostgreSQL
proof. Actual member start/login, company/node reservation, cancellation and
dispatch-release RPCs are exercised. Extra offered dispatch rows and host
measurements are explicit fixtures. The proof creates a failure before applying
the migration, checks a new failure and replay afterward, verifies authority,
pagination, identity, original refusal times and read-only behavior, then compares
the retained response across database restart. It performs no model calls or
physical VM provisioning.
