# Company folders

`qorpera company init [dir]` scaffolds the Qorpera Base spine (spec §2) —
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

Behavior notes:

- The scaffolded `authority.toml` activates gates immediately: the folder
  protects its own spine from the first session (writes to kernel files,
  `authority.toml`, or `inbox/` gate; destructive bash gates).
- `sessionDir` is stored as `./trail`, which the CLI resolves at launch —
  start sessions at the company root (the normal case). Hosts embedding the
  SDK should pass an absolute session dir rooted at `<company>/trail`.
- Session files flush on the first assistant message (upstream behavior),
  so an abandoned prompt leaves no trail entry.
- There is no wizard: conception is a dialogue. The kernel (AGENTS.md)
  instructs the controller to interview the founder and rewrite
  `company.md`, then bootstrap its first surfaces in `app/`.
