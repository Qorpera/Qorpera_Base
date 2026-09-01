# Runtime Step 6: memory and skills

Date: 2026-08-28; retention correction verified 2026-08-30. Status: **company-shared services implemented and locally
verified against the frozen Step-2 baseline; richer scopes, final runtime
adoption and deployed acceptance remain incomplete**.
No deployment, infrastructure change, native adapter rewrite, central composer
change, constitution change, historical purge, or commit. The main track was
not contacted.

## Baseline and delivery

Assigned worktree: `/Users/jonas/.codex/worktrees/b2ee/Qorpera_Base-step2`.
Its starting HEAD was `2823637c0fd6def4cf21d3bc8e21f5f472f9d6b1` and lacked the
shared Company File gateway. It also contained unrelated runtime/UI changes.
Those changes were preserved, not rebased or replaced.

After authorization to integrate the shared baseline, a detached integration
checkout was created **inside the assigned worktree** at
`.artifacts/step6-memory-skills`. It contains:

| Input | Verified identity |
| --- | --- |
| Released base | `a0b692947d5c867353591b36172afcc997f0521e` |
| Frozen `runtime-step2.patch` SHA-256 | `1d92d0aef8f5a9028cb3752ef97adf1ba828dee637c795d3004fa17a7f71461d` |
| Frozen `runtime-step2-supplement.patch` SHA-256 | `eaf2b08931fec1254fce99ba4fcc9c14341b07084440c2a70670e9249926e30b` |
| Combined baseline tree | `aa364808b05165c088a20620ffe070adb012ba50` |

All 115 files in the combined frozen manifests were checked before Step-6
edits. The architecture contract and current Step-2 handoffs were read. The
later mutable Step-2 source checkout was not used as an unreviewed replacement.

The portable `step6-memory-skills/runtime-step6.patch` beside this handoff is
against that **combined baseline**, not the older assigned HEAD. Its manifest
records input hashes, changed files, and verification. Apply the two frozen
Step-2 inputs first, then this patch, or consume it on an identical combined
baseline. The integration checkout is the complete tested tree. Only owned
company-service files and this handoff are synchronized to the older assigned
checkout; shared gateway/SQL changes remain in the integration checkout and
patch to avoid overwriting unrelated work.

## Review findings addressed

| Finding | Implemented correction |
| --- | --- |
| 64-object collection ceiling, including tombstones | Resumable windows of at most 32 raw entries. Empty/nonmatching windows advance with an explicit continuation. No whole-collection enumeration before selection. |
| SQL's durable 128-path limit still broke traversal | Real gateway/SQL candidate preparation retains only selected sources. No gateway rotation, invented run, higher cap, or read-set clearing. |
| Sequential reads and repeated body-based version probes | Bounded parallel reads, batched metadata/ACL/version fences, and preparation deadlines; component and gateway request/latency regressions. |
| Cache eviction/invalidation lost matches or continuations | Window-local scores survive eviction and in-flight invalidation; selected bodies still require current canonical reads and final authorization. |
| Non-string memory kinds passed coercion | Closed literal discriminators; arrays/objects cannot become facts/profiles/logs, and logs require a valid calendar date. |
| Padded `.skill` convention and envelope mismatch | Readable `.md` with bounded JSON front matter; required host delivery-budget check before recording/release. Full native-envelope escaping is tested. |
| Gateway and session could name different companies/environments/runs | The real gateway exposes its immutable admitted identity; session construction checks all three fields before I/O. The cloud factory derives them directly from that gateway. |
| Private scope labels looked like implemented permissions | Gateways declare supported scopes. The real gateway supports only `company_shared`; unsupported scopes fail at construction and SQL fences verify canonical resource kind/scope. No replacement permission model is introduced. |
| Schema validation stopped at the service | Explicit human registration annotates existing versioned path resources. Immutable semantic proofs, the shared mutation-plan guard and a projection trigger enforce recognized object schemas for generic writes and imports. |
| Durable skill recording/replay was only a callback | The cloud factory wires concrete record/assert RPCs to the existing run-event table. Replay requires an existing exact record and current source/access checks; recomputing a forged body's hash/key cannot create a record. |
| Memory replay accepted changed text/title/hash and oversized cached payloads | Closed context/item/source/run schemas, required current byte/item allocation and canonical content verification. Bounded fingerprints accelerate unchanged replay but never skip live access/version checks. |
| Skill replay and catalogs did not bind names or use-when descriptions | Company catalog replay checks canonical headers; platform metadata checks the pinned manifest. Durable load records and semantic proofs now bind name/useWhen as well as body hash/length. |
| Skill-load audit events replaced run lifecycle status | The existing run descriptor excludes only the new skill_loaded audit event when deriving status. Existing lifecycle events and all other descriptor fields retain their prior behavior. |
| `history: preserve` was only a label; aged history remained eligible for shared GC | Human-approved collection policies are checked at publication. The same transaction records exact version lineage in the existing revision ledger; shared GC retains its file manifests/bodies independently of current files, approval or caches. |
| Synthetic tests were presented too close to cloud completion | Separate service, gateway/boundary, PostgreSQL and deployed acceptance evidence. Missing integrations remain explicit gates. |

## Implemented behavior

### Governed memory and indexes

`CompanyKnowledgeSession` binds to the gateway's immutable company/environment/
run identity, explicit host-resolved collections and the shared path parser.
Mismatched identities fail before I/O. `createCloudCompanyKnowledge` supplies
the real gateway, parser, memory service, skill service and durable recorder.
Collections and policies never come from file text or model arguments.
Governed Company File operations must provision parents.

`CompanyMemoryService` supports read, create, revise, forget, context retrieval,
index invalidation/rebuild and retained-context validation. The component
contracts describe company/project/room/member facts and agent profiles/logs.
**Only company-shared facts/playbooks are admitted by the real cloud adapter.**
The shared baseline has a company runtime audience, not an authorized private
audience or project/room/agent-private path resource. These scopes now fail with
`scope_unsupported`; labels cannot turn them on. Profiles/logs still require
agent-private collections, so their cloud execution remains blocked by that
missing dependency. Synthetic scope tests are not proof of private admission.
Writes preserve exact expected versions, operation keys, protected proposals
and the existing `qorpera.company-path-result/v1` receipt. No second effect
ledger or memory database is introduced.

`CompanyMemoryIndex` contains disposable lexical postings and source/version
references, not authoritative bodies, history or grants. It is partitioned by
company/environment. Live listings repair missed invalidations only within
visited intervals; unfinished crawls never delete unvisited ranges. Duplicate
or old notifications may evict entries but cannot restore old data. Cache
capacity can cause more canonical reads, not missing matches.

`rebuild` replaces one verified window after its final access/version fence.
An invalidation during the window prevents publication. Continue until
`next === null`; a successful page is not a completed corpus rebuild. Indexes
may be discarded without deleting Company File data.

### Forgetting and historical preservation

The host supplies `{ id, version, history: "preserve" }` as a **reference**, not
approval. A human with the existing resource authorization must approve that
exact policy on the collection using `qorpera_set_company_knowledge_schema`.
That operation uses resource CAS, rotates its version and invalidates old
grants. Missing, revoked or mismatched approval rejects a new forget, including
generic writes and protected-proposal application. It does not change current
content or invalidate indexes. Completed exact retries keep their original
receipt; a proposal alone creates no permanent historical hold.

A successful forget attaches `qorpera.knowledge-retention/v1` to the existing
immutable path revision in the snapshot/receipt transaction, under the existing
Company File and profile GC locks. The binding identifies policy/resource
versions, exact path and predecessor. Shared GC retains the tombstone and all
preceding path versions' file manifests and bodies. An imported initial version
is resolved from its verified parent tree and its descriptor is recorded once.
This preserves reconstructible **individual path versions**, not complete old
Company File snapshots or unrelated/private paths from those snapshots.

Committed bindings remain roots after later edits, generic deletion, policy
rotation, schema removal, proof-cache eviction and index rebuilding. Derivation
uses immutable revision descriptors, never current tombstones or mutable
semantic proofs. No release API or expiry is introduced. Releasing a hold,
physical erasure and legal-hold interaction require a separate policy decision.

Before the first hold, all historical file closure must still be verifiable.
This implementation accepts the existing canonical knowledge object contract:
at most 32 KiB, with a verified manifest plus its single body chunk (or an empty
file). Missing history/proofs, an unavailable imported origin, or larger legacy
files reject preservation; approval cannot recover already-purged bytes.
Adoption also rejects pre-existing forgotten objects without a committed hold.
There is no silent backfill or conversion. First preservation work is
proportional to previously unpreserved history, without a version-count ceiling.
Later holds validate only the new segment up to a committed checkpoint; the GC
derivation visits each distinct retained revision once. Production history-size
and GC-latency acceptance remain required.

### Bounded preparation and durable context

`CompanyFileKnowledgeGateway` requires immutable `identity`, explicit
`supportedKnowledgeScopes`, and the shared `beginPreparation`/`assertCurrent`
extensions. There is no fallback that
silently treats ordinary native reads as discardable candidates.

`CompanyKnowledgeSession.prepare` gives its callback a scoped reader, rejects
nested preparation and writes, then retains the callback's exact source set
before returning its value. It closes the reader on success, failure,
cancellation or uncertain acknowledgement. Closed readers cannot keep reading.

The shared extension uses three **service-only, run-bound RPCs**:

| RPC | Contract |
| --- | --- |
| `qorpera_read_company_path_candidates` | At most 32 explicit paths; current admission, lease, company/audience, ACLs and prior durable context are checked. Returns existing metadata shapes, not a new authoritative catalog. |
| `qorpera_list_company_path_candidates` | At most 32 authorized immediate children with existing snapshot/cursor rules. |
| `qorpera_retain_company_path_sources` | At most 64 checked paths, expected versions and retained paths. One transaction validates all candidate versions/access and prior context, then adds selected sources. The knowledge overload also checks at most 16 collection descriptors against registered path resources. Failure rolls back every addition. |

Original native read/list functions share the private metadata/page helpers
and **keep their existing retention behavior**. No preparation flag or RPC is
exposed as a native/model tool. Each preparation has a 64-path work bound;
service windows use at most 32 entries plus 16 collection roots. Candidate
bytes retain immutable hash verification and metadata checks before/after
storage access. Final retention also checks discarded candidates.

The existing 128-distinct-path **run context** limit still applies to selected
sources and ordinary native reads. It no longer limits discarded candidates
or tombstones. Tests retrieve a match after 160 nonmatches and rebuild past
128 candidates while preserving prior native sources. Emitting a 129th distinct
context source correctly fails; neither restart nor a fresh gateway resets
that fence. A lost retention acknowledgement withholds output and may
conservatively retain a source.

### Context and continuations

Memory is ranked lexically within the visited window, not globally across an
unscanned corpus. Items carry path, version, company/environment, scope, text
hash, original byte length, truncation status and `authority: none` /
`trust: untrusted_data`. Budgets measure the entire serialized contribution,
including attribution, cursors, UTF-8 and JSON escaping. Excerpts never split
a Unicode code point. Provider token accounting remains the composer's job.

`memory.context` and `skills.catalog` accept `maxScanEntries`, `maxPreparationMs`
and continuations. The default preparation ceiling is 5 seconds, configurable
up to 30 seconds; individual adapter calls also have a 30-second ceiling.
These are component resource bounds, not a chosen cloud latency SLO.

Continuations bind run, collections/scopes, query where applicable, snapshot,
page size and ranked-window position. Omitted matches revisit the same
authorized window. Revision or visibility changes fail closed instead of
skipping matches. A zero-item budget performs no enumeration. An insufficient
budget for the first item fails explicitly.

**Keep continuations in trusted host control state.** Only attributed items
and completeness information belong in model context. `next !== null` means
enumeration is incomplete even when the page has no matches. `hasMore` can
also mean a truncated excerpt, so it is not the pagination loop condition.
Do not silently perform an entire corpus crawl before every model response.

Retained memory and catalog replay now require a **current** host allocation:
`memory.assertContext(context, { budget, maxPreparationMs? }, signal)` and
`skills.assertCatalog(catalog, { budget, maxPreparationMs? }, signal)`.
Both return a validated, frozen snapshot; compose that result, not the mutable
input passed to validation. Skill `assertContext(context, signal)` also returns
a frozen snapshot and still checks the host's current `fitsContext` policy.
Closed schemas reject extra instruction/authority fields at the contribution,
item, run, reference and source boundaries.

Memory replay binds kind, title, date, full-text digest and original byte length
to the current canonical object. Included text must be either the exact full
body or a nonempty Unicode prefix marked truncated. Catalog replay binds each
name/useWhen pair to the current company header or pinned platform manifest.
The checks do not re-run ranking or certify a host's pagination history;
continuations remain trusted host control state.

Each service keeps at most 64 private SHA-256 validation fingerprints, with no
bodies or permissions. Entries are added only after successful final fencing.
Unchanged replay uses a metadata-only live fence. After eviction/restart or a
changed payload, memory reads canonical objects and catalogs read only bounded
headers, using the existing preparation/retention API. A cache miss never
makes a collection unavailable. Revoked access, stale versions and exhausted
current budgets still fail with a warm cache.

### Skill format, loading and recording

This slice selects readable Markdown with bounded JSON front matter for new
company/agent playbooks: `<collection>/<id>.md`.

```text
---
{
  "schema": "qorpera.company-skill/v1",
  "state": "active",
  "name": "Review",
  "useWhen": "When reviewing attributed evidence",
  "bodySha256": "<SHA-256 of the exact UTF-8 body>",
  "bodyBytes": 42
}
---
Markdown instructions follow the closing delimiter.
```

The example hash/length are placeholders; use `serializeCompanySkill` for a
valid object. Metadata is at most 4096 UTF-8 bytes with no padding; LF and CRLF
delimiters are accepted. Unknown metadata/authority fields and incorrect body
lengths/hashes are rejected. Metadata and body share one Company File version.
Forgotten skills contain a metadata-only tombstone.

Padding was not justified: the actual immutable store fetches whole
intersecting chunks, so it did not prevent storage from fetching body bytes.
Catalogs request only a bounded prefix, parse metadata and emit no instructions.
Prefix/chunk reads may contain unused body bytes. Existing `.skill`, `SKILL.md`
or historical files are **not automatically converted or removed**. Canonical
registration is implemented, but applying it to an existing company's content
requires an explicit adoption decision and verified bytes.

Loads require the exact catalog version and verify the entire body. They
never switch silently to a newer procedure or truncate instructions. Every
load must pass both its serialized `maxBytes` allocation and the required
host-supplied `fitsContext(context)` callback **before recording or returning
the body**. The callback must measure the actual destination envelope and
token allocation; skill content/tool arguments cannot select that policy.

The 24 KiB body storage limit does not enlarge the 8 KiB native result limit.
Subtracting fixed overhead from 8192 is insufficient: wrapping JSON inside
JSON and native HTML/line-separator escaping can expand it again. Tests compare
the host measurement with the real native serializer and reject oversized
escaped procedures before recording. That test adapter is not production
registration. A larger composer load channel remains an explicit owner
decision; none is added here.

`recordLoad` and `assertRecordedLoad` are required service callbacks, supplied
by the real cloud factory through `qorpera_record_company_skill_load` and
`qorpera_assert_company_skill_load`. The first appends an idempotent
`skill_loaded` event to `qorpera_execution_run_events`; the second never inserts.
Both bind the admitted run and recheck current permissions, schema, version
and verified name/useWhen/body metadata. Duplicate identical records are harmless; changed
records fail. The durable limit is 64 distinct loads per run, including after
restart. It does not purge any events.

Skill loads are audit events, not lifecycle transitions:
`qorpera_execution_run_json` excludes `skill_loaded` when selecting status.
The PostgreSQL regression checks the full descriptor before/after company,
platform and repeated loads, and verifies that existing lifecycle events still
advance status.

The stable `loadKey` is SHA-256 of newline-separated fields: schema
`qorpera.skill-load/v1`, company, environment, run, runtime bundle, reference
kind, collection id (empty for platform), object id, source version, body hash.
Fields reject line breaks. This replaces the earlier unreleased JSON-array
key encoding. Sources are checked before and after recording; replay also
rechecks the host delivery budget. Failure or revocation withholds the body.
The first recorded bundle version pins subsequent load records for that run;
this log consistency check does not substitute for runtime artifact admission.

Platform skills use a host-verified, defensively copied manifest pinned to the
run's runtime bundle. Bodies load lazily and must match its exact hash/length.
Platform write/revise/forget requests fail before gateway calls. Company and
platform references remain distinct even when names/ids coincide. Skill
content cannot install tools, grant permissions or alter runtime authority.

## Schemas, interfaces and migration

| Schema/interface | Shape |
| --- | --- |
| `qorpera.company-memory/v1` | `.json`; active kind/title/text and date for logs; forgotten previousVersion/reason/retentionPolicy. |
| `qorpera.company-skill/v1` | `.md`; JSON front matter plus Markdown; one exact object version. |
| `qorpera.memory-context/v1`, `qorpera.skill-catalog/v1` | Bound run, attributed items, scanned/hasMore and host-only next cursor. |
| `qorpera.knowledge-scan/v1` | Bound collection position, snapshot, after path and page size; no grant. |
| `qorpera.memory-continuation/v1`, `qorpera.skill-continuation/v1` | Scan plus ranked-window offset/digest and query/platform enumeration binding. |
| `qorpera.skill-context/v1`, `qorpera.skill-load/v1` | Complete body contribution and durable load-record contribution respectively; source/version, name/useWhen, hash and loadKey. The record also carries bodyBytes, never the body. Neither is an authorization receipt. |
| `CompanyFileKnowledgeReader`, `CompanyFileKnowledgePreparation`, `CompanyFileKnowledgeGateway` | Structural consumer of the real shared gateway, including batch fences and sealed preparation. |
| `createCloudCompanyKnowledge` | Concrete cloud factory deriving run identity and wiring canonical collection fences, semantic verification, durable load recording and replay verification. No tool registration or context composition. |
| `qorpera.knowledge-proof/v1` | Derived body-free validation metadata on an existing immutable-file proof, including active skill name/useWhen and body hash/length, bound to exact UTF-8 bytes/hash. Rebuildable, never a read grant. |
| `qorpera.knowledge-retention/v1` | `change.knowledgeRetention` on an existing committed path revision: exact path, approved policy/resource versions, predecessor version and optional enrolled-origin descriptor. File references only, no duplicated bodies or permissions. |
| `PlatformSkillBundle` | Pinned manifest and read-only lazy loader. |

Migration `20260828160000_company_knowledge_preparation.sql` adds the three
service-only RPCs and private helpers, and factors existing read/list wrappers
through them. It depends on the complete frozen Step-2 migration chain. It adds
no tables, alternate authorization, retention policy or purge.

Migration `20260828170000_company_knowledge_governance.sql` adds:

- Nullable `knowledge_kind` (`memory`/`skills`) and approved
  `knowledge_retention_policy` on existing path resources, plus nullable derived
  `knowledge_metadata` on existing verified-file proofs. Forgotten metadata
  includes its policy reference so generic writes cannot bypass approval.
- Human-only `qorpera_set_company_knowledge_schema(environment, path, kind,
  expectedVersion, retentionPolicy = null)`. It delegates authority/CAS to the current resource setter,
  rotates the resource version and invalidates old grants. Regrant explicitly.
  Registration checks existing recognized files atomically; it neither rewrites
  nor deletes them. Omitting the policy grants no preservation approval. Removal
  of a registration also requires that explicit API, and releases no existing hold.
- Service-only `qorpera_verify_company_knowledge_file`, binding strict semantic
  validation to the existing verified manifest's exact file hash and byte count.
  The gateway calls it after immutable verification and before publication.
  Other ingest workers must obtain this proof before publishing registered data.
- Schema checks in the shared mutation-plan path (including proposals/approval)
  and a projection insert/update trigger. Only immediate lowercase object ids
  with `.json`/`.md` are managed; unrelated files remain ordinary content.
  Collection aliases cannot bypass the guard. Tombstone writes must name the
  expected predecessor and an approved policy; agent profiles/logs cannot use shared/member scopes.
- A private revision-publication trigger recording committed preservation and
  two indexes on existing revisions for opaque-version lookup and hold roots.
  The shared additional-retention function includes exact historical file roots;
  existing snapshot and non-knowledge retention behavior is unchanged.
- A six-argument source-fence overload adding canonical collection validation;
  ordinary native callers keep the five-argument function.
- Two skill-load RPCs, a private validator, the `skill_loaded` event type and a
  partial unique `(run_id, loadKey)` index on the existing run-event table.
- A replacement of the existing run-descriptor function preserving all fields
  and event behavior except that skill-load audit events do not change status.

The stricter replay APIs and unreleased load/proof metadata shapes must be
adopted together with this service and SQL patch. Older draft load records
without name/useWhen are rejected; no historical record is silently rewritten.

No new body store, separate policy/grant store, retention period, dependency or lockfile.
Both migrations depend on the complete frozen Step-2 migration chain.

Resource limits: 32 KiB stored objects; 16 KiB memory text; 24 KiB skill body;
16 collections; 32 raw scan entries; 64 preparation paths; contribution bounds
up to 64 KiB/64 items; 64 platform catalog entries and durable distinct skill
loads per run.
These are not collection-size ceilings or retention periods.

## Verification

All results below use synthetic data and the isolated integration checkout.

| Layer | Result | What it establishes |
| --- | --- | --- |
| Company services | **117 tests passed** in memory, skills and runtime-lock files | Scope/cross-company isolation, identity misbinding, revoked access/policy approval, stale writes/receipts/proposals, forgetting/history, cache races, rebuilds/pagination, current replay budgets, canonical payload/header validation, immutable snapshots/platform skills and required durable replay. Authority/storage/recorder dependencies are synthetic; their in-memory history is not GC evidence. |
| Shared gateway and native boundary | **142 tests passed** in path gateway/control and native tool authority/boundary files | Real gateway/factory/service/immutable-store/boundary orchestration with simulated RPC/storage, canonical collection binding, semantic-proof calls, durable record/assert wiring, retention failures, request counts and exact native-envelope checks. |
| Disposable PostgreSQL | **84 migrations applied; 3 suites passed**: 160 native identity, 270 object continuity, 290 path gateway | Real admission/lease/ACL/CAS/proposal transactions, canonical schema registration/write rejection, governed preservation after 31-day aging, actual GC claims/deletion authorization, policy revocation, proof/cache independence, complete load/replay metadata and preserved run lifecycle status. Storage and passage of time are synthetic; candidate traversal and enrolled-origin cases explicitly seed synthetic projection state. This is not deployed or full cutover acceptance. |
| Complete repository check | **`npm run check` passed** | Formatting, pinned deps, imports, cloud boundaries, shrinkwrap/install lock, complete TypeScript and browser-smoke checks on the verified integration baseline. |

Focused commands, from their package directories:

```sh
# packages/company
node ../../node_modules/vitest/dist/cli.js --run test/company-memory.test.ts test/company-skills.test.ts test/company-runtime-lock.test.ts
# packages/shell
node ../../node_modules/vitest/dist/cli.js --run test/cloud-company-path-gateway.test.ts test/cloud-company-path-control.test.ts test/cloud-native-tool-boundary.test.ts test/cloud-native-tool-authority.test.ts
```

SQL verification used the repository's pinned `POSTGRES_IMAGE`, `bootstrap.sql`,
all sorted migrations and the three named suites in a disposable local Docker
database, removed afterward. Logs are under the assigned worktree's
`.artifacts/step6-verification`; this revision's summary is
`retention-20260830/summary.json`. The container had no published ports or network.
`npm run test:hosted-db` is the repository's
broader SQL runner; this handoff does not claim its entire suite was run.

Ignored model data was hydrated with documented `npm run hydrate:model-data`
after `npm ci --ignore-scripts`. No tracked model source, dependency or lockfile
changed. The green check applies to the verified integration baseline, not a
claim that the older dirty assigned checkout was rebased. No real provider
call, paid token, full Vitest suite, production SQL, build, release or commit.

After synchronization, the older assigned checkout also passed all **114
memory/skill tests**. Its full check remains non-green with the same **10
unrelated Cloudflare catalog TypeScript errors**: `openai-completions` is absent
from the generated Cloudflare provider groups, and existing AI tests refer to
the absent `workers-ai/@cf/moonshotai/kimi-k2.6` entry. No provider code or tests
were weakened to hide that drift. All 67 unrelated changed files were checked
byte-for-byte and preserved. The complete green baseline is the isolated
integration checkout and the patch's declared prerequisite tree.

### Request counts and latency

One collection, eight small candidates, one selected item, four concurrent
reads and a deterministic 20 ms per simulated transport invocation:

| Actual gateway path | Control RPC calls | Immutable storage GET calls | Simulated elapsed |
| --- | ---: | ---: | ---: |
| Cold memory window | 23 | 16 | 300 ms |
| Warm memory window | 9 | 2 | 220 ms |
| Cold replay of the selected memory after service restart | 5 | 2 | 140 ms |
| Warm replay of that memory | 1 | 0 | 20 ms |

Component-only tests separately count 8 cold / 1 warm range reads, one listing
and five explicit fences, at 160 / 140 ms. Catalog preparation uses eight
bounded-prefix reads and a 160 ms component ceiling. A serial cold preparation
exceeding its 150 ms allocation is cancelled without releasing partial context.
Replay component tests measure eight cold canonical memory reads / zero warm
reads at 100 / 20 ms, and one cold catalog header / zero warm reads at 80 / 20 ms.
Cold checks use three fences with four concurrent reads; warm checks use one
live fence. Replaying under a shorter deadline withholds output.

The shared `assertCurrent` batch now makes one metadata transaction and zero
storage GETs; four-byte body probes have been removed. Before/after metadata
checks around byte reads remain. Further batching belongs in the shared
gateway with the same exact paths, current actor/ACLs, immutable verification
and final group fence.

These are measured component/gateway invocations under a fake clock, **not
deployed HTTP counts or a latency SLO**. The production object transport can
add authorization/network calls. Real storage latency, snapshot churn,
revocation races and tokenizer/assembly costs remain acceptance work.

## Required owner integrations and remaining gates

1. **Adopt this shared baseline/extension.** Use `createCloudCompanyKnowledge`
   with the admitted gateway, registered collections, approved retention policy,
   pinned platform bundle and actual `fitsSkillContext` allocation. The factory
   wires real record/assert RPCs; no test adapter is a production dependency.
2. **Complete current scope enforcement.** Step-2 native execution has a
   company audience and rejects private paths. Its member-private rules do
   not implement room/project/agent-private or authorized private-audience
   execution. Richer labels in this package are not those permissions.
   The cloud gateway and SQL reject these unsupported scopes. An approved
   shared audience/ACL contract is required to enable them; this track does not
   invent one or change central runtime authority.
3. **Apply explicit collection registration.** The canonical schema mechanisms
   are implemented and locally tested, not deployed. Provision authorized
   resource roots, verify any existing immutable bytes, register each kind and
   its separately approved preservation policy, and
   regrant against the new resource version. Other ingest paths must use the
   verifier. Semantic proof can be rebuilt from the same bytes without changing
   file versions or load events. Never silently convert existing content.
4. **Wire context/tools and replay.** Composer owners assign output, scan,
   tokenizer and latency budgets; bind `fitsContext` to the actual codec.
   Before every model request, prewarm, replay or compaction, call memory
   `assertContext`, skill `assertCatalog`/`assertContext`, and in-process
   `assertLoaded` as appropriate. Supply current byte/item budgets to memory
   and catalog replay, and compose only their returned frozen snapshots.
   Keep cursor/control state out of model content. Persist/restore source versions in canonical
   run context. Changed/denied sources require recomposition or refusal.
5. **Pin actual runtime artifacts.** The bundle/manifest must be supplied by
   the runtime owner from approved artifacts. SQL records and pins the supplied
   bundle version across loads; it cannot prove a platform body belongs to a
   runtime artifact without the owner's manifest. The host verifies pinned
   platform hashes/lengths; the event itself grants no authority. Final native
   tool/context/recovery wiring remains owner work, despite concrete recorder
   implementation here.
6. **Connect committed change events.** Map the existing change plan's path,
   resulting version, company and environment to `CompanyMemoryChange`.
   Missed events are repaired by current listings; cache deletion is safe.
7. **Approve retention/adoption policy.** Forget requires an explicit versioned
   `{ id, version, history: "preserve" }` policy matching the human-approved
   canonical collection binding. It creates a governed tombstone and retains
   exact historical path versions through shared GC roots. Policy approval is
   not an automatic hold on every collection write before forgetting; history
   must still be present and verified when its first hold commits. Decide how
   to adopt unsupported or unavailable legacy history, approve protected
   forgetting, and separately govern any erasure/legal-hold/release mechanism.
   No period, purge, automatic conversion or silent release is introduced.
8. **Accept deployed behavior.** Run multi-member/cloud tests with clients
   closed: real scoped access/revocation, generic schema rejection, stale
   CAS/proposals, durable load/replay, index restart rebuild, native context
   reconstruction and realistic transport/latency budgets. Shared wire errors
   currently collapse stale versions/snapshots and access failures; this layer
   reports `access_unavailable` or `operation_unconfirmed` rather than inventing
   safe retry semantics.

These are substantive owner implementation and acceptance gates. This slice
does not claim completion of runtime-contract launch gate 15.

## Changed files

- `packages/company/src/company-knowledge.ts`, `company-memory.ts`,
  `company-skills.ts`: services, schemas, context and indexes.
- `packages/company/src/index.ts`, `packages/company/CHANGELOG.md`: exports
  and unreleased changes.
- `packages/company/test/company-memory.test.ts`, `company-skills.test.ts`,
  `fixtures/company-knowledge.ts`: synthetic component verification.
- `packages/shell/src/cloud-company-path-gateway.ts`,
  `cloud-company-path-control.ts`, `cloud-company-knowledge.ts`: real preparation,
  canonical schema/identity fences, cloud factory and durable load adapter.
- `packages/shell/test/cloud-company-path-gateway.test.ts`,
  `cloud-company-path-control.test.ts`, `packages/shell/CHANGELOG.md`: gateway
  contracts, regressions and unreleased changes.
- `supabase/migrations/20260828160000_company_knowledge_preparation.sql`,
  `20260828170000_company_knowledge_governance.sql`,
  `supabase/tests/290_company_file_path_gateway.test.sql`: SQL extension and
  transactional isolation/schema/retention/load-record regressions.
- This handoff. Delivery patch/manifest files are packaging artifacts, not runtime state.
