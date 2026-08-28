# Runtime Step 2: signed cloud staging

Date: 2026-08-28. **Signed v48, v49 and v50 are preserved. Managed Storage and
human file acceptance passed. V50 includes the verified startup fixes; its
managed trace identified a successful HTTP 204 rejected by the client before
model admission. That correction is verified but not yet committed or signed.**
Step 3 is paused. Production enrollment is unchanged.

## Source and immutable artifacts

- Branch: `codex/runtime-step2-fenced-cloud`.
- Runtime/guest source: `f0574bdf5d6fcd36e29e94dcaed05c305f819ef8`.
- Provider installer pin correction: `1f72aebaebf705cd9080b234905aa49975063419`.
  This changes only the host installer checksum, not guest or provider bytes.
- The runtime commit contains 159 explicitly selected Step 2 paths, including
  the native patch's required whitespace attribute. No Step 3 migration,
  wake-policy helper, coworker tool or scheduler change was imported.
- No source push, tag, application release or production enrollment occurred.

The clean source archive was transferred to a disposable cloud build VM and
rebuilt on Linux x64. Its guest manifest exactly matched the reviewed
[package manifest](native-codex/guest-package-manifest.json). Public dependency
installation used `npm ci --ignore-scripts`; no production credentials or
Company File mount were present in the builder.

| Binding | SHA-256 / identity |
| --- | --- |
| Clean source archive | `97fe5d40243cff135d60001fe84f138ecf76f008c9a377006686b0471bc0714b` |
| Ubuntu 26.04 base image | `5e644adaf5d1c43149ea7310ac2a7cad927fa6603343e8fa9070a9200a24b7b8` |
| Guest package manifest | `1f75de50b0da5e0d4b8852df30d4a4f60bc74d04984c445afb605fe61791b9c4` |
| LXD candidate image | `8d866f522c55d75038f10ef2019aeddf4889024fc72c68659b25fd29e190cf62` |
| Native release binary | `babeed68a7732f96fa6bcd69ac3a9e4124bcfab5340ce0fbab61363b8b1a148f` |
| Namespace helper | `84bc4ab892cfe18a905a9dfcae9cd5a8206c054ae114af58feb73d63a7931df9` |
| Provider bundle | `02bf0e81e432a00b3fa4a1bebea9be78d06decdaa1a7406974896952913418c7` |
| Clean-boot evidence | `24d67d6e46522d8ff105b6e3854c9910858450b23ab8da1064655074f884dad5` |
| Packaged containment evidence | `775de230806cd5d37c13d135782d368b63f87337861848c680982d418f5c48ee` |
| Signed provenance envelope | `ef1119e003b435c102d864e23c1752e1ef3ef992e8e41f40dfb81a305d19c452` |
| Existing public key (PEM bytes) | `b62d24b8335468ef39cd7e16a50beb9d5ddab7343c4e5695273cd0a8d8bb1039` |

The image remains under the descriptive alias
`qorpera-runner-ubuntu-26.04-v48-unsigned` in LXD's `default` project. The
alias/properties are not authority: the separately verified signed envelope
binds the exact fingerprint. Signing used the existing encrypted off-node
Ed25519 key and its Keychain passphrase through stdin. No private signing
material was copied to the node. Both off-node and on-node signature checks
passed; a mismatched fingerprint was rejected.

Signed public material, provider bundle and evidence are staged at
`/home/company41-admin/step2-lxd/acceptance-v48-signed`. The full guest package
is at `/home/company41-admin/step2-lxd/lxd-runner-guest-v48`. Neither path is
the installed production provider, and no production service was replaced.

## Cloud acceptance completed

A fresh instance of the exact image proved KVM and UEFI Secure Boot, matching
binary/helper hashes and root-owned read-only installation. Without a job,
all native and runner services remained inactive; there was no identity or
recovery volume, company mount, bootstrap credential or registry credential.

After preserving clean-boot evidence, a synthetic containment probe ran in
that disposable instance under the actual `qorpera-native-company` account.
Its 28 security/resource settings were compared with the packaged host unit.
Test entrypoint, scratch, credentials and lifecycle settings were isolated
from the production service.
The packaged native binary and helper were not replaced. The probe passed:

- host file, process, environment and systemd credential isolation;
- empty capabilities, no-new-privileges, nested namespace denial and read-only
  system files;
- denied direct loopback, private-network, metadata and arbitrary proxy access;
- exact private result fencing and denial after synthetic authority revocation;
- auth-only refresh, certificate-validated encrypted provider TLS, kernel
  memory/process/CPU limits, and detached-descendant termination.

The TLS probe received an unauthenticated HTTP 403. It did not invoke GPT.
This is packaged-containment evidence, not a real-provider turn.
The earlier 753 focused tests, seven SQL suites after 84 migrations, recovery
and quota probes remain recorded in [the resumed audit](RUNTIME-STEP-2-RESUMED.md).
All three guest/runner/provider packaging tests passed on Linux and macOS;
`npm run check` passed without diagnostics after the installer correction.

## Next gates and authority

The managed cloud project was inspected read-only: PostgreSQL 17.6, 92 recorded
application migrations and Storage migration 64. `storage.objects.user_metadata`
exists; the new governed gateway is not installed. The installed history is
not identical to the disposable fixture. The next test must use the real
managed Storage preflight/final-transaction path and the current cloud schema,
not infer compatibility from a column check or overwrite production history.

The user completed the authorized Pro upgrade. The temporary data-free branch
`step2-fences-v48-20260828` has branch ID
`6051d2d8-f1de-4d04-ac0e-f1f9e8c3314d` and project
`hurfdoempkqpzxggemhc`. It is not the default or a persistent branch and will
be deleted after acceptance. The automatic parent `main` metadata remains
untouched. The preview is billable independently of the spend cap.

Automatic schema replay stopped because the preview lacked `pg_cron`. After
confirming it contained no company/user data or configured vault secrets,
`pg_cron` was enabled there and the missing historical migrations plus Step 2
040 through 130 were applied. The actual preview has 102 migrations, including
all eighteen managed-only company-computer/mobile migrations. Its earlier
branch-workflow failure is not represented as a successful automatic replay.
No production migration or provider call was performed.

The isolated cloud NAS gateway uses preview-only credentials and a private
task-owned NAS directory and recovery journal. Read delegation remains off.
Actual Auth users proved tenant denial, exact immutable upload/read, corrupt
body rejection and a byte-identical managed Storage replica. The real Storage
preflight/final-transaction race also passed: a temporary observer paused an
upload at final metadata, cleanup acquired its fence, and the write was
rejected. Authorized cleanup removed both copies and the catalog; a late
retry could not resurrect them. The observer trigger/schema and advisory lock
were removed. No Storage deletion-protection guard was disabled.

Managed SQL suites 165, 280, 295 and 296 passed. The unchanged 160 suite passed
through regular `psql` with `verify-full` TLS and the published Supabase CA.
Sending that whole fixture as one management-API statement gives its queued
requests identical statement timestamps and invalidates its ordering
assumption; this was not a runtime-authority failure. Whole-suite managed 270
and 290 runs remain unclaimed because their direct `storage.objects` deletion
fixtures meet managed Storage's deletion guard. The live API race above
independently covers the required installed-Storage fence.

## Cloud-native login and first admitted turn

The preview-only gateway, signed provider, project-scoped LXD transport and
orchestrator were deployed in `qorpera-step2-v48`. Temporary authenticated test
tunnels connect the preview Edge functions to the isolated node services; no
production DNS or service was changed. The governed Company File was uploaded,
read back, closure-verified, published and enrolled through the actual cloud
interfaces. There is no canonical Company File mount in the native harness.

The user approved a fresh official GPT device login. Login
`4d1e9797-38b1-467a-b0ff-8933a74ea8e2` completed for test Compute Identity
`5de7774d-6beb-4bd8-af4f-0019edbed3e5`; its login VM stopped afterward.
The production credential capsule was not used or exported. The real human
turn `32e912a2-68eb-459d-95e3-77f9896eee58` was admitted through
`qorpera_request_session_turn_v2` and the ordinary orchestrator. Its VM accepted
the assignment, but the turn failed before native model-start admission and
produced no public sends.

Investigation independently reproduced a layout mismatch: the adapter's scratch was a direct
child of `/tmp`, while the containment validator requires a deeper private
directory. The source fix adds a `runtime/` child beneath the unique allocation;
the validator and all isolation policies remain unchanged. An actual-cloud
before/after probe reproduced the old rejection and reached verified native
configuration with the fix, deliberately stopping before model admission.
It used no provider credentials and did not replace the installed native
binary or namespace helper. This is startup evidence, not GPT acceptance.

The new regression failed before the fix; 57 focused adapter/run/runtime tests
and the full code check then passed. The authorized Step 2-only source commit
and signed v49 replacement were completed. The fix is not in the signed v48
image; both candidates and their historical verification remain intact.
Restaging does not authorize a push, release or production change.

Thirteen additional live human-file cases passed using the actual client
transport: seven read/list cases and six mutation/authority cases. These cover
shared/private/outsider access, lost-acknowledgement recovery to the original
command, unchanged replay, changed-content refusal, protected-edit dismissal
without approval, and revocation between object retrieval and final return.
The cloud owns each mutation; no desktop model or canonical checkout is used.

## Signed v49 and auth-capsule startup correction

The scratch correction is commit `4504d8b081efa09cdfc97b69571db5bd55d7d3a5`;
its installer/manifest pins are `5de32dca3fceb032cf278ad85146808da5732582`.
It was rebuilt from clean source on Linux and passed all three packaging tests,
57 focused tests and `npm run check` on both platforms. A fresh image passed
KVM/Secure Boot, clean boot, containment and the pre-model startup probe.

| V49 binding | SHA-256 |
| --- | --- |
| Clean runtime source archive | `1bed10039fa514489920bb2cadc8b9e1392e4f0636e5f9635dedd72d7e47b295` |
| Guest package manifest | `64cd51e07365da3d47e3fa677ed20018addd98b88a69fd842fa9318997b70f41` |
| Native host bundle | `8dca80327c75ddcaac9e1b819f116bc5f08e8bde430b0cb1ed4d93b63b4fc3e6` |
| LXD image | `5021078377d965041cc9c742d14195b12ffb1650b61154ee05642b627673ba82` |
| Clean-boot evidence | `9e84b6a480b99aa33bcb9da9414cf329b8e5487d07fce21058c7e88339420f4a` |
| Combined signing evidence | `2e85669b8adca019c0c70a013390c386fa02508d82e18728dafa8b504560c963` |
| Signed provenance envelope | `b2a1c6016424ca299077083e6322232e32eb360b03231f2b920dd37ff8de9490` |

Signing used the existing off-node encrypted key. Both signature checks and
the wrong-fingerprint rejection passed. Native Codex, helper, provider and
nested OCI bytes are unchanged. Public signed material is staged at
`/home/company41-admin/step2-lxd/acceptance-v49-signed`; prior provider state
and v48 artifacts remain preserved.

Canonical human run `be07fb2f-0cb7-47c0-abef-2633e70829bd` was admitted through
the ordinary preview flow and assigned to that exact image. It failed before
the native model-start event and emitted zero public sends. The orchestrator
was paused, and no automatic retry or authority repair was performed.
After diagnosis, the exact failed VM was stopped without force. Its worker
was already inactive; encrypted identity and recovery volumes are retained.

Inside the test identity VM, a read-only, metadata-only capsule check found
`auth.json` plus two non-auth Codex files. No credential bytes were exported,
no capsule was overwritten, and no provider was invoked. Source regressions
then reproduced the strict runtime's `auth-only identity` rejection.
The correction restricts new Codex login capsules to `codex/auth.json` and
restores only that required path for governed execution, while validating the
entire archive. Duplicates, missing auth, unsafe paths/modes and path collisions
still fail; incidental configuration never enters the native mount. Refresh
and current-authority requirements are unchanged.

The correction passed 92 focused tests on macOS and cloud Linux. A synthetic
before/after probe under the actual cloud service containment confirms the
fixed host reaches verified configuration and stops before model admission.
The Linux package changes only the host bundle, to
`05ec1dac29ceee2400628e3636ce01fdc04c2302df579cdc5c1ff971630af8c4`
(230,291 bytes). The v50 manifest is
`f5dc9747e6aac5db7f9f9e6f8a4f9c797c8dd0b84c54c887b4971fe79823f319`.
The earlier manifest check correctly rejected the stale v49 host pin; the
recipe and package pins name those replacement bytes. The user-approved fix
and pins were committed as `a20dd1ef0dbdcce31166789053b2d7bb5ab2a929` and
restaged as signed v50, without push, release or production changes.

## Signed v50 and successful-void-response correction

The clean v50 source was rebuilt on cloud Linux, passing 92 focused tests,
all three packaging tests and the full check. The exact resulting image
passed clean boot, KVM/Secure Boot, the 28-setting containment comparison and
both pre-model startup probes. The auth-only probe used synthetic credentials.
Off-node/on-node signature checks and wrong-fingerprint rejection passed.

| V50 binding | SHA-256 |
| --- | --- |
| Clean source archive | `fa1adcf05ad817daf514edb38d0031687717fbcf9004e45a9ab2e686f53a3be1` |
| Guest package manifest | `f5dc9747e6aac5db7f9f9e6f8a4f9c797c8dd0b84c54c887b4971fe79823f319` |
| Native host bundle | `05ec1dac29ceee2400628e3636ce01fdc04c2302df579cdc5c1ff971630af8c4` |
| LXD image | `a0cbbb527c7c8c2dc24cd9f3350caa6215ab1fb5b7cdc05ab5b93582336a5bac` |
| Clean-boot evidence | `18bf7935e73e51b89c430c4649c8a9c56d803e0347996a0791852ef6cca9462b` |
| Combined signing evidence | `96af6060bbef293bf8a0fdbc2e50741bc2fac67feb8d1b85989f40fc99e6aecc` |
| Signed provenance envelope | `06d84b0e22d56589dfcbed3867f8d24f106e23091224c3686c9fdb92d8eb2a19` |

Public signed material is staged at
`/home/company41-admin/step2-lxd/acceptance-v50-signed`. Its signature binds
the immutable fingerprint, not the descriptive `v50-unsigned` alias.
Native Codex, helper, provider and nested OCI bytes remain unchanged.

After network recovery, the expired preview-only tunnel endpoints were
replaced and verified over certificate-checked HTTPS from the cloud VM.
V50 was activated only in the preview. Fresh canonical human run
`5e03dc98-87d0-483d-a8ff-9af2f5c6bd6e` was assigned to that exact image and
failed before durable native model admission, with zero public sends. The
orchestrator was paused; the terminal VM was stopped without force or retry.
Its identity/recovery volumes and all earlier signed images remain preserved.

The managed API trace shows successful context and authority responses,
followed by HTTP 204 from `qorpera_assert_company_path_reads`. The client
wrongly parsed this void success as JSON and raised an authority error. The
trace does not prove earlier generic bridge failures reached either separately
reproduced scratch/auth defect.

The uncommitted fix accepts no-body 204 only for that RPC and the other void
RPC, `qorpera_verify_company_path_file`. Missing values on admission/read/
receipt/commit RPCs, other empty statuses, denials and aborted requests still
fail closed. Three new cases failed before the change, including a full
synthetic runtime/mouth path using the HTTP adapter. The fixed source passed
210 focused tests, all three packaging tests and `npm run check` on both
macOS and cloud Linux. The patched adapter also
passed actual managed 204 success and 400 rejection; only an existing
synthetic object's verification metadata was refreshed, with the canonical
head unchanged. No model or execution-admission call was made by that probe.

The proposed v51 package changes only the host bundle to
`449fd0341912a3034439d63611d1b633af95e53690a418cd60641515a89490ab`
(230,492 bytes), manifest
`6143706cb0e80cc808694b7ba7f85bdc66c49eb08ceb1dfbd35ad7a63507ba24`.
No v51 image has been built or signed. Its additional source commit and
signed test-image restaging require authorization; no further GPT run is
claimed. After those gates, repeat clean boot/containment/startup and admit
a new turn for GPT injection, revocation, lost-acknowledgement and recovery
acceptance with clients closed. Do not retry a failed canonical job ID.

Before production enrollment, the NAS/workbench reconciliation, shared-computer
path enforcement and authorized replacement-node identity recovery must also
be verified. The retained synthetic outcome-volume backup does not prove
recovery of a real Compute Identity master key or restore execution authority.
Those production gates were not waived by signing the candidate.

Evidence, source archives and synthetic recovery backups are retained under
the workspace's `.artifacts/runtime-step-separation-20260828/step2` directory.
The synthetic build, clean-boot and containment machines are disposable;
the immutable signed candidate and its source remain preserved. No later-step
handoff is an instruction to start Step 3.
