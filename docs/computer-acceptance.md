# Paid computer acceptance

The manual `Step 2 LXD contracts` workflow has a `real_lxd_acceptance` input. Its default is false; ordinary pull-request runs remain contract tests. Select true to exercise the production guard on a disposable GitHub-hosted Ubuntu host with systemd and an actual nested-KVM LXD VM.

```sh
gh workflow run step2-lxd.yml --ref <reviewed-branch> -f real_lxd_acceptance=true
```

The job checks actual KVM VM creation, installs the reviewed LXD revision, and refuses an initialized LXD host or existing instances. The harness creates one temporary Ubuntu VM and uses the production systemd guard unit with its executable path redirected to the candidate bundle. It starts the VM, kills the guard process, checks automatic restart with the original deadline, replays the original arm request, then leaves the guard to stop the physical VM without a provider or renewal process.

The second phase starts the VM with a fresh permit and routes the production guard's LXD connection through a transparent Unix proxy. It withholds responses around the scheduled stop, checks that guard IPC and systemd remain responsive, and independently confirms that the VM is still running with no false stop receipt. Restoring transport must allow a confirmed physical stop before the original deadline. This bounded fault does not prove enforcement during indefinite LXD unavailability.

The uploaded `evidence.json` records the source commit, image fingerprint, guard bundle and unit hashes, physical start operation, restart observations, deadline and actual stop receipts. A pass requires independent LXD confirmation and stop receipts before the paid deadlines. The harness removes its VM on exit; the disposable runner is the final cleanup boundary.

This uses synthetic control-plane permits. It proves the physical guard boundary, not SQL funding, Stripe accounting, full office recovery or deployed host/image parity. GitHub-hosted nested virtualization is experimental; a missing capability fails the job instead of substituting containers or mocks. Disk exhaustion, archive restart latency and the complete office guest/provider/SQL path need separate physical acceptance.

Stripe acceptance must use a test key and a separate database. Evidence must distinguish genuine Stripe canonical objects replayed with local signatures from actual Stripe-to-endpoint webhook delivery. Hosted Checkout creation is not payment completion. A paid invoice and its exact replay must fund one period only; renewals, failed payments and cross-company pooling need their own assertions. Production offer and accounting flags stay disabled until the complete rollout gates pass.

## Docker-free joined acceptance

The separate manual `Docker-free office acceptance` workflow runs five isolated jobs without invoking Docker: the full Linux regression suite, guard storage recovery, real Auth/browser company creation, paid office lifecycle, and physical workload accounting:

```sh
gh workflow run office-physical-acceptance.yml --ref <reviewed-branch>
```

Before that workflow reaches the default branch, dispatch it through the existing workflow's reusable-job entry:

```sh
gh workflow run step2-lxd.yml --ref <reviewed-branch> -f office_physical_acceptance=true
```

It starts PostgreSQL 17 as an unprivileged owned process with a fresh private data directory and Unix socket, applies every migration, and runs every SQL regression. No existing database is attached. The PostgreSQL listener has no TCP address; the harness stops its own process before deleting its own temporary cluster.

The guard storage job exhausts a separate ext4 filesystem while a real LXD VM has an active permit. It exercises physical deadline enforcement without writable receipt storage, interrupted archive-tail repair and restart with 4,161 archived records. It requires independent physical stop confirmation, recovery of durable receipts after space is released, and cleanup of the VM and mount. Its control-plane permits are synthetic; SQL settlement is covered by the joined lifecycle jobs.

The office storage stage mounts a loopback NFSv4 export and a separate ext4 journal, then runs the production open-descriptor mount checks against actual Linux mount metadata. It preserves root squashing and checks workbench access as its owner. This proves the local protocol and mount boundary, not remote NAS durability or guest workbench custody.

The guest stage builds and installs the actual office package inside an LXD VM, measures the installed dependencies and performs real systemd/boot-credential checks. It verifies Secure Boot, effective guest HTTPS certificate trust and signed image provenance. Successful image preparation is only a prerequisite; it does not establish successful paid admission or usage reconciliation.

The joined office lifecycle uses a separate, dedicated loopback export preserving numeric user identities and trusted host root access. The real comparison in [coding storage acceptance](coding-storage-acceptance.md) showed that root-squashed NFS refuses the unchanged guest helpers and session writes; the identity-preserving control passed. This corrects an incompatible test export, not the runtime's ownership checks. It does not establish production NAS safety: deployed exports must be restricted to trusted hypervisors, preserve distinct session owners, and block direct guest access to NAS/RPC before NAT. Neither the historical map-all-to-admin deployment nor mount metadata alone proves those conditions.

The office lifecycle then connects the actual provider, guest, independent guard and SQL control plane. Acceptance must show a paid start, measured usage, provider outage, independent physical deadline stop, retained-workbench recovery and final settlement. The ordinary lifecycle cases additionally cover power-off, an unchanged balance while stopped, same-machine resume, service restart and root replacement with retained workbench data. Every claimed operation needs its own successful physical evidence; a timeout or fixture-setup error is a failed case.

The browser job runs the production web entry, actual Supabase Auth with email OTP, PostgREST and native PostgreSQL in separate member browser contexts. It checks invitations and joining, setup-revision agreement, separate contribution consent, noncreator launch, retry deduplication, immutable shared vision and solo creation. Its invoice and model-account setup are labeled fixtures. It does not establish external provider OAuth, hosted Stripe Checkout completion or model execution.

The workload job covers native and coding LXD machines, exempt login helpers, CPU- and memory-dominant normalization, idle/busy time, natural renewal, pooled fallback, Dedicated plans, concurrent coding claims and rejected resource-shape drift. See the [workload matrix and evidence boundaries](workload-usage-acceptance.md). Every case uses a new database and owned guard state, with exact integer reconciliation of physical samples against reservations, settlements and global balances.

The database stages also exercise real concurrent row-lock ordering and the restricted [accounting health checker](computer-accounting-health.md). The checker must detect an unresolved hold without mutating it, distinguish refund-related funding shortfalls from ledger corruption, and clear after a trusted settlement. Local checker success does not prove delivery through a deployment's alert collector.

Review the uploaded `evidence.json` files against the run's exact commit. Require `passed: true`, successful owned-resource cleanup and the expected options for each case. Raw credentials, signing material, access tokens and private service logs are not uploaded. Retain failed reports rather than rewriting them as passed after a later correction. A green SQL or image stage must never substitute for a missing browser or physical lifecycle result.

See [computer billing setup](computer-billing-setup.md) for the agreed plans, authority boundaries and remaining launch gates.

Run `36284793096` at `9c346704f` passed actual paid VM boot and preparation with the identity-preserving fixture export. It then failed before service configuration because the fixture supplied 48-byte bearer tokens where the closed material contract requires 32 bytes. The fixture now generates the required format, with a regression against the production parser; production credential validation is unchanged. This run does not establish service activation or lifecycle completion.

Run `36286123436` at `30f118add` completed the protected guest configuration command, then exhausted the host configuration reconciliation deadline before publishing completion. Its failed report retains physical and accounting custody. Bounded phase/call-count/timing diagnostics now distinguish the blocked boundary without exposing credentials or changing the 30-second reconciliation and five-second authority deadlines. A successful guest command alone does not establish host acknowledgement or office activation.

Full Linux run `36285673891` at `8cd5d7093` found seven failures sharing an outdated outage fixture that omitted canonical `workReady`. The corrected fixture derives readiness from its accepted running sample and matching bound permit; two negative regressions still reject false or absent readiness while the guarded VM is running. All 71 focused controller/outage tests pass, but the complete merged-source Linux rerun must pass independently.

Run `36287333010` at `d80df2206` completed guest configuration and host acknowledgement within the unchanged deadline, then observed the main office service exit with status 1. Preparation and the physical VM remained running; service activation and final cleanup did not pass. The next harness retains bounded, identity-checked guest failure records through the production diagnostic whitelist, without uploading raw journals or credentials.

Full Linux run `36287439241` at `403daf29e` passed all 4,245 runner-orchestrator tests. One runtime composition test exceeded its one-second child-startup wait and left an unsettled child result. The fixture now waits for the actual child handshake within five seconds and always cancels and settles its child. All 105 tests in that file pass locally; a fresh full Linux pass is still required.

Run `36288464116` at `4a2a55cd6` retained the guest's closed `OFFICE_REGISTRY_UNCONFIRMED` startup failure. The acceptance TLS server required a bearer header even though the production registry correctly sends opaque Supabase keys as `apikey` alone. The fixture now authenticates the exact configured key, accepts only a matching bearer when supplied, and rejects missing, conflicting and duplicate credentials. A real production registry client over verified TLS and all 11 server tests pass. Production authentication is unchanged; the full office lifecycle still requires a physical rerun.
