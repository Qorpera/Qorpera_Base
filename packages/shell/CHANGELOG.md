# Changelog

## [Unreleased]

### Changed

- Replaced the selectable agent figures with Planet, Acorn, Flame, Rocket, Crown, Heart, and Ghost, with compact single-row selectors and an eleven-color palette that preserves artwork depth and transparency.
- Adopted the approved Rocket/Crown app icon, light-blue selection, and warmer sidebar surfaces.
- Unified sidebar, header, and trailing conversation activity around per-agent motion clocks, geometric typing dots, expressive working eyes, and finite creation and attention effects. Sidebar hover stays static; reduced motion and hidden windows pause animation.
- Replaced overlapping group-avatar frames with transparent silhouette separators and count-aware layouts. Pinned figures retain their full card size.

### Fixed

- Prioritized unresolved requests, current activity, and unseen replies over the last-message preview. Reading a visible reply clears New without clearing an unresolved Needs you state.
- Preserved public message previews across session appends and room metadata updates without exposing reasoning, tool output, or attachment payloads in the sidebar.

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
