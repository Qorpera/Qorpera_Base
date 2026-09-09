# Changelog

## [Unreleased]

### Added

- Added a bounded member presence endpoint that verifies native signatures and intersects current member/native path permissions in separate authority transactions. Responses contain display metadata only, with explicit browser CORS and no native bindings or routing keys.

- Added member-authenticated shared export downloads with exact asset/hash selection, completed receipt and audience checks, bounded binary verification, live authority rechecks and narrowly scoped browser CORS.

- Added bounded member binary upload admission with immutable source/manifest/chunk identity, current SQL authority and existing live publication or protected human review. Pending file downloads assemble and verify chunks with authority rechecks and exact plan identity.

- Added an explicit browser-origin allowlist for member Company File reads, edits, reviews and session attachments, with route-specific preflight checks and no browser access to private gateway routes.
- Added bounded, operator-only Company File request observations with canonical command/read linkage, timing, safe outcomes and available object-byte counts. The in-process window exposes restart/eviction gaps and excludes paths, file contents, tokens and raw errors.

### Fixed

- Return non-retryable HTTP 412 for stale Company File versions, context, policy and review preconditions, preserving authorization and receipt replay without managed API transaction-retry stalls.
- Resolve authoritative manifest byte counts before Company File bootstrap reads, preserving exact-size and hash validation across NAS reads and Storage fallback.
- Authenticate configured JWT service credentials on gateway publication, object authority, and Storage requests without replacing member identity or treating opaque API keys as bearer tokens.
