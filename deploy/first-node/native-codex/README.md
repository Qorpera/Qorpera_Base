# Pinned native result fence, governed tools, images and composition

This is a narrow downstream change to the official Codex 0.155.1 source, not
an official upstream release. The user explicitly authorized this exception
to the unmodified-harness requirement on 2026-08-28. Native GPT sign-in,
refresh, credential storage, provider transport, model metadata and provider
request headers are unchanged. There is no credential-reading model proxy.

`source.json` pins the upstream commit, patch, compiler and Cargo lock hashes.
The patch adds a private result-only Unix-socket callback at the common
Responses request builder (HTTP, WebSocket and compaction). A capability
marker is returned to the local app-server client. Qorpera also requires an
operator-pinned executable SHA-256; the marker alone is not artifact trust.

The separately authorized direct-tools extension selects `ToolMode::Direct`
only when `QORPERA_NATIVE_RESULT_FENCE_SOCKET` is present. This prevents model
metadata from advertising `functions.exec` and `functions.wait` while their
execution host is disabled. Ordinary sessions retain upstream tool selection.
Invalid sockets still fail the unchanged pre-request handshake. Authentication,
provider transport, model metadata and the result-fence wire schema are unchanged.
The host requires both `qorpera.native-result-fence/v1` and
`qorpera.native-direct-tools/v1` before model admission; the older result-only
binary is no longer accepted by this governed adapter.

The host also requires `qorpera.native-message-composition/v1`. In governed
sessions the native stream emits `qorpera/messageComposition` when a
`qorpera.send_message` output item begins, before its arguments are complete,
and closes it before tool dispatch or when the stream ends. The notification
contains only thread, turn, call identity and start/finish phase. It is excluded
from durable native rollouts. The host validates the bound identities and emits
expiring `message_composition` observations; it renews them every five seconds
while composition continues and closes them on completion or cancellation.
The member activity projection uses these observations for Writing. Executing
`send_message` is delivery and does not imply that the agent is still writing.

Capture-enabled sessions additionally require `qorpera.native-capture-images/v1`.
Images must originate in an issued tool result and match its call, envelope and
hash. The host rechecks the capture read set on every provider/compaction request,
including when reconstruction has replaced pixels with summaries. Arbitrary
provider-message media cannot acquire authority through this path.

The result fence sends every tool output of a model request's history to the
host, which returns each as a host-issued envelope of at most 8 KiB. Since bundle
v104 a request may carry any number of outputs: the frame is bounded at 64 MiB
each way (it was 8 MiB, with fewer than 128 outputs and 1 MiB of result text),
more than any model context holds.

## Build

Provision Rust 1.95.0, its `llvm-tools` component and the upstream platform
build prerequisites, then run from the Qorpera repository:

```sh
rustup component add --toolchain 1.95.0 llvm-tools
node scripts/build-native-codex.mjs --source /absolute/path/to/upstream-clone --out /absolute/path/to/new-build-directory
```

The supplied clone must contain the pinned commit. The script creates its own
checkout and refuses an existing output directory. `--prepare-only` verifies
and applies the patch without compiling; `--profile dev` produces a component
test binary, not a release candidate. The default is a release build. The
artifact includes LICENSE, NOTICE, compiler/target information and a hash.
Release staging strips debug sections from the copied executable using that
same Rust toolchain's `llvm-objcopy`; it preserves the compiled input and
records both input and processing-tool hashes. The upstream release profile
includes debug symbols, so omitting this step exceeds the guest package bound.
The package validator requires this processing record and retains its size
limit; it does not accept an arbitrary host `strip` result.
Cloud acceptance is explicitly unperformed in the build manifest.

`--target-cache /absolute/path` can reuse Cargo intermediates across local
build attempts. Each attempt still creates a new checkout/output directory,
checks the source/patch/lock and records the final executable independently.
The cache is trusted build input, never an acceptance result.

The upstream tag updates workspace package versions without updating the
135 path-package versions in Cargo.lock. The script normalizes only those
release metadata fields, verifying both full-file hashes before compiling
with `--locked`. No external dependency is changed. Upstream's Bazel lock
refresh was run and produced no lock diff.

## Wire and authority

The host enables `QORPERA_NATIVE_RESULT_FENCE_SOCKET` only in a private native
process. The socket is in a mode-0700 directory, mode 0600, never a provider
endpoint. Each length-prefixed JSON request includes a random request ID,
thread/turn, purpose and the exact result bodies. It contains no authentication
headers, credentials, installation identity or session tokens.

Every request, including an empty initial request, needs a live acknowledgement.
Missing, stalled, malformed, mismatched or replayed replies fail closed. The
native deadline is 45 seconds; the host deadline is 40 (5 and 4 until 4 Oct 2026: a database slowed to a few
seconds per call stopped turns; the host now asks a lost or late fence call again within its budget). An exhaustive
item match rejects unhandled tool-result kinds, unissued images and encrypted tool
results. Native memory requests are not admitted in this adapter. Only result
bodies can change; the reply cannot alter calls, instructions, models or roles.

The host owns the closed provenance envelope and rechecks live run authority
before releasing results. Only an exact host-issued same-call envelope may
pass through unchanged. An attacker-supplied envelope is data, not authority.
Raw result text is private and is never a public send. Each final serialized
envelope is capped at 8 KiB, with original byte count, hash and truncation.
This can exceed 1,000 tokens and requires manual payload-budget review; it
cannot exceed the upstream 10,000-token item ceiling under a byte-level bound.

## Usage-limit codes (Sign in with ChatGPT)

A ChatGPT plan's usage limit arrives as OpenAI's code
`subscription_sharing_usage_limit_exceeded`: mid-stream as a `response.failed`
event, or before the stream as an HTTP 429. Codex 0.155.1 maps only
`insufficient_quota` (and a few spend-limit codes at 429) to its quota error:
- mid-stream, it retried the request five times (about six seconds) and then
  failed as `other`, so the host read a generic failure;
- at a 429, it failed after one request as `responseTooManyFailedAttempts`; the
  host already reads that as the usage limit on a plan run, but its category was
  `provider_failed`.

The patch adds that code to both places in `codex-api`:
`sse/responses.rs`' `is_quota_exceeded_error` and `api_bridge.rs`' 429 code
list. Both give `ApiError::QuotaExceeded` / `CodexErr::QuotaExceeded`, which is
not retried and which the app-server reports as `codexErrorInfo:
usageLimitExceeded` (`willRetry: false`). The host reads that as a usage limit
(`budget_exhausted`, `usage_limit`): the run stops and is not moved to another
login. Only a response carrying this exact code takes the new path; every other
code, `insufficient_quota` included, is handled as before, so Codex logins are
unchanged. Not covered: Codex 0.155.1 ignores a top-level `error` stream event,
so a limit sent that way would still be retried. OpenAI documents the code for
Sign in with ChatGPT; its live response shape cannot be checked before OpenAI
approves the partner track, so the proof uses a synthetic provider.

Proof for a build carrying this change:

```sh
# Rust: the two qorpera_* tests next to upstream's quota tests.
cd /absolute/path/to/patched-checkout/codex-rs
cargo test -p codex-api qorpera_
# The host: a real native process against a synthetic provider that ends the
# turn at the plan's limit, mid-stream and as a 429.
cd /absolute/path/to/qorpera
QORPERA_CODEX_FENCE_BINARY=/absolute/native/codex node node_modules/vitest/dist/cli.js \
  --root packages/runtime --run test/patched-codex-boundary.test.ts
```

Every boundary case must still pass. Each of the two new cases must make one
model request and fail at `codex-turn-completion` with `budget_exhausted` and
`usage_limit`. Against the previous pin (a7531592…), the mid-stream case makes six requests
and fails without a usage signal, and the 429 case fails as `provider_failed`.

## Verification and rollout boundary

Six native tests cover governed versus ordinary tool selection, exact-body
replacement, closed identity/batch checks, the initial-request handshake,
unsupported content and stalled-host expiry.
They passed with Rust 1.95.0. The original result callback also passed upstream's
targeted Clippy fix; upstream formatting was rerun for the direct-tools extension.
The complete upstream test suite was not run.

Qorpera's actual-binary fixture forces forbidden native calls, malformed JSON,
hostile nested data, synthetic-secret reads and duplicate public sends. It
requires all 31 result bodies to be fenced, with 22 execution bypasses denied.
Separate actual-binary cases revoke or stall authority before the next request.
The unpatched official binary and the older result-only patch must be rejected
before a model request. The default GPT inventory must expose only registered
Qorpera tools, with no code-mode execution or wait tools.
Local, remote-v1 and remote-v2 compaction each have success and revocation
cases: earlier tool results remain fenced, runtime laws survive reconstruction,
forged compaction instructions do not acquire authority, and revocation denies
the next provider request and effect. These checks are also mandatory in the
standalone Linux fixture for both the synthetic model and the provider default.

`node packages/runtime/test/fixtures/run-native-codex-composition-probe.ts /absolute/native/codex`
holds a scripted public-message output item open for over two seconds before
supplying its arguments. It requires the actual native Writing signal during
that hold, a finish before send dispatch, and cleanup when the incomplete
stream is cancelled. Both synthetic and provider-default model configurations
are checked. The fixture also checks the closed metadata schema and exclusion
of public-message and private-reasoning canaries from activity telemetry.

The [initial Linux proof](linux-x64-component-proof.json) records the artifact and
fixture hashes from the isolated cloud-node VM, including both authority
failure cases. The development artifact archive is retained at
`/tmp/qorpera-codex-fence.sX30In/linux-x64-artifact.tar.gz`; it is not a release
installer or production image. The build manifest keeps its build-time
`cloudAcceptance: not_performed`; the separate proof records what was tested.

The [Linux release proof](linux-x64-release-proof.json) records the historical result-only
release-profile binary and all six compaction cases. The stripped binary is
307,148,960 bytes, SHA-256
`babeed68a7732f96fa6bcd69ac3a9e4124bcfab5340ce0fbab61363b8b1a148f`.
Its exported archive was reverified and used by the actual guest packager in
`--contract-only` mode. The signed runner image was not included or accepted;
this is not a deployable-image or complete-guest isolation claim. The disposable
builder was removed after export; retained artifact paths are in the proof.

The historical [direct-tools Linux proof](linux-x64-direct-tools-proof.json) pins the
307,161,584-byte release executable, SHA-256
`2f2c26cfdfacebbcce848fb50cfaaa4e8d0aa3c6ec3c1009123ecf766c8335f7`.
It verifies the provider-default direct-only inventory, all result fences,
authority failure and twelve compaction cases. These native component proofs
use a loopback scripted provider, not real GPT or production acceptance.
The separate [signed v52 acceptance](../RUNTIME-STEP-2-V52-ACCEPTANCE.md)
records the clean-image rebuild and real-GPT write/receipt replay after forced
VM restart. Production is not enrolled; remaining Step 2 gates are explicit.

The historical [capture-images Linux proof](linux-x64-capture-images-proof.json)
records the 307,464,032-byte release executable, SHA-256
`6bbe4704774454be5aff5501bfe4bbd5e023930ff87d187ca9e5ec4c333c8e8d`.
The actual executable passes twelve image/compaction checks across local,
remote-v1 and remote-v2 modes with both synthetic and provider-default metadata,
plus an unissued-image refusal. The complete tool-boundary probe also passes:
22 denied bypasses, fenced results, revocation/stall checks and twelve baseline
compaction checks. These run in a disposable Linux AMD64 container without
external networking, using a scripted loopback provider. They do not establish
real model interpretation or combined office/SQL/object-gateway readiness.

The current [message-composition Linux proof](linux-x64-message-composition-proof.json)
records the 308,143,880-byte release executable, SHA-256
`9bd7b4e1148cb77820ea75943d03e7531757b3c74e47399df25a00477e58a7d0`.
All four actual-binary composition scenarios pass, including early Writing
while complete arguments are withheld and cancellation before delivery. The
existing result-fence, authority, image and compaction probes also pass. Five
new unit checks were run from the exact source modules using pinned `rustc
--test` against the compiled release libraries; the complete upstream test
harness was not run. The proof records the executed source hashes and actual
Linux guest package manifest. These are scripted loopback checks in a dedicated
Linux VM, with no real-model or production acceptance.

The native checks also caught the namespace description exceeding the pinned
app-server's 1,024-character bound. Its catalog summary is now compact, while
the complete result-handling instructions remain unchanged in the trusted
bootstrap and developer instructions.

`linux-x64-artifact.json` is the accepted native input to runtime bundle generation.
It must match `source.json` and the patch bytes. Generate that bundle before
packaging its native host, then retain the actual packager's
`guest-package-manifest.json`. The guest manifest is an output, because its host
embeds the runtime bundle; using that output to supply the native input would
create a circular pin dependency. The current package uses `--contract-only`:
its signed runner image and Cosign bundle are external prerequisites. Historical
v56 manifests, image recipes and acceptance pins retain their original bytes.

Source now includes an explicit `company-path-v1`
host/provider/guest lane with a cloud-authorized live Company File gateway;
the deployed legacy lane has not been switched. Packaging accepts only a
matching release-profile Linux x86_64 artifact, not the development archive.
See [the governed-guest record](../RUNTIME-STEP-2-GOVERNED-GUEST.md) for human
file integration, shared-workbench containment and rollout gates. A new upstream version requires
source review, a new patch/hash, and rerunning these proofs; never auto-upgrade
the native artifact or infer compatibility from its version string.
