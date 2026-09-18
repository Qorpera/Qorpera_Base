# Screen ordering and Company File denial closeout

Isolated source: `/Users/jonas/work/Qorpera_Base-screen-refusal-20260912`, branch
`codex/runtime-screen-refusal-20260912`, base `71a355d54`. No main checkout,
live SQL, node, NAS or providers changed. No migration is required; reservation
20260913000500 is unused. Root owns integration, bundle generation and deployment.

## Screen lifetime ordering

Evidence: `gates-v23-20260912/gate-c/NOTES.md` records a screen open with both
`qorpera_one_physical_screen_per_invocation` and "Screen lifetime must begin
with a current request" while physical open still completed. Gate R5 separately
records an old shared lifetime remaining open during later screen activity.

The source outbox selected one pending event per lifetime in random UUID order.
A newly opened lifetime could therefore be sent while the predecessor's queued
closing/closed events had not reached SQL. The unique index correctly refused
that second lifetime. The separate retention fallback then preserved its
requested event as unconfirmed, so its later ready event had no canonical
requested row. This is a concrete reproducible cause consistent with the
retained logs; the logs alone do not establish every historical occurrence.

The exporter now selects the earliest pending lifetime per physical screen and
admitted invocation. It drains that lifetime before advancing another on the
same screen, including closed-before-open ordering for equal timestamps.
Independent screens still progress; failed acknowledgement of an earlier
lifetime blocks only its own physical screen. The unique index, physical
controls, exact event replay and separate unconfirmed retention are unchanged.
It does not invent a closure, repair historical missing receipts, or infer
current physical readiness from archived observations. Noncausal/malformed
history continues to rely on SQL's validation and unconfirmed retention.

## Confirmed denial boundary

Evidence: gate C's staff-B read and expired-grant path calls received SQL42501,
but the model received TOOL_OUTCOME_UNCONFIRMED. The control transport discarded
the structured denial into a generic diagnostic; the native boundary correctly
classified all generic execution errors as potentially following effects.

The HTTP transport now brands only a fully read, bounded, valid standard
PostgREST HTTP403/code42501 envelope. It never retains or returns raw diagnostic
text. That brand describes rejection of one transaction only.

The Company File gateway promotes it to a tool denial only at these initial
admission points, before presence registration, object staging or canonical
commit attempts:

- `qorpera_read_company_path_v2` for company_read.
- `qorpera_list_company_paths_v2` for company_list.
- `qorpera_native_company_file_write_source` for the initial export lookup.
- `qorpera_check_company_path_mutation`, or the asset-write RPC's check action,
  before any write/mkdir/delete staging.

Only the five registered Company File tools recognize that promoted brand.
They return `denied` / `COMPANY_FILE_ACCESS_DENIED`, retain normal provenance,
recheck release authority and cache the result without reexecution. This is a
refusal of this invocation's admission, not a claim about earlier operation-key
attempts or a reason to retry with other authority.

All later prepare, verify, read-confirmation and commit errors remain unconfirmed,
even when a complete42501 proves that later transaction rolled back. Generic403,
malformed/truncated/stalled bodies, cancellation, transport errors and forged
error text also remain unconfirmed. Existing bounded PT409 head rebuilds are
unchanged; no new automatic retries were added.

## Verification

- Four focused suites: **166 tests passed**, including a real bounded HTTP
  transport → gateway → native boundary denial, exact call-id replay, redaction,
  text spoofing refusal, no object reads/writes before denied admission,
  post-staging42501 remaining unconfirmed and a committed effect with a lost
  response remaining unconfirmed without reexecution.
- Production outbox tests prove predecessor closure precedes a lexically earlier
  new lifetime, including the same millisecond; failed acknowledgement cannot
  be leapfrogged on the same screen; independent-screen progress is preserved.
- `node scripts/test-runtime-office-start.mjs --activation` passed on a disposable
  network-disabled PostgreSQL database with **220 migrations**. Added actual SQL
  proof uses the production outbox against the real unique index with reversed
  UUID order and identical timestamps: four canonical events, **zero retention
  fallbacks**, exactly one open lifetime, expected requested/ready history.
  Existing activation/replay/history/database-restart checks also passed.
  Physical desktop measurements remain fixtures; no live display is claimed.
- Final TypeScript, changed-file Biome and git diff checks passed.
- Evidence logs: `/tmp/qorpera-screen-refusal-tests-final.log`,
  `/tmp/qorpera-screen-refusal-typecheck-final.log`,
  `/tmp/qorpera-screen-outbox-sql.log`, copied beside the exported patch.

Root must run combined-source checks and regenerate the coherent bundle before
release. No frozen/generated manifests were changed in this lane. Existing
historical ambiguous operations remain for review; this patch does not relabel
or replay them. Temporary dependency/model-data links are excluded from delivery.
