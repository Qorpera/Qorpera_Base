# Company folders

## The forking hub (spec §6.1a)

Base is the hub companies are spun up from. **Bare `qorpera` from any
directory outside a company opens the hub**: enter one of your companies
(remembered in `~/.qorpera/agent/companies.json`), start a new one,
integrate an existing repo, or just open a plain session where you are.
Inside a company folder, `qorpera` goes straight to the session. Any
argument bypasses the hub, so `qorpera` keeps working as a general agent.

The same flows exist as explicit verbs, all ending in a conception dialogue
where the human only says what the company is:

- `qorpera new <dir>` — start a new company from zero. Scaffolds the spine
  and launches the session with the conception interview; the agent performs
  the setup itself (rewrites company.md, proposes authority/connections,
  builds the first surface).
- `qorpera new <dir> --from <repo>` — integrate an existing product/company:
  a `<product>-development` department is created, the repo is cloned into
  its `repository/`, and conception begins with study.
- `qorpera company product add <name> [--from <repo>]` — add the standard
  product-development department kit to an existing company.
- `qorpera fork <company-repo> [dir]` — fork an existing company (the folder
  is the company and it is a git repo, so forking is cloning). Opens as an
  ordinary wake — the company already knows itself.

`--no-launch` on any of them scaffolds/clones without starting the session.
The human's setup obligations are exactly three: say what the company is,
ratify `authority.toml`, and connect subscriptions (`/login` in the session,
or `codex login` for engine mode).

## The spine

`qorpera company init [dir]` is the bare scaffold plumbing (spec §2) —
the folder IS the company, and it is a git repository (fork a company =
clone it):

```
<company>/
  AGENTS.md         # the kernel prompt, materialized (single-sourced with
  CLAUDE.md         # CLAUDE.md — the context-file slot both vendors
                    # co-train models to honor). [authority]-gated.
  company.md        # identity — starts as an interview prompt, becomes prose
  authority.toml    # the gates (see authority.md). Human-owned.
  connections/      # declared capabilities; references only, never secrets
  trail/            # sessions ARE the trail: project settings point
                    # sessionDir here, so every session's tree-shaped JSONL
                    # lands inside the company folder. Never compact/delete.
  inbox/            # gate requests + human steering
  app/              # THE CONTROLLER the agent builds: manifest.json,
                    # surfaces/, substrates/, routines/, tools/
  departments/      # optional department kits; arbitrary other structures
                    # remain agent-authored
```

Scaffolding is idempotent and never overwrites — a company's `company.md`
is its identity, not ours to reset. Existing `.qorpera/settings.json` keys
are merged around, and a pre-set `sessionDir` is respected.

## Product-development departments

Product development is a built-in optional department kit, not the
company's universal ontology:

```
departments/
  <product>-development/
    department.json   # kit identity and product display name
    briefs/           # controller-owned direction
    repository/       # controlling clone; controller read-only
    worktrees/        # one isolated task worktree per product assignment
    pull-requests/     # synchronized local PR read models
```

The company Git repository ignores `repository/` and `worktrees/`; each
product repository owns its own history. The base product navigation has
three rows: **Chat**, **Pull Requests**, and **Architecture**. Chat creates a
fresh Git worktree and launches a `product-worker` rooted there. Pull
Requests reads synchronized JSON records from `pull-requests/`. Architecture
is intentionally a disabled placeholder: it defines no folder schema,
ontology, search contract, or storage model yet.

The controller can inspect every product artifact and write briefs, but it
cannot modify product repositories or worktrees — not even in an attended
session and not through a one-off approval. A product-worker can modify only
its kernel-assigned worktree. New Chat from the department starts a new
worktree; the ordinary new-chat action continues the currently assigned
worktree. Product sessions remain in the company `trail/` and are named
`product — <department> — <worktree>`, so the exact capability and provenance
can be restored.

## Chats vs autonomous work (the communication split)

Chat sessions are for work the founder brings. The controller's own
autonomous work communicates through the inbox instead: it authors
`inbox/msg-*.md` items — questions, proposals, plans, progress updates —
and the founder responds inside the item (the shell renders a reply box; the
response is appended as a `## Response` section the agent reads on its next
wake). Conception runs this way: study, set up, post questions — never an
interactive interrogation. The authority layer permits agent writes ONLY to
`inbox/msg-*.md`; gate files and everything else in the inbox remain
human-owned.

Behavior notes:

- The scaffolded `authority.toml` activates gates immediately: the folder
  protects its own spine from the first session (writes to kernel files,
  `authority.toml`, or `inbox/` gate; destructive bash gates).
- `sessionDir` is stored as `./trail`, which the CLI resolves at launch —
  start sessions at the company root (the normal case). Hosts embedding the
  SDK should pass an absolute session dir rooted at `<company>/trail`.
- Company scaffolding sets `compaction.enabled` to `false` unless the company
  already has an explicit choice. Base never rewrites, summarizes in place,
  expires, or deletes trail records. Long work continues in a new session or
  worktree instead.
- Session files flush on the first assistant message (upstream behavior),
  so an abandoned prompt leaves no trail entry.
- Headless wakes (print/json/SDK, no UI) resolve project trust to
  UNTRUSTED by default — project extensions under `.qorpera/extensions/`
  silently never load unless the company root is in
  `~/.qorpera/agent/trust.json`. A controller cannot currently distinguish
  "extension gated" from "extension silently untrusted"; trust the folder
  before scheduling unattended wakes that rely on self-built tools.
- Known transient (2026-08-05, tsx + node 24 on Windows): the CLI
  intermittently dies with 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN,
  surfaces as "exit 9"), sometimes mid-session. Work already performed
  persists (filed gates, flushed trail); an identical retry has succeeded
  every observed time. The scheduled runtime should carry retry-once
  semantics for wakes.
- There is no wizard: conception is a dialogue. The kernel (AGENTS.md)
  instructs the controller to interview the founder and rewrite
  `company.md`, then bootstrap its first surfaces in `app/`.
