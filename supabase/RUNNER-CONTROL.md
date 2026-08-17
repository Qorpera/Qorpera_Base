# Runner control operations

Runner control is an outbound-only protocol for disposable local runners and future Qorpera Computers. The hosted primary owns registration, immutable job references, short-lived leases, revocation, and audit receipts. It does not give a runner a database service credential.

The NAS is not involved in this slice.

## Authority boundary

- An owner or admin registers and revokes a profile runner through account-authenticated RPCs.
- A contributor, admin, or owner can enqueue work for an exact environment and composite substrate version. An optional shared session must belong to the same environment.
- The registration client generates a 32-byte activation token before the request and persists it locally for ambiguous-response retry. Postgres stores only its SHA-256 hash.
- The runner sends the activation token to `runner-control` and supplies a new session token. The Edge Function hashes both and calls service-role RPCs; the raw tokens are never written to Postgres or audit receipts.
- Heartbeats rotate the runner session token. The new session lasts 15 minutes; the previous token remains valid for two minutes only to recover a lost heartbeat response with the same renewal UUID.
- Job claims generate independent client-lease and lease-token values. A lease lasts two minutes and can be renewed while its runner session remains valid.
- Revocation clears current and previous session authority immediately. Unfinished leases return to the queue unless they have exhausted eight attempts.

Runner capabilities are deliberately narrow:

- `agent_turn`
- `git_worktree`
- `company_substrate`

These are scheduling constraints, not authorization scopes for direct database or Storage access. A job payload references an immutable substrate version. File and artifact access uses the separately deployed job-scoped broker documented in `RUNNER-BROKER.md`.

## Worker authority persistence

The production worker opens its runner through a private authority store rather than keeping rotating tokens only in memory. The state file is atomically replaced, fsynced, bounded to 256 KiB, owned by the unprivileged runner service account, and restricted to mode `0600` inside a mode `0700` state directory. Symbolic-link paths and permissive Linux ownership or modes fail closed.

The durable record includes only the authority needed to recover protocol ambiguity:

- Pending activation and heartbeat tokens plus their stable renewal UUIDs.
- A pending claim UUID and lease token.
- Exact leased job projections and their lease tokens.
- A bounded completion result staged before the completion request.

After restart, the worker reuses the exact pending operation. It never generates a replacement token or completion identity until the previous operation is resolved. Public status snapshots expose job IDs and health only, never these tokens.

The first worker loop is deliberately single-lane. It validates the containment backend before claiming new work, restores a retained lease, renews it every 45 seconds, rotates the runner session during long jobs, connects the exact broker substrate to the sandbox, publishes outputs, stages completion durably, and then invokes atomic output-substrate completion. Graceful shutdown destroys the sandbox but retains lease authority so restart can recover or let the hosted lease expire; it does not falsely report a job failure.

## Deployment

1. Apply `migrations/20260816019000_runner_registration_leases.sql`.
2. Apply `migrations/20260817001000_runner_output_substrates.sql` after the object-broker migration to install job-attributed artifacts and atomic output publication.
3. Deploy `functions/runner-control` with JWT verification disabled as declared in `config.toml`. The function performs its own 43-character bearer-token validation.
4. Keep the Supabase secret key inside the Edge Function environment. Runner installations receive only the project URL, publishable key, runner UUID, and their current short-lived token.
5. Create a service-account-owned mode `0700` state directory and keep its authority file at mode `0600`. Supply the one-time activation token only for first initialization.
6. Verify a disposable lifecycle before registering physical hardware: register, activate, restart during activation, heartbeat, restart during claim, renew, execute, restart during completion, replay completion, revoke, and confirm that the revoked session is rejected.

The deployable worker package is under `deploy/ephemeral-runner`. It is a dedicated systemd user service, so rootless Podman receives a real user manager, home directory, and runtime directory. `LoadCredential=qorpera-runner-activation` supplies the activation token only when the private authority file does not yet exist; the source credential is removed after successful activation. The configuration rejects mutable image tags, unknown settings, credential-shaped container environment entries, and non-absolute host paths before the worker loop starts.

## Failure and recovery

- Registration, activation, heartbeat, claim, completion, and failure operations are idempotent when retried with the same client UUIDs, bodies, and locally retained tokens. Completion reuses deterministic artifact-index and substrate-version UUIDs derived from the job identity.
- A lost activation or heartbeat response reuses the pending next-session token. A lost claim response reuses its client-lease UUID and lease token.
- Expired leases can be claimed by another compatible runner. After eight attempts, an expired lease fails terminally.
- Retryable runner failures requeue work without changing its immutable substrate reference.
- Successful completion atomically creates a child substrate when the job registered outputs. It preserves the source company snapshot and operation watermark, unions the source artifact index with only that job's artifacts, and records the child on the completed job. Zero-output jobs complete without manufacturing a redundant child.
- Concurrent jobs that share a source substrate publish independent child substrates. They are never silently merged; a later explicit operation must select or combine sibling work.
- A completion result is durably staged before the network request. If the process or response is lost, restart submits that exact result and the existing deterministic artifact-index and substrate-version UUIDs without rerunning the container.
- Authority-state write failure stops the operation before a new token or lease is used. A graceful worker shutdown retains the current lease instead of marking the job failed; expiry recovery remains hosted and idempotent.
- Audit receipts contain runner/job identities, counts, capabilities, expiry timestamps, and state transitions. They never contain bearer, session, or lease tokens.

This protocol establishes scheduling and authority revocation. The disposable execution-bundle and containment contract is documented in `RUNNER-SANDBOX.md`, its Storage boundary is documented in `RUNNER-BROKER.md`, immutable successful-execution observations are documented in `RUNNER-USAGE.md`, and leased-job model authority is documented in `RUNNER-MODEL-GATEWAY.md`. Sandbox IPC, approved network-tool adapters, billing attribution, optional microVM isolation, and NAS readiness remain separate work.
