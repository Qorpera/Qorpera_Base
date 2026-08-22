# Step 1 cloud control-plane acceptance

**Status (2026-08-22):** The local contract gate, clean hosted Supabase gate,
and physical Windows/Mac-to-NAS end-to-end gate passed. The NAS service now has
stable named TLS ingress and an enabled DSM boot task. A reboot proof, migration
to a dedicated non-administrator service account, and an independent backup
target remain production operations gates, so the deployment must not yet be
described as production-ready.

## Scope

Step 1 proves a cloud-authoritative control plane that remains correct without
an open desktop or execution computer:

- Supabase owns canonical sessions and transcripts, queued inputs, scheduled
  wakes, immutable execution runs, claims and leases, runner registrations and
  assignments, sponsor/provider provenance, permissions, operation receipts,
  and Company File revision metadata.
- NAS/object storage owns immutable Company File objects, attachments,
  artifacts, proposals, and encrypted checkpoint objects. Supabase retains the
  authoritative object roots and transitions.
- Missing notifications cannot lose work: reconciliation reads durable rows.
- Missing execution capacity leaves work queued; it does not transfer authority
  to a desktop or runner.

Step 1 does not make provider requests, decrypt a personal provider credential,
run a native provider harness, provision a physical computer, or prove
all-member-devices-offline model execution. Those are step 2.

## Required invariants

1. A company session and its input order are canonical cloud rows shared by
   authorized members.
2. Each admitted turn or wake materializes one immutable run with pinned Company
   File, staff, sponsor, provider-connection, model-authority, and transcript
   boundaries.
3. Sponsor and provider provenance cannot be silently pooled, substituted, or
   rewritten after admission.
4. Job claims, runner assignments, capabilities, heartbeats, and leases are
   scoped, expiring, and transactionally reconciled.
5. Operation receipts make effects retry-safe and fence ambiguous outcomes.
6. Company File publication uses immutable objects plus a validated
   compare-and-swap head transition; isolated checkouts never share a writable
   NAS filesystem.
7. A runner cannot enumerate the global queue or become an authority.
8. The control plane receives only opaque credential/capsule references and
   provenance, never plaintext subscription credentials.
9. With no dispatcher or runner online, the first eight invariants continue to
   hold and work remains pending.

## Local proof record

The following gates passed from the repository root on 2026-08-21:

- `npm run test:hosted-db`: all 52 migrations applied to a clean local Supabase
  database and all 21 SQL contract files passed.
- Edge-function unit tests: 38 passed across company-file verification, runner
  control/broker/orchestration, artifact GC, invitations, and native-login
  authority.
- `packages/runner-orchestrator`: 27 dispatcher-contract tests passed across 6
  files using fake/local providers.
- `packages/object-gateway`: 10 service, authority, and migration tests passed.
  They cover server-verified addressing, deduplication, authenticated reads,
  modern secret-key header isolation, legacy-object migration, corruption
  refusal, and lease-scoped deletion.
- `packages/coding-agent/test/company-connections.test.ts`: 22 sponsor and
  provider-connection tests passed.
- The selected shell cloud-control suite: 166 tests passed across 22 files,
  covering authenticated object-gateway transport, session arbitration, input
  outbox, wake materialization, Company File projection/publication, runner
  assignment/control, provenance, presence, and runner-independent trail
  synchronization.
- `npm run check`: repository formatting, dependency policy, import policy,
  shrinkwrap/install-lock verification, TypeScript, and browser smoke checks
  passed.

The local provider adapters are test doubles for the future dispatch boundary.
Their success is evidence for the contract only, not evidence that production
execution infrastructure exists.

## Hosted Supabase proof record

A new clean project was created expressly for Step 1:

- project reference: `wovsmjvghnbcbfazdtvr` (`Qorpera Cloud Step 1`,
  `eu-central-1`);
- health: `ACTIVE_HEALTHY`;
- all 52 repository migrations are recorded remotely and `db push --dry-run`
  reports that the hosted database is up to date;
- Auth configuration as code preserves email confirmation and TOTP while
  allowlisting the desktop's dynamic `127.0.0.1` callback; email login is
  enabled, while Google and GitHub remain disabled until their provider
  credentials are explicitly configured;
- direct Postgres and pooler connections require TLS; HTTP APIs already remain
  behind their hosted HTTPS endpoints;
- the optional `profile-invitation-email` function, `artifact-gc-worker`,
  `company-file-verifier`, `runner-control`, `runner-broker`, and
  `runner-orchestrator` are deployed and active. External invitation email is
  not required for the app-native invitation path;
- `native-provider-login` is intentionally not deployed because provider-native
  execution is Step 2;
- a two-account hosted smoke test created a profile, issued and accepted a
  contributor invitation, created one canonical shared session, retried one
  queued input idempotently, synchronized two ordered inputs across both
  members, and verified the author provenance visible to the opposite member;
- company invitations are app-internal control-plane records. The invitee sees
  and accepts them after signing in to Qorpera; delivery to an external email
  inbox is optional notification behavior and is not an acceptance gate;
- the same source completed full builds on Windows x64 and a physical Apple
  Silicon Mac connected over Tailscale;
- a physical two-device test used independent temporary Auth accounts and the
  built shell hosted-primary and Realtime transports. The Mac accepted its
  contributor invitation, both devices observed one canonical session, Windows
  observed four Realtime trail changes, and four strictly ordered inputs kept
  their Windows/Mac author provenance;
- after the Mac process stopped, Windows appended an input and a newly started
  Mac process recovered it from the durable cursor before replying. The owner
  then removed the Mac member; the Mac observed the access change over Realtime
  and both its next read and next write were denied;
- the test profile and both temporary Auth accounts were deleted after the
  proof, and an independent database query confirmed zero Auth users, profiles,
  members, sessions, and session inputs remained;
- a second physical Windows/Mac test stored a 4,194,324-byte Company File as
  three immutable NAS objects, downloaded and deduplicated the same objects on
  the Mac, synchronized two ordered shared-session inputs and their sponsor
  provenance, and denied the still-signed-in Mac both session and object reads
  immediately after membership revocation;
- the physical gateway was restarted between upload and cross-device recovery.
  One exact 4 MiB object was made unavailable, the read failed closed, the
  object was restored from the NAS test backup, and its hash was verified before
  the Mac download;
- deleting temporary profiles exposed orphaned physical objects. Migration
  `20260821007000_deleted_profile_object_gc.sql` added an independent,
  lease-scoped cleanup queue; the hosted Edge worker reclaimed all 12 orphaned
  test objects, and the database plus NAS were verified empty afterward;
- `pg_cron`, `pg_net`, and Vault are enabled. The cleanup worker has a dedicated
  invocation key that is separate from its internal database credential, runs
  every five minutes, and returned HTTP 200 when invoked through the same
  database/Vault path used by the schedule;
- `https://objects.qorpera.com` is routed through a dedicated named Cloudflare
  Tunnel to the NAS gateway. Windows and Mac health checks passed, and a
  database-triggered Edge-worker run reclaimed an exact physical test object
  through the stable hostname with its live lease before the temporary tunnel
  was retired;
- DSM has an enabled `Boot-up` task for the idempotent gateway/tunnel startup
  script. A controlled full stop/start through that exact script restored both
  services and passed Windows/Mac health checks. The task runs as
  `company41-admin`; it has not yet been proven by an actual NAS reboot and is
  not the final least-privilege service identity;
- the legacy object migration command completed with zero source objects, as
  expected for this clean project.

The prior `bzbvxthyjcgcrwpcvdpj` project remains intact and was not migrated or
mutated by this deployment. It is no longer the default project endpoint in the
client.

## Remaining production operations gate

The Step 1 data path is deployed and end-to-end proven through its stable public
hostname. The restore proof used a second location on the same NAS; it proves
recovery behavior, not protection from NAS loss. Production acceptance still
requires:

1. move the DSM boot task, gateway environment, tunnel credential, and storage
   permissions to a dedicated non-administrator service account, then repeat
   the restart check across an actual NAS reboot;
2. configure an independent backup destination, retention policy, monitoring,
   and periodic restore drill; and
3. schedule SMART/storage-health monitoring independently of Qorpera.

Until those operations checks pass, describe the Supabase-plus-NAS cloud layer
as hosted and end-to-end proven, but not production-ready. It still provides no
autonomous model execution; that remains Step 2.
