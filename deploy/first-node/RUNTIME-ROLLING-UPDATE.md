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
checks that statement. A release **rolls** when every migration in it is safe for runs of the
previous bundle, which keep running on the other node for up to the longest run (14 min last week).
That covers:

- New tables, columns, functions and indexes. A new index on a busy table uses
  `create index concurrently` in its own migration, or the release pauses.
- A function body replaced under the same signature, where callers from the previous bundle's host
  send the same inputs and get the same output shape.
- Control-plane patches: placement, claim, admission, deferral, wake policy, the web RPCs.
- The activation migration itself, which is the switch in step 6 below.

A release **pauses** when any migration:

- drops or renames a table, column or function the previous bundle's host calls, or changes a
  signature or JSON shape it sends or receives. The run context `…/v1` → `…/v2` switch of
  2026-09-20 is the example.
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

## Procedure (coordinator)

Node A is the node that is emptier: fewer awake machines, and not the only fast host during a busy
hour. N is the running bundle and N+1 the new one. The observer, provider and fast host steps are
the same ones today's cut runs, one node at a time.

1. **Preflight** (read-only):
   - both nodes are `serving` and `ready`;
   - the release is staged on both nodes;
   - no orchestrator declares a bundle (`runtime_bundle_sha256` all null);
   - `qorpera_runtime_bundle_roll_status()` shows only N;
   - every active login is in the vault: no active run capsule still needs a node key.

   ```sql
   select c.compute_identity_id from public.qorpera_native_credential_capsules c
   where c.status = 'active' and not public.qorpera_compute_identity_login_in_vault(c.compute_identity_id);
   ```

   This must return no rows. Such a login ties its member's runs to one node.

   Save the **ids** of N's pending inputs as the baseline. Counts can hide a live input behind a
   dead one.

   ```sql
   select id, session_id, created_at from public.qorpera_session_inputs
   where completed_at is null and failed_at is null and execution_run_id is null and turn_id is null
     and runtime_bundle_sha256 = '<N sha>';
   ```
2. **Migrations.** Apply the release's migrations, not the activation. Dry run first, then commit.
3. **Declare node B as N.** Declare every active orchestrator on node B as N
   (`qorpera_declare_runner_orchestrator_bundle`), so B keeps taking N runs and never an N+1 run.
4. **Empty node A.**
   - `qorpera_set_runtime_node_serving(A, false, <version>, 'roll vN+1')`.
   - Wait until `qorpera_runtime_node_drain_status(A)` shows `readyForUpdate`. Runs usually end
     within a minute; long ones take up to 14 minutes. Waiting is fine: node B serves meanwhile.
   - Clear A's parked warm hosts, as today's cut script does before the fast host rebuild.
5. **Update node A.**
   - `agent apply N+1`. A is quiet, so no role needs `--defer`.
   - Roll the office provider and coding executor if the release changes them. Machines already
     running there keep running (decision 4) and take new guest software at their next start.
   - Rebuild the fast host, then declare its orchestrator N+1 by hand
     (`qorpera_declare_runner_orchestrator_bundle`). Change 5's rebuild script does this itself with
     `EXEC_RUNTIME_BUNDLE_SHA256=<N+1>` once it is merged. The rebuild's re-registration clears any
     older declaration.
   - Re-enrol A's inventory digest if the policy still pins the fast host's image (change 6
     removes that step).
   - Declare **every** active orchestrator on A as N+1, including the fresh-VM path.
   - Start A's orchestrators while A is still switched off: they report heartbeats but claim
     nothing. Then `qorpera_runtime_bundle_roll_status()` must show `undeclared = []`. That list
     ignores heartbeats, so a rebuilt host left stopped still shows.
6. **Switch.**
   - Return A: `qorpera_set_runtime_node_serving(A, true, …)`.
   - Apply the activation migration. New inputs and runs bind to N+1, and only A takes them.
   - Renew packaged offices' packages for N+1, as today's cut does.

   Check that one new run completes on A.
7. **Let node B finish N.** Watch `qorpera_runtime_bundle_roll_status()` until N has 0 queued and
   0 running runs. Then compare N's pending input ids with the baseline: any id not in the
   baseline, or any baseline input that can still run, is live N work.
   - Inputs accepted before the switch run on N, on B.
   - A sponsorship request approved later, or a retried run, also stays on N.

   Decide each remaining input as today's "unclaimed input" check does. Never relabel one.
8. **Empty and update node B** as in steps 4–5 with N+1. B's fast-host rebuild clears B's
   declarations, so declare all of B's orchestrators as N+1 before returning it.
9. **Finish.**
   - Clear every declaration (`… , null`).
   - Check that `qorpera_runtime_bundle_roll_status()` shows only N+1 and `undeclaredLive` holds
     the live orchestrators of both nodes.
   - Check that both nodes serve.
   - Run acceptance, then `agent gc`.

## If something goes wrong

- **Node A fails its checks in step 5.** A stays empty. Roll it back (`agent rollback`, and
  rebuild the fast host from N), declare A's orchestrators as N, and return A. Clear the
  declarations once both nodes run N. The switch never happened, and B served throughout.
- **N+1 misbehaves after the switch.** There is no rolling way back once N+1 is active. An
  activation accepts only the exact previous bundle as its predecessor, and the node agent's
  rollback after an activation runs under a pause. So:
  1. Pause as today's cut does, with a new activation of N that names N+1 as its predecessor,
     prepared with the release.
  2. Roll node A back to N (`agent rollback`, fast host rebuilt from N) and clear all
     declarations.
  3. Resume.

  Runs already bound to N+1 fail with their reason. Do **not** declare A as N while A still runs
  N+1: A would take N runs and refuse them.
- **N work stuck in step 7** (an input that can never run, or a session held on a sponsorship):
  treat it as today's "unclaimed input" check against the baseline ids. Do not relabel it.

## What members notice

- No pause. For the roll (about 10–20 minutes) the fast capacity is one node's.
- A conversation that was warm on the node being emptied starts cold once.
- Open computers and coding sessions keep running.
