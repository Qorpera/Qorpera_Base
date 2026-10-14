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
| Artifacts and activity | SDK file exports (deleted with snapshot-v1 in legacy sweep step C), attachments, `CloudMemberCompanyPresence` | Explicit verified downloads and lossy read-only activity exist; no raw runtime credential or local path authority. |
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

## Checkpoint 2 — 2026-09-12 10:58 UTC

Track A is still at the exact starting commit; there is no subsequent committed source to merge. Its latest ledger now records completed staff A/B shell and shared-readback runs on v23 (10:47/10:50 UTC). Screenshot, reset guest lane, reboot and final review gates remain open. This is progress, not a completed runtime release.

Track B adds owner/admin company pause/resume and versioned monthly spend/token and hourly wake ceilings, plus member-addressed execution notifications and explicit acknowledgment. The public authenticated member RPC contracts are documented in the Steps 0–2 amendment and Step 3 wake-bus acceptance. The exported SDK provides bounded browser transport; the cloud retains all admission, enforcement, recipient and role authority. No ceiling accounting, wake execution, machine ceiling setter or generic event-based approval was recreated. Controls refresh after uncertainty, and notification counts explicitly cover only the latest 50 records.

Full `npm run check` passed (2085 files; bundle unchanged; browser boundary passed). All 93 tests across seven affected files passed after these changes. A further 120 baseline regressions across ten computer/file/auth/transcript files passed before this change, in addition to checkpoint 1's 146. These are distinct runs with overlapping coverage, not an additive unique test count. The preview build passed. Entry `main-7VVKCHCO.js` SHA-256 is `e0990def2f20c71506c4b4e3d21b86fe5b7031ffff0ef12376b8760318a946e8`; CSS `app-KU52M7C4.css` is `9c3547d11d50d82209fad1674bd21cf769f0aa70ac94845de6bd91fd1e4b0ffd`.

Actual component browser fixtures at desktop and 390×844 verified pause/resume, exact decimal ceiling save/readback, notification acknowledgment, readable layout and zero console warnings/errors. No backend/model calls occurred. Read-only deployed probes found that app.qorpera.com serves HTML for web-deployment.json, different entry artifacts, and no viewer WSS in CSP. The objects gateway health endpoint is healthy; this does not establish governed operations or a matching release. Final acceptance remains open.

## Checkpoint 3 — 2026-09-12 11:06 UTC

Track A's committed source remains `7d745d309ac55aaee2486c24dbd5df9a4f8d3a1a`; package and runtime identities remain unchanged. The live ledger additionally records gate-C attempt A1 as `failed_other` at 10:59:47 UTC. No completed release is available, and no runtime merge is warranted yet.

Provider sign-in now composes exported `NativeSubscriptionControlPlane` identity discovery/creation and login admission with `HttpNativeProviderIdentityBridge`. A validated optional `nativeProviderLoginUrl` explicitly configures the public HTTPS base and generated CSP. There is no default gateway or inferred internal endpoint. SDK login capabilities are memory-only; the view receives only the interaction link, device code and expiry. The member JWT is never sent to the identity bridge. Account/company/view cancellation and an overall deadline bound the flow. Because SDK login admission creates new capability material each invocation, uncertain admission is never replayed with the same IDs; refresh and an explicit new attempt are required. Enabling sponsorship remains separate.

The existing public Edge route lacks browser CORS/preflight support. This implementation does not alter Track A's proxy, runtime or infrastructure. Live sign-in requires an accepted gateway and configured build. Notifications also now accept the SQL contract's Unicode character count for pause reasons, including valid astral characters; the UI preserves that full character allowance.

Validation: all 144 tests across nine affected web files and all eight deployment/configuration tests passed. Full `npm run check` passed, including the unchanged bundle, browser dependency boundary, SDK builds and web typechecks. Preview build passed (`release: false`). Entry `main-IAQB7XO2.js` SHA-256: `76d241a0c048cc3e623fecbc12d7ca8ba6fc150084c5cc3374bc759626a971a6`; CSS `app-X6SIMTLI.css`: `c1c4eaf94d2b5ac8c1434b376d620c109a2241790f91c1c349db04d271f90282`.

Actual Connections component fixtures at desktop and 390×844 verified provider prompt display, explicit close clearing instructions, refresh before a new attempt, disabled pending controls and readable phone layout. The provider link was not opened; no provider/backend/model calls were made, and no console warnings/errors were observed. Final live product acceptance stays open until a subsequent checkpoint integrates Track A's completed release and verifies the matching deployed product artifact.

## Checkpoint 4 — 2026-09-12 11:19 UTC

The final scope audit found that existing team-room conversations were incorrectly routed through the single-staff sponsored-turn API. The client now uses the documented public room discovery and atomic room-post contracts from Step 3. It validates the exact room, session, environment and active member before posting, retains room/input/sponsor identity for uncertain retries, and refuses changed destinations or images before upload. SQL owns all recipient wakes and admission. Rooms retain account selection and canonical replies, without calling the inapplicable single-staff run-control or native-turn history interfaces.

This audit also found an authoritative interface limitation: member-readable room sends carry run identity, but no historical staff-speaker identity. The event's human actor is the run creator, not the speaking staff agent. Direct/operational run queries are not member APIs, and current activity cannot prove historical attribution. The client labels agent replies with speaker unavailable rather than guessing. Named room attribution requires Track A to publish an authorized immutable run-to-staff projection; the browser must not recreate it or use service credentials.

Validation: all 145 tests across ten affected web files passed, including 22 room-adapter and nine room-routing regressions. Full `npm run check` passed (2088 files, unchanged bundle and browser boundaries), followed by a passing preview build. Entry `main-YRZZPVIT.js` SHA-256: `a35d68166aa36b74e1aaf6baeb0bc53b6616da4ab30a992c55693da25a338187`; CSS unchanged from checkpoint 3. Real-browser fixtures at desktop and 390×844 confirmed explicit account choice, text-only room composition, canonical send display with unavailable speaker identity, and readable layout with no console errors/warnings. No backend/model calls or deployment occurred.

Track A was re-read at 11:18 UTC and remains at the initial committed source. Its latest ledger adds R6 replacement-caller reconstruction proof and reports R8 file-read and screenshot gates blocked on NAS gateway native-token configuration. It also records runtime latency/reliability and long-prompt context findings for final review. Reset guest, reboot and remaining review gates are not closed. There is still no subsequent completed release to merge. The repeated external release dependency now prevents final acceptance; this checkpoint does not declare the runtime or web product accepted.
