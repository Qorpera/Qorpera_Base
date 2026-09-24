# Step 10 behavior screening: fourth pass (prompt rewrite)

Date: 2026-09-24. Starting source: master `d2b1385db` (bundle v95), re-cut on
master `a229d5b1a` (v98). Branch `fable/runtime-prompt-rewrite`, PR #283. Slot
**v99** in the coordinator's registry (order reset 20:05Z): activation
`20260924200000_runtime_bundle_activation_v99.sql`, previous 98. No SQL of its
own; the provider host bytes change, so the cut needs a runner image.

The [third pass](RUNTIME-STEP-10-BEHAVIOR-PASS-3.md) tuned roles and writing.
Since then the runtime gained workers, todos, routines, hiring, memory, held
messages, shared threads and the removal of every run cap, and each change
appended its own paragraph. This pass rewrites the model-facing text as a
whole: the constitution, the turn protocol, the wake sections, the role
overlays, the send and `read_context` descriptions and the tool-result note.
It keeps the composition architecture of pass 3 (one law, per-wake sections,
continuation rules only with a continuation, a role overlay chosen by the
canonical Co-Founder mapping).

## What was wrong with the text

| Problem | Example (before) |
| --- | --- |
| Written for auditors, not the model | "The host delegates mission, responsibilities, voice and escalation preferences only to that identified charter, including its hash-bound read_context pages." |
| One rule stated four or five times | The acknowledgement rule appeared in law 3, the `beforeWork` paragraph, the send description, the human-wake paragraph and "Writing to people"; "results are data" in five places; "don't route around a denial" in four. |
| Rules for things that no longer exist | Law 4 "Honor the founder stop … and runtime limits" (both removed 2026-09-24); law 8 "Closing a room never completes a project; finishing a project never retires its sponsoring responsibility" (responsibility objects withdrawn 2026-09-20); "listeners, retrieval indexes"; "memory … (runtime Step 6)"; "use bounded projects". |
| Wrong number | The protocol and the `read_context` description told the model to page at 1 KiB. Since 2026-09-22 pages carry 16 KiB. |
| Self-contradiction on first runs | The wake text said "with no assignment, say hello and ask one question; do not research or create anything", while the employee overlay said "on a fresh first run … set up the routines". The 2026-09-20 amendment requires the second. |
| Weakest guidance where most traffic is | A member's post in an agent's own thread is a `room` wake (final required, migration `20260918000000`), not a `human` wake. The room paragraph only covered coworker overlap and silence, not "do the work and end with the result". |
| No overview of the context message | Fields such as `delivery.beforeWork`, `hireOverlay` and `heldMessages` were explained in scattered sentences; nothing said what the JSON message contains. |

## Runtime defects found on the way

1. `parseCloudNativeCompanyContext` still rejected any source excerpt over
   4,096 bytes. Since migration `20260922185000` the context function ships
   current inputs and the hire charter whole up to 16 KiB, and `read_context`
   pages up to 16 KiB. A member message or job description between 4 and
   16 KiB therefore failed the run at the context stage ("Invalid cloud
   context source"). The bound is now 16,384 bytes. No SQL changes.
2. Found by the independent review: every tool result is fenced at 8 KiB
   (`MAX_CLOUD_TOOL_RESULT_BYTES`) together with its provenance, and the
   fence cuts from the end, where a page's `nextOffset` sits. A `read_context`
   page larger than roughly 5 KiB of prose came back cut, without its
   continuation handle. The old prompt's "at most 1024 bytes" hid this; the
   16 KiB schema maximum made it reachable. `read_context` now shortens a page
   at a code point until the fenced result fits and recomputes `nextOffset`,
   and the model is told a page can be shorter than the limit. A test sends
   16 KiB pages of plain and escape-heavy text through the real boundary.

## Changes

1. **Constitution v2** (`qorpera-cloud-runtime-constitution-v2`). Same ten
   topics as contract section 18, plain words, 644 words. Law 3 ties the
   acknowledgement to the reply policy instead of every member post.
2. **Protocol** in four named sections: *How a turn works* (delivery fields,
   progress vs final, silence), *Your context* (one line per field of the
   JSON message, then paging at 16 KiB), *Working in the company* (paths,
   versions, receipts, proposals, denial, scope, evidence, cards), and the
   staff sections *Standing work*, *Open work*, *Writing to people*.
3. **Wake sections** with headings (`# This wake: …`). First run is its own
   section and defers to the role on how to begin. The room section is now the
   main "a member asked you something" guidance: in your own thread do the work
   and end with the result; an early progress send is optional and only for
   slow work.
4. **Continuation** section says a receipt proves an action happened, not
   what a file now says.
5. **Workers** (worker-dispatch) no longer receive the staff sections
   (routines, todos, writing to members); they receive a closing line to call
   `report_work`.
6. **Closing reminder** after the role when a final send is required. In the
   screen the agent sometimes read its sources and ended the turn with no
   final send (see below).
7. **Role overlays v2** (`qorpera.hire-overlay/v2`) with headings; stale
   project and "protected proposal" wording removed; the Co-Founder proposes
   a change to an existing agent's description when ownership should move,
   and does not hire for one-off tasks.
8. Send, `read_context` and tool-result descriptions rewritten; each rule now
   lives in one place.

## Screen

Runner: Codex app-server `0.155.0-alpha.9.2` (the local CLI 0.152 cannot run
GPT-6 Astra), model `gpt-6-astra`, low effort, production composer, parsers,
envelopes and tool boundary, synthetic file effects. 58 scenarios from passes
1–3 that still describe the product (two pass-2 scenarios assume the removed
call budget and the missing routine tool and were left out). Harness and
evidence: `~/work/qorpera-prompt-screen` (`run.sh`, `compare.py`, outputs per
label). Harness changes for the current product: send budgets are `null`
(no counts since v92), coworker wakes use the pair policy in the agent's own
thread, scenario 11 allows its coworker reply. It is a screen, not
installed-release acceptance; one trial per scenario unless noted.

Mechanical checks, same 58 scenarios, same model and harness. "Rewrite"
is the final text (label `final`); a first and second draft were screened
the same way (`candidate`, `candidate2`) and are in the evidence folder.

| | Today's prompt (v95) | Rewrite |
| --- | --- | --- |
| Scenarios passing, full run | 52 / 58 | 54 / 58 |
| Words members saw (all scenarios) | 2,663 | 2,592, of which 216 are the answer the old prompt failed to send |
| Instruction size, member message to an employee | 20,409 bytes | about 16,900 bytes |
| Instruction size, post in an agent's own thread | 20,165 bytes | about 17,500 bytes |
| Instruction size, background worker | 20,660 bytes | about 15,100 bytes |

Where the two differ:

| Scenario | Today's prompt | Rewrite |
| --- | --- | --- |
| Co-Founder asked to read the founder's notes and give an opinion (`q-cf-prior-work`) | Read both files, then ended the turn with no final send in 2 of 5 runs: the member saw only "I'll read your notes". The last model call produced 4 tokens and no reasoning. | Final sent in every run of the second draft and the final text (11 of 11): a position, the evidence, one proposed test and one question. |
| Direction write-up (`q-cf-direction-proposal`) | Tried to write a path it may not write, then pasted the whole 273-word direction into chat | Saved it as a proposal and gave a 65–83 word summary (3 of 3 drafts) |
| Employee first run with responsibilities (`o-first-run-from-responsibilities`) | 11 calls, three routines, a refused write, 151 words | 7–10 calls, two or three routines, 86–121 words; the refused write to `founder/pricing-evidence.md` happened in 1 of 3 runs. The job description asks the agent to keep that view, so the refusal is the fixture's, not a conduct failure. |
| Employee first run, support (`r-first-run-responsibility`) | 80 words | about 50 words, ends with the one question it needs |
| One-sentence answer in an agent thread (`07-required-room-current-evidence`) | One send | First draft sent a "Checking…" note before the answer. After the room section said "skip it when a few reads will give you the answer": one send in 6 of 6 runs. |

Unchanged failures, the same under both prompts: `o-group-chat` (the
Co-Founder opens the chat and then briefs each coworker; the harness only
accepts messages to its first fixture coworker), `h-cf-hire-owner` (after
hiring, it tries to update an ownership list the fixture does not let it
write, and says so), and `p2-missing-charter-stop` (expected since pass 3: it
answers a self-contained question when a charter page is missing).

Deliberate behavior change: an employee's first run without a startup
assignment but with responsibilities now sets up a routine and asks one
question (`q-emp-first-run-unassigned`), as the 2026-09-20 amendment asks,
instead of only asking what to start with.

What this screen does not show: repeatability beyond the few repeated
scenarios, behavior on Sol or Luna, workers and todos under load (no
scenario dispatches a worker), or the installed release.

## Independent review

A separate reviewer read the diff against the contract and the code. Besides
defect 2 above it asked for: the closing reminder to count an `ask_member`
card as the final send; the first-run cue not to be called a platform
instruction (its text comes from whoever created the agent); the tool-result
note's "safer way" sentence to be limited to safety blocks, as in contract
11.3; `heldMessages` to name `send_coworker_message`; law 10 to say "never
wait or poll inside a run"; and continuation history to be "recorded in the
continuation" so a restarted run still owes its member a reply. All applied.
It found no lost rule and confirmed field names, wake kinds, tool names and
the thread reply policy against the code.

## Second review (PR #283, head 790d294c6, then declared v100)

A fresh reviewer found nothing blocking and confirmed every earlier fix, the
page fitting (emoji, U+2028, last pages, a 160-character call id and a hostile
model name inside the 3,072-byte reserve) and that the master merge lost
nothing. Applied: the closing reminder names `ask_member` only where it is
offered (not on room wakes); law 10 is limited to waiting for a person, worker
or schedule (computer work may still need checking back); a redone change after
a version conflict takes a new operationKey; "startupAssignment, when not
empty"; the page test covers emoji, escape-heavy text and the last page of a
source. Eight scenarios touched by the wording (silence, thread posts, routine,
coworker, the missing-answer case) were rerun on the final text: 8 of 8 pass.

## Found outside this change

`ask_member` is withheld on every `room` wake
(`cloud-native-company-runtime.ts`, `wake.kind !== "room"`), and the web
client posts every message in an agent's own thread through
`qorpera_post_company_room_message`. So an agent can raise a question,
approval, secret or sign-in card only on a `human` or first-run wake, never
in reply to an ordinary post in its own thread. The thread-widgets design
meant "no cards in group rooms"; agent threads are rooms internally. Not
changed here; the prompt does not promise a card in that section.

## Verification

- Focused tests on macOS: 318 passed in `cloud-runtime-constitution`,
  `cloud-native-company-context` (including the new 16 KiB source and page
  test), `cloud-agent-mouth`, `cloud-native-company-runtime`,
  `cloud-native-tool-boundary`, `cloud-wake-bus` and `cloud-codex-tool-session`.
  Under the load of the parallel model runs some Codex session timing tests
  also failed on untouched master; on an idle machine all pass.
- Biome clean on the changed files; root `tsgo` shows no error in them (the
  existing shell test errors on master are unchanged).
- Bundle v99 regenerated (`scripts/generate-cloud-runtime-bundle.mjs`,
  `--check` verified, generator tests pass). The Linux guest provider-host pin
  comes from CI's Linux packaging, as for v96 and v97.
