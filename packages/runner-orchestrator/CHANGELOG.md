# Changelog

## [Unreleased]

### Added

- Added the standalone durable Runner Orchestrator contract, polling loop, Supabase control-plane client, authenticated provider service boundary, and local test adapter.
- Added a Unix-socket LXD provider with full-VM enforcement, durable crash/replay journaling, exact image/profile/project/disk authority, private boot credentials, Compute Identity volume attachment, assignment fencing, and non-destructive VM stops.
- Added a checksum-verified single-file provider package and a fail-closed first-node systemd installer.
- Added a disposable first-node KVM, Secure Boot, storage, and private-network boundary smoke test.
- Added a locked full-VM guest package, unsigned local-image candidate builder, and fail-closed clean-boot acceptance test.
- Added strict Ed25519 image-provenance tooling and a provider startup gate binding the exact LXD fingerprint, guest package, clean source, and acceptance evidence.
- Added a TLS-only, source-fenced provider network boundary for the dedicated management VM.
- Added a checksum-verified Runner Orchestrator package and fail-closed management-VM systemd installer.
- Added a signed-image-gated, static-address management VM provisioner with no LXD authority.
- Added nested OCI runner-image provenance binding for the immutable image reference, private archive, and retained keyless Cosign bundle.
- Added the Step 3 persistent company-computer provider lane: a per-environment long-lived LXD VM journaled by logical computer with a pinned NAS-dataset disk device, stable runner reuse across runs, non-destructive stops, control-plane lifecycle activation, a coordinated snapshot window, and a stateless instance-snapshot LXD client extension.
- Added a guarded same-dataset Company Computer image refresh that verifies the current VM root, rejects live work or screens, proves the signed target exists, and preserves both the NAS dataset and Compute Identity volume.

### Changed

- Extended routine reconciliation with weekday-anchored intervals and advanced month, weekday, time-window, and time-zone schedules.
- Replaced the Pi protocol dependency with the provider-neutral `@qorpera/contracts` package.

### Fixed

- Restricted Company Computer image refresh to the service role even when hosted defaults grant function execution directly to client roles.
- Kept the live Company File mount optional for copy-mode guests and excluded it from isolated proposal-review VMs.
