# Track B runtime integration checkpoints

Track B integrates Track A's implementation through its exported client APIs.
An integration checkpoint is not a completed runtime release or live web acceptance.

## Source ownership and baseline

- Track A session: [Qorpera Steps 0–4 headless runtime acceptance](https://claude.ai/code/session_01WBKzRos3cjzPfpzEE7o9ad).
- Repository: `https://github.com/Qorpera/Qorpera_Base.git`; common Git directory is in `/Users/jonas/work/Qorpera_Base`.
- Track A's active source checkout: `/Users/jonas/work/Qorpera_Base-web-runtime`.
- Track A branch: `codex/web-runtime-contract-launch`.
- Track B branch: `codex/track-b-web-runtime-integration`.
- Track B worktree: `/Users/jonas/Documents/Codex/2026-09-12/integrate-the-steps-0-4-headless/work/track-b`.
- Starting commit, 2026-09-12: `7d745d309ac55aaee2486c24dbd5df9a4f8d3a1a`.
- Creation used that exact commit with `git worktree add -b`; no default-branch merge or uncommitted Track A files were copied. Track A's unrelated `AGENTS.md` modification remains in its checkout.
- Packages `@qorpera/runtime`, `@qorpera/cloud-client`, `@qorpera/member-web`, and `@qorpera/web`: `0.83.0`.
- Runtime bundle: v23, `4f78c340eeab7d8fa9c11f1bb228dff96c91daa900b0c8fd9135c52167cf9e7c`.
- Native executable: `6bbe4704774454be5aff5501bfe4bbd5e023930ff87d187ca9e5ec4c333c8e8d`.
- Bundle manifest: `deploy/first-node/native-codex/runtime-bundle-manifest.json`; generated identity: `packages/runtime/src/cloud-runtime-bundle.generated.ts`; activation: `supabase/migrations/20260912000800_runtime_bundle_activation_v23.sql`.

The earlier `fable/remove-local-execution-lane` checkout at `8836ce6bd` is an ancestor containing v22, not the latest active Track A source. The reset worktree at `73e23f9f2` is a separate unfinished lane and is not part of this baseline.

## Architecture and public consumer inspection

Read before web changes: the runtime contract's Steps 0–4 and acceptance/enforcement sections; `packages/runtime/README.md`, package exports and root; `packages/cloud-client/README.md`, package exports and root; `packages/member-web/README.md` and `src/account.ts`; `packages/web/README.md`; the Step 4 integration/acceptance documentation and current Track A rollout ledger.

Track A's external consumer is under its task evidence root:
`/Users/jonas/Documents/Codex/2026-09-05/files-pasted-by-the-user-take/outputs/step4-live-acceptance-preflight-20260909/r11-external-import-20260912`.
`CONTRACT.md`, `consumer/run.mjs`, `REVIEW.md`, and `TARBALLS.sha256` document/import the actual packed API. This is distinct from the standalone `packages/member-web` reference application.

That R11 package was packed from `8836ce6bd`, version `0.83.0`, tarball SHA-256 `d275efa171a05000d8985e0a8d912b3df0f16a6e362c96366332630aab8850ef`. Its one live call is `CloudMemberCompanyComputerClient.views(...).status(signal)`. It proves an external authenticated read, not complete runtime or product web acceptance. The three v23 commits change the server supervisor and bundle, not the cloud-client source. The unchanged version alone is insufficient to identify a runtime release: use commit plus bundle/artifact hashes.

The cloud runtime owns execution, receipts, authorization fences, provider credentials and guest lifetime. Supabase owns canonical state and admission. Provisioning belongs to the runner orchestrator. The browser imports `@qorpera/cloud-client` or documented browser-safe subpaths; it must not import `@qorpera/runtime`, `cloud-client/node/*`, desktop adapters or infrastructure. The package wildcard export does not make all subpaths browser-safe. Both runtime/client packages are private; the existing exported workspace build and packed tarballs are the distribution interfaces, not a presumed public npm release.

## Client mapping for Steps 0–4

| Requirement | Public integration | Product status at baseline |
| --- | --- | --- |
| Member identity and connection | Host PKCE/member token; SDK `NativeSubscriptionControlPlane` for provider connections/sponsorship | Auth exists; provider Connections panel remains a placeholder. |
| Governed live Company File and review | `CloudMemberCompanyFileClient`, reader, exact path/version/operation keys | Reads, edits, upload, download and protected review already composed. |
| Submit work and expose only the mouth | Member input contract; sponsored turns through `NativeSubscriptionControlPlane`; explicit-send transcript projection | Input/attachment submission and send projection exist. Sponsored admission for sessions without a binding needs integration. |
| Human interruptibility | `CloudSessionRunControl.read/cancel` with exact session/run | Missing at baseline; Track B is wiring it. |
| Progress, results and reconnect | Canonical transcript and inputs; SDK turn provenance; fresh member reads after reconnect | Transcript reconstruction exists; sponsored turn provenance/error display needs integration. |
| Wake bus | Cloud-owned scheduling/dedup/silence | No browser wake executor. Test outcomes with every client offline against accepted release. |
| Shared office/start/access | `CloudMemberCompanyComputerClient` factories | Start/status/cancel and observed-version grants exist. |
| Watch/control/private sign-in | SDK views, `MemberCompanyBrowserSession`, browser recovery | Explicit trusted WSS origin, private acknowledgement, consent and cleanup exist. Viewer closure does not stop work or end privacy. |
| Artifacts and activity | SDK file exports, attachments, `CloudMemberCompanyPresence` | Explicit verified downloads and lossy read-only activity exist; no raw runtime credential or local path authority. |
| VM reset and durability | Track A's governed runtime lifecycle | No invented member reset API. Runtime release gate remains open. |

## Checkpoint procedure

1. Read Track A's current branch commit and release/acceptance record without modifying its worktree. Compare committed changes from the last integrated commit; inspect API/export and bundle changes.
2. Commit Track B's own changes, then merge the exact reviewed Track A commit into Track B. Keep runtime changes owned by Track A; do not cherry-pick an incomplete reset lane as a substitute for its release.
3. Append a checkpoint here with source commit, package versions, bundle identity, acceptance state, migration/release identity and any interface differences. Run the boundary check and affected product tests against the newly integrated source.
4. Before final acceptance, consume Track A's completed release and verify the deployed artifact identity matches it. Record the product build commit and browser artifact manifest. Repeat live product flows on this completed release even if earlier fixtures or v22/v23 probes passed.

## Final acceptance gate — OPEN

At initial inspection Track A was rolling out v23 office revision 2. Its latest committed source is not a completed release. The current rollout ledger records R7 reset's missing guest successor lane (`OFFICE_RESET_GUEST_LANE_UNAVAILABLE` at `restored`), partial ordinary-workload/private/transfer/offline proofs, screenshot gateway configuration work and remaining production review. Historical local acceptance documents do not close these gates.

Final web acceptance requires normal hosted authentication; account/company fencing; actual sponsored work and actionable failure state; explicit-send-only output; files/review/artifact transfer; office watch/control/privacy/revocation; and a submitted run completing with all product clients closed followed by state/results reconstructed in a replacement client. Evidence must identify the completed Track A runtime release, not only this initial snapshot. Fixture-only results must remain labelled as such. Runtime deployment/reset remain Track A's responsibility.

## Checkpoint 1 — 2026-09-12 10:36 UTC

Track A remains at `7d745d309ac55aaee2486c24dbd5df9a4f8d3a1a`; no new committed source is available to merge. Package versions and bundle hashes match the baseline. Its rollout ledger now records office service revision 2 active, v23 activation applied at 10:21:05 UTC (ledger 236), and a subsequent gate-A attempt classified `failed_other`. Activation does not constitute acceptance; R7 and the final gates remain open.

Track B now composes `NativeSubscriptionControlPlane` and `CloudSessionRunControl` through their exported browser interfaces. The composer atomically requests input plus sponsorship; it never separately appends before requesting work. Members explicitly select an observed account/binding. Exact uncertain retries retain input/request IDs, text, image files and sponsor authority. An explicit new-request action preserves the draft while releasing retry identity and warns that the original request may have been accepted. Canonical provenance exposes provider, sponsor, run state and failure reason. Stop targets only the observed run, requires refresh after uncertainty, and is never called by teardown.

Settings discovers existing connections and offers explicit message-only sponsor enablement (`allowAutonomous: false`) and revocation. Enable IDs are retained per connection/version during the view lifetime; rotation gets a new operation UUID. New browser provider login remains unavailable: the exported login bridge needs a deployed, accepted browser gateway; the internal runtime login endpoint is not a browser transport. No internal endpoint or service credential was added to the client.

Validation at this checkpoint: all 146 targeted tests across 11 product client files, full `npm run check`, product TypeScript and production-mode local build pass. The build is a preview artifact (`release: false`), not a deployed release. The initial full check exposed absent ignored model catalogs in this new worktree. Copied Track A's existing catalog byte-for-byte, without fetching new catalogs or changing tracked files; both model-data checks and root TypeScript then pass. Model-data manifest SHA-256: `6997f6dc319067ade1697d6be8533171a973a12fe7519ffcbe2a6d5313305aff`.

Real-browser fixture checks at 1280×720 and 390×844 used the actual conversation/settings components and production styles with inert transports. Verified explicit selection enabling Send; uncertain-send lock, warning and explicit new-request recovery preserving the draft; observed-run Stop and refreshed idle state; account enablement, refresh, revocation and disabled revoked controls; readable narrow-screen layout. No browser console errors were observed. The fixture made no backend/model calls and is not live runtime acceptance. Preview entry artifact SHA-256: `99cbca2ebf49b30e1b7230706b91bd0483e322d7d2e7c59841ad243ba96340a4`; CSS: `c770b8cea9e165ca2ff404440a1b66ff564ffd2095a1547e27cdefb8b88a0f17`.
