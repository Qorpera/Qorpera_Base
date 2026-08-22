# Qorpera Hosted Primary v1

> Historical record through 2026-08-17. The current clean Step 1 project and
> its remaining NAS deployment gate are recorded in
> [`supabase/CLOUD-CONTROL-PLANE-ACCEPTANCE.md`](supabase/CLOUD-CONTROL-PLANE-ACCEPTANCE.md).

**Status:** Desktop profile binding, orthogonal account/placement/execution/sponsor product projection, durable attended-chat synchronization, restricted offline recovery, realtime sync wake-ups, online access revocation, profile-scoped content-addressed objects, immutable company-tree workspace heads, automatic publication/workspace inbox, explicit preview/merge UX, composite substrate versions, immutable artifact indexes, conservative retention analysis, verified reachability graphs, expiring restore proofs, recoverable service-owned cleanup, outbound runner registration with short-lived leases, disposable runner execution, the job-scoped runner object broker, atomic runner-output substrate publication, immutable runner and model usage observations, the leased-job model gateway authority and job-private socket handoff, the rootless Podman execution backend, restart-safe single-lane worker orchestration, standalone worker packaging, and the sandbox-probe image contract implemented
**Date:** 2026-08-17
**Scope:** Shared company control plane with local execution

## Decision

Qorpera will introduce a small hosted primary before operating Qorpera Computers.

The hosted primary owns the state that cannot be coordinated safely through Git or machine-local files:

- Account-authenticated profile identity.
- Membership, invitations, and access roles.
- Stable environment and shared-session identifiers.
- Ordered shared-session events.
- Later, execution-target registration, job leases, and usage.

The company environment remains portable and inspectable. The hosted database is an operational journal and index, not a mandatory company ontology. Hosted trail segments and referenced payloads must be materializable into the documented company export format. A database-only export is not a valid company export.

## Product boundary

Every profile has an explicit `profileType` discriminator. Its application identity is namespaced as `local:<uuid>` or `cloud:<uuid>`, so the type is part of the identity rather than inferred from the active account or folder. Accounts never determine that type; they are owners or members of a profile.

### Commercial entitlement

- Product entitlement belongs to the account. A cloud-enabled account can place its profiles in local or hosted mode without buying a separate plan for each profile.
- Profile membership roles govern access and authorization, but do not grant or redefine an account's product capabilities.
- Hosted costs occur in profile scope: active seats, retained storage, compute, and model usage are measured against the profile where they occur.
- A cloud-enabled account pays its own seat and attributable execution or model usage by default, regardless of how many profiles it joins.
- Every hosted profile also has one explicit billing sponsor account for retained storage, shared infrastructure, and optionally sponsored member seats. The owner is the default sponsor, but sponsorship can transfer only through an explicit accepted operation.
- Immutable usage facts carry `profile_id` and `actor_user_id`; authorization records separately identify who approved bounded paid work. Later billing-attribution records add `billing_account_id` without rewriting those execution facts. This separates where usage happened, who caused and authorized it, and which account ultimately pays.
- Adding hosted profiles or storage increases the sponsor's bill. A sponsor may cover a non-cloud member's seat without requiring that member to buy an independent subscription.
- Automatic 50/50 splitting is not a valid default. Attributable usage follows its actor; shared costs follow the sponsor. Cost-sharing can remain a report or a later explicit invoicing arrangement.

### Local profile

- `profileType` is `local` and the installation assigns a stable local profile UUID.
- Profile state and access exist only on that installation.
- Worktrees and execution remain local.

### Cloud profile

- `profileType` is `cloud` and the hosted primary assigns its stable profile and environment UUIDs.
- Members see the same profile identity, access policy, and attended agent chats.
- `viewer` can read.
- `contributor` can read, write, and communicate but cannot authorize.
- `admin` can authorize and manage non-admin access.
- `owner` controls the profile and full-access membership.

### Execution placement

- Execution location is independent of profile type.
- A cloud profile may attach to local company folders, Git worktrees, and local runners on many machines.
- A future Qorpera Computer attaches to the same cloud profile and shared sessions without changing their identities.
- The UI marks each worktree or session execution target as local or cloud separately from `profileType`.

### Qorpera Computers

- A hosted runner uses the same future runner protocol as a local runner.
- Compute placement is not part of session identity.
- Persistent computers can sleep while their session and workspace references remain available.

## v1 topology

```text
Desktop shell
  | Supabase account session
  v
Hosted-primary RPCs
  |-- PostgreSQL: profiles, members, environments, sessions, event indexes
  |-- private object storage: profile-scoped SHA-256 chunks and file manifests
  |-- runner-control: hashed pairing/session tokens and short-lived job leases
  `-- runner-broker: lease-scoped verified substrate reads and bounded artifact writes

Local company kernel
  |-- company folder and Git
  |-- local worktree
  `-- local integrity-checked trail
```

The desktop uses only a publishable Supabase key and the signed-in user's access token. Mutation tables have no direct client write grants. Security-definer RPCs apply authorization, and row-level policies provide a second read boundary.

Each machine stores a company-folder attachment under the shell's user-data directory, outside the company folder. The attachment is a discriminated local or cloud profile identity. A clone can attach to the same cloud profile and environment on another machine, while export, import, and fork never copy that live association or its authority. Account identity is deliberately absent from this attachment; hosted membership authorizes the signed-in account independently.

## Validation status

- The baseline and profile-management migrations were deployed to the prior Qorpera Auth project.
- Six hosted-primary tables have RLS enabled and authenticated clients have no direct write grants.
- All profile, membership, environment, session, and event mutations are exposed through security-definer RPCs with an empty search path.
- Typed client and per-profile attachment tests pass.
- Profile attachment schema v2 stores identity and promotion state without embedding a product plan. The desktop setup and Settings surfaces now present account entitlement, profile placement, per-session execution target, and billing sponsorship independently; v1 `free`/`cloud`/`computer`/`hq` attachment records migrate without treating those legacy labels as authority.
- A two-machine integration test round-trips chunked messages through the hosted event stream, materializes them into verified local trails, exercises viewer pull-only access, and continues appending through live audit bindings.
- The client-session identity migration was deployed to the prior Qorpera Auth project. A transactional hosted smoke test verified idempotent session creation, client-identity listing, event append/retry/read, and stale-sequence rejection without leaving test data behind.
- A real cross-account test passed between an owner on Windows and an invited contributor on a physical Mac. The contributor accepted an explicit partial-access invitation, attached a local checkout to the same cloud profile, read the shared staff trail, and appended a message that appeared in the owner's live Windows trail.
- Account-bound profile and team caches now survive hosted-primary outages for up to 30 days. Cached roles preserve reading and contribution, while authorization and member management fail closed until the server is reachable.
- Staff and attended-trail synchronizers checkpoint after each durable unit, persist exponential retry state across restarts, coalesce concurrent triggers, and reuse deterministic event IDs after ambiguous remote commits.
- An isolated desktop outage test opened a previously validated cloud profile without the hosted service, showed both channels as reconnecting with persisted retry schedules, disabled authority mutation, then recovered both channels to healthy after connectivity returned.
- Profile-scoped Realtime subscriptions now wake the durable trail and staff synchronizers from lightweight shared-session and staff-row changes. The persisted polling loops remain authoritative recovery, and large trail bodies never travel through the Realtime invalidation channel.
- A bounded access-state projection now survives membership deletion and remains readable by its subject. Connected checkouts fail closed immediately on their own role change, confirm the authoritative role, stop running agents when write access is lost, and return to the hub when membership is revoked. A live owner/contributor test confirmed a contributor-to-viewer transition and restoration across two authenticated clients in under one second.
- A private profile-scoped object bucket now stores immutable SHA-256 objects up to 8 MiB. Larger in-memory files are split into deterministic 4 MiB chunks and represented by a content-addressed manifest; every existing object and every download is rehashed before use. A live owner/contributor test verified upload, cross-account download, integrity, and deduplication against the same file and manifest hashes.
- Logical company working trees now have deterministic content-addressed manifests. Their layer boundary is explicit: company Git history, session trails, the hosted staff registry, product Git checkouts, and dependency caches remain separately authoritative instead of being duplicated into every tree snapshot. Materialization verifies the manifest, every file manifest, every chunk, path containment, case-folded uniqueness, and Win32 device/alternate-stream namespace safety before writing.
- Each local company attachment has a stable client-workspace UUID and a durable pending checkpoint record outside the company folder. Hosted workspaces use compare-and-swap heads over immutable snapshot rows, can fork from any snapshot in the same environment, and retry an ambiguous commit with the same client-snapshot UUID. A deterministic `PT409` discards the stale pending identity and surfaces the head conflict for explicit resolution instead of wedging every later checkpoint or silently overwriting the remote tree.
- The workspace/snapshot migrations are deployed. A live owner/contributor test created a shared base, advanced two independent fork heads concurrently, verified cross-account object reads and idempotent replay, and rejected a stale same-workspace commit without disturbing either fork. Deterministic head conflicts use PostgREST's explicit `PT409` application status instead of retryable transaction SQLSTATE `40001`.
- The automatic publication engine debounces logical company-file changes, retains steady polling as recovery, skips separately authoritative layers, and avoids duplicate snapshots when the tree is unchanged. A durable workspace inbox resolves every local and remote head to a verified immutable tree reference; Realtime updates that inbox but never writes into the active company folder.
- Snapshot lookup and single-writer workspace enforcement are deployed. A live contributor test read an owner-authored head and its object payload, was denied when it attempted to advance the owner's workspace, then advanced another contributor-owned fork and observed the new head through Realtime and the persisted inbox.
- Cloud company publication and inbox synchronization now start and stop with the desktop company runtime, share its kernel-owned transaction capability, and serialize captures behind runtime transitions so an active agent turn cannot race a checkpoint. Realtime workspace changes refresh the inbox without applying files.
- Settings now lists each computer's immutable workspace head. Preview materializes a verified remote tree outside the company folder. Review discovers the common snapshot ancestor and computes a three-way plan; divergent or structural changes refuse, unpublished local edits refuse, and only a second explicit merge action can apply a conflict-free plan. Application stages and rolls back logical files under the existing company transaction boundary while leaving trails, staff state, Git checkouts, and dependency caches untouched.
- New cloud checkouts fork the most recently published environment head instead of scaffolding an unrelated history. A live desktop QA test created a remote fork, received it through the workspace inbox, opened a verified preview, reviewed one conflict-free change, merged it into the active checkout, published the resulting local head, and then reported the remote fork as already included.
- Hosted staff changes and shared-session head advances now append immutable, profile-wide operation receipts with one monotonic sequence. Existing staff and session heads were backfilled during deployment, so mutable staff rows have a replayable history and session trails remain referenced by their immutable ordered event records rather than copied into every company snapshot. Event hashes are server-generated correlation fields; the client does not yet provide independent chain verification or a tamper-evidence guarantee.
- Composite substrate versions now bind one immutable company-tree snapshot to an exact operation-journal watermark. The desktop captures them only after staff and trail synchronization, persists the client version UUID before the request for ambiguous-response replay, and exposes paged resolution for future fork and runner consumers. A production rollback-only QA used one writable member to capture a version and another profile member to resolve the same snapshot and exact operation count through RLS.
- Immutable artifact records and ordered artifact indexes are deployed. Every new composite substrate version references an index, including an explicit empty index when no artifact producer has supplied outputs yet. Artifacts receive a default 30-day recovery grace, and owners or admins can place and release retention holds.
- Reference-aware garbage-collection analysis is deployed. It returns only expired, unheld artifacts that are absent from every retained substrate index. A production rollback-only QA verified cross-account index resolution, hold behavior, reference exclusion, and the deletion-disabled guard without leaving test data behind.
- Immutable object reachability graphs now cover direct objects, file manifests and their chunks, and company-tree manifests, file manifests, and chunks. Uploads are bounded to 500 entries per request; the server verifies every object path and byte length, then independently recomputes the canonical graph hash before completion.
- Desktop publication reconstructs and rehashes the complete snapshot or artifact before issuing a seven-day restore proof. Cleanup readiness requires independently verified closure coverage for every live root, plus a current candidate proof and current candidate Storage availability; unrelated historical roots no longer require weekly full-content proof downloads. Production rollback-only QA rejected a wrong-size graph entry, completed a proof over a real stored object, confirmed incomplete profile coverage blocks cleanup, and left no QA records behind.
- Recoverable cleanup plans and the separately deployed service-role Storage worker are live. Owners and admins can prepare, inspect, cancel, and retry plans without receiving object paths or deletion authority. Plans wait at least 24 hours; claim and root writes share a per-profile row fence; every Storage batch renews its exact lease; newly shared objects remain retained; and completion refuses while any acknowledged Storage row remains. An abandoned deleting plan becomes owner-cancellable after its lease and stale-request grace expire. The five-minute worker schedule uses an existing Vault-held secret; authenticated desktop accounts cannot claim work. A live zero-job invocation returned HTTP 200, an unauthenticated invocation returned HTTP 401, and rollback-only account QA left no plan or audit rows behind.
- Outbound runner registration and short-lived job leases are deployed. Owners and admins create retry-safe pairing records; contributors can enqueue work against an exact environment and immutable substrate version but cannot register runners. Raw activation, session, and lease tokens are generated locally, while Postgres stores only SHA-256 hashes. Runner sessions rotate on heartbeat, leases last two minutes, revocation clears both current and recovery authority, and unfinished work requeues up to an eight-attempt ceiling. A disposable local lifecycle covered ambiguous-response retries, and rollback-only production QA covered registration, contributor enqueue/cancel, service-only activation, heartbeat rotation, claim, renewal, idempotent completion, audit receipts, and revocation. A live synthetic unknown-token request returned HTTP 401, and all QA runner tables were empty afterward.
- Claimed jobs now have a strict disposable execution contract. The host resolves the job's exact immutable substrate, verifies and materializes its company tree, ordered operation journal, and artifact index into read-only inputs, exposes only a separate private output directory, passes an explicit non-secret environment, enforces input/output/result/deadline limits, rejects linked or special output, and cleans the workspace on success or failure. Normal execution refuses a backend without rootless-container or microVM guarantees; the current in-process backend is explicitly test-only, so no production customer code or NAS process has been started.
- The job-scoped runner object broker is deployed. A runner presents its rotating session token and active lease token only in headers; the Edge Function hashes them before invoking service-only RPCs and never gives the runner a database, Storage, or signed-URL credential. Reads are limited to objects proven reachable from the job's exact snapshot and artifact index. Direct outputs are limited to 8 MiB each, 100 objects, and 64 MiB per job; every upload is rehashed and can become durable only through an immutable artifact plus a complete reachability graph and restore proof. The shell broker follows token rotation, publishes scanned sandbox output deterministically, and loses authority when the job completes or fails. Live validation confirmed the deployed endpoint rejects malformed traffic with HTTP 400 and structurally valid unknown runner authority with HTTP 401; database checks confirmed RLS, service-only entry points, and lease-row serialization.
- Successful runner completion now atomically publishes registered outputs as a child substrate. The child preserves the source company snapshot and exact operation watermark while replacing the artifact index with the ordered union of source artifacts and that job's outputs. Deterministic publication UUIDs make ambiguous completion retries idempotent. Concurrent sibling jobs create independent children and never silently merge. Production rollback-only QA completed and replayed one job, completed a concurrent sibling, verified exact lineage and output isolation, and confirmed the transaction left no QA rows.
- A rootless Podman backend now implements the first production container boundary. It requires a local Linux Podman 5+ runtime with rootless mode, cgroups v2, and seccomp; accepts only digest-pinned preloaded images; removes network, inherited environment, image writes, capabilities, and shared namespaces; enforces CPU, memory, swap, PID, result, output-filesystem, and independent container wall-time limits; and force-removes named containers before termination completes. The trusted entrypoint remains alive after reporting its result, the host confirms the container is still running, copies bounded outputs from tmpfs, and only then destroys the boundary. Startup removes only exact Qorpera container/workspace names left by an interrupted process. Focused tests verify the exact command boundary, stdin-only job payload, fail-closed runtime inspection, cancellation and restart cleanup, live-result transport, and real subprocess output bounding. No real Linux worker or NAS process was started.
- Runner authority and orchestration now survive process restarts. A private atomic state record preserves pending token rotations, ambiguous claims, exact leased job projections, lease tokens, and staged completion results without exposing them in status snapshots. The single-lane worker preflights containment before claim, restores or renews existing work, serializes heartbeat and lease renewal during execution, connects broker input and output, and replays a staged completion without rerunning the container. Focused tests cover restart at activation, claim, and completion boundaries, private-file replacement, renewal during work, deterministic failure classification, and shutdown without false job failure.
- The restart-safe worker now has standalone Node packaging, strict file-backed configuration, cooperative `SIGINT`/`SIGTERM` shutdown, and a dedicated systemd user-service contract. Initial activation accepts only the named systemd credential, then restart uses the private rotating authority record without retaining the credential source. The OCI source bundles a minimal `sandbox_probe` that verifies its immutable substrate mount and emits a bounded output proof. A build script requires a digest-pinned Node base, signs the pushed digest with Cosign, and verifies the configured OIDC identity. Portable configuration, credential, restart, signal, package, stdin-bound, substrate, and output tests pass on Windows; registry signing, systemd, rootless Podman, cgroups, seccomp, and container escape behavior remain explicitly unverified until the disposable Linux VM gate.
- A headless Linux containment harness and GitHub Actions workflow now exercise the real `RootlessPodmanSandboxBackend` against a locally built digest-pinned probe image. The probe asserts read-only input, a read-only image root, no non-loopback network interface, exact cgroup CPU/memory/PID limits, private output, and destruction of the named container. The workflow is pinned to the current Ubuntu 26.04 hosted VM because its published image includes Podman 5; it rechecks the runtime and fails closed. The live workflow passed the real containment, ShellCheck, systemd-unit, and retained-container gates. It does not replace the later dedicated-user lingering and host-reboot VM test.
- Successful runner completion now records one immutable `qorpera.runner-usage/v1` observation in the same transaction as output publication and terminal job state. The record binds profile, environment, job, runner, actor, applied limits, execution time, and verified byte counts; reserved CPU and memory capacity are derived server-side. Replays are idempotent and altered observations fail. The ledger intentionally has no payer field, so later entitlement and sponsorship policy can attribute charges without rewriting execution facts or forcing contributors to pay.
- A leased-job model gateway authority now separates the networkless runner from provider credentials. An owner or admin can bind exact provider/model pairs and cumulative token/call ceilings to one queued job; the Edge broker reserves against the live lease, forwards a credential-free request to a controlled gateway, and records one immutable provider-usage observation. The job actor and policy authorizer remain separate from the future billing account. The database, Edge, host transport, replay, and fake-gateway tests are local; production deployment and account-entitlement enforcement remain.
- The networkless Linux sandbox now receives model access only through a mode-`0600`, job-private Unix-domain socket owned by the trusted worker. Windows named pipes are rejected because this implementation does not establish an equivalent per-job ACL boundary. The bounded single-frame protocol routes to the current leased `CloudRunnerJobBroker`, limits concurrent and total requests, returns generic failures, exposes no authority or provider credential, and closes with the container. Protocol validation, workspace lifecycle, worker, and exact Podman-command tests pass on Windows; Unix socket and container-client coverage runs on Linux, and the updated real Linux containment probe remains to be run.
- Durable invitation email delivery is deployed as a Postgres outbox plus a secret-authenticated Supabase Edge Function using Resend idempotency keys. Sender-domain verification, provider secret, and the one-minute worker are configured; live delivery and the HTTPS-to-desktop invitation handoff were verified.
- These historical migrations were applied to the prior project through the SQL editor because no management credential or Supabase CLI was configured locally. That project did not contain Supabase CLI migration history. The clean Step 1 project instead records all repository migrations normally through the CLI.

## Shared event rules

- Each session has a server-issued UUID and a profile-unique client-session UUID copied from the originating trail header. Filenames and worktree paths are never identities.
- Events are ordered by a per-session sequence.
- Appends take a caller-generated event UUID for idempotent retries.
- An optional expected sequence prevents accidental writes against stale state.
- Events carry server-generated SHA-256 hashes as correlation fields; clients do not yet verify the chain, so it is not a tamper-evidence guarantee.
- Account RPCs always stamp `auth.uid()` as the actor; clients cannot impersonate an agent or kernel.
- `authorization_decision` requires `owner` or `admin` access.
- Agent and kernel observations will use short-lived runner capabilities through a separate service boundary.
- Portable trail entries are split into deterministic 128 KiB parts, keeping every event below the hosted 256 KiB boundary. Large artifacts and company files use profile-scoped content-addressed chunks. Logical company-tree manifests, fork-safe workspace heads, automatic change publication, explicit three-way merging, composite substrate watermarks, immutable artifact indexes, retention holds, verified object reachability, restore proofs, and reference-aware cleanup are implemented. Object removal is available only through an explicit recoverable plan and the service-owned worker.

## Agents-only runtime integration

- Trail sharing gates on the `company-agent` actor. Agent scopes are stamped unattended and attendance is a per-turn fact on kernel inputs, so a conversation becomes shareable once a person actually writes in it; wake/job groups, subagent trees, autonomous runs, and product worktrees stay machine-local. Materialized shared chats carry the agents-only authority shape.
- The company-tree contract is v2. In addition to the v1 omissions (Git history, trails, staff registry, product checkouts, dependency caches), v2 omits per-agent `instructions.md` files — the charter is part of the separately-authoritative staff layer and travels through staff sync — per-agent `memory.md` (mutable every-turn state whose synchronization needs its own layer rather than fork-with-tree snapshot semantics), and the operational mail surfaces: `inbox/` authority gates and trigger events, and the `.qorpera/agent-messages.json` delivery ledger. Published v1 manifests keep validating against the v1 rules forever. Agent artifacts, per-agent skills, connector manifests, and shared `files/` are company work product and publish normally; connector manifests carry secret names only, and secret values never live inside the company folder.
- The hosted staff roster carries `lifecycle_state`, `appearance_creature`, and the per-agent model selection (`model_provider`/`model_id`) so the authoritative cloud replacement cannot downgrade an active agent to setup behavior, strip its appearance, or silently reset its chosen model to the company default. The local replacement writes each agent's instructions file alongside the registry.
- Routines, connection requests, and credentials are deliberately machine-local standing authority: a company synced to another machine arrives with agents and artifacts but without recurring work or credentials until they are granted there. Hosted placement for these is the declared `hostedCompanyState` capability, not tree snapshots.

## Compute servers (planned)

- Compute servers have internet; agent processes do not. Terminal, browser, and file capabilities are host-side brokers the sandboxed agent requests through job-private channels, following the model-gateway socket pattern. Every brokered action is observable in the trail.
- Credentials live in a vault agents can request from but never read: the local company vault (OS-protected, `secret://` references dereferenced only kernel-side) extends to the declared `hosted-kms-vault` placement for cloud execution, so compute-server jobs use credentials without the values entering any agent context.
- Cross-account separation rests on RLS plus security-definer RPCs, profile-scoped object prefixes, and lease-scoped runner reads. Closing DBTEST-1 (role-based behavioral tests for RLS and the grant matrix) is a prerequisite for hosting multiple real customer accounts.

## Failure model

- If the hosted primary is unavailable, local profiles remain available. A cloud profile with a validated account-bound cache can reopen for reading and contribution; authorization and membership management fail closed, and outbound synchronization retries durably in the background.
- A connected cloud checkout receives role changes and revocation immediately. A machine that is offline cannot receive that signal and may retain cached contribution access until it reconnects or the 30-day cache expires; managed Qorpera Computers must therefore use short-lived runner leases before they are allowed to execute unattended work.
- A cloud profile without a prior validated cache, or with a cache older than 30 days, fails closed.
- Signing out clears the remembered account projection. An expired account session may restore only the last validated local identity while refresh is unavailable; hosted authorization still depends on the restricted cached team projection.
- Invitation creation commits independently of email delivery. Provider outages leave a visible queued or retrying state; cancellation, decline, acceptance, and expiry remove the associated outbox row.
- Invitation emails are provider-idempotent and database-leased. Ambiguous provider success is retried with the same invitation-derived key after the lease expires.
- Retrying an accepted append with the same event UUID and content returns the existing event.
- A reused event UUID with different content fails.
- Concurrent session appends serialize on the session row.
- Filesystem events only accelerate company publication; periodic full logical-tree capture remains the durable recovery path. An unchanged tree does not create another snapshot.
- Each workspace is single-writer. A remote advancement of the same workspace places local publication in an attention state instead of rebasing or overwriting silently.
- Realtime workspace invalidation refreshes a separate local inbox. Remote heads are never applied to the active company folder without a verified preview/review path and an explicit merge action; conflicts or unpublished local edits leave the folder unchanged.
- Restore proofs expire after seven days. A missing, incomplete, or unverified closure blocks cleanup for the entire profile; an expired candidate proof blocks its plan. Unrelated verified roots do not require repeated full-content proofs. Cleanup never weakens retention or falls back to root-only deletion.
- Cleanup plans remain cancellable throughout their 24-hour recovery window. Active removal is not cancellable; after its lease and a one-minute stale-request grace expire, an owner or admin can cancel an abandoned deleting plan to lift the profile fence. Failures resume idempotently, and completion requires both an empty pending set and absence of every acknowledged Storage object.
- Runner activation links expire after 15 minutes. Active sessions last 15 minutes and retain the previous token for two minutes for direct ambiguous-response replay; a later retry recovers through the durably staged next token. Fully expired active sessions can be returned to pairing by an owner or admin without deleting the runner registration. Job leases last two minutes, can be renewed only by the active runner, and can be reassigned after expiry. Revocation wins the runner-row lock and prevents any later claim assignment.
- Runner object reads and writes revalidate the current session and exact active lease on every request. Output authorization, confirmation, and artifact registration hold the job-row lock, so completion, failure, expiry recovery, or revocation cannot race a new durable output root. Broker access fails closed as soon as the lease is unavailable.
- Runner completion holds the same job-row lock while it creates the output artifact index, child substrate, and terminal job record. Failed, requeued, cancelled, or expired work cannot publish a child. A lost completion response retries the same deterministic artifact-index and substrate-version UUIDs. Concurrent jobs fork from their shared parent independently; joining sibling outputs requires a later explicit operation.
- The NAS is not required for profile, membership, or shared-trail availability.

## Deployment sequence

Migration-history note: `20260816003000_profile_promotion_identity.sql` was renamed to `20260816003500_profile_promotion_identity.sql` before any Supabase CLI migration history was initialized. The 2026-08-16 migrations already applied through the SQL editor must be reconciled under the unique `03500` version when migration history is created; do not record the removed duplicate `03000` filename. Environments that received the earlier SQL-editor deployment must also apply `20260817004000_review_blocker_hardening.sql`, `20260817005000_gc_retention_correctness.sql`, `20260817006000_runner_recovery_ambiguity.sql`, and `20260817007000_collaboration_ops_hardening.sql` in order before artifact cleanup, real runners, provider calls, or invitation acceptance are enabled. The first migration permits deletion authority only for exact direct-object closures verified from relational metadata; client-restored manifest graphs remain useful for integrity analysis but fail closed for physical cleanup until manifest closure is independently verified by a service boundary. The second adds the shared profile fence, per-batch lease renewal, expired-plan escape hatch, and closure-based proof-cost model. The third makes runner ambiguity recoverable and prevents usage facts from being mutated or cascade-deleted. The fourth requires authoritative verified-email ownership for invitation decisions and makes access projection safe during profile and Auth-user cascades.

1. Apply `supabase/migrations/20260816000000_hosted_primary_v1.sql` and `supabase/migrations/20260816001000_hosted_profile_management.sql` to the target project. Complete.
2. Exercise profile creation, invitation acceptance, session creation, append retry, stale-sequence rejection, and cross-account reads. Complete across Windows and a physical Mac.
3. Bind typed profile identity, local-to-cloud enablement, folder attachment, and the existing team UI to the hosted client. Complete.
4. Add durable event-to-trail materialization, account-bound offline membership caching, persisted retry health, and ambiguous-commit recovery. Complete for attended controller and staff chats.
5. Deploy the invitation-delivery migration and Edge Function, configure the verified sender and provider secret, and schedule the one-minute worker. Complete; live email delivery and desktop handoff verified.
6. Add profile-scoped Realtime invalidation for shared-session and staff operations. Complete locally and in production; live owner/contributor trail and staff materialization verified across isolated workspaces.
7. Add revocation-safe membership invalidation and runtime enforcement. Complete locally and in production; live role downgrade and restoration verified across two authenticated clients.
8. Add content-addressed object payloads for artifacts and company files. Base object/chunk transport complete locally and in production.
9. Add immutable logical company-tree manifests and fork-safe workspace heads. Complete locally and in production; live two-account concurrency and conflict behavior verified.
10. Add automatic file-change publication and the persisted remote-workspace inbox. Complete, including desktop lifecycle wiring, runtime serialization, and Realtime refresh.
11. Add explicit preview/merge operations. Complete, including verified previews, common-ancestor three-way review, conflict refusal, rollback-safe application, fresh-checkout lineage, and live desktop UX validation.
12. Add composite substrate version pointers. Complete locally and in production; durable ambiguous-response retry and cross-account resolution verified.
13. Add artifact records, immutable indexes, retention holds, and reference-aware garbage-collection candidates. Complete locally and in production; physical deletion remains disabled.
14. Add verified object/manifest/chunk reachability, recovery grace enforcement, expiring restore proofs, and profile-wide cleanup readiness. Complete locally and in production; automatic snapshot proof publication is wired into the desktop lifecycle.
15. Add the separately deployed service-role Storage cleanup worker with an immediate proof recheck, exclusive-object plan, recovery window, idempotent retries, and audit receipts. Complete locally and in production; explicit plan-driven cleanup is enabled and automatic cleanup remains disabled.
16. Define and implement the outbound runner registration and lease protocol in disposable local environments. Complete locally and in production; no physical runner or NAS was involved.
17. Add the disposable execution-bundle and sandbox-backend contract. Complete locally with verified substrate materialization, bounded output publication, cancellation, cleanup, and fail-closed backend selection; a production containment backend remains required.
18. Add the runner-scoped object broker and connect verified sandbox input/output to it. Complete locally and in production for exact substrate reads and bounded direct artifact writes.
19. Publish registered runner outputs as an atomic child substrate on successful completion. Complete locally and in production, including deterministic retry and concurrent-sibling rollback QA.
20. Implement the rootless Podman backend and restart-safe single-lane worker for disposable Linux worker VMs. Complete locally at the command, credential-persistence, lease-maintenance, broker, publication, and completion boundaries.
21. Package the worker and first signed-image contract. Standalone worker/probe bundles, strict configuration, systemd user unit, one-time credential handoff, sandbox-probe OCI source, digest-signing script, and headless Linux containment workflow are complete; portable and hosted Linux containment tests pass. Building/signing against a real registry and dedicated-user/reboot VM acceptance remain.
22. Record immutable runner resource observations independently from billing attribution. Complete locally: the sandbox reports its applied limits and bounded metrics, v3 completion validates and inserts one idempotent profile/job/actor observation, members can page the ledger, and corrective constraints/triggers prevent mutation or cascade deletion. Production migration and rollback-only QA remain.
23. Add leased-job model gateway authority and immutable provider observations. Complete locally at the database, Edge request, host transport, explicit authorization, token budget, recoverable ambiguity, exact over-reservation usage, idempotency, bounded response, and secret-separation boundaries. Production deployment and account-entitlement enforcement remain.
24. Mount a job-private Unix-domain-socket adapter so the networkless sandbox can call the trusted host model broker. Complete locally for protocol, lifecycle, client, worker, packaging, and Podman command boundaries; rerunning the real Linux containment workflow remains.
25. Founder decision 2026-08-18: the NAS never runs agent execution. It is the self-owned host for company data; its first data role is object storage for company files once the retention layer no longer queries `storage.objects` directly. Register the first real runner on dedicated compute hardware only after that machine's storage, network, backup, isolation, and restore baseline is ready. Runners receive a forked immutable substrate, operate on it on their own machine, and publish back through the existing atomic child-substrate path; continuous work visibility for long-running agents is a planned slice (checkpointed job chains), with live trail sync already carrying the narrative in real time.

## Not in this slice

- Remaining non-blocking review findings are grouped by subsystem and deployment gate in [`CLOUD-HARDENING-BACKLOG.md`](CLOUD-HARDENING-BACKLOG.md).
- Building and signing the execution image in a real registry, live Linux systemd/rootless-container validation, optional microVM execution, and physical runner-host hardening.
- Autonomous scheduling policy and separately approved named network/tool adapters.
- Chunked runner outputs above 8 MiB, explicit sibling-substrate merge/rebase, automatic orphan-output cleanup, automatic retention-policy cleanup, and object compaction.
- Autonomous-run, product-worktree, file, and artifact synchronization.
- Account entitlement, sponsorship attribution, pricing, credits, and invoicing. Raw successful runner resource observations are implemented separately.
- Automatic migration of existing local membership records.

These are subsequent slices over the stable profile, environment, session, and event identities established here.
