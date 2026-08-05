# Authority gates

Qorpera Base's enforcement layer (spec §4): full freedom in thought and
construction, gates on effect. Implemented in `src/core/authority.ts`,
mounted in two places — `agent-session.ts` (`_installAgentToolHooks`, ahead
of extension `tool_call` handlers) and the resource loader's
project-extension filter. Without an `authority.toml` above the working
directory, everything is `allow` and Base behaves like the stock harness.

## authority.toml

Lives at the company root (discovered walking upward from the session cwd).
Human-owned: the agent editing it is itself a gated effect.

```toml
[money]
mode = "gate"          # auto | notify | gate
limit_usd = 50         # parsed; enforcement of limits lands with money tools

[identity]
mode = "gate"          # acting AS the company externally

[irreversible]
mode = "gate"          # destructive/unrecoverable actions

[authority]
mode = "gate"          # ALWAYS gate — this line is decorative; the engine
                       # forces it regardless of what the file says

[tools]                # optional per-tool overrides
deploy = "irreversible"
bash = "none"          # opt a tool out of built-in classification
```

Modes: `auto` (proceed silently) · `notify` (proceed, record a line in
`inbox/notices.md`) · `gate` (block the effect, file a request). A malformed
file fails **closed** — every class gates.

## Built-in classification

- **authority**: writes/edits touching `authority.toml`, root `AGENTS.md` /
  `CLAUDE.md`, or anything under `inbox/` (the agent cannot approve its own
  requests) — checked for `write`/`edit` path args and screened in `bash`
  command strings; also loading project-local extensions (below).
- **irreversible**: `bash` commands matching a conservative destructive
  screen (`rm -rf`, `git push --force`, `git reset --hard`, `DROP TABLE`,
  `mkfs`, …). False positives gate (recoverable); the screen errs that way
  on purpose.
- **money / identity**: no built-in detections yet — assign via `[tools]`.
- **products**: `[products] paths = ["work/my-product"]` declares software
  products the controller may READ and study freely but not MODIFY without
  approval. Precise for path-arg tools (`write`/`edit`/`apply_patch` — and
  engine-mode patch approvals, which evaluate as `apply_patch` per file);
  heuristic for `bash` (mutation-looking commands that mention a product
  path or its basename gate; pure study commands pass). Zone checks rank
  ABOVE `[tools]` opt-outs — `bash = "none"` cannot open a product zone or
  the kernel files.

## Gate lifecycle

A gated call returns a block result naming the request file; the agent keeps
working on other things (gates block effects, never the agent). The request
lands at `<root>/inbox/gate-<hash8>.md` with `status: pending`. The human
edits `status:` to `approved` or `denied`.

- **Tool-call approvals are single-use**: the first matching call consumes
  the approval (status → `consumed`); an identical later call files a fresh
  request.
- **Denied** requests block without re-filing; a human can still flip a
  denied file to `approved`.
- Matching is by SHA-256 of tool name + canonical-JSON args — approval covers
  exactly the requested action.

## Project extension gating

Project-local extensions are agent-authorable code that runs with full user
permissions (`SEAMS.md` c.3) — so loading one from inside the authority root
is an authority-class effect. Applied at every load site including the
pre-trust load. Approvals here are **durable per content hash**: approving a
file approves that exact code; any edit produces a new hash and a new
request. User-global extensions (`~/.qorpera/agent/extensions`) are outside
the company root's authority and load as before.

## The signature rule (EVOLUTION.md §3)

Codified behavior taking an outward effect **unattended** requires a standing
founder signature on that behavior's content hash. Implemented as a fifth
input to `evaluateToolCall` (`ToolCallContext`): the agent-session mount
passes `attended` (tui/rpc = a human with approval UI; print/json/SDK =
unattended) and `behaviorPath` (the source file of an extension-registered
tool; synthetic `<builtin:…>`/`<sdk:…>` paths and code outside the authority
root are ignored — only company-authored code is subject).

- Applies to the **outward** classes only (money, identity, irreversible);
  [authority] and [products] keep their own semantics.
- Checked before — and regardless of — class modes: `auto` trust in a class
  covers the model acting under founder direction, not agent-authored code
  acting with nobody present.
- Necessary, not sufficient: signed code still hits per-action class gates
  and limits.
- Signatures are durable per content hash (`behavior_signature` requests,
  same mechanism as extension-load approvals): approving signs exactly that
  code; any edit is a new hash and a new request. The hash is computed from
  the file as it is now — with hot-reload this tracks what executes next and
  errs toward gating.
- Attended calls fall through to the normal inline gates: presence is the
  intent source there.

Every classified effect is stamped into the trail as a `qorpera_effect`
custom entry — tool, effect class, decision, and (when codified behavior
acted) its content hash and signature status.

## What this is not

Prompt-tier guidance. Enforcement is code at the tool-call boundary and the
extension loader; the kernel prompt only explains the rules. Known limits of
v1: the bash screen is string-level (no shell parsing), `limit_usd` is parsed
but not yet enforced (no money-moving tools exist in Base), and gates do not
yet write trail entries (the trail lands in slice 3).
