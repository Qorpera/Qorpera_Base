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

### Changed

- Replaced the Pi protocol dependency with the provider-neutral `@qorpera/contracts` package.
