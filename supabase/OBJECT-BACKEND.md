# Self-owned object backend

**Status:** Design. No code in this slice.
**Goal:** company file objects live on Qorpera-owned storage (the NAS) while
account identity, membership, and trails stay on managed infrastructure.

## Why this is not a configuration change

The desktop already talks to storage through an interface —
`CloudObjectTransport` in `cloud-object-store.ts` is just `put(path, bytes,
mediaType)` and `get(path)`, and the test suite substitutes an in-memory
implementation. Swapping the client side is genuinely easy.

The database is the hard part. Twelve sites across six migrations join
`storage.objects` directly:

| Migration | Purpose of the join |
| --- | --- |
| `20260816010000` | bucket definition and the profile-prefix RLS policies |
| `20260816016000` | artifact registration verifies the root object exists at its declared size |
| `20260816017000` | reachability entries, graph availability, restore proofs |
| `20260816018000` | GC candidate listing; the object-writes fence on the insert policy |
| `20260817000000` | runner broker input authorization and output confirmation |
| `20260817001000` | output publication into a child substrate |

Every one of them asks the same question in the same shape: *does an object
exist for this profile, at this SHA-256, with exactly these bytes?* That
question is the trust root of the whole retention system — reachability
closure, restore proofs, GC exclusivity, and lease-scoped runner reads all
resolve to it. Postgres can answer it today only because Supabase Storage
writes `storage.objects` in the same database.

Move the bytes to the NAS and Postgres goes blind. Nothing else in the
system breaks first; this does.

## Design: object catalog + trusted storage gateway

**1. Catalog.** A `qorpera_profile_objects (profile_id, sha256, bytes,
backend, created_at, confirmed_by)` table becomes the authoritative record of
what exists. The twelve sites query the catalog instead of `storage.objects`,
behind one predicate function so the join shape lives in a single place.

**2. Gateway.** A trusted service accepts uploads, **hashes the bytes
server-side**, writes them to the configured backend, and only then inserts
the catalog row. The catalog is never writable by clients.

That second point is not optional, and it is the reason this needs a design
slice rather than a patch. The original review found a critical defect of
exactly this shape: reachability graphs were client-asserted, so any writer
could describe a graph that under-covered its root and drive the GC worker
into deleting live objects. The fix made deletion authority derive only from
server-verifiable facts. A catalog that clients could write would reintroduce
that defect one layer down — a client could claim an object exists, and the
GC's exclusivity analysis would believe it.

The pattern already exists in the codebase: the runner broker hashes uploaded
bytes Edge-side, refuses `upsert`, and re-downloads pre-existing objects to
verify them before trusting the address. The gateway generalizes that.

**3. Authorization.** The RLS insert policy on `storage.objects` currently
enforces profile-prefix containment plus `qorpera_profile_object_writes_allowed`
(write access and no active GC fence). That check moves into the gateway,
which must consult the same predicate before accepting an upload — including
the GC fence, or a cleanup plan could delete objects a concurrent upload is
adding.

## Sequencing

1. **Catalog behind a predicate.** Introduce the table and one function; keep
   Supabase Storage authoritative and dual-write. No behavior change.
2. **Cut the twelve sites over** to the predicate. The account-separation and
   GC suites already exercise these paths, so equivalence is testable in CI.
3. **Build the gateway** with server-side hashing and the authorization
   checks, still writing to Supabase Storage. Verifiable without new hardware.
4. **Add the NAS backend**, migrate existing objects, flip `backend` per
   profile. Reversible per profile.

Steps 1–3 need no NAS and are the honest place to start.

## Constraints this must not break

- **Server-verified facts.** The database must never accept a client's claim
  that an object exists or how large it is.
- **Deletion safety.** `qorpera_object_graph_objects_available` and the GC
  exclusivity analysis must stay server-side truths.
- **Content addressing.** Objects remain immutable and addressed by SHA-256;
  the backend is a transport detail, never an identity.

## Availability consequence

With objects on the NAS, a NAS outage stops publication, preview, merge, and
runner input materialization. Identity, membership, and attended chats keep
working, and cached checkouts keep reading. That is a bounded, acceptable
degradation and matches the intended model — but it is a real change from
today, where a NAS outage costs nothing.

**Prerequisite:** the storage baseline. Objects are company work product;
until the NAS has verified backup and restore, moving them there trades a
managed durability guarantee for an unproven one. The drives are also outside
Synology's validated list, so lifespan prediction is unavailable and SMART
self-tests should be scheduled independently.
