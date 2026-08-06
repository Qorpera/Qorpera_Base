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
  the repo is cloned into `work/`, and conception begins with study before
  the interview.
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
                    # lands inside the company folder. Append-only exhaust.
  inbox/            # gate requests + human steering
  app/              # THE CONTROLLER the agent builds: manifest.json,
                    # surfaces/, substrates/, routines/, tools/
  work/             # everything else; earns its structure
```

Scaffolding is idempotent and never overwrites — a company's `company.md`
is its identity, not ours to reset. Existing `.qorpera/settings.json` keys
are merged around, and a pre-set `sessionDir` is respected.

## Session scopes (company vs product)

A chat session carries a *scope*: the company (default) or one of the
products declared in `authority.toml` `[products] paths`. The shell's
composer offers exactly those — a company and a product are different kinds
of thing (a company has authority, a trail, an inbox, an app; a product is a
repo the company works ON), so scopes are per-company, never a flat project
list.

Picking a product opens a fresh session rooted INSIDE that product's
directory, pre-approved for that zone and nothing else (see authority.md,
"The scope grant"). The kernel confirms the grant in a native dialog — that
confirmation is the founder's approval, which agent-evolvable userland code
cannot fake. Scoped sessions still record to the company `trail/` and are
named `scope — <path>`, so the chat list shows the product tag and restores
the scope (with a fresh confirmation) when reopened.

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
