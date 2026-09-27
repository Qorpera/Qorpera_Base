# Node updater authority and reconciliation

This work adds the signed controller, a scoped backend desired-target authority,
an HTTPS client and their concrete preparation/publication/drain/resume adapters.
It is not an installed updater and does not close the production rollout item.
Production signing-key enrollment, distribution, host execution and acceptance
remain separate deployment steps.

`RuntimeNodeUpdateController` in
`packages/runner-orchestrator/src/runtime-node-update.ts` verifies an Ed25519
release envelope against an independently enrolled public key and node/host
identity. The signed release binds the exact predecessor revision, predecessor
release and installed-artifact digests, the next artifact size/digest, source
commit, acceptance-evidence digest and target runtime bundle. Revisions advance
exactly once. A release cannot supply its own key, URL, shell command, destination
path, service unit or credential. Host-update signatures use their own schema;
guest-image provenance does not authorize a host update.

Each reconciliation performs at most one new effect:

1. Stage and verify the package without changing installed services.
2. Close admission with a versioned compare-and-swap and wait for the required
   physical/backend drain; retain the original public node policy and its exact
   enabled state.
3. Stop the enrolled services after the drain is proven.
4. Install only the reviewed package through the protected physical adapter.
5. Start the enrolled services while admission remains disabled.
6. Verify installed bytes, service identity, health and inventory.
7. Acknowledge readiness to the release coordinator.
8. Restore the original node policy only after the target runtime bundle is
   active, the authenticated coordinator has separately released this exact
   node revision for admission with retained evidence, and the exact
   disabled-policy version/digest still belongs to this
   update. An originally disabled node remains disabled.

The controller uses the existing protected, immutable journal-file publisher.
Each phase first retains its exact intent locally and in the backend, against a
complete current observation and predecessor receipt. A separately fsynced physical
claim wins an atomic no-overwrite claim before dispatch. Other
processes and later invocations can inspect that exact intent but cannot dispatch
it again. A crash between intent and dispatch therefore remains unconfirmed,
even when an inspection finds no effect. Only retained evidence of that exact
operation may settle it. Explicit failure terminates the attempt; there is no
automatic rollback, stale-lock takeover or destructive retry. Receipt digests
form an ordered chain bound to the signed release. A new candidate cannot reuse
another release's journal. The physical result is retained locally before a
separate backend publication step. Preparation and publication use immutable,
exact-body SQL writes: after a lost reply the adapter reads the retained row and
only submits the same body if absent. Neither operation repeats a physical
effect. The next phase cannot begin before publication is confirmed.

## Adapter requirements before an executable updater can ship

The ports have distinct authority and durability boundaries:

| Port | Required concrete behavior |
| --- | --- |
| `observe` | Read an authenticated, operator-enrolled desired release for this exact node and a fresh node policy/version, host identity and active runtime bundle. Also read the separate coordinator admission-release record and its evidence digest; desired-target publication or bundle equality does not imply permission to reopen. A hash from `origin/master` or an unauthenticated download is not desired-target authority. |
| `prepare` / `publish` | Read or commit the exact immutable backend intent/receipt independently of physical dispatch. Verify retained row equality on lost replies. |
| `execute` | Recheck authority at effect time. Stage bounded bytes and verify the signed artifact digest; preserve pinned image provenance and deployment-specific service/file allowlists. Use existing company pause and node admission CAS; prove backend and physical drain, including unresolved operations, before stopping services. Preserve immutable journals and configuration. Record phase-specific physical/backend evidence before returning its digest. Never interpret the controller's earlier observation as a reservation lease. |
| `inspect` | Read the retained exact-intent outcome without dispatching or repairing it. A missing VM, absent file, expired lease, timeout or currently healthy service is not evidence that a particular update effect completed. Return null for uncertainty. |

The drain adapter must preserve the complete original public policy in its
protected evidence, not only this controller's hash. Its success receipt binds
original policy digest/version/enabled state and the resulting disabled policy
digest/version. Disabling may change only the intended admission field, must
advance the existing policy version by one, and must not discard capacity or
alter provider enrollment. Every later phase requires that exact disabled
version/digest. The resume adapter restores the complete original policy with
the same CAS and verifies the result; it cannot overwrite another operator's
intervening change. The controller leaves this enforcement in the adapter
because it has no database write credential or production endpoint.

The physical adapter must use protected canonical directories and a retained
kernel installation lock, bind the current service executable/configuration and
invocation to the signed predecessor, verify archive entries before extraction,
and reconcile accepted IO through retained operation evidence. It must have a
closed service/file allowlist per enrolled node. Arbitrary package scripts and
model-provided paths are not supported. Its inspection mechanism and receipts
must survive a process/host restart. Safe rollback, if added, is a separately
authorized signed successor, never a blind copy of old bytes.

`20260921010000_runtime_node_update_authority.sql` adds private enrollment,
target, intent and receipt tables. Only a direct postgres session in its actual
postgres role can enroll/rotate a capability, publish a signed target, authorize
drain against retained company pauses or release admission. JWT role claims are
not operator proof. No updater receives a service-role key. Public project keys
can access only scoped RPCs when accompanied by the exact random node capability
and capability revision; revocation rejects reads as well as writes.

The backend retains the complete original node policy and its exact disabled
successor under the existing company/node lock order. Preparation binds the
complete pre-effect observation before external work. Receipt publication
requires that exact intent and the phase's preserved policy/ownership; a later
bundle activation cannot rewrite the pre-effect snapshot. Coordinator release
requires all seven preceding successful receipts, no pending intent, exact target
bundle and an owned quiet drain. The global coordinator must order incompatible
activation after all required node acknowledgements; this updater never applies
schema or guest-image changes itself.

`RuntimeNodeUpdateRegistry` accepts a fixed HTTPS origin, a publishable project
key (or legacy anon JWT), and a separate node capability. It refuses privileged
project keys, redirects, overlapping requests, oversized responses and unexpected
response fields; errors do not include backend/transport text that might echo
credentials. `createNodeUpdateRegistryPorts` implements SQL drain/resume and
their read-only lost-reply reconciliation, independently of physical service work.
Existing inventory/reservation APIs and disabled runtime-rollout packets are not
release feeds or admission grants.

## Protected host service

`LinuxNodeUpdatePhysicalPorts` supplies the first concrete host implementation:
one already-running enrolled Qorpera service with a raw `.mjs` artifact under
`/opt/qorpera/<component>/` or the deployed `/opt/qorpera-native25-phql-a1/`.
The updater preserves the unit, its exact enrolled ordered drop-ins, runtime executable, complete
configuration and guest-image provenance. A change requiring new configuration,
a unit, an image or a schema cut needs the separate reviewed coordinator work.

Root enrollment pins the machine identity, artifact HTTPS base URL, service and
unit path/digest and `dropIns` path/digest array, `/usr/bin/node` digest, installed path/mode, service user/group/UID,
configuration path/digest list, localhost health endpoints, LXD socket/project,
private journal root and its existing kernel lock. Download names consist only of
the signed digest plus `.mjs`; no URL, path, unit or command from the desired
release is executed. The artifact is size/digest checked before staging. The
physical adapter validates root-owned canonical local paths and files, inherited
kernel flock ownership, configuration pins, systemd MainPID/InvocationID/start
timestamp and actual `/proc` command, UID and executable before dispatch.

Stop requires the same invocation measured during staging, the owned SQL drain,
stopped VMs and no pending LXD operations in the enrolled provider project. The
invocation is checked again after all asynchronous lock/authority/drain work,
immediately before spawning systemctl. It
verifies systemd and an empty/absent service cgroup afterward. Install replaces
the verified predecessor binary and, for the native layout, the one checked launcher
digest literal. Both successors are staged and fsynced before either publication.
The service must remain stopped through both atomic renames, with predecessor
custody checked before the first and the exact intermediate pair checked before
the second. An intermediate crash remains unconfirmed and never permits an
automatic repair or start. Start, verify and acknowledgement
retain the successor invocation, installed digest, health and quiet inventory.
Admission independently rechecks the same boot/invocation, bytes, health and
physical drain before invoking the scoped resume RPC; it checks identity again
after health/drain reads and admission-evidence publication. Physical evidence contains
the measured facts, not just their hash, and is sealed under the exact phase
intent and host-enrollment digest.

Native enrollment requires `launcher` with the exact deployed `path`
(`provider-launch-v52.py` or `provider-launch-node02-v52.py`), original `sha256`,
original checked `artifactSha256`, and `templatePath` equal to
`/etc/qorpera/node-updater/launcher-template.py`. Root must retain that original
launcher byte-for-byte at this protected path during enrollment. Direct services
set `launcher` to null. The updater derives each revision from that immutable
root-enrolled template and the locally verified predecessor/signed successor
artifact hashes; it never uses the backend's current revision as the baseline.
The enrolled old digest must occur exactly once and on the existing exact Python
`need(hashlib.sha256(read(BUNDLE,0o444,1024*1024)).hexdigest()==...)` check.
Every other byte is preserved. The launcher keeps its 0555 mode and the native
binary its 0444 mode and existing 1 MiB limit. No new launcher command is accepted
from a release. Both before/after file digests and paths are retained in the
physical claim and sealed evidence. Extra, removed or reordered effective
systemd drop-ins, changed launcher bytes, and any changed config pin fail closed.
The service sandbox permits writes only to the journal and the two supported
artifact directories; the optional directory prefixes allow either enrolled
layout without creating a missing directory.

Each physical call takes its own immutable host claim in addition to the
controller claim. A crash before sealing evidence leaves that operation
unconfirmed, even if systemd or the rename might have completed. Inspection only
reads sealed exact-intent outcomes; it does not infer a successful stop/start
from a currently stopped/running unit or dispatch a second physical operation.
No claim is removed and no timeout grants a retry. This is deliberately a
fail-closed recovery boundary requiring operator investigation when retained
completion evidence is absent. The updater does not stop persistent computers
in other LXD projects or claim to prove their workload acceptance.

`selectNodeUpdateJournal` stores a root-enrolled baseline and sequential signed
envelopes under `revision-N`. It advances the predecessor only after validating
all eight local phase receipts, publication markers and the completion seal.
Remote enrollment state never supplies a new baseline. A resume that committed
in SQL but lost its response keeps the original local predecessor and reads that
exact release until its receipt/publication completes. Polling can then ignore
only the exact previously completed target retained by SQL.

Build the reviewable package with
`node scripts/package-runtime-node-updater.mjs --out <owned-output-directory>`.
It contains the updater CommonJS binary, fixed systemd service/timer and an
artifact size/digest manifest. Building it installs or enrolls nothing. The
service accepts only `/etc/qorpera/node-updater/service.json`, mode 0400 root:root,
and its own executable at `/opt/qorpera/node-updater/qorpera-node-updater.cjs`
must match the enrolled updater digest. The configuration's closed top-level
fields are `schema` (`qorpera.node-update-service/v1`), `host`, `registry`,
`baseline` and `updaterSha256`. The registry section contains the fixed origin,
public project key, separate random capability and capability revision. The
baseline contains the independent signer/node/host and reviewed predecessor.

The supplied service uses the existing lock at
`/var/lib/qorpera-node-updater/provider/update.lock` without creating it. Root
must prepare the protected 0700 journal and empty 0600 lock during reviewed
enrollment, and install/verify the package and configuration before enabling
anything. The timer performs one reconciliation every 15 seconds after a run;
it does not install itself, generate keys, publish targets, pause a company or
release admission. The reviewed backend coordinator must publish signed exact
successors, bind a real maintenance pause and later release readiness.

## Coordinated runtime upgrade

At the 21 September investigation, production is on global runtime v35 and
context format v1. Migration `20260919234000_runtime_hire_overlay_context`
changes that format to v2, which the v35 guest parser refuses. Migration
`20260920070000_runtime_retire_responsibility_objects` retires eight tables and
also requires coordinated object-gateway/runtime changes and the authorized
export and verification. Missing historical bundle activations must not be
blindly replayed in filename order.

The release coordinator must stage the signed native image and host packages,
pause company dispatch using the existing execution-pause authority, prove old
native jobs/logins/refreshes and unresolved physical work drained, and close node
admission before changing incompatible schema. It then coordinates the selected
schema delta, object gateway, signed image/provider policy and host services,
and activates the final reviewed bundle only after required installation
readiness is established. The controller's acknowledgement precedes its resume;
it never activates a bundle or applies a migration. A ready node alone is not a
complete global-cut acknowledgement. Unbound historical inputs retain their
original provenance and are never relabeled to the new bundle.

Production acceptance still needs an enrolled signed release distributed to
both nodes, owned admission drain, installed-byte and cold native execution
proof, ordinary retry acceptance, crash/lost-reply recovery and exact admission
restoration. Offline tests use explicit fake physical/backend ports and do not
claim those deployment proofs.

## Validation

The focused controller/HTTP/adapter suites pass 66 tests, including all eight
lost physical replies, lost preparation/publication replies, publication failure
before commit, concurrent claims, a crash before dispatch, policy ownership and
signed-target substitutions. Both additive SQL candidates passed the actual
isolated PostgreSQL 18.6 rehearsal and rolled back all candidate DDL. The second
test includes forged JWT/actual-role denial, capability revocation, full policy
CAS, failed pre-drain publication, pending-ack grant refusal and a bundle change
between preparation and receipt publication. A third candidate adds completed
historical receipt reads across successor publication and passed its pinned
scratch run. Those tests use explicit fake
physical evidence; they do not claim a real host cut.

Standalone TypeScript checking passes. `npm run check` currently stops at the
expected stale runtime-bundle manifest after adding SQL; the parent rollout owns
the reviewed successor activation and generated bundle. No existing activation
was rewritten to suppress that check. The full repository suite and production
host acceptance have not run for this change. The package reproducibility test
passes, including every artifact digest, hardened runtime help, and rejection of
execution outside the enrolled service path. Host enrollment/parser tests do
not exercise real Linux/systemd mutation: that isolated acceptance is still
required before deployment or enabling the timer.
