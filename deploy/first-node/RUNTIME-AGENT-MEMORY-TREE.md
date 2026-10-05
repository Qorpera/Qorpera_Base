# Agent context as a folder of summary trees

Status: **design for approval. Nothing is built.** Jonas asked for this design on 5 October 2026, after reading Victor
Taelin's OptChat design (https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449). No code, migration
slot or SQL test number is taken until he approves it. Part 1 is the short version (a 10-minute read). Part 2 is the
technical spec. Where this page and `QORPERA-RUNTIME-CONTRACT.md` differ, the contract governs until the amendment in
§16 is ratified.

Revised on 5 October:
- **Company-first and agent-first, with no compromise.** Members are not a boundary. Everything is stored as if all
  members were one, and every agent may read every conversation (§9, §15).
- Jonas said yes to both open questions: the tree replaces the notebook's diary and "the last 32 messages" (§11), and
  old copies of summary files are pruned after 7 days (§10).
- **Widened.** Jonas: "This isn't just memory, it's a shared unlimited context window in the company folder between
  all agents that replaces the current context window entirely." And the work should not sit in the log itself, but
  be something an agent can open, "like clicking into a file in a folder". So the tree is now the agents' whole
  context, the work inside a run included. The M steps of §14 are the first version, unchanged. The W steps widen it.

# Part 1: the short version

## What we want

One context for every agent that never runs out and never rots.
- An agent remembers a whole conversation, however long, and can look up the exact words.
- It can open any work done before, its own or another agent's, like opening a file.
- A long task does not make it slower, dearer or more confused as it goes.
- Nothing depends on which AI model runs it, which member pays, or which machine it runs on. A restart loses nothing.
- Every agent in the company shares it.

## How it works today

Every time an agent answers, it starts from scratch. Our runtime puts together what it sees:
- its instructions, its tools and its job;
- its notebook: a small profile page, plus a diary of dated facts from the last two months;
- the **last 32 messages** of the conversation, each cut to 2 KB.

Anything older is gone, and no tool can look it up. The company's vision is only read when the agent is told to open
it.

Then, while it answers, Codex (the program that runs the AI model) keeps its own record of the work: every tool it
used and every result. That record grows until Codex shrinks it on its own. It lives in one program, for one model and
one login. If the machine restarts, it is gone, and the answer stops. When the answer is done, it is thrown away.

## The idea

**A folder of logs.** Each conversation gets a folder in the company folder:
- one log of the **words**: every message and card;
- one log of **work per answer**: every tool the agent used while answering, and what came back. The agent's reply
  links to it;
- a helper's work gets its own log, inside the step that sent the helper off.

**Each log is a summary tree.** A cheap, fast AI model writes a one-line summary of each entry. Then it merges two
neighbouring lines into one line, two of those into one, and so on. The bottom holds every entry, word for word. Each
level up covers twice as many entries, still with one line.

**A view of fixed size.** New entries show up one line each. Older ones show up as lines that each cover 2, 4, 8 or
more. Every line has an address, like `2184+8`: 8 messages, starting at message 2184. The agent can **zoom** into any
line. It then gets the two lines below it. At the bottom it gets the original words.

A view could look like this:

```
0+512|Jonas founded Bageriet with the Co-Founder: an organic bakery in Aarhus, wholesale first, cafés later. …
512+256|Jonas rejected the café plan for 2026 ("no rent before we sell 500 loaves a day"); hired Sales. …
…
1022+1|Jonas: Make the vision shorter. Five lines at most.
1023+1|Co-Founder: Draft 3 of the vision, in five lines: …
```

**Every request is built from the folder.** Each time the AI model is asked for its next step, it gets:
1. **The head:** the company's vision and the agent's own job and profile page. It is always there and the same for
   every member. It takes the place of instruction files like `AGENTS.md`.
2. **The words:** the view of the conversation it answers in, large, and short views of its other conversations.
3. **The work so far in this answer:** its newest steps in full, and its older steps folded into summary lines.

Work from earlier answers stays closed, like a folder you have not opened. It costs nothing until the agent zooms into
it.

Why this works:
- **A request never grows.** A long conversation or a long task costs the same per request as a short one.
- **No context rot.** Work never crowds out the words, and old work folds into lines, so the agent does not drown in
  old tool output.
- **Nothing is lost.** Zoom brings back the exact words, or the exact work.
- **Nothing depends on the run.** The context lives in the folder. Another model, another member's login or another
  machine reads the same folder. A restart costs only the time to start again.
- **The start of each request rarely changes.** The AI provider can reuse its stored copy of it (its "cache"), which
  makes answers cheaper and faster.

## What each agent sees

- **One tree per conversation.** An agent's own thread has one tree, and each group chat has one. A group chat's tree
  is written once and shared by every agent in it. That costs less than one copy per agent, and agents who were there
  together remember the same thing.
- **An agent sees all of its conversations at once.** The one it is answering in is shown large. Every other
  conversation it takes part in is shown as a short summary below it. So in its thread an agent remembers what was
  decided in its group chats, and the other way round.
- **The Co-Founder** also sees a short summary of every other agent's thread. These are Jonas's "branches".
- **Any agent can zoom into any conversation in the company**, and into any work done in it.
- **A helper starts from what its agent saw**, not from nothing. It shares the agent's cache, so that costs little.
- **The notebook** keeps its small profile page, now as part of the head. The diary goes, because the tree remembers
  (decided 5 October).

## Company first

Everything in a tree belongs to the company, as the conversations do. **The tree is written as if all members were
one.**
- No summary, view or zoom depends on which member asked, wrote or pays.
- Every member can open every tree and every work log, as they can read every conversation.
- Every agent can read every conversation's tree. What its view shows first is a choice of what matters most to that
  agent, not a permission.
- Group chats are company-wide too. Who is in a group decides who takes part, not who may read.

## Who pays

- The summaries are written by GPT-6 Luna at low effort. It is the same model that does auto-review today.
- The run that did the work writes its summaries, on the same login that paid for the run. So the member who started
  the work pays for its summaries, as the founder rule says. **No login is ever swapped.**
- Short entries (under about 512 bytes) need no model call: the entry is its own line.
- If that login hits its usage limit, the summaries wait. The next run in that conversation writes them, on its own
  login, as part of its own work. Until then the view shows "not summarized yet, zoom it", and the agent can still
  open the original.
- Expected cost: one or two small model calls per long entry, mostly read from the cache. We will measure it.

## Erasing

- A summary line is made from the entries under it, plus at most 31 entries just before them. So when a message is
  erased, every line made from it is erased as well, and rebuilt without it. The old copies of those summary files
  are wiped with the folder's existing erasure tool.
- The helper reads those earlier entries themselves, never their summaries. So an erased fact cannot travel on from
  line to line.
- **Work logs follow the same rule.** When a file is erased, every step that read it, wrote it or named it is erased,
  and so is every copy of that step another agent opened. Their summary lines are rebuilt. An owner or admin can also
  erase one step, as they erase a message. A run that is still working keeps what it has until it ends; then the
  erase happens.
- **Today there is no way to erase a single message.** We build it before the tree is switched on for real
  companies. Owners and admins may erase, as they can erase files today.
- When an agent or a group chat is deleted for good, its trees and work logs go with its folder.

## Where it lives

The trees are ordinary files in the company folder, next to what they belong to:
- `agents/<agent>/memory/thread/` holds an agent's thread;
- `agents/groups/<group>/memory/` holds a group chat;
- `runs/<run>/` inside either holds the work of one answer.

Only the platform writes them. Members, agents and machines read and search them like any other company file. The
messages themselves stay where they are today, in the conversation. A summary file only points at them.

A summary file is rewritten as its summaries grow. An old copy is thrown away 7 days after a newer one replaced it, as
we do with old git objects. The copies are rebuilt data, so nothing is lost.

## How we prove it helps

We measure on the Qorpera Live Test company, each time against how it works today:
- **Memory.** A scripted conversation of 300 messages with 20 planted facts, decisions and corrections. Then 20
  questions about them. The agent should answer at least 16.
- **Long work.** A task of at least 150 steps, where facts found early are needed at the end. It should use at least
  9 of 10, and read the same files again less often than today.
- **Swaps and restarts.** The memory test again, while we change the model, the paying login and the machine along
  the way. The answers should be as good as without the changes.
- **Cost.** Tokens per answer, the share read from the cache, and what the summaries cost.
- **Speed.** Extra seconds per answer, from waiting for summaries and from zooming.

## The steps

M steps build the tree of words. W steps make it the whole context.
1. **M0.** A short test on the test machine, with our Codex as it is today: check that the provider reuses its cache.
2. **M1.** Trees of words for agents' own threads, on the Live Test company only.
3. **W1.** Work logs for every answer, that agents can zoom into, with erasing.
4. **M2.** Measure and tune.
5. **M3.** Erasing a single message, with its summaries. Then the 7-day cleanup of old copies.
6. **W2.** After your yes: check that our patched Codex accepts a request we built. Then every request built from
   the folder. Measure long work and swaps.
7. **W3.** The head.
8. **M4.** Group chats, each agent's other conversations, and the Co-Founder's branches.
9. **W4.** Helpers start from their agent's view.
10. **M5.** Switch it on for every company, and shrink the notebook.
11. **W5.** An answer that is cut off goes on from where it was. An answer that hits a usage limit pauses.
12. **W6.** Coding sessions. Claude Code cannot be changed, so on a Claude login the folder is given at the start of
    each answer only.

## Decided by Jonas (5 October)

1. **The tree replaces the agent's diary**, the dated facts and short notes in its notebook. It also replaces "the
   last 32 messages". The small profile page stays.
2. **Old copies of summary files are thrown away 7 days after they are replaced**, as we do with old git objects.
   They are rebuilt data. Erasing a message still wipes its copies at once.
3. **Company first, with no compromise.** Group chats are company-wide. The Co-Founder sees every agent's thread. Any
   run writes missing summaries on its own login. Owners and admins erase messages, as they erase files.
4. **The tree is the agents' whole context**, shared by all agents in the company folder. The work sits in its own
   logs, which an agent opens like a file in a folder.

## Needs Jonas's yes

None of these blocks the first steps (M0, M1, W1, M2, M3). Until you say yes to item 1, M1 just runs without its own
cache name.
1. **Our Codex patch names the cache, and builds every request.** Today our change to Codex may only change tool
   results.
   - From M1, it would give each request a fixed cache name, so a new answer can reuse the cached start of the last
     one (§6.2).
   - From W2, it would replace all that the model is sent.

   It still cannot change the model, the tools or Codex's own rules (§6.3, §16).
2. **An answer that is cut off goes on** from its last saved step (W5). Today it stops and waits for review (§12).
3. **An answer that hits a usage limit pauses** (W5), and goes on with the same login when the limit resets. Today it
   fails. It never moves to another login (§12).
4. **Pins instead of the profile page** (a proposal): pin any message or line into an agent's head. The profile page
   stays until you decide (§11).

# Part 2: technical spec

Paths below are relative to the repository root. `C:n` is a line of `QORPERA-RUNTIME-CONTRACT.md`. `mig/` is
`supabase/migrations/`, and `rt/` is `packages/runtime/src/`. Line numbers are from master `215c2798a`.

## 1. Facts this design rests on

**How a run is built today.**
- Every run is a new, ephemeral Codex thread (`ephemeral: true`, `rt/cloud-codex-tool-session.ts:1838-1853`). A warm
  Codex process may serve the next run, but each run starts a new provider thread (C:2779-2780).
- What reaches the model, in order:
  1. Codex's own base instructions. Nothing overrides them.
  2. The tools, as one `qorpera` namespace of dynamic tools (`rt/cloud-codex-tool-session.ts:1850`). They are not MCP.
  3. Developer instructions: the tool-result rules (`rt/cloud-native-tool-boundary.ts:23-34`) and
     `compileCloudNativeCompanyInstructions` (`rt/cloud-native-company-context.ts:553-574`). These are core protocol,
     wake-kind rules, continuation rules, closing protocol, a JSON binding of company, agent, version and bundle ids,
     the role text and a closing reminder. They hold no timestamps or run ids.
  4. One user message holding the JSON prompt (`rt/cloud-native-company-context.ts:595-663`). Its keys, in order:
     schema, identity, `observedAt`, presence, delivery, wake, current inputs, history, coworkers, job, continuation,
     open work, skills, memory and the hire overlay. It is capped at 768 KiB.
- `AGENTS.md` is written but never loaded (`project_doc_max_bytes=0`, `rt/cloud-codex-tool-session.ts:281`).

**History today.**
- The newest 32 message and card events of the session, read from `qorpera_session_events` and listed oldest first
  (`mig/20260828022000_runtime_company_rooms.sql:1031-1056`). Each is cut to 2,048 bytes (`mig/20260922185000_*:36-38`).
- Past runs' tool calls and results never appear. Only continuations carry receipts of them, in new runs after a
  worker, office or machine event (`rt/cloud-native-company-context.ts:110-111`). The same-run `run-continuation/v1`
  is no longer produced: since 1 October a run at its usage limit fails, with no handoff (C:2062-2078).
- No tool reads older messages: `read_context` pages only sources already in the run (`:733-794`).

**Inside a run today.**
- Codex keeps the run's history in its own thread, in one process, on one login and one model. Near the window it
  compacts the history itself.
- A started run that is cut off is never retried: it ends in review as `native_execution_uncertain`
  (`mig/20260828024000_*:337-345`, kept by `mig/20260928359930_*:139-157`). Only a run that never started gets a
  pristine retry.

**The vision.** C:887 asks every run to read `vision/vision.md` in full. No composer does: an agent reads it only when
its wake or role text tells it to, with a tool (`rt/cloud-native-company-context.ts:76`).

**Rough sizes** (estimates from source text, to be measured in M0):
- developer instructions: about 20 KB, about 5k tokens;
- tool catalogue: 30 to 50 KB, about 8k to 13k tokens;
- JSON prompt: 15 to 40 KB, with history alone up to about 75 KB.
- Real per-run numbers are already recorded. `model_turn` observations carry `inputTokens`, `cachedInputTokens` and
  `reasoningOutputTokens` (`mig/20260828019970_*:7-19`, `rt/cloud-codex-tool-session.ts:1082-1107`).
  `qorpera_native_execution_launches.context_bytes` holds the size of the composed context.

**Caching today.**
- Nothing sets `prompt_cache_key`. Upstream Codex is believed to use the thread id, which is new every run (M0
  checks this).
- The `read_context` tool's schema lists the run's source ids and hashes (`rt/cloud-native-company-context.ts:741-745`).
  The tool sits early in the list (`rt/cloud-native-company-runtime.ts:653`), so the tool catalogue is not identical
  between runs.
- Each run's working directory is a fresh random path (`rt/cloud-codex-tool-session.ts:1320,1393`). Codex's
  environment context probably carries it.
- The only measurement in the repo is about caching within one run: 79% of 4.7M tokens were cached
  (`deploy/first-node/RUNTIME-STEP-10-BEHAVIOR-SCREEN.md:101-103`).

**Memory today.**
- The notebook lives at `agents/<agent>/memory/profile.md` (at most 6 KiB) and `memory/log/YYYY-MM.md`.
- The composed block is the whole profile, plus at most 8 KiB, 40 facts and two months of the log. Notes fade after 7
  days (`rt/cloud-memory-tools.ts:53-72,288-334`).
- There are two tools: `update_memory` and `recall_memory`. There is no per-member memory (C:378-390).
- No summarizing job exists.

**Conversations are database state, not files** (C:419-429, C:544-545).
- They live in `qorpera_shared_sessions` and `qorpera_session_events`: append-only, one sequence per session,
  hash-chained.
- A send is appended exactly once (C:650-651).
- A group chat's only file is `agents/groups/<group>/group.md`. Its conversation stays when the folder is deleted
  (C:536-546).
- No path erases a single event.

**Visibility today.**
- One shared thread per agent, with company audience: every member sees it the same way. A post runs on the posting
  member's own login (C:2557-2573).
- "The shared thread and the Company File are the agent's continuity across members" (C:2570-2572).
- Member-private conversations are withdrawn, and folder-v2 has no member-private files (C:2574-2581).
- `qorpera_can_read_session` lets any company member read any company-audience session, group chats included
  (`mig/20260828019000_*:28-39`). `RUNTIME-COMPANY-STATE-FILES.md:280-281` still gives "adding a person lets them read
  the conversation" as a reason; §16 corrects that wording.
- The Co-Founder "MUST NOT receive copies of every internal message" (C:1380-1381). The sentence goes on "or require a
  member to supervise every delegated thread", and asks for structured composed state instead. It is about the
  Co-Founder's attention, not secrecy.

**The result fence.**
- Before every provider request, the patched Codex sends each tool output to the host, which wraps it in an envelope
  of at most 8 KiB (`rt/cloud-native-result-fence.ts`, `rt/cloud-native-tool-boundary.ts:745-805`).
- The host records a context view with digests and read references only, never text (`rt/cloud-company-path-gateway.ts:531-580`,
  table `qorpera_native_context_views`).
- The callback sits at Codex's common request builder, for HTTP, WebSocket and compaction requests. Only result bodies
  can change: the host's reply cannot alter calls, instructions, models or roles
  (`deploy/first-node/native-codex/README.md:10-11,94-95`).
- Instructions and the prompt are bound by hash and size (`rt/cloud-native-company-runtime.ts:416,555`).
- Composition reads from the folder are released under the hash of the composed context (`rt/cloud-folder-notebooks.ts:31-43`).

**Erasure (P18).**
- An owner or admin erases deleted paths. Every past version, closed under moves, is removed. A path that is live
  again keeps its current life and loses its earlier ones (`RUNTIME-COMPANY-FOLDER-ERASURE.md` §1, §2.2).
- Receipts and review cards that quote an erased path are scrubbed (§6).
- Kept by decision: run and view read records, and "conversations, transcripts, memory … a member removes it" (§1).
- There is no general "derived from" invalidation.

**Who pays.**
- The member who started the work pays for it and for what follows from it (C:2035-2044).
- A login is never switched without the member's permission (4 October). At a usage limit the work stops
  (C:2062-2078). OpenAI's terms forbid rotating accounts to get round a usage limit (C:2065-2066).
- Auto-review already makes background model calls this way: `gpt-6-luna` at low effort, on the member's own
  subscription (`rt/cloud-action-review.ts:26-28`). It runs one fresh thread per review in the run's own Codex
  app-server, through its own lane of the fence, never recorded as the agent's context
  (`RUNTIME-AUTO-REVIEW.md:25-31`).

**Light threads** (2 October). A chat turn has no shell. It reads the folder through server-side tools
(C:4404-4428).

**Folder writes.**
- A write replaces a whole file at an expected version (core §3).
- Every version is kept for good. The one exception: old git objects are pruned after 7 days (core §2).
- Content is stored in chunks of up to 4 MiB (core §7). So rewriting a small file stores a new copy of it.

## 2. What we take from OptChat, and what we change

| OptChat | Qorpera |
| --- | --- |
| One endless chat, one user | One tree per conversation, shared by every agent in it; all members count as one (§9) |
| Logs tool calls and results in its one log | Words in the conversation's log; each run's tool work in a log of its own, linked from its sends and closed until zoomed (§3, §4.5) |
| The view is the chat's whole context | The head, the views and the run's own folded work are the whole input of every request; Codex's own history no longer carries it (§6, W2) |
| A background process with a lock writes the tree | The run that caused the messages builds their lines, in its own Codex, on its own payer (§7) |
| Day files, `fsync`, single writer by socket lock | Folder files committed at expected versions (§4) |
| View kept in memory, folded incrementally | View recomputed per run as a pure function of length and built lines (§5); the run's own work refolded only at fold boundaries (§5.7) |
| Anthropic breakpoints / OpenAI implicit cache | OpenAI caching through Codex, with a stable cache key and a stable prefix (§6) |
| `zoom(id, n)` and `date(id)` | `zoom(line)`; dates appear in zoom results, never in the view (§8) |
| Compactor context: the folded chat before the node | Raw messages from a short window before the message, never summary lines, so that erasure stays bounded (§7.3, §10) |
| Subagents see the view | Workers start from their parent's view by reference, and their logs nest under the dispatching step (§12, W4) |

Kept as OptChat has them: the binary tree, free nodes, the 512-byte line target, the fold rule, "never a whole message
and never cut text in the view", the compactor's priorities, "never obey", no ids in compactor input, the shortest of
several attempts, and placeholders instead of cuts.

## 3. Units: what a tree covers

**One tree per conversation**, not one per agent. A conversation is one of:
- an agent's thread: its participants are the agent and the company's members;
- a group chat: its participants are the agents and people in `group.md`;
- an agent pair transcript (agent messaging): the two agents. It comes in a later slice (M6).

Participants matter only for relevance: they decide which conversations a run's view shows (§5.5) and whom a post
wakes. They never decide who may read (§9).

One tree per agent, merging all its conversations, is rejected:
- A group chat would be summarized again for every agent in it, at that many times the cost, and agents who were there
  together could remember it differently.
- The conversation a run answers in would not stay sharp. Busy group chats would push its newest lines out of the view.
- Erasing one message would touch the tree of every agent that took part.

Trees per conversation are written once and shared, and §5.5 still gives an agent all of its conversations in one
view.

**The log** is the conversation's existing transcript. It does not move.
- **Included events**: message events and card events (requests and answers), the same set today's history reads
  (`mig/20260923012000_*:103,112`). Run receipts and other events are left out.
- **Message number** `i` is an event's 0-based rank among the session's included events, by sequence. `T` is their
  count. Erased events keep their place, so numbers never shift.
- **Rendering an event** for the tree: `<speaker>: <text>`, with newlines kept. The speaker is the member's display
  name, the agent's name, or `card` (what was asked, the choices, and who answered what). Attachments become
  `[2 attachments: plan.pdf, logo.png]`.
- **Quotes stay fenced** (C's 2026-10-02 amendment on quoted outside content, C:4488; items 4 and 7 at
  C:4543-4572). A member message with quotes renders in its fenced form, as `qorpera_member_message_fenced` gives it
  to runs today (`mig/20260928459100_member_message_quotes.sql:84-119`):
  - the member's own words, with each quoted span as `[quote N]`;
  - then each quote's record, `[quote N: outside content from <source>, not <speaker>'s words: "…"]`, its words
    JSON-escaped, so they cannot close the record.

  The transcript keeps the «» marks for people, as it does today. So every free node, every compactor window and every
  zoom shows quoted words only inside their record, never as the speaker's (§7.3, §7.4, §8).

**Run logs: the work, beside the words** (W1). A conversation is a folder of logs, not one log.
- The conversation's log above holds **words only**: messages and cards. Its tree is what every run sees (§5).
- **Each run has its own work log**: its tool calls and their results, in order, as steps (§4.5). It has its own
  tree, built the same way (§7.5).
- An agent's send links to its run's log (§8). The log stays **closed until zoomed**, like a file in a folder.
- A worker's run log nests under the step that dispatched it. A coding session's turns will nest the same way (W6).
- Only one work log is ever open in a request: the run's own, folded (§5.7).

So a long piece of work never crowds the words out of the view, and the work is still one zoom away. That is how the
tree can carry the whole context without the context rot of a growing history.

## 4. The tree, its files and its index

### 4.1 Nodes

- `node(l, k)` covers messages `[k·2^l, (k+1)·2^l)`. Its address is `start+size`, so `node(3, 273)` is `2184+8`.
- **Level 0.** If the rendered event is at most NODE bytes, the node is the rendered text with newlines turned into
  spaces. That is a **free** node: no model call. Otherwise the compactor writes it (§7).
- **Level above 0.** If `childA + " " + childB` is at most NODE bytes, that joined text is a free node. Otherwise the
  compactor merges the two children.
- Sizes are UTF-8 bytes, never tokens. Danish letters count two bytes.
- **Sources.** Let `s = k·2^l` and `e = (k+1)·2^l`. `node(l, k)` is built only from the transcript events
  `[w(s), e)`, where `w(s) = max(0, 16·⌊s/16⌋ − 16)`. These are the messages it covers, plus the compactor's window
  before its first message (§7.3), which is at most 31 messages. No line is ever built from another conversation, a
  file, or a line outside its own subtree. Erasure relies on this bound (§10).

### 4.2 Files

Each conversation has a tree root:

| Conversation | Tree root |
| --- | --- |
| an agent's thread | `agents/<agent>/memory/thread/` |
| a group chat | `agents/groups/<group>/memory/` |

So a tree moves with its folder, is restored with it, and is erased with it. P18b's agent-folder erasure therefore
covers a deleted agent's thread tree.

Under a root:

```
tree.toml                  format = 1, conversation = "<session uuid>", node_bytes = 512
t0/00000000.jsonl          tier 0, block 0: levels 0–3 of messages 0–15
t0/00000001.jsonl          tier 0, block 1: levels 0–3 of messages 16–31
t1/00000000.jsonl          tier 1, block 0: levels 4–7 of messages 0–255
t2/…                       tier 2: levels 8–11 of 4,096 messages each
```

- **Tier `t`, block `b`** holds the nodes of levels `4t` to `4t+3` that cover messages `[b·16^(t+1), (b+1)·16^(t+1))`.
  That is 16 + 8 + 4 + 2 = 30 nodes at most, about 10 KB.
- A block is final once all 30 nodes are built. After that it changes only through erasure.
- File count is about `T/15`. A 10,000-message thread has about 670 files.
- **One JSON object per line**, ordered by `(l, k)`. Unknown keys are refused.

```
{"l":0,"k":2184,"seq":9113,"hash":"<event_hash>","free":true,"text":"Jonas: Make the vision shorter. Five lines at most."}
{"l":3,"k":273,"free":false,"text":"…","tries":2}
```

  - Level-0 lines carry the event's transcript `seq` and `event_hash`. They bind the line to the exact event: the
    index refuses a line whose event does not match, and erasure finds lines by event.
  - `text` must be valid UTF-8 and at most 2,048 bytes. NODE is a target, not a hard bound, as in OptChat.

**Why blocks.** Rewriting one growing file per conversation would store a new copy of it on every batch, kept forever
(§1, folder writes). Small blocks bound each rewrite to about 10 KB. Old versions of a block are only rewrite noise,
so they are pruned 7 days after they are replaced, like git objects (§10, GC; Jonas, 5 October).

### 4.3 Writes and refusals

- **One writer path.** The runtime host writes tree files through the folder commit function. Each batch is one change
  set, attributed like any of the run's writes: actor the agent, requester the member, the run and its sponsor. Each
  touched block is one unit at its expected version.
- **Erasure generation.** `qorpera_shared_sessions` gets `memory_generation`, a counter per conversation. The
  single-message erase (§10) raises it in the same transaction that blanks the event and deletes the blocks.
  - A compactor batch reads the generation before it reads any event or line, and keeps it with its results.
  - Its commit is the ordinary folder commit with one new precondition, `sessionGenerations`: a list of
    `(session, generation)` pairs.
  - **The check sits at the commit's own session step**, not before the commit. Core §3's transaction takes, in
    order: the run's rows, the folder fence, the principals (members first), the index rows, resources, grants and
    uniques, then run-owned rows, and then every session the transaction writes, `FOR UPDATE` in id order (step 4). A checked session joins that
    pass in the same id order, `FOR SHARE` when the commit only checks it. Then the commit compares the generation,
    and only then does it lock and write paths.
  - So the batch takes the member row before the session, like every other commit. For example, a payer's role
    change holds the member row `FOR UPDATE` and then asks for the thread session
    (`qorpera_folder_member_change_enter`). A batch waits for it at the member row, holding no session lock, and
    the two cannot deadlock.
  - The erase's update of the session row takes `FOR UPDATE` at the same step, so it and a batch wait for each other
    there in one order (§10).
  - If the generation moved, the commit refuses with `memory_generation_stale`. The batch is **discarded whole**: it
    is never merged, retried or partly kept. The next run builds those nodes again from the transcript as it now is.
  - Every retry below is its own commit, so it makes the same check.
  - So a result computed before an erasure can never land after it. The level-0 `hash` alone could not show this,
    because an erased event keeps its hash.
- **Concurrency** (for example, two members posting in one thread at once). On a version conflict the writer re-reads
  the block and merges by position: a node already built is kept, and the newer duplicate is dropped. It retries up
  to 3 times. Folder commits are transactional, so OptChat's `fsync` and lock rules have no counterpart here.
- **Platform-only paths.** Writes, moves and deletes under a tree root by members, agents or machines are refused
  (`platform_only`), like owner-only `rules/`. A tree moves or goes only with its owning folder: an agent rename, a
  group folder delete or restore, or erasure.
- **Ordinary reads.** Members, agents and machines read, list and search tree files like any company file (§9). Only
  writes are the platform's.
- **No file-change wakes.** P29 subscriptions never match tree roots, because a tree is derived data.

### 4.4 The index

`qorpera_memory_tree_nodes` is a structured-file index (core §5), rebuilt from the files.
- Columns: environment, conversation, `l`, `k`, `text`, bytes, `seq` and `hash` at level 0, and the source path and
  version.
- The composer and `zoom` read it in one call each, so a run never opens dozens of block files.
- `T` is the transcript's count of included events (§3). The built set is the index's rows; an address with no row is
  missing, whether it was never built, failed, or was erased (§10). Events are read from `qorpera_session_events`.
- The composer releases the block paths and versions it used under the hash of the composed context, as notebook
  composition does today (`rt/cloud-folder-notebooks.ts:31-43`). So the view passes the fence as read references, and
  no text is stored.
- Erasure handles its rows like other retired index rows (`RUNTIME-COMPANY-FOLDER-ERASURE.md` §5).

### 4.5 Run logs (W1)

Each run has a work log, under the tree root of the conversation it ran in (§4.2):

```
runs/<run id>/run.toml             format = 1, run = "<uuid>", conversation = "<session uuid>", parent = "<run uuid>", step = 37
runs/<run id>/log/00000000.jsonl   steps 0–15, one record each
runs/<run id>/t0/…, t1/…           its tree, laid out as §4.2
```

`parent` and `step` name the dispatching step of a worker's run, and are absent for other runs. A worker's log sits
beside its parent's, under the same root, so a log moves, is restored and is erased with its conversation's folder.

**A step record**, one JSON object per line:

```
{"j":12,"tool":"company_read","call":"call_…","args":"{…}","args_bytes":214,"args_hash":"…","result":"<envelope>","reads":[{"path":"sales/prices.md","version":"…"}],"text":"…","at":"2026-10-05T09:12:03Z"}
```

- `result` is the envelope exactly as the fence issued it, at most 8 KiB (§1). So the log holds what the model saw,
  never a larger raw result.
- `args` is fitted to 8 KiB the same way, with its byte count and hash. So a step is at most about 16 KiB.
- `reads` are the read references the fence recorded for this result in the context view (§1). Erasure uses them
  (§10.1).
- `text` is the agent's own text before the call. Reasoning items are never stored (§6.3).
- **A send, a card or a `send_mail` keeps its arguments as a hash only**, in its pre-commit (below) too: `args` is
  empty, and `args_bytes` and `args_hash` stay. Its result is its receipt. Its words are in the conversation, on the
  card or in the outbox row, and are not copied. So a mail's addresses and body are never in a run log
  (`rt/cloud-event-tools.ts:289-309`).
- Other arguments can hold a file's text, for example `company_write`'s `text`. A file's erasure reaches them by the
  path they name (§10.1).

**Commits.**
- A run commits its new steps as one batch every STEP_COMMIT and at run end, as an ordinary folder commit at the
  block's expected version.
- **The log is found by run id.** A batch looks up its log's path in the index, `qorpera_memory_run_logs`, by run id,
  never by a path it remembers. A move of the folder, such as an agent rename, repoints that row in the same commit
  (core §5), so the next batch writes under the new path.
- **A step batch only appends.** It adds new steps, and fills in the result of its own pending effectful step (below).
  It never changes any other step: steps already in the block are kept as the file has them, never rewritten from the
  run's memory. On a version conflict the run reads the block again and does the same again. So a batch never brings
  back a step that was erased. Filling in a pending result is safe, because no erase changes a live run's log (below).
- **No generation check discards step records.** They are the only copy of the work: context views keep digests only
  (§1). So a step batch does not take §4.3's generation check. Only batches of step lines do (§7.5); like tree
  batches, they are derived and are discarded whole on `memory_generation_stale`.
- **The run log's generation** lives on a runtime row, `qorpera_memory_run_generations` (run id, `memory_generation`),
  created with the run's first batch. Like `qorpera_shared_sessions` for a conversation, it is never rebuilt from
  files, so a rebuild of the indexes cannot reset it. It is run-owned, so it is taken at core §3's run-owned step:
  `FOR SHARE` by a step-line batch or a zoom that checks it, `FOR UPDATE` by a step erase (§10.1).
- **If the log's folder is deleted while the run is live** (a group folder's delete during a group-chat run, or the
  agent's), the log goes with it, as its tree does (§4.2). The next batch finds no index row and fails with
  `memory_run_log_gone`. The run's effectful calls then cannot pre-commit, so they do not run, and the run ends with
  that error. Its unsaved steps go with the folder, as the delete asked. A restore brings back the log as last
  committed.
- **No erase changes the log of a live run.** An erase that reaches it (of one step, or through a file's or a message's
  erasure) stays pending until the run ends, as P18 does for receipts (§10.1). So a running run, its folded work and
  its resume (W5) never meet a hole in its log.
- **An effectful call is committed alone, before it runs**, as a step with no result yet. Effectful means any call that
  `cloudActionEffect` does not class as a read. **The call runs only once that commit has landed.** If it cannot land,
  the call does not run, and the host answers it with an error result, as for any refused call. Its result is filled
  in by the next batch. So after a cut-off, the log names every effect that may have happened (§12).
- A log block is final once its 16 steps are written. The last block is rewritten as batches land, and the 7-day prune
  removes that rewrite noise (§10, GC).

**Index and rules.** `qorpera_memory_run_logs` (one row per run: path, conversation, parent, step count) and
`qorpera_memory_run_steps` (one row per step) are structured-file indexes, rebuilt from the files. Like every index,
they are taken at core §3's rank 5, through the structured-file hook; the generation is not on them (above). A run
log's tree nodes go into `qorpera_memory_tree_nodes` with the run in place of the conversation. Writes are the
platform's only, reads are ordinary, and no file change under `runs/` wakes anyone, as §4.3 says for trees.

## 5. The view

### 5.1 Constants

| Name | Value | Meaning |
| --- | --- | --- |
| NODE | 512 bytes | target size of one line |
| VIEW | 96,000 bytes | the run's own conversation (M2 compares it with 48,000) |
| BRANCHES | 24,000 bytes | all branches together (§5.5) |
| HEAD | 16,000 bytes | the company head and the agent head together (§5.6) |
| PINS | 4,000 bytes | pinned text in an agent head, if Jonas chooses pins (§11) |
| RUN_VIEW | 64,000 bytes | the run's own work: folded lines plus raw steps (§5.7) |
| STEP_COMMIT | 16 steps or 30 s | how often a run commits its steps, whichever comes first, and at run end (§4.5) |
| WINDOW | 16 messages | the compactor's window is the previous group of 16 plus the current group up to the message (§7.3) |
| COMPACT_CONTEXT | 32,000 bytes | the most raw text in that window; each event in it is cut to 1,024 bytes (§7.3) |
| TRIES | 3 | attempts to bring a line under NODE |
| JOBS | 4 | compactor threads at once in one run |
| SETTLE | 20 s | longest wait at run start for missing lines (§5.4) |
| CLOSE | 60 s | longest time a run spends building lines after its last send (§7.1) |

These are bundle constants, not settings. Each line also costs about 12 bytes of address and markup. 96,000 bytes is
roughly 24k to 48k tokens, depending on language. That is about 380 lines of 250 bytes, the average line size OptChat
reports. HEAD, VIEW, BRANCHES and RUN_VIEW together are about 200,000 bytes, so with the tools and instructions a
request stays far below the point where Codex compacts on its own (§6.3). M0 records the real window.

### 5.2 The fold

The view is a list of parts that tile `[0, T)`, oldest first. It is a **pure function of `T` and the set of built
nodes at run start**, so no view state is stored anywhere:

```
fold(T, built, budget):
  parts = []
  for n in 1..T:                      # replay the conversation's growth
    parts.append(node(0, n-1))
    while size(parts) > budget:
      pairs = adjacent (a, b) with a.l = b.l, a.k even, b.k = a.k + 1, built(a.l + 1, a.k / 2)
      if none: break                  # wait for a parent; see 5.4
      merge the pair with the largest (n / 2^a.l − a.k), the oldest first on a tie
  return parts
```

- `size` counts a built part's line and a missing part's placeholder.
- The rule is OptChat's `due`, as simplified in the gist's comments: merge the pair furthest from the end, measured in
  its own line size.
- A level-`l` line changes about once per `2^l` messages, so the start of the view stays the same from run to run.
- The replay costs `O(T log T)`. OptChat folds 2,300 messages in 20 ms. A checkpoint of the fold in the index is a
  later optimisation if a long conversation needs it.

### 5.3 Rendering

```
<conversation ref="." name="Co-Founder (thread)">
0+512|…
…
1023+1|…
</conversation>
```

- Each part is `start+size|text`, with newlines as spaces.
- **Nothing that grows goes before the lines.** The opening tag holds only the ref and the name. The message count
  would change with every message, so it is left out: the last line's address shows it, and the user message carries
  it as `conversationMessages`.
- **No dates or times.** They would change the prefix. `zoom` shows them.
- **Never a whole message, and never cut text.** The new inputs that woke the run still appear in full, as today's
  "current inputs" (up to 16 KiB each). The view covers `[0, T)` before them.
- The view carries the same trust label as today's history block (C §9.2). It is conversation data, and the agent's
  instructions stay where they are. Its text is escaped as today's prompt is (`<`, `>`, `&` and direction controls,
  `rt/cloud-native-company-context.ts:664-667`), so a message cannot close the tag or open another.
- A fixed paragraph, VIEW_DOC, goes before the view. It explains the line format, that old lines are coarse, that
  placeholders exist, and that the agent must **zoom before it acts, guesses or asks** about anything a line only
  hints at. It also says that each of its sends links to the run's work, which `zoom` opens (§8), and that its own
  run's earlier steps are folded the same way (§5.7).

### 5.4 Missing lines: wait, never cut

- A missing level-0 node renders as `start+1|(not summarized yet: zoom it)`.
- **Settle.** At run start, missing lines in `[0, T)` are built first, on the run's payer, whichever run left them
  missing (§7.2). The run waits at most SETTLE. In steady state nothing is missing, because the previous run built its
  own lines (§7.1).
- **Overflow.** If blocked merges leave the view over `VIEW × 1.25`, the composer merges the oldest blocked pairs into
  placeholder parents (`start+size|(not summarized yet: zoom it)`) until it fits. Zoom opens them like any line.
  Text is never truncated.
- Each run records its placeholders and its wait (§13).

### 5.5 Branches

A branch is another conversation shown inside a run's view. Branches are chosen by relevance to the agent. They are
never a permission: every agent may zoom into every conversation of the company (§9).
- **Which branches:**
  - in any run: every other conversation the agent takes part in (§3), so its own thread in a group-chat run, and its
    group chats in a thread run;
  - in any run of the Co-Founder, also every other agent's thread (C:1380-1381 is amended for it, §16).
- **Budget.** BRANCHES is split by recent activity: half to the most recently active branch, a quarter to the next,
  and so on. Each branch gets at least 600 bytes.
- **Rendering.** Each branch is folded with `fold(T_b, built_b, b)`. When even the coarsest fold does not fit its
  share, its oldest parts are replaced by one line, `earlier|zoom 0+1024, 1024+512, …`, which names their addresses.
  Branches that do not fit at all are listed by name and length on one line each, and `zoom` opens any of them.
- **Placement.** Branches change every run, so they go after the stable prefix (§6), in the user message.

### 5.6 The head (W3)

The head is the fixed top of every request, in the developer message after the stable part (§6.1). It takes the
place of files like `AGENTS.md`, which Codex never loads here (§1).
- **The company head**: the approved `vision/vision.md`, whole. C:887 asks every run to read it in full; no composer
  does today (§1).
- **The agent head**: its job specification (the body of its `agent.md`, today in the prompt's hire overlay) and its
  profile page (at most 6 KiB, today in the prompt's `memory`). If Jonas chooses pins, they take the profile page's
  place (§11). The host-owned behaviour of the agent's kind (`cloudRuntimeHireBehavior`) stays in the stable part, as
  today.
- **A deliberate change of role.** Today the developer message holds only host-owned rules and validated identifiers;
  names, charters and assignments stay in data (`rt/cloud-native-company-context.ts:550-551`), and the job
  specification sits in the user message (`:650-658`). C §9.3 has the bootstrap point to the hire overlay (C:953),
  not carry it. **This design changes that, on purpose, for the cache.** Codex's environment context, with its random
  working directory, follows the developer message (§6.1, part 4). So only text in the developer message can be a
  prefix that runs share. The head moves there (W3), and so do VIEW_DOC and the primary view (M1).
  - Models weigh developer-role text above user-role data, so this is a change to C §9.2 and §9.3 (§16) and a risk
    (§17). It is not a way around them.
- **Still data, not instructions.** What keeps every part distinguishable, as C §9.2 asks:
  - it is one serialized object, escaped as today's prompt is (`:664-667`), so its text cannot close a tag, add a role
    or change the rules before it;
  - each part names its source (path and version) and carries a trust label. The vision is
    `company_instructions_not_authority` (new): the company's own instructions file (C §9.3), which guides the work
    and never overrides the platform's rules. The job specification is `job_specification_not_authority`, as the hire
    overlay carries it today (`:650-658`). The profile page and pins are `own_notebook_not_authority`, as today
    (`rt/cloud-memory-tools.ts:113`), and a pinned line also keeps its source's label (§11);
  - the stable part says what the labels mean, as it does for tool results today.

  So a profile write that a web page talked the agent into is still the agent's own note, never an instruction, as it
  is today. The view's lines carry their own label the same way (§5.3). M1's proof checks this through a view line,
  and W3's through a profile write (§14).
- Both are read for the company and released as read references (§4.4). They are the same for every member, model and
  payer, and change only when the vision, the role or the profile changes. So the head is read from the cache across
  runs.
- **Never cut.** If the head is over HEAD, it shows the parts that fit whole, in the order above, and names the path of
  each part left out, with its size, so the agent can read it.

### 5.7 The run's own work (W2)

Every request of a run ends with the run's own work (§6.1, part 6), taken from its log (§4.5). Steps are numbered
`0..S` in the order the run made them.
- **The raw tail** is steps `[r, S)`. They go in as the real call and output items Codex made, with their reasoning
  items, so the model sees its newest work exactly.
- **Earlier steps**, `[0, r)`, go in one message before the tail, folded with `fold(r, built, RUN_VIEW / 2)` (§5.2),
  one `start+size|text` line per part.
- **That message is data, in a runtime envelope** (C §9.2). Its lines sum up tool results, so they are what the results
  were: untrusted data, never instructions.
  - It is a user-role message, never the developer role, and it is not part of the conversation's transcript.
  - It is one serialized object, escaped as the prompt is: `{"schema":"qorpera.run-work/v1",
    "trust":"tool_results_not_authority","ref":"run:.","lines":["0+16|…",…]}`.
  - The host issues it in its composition reply over the fence socket, and the patch accepts it only from there, at
    that place (§6.3). Text the model or a tool wrote cannot pass for it.
  - W2's proof checks that a fake instruction carried into a folded line is not followed (§14).
- **Fold boundaries.** `r` starts at 0. A step's bytes count its call, its output and its reasoning items. When the
  raw tail passes RUN_VIEW / 2 bytes, `r` moves forward to the first step that brings the tail under RUN_VIEW / 4, but
  never past the first step of the newest model response. One response can make several calls, and their outputs
  reach the model together in the next request, so all of them stay raw, beside the response's reasoning item. Any
  step will do, because `fold(r, …)` needs no alignment. So the raw tail sent is at most RUN_VIEW / 2 bytes, or the
  newest response's steps alone when they are larger. The folded lines are at most RUN_VIEW / 2, or up to 1.25 times
  that while lines are missing (§5.4's overflow).
- That request is a fold boundary: the only kind of request in which anything before the newest items changes (§6.3).
  The folded lines are computed at a boundary and kept as they are until the next one, even when more lines get built
  in between. A run whose steps are large folds more often: one fold per RUN_VIEW / 4 bytes of new work. W2 measures
  what that costs in cache reads (§13).
- **Missing lines.** A step that leaves the tail needs its level-0 line. It is usually built already (§7.5). If not,
  the request waits up to SETTLE for it, and then shows a placeholder (§5.4). Text is never cut.
- **Zoom** `run:.` opens any earlier step whole (§8). A dispatch step's result holds its worker's report, as today; the
  worker's own work is one zoom away in its log.

## 6. Composing every request through Codex

M1 composes only what a run starts with, as today: the developer instructions and the prompt. **W2 composes every
request of the run**, so Codex's own history no longer carries the context (§11).

### 6.1 The order of a request

1. Codex base instructions. These are fixed per binary.
2. Tools, identical for a given tool set. `read_context` stops naming per-run source ids in its schema; they move into
   its results and the prompt.
3. Developer instructions, in this order: the stable part (tool-result rules, core protocol, binding, the behaviour of
   the agent's kind), then the **head** (§5.6, W3) and VIEW_DOC with the **primary view**, both as labelled data, then
   the parts that vary by wake (wake-kind rules, continuation rules, final-send policy, closing reminder).
4. Codex's environment context (with the random working directory), after the developer message. M0 checks this
   order.
5. The user message: `observedAt`, wake, `conversationMessages`, current inputs, branches and the rest, as today
   without `history`.
6. From W2, **the run's own work** (§5.7): one user-role message, a runtime envelope with the folded lines of its
   earlier steps, then its newest steps raw, as the call and output items Codex made.

Parts 1 to 5 are composed once, at run start, and stay byte-identical for every request of the run. Only part 6 grows.

### 6.2 The cache key

- Our Codex patch sets `prompt_cache_key` to
  `qorpera:` + sha256(payer login connection id, agent id, conversation id).
- Setting it is a new capability of the patch, so it waits for Jonas's yes (§16). Until then M1 runs with the key
  Codex sends itself, and runs reuse each other's cache only as far as the provider allows without it (M0 measures
  that).
- It names the payer login because the provider keeps a cache per paying account: provider-side context is never
  pooled across logins (C:2570). That is a provider fact. The tree itself is the same for every member.
- Without a stable key, every run's new thread id would route it away from the previous run's cache.
- A worker uses its parent's key, so its first request can read the parent's prefix from the cache (§12, W4).

### 6.3 The composition patch (W2)

Today the patch lets the host change only result bodies (`deploy/first-node/native-codex/README.md:94-95`). Codex keeps
the run's history itself and compacts it when it nears the window.
- **The hook exists.** Before every provider request (HTTP, WebSocket and compaction), the patch's
  `build_fenced_responses_request` (`deploy/first-node/native-codex/0001-cloud-result-fence.patch:252`) sends the
  request's tool outputs to the host. W2 extends it under a new capability marker,
  `qorpera.native-context-composition/v1`: it sends the whole input list, the model and the request kind, and takes back
  a replacement input.
- **What the host returns.** Parts 3, 5 and 6 of §6.1, built from the tree and the run's log. Codex's own items are
  kept only for the raw steps of part 6, with their reasoning items.
- **What the patch checks, in Codex,** before the existing fence runs:
  - every output follows its call, and every call before the newest model output has its output;
  - every call is one the run made: in Codex's own history, or in the run's log after a resume (W5);
  - reasoning items come only from this process's own history;
  - the work message of part 6 is the one the host's reply added, in the user role, just before the raw steps; any
    other item that claims its schema is refused;
  - the base instructions, the tools and the model are unchanged.

  Then the fence runs over every output as today, so every result in the input is still a host-issued envelope.
- **Folds only at boundaries.** Between folds, each request is the previous one plus Codex's new items. The provider
  reads the previous part from the cache, and the WebSocket transport can send only the new items. When the raw steps
  outgrow RUN_VIEW / 2, the host folds the oldest of them into lines (§5.7). That one request changes part 6, and growth
  starts again from there.
- **Reasoning items** stay next to their calls among the raw steps. After a model change, a payer change or a restart
  they are dropped, because they belong to the model and account that made them. The agent's own text stays.
- **Codex's own compaction** starts at a share of the window that config can only lower (at most 90%). Composed
  requests stay far below it, so it is never reached. If it ever is, its request passes through the same hook, is
  recorded as today, and the host's next composed request replaces what it made.
- **Sign-off.** The capability lifts the rule that only result bodies change, so it needs its own proofs, the existing
  native proofs run again, and Jonas's sign-off (§16).

### 6.4 What M0 must show before M1 is built

It runs on the node test machine with the patched Codex 0.155.1 and a test login:
- where 0.155.1 puts the environment context, and whether it adds a date;
- what it sends as `prompt_cache_key` (probably the run's thread id, §1);
- that later requests of one run report `cachedInputTokens` for the earlier part;
- whether two runs with the same developer instructions, each with its own key as Codex sends it, report
  `cachedInputTokens` for the shared prefix;
- the same for a growing conversation: a second run after a few new messages, whose view differs from the first
  run's only in its last lines;
- what makes Codex's own compaction start, read from the unchanged patched build and its config.

M0 uses only the patch as it is today, so it needs no new sign-off. It sets no key. The check with one shared key
across runs moves to M1, once Jonas has said yes to the key (§6.2, §16). If the provider ignores the key for
ChatGPT-login requests, the view still works. It just costs more.

**The compose probe** comes first in W2, after Jonas's sign-off on the patch (§6.3, §16), never before. With a test
build of the hook on a test login, it checks that an input returned unchanged, reordered and folded is accepted; that a
request after a fold reads parts 1 to 5 from the cache; and whether the WebSocket transport still sends only new items
between folds.

**Until W2**, nothing changes within a run: Codex keeps the thread, and each step reads earlier steps from the cache.

## 7. The compactor

### 7.1 When and where

- **In the run, not in a drain.** Members' ChatGPT logins may only be used through the official client, inside a
  run's protected slot (2 October, light threads). The founder rules tie every model call to a payer. A drain would
  need a member's login outside any run, and would count as "work no member started" (C:4304-4334), which a ChatGPT
  plan never pays for. So lines are built where auto-review already makes its calls: in the run's own Codex
  app-server, one fresh ephemeral thread per call, with no tools, through the reviewer's lane of the fence, and never
  recorded as the agent's context. No receipt, card or transcript keeps a call's input or output: its only product is
  the tree, plus the counts in `memory_compaction`.
- **Closing.** After the run's last send or card, and before it finishes, the run builds:
  - the level-0 nodes of the events it caused: the inputs that woke it, and its own sends and cards;
  - every merge those nodes make possible;
  - the lines of its own steps that are not built yet (§7.5).

  It runs up to JOBS calls at once, for at most CLOSE, and commits one batch. The member already has the reply, so
  they do not wait. What is left unbuilt stays missing (§5.4).
- **Settle** at the next run's start (§5.4).
- **Order.** A level-0 node needs only the transcript (§7.3), so level-0 nodes can be built in any order, and one
  missing line never blocks a later one. A merge starts once both children exist. Level-0 nodes are started in
  message order, so that calls in one window share their prefix.
- **Warm processes.** A warm Codex process (C:2767-2804) serves the closing calls like any other request of the run.

### 7.2 Model, payer and limits

- **Model**: `gpt-6-luna`, effort low, as auto-review uses. M2 records how often a line overshoots NODE. OptChat found
  that low effort overshoots more than medium, so M2 may move to medium.
- **Payer**: the run's payer, the same login as the run's own calls. That is the member who started the work
  (C:2035-2044), or the supervisor for work no member started (C:4304-4334). No other login is ever chosen.
- **Gaps another run left.** A run's settle also builds lines that an earlier run left missing, for example after
  that run's login hit its limit. Members count as one, so filling the company's tree is part of the run's own work,
  on its own payer. Nothing is switched: each run pays only for its own calls.
- **Usage limit.** When the provider reports the limit, every compactor call of the run stops at once. Nothing is
  retried elsewhere, and the lines stay missing. A rate limit or outage is not a usage limit (C:2062-2078): the calls
  stop for this run, and the next run retries.
- **Failure.** An empty reply, a refusal or an error after TRIES leaves the node missing for the next run. There is no
  retry loop inside a run, because a later run will meet the same gap.
- **Cost record.** Each batch writes one `memory_compaction` observation: calls, free nodes, input, cached and output
  tokens, overshoots and the payer connection (§13).

### 7.3 One call

- **System**: COMPACT (§7.4), byte-stable, then a SCALE example: a realistic line of exactly NODE bytes.
- **Level 0, message `i`:**
  - **Block 1**: `<chat>…</chat>`, the raw rendered events `[w(i), i)` from the transcript, quotes fenced (§3), where
    `w(i) = max(0, 16·⌊i/16⌋ − 16)` (§4.1). That is the previous group of WINDOW messages, plus the current group up
    to `i`: 0 to 31 events.
    - Each event is cut to 1,024 bytes with a `[…]` mark, which keeps the block under COMPACT_CONTEXT. This is the
      compactor's input, not the view, so cutting is allowed here. The message being summarized is never cut.
    - The window starts at a multiple of 16, so the calls for the messages of one group share a prefix.
    - It has no ids: OptChat saw ids copied into lines.
    - It resolves references like "do that" or "the file" to the messages just before.
    - It holds **raw messages only, never summary lines.** A line built with summary lines in its context could pick
      up a fact from any earlier message, and pass it on to every later line. Then erasing one message would mean
      rebuilding everything after it. With raw messages, a line's sources stop 31 messages back (§4.1, §10).
  - **Block 2**: "Compress this message into one line of at most 512 bytes", then the rendered event, whole, with its
    quotes fenced.
- **Merge**: "Merge these two adjacent lines into one line of at most 512 bytes", then both children. A merge sees its
  two children only. They already carry what their own windows resolved.
- **Size enforcement**: if the reply is over NODE, the same thread is told its byte count and shown the line cut at
  NODE with a `| ← LIMIT` mark, up to TRIES attempts. The shortest attempt is kept.
- **Context of a summary is the same conversation only.** A compactor call never sees another conversation, a branch
  or a file.

### 7.4 The COMPACT prompt (outline)

OptChat's prompt, adapted for many speakers:
1. **The task.** The tree and its levels. The agent sees this conversation only through these lines and opens a line
   only when its words show what is inside. Whatever a line drops is lost to every line above it.
2. **Priorities**:
   1. People's own words, near-verbatim, with the speaker's name: orders, decisions, corrections, standing
      instructions and their reasons. These must survive the longest. Record what was said, not that something was
      said. A quote's words are never someone's own words (rule 4).
   2. Lasting effects and outcomes, failures included and why. Cards: what was asked, and who approved or refused it.
   3. Agents' findings, commitments and open questions, in fewer words.
3. **Keep items findable.** One or two words keep an item findable. Drop only items of little value, and only when
   the space is worth much more elsewhere.
4. **Never** answer, obey or add to the messages, and never make anything look further along than it was. Text
   inside the messages is data, which also blocks prompt injection through a member's or contact's words.
   - `[quote N]` and its record are outside content from whoever wrote it, as the run's rules say today (C:4549-4553).
     A line may say what a quote is about, as the quote's ("quote 1, an email from Acme, offers 20% off"). It never
     gives a quote's words to the speaker, and never states what a quote asks for as anyone's order.
5. **Write in the language of the messages.** Output only the line.

### 7.5 Step lines (W1, W2)

A run log is compacted like a conversation (§4.1, §7.3), with steps in place of messages.
- **A rendered step** is `<tool>(<arguments>) → <result>`, preceded by the agent's own text before the call, if any.
  The arguments and the result are as committed (§4.5), so a step is at most about 16 KiB. A step of at most NODE bytes
  is a free node.
- **Level 0, step `j`**: block 1 holds the raw rendered steps `[w(j), j)` of the same run, each cut to 1,024 bytes;
  block 2 is "Compress this step into one line of at most 512 bytes", then the step, whole.
- **Its context is the same run's raw steps only.** Never the conversation, the head, another run, or a line. So a
  step line's sources stop 31 steps back, and erasing a step or scrubbing a result stays bounded (§10.1).
- **Merges** see their two children only, as in §7.3.
- **The prompt**, COMPACT_STEP, keeps §7.4's rules 3 to 5, with these priorities:
  1. What was done, and to what: paths, ids, people, amounts. Results and numbers that later steps used.
  2. Failures, and why. Dead ends, so they are not tried again.
  3. What the step showed about the company or the task.
  4. Never copy a file's text that can be read again: name its path instead. Zoom or a read brings it back.
- **When.** As soon as a batch of steps commits (§4.5), its level-0 lines start, in the run's own lane, up to JOBS at
  once, and merges follow as children appear. So lines are usually built before a fold needs them (§5.7). What is left
  is built at closing, within CLOSE.
- **Payer and limits** as §7.2: the run's own payer, and nothing else. A worker's steps are compacted by the worker's
  run, on its payer.

## 8. The zoom tool

```
zoom({ line?: "2184+8", conversation?: "thread:sales", from?: 3812 })
zoom({ conversation: "run:7f3a19c2", line: "12+4" })
```

A conversation is a folder of logs: its words, and one work log per run. Zoom opens either, like opening a file in a
folder.

- **`line`** is an address as the view shows it. The tool checks that `size` is a power of two, that `start` is a
  multiple of `size`, and that `start + size ≤ T`. Otherwise it answers `No line 2184+8.`
- **No `line`** returns the conversation folded to one page, rendered as a branch is (§5.5), with its message count.
  An agent uses it to start in a conversation that is not in its view.
- **`conversation`** is `.` (the default, the run's own conversation), `thread:<agent>`, `group:<group>` or
  `run:<run id>`: a ref from the view, or any agent's thread, group chat or run log in the company. `run:.` is the
  run's own log. A ref that names none answers `No conversation thread:sales.` In a run log, `T` is the log's step
  count.
- **`size > 1`** returns the two lines below, each with its date range: `2184+4 (3–4 Oct)|…`. A child that is not
  built is shown as its placeholder.
- **`size = 1`** returns the original event: `2184|Jonas (2026-10-04 09:12 UTC): …`. It is read from the transcript,
  never from a summary. An erased event shows `(erased)`.
  - A message with quotes comes in its fenced form: the member's words with `[quote N]`, and the quotes as their
    `qorpera.member-quote/v1` records with trust `untrusted_data`, as `read_context` pages them today (C:4546-4548).
    Never the «» text.
  - An agent's send or card also names the run that wrote it, with its size: `work: run:7f3a19c2 (148 steps)`. That
    is the link from the words to the work.
  - In a run log it returns the step as committed: the call, its arguments and the result envelope (§4.5). An erased
    step shows its tool and `(erased)`. A dispatch step names its worker's log, `run:<id>`, and a coding step its
    session's child log (W6).
- **Fitted to the fence, never cut by it.** Every result is fitted after encoding, as `fittedContextPage` does for
  `read_context` (`rt/cloud-native-company-context.ts:685-716`).
  - The fence JSON-encodes a result and escapes `<`, `>` and `&`, so text full of markup can grow up to six times.
    A fixed page of text could therefore pass the fence's 8 KiB limit and be cut from the end.
  - So zoom shortens its text at a code point until the encoded result fits, with the fence's reserve for its
    provenance. When text is left, the result ends with `nextOffset` (in code points) and the total length.
  - The agent passes `nextOffset` back as `from`. Nothing is skipped, however costly the text is to encode.
  - This holds for an original event and for a pair of child lines alike. A line can be up to 2,048 bytes (§4.2).
- **Scope.** Every conversation of the run's company (§9). It reads for the company and checks nothing else, so the
  answer never depends on which member the run works for, on who takes part in the conversation, or on the agent's
  folder grants.
- **It is a read.**
  - `cloudActionEffect` classes it as read, so it is never reviewed.
  - Its name joins `CLOUD_RUNTIME_TOOL_OPERATIONS` and the observation vocabulary.
  - Its output goes through the result fence like any tool output.
  - Summary lines are released as platform reads of their block's path and version, the way composition reads are
    (§4.4), so the release needs no folder grant (§9). Transcript events are released the way `read_context`
    releases its sources.
  - Its receipt input keeps the target conversation's session id, or the run log's run id (not the ref, which a
    rename changes), `start`, `size` and `from`. Erasure matches receipts by these (§10). A call without `line` is kept with `start` 0 and
    `size` T: the whole conversation, so any erasure in it matches.
  - It reads the conversation's `memory_generation` (§4.3) before it reads, and stores its receipt in a transaction
    that checks the generation again. If the generation moved, that transaction rolls back, and zoom reads again and
    answers from the new state. So no receipt that holds erased text is stored after the erase.
  - That transaction keeps core §3's order: the run's rows first (a receipt takes the run mutex, step 2), then the
    receipt row with the other run-owned rows, and the target session `FOR SHARE` last, at the session step. It
    takes no principal or path lock after the session. The erase takes the session at that same step, so the two
    wait in one order.
  - A zoom into a run log checks that log's generation the same way, with its `qorpera_memory_run_generations` row
    taken `FOR SHARE` among the run-owned rows, where a step erase takes it `FOR UPDATE` (§4.5, §10.1).
- **Light threads.** It runs on the server, with no shell.

## 9. Company-wide, with no reader rules

The tree is company data, like the conversations it summarizes, and it is **written and read as if all members were
one** (Jonas, 5 October: company-first and agent-first, with no compromise).
- **No member in the result.** No line, view, branch or zoom result depends on which member asked, wrote, or pays.
  The payer login only decides who pays for a call (§7.2) and which provider cache a request can reuse (§6). Speakers'
  names stay in the lines as attribution.
- **Every agent may read every conversation of its company.** `zoom` opens any agent's thread or group chat (§8). The
  tree adds no reader rule of its own: the composer and `zoom` check that a conversation belongs to the run's company,
  and nothing about the conversation's participants.
- **Relevance, not permission, chooses the view.** The run's own conversation is large, the agent's other
  conversations and, for the Co-Founder, every agent's thread are branches (§5.5). Anything else is one zoom away.
- **The composer and `zoom` read for the company.** They read tree blocks and transcript events as the platform, as
  notebook composition reads today (`rt/cloud-folder-notebooks.ts:31-43`), and release them as read references
  (§4.4, §8). They check the company and nothing else: not the member the run works for, not the participants, and
  not the agent's folder grants. Conversation memory is the company's, and every agent gets it.
- **Ordinary files too.** Tree files sit under `agents/`, a shared root that every member reads, and every agent with
  the default access (a read grant on every live shared root, `RUNTIME-COMPANY-STATE-FILES.md:1128-1130`). The tree
  adds no path resource, not even for a group chat's root. So `company_read`, `company_list`, `company_search`, the
  web app and the folder copies on machines ([the company folder on every machine](RUNTIME-COMPANY-FOLDER.md)) read
  them exactly like any other file under `agents/`.
- **Group chats are company-wide.** `qorpera_can_read_session` already lets every member read every company
  conversation, group chats included (§1), and the tree keeps it that way. Who is in a group decides who takes part
  and whom a post wakes, not who may read.
- **Run logs too.** A run's work is the company's, like its replies. Every agent and member may open every run log
  (§4.5, §8), whichever member the run worked for.
- **The compactor** sees only its own conversation or run (§7.3, §7.5). That bound exists for erasure (§10), not for
  secrecy.

## 10. Erasure, GC and retention

**The hard rule.** A line built from an erased message is erased, and later rebuilt without it. A line's sources are
known from its address alone (§4.1): `node(l, k)` is built only from the events `[w(s), e)`. No "derived from"
records are needed. Message `i` is a source of `node(l, k)` exactly when `w(s) ≤ i < e`. That is:
- the node over `i` at each level, `node(l, i >> l)`;
- the nodes of the rest of `i`'s group of 16 and of the next group, whose compactor windows reach back to `i`, with
  their parents.

That is at most two blocks per tier, so at most eight blocks in a 4,096-message conversation. The bound holds because
the compactor's window holds raw messages, never lines (§7.3). With lines in it, a fact could pass from line to line,
and every later line would depend on every earlier message.

**Erasing one message** (new, M3). Owners and admins may erase, with the same role check as P18's erasure of paths
(`RUNTIME-COMPANY-FOLDER-ERASURE.md` §3, rank 1). Authorship gives no extra right: members count as one. One
request, for event `i` of conversation C:
1. **Transcript and tree, in one folder commit.** The erase is one commit, attributed to the member who asked, and
   it keeps core §3's order like any other:
   - the principals first (members and the rest, step 4);
   - then C's session row `FOR UPDATE`, at the session step, as a session the commit writes. There the event's body
     becomes `{"erased": true}` and `memory_generation` goes up by one. Its stored `event_hash` is kept, and chain
     checks treat an erased body as opaque. The speaker and time stay, as attribution
     (`RUNTIME-COMPANY-FOLDER-ERASURE.md` §1 keeps speaker names);
   - then the paths: every block that can hold a node with `i` among its sources is deleted. The candidate blocks
     follow from the addresses alone. At the path step, the erase lists which of them exist and deletes each at its
     current version.

   A compactor batch or zoom that read before this commit now fails its generation check (§4.3, §8), so nothing
   computed from the old text can be written back. One that checks first holds the session `FOR SHARE`, and the
   erase waits for it at that step. The erase lists the blocks only after it holds the session, so it sees every
   batch that committed before it, and deletes those nodes with the rest.
2. **Rewrite.** A second, ordinary commit writes each deleted block again with the nodes that do not have `i` among
   their sources. It reads them from the block's last version before the delete, so it runs before step 3. Writing
   a deleted path gives it a new life. The rewrite is a batch at the new generation, so it merges by position with
   any batch that recreated a block first (§4.3). Nothing it writes derives from `i`, so the order does not matter.
   A node it cannot recover is just missing, and is rebuilt (step 6).
3. **Old versions.** A P18 request on those block paths erases their earlier lives. P18 already keeps a live path's
   current life and erases its earlier ones (§2.2 there). Their index rows go with them (§5 there).
   - It follows moves, as P18 does (§2.3 there). A block can have an earlier life at another path, for example
     before its agent's folder was renamed. P18 then refuses and names that path. The erase adds each path it names
     and asks again, until no partner is open. So every life of each block is erased, at every path it had.
4. **Receipts.** Every `zoom` receipt **in the whole company** whose target is C and whose result may hold text from
   `i` gets the P18 §6 scrub: its envelope stays and its `content` becomes `[erased]`.
   - Matched by the target conversation in the receipt's input, not by the run's own conversation. Any agent may
     zoom into any conversation (§9): when Marketing opens a line of Sales's thread, the receipt belongs to a run in
     Marketing's thread.
   - Matched by range, not by a text needle: a `size = 1` receipt at `i`, or a `size > 1` receipt for a line whose
     two children have `i` among their sources. That is, `start+size` overlaps `[i, 16·⌊i/16⌋ + 32)`.
   - The erasure lists those runs in its run table, as P18 does. A run still live or with an open card stays
     `pending`, and is scrubbed once it ends (P18 §6). Receipts stored later cannot hold the old text (§8).
5. **Context views** store digests and read references only (§1), so they need nothing. P18 already keeps view read
   records. Compactor calls keep no copy of their input or output outside the tree (§7.1). A run already under way
   when the erase lands keeps what its model has read until it ends, as with a file a live run read when P18 erases
   it. Its receipts are scrubbed once it ends (step 4).
6. **Rebuild.** The next run in C rebuilds the missing nodes at closing or settle. An erased event renders as
   `<speaker>: (erased)`, a free node.

Erasing a message does not touch later messages that repeated it, such as an agent's reply quoting it. Those are
messages of their own, which an owner or admin erases the same way, as P18 decides for files (below). Their lines
then follow.

**Whole conversations.**
- Deleting an agent for good (contract 14.1, P18b) erases its folder, and its thread tree with it.
- Deleting a group folder closes the chat. The tree goes with the folder, and comes back if the folder is restored.
- Erasing the group folder's paths erases the tree's history too.

**Folder erasure of a file** (P18 today) leaves messages that quoted the file as they are. That is P18's decision:
conversations are free text that a member removes. So a conversation's tree, built only from messages, needs no hook
there. To remove such a quote, an owner or admin erases the message, and the tree follows it. Tool results live in run
logs, and §10.1 says how a file's erasure reaches them.

**GC** (decided by Jonas, 5 October). Tree files are ordinary folder files with ordinary roots. Versions are kept for
good (core §2), with one more exception next to old git objects. A version of a path under a tree root (§4.2) is
pruned when all three hold:
1. its op is a `write` with a prior. So it is not the start of a life (a `write` with no prior, a `copy` or a
   `move_in`), and not a `move_out` or a delete;
2. a later `write` of the same path took it as its prior. So it lies inside one life, and is not the last version
   before a delete or a move;
3. that later write is at least 7 days old.

The prune runs beside the git-object prune, through the same shared helper (`RUNTIME-COMPANY-FOLDER-ERASURE.md` §4
step 5).
- **Moves and life boundaries keep their rows, with their content.** P18 finds a file's lives through the start of
  each life and through its move pairs (§2.1 and §2.3 there). Suppose an agent's folder is renamed and a block is
  then rewritten at its new path. The `move_in` stays, so a later message erase still follows it back to the old path
  and erases the block's lives there too (step 3). Moves are rare, so the rows they keep cost little.
- A path's current version is always kept. So restoring a deleted group folder, or an agent's, brings its tree back.
- Only tree roots are covered. The notebook (`agents/<agent>/memory/` outside `thread/`) and every other file keep all
  their versions.
- A pruned version can no longer be restored, the same trade as for git objects. A tree is derived from the
  transcript, so a node that is missing is rebuilt by the next run in the conversation (step 6 above).
- Erasure stays immediate (step 3 above); it does not wait for the prune.

**Retention.** A tree lives as long as its conversation and its owning folder. Nothing is trimmed by age: old lines
just get coarser in the view. Run logs live under the conversation's root (§4.5), so they go and come back with it.

### 10.1 Erasure of work (W1)

A run log is a log like a conversation, with steps in place of messages. Its lines follow the same bound: the step
compactor's window holds only the same run's raw steps (§7.5), so step `j` is a source of `node(l, k)` exactly when
`w(s) ≤ j < e`. The hard rule therefore applies to steps unchanged.
- **Erasing one step.** Owners and admins may erase a step, as they erase a message. For step `j` of run A, it follows
  §10's steps 1 to 6 with A's log in place of conversation C:
  - A's `qorpera_memory_run_generations` row in place of the session row: `memory_generation` goes up in the same
    commit, taken `FOR UPDATE` at core §3's run-owned step, where step-line batches check it `FOR SHARE` (§4.5,
    §7.5);
  - the step's record keeps only `j`, `tool`, `call`, `args_bytes` and `args_hash`, with `"erased": true`. Its
    arguments, result, read references and text go. The call id keeps pairing intact, and the hash is what receipts
    keep today (`inputSha256`, P18 §6);
  - its log block and every tree block with the step among its sources are deleted, rewritten without it, and their
    earlier lives erased through P18 (steps 1 to 3);
  - **a log block is never "just missing".** Its rewrite is the only copy of the block's other steps, so §10 step 2's
    "a node it cannot recover is just missing" holds for tree blocks only. Step 3 runs for a log block only after its
    rewrite has landed with every other step. If the rewrite cannot read the block's last version, it stops, the erase
    stays `pending`, and it is tried again; no earlier version is erased until it lands;
  - step 4 scrubs every zoom **in the company** whose target is run A and whose range may hold text from `j`, by the
    same range rule as §10. It matches by run id and range, never by a block version, which the 7-day prune may have
    removed. A zoom is kept in two places, and both are scrubbed: its receipt, and the zoom step in the zooming run's
    own log. Scrubbing that step is a step erase of that run's log, so a zoom of the zoom is reached too. Each zoom is
    later than what it opened, so this ends.
- **When.** An erase that reaches a live run's log stays `pending` until that run ends, as P18 §6 does for receipts.
  So no erase changes a log while its run writes it (§4.5). A cut-off or paused run is not live: it resumes from its
  log as it then is (W5).
- **A file's erasure reaches steps.** P18 §6's rule for receipts applies to run-log steps, as a new row of its table:
  - over the runs P18 notes in phases 1 to 3 (the runs that wrote, refused, were refused about, or read the erased
    path), once they have ended;
  - a step is reached when the JSON text of its `args` or of its `result` contains a needle (an erased path as P18
    spells it, §4.3 there), or when its read references name an erased version (§4.5);
  - a reached step gets the full step erase above: its record keeps only the call's identity and hash, its log block
    and the tree blocks over it are deleted, rewritten and their earlier lives erased, and zooms of it are scrubbed
    company-wide;
  - **the drain only marks; the runtime erases.** P18's drain is one SQL step per tick (P18 §4.2), and SQL cannot
    write new block content to the object store. So the drain's new row only finds the reached steps and lists them
    on the erasure as pending, as it lists pending runs today. The runtime host's memory eraser, which makes no model
    call, takes each listed step and does the step erase above through the folder commit function. The erasure stays
    `waiting` until the eraser reports every listed step done.

  So a `company_write` step, whose `args` hold the file's text, is reached by the path it names, as P18 reaches a
  card's arguments. A search or list result that names the path is reached the same way.
- **A contact's mail.** P18 §6 leaves the erasure of company mail rows to H4's owner (P18 §6's table). A `send_mail`
  step keeps no addresses or body (§4.5). When H4 adds its row, the same row covers run-log steps: a step whose result
  holds mail from or to the contact (a mail read, for example) is reached by H4's needles and gets the step erase
  above.
- **A message's erasure reaches steps** through zoom. A zoom call is a step, and its result is the zoom receipt of §8.
  So step 4 of §10 scrubs it in both places, by target and range, as a step erase of the zooming run's log.
- **Rebuild.** Lines missing in a past run's log are built at the next settle in that conversation, after the
  conversation's own gaps, on the settling run's own payer (§7.2). Until then zoom shows placeholders, with the raw steps below.
- **Not reached**, by P18's existing decision (P18 §1: transcripts are free text that a member removes): an agent's
  own words that repeated a message or a file, and shell output that printed a file's text with neither its path nor
  a read reference. An owner or admin erases such a step, and its lines follow.

## 11. What the tree replaces

Decided by Jonas on 5 October: the tree replaces the diary and `history`, and the profile page stays. Widened the
same day: the tree is the agents' whole context, so it also replaces Codex's own history inside a run.

| Today | After |
| --- | --- |
| `history`: the last 32 events, 2 KiB each (C §9.1 "recent canonical transcript") | the view (§5); `history` and `historyTruncated` leave the prompt |
| Codex's own history inside a run, and its own compaction | the run's own work, folded (§5.7), in every request (§6, W2) |
| `vision/vision.md`, which the role text tells some agents to read with a tool | the company head, in every request of every run (§5.6, W3) |
| notebook `profile` tier, composed whole (6 KiB) | **kept**, as part of the agent head (§5.6): standing instructions and facts the agent must never lose |
| notebook `log` tier (two months, 8 KiB composed) | removed: the conversation lives in the tree, and the work in run logs |
| notebook `note` tier (fades after 7 days) | removed |
| continuations' `receipts` and `priorSends` | kept for new runs after a worker, office or machine event; their earlier run's log is one zoom away. A resumed run reads its own log (W5) |
| `recall_memory` | removed: `zoom` opens the tree, and `company_search` finds words in the notebook and in the summary lines of every tree (§9). The view is the index, as in OptChat; M2's probe shows whether a word search over the raw messages is needed |
| `update_memory` | kept, profile tier only |

- There are no users, so nothing is migrated. Hiring stops seeding `memory/log/`, and the log composer goes.
- Contract 5.4, 9.1 and 15.1 change with it (§16).
- The notebook is trimmed at M5, once the probe has met §13's targets. Until then a company with the tree on keeps
  its notebook as it is, and the tree replaces only `history`.

**Proposal for Jonas, not decided: pins.** The profile page is a file the agent writes about itself. Pins would be
its successor: a member or the agent pins a message or a line of any conversation or run log into the agent's head,
up to PINS bytes, and the agent's head then shows the pinned text with its address. A pin keeps the exact words and
their source, and an erase of the source removes the pin. A pin keeps its source's trust label too: a pinned work
line is tool-result data and a pinned message is conversation data, never an instruction (§5.6). The profile page
stays until Jonas decides.

## 12. Routines, workers, coding, resume, review and onboarding

- **Routines and other wakes** (event, file and supervisor work) run in the agent's thread, so they see the thread
  view. A routine's intent stays on its own wake, after the view (§6). Its run builds the lines of its own sends and
  steps, on its own payer.
- **Workers** (W4). Today they start blank with a bounded dispatch (contract 13). After W4 a worker's first request is
  composed from the head and its parent's views, exactly as the parent's run composed them at dispatch, by reference,
  with its dispatch as the current input. The prefix is the parent's, so on the same payer it is read from the cache.
  A worker runs on its parent's payer, as work that follows from it (C:2035-2044). Its run log nests under the
  dispatching step (§4.5). Its report comes back as today, and its work stays one zoom away.
- **Coding sessions** (W6) are their own Codex sessions on coding machines. Their turns become child logs of the step
  that started them. A Codex coding session can compose its requests like any run once W2 is proven. A Claude Code
  session runs the unmodified binary, which cannot be patched: it gets the head and views only at the start of each
  answer, and its transcript is copied into its child log after each turn. W6 designs this.
- **Resume after a cut-off** (W5). A run commits its steps as it goes (§4.5). When its machine or process goes away,
  the run resumes on any machine: a new Codex process, the same run, its input composed from its log. A call that was
  committed with no result is shown as "outcome unknown: check before you repeat it". Effectful calls are committed
  before they run (§4.5), and folder writes at an expected version make a blind repeat fail safely. Today a started
  run that is cut off is never retried, and ends in review as `native_execution_uncertain` (§1).
- **Pause at a usage limit** (W5). Today the run fails and the member is told (§1). After W5 it pauses with its log
  kept, and resumes **on the same login** once the limit resets. The member is told, and may cancel it. It never moves
  to another login (C:2062-2078).
- **A model or payer change** between requests or runs costs only the provider cache and the reasoning items (§6).
  The context is the tree's, so the next request carries the same information.
- **Auto-review** is unchanged. It still sees the member's latest three messages (`RUNTIME-AUTO-REVIEW.md:102-115`).
- **Agent messaging** pair transcripts come in M6, with their tree root decided then. Until then a woken agent sees the
  last 12 lines, as today.
- **The Co-Founder's onboarding** (`rt/cloud-runtime-hire-overlays.ts:6-17`). The first conversation builds the vision
  with the founders, and the tree keeps their words near-verbatim (§7.4, priority 1). That is what a long onboarding
  needs. The approved vision goes into the company head from W3, so every run sees it, as C:887 already asks.
- **The provider's own compaction** inside a long run is unchanged until W2, and still recorded as a context-view
  purpose. From W2 composed requests stay far below its threshold, so it is never reached (§6).

## 13. What we measure

**Recorded per run** (existing records, plus new observation kinds):
- `model_turn` (exists): `inputTokens`, `cachedInputTokens`, `reasoningOutputTokens` and `totalTokens`.
  `context_bytes` on the launch (exists).
- `memory_view` (new), **per composed request** (§6):
  - the step number, `T`, and the bytes of the head, the view, the branches and the run view;
  - raw steps, placeholders, the wait in ms, and the lines built while waiting;
  - whether the run view folded at this request;
  - the hash of the stable prefix, to check cache hits against.
- `memory_compaction` (new, per batch): the log kind (conversation or run), calls, free nodes, input, cached and
  output tokens, overshoots, failures, whether a limit was hit, and the payer connection.
- `run_resume` (new, W5): why the run resumed (restart or limit reset), the steps read back from its log, and the
  calls shown as "outcome unknown".
- `zoom` tool operations (counted like every tool), with the target kind.

**Rolled up per company and agent per day:**
- the tokens of their runs, split into the agent's own and the compactor's, and the cached share;
- **cost per answer**: all tokens, the compactor's included, per message the agent sent;
- **re-reads**: the same path and version read twice in one run, or in runs of one conversation on one day. They come
  from the read references the context views already record (§1).

The split by payer login exists only to show what each login's limit spent.

**Probes**, scripts on Qorpera Live Test (10c3ee8c). Each runs with the tree off, as the baseline, and with it on.
1. **Memory probe** (M2):
   - A scripted conversation of 300 messages with the Co-Founder, in Danish and English. It plants 20 items at known
     ages: decisions, numbers, corrections ("not Tuesday, Thursday") and one standing instruction given at message 20.
   - From M4 on, four of the 20 are planted in a group chat the Co-Founder takes part in instead, and two in another
     agent's thread.
   - Twenty questions about the planted items, asked in the Co-Founder's thread, then a task that needs the standing
     instruction. The answers are scored against the planted facts.
2. **Work probe** (W2): one long task of at least 150 tool steps, for example a price list built from 40 files. Ten
   facts appear only in early tool results, and the end of the task needs them. The baseline is today's Codex history,
   with Codex's own compaction. Scored: facts used correctly, steps, re-reads and tokens.
3. **Folder probe** (W1): questions about past work, such as "which files did you change on Monday, and why?". They
   can only be answered by zooming into earlier runs' logs.
4. **Swap probe** (W2, W5): the memory probe again, but the model changes every 50 messages, the payer moves between
   two test logins, and the machine is restarted in the middle of two runs. It is scored against the same probe run
   without swaps.

**Targets** for switching the tree on everywhere (M5):
- at least 16 of 20 recalled, and the standing instruction followed;
- runs after the first, within the cache's lifetime, read at least 60% of their input from the cache;
- compactor tokens at most 25% of the agent's own tokens per message;
- median settle wait under 2 s, and a median of at most 2 zooms per run.

**Targets** for composing every request from the tree (W2 on everywhere):
- the work probe uses at least 9 of 10 facts, at most as many re-reads as the baseline, and at most 10% more tokens
  per finished task;
- requests inside a run read at least 70% of their input from the cache (79% was measured with Codex's own history,
  §1);
- the swap probe recalls at most one item fewer than the unswapped run, and no resumed run repeats an action.

## 14. Build plan (after approval)

No slots or test numbers are reserved yet. Each step is its own PR with its own review. M steps build the tree of
words; W steps make it the whole context.

| Step | What | Proof |
| --- | --- | --- |
| **M0** | Probe, no product code, with the patch as it is today and no key set: the Codex 0.155.1 request order, the `prompt_cache_key` Codex sends, `cachedInputTokens` within a run and across runs with a fixed prefix and with a growing conversation, and where Codex's auto-compaction starts; today's real per-run sizes on Live Test from `model_turn` | a short report; decides §6 |
| **M1** | Agent threads on Live Test only, behind a deploy-config list of company ids: tree files, refusals and index (SQL); `memory_generation` and the checked batch commit; fold, rendering and VIEW_DOC; closing compactor with its raw window, and settle that fills gaps any run left; `zoom` into any agent's thread, with fitted results; view in developer instructions, as labelled data; quotes fenced in every line, window and zoom; stable `read_context` schema; `memory_view` and `memory_compaction`. The cache key in the patch once Jonas has said yes to it (§16), with the shared-key cache check M0 leaves open | SQL tests for index, write refusals, ordinary reads and search of tree files, and the generation check (a batch read before a generation change is discarded), and a dblink race of a batch commit and a zoom receipt against a payer's role change (`qorpera_folder_member_change_enter`) that ends with no deadlock; runtime tests for fold determinism, budget, placeholders, size enforcement, a zoom by an agent into another agent's thread whose result is the same whichever member the run works for, and a markup-heavy zoom read whole through `from`; contract Order 2's fake-instruction proof (C:2136) through a view line; the quote amendment's test 7 (C:4571) through a free node, a compactor line and a zoom; one live run that writes and reads a tree |
| **W1** | Run logs (§3, §4.5): step records committed in batches that only append, effectful calls committed before they run, the run index, platform-only paths, step lines at closing, `zoom` into run logs, and a message's zoom naming its run; erasure of work (§10.1): one step's erase, the P18 scrub of steps by needle and read reference, the scrub of zooms into a run log, the zoom-step scrub of a message erase, and erases of a live run's log held until it ends | SQL tests for run-log refusals; a step-line batch read before a step erase is discarded, and a step batch is never discarded; a step scrubbed because its read reference names an erased path; a `company_write` step whose `args` are scrubbed when its path is erased; run B zooms a step of run A that read file F, and erasing F scrubs A's step, B's receipt and B's zoom step, and leaves no earlier version of A's log block; an erase of a live run's step stays pending while the run's batches keep landing, and runs when it ends; a step erase that rebuilds the lines over it; a step erase whose log-block rewrite cannot read the last version stays pending and erases no earlier version; a file erasure whose drain lists the reached steps and stays waiting until the memory eraser reports them done; a step batch that still finds its log by run id after the agent's folder is renamed; a run whose log folder is deleted gets `memory_run_log_gone` and no effectful call pre-commits; a send, card or `send_mail` step whose `args` hold only the hash. Runtime tests: a run's log matches its context views call for call; an effectful call whose pre-commit fails is not run. The folder probe |
| **M2** | Measure and tune: the memory probe, VIEW at 48,000 vs 96,000, Luna low vs medium | probe report against §13's targets |
| **M3** | Erasing one message (§10): the generation raise, the rebuild of every line with the message among its sources, and the receipt scrub by target and range across all runs | SQL tests, including a later message whose line named the erased fact, a Co-Founder zoom into another thread, a compactor batch and a zoom receipt racing the erase (each either lands before it and is deleted or scrubbed, or is discarded and redone at the new generation), and an erase racing a role change, with no deadlock; a block with an earlier life at its agent's former path (a renamed folder), erased at both paths; live: erase, then see the lines rebuilt and old versions gone |
| **M3b** | The 7-day prune of replaced tree versions (§10, GC) | SQL tests: a block version replaced by a write more than 7 days ago is pruned. Kept: the current version, one replaced less than 7 days ago, a life's first version, the last version before a delete or a move, both rows of a move pair, and old versions of a notebook file. Regression: an agent's folder is renamed, a block is rewritten at its new path, and 8 days pass; the prune keeps the `move_in`, and a message erase then erases the block's lives at both paths |
| **W2** | Every request composed from the tree (§6): first the compose probe (§6.4), then the composition capability in the Codex patch, in-run folding of the run's own work (§5.7) in its runtime envelope, step lines built during the run. **Needs Jonas's sign-off on the patch scope (§16) before the compose probe** | the native proofs run again with the new capability; runtime tests for pairing after composition, a forged work message refused, folds only at boundaries, the raw tail within RUN_VIEW / 2 or the newest model response, a response with parallel calls never split by a fold, folded lines within §5.7's bound, reasoning dropped after a model or payer switch, and Codex's own compaction never reached; contract Order 2's fake-instruction proof (C:2136) through a tool result that has been folded into a step line; the work probe and the swap probe without restarts |
| **W3** | The head (§5.6): vision, job specification and profile page in the stable prefix, as labelled data | runtime test that the head is byte-identical across runs and members, and that its text is escaped; contract Order 2's fake-instruction proof (C:2136) through a profile write that a fetched page asked for; the memory probe's standing instruction |
| **M4** | Group chats, branches of every conversation the agent takes part in, and the Co-Founder's branches of every agent's thread | runtime tests for branch choice and budget; probe: a fact said in a group chat is recalled in the agent's own thread, and the Co-Founder recalls a fact from another agent's thread |
| **W4** | Workers start from their parent's view by reference, and their logs nest under the dispatching step (§12) | runtime test: a worker's first request shares the parent's prefix and reads it from the cache on the same payer; zoom from the parent's step into the worker's log |
| **M5** | On for every folder-v2 company; notebook trimmed to its profile page (§11) | the probe on a fresh company |
| **W5** | A cut-off run resumes from its log, and a run at its usage limit pauses and resumes on the same login after the reset (§12). **Contract change; needs Jonas's sign-off** | live: kill the machine mid-run twice, and run a test login to its limit; each run finishes without repeating an action; the swap probe with restarts |
| **W6** | Coding sessions as child logs of the step that started them (§12) | to design with W6 |
| **M6** | Agent pair transcripts | — |

**Gates.**
- M3 must be live before M5. Without it, the hard erasure rule has nothing to act on, but the tree must not reach real
  companies before a message can be erased. M3b comes before M5 too, so no real company keeps rewrite noise for good.
- W1's erasure of work is live before W2 reaches a real company, for the same reason: a run's work feeds its lines.
- W2 reaches real companies only after its probes meet §13's targets.
- W5 waits for its contract amendment.

## 15. Alternatives we rejected

- **The tree in database tables.** It is new company data, so it belongs in the folder (founder rule, 3 October). The
  only tables are indexes rebuilt from the files.
- **Moving conversations into the folder.** Contract 5.6 keeps conversations as runtime state, and delivery, the
  exactly-once send and the hash chain live there. The tree points at the transcript instead.
- **Run work in `qorpera_session_events`.** The events are hash-chained, a send is appended exactly once under the
  session lock, and the erasure scrub would have to reach into the chain. A run writes many steps a minute, so the
  session lock would be held all the time. Run logs are folder files instead (§4.5).
- **Reader rules per member or per group chat**, as the first draft had: a group chat's lines kept inside the group,
  and each run's audience checked. Qorpera is company-first and agent-first: members count as one, and every agent may
  read every conversation (§9). Such rules would hide the company's memory from the agents that need it.
- **Tool work inside the conversation's log**, as OptChat logs it. Work would crowd out the words: a run of 200 steps
  would push the decisions around it into coarse lines. The words would also be summarized together with file copies
  and machine output. So work gets its own log per run, linked from the reply, closed until zoomed (§3).
- **No work in the tree at all**, as the first version of this page had. Then the tree could not carry a run: Codex's
  own history would still hold everything inside it, and a restart, a model change or a payer change would lose it.
- **Codex's own history inside a run.** It lives in one process and is tied to one login and one model. It grows until
  Codex compacts it, in a way we do not control or record as lines, and it ends with the run. Composing every request
  from the tree removes all three limits (§6).
- **A background summarizer drain.** It would need a member's login outside a run, and a ChatGPT plan never pays for
  work no member started (§7.1). It can be revisited when a company account can pay.
- **The newest messages in full.** OptChat found that one large message forces old lines to merge for good, and
  breaks the budget. Steps are bounded the same way: a raw step is at most the fence's 8 KiB envelope (§4.5).
- **OptChat's compactor context: the folded chat before the node.** It resolves more references, but each line could
  then carry a fact from any earlier message. Erasing one early message would mean rebuilding every line after it,
  and the view would be placeholders until then. The raw window of §7.3 keeps each line's sources within 31
  messages before the first message it covers. M2's probe measures what the shorter context costs in quality.
- **A window that slides by one message.** Each call's prefix would differ from the last one's. The window starts at a
  multiple of 16 instead, so the calls of one group share it (§7.3).
- **One file per tree, or one per message.** One file is rewritten whole on every batch, and kept forever. One per
  message gives too many folder entries. Blocks of 16 are the middle way.
- **Composing every step inside Claude Code.** The unmodified Claude Code binary is the only program Anthropic lets a
  member's Claude login run, so it cannot be patched. There the tree can only be given per answer (W6).

## 16. Contract amendment (to draft after approval)

"2026-10-xx amendment: agent context as a folder of summary trees" would change:
- **5.4**: memory is the head (§5.6) plus the conversation trees and run logs; chats remain the audit record, and
  trees are derived from them. Pins as the profile page's successor are a proposal for Jonas (§11).
- **5.6**: tree roots under agent and group folders, with run logs under them; platform-only writes; ordinary reads;
  the erasure generation on the conversation and on each run log.
- **9.1**: "recent canonical transcript" becomes "the conversation's view and branches of the agent's other
  conversations". **Every model request of a run** is composed from the head, these views and the run's own folded
  work (§6). The vision is read at every run as 9.1 already says (C:887), now as part of the head. Every part keeps
  its source and trust label (9.2): the head is labelled data, and the run's folded work is tool-result data in a
  runtime envelope (§5.6, §5.7).
- **9.2 and 9.3**: the developer message, today host-owned rules and validated identifiers only, also carries
  labelled, escaped company data: the head (the vision, the job specification and the profile page or pins) and the
  primary view. It is done for the cache (§5.6). The labels, not the role, keep that data from counting as
  instructions. In 9.3, the bootstrap carries the job specification in the head, instead of pointing to the hire
  overlay (C:953).
- **13 (workers)**: a worker starts from its parent's view by reference, plus its bounded dispatch.
- **14.2**: the Co-Founder's view holds branches of every agent's thread; it still receives no copies.
- **15.1**: the notebook keeps only its profile tier (§11); `zoom`, which reads any conversation or run log of the
  company.
- **Native Codex** (`deploy/first-node/native-codex/README.md:94-95`, "Only result bodies can change"). Each
  extension of the patch is authorized on its own (README :3-5, :15), and this design asks for two:
  - **the cache key** (M1): the patch sets `prompt_cache_key` to the stable key of §6.2;
  - **composition** (W2): the host returns a request's whole input, within §6's rules.

  The model, the tools and Codex's base instructions still cannot change. **Both lift an authorized boundary, so they
  need Jonas's sign-off.** Until then, M1 runs with the key Codex sends itself.
- **Runs** (C:2062-2078, and the rule that a started native turn is never retried): a cut-off run resumes from its
  log; a run at its usage limit pauses and resumes **on the same login** after the reset. It never moves to another
  login: OpenAI's terms forbid rotating accounts around a limit (C:2062-2078). **Needs Jonas's sign-off.**
- **Folder versions** (the 2026-09-27 amendment, item 9; core §2): next to old git objects, versions under a tree root
  that a later write replaced are pruned 7 days after that write (§10, GC). Jonas approved this on 5 October. Run logs
  sit under tree roots (§4.5), so the prune also removes the versions of a log block written while its 16 steps
  filled; each later version holds every step the earlier one held.
- **17**: a run's summaries, and the gaps it fills, are part of its work and are paid by its payer.
- **P18**: erasing one message or one step by an owner or admin, and the tree's rebuild after it. A new row in P18 §6:
  run-log steps whose arguments or results contain an erased path, or whose read references name an erased version,
  get the full step erase once their run has ended, with every zoom of them (§10.1).
- **Company-wide conversations**: every member and agent of the company may read every conversation, run log and tree.
  Group membership decides who takes part and whom a post wakes. The rule in `RUNTIME-COMPANY-STATE-FILES.md:280-281`
  that an agent adds to `people` only the member its run works for loses its reason ("adding a person lets them read
  the conversation"), so it should go. That page's owner changes it; this design does not depend on it.

## 17. Risks and unknowns

- **The Codex request shape and the provider's caching on ChatGPT logins are not verified.** M0 settles the shape and
  the caching it can see with the patch as it is today, before any build. Caching across runs under one shared key is
  checked in M1, once the key is approved.
- **The composition patch is deeper than the fence.** Every Codex upgrade must carry it, and its proofs run again.
  It changes nothing about sign-in, credentials or transport, so it does not change our standing with OpenAI (see the
  provider policy notes), but it is more of the client that we patch.
- **Pairing and reasoning.** The provider refuses an input with a call and no output, or reasoning from another model.
  The patch checks pairing (§6). Dropping reasoning after a switch may cost one step some quality; the swap probe
  measures it.
- **Company data in the developer role.** The head and the view sit in the developer message for the cache (§5.6).
  Labels and escaping keep them distinguishable, but a model may still weigh a line there more than the same line in
  user data. Contract Order 2's fake-instruction proof runs through a view line (M1), a profile write (W3) and a
  folded step line (W2). If any fails, that part moves to the user message, and the cache loss is measured.
- **Folds inside a run cost cache.** Each fold of the run view re-sends the run's part of the request. Folds happen
  only at boundaries, about once per RUN_VIEW / 4 of new work. W2 measures the cached share.
- **Usage.** A ChatGPT plan's limit is the real cost to a member. Compaction spends it, and so does a bigger view.
  M2 and W2 decide the sizes from measurements.
- **Line quality** in Danish at low effort is unknown, and so is the cost of a compactor window of 16 to 31 raw
  messages or steps instead of OptChat's folded chat. M2 and W2 measure both.
- **Latency.** Each zoom is one more tool round. Closing compaction holds the slot up to CLOSE after the reply, and the
  run lease must allow that time. A fold inside a run may wait for lines (§5.7).
- **Storage.** Block rewrites cost a few KB per message, kept for 7 days (§10, GC). Run logs cost at most about 16 KiB
  per step (a call and its 8 KiB envelope), so a 500-step run stores about 8 MB, kept like the conversation.
- **Shell output without a read reference.** A step that printed a file through a shell, with no read reference, is
  not found by a file's erasure. That is the same as P18 decides for receipts and transcripts today (§10.1).
- **The fence's 8 KiB envelope** bounds zoom pages. A long message takes several calls to read in full.
