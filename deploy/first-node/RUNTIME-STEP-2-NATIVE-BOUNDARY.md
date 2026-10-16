# Runtime Step 2: native boundary and cloud tool authority

Date: 2026-08-28. This is the historical source/component checkpoint;
**native-result blocker resolved; production unchanged and Step 2 incomplete**.
The current signed-image, direct-tool and real-GPT VM-recovery acceptance is in
[RUNTIME-STEP-2-V52-ACCEPTANCE.md](RUNTIME-STEP-2-V52-ACCEPTANCE.md).
The subsequent governed Company File, context, guest and recovery work is
recorded in [RUNTIME-STEP-2-GOVERNED-GUEST.md](RUNTIME-STEP-2-GOVERNED-GUEST.md).
Historical test counts below describe their checkpoint, not a combined total.

## Decision and scope

Host-managed Codex app-server tools alone do not intercept every native result.
The user explicitly authorized a narrow downstream native patch. The pinned
patch now intercepts result bodies at the common model request builder; the
actual-binary proof reports `allNativeResultsFenced: true`, including native
rejections and malformed-argument errors. Native authentication and provider
transport are unchanged. There is no credential-reading provider proxy.

Implementation is based on the released Step 1 tree at
`a0b692947d5c867353591b36172afcc997f0521e`, not the older architecture draft.
`NativeProviderHost` now has an explicit `company-path-v1` source integration;
the deployed legacy `codex exec` driver has not been switched.
No production services, NAS routes, company mounts, credentials, migrations or
releases were changed. The first synthetic-data build VM produced the Linux
development artifact and was removed after export and hash verification. A
separate disposable VM produced the release-profile artifact and passed the
expanded fixture; it was also removed after verified export. Neither VM had
a company or credential mount.
Scoped gateway/worker outage-resilience components are now integrated; client
Auth/object-transport changes and offline read delegation are not enabled.

This remains a pure-cloud design. The caller is the cloud native host,
never the desktop client. The Company File is one live, company-owned cloud
state, and the Company Computer remains shared. The empty, temporary harness
working directory in this proof is neither a company checkout nor a copy of
company state. Canonical storage is never passed to the harness; the trusted
cloud host mediates path operations against current cloud authority.

## Implemented components

`packages/shell/src/cloud-native-tool-boundary.ts` provides:

- A closed host registry with required argument parsers. Company and run
  identities come from the host, not model-supplied fields.
- A versioned `qorpera.cloud-tool-result/v1` envelope. Source, tool, call and
  run provenance remain outside untrusted text or nested JSON. Control-like
  characters are escaped; fake role labels and nested envelopes stay payloads.
- Fixed errors that do not echo adapter exceptions, credentials or parser
  details. A thrown adapter call is unconfirmed, not automatically retried.
- 64 KiB argument, 1 MiB source and 128-call limits. Each complete serialized
  result envelope, including escaping and provenance, is at most 8 KiB.
  Truncation preserves UTF-8 boundaries and records original size and hash.
- Serialized dispatch, exact in-process call deduplication and authority
  rechecks before dispatch and result release, including cached replies.
  Cancellation bounds waiting for stalled authority checks and handlers.
- Native result batches are checked against exact host-issued call/body hashes.
  Spoofed or copied envelopes are treated as untrusted payloads. Replayed
  unchanged results retain stable envelopes; changed bodies for an existing
  native call fail closed. Empty model requests also require live authority.

The boundary's callback is connected to live run authority by the cloud
entrypoint below. That is not itself a Company File path grant; the governed
path gateway independently enforces those grants at read and commit time.
The low-level call-ID cache remains in-process only; durable effect retries
use the existing cloud operation ledger, not this cache.

### Cloud run identity and authority

`cloud-native-tool-authority.ts` and `cloud-native-run-tool-session.ts` bind
the adapter to the cloud-admitted run before a native process starts:

- The service-only authority RPC derives company, environment, staff/version,
  requester, sponsor, session audience, connection/version, compute identity,
  job/assignment/lease and pinned model from current database state. The model
  cannot supply or change these fields. Provenance contains no credentials,
  capsule references or runner/session tokens.
- Each dispatch and result release obtains fresh authority. Queued and cached
  results are rechecked. A change in the admitted identity ends the session;
  a retained result cannot restore revoked permission.
- The server bounds validity to 30 seconds and to the remaining native,
  assignment, job and runner-session leases and run deadline. The host uses a
  monotonic deadline, conservatively subtracts request time, refreshes while
  the model is running, and maintains an independent expiry watchdog. Failed
  or stalled refresh aborts the native session instead of extending authority.
- The RPC checks active employment and current requester membership separately
  from subscription sponsorship. A new agent in setup may still be active;
  archiving its employment removes authority. A departed requesting friend
  cannot continue using another member's still-active subscription.

New migration `20260828004000_native_cloud_tool_authority.sql` adds three
service-only RPCs and a non-callable private helper. It reuses native lease
validation and job-first locking. Explicit clock-time checks reject expiry
after lock waits. It is **not applied to production**.

`SupabaseNativeProviderControlPlane` supplies these RPC methods. Its JSON
responses are capped at 256 KiB; redirects are refused; error bodies are
cancelled without being read. The new authority/receipt path has a 5-second
request-and-body deadline, including transports that ignore cancellation.
Existing control-plane operations retain a bounded 30-second deadline.

### Durable operation attempts

`cloud-native-tool-operations.ts` connects trusted cloud effect adapters to
`qorpera_run_operation_receipts`; it creates no competing effect ledger:

- A closed, immutable plan includes tool/schema version, exact arguments,
  resolved target/audience/policy/expected version, logical operation key and
  revision requirement. Its digest includes the cloud principals. Runner,
  assignment and native lease IDs are excluded from this logical digest so
  recovery can identify the same work under a new assignment.
- A fresh receipt admits one attempt. A completed receipt can supply its
  recorded result after fresh authorization. Existing executing, ambiguous
  or cancelled receipts never admit a second attempt. Changing a native call
  ID does not change logical work; the existing database ledger also rejects
  a different key while any operation remains unresolved.
- The downstream idempotency key is stable per run/logical operation. Lost
  admission or completion responses and effect exceptions remain uncertain;
  this component never automatically reruns them. It bounds effect waits to
  30 seconds, but does not pretend cancellation reverses a completed effect.
- Revision-requiring completions use the existing verified snapshot/proposal
  checks. This retains recovery metadata; it does not add a branch/commit
  workflow to the live Company File or invent prebuilt agent artifacts.

The `authorize` callback and the target gateway's atomic permission check are
still mandatory dependencies. A run receipt is not path permission, human
consent, or a filesystem/connector transaction. The governed Company File
adapter is now implemented in source; no production adapter was activated.
Connector adapters remain separate work. Adapters must enforce exact target authority
at their commit point and propagate the supplied idempotency key. Private
operation results never become public sends automatically.

`packages/shell/src/cloud-codex-tool-session.ts` provides an opt-in,
single-turn app-server adapter for the pinned downstream Codex **0.147.0** binary:

- Private launch directory, explicit environment and an optional fresh,
  host-restored auth-only identity directory; no client config, provider skills,
  hooks, Company File path or mouth bearer token is passed to the harness.
- Required operator-pinned executable SHA-256 and native capability marker;
  an unpatched official binary is rejected before a model request. Strict
  configuration and pinned-version verification; effective configuration
  and an empty provider skill catalog are checked before starting the turn.
- No executor environment, no workspace roots and read-only/no-network tool
  sandbox policy. Native shell, patch, browser, computer, worker, app and MCP
  execution routes are unavailable in the tested tool registry.
- Native plan, user-question and orchestrator skill tools are explicitly
  disabled. Qorpera tools are direct-only, excluded from nested Code Mode calls.
- Low effort in both configuration and the turn request, including the bundled
  provider-default model path.
- Closed thread/turn/call bindings for callbacks; non-tool callbacks cannot
  become approvals, credential refreshes or UI effects. Bounded protocol
  messages, total output, callback count and elapsed execution.
- Process-group shutdown on completion, failure or cancellation. Ordinary
  assistant text, reasoning, diffs and diagnostics are never a public message.

The adapter does not implement the public mouth itself. Its proof and the
governed cloud runtime reuse `CloudAgentMouth` and its closed send/receipt
parsers. The runtime calls `mouth.finish()` and the database independently
enforces completion. Optional silent wakes await the admitted Step 3 policy;
they are not inferred from model or job payload flags.

## Pinned-binary findings

The reproducible source pin, patch, Unix-socket contract, build recipe and
compiler requirements are in [native-codex/README.md](native-codex/README.md).
The patch is applied to upstream commit
`be6e8eac029b183056b7e4402879f15d2c85f61b` with Rust 1.95.0. It does not change
authentication, headers, model metadata or the native provider transport.

`cloud-native-result-fence.ts` accepts only length-prefixed, bounded JSON over
a private Unix socket. It binds request, thread and turn identity, rejects
replay and extra fields. It times nothing out: the checks before release end only
with the run (its authority or lease gone, a refusal, a stop). The native caller
keeps a 10-minute backstop against a hung host (until 5 Oct 2026 a four-second host
and a five-second native deadline). Unhandled result kinds and
multimodal/encrypted tool results fail closed. The callback covers the common
HTTP, WebSocket and compaction request builder; the actual-binary acceptance
below exercises HTTP. Additional actual-binary tests cover local, remote-v1
and remote-v2 compaction, restored runtime laws, untrusted compaction output,
and revocation during compaction. Full deployed context reconstruction with
real GPT and the complete guest boundary remains an integration gate.

Do not infer the active tool set from configuration flags alone. With the
historical result-only patch and bundled provider-default model (`gpt-5.6-sol`), Codex uses an
`additional_tools` input item and model metadata still advertises Code Mode
despite `features.code_mode.enabled=false` and `code_mode_only=false`.

The separate `code_mode_host=false` setting rejects actual script execution.
Direct-only `qorpera` exposure preserves access to the host tools without a
script wrapper that could discard their provenance. Forced nested reads,
sends, shell calls, module imports, network requests, image reads and waits
are rejected before execution.

| Model metadata path | Advertised tools after configuration | Execution result |
| --- | --- | --- |
| Synthetic direct-tool model | `qorpera.read_document`, `qorpera.send_message` | Controlled callbacks return host envelopes. |
| Bundled provider default | Same Qorpera tools plus `functions.exec`, `functions.wait` | Qorpera callbacks work; script calls return `code-mode host is disabled`. |

The provider-default model and the synthetic direct-tool path are both tested.
No model catalog or model selection was overridden to hide this difference.
Disabled native plan, question and skill names are also force-called: they
are rejected, not merely absent from the advertised list.

### Functional gate exposed by signed v51

The later real-GPT run `1c4f4e0b-8564-4a25-9e64-581e59ae4f48` reported
using this advertised but disabled route and ended without a governed file
read or write. Its private tool arguments were not retained, so the report
alone is not a raw call trace. An independent synthetic recheck with the
same Linux executable hash reproduced the exact advertised tools and fixed
rejection; all 22 denial and six compaction checks remained green.

At the pinned source commit, `codex-rs/core/src/tools/mod.rs` takes
`model_info.tool_mode` before the feature flags. Its unavailable-host fallback
applies to `CodeMode`, not the default model's `CodeModeOnly`. The documented
feature configuration does not establish an override for that model setting.
This makes the inventory mismatch a functional Step 2 blocker even though
execution remains denied and every error result is fenced.

The user subsequently authorized direct tool selection for governed, fenced
runs, a scoped source commit and a signed replacement preview. The patch
selects direct mode only when the host-owned fence socket is present; ordinary
sessions keep upstream selection. The host requires the separate direct-tools
capability before model admission. Authentication, model metadata and the
result callback are unchanged. New source/patch/binary pins, signed v52 and
real-GPT VM-restart acceptance have now passed. Do not
enable arbitrary native scripts, substitute a synthetic model/catalog or
claim a prompt-only workaround fixes the tool inventory. See [the staging record](RUNTIME-STEP-2-STAGING.md) for the
scoped real-GPT passes, the process-only receipt replay and remaining gates.

The proof sends 22 forbidden calls plus a malformed Qorpera call, then checks
the next provider request. All 23 native error results are now fenced. The
eight host-dispatched results, including safe errors and a truncated hostile
payload, retain their complete Qorpera envelopes. No admitted native tool
result in either tested model path reaches the provider unfenced.

## Verification

Initial native-fence checkpoint: **214 focused Qorpera tests across fourteen files passed**,
including the existing Step 1 mouth regressions, stock-binary rejection and
patched-binary success/failure tests. Two build-script tests and five native
Rust tests also passed. `npm run check` passed without diagnostics. Native
Clippy and formatting passed with the pinned compiler.

The standalone provider-default proof passed inside an isolated Ubuntu 26.04
VM on the actual cloud node, as an unprivileged user in a loopback-only network
namespace: 22 denied bypasses, eight fenced host results, 23 fenced native
errors, unchanged synthetic canonical bytes, no unbrokered requests and two
deduplicated public sends. Revoked and stalled authority each allowed only the
initial provider request and no effect. This is cloud-node **component** proof,
not the deployed run/control-plane path or real-GPT acceptance. The fixture's
authority and Company File adapters are synthetic.

At that initial checkpoint, disposable PostgreSQL applied all **75 migrations** and passed selected suites
`160_native_subscription_compute_identity`,
`165_cloud_agent_public_mouth_privileges` and `280_cloud_session_run_control`.
The expanded native fixture exercises the new service-only RPCs on real
admitted database runs, including distinct requester/sponsor identities,
requester removal with the sponsor still active, revocation, lease expiry,
expiry during a request, changed arguments, unresolved-attempt fencing,
completion replay and required Company revision checks. The full database
suite was not run for this checkpoint. Disposable test databases were removed.

Tests use the actual pinned Codex binary with a scripted loopback Responses
provider and synthetic files. There are no real model calls, provider tokens,
or actual company credentials. A scripted adversarial call proves denial even
if a model follows the injected instructions; it does not measure real-model
prompt-injection resistance.

Run from `packages/runtime`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/cloud-native-tool-authority.test.ts test/cloud-native-tool-operations.test.ts test/cloud-native-tool-control-plane.test.ts test/cloud-native-run-tool-session.test.ts test/cloud-native-tool-boundary.test.ts test/cloud-codex-tool-session.test.ts test/official-codex-boundary.test.ts test/cloud-agent-mouth.test.ts test/cloud-native-provider-host.test.ts test/cloud-native-provider-service-main.test.ts
```

Run the same provider-default native proof on Linux without a test runner:

```sh
node packages/runtime/test/fixtures/run-official-codex-boundary-probe.ts /absolute/path/to/pinned/codex
```

The probe's `send_message` delivers through `CloudAgentMouth.send` in process,
as a company run does; it starts no MCP endpoint (legacy sweep step C, C-R4).
A lost receipt still reaches the model only as an unconfirmed outcome, and the
fence checks and proof fields are unchanged.

At the historical result-only checkpoint, the Linux x86_64 artifact was a release-profile build with debug sections
removed by the pinned Rust toolchain's LLVM utility. The input/tool/output hashes
are recorded, the exported binary passed the same native and compaction checks,
and the real guest packager accepted it in contract-only mode. That checkpoint
was not a signed guest image; the later v52 image is recorded separately above.
Node 24.19.0 and the Ubuntu image were pinned for the disposable
build guest. Only public build dependencies were downloaded; acceptance itself
had no external network. The earlier
Linux ARM64 stock-binary proof demonstrated the original gap and is historical
negative evidence, not current fence acceptance.

Assertions include unchanged synthetic canonical bytes through direct,
symlink and hardlink attempts; no unbrokered HTTP request; excluded synthetic
secrets and raw errors; authority revocation after queueing and on retry;
stalled-call cancellation; configuration drift; malformed or replayed native
callbacks; descendant process-group termination; and immediate/deduplicated
progress and final sends with private output excluded.

The new authority/operation tests use scripted cloud transports and a native
RPC fixture. They cover stalled refresh/body/effect handling, immutable plans,
concurrent retries, durable completed/uncertain replay, authority changes on
cached results, and native process cancellation. SQL tests separately verify
the actual lease/receipt functions. These layers are component evidence, not
an end-to-end deployed native-host acceptance test.

For the current native slice, set `QORPERA_CODEX_FENCE_BINARY` to the exact
built artifact and also run `test/cloud-native-result-fence.test.ts` and
`test/patched-codex-boundary.test.ts` with the focused command above. Run
`node --test scripts/build-native-codex.test.mjs` from the repository root.
The standalone command now includes both authority-failure checks and twelve
compaction checks (three paths, with and without revocation, using both the
synthetic and provider-default models), and fails
for a missing or unpatched artifact; it does not silently skip acceptance.
The [initial Linux evidence](native-codex/linux-x64-component-proof.json) pins the
development artifact. The [release evidence](native-codex/linux-x64-release-proof.json)
pins the packageable release and expanded fixtures. Both archives include the
upstream license and notice and were verified after transfer off their VMs.

## Remaining gates, in order

1. Connect the implemented member path-content reader to the human UI and finish
   direct editing and proposal review/application. Descriptors and isolated
   transport tests cannot replace the human Company File experience by themselves.
2. Reconcile the existing plain NAS company state with the governed live head,
   then verify shared-workbench containment before any canonical-mount cutover.
   Do not introduce a second company or discard existing NAS work.
3. Verify secret custody, destination egress, process/cgroup isolation and
   persistent-volume recovery in the complete packaged guest. Synthetic
   provider and mount-schema checks are not this acceptance.
4. Verify the accepted release-profile artifact together with a signed guest
   image, provider configuration and persistent recovery storage. A binary digest
   and contract-only packaging are not a complete runtime-bundle admission pin.
5. Run controlled real-GPT cloud acceptance with clients closed, revoked
   authority, crashes and multiple human identities, then use the coordinated
   rollout lane. Retained private data never restores expired authority.

Step 3 integration is paused by user direction on 2026-08-28. Wake policy,
room ingress and full cross-step runtime-bundle composition remain deferred
handoffs, not Step 2 completion gates. Existing final-send enforcement stays
in place. The preserved mixed-source snapshot and Step 2-only working baseline
are inventoried in `/tmp/qorpera-step2-resume.rN3rbf/README.md`.

### Historical recheck and authorized resolution

The request to complete the remainder was checked against the canonical
runtime contract, the native-subscription architecture, the installed 0.147.0
app-server protocol, and the current official app-server/hooks documentation.
The three official-binary boundary regressions were rerun and passed their
explicit partial-coverage assertions: 22 forbidden calls denied, eight
host-controlled results fenced, and 23 native errors unfenced. This is a
reproduction of the blocker, not a passing Step 2 acceptance result.

The installed protocol exposes responses for dispatched dynamic tools; it
does not expose a synchronous callback for every native result. Supported
hooks also exclude some paths. Observing a native event and then cancelling
the turn is not a substitute: it does not establish interception before the
next model request.

At that checkpoint the contracts required both complete result fencing and unmodified
official native harnesses with isolated subscription credential custody. No
supported mechanism satisfying both was found. A maintained native-harness
change required explicit approval to revise the unmodified-harness
requirement and a separate feasibility/acceptance review. A credential-reading
provider proxy or a narrower fence guarantee is not implicitly authorized by
the implementation request. No such change, production activation, or
credential operation was performed during that recheck.

The user subsequently authorized the narrow native patch. The technical
exception is now recorded in the native-subscription and cloud-control-plane
contracts, with source/patch/binary pins and no change to credential custody.
The native-result blocker is resolved by the proofs above. This decision does
not by itself resolve Company File integration, complete guest isolation,
recovery operations or rollout gates. See the governed-guest record for the
source implementation completed since the initial native proof.

## Source references

The official [app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes experimental dynamic tools and host callbacks. The
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [configuration schema](https://learn.chatgpt.com/docs/config-schema.json)
describe the settings used here. They guided the controls to probe; the pinned
binary tests determine the behavior actually claimed above. In particular,
configuration reporting is not a substitute for checking the model-facing
inventory and forcing a forbidden call.

The official [hooks documentation](https://learn.chatgpt.com/docs/hooks)
explicitly limits hook coverage; specialized paths can opt out. The installed
dynamic-tool response protocol likewise exposes only the results of dispatched
host tools, not all native router failures. Neither is a universal pre-model
result interceptor in this implementation.
