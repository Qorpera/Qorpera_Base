# Step 3 session kickoff

Paste-ready opening prompt for the dedicated Step 3 session (open it with this
worktree as the working directory: `~/Qorpera_Base-Step3`, branch
`step3/company-computers`).

---

You own Step 3 of Qorpera's cloud/remote computers layer: the Company
Computers build. This worktree (`~/Qorpera_Base-Step3`, branch
`step3/company-computers`, remote `github`) is yours; a parallel session
handles Step 2 acceptance and the node — do not touch
`~/Qorpera_Base-Step2`, the hosted Supabase project `wovsmjvghnbcbfazdtvr`,
or the node `company41-node-01` without an explicit founder instruction.

Read first, in order:
1. `deploy/first-node/STEP-3-COMPANY-COMPUTERS.md` — the ratified,
   founder-approved design goal. Every decision traces to it.
2. `deploy/first-node/STEP-2-ARCHITECTURE.md` — the contracts Step 3 must
   extend, never replace.
3. `STEP-3-SESSION-REPORT-2026-08-25.md` — the background agent's complete
   wrap-up: scopes 1 and 2 are BUILT and pushed (`9493c7698`); scope 3 (the
   delta-sync agent) is designed but unbuilt; its "NEXT SESSION PICKUP"
   list is your literal starting point, and it flags one open founder
   decision (member subscriptions on the shared machine).

Scope (from the charter's "Step 3 adds"):
- `qorpera_logical_computers` control-plane contract as draft migration
  files only (timestamps after 20260826000000, applied nowhere).
- Persistent-VM provider class beside the ephemeral lane: create / start /
  stop / snapshot for a long-lived LXD VM whose working storage is a
  per-company NAS dataset (`company/` working checkout, `workbench/`,
  `profiles/`).
- Delta-sync agent keeping the working Company File checkout tracking the
  verified head over the signed-URL object transport (one-directional;
  publication stays on the capture + verifier path).
- Screen attach/detach comes after those three.

Conventions: biome (`npx biome check --write`), `npx tsgo --noEmit` stays
clean, vitest colocated in `packages/*/test/`, tab indentation, comments
state constraints only. Known quirks: `packages/ai/src/providers/data/` is
generated and already populated — do not rerun `hydrate:model-data` (it
pulls a dataset newer than the code pins); `node_modules` was installed with
`--ignore-scripts`, so Electron-dependent shell tests need a full `npm ci`
first; build macOS temp fixtures with `realpathSync(tmpdir())`.
