# The durable trail — on-disk format

**Status:** Reference for trail schema version 5. The validators are the
authority: `packages/shell/src/agent-runtime.ts` (`validTrailEntry`,
`validProvenance`, `auditHash`, `loadTrailAudit`) and
`packages/coding-agent/src/core/session-manager.ts` (append-only
enforcement). This document exists so an export can be read with no Qorpera
installation (build plan §3: the trail format is documented, versioned,
self-describing plain files inside the exportable environment).

## Files

One JSONL file per agent run at
`<company>/trail/<ISO-timestamp-with-:.-replaced-by-->_<uuid>.jsonl`.
Line 1 is the run header; every following non-empty line is one entry. Agent
runs accumulate into the trail without becoming company identity or lifecycle
objects. There is no mirroring layer, and compaction is disabled by forced
project settings (`.qorpera/settings.json`).

## Header (line 1)

```json
{"type":"session","version":5,"id":"<uuid>","timestamp":"<ISO>","cwd":"<abs>",
 "qorpera":{"actor":"controller|product-worker","attended":true,
            "autonomous":true,"label":"<name>","department":"<id>","worktree":"<id>"}}
```

`version` must equal 5 to resume; other versions require an explicit
append-only migration. `qorpera` is the trusted-host authority binding;
resuming a run with a different `actor`/`department`/`worktree` is refused.
`controller` remains the version-5 wire value for a normal company agent; it
is not a separate company actor.
Header max size: 64 KiB.

## Entry envelope

Every entry line carries:

- `type` — one of `message`, `thinking_level_change`, `model_change`,
  `branch_summary`, `custom`, `custom_message`, `label`, `session_info`.
- `id` — unique within the session (1–128 chars); `parentId` — `null` or a
  previously seen id (the session is a tree).
- `timestamp` — set by the host at receipt (equals `kernel.receivedAt`).
- `provenance` — exactly one of:
  - `{"source":"kernel","trust":"observed"}` — the legacy wire value for an
    observation written directly by the desktop host from what it observed;
  - `{"source":"child","trust":"assertion"}` — asserted by the agent
    child process. Message content (including thinking blocks) is in this
    class: attributable, hash-chained, but not host-verified against
    provider bytes.
- `kernel` — the version-5 wire name for the host integrity envelope:
  - `sequence` — 1-based, strictly increasing by 1;
  - `receivedAt` — host receipt time;
  - `previousHash` — prior entry's `hash`, `null` for the first entry;
  - `hash` — `sha256(previousHash + "\n" + JSON(entry without kernel))`,
    hex. `loadTrailAudit` re-verifies the whole chain on resume and refuses
    the session on any break.

Entry max size: 16 MiB. Only the host writes the file; the child submits
entries as `{"type":"qorpera_trail_append","token":…,"entry":…}` frames on
stdout, which the host validates, stamps, and appends.

## Per-type payloads

| type | required fields |
|---|---|
| `message` | `message` — the full model message: role, content array (text, `thinking` blocks with signature and redacted flag, tool calls/results), provider, model, usage, stopReason |
| `thinking_level_change` | `thinkingLevel` |
| `model_change` | `provider`, `modelId` |
| `branch_summary` | `fromId` (seen id), `summary` |
| `custom` | `customType` (+ free-form `data`) |
| `custom_message` | `customType`, `content`, `display` |
| `label` | `targetId` (seen id) |
| `session_info` | optional `name` |

## Qorpera custom entry types

Effect boundary (child-asserted, written at the authority layer):

- `qorpera_effect` — every classified tool call: tool, effect class,
  decision, gateId, attended flag, actor, behavior content-hash + signature
  status, host intent (serialized as `kernelIntent` in version 5).

Host-observed (`source:"kernel"` in the version-5 wire format):

- `qorpera_kernel_input` — founder input delivered to the child.
- `qorpera_kernel_model_request` — provider, model, request sha256, status,
  budget reservation, usage. (The host records the request identity and
  usage — not response bytes; see provenance note above.)
- `qorpera_kernel_founder_mutation` — authorized founder POSTs (authority,
  gate, inbox responses) with review decision and result.
- `qorpera_kernel_product_storage` — product worktree/bundle operations.
- `qorpera_kernel_gate_transition` — gate lifecycle changes.
- `qorpera_kernel_inbox_message` — inbox messages observed by the host.

## Reading a trail without Qorpera

Each file is plain JSONL: parse line 1 as the header, every other line as an
entry. To verify integrity, walk entries in order and check
`sequence`, `previousHash`, and
`hash == sha256(previousHash + "\n" + canonical-JSON(entry minus kernel))`
(canonical means the entry exactly as serialized on disk minus the `kernel`
key — reserialize with the same key order, or compare against a re-parse of
the original line with `kernel` removed).

## Guarantees and non-guarantees

- Append-only from the agent's side: rewrite paths throw for
  host-bound runs, the sandbox mounts `trail/` read-only, and the hash
  chain makes out-of-band edits detectable at next resume.
- Never lossily compacted; large payloads are subject to the entry size cap,
  not summarization.
- Child-asserted content is attributable, never reproducible (EVOLUTION §8.5)
  — the trail proves what the agent recorded, and the host envelope
  proves when and in what order, not that provider output was transcribed
  faithfully.
