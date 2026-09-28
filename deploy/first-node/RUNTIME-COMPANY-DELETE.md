# Deleting a company

Decided by the founder on 28 September 2026 ("option 2"): deleting a company removes everything the
company has, on the nodes too. The company disappears for its member at once; the servers then remove
its machines and node state; the database rows go last.

Only the last member deletes a company (contract, 28 September 2026 "several founders"); everyone
else leaves. Deleting is final: there is no undo window, and no copy of a deleted company's machines is
kept. Usage and computer-hour records stay for bookkeeping, with plain ids (contract §19 item 9).

## The flow

1. **Request** (`qorpera_delete_hosted_profile` → `qorpera_request_company_deletion`, 20260929150000).
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
   - Company Computers power off at their provider's next idle check.
2. **Drain.** Node components remove what the company has on the nodes, each through its own custody.
3. **Finish** (`qorpera_finish_company_deletions`, an operator's pg_cron every minute). For each open
   request it repeats `qorpera_stop_company_work`, reads `qorpera_company_node_holdings`, and runs
   `qorpera_purge_company` (20260929120000) once nothing is held. Its state (`holdings`, `last_error`,
   `purged_at`) is on the request row.

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
| Company Computers | office provider: power off (works), delete and release (D3) | D3 |
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
- **D3** office retirement: retirement rows; after power-off the provider deletes the VM under its
  operation journal, confirms absence, then one SQL call releases the allocation (the triggers release
  the node demand and write the meter's `gone`), drops the node binding and sets the office `retired`.
  Needs a new office provider build. RUNTIME-OFFICE-RETENTION.md is updated with it.
- **D4** identity retirement: per (node, identity) rows; the login gateway detaches the device from the
  exec host, deletes the volume, confirms; the holdings rule then waits only for unconfirmed rows.
- **D5** storage and NAS queues, written before the purge, consumed by the artifact GC worker and the
  coding executor.
- **D6** upstream token revoke on delete and on Disconnect.
