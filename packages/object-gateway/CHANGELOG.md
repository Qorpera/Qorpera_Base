# Changelog

## [Unreleased]

### Added

- Added the folder core's byte route for folder-v2 runs (core C1d-1b): `/v1/folder-objects/<environmentId>/<sha256>` on the native credential with the run's binding. A put names its upload intent (`x-qorpera-upload-intent`) and is authorized by that intent alone, then stored, confirmed and replicated as native objects are; a get is allowed when an entry or path version the run may read references the hash, checked before and after the NAS read. The folder core's stop (55000) is answered 423 and its lock conflicts (40001, 40P01, 55P03) 409, instead of PostgREST's 500, so neither opens the gateway's database circuit for every company. A read that meets a busy NAS lane when Storage has no copy yet (replication pending) is answered 503, which the runtime asks again, rather than Storage's miss. The native route's token and binding checks are now shared helpers; its behaviour is unchanged.

- Added a bounded member presence endpoint that verifies native signatures and intersects current member/native path permissions in separate authority transactions. Responses contain display metadata only, with explicit browser CORS and no native bindings or routing keys.

- Added member-authenticated shared export downloads with exact asset/hash selection, completed receipt and audience checks, bounded binary verification, live authority rechecks and narrowly scoped browser CORS.

- Added bounded member binary upload admission with immutable source/manifest/chunk identity, current SQL authority and existing live publication or protected human review. Pending file downloads assemble and verify chunks with authority rechecks and exact plan identity.

- Added an explicit browser-origin allowlist for member Company File reads, edits, reviews and session attachments, with route-specific preflight checks and no browser access to private gateway routes.
- Added bounded, operator-only Company File request observations with canonical command/read linkage, timing, safe outcomes and available object-byte counts. The in-process window exposes restart/eviction gaps and excludes paths, file contents, tokens and raw errors.

### Fixed

- Return non-retryable HTTP 412 for stale Company File versions, context, policy and review preconditions, preserving authorization and receipt replay without managed API transaction-retry stalls.
- Resolve authoritative manifest byte counts before Company File bootstrap reads, preserving exact-size and hash validation across NAS reads and Storage fallback.
- Authenticate configured JWT service credentials on gateway publication, object authority, and Storage requests without replacing member identity or treating opaque API keys as bearer tokens.
