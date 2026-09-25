# Runtime Step 6: agent memory (Grok Bot shape, company first)

Date: 2026-09-22, company first since 2026-09-24. Status: **source implemented
and unit-tested; bundle v85 declared; not applied live; Grok import
deferred**.

## Decision

Contract §5.4 and §15.1 originally described memory as retrieval indexes over
company state (profiles, logs, project, room and company facts). That shape
never shipped: the August Step 6 handoff (`codex/step6-memory-skills-handoff`)
stalled on scopes and eight owner gates, and until this cut the cloud runtime
composed no memory and advertised no memory tool at all.

On 2026-09-22 Jonas decided memory follows the Grok Bot notebook layout, so a
Grok Bot's memory export can be imported into a Qorpera company and a hired
Grok Bot keeps its notebook. Memory is the agent's own notebook, separate from
the transcript and from the company's own records; company facts stay in their
own Company File objects.

On 2026-09-24 Jonas decided memory is company first: "everything should be
company first, users are just bolted on". There is no per-member memory and no
member shard; the Grok Bot's user scope is not adopted. An agent's notebook is
company state in the Company File, owned by the company like the rest of the
agent's folder, and what an agent learns about a member is a fact in its own
notebook. The contract (§4, §5.4, §15.1, Order 6, gate 15) is amended in this
change.

## What is built

| Piece | Where |
| --- | --- |
| Notebook layout | `agents/<staffAgentId>/memory/profile.md`, `agents/<staffAgentId>/memory/log/YYYY-MM.md` in the Company File, company-owned; one fact per line `- (YYYY-MM-DD) <fact>`, notes as `[note]`-tagged log lines |
| Tools | `update_memory` (`action` write/forget, `fact`, `tier` profile/log/note) and `recall_memory` (`query`, `limit` 1–50) in `packages/runtime/src/cloud-memory-tools.ts`; no `scope` parameter, the tools only address the executing agent's own notebook |
| Writes | through `CloudCompanyPathGateway.mutate` with the exact expected version; deduplicated across the whole notebook (any tier, any month; the receipt says where the copy is); forget removes every current copy and reports how many, per file; up to three fresh re-reads when the database refuses a stale version (PT412, promoted by the gateway to `CloudCompanyPathVersionChanged`) or the head keeps moving, then a `conflict` receipt that saved nothing; a write past the profile or month size is a `full` receipt; a file that is not notes (over 32 KiB or not UTF-8) is skipped and named (`searched.unreadable`, forget `partial`, a write into it `unreadable`); a deleted file or folder is recreated against its tombstone version (`readTrusted` returns `kind: "absent"` with it); one operation key per (action, path, version, fact) |
| Search | recall and forget read the profile and every monthly file (eight at a time) (the trusted listing pages to its end and restarts if the company moves on between pages) and report `searched: { logMonths, oldestMonth }`; there is no search horizon (2026-09-25) |
| Composition | `composeCloudAgentMemory` builds the `memory` block of the turn context (before `hireOverlay`): whole profile (every fact a write accepted; a write keeps it within 6 KB; a profile another writer grew past the 768 KiB turn context degrades the block to `unavailable: too_large`, never the run), newest-first slice of the current and previous month (40 facts, 8 KB), notes older than seven days removed, a count of log facts not shown, exact object versions |
| Trusted reads | `CloudCompanyPathGateway.readTrusted` / `listTrusted` call the plain `qorpera_read_company_path` / `qorpera_list_company_paths` (service role, authority-checked, no model-read observation, no wake-work gate), so composition runs before the first acknowledgement and spends none of the run's 128 model reads; `HttpCloudCompanyPathControl` permits both RPCs |
| Workers | a worker of the same agent gets `recall_memory`; `update_memory` only when its dispatch allows Company File writes |
| Vocabulary | `20260924000000_runtime_observation_memory_tools.sql` adds the two tool names to `qorpera_record_runtime_observation`, restated on master's latest definition (`20260923012000`); record it before activating v85 |
| Constitution | item 8: memory is the agent's company-owned notebook and grants no authority; keep the profile small, log decisions and lessons, forget to correct; company facts belong in their own objects (the constitution stays within its 650-word bound) |

Failure mode: an unreadable notebook composes as `available: false` with a
safe error category and the run still starts. Memory is never a precondition
of company work.

## Deferred (in order)

1. **Grok Bot import.** Map a bot's agent memory onto the agent folder
   unchanged. A Grok Bot export carries no user memory, and the import creates
   none.
2. **Owner write rule.** Notebook files live under the agent folder under
   existing company authority; the tool addresses only the executing agent's
   folder in code. Other agents and members read a notebook like any other
   company object (today through `company_read`). Whether the folder gets an
   owner-only write rule in SQL is Jonas's call.
3. **Log file cap.** A month file is capped at 28 KB; a write past it answers
   "full" and asks the agent to forget older facts.

## Verification

- `packages/shell/test/cloud-memory-tools.test.ts`: layout, dedupe, no scope
  parameter (a `scope` argument is refused on both tools), exact-text forget
  with version, head-conflict retry, recall ranking and fallback, argument
  rejection, own-folder-only, composition and fading.
- `cloud-native-company-context.test.ts`: the `memory` block precedes
  `hireOverlay` and defaults to unavailable.
- `cloud-native-company-runtime.test.ts`: tool catalogs for company runs and
  workers; trusted notebook reads through the fake control plane.
- `cloud-company-path-control.test.ts`: the HTTP control permits the two
  trusted read RPCs.
- `supabase/tests/320_runtime_operational_observability.test.sql` records an
  observation for both tool names; `scripts/check-runtime-observation-vocabulary.test.mjs`
  keeps the SQL and TypeScript vocabularies equal.
- Not run here: any live turn. Bundle v85 has not been cut or applied.
