# Runtime Step 6: agent memory (Grok Bot shape)

Date: 2026-09-22. Status: **source implemented and unit-tested; bundle v71
declared; not applied live; member shard and Grok import deferred**.

## Decision

Contract §5.4 and §15.1 originally described memory as retrieval indexes over
company state (profiles, logs, project, room and company facts). That shape
never shipped: the August Step 6 handoff (`codex/step6-memory-skills-handoff`)
stalled on scopes and eight owner gates, and until this cut the cloud runtime
composed no memory and advertised no memory tool at all.

On 2026-09-22 Jonas decided memory follows the Grok Bot shape exactly, so a
Grok Bot's memory export can be imported into a Qorpera company and a hired
Grok Bot keeps its notebook. Memory is the agent's own notebook, separate from
the transcript and from company state; company facts stay in the Company File.
The contract (§5.4, §15.1, Order 6) is amended in this change.

## What is built

| Piece | Where |
| --- | --- |
| Notebook layout | `agents/<staffAgentId>/memory/profile.md`, `agents/<staffAgentId>/memory/log/YYYY-MM.md`; one fact per line `- (YYYY-MM-DD) <fact>`, notes as `[note]`-tagged log lines |
| Tools | `update_memory` (`action` write/forget, `fact`, `tier` profile/log/note, `scope` agent/user) and `recall_memory` (`query`, `scope` agent/user/all, `limit` 1–50) in `packages/runtime/src/cloud-memory-tools.ts` |
| Writes | through `CloudCompanyPathGateway.mutate` with the exact expected version; deduplicated; exact-text forget; up to three re-reads on a head conflict; one operation key per (action, path, version, fact) |
| Composition | `composeCloudAgentMemory` builds the `memory` block of the turn context (before `hireOverlay`): whole profile (4 KB budget), newest-first slice of the current and previous month (40 facts, 8 KB), notes older than seven days removed, counts of facts not shown, exact object versions |
| Trusted reads | `CloudCompanyPathGateway.readTrusted` / `listTrusted` call the plain `qorpera_read_company_path` / `qorpera_list_company_paths` (service role, authority-checked, no model-read observation, no wake-work gate), so composition runs before the first acknowledgement and spends none of the run's 128 model reads |
| Workers | a worker of the same agent gets `recall_memory`; `update_memory` only when its dispatch allows Company File writes |
| Vocabulary | `20260922230000_runtime_observation_memory_tools.sql` adds the two tool names to `qorpera_record_runtime_observation`; record it before activating v71 |
| Constitution | item 8 now names the three tiers and the rule "a fact about the company belongs in the Company File" |

Failure mode: an unreadable notebook composes as `available: false` with a
safe error category and the run still starts. Memory is never a precondition
of company work.

## Deferred (in order)

1. **Member shard (`scope: "user"`).** Refused with `scope_unavailable` in this
   cut. It needs the member-audience execution lane so an agent can write a
   member-private object; the tool schema already carries the scope.
2. **Grok Bot import.** Map a bot's agent memory onto the agent folder
   unchanged; map its user-scoped facts onto the importing member's shard with
   the learning assistant recorded. Blocked on 1 for the user part only.
3. **Owner scope.** Notebook files live under the agent folder under existing
   company authority; the tool addresses only the executing agent's folder in
   code. Whether other agents may read a notebook (today: yes, through
   `company_read`) and whether the folder gets an owner-only write rule in SQL
   is Jonas's call.
4. **Log file cap.** A month file is capped at 28 KB; a write past it answers
   "full" and asks the agent to forget older facts.

## Verification

- `packages/shell/test/cloud-memory-tools.test.ts`: layout, dedupe, scope
  refusal, exact-text forget with version, head-conflict retry, recall ranking
  and fallback, argument rejection, own-folder-only, composition and fading.
- `cloud-native-company-context.test.ts`: the `memory` block precedes
  `hireOverlay` and defaults to unavailable.
- `cloud-native-company-runtime.test.ts`: tool catalogs for company runs and
  workers; trusted notebook reads through the fake control plane.
- Not run here: the hosted-db SQL suite for the vocabulary migration, and any
  live turn. Bundle v71 has not been cut or applied.
