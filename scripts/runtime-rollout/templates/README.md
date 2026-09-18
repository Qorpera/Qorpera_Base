# Disabled Company41 rollout packet

Generated from versioned tooling. This directory does not authorize production activity.

1. `node controller.mjs check` verifies the clean detached source, captured baseline, exact migration delta, implementation hashes, and every generated SQL file.
2. `node verify-offline.mjs` runs the fake-transport and controller tests and preserves their actual result as `OFFLINE-TESTS.json`.
3. Run `node rehearse-wrapper.mjs /absolute/pinned-production-schema.sql`. The reviewed August 29 schema hash and its 92 baseline versions are in `rehearsal-baseline.json`. The runner restores that schema into pinned, network-isolated disposable PostgreSQL, advances it with the candidate's already-shipped migrations, seeds synthetic target metadata, and rehearses every exact wrapper and reconciliation query. It rejects replay of each mutation and confirms cleanup before writing `WRAPPER-REHEARSAL.json`. This proof does not substitute for native execution acceptance or a fresh production readback.
4. `node freeze-packet.mjs freeze` seals the tested packet; `verify` rechecks it.

`READY` remains false. No command here issues a release window, source acceptance, physical fence, disabled installation receipt, signature, or founder approval. Any approved execution requires a separately reviewed activation successor with four fresh literal receipt hashes, exact source and local pins, and the pinned Supabase 2.116.0 executable. Never reuse historical gates. Admission remains disabled after execution.

An intent is preserved before the sole local CLI invocation. An ambiguous result must not be retried. Reconciliation is read-only and cannot promote an earlier uncertain attempt. These are global OpenAI native-subscription policy mutations for the fixed Company41 project. The 18 production-only ledger versions are retained.
