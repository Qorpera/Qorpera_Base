# Company creation on the folder core (C2-create, P14)

Status: design, 3 October 2026 (F2, the coordinator's slice P14); revised after design review r1 and the coordinator's
answers. The core's §5 "Company creation is one commit" and §11 C2 say what; this says how. It fills the stubs the
founding lobby left for C2 (`20260928248200_company_founding_lobby.sql`): `qorpera_folder_company_open`, `_seed` and
`_ready`. C5 turned creation on (`qorpera_company_founding_available()`, P39, 20260930031000) once C4's materializer
(P28) ran the first run; switching it off again is the rollback.

In short:
- **Open** makes the company row, its environment and its owner, already on `folder-v2`: no seeded tree yet.
- **Start** records one creation request with the founders' vision and roles.
- **A creation worker** in the object gateway builds the seeded tree (`companyStateSeedTree`), stores its files as the
  platform, and then makes **one transaction**: the creation commit, the Co-Founder (staff row, thread, cofounders
  row), and the Co-Founder's silent first run (a kickoff). Since P15 the follow-up queue then gives the Co-Founder
  its default grant and queues the kickoff's turn request; the worker kicks the queue after the transaction.
- **Ready** is that transaction having landed and the queue having converged the Co-Founder. Until then the company
  is hidden.
- **If setup fails for good,** the founders' table says so, and an operator can retry it. The company stays hidden
  until it is ready.
- **Before C5,** only an operator makes a `folder-v2` company, through the same path (§6).

## 1. What exists (master 186cd8646)

- **The stubs** (`20260928248200:20-44`): open and seed raise `0A000`, and ready returns false. All three are revoked
  from every API role. `qorpera_company_founding_available()` returned false then; it is granted to `authenticated`, and
  C5 flipped it (P39).
- **The lobby's callers:**
  - `qorpera_open_company_founding` calls `open` as the signed-in member, with no lock held, and reads `profile_id`.
  - `qorpera_start_company_founding` calls `seed` once, inside its own transaction. A repeated Start returns early at
    `phase = 'started'` (`248200:415`). The input is `qorpera.company-seed-input/v1`: `companyName`, `vision`,
    `kickoffRequestedBy` (the member who pressed Start) and `founders` (`userId`, `displayName`, `role`). Start then
    nulls the vision and the roles, so the input is their only copy.
  - With C1c-3d-1 (#705), Start holds the folder fence and the company row `FOR NO KEY UPDATE` at that point. #705
    requires the fence row to exist as soon as Open returns.
- **The web** reads `companyReady` (from `_ready`) and polls until it is true. Then it expects the company in
  `qorpera_list_hosted_profiles`.
- **The old creation (`snapshot-v1`; legacy sweep D1, 20260930330000, dropped it):**
  - The request does the profile, the environment (its trigger makes the Company File row), the Co-Founder and a
    bootstrap job.
  - The object gateway's `CompanyBootstrapProvisioner` stages the files and finalizes.
  - Finalize writes the silent `kickoff` input in the Co-Founder's thread, `qorpera_company_first_runs`,
    `qorpera_agent_first_runs`, and `qorpera_queue_agent_first_run`'s turn request.
  - The `first-run` wake row appears only when the turn materializer makes the run (`qorpera_admit_input_wake`).
- **The traps** (registry; #444):
  - Running the old chain beside C2 makes two Co-Founders and two first runs.
  - Enabling the folder core after a bootstrap job is queued leaves the company hidden for good.
  - Claim, finalize and Co-Founder seeding already refuse `folder-v2`. Not yet guarded:
    `qorpera_enqueue_company_bootstrap`, and `qorpera_folder_enable` with a queued job.
  - Legacy sweep D1 (20260930330000) dropped the old chain, so neither trap remains.
- **Bytes:**
  - A commit unit only references stored bytes (a version-2 proof and catalog rows). SQL cannot store the bytes.
  - The platform can stage through `qorpera_folder_open_upload`, `_authorize_object_upload`, `_confirm_object` and
    `_seal_upload` (service role; the platform needs no possession).
  - A1's P22b writer (`packages/object-gateway/src/platform-folder-writer.ts`, draft #730, stacked on #727 → #715 →
    #705) will be the gateway's platform stager. P14b depends on it.
- **The commit's platform branch** takes no fence and has no admission step (`20260928259230:985-990, 1392-1430`).
- **First-run wakes:** the wake pin trigger's `first-run` branch requires a `session_turn` run
  (`20260828023000:195-200`), and the wake policy accepts `first-run` only for such a run. Nothing delivers a
  `folder-v2` run until C4 (P28).

## 2. The flow

1. **Open** (`qorpera_folder_company_open(user, clientCreationId, name)`, called by the lobby as the member):
   - It inserts the creation request first (`qorpera_company_creation_requests`, `on conflict do nothing`). A
     repeat returns the same company. A name mismatch refuses, as `qorpera_create_cloud_company` did. A creation id
     the old path already used refused (`23505`, as the lobby did for a company with a bootstrap job), and the reverse
     (a folder-path id sent to the old path) failed at its own strict job lookup. Since legacy sweep D1
     (20260930330000) there is no old path: a creation id names a `folder-v2` company or none.
   - It makes the profile, the owner member (email and display name read from `auth.users`, so the same body serves
     the operator functions, which have no member's session), and the environment named after the company (contract
     version 2). The provision
     trigger makes the `snapshot-v1` `provisioning` file row as today.
   - In the same transaction, `qorpera_folder_enable_internal` switches that row to `folder-v2`: the clock, fence and
     admission rows, and the root and `rules/` resources.
   - `qorpera_folder_enable` becomes a role check around the same internal function. Both refuse an environment
     with a bootstrap job (F1's promise on #444; legacy sweep D1, 20260930330000, dropped the jobs and the check).
     The file row's `state` is then `ready`, and nothing may read that
     as "the company is ready".
   - No staff, no thread, no seed, no wake. It returns `{profile_id, environment_id}`. Vault By Default registers the
     company for sign-in on its own.
2. **Start** (`qorpera_folder_company_seed(profile, input)`, called inside Start):
   - It checks the input (the schema, the fields, their sizes as the lobby keeps them) and that the company is
     `folder-v2` with no Co-Founder (and, until legacy sweep D1, 20260930330000, no bootstrap job).
   - It inserts one row into `qorpera_folder_company_creations`: `state = 'queued'`, the input,
     `kickoff_user_id = kickoffRequestedBy`, and the ids the seed needs: `cofounder_id` and `first_todo_id`, each a
     random version-4 UUID (`gen_random_uuid()`), made once here. Every client checks a staff id's version and variant
     digits (the runner broker, the web, the wake bus), so these are never derived by hashing.
   - Start reaches it once; a second call finds the row and returns its id (a safety net). The insert adds no lock
     another session holds in a conflicting mode.
3. **The creation worker** (object gateway; P14b):
   - It claims a queued creation with a lease token (`qorpera_folder_company_creation_claim`). The claim's
     `kickoffRequestedBy` can be null (that member's account was deleted); the worker still calls create, which
     answers `failed` (`kickoff_member_left`).
   - It builds `companyStateSeedTree({companyName, cofounderId, vision, founders, firstTodo: {id, requestedBy:
     kickoffRequestedBy}})` with the ids the claim returns from the creation row, so a retry builds the same tree, and
     parses each structured file with the shared parser.
   - It stages every file as the platform with A1's `PlatformFolderWriter.stage()`, in the same attempt as the
     create (open intents are GC roots; restaging an object already present costs nothing), then calls
     `qorpera_folder_company_create` once (§3).
   - The create function sorts its own refusals (§3, "Every unit saved, or nothing"). Any error the worker gets back
     releases the lease with a back-off; a paused or deleting company (`55000`) is a back-off, not a failure.
   - The worker's own failures: any throw from `companyStateSeedTree` (a `RangeError` for a file the parser refuses,
     or a plain `Error` from a writer) or a staging refusal (`stage_invalid`) is final,
     `qorpera_folder_company_creation_fail(creation, token, code)`. Open and seed refuse a company name with a control
     character or a line separator (`22023`), so a name the seed tree cannot write never reaches the worker;
     `stage_incomplete` and any code not listed are retried with a growing back-off (to an hour between tries), and
     the attempts are counted on the row for the operator. There is no attempt limit.
4. **Ready** (`qorpera_folder_company_ready(profile)`) is `state = 'completed'`: a plain `stable` read.

## 3. The creation transaction (`qorpera_folder_company_create`, service role)

One transaction, numbered with the core's steps (core §3):
- **Step 2 (the job's place): the creation row `FOR UPDATE`.** Its lease token is checked, and a completed creation
  answers its stored result (a replay).
- **Step 3: the fence.**
  - The pause is read before the fence (`qorpera_company_execution_paused`, which also covers a company being
    deleted).
  - Then the folder fence `FOR NO KEY UPDATE`: the mode member management uses (C1C §6.1). So a join, a leave or a
    role change and the creation run one after the other. A join can no longer miss the Co-Founder's thread, which
    the staff-insert trigger creates with the members of that moment.
  - Effects hold the fence `KEY SHARE` and are not blocked. Stop and resume wait as before. It is the company's
    existing fence, taken once per company, so it is not a new company-wide lock.
  - Then the pause again, as every effect does.
- **Step 1, here: the operation key.** The setting `qorpera.folder_company_create` carries the creation: the
  environment, the creation id and the operation key `company-create:<id>`. It is set in the body before the
  exception block (a set inside the block would be undone when the block catches its error) and cleared on each of
  the three answers, as `qorpera.folder_send` is. Apply cross-checks it against the commit's own key and the creation
  row it holds.
  Then `qorpera_folder_commit(environment, platform, 'company-create:<id>', units)` runs, and claims the key at its
  own step 1, after the creation row and the fence.
  - This order is a named exception for P13's call-chain check. The key is only ever claimed under its creation row
    and the fence, so nothing can hold it and wait for them.
- **The units:**
  - `mkdir vision`, `write vision/vision.md`;
  - `mkdir agents`, `write agents/sections.md`;
  - `new_folder agents/co-founder`: `agent.md`, `memory/`, `skills/`, `routines/`, and `todos/` with the first todo;
  - `mkdir` for every other seeded folder: `agents/groups`, `connections`, `rules`, `skills`, `skills/human-task`
    with `SKILL.md`, `human-tasks` and `contacts`;
  - `interfaces/` and `tables/` with the library copies, once P16 adds them to the seed tree (§8).

  The hook's existing rules apply: only the platform records the Co-Founder (`qorpera_company_cofounders`, formation
  null), and `vision_seeded` is true.
- **Steps 4 to 8: the commit's own order.**
  - Rank 0: the company row `KEY SHARE`.
  - Rank 1: every member row `KEY SHARE`. The hook names them for an agent with no thread yet. Joins, leaves and
    role changes have already met the creation at the fence; only an account deletion (which cascades with no
    prelude) meets it here.
  - Rank 2: the new staff row; then paths and objects.
  - Apply: the staff row, its thread room, session and room members (the staff-insert triggers, as for a hire), the
    operation clock, then the first run (below). Todos are indexed after the agent within the unit, so the first
    todo comes after the operation clock too. These are all new rows.
  - The foreign-key `KEY SHARE` locks apply takes after the paths: the kickoff author in `auth.users`; (before P15, the
    sponsor binding, sponsor version and compute identity of the turn request); the Company File row (through
    `qorpera_agent_first_runs`); and the runtime bundle row (the provenance trigger). None closes a cycle: none of
    these rows is locked more strongly by anything that also holds a lock this transaction waits for. The known
    exception, an account deletion cascading with no prelude, can meet it as one `40P01` (C1C §6 accepts that).
- **The first run, in apply, for the Co-Founder's `agent.md`, when the setting is there** and the file's `id` is the
  creation row's `cofounder_id`, so only the creation's own Co-Founder gets it. This is the seam P28 consumes:
  - **The kickoff** (`qorpera_session_inputs`):
    - `session_id` is the Co-Founder's thread (the room bound to the Co-Founder);
    - `client_input_id = md5('qorpera.folder-company-create/kickoff:' || creation_id)::uuid`;
    - `kind = 'kickoff'` and `author_user_id = kickoff_user_id`;
    - `body`:
      ```json
      {"schema": "qorpera.company-first-run/v1",
       "assignment": {"kind": "company_founding", "companyId": "<profile>", "creationId": "<creation>",
                      "cofounderStaffAgentId": "<agent>",
                      "firstTodo": "agents/co-founder/todos/start-with-the-founders.md"}}
      ```
    - The other columns take their defaults, as finalize's kickoff does.
  - **`qorpera_agent_first_runs`:** the Co-Founder, the thread, the kickoff, `source_path_version` = the `agent.md`
    version, and `startup_assignment` = the kickoff's body.
  - **The turn request** (since P15, the follow-up queue's, after the Co-Founder's default grant: STATE-FILES "Plan
    (P15)"), through `qorpera_queue_agent_first_run`. Its sponsor is `qorpera_member_first_run_sponsor` of the
    kickoff's author, read again then, together with the same `qorpera_sponsor_serves_requester` check Start made.
    With no usable login the kickoff stays pending, and its author starts it later, as today.
  - `qorpera_company_first_runs` is not written (it needs a formation; legacy sweep D1, 20260930330000, dropped the
    table).
- **Step 9:** the check (verify).
- **Step 11:** the folder clock.
- **After the clock:** the creation row becomes `state = 'completed'`, with the commit id, and the input is nulled
  (the files now hold the vision and the roles). This row is already held, so no new lock is taken.

**Every unit saved, or nothing.** The gateway never reads an error's body (`member-company-authority.ts:118-125`),
so the create function sorts the outcome itself and answers `completed`, `failed` or `retry`:
- The commit runs inside one exception block (one subtransaction; the creation row and the fence are taken before it
  and stay held). The commit returns normally even when it saves nothing (`seq` null), so the block checks for a
  `seq`, one outcome per unit sent and every outcome `saved`. It then checks that the recorded Co-Founder is the
  row's `cofounder_id`, with exactly one `qorpera_agent_first_runs` row and one kickoff for it (a mismatch can only
  come from a worker defect, and must not complete without the first run contract 14.1 requires). Otherwise it raises
  `QFC01`, which the block catches. Everything the commit wrote rolls back: no half-seeded company.
- **Retryable** (`retry`: the row stays `leased` until the worker releases it, and the next attempt restages): a
  `bytes_unverified` outcome (a deleting object: "the writer redoes its call once GC has finished", core §8 G3).
- **Final** (`failed`: the row keeps the outcomes and the input): a parse, schema or 5.6 refusal, an unexpected
  `conflict`, and a Co-Founder or first run that does not match the row.
- **Before the block,** a company with a recorded Co-Founder (`cofounder_exists`), or whose kickoff member is gone
  (`kickoff_member_left`), answers `failed`. A bootstrap job answered `old_chain` until legacy sweep D1
  (20260930330000) dropped the old chain.
- **Stale:** a create call that is not the lease's worker and generation answers `stale` and changes nothing; the
  worker drops the claim.
- Errors the block does not catch (`QRC01`, `55000`, `55P03`, `40P01`, and defects such as `22023` or `XX000`) roll the
  whole transaction back; the worker backs off and tries again, and a defect then shows in the attempt count.

**What founders see.**
- `qorpera_folder_company_ready` stays false, and the lobby's view gains `start.companySetup`: `pending`, `ready` or
  `failed`. A web follow-up shows "Setup failed; we are looking at it" for `failed`.
- The operator requeues (`qorpera_folder_company_creation_requeue(creation, reason)`, owner role only) after fixing
  the cause. It accepts only a `failed` creation, and refuses a company being deleted or one whose kickoff member has
  left.
- Departure and delete are allowed while a creation is `failed`.

**No wake row at creation** (the coordinator, 3 October).
- The wake pin trigger's `first-run` branch requires a `session_turn` run, and the wake policy accepts `first-run`
  only for such a run. So a run-less wake at creation would fail today, while the kickoff and turn request fit both
  unchanged.
- This matches contract 14.1 ("exactly one first-run kickoff … a silent system input"), the 2026-09-18 amendment and
  launch item 3, the way `snapshot-v1` met them.
- Exactly one:
  - one creation row per company;
  - `qorpera_agent_first_runs` is unique per agent;
  - turn requests are unique per input;
  - the wake index `qorpera_wake_first_run_once` is unique per agent.
- The core text that says "wake" moves with this (P14a): core §3 step 10's "the creation commit's first run", §5's
  "exactly one silent first-run wake", and C5's acceptance line, which becomes "one kickoff and its turn request at
  creation; the first-run wake once P28 materializes it".

**What P28 needs from this** (Q1's slice; recorded here as the hand-over):
- **A `folder-v2` turn materializer,** one company per transaction, in the core's order:
  1. the request row;
  2. the fence `KEY SHARE`, with the pause read before and after;
  3. ranks 0 to 4 (the requester, the Co-Founder, the thread room);
  4. the session `FOR UPDATE`;
  5. the operation clock;
  6. `qorpera_folder_admit_wakes`;
  7. the run and its `queued` event, after which `qorpera_admit_input_wake` inserts the `first-run` wake.
- **No change to the pin trigger or the wake policy.** A test should prove `qorpera_folder_wake_authorized` accepts
  it.
- **A dead request.** The turn request pins the sponsor chosen at creation, and `qorpera_queue_agent_first_run`
  returns any existing request whatever its status. So `qorpera_start_agent_first_run` needs a `folder-v2` branch
  (the fence, then the pause) and a way to replace a dead request.
- **The runtime** passes the kickoff as `startupAssignment` on the `first-run` wake. The kind `company_founding`
  replaces `company_formation`; P28 checks the runtime reads it.

## 4. Hiding, the old chain, and deletion

- **Hidden until ready:** `qorpera_list_hosted_profiles` gains one condition in its WHERE clause (the eight keys
  member-web reads stay exactly as they are). A `folder-v2` company shows only when its creation is `completed`. A
  `folder-v2` company with no creation row (none exists outside tests) stays hidden. The core flag and the creation
  row are joined once, not called per row.
- **Founder departure** (`qorpera_guard_founder_departure`, and the team page's `leave` capability): a founder named
  as a creation's `kickoff_user_id` cannot leave while it is `queued` or `leased`, as a bootstrap job held them. `failed`
  and `blocked` do not hold them.
- **Company delete** (`qorpera_stop_company_work`, called with the company fence held): it marks `queued` and `leased`
  creations `blocked` with `FOR UPDATE SKIP LOCKED`, as it treats runner jobs, since the creation row sits before the
  fence. An in-flight creation refuses after its fence (the pause check covers deletions). The finisher's next pass
  marks it. A worker's release never turns `blocked` back into `queued`.
- **Guards:**
  - `qorpera_folder_enable(_internal)` refuses an environment with a bootstrap job;
  - `qorpera_enqueue_company_bootstrap` refuses `folder-v2` (a `folder-v2`-only prefix; its old body stays byte for
    byte);
  - `qorpera_folder_company_create` refuses a company with a bootstrap job or a Co-Founder;
  - Open never runs the old chain.

  Legacy sweep D1 (20260930330000) dropped the old chain, the enqueue with it, and the bootstrap-job checks; the
  Co-Founder check stays.
- **Other platform writers** (P22's connection files) skip a company whose creation is not `completed`. Otherwise
  the creation's `mkdir connections` meets a `conflict`, and the creation then fails on every requeue. The skip goes
  into P22a's claim (`qorpera_claim_connection_file(uuid,integer)`, migration 20260930006000), after the candidate
  select's `lease_until` and `not_before` lines: `and not exists (…creation of work.profile_id whose state is not
  'completed')`. Whichever of P14a and #727 landed second was to carry it (the coordinator, 3 October; A1
  agreed): #727 merged first, so P14a carries it, by an exact anchor with its body marker. Work rows the claim
  inserts for such a company stay due until the skip lifts; nothing else changes. **Gate:** the P22 writer is not
  switched on, and P38/P39 do not run, until the skip is on master. A `folder-v2` company with no creation row
  passes the skip, while the hub list hides it: deliberately, since such companies exist only in tests (#727's own
  among them), and the writer serves them there.
- **The rollout packet:** `templates/sql-packet.mjs:92`'s bootstrap gate belongs to Company41's frozen packet, which
  C5 rewrites (core §10); the live release train has no such gate, and a creation is one short transaction. P14a adds
  nothing there.

## 5. The worker (TS, `packages/object-gateway`, P14b)

- **`CompanyFolderCreator`** runs in a loop of its own with its own database client (as P22b's connection-file
  writer), not in the gateway's maintenance loop. It is built on A1's P22b module:
  - `drainPlatformClaims` with its own claim, release, fail and create calls;
  - `PlatformFolderWriter.stage()` for every seed file;
  - one `qorpera_folder_company_create` call per creation.
- **Off by default** behind its own setting. The coordinator switches it on.
- **Rollout:** the SQL in a cut first; then the gateway, as a node 1 shared service in its own quiet minute. The
  gateway build carries the cloud-client parser and seed tree that match the live hook.
- **Tests:**
  - a crash between staging and create (the retry restages; sealed objects come back `present`);
  - each retryable class, and a final refusal (`failed`, not retried);
  - a paused and a deleting company (back-off);
  - a replay;
  - a stale lease token.

## 6. The operator path (C5 step 2; P38)

Two functions, like the lobby. Both are revoked from every API role; the coordinator's P38 lane calls them as the
owner role:
- **`qorpera_folder_company_operator_open(owner_user_id, client_creation_id, name)`:** Open for that account. The
  owner's email must be confirmed. It takes no reason: the P38 lane calls `operator_start` right after, and that
  reason is stored on the creation row.
- **`qorpera_folder_company_operator_start(profile, vision, reason)`:**
  - It refuses a company with a founding row, so an operator never starts a lobby's company under its founders, and
    checks that the owner is still a member with the owner role.
  - It checks the owner has a usable model login, as the lobby's Start requires of every founder. So a proof
    company's first run is paid, once Vault By Default has registered the company and the owner has connected a
    login.
  - Then it records the creation through seed's own checks, with `founders = [the owner]`, `kickoff_user_id =
    owner`, the operator's reason on the creation row, and the same first todo as the lobby's. The same worker seeds
    it.

**Gate:** not before the audit's list "before any `folder-v2` company exists" (P02 #705, P01, F1's six #613
follow-ups, P03) and P13.

**What the proof company does not prove:** Start's real-seed lock path inside #705's prelude first runs in
production at P39. A lobby smoke test follows the switch. The web has no `folder-v2` company screens yet (C4); once
ready, the proof company appears in the owner's hub.

## 7. Locks, summed up

- **Open:** what profile creation takes today, plus the file row it switches and the new folder rows it inserts. No
  fence exists yet, so none is taken.
- **Seed:** one insert, inside Start's locks. Its foreign key to the kickoff member's account takes that
  `auth.users` row `KEY SHARE`, which only an account deletion of that member waits for.
- **Create:** the creation row; the pause, then the fence `FOR NO KEY UPDATE`, then the pause again; then the
  commit's own order:
  - the operation key;
  - rank 0, the company row `KEY SHARE`;
  - rank 1, the member rows `KEY SHARE`;
  - rank 2, the new staff row;
  - paths and objects;
  - apply: the thread, its session and room members, the operation clock, the kickoff, the first-run row, the first
    todo (the turn request is the follow-up queue's since P15);
  - verify;
  - the folder clock.

  The creation row is updated after the clock, but it is already held.
- **Company-wide locks:** none beyond the fence, in the mode member management already takes.

## 8. Patches, PRs, tests

**Shared live functions P14a patches**, each with the body marker `<slot>` and an exact anchor, and a snapshot-v1
reversal test (as #705's 817 §1; no snapshot-v1 reversal tests since 3 October: legacy sweep A, #829, removed 856 §7's
and 817 §1's):
- `qorpera_folder_structured_apply` (the first run);
- `qorpera_list_hosted_profiles` (hiding);
- `qorpera_guard_founder_departure` and `qorpera_profile_team_info` (`leave`);
- `qorpera_stop_company_work` (creations blocked);
- `qorpera_enqueue_company_bootstrap` (a `folder-v2` refusal prefix; legacy sweep D1, 20260930330000, dropped it);
- `qorpera_folder_enable` (a role check around the new `qorpera_folder_enable_internal`, with the bootstrap-job
  refusal);
- `qorpera_company_founding_json` (`start.companySetup`);
- `qorpera_claim_connection_file(uuid,integer)` (the creation skip): #727 merged first, so P14a carries it (§4);
- the three stubs (`create or replace`; still revoked from every API role).

**PRs:**
- **P14a, the database:**
  - the creation table, with RLS on, revoked from every API role, cascading from the company row;
  - the functions: open, seed, ready, claim, release, fail, requeue, create, and the two operator functions;
  - the patches above, and the core and CLIENT-CONTRACT text (core §3 step 10, §5, C5's acceptance line;
    CLIENT-CONTRACT's lobby: no seeded tree before Start, `companyReady` and `companySetup`, the hub list, the first
    run's account read again at creation).
  - Tests:
    - open (repeat-safe, a reused old id, the core switched, the fence present);
    - seed (input checks, once);
    - create (the units, the Co-Founder, the kickoff's exact shape, the first-run row, the turn request with and
      without a usable login, a replay, a stale token, all-or-nothing with the three answers (a `retry` on
      `bytes_unverified`, a final refusal kept on the row, `completed`), the setting cleared after each, an `agent.md`
      whose id is not the row's `cofounder_id` answering `failed`, the worker's failure classes);
    - hiding and ready; the guards; the operator functions (member and anon callers refused, the reason kept, a
      company with a founding row refused, an owner who left refused).
    - **Exactly one under a creation retry and under two racing Starts:** one creation row, one
      `qorpera_agent_first_runs` row, one kickoff.
    - Races: a join against a creation, in both orders (the second waits at the fence; the joiner ends in the
      thread); a leave against a creation (they meet at the fence); a company delete during a creation, with the
      deletion path named: before P08 the creation may still finish on a company being deleted (harmless: it stays
      hidden and is purged); after P08 the fence drain stops it.
  - P14a builds on #705 (P02), #715 (P03) and #727 (P22a), all on master: Start's real-seed tests need #705's
    prelude, and P14a carries the connection claim's skip (§4).
- **P14b, the worker** (TS, object gateway), on A1's P22b module (#730), after P14a and #730.
- **`interfaces/` and `tables/`** (contract 5.6, 2 October): P16 adds them to the seed tree and the SQL seeded list.
  The worker's unit builder (`creationUnits`) then needs: their parse through `parseCompanyStateFile` once it
  dispatches to the interface parser P16 adds (Interfaces' entry point over `interfaces.ts`); each table as one
  `new_folder` unit (its `table.toml` and `rows.csv` together, since rows are checked against their definition); and
  the media type by extension (`text/plain` for `.toml` and `.csv`, as the runtime writes them).
  P16 lands before the proof company (P38), so no `folder-v2` company exists without them; the coordinator records
  that dependency in the audit. P16 also redeploys the gateway.

**Hand-overs:**
- **P15:** the Co-Founder's root grant comes from the staff-insert trigger, outside the authority journal. When P15
  moves default grants into its queue, it covers the Co-Founder made here, and `ready` then also waits for that queue
  row ("hidden until the queue has converged", core §5).
- **P15's name copy:** the hub reads `qorpera_profiles.name`, and `folder-v2` runs read the vision's name from the
  index. They agree at creation (the input's name is the profile's). P15's name copy keeps them aligned after.

**Custody of the input:** between Start and the commit, the vision and the roles are founders' prose in a database
row. That is runtime state with a bounded life: the lobby kept it before Start, it is nulled at completion, and it is
kept only while a creation is `failed`, for the requeue.
