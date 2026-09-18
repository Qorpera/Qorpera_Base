# Runtime Step 2 production acceptance and cutover record

Date: 2026-08-29. Status: **pre-SQL drain, durable raw-mount retirement,
exact create-only NAS reconciliation, final migration replay and deployment
package refresh complete; production cutover remains blocked**. Phase A and
Phase B synthetic gates passed and were fully cleaned up. The exact NAS creates,
runtime drain, Step 3-safe provider stop and non-forced raw-mount detach were
performed only under their separate explicit approvals. This record authorizes
no production SQL, further runtime or NAS mutation, source commit, push, client
release, or new Azure resource. Step 3 remains paused, byte-for-byte preserved
and separate from Step 2.

**Source-review addendum (2026-08-30):** The dated inventories, migration
counts, hashes and signed-package proofs below are historical evidence, not a
current deployment manifest. The organization additions `19000`–`19600` and
executable/read-provenance corrections `19700`–`19900` require a fresh exact
ledger/schema replay and a compatible signed package. Prior v55/v56 evidence
does not certify those changed bytes. The source-required cutover sequence
below now uses the organization bootstrap worker and v3 finalizer; no live
operation or authorization is added by this correction. See
[Steps 0–2 review corrections](RUNTIME-STEPS-0-2-REVIEW-CORRECTIONS.md).

## Dependency gates

Production work remains behind, in order:

1. completed and cleaned-up synthetic Azure Phase A evidence;
2. completed and cleaned-up exact Phase B replacement-node evidence;
3. frozen source, migration, package, image and recovery hashes;
4. completed exact create-only NAS reconciliation and approved runtime drain;
5. final frozen custody/package pins and integrated compatibility replay;
6. explicit infrastructure-only staging approval, followed by frozen recovery
   public keys, authority origin and control-capability hash;
7. explicit approval for the exact production SQL/runtime window; and
8. explicit commit, push and release approval after production acceptance.

The original independent Phase B plan remains preserved at
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/planning/STEP-2-PHASE-B-AND-PRODUCTION-ROLLOUT.md`,
SHA-256 `a40e1dda24c3516ab10d6e464d68e41fe23939673131b0ba81e138dab5c1f4e0`.
Its EUR 6 scope assumed that Phase A's D4s_v6 host would remain as the
replacement target. Mandatory Phase A cleanup deleted that host and its disks,
so that plan was superseded without being executed.

The exact replacement proposal is preserved at
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/planning/phase-b-revised-20260829T075509Z/RUNTIME-STEP-2-PHASE-B-PROPOSAL.md`,
SHA-256 `7ec624fdc3bcebde62af8486b02cd55311ca2bf41acdc9bdf29d7359d1da9121`.
It recreates a Trusted Launch `Standard_D4s_v6` replacement target and adds a
separate Trusted Launch `Standard_D2s_v6` recovery authority, pinned disks,
network and bounded transfer resources in Sweden Central. Its exact ceiling is
EUR 14 before tax for at most 24 hours, with a EUR 9.925 conservative subtotal
and a stop gate if the refreshed subtotal exceeds EUR 11. The user explicitly
approved that revised scope. Both hosts passed their KVM gates and the distinct
signed-guest replacement/recovery proof, including two replicas, explicit
selection, old-node fencing, lost-acknowledgement restart/replay and exactly one
completion receipt. The production unit remained disabled and failed closed
without credentials. The observed lifecycle before cleanup was 1.155 hours,
with a conservative two-hour allocation upper bound of EUR 1.830504109589041.
Deletion was verified at `2026-08-29T09:33:19Z`. The sealed evidence is
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/azure-phase-b/provisioned-20260829T081608Z`;
its `SHA256SUMS` file has SHA-256
`eed312ad8f666cd8c111ef34c52c5a493ce0a349634ba708342ba44600822476`.

## Read-only production inventory

The audited managed project is `wovsmjvghnbcbfazdtvr`. The production Company
File target is profile `88227549-9724-43c2-8966-9fafb3e855d6`, environment
`0d2053f0-c1a8-444d-99a8-68c8214e5414`. Its unchanged canonical head is
`0c0656d6-42b3-485f-86b3-a3ba1d5f6032`, tree SHA-256
`e6fddb19fe97d78e467069ceab6ed37bb1c12fcdf586344adc06b40303f329b4`,
with 206 files and 145,839,120 logical bytes.

The live migration ledger was fetched read-only through `2026-08-29T12:41:24Z`
and still contains 92 versions. The integrated candidate contains 91 source
migrations. Exactly 17 Step 2 versions are missing from production, while
production retains 18 older versions absent from the candidate:

- `20260826110000` through `20260826230000` and `20260827000000`: the existing
  legacy Company Computer registry/screen/NAS lane;
- `20260827043000` through `20260827046000`: mobile push.

Those production-only records and objects must remain intact. Do not repair,
delete, mark-reverted, or silently import them into Step 2 source. The fetched
history and two exact deployment stages are sealed at
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/planning/production-migration-deployment-bundle-20260829T124116Z`.
Its manifest SHA-256 is
`10dc5a8cc4ccba6671d528b1555bee89f2a34edc70362cc63258b64da6e68b24`;
its `SHA256SUMS` file has SHA-256
`36ed32b6237a9176ec204c7215d015675a2ab579967247689a731e558b9f7401`.
Stage A contains all 92 production records plus exactly the 11 missing files
through `13500`; its live dry-run lists exactly those 11. Stage B contains the
same production history plus all 17 candidate files; before Stage A its dry-run
lists 17 and, after approved Stage A plus the teardown attestation, it must list
exactly the six files `14000` through `18100`. No migration repair was used.

The final disposable compatibility replay restored the captured production
schema into pinned PostgreSQL, applied all 17 candidate migrations, re-proved
the legacy overlap rejection before attestation and acceptance afterward,
verified the dedicated broker role's least privilege, and passed SQL test 305.
The proof is
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/production-compatibility-candidate-20260829T123044Z`,
whose `SHA256SUMS` has SHA-256
`c9089ca3bd7bf8a78d9af765f953a51d6dd8177a8a67c0a8d1518baccf7afe4b`;
its `proof.json` has SHA-256
`cac69b3f4891641f662fb2583821dda9e7473834d893729a29579a7497b1d728`.
The source identity is
`cc30e0fd97d8918bd581401ad03590f0698d363a`. No production data, schema or
runtime changed.

The final custody-specific production read-only checkpoint is
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/production-readonly-custody-final-20260829T121111Z`;
its `SHA256SUMS` has SHA-256
`e09bbb2f08a1fdeae8d1d6a7f6c4b1abe31a621de687430edca4c01e185098d3`.
A final ledger, hash, head and zero-work preflight remains mandatory immediately
before an approved production transaction.

## Frozen secret-custody dependency

The separately owned isolated broker/KMS canary and dedicated-login extension
passed and are frozen. The current accepted pins are:

- content-addressed deployed canary archive
  `ba59d83a8699e758f4549daa94d2e510f64526c41a0fab0ce97664cf6ca5b661`;
- package manifest
  `2223971f6994f4da946b71c0cdf80c28224e24a58ddd2734b867791c16db6b67`;
- broker bundle
  `b55d5d51bf13f2e0356e3b97f2a42ff566ebb1df84521f730240e798b80ce4cb`;
- native cloud-tool authority migration
  `1b3ef0fed7d48385422bab10ccf30b93e0e4cd99b60d5b3c98ba36bdda1c18be`;
- custody migration
  `c5135f335bae7a48c5e8bee755ebd92088b07a5d391a85490bcf24dc20a9dd36`;
- dedicated broker-role migration
  `00d72da917d5567986f6f9b001cd6d89b139d1b1f6671661079d236336403a34`;
  and
- SQL test 305
  `16d674366d101eb3142fc09a4369044ec5975a723ee7be32055a8a72acdbe53a`.

Fresh packaging matches the deployed manifest and broker bundle byte for byte.
The dedicated login is `LOGIN`, `NOINHERIT`, has no elevated attributes,
direct table privileges or `service_role` membership, and can call exactly
three custody functions. A live safe effect completed; raw, URL, base64 and
base64url reflections were withheld; authenticated revocation denied the same
effect; receipt `8a28578b-d549-4678-84b3-902c8eae417c` reconciled to
`cancelled / confirmed_not_run`; and the run, assignment and lease ended
revoked. The post-operation scan checked seven credential classes, 33 raw or
encoded patterns and 471 persistent files with zero persistent, journal,
access-log or crash matches. Current source verification passes 22 focused
custody tests, 38 LXD tests, 19 bootstrap tests, four packaging tests, SQL after
all 91 migrations plus the upgrade fixture, and `npm run check`.

The final signed v55 real-GPT guest proof is blocked on the exact encrypted
OpenAI/Codex account's usage allowance at this record's current checkpoint. Its
signed provenance pins source commit
`3a4b8b5c229d725b8ce6d47b27f0349b521f3839`, guest manifest
`5edcc95298dd82a6af203493c5610527498f03f907da6324bb69bb4fc6b18c5f`,
runner image
`localhost/qorpera/sandbox-probe:135b4fc7b40f70a0fd6859fb9400fbb42d820ebc@sha256:adda31f15d111ed8a06d4d773bac9d8d309047e09862642a292068d62b9b60e1`
and LXD image fingerprint
`e6f9e5046eb6909bbdb5ef861a030ce45e7a58ed53bb1bc157aa78792233e06d`.

A provider-side schema probe accepted the send schema, connector schema and
both together, rejecting only the deliberately invalid empty namespace. The
two attempted runs returned the fixed structured enum `usageLimitExceeded`
with `willRetry=false`. Both were terminalized with zero durable model
requests, effect receipts or public sends and revoked native leases. The guest
was restored to exact signed native-host SHA-256
`90e3cff0f6e595fb1c8b802d57be07793818f46d54dd8818f9a1ccf24b01d3d9`;
temporary diagnostic bytes are excluded. The sanitized blocker evidence has
path
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/signed-v55-secret-gpt-20260829T134641Z/usage-limit-diagnostic.json`
and SHA-256
`01502c71ab62a1b8c0603cf5c1c30e67010c09c084c2a17d67fbbbf9322ca576`.
Do not treat the signed inputs or safe blocker handling as a passed real-GPT
result. Acceptance still requires replenishing or reconnecting that exact
account, rerunning the exact signed bytes, freezing the non-exposure result and
cleaning proof-only ingress/resources.

Read-only Azure review currently finds the proof-only public IP
`pip-qorpera-s2-secret-proof`, NSG rule `allow-step2-proof-from-lxd`, four
persistent v54 Run Command resources, and a stopped marked v54 image-builder
VM. These are cleanup targets owned by the custody proof lane, not production
resources to retain. The pre-cleanup checkpoint is
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/custody-v54-precleanup-readonly-20260829T131919Z`;
its `SHA256SUMS` has SHA-256
`e54dbf12ea87ccfb4ea0e798d5b4c5f336476e550e845bbd7ab41708e57fffb4`.

## Exact reviewed SQL delta

The integrated candidate contains these files, in this order and with these
SHA-256 values. All 17 passed the captured-production compatibility replay:

| Version | File | SHA-256 |
| --- | --- | --- |
| `20260828004000` | `native_cloud_tool_authority.sql` | `1b3ef0fed7d48385422bab10ccf30b93e0e4cd99b60d5b3c98ba36bdda1c18be` |
| `20260828005000` | `company_file_path_gateway.sql` | `f312180efc6a5d20df523c86a3c40bba7f1585f533032aee2165727ccbab22bc` |
| `20260828006000` | `native_company_context.sql` | `c7822b21d7b385715200c76cc1a83ba05023cae3cebfd924d299f7b25579721d` |
| `20260828007000` | `cloud_object_continuity.sql` | `658c3ec14ff219141fbe0b9ed1d028ac95a7a47bfacb321c1435d7664ac150f1` |
| `20260828008000` | `native_company_object_staging.sql` | `2b7cde08f366edb6541a7abe2c12eda61e4bfa9af1038986c6b05e472ae6b1f2` |
| `20260828009000` | `company_path_runner_completion.sql` | `a871898a60276e586f5af0286e0210cfb9f0f3b6a0402132bda5cf791ceccf9c` |
| `20260828010000` | `native_company_execution_admission.sql` | `0dffcc0e04a12f48bd3d16512901aed3836e7d38640b430f6f99a56a7ec27de0` |
| `20260828011000` | `member_company_path_objects.sql` | `49a876cec295563b8ba3efab14de5f2e49545cff763031a4ed39982f96b91eac` |
| `20260828012000` | `member_company_file_commands.sql` | `943d51866fadb0f3ae1de730219c18567772c6b9ca43e959f5f2ec5c8fa623e9` |
| `20260828013000` | `member_session_attachment_authority.sql` | `78bea6f4a5f6123460043cd19d803be1a1007e2427516c9f50df5976ce55ef1b` |
| `20260828013500` | `legacy_company_computer_teardown.sql` | `5e26ac0d8e80e5b6015f6bdffb92664923d108d412a9320ef7049cec88d0d865` |
| `20260828014000` | `company_path_computer_interlock.sql` | `dfe250f36e3db5712e978abf43cfdf6bbe06a2b023af9353df65cf1357dc6413` |
| `20260828015000` | `compute_identity_recovery.sql` | `34c87c597379df16e63f695a5739e3e017de5251411a1417b03b7a30f407614d` |
| `20260828016000` | `member_identity_recovery_review.sql` | `5eb8e435ac6797238486f5a05af85cda3fd30847421c6ea005d739444d3a4f60` |
| `20260828017000` | `governed_company_computer.sql` | `a6a7400fa630114b6b217d72eaebea62058b9c4611d393f3fe18cb9e6a4295ca` |
| `20260828018000` | `cloud_secret_custody.sql` | `c5135f335bae7a48c5e8bee755ebd92088b07a5d391a85490bcf24dc20a9dd36` |
| `20260828018100` | `cloud_secret_broker_role.sql` | `00d72da917d5567986f6f9b001cd6d89b139d1b1f6671661079d236336403a34` |

Recompute every hash and refresh the live ledger immediately before approval.
Use an explicit reviewed transaction/runner that tolerates the recorded
production-only history; do not use a naive history-repair or blind `db push`.
A failure rolls back the current migration transaction and stops the rollout.
Previously committed additive migrations are not down-migrated automatically.

The future SQL change is intentionally split at the physical-teardown fence.
After the old runtime is stopped, its raw NAS mount is absent and the existing
lifecycle RPC has retired the exact registry/logical row, apply `04000` through
`13500` in reviewed per-migration transactions and stop. Register the exact
four proof hashes with
`qorpera_register_legacy_company_computer_teardown` and verify its immutable
authority digest. Only then apply `14000` through the frozen `18100` broker-role
migration. An unresolved legacy row makes `14000` roll
back; a label without the matching `13500` attestation does not pass. None of
these production calls is authorized yet.

## Existing shared Company Computer and teardown boundary

The read-only audit found exactly one legacy Company Computer, all for the
target Company File:

- registry ID `b13c3dc2-2bf0-4be0-8675-52bece89ee1a`, lifecycle `active`;
- logical computer ID `6d9da3a0-f09b-4d63-b79b-8a3aad7919d9`, status `active`;
- physical node ID `802a53f7-6544-46e6-b7a5-502cb368eba6`;
- client computer ID `94e4a50a-d711-464a-bc5b-9a78abf0be55`;
- one screen `a34c0c41-4e6a-45af-85bc-3035b9942abe`, unoccupied, not open,
  and power state `closed`;
- zero Company Computer runners, open assignments, execution runs or turn
  requests at audit time.

The registry has 240 retained events and its screen has 218 retained view
capabilities behind restrictive foreign keys. They must not be deleted merely
to satisfy the path interlock. Migration `20260828013500` therefore retains the
old logical and audit rows and adds a service-only immutable teardown
attestation before migration `14000` installs the interlock. It requires the
old logical computer to be retired with no
addressable work and pins four independent SHA-256 proofs: the exact legacy
binding, physical teardown, process fence and mount detach. The retired row and
the attestation then become immutable. Only that exact attested tombstone is
ignored by the path interlock; a disabled/retired label alone remains
insufficient. New work still requires the separate exact governed binding.

The approved runtime drain and durable-detach change produced four complete,
accepted proof artifacts: exact legacy binding, physical teardown, process
fence and mount detach. They are evidence inputs only; they have not been
registered in production because the lifecycle/attestation SQL calls remain
unapproved. The existing service lifecycle function is
`qorpera_company_computer_lifecycle(uuid,text,text,jsonb)`, definition SHA-256
`da8587ccb0c03ad76344c69f228de6214800229d2138c131dd9cc18029b20741`.
Its future call target would be registry
`b13c3dc2-2bf0-4be0-8675-52bece89ee1a` to state `retired`, followed by the
new teardown-attestation RPC with the exact proof hashes and current owner
authorization. No such call has been made.

## Production runtime audit and Step 3 separation

The production host/runtime audit is sealed at
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/production-runtime-readonly-20260829T094827Z`.
Its `SHA256SUMS` file has SHA-256
`28162eb676cd65471df07941b629aedd0987f37c5b36578b4033d8f88920859c`.
The audit made no database, host, LXD, service or NAS mutation.

The user explicitly approved stopping, but not deleting, the five terminal-job
managed-sandbox instances and six old Step 2 image/package test instances found
running by that audit. At `2026-08-29T10:09:19Z` the runner orchestrator was
stopped and disabled; all 11 instances stopped cleanly without force and were
verified `STOPPED` by `2026-08-29T10:09:50Z`. The nine previously stopped
terminal-job instances and every stopped build/acceptance instance remain
present. No LXD instance, image, storage volume or project was deleted.

The user separately approved stopping and disabling both host providers while
preserving the stopped Step 3 VM and every Step 3 byte/configuration, followed
by a non-forced detach of `/mnt/qorpera-companies`. The exact executed root
script has SHA-256
`871d3e9275c003831751b187959c969d206d9d188c56959a0a37a982c4f44e28`.
Both host providers are now disabled/inactive with main PID zero. The Step 3 VM
`qorpera-cc-6d9da3a0f09b4d63b79b8a3aad7919d9` remains stopped and configured
with logical ID `6d9da3a0-f09b-4d63-b79b-8a3aad7919d9` and dataset source
`/mnt/qorpera-companies/company41`. The raw mount and its mount identity are
absent; no force/lazy detach was used.

A read-only post-drain check found one orphaned standalone v48 provider process
outside systemd, owned by the prior acceptance directory and listening only on
127.0.0.1 ports 18491/18492. It was within the approved provider drain and was
ended gracefully with `SIGTERM`, not force, at `2026-08-29T10:22:12Z`. Its
retained bundle remains present with SHA-256
`02bf0e81e432a00b3fa4a1bebea9be78d06decdaa1a7406974896952913418c7`.
The final audit finds zero provider processes and zero listeners on those
ports.

The first asserted post-drain checkpoint remains sealed at
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/production-pre-sql-drain-20260829T102303Z`,
`SHA256SUMS` SHA-256
`0b45655b34f8f663f34013bf96e4c355d909583a32e0c66eedf78e8565b91c53`.
It correctly rejected its mount proof because the live mount was absent but the
persistent remount definition still existed.

The user then explicitly approved the exact durable-detach proposal preserved
at
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/planning/production-fstab-durable-detach-20260829T103142Z`,
manifest SHA-256
`0939566d7997f095348baf4943bf080cb5f7b2e9d0463e54d15049978d6b710e`.
The proposal's initial script used `oflag=excl`, which GNU `dd` rejected before
creating the backup or changing `/etc/fstab`. That failed trace is retained.
The implementation was corrected only to the valid equivalent `conv=excl`,
verified by an exclusive-create probe, and restaged with SHA-256
`ffd2450b5cd9a9b75a8bb4497cd11e2c23721519123fd13374d6c2db3a82ae76`.
No approved target, expected hash, validation, rollback or excluded action
changed.

The corrected run completed at `2026-08-29T10:54:30Z`. It exclusively created
the root-owned mode-`0600`, 870-byte backup
`/etc/fstab.qorpera-before-step2-legacy-detach-20260829T103142Z`, whose
root-verified SHA-256 is
`a280c5e1c67b5f78461cf9bcd34853a8d2f80e49ea4cdfa863ddca4083abe8fa`.
It changed only line 15 by prefixing `# `, from:

```text
192.168.0.90:/volume1/qorpera-companies /mnt/qorpera-companies nfs4 rw,noatime,_netdev 0 0
```

to:

```text
# 192.168.0.90:/volume1/qorpera-companies /mnt/qorpera-companies nfs4 rw,noatime,_netdev 0 0
```

The installed `/etc/fstab` is root-owned mode `0644`, 872 bytes and SHA-256
`f905d9b895407f6dd72b76ea0c07b3868795ed44b23c8ed702f60339764869f4`.
`findmnt` accepted it; the file and directory were fsynced; the mount and mount
identity remained absent. No service/VM state, NAS data, production SQL or
Step 3 byte/configuration changed during this operation.

The final independent host/database audit is sealed at
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/production-durable-detach-20260829T103142Z`.
Its `SHA256SUMS` file has SHA-256
`ceca748da8666ba8610e6c68c032e16b669cf0fa95e37ffe18faef332bfbbbeb`.
At `2026-08-29T10:55:47.700Z`, every non-management runner-project instance
was stopped, all 14 correlated managed-sandbox runs remained terminal,
production still had zero Company Computer runners, open assignments,
execution runs or turn requests, and all four proofs were complete:

- exact legacy binding:
  `e7ca2c8fef8c4eaa5e21f7ed120604bc4f45cf2500a03785a44ad913a143cd8f`;
- physical teardown:
  `5bfed0cf83f21138455cf39b5d1d49fca62680a9645dbefb21a2c2585daf770d`;
- process fence:
  `182567958a346818e0f0f8df6f07fd8265880b72c6a533e3f2fad336fabbf51e`;
  and
- durable mount detach:
  `2076970c861e35bc2f0a7596a8bd8ffae06cca19bb5255eb61c93ce4a23bbded`.

The mount proof records `durableAcrossReboot: true`, `proofComplete: true` and
`productionGateSatisfied: true`. No lifecycle or teardown-attestation RPC has
been called; production SQL remains separately prohibited.

## NAS create-only reconciliation

The only proposed Company File byte writes are the two absent canonical files
and their six absent parent directories under
`/mnt/qorpera-companies/company41/live`:

- `agents/14c35f74-ce03-40c4-aceb-c4b36be4fe29/{artifacts,skills,memory.md}`;
- `agents/3bd9862b-42e0-4937-b236-6c1d5e6c19a5/{artifacts,skills,memory.md}`.

Each `memory.md` is 204 bytes, non-executable, with SHA-256
`9eb5066e67daed4ea7d4e4c0b20b654a2fec0572ce2e7a60a25543583cfbd200`.
The observed target contract is UID 1024, GID 100 (`users`), directories mode
`0777`, files mode `0666`. The user explicitly approved these eight targets.
They were created exclusive/no-follow at `2026-08-29T10:07:47.496148Z`, with
directory-relative descriptors, exact ownership/modes and file/directory fsync.
There were zero overwrites and zero deletions. Read-after-write hashing and the
complete live-tree re-audit passed.

The final read-only reconciliation was refreshed through
`2026-08-29T09:40:44Z` and is
sealed at
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/nas-readonly-final-20260829T093634Z`.
Its `SHA256SUMS` file has SHA-256
`6263419f310034204bf3542230f90355c6f818de646f1f27ae755aa782244986`.
The cloud head, all canonical hashes and the exact eight missing targets were
unchanged before the approved write. The completed reconciliation is sealed at
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/nas-create-only-20260829T100616Z`.
Its `SHA256SUMS` file has SHA-256
`d0c1be5c96838777e734a9af09ecaa827e93950b6a6800c7508b0be679c0098b`.
The post-write tree contains 206 files and 145,839,120 logical bytes with zero
canonical differences; the production head and tree manifest remained exact.

## Frozen production packages and signed guest

The integrated source candidate is commit
`3a4b8b5c229d725b8ce6d47b27f0349b521f3839`. The broker, recovery, LXD-host
provider and orchestrator package snapshot was originally rebuilt from its
parent `cc30e0fd97d8918bd581401ad03590f0698d363a` at
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/production-package-refresh-20260829T124424Z`;
its `SHA256SUMS` has SHA-256
`b6a2f4c32afde0d66b7d788c8f93ddb84590ca1f2d1bf612b04480e01886a96f`.
Fresh packaging from `3a4b8b5c2` reproduces all eight manifest/bundle hashes
exactly; that child changes only the connector-tool boundary and its focused
tests. The replay is sealed at
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/production-package-replay-3a4b8b5c2-20260829T141446Z`;
its `SHA256SUMS` has SHA-256
`ddfdd64a2a1fdbb6969f2bfbd8cdb3eb71481f6e8c0d7127d80d9f1a2c7c64c9`.
The deployment pins are:

- cloud secret broker manifest
  `23bdd2e63c10d0e0052c641476e1377e5208cd7236bbd9414a5a6f70af1f4db0`
  and bundle
  `c3b986836344af31bfbe63ac5a6257eb97dc2df0ce4b2af5842074d7023e6404`;
- identity recovery manifest
  `8e137709e6cf8c60d215bdf30b6773a72e187b427c68c964269875a7d11f1f05`
  and authority bundle
  `4f0ab7a409be48d96e321b1a5aafad7bd12727288bd085a8a899a1e123e7c59b`;
- LXD provider manifest
  `a64829ac3c0671731111098c5605b01cf6318a66586a32ddbeeb8d59df1d0534`
  and provider bundle
  `fe5f624e7ffd6776a7b2d384145243df1534e8df390ba7ee47bfeb9d4d852d60`;
  and
- Runner Orchestrator manifest
  `fbf8952dbfed5f4b541163d7f7a0001b0455dec5154249a7c072c45b30edb022`
  and bundle
  `58adfcae730a0a371f322023aa02453b919eb58d14179bcc73ab2aacdd357ce9`.

The v55 image inputs are LXD fingerprint
`e6f9e5046eb6909bbdb5ef861a030ce45e7a58ed53bb1bc157aa78792233e06d`,
guest manifest
`5edcc95298dd82a6af203493c5610527498f03f907da6324bb69bb4fc6b18c5f`,
sealed guest-package archive
`86079a21785f1a60fc176a77c0b6a8f67dc940e455787b63d9d83e5dee0dc0e3`,
native provider host
`90e3cff0f6e595fb1c8b802d57be07793818f46d54dd8818f9a1ccf24b01d3d9`,
native binary
`2f2c26cfdfacebbcce848fb50cfaaa4e8d0aa3c6ec3c1009123ecf766c8335f7`,
guest bootstrap
`6d5615c2daa931e5f80cdf91262a5f4cd7cd4c3db69f30901e26740686b3a372`,
runner OCI archive
`c9370c825bdbd589bf0c1391e567b8f5ea8ba36161cc554b32fcfb235f046239`
and Cosign bundle
`98a00fefd625c9aceeadd746ee610682a8787e5ce85ec0a6ac513a354a7491ce`.
The final real-GPT result, non-exposure manifest and proof-resource cleanup
remain the last acceptance dependency.

Deployment metadata now pins these packages, preserves the existing configured
management VM during a disabled update, and carries the governed runtime's two
distinct root-only bearer files plus broker CA pin. Those metadata changes are
uncommitted and authorize no deployment. No further commit is authorized by
this record.

## Unpublished production-client candidate

The current macOS arm64 shell was built and packaged locally from commit
`3a4b8b5c229d725b8ce6d47b27f0349b521f3839`, tree
`54b307f0c1a55203d2c61086855199d039f39a31`. Its tracked package inputs were
clean at that commit; the uncommitted deployment metadata above is outside the
packaged app. The packager verified that the agent and Codex runtimes were
present and that the packaged renderer painted a nonblank frame. Six critical
compiled modules, including `cloud-secret-tools.js`, matched their packaged
bytes. Deep/strict code-signature verification passed.

The preserved, unpublished evidence is
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/production-client-package-v55-20260829T140034Z`;
its `SHA256SUMS` has SHA-256
`a6cd6ea3058e27eda24e53d4d1ee3a04d0e84002cd40d7614f2e260b0c823214`.
The ZIP SHA-256 is
`24a1869b677d6a456800f4eb07162abd97b2f55a1f9d0d825cbae53dfd2e57f5`;
the DMG SHA-256 is
`b1ac2b865214c46e525a4c0cef11d4fbe41732a4cd11e3cdb56402ddbdd7b1e2`.

This is not a releasable client. It retains existing product version `0.20.44`,
uses an Apple Development certificate, is not notarized, and Gatekeeper rejects
it. Nothing was published or installed. A real release requires the separately
approved production result, release commit/branch, new version, distribution
signature, notarization, fresh package, push and release action.

## Proposed production targets and required source order

The production SQL target is only project `wovsmjvghnbcbfazdtvr`, profile
`88227549-9724-43c2-8966-9fafb3e855d6`, environment
`0d2053f0-c1a8-444d-99a8-68c8214e5414`, current snapshot
`0c0656d6-42b3-485f-86b3-a3ba1d5f6032`, and authorizing owner
`4fa1e977-a64a-4d39-a5c6-91ffd677f507`. Those dated identifiers must be
revalidated. The following is the required source order, not an executable
approval packet; freeze a new exact migration/hash/rollback set before asking
for the production window:

1. Re-run the read-only ledger, head/tree, zero-work and identity preflight.
2. Call the existing
   `qorpera_company_computer_lifecycle(uuid,text,text,jsonb)` only for registry
   `b13c3dc2-2bf0-4be0-8675-52bece89ee1a`, changing it from `active` to
   `retired`. This retains its logical computer, screen, events and historical
   capabilities and clears only the legacy encrypted-volume binding required
   by the existing lifecycle contract.
3. Apply Stage A's exact 11 migrations, `04000` through `13500`.
4. Insert the one immutable teardown attestation through
   `qorpera_register_legacy_company_computer_teardown` for logical computer
   `6d9da3a0-f09b-4d63-b79b-8a3aad7919d9`, client teardown ID
   `ea46646a-fe71-42fd-8ce9-ef3699e8dd01`, the four proof hashes pinned above,
   and owner `4fa1e977-a64a-4d39-a5c6-91ffd677f507`; then read back and verify its
   server-derived computer-authority digest.
5. Apply the revalidated Stage B prerequisites, `14000` through `18100`, then
   the organization and provenance migrations `19000` through `19900` in
   order. Keep admission and the bootstrap worker paused until the matching
   bundle is installed and the activation matches its generated manifest.
   Inventory pending historical inputs/runs; do not silently repin or replay
   incompatible work. The historical 17-file packet does not cover this set.
6. Register one recovery-authority row for authority ID
   `ea95ab94-5bfa-4719-8c73-0e28859b684d` only after its independently generated
   public keys, service origin and control-capability hash have been frozen and
   presented in the execution approval. Private keys and capabilities never
   enter SQL, source, chat or the Company File.
7. Drain the cloud-owned `CompanyBootstrapProvisioner` job for the verified
   target environment. It must preserve the exact current immutable base,
   add only missing canonical organization entries, and finalize through
   `qorpera_finalize_company_bootstrap`. The finalizer uses
   `qorpera_enable_company_path_gateway_v3` with the exact verified
   organization-and-agent document map, atomically advancing the Company File
   head and projections. Do not call the legacy projection-blind gateway RPC.
   Verify job completion, resulting head/path-index equality, canonical
   Co-Founder/formation versions, exactly-one first-run records where required,
   and distinct member-private sessions. Record the resulting head; it is not
   assumed to remain the dated 206-file snapshot above.
8. Establish the existing company Compute Identity
   `50b6456a-3f13-4cd7-a671-a8619eb758d0`, create and verify its two-copy key
   backup, and keep admission closed until the receipt is durable.
9. Call `qorpera_register_governed_company_computer` with new client computer ID
   `49676b8b-ec73-4608-802f-004f14f49aba`, that existing Compute Identity, and
   the newly accepted bundle-compatible image, bootstrap and native hashes,
   and the same owner. The function generates the new logical computer ID; it
   cannot reuse legacy client computer ID
   `94e4a50a-d711-464a-bc5b-9a78abf0be55` because that immutable historical row
   remains unique.

Reserved recovery proof identifiers are target
`52be89ce-8b4a-49e1-b6c0-957588b07125` and client request
`ec44ac2c-a20e-4e6c-892f-6d850bf9a3d9`. They are planning values only and have
not been inserted. The exact public keys, capability hashes and resulting
server-generated logical/recovery/receipt IDs must be captured before admission.

## Private production network and recovery placement

Read-only host/NAS inspection found the company host online in tailnet
`qorpera.com` at `100.75.4.70`, advertising no subnet route. The NAS exports
only `/volume1/qorpera-companies` to host LAN address `192.168.0.206`; the host
reaches NAS `192.168.0.90` directly. The proposed least-scope path is to join
only the Azure infrastructure VM to that tailnet, advertise only
`192.168.0.90/32` from the company host with subnet-route SNAT retained, and
allow only recovery-authority-to-`192.168.0.90` TCP 2049 plus
company-host-to-broker TCP 8443 in the tailnet policy. UDP NFS, Tailscale SSH,
exit-node use and every broader subnet route remain denied. This requires no
NAS export change and does not restore the retired raw Company File mount on
the host.

The preferred low-cost placement is a separate recovery service, user, keys,
credentials and retained 32-GiB E4 journal disk on the existing Trusted Launch
Azure infrastructure VM, outside every execution node. It preserves a distinct
local journal plus NAS and Supabase replicas, but shares the broker VM failure
domain; a separately priced recovery VM remains the stronger alternative if
the operator requires host-level separation. This packet does not price or
authorize that alternative; selecting it requires a new exact SKU, disk,
network, time and cost proposal before provisioning.

The read-only proposal and official Azure Retail Prices API observation are
sealed at
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/planning/production-private-network-20260829T130726Z`;
its `SHA256SUMS` has SHA-256
`e17c86bdc45289b494d5621381d88fc2235eb6d6827fd29a76328849a88ab20b`.
The exact incremental journal-disk commitment is EUR 2.1087/month before tax.
At 730 hours the known existing VM, OS disk, NAT gateway and static egress IPv4
subtotal is EUR 80.9487/month; with the journal disk it is EUR 83.0574/month.
Private Endpoint, Key Vault, Storage, NAT data processing, transfer and tax are
variable or excluded, so this is not an all-in invoice ceiling. Retaining and
promoting the isolated Azure resources, the disk, Tailscale enrollment/route,
NFS mount and first recovery-object writes all require explicit approval.

## Disabled installation, recovery and canary order

Freeze signed gateway, provider/runner, recovery-authority, restore-client,
bounded custody-canary and released-client packages only from the passed Phase
A, Phase B and separately owned custody proof bytes. Install production runtime
components disabled, with admission paused and drained. Verify package hashes,
systemd sandboxing, loopback-only listeners, LXD project/storage identities, no
public listener and old-provider inactivity before applying SQL. Production
connector adapters and their user-facing authorization flows remain Step 7 and
are not a Step 2 launch gate.

Recovery authority must be established before the first new admission. Require
the dedicated retained journal, registered public/control keys and a two-copy
encrypted-key backup receipt for the existing company Compute Identity. Never
regenerate an established identity key or decrement its epoch.

Acceptance order is: synthetic acceptance company; multiple human identities;
mediated shared-computer read/write; public-mouth privacy; revocation during
work; lost acknowledgement; source-node loss; replacement install; old-node
generation/lease/effect denial; fresh admission; exactly one completion receipt;
then one production-company canary. Permit a production write only after all
read-only and recovery checks pass.

The client is cut only from the frozen accepted source after server/runtime
compatibility. Re-run unpublished Node/Bun package smoke tests and every release
check. A real default-provider prompt or paid model call needs separate
authorization. Commit paths, push target, release version and release action all
need explicit approval.

## Rollback and recovery boundaries

- Before canonical effects: keep admission closed, stop new services and route
  back to prior binaries. Preserve additive schema and evidence.
- After a canonical revision, recovery epoch, external send or receipt: drain
  and forward-fix. Do not downgrade the database or client blindly.
- The legacy teardown attestation is irreversible evidence. Do not revive,
  mutate or delete its historical logical/registry/event rows.
- Immutable cloud objects are not rolled back by deletion. Correct the
  authoritative reference while retaining evidence.
- NAS restoration is create-only. A partial create is forward-fixed after
  revalidation; any deletion requires a new exact approval.
- Phase B and Azure pilot resources follow their own explicit cleanup records.
- The Company File remains authoritative and independent of every VM disk.

## Remaining approval packet

The completed inputs now include Phase A (`SHA256SUMS`
`df4a2d49b1d6c81e611b65dd929d4f0082fdc045b81c503ab3dca5c25628a514`),
Phase B, the four accepted teardown proofs, refreshed production ledger/head/NAS
state, the 17-migration replay and staged deployment bundle, production package
pins, signed v55 inputs, exact database IDs, planned canary IDs and current
pause/drain witnesses. Providers and orchestrator are fenced, every
non-management runner instance is stopped, the raw mount is absent and durably
retired from `/etc/fstab`, the NAS reconciliation is complete, and Step 3 bytes
and configuration remain preserved.

Before requesting any production mutation, add the custody lane's final signed
real-GPT result, non-exposure manifest and cleanup inventory. Production
preparation then requires two separate approvals because the recovery public
keys and capability hashes do not exist yet.

Also refresh this historical packet for `19000`–`19900`: current target/head
inventory, exact migration bytes and split-owner schema replay, generated bundle
verification, signed runtime/package compatibility, and offline multi-member
organization/path acceptance. Do not count earlier custody or mouth evidence
as proof of the new bundle, and do not rewrite their frozen artifacts.

The first approval is infrastructure staging only. It must name:

- retention/promotion of the isolated Azure broker resources and their ongoing
  known EUR 80.9487/month base subtotal plus variable charges;
- one new retained E4 recovery journal disk at exactly EUR 2.1087/month before
  tax on the existing infrastructure VM;
- the exact Tailscale enrollment, TCP-only ACL and `192.168.0.90/32` subnet
  route;
- generation of recovery keys/capabilities on the Azure authority; and
- no production database/schema change, runtime-package change, NAS mount or
  data write, recovery-service enablement, or admission during staging beyond
  the explicitly approved network configuration.

If host-level recovery separation is required instead, stop here and prepare a
separate exact VM/disk/network/time/cost proposal; this record cannot authorize
an unpriced alternative.

After staging, pause. Freeze and present the exact Azure resource IDs, private
service origin, recovery public/control keys, control-capability hash, broker CA
pin, backup destinations and a fresh production ledger/head/zero-work preflight.
Only then request a second approval for the bounded production window, naming:

- the exact production SQL sequence and identifiers listed above;
- disabled host/management-VM package installation, root-only configuration,
  recovery service, first two-copy backup, governed-computer registration and
  read-only production canary;
- rollback operator `Jonas.mk@qorpera.com` and a bounded start/end time; and
- no production Company File write, public send, paid model request, push or
  release in that window.

Any canonical write/default-provider prompt, further source commit, push,
client version, tag or release remains a separate approval. Until the signed
proof and both exact approvals are complete, all production SQL, further
runtime/NAS changes, NAS deletes and release actions remain prohibited.

## Signed v56 custody handoff and cleanup (2026-08-30)

The bounded signed-v56 native GPT canary and cleanup passed. This supersedes
only the historical v55 usage-account blocker and proof-cleanup-pending status
above. It preserves the 2026-08-30 source-review addendum and the required
bootstrap-worker/v3 rollout sequence. It does not certify the newer source,
open production admission, or authorize production SQL or another Azure run.

The sealed record is
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/signed-v56-final-custody-20260830TeMXRHG/ACCEPTANCE.md`.
Its enclosing `SHA256SUMS` has SHA-256
`9f1e6d69e3a967f479b4f4776ebab37183cc36f7ca306bae447df18629c8c3a1`;
the manifest has SHA-256
`64623a02949f30ae688ab154b3adb1a38d5efe3308d96ecd0aca6a7c03c06642`.
All 72 evidence files, including the guest package and encrypted recovery
copies, are retained create-only. Previous evidence was not rewritten.

### Signed runtime and durable result

The exact runtime source commit is
`509f514362a8000a8398faa86663a873c2828f97`, guest package SHA-256
`6a662a6b93c3737d417b08764591c784f69d65b732beb75934f7703ae2fa13d9`,
guest manifest
`94b5dd1675f85955f8059eb25429b4d35800147206b1fa87ce7e5638bcea3d14`,
and LXD fingerprint
`507024b38d726a12fc74514e7e473f7766e8e339495e610c425d80b6787f61d9`.
The native host remains
`90e3cff0f6e595fb1c8b802d57be07793818f46d54dd8818f9a1ccf24b01d3d9`;
the fenced Codex remains
`2f2c26cfdfacebbcce848fb50cfaaa4e8d0aa3c6ec3c1009123ecf766c8335f7`.
The signature and signed acceptance-evidence digest were reverified locally;
wrong-fingerprint and tampered-statement inputs were rejected. No new signing
or diagnostic executable substitution occurred.

Only preview `tlnzirrtjufnexorsbic` and synthetic company
`38500000-0000-4000-8000-000000000010` were used. The approved replacement
account completed native login after a durable encrypted-key backup. Run
`b5c26172-8bb0-4214-ab28-9641d761ac59` then completed through the signed
on-prem guest `qorpera-login-3b90-v56`: one native-start event, one progress
send, one final send containing `STEP2_V56_SECRET_PROOF_OK`, and one completed
connector receipt `9ca942e6-fc71-4f72-87e2-0b1a44fb3b91`. Destination effect
`532fa335-8386-459a-a117-0469debf557e` matched its exact downstream digest.
The job and assignment are completed, the native lease is released, and there
were zero Company File revisions. The approved native subscription was used;
no API-key model call or production send was made.

Earlier attempts remain separately recorded, including one completed safe
effect whose operator controller incorrectly counted progress as an extra
final send. That completed receipt was preserved, not relabeled or replayed.
All four attempts have terminal jobs/leases and no unresolved effect receipts.
The accepted final result is not inferred from a zero model-gateway row count.

### Non-exposure and cleanup

The post-run scans passed: Azure checked 12 credential classes, 41 patterns
and 730 files; the signed guest checked 8 classes, 28 patterns and 64 files,
including provider access/refresh/ID tokens. Persistent-file, journal and
process-environment/argument matches were zero; Azure access-log bytes and
crash-file counts were zero. After cleanup, all 143 preview public/auth tables,
268 rows and 47 combined pattern digests were checked with zero matches and
zero inaccessible tables. Exact coverage and authorized root-only credential
source exclusions are preserved; this is not an unbounded whole-machine claim.

The synthetic effect grant was revoked through the ordinary member RPC. Both
the v56 login/proof guest and the earlier v55 proof guest stopped without
force; no LXD guest, image or volume was deleted. Their correctly bound
identity volumes and keys remain intact. Five local and two guest temporary
admission/request transport files were removed after terminalization; accepted
results and encrypted recovery copies were retained first.

Azure cleanup removed only proof NSG rule `allow-step2-proof-from-lxd`, public
IP `pip-qorpera-s2-secret-proof`, and temporary E4 disk
`disk-qorpera-s2-recovery-journal-01`. The broker VM was deallocated at
`2026-08-30T03:10:11.457Z`; disk deletion completed at
`2026-08-30T03:10:18.779Z`. Both canary mounts had been unmounted without
force or lazy detach. Only their two Azure `/etc/fstab` entries were commented;
the loopback export definition was backed up and disabled. The sealed journal
matched its NAS and cloud replicas and is retained both locally and on the
preserved Azure OS disk. No production NAS mount or byte was changed.

Final readback confirms no VM public IP, no attached data disk, zero managed
Run Command resources, no extra Azure image-builder VM, and absent Phase A/B
resource groups. Key Vault remains private-endpoint-only/default-deny. Storage
has shared-key access disabled, default deny and zero IP rules. Fourteen
isolated broker/KMS/storage/OS/network resources remain retained; deallocation
does not eliminate their standing non-compute charges. The temporary disk
lived for 5.918655 hours, within the approved 24-hour/EUR 4 before-tax scope;
the recorded 24-hour VM-plus-disk estimate was EUR 1.6077271232876715, not a
measured invoice. No production promotion was performed.

### Frozen Step 2 SQL pins and remaining integration boundary

The production replay and source pins above are historical. The corrected
Step 2 values for the new handoff are:

| File/version | SHA-256 |
| --- | --- |
| `12000_member_company_file_commands.sql` | `28aa4915be004c4e74f391bba6781b76e0a7f45b6d202d6c100a32f83b530a89` |
| `13000_member_session_attachment_authority.sql` | `87e6a9b44943fd6d5139e79c8ba2d8b52bd0b1750b70c35f61944bfa507b4dc8` |
| `17000_governed_company_computer.sql` | `e75c02ac6aa017794a0958e732c680b4f18343a8aab74f44be8bb3dfde998cba` |
| `306_governed_company_computer_privileges.test.sql` | `f11f6f68241bad71fa420489ceade2354db0e348ca1b789fc93772f0d072a89b` |

The first two preserve split-owner retained-object calls with narrow dynamic
owner grants. The `17000` correction conditionally revokes the retained legacy
binding trigger's PUBLIC/API execution grants while preserving its exact
definition, owner and trigger bindings. All 17 Step 2 delta migrations, the
fail-closed teardown interlock, SQL305 and SQL306 passed against the captured
production schema; the disposable database/container/volume were removed.
The proof JSON SHA-256 is
`eb4803d229e6f23d61894f8e5402c93537c2315f8d6c71bf278f4812a27c5042`.
Only the extracted ACL reduction was applied to the isolated preview, whose
broker readback was exactly three functions, no direct table privileges, no
elevated attributes and no `service_role` membership. Production was untouched.

This replay ends at frozen `18100`; it does not cover the later Step 0 wrappers.
The subsequent reassessment found missing-member NULL authorization, reopened
broker function grants, private Co-Founder shared-path access and historical
member-removal defects. A separate task owns their forward Step 2 correction
after `18100`, Step 0 correction before source-only `19900`, regressions and
new bundle. Do not rewrite the frozen `17000`/`18000`/`18100` evidence or count
this v56 result as proof of those future changed bytes.

The observed `npm run check` for generated bundle
`610f2f28b45556d92fb675d37986d8b879ff7f33b150b6edcfdae9cb0fd72b1f`
passed before that reassessment. The current production gate remains closed
until the corrected combined delta and ownership replay, new signed-runtime
compatibility and offline multi-member acceptance are verified. Preserve the
organization bootstrap/v3 finalizer, recovery-before-admission, rollback and
two-stage explicit production approvals above. No additional source commit,
push, release or production mutation was performed by this handoff.
