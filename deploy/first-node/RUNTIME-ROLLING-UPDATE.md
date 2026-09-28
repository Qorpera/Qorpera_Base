# Rolling updates (identical nodes, change 7)

Design page: "Identical Nodes" (https://claude.ai/artifact/8Gm5z4Jym3fpLWpeXe4t9Y), step 4.
Technical background: `RUNTIME-IDENTICAL-NODES.md`. Today every cut pauses all companies for 1–3
minutes, because both nodes change together. A rolling update instead empties one node, updates it,
switches new work to the new bundle, then empties and updates the other node. A run always starts
and ends on one bundle.

## Prerequisites

| Needed | Why |
|---|---|
| Identical nodes change 1 (`20260928180000`) | The serving switch and `qorpera_runtime_node_drain_status` |
| Identical nodes change 4 (`20260928182000`) | Orchestrator bundle declarations and `qorpera_runtime_bundle_roll_status` |
| Logins in the vault change 3 (`20260928180600`), and **every active login moved into the vault** | Member runs are no longer pinned to the node holding the login's disk. A login still on a node disk ties its runs to that node: while that node is empty or on the other bundle, they cannot run. |
| Identical nodes changes 3 and 5 | A fast host on both nodes, and runs placed on either node, with fast hosts declared for another bundle left out of the placement |

Until all of these are live, cuts keep today's paused procedure.

## Does a release roll or pause?

Every release PR states `Rollout: rolls` or `Rollout: pauses — <reason>`. The exact-head review
checks that statement.

A release **rolls** when both of these hold:

- Every migration in it is safe for every N component that stays live on the other node while the
  first node is updated. On that node these keep running N code against the new schema:
  - the run host, for runs of N: from step 2 until that node has drained, which includes N runs
    created after the switch from earlier inputs or retries, not only the longest run (14 min last
    week);
  - the orchestrators' claim loop;
  - the office provider and the coding executor;
  - the node observer and the login gateway.
- Every service both nodes share works with both bundles. The secret broker, the object gateway,
  the web API and the edge functions (such as `runner-orchestrator`) serve both nodes at once, so
  they cannot be updated one node at a time. A release that changes one of them is deployed at
  step 2 only if the new version works with both bundles; otherwise the release pauses.
- Its node release's `order` is `schema-first` or `either`: the migrations come before node A's
  update. With `pause`, `agent apply` insists on `--defer`.

That covers:

- New tables, columns, functions and indexes. A new index on a busy table uses
  `create index concurrently` in its own migration, or the release pauses.
- A function body replaced under the same signature, where every N caller sends the same inputs and
  gets the same output shape.
- Control-plane patches: placement, claim, admission, deferral, wake policy, the web RPCs. They must
  keep the guards the roll relies on; step 2 checks them.
- The activation migration itself, which is the switch in step 6.

A release **pauses** when any migration:

- drops or renames a table, column or function an N component calls, or changes a signature or JSON
  shape it sends or receives. Examples: the run context `…/v1` → `…/v2` switch of 2026-09-20; v142's
  stricter inventory check, which an N observer on the other node would have failed, taking that
  node out while it was the only one serving.
- changes what a shared service accepts or sends in a way one of the two bundles cannot handle, for
  example a new operation name the secret broker checks, unless the service accepts both;
- changes lock order on busy tables, or takes long table locks. The storage core does this; it
  ships alone with a 30-minute database watch.
- rewrites or relabels company data in bulk (the clean reset).

When unsure, the release pauses.

Two things that are **not** reasons to pause:
- **Packaged offices.** A packaged office checks its package's bundle against the active bundle on
  every start, reset and install. At every switch, rolling or paused, the package is renewed for
  the new bundle right after activation, as today's cut does. Until then such an office cannot
  start or reset; running offices are not affected.
- **The model policy.** A run reads its own bundle's policy; only a conversation's displayed
  defaults follow the active bundle.

## Why the updated node stays off until the activation

An orchestrator can be declared only for a registered bundle, and the activation migration
registers N+1 and makes it active in one step. So node A cannot be declared N+1 before the
activation. Returning A undeclared would be worse: its N+1 hosts would take N runs and refuse them.
A therefore stays switched off from step 4 until right after the activation (step 6). New messages
sent in that short gap wait for A; work already running is not touched.

## Procedure (coordinator)

Node A is the node that is emptier: fewer awake machines, and not the only fast host during a busy
hour. N is the running bundle and N+1 the new one; R+1 is the node release that carries N+1. The
observer, provider and fast host steps are the same ones today's cut runs, one node at a time.
Run the SQL as `postgres` with service-role claims (`request.jwt.claims` with role
`service_role`), not under the `service_role` role itself: `qorpera_runtime_orchestrator_nodes` refuses
that role.

Never run `qorpera_configure_runtime_node` on a switched-off node during a roll: its policy sets
`enabled` again, which returns the node before it is declared.

1. **Preflight** (read-only):
   - both nodes are `serving` and `ready`;
   - release R+1 is staged on both nodes (`agent stage`);
   - the release's migrations, the activation and the reverse activation (see "If something goes
     wrong") were rehearsed on a copy of the production schema;
   - every active orchestrator maps to exactly one node. An orchestrator with no node is not
     stopped by emptying, and one with two nodes keeps `readyForUpdate` false. Enrol or revoke such
     an orchestrator first.

     ```sql
     select o.id, o.provider_adapter, array_agg(n.node_id) nodes
     from public.qorpera_runner_orchestrators o
     left join lateral public.qorpera_runtime_orchestrator_nodes(o.provider_adapter) n on true
     where o.status <> 'revoked'
     group by o.id, o.provider_adapter
     having count(n.node_id) <> 1;
     ```
   - no unfinished signed-updater target, because the serving switch refuses on such a node:

     ```sql
     select node_id, revision from public.qorpera_node_update_targets where resumed_version is null;
     ```
   - no orchestrator declares a bundle (`runtime_bundle_sha256` all null);
   - `qorpera_runtime_bundle_roll_status()` shows no bundle other than N with queued or running
     runs;
   - every active login is in the vault: no active run capsule still needs a node key.

     ```sql
     select c.compute_identity_id from public.qorpera_native_credential_capsules c
     where c.status = 'active' and not public.qorpera_compute_identity_login_in_vault(c.compute_identity_id);
     ```

   Each of these queries must return no rows. Then save the **ids** of N's pending inputs as the
   baseline. Counts can hide a live input behind a dead one.

   ```sql
   select id, session_id, created_at from public.qorpera_session_inputs
   where completed_at is null and failed_at is null and execution_run_id is null and turn_id is null
     and runtime_bundle_sha256 = '<N sha>';
   ```
2. **Migrations.** Apply the release's migrations, not the activation.
   - Deploy the release's changed edge functions and other shared services now, and only if they
     work with both bundles (see "Does a release roll or pause?").
   - A migration that runs in a transaction: dry run first, then commit.
   - A `create index concurrently` migration cannot run in a transaction: apply it on its own, as
     rehearsed, and record it in the migration history as today's cut does.

   Then check that the guards the roll relies on are still live. A release that re-creates the
   claim or the placement without them must pause instead.

   ```sql
   select g.marker, position(g.marker in g.def) > 0 as present from (values
     ('qorpera_runtime_orchestrator_nodes(v_adapter)',
       pg_get_functiondef('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure)),
     ('declared.runtime_bundle_sha256',
       pg_get_functiondef('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure)),
     ('qorpera_runtime_claim_turn(p_orchestrator_id, job, run)',
       pg_get_functiondef('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure)),
     ('orchestrator.runtime_bundle_sha256 = p_run.runtime_bundle_sha256',
       pg_get_functiondef('public.qorpera_runtime_run_placement(public.qorpera_runner_jobs,public.qorpera_execution_runs)'::regprocedure))
   ) g(marker, def);
   ```

   Every row must say `present`.
3. **Declare node B as N.** Declare every active orchestrator on node B as N, so B keeps taking N
   runs and never an N+1 run:

   ```sql
   select public.qorpera_declare_runner_orchestrator_bundle(o.id, '<N sha>')
   from public.qorpera_runner_orchestrators o
   join lateral public.qorpera_runtime_orchestrator_nodes(o.provider_adapter) n on true
   where o.status = 'active' and n.node_id = '<B>';
   ```
4. **Empty node A.**
   - `qorpera_set_runtime_node_serving(A, false, <version>, 'roll vN+1')`.
   - Wait until `qorpera_runtime_node_drain_status(A)` shows `readyForUpdate`. Runs usually end
     within a minute; long ones take up to 14 minutes. Waiting is fine: node B serves meanwhile.
   - Clear A's parked warm hosts, as today's cut script does before the fast host rebuild.
5. **Update node A.** A stays switched off.
   - `agent apply <R+1>`. A is quiet, so no role needs `--defer`.
   - Roll the office provider and coding executor if the release changes them. Machines already
     running there keep running and take new guest software at their next start.
   - Rebuild the fast host **without** `EXEC_RUNTIME_BUNDLE_SHA256`: N+1 is not registered yet.
     The rebuild's re-registration clears any older declaration and keeps the host's dispatch role
     (change 3).
   - Re-enrol A's inventory digest if the policy still pins the fast host's image (with the fast
     host listed by role, change 6, this step goes away).
   - Start A's orchestrators. While A is switched off they report heartbeats but claim nothing.
6. **Switch.** The activation cannot be undone without a pause, so check first, then do the rest
   right after each other; new messages wait for A in between.
   0. Before the activation, all of these must hold:
      - every active orchestrator on B is still declared N (the query of step 6.3 for B and N
        returns no rows);
      - `qorpera_runtime_bundle_roll_status()`'s `undeclared` lists only A's orchestrators, so no
        orchestrator registered since step 1 on neither node can take N+1 runs on N code;
      - every active orchestrator on A runs. This must return no rows; revoke a stale row that
        belongs to no running host rather than wait for it:

        ```sql
        select o.id, o.last_heartbeat_at from public.qorpera_runner_orchestrators o
        join lateral public.qorpera_runtime_orchestrator_nodes(o.provider_adapter) n on true
        where o.status = 'active' and n.node_id = '<A>'
          and o.last_heartbeat_at < statement_timestamp() - interval '30 seconds';
        ```
      - A's observer publishes `ready` for A under A's current policy, fresh enough for placement,
        so A's run machines, sign-ins and machine wakes are admitted once it returns. This must
        return `true`:

        ```sql
        select o.observation->>'state' = 'ready'
          and o.observed_at > statement_timestamp() - interval '60 seconds'
          and public.qorpera_runtime_node_inventory_ready(n.id, o.observation_id, n.version)
        from public.qorpera_runtime_nodes n
        join public.qorpera_runtime_node_observations o on o.node_id = n.id
        where n.id = '<A>';
        ```

      If one fails, fix it first. A stays off and B serves N meanwhile.
   1. Apply the activation migration with A still switched off, and record it in the migration
      history as today's cut does. New inputs and runs bind to N+1. Nobody claims them yet: B is
      declared N, and A is off.
   2. Declare every active orchestrator on A as N+1 (the query of step 3, with A and N+1).
   3. Gate: `qorpera_runtime_bundle_roll_status()` shows `undeclared = []`, and no active
      orchestrator on A is declared anything but N+1:

      ```sql
      select o.id, o.runtime_bundle_sha256 from public.qorpera_runner_orchestrators o
      join lateral public.qorpera_runtime_orchestrator_nodes(o.provider_adapter) n on true
      where o.status = 'active' and n.node_id = '<A>'
        and o.runtime_bundle_sha256 is distinct from '<N+1 sha>';
      ```

      It must return no rows. (The `undeclared` list ignores heartbeats, so a rebuilt host whose
      orchestrator was never declared still shows there.)
   4. Return A: `qorpera_set_runtime_node_serving(A, true, …)`. It takes the waiting N+1 runs.
   5. Renew packaged offices' packages for N+1, as today's cut does.

   Check that one new run completes on A.
7. **Let node B finish N.** Watch `qorpera_runtime_bundle_roll_status()` until N has 0 queued and
   0 running runs. Then compare N's pending input ids with the baseline. Every N input that is not
   in the baseline is live N work. A baseline input was already pending before the roll; it is live
   too if its conversation gets a new N run while B still serves N. For example:
   - inputs accepted before the switch run on N, on B;
   - a sponsorship request approved later, or a retried run, also stays on N.

   B still serves N, so let such work run there. Never relabel an input's bundle.
8. **Empty and update node B.**
   - Empty B as in step 4 and wait for `readyForUpdate`.
   - Check N once more: no queued or running N run, and no N pending input outside the baseline.
     If there is one, return B (it still runs N), let it finish, and empty B again. N work that
     appears after B is updated has no N host left: it waits until step 9 clears the declarations,
     then an N+1 host claims it and it fails with `bundle-compatibility`, as it would in a paused
     cut. The member sees the failed run and sends again.
   - Update B as in step 5, except that N+1 is registered now: rebuild B's fast host with
     `EXEC_RUNTIME_BUNDLE_SHA256=<N+1>` (the script declares it as its last step).
   - Declare B's other orchestrators as N+1. `agent apply` does not clear their N declaration from
     step 3; only a re-registration does.
   - Gate: the query of step 6.3 for B returns no rows, and N's `declaredBy` in the roll status is
     empty.
   - Return B.
9. **Finish.**
   - Clear every declaration (`… , null`).
   - Check `qorpera_runtime_bundle_roll_status()`: no bundle other than N+1 has queued or running
     runs, every pending input of another bundle is in the baseline, and `undeclaredLive` holds the
     live orchestrators of both nodes.
   - Check that both nodes serve.
   - Run acceptance, then `agent gc`.

## If something goes wrong

- **Node A fails its checks in step 5** (before the activation). A stays empty. Roll it back
  (`agent rollback`, and rebuild the fast host from N), declare A's orchestrators as N (N is
  registered), and return A. Clear the declarations once both nodes run N. The switch never
  happened, and B served throughout.
- **A does not come back after the activation** (a declaration or the return fails). New messages
  wait for A; B keeps serving N and cannot take N+1 work. Fix the step and return A. If that cannot
  be done within minutes, roll back as below.
- **N+1 misbehaves after the switch.** There is no rolling way back once N+1 is active. The node
  agent's rollback after an activation runs under a pause. So:
  1. Pause as today's cut does.
  2. Apply the reverse activation. It is written by hand with the release, not generated: the
     generator's activation always inserts a new bundle row, and N's row already exists
     (`unique (bundle_key, version)`, and the table is immutable). The reverse activation checks
     that exactly N+1 is active, then moves the active pointer back to the existing N row. Rehearse
     it on a test database with the release (step 1).
  3. Move **every** node that runs N+1 back to N (`agent rollback`, fast host rebuilt from N), node B
     too if step 8 has started, and clear all declarations. Never declare a node as N while it still
     runs N+1: it would take N runs and refuse them.
  4. Renew packaged offices' packages for N again; offices renewed for N+1 cannot start or reset
     under N.
  5. Resume.

  Runs and pending inputs already bound to N+1 fail with their reason.
- **N work left over** (an input that can never run, or a session held on a sponsorship): see steps
  7 and 8. Never relabel it.

## What members notice

- No pause for work that is running. For the roll (about 10–20 minutes) the fast capacity is one
  node's.
- New messages sent between the activation and A's return (step 6) wait that long, usually
  seconds.
- A conversation that was warm on the node being emptied starts cold once.
- While a node is emptying (change 1): a sleeping computer or coding machine there cannot wake, new
  coding turns for members whose machine is there wait, and sign-ins already routed there wait,
  until the node returns.
- Open computers and coding sessions keep running.
