# Minimum Base — completion status

**Date:** 2026-08-10
**Branch:** `claude/base-minimum` (Builds 0–5)
**Measured against:** `QORPERA-BASE-BUILD-PLAN.md` §11 overall completion condition.

| Condition | Status | Where |
|---|---|---|
| Durably operate arbitrary company files | ✅ | folder + 4-layer append-only trail + turn checkpointing (pre-existing, verified Build 1) |
| Build and run its own capabilities safely | ✅ | `run_company_tool`: clean-env sandboxed subprocess with content-hash identity; signature rule live (Build 2) |
| Contact the outside world through generic controlled means | ✅ | kernel HTTP lane w/ destination capabilities + `secret://` references + OAuth2 refresh; stdio MCP client; program-side lane for signed unattended outward action (Build 3) |
| Continue through time under kernel-owned serialization and ceilings | ✅ | scheduled wakes, single-flight, chat-child stop/resume serialization, 5-min wake-rate floor, missed-wake coalescing (Build 4) |
| Snapshot, restore, export, playback, fork | ✅ | export/import round-trip (Build 1); quiesced snapshots, reversible restore, fork-with-lineage, trail list/verify/show (Build 5) |
| Policy provenance | ✅ | cryptographic founder identity (ed25519): `qorpera founder init` / `ratify`; `authority.toml` carries a detached signature verified at every policy read — unratified, tampered, or foreign-signed policy fails closed to all-gate; the sandbox sees only the public key; kernel policy writes re-ratify. Machines without an identity keep legacy semantics (opt-in, then enforced). Keys at rest are mode-0600 files, not OS-keychain — that hardening remains listed below. |
| Append-only trail | ✅ | kernel-only writes, hash chain, sandbox read-only; independently verifiable (`company trail verify`) |
| Reference-only secrets | ✅ | opaque references, kernel-side dereferencing, machine-local vault outside the folder |
| Founder escalation surviving a broken controller | ✅ | wake failure streak → kernel suspends schedule + posts founder-visible inbox item |

## Standing refinements (stated, not blocking the minimum)

- Kernel-signed per-request intents for the HTTP lane (parity with the model lane).
- Settings → Connections / Wake UI in base userland (terminal lanes exist).
- Founder key material in the OS keychain (currently mode-0600 files, same posture as auth.json); founder-signed GATE approvals (policy ratification is signed; per-gate approvals still rest on the machine-local kernel-trust lane).
- Inbound events (webhooks) and MCP server surface — optional kernel modules by ratified decision.
- Headless kernel operation (wakes while the shell is closed; founder-response and operation-completion wake causes become meaningful there).
- macOS/Linux sandbox verification beyond the network probe.
- Erase currently removes the folder + this foundation's machine state (connections, snapshots); desktop-kernel state under Electron userData becomes inert by path-keying rather than being deleted.
