# Engine mode: codex app-server

Qorpera Base's default runtime for real company work (spec §6.0). The codex
app-server runs its own loop — co-trained prompts, its own tools, caching,
compaction — and Base does exactly three things around it:

1. **Lifecycle.** `initialize` → `thread/start` → `turn/start` per task. The
   desktop host binds the run to one durable company agent and supplies that
   agent's private instructions, artifact measures, connector inventory, and
   lifecycle behavior. An agents-only company has no root universal
   `AGENTS.md` persona and no unnamed company-wide controller.
2. **Trail.** Every completed item is normalized into the session tree:
   agent messages become assistant messages with model/usage attribution;
   reasoning, command executions, and file changes persist as `custom`
   entries (outside model context). Inside a company folder the session
   lands in `<company>/trail/` — sessions are the trail.
3. **Authority.** Codex approval requests route through the same gates as
   everything else: command approvals evaluate as `bash`, patch approvals as
   `apply_patch` per file. Declines file `inbox/gate-*.md` requests; a human
   approval is consumed by the next matching attempt. When an authority is
   present the task defaults to `approvalPolicy: "untrusted"` so every
   command consults the gates; codex's own sandbox is the containment layer
   underneath.

## CLI

```
qorpera engine codex <prompt…>
```

Run from a company root (or below it). Streams thinking/commands/gate events
to stderr, prints the final message to stdout. `QORPERA_CODEX_BIN` overrides
the binary (e.g. `"npx -y @openai/codex@latest"`); default is `codex` on
PATH, spawned as `codex app-server`.

## Wire notes (verified against openai/codex sources, 2026-08-04)

- Transport: JSON-RPC 2.0, newline-delimited JSON over stdio.
- Targeted surface: `initialize` (+`initialized` notification),
  `thread/start` → `{thread:{id}, model, modelProvider}`, `turn/start`,
  `item/started` / `item/completed` (`item.type`: `agentMessage`,
  `reasoning`, `commandExecution`, `fileChange`, …), `turn/completed`
  (`turn.usage: {inputTokens, cachedInputTokens, outputTokens}`), and the
  server→client requests `item/commandExecution/requestApproval` /
  `item/fileChange/requestApproval` answered with
  `{decision: "accept" | "decline"}`.
- The final answer is the LAST `agentMessage` of the turn; earlier ones are
  narration (recorded, not returned).
- Anything newer/experimental is ignored defensively; unknown server
  requests get a method-not-found error.

## Known environment gotchas (all hit live, 2026-08-04)

- `capabilities: { experimentalApi: true }` on `initialize` is REQUIRED for
  the v2 item notification stream on current app-server builds — without it
  `turn/completed` arrives with no `item/completed` events at all.
- An `~/.codex/config.toml` written for a newer codex than the installed
  binary makes `thread/start` fail with a config parse error (e.g.
  `service_tier` variants). Fix by aligning the binary
  (`QORPERA_CODEX_BIN="npx -y @openai/codex@latest"`) or the config.
- A stale subscription token yields turns that fail with 401 to
  `api.openai.com/v1/responses` (codex retries 5×, then `turn/completed`
  with `turn.status: "failed"` — which the adapter surfaces as an error and
  records as a `codex_turn_failed` trail entry). Re-run `codex login`.
- On Windows the npm `codex` shim requires a shell spawn; `dispose()`
  tree-kills the wrapper so no codex.exe is left behind.
- `QORPERA_ENGINE_DEBUG=1` dumps every received wire line to stderr.

## Tests

`test/codex-engine.test.ts` is hermetic: `test/fakes/fake-codex-app-server.mjs`
speaks the targeted v2 subset and records every approval decision it
receives. Live verification is manual (`qorpera engine codex …` in a scratch
company) — it spends subscription tokens, so it is not part of the suite.
