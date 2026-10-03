# Company creation on the folder core (C2-create, P14)

Status: design, 3 October 2026 (F2, the coordinator's slice P14). The core's §5 "Company creation is one commit" and
§11 C2 say what; this says how. It fills the four stubs the founding lobby left for C2
(`20260928248200_company_founding_lobby.sql`): `qorpera_folder_company_open`, `_seed`, `_ready` and, for C5 only,
`qorpera_company_founding_available`.

In short:
- **Open** makes the company row, its environment and its owner, already on `folder-v2`: no seeded tree yet.
- **Start** records a creation request with the founders' vision and roles.
- **A creation worker** in the object gateway builds the seeded tree (`companyStateSeedTree`), stores its files as the
  platform, and then makes **one transaction**: the creation commit, the Co-Founder (staff row, thread, cofounders
  row), and the Co-Founder's silent first run.
- **Ready** is that transaction having landed. Until then the company is hidden.
- `qorpera_company_founding_available()` stays false. C5 turns creation on (P39). Before that, only an operator
  makes a `folder-v2` company, through the same path (§6).

## 1. What exists (master 186cd8646)

- **The stubs** raise `0A000` or return false. They are revoked even from the service role.
- **The lobby's callers:**
  - `qorpera_open_company_founding` calls `open` as the signed-in member, with no lock held, and reads
    `profile_id`.
  - `qorpera_start_company_founding` calls `seed` inside its own transaction, with the input
    `qorpera.company-seed-input/v1`: `companyName`, `vision`, `kickoffRequestedBy` (the member who pressed Start) and
    `founders` (`userId`, `displayName`, `role`). Start then nulls the vision and the roles, so the input is their only
    copy.
  - With C1c-3d-1 (#705), Start holds the folder fence and the company row `FOR NO KEY UPDATE` at that point.
- **The web reads `companyReady`** (from `_ready`) and polls until it is true. Then it expects the company in
  `qorpera_list_hosted_profiles`.
- **Today's creation (`snapshot-v1`):**
  - The request does the profile, the environment (whose trigger makes the Company File row), the Co-Founder and a
    bootstrap job.
  - The object gateway's `CompanyBootstrapProvisioner` stages the files and finalizes. Finalize writes the silent
    `kickoff` input in the Co-Founder's thread, `qorpera_company_first_runs` and `qorpera_agent_first_runs`, and
    `qorpera_queue_agent_first_run`'s turn request.
  - The `first-run` wake row appears only when the turn materializer makes the run (`qorpera_admit_input_wake`).
- **The traps** (registry, #444):
  - Running the old chain beside C2 makes two Co-Founders and two first runs.
  - Enabling the folder core after a bootstrap job is queued leaves the company hidden for good.
  - Claim, finalize and Co-Founder seeding already refuse `folder-v2`. Not yet guarded:
    `qorpera_enqueue_company_bootstrap`, and `qorpera_folder_enable` with a queued job.
- **Bytes:**
  - A commit unit only references stored bytes (a version-2 proof and catalog rows). SQL cannot store the bytes.
  - The platform can stage through `qorpera_folder_open_upload` / `_confirm_object` / `_seal_upload` (service role;
    the platform needs no possession).
  - The object gateway's folder route serves runs only. Its bootstrap worker is the model for a platform writer.
- **The commit's platform branch** takes no fence and has no step 10 (no wake).
- **Delivery:** nothing delivers a `folder-v2` run until C4 (P28). The materializers skip `folder-v2`.

## 2. The flow

1. **Open** (`qorpera_folder_company_open(user, clientCreationId, name)`, security definer, called by the lobby):
   - Repeat-safe on `qorpera_company_creation_requests` (user, creation id): a repeat returns the same company. A
     creation id the old path already used refuses (`23505`), as the lobby already does for a company with a bootstrap
     job.
   - It makes the profile, the owner member and the environment (contract version 2). The provision trigger makes the
     `snapshot-v1` `provisioning` file row as today.
   - In the same transaction it switches that row to `folder-v2`, through the enable step's own internal body (clock,
     fence, admission, the root and `rules/` resources), because `qorpera_folder_enable` itself is service-role only.
   - No staff, no thread, no seed, no wake. It returns `{profile_id, environment_id}`.
   - Vault By Default registers the company for sign-in on its own.
2. **Start** (`qorpera_folder_company_seed(profile, input)`, called inside Start):
   - It only records the request: a row in a new table `qorpera_folder_company_creations`, one per company, with
     `state = 'queued'` and the input.
   - A repeated Start finds the row and returns its id.
   - Nothing else, so Start's locks stay as #705 made them (the insert's foreign key to the company row is compatible
     with the `FOR NO KEY UPDATE` Start holds).
3. **The creation worker** (object gateway, beside the bootstrap provisioner):
   - claims a queued creation with a lease (`qorpera_folder_company_creation_claim`);
   - builds `companyStateSeedTree({companyName, cofounderId, vision, founders, firstTodo})`, with the ids derived from
     the creation's id, so a retry builds the same tree;
   - parses each structured file with the shared parser;
   - stages every file as the platform: open, a NAS put of what is missing, confirm, seal;
   - calls `qorpera_folder_company_create` once (§3).
   - On a staging error it releases the lease and retries later. A creation that the commit refuses is marked
     `failed` with the reason, and is never retried blindly.
4. **Ready** (`qorpera_folder_company_ready(profile)`) is `state = 'completed'`. A plain `stable` read.

## 3. The creation transaction (`qorpera_folder_company_create`, service role)

One transaction, in the core's lock order:
1. **The creation row `FOR UPDATE`**, its lease checked (it sits where a run's job sits, before the fence). A
   completed creation answers its stored result: a replay.
2. **The fence `KEY SHARE`, then the pause read again.** A paused company refuses (`55000`), and the worker retries
   later. The platform branch of the commit takes no fence, so the creation takes it here. Member management (joins,
   leaving, role changes) holds the fence `FOR NO KEY UPDATE`, so a join waits until the Co-Founder's thread exists,
   and then the join's own trigger adds the member to it.
3. **The commit:** the transaction-local setting `qorpera.folder_company_create` carries the creation (environment,
   creation id, operation key), as F2-5b's worker request does. Then `qorpera_folder_commit(environment,
   platform, 'company-create:<id>', units)` runs, with these units:
   - `mkdir vision`, `write vision/vision.md`;
   - `mkdir agents`, `write agents/sections.md`;
   - `new_folder agents/co-founder` (`agent.md`, `memory/`, `todos/` with the first todo, `routines/`);
   - `mkdir` for each other seeded folder (`agents/groups`, `connections`, `rules`, `skills`, `skills/human-task`
     with `SKILL.md`, `human-tasks`, `contacts`).

   `interfaces/` and `tables/` join with P16. The hook's existing rules apply: only the platform records the
   Co-Founder (`qorpera_company_cofounders`, formation null); `vision_seeded` is true.
4. **The first run, in apply, for the Co-Founder's `agent.md` when the setting is there.** After the staff row and its
   thread exist (the staff-insert triggers, as for a hire):
   - the silent `kickoff` input in the Co-Founder's thread, authored by `kickoffRequestedBy`, with the assignment
     `{schema: 'qorpera.company-first-run/v1', assignment: {kind: 'company_founding', companyId,
     cofounderStaffAgentId, firstTodo: <its path>}}`;
   - `qorpera_agent_first_runs` (the `agent.md` version as `source_path_version`);
   - the turn request, through `qorpera_queue_agent_first_run`, with `qorpera_member_first_run_sponsor` of the member
     who pressed Start, read again now. With no login, the kickoff stays pending, and its author starts it later
     (`qorpera_start_agent_first_run`), as today.

   `qorpera_company_first_runs` is not written (it needs a formation).
5. **Every unit must be saved.** If any unit is refused or conflicts, the function raises, and the whole transaction
   rolls back: no half-seeded company. Then the creation is marked `failed` in a second call, with the outcomes.
6. **The creation row:** `state = 'completed'`, the commit id, and the input nulled (the files now hold the vision and
   the roles). This is the row the transaction already holds.

**No wake row at creation.** As today, the first run is a kickoff and a turn request; the `first-run` wake appears
when the run is made. That is C4's `folder-v2` materializer (P28: "plain conversations on `folder-v2`"). So the
creation needs no admission and no change to the core's commit. Core §5 and contract launch item 3 say "one silent
first-run wake": the kickoff is that, as on `snapshot-v1`, and exactly one, since the creation is one row per company
and `qorpera_agent_first_runs` is unique per agent.

## 4. Hiding, and the old chain

- **Hidden until ready:** `qorpera_list_hosted_profiles` also hides a `folder-v2` company whose creation is not
  completed. A company with no creation row (none exists outside tests) stays hidden as well.
- **Rules keyed on the bootstrap job, mirrored for a creation:**
  - a founder cannot leave while the creation is queued or leased (as with a bootstrap job, 20260928248100);
  - company delete marks a queued creation `blocked` (as it does a bootstrap job, 20260928249150).
- **Guards:**
  - `qorpera_folder_enable` refuses an environment with a bootstrap job (F1's promise on #444);
  - `qorpera_enqueue_company_bootstrap` refuses `folder-v2`;
  - `qorpera_folder_company_create` refuses a company that has a bootstrap job or a Co-Founder;
  - `open` never runs the old chain.

## 5. The worker (TS, `packages/object-gateway`)

- **`CompanyFolderCreator`,** run from the gateway's maintenance loop like the bootstrap provisioner:
  - claim (service role);
  - `companyStateSeedTree` from `@qorpera/cloud-client`;
  - stage through the gateway's own NAS store with a platform authority (open, authorize, confirm, seal, the
    replication path the bootstrap uses);
  - create.
- **Off by default** behind its own setting, until an operator or C5 needs it.
- **Its deploy:** the gateway's, apart from the SQL train. It needs the SQL live first.
- **Tests:**
  - a crash between staging and create (the retry restages or reuses: sealed objects come back `present`);
  - a refused commit (failed, not retried);
  - a paused company;
  - a replay.

## 6. The operator path (C5 step 2, P38)

`qorpera_folder_company_operator_create(owner, clientCreationId, name, vision)`, service role:
- open, then a creation with `founders = [the owner]` and `kickoffRequestedBy = owner`;
- no founding row;
- the same worker seeds it.

This is how the proof company is made before C5 turns creation on.

## 7. Locks, summed up

- **Open:** what `create_hosted_profile` takes today, plus the file row and the new folder rows it inserts. No fence
  exists yet, so none is taken.
- **Seed:** one insert, inside Start's locks.
- **Create:** the creation row, then the fence `KEY SHARE`, then the commit's own order:
  - the company row `KEY SHARE`;
  - the new staff row;
  - paths;
  - apply: the thread and its session, the operation clock, the kickoff, the first-run rows, the turn request;
  - verify;
  - the folder clock.

  Nothing is locked after the clock: the creation row is already held.
- **No company-wide lock beyond the fence `KEY SHARE`** every effect takes.

## 8. PRs and tests

- **P14a, the database** (one migration, one SQL test file plus a race file):
  - the creation table; open, seed, ready, claim, fail, create and the operator entry;
  - the apply step for the first run; the list and the guards;
  - Start's race tests with a real seed (#705 left them to P14): a join against a creation, Start twice at once, a
    delete during a creation.
- **P14b, the worker** (TS, object gateway), after P14a.
- **Docs:** core §5's creation paragraph and CLIENT-CONTRACT's lobby section ("no Company File before Start" becomes
  "no seeded tree before Start").

## 9. Open points for the coordinator

1. The first run as a kickoff and a turn request, with no wake row (§3). P28's materializer runs it as a plain
   conversation. Agree?
2. The worker in the object gateway (a gateway deploy), versus elsewhere.
3. Whether the operator entry is an SQL function (§6) or a script around it.
