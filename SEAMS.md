# SEAMS.md — where Qorpera Base plugs into the forked core

Verified against this repository at slice 1C (2026-08-04, post-rename master).
Every path below was checked in code, not carried from the fork audit. This is
the map later slices build against: slice 2 (authority gates), slice 3 (trail
recorder + company folder), slice 4 (codex app-server engine adapter).

## a. StreamFn — the per-turn LLM seam (direct mode)

`packages/agent/src/types.ts:28` — `StreamFn = (model, context, options?) =>
AssistantMessageEventStream`. Injected into the loop (`agent-loop.ts`, config),
settable globally via `setDefaultStreamFn()` (`packages/agent/src/stream-fn.ts:11`).
`packages/agent/src/proxy.ts` implements a non-LLM StreamFn (remote forwarding),
proving the seam. The faux provider (`packages/ai/src/providers/faux.ts`,
`fauxProvider`/`setResponses`) is the scripted test double — used by
`packages/agent/test/harness/headless-smoke.test.ts`.

**Qorpera use:** direct mode ("the scoped, focused mind" — trail audits,
revision reading) runs here with our own short prompt. This seam is per-turn:
pi still owns the loop and tool dispatch.

## b. Session-level engine seam — `PiSessionBackend` / `PiSessionRuntime`

`packages/server/src/types.ts:41-63` — `PiSessionRuntime` (snapshot, getPhase,
prompt, steer, abort, setModel, setThinking, subscribe, dispose) and
`PiSessionBackend` (listSessions, listModels, createSession, openSession).
**Status: interface only.** The sole implementation is the conformance test
double at `packages/server/src/testing/backend.ts`; `packages/server/README.md`
says the pi-native backend has not landed. Upstream's `harness-v2.md`
(`packages/agent/docs/harness-v2.md`) is an in-flight redesign of this layer —
expect the shape to be ours to own post-fork.

**Qorpera use:** slice 4 implements this shape twice — over `AgentHarness`
(pi-native) and over codex app-server (engine mode: their loop, their caching,
their orchestration; our kernel appended as developer-tier instructions). The
oh-my-pi Cursor bridge (`packages/ai/src/providers/cursor.ts` +
`coding-agent/src/cursor-bridge-tools.ts` in that repo) is the open reference
for remote-loop + local-tool-exec-bridge + approval gating.

## c. Tool-call enforcement points — where slice 2's authority gates mount

Core loop: every tool execution passes through `prepareToolCall`
(`packages/agent/src/agent-loop.ts:600-664`), which runs
`config.beforeToolCall` and converts `{block: true, reason}` into an error
result **before** execution. Verified: `executePreparedToolCall` has exactly
two call sites (`agent-loop.ts:461` serial, `:523` parallel) and both are
preceded by `prepareToolCall`. `afterToolCall` (`agent-loop.ts:720`) can
override results.

Extension layer: `agent-session.ts:470` (`_installAgentToolHooks`) sets
`agent.beforeToolCall` to forward into the extension runner's `emitToolCall`
(`core/extensions/runner.ts:932`) — extensions subscribed to `tool_call` can
return `{block: true, reason}`; first block wins. `ToolCallEvent` docs:
`core/extensions/types.ts:899`.

**Bypass analysis (the important part):**

1. **No bypass inside the loop.** All model-initiated tool calls are gated.
2. **`agent-session.ts` OVERWRITES `agent.beforeToolCall`.** A gate installed
   as a core-level `beforeToolCall` would be clobbered by the extension-hook
   installer. Slice 2 must either mount as an extension `tool_call` handler or
   integrate inside `_installAgentToolHooks` — not both layers independently.
3. **Extensions are trusted code.** They run in-process with full user
   permissions and get `pi.exec(command, args)` (`core/extensions/types.ts:1328`)
   plus arbitrary Node imports — outside tool gating entirely. Project-local
   extensions load only for trusted projects (`core/project-trust.ts`), but a
   gate CANNOT constrain extension code via the tool-call path. Qorpera
   consequence: the agent may author extensions freely, but *activating* them
   is itself an effect the authority layer must own (spec §4 — gates bind
   self-built tools; here that means gating extension load/reload, not just
   tool calls).
4. **The bash tool is one gate for arbitrary commands.** `beforeToolCall` sees
   the full command string in `args` — money/identity/irreversible
   classification must parse intent at that boundary or wrap execution
   environments; a single allow on `bash` is an allow on anything.
5. **Upstream ships no permission system** (root README states this).
   Everything above is enforcement *points*, not policy. Policy is Qorpera's.

## d. Session storage — where the trail attaches

Interfaces: `SessionRepository`/`SessionStorage`
(`packages/agent/src/harness/session/repository.ts`, `harness/types.ts`).
Implementations: JSONL (`session/jsonl-repo.ts` — `JsonlSessionBackend`,
`JsonlSessionRepository`), in-memory (`session/memory-repo.ts`), SQLite
(`packages/storage/sqlite-node`). Entries are a tree: `SessionTreeEntryBase`
(`harness/types.ts:375`) carries `id` + `parentId`; message entries embed the
full `AgentMessage` including tool calls, tool results, model/provider/usage
attribution (asserted headless in `headless-smoke.test.ts`). Sessions persist
under the sessions root as `--<encoded-cwd>--/<timestamp>_<id>.jsonl`, header
line `{type: "session", ...}`.

Custom entries: extensions can `appendEntry(customType, data)`
(`core/extensions/types.ts:1312`) — persisted in the tree, excluded from model
context by default, projectable via `SessionContextBuildOptions.entryProjectors`
(`session/session.ts`).

**Qorpera use:** slice 3's trail recorder is a `SessionRepository` decorator or
subscriber normalizing every engine's events into the company trail
(`trail/…`); the session tree is already the right shape (spec §3 — same JSONL
parent-pointer structure). Branch mechanics (`fork()`, `navigateTree()`,
`branch_summary`) verified headless: navigating to an entry re-points the leaf;
the next prompt appends a child there — branch = entry with 2+ children.

## e. Extension loader — the self-modification mechanism

`packages/coding-agent/src/core/extensions/loader.ts` — single-file TypeScript
extensions, loaded via jiti with **no build step**, from `~/.qorpera/agent/
extensions/*.ts` (user) and `<project>/.qorpera/extensions/**` (project,
gated on project trust). Registration surface (`core/extensions/types.ts`):
tools, commands, shortcuts, flags, providers, renderers, ~40 events, plus
actions (`sendMessage`, `appendEntry`, `exec`, …). The documented
author-then-hot-reload-in-one-session pattern (`docs/extensions.md`, reload via
`ctx.reload()`) is the concrete mechanism for "the agent builds its own
capability" (spec §2.1 `app/tools/`) — subject to the gate consequence in c.3.

## f. System-prompt composition — where the kernel file enters (direct mode)

`packages/coding-agent/src/core/system-prompt.ts` — `BuildSystemPromptOptions`:
`customPrompt` (full replacement), `appendSystemPrompt`, `promptGuidelines`,
`contextFiles` (wrapped as `<project_context><project_instructions path=…>`),
`skills`. At the core layer, `AgentHarness` takes `systemPrompt` as a string or
callback (`harness/types.ts`). Context-file discovery feeds AGENTS.md-style
files into `contextFiles`.

**Qorpera use:** per spec §5.1 the kernel lives as the locked AGENTS.md/
CLAUDE.md at the company root and arrives through the context-file channel on
ANY harness; in direct mode our short base prompt replaces the default via
`customPrompt`. The pi-docs pointer block was already removed in slice 1B.

---

Status summary: (a) exists as audited · (b) interface-only, confirmed —
adapters are ours to write · (c) exists, with the four caveats above (c.2 is
new information vs the audit) · (d) exists as audited, verified headless ·
(e) exists as audited · (f) exists as audited.

**Slice 2 update (2026-08-04):** the authority gates now occupy seam (c) —
`src/core/authority.ts`, mounted core-owned at the head of
`_installAgentToolHooks` (ahead of extension handlers, resolving c.2) and in
the resource loader's project-extension filter at every jiti load site
including pre-trust (resolving c.3 for project-local code: durable
per-content-hash approvals). c.4 (bash is one gate for arbitrary commands) is
mitigated by a conservative destructive-pattern screen plus protected-path
tokens; a full answer needs sandboxed execution environments (later).
See `packages/coding-agent/docs/authority.md`.
