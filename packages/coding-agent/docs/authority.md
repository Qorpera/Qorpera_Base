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
  on purpose. Includes history rewrites (`commit --amend`, `rebase`,
  `filter-branch`/`filter-repo`, `reflog expire`, `update-ref -d`,
  `gc --prune`) — the company's history is append-only from the agent's
  side (EVOLUTION.md §4 invariant 1).
- **money / identity**: no built-in detections yet — assign via `[tools]`.
- **product_code**: mutations under
  `departments/<product>-development/repository/` or a task directory under
  `worktrees/`. This is a fixed role boundary, not an `authority.toml`
  class. Controllers are read-only even when attended, and their denied
  mutations create no approvable gate. Product-workers can mutate only the
  exact worktree assigned by the kernel. Path-argument tools are precise;
  `bash` uses conservative mutation and worktree-escape screens. Boundary
  checks rank above `[tools]` opt-outs.

## Controller and product-worker roles

Attendance expresses founder intent for ordinary outward effects; it never
changes organizational role. A product department Chat creates a Git
worktree, starts the runtime with actor `product-worker`, and records the
department and worktree in the session name. The authority hook receives the
same actor/worktree capability in pi-native and Codex engine modes.

- **controller** — reads product repositories, worktrees, PR records, and
  trails; writes briefs and company operations; cannot modify product code.
- **product-worker** — modifies only non-`.git` content in its assigned
  worktree. It receives no direct network, credentials, repository-metadata,
  commit, push, or PR capability. The kernel checkpoints content changes;
  future push and PR operations require explicit kernel brokers.
- Gates cannot widen the worktree, `.git`, network, or credential boundary.
- Destructive commands and PR merge/close operations re-classify as
  `[irreversible]`; ordinary irreversible policy still applies.

## Gate lifecycle

A gated call returns a block result naming the request file; the agent keeps
working on other things (gates block effects, never the agent). The request
lands at `<root>/inbox/gate-<hash8>.md` with `status: pending`. Base presents
the canonical request in a native review and performs the approved or denied
transition. Editing the file alone never mints an executable capability.

- **Tool-call approvals are single-use**: the first matching call consumes
  the approval (status → `consumed`); an identical later call files a fresh
  request. If an approved file outlives the child-local capability that
  accompanied it, a retry returns it to `pending` for fresh native review.
- **Denied** requests block without re-filing; the founder can return one to
  `pending` and review it again through Base.
- Matching is by SHA-256 of tool name + canonical-JSON args — approval covers
  exactly the requested action.

## Project extension gating

Project-local extensions are agent-authorable code that runs with full user
permissions (`SEAMS.md` c.3) — so loading one from inside the authority root
is an authority-class effect. Applied at every load site including the
pre-trust load. Trust is **process-local per content hash**: native review
establishes trust for that exact code in the live child; an edit or child
restart requires trust to be established again. User-global extensions
(`~/.qorpera/agent/extensions`) are outside
the company root's authority and load as before.

## Provenance trailers (EVOLUTION.md §4 invariant 3)

Every agent-authored commit ends its message with `Qorpera-Trigger:` (what
prompted the change) and `Qorpera-Rationale:` (why). Enforced at the bash
boundary before classification — every agent commit, pi-native or engine
mode, crosses it; the founder's own commits in their own terminal never do.
A commit without trailers is rejected with retry guidance and **no gate is
filed** — it is a message-format requirement, not an approval. Matching is
deliberately narrow (`git [-c/-C …] commit`); exotic invocations slip the
screen the same way exotic destructive commands do.

Because trailers legitimately reference inbox items, `-m`/`--message`
bodies are blanked before the bash screens run (protected paths, product
zones, destructive patterns) — a mention inside a commit message is data,
not an effect. The same applies to the path arguments of index-only git
verbs (`git add`, `git commit` pathspecs): staging or committing a file
reads it into the index and cannot modify it, so committing inbox records
or the kernel files is bookkeeping, not an effect. Bodies or arguments
containing execution constructs (`$(…)`, backticks, `${…}`) are NOT
blanked; flags survive the strip (`--amend` still hits the history
screen); worktree-writing git verbs (checkout, restore, reset, rm, mv,
clean, stash, apply) still screen on their mentions; and the provenance
check runs on the raw command. (Live 2026-08-05: every routine commit
gated on its own trailer mentioning `inbox/msg-…`, then every close-out
gated on staging its own gate records.)

## The signature rule (EVOLUTION.md §3)

Codified behavior taking an outward effect **unattended** requires a standing
founder signature on that behavior's content hash. Implemented as a fifth
input to `evaluateToolCall` (`ToolCallContext`): the agent-session mount
passes `attended` (tui/rpc = a human with approval UI; print/json/SDK =
unattended) and `behaviorPath` (the source file of an extension-registered
tool; synthetic `<builtin:…>`/`<sdk:…>` paths and code outside the authority
root are ignored — only company-authored code is subject).

- Applies to the **outward** classes only (money, identity, irreversible);
  [authority] and product_code keep their own semantics.
- Checked before — and regardless of — class modes: `auto` trust in a class
  covers the model acting under founder direction, not agent-authored code
  acting with nobody present.
- Necessary, not sufficient: signed code still hits per-action class gates
  and limits.
- Signatures are process-local per content hash (`behavior_signature`
  requests, the same mechanism as extension-load approvals): local native
  review signs exactly that code for the live child; an edit or restart
  requires trust again. The hash is computed from the file as it is now —
  with hot-reload this tracks what executes next and errs toward gating.
- Attended calls fall through to the normal inline gates: presence is the
  intent source there.

Every classified effect is stamped into the trail as a `qorpera_effect`
custom entry — tool, effect class, decision, consumed gate ID, and (when
codified behavior acted) its content hash and signature status. The kernel
separately records each gate consumption or orphan reset in the hash-chained
trail, so file state and child assertions are not the authority evidence.

**File-only pre-signing is intentionally insufficient.** `requestHash` is
deterministic (sha256 of `tool\n` + canonical-JSON args; for signatures the
args are `{contentHash, path}` with the root-relative POSIX path), but an
approved file must be paired with a one-shot capability created by local
native review. A copied or cloned approval therefore cannot authorize an
effect on another machine or in a later child session.

## What this is not

Prompt-tier guidance. Enforcement is code at the tool-call boundary and the
extension loader; the kernel prompt only explains the rules. Known limits of
v1: the bash screen is string-level (no shell parsing), and `limit_usd` is
parsed but not yet enforced because Base has no money-moving tools. Native
founder reviews, child effect assertions, gate transitions, and broker-observed
model usage are recorded as distinct provenance events.
