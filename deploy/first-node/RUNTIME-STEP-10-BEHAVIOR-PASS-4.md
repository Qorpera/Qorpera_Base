# Step 10 behavior screening: fourth pass (prompt rewrite)

Date: 2026-09-24. Starting source: master `d2b1385db` (bundle v95). Branch
`fable/runtime-prompt-rewrite`. No bundle version is declared here; the change
takes the next free slot from the coordinator's registry at merge time.

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

## Runtime defect found on the way

`parseCloudNativeCompanyContext` still rejected any source excerpt over 4,096
bytes. Since migration `20260922185000` the context function ships current
inputs and the hire charter whole up to 16 KiB, and `read_context` pages up to
16 KiB. A member message or job description between 4 and 16 KiB therefore
failed the run at the context stage ("Invalid cloud context source"), and a
16 KiB page failed the same way. The bound is now 16,384 bytes, with a
regression test for both paths. No SQL changes.

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

Mechanical checks, same 58 scenarios, same model and harness:

| | Today's prompt (v95) | Rewrite |
| --- | --- | --- |
| Scenarios passing | 52 / 58 | 54 / 58 in the full run; 55 after the room sentence below was tightened (3 of 3 repeats) |
| Words members saw (all scenarios) | 2,663 | 2,535, of which 160 are the answer the old prompt failed to send |
| Instruction size, member message to an employee | 20,409 bytes | 16,353 bytes |
| Instruction size, post in an agent's own thread | 20,165 bytes | 16,978 bytes |
| Instruction size, background worker | 20,660 bytes | 14,712 bytes |

Where the two differ:

| Scenario | Today's prompt | Rewrite |
| --- | --- | --- |
| Co-Founder asked to read the founder's notes and give an opinion (`q-cf-prior-work`) | Read both files, then ended the turn with no final send in 2 of 5 runs: the member saw only "I'll read your notes". The last model call produced 4 tokens. | Final sent in 6 of 6 runs: a position, the evidence, one proposed test and one question (160 words). |
| Direction write-up (`q-cf-direction-proposal`) | Tried to write a path it may not write, then pasted the whole 273-word direction into chat | Saved it as a proposal and gave a 72-word summary |
| Employee first run with responsibilities (`o-first-run-from-responsibilities`) | 11 calls, three routines, a write outside its remit, 151 words | 7 calls, two routines, 86 words |
| Employee first run, support (`r-first-run-responsibility`) | 80 words | 50 words, ends with the one question it needs |
| One-sentence answer in an agent thread (`07-required-room-current-evidence`) | One send | After tightening the progress-send sentence: one send in 3 of 3 runs (first rewrite sent a "Checking…" note first) |

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

## Verification

- Focused tests on macOS: 318 passed in `cloud-runtime-constitution`,
  `cloud-native-company-context` (including the new 16 KiB source and page
  test), `cloud-agent-mouth`, `cloud-native-company-runtime`,
  `cloud-native-tool-boundary`, `cloud-wake-bus` and `cloud-codex-tool-session`.
  Under the load of the parallel model runs some Codex session timing tests
  also failed on untouched master; on an idle machine all pass.
- Biome clean on the changed files; root `tsgo` shows no error in them (the
  existing shell test errors on master are unchanged).
- Not done here: `npm run generate:runtime-bundle`, the activation migration
  and the Linux guest pin. Every changed file is a bundle input (constitution,
  context composer, provider bootstrap, tool catalog), so the change needs the
  next free slot in the coordinator's registry and the usual re-cut before merge.
