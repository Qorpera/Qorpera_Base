# Agent memory tree: the M0 report

Status: done 6 October 2026, from source and from Live Test's records. No model was called.

M0 is the first step of `RUNTIME-AGENT-MEMORY-TREE.md` (§6.4, §14). It asks six questions about how Codex 0.155.1
builds its requests, caches them and compacts. On 6 October Jonas deferred every test that needs a Codex subscription
to a test release the week after ("just ignore tests that needs a codex subscription"). So this report answers what
the source and the records can answer, and lists the rest under "Deferred".

Sources:
- Codex 0.155.1, `codex-rs` at `be2951ea`, as our patch builds it. Paths below are relative to `codex-rs/`.
- Our patch, `deploy/first-node/native-codex/0001-cloud-result-fence.patch` (here "patch").
- One read-only query on Live Test, by company id, of its newest 22 runs (4 and 5 October): `model_turn` and
  `native_result_fence` observations and `qorpera_native_execution_launches`. Queried 2026-10-06T09:57Z.

## Answers

### 1. Where the environment context goes, and whether it adds a date

A request has `instructions` (the base instructions) and `tools` (the tool list) as fields of their own
(`core/src/client.rs:784-890`). The input then starts with the initial context, in this order
(`core/src/session/mod.rs:4064-4299`):
1. one developer message: the developer instructions from config, then extension fragments, then the world-state
   sections (permissions and the like);
2. any separate developer messages;
3. one user-role message: plugin notes, then AGENTS.md, then `<environment_context>`;
4. guardian and managed items;
5. the user message.

So the environment context comes after the developer message, as the design assumed (§6.1, part 4).

What it holds on our path is less than the design assumed:
- It holds `<current_date>`, the local day as `%Y-%m-%d`, and `<timezone>` when one is set
  (`core/src/world_state.rs:229-247`). When the date changes during a thread, Codex appends a diff.
- **It holds no working directory.** Our host starts threads through the app-server with `environments: []` and
  `runtimeWorkspaceRoots: []`. With no environments there is no cwd, no workspace roots and no shell in the context
  (`app-server/src/request_processors.rs:634-681`, `app-server/src/thread_processor.rs:1442-1446`,
  `core/src/environment_selection.rs:999-1001`, `core/src/environment.rs:64-69, 254-258, 507-512`).
- The permissions section for read-only does not name the cwd (`core/src/permissions_instructions.rs:198-212,
  316-324, 346-362`; read, not run). The cwd goes only into request metadata (`core/src/turn_metadata.rs:180-208,
  283-295`).
- The `<current_time_reminder>` developer item (UTC, to the second) sits behind the feature `current_time_reminder`,
  which is under development and off by default (`features/src/lib.rs:1634-1639`). `apply_persistent_defaults`
  (`core/src/time_reminder.rs:16-37`) may switch it on together with the sleep tool; we did not find its caller. Our
  patch drops the clock, current-time, sleep and async tools when `QORPERA_NATIVE_RESULT_FENCE_SOCKET` is set (patch
  lines 562-577 and 1396-1462).

So the only part of the environment context that varies is the day. Two runs on the same day get the same bytes there.

### 2. What Codex sends as `prompt_cache_key`

The session id, which is the new root thread id of each run (`core/src/session.rs:814-821`,
`core/src/client.rs:497-509`). The only override is for guardian sessions (`core/src/session.rs:1562-1568`). We found
none in the app-server (`thread_processor.rs` and `request_processors.rs` searched). Subagents inherit their root's key.

Other cache-related fields: `store: false`, no `prompt_cache_retention`, and `include: ["reasoning.encrypted_content"]`.
`previous_response_id` is sent only on the WebSocket transport, and only when the input strictly extends the previous
request (`core/src/client.rs:308-362, 1248-1324, 1767-1810`).

So every run has its own key, as the design expected (§1, §6.2).

### 3. Caching within one run

Seen in Live Test's records. Later requests of a run read the earlier part from the cache: up to about 90% of a run's
input tokens are cached (table below).

### 4 and 5. Caching across runs

Deferred: both need model runs (below). The records hint at the answer. A run of 3 requests has about 48% of its
input cached, which is what reuse within the run alone gives. Its first request does not look cached, so no reuse
across runs is visible (an inference, not a measurement). With a key per run (answer 2) that is what we expected.

### 6. What starts Codex's own compaction

- The limit is 90% of the model's context window by default, and the usable window is 95% of it
  (`protocol/src/openai_models.rs:385-386, 504-526`).
- The scope is `Total` by default (`protocol/src/config_types.rs:49-55`, `core/src/config/mod.rs:4188-4190`). Config
  can only lower the limit. `BodyAfterPrefix` is not clamped, but the 95% cap still holds.
- The count is the last response's `total_tokens` plus a local estimate of what was added since. It is checked at turn
  start, and after a response only if the turn goes on.
- For the OpenAI provider, compaction is remote (V2) through the same Responses endpoint (`core/src/turn.rs:1396-1454`,
  `core/src/compact_remote_v2.rs:372-400`). Our patch already fences it: P3 replaces tool outputs with host envelopes in
  every provider request, compaction included.
- The token-budget feature is off by default (`features/src/lib.rs:1610-1615`).
- The bundled default model is `gpt-6-astra`, with a context window of 272,000 tokens (`models.json:4, 33-35, 68-73`;
  `models-manager/src/manager.rs:186-208, 671-678`). That gives a usable window of 258,400 and auto-compaction at
  244,800 tokens. A ChatGPT login may refresh the model catalogue (`manager.rs:115-125`), so the live numbers can differ.

A single request on Live Test is far below that (next section), so compaction does not start today.

## Live Test's sizes

Company `10c3ee8c-184d-4884-9080-dbaaf46e6fb1`, 22 `agent_turn` runs on 4 and 5 October, each with one `model_turn`
and one prewarm. Bytes are the composed context and the tool catalogue; tokens are the run's totals over its
requests.

| context bytes | tool catalogue bytes | fenced requests | input tokens | cached | output tokens |
|---:|---:|---:|---:|---:|---:|
| 5,956 | 47,282 | 5 | 84,309 | 61,440 | 181 |
| 7,435 | 47,494 | 3 | 41,881 | 20,224 | 108 |
| 9,521 | 47,706 | 3 | 43,934 | 21,376 | 115 |
| 11,861 | 47,918 | 3 | 45,832 | 22,272 | 159 |
| 14,245 | 48,130 | 3 | 47,717 | 23,168 | 408 |
| 17,619 | 48,342 | 3 | 49,809 | 24,192 | 508 |
| 22,172 | 48,660 | 9 | 239,521 | 204,288 | 1,231 |
| 24,508 | 48,872 | 6 | 145,088 | 113,152 | 515 |
| 27,696 | 49,190 | 9 | 257,636 | 220,032 | 1,026 |
| 6,220 | 47,282 | 12 | 277,478 | 244,224 | 1,959 |
| 6,454 | 47,282 | 11 | 246,883 | 187,904 | 1,347 |
| 7,312 | 47,282 | 9 | 222,144 | 191,488 | 370 |
| 5,729 | 47,176 | 13 | 340,204 | 304,896 | 2,129 |
| 32,171 | 49,402 | 7 | 236,221 | 197,760 | 515 |
| 8,105 | 47,282 | 5 | 113,574 | 87,680 | 140 |
| 32,262 | 49,402 | 8 | 237,735 | 198,656 | 649 |
| 6,080 | 47,282 | 6 | 135,905 | 108,800 | 151 |
| 6,913 | 47,388 | 4 | 63,277 | 40,576 | 198 |
| 10,392 | 47,706 | 3 | 43,748 | 21,120 | 132 |
| 11,713 | 47,812 | 6 | 149,529 | 120,064 | 165 |
| 12,436 | 49,917 | 9 | 244,310 | 211,200 | 554 |
| 6,878 | 49,387 | 11 | 292,157 | 257,664 | 687 |

What it shows:
- The composed context is small: a median of about 10 KB, growing to about 32 KB as a conversation grows.
- The tool catalogue is about 47 to 50 KB and differs between runs. `read_context` lists the run's source ids in its
  schema, so the catalogue grows by about 212 bytes per source (§1 of the design said so; this confirms it).
- Input tokens divided by fenced requests is about 14k to 27k per request. That is far below the 244,800 at which
  Codex would compact.

## What this changes in the design

- §1 and §6.1, part 4: the environment context holds no working directory on our path, only the day (and a time zone
  if set). The random directory is not a reason for anything to vary between runs. The day still is, once a day.
- §5.6 keeps its reason in a weaker form: the developer message is still the only text before the environment context,
  and only it can be shared across days. Within one day the environment context is the same too.
- §6.2 stands: Codex's key is the run's own thread id, so the approved key (M1) is what lets runs share a cache.
- §6.3 stands: compaction starts at 90% of the window (244,800 tokens for `gpt-6-astra`), far above any request.
- §6.1, part 2 stands: the tool catalogue differs between runs today. M1 moves the source ids out of the schema.

## Deferred (needs Codex)

These run in the test release the week after 6 October:
- the probe that captures one real request and checks the order above against it;
- caching across two runs with the same developer instructions, each with its own key as Codex sends it (§6.4, 4th
  point);
- the same for a growing conversation (§6.4, 5th point);
- the check with one shared key across runs, which moves to M1 (§6.4).
