# Runner usage observations

Runner completion records one immutable resource observation in the same transaction as the terminal job state. This is an operational fact ledger, not an invoice ledger.

Each observation binds:

- The profile and environment where the work happened.
- The exact runner job and runner that executed it.
- The profile member who created the job.
- Successful sandbox execution time and verified input, output, and result bytes.
- The CPU, memory, process, wall-time, input, output, and result limits actually applied by the worker.
- Server-derived reserved CPU-milliseconds and memory-MiB-milliseconds.

The sandbox emits `qorpera.runner-usage/v1` inside its bounded completion result. `qorpera_complete_runner_job_v4` validates every numeric field, cross-checks output bytes, derives reserved capacity itself, completes the job through the existing idempotent v2 publication transaction, and inserts the observation before that transaction commits.

One job can have only one observation. Replaying the same completion returns the existing job and observation; changing any observed value fails. Failed, cancelled, requeued, and expired jobs do not create successful-execution observations.

Both runner-resource and provider-model observations are append-only even to service-role application paths. Update and delete triggers reject mutation, and restrictive profile, environment, job, and model-request references prevent parent deletion from cascade-deleting usage history. Product deletion must therefore use a later retention/redaction process that preserves the financial fact instead of deleting these rows implicitly.

## Billing boundary

Usage observations intentionally contain no `billing_account_id`.

They answer:

- Where did usage happen?
- Who caused it?
- What bounded resources did the worker reserve and consume?

They do not answer who pays. A later entitlement and sponsorship service can attribute an immutable observation to the actor account or profile sponsor under a versioned policy. Keeping attribution separate allows a company to sponsor a contributing member without rewriting execution history or forcing that member to buy a plan.

Automatic 50/50 cost splitting is not inferred from profile membership.

## Access and authority

- Only the service-role runner completion path can create observations.
- Authenticated clients have no direct table grants.
- Any current profile member can page observations through `qorpera_list_runner_usage`.
- A runner supplies no account, billing, database, or Storage credential.
- The Edge Function hashes runner authority before invoking the completion RPC.

## Deployment

1. Apply `migrations/20260817002000_runner_usage_observations.sql` after the runner output-substrate migration.
2. Apply `migrations/20260817006000_runner_recovery_ambiguity.sql` before any paid provider call.
3. Deploy the updated `functions/runner-control`; its completion action calls `qorpera_complete_runner_job_v4`.
4. Complete and replay a disposable job, confirm exactly one observation, and confirm a changed replay is rejected.
5. Confirm a non-member cannot list the profile ledger, authenticated clients cannot write the table directly, and parent deletion cannot cascade-delete an observation.

Model-token, approved-network, storage-retention, and seat observations can use the same fact-versus-attribution boundary later. Provider calls, pricing, credits, invoices, and payer selection are not implemented by this slice.
