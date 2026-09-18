# Steps 0–4 local integration audit

Local implementation and verification are complete for the enabled candidate.
Production acceptance is not complete. This audit does not authorize release,
signing, deployment, migration execution or opening production admission.

Candidate: `/Users/jonas/work/Qorpera_Base-step3`, branch
`fable/runtime-step3-wake-bus`, base commit
`6286ac52c60444bed3f42757557d316426bbf0b8` with the intentional uncommitted
candidate. Runtime source bundle:
`e3caea07522ccaa1f602f9e6a02c1378389e4e1f6b10c79f571a0059a734a1e4`.
The reusable Step 4 source checkout remains at
`cb07a0269aa533c1f1511022ae98df4615933871`; its office components were integrated
with the current authority implementation, not used to replace it with an
older runtime.

## Requirement and evidence map

| Requirement | Current evidence and boundary |
| --- | --- |
| Clear headless architecture | The runtime owns native execution, company tools, office service and supervision. `cloud-client` owns shared APIs; desktop and `member-web` own interaction/display. Actual source and bundle checks cover 147 runtime sources, 268 runtime inputs, 72 browser SDK inputs and 78 web inputs. Runtime excludes Electron/desktop implementation; web excludes runtime, infrastructure, Node adapters and external imports. |
| Step 0: live Company File, scope and atomic versions | Current path-gateway/control tests pass. After all 205 migrations, the actual SQL concurrency driver passes simultaneous writers, stale-version refusal, atomic rollback after connection death and lost-response replay without another effect. The combined office proof publishes through the same mutation gateway and imports exact live versions. Historical two-member/agent ACL and attribution evidence remains in the Steps 0–3 ledger with its original versions. |
| Step 1: native loop, tool boundary and mouth | Current native authority, operations, boundary, run-tool-session, company-context/runner/runtime and wake tests pass. Actual SQL context for company and member-private admissions reaches the production parsers and prompt composer. Wake integration checks acknowledgement/send rules, final-send closure, silence, durable completion and handoff. No new paid model call is claimed; historical live model/handoff evidence keeps its original bundle identity. |
| Step 2: inbound/effect fences and secret custody | Current boundary tests cover untrusted nested results, closed namespaces, errors, cancellation, replay and revocation before queued work or result release. After all 205 migrations, secret-custody SQL passes both fresh setup and the service-role upgrade fixture. Historical canary capture/use, rotation, reflection, revocation, restart, encrypted recovery and scoped nonexposure evidence remains separately bounded by the Steps 0–3 ledger. |
| Step 3: five wake kinds and silence | Actual SQL materializers feed the same staff identity through human, first-run, routine, agent and room contexts into production parsers, exact bundle checks and prompts. Component/forward-upgrade/concurrency/restart checks and all 25 integration cases pass on the current migration set, including silent completion, File causality, founder stop, capacity-aware handoff and negative outage/rate-limit cases. |
| Step 4: shared Linux office and concurrent desktops | The combined proof uses actual SQL-native admission, receipts and office TLS to drive two real persistent XFCE desktops. Separate totals are shared and reconciled in Chromium, followed by binary export and live Company File publication/import with no member clients running. Native-session closure leaves desktops alive. VM adoption/readiness and application page content are explicit fixtures. |
| Browser grants, privacy and desktop/viewer lifetime | Current native/tool/privacy/drain/service tests pass. Prior actual Linux probes cover persistent synthetic browser sessions, contained Chromium/input, private sign-in surfaces, revocation, viewer disconnect and whole-guest cleanup. Packaged web SQL/TLS/noVNC tests separately cover watch/control/private reconnect and owner consent. Guest pixels or physical acknowledgements remain fixtures where declared. |
| Native screenshots and explicit transfers | Current capture-image, native endpoint, tool, export/import tests pass. Screenshots retain their admitted asset/receipt boundary. Transfers require explicit source/destination realms, exact versions, verified immutable bytes and current authority; unsupported worker paths are refused. Combined SQL/TLS/Linux/object-store tests verify physical bytes and native receipts. |
| Canonical state after guest loss | The rebuild proof confirms old-container removal, discards the workbench, restarts PostgreSQL and restores the same canonical head in a fresh guest. Five unchanged physical objects form two live files totaling 13 bytes. All head-tree entries and file chunks verify; two exact-version imports require no canonical re-upload. Released screen leases stay refused and the allocation record stays unchanged and charged. This is container loss, not actual LXD/NAS reset. |
| Governed startup, reboot and allocation ownership | Existing current-source provider/SQL/Unix HTTP proofs cover creation through activation, retained stop history, fresh-boot admission and repeated service/VM control cycles with lost replies and database restarts. Separate actual-systemd tests exercise installed protected controls. Physical LXD/VM observations remain fixtures. Stopping or losing a client never releases capacity. |
| Host capacity, placement and demand | The shared SQL ledger gates enabled office/native/login dispatch; pending reservations, full-host inventory, per-node headroom, contention, freshness, waiting requests and typed refusal/failure records have current source-bound proofs. Stopped or idle allocated machines are not free capacity. Unconfigured overflow stays unavailable. |
| Lifecycle records, usage and retention | Computer and screen records retain distinct source identities/times/reasons; bounded usage estimates expose unknown gaps and separate confirmed release. Private screen custody survives supported restarts and export outages. The enabled office supervisor never deletes a VM/root; replacement stops and remains held. Destructive maintenance and future deletion need a separate custody handoff, as detailed in the retention audit. |
| Basic health and operational access | Protected node observation exposes CPU, memory, root-disk and interface counters with freshness/unknown values. The object gateway separately reports current NAS/API/storage/auth dependency health and replication degradation. Root-disk or zero network counters do not imply healthy NAS/reachability. Operator SQL views remain scoped service interfaces. Actual-host configuration and durability remain live gates. |
| Independent clients and governed review | The static member web app is implemented separately and packaged without server authority. Prior actual SQL/member gateway/disk-store/Chromium proofs cover File editing, binary transfer, protected review, native activity and viewer flows. Desktop uses shared APIs and scoped remote viewing; its installed OS/Electron behavior remains a live gate. |
| Reproducible current candidate | Full repository check passes across 1,936 files without fixes, including dependency pins, TypeScript, runtime closure and browser boundaries. Six existing local Linux package manifests and all available artifact bytes are reverified against the unchanged source closure. The native binary is retained unchanged; two external signed native artifacts remain absent and are not accepted. |

## Fresh audit checks

The final focused run passes 717 tests across 25 named files: 371 native/path/wake
tests, 63 Linux boundary/screen-custody tests, 125 office lifecycle/service tests
and 158 native office/capture/transfer/privacy/drain tests. No full Vitest suite
or paid provider test was run.

Fresh disposable PostgreSQL checks pass with all 205 migrations: SQL-to-runtime
context parity, five-kind wake integration, secret custody including the
service-role upgrade, and Company File concurrency/crash recovery. The wake
driver also verifies the original component and forward-upgrade behavior;
all 25 current integration cases pass. The context driver requires the local
`tsx` import loader for source aliases; launching it without that loader failed
before database/test execution and is not counted as a runtime finding.

The rebuild checkpoint records 21 completed native receipts, two staff
identities, one published path, zero active office resources and zero screen
leases. Fixture boundaries and reproduction commands are documented in
[the combined proof](RUNTIME-OFFICE-COMBINED-PROOF.md).

The audit corrected stale architecture-document statements that web integration,
node admission and combined workload verification were still missing. Earlier
checkpoint prose is now explicitly historical. No additional production-code
defect was identified by this final local audit.

## Live gates and intentionally unsupported work

Before a production release, separately approve and verify:

1. A frozen release packet, fresh production policy/migration/node readbacks,
   reviewed source/package pins and required release receipts. No historical
   acceptance record is permission to deploy the current dirty candidate.
2. The signed external native artifacts and actual LXD guest image, provider
   enrollment, network/TLS configuration, boot/adoption, reboot/reset, NAS mounts
   and required storage durability on the intended host.
3. Hosted authentication/PKCE, proxy/TLS/Realtime and the installed desktop's
   chooser/viewer/account behavior. Local auth/transport/OS fixtures do not
   establish these deployment results.
4. An operator retention decision before any destructive VM/root maintenance.
   The enabled supervisor preserves the root and does not perform replacement
   deletion. A future destructive workflow must first prove private pending-event
   custody; host/root loss can leave unknown lifecycle intervals.

Worker dispatch/todos, isolated coding VMs and deferred Azure integration remain
Orders 5, 9 and post-build work. No additional-company-machine or full-host
failover implementation is implied by this audit. These scope boundaries do
not permit unsupported transfer realms or synthetic capacity to be enabled.

## Evidence locations

The task workspace is
`/Users/jonas/Documents/Codex/2026-09-05/files-pasted-by-the-user-take`.
`outputs/step4-final-local-audit` contains the final source manifest, raw audit
check results, package verification and review summary. The unchanged code is
also bound by `outputs/step4-canonical-rebuild` and
`outputs/step4-operation-history-packages-final`.

The requirement-specific historical evidence remains indexed by
[the Step 4 ledger](RUNTIME-STEP-4-ACCEPTANCE.md),
[the Steps 0–3 ledger](RUNTIME-STEPS-0-3-ACCEPTANCE.md), and
[the retention audit](RUNTIME-OFFICE-RETENTION.md). Each proof retains its own
version, actual measurements and exclusions.
