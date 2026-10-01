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
   `qorpera_stop_company_work`, reads `qorpera_company_node_holdings`, revokes the company's connected
   accounts and waits for their upstream revoke (D6, at most six hours), and runs `qorpera_purge_company`
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
| Company Computers | office provider: power off (works), delete and release (D3), then its NAS workbench (D5b) | D3 live since v150; D5b once its provider build is rolled |
| Sign-in identity volumes on the nodes and their exec host devices | LXD provider's login gateway (D4) | D4; live once the LXD provider build is rolled |
| Run recovery volumes (`user.qorpera.profile_id`), identity volumes from before node demands (8 Sep) | operator runbook: a run's recovery volume only once its journal is archived (a day after it settles; the provider still requires it before) | last |
| Company File and folder objects (Storage, NAS) | artifact GC worker, deleted-profile phase (catalog rows outlive the purge) | exists; runs once the worker is deployed (not deployed on 29 Sep) |
| Credential capsules and recovery backups in Storage | artifact GC worker, from `qorpera_company_storage_deletions` (D5a) | D5a; same worker |
| Recovery backups on the recovery service's NAS and journal | operator runbook (a per-company service) | last |
| Coding NAS workspaces `workers/<company>/` | coding executor (D5b) | D5b |
| Connected-account tokens at Google/GitHub | the broker or shared vault that sealed them, from `qorpera_connector_token_revocations` (D6) | D6; live once the broker and vault builds are rolled |
| Model logins (ChatGPT, Claude) | our rows are purged and a node capsule's Storage object goes with D5a; the member signs out at the provider | by design |
| Per-company broker units, recovery services, office host config (older companies), office reset archives, the emptied workbench mount and its NAS export | operator runbook | last |

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
  the retirement, before any other call (the fleet unit goes straight to it). Once the VM is gone and
  before SQL hears, it empties the office's workbench (D5b; "Office retirement" in
  RUNTIME-OFFICE-RETENTION.md): the top-level entries its journal accounts for on the NAS workbench
  mount, after checking that no other instance or mount on the host reaches that export; the mount root
  stays. A large workbench takes several passes (`state: pending`); anything it may not remove holds
  the office for an operator. It writes `office-retired.json` from SQL's receipt; with that marker the
  provider, the fleet unit on that host and the root host guards make no call, and the provider service
  ends. Not covered, and held for an operator: offices whose VM was created but never activated,
  offices mid-reset, an office whose resume (a wake before the deletion) was under way when the
  deletion came (its boot intent or successor stays; the pause keeps it from finishing), and an office
  whose node rebooted between its power-off record and its node-demand suspension.
  Coordinator's lane for D3b (rolled on node 1 at the v150 cut, qorpera-prod-office-a1 f125fae6 →
  a115c550) and, the same way, for the D5b build at the cut that carries it: the coordinator rolls the
  office provider build at the cut (RUNTIME release roll, as #505). No company deletion had been
  requested by 29 Sep. An office retired by the D3b build before the D5b build reaches it keeps its
  workbench (its marker ends the provider). After the D5b roll, list them with `select office_id,
  provider_id, retired_at from public.qorpera_runtime_office_retirements where retired_at <
  '<roll time>'`. For each, find the node and unit whose protected policy names that office
  (`guest.companyComputerId`) and provider; its `workbench.mountPoint` is the mount. Empty it by hand
  as the workbench account (`workbench.uid`), keeping the mount root, with the provider's limits:
  only the names it accounts for ("Office retirement" in RUNTIME-OFFICE-RETENTION.md), nothing that
  `find <mount> -xdev ! -uid <uid>` lists, and only after checking that no other office's mount or
  instance reaches the same export.
  1. Build `node scripts/package-lxd-office-provider.mjs --out <dir>` from the release commit on node 2;
     its sha256 must match the review. Stage it on the node.
  2. Before the roll, read the provider's last observation (`journalctl -u <unit> -n 5`). Roll on
     `active`, `idle` or `power_off`/`powered_off`, and on `unconfirmed` with `power-off host changed`
     (a computer powered off before a node reboot, which the old build cannot replay; the new build
     retires it if its company is being deleted). Wait while it is mid-reset, mid-resume or `pending`;
     a retirement that is `pending` while it empties the workbench may be rolled (the new build carries
     on).
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
  4. Check, at the first deletion of a company with a Company Computer: its office shows
     `phase: retirement` (with the D5b build `state: pending` while it empties the workbench), then
     `state: retired`; `qorpera_runtime_office_retirements.retired_at` is set; LXD lists no instance for
     the office; the node's inventory stays ready (no unmanaged instance); the office's workbench mount
     is empty; `qorpera_company_deletions.holdings` drops the machine and the finisher purges the
     company. A held removal logs `OFFICE_WORKBENCH_<reason>`; `find <mount> -xdev ! -uid <uid>` finds
     a foreign entry. Once an operator removes what holds it, the provider carries on by itself.
  5. A retired office's unit exits 0 and stays stopped. Disable it, and disable this office's fleet
     units on the other candidate hosts too: they have no marker and would call SQL for a purged office
     at their next start. The protected configuration and journal, the emptied workbench mount
     and its NAS export are left for the operator runbook.
  6. Rollback: put the `.retired-<sha12>` file back and restart. Not for an office that already has
     `office-retirement-request.json` in its journal: an older build would keep asking for the deleted
     VM (and would retire it without emptying the workbench). Leave that office on the new build.
- **D4** sign-in identity retirement (migration 20260928269450; `lxd-login-gateway.ts`). A node-held
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
  with the purge and their Storage backups are D5a.
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
- **D5a** Storage (migration 20260928269480). Company File and folder objects need nothing new: their
  catalog rows have no link to the company, and the worker's deleted-profile phase removes them once
  the company is gone. Credential capsules (`qorpera-native-compute-capsules/<capsule>.capsule`, named
  only by the capsule) and the identity recovery prefix (`qorpera-identity-recovery/<company>/`) have
  no such record: the finisher writes them into `qorpera_company_storage_deletions` right before the
  purge, in the same step, so a purge never happens without the record. The artifact GC worker claims
  up to 100 entries a run (`qorpera_claim_company_storage_deletions`, entries that keep failing last),
  removes each through the Storage API (SQL cannot), empties the recovery prefix in rounds, and
  completes each (`qorpera_complete_company_storage_deletion`); a failure is recorded and the entry
  offered again. A name under the recovery prefix that is not a recovery object (or a folder) stops
  that prefix before anything more is removed; the entry then keeps failing (`last_error`) until an
  operator looks. A capsule is recorded only when its reference names its own id. A vault sign-in has
  no Storage object. The worker is not deployed (coordinator, 29 Sep): until it is, nothing of a
  deleted company's Storage is removed.
  Not covered, for the operator: companies deleted before this migration by the old direct delete or
  by the finisher, and capsule objects whose sign-in failed after the upload (no row names them). A
  one-off sweep removes `<uuid>.capsule` objects older than a day that no capsule row names as
  `native-capsule/<uuid>` (a sign-in uploads its capsule before its row commits), and recovery folders
  of companies that no longer exist.
  Switching the worker on (supabase/ARTIFACT-GC.md "Deployment"; the coordinator bundles it with the
  other function deploys once Jonas has created the worker key):
  1. Apply the migrations, including 20260928269480.
  2. Deploy `supabase/functions/artifact-gc-worker` with JWT verification off (`config.toml`).
  3. Edge Function secrets: `QORPERA_ARTIFACT_GC_WORKER_KEY` (a new random invocation key, kept only
     there and in Vault), and for NAS-backed Company File objects `QORPERA_OBJECT_GATEWAY_URL` and
     `QORPERA_OBJECT_GATEWAY_CONTROL_TOKEN`. `SUPABASE_URL` and the function's Supabase service
     credential come from the platform (`SUPABASE_SECRET_KEYS`, else `SUPABASE_SERVICE_ROLE_KEY`), or
     `QORPERA_ARTIFACT_GC_SERVICE_KEY` if set.
  4. Vault secrets for the schedule: `qorpera_project_url` and `qorpera_artifact_gc_worker_key` (the same
     invocation key). The schedule posts with pg_net.
  5. The worker has no dry run: its first run already removes the objects of every deleted company in
     the catalog and the D5a entries. Check the counts first (ARTIFACT-GC.md "Monitoring and
     recovery": deleted companies' catalog objects and open D5a entries), run it once by hand, then
     schedule it every five minutes (`qorpera-artifact-gc-worker`, the `cron.schedule` in
     ARTIFACT-GC.md).
- **D5b** NAS: the Company Computer workbench, emptied by the office provider as the last step of its
  retirement (D3b above; "Office retirement" in RUNTIME-OFFICE-RETENTION.md), and coding workspaces
  `workers/<company>/` (the coding executor cannot remove them alone: their files belong to session
  users; not built yet).
- **ChatGPT plan logins** (Sign in with ChatGPT slice 1c, migration 20260929960000; built switched off with
  the login kind). Each finisher pass revokes the connections of the company's members' plan logins, as for
  a member who left. A connection that still pays a queued or leased job waits for a later pass: the stop
  skipped that job because a run host holds it (job before fence), and revoking now would wait for the job
  under the fence (test 773). The vault's upkeep then ends each login at OpenAI and marks it revoked
  (`qorpera_take_chatgpt_plan_revocation`, `qorpera_finish_chatgpt_plan_revocation`; the company's broker
  authority stays active until the purge). The finisher counts the open plan logins as
  `holdings.chatgpt_plan_logins` and waits for them, at most six hours after the deletion request; a login
  still open then is deleted with the company, and its refresh token lapses at OpenAI within 30 days.
  - The purging pass counts such logins in the database log: search the Postgres logs for
    `ChatGPT plan login(s) not ended at OpenAI before the purge` (the line names the company). The member can
    also remove Qorpera's access in their ChatGPT settings.
  - A plan sign-in can complete for a company being deleted until slice 1b (#614, migration 20260929950000)
    is live; the next pass revokes it again. The platform switch waits for #614 (RUNTIME-LOGIN-VAULT.md).
- **D6** upstream token revoke on Disconnect and on delete (migration 20260928269500;
  `cloud-connector-token-revocation.ts`). Until now Disconnect only marked the secret revoked, and a
  deleted company's tokens stayed live at Google and GitHub (GitHub's never expire).
  - Each time a Gmail, Drive or GitHub secret goes from active to revoked (Disconnect, a member's
    removal, a company's deletion), a trigger queues each stored version in
    `qorpera_connector_token_revocations`. The ledger has no link to the company and never holds a
    token or an account name, so its rows outlive the purge as receipts.
  - Deleting a company: each finisher pass revokes the company's connector secrets and their grants
    (secrets locked in id order; a connection captured late goes too), counts the open entries as
    `holdings.connector_tokens` and waits for them. Each entry gets six hours from the later of the
    deletion request and its own queueing; then the finisher marks what is still open `abandoned` right
    before the purge, which deletes the envelopes. A member's Disconnect racing a deleting company's
    finisher can deadlock; Postgres ends one of them and the finisher retries at its next pass.
  - The broker that sealed a version claims it once a minute (a company's own broker, or the shared
    vault for each company it serves; `qorpera_claim_connector_token_revocations`, leased five
    minutes, entries that keep failing last), opens the envelope, cancels the token and records the
    outcome (`qorpera_complete_connector_token_revocation`). An error is recorded as a fixed phrase and
    the entry is offered again after one minute, doubling to an hour. Google: `POST /revoke` with the
    refresh token in the form body; 200 `revoked`, 400 `invalid_token` `already_invalid`. GitHub (our
    one OAuth App): `DELETE /applications/{client_id}/token`, which revokes that one token and never
    the user's whole grant; 204 `revoked`; any other answer is checked with GitHub's token check
    (`POST` to the same path), where 404 means `already_invalid` (to confirm at the first real
    revoke). GitHub may also answer 404 when the client credentials are wrong, so a unit with a wrong
    GitHub client secret would record live tokens as `already_invalid` (lane step 2 checks it). A typed
    personal token (`ghp_`, `github_pat_`) is `not_ours`; a `gho_` token of another OAuth app comes out
    `already_invalid`.
  - Google withdraws the account's whole grant to our client on any revoke. By Jonas's option A
    (29 Sep), an entry whose Google account is still connected (an active Gmail or Drive secret with
    the same account name, in any company not being deleted, this one included) completes as
    `kept_shared` without a call; so does one with no account name. Only a Google secret's current
    version is revoked: its account name is the only one known (a reconnect may have changed the
    account), and the revoke withdraws the older tokens of that account too; older versions complete
    as `superseded`. A disconnected Google entry is due ten minutes after the Disconnect, so a quick
    reconnect of the same account counts as still connected. Our copy is revoked either way.
  - Not covered, for the member or the operator:
    - revoked by the member at the provider: a Google account kept connected elsewhere
      (`kept_shared`), a Google connection with no account name, the older tokens of another account
      that a reconnect replaced (`superseded`), and typed GitHub tokens (`not_ours`);
    - a current Google version whose account name is stale (a reconnect whose identity lookup failed
      keeps the old name) is judged by that name, and so could withdraw another company's grant of
      the new account;
    - a reconnect of the same Google account whose consent lands between the claim and the revoke
      call (after the ten minutes) loses its new grant; the member connects again;
    - connections disconnected before this migration are not queued (no backfill);
    - the GitHub revoke uses the unit's current client credentials: a rotated or wrong secret fails
      those entries or records them `already_invalid`; an entry whose broker was retired is never
      claimed (a deletion abandons it at six hours).
  Coordinator's lane for D6, at the cut that carries 20260928269500:
  1. Build `node scripts/package-cloud-secret-broker.mjs` from the release commit and roll it, within
     six hours of the cut (before it is fine: without the migration a pass logs one line and does
     nothing), to the shared vault (node 1 and node 2's standby) and to every company broker unit
     still running. Each unit needs its `qorpera-cloud-secret-connectors` credential with the GitHub
     client, or its GitHub entries fail with "the GitHub client is not configured". Until a unit runs
     the new build, its companies' entries wait, and a deletion purges after six hours with them
     `abandoned`.
  2. Check: `journalctl -u <unit>` shows `Connector token revocation: N completed` after a deletion or
     Disconnect with a connected account, and `select outcome, count(*) from
     public.qorpera_connector_token_revocations group by 1` has no entry left open for long. On each
     unit, connect and then disconnect a throwaway GitHub account: its entry must complete `revoked`
     (a wrong client secret shows as `already_invalid`). Where no member session in that unit's
     company is at hand, compare the unit's GitHub client credentials with the shared vault's. At the
     first revoke of a token GitHub no longer knows, confirm it completes as `already_invalid`.
  3. After a company with its own broker unit is purged, retire the unit and delete its keyring
     (operator runbook, "Per-company broker units").
