# Retained computer lifecycle query

Migration `20260909000500_runtime_computer_lifecycle.sql` adds the service-only
`qorpera_runtime_computer_lifecycle(allocation_id, from, until)` query. It reads
existing control records and the separate physical usage projection in one
statement snapshot. It changes no admission, lifecycle, allocation or telemetry
record. The explicit past window is half open (`from <= time < until`) and at
most 24 hours. More than 1,000 control events, 20,000 physical samples, or a
4 MiB response requires a smaller window; the query does not silently truncate.

`controlEvents` separates these layers:

| Layer | Retained records |
| --- | --- |
| `company_allocation` | Company capacity reservation and confirmed release |
| `node_allocation` | Node capacity request, reservation and confirmed release |
| `office_admission` | Initial start request/cancellation, admission revocation, successor preparation and predecessor supersession |
| `office_service` | Successful activation and provider acknowledgement of service absence |
| `vm_control` | Explicit retained-VM boot intent |

Each event includes its source identity, database time, fixed reason, recorded
action where available, activation, transition and computer generation. Root
requests, inspection bodies, private challenges and member identities are not
copied. Records remain in the existing private tables with their existing
retention; this migration adds no automatic deletion or product-path export.
Only the explicit RPC is granted to `service_role`. Members, anonymous callers,
the secret broker and the guest registry do not gain operator access.

`recordedAt` is always a database record time. `physicalTransitionAt` is null.
An activation records successful service admission; an acknowledged stop records
that the provider confirmed service absence by that time. Neither gives the
exact instant of VM power-on/off. The pre-activation `ready_at` field can be
refreshed and is deliberately not presented as a permanent lifecycle boundary.
A boot intent remains a request. A service stop does not close the VM or release
either capacity reservation. Viewer events are excluded.

`physicalHistory` is the existing allocation-bound computer history, with
explicit sample-held estimates and unknown gaps. Missing node placement returns
null history and `NODE_PLACEMENT_NOT_RECORDED`. Exact physical transition times
remain unavailable; no synthetic suspended/resumed/closed/failure event is
created from a service record, missing sample or desired power state. The query
is historical evidence, not a current health or work-admission API. Window
partitioning preserves database microsecond timestamps.

This view covers retained allocations, including native and login allocations;
it cannot discover an unallocated office request. Full current computer/job,
pending-demand, activity and health visibility remains separate work. Exact
physical transition recording still requires instrumentation at the provider
boundary. The production office lifecycle presently restarts or reboots the
same retained VM; it does not expose a VM deletion worker. Canonical company
reset/rebuild preservation and undelivered diagnostic custody through guest
destruction still require acceptance before release.

The disposable office SQL driver exercises this query after real activation,
revocation, stop acknowledgement and optional successor admission. The node
inventory driver exercises actual company/node release separately. The probes
check unchanged source rows, operator-only access, bounded windows/responses,
exact source times, microsecond partitioning and database restart. Physical VM
and service measurements in those SQL probes are fixtures, not live-host proof.
