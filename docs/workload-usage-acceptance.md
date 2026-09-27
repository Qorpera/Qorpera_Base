# Physical workload accounting acceptance

The disposable `office-physical-acceptance.yml` workload job joins actual Linux/LXD VM clocks and the production paid controller/guard to a fresh native PostgreSQL database containing every migration. It runs cases sequentially against one built image, with a separate database and owned guard state for each case. It never substitutes containers or mocked physical observations when KVM is unavailable.

The financial setup uses explicitly synthetic invoice proofs passed through the real privileged funding kernels. These are test entitlements, not evidence of a new Stripe payment. Source agents, repositories and model accounts are fixtures. The separate Stripe acceptance evidence establishes payment integration; it must not be inferred from these VM tests.

Run only this matrix, without duplicating an ongoing office lifecycle or full regression run:

```sh
gh workflow run step2-lxd.yml --ref <reviewed-branch> -f office_physical_acceptance=true -f workloads_only=true
```

## Cases and assertions

| Case | Physical operation | Required financial result |
| --- | --- | --- |
| Native and coding, 1 CPU / 1 GiB | Actual idle intervals and bounded CPU, memory and disk activity | Exact cumulative elapsed time at 0.25 standard size |
| Native and coding, 1 CPU / 4 GiB | Same on the smaller acceptance host | Exact cumulative elapsed time at 0.5 standard size, dominated by memory |
| Native and coding, 2 CPU / 2 GiB | Same | Exact cumulative elapsed time at 0.5 standard size |
| Native and coding, 2 CPU / 8 GiB | Same | Exact cumulative elapsed time at 1 standard size, dominated by memory |
| Native and coding, 2 CPU / 10 GiB | Same | Exact cumulative elapsed time at 1.25 standard size, dominated by memory |
| Native and coding, 4 CPU / 8 GiB | Same at the actual standard computer size | Exact cumulative elapsed time at 1 standard size |
| Native and coding, 5 CPU / 2 GiB | Same above the CPU reference size | Exact cumulative elapsed time at 1.25 standard size, dominated by CPU |
| Login, each of those seven shapes | Actual guest clock advances before physical stop | No paid permit, reservation or debit |
| Native and coding, pooled renewal | Actual natural five-minute funding-window renewal; exact renewal replay; controller recreation and stop | Responsible member's remaining allowance drains first, then consenting fallback; exact aggregate debit and no remaining hold |
| Native and coding, Dedicated | Actual idle/busy intervals and stop | Same elapsed-time tariff, with allowance issued for the exact test invoice period |
| Coding, two concurrent claims | Two distinct public dispatches/leases, same planned machine, separate authorized storage identities, overlapping 10- and 18-second guest processes | One physical UUID, permit, metering stream and initial held amount; first claim completion cannot stop the second; final global debit counts machine time once |
| Native, physical shape mismatch | Real stopped VM has 256 MiB more memory than its admitted shape | Inventory refuses readiness, controller refuses before arming/start dispatch, retained prestart cancellation closes the hold with zero debit |

One standard computer is 4 CPU / 8 GiB. These cases cover the CPU- and memory-dominant branches and fractional, standard and greater-than-standard ratios. They are not an exhaustive enumeration of every configurable CPU/RAM pair. The GitHub host must retain its configured infrastructure headroom; the test must not silently lower that headroom to admit a larger guest.

The standalone runner records its observed CPU and memory capacity and preserves 500m CPU / 2 GiB infrastructure headroom. A 2 CPU / 8 GiB host can run the 1 CPU / 1 GiB and 1 CPU / 4 GiB cases; it cannot prove the larger requested shapes. Those cases require a larger disposable host and remain outstanding until their own evidence passes. Host admission size never changes the 4 CPU / 8 GiB billing reference.

## Operator-designated disposable hosts

The same runner accepts `--disposable-host /absolute/path/host.json` without GitHub environment variables. The operator must first explicitly designate an empty, disposable Linux x86-64/KVM host for these tests. The manifest establishes identity and source provenance; it does not authorize production cleanup or make an existing node disposable. The workload runner refuses unrelated LXD instances, projects, storage pools and custom volumes. It never installs packages, downloads an image, provisions a host or purchases capacity.

Prepare Node 24, systemd, LXD `6.9-ab8fad2` with the existing `default` pool and `lxdbr0` network, PostgreSQL 17 at `/usr/lib/postgresql/17/bin`, Python 3, Git and a reviewed agent-enabled VM image. Supply its existing `image-context.json` containing `imageFingerprint` and `bootstrapSha256`. Image preparation/trust remains a separate prerequisite; the preflight verifies the locally installed fingerprint rather than claiming a new image build. Use a clean checkout with reviewed dependencies already installed. A 4 CPU / 16 GiB host admits the outstanding 2 CPU / 2, 8 and 10 GiB shapes with the unchanged reserves. At least 6 observed CPUs and 16 GiB also cover the actual 4 CPU / 8 GiB standard machine and the CPU-dominant 5 CPU / 2 GiB case; the same host capacity accommodates the separate joined founding/native test.

For a fresh host without the reviewed image, the existing image acceptance supports the same explicit designation. Install the prerequisites above but leave LXD **uninitialized**, with no images, instances, storage pools or managed networks. Pin LXD snap revision `40424`. Create the same private root-owned manifest shown below with schema `qorpera.workload-image-host/v1` and omit `imageFingerprint` and `bootstrapSha256`; those outputs do not yet exist. Then run:

```sh
sudo node scripts/acceptance/office-image-prepare.mjs \
  --disposable-host /etc/qorpera-acceptance/image-host.json --preflight-only \
  --out /opt/acceptance-image
sudo node scripts/acceptance/office-image-prepare.mjs \
  --disposable-host /etc/qorpera-acceptance/image-host.json \
  --out /opt/acceptance-image
```

The second command initializes only the empty LXD host, downloads the Ubuntu base and pinned guest dependencies, and performs the existing full package measurements, Secure Boot/cold-boot checks, TLS trust proofs and signed-image verification. It deletes its two owned probe VMs and retains the accepted image. Only a successful build and cleanup publishes both `image-context.json` and a root-owned `workload-host.json` containing the measured output pins. Use `/opt/acceptance-image/workload-host.json` as `--disposable-host` for the workload commands below. The signing key remains explicitly an acceptance key, not a production release signature. No GitHub flags, bypassed image checks, host purchase or automatic production deployment are involved.

Create a root-owned mode `0600` manifest under root-controlled directories (for example `/etc/qorpera-acceptance/host.json`), with exactly these fields:

```json
{
  "schema": "qorpera.workload-usage-host/v1",
  "complete": true,
  "disposableHost": true,
  "hostMachineIdSha256": "SHA256 of the trimmed /etc/machine-id bytes",
  "hostBootId": "current /proc/sys/kernel/random/boot_id",
  "commit": "exact 40-character checkout HEAD",
  "imageFingerprint": "existing image's 64-character fingerprint",
  "bootstrapSha256": "existing image context's 64-character bootstrap digest"
}
```

Run the non-installing preflight first; it performs a real KVM capability probe and immediately closes that probe VM, but creates no LXD instance, account, service, database or result directory:

```sh
sudo node scripts/acceptance/workload-usage-physical.mjs \
  --disposable-host /etc/qorpera-acceptance/host.json --preflight-only \
  --kind native --cpus 2 --memory-gib 10 \
  --image-context /opt/acceptance-image/image-context.json --out /opt/acceptance-results/native-2-10
```

After successful preflight, omit `--preflight-only` to execute that case. Repeat with each `--kind native`, `coding` and `login`, using CPU/RAM pairs `(2,2)`, `(2,8)`, `(2,10)`, `(4,8)` and `(5,2)` and a distinct output directory for each case. Every case must pass its own capacity preflight. Stop on failure unless its persisted report explicitly confirms both `cleanup: true` and `hostCleanup: true`. Never remove a retained independent guard or journal to force the next case through. The root parent publishes an immutable host receipt for its unprivileged child, which rechecks physical host and boot identity. Reports distinguish `operator-designated-disposable` from `github-hosted` provenance. Existing GitHub mode and its environment checks are unchanged.

Coding physical cases also require `controller.assertRunning` before loading the offline guest exercise and record `confirmedRunningBeforeGuestWork`. This proves the controller gate against actual guard/SQL state, not complete executor workspace attachment or model/repository execution. The new explicit-host path requires its own successful physical run; unit-tested preflight logic is not larger-host billing evidence.

## Accounting and cleanup

The matrix continues after an individual assertion fails only when its report confirms both child VM/database cleanup and parent host-service cleanup (`cleanup: true`, `hostCleanup: true`). The job still fails if any case fails. Missing or uncertain cleanup stops the matrix; the independent guard, journal and service account remain available for recovery instead of being removed while a VM might still be running.

`workload-usage-evidence.mjs` independently computes cumulative normalized microseconds with integer arithmetic. It joins the actual successful controller samples to SQL observations, checkpoints, reservations, settlements, and per-bucket debits. It verifies exact sample predecessors, physical/boot identities, zero-charge uncertainty gaps, reservation draw order, replay deduplication, full hold closure, and equality between the observed bucket balance changes and the sum of actual settlements. The physical idle and busy intervals use the same pinned tariff. CPU utilization is not the billed unit.

Fresh paid cases require the independent guard producer. During a 20-second interval with no controller upload, the separate guard must retain at least three actual observations. On controller recovery, the SQL oracle requires those exact observations to cover at least fourteen seconds continuously and reports their allocated standard-time debit. Exact upload replay and sealed terminal acknowledgement precede final settlement. This is an assertion to be proved by the physical run, not a claim that controller recreation alone establishes outage coverage. The report explicitly retains the first observed guest boot age, the unmeasured interval before the first paired observation, the last running-to-terminal host margin, and observed elapsed time excluded from billing; none of those margins is filled with inferred usage.

In the pooled case only, an explicitly labeled operator fixture sets the responsible member's **starting** balance to one standard-computer second. That prior-consumption fixture is not claimed as historical physical usage. The subsequent VM observations, current-period debit, and fallback draw are real execution of the accounting path.

The shared case completes its synthetic source claims with a failed outcome explaining that no model or repository task ran. The workload completion markers attest only the bounded offline CPU/memory/disk exercises. There is no fabricated successful product task, pull request, model response, repository checkout, or NAS hot-plug evidence.

## Companion database evidence

- Test 667 exercises actual Dedicated funding for 28-, 29-, 30- and 31-day periods and an invoice period spanning a UTC-offset change. It verifies exact replay and overlap refusal, refuses use of a future paid bucket, crosses a real two-second wall-clock period boundary, closes the old authorized hold, and draws the next hold from the newly active period. Its checkpoints are explicitly SQL fixtures.
- Test 668 creates a real account-refresh request/allocation in paid mode, verifies `login_helper` classification and zero normalization even at double standard size, refuses relabeling as a sandbox, and refuses an allowance hold. It does not log into a provider or boot another VM.
- `allowance-concurrency.mjs` uses separate PostgreSQL processes and observes actual row-lock blocking through `pg_blocking_pids`. It covers competing 75% reservations across companies, both payment-fence/reservation orderings, settlement of already authorized holds after a fence, and a delayed paid event that cannot remove that fence. It is database concurrency evidence, not physical VM evidence.

## Evidence boundaries and status

As of the addition of this matrix, local PostgreSQL 17.11 acceptance passed tests 667 and 668 with all 432 migrations. A separate fresh-database preflight passed actual two-claim admission, shared planning, distinct guest UID authorization, completion and custody refusal/permission. The usage oracle's nine unit tests passed, including outage allocation and unmeasured margins. These local checks do not establish Linux physical acceptance.

Run `36270332908` did not prove VM accounting: its workload job stopped during node observation. The subsequent fix corrects the local RPC adapter's rejection of valid parameter names containing digits. Base run `36272593866` passed actual inventory, paid preparation and physical boot, then failed the first native 1 CPU / 1 GiB case at its first metering observation with `RUNTIME_COMPUTER_OBSERVATION_UNCONFIRMED`. No paid sample reached SQL. Diagnostic run `36274090728` at commit `085e21016` confirmed the clock-acquisition cause: both physical brackets reported Running/103, every procfs read retained root:root mode 0444, and the boot IDs agreed. The three separate public-clock reads took 351.7, 516.6 and 329.5 ms; the recorded physical bracket spanned 1,209.6 ms, exceeding the unchanged 1,000 ms acceptance budget. The combined boot/uptime/boot observation addresses those repeated transports while preserving that budget and all custody checks; its Linux validation remains pending. The newly added shared/mismatch cases also require successful physical evidence. A case is physically proven only when its uploaded evidence has `passed: true`, `cleanup: true`, the expected case options, and a successful usage reconciliation or explicit zero-charge exclusion/refusal result. A successful image-build job alone is insufficient.

Run `36275142558` at commit `f9a170b30` did reach an initial paid sample: the first combined clock read took 394.9 ms within a roughly 414.7 ms physical bracket. The next read took 1,988.6 ms, with a roughly 2,009.6 ms bracket, and was correctly rejected by the same one-second budget despite matching boot identity and Running/103 state. The combined transport fixes the repeated-call cost but does not make host latency deterministic. The independent producer now retains explicit uncertainty and is being validated separately; this failed run is not a matrix pass.

The separate office runner owns full guest/provider/SQL lifecycle evidence. Ordinary power-off, sleeping balance, resume, service restart and root reset must be verified there; native/coding controller recreation cannot substitute for those operations. The shared coding case does not exercise the complete coding executor, model harness, repository workflow or real session-volume attachment. Paid shared-systemd/process execution remains explicitly unsupported and refused; an LXD pass must not be advertised as proof for an enabled process backend.

Run `36279192718` at `dde790fe8bb6e409c6966765d603542ef1a1112b` passed all twelve small-host physical cases. Independent replay of the retained evidence reconciled exactly **235,837,500 standard-computer microseconds** across nine paid permits, all closed with zero remaining global reserved balances. Native/coding 1 CPU / 1 GiB and 1 CPU / 4 GiB, pooled natural renewal, Dedicated, two overlapping coding claims, zero-charge login helpers and physical shape mismatch refusal passed. The shared claims overlapped for 10.308 seconds on one VM and one permit; completing the first preserved the second. This proves the small-host matrix only; the larger shapes above remain outstanding.

Those nine paid cases had no uncertainty-gap intervals after the first running observation. They still excluded startup and terminal observation margins: the first observed guest boot age was 11.44–13.60 seconds, the last running-to-terminal margin was 0.49–1.56 seconds, and total observed uncharged elapsed time was 21.56–24.14 seconds. Continuous clock pairing retains up to one second of uncertainty per segment and cannot resolve subsecond suspension. Exact agreement with the accepted observations does not establish perfect coverage of the complete powered-on interval. These exclusions must remain visible when evaluating billing accuracy.

The complete excluded host interval splits into 20.26–22.58 seconds before the first paired running observation and the terminal margin above; part of that initial interval precedes the guest kernel's uptime origin. The evidence cannot separate firmware, guest readiness and capture latency, or distinguish last-sample-to-stop-request time from the physical stop operation. All exercised CPU/memory/disk work began at least 11.02 seconds after the first pair and ended at least 26.03 seconds before the last pair, wholly inside the reconciled interval. Missing endpoint measurements remain uncharged.

Legacy holds without retained start authority, skipped-generation reconciliation, archive disk-failure/restart behavior and accounting-health alarms have separate recovery/operational checks. Retaining an unresolved hold is safe financial custody, but it is not successful reconciliation. Acceptance must report those outcomes explicitly rather than silently treating them as closed.
