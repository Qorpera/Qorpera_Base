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
| Agent machines (#419, not yet merged) | executor, once the machine is set `deleted` | to add with #419 |
| Company Computers | office provider: power off (works), delete and release (D3) | D3; live once the D3b provider build is installed per office |
| Sign-in identity volumes on the exec host, recovery volumes | login gateway / LXD provider (D4) | D4 |
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
- **D3** office retirement (D3a SQL: migration 20260929320000). After a deleting company's idle power-off
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
  build, reinstalled per office in the coordinator's lane below. Not covered, and held for an operator: offices whose VM was created but
  never activated, offices mid-reset, and an office whose resume (a wake before the deletion) was under
  way when the deletion came (its boot intent or successor stays; the pause keeps it from finishing).
  Coordinator's lane for D3b (after the release carrying 20260929320000 is live):
  1. Package the office provider and the office fleet from the release commit
     (`scripts/package-lxd-office-provider.mjs`, `scripts/package-lxd-office-fleet.mjs`).
  2. For each installed office provider on each node, one at a time: read its last observation
     (`journalctl -u <unit> -n 5`). Continue for `active`, `idle` or `power_off`/`powered_off`, and for
     `unconfirmed` with `power-off host changed` (a computer powered off before a node reboot, which the
     old build cannot replay; the new build retires it if its company is being deleted). Wait while it is
     mid-reset, mid-resume or reports `pending`. Stop the unit (the VM keeps running),
     install the new build the way the release installs provider builds (root reinstall; the installers
     refuse to overwrite a changed unit or binary without that explicit step), start it, and confirm the
     next observation has the same state as before.
  3. Check: deleting companies with a Company Computer (4168e335 and b116763d on 2026-09-28) show
     `phase: retirement`, then `state: retired`; `qorpera_runtime_office_retirements.retired_at` is set;
     LXD lists no instance for the office; the node's inventory stays ready (no unmanaged instance);
     `qorpera_company_deletions.holdings` drops the machine and the finisher purges the company.
  4. A retired office's unit exits 0 and stays stopped. Disable it, and disable this office's fleet
     units on the other candidate hosts too: they have no marker and would call SQL for a purged office
     at their next start. The protected configuration and journal are left for the operator runbook. The
     workbench NAS directory stays (D5).
  5. Rollback: reinstall the previous build. Not for an office that already has
     `office-retirement-request.json` in its journal: an older build would keep asking for the deleted
     VM. Leave that office on the new build.
- **D4** identity retirement: per (node, identity) rows; the login gateway detaches the device from the
  exec host, deletes the volume, confirms; the holdings rule then waits only for unconfirmed rows. It
  also ends identity recoveries requested before the deletion (consent, activation and review do not
  check the deletion in D1).
- **D5** storage and NAS queues, written before the purge, consumed by the artifact GC worker and the
  coding executor.
- **D6** upstream token revoke on delete and on Disconnect.
