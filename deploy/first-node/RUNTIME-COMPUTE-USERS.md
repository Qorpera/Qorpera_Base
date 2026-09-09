# Computer users and observed activity

`qorpera_runtime_compute_users(node_id, from, until)` is a service-only operator
query added by `20260909000800_runtime_compute_users.sql`. It separates two
different measurements:

- Current unreleased node reservations: distinct allocated computers, companies,
  and current associated company members. A member of several served companies
  counts once. These are charged allocations, including idle/stopped computers,
  not a count of physically running machines.
- Observed activity in the requested half-open time window: distinct humans,
  computers and companies with retained viewer redemption or admitted control
  input records. Repeated viewers and inputs from one person count once.

The query requires an explicit finite past interval of at most 24 hours. It
refuses windows exceeding 20,000 matching records rather than silently truncating
counts. Activity belongs to the exact office generation and recorded company/node
allocation interval. Prior activity remains visible after a viewer ends, authority
is revoked, or an allocation is released. Current member counts remain a separate
as-of view and can change independently of the historical activity window.

`observedActiveUsers` counts only the declared sources. It is null, with
`NO_ACTIVITY_OBSERVATIONS`, when no matching evidence exists. Zero recorded events
means no evidence in those sources, not zero humans using the system. Watching
without another redemption or control input is not continuously measured. Input
admission precedes forwarding and does not prove execution or a human's attention.
Agents and native-job sponsors never become observed active humans merely because
they share a computer or sponsor work. Issued but unredeemed tickets are excluded.

No new activity-write path or diagnostic export is introduced. The query reads
existing transactional authority records and never changes reservations, viewer
authority or input admission. It exports aggregate counts, source labels and
time bounds only: no member identities, ticket capabilities, private challenges,
input commitments, keys, pixels or file contents. Existing private record custody
and retention apply; this migration adds no automatic deletion. Member, anonymous,
guest and secret-broker access remain unavailable.

The disposable PostgreSQL probe exercises actual viewer mint/redemption, input,
revocation and drain functions. Host/allocation placement is explicitly synthetic.
It checks distinct counts, original-time boundaries, missing observations,
generation/placement limits, historical release, access, record bounds, read-only
behavior and retained activity across database restart. This is not evidence of
continuous deployed-user presence or a combined physical office workload.
