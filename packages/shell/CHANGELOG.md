# Changelog

## [Unreleased]

### Breaking Changes

- Removed the local execution lane from the desktop shell. The shell no longer starts a local agent process, offers desktop model accounts or an intelligence sign-in, or runs local wakes, rooms, trigger workers or product-worker chats. All agent execution happens in the cloud through the Runner Orchestrator; the desktop only observes and mutates durable cloud state.
- Native recovery-enabled guests require the recovery migration and per-company cloud authority provisioning before provider sign-in. Missing recovery configuration stops bootstrap before creating a key or requesting provider authentication.
- Governed native runs require the exact activated executable bundle and reasoning-policy pins. Symbolic-only historical bundles are not silently upgraded; migration activation and signed runtime installation must be coordinated.

### Added

- Added recent native read/write activity for the inspected Company File path or folder. The isolated display clears on path, account and connection changes and expiry; activity never blocks file operations or grants access.

- Added member-owned browser profiles, separate agent consent and explicit private sign-in through the cloud viewer. Closing the view preserves privacy; account-level cleanup can finish sign-in or revoke consent after company membership removal. Office APIs no longer depend on the Company File gateway configuration.

- Added remote screen discovery, watch-only viewing, acknowledged owner/admin control and exact connection recovery to the Company Computer window. A bounded host relay keeps tickets and TLS endpoints out of the renderer, and closing a view leaves the cloud computer running.

- Added a Company Computer control window from the governed Company File. Owners/admins can request a start, cancel its exact pending intent and configure observed agent grants. Lost replies require status recovery; closing the client leaves the cloud computer and durable intent intact.

- Added shared export discovery and explicit native downloads in the Company File window, including for read-only members. The host saves only the selected, verified asset; cancellation and lost access preserve the destination.

- Added explicit native file selection and checked Company File upload destinations. Uncertain uploads retain their original bytes and operation; the renderer receives no local path or upload bytes. Binary proposals support verified previews and explicit native downloads before approval.

- Added member-selected binary downloads from the governed Company File window using exact listed versions and a native save chooser. Verified bytes stay in the desktop host; cancelled, stale or unauthorized downloads leave the destination untouched.
- Added an experimental cloud-owned tool result boundary and pinned native Codex adversarial proof, covering closed arguments, provenance, bounded results, authority rechecks, cancellation and the existing public mouth. The deployed driver is unchanged.
- Bound the experimental native tool session to cloud-derived run, agent, requester, sponsor and audience identity with live lease checks and an independent deadline. Added durable operation-receipt adapters that prevent changed call IDs or uncertain retries from repeating work; target permissions remain a separate effect-time gate.
- Added a pinned, authorized downstream Codex result-only callback and reproducible build recipe. The private Unix-socket boundary fences native rejection and parse errors before model requests, preserves native authentication, requires verified executable identity, and fails closed on missing, revoked or stalled authority. Verified on an isolated cloud Linux VM with synthetic data; full Step 2 rollout remains gated.
- Added the opt-in cloud-native Company File runtime: cloud-composed identity and context, current path permissions, atomic versioned edits, protected-path proposals, exact-object staging, durable execution admission, and receipt-bound completion without a canonical company mount in the harness.
- Added a separately packaged governed guest with pinned native artifacts, exact recovery-volume identity, mount validation and private execution recovery. Uncertain or expired work is retained for reconciliation rather than automatically rerun.
- Added actual-native local and remote compaction regressions for fenced results, restored runtime laws, forged instructions and authority revocation.
- Added a bounded human Company File reader using current member/path permissions, exact-version immutable bytes and a final access check, independent of model connections or quota.
- Added a governed Company File window with text editing, exact proposal previews, explicit approval or skip, and recovery of uncertain saves by their original command identity. Governed companies use fresh display-only roots instead of locally materializing or republishing the Company File.
- Added session/input-bound image attachment upload and retrieval with current human authority, immutable hash checks and bounded lifetimes; attachments cannot reopen the legacy raw-object path.
- Isolated the governed native process in a private Linux filesystem, process and network namespace, with a bounded provider-only encrypted relay, exact private tool sockets and kernel resource limits. The mode remains opt-in pending coordinated cloud acceptance.
- Added an explicit cloud-preview launch mode with separate account, model, registry and browser state, pinned preview endpoints, and no auto-update or login-item changes. It uses the normal account and Company File paths without bypassing authorization.
- Added a separately hosted Compute Identity recovery authority with sealed two-copy key backups, exact owner/member restore consent, private durable release receipts and replacement-guest installation. Deployment remains gated on independent key custody and live recovery acceptance.
- Added an isolated human recovery-review window with bounded member discovery, exact target and backup fingerprints, explicit source selection and native confirmation. Stale reviews, dismissed confirmations and lost acknowledgements cannot silently approve or repeat a restore.
- Added company-centered cloud secret custody with immutable envelope versions, company/member ownership, operation grants, one-time direct capture, effect-time receipt checks, a separately packaged broker, typed connector tools, and reflected-secret result fencing. Governed runtimes have no local or plaintext fallback.
- Added generated implementation/native bundle hashes, immutable low-effort admission, and private launch records for the exact offered tool catalog and initial-context digest. Packaging rejects stale generated pins.
- Added private Company File read observations and confirmations with exact versions, immutable content references and ranges, plus durable provider-view and compaction ancestry. Live permission and write-conflict checks remain authoritative; audit records contain no file contents or credentials.
- Added private, bounded operational observations for native turns, tools and authority checks, linked to canonical runs, assignments, Company File reads and effect receipts. Operator queries distinguish diagnostics from durable outcomes, preserve unknown counters and expose missing observations; optional export cannot retry or block product work.

### Fixed

- Updated the desktop updater's YAML parser to reject repeated empty merges that bypassed its CPU-work limit (GHSA-2883-xcg3-v3hh).
- Closed missing-member credential mutation and stale capture/grant revival, including concurrent capture admission versus membership revocation. The broker retains exactly its three custody functions after organization migrations.
- Allowed private agent conversations to read explicitly authorized shared company state while keeping drafts private and requiring the originating member's consent for shared publication. Member removal closes execution access without deleting retained private history.
- Forced direct tool selection for governed, fenced native runs so GPT model metadata cannot advertise an unavailable code-mode host. Older result-only binaries are rejected before model admission; ordinary Codex sessions retain their existing tool selection.
- Bounded native control-plane JSON response reads and cancellation, refused redirects, and stopped consuming raw RPC error bodies.
- Preserved private completion/failure records across lease expiry, stalled renewal and credential repair; retained records never become public sends or renewed execution authority.
- Hardened native credential resealing against hard links, changed file identities, unbounded file growth and missing original credential paths. Linux capture uses descriptor-anchored directories; unsafe refreshes retain the previous sealed capsule.
- Blocked legacy local Company File mutation and publication routes for governed companies, including product creation and artifact/configuration writes. Cloud file access and sign-in do not depend on model allowance.
- Bounded runner-control success bodies and preserved denial responses without reading backend error pages, including stalled bodies and redirects.
- Nested native runtime scratch inside its private temporary allocation so Linux cloud turns pass the existing containment layout check; failed startup still removes the entire allocation.
- Kept Codex login capsules and governed runtime identities auth-only: incidental CLI files cannot become runtime configuration or block startup, and credential refresh retains only the required auth file.
- Accepted PostgREST's HTTP 204 success for the two void Company File checks, so a successful permission check cannot block cloud agent startup. Data-bearing RPCs, denials, cancellation and uncertain-write handling remain fail-closed.
- Refused silent replacement of missing native identity keys. Bootstrap and native execution now bind the local identity volume to its current cloud recovery generation; recovery fences old login, run and lease authority. Generic service credentials cannot directly change recovery generations or clear their pending fence.
- Removed the recovery service's NAS startup dependency. The retained journal must be on a dedicated local filesystem; each NAS operation checks the opened directory against its pinned NFS export and cannot accept an unmounted local directory as a replica.

## [0.20.44] - 2026-08-28

### Fixed

- Wired the conversation Stop control to the exact displayed cloud run, with live member authorization, idempotent cancellation, and active-run status independent of historical failure alerts.
- Released native connection leases atomically when cloud jobs finish or are cancelled, so revoked jobs cannot block later work on the same connected account.

## [0.20.43] - 2026-08-27

### Fixed

- Decoupled Qorpera sign-in and company access from model connections, provider readiness, and allowance. The launcher now shows loading and retry states, keeps company cards during refresh failures, and replaces gateway HTML errors with actionable messages.
- Fixed cloud job cancellation violating terminal-state constraints; cancellation now atomically records its actor and timestamp and rejects further sends from the revoked lease.
- Added private-output-safe native startup diagnostics and a real Codex CLI regression covering progress delivery, lost-receipt retries, and private reasoning and output.
- Preserve refreshed native credentials after a failed turn while its execution authority remains valid; distinguish provider allowance, context, and capacity failures without exposing private diagnostics.

## [0.20.42] - 2026-08-27

### Added

- Added a run-scoped cloud `send_message` channel for explicit progress and final delivery. Provider output and reasoning remain private; delivery receipts are authority-checked and idempotent.
- Added agent-owned cloud routine editing with interval and advanced calendar triggers, active/inactive control, and run history.

### Changed

- Changed native cloud harness results to delivery-only receipts and required a final send before conversation jobs can complete.

### Fixed

- Fixed Company File opening with `ENOTEMPTY` when a tree update removes a directory containing separately managed staff instructions or dependency data. Such data remains in place, and incompatible file replacements are rejected.
- Fixed agent avatar color flicker and kept active-agent highlights blue.
- Fixed macOS sidebar chrome, compact add-agent alignment, and sidepanel pointer interactions.
