# Pinned native result fence

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

## Build

Provision Rust 1.95.0 and the upstream platform build prerequisites, then run
from the Qorpera repository:

```sh
node scripts/build-native-codex.mjs --source /absolute/path/to/upstream-clone --out /absolute/path/to/new-build-directory
```

The supplied clone must contain the pinned commit. The script creates its own
checkout and refuses an existing output directory. `--prepare-only` verifies
and applies the patch without compiling; `--profile dev` produces a component
test binary, not a release candidate. The default is a release build. The
artifact includes LICENSE, NOTICE, compiler/target information and a hash.
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

Five native tests cover exact-body replacement, closed identity/batch checks,
the initial-request handshake, unsupported content and stalled-host expiry.
They passed with Rust 1.95.0, followed by upstream's targeted Clippy fix and
format commands. The complete upstream test suite was not run.

Qorpera's actual-binary fixture forces forbidden native calls, malformed JSON,
hostile nested data, synthetic-secret reads and duplicate public sends. It
requires all 31 result bodies to be fenced, with 22 execution bypasses denied.
Separate actual-binary cases revoke or stall authority before the next request.
The unpatched official binary must be rejected before a model request.

The [Linux proof](linux-x64-component-proof.json) records the artifact and
fixture hashes from the isolated cloud-node VM, including both authority
failure cases. The development artifact archive is retained at
`/tmp/qorpera-codex-fence.sX30In/linux-x64-artifact.tar.gz`; it is not a release
installer or production image. The build manifest keeps its build-time
`cloudAcceptance: not_performed`; the separate proof records what was tested.

These are component proofs with a loopback scripted provider, not real GPT or
production acceptance. The normal native host is not switched by this patch.
Company File path authorization, shared-workbench containment and deployment
acceptance remain separate required gates. A new upstream version requires
source review, a new patch/hash, and rerunning these proofs; never auto-upgrade
the native artifact or infer compatibility from its version string.
