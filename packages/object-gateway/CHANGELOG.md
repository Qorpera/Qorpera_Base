# Changelog

## [Unreleased]

### Added

- Added the folder core's byte route for folder-v2 runs (core C1d-1b): `/v1/folder-objects/<environmentId>/<sha256>` on the native credential with the run's binding. A put names its upload intent (`x-qorpera-upload-intent`) and is authorized by that intent alone, then stored, confirmed and replicated as native objects are; a get is allowed when an entry or path version the run may read references the hash, checked before and after the NAS read. The folder core's stop (55000) is answered 423 and its lock conflicts (40001, 40P01, 55P03) 409, instead of PostgREST's 500, so neither opens the gateway's database circuit for every company. A read that meets a busy NAS lane when Storage has no copy yet (replication pending) is answered 503, which the runtime asks again, rather than Storage's miss. The native route's token and binding checks are now shared helpers; its behaviour is unchanged.

- Added a bounded member presence endpoint that verifies native signatures and intersects current member/native path permissions in separate authority transactions. Responses contain display metadata only, with explicit browser CORS and no native bindings or routing keys.

- Added member-authenticated shared export downloads with exact asset/hash selection, completed receipt and audience checks, bounded binary verification, live authority rechecks and narrowly scoped browser CORS.

- Added bounded member binary upload admission with immutable source/manifest/chunk identity, current SQL authority and existing live publication or protected human review. Pending file downloads assemble and verify chunks with authority rechecks and exact plan identity.

- Added an explicit browser-origin allowlist for member Company File reads, edits, reviews and session attachments, with route-specific preflight checks and no browser access to private gateway routes.
- Added bounded, operator-only Company File request observations with canonical command/read linkage, timing, safe outcomes and available object-byte counts. The in-process window exposes restart/eviction gaps and excludes paths, file contents, tokens and raw errors.

### Changed

- The folder route answers the folder core's storage allowance refusal (23514, which PostgREST sends as 400) with 413, so the runtime can tell a full company from a failed request.

### Fixed

- A lock conflict on the native object route says so in its error body: a 409 from a serialization failure, deadlock or lock timeout (40001, 40P01, 55P03) answers `{ "error": …, "code": "lock_conflict" }`. The database call that answered rolled back, and that route's request (content-addressed bytes, then read checks and one catalog upsert) may be sent again whole; the runtime's native object transport retries on it. No other refusal carries a code: a stop (423), a GC write fence or a deletion in progress (409), a denial or an unavailable dependency keep `{ "error": … }`, and so does every other route, including member Company File routes, whose earlier steps (a review before its apply) may have committed.
- One company's database state no longer refuses every company. PostgREST answers SQLSTATE classes 40 and 55, and 57014, with HTTP 500, which the database circuit counted as an outage for its cooldown (~5 s). The native and member object RPCs and the member Company File RPCs now read PostgREST's error code, with the folder core's codes (#560): a stop (55000) is 423, a serialization failure, deadlock or lock timeout (40001, 40P01, 55P03) 409. A statement timeout (57014) is 503 and opens the circuit only when no other call succeeded while it ran. Other 500s, 502/503/504, refused connections and the gateway's own deadline still open it. Profile, replication and deletion RPCs keep every 500 a dependency failure. The folder core's byte RPCs (#560) now use the same reading, so their statement timeout follows the same rule; their storage allowance (23514) stays 413 (#582), and their other 400s stay 400.
- A caller that gives up no longer opens the member Company File circuit. When the presence route passed its 2.5 s deadline, or a member closed the tab, the aborted database call counted as the database failing and refused every company for the cooldown. Only the circuit's own deadline and real upstream failures count now.
- A lock conflict (40001, 40P01, 55P03) on a profile, replication, deletion or migration RPC is still 503 to its caller, so the replication reconciler keeps the object pending instead of blocking it, but it no longer opens the database circuit for every company. With migration 20260929630000 the native and member object RPCs and the replication RPCs end a lock wait after 2 s with 55P03, under the gateway's 5 s deadline, instead of running into that deadline.
- Return non-retryable HTTP 412 for stale Company File versions, context, policy and review preconditions, preserving authorization and receipt replay without managed API transaction-retry stalls.
- Resolve authoritative manifest byte counts before Company File bootstrap reads, preserving exact-size and hash validation across NAS reads and Storage fallback.
- Authenticate configured JWT service credentials on gateway publication, object authority, and Storage requests without replacing member identity or treating opaque API keys as bearer tokens.
