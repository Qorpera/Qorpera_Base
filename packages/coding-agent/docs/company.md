# Company folders

## The forking hub (spec §6.1a)

Base desktop is the runtime hub companies are opened from. The CLI can list,
register, scaffold, integrate, and clone company folders, but it never starts
a company controller: controller authority exists only inside the desktop
kernel. Bare `qorpera` outside a company still offers the CLI hub and prints
the company path to open in Base desktop.

The same scaffold flows exist as explicit verbs:

- `qorpera new <dir>` — scaffold and register a new company from zero. Open
  it in Base desktop to let the kernel start autonomous conception.
- `qorpera new <dir> --from <repo>` — integrate an existing product/company:
  a `<product>-development` department is created, the repo is cloned into
  its `repository/`. Open the company in Base desktop to begin study.
- `qorpera fork <company-repo> [dir]` — fork an existing company (the folder
  is the company and it is a git repo, so forking is cloning). Opens as an
  ordinary registered company — it already knows itself.

`--no-launch` remains accepted for scripting but company sessions are never
launched by the CLI. Product registration is likewise a desktop-kernel
transaction; `company product add` is refused outside that transaction.
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
  app/              # THE CONTROLLER the agent builds: projection.json,
                    # surfaces/, substrates/, routines/, tools/
  departments/      # optional department kits; arbitrary other structures
                    # remain agent-authored
```

Scaffolding is idempotent and never overwrites — a company's `company.md`
is its identity, not ours to reset. Existing `.qorpera/settings.json` keys
are merged around, and a pre-set `sessionDir` is respected.

## UI projection hierarchy

`app/projection.json` is the only navigation publication contract. There is
no compatibility reader for the former flat manifest. The agent remains free
to arrange company data, code, schemas, routines, tools, and integrations in
whatever form the company requires; the projection contains only the small
subset deliberately exposed to the founder.

The hierarchy is intentionally bounded:

```
Department
  ├─ Page
  └─ Category
       └─ Page
```

- A **Department** groups related user-facing responsibilities.
- A **Category** opens a generated collection page; its pages do not expand
  into the sidebar.
- A **Page** either hosts an agent-authored surface or a named Base builtin.
- IDs are immutable and namespaced. Labels and surface file paths may move
  without detaching routes or sidechat trails.
- `q:` is reserved for the platform-owned Main department and its Inbox,
  Activity, and Chats pages.
- Navigation never scans or infers structure from the company folder.
- Invalid references are shown as projection diagnostics rather than being
  repaired by filesystem discovery.

Department titles are static group labels with no collapse affordance.
Right-clicking any department or row exposes a per-item height adjustment of
±12px. Appearance settings control the optional page/category hue indicators.
These are local presentation preferences and never change `projection.json`.

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
product repository owns its own history. Installing the product kit adds an
ordinary projection Department with three Pages: **Chat**, **Pull Requests**,
and **Architecture**. The renderer has no separate product-navigation path.
Chat opens the product's chat collection; its explicit new-task action creates
a fresh Git worktree and launches a `product-worker` rooted there. Pull
Requests reads synchronized JSON records from `pull-requests/`.
Architecture opens an inert placeholder; it defines no folder schema,
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

## Kernel runtime boundary

The desktop kernel, not the company renderer, creates controller and product
workers. Each child receives a clean environment, a read-only projection of
model credentials, and network access only through a kernel-owned broker for
model-provider domains. Ambient Git, cloud, connector, and desktop credentials
are absent. On Windows, Base requires the elevated offline sandbox account and
fails closed when it is unavailable; the broker is the only permitted outbound
path. Product registration is refused while a company runtime lock exists, so
new protected roots cannot become visible under a stale sandbox profile.

Mutable userland may request a prompt, but every prompt is confirmed in native
kernel UI and delivered with a signed, expiring, single-use intent capability.
The trail records that kernel-observed input separately. Events emitted by the
child remain append-only and hash-chained, but are marked as child assertions;
they cannot manufacture kernel-observed founder provenance.

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
- Desktop controllers trust that company's project-local resources inside the
  kernel sandbox. Global extensions and connector credentials are not copied
  into the child; the company can build its own tools and routines without
  inheriting ambient user authority.
- Known transient (2026-08-05, tsx + node 24 on Windows): the CLI
  intermittently dies with 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN,
  surfaces as "exit 9"), sometimes mid-session. Work already performed
  persists (filed gates, flushed trail); an identical retry has succeeded
  every observed time. The scheduled runtime should carry retry-once
  semantics for wakes.
- There is no wizard: the desktop kernel starts autonomous conception. The
  controller records questions in the inbox, rewrites `company.md`, and
  bootstraps its first selectively published surfaces in `app/`.
