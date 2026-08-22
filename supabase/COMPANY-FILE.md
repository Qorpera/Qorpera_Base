# Company File

**Status:** Normative product and authority contract. The logical organization
is versioned and intentionally not frozen to today's desktop folder layout.

## Product definition

The Company File is the cloud-authoritative data plane that forms the durable
digital body of a company. It is one logical, revisioned namespace presented
to members and agents even though its bytes are content-addressed objects on
the NAS and its revision authority is recorded in Supabase.

The Company File is not:

- a folder on the member's computer;
- a shared writable NAS filesystem;
- a particular computer's checkout or local disk; or
- one mutable archive that every runner edits in place.

The complete cloud company combines three authority layers:

1. the Company File data plane for durable company content;
2. the Supabase control plane for sessions, permissions, queues, leases,
   provenance, and Company File revision metadata; and
3. credential and compute-identity capsules for secrets that application and
   control-plane code must not receive in plaintext.

The product may present those layers as one company experience. It must not
move authority into the wrong layer merely to make the interface look like one
filesystem.

## Durable content

The Company File must be able to retain and reconstruct the company's durable
work, including:

- shared data files, attachments, generated artifacts, and review material;
- agent workspaces, memory, skills, instructions derived from authoritative
  staff state, and durable handoff material;
- connector recipes, schemas, non-secret configuration, and opaque secret or
  connection references;
- project and repository identities, refs, bundles, durable branches,
  unmerged work, and worktree recovery checkpoints;
- company policies, product definitions, and other versioned configuration;
- encrypted logical-computer volumes or checkpoints when company policy elects
  to retain them; and
- admitted recovery archives plus inventories and restore proofs.

Plaintext provider credentials and connector secrets do not belong in the
Company File. Live processes, dependency caches, and a physical checkout are
also not durable content. A repository or unmerged worktree state can be
durable Company File data while the directory in which one runner materializes
it remains a disposable cache.

## Logical organization

The product owns a semantic namespace, not a permanently fixed top-level
directory convention. Members should be able to navigate familiar views such
as Projects, Agents, Connectors, Data, Artifacts, Computers, and Recovery.
Those are logical collections backed by a versioned manifest and stable object
identities; they need not map one-for-one to NAS paths or runner directories.

This leaves room to improve organization without moving every object or
breaking old revisions. A revision records the organization contract it uses,
and newer clients must continue to restore older contracts.

## Member and computer access

The desktop File Explorer action opens a synchronized copy on that member's
computer. It is an editable projection of the current authorized revision, not
the authority. The UI must label it as a synced copy. Changes are validated,
uploaded as immutable objects, and published through a compare-and-swap head
transition; a local edit is not cloud durable merely because it exists in File
Explorer.

A Company Computer receives an isolated checkout of an exact pinned revision
plus the repository and checkpoint references required for its run. The
computer writes only to its job-private checkout. Its result becomes a
validated revision or review proposal. Destroying the physical computer must
not destroy the company data required to reconstruct that work.

Neither interface writes directly to a common NAS directory.

## Recovery admission

An operator recovery archive is a source for Company File admission, not a
parallel permanent authority. Admission must:

1. preserve the source archive immutably with its size, hash, owner, capture
   time, and provenance;
2. inventory its paths without trusting archive names or allowing traversal,
   links, device files, or platform path collisions;
3. classify durable content without silently discarding unknown items;
4. upload the content through the authenticated object gateway and register
   server-verified reachability and retention roots;
5. publish an explicit Company File revision or review proposal that points to
   the admitted content; and
6. prove an independent restore before the source archive can be retired.

Large archives and cold data require lazy, range-capable materialization. They
must not be downloaded in full to every desktop projection or every agent
computer merely because they belong to the Company File.

## Current implementation gap

The current tree contract proves immutable, verified publication for ordinary
files, but an individual logical file is capped at 256 MiB and desktop
projections eagerly materialize the visible tree. Product Git checkouts are
also omitted as disposable caches, while only selected source and recovery
references are retained.

Company41's credential-safe structured recovery set is now admitted under an
explicit Recovery collection and counted in the published Company File. It
contains the verified Git bundle, worktree patches and untracked archives,
company state, inventories, and checksums needed to reconstruct the retained
work without treating a local checkout as authoritative.

The separate 38.6 GB cold source archive remains immutable operator recovery
input with a recorded size and digest, but it is not yet an admitted Company
File object and is therefore not included in catalog usage. Admitting that raw
archive still requires a server-side importer, large/cold-object references
with lazy hydration, and an independent restore proof.
