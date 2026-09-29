# Deleting a company

Decided by the founder on 28 September 2026 ("option 2"): deleting a company removes everything the
company has, on the nodes too. The company disappears for its member at once; the servers then remove
its machines and node state; the database rows go last.

Only the last member deletes a company (contract, 28 September 2026 "several founders"); everyone
else leaves. Deleting is final: there is no undo window, and no copy of a deleted company's machines is
kept. Usage and computer-hour records stay for bookkeeping, with plain ids (contract §19 item 9).

## The flow

1. **Request** (`qorpera_delete_hosted_profile` → `qorpera_request_company_deletion`, 20260928249150).
   In one transaction, after the company fence:
   - a row in `qorpera_company_deletions` (ids and times only, no link to the company, so it
     outlives the purge);
   - `qorpera_member_role` answers no role and the company list leaves the company out, so every check
     built on them treats it as gone; the member's access state turns `revoked`, which open clients
     receive;
   - `qorpera_company_execution_paused` answers true and a pause row is written; the pause cannot be
     lifted while the deletion is open;
   - `qorpera_stop_company_work`: queued and running jobs end as failed ("Company deleted"), company
     setup is blocked, coding sessions are archived, coding executors switched off and coding
     machines asked to retire, pending invitations withdrawn.
   - Company Computers power off at their provider's next idle check (a provider whose preparation
     is switched off keeps its computer awake, as for any company).
   - The founding lobby drops the table at once and withdraws its invited seats; identity recovery
     refuses the company.
2. **Drain.** Node components remove what the company has on the nodes, each through its own custody.
3. **Finish** (`qorpera_finish_company_deletions`, an operator's pg_cron every minute, up to ten
   companies per call, picked at random so a company that keeps failing never stalls the rest; with
   more open requests than that, each is visited less than once a minute). It repeats
   `qorpera_stop_company_work`, reads `qorpera_company_node_holdings`, and runs `qorpera_purge_company`
   (20260928248920) once nothing is held; stop and purge run in separate subtransactions. Its state
   (`holdings`, `last_error`, `purged_at`) is on the request row. The member's account cannot be deleted
   until the purge (their rows restrict it).

Operator step after the migration is live:

```sql
select cron.schedule('qorpera-company-deletions', '* * * * *', 'select public.qorpera_finish_company_deletions()');
```

Rollback: `select cron.unschedule('qorpera-company-deletions')`. Requests then wait; nothing else changes.

## What the nodes hold, and who removes it

| Held | Removed by | Status |
|---|---|---|
| Run machines (one-run VMs, exec-host sandboxes) | provider reconcile after the run ends | works; a guest that never got its assignment runs on (D2) |
| Coding machines | coding executor housekeeping (retiring machine → stop, sleep, delete, release) | works |
| Agent machines (#419) | executor, once the machine is set `deleted` | #531 adds them to `qorpera_stop_company_work`; until it lands their allocations hold the purge |
| Company Computers | office provider: power off (works), delete and release (D3) | D3; live once the D3b provider build is installed per office |
| Sign-in identity volumes on the nodes and their exec host devices | LXD provider's login gateway (D4) | D4; live once the LXD provider build is rolled |
| Run recovery volumes (`user.qorpera.profile_id`), identity volumes from before node demands (8 Sep) | operator runbook: a run's recovery volume only once its journal is archived (a day after it settles; the provider still requires it before) | last |
| Credential capsules and recovery backups in storage | deleted-company storage queue (D5) | D5 |
| Coding NAS workspaces `workers/<company>/` | coding executor (D5) | D5 |
| Connected-account tokens at Google/GitHub | secret broker, best-effort revoke (D6) | D6 |
| Model logins (ChatGPT, Claude) | our copies are purged; the member signs out at the provider | by design |
| Per-company broker units, recovery services, office host config (older companies) | operator runbook | last |

Until a step lands, a company holding that kind of state stays hidden and stopped, and the finisher
records what it waits for.

## Build steps

- **D1** (this migration): request, stop, finisher; coding machines and Company Computer power-off.
- **D2** orchestrator: retire `registered`/`assigned` guests whose job is terminal (one-run VMs and
  exec-host sandboxes).
- **D3** office retirement (D3a SQL: migration 20260928259320). After a deleting company's idle power-off
  (stop acknowledged, node demand suspended, no later transition, boot intent or open reset), the
  provider asks `qorpera_runtime_office_retirement(request)` for the retirement and its delete command
  id, takes a five-second window (`qorpera_prepare_runtime_office_retirement`), deletes the VM under its
  operation journal, confirms it is absent, then `qorpera_retire_runtime_office(request, evidence)`
  releases the allocation (the release trigger releases the already suspended node demand; the meter
  ended the stretch at the suspension), drops the node binding, sets the office `retired` and cancels its
  start intent. The ledger `qorpera_runtime_office_retirements` has no link to the company, so
  `qorpera_runtime_office_retirement_receipt` still answers after the purge.
  D3b is the provider step (`lxd-office-retirement-worker.ts`, see "Office retirement" in
  RUNTIME-OFFICE-RETENTION.md). After a confirmed power-off, also one from before a node reboot, the
  lifecycle asks SQL; until a delete is pinned, at most once a minute per process. For a deleting
  company it pins the delete command id in `office-retirement-request.json`, and from then on runs only
  the retirement, before any other call (the fleet unit goes straight to it). It writes
  `office-retired.json` from SQL's receipt; with that marker the provider, the fleet unit on that host
  and the root host guards make no call, and the provider service ends. It needs a new office provider
  build, which the coordinator rolls at the cut (lane below). Not covered, and held for an operator: offices whose VM was created but
  never activated, offices mid-reset, an office whose resume (a wake before the deletion) was under
  way when the deletion came (its boot intent or successor stays; the pause keeps it from finishing),
  and an office whose node rebooted between its power-off record and its node-demand suspension.
  Coordinator's lane for D3b: the coordinator rolls the office provider build at the cut (RUNTIME
  release roll, as #505), after the release carrying 20260928259320 is live.
  1. Build `node scripts/package-lxd-office-provider.mjs --out <dir>` from the release commit on node 2;
     its sha256 must match the review. Stage it on the node.
  2. Before the roll, read the provider's last observation (`journalctl -u <unit> -n 5`). Roll on
     `active`, `idle` or `power_off`/`powered_off`, and on `unconfirmed` with `power-off host changed`
     (a computer powered off before a node reboot, which the old build cannot replay; the new build
     retires it if its company is being deleted). Wait while it is mid-reset, mid-resume or `pending`.
  3. As root: check the live file's sha is the expected old one, keep it beside the live file as
     `.retired-<sha12>` (root 0400), `install -m 0444` the new build to `.new`, move it over the live
     file, restart the unit and wait for active. Production is `qorpera-prod-office-a1`
     (`/opt/qorpera-prod-office-a1/qorpera-office-provider.cjs`); the acceptance provider
     `qorpera-phql-office-a1` only when named. Before the roll, find the unit that serves each target
     office of step 4 (its policy's `companyComputerId`). The VM keeps running across the restart;
     confirm the next observation has the state from step 2, except for a deleting company's office,
     which goes to `phase: retirement` (step 4).
     Fleet units, where installed, run their own bundle (`scripts/package-lxd-office-fleet.mjs`,
     installed under `/opt/qorpera/office-fleet/<sha>/`, a path named by its sha). Build it too, check
     its sha, and install it with the fleet installer as an explicit reviewed reinstall; never move new
     bytes over a sha-named path.
  4. Check: deleting companies with a Company Computer (4168e335 and b116763d on 2026-09-28) show
     `phase: retirement`, then `state: retired`; `qorpera_runtime_office_retirements.retired_at` is set;
     LXD lists no instance for the office; the node's inventory stays ready (no unmanaged instance);
     `qorpera_company_deletions.holdings` drops the machine and the finisher purges the company.
  5. A retired office's unit exits 0 and stays stopped. Disable it, and disable this office's fleet
     units on the other candidate hosts too: they have no marker and would call SQL for a purged office
     at their next start. The protected configuration and journal are left for the operator runbook. The
     workbench NAS directory stays (D5).
  6. Rollback: put the `.retired-<sha12>` file back and restart. Not for an office that already has
     `office-retirement-request.json` in its journal: an older build would keep asking for the deleted
     VM. Leave that office on the new build.
- **D4** sign-in identity retirement (migration 20260929450000; `lxd-login-gateway.ts`). A node-held
  sign-in keeps its key on an LXD volume named after the identity, on its sign-in machine's node and on
  every node its runs used; on node 2 the volume is also attached to the execution host. The holdings
  count the company's (node, identity) placements: each identity that had a sign-in machine, on each
  node where the company had a reserved machine. A company without node sign-ins (Vault By Default, or
  none) has none and purges as before.
  Once none of the company's machines was released in the last ten minutes (a parked execution-host
  slot keeps an identity mounted up to five), each node's LXD provider (its login gateway, at most once
  a minute) gets the identities from `qorpera_runtime_identity_retirements_due`, and tries each at
  most once a minute, eight a pass: it skips one with a sign-in machine of its own not yet released,
  checks the volume is exactly the identity's, detaches the execution-host device of exactly the
  identity shape, deletes the volume (LXD refuses one still in use), confirms both gone and records it
  with `qorpera_confirm_runtime_identity_retirement`. While SQL names it, its sweep does not attach it
  again. A node whose inventory policy has an execution host with identity volumes cannot report
  `device: none`. The ledger `qorpera_runtime_identity_retirements` outlives the purge, and a replay
  after a lost reply may report `absent` for what it removed (never the reverse).
  The node inventory keeps accepting the device from the company's login demands until the purge, which
  now waits for the detach. No new volume appears while deleting: node reservations refuse a paused
  company, and the run provider neither needs nor re-creates the identity volume of a stopped or lost
  run it keeps reconciling (up to a day, also after a restart). Identity recoveries need no node step:
  the escrowed key reaches a node only through a sign-in machine, refused while deleting; their rows go
  with the purge and their backups are D5.
  Once the migration is live, an open deletion that waited only on sign-ins never placed on a node
  purges at the next finisher pass.
  A pair no node can confirm (a node taken out of service, a volume that is not exactly the identity's,
  a device refused) keeps the deletion waiting; `qorpera_company_deletions.holdings` counts it, and
  `select * from public.qorpera_company_identity_placements('<company>') as p where not exists (select 1
  from public.qorpera_runtime_identity_retirements as r where r.node_id = p.node_id and
  r.compute_identity_id = p.compute_identity_id)` names it. After checking the node by hand (no volume
  `<prefix><identity>`, and on node 2 no `identity-<identity>` device on the execution host, or the
  purge takes node 2 out of the inventory), an operator records it as the provider would:
  `insert into public.qorpera_runtime_identity_retirements (node_id, compute_identity_id, provider_id,
  volume, device) values ('<node>', '<identity>', '<provider id>', 'absent', 'absent');`
  Not covered, for the operator runbook: volumes from before node demands existed (8 September), and
  run recovery volumes. An execution-host rebuild that runs while a device is retired stops with "lost
  Compute Identity devices": check the volume is gone (retired), then run it again.
  Rollout: the LXD provider build on every node (node-agent `provider` role) after the release carrying
  the migration is live. Before that, the due list 404s (logged once a minute) and a company with node
  sign-ins keeps waiting, as it did.
- **D5** storage and NAS queues, written before the purge, consumed by the artifact GC worker and the
  coding executor.
- **D6** upstream token revoke on delete and on Disconnect.
