# Step 2: cloud-owned Compute Identity recovery

Status, 2026-08-29: implemented, component-verified and accepted in the
independent synthetic Azure Phase B topology. The production recovery service,
real recovery material and production approval surface are not deployed. This
is not production activation approval. Step 2 remains open for the separately
owned custody canary and production cutover gates; Step 3 remains paused.

## Boundary

The existing identity volume is a physical realization, not durable authority.
Recovery preserves the same capsule master key and ownership. It does not grant
provider consent, grant an agent access, restart a job, or publish a message.
The company remains one live cloud object; recovery records are private security
state, not files that staff can read through the Company File gateway.

The recovery service runs outside execution nodes. It owns separate per-company
Ed25519 signing and RSA-OAEP/SHA-256 wrapping keys, and a private control
capability. Image-signing keys are not reused. No key depends on a member's Mac.
Provider capsules remain encrypted; the service handles the capsule master key,
not provider-native plaintext. This is an application boundary, not a claim of
cryptographic protection from the infrastructure administrator.
Generation fencing revokes Qorpera admission and effects, not an OAuth session
at the provider. Suspected credential theft requires provider-side revocation
and reauthentication; restoring a lost node does not perform either action.

## Backup

1. A current native-login capability identifies the company and credential owner.
   The cloud derives the identity, policy digest, revision and recovery authority.
2. The login guest wraps its existing master key for the pinned recovery
   authority. Only a key commitment and encrypted key cross the guest boundary.
3. The service verifies that commitment and signs the exact identity/policy/
   revision envelope. A durable private staging record makes retries use the
   same object, rather than producing competing backup versions.
4. The envelope is written and read-verified on NAS and in a dedicated private
   Supabase bucket. Only then does the cloud mark that revision recoverable.
   A failed replica never receives a successful two-copy receipt.

There is no silent replacement key. A governed job with a missing master key
must stop. A new login may initialize a key only for an identity with no existing
credential/key history; loss of established key material requires recovery.

## Restore

1. An independent operator registers a replacement login VM's recipient public
   key and exact company/identity, node, signed-image and guest-manifest pins.
   Humans and agents cannot turn an arbitrary public key into a restore target.
2. A current company owner explicitly selects that target and the exact current
   backup revision. A different member's personal identity additionally requires
   that member's current consent. No approval transfers credential ownership.
3. Approval increments the identity execution generation and fences admission,
   old runs and leases. It waits out existing lease authority before releasing
   any recovery material. Expiry or cancellation cannot silently revive the old
   execution generation.
4. The service rechecks current owner/member/identity/policy/backup/target authority
   immediately before release. It reads the explicitly selected NAS or verified
   backup copy, rejects stale/wrong-company/wrong-identity envelopes, then wraps
   the key only for that replacement VM. Backup selection is explicit, not an
   authority-changing outage fallback.
5. The guest verifies the signed, short-lived grant and exact recipient, installs
   the key and recovery marker durably, and proves possession. The cloud records
   one recovery receipt before admitting fresh work. A lost acknowledgement
   resolves to that receipt; it never creates another job or another generation.

Native startup and execution must compare their local recovery marker with the
current cloud generation. An old volume cannot become current by asking for a
new run. Existing job/receipt/public-send machinery remains authoritative.

## Enforced integration

Migration `20260828015000_compute_identity_recovery.sql` adds private authority,
backup, target, approval and receipt state. The generic service role cannot read
or mutate that registry, or directly initialize/reset the identity's new epoch
and pending-recovery fields. Existing identity-column permissions are retained.
Only the recovery service has the additional independent control capability.

Runs, runners and native logins pin their generation on admission. Live native
lease checks return that generation; the host compares it with a root-provisioned
systemd credential derived from the identity volume. Recovery fences old
admissions, renewals and native effects. Cancelling or expiring a recovery keeps
the old generation fenced; only a newly approved recovery can advance it.
Each native login requires its own verified key-backup receipt. An existing
backup cannot be used to pretend a different login verified possession.

New login bootstrap now stops before key creation or provider authentication
when the company's recovery authority is missing. The host confirms the
two-copy backup before uploading or committing the provider capsule. Existing
key history prevents silent initialization, including when a key or marker is
missing. This requires coordinated configuration and guest rollout; deploying
these guests alone would intentionally block unconfigured sign-in.

The ordinary application user can inspect and approve through authenticated
RPCs; there is no model-facing recovery tool:

| Caller | Entry point | Effect |
| --- | --- | --- |
| Current owner or credential owner | `qorpera_review_identity_recovery(identity,target)` | Exact backup, recipient, node and image review; no secret |
| Current company owner | `qorpera_request_identity_recovery(identity,target,requestId,revision,sha256,source)` | Binds one approval to that exact target, backup and explicit `nas` or `supabase` source |
| Different personal credential owner | `qorpera_consent_identity_recovery(recoveryId)` | Adds required member consent; cannot substitute another identity |
| Owner or personal credential owner | `qorpera_cancel_identity_recovery(recoveryId)` | Cancels without reviving the old node |
| Independent operator | `POST /operator/target` | Registers previously verified replacement pins; requires a separate operator capability |
| Trusted login/replacement guest | `POST /v1/backup/prepare`, `/v1/backup`, `/v1/release`, `/v1/complete` | Capability-bound backup and restore; no execution or public send |

Target/image registration is an operator assertion after verifying the existing
signed guest and node provenance. This slice does not invent a second attestation
service. Automatic per-company authority provisioning and deployed acceptance
remain unfinished; neither is implied by the authenticated approval surface.

## Human approval surface

Migration `20260828016000_member_identity_recovery_review.sql` adds member-only
identity/target discovery, exact review and decision RPCs. Pages are bounded to
25 rows with stable identity cursors. Owners can inspect company identities;
other members can inspect only their own personal identity. A generic service
credential, agent or outsider cannot use this member surface.

The Company File window opens a separate sandboxed Cloud recovery window. It
renders identities, registered replacement nodes, backup revisions and complete
recipient/image/object fingerprints, without keys or capabilities. Backup
source selection has no default. A native confirmation repeats the host-held
review; renderer-provided objects cannot replace it. Dismissal submits nothing.

The cloud locks current membership and recomputes the exact review digest at
decision time. A stale review must be refreshed. Another member's personal
identity still requires that member's consent. Lost acknowledgements are not
automatically retried, and the UI distinguishes requested/approved from a
completed recovery receipt. Closing the parent revokes the window's access.
These controls are component-verified, not yet released or deployed.

## Packaging and operator contract

`node scripts/package-identity-recovery.mjs --out <new-directory>` creates a
standalone authority, restore client, service unit and SHA-256 manifest without
overwriting an existing directory. Guest packages include only the restore
client, not the authority entrypoint. No private key is in an artifact.

The authority entrypoint runs on Linux, outside execution nodes, behind a
certificate-validated HTTPS endpoint. Its HTTP listener is loopback-only.
The service unit is `deploy/identity-recovery/qorpera-identity-recovery.service`.
It requires private systemd credentials:

- `qorpera-recovery-config`: closed `qorpera.identity-recovery-service/v2`
  JSON containing `companyId`, `authorityId`, `supabaseUrl`, `journalRoot`,
  `journalMountPoint`, `nasRoot`, `nasMountPoint`, `nasSource` and `port`.
  Version 1 is not accepted by the new entrypoint.
- `qorpera-supabase-service-key`: the existing cloud API credential, never
  sufficient by itself for a release.
- `qorpera-recovery-control` and `qorpera-recovery-operator`: independent
  high-entropy capabilities; neither is a runner capability.
- `qorpera-recovery-signing-key` and `qorpera-recovery-wrapping-key`:
  canonical unpadded base64url PKCS#8 DER, Ed25519 and RSA-3072 respectively.
  Public SPKI values and the control-capability hash must match the separately
  provisioned immutable authority registry.

Provision service-owned 0700 roots. The journal must be on a dedicated retained
local ext4, XFS, Btrfs or ZFS filesystem, outside disposable compute. The supplied
unit requires that filesystem at `/var/lib/qorpera-recovery`, with its private
journal below it. Provision `/mnt/qorpera-recovery` as a local directory and
mount the NAS export at `/mnt/qorpera-recovery/nas`, with its private object
directory below that mount. Pin the exact export as `nasSource`; never mount NFS
over the local parent named by the service's ReadWritePaths setting.

Startup validates the journal without contacting the NAS. Each store
checks its already-open directory's Linux mount ID against bounded local proc
metadata before accessing objects. The journal must remain a dedicated local
mount; NAS reads/writes require the configured NFS mount and exact export. An
unmounted local directory, changed export or unexpected bind subtree is denied.
The NAS is not a systemd startup dependency. The unit retains strict filesystem
protection and permits the host's later NAS mount to propagate into its namespace.
Actual service startup with absent and stalled NAS remains a deployed acceptance
case; this component proof does not certify the future host's mount configuration.

Each filesystem adapter permits one outstanding operation, retained until the
kernel settles even after timeout. A stuck NFS call cannot create an unbounded
pool of pending filesystem operations. HTTP bodies, requests and object sizes
are bounded; denials are not converted to replica success.

The restore entrypoint runs only as trusted Linux guest root, into the fixed
`/var/lib/qorpera/identity` volume. Provision its recipient key inside that
verified guest. Register only its public key and exact node/image/manifest pins,
then obtain the owner's approval and, where required, the credential owner's
consent. Do not collect keys in chat, the Company File, the desktop client, or
the model's workspace.

Pass the following private credentials using the guest's approved systemd
execution lane, before enabling its normal bootstrap:

- `qorpera-recovery-restore`: closed `qorpera.identity-recovery-restore/v1`
  JSON with `companyId`, `computeIdentityId`, `authorityId`, `recoveryId`,
  `targetId`, `epoch`, `backupSha256`, `serviceOrigin` and
  `signingPublicKey`, taken from the reviewed admission.
- `qorpera-recovery-recipient-key`: the guest's RSA-3072 private key in the
  same canonical PKCS#8 encoding.
- `qorpera-recovery-target`: its separately registered target capability.

The CLI prints only completion status, receipt ID and generation. Retain the
private volume after an interrupted attempt and retry the same request. A
different target, digest, key or generation is not a retry. The grant lasts at
most 60 seconds; an already installed key may finish acknowledgement within
the original approved recovery lifetime, without another key release.
Missing committed journal state requires explicit operator repair, not
regeneration. A delayed old receipt cannot overwrite a newer epoch marker.

No old signed image may be restored after a recovery epoch advances. Produce
and verify new guest/image pins in the existing coordinated signing lane;
install SQL, authority configuration and compatible hosts together. Do not
roll back by clearing a pending fence or decrementing an epoch. Key rotation,
authority-key backup custody, retention and new-company provisioning require
an explicit operator policy before live activation.

## Verification

Synthetic tests cover real capsule decryption after restore; wrong company,
identity, policy, signature, recipient and revision; owner/member revocation;
unapproved targets; explicit replica choice; stalled/missing/corrupt replicas;
lost responses, process restart and concurrent restores; and old-generation
execution denial. No provider call is necessary for this security proof.

The reproducible database driver is
`node scripts/test-identity-recovery.mjs --out <new-evidence-directory>`.
It applies all 87 Step 2 migrations to disposable PostgreSQL, runs SQL suites
160/165/280/297/298/299, races requests/restores/release commits/completions, and
replays an immutable receipt after database restart. It then connects the
actual SQL functions to the actual HTTP recovery service, uses real synthetic
keys and signed envelopes, restores a native credential capsule, and retries
a lost acknowledgement. SQL authority is real; local fixture directories
stand in for the two remote replicas. This is not deployed Supabase/NAS proof.

`scripts/verify-identity-recovery-linux.mjs` additionally passed in a pinned,
network-disabled, read-only Linux arm64 Node container with dropped
capabilities. It exercised descriptor-anchored immutable publication,
concurrent writers, symlink/permission denial, guest installation, native
capsule decryption, lost acknowledgement and old-generation refusal.
That does not certify the future Linux x64 guest image or cloud topology.

Focused TypeScript tests also exercise native login ordering, rejection before
sign-in when recovery is unconfigured, local/server epoch mismatch, private
credential validation, bounded denial-preserving transport, the isolated human
window and descriptor-bound filesystem selection. The browser fixture exercises
the actual renderer with synthetic review data; it is not a live restore.

The current focused run passes 202 tests in 14 files, all three recovery/guest
packaging tests, the 87-migration SQL driver and its concurrency/restart/round-trip
cases, and the isolated Linux descriptor/restore proof. The complete
`npm run check` is clean. Browser verification additionally covers explicit
source selection, dismissal, personal-owner consent, updated fencing and clearing
stale review details after an uncertain response. No model or provider call is
used by these checks.

The separately approved Azure Phase B run then exercised the contract on two
distinct Trusted Launch hosts and two distinct signed v52 full-VM guests. The
independent D2s_v6 authority started before the two synthetic replica mounts;
its production unit remained disabled/inactive and failed closed when its six
credentials were absent. The live proof covered encrypted and read-verified
NAS/Supabase replicas, explicit Supabase selection, owner approval, exact target
pins, source loss, old-recipient and old-generation/lease/effect denial, lost
completion acknowledgement, authority restart, byte-identical receipt replay,
authenticated capsule recovery, fresh admission only after receipt replay and
exactly one durable completion receipt. All Azure resources were then deleted.
The sealed evidence is
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/azure-phase-b/provisioned-20260829T081608Z`;
its `SHA256SUMS` file has SHA-256
`eed312ad8f666cd8c111ef34c52c5a493ce0a349634ba708342ba44600822476`.

## Remaining live Step 2 gates

Phase B proves the independent replacement-node boundary with synthetic keys,
replicas, identities and owner decisions. Production still requires the
recovery authority to be installed disabled with independently managed
persistent service keys; real replica paths and private routes to be verified;
the authenticated approval surface to be deployed; and an exact replacement
login target to be registered only during the approved canary window. Recovery
must be established before new admission. Moving real recovery material,
applying production SQL, pausing the legacy runtime, changing NAS mounts or
claiming the production Company Computer replaceable each remain separately
authorized actions.

This is not offline control-plane recovery: live SQL authority is required
for key release and completion. Provider capsule objects keep their existing
storage path; the new two-copy objects contain only the encrypted master key.
The shared-computer mediation and production NAS/cutover gates remain separate,
unfinished Step 2 work. No Step 3 integration, commits, releases or migrations
to a managed project were performed. No additional skills were loaded; the
cumulative task skill count remains 8/10.

Cryptographic APIs use Node's documented [RSA-OAEP and signing interfaces](https://nodejs.org/docs/latest-v24.x/api/crypto.html),
with explicit algorithms, domain-separated labels and closed envelopes. Key
provisioning and rotation remain operator actions, never model tools.
Typed Storage conflict handling follows the current
[Storage error contract](https://supabase.com/docs/guides/storage/debugging/error-codes)
and [standard-upload conflict behavior](https://supabase.com/docs/guides/storage/uploads/standard-uploads);
an error message alone cannot turn a denied write into a verified replica.
