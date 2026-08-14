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
launched by the CLI. An existing company can add a product through the
desktop kernel's `addProduct(product, source?)` bridge, or while the desktop
is closed with `qorpera company product add <product> [--from <repo>]`.
Both paths hold the same cross-process transaction lock across inventory,
folder, projection, repository, and Git changes.
The human's setup obligations are exactly three: say what the company is,
ratify `authority.toml`, and connect the subscriptions the controller should
use. Model-provider execution still receives revocable opaque broker handles;
the host-capable controller can also run normal installed CLI login flows and
use the signed-in user's existing credential helpers when doing machine work.

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
is its identity, not ours to reset. The two retention settings are kernel
invariants: `.qorpera/settings.json` always uses `sessionDir: "./trail"`,
`compaction.enabled: false`, and `transport: "sse"` so model operations stay
inside the kernel model executor; all unrelated settings keys are preserved.

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
    repository/       # controlling clone; controller policy-read-only
    worktrees/        # one isolated task worktree per product assignment
    pull-requests/     # synchronized local PR read models
```

The company Git repository ignores `repository/` and `worktrees/`; each
product repository owns its own history. Kernel-owned assignment records in
`.qorpera/product-worktrees/` bind every authorized task to an immediate
`worktrees/<task>/` clone, branch, source, and creation time. Installing the
product kit adds an ordinary projection Department with three Pages: **Chat**,
**Pull Requests**, and **Architecture**. The renderer has no separate
product-navigation path.
Chat opens the product's chat collection; its explicit new-task action creates
a fresh Git worktree and launches a `product-worker` rooted there. Pull
Requests reads synchronized JSON records from `pull-requests/`.
Architecture opens an inert placeholder; it defines no folder schema,
ontology, search contract, or storage model yet.

The controller can inspect every product artifact and write briefs, but it
cannot modify product repositories or worktrees — not even in an attended
session and not through a one-off approval. A product-worker can modify only
its kernel-assigned worktree. Before a resumed worker starts, the kernel
commits staged, working, untracked, and deleted founder state in that product
repository; it also checkpoints any uncommitted worker result on settle/exit.
Raw product checkouts remain outside company Git. After every worker
checkpoint, the kernel stores the latest commit in protected `.qorpera/`
recovery records. The first checkpoint carries one verified full Git bundle;
later checkpoints add content-addressed incremental bundles chained to the
prior recovered head, so retained history grows with new Git objects instead
of multiplying the entire product history at every checkpoint. The kernel
commits the assignment and exact bundle blobs to company Git before reporting
success. A company fork can therefore restore active unpushed work after the
controlling repository is hydrated; restoration and the new worker capability
each receive their own exact native review.

Product integration records contain portable transaction IDs, never
machine-specific staging paths. Live and quarantined clone bytes stay under
the company repository's kernel-owned Git admin directory, outside company
history; only their journaled recovery metadata is versioned. A recovery move
is recorded before rename and reconciled after interruption. When an original
machine has neither side of a portable quarantine move, the kernel records a
`source-storage-unavailable` outcome instead of inventing or deleting bytes,
then permits a new exact founder-reviewed retry. When an original local
acquisition path does not exist on a new machine, a new exact founder review
records a source rebind while preserving the old source and commit evidence.
Credential-bearing submitted or derived remotes are rejected across URL
schemes before they can enter company history; an SSH username without a
password remains valid.
The desktop kernel records clone-local hydration outside company Git. A fresh
clone may open with an explicit hydration-required warning, but disappearance
or physical replacement of a repository or worktree previously observed on
that machine fails closed. Forward-only commits in the same physical clone
advance its observed head; replacement or backward history movement does not.
Founder-reviewed source rebinding and quarantined staging attempts preserve the
recovery trail without deleting partial product data.
New Chat from the department starts a new
worktree; the ordinary new-chat action continues the currently assigned
worktree. Product sessions remain in the company `trail/` and are named
`product — <department> — <worktree>`, so the exact capability and provenance
can be restored.

## Chats vs autonomous work (the communication split)

Chat sessions are for work the founder brings. The controller's own
autonomous work communicates through the inbox instead: it requests creation
of `inbox/messages/msg-*.md` items — questions, proposals, plans, progress updates —
and the founder responds inside the item (the shell renders a reply box; the
response is appended as a `## Response` section the agent reads on its next
wake). Conception runs this way: study, set up, post questions — never an
interactive interrogation. The kernel exclusively creates message IDs and
appends founder responses while recording them in the trail. Qorpera's
built-in tool policy treats existing message files, response sections, gate
files, and every other inbox path as read-only; full host commands can bypass
that policy and are therefore visible capability, not a security boundary.

## Kernel runtime boundary

The desktop kernel, not the company renderer, creates controller and product
workers. Each child runs directly as the signed-in desktop user with the full
host environment, filesystem permissions, network, installed CLIs, credential
helpers, and browser handoffs. Structured model context and streamed events
use the existing kernel pipe; paid model request construction, authentication,
and usage accounting remain in the desktop process behind opaque handles.
Every request must carry a kernel-issued causal intent and is recorded in the
trail. Product registration and company open use the same atomic transaction
lock before either reads or mutates inventory.

Company userland and surfaces are served from the kernel's local read origin
inside a per-window renderer session. That session can reach only its exact
backend origin; external fetches, WebSockets, beacons, remote subresources,
and arbitrary `file://` reads are denied. External links require exact native
review before the operating system opens them.

Mutable userland may request a prompt, but a trusted kernel modal shows the
full canonical text, image hashes, and exact product assignment before
approval. The reviewed frame is delivered with a signed, expiring, single-use
intent capability. Queued turns retain that intent identifier, and the trail
links later effect assertions to the kernel-observed input. Child events remain
append-only and hash-chained but explicitly remain child assertions.

Behavior notes:

- The scaffolded `authority.toml` activates gates immediately: the folder
  protects its own spine from the first session (writes to kernel files,
  `authority.toml`, or `inbox/` gate; destructive bash gates).
- `sessionDir` is stored as `./trail`, which the CLI resolves at launch —
  start sessions at the company root (the normal case). Hosts embedding the
  SDK should pass an absolute session dir rooted at `<company>/trail`.
- Company scaffolding and every desktop open force `compaction.enabled` to
  `false`. Base never rewrites, summarizes in place, expires, or deletes trail
  records. Long work continues in a new session or worktree instead.
- Session headers materialize immediately when the kernel binds a new session,
  so even an abandoned prompt leaves an auditable session record.
- In-process extensions are disabled in company-kernel children because they
  would share the trusted model/control process. The company remains free to
  build backend files, tools, routines, schemas, and integrations. Controller
  shell commands and local MCP servers inherit host capabilities;
  `run_company_tool` uses a clean environment for identified unattended code,
  while retaining the signed-in user's OS permissions.
- Known transient (2026-08-05, tsx + node 24 on Windows): the CLI
  intermittently dies with 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN,
  surfaces as "exit 9"), sometimes mid-session. Work already performed
  persists (filed gates, flushed trail); an identical retry has succeeded
  every observed time. The scheduled runtime should carry retry-once
  semantics for wakes.
- There is no wizard: the desktop kernel starts autonomous conception. The
  controller records questions in the inbox, rewrites `company.md`, and
  bootstraps its first selectively published surfaces in `app/`.
