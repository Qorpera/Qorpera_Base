# Pinned native result fence and governed direct tools

This is a narrow downstream change to the official Codex 0.147.0 source, not
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
native deadline is five seconds; the host deadline is four. An exhaustive
item match rejects unhandled tool-result kinds and multimodal/encrypted tool
results. Native memory requests are not admitted in this adapter. Only result
bodies can change; the reply cannot alter calls, instructions, models or roles.

The host owns the closed provenance envelope and rechecks live run authority
before releasing results. Only an exact host-issued same-call envelope may
pass through unchanged. An attacker-supplied envelope is data, not authority.
Raw result text is private and is never a public send. Each final serialized
envelope is capped at 8 KiB, with original byte count, hash and truncation.
This can exceed 1,000 tokens and requires manual payload-budget review; it
cannot exceed the upstream 10,000-token item ceiling under a byte-level bound.

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

These are component proofs with a loopback scripted provider, not real GPT or
production acceptance. Source now includes an explicit `company-path-v1`
host/provider/guest lane with a cloud-authorized live Company File gateway;
the deployed legacy lane has not been switched. Packaging accepts only a
matching release-profile Linux x86_64 artifact, not the development archive.
See [the governed-guest record](../RUNTIME-STEP-2-GOVERNED-GUEST.md) for human
file integration, shared-workbench containment and rollout gates. A new upstream version requires
source review, a new patch/hash, and rerunning these proofs; never auto-upgrade
the native artifact or infer compatibility from its version string.
