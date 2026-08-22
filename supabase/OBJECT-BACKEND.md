# Self-owned object backend

**Status:** Catalog cutover, trusted gateway, client transport, mixed-backend
cleanup, two-phase deletion recovery, deleted-profile reclamation, and
resumable migration are implemented.
The clean hosted schema and physical NAS gateway passed Windows/Mac upload,
download, deduplication, corruption refusal, cleanup, service restart, and
same-NAS restore tests. Stable named TLS ingress and an enabled DSM boot task
are configured and cloud-to-NAS cleanup passed through the stable hostname. A
NAS reboot proof, dedicated non-administrator service identity, and independent
backup target remain production operations gates.
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

**2. Gateway.** The standalone `packages/object-gateway` service accepts
uploads, **hashes the bytes server-side**, writes them to its configured
NAS-mounted root, and only then confirms the catalog row through a service-only
RPC. The catalog is never writable by clients. Downloads are rehashed before
release, and legacy Supabase Storage objects remain readable during migration.

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

## Implementation and deployment sequence

1. **Catalog behind a predicate.** Complete in migrations `20260818003000`
   through `20260818005000`.
2. **Cut server-side trust reads over to the catalog.** Complete and covered by
   the object-catalog regression suites.
3. **Build the trusted gateway and NAS backend.** Complete locally in
   `packages/object-gateway` and migration `20260821006000`. Member clients use
   only their Supabase access token; NAS filesystem authority and the Supabase
   secret key stay in the gateway service.
4. **Route cleanup by catalog backend.** Complete locally. Supabase and NAS
   deletion both commit an exact, service-only authorization while the GC lease
   is live, remove bytes second, and finalize the catalog last. The private NAS
   gateway control token cannot bypass that authorization, and an interrupted
   deletion is durably reconcilable before later work is claimed.
5. **Deploy and migrate.** Mount the verified NAS data root, deploy the gateway
   behind TLS, apply the migration, configure clients and the cleanup worker,
   then run `qorpera-object-gateway migrate`. The command pages only legacy
   catalog rows, rehashes downloaded bytes, writes them to the NAS, and flips
   each row only after durable storage succeeds.

Steps 1–5 passed against the clean hosted project and physical NAS. The
migration correctly found zero legacy objects. The dedicated named tunnel at
`objects.qorpera.com` passed Windows, Mac, and Edge-worker checks after the
temporary test tunnel was retired. Production desktop clients default to this
gateway when connected to the hosted Qorpera Supabase project; explicit gateway
configuration remains available for non-production and self-hosted projects.

Storage usage and plan allocation apply only to product objects confirmed in
the authoritative catalog. Operator recovery archives stored elsewhere on the
same NAS are excluded from the displayed count only while they remain outside
the product catalog: they are not yet addressable or authorizable Company File
objects. That exclusion is not a product boundary. A company-owned recovery
archive is Company File admission input and must enter through the trusted
gateway with an explicit owner, provenance, verified object graph, and
retention root before it contributes to product usage. The original archive
remains immutable until an independent restore of the published revision has
passed. See `COMPANY-FILE.md`.

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
