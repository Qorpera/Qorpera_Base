# Fork provenance

**Qorpera Base** is a hard fork of the PI coding agent.

| | |
|---|---|
| Upstream | https://github.com/earendil-works/pi (MIT, © 2025 Mario Zechner) |
| Forked at | `a96fb984d` — upstream `main` HEAD, 2026-08-04, version 0.83.0 |
| Fork date | 2026-08-04 |
| Fork audit | `Qorpera_Desktop/artifacts/qorpera-base/fork-audit-2026-08-04.md` (upstream chosen over `oh-my-pi`) |
| Design spec | `Qorpera_Desktop/artifacts/qorpera-base/spec-v0.md` |

## Fork policy

- **Hard fork.** No upstream tracking, no merges, no PRs back (upstream
  auto-closes outside contributions; its harness-v2 redesign will diverge the
  API anyway). The `origin` remote was removed at fork time; the fork now lives at https://github.com/Qorpera/Qorpera_Base (dev, private) with releases at https://github.com/Qorpera/Qorpera_Base_Releases (public).
- **Fixes are cherry-picked individually.** When an upstream fix is worth
  taking, cherry-pick the specific commit and record it in the table below
  with its upstream SHA.
- **Full upstream history is preserved** in this repository for archaeology
  and to keep cherry-picks cheap.
- Upstream `LICENSE` (MIT, Mario Zechner) is preserved untouched. Qorpera
  additions are © Qorpera, MIT, alongside it.

## Cherry-picks from upstream

| Date | Upstream SHA | What | Why |
|---|---|---|---|
| — | — | — | — |
