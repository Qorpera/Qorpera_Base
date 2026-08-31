# Orders 0/2 operational observability

Date: 2026-08-31. Source implementation of the minimum records ratified in
[runtime contract section 19](../../QORPERA-RUNTIME-CONTRACT.md). This is
operational diagnosis, not a second Company File, authority ledger, warehouse,
or model tool. Deployment and live acceptance of these new bytes are separate
from source verification. Earlier signed proofs do not certify this bundle.

## Scope and Azure decision

Optional Azure overflow provisioning is deferred for development-partner
testing. An unconfigured overflow path is unavailable, not unlimited capacity.
No Azure setup, production SQL, credential operation, signing, release, or
Step 3 integration is part of this change.

The independent secret broker, KMS and encrypted identity-recovery services
are different from overflow execution capacity. Any enabled runtime still
requires its existing custody/recovery/authority controls. Their current paused
deployment is not made ready by deferring overflow; retained resources and
sealed evidence are not removed by this decision.

Order 4 retains computer/screen lifecycles, whole-computer admission capacity,
pending reservations, placement history, computer/screen-hours and conditional
Azure overflow accounting. Orders 3 and 5–10 extend these same records as their
work is implemented. No speculative scheduler, screen, active-user, capacity
or billing data is synthesized here.

## Implemented records

| Boundary | Evidence and meaning |
| --- | --- |
| Run/job | Existing canonical admission, queue/start/end/status, request, claim, assignment, native lease and terminal-result records. Diagnostics cannot alter their outcomes. |
| Native model invocation | Start/end/status/safe error for the logical turn, including its tool work, retries and compaction. Available native thread-total counters are retained as snapshots. |
| Major tools | Separate attempt IDs and timing, safe outcome/category, and validated read or operation-receipt links. Protected proposals remain proposed; confirmed receipt/message replays are not new effects. |
| Enforcement | Run/context authorization and native result-fence observations. Post-effect result-release denial is separate from an already-confirmed effect. A passed pre-request fence is not proof that the provider received a request. |
| Human Company File | Canonical member-command/actor/resource/revision queries, complemented by the gateway's bounded request-observation window for read/apply attempts, including denials and transport failures. |
| Provider node | Current CPU delta, OS memory and provider-root-filesystem free space, each with its own sample time, availability and freshness. Existing gateway dependency health reports storage/authority failures separately. |

`qorpera.runtime-observation/v1` is a closed metadata object. It contains UUID
links, a one-way correlation digest, timestamps, fixed enums and nullable safe
integer counters. It has no path, prompt, transcript, file body, tool argument,
raw provider error, credential, cookie, token, secret handle or arbitrary label.
Company/requester/sponsor/agent/session/compute/bundle identities are joined from
canonical records, not accepted as authority from an event payload.

The correlation digest groups retries of the same native call, not every
possible semantic duplicate. Canonical receipt/read links and public-send
records remain necessary to reconcile changed call IDs. Count committed
revisions and public sends from their canonical records, not by summing
successful diagnostic spans.

## Operator interfaces and access

Migration `20260828019970_runtime_operational_observability.sql` adds four
service-only RPCs. Both database grants and the internal service-role check
apply; company membership alone does not grant cross-company operator access.
The model, end-user API role and narrowly scoped secret broker have no access.
Direct observation-table/sequence access is also revoked from API roles.

| Interface | Result |
| --- | --- |
| `qorpera_record_runtime_observation(run_id, observation)` | Immutable attempt/phase ingestion with a closed, exact acknowledgement. Duplicate delivery cannot create another event; changed replay is rejected. |
| `qorpera_get_runtime_operational_run(run_id, limit)` | Linked canonical run/job/admission/assignment/compute/bundle and bounded diagnostic, receipt, revision, read, proposal and public-send sections. |
| `qorpera_get_company_operational_commands(company_id, limit)` | Canonical human command status, actor/resource/version and exact applied-revision linkage without copying the command or file. |
| `qorpera_purge_runtime_observations(limit)` | Bounded deletion of eligible optional diagnostics only; never authority, receipts, reads, revisions or public sends. |

Query and purge limits are 1–200, default 200. Sections identify truncation.
Authorized operator tooling can invoke, for example, the existing RPC transport
with `p_run_id` and `p_limit: 100`, or `p_company_id` and `p_limit: 100` for the
company-command query. Do not place a service credential in a model context,
member client, shell history, report or URL to obtain this view.

The gateway adds `GET /v1/member-company-observations` behind its existing
operator control-token boundary. Its closed filters support company,
environment, command, actor and resource UUIDs, operation/outcome, and a bounded
limit. Read attribution comes from the new authorized v2 descriptor; a request
UUID or bearer payload is not accepted as canonical actor/resource identity.
Command identity is correlated with the SQL command query. Failed responses
remain separate from a confirmed apply/proposal/replay result.

The provider adds `GET /v1/qorpera-runner-provider/observations` behind the same
bearer and source-network checks as its other private operations. Public health
does not expose resource measurements. `QORPERA_RUNNER_NODE_ID` may identify an
existing canonical node; `QORPERA_RUNNER_PROVIDER_SOFTWARE_VERSION` may carry
the build's exact source commit or bounded version. Missing/invalid values are
null, not a guessed host name or capacity identity.

## Retention, failure and incomplete evidence

- Cloud events are append-only. A service-only purge makes events eligible
  after 30 days of **server ingestion time**, and only for terminal jobs. The
  limit bounds each deletion batch; `moreEligible` signals further work. This
  is an explicit operator maintenance action, not an installed purge schedule.
  Active-job observations and canonical records are not pruned by it.
- The native exporter has one outstanding publisher, at most 256 queued
  records, a bounded request deadline and final drain. Failure, malformed or
  mismatched acknowledgement, or a stalled request opens its private circuit.
  It drops diagnostics without retrying the tool, changing authorization or
  treating an uncertain effect as completed. There is no local spool/fallback.
- SQL views explicitly identify absent diagnostics, missing start/finish or
  parent, clock-order conflicts, sender clock skew and truncated sections.
  Optional delivery is not claimed as a complete execution ledger. No failure
  record is not proof of health, and a missing end is not zero duration.
- Gateway attempt observations are a **512-record, 15-minute in-process**
  window. Instance/start identity, combined expiry/capacity-eviction counts,
  dropped-update counts and coverage flags disclose restart and collection
  gaps. They do not survive a gateway restart; canonical command/revision state
  does. No file or network exporter is introduced into a Company File effect
  path.
- Node readings are latest-in-process only, sampled every 15 seconds and stale
  after 60 seconds. Failed readings retain the last successful sample's time;
  they do not restamp an old value as fresh. A timed-out filesystem syscall
  remains the sole outstanding probe until it settles.

## Measurement limits

The native adapter exposes logical turn timing, not individual provider HTTP
attempts. Internal provider request timing is explicitly unavailable; prewarm,
compaction and result-fence callbacks are not renamed HTTP requests. Provider
thread counters can contain estimates and repeated cumulative updates: do not
sum them or present them as invoice-accurate tokens. Missing counters are null.

Native Company File byte counts are logical range/write bytes. Human immutable
object transfers count available object bytes, which may be manifests or chunks,
not an entire logical file. Other tool counts describe boundary serialization.
None measures physical NAS traffic, cache hits or storage write amplification.

The node disk probe measures `/` in the provider service's filesystem. It is
not NAS capacity or an LXD storage-pool inventory. OS total-minus-free memory
can include cache; CPU utilization is an observed interval delta, not load
average. Network utilization is unobserved. Existing gateway dependency-health
states report bounded NAS/Auth/API/Storage availability, not link throughput.
Configured resource limits/reservations remain distinct from measured use.
No whole-company-computer capacity can be inferred from this endpoint alone.

Migration `20260828019971_member_object_observation_identity.sql` adds only
actor/resource identity to the already-authorized member-object descriptor and
advances that closed wire schema to v2. Current path/version/closure checks,
function ownership and permissions are preserved. Gateway and migration rollout
must be coordinated; there is no weaker old-shape compatibility branch.

## Verification and rollout

Focused synthetic tests cover privacy, retries, proposals, late revocation,
clock faults, stalled exporters, exact receipts, node freshness and gateway
attempts. The disposable PostgreSQL driver covers the full migration chain,
existing-history upgrade, immutable replay/concurrency/restart, canonical
outcome separation, role/privilege boundaries and retention.

The final command results and generated bundle pin are recorded in the
[closeout addendum](RUNTIME-STEPS-0-2-CLOSEOUT.md#2026-08-31-observability-and-overflow-deferral).
No real provider or live database was used for these new tests. Deploy the
matched gateway/provider/runtime and migrations through the existing reviewed
rollout process. A new immutable runtime activation and compatible package are
required; do not rewrite an old activation or relabel its historical proof.
Deferring overflow removes an optional capacity project, not the security
conditions for any execution path actually enabled for partners.
