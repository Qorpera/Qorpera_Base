# Step 2: signed v52 native tools and cloud recovery

Date: 2026-08-28. **The native tool-inventory and combined real-GPT
write/lost-acknowledgement/VM-restart gates passed. Step 2 is not yet complete.**
Shared-computer path enforcement, packaged/released-client acceptance and the
production NAS/replacement-node gates remain. Step 3 stays paused.

Later checkpoint: the [packaged-client/interlock record](RUNTIME-STEP-2-CLIENT-ACCEPTANCE.md)
adds real preview UI acceptance and blocks unsafe legacy-computer cutover.
It does not rewrite this native checkpoint or close desktop mediation,
off-node identity recovery, or production release gates.

## Scope and source

The user authorized the narrow governed direct-tools extension, scoped commits,
replacement-image signing and isolated preview acceptance. No push, tag,
application release, production enrollment, credential export or autonomous
consent change occurred. Existing failed and completed jobs were not rerun.

The active Step 2-only branch is `codex/runtime-step2-fenced-cloud`, in
`/tmp/qorpera-step2-resume.rN3rbf/source`. The fix is commit
`a8c068859a2f6583b0c55fdcdd692462444a7d5d`; final candidate pins and the
Linux proof are `b2b7215a660807dfbcde628cdfeca6b4d2423489`.
The preserved Step 3 files were not imported or edited.

Codex 0.147.0 remains pinned to upstream
`be6e8eac029b183056b7e4402879f15d2c85f61b`, using Rust 1.95.0. Direct tools
are selected only in the host-fenced process. Ordinary sessions retain upstream
selection; invalid sockets still fail the unchanged pre-request handshake.
The host requires both `qorpera.native-result-fence/v1` and
`qorpera.native-direct-tools/v1` before model admission. Authentication,
provider transport, model catalog, credential custody and result-fence schema
are unchanged.

## Exact candidate

| Binding | SHA-256 |
| --- | --- |
| Downstream patch | `2ee0b5ef1485c7715dcf6d2d0be9ae24a2fb7e7e7f8c5a47f18becc4064b1bbc` |
| Linux executable | `2f2c26cfdfacebbcce848fb50cfaaa4e8d0aa3c6ec3c1009123ecf766c8335f7` |
| Native artifact archive | `a3bcb7eb698573683e2bd02ff9dc32d78bb1d5acbbd6aaaf14f90d4891a5651b` |
| Guest manifest | `873ceaf8a51b4028f77a901d5e5a1320a536dec09c5b2f5b96cee98d50444193` |
| Native host bundle | `5fc5a234113dd2243ae418414d4732cfb3e1013a688d327d07ce59de5585a896` |
| Signed LXD image | `f3f763287ee3fe7ba3e31926be8341b2e1567e35283e129f673edb4d5a75d67a` |
| Signed provenance | `d5bf211f0244290515ffd13eb67581245c8ed767775c54f17ee7e8fb4af22cd8` |

The executable is 307,161,584 bytes. The namespace helper, provider bundle and
nested OCI bytes are unchanged. The separately signed fingerprint, not the
`v52-unsigned` alias, is authority. Off-node/on-node signature verification
passed, and a wrong fingerprint was rejected. No private signing key left the
existing off-node signer. Public signed material is retained at
`/home/company41-admin/step2-lxd/acceptance-v52-signed`, with the full guest
package at `/home/company41-admin/step2-lxd/lxd-runner-guest-v52`.

## Component and packaged verification

- Six targeted native Rust tests and upstream formatting passed.
- 251 focused shell tests in fourteen files passed on macOS and cloud Linux,
  including actual-native and existing mouth regressions.
- Three packaging tests passed on both platforms; eight native/build-artifact
  tests passed on macOS. The full `npm run check` passed without diagnostics.
- The Linux loopback proof advertises only registered Qorpera tools for the
  bundled default model. All 22 forced bypasses were denied and all 31 results
  fenced, with no unbrokered request or unfenced result.
- Revoked/stalled authority and all twelve compaction cases passed across
  synthetic and provider-default metadata.
- The final clean Linux rebuild exactly matched the committed manifest.
  Clean boot, KVM/Secure Boot, credential-free startup, the 28-setting service
  containment comparison and both pre-model startup probes passed.

The [immutable component proof](native-codex/linux-x64-direct-tools-proof.json)
retains its build-time synthetic-only scope. Live acceptance below is separate
evidence, not a rewrite of that historical record.

## Real GPT and power-loss acceptance

The data-free preview is `hurfdoempkqpzxggemhc`, with LXD project
`qorpera-step2-v48`. Successful runs used the signed v52 image and
`openai/gpt-5.6-sol` through the existing cloud-owned native connection.
The requesting friend and sponsoring owner were distinct Auth users.
Unauthorized self-approval failed; ordinary explicit owner approval admitted
each new request.

The clean automated run is **`2b966b99-1991-4db6-93b2-88911b039932`**.
GPT read the brief/current answer, changed only `docs/answer.txt`, and sent
progress and final messages. A preview-only fault returned HTTP 503 after the
unchanged completion transaction committed. The worker's private pending
completion was observed on its separate persistent recovery volume, then the
exact test VM was forcibly stopped. After acknowledgements were restored, the
same VM booted with a different boot ID and replayed the original completion.

The receipt, finish time and counts stayed unchanged: **one model admission,
one file revision, one progress send and one final send**. The receipt digest is
`19249876c969a886afa63d2651a6327803163602649a9643ed7e1501217f8347`.
Pending completion cleared, with no active lease or quarantined recovery.
No unbound public message, proposal or unresolved operation remained.
Other paths were unchanged; owner/friend independently read the same new file
version through the actual cloud transport. Controlled injection markers and
the private canary were absent from the answer and canonical messages. This
is not general injection immunity or released-client UI acceptance. No local
canonical company checkout was used.

Run `d18eafb5-3abc-46b0-bd78-3284e351376c` also wrote successfully and replayed
its receipt after VM restart. Its automated observer timed out because the
test-only diagnostic script was not synced and returned as an empty file.
That file was preserved. A new hash-verified read-only witness confirmed the
cleared recovery record; the cloud observer had recorded replay within the
retained lease. This supplemental proof is not an automated pass. The test was
corrected to sync its witness on the root disk, not the separate runtime
recovery volume, and the new run above passed automatically. Neither job reran.

Two earlier staging attempts are retained as negative evidence, not model
failures: `2d251fcc-d1b1-409d-a328-2402d1c975e2` was refused because the
preview retained the old binary pin; `5ee2a99d-cf06-49b3-8fd3-ac8becf04fbb`
was refused because its provider journal was bound to the old configuration.
Both were cancelled through the requester RPC after verifying zero native
admissions, sends and revisions. The corrected configuration uses the new
pin and fresh `provider-runs-v52-corrected`/`provider-logins-v52-corrected`
directories. Old private configurations and journals remain preserved.

## Cleanup and remaining gates

Every temporary Edge fault was removed. The original function was downloaded
and verified byte-for-byte; observer function/table/schema objects were removed
without cascade. The preview orchestrator is paused and terminal test VMs are
stopped, with identity/recovery volumes preserved. Production is unchanged.
The managed preview remains billable while retained for the remaining gates.

Evidence, commands, source patches and the native artifact are retained under
the workspace's `.artifacts/runtime-step-separation-20260828/step2/verification`.
Private API keys, actor tokens, credentials, capsules, private logs and signing
keys are excluded. Distinct skill count remains 7/10.

Remaining: **shared-computer path/raw-object enforcement and packaged/released
client verification**. Before production enrollment, recheck/reconcile the two
missing NAS memory files without losing live state, and verify authorized
replacement-node identity recovery/fencing. Same-node volume import and VM
restart are not replacement-node recovery. Preview approval does not authorize
release or production cutover. Step 3 wake/room/hire/consent work remains paused.
