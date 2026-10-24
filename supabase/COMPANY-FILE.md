# Company File

**Status:** Normative. Rewritten 2026-09-27 for the company folder model; the
platform's folders moved under `QorperaOS/` on 2026-10-21. The layout is fixed
in section 5.6 of the [runtime contract](../QORPERA-RUNTIME-CONTRACT.md), and
the machine side is designed in
[the company folder on every machine](../deploy/first-node/RUNTIME-COMPANY-FOLDER.md).
Where this file and the contract differ, the contract governs.

## Product definition

The Company File is the company folder. It holds all company state: who the
company is, its agents, what they know, what they do, and everything they
make. It lives once, on the NAS. Its versions and authority are recorded in
Supabase, and its bytes are stored on the NAS.

No machine holds the folder or a copy of it. The agent's run box, Company
Computers and coding machines each project onto the one folder and stream only
the bytes they open, so many machines can work across a folder of many
terabytes. A path `/company/<p>` on a machine is the logical path `<p>`, so
the vision is `/company/QorperaOS/vision/vision.md`. Paths on a machine are
case-sensitive.

Three things sit beside the folder:

1. **Supabase** holds what is not company state:
   - members, sign-in and invitations;
   - plan, usage and billing;
   - each member's own settings, including personal review rules;
   - runtime state: runs, queues, wakes, leases, locks, presence, receipts,
     read sets, schedule positions and message delivery;
   - conversations;
   - the folder's versions and authority; and
   - indexes of the folder, which are rebuilt from the files.
2. **The vault** (the credential broker) holds secrets: tokens, passwords,
   model logins and browser sign-ins. The company owns them, but they never
   enter the folder.
3. **Machines** keep only their system, applications and caches. Rebuilding a
   machine leaves the company intact.

## Layout

The platform's own folders sit under one top folder, `QorperaOS/` (Jonas,
21 October 2026; migration `20260930534000`). The platform seeds it when a
company is created (contract 5.6):

```
QorperaOS/vision/vision.md             the company's AGENTS.md; every agent reads it
QorperaOS/agents/sections.md           sidebar sections, in order, with their agents
QorperaOS/agents/<agent-name>/         agent.md, memory/, skills/, routines/, todos/
QorperaOS/agents/groups/<group-name>/  group.md, one folder per group chat
QorperaOS/connections/<connection>.md  one file per connected account, no secrets
QorperaOS/human-tasks/<task>.md        work an agent hands to a member or a contact
QorperaOS/contacts/<contact>.md        one file per outside person or firm
QorperaOS/skills/<skill>/SKILL.md      company skills
QorperaOS/rules/<rule>.md              company review rules, written by owners and admins
QorperaOS/interfaces/                  order.md, mailbox/ and members/: the app's pages
QorperaOS/tables/areas/                table.toml and rows.csv: the company's areas
```

The folder is written exactly `QorperaOS`, and its key is `qorperaos`, so
`QorperaOS/x` and `qorperaos/x` are one path. Below it, structured paths are
written in lowercase, as their keys. A structured file's stored path is
therefore `QorperaOS/<its key below the root>`: it is no longer equal to its
key, so code compares keys, or strips the root first (`osRelative` in
`packages/cloud-client/src/company-state-shared.ts`, `qorpera_os_relative` in
SQL). `QorperaOS/` itself is seeded and is never moved or deleted.

Beside `QorperaOS/`, at the top:

- `code/<owner>/<name>/` holds repositories and is created when coding starts;
- `hooks/<hook>/` holds the events the platform saved for a hook;
- `digital-post/` holds the company's Digital Post letters and their index
  `letters.json`, which the platform writes from the first letter on
  (deploy/first-node/RUNTIME-DIGITAL-POST.md);
- `bank/summary.json` is the summary of the company's bank accounts that the
  platform writes for the Bank page; and
- everything else is the company's own work, kept by area of the business
  first, then by kind, such as `sales/` and, once it is crowded,
  `sales/proposals/` (contract, 2026-10-21 amendment, item 1).

## Durable content

The folder must be able to hold and restore the company's durable work:

- the vision, agents, group chats, connections, human tasks, contacts,
  skills, rules, pages and tables above;
- shared data files, attachments, generated artifacts and review material;
- repositories with their shared git directory, branches, worktrees and
  unmerged work (contract, 2026-09-27 amendment "every machine works in the
  company folder", item 9); and
- admitted recovery archives with their inventories and restore proofs.

Plaintext provider credentials and connector secrets never belong in the
folder. Neither do live processes, dependency and build caches, or a machine's
system files.

## Writes and versions

Every write passes the mutation gateway: authority, version checks, a receipt
and a change event. A change from a shell command or a desktop application's
save is published as one change set. Each file keeps its own version, so
writes to different files never conflict. Silent last-writer-wins is
forbidden. Everything is approved by default: no path needs a member's
approval. The automatic review (contract, 2026-09-25 amendment) still checks
outside effects, hiring, archiving and reactivating agents, new group chats,
any change to a routine file (except a routine run's own end-of-run decision
that leaves its instructions and title alone), deletes and moves, made by an
agent on any write path. Members' own changes are not reviewed. Coding
sessions are not reviewed, so they see `QorperaOS/agents/` and
`QorperaOS/rules/` read-only.
Any change can be restored from the version history. The seeded folders
cannot be deleted or moved.

## Recovery admission

An operator recovery archive is a source for admission into the folder, not a
second permanent authority. Admission must:

1. preserve the source archive immutably, with its size, hash, owner, capture
   time and provenance;
2. inventory its paths without trusting archive names, and without allowing
   traversal, links, device files or platform path collisions;
3. classify durable content without silently discarding unknown items;
4. upload the content through the authenticated object gateway under upload
   intents, and hold it with a retention hold until it is published;
5. publish the admitted content into the folder; and
6. prove an independent restore before the source archive can be retired.

Large archives and cold data are read lazily by byte range. No machine
downloads them in full because they belong to the folder.

## Current implementation gap (2026-09-27, bundle v137)

The build does not yet match this file:

- **One version for the whole company.** The Company File is one tree
  manifest with one head per company. Every write re-stages the whole tree,
  so unrelated writes conflict.
- **Hard ceilings.** The manifest's 8 MiB bound caps a company at roughly
  25,000 to 27,000 files, depending on path lengths. There are also caps of
  50,000 entries, 256 MiB per file and 1 TiB per company (contract 5.5 calls
  them defects).
- **One path per change.** There is no move, change set or restore.
- **A company-wide lock.** Every tool call, reads included, locks the
  company's row.
- **No machine can see the folder.** Agents reach it through one-file tools.
  The Company Computer and coding machines use copies and their own storage.
- **Company state in database rows** with no file behind them: routines,
  review rules, sidebar sections, connections, the Co-Founder mark, agent
  threads and worker dispatch.
- **Todos run backwards:** they are database rows with a published copy.
- **Old paths:** agent documents live at `organization/agents/<uuid>.json`
  instead of `agents/<agent-name>/agent.md`, and there is no `vision/`.
- **Omitted layers:** the tree contract declares the staff registry and staff
  instructions to be outside the Company File.

The contract's 2026-09-27 layout amendment lists where each item belongs and
the order of work. The storage core changes first, before any machine writes
through the folder. Today's companies are test companies: their data is
deleted, their company state and indexes are cleared from Supabase, the
folder is set up on the NAS, and the layout is proven on new companies. The
exact scope is confirmed with the founder before anything is deleted (founder
decision, 28 September 2026).
