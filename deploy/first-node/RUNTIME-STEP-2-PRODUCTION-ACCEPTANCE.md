# Runtime Step 2 production acceptance and cutover record

Date: 2026-08-29. Status: **pre-SQL drain, durable raw-mount retirement and
exact create-only NAS reconciliation complete; production cutover remains
blocked**. Phase A and
Phase B synthetic gates passed and were fully cleaned up. The exact NAS creates,
runtime drain, Step 3-safe provider stop and non-forced raw-mount detach were
performed only under their separate explicit approvals. This record authorizes
no production SQL, further runtime or NAS mutation, source commit, push, client
release, or new Azure resource. Step 3 remains paused, byte-for-byte preserved
and separate from Step 2.

## Dependency gates

Production work remains behind, in order:

1. completed and cleaned-up synthetic Azure Phase A evidence;
2. completed and cleaned-up exact Phase B replacement-node evidence;
3. frozen source, migration, package, image and recovery hashes;
4. completed exact create-only NAS reconciliation and approved runtime drain;
5. final frozen custody/package pins and integrated compatibility replay;
6. explicit approval for the exact production SQL/runtime window; and
7. explicit commit, push and release approval after production acceptance.

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

The live migration ledger was refreshed read-only through
`2026-08-29T09:43:15Z`
and still contains 92 versions. The sealed baseline checkout contained 90.
Sixteen baseline Step 2 versions are missing from production, while production
retains 18 older versions absent from that baseline:

- `20260826110000` through `20260826230000` and `20260827000000`: the existing
  legacy Company Computer registry/screen/NAS lane;
- `20260827043000` through `20260827046000`: mobile push.

Those production-only records and objects must remain intact. Do not repair,
delete, mark-reverted, or silently import them into Step 2 source. A schema-only
dump of the real production database was restored into a disposable pinned
Supabase PostgreSQL instance. The 15 migrations through `17000` applied cleanly there,
preserving the four legacy Company Computer tables while adding the governed
computer, teardown-attestation, path-gateway and recovery objects. A synthetic
retired legacy/path-gateway overlap proved that migration `14000` fails before
an exact attestation and succeeds after the service-only `13500` RPC. No
production data or schema was changed by that proof. A second disposable pass
then applied the current 16-file snapshot through the separately owned `18000`
custody migration and verified all seven custody tables plus the service-only
authorization function. That pass used migration SHA-256
`da086b7539eed0e9583f0be32a79e3f8c077e0e13fba8a085f31e1391caf90cf`,
which is now the exact frozen custody migration hash. The compatibility proof
is `/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/production-readonly-refresh-20260829T075156Z/compatibility-provisional/proof.json`,
SHA-256 `f56d76eae0d8348a85e5dac5cb9c9053dac72ff4f367b7c7da54e813d215f23b`.
Its directory name is historical; the pinned migration equality removes the
custody-hash provisionality. A final ledger and hash preflight is still
mandatory immediately before an approved production transaction.

Those counts describe the sealed 90-migration baseline. The independently
owned custody hardening lane has since added a 91st working-tree migration,
`20260828018100_cloud_secret_broker_role.sql`, for broker-scoped PostgreSQL
authority. It is not yet frozen or included in the compatibility proof above.
If accepted unchanged it makes 17 Step 2 migrations absent from production;
the final production delta, compatibility replay and hashes must be regenerated
from the custody lane's handoff rather than inferred from its in-progress bytes.

The current read-only queries, complete migration delta and exact target state
are sealed at
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/production-readonly-final-20260829T094201Z`.
Its `SHA256SUMS` file has SHA-256
`c6cfc06d811d7daae094c0beaebdd90177bf6647dfde649657887db26b2d03f2`.
All six normalized query results are identical to the prior checkpoint; no
production schema, data or runtime changed.

## Frozen secret-custody dependency

The separately owned isolated broker/KMS baseline canary passed and was frozen.
Its accepted baseline input is the acceptance record
`deploy/cloud-secret-broker/azure/RUNTIME-STEP-2-SECRET-CUSTODY-ACCEPTANCE.md`,
SHA-256 `36677633241185639c770dc2e176eefa8797d90f228196cc68fd21260e22b399`.
The integrated source recheck matched all handed-off pins, including:

- runtime contract
  `66e1bb1deb48008563c7ea5588077922b08fd155d46e3d0232a707011b2da6bb`;
- custody deployment contract
  `6ff3fa5ade018a37df2a8943f62454d798ace510e655692414203f10effcff9a`;
- migration `18000`
  `da086b7539eed0e9583f0be32a79e3f8c077e0e13fba8a085f31e1391caf90cf`;
- SQL test `305`
  `ecf010158f1772a6a36c7fe45bb42caaf3339edb1ce6cb9ae08d7b606d8f9463`;
- content-addressed canary archive
  `ab2eb79023a6f8fab1358195a9d791954bb4003fdf45447ab64c383cb216e10a`;
- package manifest
  `5f93d023ff59ee8d959c174d81b0cc29d69f7b651667bfe0b944f4c4b7530905`;
  and
- broker bundle
  `4cb09102e1c8b25abdcb00ade3900e7647d0ca0e7eeae0dce7e9f89209361f53`.

The acceptance covers 21 focused Vitest tests, three packaging/bootstrap tests,
SQL after all 90 source migrations, `npm run check`, live
capture/use/reflection/lost-response/restart/stall/backup-restore/rotation/
old-key-removal/revocation/archive/member-removal behavior, and final
non-exposure scans. It made no model request, public send, Company File
revision, or production-parent mutation.

The custody lane is now independently extending that proof for the real
GPT/native-host route, broker-scoped PostgreSQL authority and least privilege.
Its local hardening checkpoint passes `npm run check`, 79 focused shell tests,
37 LXD runtime/provider tests, four packaging/bootstrap tests and custody SQL
after all 90 source migrations. It has not yet handed off final frozen source,
package or live-deployment pins. The hashes above therefore remain the accepted
baseline, not authority to deploy an older integrated production package.

Read-only Azure control-plane review confirmed `rg-qorpera-step2-secrets`
still exists in Sweden Central. Its dedicated `Standard_F1as_v7` broker VM is
running with Trusted Launch, Secure Boot, vTPM, system-assigned identity and no
VM public IP. Key Vault is default-deny and public-network-disabled with purge
protection and RBAC; Storage has shared-key disabled, default deny, zero IP
rules and only the broker subnet rule. The group retains a NAT egress public IP,
not an inbound VM address. This production lane did not change or clean up the
isolated custody resources or preview.

## Exact reviewed SQL delta

The frozen baseline contains these files, in this order and with these SHA-256
values. The final candidate transaction is incomplete until the custody lane
freezes `18100` and the integrated compatibility replay passes:

| Version | File | SHA-256 |
| --- | --- | --- |
| `20260828004000` | `native_cloud_tool_authority.sql` | `7add338886ee897b8acad946f549c387c6afb52cfa55dafdc23f6bddfb4e2c82` |
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
| `20260828018000` | `cloud_secret_custody.sql` | `da086b7539eed0e9583f0be32a79e3f8c077e0e13fba8a085f31e1391caf90cf` |
| `20260828018100` | `cloud_secret_broker_role.sql` | **pending final custody handoff; do not deploy the in-progress hash** |

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
authority digest. Only then apply `14000` through the final frozen custody
migration (`18100` if accepted). An unresolved legacy row makes `14000` roll
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
the independent Phase B journal, registered public/control keys and a two-copy
encrypted-key backup receipt for the canary Compute Identity. Never regenerate
an established identity key or decrement its epoch.

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

## Approval packet still missing

No production approval should be requested until it contains: the completed
and cleaned-up Phase A evidence at
`azure-phase-a-pilot/final-20260829T070839Z` (`SHA256SUMS` SHA-256
`df4a2d49b1d6c81e611b65dd929d4f0082fdc045b81c503ab3dca5c25628a514`);
the completed Phase B evidence pinned above; the baseline custody acceptance
plus the extension's pending final frozen hashes; the accepted four legacy
teardown proof hashes; refreshed ledger, head and NAS audit; final integrated
package/service/image hashes; pause/drain witnesses; the named rollback
operator and acceptance window; exact canary IDs; and the requested
commit/push/release targets. The current concrete blockers are the pending
custody-extension handoff and integrated compatibility replay, plus the missing
final production package/canary/operator identifiers and explicit SQL/runtime
window approval. The four legacy teardown proofs are accepted, the providers
and orchestrator are fenced, all non-management runner instances are stopped,
the raw mount is absent and durably retired from `/etc/fstab`, Step 3
bytes/configuration are preserved, and the NAS create-only reconciliation is
complete. Until the remaining gates are resolved, all production SQL, further
runtime/NAS changes, NAS deletes and release actions remain prohibited.
