# Client contract v1

**Status:** Draft v1, generated 2026-09-02 from the migrations, Edge Functions,
object gateway, and desktop shell at `codex/steps-0-2-fable-handoff`
(`16f23e856`, which includes the runtime session's first Order 0
responsibility commit). Owned by the runtime implementation session: whenever it changes
a member-callable RPC, Realtime topic, gateway route, or Edge Function it
updates this file in the same change. Consumed by every client — the desktop
shell and the web app. No client session edits runtime code; a needed change
is a request against this document.

**Authority rules (from the Qorpera Runtime Contract §2, §10, §14.5):** a
client is a viewing, input, approval, upload, download, and remote-display
endpoint. It uses only the publishable key plus the signed-in member's token;
it never writes tables directly, never executes an agent tool, never runs the
mouth, never resolves a secret, and never owns a wake. Product UX may be built
against the ratified semantic projection before the cloud machinery behind it
exists, but it must never render missing machinery as working autonomy.

**Verify before relying on any entry.** The RPC list below is derived from
grant statements in migrations, not from the deployed schema. Confirm against
the target project with:

```sql
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'qorpera_%'
  and has_function_privilege('authenticated', p.oid, 'execute')
order by 1;
```

## 1. Authentication

Supabase Auth with the project's publishable key. The desktop uses email
sign-in, OTP, OAuth providers, and authorization-code exchange
(`signInWithEmail`, `signInWithOtp`, `signInWithOAuth`,
`exchangeCodeForSession`); the web app uses the same. Membership and roles
(`viewer`, `contributor`, `admin`, `owner`) are cloud state read through the
profile RPCs; RLS is the second read boundary.

Founders (2026-09-28, migration 20260928248100): every member with the role
`owner` is a founder, and a company may have several. Clients name the role
"founder".
- `qorpera_update_profile_member_role`: a founder may make a member `owner`.
  A founder may step down (change their own role) while another founder
  remains and no company setup runs for them (42501 otherwise). Nobody else
  changes a founder. Admins still change contributors and
  viewers only.
- `qorpera_remove_profile_member`: founders remove any member except a fellow
  founder, admins included. Admins remove contributors and viewers.
- `qorpera_leave_hosted_profile`: anyone leaves, except the last member (who
  deletes instead), the last founder while others remain, and a founder while
  company setup runs for them (42501).
- `qorpera_delete_hosted_profile`: only the last member. Since 20260928249150 it
  requests the deletion: the company disappears at once (no role for anyone, gone
  from `qorpera_list_hosted_profiles` and the founding lobby, the member's access
  state turns `revoked`) and all its work stops. Its rows are removed later, once
  the servers hold nothing of it (deploy/first-node/RUNTIME-COMPANY-DELETE.md). A
  second call answers 42501, like any call for a company the caller is not in.
- Deleting an account (operators only; no client RPC; migration
  20260928249180) takes the person's memberships as a leave does, with the
  same refusals, and is also refused for the only member of a company that is
  not being deleted. It never removes company data: conversations, messages
  and runs keep naming the person, as they do after a leave. Closing an
  account instead (a soft delete, an update) triggers none of this; the close
  must make the same removals and refusals itself.
- `qorpera_profile_team_info` capabilities add `manage_founders`, `leave` and
  `delete_company` for the caller; `leave` also tells a founder whether they
  may step down. A cloud without several founders omits
  them; a client then falls back to "the owner deletes, others leave".

Native host entry points (G2-1, migration 20260928409985): the publishable key's role (`anon`) may also call
`qorpera_native_host_call` and `qorpera_native_host_call_long`. They are for the platform's native host inside a
runner guest and work only with that runner job's current lease token. Clients never call them; without the token
they answer 42501 "native host call is refused".

Company databases (slice 5, migration 20260930750000): `anon` may also call `qorpera_data_pass_redeem(p_pass)`. It is
for the data gateway (`deploy/company-data/`), which redeems a run's data pass once: only knowing the pass (32 random
bytes, only their sha256 kept, 60 s) opens it. Clients never call it; anything but a live, unredeemed pass answers null.

## 2. Member-callable RPCs (security-definer, granted to `authenticated`)

113 functions, grouped for navigation. Signatures: see the migration that defines each.


### Members, presence, friends, feedback (18)

- `qorpera_can_read_member_picture(p_object_name)` — the picture bucket's
  read policy: anything in your own folder, and another account's current
  picture when `qorpera_can_see_member_picture` allows it.
- `qorpera_can_see_member_picture(p_user_id)` — yourself, company colleagues,
  accepted friends, and accounts that sent you a friend request (a request you
  sent reveals nothing until it is accepted).
- `qorpera_clear_member_picture` — back to initials; returns
  `previous_object_name`, which the caller deletes from storage.
- `qorpera_find_account_by_email(p_email)` — the Friends search: the account
  whose confirmed address is exactly `p_email` (case-insensitive, never a
  prefix) as `{user_id, email, display_name, self}`, or `null` when no
  account holds it. `qorpera_send_friend_request` uses the same rule, so an
  address that finds nobody cannot be sent a request. Migration
  `20260928031000_friend_account_lookup`.
- `qorpera_is_current_member_picture(p_object_name)` — whether an object is
  the caller's current picture; the bucket's delete policy refuses it until
  another picture (or none) has replaced it. It shares a per-folder lock with
  `qorpera_set_member_picture`, so a delete and a choice of one object happen
  one after the other.
- `qorpera_list_friends`
- `qorpera_list_presence_devices`
- `qorpera_member_picture_objects()` — how many objects the caller's own
  picture folder holds; the upload policy refuses a fifth in Storage's
  preflight. The limit itself is enforced by a `before insert` trigger on
  `storage.objects` (`qorpera_guard_member_picture_insert`, also on a move of
  `bucket_id`/`name`), which covers the storage service's final write and counts
  parallel uploads into one folder one after another.
- `qorpera_member_pictures(p_user_ids uuid[])` — at most 200 accounts; returns
  `[{user_id, object_name, updated_at}]` only for pictures the caller may see
  (`qorpera_can_see_member_picture`). Migration
  `20260924150000_member_pictures`.
- `qorpera_own_member_picture_objects()` — the caller's own picture folder
  (`[{object_name, created_at, age_seconds}]`, the age by the cloud's clock),
  for tidying uploads that never became the picture; use it instead of a
  storage `list()`, which runs the read policy over the whole bucket.
- `qorpera_presence_topic_profile`
- `qorpera_register_presence_device`
- `qorpera_remove_friend`
- `qorpera_respond_friend_request`
- `qorpera_send_friend_request`
- `qorpera_set_member_picture(p_object_name)` — makes an object the caller
  uploaded to the private bucket `qorpera-member-pictures` as
  `<own user UUID>/<sha256>.<webp|jpg|png>` (512 KiB, image types only; RLS lets
  members write (four objects at most) and delete only in their own folder, and
  read per `qorpera_can_read_member_picture`) their picture; returns
  `previous_object_name` for the caller to delete.
- `qorpera_submit_product_feedback`
- `qorpera_unregister_presence_device`


### Routines (2)

- `qorpera_list_cloud_routines`
- `qorpera_upsert_cloud_routine`: a folder-v2 company keeps its routines in
  `QorperaOS/agents/<handle>/routines/` files: saving a new routine, or one that comes
  from a file, is refused with 55000; a routine saved before the company became
  folder-v2 is saved as before.


### Credentials, provider connections, identity recovery (17)

- `qorpera_begin_chatgpt_plan_sign_in` (20260928329830, switched off): begins a
  ChatGPT plan sign-in ("Continue with ChatGPT") for the caller's own member
  compute identity, the same as `qorpera_begin_native_provider_login` for
  OpenAI/Codex with the sign-in marked as a plan sign-in. Refused with 55000
  while plan logins are switched off for the company, and with 22023 for any
  identity that is not the caller's own member identity. The answer is the
  ordinary begin's plus `model_login_kind: "chatgpt_plan"`.
- `qorpera_begin_cloud_secret_capture`
- `qorpera_begin_native_provider_login`
- `qorpera_chatgpt_plan_available(profile)`: whether the caller's company may
  use ChatGPT plan logins now (show "Continue with ChatGPT" only when true).
  False while the company is being deleted (20260928359950).
- ChatGPT plan rules (20260928359950, switched off with plan logins):
  - work while away on a plan login needs the member's own choice: turn it on
    with `qorpera_set_chatgpt_plan_work_while_away(profile, connection, on)`
    (20260928369980), from Settings' "Work while you're away" switch or the
    first-routine card's Turn on. It answers for the caller's own active plan
    login in that company only (42501 "ChatGPT plan login is unavailable" for
    anything else, alike whether or not the connection is a plan, and for a
    revoked one), and its answer is the consent call's:
    `{connection_id, version, allow_autonomous, changed, ...}`, with the version
    to bind, plus `resumed_routines` (20260928369985), always `[]`: turning the
    plan on resumes no routine (the snapshot-v1 resume went in the legacy
    sweep's F3a, 20260930294000; on the folder core the agents write routine
    files). Re-read the routine list instead of assuming the card's routine
    started.
    The call waits at most 2 s for any one lock (an agent's call in flight, a
    deletion, the GC) and then answers 55P03 "Busy right now. Try again in a
    moment." with nothing changed; a rare deadlock PostgreSQL breaks on the
    call's side answers the same. Show that line and let the member try again.
    The kernel never consents a plan login for them:
    `qorpera_consent_provider_connection_autonomous` refuses to turn a plan on
    (55000 "Turn on work while you're away for this ChatGPT plan in Settings"),
    and an agent's routine save leaves a plan that is off as it is, also while
    the member is turning it off. Turning a plan off works through either call;
  - a plan never pays for a listener routine (a file change or an event): a save
    with one is refused with 42501 "A ChatGPT plan cannot pay for a listener";
  - a plan at its usage limit stays the account of the conversations it pays for
    (`qorpera_select_member_session_account` keeps it; sending then stops at the
    limit), while a new conversation starts on a login with room; a conversation
    whose login reached its limit never moves to a plan; a plan pays for
    follow-up work only of runs it pays for, so a coding worker asked for by a
    run another login pays for is refused at dispatch with 55000 when the plan
    is the member's only Codex login;
  - one usable plan per member and company:
    `qorpera_begin_chatgpt_plan_sign_in` refuses a second one with 55000
    "Disconnect your other ChatGPT plan first" (signing in again after the plan
    login lapsed works);
  - only the member whose plan pays retries a failed run on it
    (`qorpera_resolve_failed_execution_run` 'retry': 55000 for anyone else;
    acknowledging stays open).
- `qorpera_select_member_session_account(p_profile_id, p_session_id)` and
  `qorpera_choose_member_session_account(p_profile_id, p_session_id,
  p_connection_id)` (20260930059000, the payer never changes without the
  member): select keeps a conversation's login for every kind of login, also at
  its usage limit, while it needs a new sign-in, while its computer recovers and
  while an owner or admin has it disabled (it returns that login; sending waits).
  It answers `null` for a new conversation with no login that has room, and for a
  conversation whose login the member disconnected: that conversation waits for
  the member's own pick ("Choose a login to continue"). Choose saves the member's
  pick, one of their own logins that could pay now whatever its usage, and
  returns its connection id; 22023 "This login cannot pay for your conversation"
  for any other login, 42501 when the conversation cannot be read. While the
  member's own turn in the conversation waits at its login's usage limit (an
  agent's first run, say), select answers that login, also over a login saved
  before (20260930580000), so the thread shows the limit and offers the member's
  other logins; choosing one also moves those waiting turns to it (never onto or
  off a ChatGPT plan, never onto a login that may not work while the member is
  away when the turn's could), and they go on there once it has room and nothing
  earlier in the conversation holds them. A wake (a post in a thread, a routine's
  run) keeps its payer: a message sent while the thread shows the limit waits.
  A new conversation's first choice (and new work's, and a new coding session's) orders
  the logins best first (20260930559000): a login whose provider refused its last
  three runs, the newest in six hours, last, then one at its limit, then one that completed a
  run this week with at least 20% left first, then the most room on one scale
  (each window's room divided by the share of the window still to run), unknown
  usage last. `qorpera_list_member_native_execution_connections` reports each
  login's `recent_turns` (`{refused, completed}`), so a client orders its own list
  the same way.
- At a usage limit (20260930575000) the conversation still keeps its login, and a
  client may send on it: the message waits queued and goes on by itself, on the
  same login, once the limit resets or a usage reading shows room. The usage-limit notice (`provider_usage_limit`) also
  carries `accountEmail` (the login's email, or null) for the member whose own login
  it is; a company account's notice does not. Its `resetsAt` is the signal's reset:
  when the provider names none, the latest reset still ahead of a full window in
  the login's newest usage reading.
- `qorpera_grant_cloud_connector` — Step 7 (bundle v87): grants every
  operation of one company-owned connection (Gmail, Google Drive, GitHub) to
  all active agents (`p_staff_agent_ids` null, marks the connection shared so
  new hires are included) or to the named agents. Owner/admin only; a
  member-owned secret is refused (company first: connector connections belong
  to the company, opened with `p_owner_kind = 'company'`). A share re-issues,
  under the caller, grants whose issuer is no longer an owner or admin.
  Since bundle v88 company connections are always shared: sealing one
  (capture completion) shares it with every agent, so this call is only the
  idempotent repair (it issues missing or dead grants, nothing else).
- `qorpera_grant_cloud_secret_operation`
- `qorpera_list_cloud_secret_connections` — since Step 7 also returns
  `accountLabel`, `connectedByUserId` (company-owned only; attribution, not
  ownership), `availableToAllAgents`, `activeGrantCount`, `createdAt`,
  `updatedAt`.
- `qorpera_list_member_native_execution_connections`
- `qorpera_register_provider_connection`
- `qorpera_request_identity_recovery`
- `qorpera_review_identity_recovery`
- `qorpera_revoke_cloud_secret`
- `qorpera_revoke_cloud_secret_grant`
- `qorpera_revoke_native_provider_connection`
- `qorpera_set_provider_connection_status`


### Objects, artifacts, retention (1)

A folder-v2 company keeps its bytes in its company folder and has no artifacts. The artifact registration, index,
retention hold and GC plan functions went with legacy sweep E1 (20260930400000), and the reachability graph and restore
proof functions with E2 (20260930502000).
The raw object reads and uploads by hash and the read lease went with legacy sweep E3 (20260930450000).

- `qorpera_profile_object_writes_allowed`


### Company File (2)

`qorpera_get_company_snapshot` went with legacy sweep E2 (20260930502000).

- `qorpera_company_uses_path_gateway`
- `qorpera_get_company_file`


### Organization and staff (4)

- `qorpera_company_organization_json`
- `qorpera_configure_staff_execution_authority`
- `qorpera_list_profile_staff`
- `qorpera_put_staff_provider_model`

### Company sidebar (2) — bundle v90

- `qorpera_read_company_sidebar(p_profile_id)` → `qorpera.company-sidebar/v1`:
  `sections` (`sectionId`, `name`, in order), `placements` (`staffAgentId`,
  `sectionId` or null for Unassigned, `position`), and the caller's own
  `pinned` (ordered) and `hidden` agent ids. Any member. Since `20260930519000`
  also `unassignedOrder: true`: on folder-v2, `QorperaOS/agents/sections.md` keeps the order
  of Unassigned (its id lines before the first section), and placements with a
  null `sectionId` carry that order. Before it, a folder-v2 sidebar has no
  Unassigned positions.
- On folder-v2 the RPC below refuses section changes and moves (55000,
  `20260928249100`): the web makes them as the member's edits of
  `QorperaOS/agents/sections.md` through the member commit route, and writes the Unassigned
  order only where the sidebar says `unassignedOrder`.
- Each member's own sidebar (`20260930727000`): the company's sidebar is its
  sections file, kept by agents, and it is what a new member sees. Creating,
  renaming and deleting sections and moving agents and group chats through the
  RPC below change the caller's own sidebar only, for any member, viewers too,
  on every company (the 55000 refusal above is gone; the web stops writing the
  sections file). What a member touched is theirs; everything else keeps
  following the company's. The read then gives every agent and open group chat
  an explicit place, marks the caller's own sections `mine: true`, and adds
  `own`: `changes` (a count), `moved` (agent and group chat ids the caller
  placed), `sections` (`{change: added|renamed|removed, name, from?}`),
  `pinned`, `hidden`, `contacts` and `pages` (counts). A client that reads `own`
  knows the cloud keeps each member's own sidebar. `reset {}` takes away all of
  the caller's changes in the company (sections, places, pins, hidden agents and
  group chats, contact places, hidden pages); `undo_reset {}` puts the last
  reset's rows back (P0002 when there is none). A contact place may name one of
  the caller's own sections.
- Each member's own apps drawer (`20260930728000`): the company's groups are its
  file `apps/groups.md`, kept by agents. `qorpera_member_app_layout(p_profile_id)`
  → `qorpera.member-app-layout-read/v1` `{layout, updatedAt}` and
  `qorpera_set_member_app_layout(p_profile_id, p_layout, p_expected)` (whole
  document, QAL01 when `p_expected` is not the last `updatedAt`, 22023 for a shape
  the web never writes; an empty layout leaves no row). The layout is
  `qorpera.member-app-layout/v1` `{places, groups, colours?}` (packages/web/src/cloud/app-groups.ts).
  A place's key is `page:mailbox|members|bank`, `app:<name>`, `concepts`, `sites`,
  `whats-new` (the What's new page, since `20260930729000`) or `group:<id>`.
  `colours` (since `20260930731000`) maps such a key to one of the agents' palette
  colours (`charcoal`, `brown`, `coral`, `orange`, `gold`, `green`, `teal`, `blue`,
  `purple`, `pink`, `gray`), at most 300; a layout with colours alone is kept.
  `emblems` (since `20260930732000`) maps an app's key (no group's) to the icon the
  member picked: a built-in emblem's name or `custom:<id>`, one of the app's own
  icons (`apps/<name>/icons/<id>.svg`, `@qorpera/cloud-client/app-icons`), at most 300.
  Any member. Reset takes it away and Undo puts it back; `own.apps` counts it,
  each colour and each icon as one.
- Light asks (`20260930761000`, deploy/first-node/RUNTIME-LIGHT-ASK.md): one small
  question a member's own action raises, answered by one call to the small model
  with no tools, with nothing shown in a conversation.
  `qorpera_request_light_ask(p_profile_id, p_client_ask_id, p_kind, p_input)` →
  `qorpera.light-ask/v1` `{id, kind, state, answer, problem}`; owner, admin or
  contributor of a folder-v2 company. `p_kind` is a closed list, today
  `name-app-group`, whose `p_input` is `{apps: [{name, about?}], language}`: 2 to
  12 apps, a name of 1 to 80 characters, `about` at most 200, `language` like `en`,
  `da` or `en-GB`; never a prompt (22023 for anything else). `state` is `waiting`,
  `answered` (with `answer`, one line of at most 200 characters) or `failed` (with
  `problem`: `no_payer` when no Codex login of the member's own can pay,
  `unavailable` for a company with no Co-Founder or one that is paused,
  `too_many` at 8 waiting asks, `no_answer`, or `expired` after ten minutes).
  A failed ask is never raised as an error, and `failed` is final: an answer that
  comes after the ten minutes is not kept. In a company that is paused or being
  deleted no ask is kept: the answer is `failed` (`unavailable`) under an id that
  names no row, which reads as null. The same `p_client_ask_id` with the
  same kind and input answers the ask already made (23505 with other content).
  `qorpera_read_light_ask(p_profile_id, p_ask_id)` → the same shape, or null when
  the caller has no ask of that id. The member's own login pays, a ChatGPT plan
  too; no company account does. A cloud before `20260930761000` has neither
  function, and the web then asks nothing.
- `qorpera_manage_company_sidebar(p_profile_id, p_request)` answers the same
  shape after the change. Before `20260930727000`, shared, owner/admin/contributor:
  `create_section {sectionId, name, staffAgentId?, unpin?}`,
  `rename_section {sectionId, name}`, `delete_section {sectionId}` (its agents
  go to the end of Unassigned), `move_agent {staffAgentId, sectionId|null,
  order?, unpin?}`. The member's own, any member: `set_pins {order}` (at most
  24; pinning unhides), `set_hidden {staffAgentId, hidden}` (hiding unpins).
  Section names are 1-60 characters, unique per company ignoring case; any
  number of sections (at most 40 until bundle v95). The Co-Founder is never
  placed, pinned or hidden. Agents change the same shared sections through the
  runtime tool `organize_sidebar`, which saves `QorperaOS/agents/sections.md` (its old row
  writer, `qorpera_manage_agent_sidebar`, was dropped in legacy sweep D6,
  `20260930335000`).
- Group chats (migration `20260928030000`, no bundle): a group chat (an active
  room that is not an agent's thread, with an open conversation) is placed,
  pinned and hidden like an agent, named by `roomId` where an agent is named by
  `staffAgentId`. The read adds `roomPlacements` (`roomId`, `sectionId` or
  null, `position`); agents and group chats share one order per section, and
  `pinned` (at most 24 in all) and `hidden` list both kinds of id. Requests:
  `move_room {roomId, sectionId|null, order?, unpin?}` (owner/admin/
  contributor), `create_section` with `roomId`, and `set_hidden {roomId,
  hidden}`. A client that places group chats sends `groupChats: true` on
  `set_pins` and `move_agent`: its pin row and orders name group chats too.
  Without it the request is taken as one from an older page: its pin row keeps
  the member's pinned group chats (after the agents it names), and each of a
  section's group chats stays after the agent it followed (first if it led; last
  if the order leaves that agent out). A client sees `roomPlacements`
  only where the cloud has this migration. The agent tool still lists and moves
  agents only.
- The same migration: `qorpera_get_session_model` reports `model_id` null for a
  group chat's conversation while no model was chosen (each agent runs its
  own), and a group chat's post takes images like an agent thread's.

### Auto-review rules and approvals (4) — bundle v130

- `qorpera_list_review_rules(p_profile_id)` → `qorpera.review-rules/v1`:
  `canManageCompanyRules` (owner or admin) and `rules`: every active company
  rule plus the caller's own (`id`, `scope` `company|member`, `memberUserId`,
  `when`, `outcome` `ask_first|allow_automatically`, `createdVia`
  `settings|card|agent|folder` (`folder`: a company rule from the company's
  `QorperaOS/rules/` files, folder-v2 companies only), `createdByUserId`, `createdByStaffAgentId`,
  `createdAt`, `updatedAt`). Any member, viewers included. A rule with
  `createdVia: agent` was added by an agent (`createdByStaffAgentId`) when the
  member asked it to: always one of the member's own Ask first rules, which the
  member removes like any other.
- `qorpera_save_review_rule(p_profile_id, p_rule_id, p_scope, p_when,
  p_outcome)`: the client picks `p_rule_id` (a new uuid creates, an existing
  one changes its text or outcome; a retry is the same rule). `when` is one
  sentence, 1-280 characters after trimming. Company rules: owners and admins
  (42501 otherwise); a personal rule belongs to its author only. 54000 when
  the company's rules pass 48 KiB of text or one member's pass 16 KiB (what
  the reviewer reads for one action). Returns the rule. A folder-v2 company
  keeps its company rules in `QorperaOS/rules/` files: saving a company rule there is
  refused with 55000; personal rules are unchanged.
- `qorpera_archive_review_rule(p_profile_id, p_rule_id)`: removes a rule
  (again: no change). Company rules: owners and admins; personal: its author.
  A rule that comes from a `QorperaOS/rules/` file (`createdVia: folder`) is refused with
  55000: delete the file instead.
- `qorpera_answer_action_review(p_review_id, p_client_input_id, p_answer,
  p_rule_text?, p_sponsor_binding_id?, p_sponsor_version?)` answers an approval
  card (`authorization_request` whose `entry.data.schema` is
  `qorpera.action-review/v1`; `p_review_id` = its `reviewId` = the event id).
  `p_answer`: `allow_once | always_allow | deny`. Who may answer is on the
  card: `approverScope` `member` (only `approverUserId`) or `owners_admins`
  (any owner or admin). `always_allow` only where the card says
  `alwaysAllow: true`; it saves `p_rule_text` (the card's `proposedRule`, as
  the member edited it) as a company Allow automatically rule. The answer
  joins the card's conversation as its `authorization_decision`
  (`decision` `approved|declined`, `answer.answer` the exact answer). When the
  agent stopped waiting, the answer also wakes it there on the answering
  member's own account: send the selected execution sponsor as for
  `qorpera_answer_interaction` (42501 `Room sponsor is unavailable` /
  `Session sponsor is unavailable` otherwise; nothing is recorded). 55000 when
  already answered; a retry with the same `p_client_input_id` returns the
  receipt `{reviewId, answer, inputId, savedRuleId, woke}`. The answerer needs
  write access to the card's conversation; in an agent's thread, waking also
  needs an active thread membership. An answer whose delivery failed (its turn
  request refused) may be given again. `qorpera_answer_interaction` refuses
  these cards (22023).

  Card facts (`entry.data`): `title`, `summary` (the reviewer's reason),
  `operation`, `effect` `external|destructive|delegation`, `target`,
  `details` (a few short facts), `tool` + `arguments` (the exact canonical call
  arguments as text, up to 64 KiB) + `call` (the same arguments as a JSON object,
  for the agent to copy; since 20260926210000; show `arguments`),
  `builtIn` (`none|money|legal_terms|delete_outside|access_change|...`),
  `rules` (matched, `{id, scope, when, outcome}`), `approverScope`,
  `approverUserId`, `approverName`, `requesterUserId`, `alwaysAllow`,
  `proposedRule`. Do not answer these cards through
  `qorpera_answer_interaction`: its approval surface is owner/admin-only and
  does not know the review.

  Since 20260930568000 a worker's card (and one from a group chat, or any run
  whose own conversation cannot hold it) is in the agent's own thread; the
  answer wakes the agent there as for any card, and a Deny stands in that
  thread. A member's private conversation keeps its content: a run there, or a
  worker such a run started, raises no card elsewhere.
- `qorpera_list_member_waiting_approvals(p_profile_id)` →
  `qorpera.member-waiting-approvals/v1` (20260930568000): the approval cards
  that wait for the caller's answer, `approvals` of `{staffAgentId, sessionId,
  count, latestAt}`, newest first: the caller's own (`approverScope` `member`)
  and, for an owner or admin, the company's, in their agent's own open thread
  (`sessionId`), which the caller may read. The web shows such an agent as
  "Needs you" while it has no work of its own. Members only (42501 otherwise).
- `qorpera_list_member_waiting_work(p_profile_id)` →
  `qorpera.member-waiting-work/v1` (20260930723000): what each agent's work
  waits on the caller for, `agents` of `{staffAgentId, sessionId, count,
  questions, approvals, latestAt, kind, what}`, newest first: the ask_member
  cards (question, secret, takeover, draft) raised for the caller in the
  agents' own threads and still open, as
  `qorpera_list_member_open_questions` finds them (none for a viewer), and the
  approval cards above. `kind` (the surface, or `approval`) and `what` (the
  card's title or the approval's action title, one line of at most 120
  characters, null when it has none) are the newest item's. The web shows such
  an agent as stopped at the member and counts them in the tab's title.
  Members only (42501 otherwise).

### Company memory (2) — C5, `20260930508000_memory_mode.sql`

Not called by the web since 9 Nov 2026: the Memory section left Settings
(Jonas: Shared context never went live). Every company runs on Agent notebooks;
the RPCs stay for the runtime's gate.

- `qorpera_company_memory_mode(p_profile_id)` → `qorpera.company-memory-mode/v1`:
  `mode` (the company's choice: `notebooks`, Agent notebooks, the default, or
  `tree`, Shared context — Beta), `setAt` (null until first chosen),
  `effective` (what new runs get: `tree` only while the choice is `tree` and
  the beta is offered), `betaOffered` (false: show the beta as unavailable),
  `canManage` (owner or admin), and `runsInOtherMode` (runs made before the
  last change that are still queued or running in the other mode; each
  finishes in its own mode). Any member, viewers included.
- `qorpera_set_company_memory_mode(p_profile_id, p_mode)`: owners and admins
  (42501 otherwise); `p_mode` `notebooks|tree` (22023 otherwise). `tree` is
  refused with 55000 while `betaOffered` is false; `notebooks` always works.
  The same choice again changes nothing. Returns the same object as the read.
  A change applies to runs made after it: a run keeps the mode it was made
  with, also when it resumes. Switching deletes and rewrites nothing.

### Conversations, turns, wakes (13)

- `qorpera_answer_interaction` (2026-09-22, bundle v75): answers a typed card
  the agent raised in the thread. See "Thread interactions" under §6.
- `qorpera_append_session_input`
- `qorpera_approve_session_turn_sponsorship` (refuses since 2026-09-28: a member's login pays only for that member's own work)
- `qorpera_close_shared_session`
- `qorpera_configure_session_execution`
- `qorpera_ensure_staff_session`
- `qorpera_list_session_inputs`
- `qorpera_list_session_turn_requests`
- `qorpera_list_shared_sessions_page`
- `qorpera_list_wake_occurrences`
- `qorpera_read_session_events`
- `qorpera_read_session_events_tail(p_session_id, p_before_sequence, p_limit)` — the newest events below a sequence (the newest overall when null), oldest first, in the shape of `qorpera_read_session_events`, which it runs for its authorization and page check (20260928279410); a thread opens with it and "Show earlier" pages back
- Not an RPC: a conversation's erasure generation, read from its row (`select memory_generation from qorpera_shared_sessions where id = …`, under the table's `authenticated` read grant and its policy `qorpera_can_read_session`; migration `20260928509140`). An erase (`20260930441000`) rewrites an event's body to exactly `{"erased": true}` in place, under its sequence, and raises the generation without touching `updated_at` (so no `sessions` hint): a client that holds events reads them again when the generation differs from the one they reflect, and never lets a copy read before the erase replace the erased one. The web reads it with each full read of a thread.
- `qorpera_request_session_turn_v2`


### Coding sessions (6) — Order 9, part 1 (PR #211)

- `qorpera_list_coding_sessions(p_session_id)` — the coding sessions the agent dispatched from this conversation, each as `qorpera.coding-session/v1` plus `isOwner`; the thread renders each one as a centered system element (the "sandwich": a start line, a collapsible body, a status line) from this view and the session's own events, never from the agent's prose
- `qorpera_read_coding_session(p_worker_id, p_after_event, p_limit)` — the session view plus its event stream (`phase`, `step`, `text`, `needs_input`, `input`, `delegated`, `published`, `finished`, `failed`), cursor on the event id. A `failed` event of a turn that stopped at its login's usage limit carries `usageLimit: true` and `paidByChatgptPlan` (whether a member's ChatGPT plan paid; 20260928379930): tell it as a usage limit, never as a refusal
- `qorpera_answer_coding_session(p_worker_id, p_text, p_client_request_id)` — owner only; idempotent on the client request id; refused while the session is working
- `qorpera_delegate_coding_session(p_worker_id, p_client_request_id)` — owner only; "let the agent decide" a question the session asked
- `qorpera_list_coding_session_logins(p_worker_id)` — owner only; `qorpera.coding-session-logins/v1`: `current` (the connection the session pays with and its `state`: `ready`, `removed`, `disabled`, `needs_sign_in`, `not_allowed_away`, `unavailable`) and `logins`, the owner's logins that may pay for it (`connectionId`, `email`, `current`: the session pays with that very version and can). The session view carries the same `loginState` and the last turn's `reason`; a failed turn's `failed` event carries it as `code` (20260930551000)
- `qorpera_choose_coding_session_login(p_worker_id, p_connection_id)` — owner only; moves the session to one of those logins from its next turn (refused while a turn runs, 55000; a login that cannot pay, 22023); records a `step` event `{loginChosen: true, from, to}`; answers the session view. Nothing moves a session by itself (20260930551000)

### Execution, sponsors, runners, computers (27)

- `qorpera_cancel_runner_job`
- `qorpera_cancel_worker_run(p_run_id)` — a member's Stop of an in-house worker's own run (no conversation), by run id: the job's creator (the member whose work dispatched the worker) or an owner or admin, through `qorpera_cancel_runner_job`; returns the control below (20260930002800)
- `qorpera_configure_runner_model_policy`
- `qorpera_create_execution_sponsor_binding`
- `qorpera_create_member_execution_sponsor`
- `qorpera_create_runner_registration`
- `qorpera_enqueue_execution_run`
- `qorpera_enqueue_runner_job`
- `qorpera_get_worker_run_control(p_run_id)` — `{run_id, status, can_cancel}` of an in-house worker's own run, for any member who can read the company; `can_cancel` is the Stop's rule (20260930002800). A `run_no_progress` member notice names such a run with `worker: true`
- `qorpera_get_execution_run_recovery` — with `usage_limit` (the run's login reached its usage limit) and `paid_by_chatgpt_plan` (a member's ChatGPT plan pays for the run; tell its limit in OpenAI's words with "Manage usage", to the member whose plan it is: `run.requested_by_user_id`, whom a plan-paid run always serves; 20260928379930)
- `qorpera_list_compute_identities`
- `qorpera_list_execution_run_recoveries`
- `qorpera_list_runner_audit`
- `qorpera_list_runner_jobs`
- `qorpera_list_runner_model_usage`
- `qorpera_list_runner_usage`
- `qorpera_list_runners`
- `qorpera_list_staff_execution_activity`
- `qorpera_reissue_runner_activation`
- `qorpera_resolve_failed_execution_run`
- `qorpera_resolve_run_operation_receipt`
- `qorpera_revoke_runner`
- `qorpera_set_execution_sponsor_status`
- `qorpera_set_logical_computer_status`
- `qorpera_upsert_logical_computer`
- `qorpera_upsert_member_compute_identity`
- `qorpera_upsert_scoped_compute_identity`


### Accounts, profiles, membership (19)

- `qorpera_accept_profile_invitation`
- `qorpera_accept_profile_invitations`
- `qorpera_can_authorize_profile`
- `qorpera_can_read_profile`
- `qorpera_can_write_profile`
- `qorpera_cancel_profile_invitation`
- `qorpera_decline_profile_invitation`
- `qorpera_delete_hosted_profile`
- `qorpera_get_account_entitlement`
- `qorpera_invite_profile_member`
- `qorpera_leave_hosted_profile`
- `qorpera_list_hosted_profiles`
- `qorpera_list_profile_invitations`
- `qorpera_member_role`
- `qorpera_profile_team_info`
- `qorpera_remove_profile_member`
- `qorpera_retry_profile_invitation_delivery`
- `qorpera_session_profile_id`
- `qorpera_update_profile_member_role`

### Founding lobby (20260928248200_company_founding_lobby)

A founding team starts one company together. The table is a company row with
its members and an empty company folder (no seeded files); nothing else exists
until Start (no Co-Founder or first run), so no agent runs and nothing is
charged before it (20260930010000).

- `qorpera_company_founding_available()` → boolean. True since P39
  (20260930031000): new companies start at a founding table on the company
  folder. False is the rollback: opening or starting a table is then refused
  (`0A000`), and the hub says creating a company is paused. The hub has no
  other way to create a company.
- `qorpera_open_company_founding(p_client_creation_id, p_company_name)` opens
  a table with the caller's seat; repeat-safe per creation id. Needs a
  confirmed email. A creation id that already belongs to a company that is not
  a table is refused (`23505`).
- `qorpera_read_company_founding(p_profile_id)` → `qorpera.company-founding/v1`:
  `companyName`, `vision` (the description draft), `phase` (`open`,
  `started`), `revision`, `seats` (`userId`, `displayName`, `state` `invited` or
  `joined`, `role`, `ready`, `modelLoginReady`, `modelLoginUsedUp`, `modelLoginResetsAt`, `creator`), `waitingFor`, `me`
  (`state`, `canEdit`, `canManage`, `canStart`) and `start` (`startedAt`,
  `startedByUserId`, `revision`, `clientStartId`, `companyReady`,
  `companySetup`, `firstRun`) once started. `companySetup` is `pending` while
  the company is set up, `ready` once it is (then `companyReady` is true), or
  `failed` when setup stopped and waits for Qorpera, or the company was deleted
  before it was set up; a failed setup keeps the company hidden. `firstRun`
  (20260930039000) is how the Co-Founder's first run stands once the company is
  made: `queued` (its turn request waits for a run), `started` (a run took the
  kickoff, whatever that run's outcome), `waiting_for_login` (no login of the
  starter could pay when the company was made, so nothing was queued), `failed`
  (the request or the kickoff failed, or the request was cancelled), or null
  before the company is made.
  20260930579000: `modelLoginReady` is true when the founder has a live login
  of their own in the company, at any usage; `modelLoginUsedUp` when every one
  of them is at its usage limit, with `modelLoginResetsAt` the first reset
  (null when unknown). Ready and Start accept a used-up login: the first run's
  payer is then the starter's own used-up login (one with room comes first),
  and its turn request waits queued until that login has room.
  `start.firstRunWaitsUntil` is when such a waiting first run goes on (null
  when it does not wait).
  Anyone with a seat, invited or joined, may read it; after Start only founders
  who are still members.
- `qorpera_list_company_foundings()` → the caller's open tables and
  invitations, and started tables whose company is not ready yet.
- `qorpera_update_company_founding(p_profile_id, p_expected_revision,
  p_company_name, p_vision)`, `qorpera_set_founder_role(p_profile_id,
  p_expected_revision, p_role)` (at most 300 characters) and
  `qorpera_set_founder_ready(p_profile_id, p_expected_revision, p_ready)`.
  A stale revision is `PT412`. A name is refused (`22023`) as Open and the
  seed refuse it: more than 120 characters, a control character or line
  separator, or nothing but spaces (20260930039000). Ready needs the caller's
  own usable ChatGPT
  account (`55000` otherwise; a missing `p_ready` is `22023`) and holds only
  for that revision: a change to the name, description, a role or who sits at
  the table clears every Ready.
- `qorpera_invite_company_founder(p_profile_id, p_friend_user_id)`: any joined
  founder invites an accepted friend of their own; at most eight seats
  (`54000`). `qorpera_respond_company_founding(p_profile_id, p_accept)` (needs
  a confirmed email): joining makes the caller a contributor until Start;
  declining returns `{"state":"declined"}`.
- `qorpera_remove_company_founder(p_profile_id, p_user_id)`: your own seat
  (returns `{"state":"left"}`), an invitation you sent, or, for the table's
  creator, any other seat. Invitations a leaving founder sent go with them.
  The creator, the table's only owner, closes it with
  `qorpera_delete_hosted_profile`; the web offers that once they sit there
  alone.
- `qorpera_start_company_founding(p_profile_id, p_expected_revision,
  p_client_start_id)` (needs a confirmed email): any joined founder, once every
  joined founder is Ready with a usable account of their own. One step, repeat-safe: every founder at
  the table becomes `owner`, unanswered invitations are withdrawn, and the
  description and roles become the company's first files (`QorperaOS/vision/vision.md`
  and the Co-Founder's first todo). The first run is paid by the caller's own
  account, read again when the company is set up: with no usable account then,
  the Co-Founder's first run waits until its starter starts it
  (`qorpera_start_agent_first_run`).
- While a table is open, members join only through a seat, email invitations
  are refused and roles do not change; `qorpera_list_hosted_profiles` leaves it
  out, and after Start until `companySetup` is `ready`. The founder who pressed
  Start cannot leave or step down while setup is `pending` (`42501`, as for any
  company being set up); a `failed` setup holds nobody.
- A company name is one line: opening a table, or starting one, with a name
  that holds a control character or a line separator is refused (`22023`);
  rename the table, then start it.

### Mentions (20260928010000_runtime_room_mentions)

- The cloud reads mentions from a room post's text: "@" at the start or after a
  space, an opening bracket or a quote; a room member's or agent's name; then the
  end, a space or punctuation. Only A-Z fold case and every Unicode space counts as
  a space (`qorpera_mention_fold`), so the rule does not depend on the database's
  locale. Longer names first; everyone who shares a name named is named. Clients
  follow the same rule (`packages/web/src/ui/mentions.ts`, `mentionFold`) to
  suggest names and say who will answer.
- `qorpera_post_company_room_message` is unchanged in shape. A post that names
  agents wakes only those agents; a named agent's room wake has a required
  reply. A post that names no agent wakes every agent in the room, as before.
- `qorpera_list_member_mentions(p_profile_id)` → `qorpera.member-mentions/v1`:
  the caller's unseen mentions by conversation (`sessionId`, `count`,
  `latestAt`). `qorpera_mark_member_mentions_seen(p_session_id)` marks the
  caller's mentions in a conversation seen. The author is never told about
  their own post.

### Quotes in a member's message (20260928459100_member_message_quotes)

Contract: the 2026-10-02 amendment "quoted outside content in a member's message" (step I5d, part 1).

- A `qorpera.session-prompt/v1` body may carry `quotes`, a list of 1 to 16 spans `{start, end, source, ref}` of its
  `text`, both for `qorpera_append_session_input` (and the turn requests that call it) and for
  `qorpera_post_company_room_message`.
  - `start` and `end` are whole numbers counting characters (Unicode code points) from 0, with `end` excluded.
  - Each span sits just inside « and »; spans are in order, apart, and 1 to 2,000 characters long.
  - A quote's words hold neither « nor » (20260928489300_member_quote_words_hold_no_marks): a quote is always «words»,
    with no marks inside, so quotes never nest or cross. Such a quote is refused (22023) on every path that takes
    quotes, room drafts included, and room drafts stored with one were deleted. A client treats a draft whose quotes
    it can't read as absent: it shows none of its text, and the owner's next save replaces it.
  - `source` is `mail`, and `ref` is a thread id that `qorpera_member_mail_thread` shows the member, never account
    mail.
  - A body with `quotes` carries no `displayText`. Leave `quotes` out when there are none: an empty list is refused.
- Every refusal is 22023, after the membership and write checks and before any lock. An unknown, foreign or
  account-mail `ref` reads the same way, whether or not it exists.
- The transcript entry shows the text as sent and carries the list as `qorperaQuotes`.
- A name inside a quote names nobody: room mentions read the member's own words. A client that says who will answer
  (`mentionFold`) folds each quote to its placeholder first.
- Quotes are refused (22023) in a company whose runs can't fence them: an environment that is neither folder-v2 nor
  on the company path (`20260928469160_member_draft_quotes`).
- Room drafts keep their quotes: `qorpera_put_room_draft(p_room_id, p_owner_user_id, p_base_revision, p_body,
  p_quotes?)` checks `p_quotes` as a message's quotes and stores them, and `qorpera.room-draft/v1` carries `quotes`
  when the draft has any. Once a draft holds quotes, a save that keeps a quote's words without its record (in their
  marks, at that place), or changes them, is refused (22023); removing a quote whole is an ordinary save, and the
  member's own guillemets stay theirs.
  - A client that knows quotes and has none left sends `p_quotes = []`, which the draft stores as none (only the
    draft call takes an empty list). So removing the last quote and writing the member's own marks in one save is
    ordinary.
  - The server finds a kept quote by its words: own marks around the same words as a quote need that quote's record
    too, so a composer records both or folds its own marks.
  - A client that sends four arguments still reaches the function, but such a text-only save may bring no newly
    marked words while the draft holds quotes.

### Computer hours (20260928248000_runtime_computer_hours_meter)

- Contract: section 19, 2026-09-28 amendment "computer hours"; design
  `deploy/first-node/RUNTIME-COMPUTER-HOURS.md`. This step measures only:
  nothing is charged or stopped.
- `qorpera_read_company_computer_hours(p_profile_id, p_month date default
  null)` → `qorpera.company-computer-hours/v1`: `profileId`, `month`
  (`YYYY-MM`, the calendar month in `timeZone` `Europe/Copenhagen`; default
  the current one), `usedStandardSeconds` (whole standard seconds; one
  computer hour = 3600), `byKind` (`companyMachines`, `agentMachines`,
  `codingMachines`, `runs`, standard seconds rounded per kind, so their sum
  may differ from the total by a few seconds), `awakeNow` (the same kinds,
  counted now), `meteredUntil` (the meter counts up to about a minute
  ago) and, from 20260928249200, `waitingForHours` (true while the zero rule
  holds the company's new work: show "Waiting for computer hours"). Any
  member of the company, viewers included; anyone else gets 42501. While
  the rule holds a company, `qorpera_enqueue_execution_run` and
  `qorpera_enqueue_runner_job` refuse new work with 55000 ("Waiting for
  computer hours: the company has none left").
  A client shows "Not measured yet" while the function is missing (PGRST202).
  From 20260928259330, `hoursLeft`: null before the live switch (show measured
  hours only); `{"complimentary": true}` for a company that is never limited;
  otherwise `leftSeconds` (zero or less when out of hours, below zero by what
  it owes) with `freeSeconds`, `planSeconds` (the founders' current plans,
  each shared by every company it pays for), `creditSeconds` and
  `owedSeconds`. A founder reading it also gets `founders`: each founder's
  `userId`, with `planSeconds` and `creditSeconds` where they have them (who
  pays), and, with `userId` null, the packs of members who are no longer
  founders; other members never see who paid. `hoursLeft` is always now,
  whatever month is read.
  From 20260928259280, `qorpera_company_waiting_for_hours(p_profile_id)` →
  boolean says the same as `waitingForHours` without the month's figures,
  for a client that asks with its other periodic reads (any member; anyone
  else gets 42501). A client treats a missing function (PGRST202) as not
  waiting and stops asking.

- 20260928248910_runtime_computer_hours_payments:
  `qorpera_list_computer_hour_offers()` → `qorpera.computer-hour-offers/v1`:
  `items` (`itemKey`, `kind` `plan` | `credits`, `name`, `priceMinor` in
  øre excluding VAT, `currency` `dkk`, `hours`: a plan's hours a month or a
  pack's hours, `available`: whether it is on sale to this member now; credits
  still need a founder of the company, and a member who already has a plan
  changes it on Stripe's billing page, both of which checkout checks). Before live
  payments only test accounts an operator enrolled see anything available, in
  Stripe's test mode; a client shows an item that is not available as not for
  sale. Any signed-in member.
  `qorpera_read_my_computer_plan()` → `qorpera.my-computer-plan/v1`: `mode`
  (`dry_run` until live payments), `plan` (null, or `itemKey`, `status`,
  `periodStart`, `periodEnd`, `cancelAtPeriodEnd`) and `hours` (null until
  live payments, since members see only measured hours before then; then
  `grantedSeconds` this period and `companies` (`profileId`, `seconds` this
  period paid by the plan)). The signed-in member's own plan only.

### Event hooks (20260928259260_runtime_event_intake)

- Contract: section 19, 2026-09-29 amendment "events wake agents"; design
  `deploy/first-node/RUNTIME-EVENT-INTAKE.md`, and on the folder core
  `deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md`. Since
  20260928489180_folder_core_hooks_mailboxes (E1) a `folder-v2` company
  creates, pauses and removes hooks and mailboxes with these same calls; its
  folder describes each in `QorperaOS/connections/hook-<name>.md` or
  `QorperaOS/connections/mailbox-<name>.md`, never with its address or a signing
  secret. The intake is built switched off.
- Settings (step E4, `packages/web/src/app/views/settings-hooks.ts`): Company
  connections lists the company's webhooks and mailboxes to every member, each
  with its name (a mailbox by its `email`), purpose, status and last delivery.
  Owners and admins also see a webhook's URL to copy, add address-proven
  webhooks (`p_proof` `address`) and mailboxes, and pause, resume or remove
  them. Settings never adds a signed hook: its signing secret would have to
  be pasted, and members never paste a secret (agents open signed hooks,
  E3b and E3c).
- `qorpera_create_event_hook(p_profile_id, p_environment_id, p_name,
  p_purpose, p_proof default 'address', p_max_body_bytes default null,
  p_per_minute default null)` → `qorpera.event-hook/v1`: `id`, `companyId`,
  `environmentId`, `name` (`^[a-z][a-z0-9-]{0,63}$`, unique among the
  live hooks of the company environment), `purpose` (one line), `proof`
  (`address`, or from W1b `stripe`, `github` and `hmac-sha256`; signed hooks
  below), `status` (`active`), `address` (43 characters), `path`
  (`/functions/v1/event-intake/<address>`: the sender posts to the Supabase
  URL plus this path), `maxBodyBytes` (1024–262144, default 65536),
  `perMinute` (1–120, default 60), `createdAt`, `lastReceivedAt` (absent
  until the first delivery). Owners and admins only (42501); 23505 for a
  name in use, 54000 past 50 live hooks, 22023 for a bad environment, name
  (names beginning `mail-` belong to mailboxes, from 20260928299650),
  purpose, proof or limit. From 20260930280000 (E4b) a `folder-v2` company
  then refuses a `stripe`, `github` or `hmac-sha256` proof with 0A000 ("A
  signed hook is opened through the vault"; until 20260930344000, E3c-1, a
  `stripe` one got "A Stripe hook comes later: its secret is taken from
  Stripe's screen") and makes nothing: its signed hooks are opened by agents
  through the vault (E3b, E3c).
- `qorpera_set_event_hook_status(p_hook_id, p_status)` with `active`,
  `paused` or `removed` → the same descriptor. Removing is final (55000
  afterwards) and frees the name. Owners and admins only.
- `qorpera_list_event_hooks(p_profile_id, p_environment_id)` → an array of
  descriptors of live hooks, by name. Any member; `address` and `path` only
  for owners and admins.
- `qorpera_list_event_deliveries(p_hook_id, p_limit default 50)` → the
  newest deliveries (at most 200): `id`, `receivedAt`, `status` (`received`,
  `verified`, `refused`, `duplicate`), `deliveryKey`, `eventType`,
  `contentType`, `bodyBytes`, `bodySha256`, `verifiedAt`, `reason`. No
  bodies. Owners and admins only.
- Signed hooks (20260928409980_runtime_event_signed_hooks, step W1b): the
  descriptor of a `stripe`, `github` or `hmac-sha256` (Standard Webhooks,
  also Svix's headers) hook carries `signingSecret` (`connectorId`
  `event_hook`, `secretName` `h<hook id without hyphens>`, `ready`). From
  20260930344000 (E3c-1) a `stripe` hook's `signingSecret` also carries, once
  the vault has its secret, `version` (the current one), `capturedAt` (when
  that version was stored) and, if a delivery was refused under that
  version, `lastRefusal` `{receivedAt, reason}` (the newest one). From
  20260930345000 (E3c-4) a `stripe` hook whose signature did not match under
  a version no delivery verified under is held: it answers senders
  `not_ready` until the next capture, `ready` stays true, and `lastRefusal` is
  that delivery's `receivedAt` with the reason "held: the captured secret does
  not match". A `github` or `hmac-sha256` hook's keeps exactly `connectorId`,
  `secretName` and `ready`, and so does a `stripe` hook's before its first
  capture. On a
  snapshot-v1 company an owner or admin saves the sender's signing secret with
  `qorpera_begin_cloud_secret_capture(company, environment, 'company', null,
  'event_hook', secretName, purpose)` and then
  `POST <serviceOrigin>/v1/captures/<ticketId>?company=<profileId>` with
  `{"schema": "qorpera.cloud-secret-capture-request/v1", "captureCapability":
  <the ticket's captureCapability>, "fields": {"signing_secret": "<secret>"}}`
  (exactly these keys); passing the existing secret id to the begin call
  replaces it. From 20260930280000 (E4b) a `folder-v2` company refuses the
  `event_hook` connector in that begin call with 0A000 ("A hook's signing
  secret comes from the vault"), after its own checks: the vault makes or
  takes the secret when an agent opens the hook (E3b, E3c), and no member
  pastes one. An `hmac-sha256` secret is a Standard Webhooks one
  (`whsec_<base64>`). Until `ready` is true the hook answers senders
  `not_ready`. A signed delivery is listed `received` until the vault checks
  it (seconds), then `verified` with `deliveryKey` (an id the signature
  covers: Stripe's event id, `webhook-id`, or for GitHub `sig:<signature>`)
  and `eventType`, `duplicate`, or `refused` with a fixed `reason` ("The
  Stripe signature does not match"). Removing the hook revokes its secret.

### Company mailboxes (20260928299650_runtime_company_mailboxes)

- Contract: section 19, item 9; design `deploy/first-node/RUNTIME-EVENT-INTAKE.md`, "Mail (M2)". Step M2a:
  receiving only; `folder-v2` companies since E1 (20260928489180). Company mail is built switched off, and no mailbox can be made
  until operators set the platform's mail domain.
- `qorpera_create_company_mailbox(p_profile_id, p_environment_id, p_local_part, p_purpose)` → the hook
  descriptor (`qorpera.event-hook/v1`) of the mailbox's hook: `proof` `mail`, `name` `mail-<local part>` (with a short digest suffix when
  the local part holds a dot or an underscore), and
  `email` (`<local part>@<mail domain>`); never `address` or `path`. The local part is 1–64 lowercase letters,
  digits, dots, hyphens and underscores, with no leading, trailing or doubled dot; RFC 2142 names
  (`postmaster`, `abuse`, …) and `noreply` are reserved (22023). An address belongs to one live mailbox across
  the platform (23505 when taken). The domain is one platform setting: a mailbox keeps only its local part, so
  `email` always shows the current domain. Owners and admins only (42501); 54000 past 20 mailboxes or 50 hooks;
  0A000 before the mail domain is set.
- A mailbox is paused, resumed and removed with `qorpera_set_event_hook_status` on its hook; removing frees
  its address. `qorpera_list_event_hooks` lists mailboxes with their `email` for every member, and
  `qorpera_list_event_deliveries` their received messages (`eventType` `mail.received`).
- Plus addresses (20260928429982_runtime_company_mail_find_and_tags): `<local part>+<tag>@<mail domain>` reaches the
  mailbox, for a tag of lowercase letters, digits, dots, hyphens and underscores (the whole local part at most 64
  characters); mailboxes show only their own `email`. A received mail's delivery keeps `delivered-to`, `from`,
  `subject` and `authentication-results` headers. Agents find received mail with the runtime tool `find_mail`; there
  is no client surface.
- Sending (20260928309740_runtime_company_mail_sending, step M2b): agents send from a mailbox with the runtime
  tool `send_mail`; a member's own send is "Members send mail", below. Sent email is queued in `qorpera_company_mail_outbox` (closed
  to every API role) and sent by the `mail-outbox` Edge Function. Sending has its own switch in
  `qorpera_mail_settings` (`sending`, built off) and the company limits on recipients `company_hourly_recipients`
  (60) and `company_daily_recipients` (300). Received mail (`mail.received`) now also carries `autoSubmitted`,
  `precedence`, `listId` and `automated`; agents never answer automated mail.
- Sender names (20260928319810_runtime_company_mail_sender_names): `qorpera_create_company_mailbox` also reserves
  (22023) any local part that reads as Qorpera (case, separators, accents, full width and look-alike letters or
  digits folded), and no email goes out when the agent's, the sending member's or the company's name or the mailbox
  reads as Qorpera.
- Attachments (20260928429984_runtime_company_mail_attachments, step M2c-1): agents attach company files to
  `send_mail`; there is no client surface. Saving a received email's attachment (the runtime tool `save_attachment`)
  served only snapshot-v1 companies: C-P4 removed the tool, and legacy sweep D4 (20260930333000) dropped its request.
  Legacy sweep D7 (20260930336000) dropped the fetch lane behind it: the fetch table, the worker's functions and the
  `mail-attachments` Edge Function.
- Members read mail (20260928439980_runtime_company_mail_member_read, step I5a; for the Mailbox): any member calls
  `qorpera_member_mail_addresses(p_environment_id)`, `qorpera_member_mail_threads(p_environment_id, p_request)`
  (`{address?, state?, direction?: "received" | "sent", before?: {lastAt, thread}, limit ≤ 50}` →
  `{threads, nextBefore?}`; `direction`, 20260930512000, keeps the threads whose newest message went that way),
  `qorpera_member_mail_thread(p_environment_id, p_thread, p_before?)` (`{thread, address, messages, more?, nextBefore?,
  waiting}`: the newest 50 messages, oldest first; while `more`, `nextBefore` is `{at, kind, id}`, and given back as
  `p_before` (20260930512000) the answer is the 50 before it),
  `qorpera_member_mail_waiting(p_environment_id)` and `qorpera_mark_mail_thread_read(p_environment_id, p_thread)`.
  Answers are camelCase JSON and empty while mail is off; a non-member gets 42501 and an unknown thread 22023. A
  thread id is 43 base64url characters. Account mail carries `account` (`{accountId, site, lastUsedBy, lastUsedAt}`, or `{unknown: true}` while the account lookup fails) and no subject, text, recipients or attachments. A waiting send is
  answered through `qorpera_answer_action_review` with its `reviewId`. Since 20260930002660 a waiting send the member
  may answer also carries `sessionId`, the card's conversation: the card waits for this member, or for owners and
  admins and the member is one, and the member can write that conversation. Without `sessionId`, show the send without
  a way to answer it. With it, the answer can still be refused (a closed conversation, a paused company, a folder-v2
  card outside an agent thread); show that error.
  Since 20260930522000 each thread of `qorpera_member_mail_threads` may carry `snippet`, the start of its newest
  message's text on one line (at most 200 characters; never for account mail; absent once the text is no longer kept),
  and each send of `qorpera_member_mail_waiting` may carry `snippet`, the start of the text the agent wants to send,
  and `cc`, its cc recipients as the agent gave them.
  Both are outside words to show as text only; a client must also work without them.
- Members send mail (20260930716000_member_mail_send, step M2e; founder decision, 10 November 2026): a member who
  may write in the company (owner, admin or contributor) calls
  `qorpera_send_member_mail(p_environment_id, p_request)` with `{sendId, from, to, cc?, subject, text}` →
  `{mailId, thread, status}`. `sendId` is a UUID the client makes for the send and keeps while it retries: the same
  member's same id again answers with the email already queued (its `status` then `queued`, `sent`, `failed` or
  `cancelled`) and sends nothing twice. `from` is one of the company's mailbox addresses, or its name alone; `to` is
  1 to 10 plain addresses and `cc` up to 9, 10 together; `subject` is one line of 1 to 200 characters; `text` is 1
  to 20,000 characters of plain text, sent as written. The email goes out from "<member> at <company>" with no AI
  line, begins a thread of its own, and is every member's to read. Errors: 42501 for a non-member ("Company mail is
  unavailable"), a viewer, a mailbox that is not the company's, the company's own mailboxes as recipients, or a
  name that reads as Qorpera; 22023 for a request of another shape; 0A000 while the mailbox is paused or sending is
  switched off; 54000 past the company's hourly or daily limit on recipients, with when the email can go. Show the
  error's message. No attachments yet. With `replyTo` (20260930740000_member_mail_reply; Jonas, 12 November 2026),
  `{kind, id}`, the email answers a message of a thread as `qorpera_member_mail_thread` names it: `kind` `received`
  with that message's `deliveryId`, or `sent` with its `mailId`. It then joins that thread (`thread` in the answer is
  the answered message's) and carries the message's ids, so the other side's mail program threads it; `from`, `to`,
  `cc`, `subject` and `text` are still the client's to give (the sender for a reply, "Re: " before the subject).
  42501 "The email this answers is not one the company can answer" for a message that is not this company's, is no
  longer kept or is account mail; 22023 for a `replyTo` of another shape, and from a cloud before this migration. A
  forward is a new email without `replyTo`. From the same migration a received message of
  `qorpera_member_mail_thread` carries `replyTo` (a different thing: the addresses its Reply-To header names, at most
  10, while its stored message is kept; absent otherwise and for account mail): a reply goes to them, and to
  `fromAddress` when there are none. Outside words, to show as text only. In `qorpera_member_mail_thread` a sent
  message a member sent themself carries `member` (`{userId, name?}`; the name is theirs in the company now, absent
  once they have left) and no `staffAgent`; in `qorpera_member_mail_threads` a thread whose newest message is such
  an email carries `sentBy`, the same shape.


### Digital Post (20260930529000_digital_post_sync)

- Design `deploy/first-node/RUNTIME-DIGITAL-POST.md`. A company's public post (Danish Digital Post) reaches the company
  folder through the company vault: an owner or admin saves the API key of the company's Digital Post recipient system
  with the vault's capture (`qorpera_begin_cloud_secret_capture`, `owner_kind` `company`, connector `digital_post`,
  secret name `primary`, one field `api_key`). The vault seals only a key that reads as one (the Basic credential of
  the system's id and its key) and labels the connection with the system id; anything else fails the capture. A new
  key replaces the old (`p_existing_secret_id`); Disconnect is the secret's revoke, as for every connection.
- `qorpera_member_digital_post(environment)` → `{schema: "qorpera.member-digital-post/v1", connected, status,
  secretId, supplier, systemId, fetchedAt, lastError, letters, waitingForFolder, held}` for any member of the company
  (viewers too; 42501 for anyone else). `secretId` is the connection's secret while connected (a new key passes it as
  `p_existing_secret_id`; Disconnect revokes it). `supplier` is `{environment, cvr, addresses}`, what the setup steps
  show: `test` or `production`, Qorpera's CVR and the vault's public addresses, or null until operators set
  `qorpera_digital_post_settings`, and then Digital Post can't be connected yet. `status` is `waiting` (connected, not fetched yet), `current`, `failed` (tried again; `lastError`
  says why in a fixed phrase), `refused` (Digital Post refused the key: connect again) or `disconnected`. `letters`
  counts the letters kept, `waitingForFolder` those not yet in the folder, `held` the letters of the last eight days
  the vault could not take (Digital Post moves them to the Virk mailbox).
- The letters, their staged files and the sync are closed to every API role; the vault reaches them through its own
  functions.
### Account model logins (20260930548000_account_model_login)

Built switched off (`qorpera_account_model_login_settings`). A member's Codex sign-in in a company the shared vault
serves is kept once for the member and used in every company of theirs that the vault serves; each company still has
its own ordinary connection for it, so the connection list, usage and Disconnect work as before.

- `qorpera_list_account_model_logins(profile)`: `{schema: "qorpera.account-model-logins/v1", enabled, logins}`, the
  caller's own account logins (members of the company only). `enabled` says whether sign-ins in this company are
  account sign-ins now (the switch is on, the shared vault serves the company and the company takes sign-ins in the
  vault; the last since `20260930554000`). Each login has `loginId`, `loginKind`, `status` (`active` or `needs_sign_in`),
  `providerAccountEmail`, `createdAt`, `companies` (how many companies use it) and `connectionIds` (its connections
  in this company). Label those connections "Used in all your companies"; their Disconnect only stops using the login
  in this company (it is never linked there again until the member signs in again).
- `qorpera_sign_out_account_model_login(login)`: Sign out everywhere. Only the login's member; every company's
  connection for it is revoked as Disconnect does, and the login is ended. Answers
  `{schema: "qorpera.account-model-login-sign-out/v1", loginId, status: "revoked", companies}`.

### ChatGPT plan reads (20260928369970_runtime_chatgpt_plan_member_reads)

Built switched off with plan logins. Show none of it while plan logins are switched off for the company
(`qorpera_chatgpt_plan_available` is false) or the member has no plan login.

- `qorpera_list_member_native_execution_connections`: each connection also has `login_kind` (`codex` or
  `chatgpt_plan`; null for a node login), `allow_autonomous` (whether its member turned on work while away for
  this version) and `routine_offer_shown_at` (when the member's first-routine card was shown in this company;
  null until then; the same on every entry of the member's list, so read it from a plan login's entry). Label
  a `chatgpt_plan` connection
  "ChatGPT plan". Never consent a plan login on the member's behalf: its "Work while you're away" switch calls
  `qorpera_set_chatgpt_plan_work_while_away` (the consent call alone refuses a plan, 20260928369980). Codex
  logins keep today's behaviour.
- `qorpera_record_chatgpt_plan_routine_offer(profile, connection)`: records that the first-routine card was shown
  to the caller, for their own active plan login (members only; not in a company being deleted). Shown once per
  member and company: a repeat, also on a later plan login after a new sign-in, answers the first showing
  (`{connection_id, shown_at}`), and "Not now" never brings the card back. 42501 for a connection that is not the
  caller's own active one in that company, 22023 "Not a ChatGPT plan login" for any other login.
- `qorpera_list_cloud_routines`: each routine also has `pause_reason` (for example `needs_model_account`, a
  routine that waits for a payer) and `runs_for_user_id` (the member its current version runs for: that
  version's creator). When its current version is a resume (20260928369985), `resume_reason` is
  `plan_turned_on`, `resumed_by_user_id` the member who turned on work while away and `resumed_at` when; all
  three are null for any other version, so a later save clears them. No new version is a resume since the legacy
  sweep's F3a (20260930294000). Show it as "Resumed when <member> turned on
  work while away".

- `qorpera_get_routine_payer(p_routine_id)` and `qorpera_set_routine_login(p_routine_id, p_connection_id)`
  (20260930095000, folder-v2 routines; the payer never changes without permission). Get answers
  `{schema: 'qorpera.routine-payer/v1', routineId, routineVersion, status, pauseReason, connectionId,
  payer: 'member'|'company'|null, payerUserId (null for a company account), savedByUserId (the member the routine
  runs for), canPay, waitsFor: 'login'|'usage_limit'|'sign_in'|null, since, changedByUserId,
  changeReason: 'save'|'pick'|null}` to a member who may read the
  routine's file. `payer` and `connectionId` are null when the routine's binding names no login any more (show no
  "Paid by" line); `changedByUserId` and `changeReason` are null until a save or a pick has changed the payer, and
  `since` is then when the routine was made. `canPay` is whether the login can pay now; `waitsFor` says why not:
  `login` (the routine waits as `needs_model_account` until someone picks one), `usage_limit` (the routine keeps the
  login, and its runs stop until the limit resets) or `sign_in` (its member must sign in to it again in Settings);
  null when `canPay`. Show "Paid by <member or the company> since <since>", with that reason, and when `canPay`
  is false a "Choose a login" control: set picks one of the caller's own
  logins (the caller becomes the routine's saver; any member who may write the routine's file) or, for an owner or
  admin, a company account (the saver stays), and answers the same shape. Set never consents a login: bind it for
  work while away first (the editor's consent-and-bind step), else it answers 22023.
  A routine that waited runs again. Refusals: 42501 "Routine is unavailable" (not a member who may write the
  routine's file, or a retired routine), 42501 "This login cannot pay for this routine" (another member's login, or
  a company account picked by a contributor), 22023 "This login cannot pay for this routine" (a login that cannot
  pay for work while its member is away now), 22023 "This login has reached its usage limit", 22023 "This login needs
  a new sign-in", 42501 "A ChatGPT plan cannot pay for a listener" (a plan for a routine with any trigger other than a
  schedule or a single time, such as a file change), 55000 "Company execution is paused" (the company is stopped or
  being deleted; nothing changed).
- Member notification `routine_payer_changed` (subject `qorpera.member-notification.routine-payer-changed/v1`:
  `routineId, routineVersion, staffAgentId, payer ('member'|'company'), payerUserId, changedByUserId (null when no
  member made the change), reason ('save'|'pick'), at`): the member whose login paid for a routine before someone else's save or pick moved
  it. Show "<agent>'s routine no longer runs on your login" with who moved it.

### The company folder for members (20260928469250_folder_core_member_reads)

Folder-v2 companies only (folder core C4, P27a; `deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md`). Each call
answers 42501 "Company folder is unavailable" for a caller who is not a member of a folder-v2 company with that
environment, and 55000 "Company is being deleted" while the company is being deleted. A path the member may not read
looks absent in every answer. Members write through the object gateway's member commit route (P34a,
`20260928479130_folder_core_member_writes`; `POST /v1/member-folder-commits/<environment>`), never with these calls;
a write under `QorperaOS/human-tasks/` waits for P31.

Since `20260930534000` the platform's folders (vision, agents, rules, connections, skills, contacts, human tasks,
interfaces and tables) are under `QorperaOS/` at the top, beside `code/`, `hooks/` and the company's own work (runtime
contract 5.6). The folder is written exactly `QorperaOS` and its key is `qorperaos`; below it, structured paths are
written in lowercase. An entry's `path` keeps the stored spelling (`QorperaOS/agents/...`), so a client compares paths
by their keys, never with a lowercase literal.

- `qorpera_member_company_file_mode(profile)` answers `mode: "folder"` for a folder-v2 company (P33,
  `20260928469270_folder_core_member_file_page`); `governed` and `legacy` are unchanged. A client reads a `folder`
  company with the functions below, never with the governed Company File calls.

- `qorpera_member_folder_read(environment, path)`: `{schema: "qorpera.folder-read/v1", asOfSeq, found, entry}`,
  `entry` null when not found; an entry has
  `path`, `kind` (`file`, `folder` or `symlink`), `version`, `seq`, `updatedAt` and, for a file, `manifestSha256`,
  `fileSha256`, `bytes`, `mediaType`, `executable`; for a link (`20260928549380_folder_links`), its `target`, the
  text it holds, never resolved. Nothing is below a link.
- `qorpera_member_folder_read_many(environment, paths)` (`20260930722000`): `{schema: "qorpera.folder-read-many/v1",
  reads}`, `reads[i]` what `qorpera_member_folder_read(environment, paths[i])` answers, for 1 to 64 paths, in one
  snapshot; an invalid path refuses the whole call. A client that finds it missing reads each path alone.
- `qorpera_member_folder_list(environment, parent, after, limit)`: `qorpera.folder-list/v1`, one folder's entries in
  folder-key order (`parent` null for the top), at most `limit` (1 to 1,000); `next` is the path to pass as `after`
  for the next page, null on the last.
- `qorpera_member_folder_path_history(environment, path, before, limit)`: `qorpera.folder-path-history/v1`, a path's
  versions newest first (1 to 100 a page), each `{version, seq, op, kind, path, at, by}` and the content fields (a
  link's `target`, except on a delete); a
  `move_in` has `from` and a `move_out` has `to` when the member may read that path. `next` is a version to pass as
  `before`.
- `qorpera_member_folder_history(environment, before, limit)`: `qorpera.folder-history/v1`, the change sets newest
  first (1 to 50 examined a page), each `{seq, at, by, paths, more}`: the first 20 readable paths in unit order
  (`path`, `op`, `kind`, `version`), `more` when there are others or more than 1,000 versions. A change set none of
  whose first 1,000 versions the member may read is left out (the feed still shows it). `next` is a seq to pass as
  `before`.
- `qorpera_member_folder_changes(environment, after_seq, limit, cursor?)`: the folder feed (`qorpera.folder-feed/v1`,
  core §6), each change set with `by` and `at`; a link's change has its `target`. Follow it from `next` (`afterSeq`,
  `cursor`); on `resync`, read
  again from the top.
- `by` is `{kind: "member", userId}`, `{kind: "agent", staffAgentId}` or `{kind: "platform"}`.
- `qorpera_member_folder_object(environment, sha256)`: the object gateway's check for one object (a manifest or a
  chunk) of a file the member may read, now or in a version they may read. Clients fetch bytes from the gateway
  (P27b), not with this call.
- `qorpera_member_company_state_folders(environment)` (P34a): `{schema: "qorpera.member-company-state-folders/v1",
  agents: [{staffAgentId, file}], groups: [{roomId, file}]}`, the live agents' `agent.md` and group chats' `group.md`
  the member may read, in path order. An agent's or group chat's folder is its file's parent.
- `qorpera_member_folder_writer(environment)` (P34a): `{schema: "qorpera.member-folder-writer/v1", actor, profileId}`,
  the caller's own actor `{kind: "member", userId}`. For the object gateway's member commit route, which calls it
  with the member's token; clients don't call it.
- `qorpera_member_folder_agent_proposals(environment, staffAgentId, request)` (P40c,
  `20260928499170_folder_proposals_member`): the changes one agent saved through a view for the caller that wait for
  review (`deploy/first-node/RUNTIME-COMPANY-FOLDER-C2.md` §8). `request` is `{}` or `{cursor}` (22023 otherwise; a
  cursor that is not the caller's proposal of that agent is P0002). The answer is
  `{schema: "qorpera.member-folder-proposals/v1", proposals, moreProposals, nextCursor}`: oldest first, at most 4,
  each `{proposalId, createdAt, viewKind, createsAgent, unitCount, units, moreUnits}` with its first 50 units
  `{unit, op, path, to?, structured?}` (`op` is `write`, `new_folder`, `delete` or `move`; `to` only for a move;
  `structured` lists `{path, kind, parse}`, where `parse` keeps only the strings `name`, `title`, `role` and `status`,
  and is left out when the unit writes no structured file). A proposal is
  listed (and counted) only while the caller may read every path it names. `nextCursor` is the last proposal's id when
  `moreProposals` is above 0, else null.
- `qorpera_member_folder_discard_proposal(environment, proposalId)` (P40c): `{schema: "qorpera.folder-proposal/v1",
  proposalId, status}`, `status` being `discarded`, or how a decided proposal was decided (`applied`, `not_applied`,
  `declined`). The member it waits for, owners and admins discard (42501 "Only the member it waits for, owners and
  admins discard a proposal"); an unknown or erased proposal is P0002 "Proposal is unavailable".

### Pages (20260930509000_interface_pages, 20260930520000_interface_page_bank, 20260930697000_interface_pages_hidden_per_member)

Folder-v2 companies only (Interfaces C6a; `QORPERA-REBUILD-SCOPE-AMENDMENT-2026-10-17.md` §4). A company shows at most
three pages in its Interfaces tab, Mailbox, Members and Bank. Mailbox and Bank are on and Members off until an owner or admin switches one (20260930583000). A client draws
them from the definitions it ships, never from a definition in the folder's `QorperaOS/interfaces/`: Pulse, a page an agent wrote
and any other page name are pages that aren't there, in the tab, a direct link or a fallback. Switching changes no
data: the pages' tables, the areas' consents and offers, and who pays stay as they are. Each call answers 42501 for a
caller who is not a member of a folder-v2 company with that environment.

- `qorpera_member_interface_pages(environment)`: `{schema: "qorpera.member-interface-pages/v1", pages, mayChange}`,
  `pages` being `[{page, on, hidden}]` for `mailbox`, `members` then `bank`, and `mayChange` whether the caller is an
  owner or admin. `hidden` (20260930697000) is whether the caller hid the page from their own rail: a client that reads
  it shows a page unless the member hid it (Members once the company has a second member), whatever `on` says, and
  offers Hide and Show; a client finds `hidden` on every page or treats the answer as one from before it, where `on`
  decides. A client refuses a page name it doesn't know, so a web that knows `bank` goes live before or with
  20260930520000.
  Read it when the company opens, on focus, and after switching.
- `qorpera_set_interface_page(environment, page, on)`: owners and admins only (42501 "Only the company's owners and
  admins can switch its pages"); another page name or a null is 22023, and a company being deleted 55000. Answers
  the pages as they are then, in the same shape. Switching a page to what it is changes nothing. The web no longer
  offers it (20260930697000).
- `qorpera_set_interface_page_hidden(environment, page, hidden)` (20260930697000): any member hides a page from their
  own rail or shows it again; nobody else's rail and none of the company's data change. A caller who is not a member is
  42501, another page name or a null 22023, a company being deleted 55000. Answers the pages as they are then, in the
  same shape. Hiding a hidden page, or showing a shown one, changes nothing.

### Offers of a claimed cell (20260928509110_interface_offers)

Folder-v2 companies only (Interfaces I9c; `deploy/first-node/RUNTIME-INTERFACES.md` §5 "Offers"). A member offers a
`needs_yes` member cell of a table to another member. The offer changes nothing in the file: the member it names
accepts by saving themselves into that cell with the member commit route, which the claim rule allows while the offer
is open and the cell is as the offer read it. Each call answers 42501 for a caller who is not a member of a folder-v2
company with that environment, and 55000 while the company is being deleted. An offer is
`{id, table, folder, key, column, from, was, to, state, agent, at, closedAt}`: `table` is the table's id, `folder` its
folder now, `key` the row's typed key (a JSON array, as the client's table parse gives it), `from`, `was` and `to` user
ids (`was` null for an empty cell), `state` `open`, `accepted`, `declined`, `withdrawn` or `lapsed`. `agent` is null
for a cell's offer; an agent's id is an agent offered to an area's supervisor ("Supervision consent" below), with
`column` `agents` and `was` null. A closed offer has `key` and `column` null.

- `qorpera_offer_interface_cell(environment, {table, key, column, was, to})`: `was` is the cell as the caller read
  it. Answers `{schema: "qorpera.interface-offer/v1", ok: true, created, offer}`; `created` is false when the same
  cell is already offered to `to`, with that open offer. A refusal is `{schema, ok: false, reason, message}`, show the
  message:
  - `gone`: "This table is gone." or "This row is gone.";
  - `column`: "Only a member column that needs a yes can be offered.";
  - `changed`: "That changed while you were looking." (the cell is not `was`);
  - `not_yours`: "Only the member it names can offer it.";
  - `member`: "Offer it to another member of the company.";
  - `write`: "You or they may not change this table's rows.".
  A request of another shape is 22023, and a paused company 55000.
- `qorpera_decline_interface_offer(environment, offer)` (the member it names) and
  `qorpera_withdraw_interface_offer(environment, offer)` (the member who made it): `{schema, ok: true, changed,
  offer}`; `changed` is false when the offer was already closed, with the offer as it is. Anyone else gets 42501, an
  unknown offer 22023. Both work in a paused company.
- `qorpera_member_interface_offers(environment)`: `{schema: "qorpera.member-interface-offers/v1", offers,
  truncated}`, the open offers on live tables the caller may read, between members of the company, newest first, at
  most 500. Every member who reads the table sees its offers. Read it again after a folder change to the table and on
  focus; an offer settles with the save that changes its cell.

### Supervision consent (20260928549360_interface_supervision)

Folder-v2 companies only (Interfaces I9b; `deploy/first-node/RUNTIME-INTERFACES.md` §5.1 "Supervision"). A member
supervises the agents of an area (a row of `QorperaOS/tables/areas`) by consent: their own save of the areas' rows that puts them
in a row's `supervisor` cell (a take, or an offer of the cell they accept) consents. While the consent is live, the
agents the row's `agents` cell holds take and release claimed cells as that member. A `supervisor` cell with no live
consent decides nothing: its agents act for no one. A consent ends `released` (a save leaves the cell naming someone
else or no one), `gone` (the row deleted, or its key changed), `withdrawn` (its member's call below) or `left` (its
member left the company); a save that keeps a cell its member had withdrawn consents to nothing, the consent call is the
way back. A consent is `{id, table, folder, key, user, state, at, endedAt}`: `table` is the areas table's id, `folder`
its folder, `key` the row's typed key (a JSON array, as the client's table parse gives it; null once ended), `user` the
supervising member. Each call answers 42501 for a caller who is not a member of a folder-v2 company with that
environment.

- `qorpera_consent_interface_supervision(environment, {key})`: the member the row's `supervisor` cell names consents
  again. Answers `{schema: "qorpera.interface-supervision/v1", ok: true, created, supervision}`; `created` is false
  while a consent to that row is live, with that consent (a consent being withdrawn meanwhile is waited for, and a new
  one made). A refusal is `{schema, ok: false, reason, message}`, show the
  message: `gone` "This area is gone." (no such row, or the areas unreadable to the caller), `not_yours` "Only the
  member it names as supervisor can consent.". A request of another shape is 22023 (`key` a non-empty array, at most
  4,096 bytes), a paused or deleting company 55000.
- `qorpera_withdraw_interface_supervision(environment, supervision)` (its member only): `{schema, ok: true, changed,
  supervision}`; `changed` is false when the consent had already ended, with the consent as it is. The file is
  unchanged. Anyone else gets 42501 "This supervision is not yours to withdraw", an unknown consent 22023. It works in
  a paused company.
- `qorpera_member_interface_supervisions(environment)`: `{schema: "qorpera.member-interface-supervisions/v1",
  supervisions, truncated}`, the live consents of current members on the areas, when the caller may read them, newest
  first, at most 500. Read it again after a folder change to `QorperaOS/tables/areas` and on focus. A row whose `supervisor` cell
  names a member with no consent here is waiting for theirs: offer them "Consent" when it names the caller.
- Agents join a supervised area by its supervisor (20260928549370_interface_supervision_agents). While an area's
  consent is live, only its member's save adds an agent to the row's `agents` cell; anyone else's save that adds one
  is refused (`areas`: "only the area's supervisor adds its agents; offer the agent to them"). Removing an agent stays
  free, and so does adding one to an area nobody supervises.
- `qorpera_offer_interface_agent(environment, {key, agent})`: the caller offers a hired agent to the area's
  supervisor. Answers `{schema: "qorpera.interface-offer/v1", ok: true, created, offer}`, an offer with `agent` set
  and `to` the supervisor (see "Offers of a claimed cell"); `created` is false when the agent is already offered to
  that area, with that open offer (whoever made it). A refusal is `{schema, ok: false, reason, message}`, show the
  message:
  - `gone`: "This area is gone." (no such row, or the areas unreadable to the caller);
  - `agent`: "Offer an agent the company has hired.";
  - `changed`: "The agent is in this area already.";
  - `supervisor`: "Nobody supervises this area: add the agent yourself." or "You supervise this area: add the agent
    yourself.";
  - `write`: "You or they may not change this table's rows.".
  A request of another shape is 22023 (`key` a non-empty array, at most 4,096 bytes; `agent` an agent id), a paused
  company 55000. The supervisor accepts by saving the agent into the row's `agents` cell; they decline, and its maker
  withdraws, with the offers' calls above. The offer lapses when the consent ends.
- Member notification `interface_supervision_ended` (subject
  `qorpera.member-notification.interface-supervision-ended/v1`: `supervisionId, tableId, key (null when longer than
  1,024 bytes), supervisorUserId, reason ('released'|'gone'|'withdrawn'|'left'), byUserId (null when no member ended
  it), at`): a consent ended, told once to the company's owners and admins, the supervisor and the member the area's
  `owner` named before the end (before the save, when a save ended it), each while a member who may read the areas,
  never the member who ended it. A key the supervisor
  changed in their own save that consents to the renamed row tells nobody.

> **Scope reset, 2026-10-17.** Interfaces are two pages Qorpera makes, Mailbox and member-to-agent ownership
> ([the scope amendment](../QORPERA-REBUILD-SCOPE-AMENDMENT-2026-10-17.md), §2). The calls for the company's pages
> must cover these rules, and a client keeps to them:
> - **listing:** only the two supported pages are listed, each with whether it is on; both start off;
> - **fixed layouts:** a page's layout and actions are the platform's, never a definition a company or an agent
>   wrote;
> - **turning on and off, and source settings:** only an authorized member changes them, for the whole company,
>   and only the allowed fields. It changes what is shown, never ownership, payment, consent or data;
> - **direct routes and fallbacks:** a direct link, a stored route or a fallback opens only a supported page that
>   is on, and never a Pulse or custom definition, whatever its name.
>
> Consent records stay. No call for the page set is listed here yet. This note records scope; it says nothing
> about what is built.

### Who each agent works for (20260930700000_agent_works_for)

The Members page (Jonas, 9 Nov 2026). Each agent of a company except its Co-Founder works for one member, or for
nobody: its row when one was saved, else the member who hired it while a member, else nobody (no known hirer). A member who leaves leaves their agents working for nobody, and every open ask that involves them is void.
20260930701000 makes the work handed to an agent by another agent run on that member's own login: the login the
first-choice order picks for new work of theirs, when it is theirs and not a ChatGPT plan login (otherwise, or with
none, it stays the chain starter's). A member's own message is still paid
by them, and a routine still by the member who saved it: moving an agent does not move its routines.
Each call answers 42501 for a caller who is not a member of the company.

- `qorpera_read_works_for(profile)`: `{schema: "qorpera.works-for/v1", may_ask, may_ask_for_others, agents, logins,
  asks}`. `may_ask` is false for a viewer; `may_ask_for_others` is true for an owner or admin. `agents` is
  `[{staff_agent_id, user_id (null: nobody), since (null: never moved)}]`. `logins` is one entry per member,
  `{user_id, state, used_percent, resets_at}`: `state` is `ready`, `full` (every live login used up; `resets_at` the
  first reset when known), `sign_in` (no live login, one needs a new sign-in) or `none`; `used_percent` is 0-100 of
  the login with the most room, null when no fresh reading says. No email or account is shown. `asks` are the open
  asks, `[{id, staff_agent_id, from_user_id, to_user_id, asked_by_user_id, asked_by_staff_agent_id,
  answer_by_user_id, created_at, why}]`; `why` is the asker's short reason (null when none; 20260930702000), and an
  ask the Co-Founder made has `asked_by_staff_agent_id` and no `asked_by_user_id`. Read it when the page opens, after each call below, and every 30 s while it is
  open.
- `qorpera_ask_works_for(profile, staff_agent, to_user)`: `{moved, ask_id}`. Asking for the member it already works
  for, or taking (to = the caller) an agent that works for nobody, moves at once (`moved` true, no ask). Otherwise an
  open ask answered by the side that did not ask: taking an agent asks the member it works for; offering one, by that
  member or by an owner or admin, asks the member it would go to. A viewer cannot ask (42501) or receive (22023);
  another member's agent can be offered only by them or an owner or admin (42501); one open ask per agent (55P03,
  "Someone has already asked about that agent"); the Co-Founder or an archived agent is 22023.
- `qorpera_answer_works_for(ask, yes)`: `{status, moved}`. The member asked says yes (`yes`, the agent moves) or no
  (`no`); the member who asked may withdraw (`yes` false, `withdrawn`). A yes on an agent that meanwhile works for
  someone else, or for a member who is now a viewer, is `void` and moves nothing. An ask already answered answers its
  status. Anyone else is 42501.
- The Co-Founder asks too (20260930702000, host calls, never a member's): `qorpera_cofounder_crew(binding)` reads the
  members, the agents with whom they work for and the open asks; `qorpera_offer_agents_to_member(binding, {member,
  agents, why})` asks one member (an id, email, full name or a first name only they have) to take 1 to 20 agents (ids or
  names). The member answers on the Members page as above.

### Member chats (20260930715000_member_messages)

Members of a company message each other (Jonas, 10 Nov 2026): one chat per pair of members per company, shown as
contacts in the rail. A chat is the company's (deleted with it, kept when an account goes), wakes no agent, takes no
login and no computer hours, and is not stopped by a company's pause. Every member reads and writes their own chats,
viewers too; nobody reads another pair's. Each call answers 42501 for a caller who is not a member of the company (or
while it is being deleted), and for a `user` who is not another member of it.

- `qorpera_list_member_chats(profile)`: `{schema: "qorpera.member-chats/v1", chats}`, one entry per other member in
  the order they joined, with or without messages: `{userId, lastSeenAt, unread, readSeq, theirReadSeq, last}`.
  `lastSeenAt` is when that member was last online (their last `qorpera_mark_online`, else their last sign-in; null
  when neither). `unread` counts their messages after the caller's read mark that were not taken back, at most 100.
  `readSeq` and `theirReadSeq` are the newest message each side has seen (0: none). `last` is the chat's newest
  message with its words cut to 280 characters, or null. Read it when the company opens, on the `member-chats` hint
  (§3) and on the slow poll.
- `qorpera_read_member_chat(profile, user, before_seq default null, limit default 50)`: `{schema:
  "qorpera.member-chat/v1", userId, messages, hasMore, readSeq, theirReadSeq}`: the newest `limit` messages (1 to
  200), or those before `before_seq`, oldest first; `hasMore` says older ones exist. A message is `{id, seq,
  authorUserId, createdAt, text}`, or `{..., deleted: true}` without `text` once its author took it back. A message
  the caller wrote also carries `clientMessageId`, the id they sent it with (the list's `last` does not): a client
  knows its own message by it when a read brings it before the send is answered, or after an answer was lost. `seq`
  orders the messages of a chat; it is not dense. A chat's sends go one at a time, so its messages are committed in `seq`
  order: none appears later in front of one already read. A message taken back keeps its `seq`, so a client shows the
  change only by reading that message again: the web reads every message it shows again on each hint and poll.
- `qorpera_send_member_message(profile, user, client_message_id, text)`: `{schema: "qorpera.member-message/v1",
  userId, message}`. `text` is not blank and at most 16 KiB (else 22023). `client_message_id` is the client's own
  uuid for the message: the same call again answers the same message and writes nothing; the id with other words or
  for another member is refused (23505). No read mark moves: a member's own messages are never unread to them.
- `qorpera_mark_member_chat_read(profile, user, seq)`: `{schema: "qorpera.member-chat-read/v1", userId, readSeq}`.
  The caller has seen the chat up to `seq`: the mark moves to the chat's newest message at or before `seq`, never
  back; `readSeq` is the mark as it stands. Call it when new messages of the open chat are in front of the member.
- `qorpera_delete_member_message(profile, message)`: `{schema: "qorpera.member-message/v1", userId, message}`, the
  message now `deleted`. Only its author, while a member; twice answers the same.

### An agent's computer, watched (20260930712000_machine_member_screens)

A member watches an agent's desktop computer in the computer window: a picture of its screen about once a second, with
no take-over (that is 20260930713000). Every member who reads the company may watch, viewers too; owners, admins and
contributors may wake a sleeping machine (`qorpera_member_manage_company_machine(profile, machine, 'start')`, as
before). Each call answers 42501 for a caller who is not a member of the company, or while it is being deleted.

- `qorpera_list_agent_machines(profile, staff_agent)`: `{schema: "qorpera.agent-machines/v1", profileId,
  staffAgentId, canWake, machines}`. At most 20 of the company's machines that the agent started or whose screen it
  drove last, not removed and not being deleted: running ones first, then the ones this agent drove most recently, then
  the newest. A machine is `{machineId, name, purpose, state, lifetime, desktopCapable, startedByAgent, screenUsedAt,
  screenAgentName, waitingFor}`: `state` as `qorpera_company_machine_state` (running, starting, waiting, stopping,
  stopped); `desktopCapable` at 2 processors and 4 GiB; `screenUsedAt` and `screenAgentName` the last agent's drive of
  its screen (null: never); `waitingFor` `hours` or `room` for a waiting machine, else null. No node, placement, boot or
  command. 42501 for an agent that is not the company's. Read it when the window opens, on the `machines` hint (§3) and
  every 15 s while the window is open without hints. Fields may be added; a client ignores the ones it does not know.
- `qorpera_member_machine_screen_begin(profile, machine, watch)`: one look, begun as the member. Clients do not call it:
  the look route (§4) does, with the member's own token. `watch` is `{"confirmed": boolean}`.

### An agent's computer, taken over (20260930713000_machine_member_control)

An owner, admin or contributor takes over an agent's desktop computer in the computer window and hands it back; a viewer
watches only. While a member holds the desktop, the agent gets no picture of that machine and neither acts on it, starts
a new command there nor saves a key off it (`DESKTOP_MEMBER_IN_CONTROL`); other members see who holds it, not the
screen. The hold is a lease: 5 minutes from the member's last word (taking it, an action, the heartbeat), never more
than 30 minutes from their last input (taking it, an action); it ends at once when they hand it back and by itself at
its time (no job ends it: every check compares the time). Each call answers 42501 for a caller who may not, 22023 for a
request of another shape.

- `qorpera_list_agent_machines` also answers `canTakeOver` (owners, admins, contributors) and, per machine, `epoch`
  (the caller's own hand-back epoch for it, 0 when never handed back) and `control`: null, or `{mine, name, until}`
  while a member holds its desktop (`mine` when it is the caller; `name` the holder's; `until` when the lease runs out
  unless renewed: read the list again then). The caller's own hold also says `epoch`, the epoch it was taken under,
  `seat`, its seat, and `press`, the id of the take-over that seated it (never for another member's).
- Shared control (20260930734000, 20260930738000): owners, admins and contributors act on an agent's desktop beside the
  agent with no hold, through the executor (`qorpera_member_machine_desktop_share_begin`, which the executor calls with
  the member's token). The list also names, per machine, `others` (the other members who acted on it in the last
  minute, by name) and, to those who may act, `generation`: the desktop's lease generation, which moves at every
  seating and every hand-back that ends a lease. A page sends each shared action with the generation the list named
  when its input was made; the begin refuses it `DESKTOP_HELD_SINCE` once that is not the current one (someone held the
  desktop privately since), and the page then reads the list again and goes on under the new one. A begin without a
  generation (a page before 20260930738000) is served as before.
- The member's pointer (20260930744000): `others` names at most 50 members, the most recent first. Through the executor, a
  member who may act begins a 10 s pointer pass (`qorpera_member_machine_desktop_pointer_begin(profile, machine,
  generation, epoch, seat)`: shared at the generation the page knows, or on the caller's own private hold at its epoch
  and seat; `{schema: "qorpera.member-machine-desktop-pointer/v1", state: "ok", passId, seconds: 10}` or a refusal:
  `MACHINE_NOT_RUNNING`, `MACHINE_NEEDS_COMPANY_VIEW`, `DESKTOP_MACHINE_TOO_SMALL`, `DESKTOP_MEMBER_IN_CONTROL`,
  `DESKTOP_HELD_SINCE`, `DESKTOP_CONTROL_ENDED`); the moves on it ask SQL nothing. A pass records no action and renews no
  lease; the executor's read of it moves the machine's last use at most every 30 seconds.
- The member's live picture (20260930745000): `qorpera_member_machine_stream_release(placement, boot, user, generation,
  epoch)`, service_role only, read only (it writes and locks nothing), the machine's node's read for one release cycle
  of a member's stream: `{schema: "qorpera.member-machine-stream-release/v1", state: "ok"}` or a refusal:
  `STREAM_NOT_ALLOWED` (no longer an owner, admin or contributor, or the company is being deleted),
  `MACHINE_NOT_RUNNING` (not running, or not on that boot or placement), `MACHINE_NEEDS_COMPANY_VIEW`, and for the
  stream's hold `DESKTOP_MEMBER_IN_CONTROL` and `DESKTOP_HELD_SINCE` (shared) or `DESKTOP_CONTROL_ENDED` (private); then
  the member's read check of what the machine read (`qorpera_folder_member_machine_reads`, 42501 with detail
  `qorpera.test-machine/member-unreadable`). No page calls it; a page buys a ticket on the executor's pointer route.
- Hand-back epochs (review r5 of #1661): one counter per member and machine that only the database moves. A take-over
  is sent at the epoch the page knows and accepted only at the current one; a hand-back at the current epoch moves it
  on (always for VOID; for EXACT when nothing of the member's is left live, below), one at an older epoch changes
  nothing. So once an answer named an epoch above e, nothing taken or sent at e or before holds the desktop or ever
  will, whenever it arrives: a live lease of the member's is always under the current epoch, and no clock or list read
  is involved.
- Seats (release review r1 of #1667, F26 of #1661): the epoch orders take-overs against hand-backs, but two holds of one
  member can live under one epoch (a lease that ran out and was taken again; another tab's take-over of the member's
  own live lease). So the database gives every seating a seat, a number that only grows per machine: a take-over that
  starts a lease, one after a lease ran out, and one that takes the member's own live lease over from another press
  each get a new one. Everything a page does as holder names the seat beside the epoch (the heartbeat, every action),
  and is taken only in that seat: a stale tab's heartbeat renews nothing and its input runs nowhere, and that tab
  hears at its next heartbeat or action that it holds nothing. A page holds a seat only from the answer to its own
  take-over, or, when that answer was lost, from a list that shows the hold seated by that very take-over's `press`.
  A press id is for recognition only, never authority: no call but the list reads it. A page never has two
  take-overs of a machine that may both be alive (F28 of #1661): before it sends a new one while an earlier one of its
  own at that epoch has no answer (lost, timed out, cut off: none of these is an answer), it sends VOID at that epoch
  and waits for its answer, and the new one goes at the epoch that answer names.
- `qorpera_member_take_machine_desktop(profile, machine, epoch, press)`: `press` is a uuid the page mints for each
  take-over request. `{schema: "qorpera.member-machine-desktop/v1", state: "ok", until, seat}`, or `state: "refused"`
  with `reason` `DESKTOP_MACHINE_TOO_SMALL`, `MACHINE_NOT_RUNNING`, `MACHINE_NEEDS_COMPANY_VIEW`,
  `DESKTOP_MEMBER_IN_CONTROL` (with `memberName`, the holder's) or `TAKE_CALLED_OFF` (not the current epoch; with
  `epoch`, the current one). Taking it again at the same epoch takes the caller's own lease over: a new seat.
- `qorpera_member_keep_machine_desktop(profile, machine, epoch, seat)`: the window's heartbeat, every 60 s while it
  shows the member holding the desktop: `state: "ok"` with the new `until`, or `state: "ended"` (handed back, run out,
  seated anew by another take-over of the member's, or another member's now). It renews only the lease taken under
  that epoch in that seat.
- `qorpera_member_hand_back_machine_desktop(profile, machine, reason, epoch, seat)`: `reason` `handed_back` (the
  member's word, or their take-over card's I'm done) or `closed` (their window closed or they left the company's page).
  Two forms, chosen by what the page knows (F27, F28 of #1661):
  - EXACT, `seat` a number: the caller's lease taken under `epoch` in that seat ends, if it is the lease; the epoch
    moves on when `epoch` is the current one and no live lease of the caller's is left. A page sends it only when every
    take-over it sent for that machine at that epoch was answered: a tab that closes then never ends another tab's
    hold. Its answer discharges that seat on the page (ended now, or gone already), and every lower one.
  - VOID, `seat` null: at the current epoch the epoch moves on and the caller's lease taken under it ends, whichever
    seat; at an older epoch nothing. A page sends it whenever a take-over of its own for that machine at that epoch has
    no answer: moving the epoch is the only thing that voids that take-over whenever it arrives. It also ends another
    tab's hold of the member's under that epoch: a tab that closes while a take-over of its own is unanswered, while
    another tab of the same member holds the desktop under the same epoch, ends that tab's hold (it hears so at its
    next heartbeat or action, and its window shows the hold no more; the web begins no take-over since 14 Nov 2026). This race is the one place a closing tab ends
    another's; it keeps a take-over that outlives its window from seating anyone.
  A lease of the caller's that ran out is closed as it ended when the epoch moves. Which form each release sends:
  a close, a switch away, pagehide and leaving the page send VOID when uncertain, else EXACT by the seat the page's
  own take-over got, else nothing (a hold only seen from another window is not theirs to end); Hand back and I'm done
  send VOID when uncertain, else EXACT by the highest of that seat and the seat a list or an answer showed the member
  holding (the lower one is gone: seats only grow). A VOID asked again until answered stays VOID: its answer is what
  fences a copy of it still on its way. `{schema, state: "ok", handedBack, epoch, holding, seat}`: `handedBack`
  whether it gave a live lease back; `epoch` the caller's current epoch afterwards (a take-over the member asks for
  later is sent at it); `holding` whether the caller holds the machine now (another tab of theirs) and `seat` that
  hold's seat (null when not): hand back again at `epoch` naming that seat to give it back too.
- The take-over card's I'm done is answered after this (reviews r9 and r10 of #1661): I'm done answers once, after a
  list read that counts (none of its machines below the epoch the page knows), the page owes nothing for the agent's
  machines. What it owes at an epoch is discharged by learning from the database that the member's epoch is above it
  (a hand-back's answer, a `TAKE_CALLED_OFF`, a list), or, seat by seat (F27, F28): a take-over with no answer by its
  own answer (or a list showing the hold seated by it); the seat the page's own take-over got, or one shown it, by an
  EXACT hand-back's answer for that seat or a higher one, or by a heartbeat or an action answered `ended` for it. No
  refusal of another request, timeout or closed window discharges anything; a hold the read itself shows at the
  current epoch is owed like any other.
  A take-over the member starts from another tab after that read was taken is a new take-over, outside this answer;
  the agent then hears `DESKTOP_MEMBER_IN_CONTROL`, as for any take-over without a card. No page can exclude what the
  member does a moment later.
- A page uses a hold (input, heartbeats) only after a take-over of that page's own (review r14 of #1661): a hold of
  the member's that the list shows from another window, or from before the page was loaded again, is shown, never
  taken up, and ends with the window's Done or by itself. Since 14 Nov 2026 the web begins no take-over at all (Jonas:
  private typing removed; no Take over, no Type privately): the take-over call stays in the database, unused by the
  web, until it is retired.
- `qorpera_member_machine_desktop_act_begin(profile, machine, action, epoch, seat)`: one action, begun as the member.
  Clients do not call it: the action route (§4) does, with the member's own token, the action as SQL keeps it (a text
  by its length), `epoch` and `seat`, the hold the page captured the input under (release review r1 of #1667, F24 and
  F26 of #1661). Under the machine's lock it is taken only from the member whose live lease was taken under exactly
  that epoch and is exactly that seat; otherwise `DESKTOP_CONTROL_ENDED` (that hold has ended) and nothing is recorded,
  counted or renewed, so input delayed across a hand-back and a new take-over, a lease that ran out and was taken
  again, or another tab's take-over never runs under the new hold. An `epoch` or `seat` that is null or below 0 is
  malformed (22023). The executor's read (`qorpera_member_machine_desktop_act_authority`) then serves the action only
  while the lease row it was begun on stands and is still in the seat the begin recorded, so a hand-back, a new
  take-over or another press's take-over between the begin and the read refuses it too.
- The action route's body is `{"action": {...}, "epoch": n, "seat": s}`; the page sends the epoch and the seat of the
  hold the key, click or text was captured under, never those at send time, and its queue and every answer belong to
  that one hold: an answer for an older hold changes nothing of the current one (F25).
- An agent's `save_coding_value` is fenced as a picture is (v233 release review r1, F29 of #1661): its read
  (`qorpera_authorize_machine_coding_value`) answers `desktopGeneration`, the lease generation it saw, and the executor
  asks `qorpera_machine_desktop_picture_check` (no looker) before the clipboard helper reads the clipboard and again
  after it, before the box is answered: a take-over at any moment since the read drops the box whole (nothing stored,
  nothing logged; the agent hears `DESKTOP_MEMBER_IN_CONTROL`). The helper takes the desktop as an action does, so a
  member's action (a copy, a paste) and the clipboard read never interleave on one desktop. What cannot be undone: a
  helper that had begun reading before a take-over may already have cleared the clipboard, the member's copy with it.
- After a member has held a desktop, the platform clears its clipboard before an agent can read a key from it (F32 to
  F35 of #1661): what a member copied stays on the clipboard after they hand back.
  - The clear is owed from the hold on: `desktop_clipboard_generation` (the lease generation at the last confirmed
    clear) differs from the lease generation, which moves at every seating and every hand-back. Only the platform's
    confirmed clear lifts it; nothing the agent does (a look, a click, a copy) does.
  - The clear: the machine's executor takes the desktop under the one-actor rule, asks the fence, clears both
    selections with a fixed script of its own (each xsel must succeed, then each selection is read back by its byte
    count alone; never the helper's `--clear-only`, which answers cleared whatever xsel did), and confirms it with
    `qorpera_machine_desktop_clipboard_cleared(placement, generation)` (service_role), which records it only while that
    generation stands and no member holds the desktop. A desktop that is not running counts as cleared: the image keeps
    no clipboard past its desktop's session (no clipboard manager, no saved history; measured on image 91d433c0).
  - First, at the agent's first screen call after the hold (a look or an action): `qorpera_authorize_machine_screen`
    answers `clipboardClear`, and the host clears and records under that call's hold of the desktop, within 3 s,
    before it looks or acts, so whatever the agent copies after is its own and its save reads it at the first call. If
    the fence or the record says a member holds the desktop again, an action does not run (`DESKTOP_MEMBER_IN_CONTROL`);
    any other failure fails nothing, and the clear stays owed.
  - The backstop is `save_coding_value`: while the clear is owed, its read answers `{state: "clear", machineId,
    placementId, bootId, executorOwner, providerId, receiptId, desktopGeneration}` and reads nothing; the executor
    clears and records the same way, and the agent hears `CLIPBOARD_EMPTY` (true then: it copies the key on the site
    and calls again); its next call reads as before. `DESKTOP_MEMBER_IN_CONTROL` stays for a member who holds the
    desktop, or took it over across a read.
- A member's action asks the fence for its seat again once the host holds the desktop
  (`qorpera_member_machine_desktop_act_authority` answers the seat), so one authorized before a hand-back never runs
  after it.
- A stated limit: the computer is the agent's. While a member holds the desktop the agent starts nothing new on it and
  reads nothing of its screen or clipboard through the platform's tools, but a program the agent started there before
  the take-over keeps running and can see the screen and the clipboard.
- One lock order with every machine path (F30 of #1661): a take-over, and a member's first look at a machine (which
  writes their watch row, keyed by the company), take the folder fence and the company row KEY SHARE
  (`qorpera_folder_machine_fence`, rank 0) before the machine's row, as the executor's custody and a member's wake do,
  so a holder of the fence that then wants the machine (company deletion's finisher) is waited for, never met in a
  circle.
- The window sends the member's input in the order it was made (F31 of #1661): a click waiting for its second, typed
  text and a wheel turn are each gathered a moment, and when input of another kind begins, what is gathered goes first.

### A member turns an agent's desktop on (20260930714000_machine_member_start)

An owner, admin or contributor turns the desktop (the screen) of an agent's running desktop computer on, whatever the
agent does (Jonas, 11 Nov 2026): the window's Turn it on, and Wake it, which turns the screen on too once the machine
runs. Starting is not taking over: it needs no hold and takes none, and the agent is told nothing (its next
`machine_screen` or `desktop start` finds the desktop running).

- `qorpera_member_machine_desktop_start_begin(profile, machine)` (authenticated; the start route calls it with the
  member's own token): under the machine's lock, a running machine of the company big enough for a desktop
  (`MACHINE_NOT_RUNNING`, `DESKTOP_MACHINE_TOO_SMALL`), then exactly what an agent's first screen use marks and refuses:
  the disk rule (`MACHINE_NEEDS_COMPANY_VIEW` on a disk that had a view, for a member who does not read the folder's
  root; a disk that never had one is marked unchecked for them), the machine's last use (at most every 30 s), and a
  screen no agent drove yet stamped as the agent the machine was started by (a screen an agent drove keeps that agent's
  stamp, so the machine stays in that agent's window). A member's hold of the desktop, the caller's or another's, does
  not stop a start: a hold does not prove the desktop runs (a take-over never checks it, and the desktop stops itself
  after an hour without a desktop command), and a start takes no hold and does nothing to a desktop that runs. A second
  start of the machine within 5 s is `DESKTOP_START_TOO_SOON`. It records the start (id, member, machine, time) and answers `{schema:
  "qorpera.member-machine-desktop-start/v1", state: "ok", startId}`; refusals are `{state: "refused", reason}`.
- `qorpera_member_machine_desktop_start_authority(start, owner, provider)` (service_role): the executor's read, single
  use, within 15 s of the begin, of a member still an owner, admin or contributor of a company not being deleted, the
  machine still running and big enough, the disk rule read again (marking as the begin does); `served` only for the
  placement's own executor.
- The machine stays awake under a member: a member's look read moves the machine's last use (at
  most every 30 s) while their word that they watch is at most 30 minutes old, and a hold's heartbeat moves it when it
  renews the lease. Without them a task machine whose desktop a member only watched slept after its executor's
  `sleep_after_seconds` (an hour by default), and a hold kept by heartbeats alone could too.

### A member starts a computer for an agent that has none (20260930730000_member_agent_computer)

An owner, admin or contributor starts a desktop computer for an agent from its computer window (Jonas, 12 Nov 2026),
when the agent has no machine or none big enough for a screen. One press; never on opening the window (a computer
costs hours). The agent is told nothing: the machine is its own (its machine list shows it, started by it) and it uses,
stops and deletes it as one it started.

- `qorpera_member_start_agent_computer(profile, agent)` (authenticated): owners, admins and contributors
  (`qorpera_can_write_profile`, as a member's wake). An agent of the company on staff and not deleted, else
  `AGENT_UNAVAILABLE` (an unknown agent is 42501). Under the company's machine lock: a machine of the agent's (started by
  it, or whose screen it drove last) big enough for a desktop and not being deleted is answered as `{state:
  "existing", machine}` and nothing is made (the client wakes it when it sleeps); at most one new computer per agent a
  minute (`START_TOO_SOON`); else ONE machine as the agent's own `machine_start` with desktop true and its defaults makes
  it (2 cpus, 4 GiB, 40 GiB of disk, lifetime task, the standard image), named after the agent with `-desktop` (a
  number added when taken), its purpose naming the member, the agent as the one it is started by and the member as the
  one who asked, no run. It goes through machine_start's admission: `MACHINE_TOO_LARGE` (no server could ever hold it)
  and `MACHINES_UNAVAILABLE` (no node runs machines) refuse and keep nothing; otherwise it waits in line for room or
  hours as any wanted machine (only the service role reserves room on a node, so a member's start waits for the node
  executor's next pass, as a member's wake does). Answers `{schema: "qorpera.member-agent-computer/v1", state:
  "started" | "existing", machine: {machineId, name, state}}`, or `{state: "refused", reason}`.
- Such a machine has no starting run: `started_by_run_id` and `started_by_receipt_id` are null together. Its folder view
  acts as its agent and member, company-wide, as a view whose starter's run has ended; a save through it checks the
  read sets of every run with a command or an authorized `machine_screen` action on its disk, as a starter's is checked
  (`qorpera_company_machine_screen_runs` records the action's run once per placement; a look records nothing). The disk
  is the placement's: a machine keeps it while it sleeps and wakes on its node, and a new placement starts empty.
- The computer window's list (`qorpera_list_agent_machines`) takes the agent's machines big enough for a desktop first
  into its 20, and `existing` is the first of them in the list's own order: the window always lists the machine a start
  answers. A busy record moves its last use only
  while a command whose conversation the busy check-in asks runs on it: with no one to ask, it sleeps after its quiet
  window without use, busy or not.

### The company's time zone (20260930739000_company_time_zone)

A company has one time zone, an IANA name (`qorpera_profiles.time_zone`, null while it is not known), taken once from
a member's browser (Jonas, 12 Nov 2026: "Yes, from the browser"). There is no setting. An agent's desktop computer
shows its clock in it: the executor's list of machines names it with each placement, and the executor writes it into
the machine. A routine's own time zone is not touched and does not take it as a default.

- `qorpera_profile_team_info(profile)` answers `time_zone` beside its other keys: the name, or null. A cloud before
  this migration answers no such key.
- `qorpera_ensure_company_time_zone(profile, zone)` (authenticated): owners, admins and contributors
  (`qorpera_can_write_profile`; a viewer and an outsider get 42501, whatever they hand in). The zone is taken only
  while the company has none, in one statement (of two members at once the first is taken); a later call changes
  nothing. Answers `{schema: "qorpera.company-time-zone/v1", timeZone, taken}`: the company's zone either way, and
  whether this call's was taken. Refused with 22023 "Time zone is unknown": no name, a name that is not exactly one of
  `pg_timezone_names` (read from `qorpera_runtime_time_zone_names`, as a routine's zone is), or one of another shape
  than letters, digits, `_`, `+`, `-` in at most three parts with `/` between, 64 characters at most.
- The client calls it when a company opens whose team read says `time_zone` null and the member may write: once, with
  the zone it shows times in (the member's saved choice, else the device's as the browser reports it; nothing when
  the browser reports none). It never calls for a viewer, for a company that has a zone, or on a cloud whose team
  read has no `time_zone`; a refused zone is not handed in again by that browser.
- Nothing else changes the zone in this version. A later change is one more function (a setting, or an agent's tool)
  that updates the column: the executor writes a changed zone into the machine on its next pass, and a desktop shows
  it from its next start.

#### Member contacts' places (20260930717000_member_contact_places)

A contact is a rail row like an agent's (Jonas, 10 Nov 2026: "not sure I like the member contacts at the top,
undraggable and un-hideable"): its member drags it into the pinned row, into a section or among what is in no section,
and hides it. Where a contact stands is each member's own, as their pins and hidden agents are: nobody else's rail
changes, nothing is written to the company's folder, and any member may place their contacts, viewers too.

- The list (`qorpera_list_member_chats`) answers `placing: true` on a cloud that keeps places; a client offers no
  drag, pin or hide without it. Each chat carries `hidden` (boolean) and, once its member placed it, `place`: `{zone,
  sectionId?, after?, rank}`. `zone` is `members` (the Members group at the foot of the list, where a contact stands
  until it is placed), `pinned`, `unassigned` or `section` (with `sectionId`, a section of the sidebar). `after` is
  the agent or group chat the contact stands after in its zone (absent: first; never in `members`), and `rank` (0 to
  9999) orders the contacts that stand after the same one (in `members`: all of them).
- The company's own order of a zone (the sidebar's) can change under a kept place. A client draws a zone by weaving
  its contacts into that order, each after its `after`; a contact whose `after` is not in the zone stands last, and
  one whose section is gone, or whose rail has no sidebar, stands in the Members group. The kept place is not
  rewritten for it. A contact never placed stands in the Members group after the placed ones, in the order the
  members joined.
- `qorpera_place_member_contacts(profile, contacts)`: `contacts` is a list of 1 to 100 entries `{userId, zone,
  sectionId?, after?, rank, hidden}`, each one contact's whole place (it replaces the kept one). Answers the list as
  `qorpera_list_member_chats` does. Refused whole with 22023, nothing written, when the list or an entry has another
  shape, names the caller, someone who is not a member of the company or one contact twice, names a section the
  company does not have, gives `sectionId` without zone `section` (or the other way round), or gives `after` in
  `members`. `after` is not checked against the company's agents: it is the caller's own note. 42501 as the other
  calls. A place goes with either member's membership and with the company.
- A change of place sends no hint: another tab of the same member shows it on the slow poll.

### Chat images (20260928549140_chat_images)

Folder-v2 companies only. A member's image in a conversation (an agent's thread or a group chat) is a folder file under
the conversation's summary-tree root: `<root>/images/<clientInputId>/<sha256>.<png|jpg|gif|webp>`, the root being
`QorperaOS/agents/<handle>/memory/thread` for a thread and `QorperaOS/agents/groups/<handle>/memory` for a group chat. The input lists each
image as before, `{objectSha256, bytes, mediaType}`, the hash being the file's. An input holds at most 5 images and
8 MiB, each PNG, JPEG, GIF or WebP (the web's limits). Only the platform writes these paths (a summary tree is the
platform's; a member's commit is refused `platform_only`), and an agent reads them as folder files. A conversation with
no root (its agent has no folder) takes no images.

The steps, through the object gateway's `/v1/member-session-attachments` routes (§4):

1. The client picks the input's `clientInputId` first: every image of the input and the post use it.
2. `PUT …/upload/<sessionId>/<clientInputId>/<sha256>`: the gateway calls `qorpera_room_image_begin(session,
   clientInputId, sha256, bytes, mediaType)` with the member's token, which answers `{schema:
   "qorpera.room-image-begin/v1", environmentId, sessionId, clientInputId, sha256, bytes, mediaType, path}`; it stages
   the bytes as the platform and calls `qorpera_room_image_commit(userId, session, clientInputId, file)` as the service
   role, `file` being the seal's `{manifestSha256, fileSha256, bytes, mediaType, executable}`. That makes the folders
   still missing and writes the file in one memory commit naming the conversation's generation, and answers `{schema:
   "qorpera.room-image/v1", sha256, bytes, mediaType, path}`. The same image again answers the same and commits nothing.
3. The post (`qorpera_post_company_room_message`) lists the images. Each must be a live file at its path that this
   member uploaded for this `clientInputId` (42501 "Attachment bytes must be uploaded for this exact member input"); a
   replay of the post is not checked again. The input trigger holds any writer to the same rule, and a submitted
   input's images and author never change (42501 "Submitted input attachments cannot change").
4. `GET …/input/<sessionId>/<inputId>/<sha256>`: the gateway calls `qorpera_room_image_download(session, inputId,
   sha256)` with the member's token, which answers `{schema: "qorpera.room-image-download/v1", environmentId, sessionId,
   inputId, sha256, bytes, mediaType, manifestSha256, fileSha256, path}`, and serves that file. Any member who may read
   the conversation may download (a viewer too).

The begin's refusals: 42501 "Member attachment authority is required" (not a member's token), 22023 "Member attachment
is invalid" (no input id, or an image outside the limits above), 42501 "Member attachment session is unavailable"
(not a member of the open conversation's room, or the company was deleted meanwhile), 42501 "Submitted input
attachments cannot change" (the input is posted), 55000 "Attachment folder is unavailable" (no root), 55000 "Member
attachment could not be saved" (the sweep removed the input's uploads meanwhile; begin again), 23505 "Attachment input
id is bound to another member" and 54000 "Member attachment capacity is reached" (a sixth image, or more than 8 MiB;
the same image again does not count). The
commit's refusals: 42501 "Member attachment authority is required" (not the service role), 22023 "Member attachment is
invalid" (`file` other than exactly those five keys with `executable` false, or an image outside the limits), 42501
"Member attachment session is unavailable" (no such conversation, an input id nobody began, another member's input, or
the member no longer in the room), 42501 "Submitted input attachments cannot change" (the input was posted, before or
during the save), 55000 "Attachment folder is unavailable" (no root), 54000 "Member attachment capacity is reached" and
55000 "Member attachment could not be saved" (the folder refused the write). The download's refusals: 42501
"Chat attachment access is unavailable", "Canonical chat input is unavailable" (no such member prompt in the
transcript, or its message erased) and "Attachment does not belong to this canonical input", and 55000 "Attachment
object is unavailable" (the file is gone).

Images no input lists are deleted a day after the input's last upload, by a sweep every minute
(`qorpera_room_image_orphan_sweep`, pg_cron job `qorpera-room-image-sweep`, at most one folder commit per call): the
whole folder of an input never posted, and the images a posted input does not list. Erasing a message (memory step
M3) deletes that message's images (its input's folder) with its lines. The memory zoom's `attachments` stay `{mediaType, bytes}` for
now; an image's path comes to the zoom with the runtime that opens it.

### Coding environment secrets (20260928549440_coding_environment_secrets)

The environment variables of a coding session's commands (an npm token, a Sentry DSN). Each is a vault secret captured
like any other (`qorpera_begin_cloud_secret_capture`, the broker's screen, completion) with the connector id
`environment`, owned by the company (owners and administrators capture those) or by the member. Its secret name is the
variable's name in lower case: `npm_token` for `NPM_TOKEN`. A name is `[a-z][a-z0-9_]{0,63}`, never one the coding
machine sets itself (`home`, `path`, `tmpdir`, `user`, `shell`, `lang`, `tz`, the proxy and certificate variables, and
any name that starts `lc_`, `git_`, `ld_`, `dyld_`, `ssh_`, `xdg_`, `docker_` or `qorpera_`), and never one that names
a harness's login or provider (`anthropic_`, `claude_`, `codex_`, `openai_`), so no secret changes who pays for a
session. The begin refuses any other name with 22023 "That name is not available for an environment variable". A
value never comes back to a client. The broker's screen seals only the one field `value`, at least 8 UTF-8 bytes long
and without a NUL, so the coding machine can mask it in its output; it refuses any other capture for `environment`.

A coding session gets its member's own environment secrets and the company's that an owner or administrator granted on
its repository; a company secret with no grant reaches no session. When the member's and a granted company secret have
the same name, the company's wins.

- `qorpera_list_coding_environment(profile, environment)`: `[{schema: "qorpera.coding-environment-secret/v1",
  secretId, name, ownerKind, purpose, version, grants, createdAt, updatedAt}]`, the company's environment secrets and
  the caller's own, by name. `name` is the variable's (upper case); `grants` lists a company secret's live grants,
  `[{grantId, repository, issuedByUserId, createdAt}]` by repository (always `[]` for a member's). Every member may
  read it, a viewer too; anyone else gets `[]`.
- `qorpera_grant_coding_environment_secret(profile, secret, repository)`: an owner or administrator gives a company
  environment secret to the coding sessions of one GitHub repository, `owner/name` in any case (kept in lower case, as
  GitHub compares names). Answers `{schema: "qorpera.coding-environment-grant/v1", grantId, secretId, repository,
  issuedByUserId, status, createdAt}`; granting it again answers the live grant. Refusals: 42501 "coding environment
  grants need an owner or administrator", 22023 "A repository is named owner/name", 42501 "company environment secret
  is unavailable" (a member's secret, another connector's, a disconnected one, or a name no longer allowed).
- `qorpera_revoke_coding_environment_grant(profile, grant)`: an owner or administrator withdraws a grant. The same
  answer with `status: "revoked"`, also for one already withdrawn; 42501 "coding environment grant is unavailable" for
  a grant the company does not have.

A grant also ends when its secret is disconnected (`qorpera_revoke_cloud_secret`), and for good when the member who
gave it stops being an owner or administrator or leaves: promoting them again revives none, so another owner or
administrator grants it again. Rotating the secret keeps its grants. A member's own environment secrets end when they
leave, as their other secrets do.

### Coding MCP sign-ins (20260928559210_coding_mcp_sign_ins)

The API key a coding session's MCP server needs (an HTTP MCP server that asks for a sign-in). Each is a vault secret
with the connector id `mcp`, owned by the company (owners and administrators start those) or by the member, captured
like any other secret but started only with `qorpera_begin_coding_mcp_sign_in`, which names the server: a plain
`qorpera_begin_cloud_secret_capture` under `mcp` never completes. The broker forwards the session's requests to that
server with the key in a header, so the key never reaches the coding machine. A value never comes back to a client.

A server is named by its origin, `https://host[:port]`: lower case, no path, no `:443` (so an origin has one spelling),
a DNS name of two labels or more whose last label is not a number (decimal or `0x` hex, so no address in any spelling a
URL parser reads as one) and not one kept for private networks (`localhost`, `local`, `internal`, `lan`, `home`, `corp`,
`test`, `example` and others). The broker also refuses a private address when it connects. There is one active sign-in
per owner and origin. A member's own sign-in reaches only that member's coding sessions; the company's reaches every
coding session in the company. For an origin both have, the company's wins. Disconnect (`qorpera_revoke_cloud_secret`)
ends a sign-in; a member's own end when they leave, as their other secrets do. Rotate one with
`qorpera_begin_cloud_secret_capture` and the existing secret (connector `mcp`, its `secretName`).

- `qorpera_begin_coding_mcp_sign_in(profile, environment, ownerKind, origin, headerName = 'authorization',
  headerPrefix = 'Bearer ')`: starts the capture of an API key for the server at `origin`, owned by the company
  (`ownerKind: "company"`, owners and administrators) or by the caller (`"member"`, any member who may write). The key
  travels in `headerName` (a lower-case header name, never one the relay or HTTP sets itself: `host`, `cookie`,
  `content-type`, `origin`, the `proxy-`, `x-forwarded-`, `mcp-` and `sec-` families and others) after `headerPrefix`
  (empty, or one word and a space). Answers the capture (`qorpera.cloud-secret-capture/v1`: `ticketId`,
  `captureCapability`, `serviceOrigin`, `scope`, `expiresAt`; the broker's screen takes the key) and `signIn:
  {schema: "qorpera.coding-mcp-sign-in/v1", secretId, origin, kind: "api_key", headerName, headerPrefix}`. Refusals:
  22023 "An MCP server is named by its origin, https://host[:port]", 22023 "That header is not available for an MCP
  sign-in", and the capture's own (42501 "secret capture requires company write access", 22023 "secret capture scope
  is invalid" for a company sign-in a contributor starts, 23505 "an active secret already has this name" for an origin
  that already has one of this owner's).
- `qorpera_list_coding_mcp_sign_ins(profile, environment)`: `[{schema: "qorpera.coding-mcp-sign-in/v1", secretId,
  secretName, origin, kind, headerName, headerPrefix, ownerKind, version, createdAt, updatedAt}]`, the company's
  active sign-ins and the caller's own, by origin. Every member may read it, a viewer too; anyone else gets `[]`.

### Company sites (20260930550000_company_sites)

Websites the company's agents publish from the company folder (`publish_site`), each at a private link
`https://sites.qorpera.com/<slug>/` that visitors open with the site's password (`supabase/functions/site-serve`).
Settings → Sites. Built switched off (`qorpera_site_settings.enabled`) until the sites host is routed.

- `qorpera_list_company_sites(profile)`: `[{schema: "qorpera.company-site/v1", id, slug, title, url, state, source,
  files, bytes, publishedAt, publishedBy, createdAt, passwordChangedAt}]`, newest published first, for any member of
  the company (viewers too; 42501 for anyone else). `state` is `live`, or `publishing` while a site's first upload has
  not finished (its link does not work yet). `source` is the Company File path it was published from; `publishedBy`
  is `{agentId, name}`, or null when that agent is gone. Never a password. A repository's own site (20260930729000,
  "What's new" below) is listed only once a member has put a version of it live, in the same row: `source` is
  `code/<owner>/<name>` (tell a code site by that prefix; `publish_site` never publishes a folder under `code/`) and
  `publishedBy` is null. Until then it waits in What's new, and it still counts toward the company's 10 sites.
- `qorpera_company_site_password(site)`: `{schema: "qorpera.company-site-password/v1", siteId, password, changedAt}`,
  owners and admins only (42501 for anyone else, a site that is gone included).
- `qorpera_set_company_site_password(site, password)`: owners and admins. `password` null makes a new random one;
  otherwise 10 to 128 characters, no control characters, not only spaces (22023 "A site password is 10 to 128
  characters"). Every visitor's session ends, so they enter the new one. Answers as `qorpera_company_site_password`.
- `qorpera_unpublish_company_site(site)`: owners and admins. Deletes the site, its files, password and sessions at
  once (the Company File keeps the source). `{schema: "qorpera.company-site-unpublish/v1", siteId, removed}`;
  `removed` false when it was already gone.
  For a repository's site its kept versions and the way back go with it. The site is then off, not gone for good: the
  newest change that left a site is due again at once, so the executor's next upload pass (within about a minute, no
  new change needed) makes the site again under its name, with a new password and not live, and it waits in What's
  new until a member puts it live.
- The tables are closed to every API role; the agent's and the edge function's calls are service-only.

#### An address of its own (20260930756000_site_hosts)

Every files site gets a host of its own, `https://<slug>.qorpera.com/`, served at the top (links from `/` are the
site's own), and a repository's site a next host, `https://<slug>--next.qorpera.com/`, where owners and admins look
at a version before it is live (Look first, "What's new" below). Built switched off: the operator sets
`qorpera_site_settings.hosts_domain` first and `hosts_enabled` last (the column takes `qorpera.com` and no other value,
23514: site-serve, the web and the executor have that domain written in, so the one host rule is one domain everywhere),
only once the web that parses the
host form, the app relay's cross-origin refusal and the front's `site-hosts` route are live (STEP5-BUILD's order);
`hosts_enabled = false` is the way back.

- The link form. While hosts are on, `url` in `qorpera.company-site/v1` (and every other site link: the agent's
  publish answers, What's new) is a files site's own host, `https://<slug>.qorpera.com/`, with the path `/`; while
  they are off it is `https://sites.qorpera.com/<slug>/` as before. An app link's is `https://<slug>-preview.qorpera.com/`
  either way. The row's keys do not change, only the form of `url`: a deliberate exception to "breaking changes ship a
  `_v2`" (section 8), made safe by its order: a client must accept both forms (any https host with the path `/`, or
  the path `/<slug>/`) before the operator turns hosts on.
- A site's name (D20, `qorpera_site_slug_valid`, also the coding executor's): `a-z`, `0-9` and `-`, 3 to 48, a letter
  or digit at both ends, never two hyphens in a row, not ending `-preview`, never holding `qorpera`, and none of the
  reserved names (one text, `qorpera_site_reserved_names()`: every name the platform has or plans under qorpera.com).
  A new platform name under qorpera.com is reserved by a migration first, after production is read for a site of that
  name, and only then gets its DNS record, tunnel hostname or envoy host.
- A host is a site host when, lower-cased, it ends `.qorpera.com` and the one label before it is a slug that passes
  the rule (an own host), or such a slug followed by `--next` (its next host). As one regex:
  `^([a-z0-9]+(?:-[a-z0-9]+)*)(--next)?\.qorpera\.com$`, the slug in group 1, its length (3 to 48) and the rule
  checked apart.
- `qorpera_company_site_access(profile)`: `{schema: "qorpera.company-site-access/v1", hosts, sites: [{siteId, slug,
  title, kind, source, takenDown}]}` for any member (viewers too; 42501 "Only the company's members see its sites"
  otherwise). `hosts` says whether sites have hosts of their own; `takenDown` is `{at, reason}` for a site Qorpera's
  operators took down (Sites says why: "Qorpera took this site down: <reason>"), else null. Every site of the company,
  by slug, also a project's site that never went live, which `qorpera_list_company_sites` leaves out: Sites draws the
  row of such a site taken down from its `slug`, `title` (or null), `kind` and `source`. Read leniently: later steps add
  keys (public sites, own addresses).
- A site taken down answers 410 on every host of it (an app link answers as off), nothing goes live on it (What's
  new's writes answer `refused`, `SITE_TAKEN_DOWN`), and Look first does not open. Nothing is deleted, and a takedown
  sticks until the operator restores it: `qorpera_unpublish_company_site` refuses such a site (55000 "Qorpera took this
  site down, so it stays as it is until Qorpera restores it. If you think this is wrong, tell us with Feedback in your
  menu.", nothing written; Sites offers no menu for its row), `qorpera_delete_hosted_profile` refuses while any site
  of the company is down (55000 "Qorpera took one of this company's sites down, so the company can't be deleted until
  Qorpera restores the site. If you think this is wrong, tell us with Feedback in your menu."), a deletion asked before
  waits, and its name is never free to another company. Only the operator takes a site down or restores it.
- What an agent reads (the platform's calls, not a client's): every refusal of a site's name (`SITE_NAME_INVALID`,
  22023, by `publish_site`, `share_app` and `unpublish_site`) says the rule in one sentence
  (`qorpera_site_name_words()`, which the coding executor and the runtime say byte for byte). A site of the company
  taken down takes nothing from an agent: `publish_site`'s, `share_app`'s and `unpublish_site`'s calls refuse it with `SITE_TAKEN_DOWN: This
  site was taken down by Qorpera (<reason>) and cannot be published until Qorpera restores it. Tell a member of the
  company.` (55000, no address, nothing written); a repository's site takes no upload while it is down, and its list
  file's `index` then has `live` null, no `preparing` and `takenDown: {reason}`.
- **The cookie invariant (D22).** Sites are sibling hosts of the app and the API under qorpera.com, so no Qorpera
  program takes a cookie, HTTP auth, a client certificate or anything else a browser sends by itself as proof of who is
  calling, on any qorpera.com host, except the sites' and the app links' own `__Host-` gate cookies
  (`__Host-qorpera_site`, `__Host-qorpera_app`). Auth's redirect list stays exact, never a wildcard. A future platform
  cookie is `__Host-` (no `Domain`), and a request that changes something also needs an Origin or Fetch Metadata check.
  Reviews hold every change to this rule.

#### Seen inside Qorpera: a member's pass (20260930774000_site_member_pass)

The web shows a files site in a frame on its own host (company views step 4, V1), opened without the site's password.
`deploy/sites/SITE-HOSTS.md` ("Seen inside Qorpera") is the operator's side.

- `qorpera_site_member_pass(site)`: any member of the site's company (viewers too). 42501 "Only the company's members
  open its site here" for anyone else, and the same for no such site, an app link or a company being deleted; 22023
  for no site. Answers `{schema: "qorpera.site-member-pass/v1", state, ...}`:
  - `open`: `host` (`<slug>.qorpera.com`), `pass` (43 characters of base64url), `expiresAt` (60 seconds on), `action`
    (`https://<host>/__qorpera/member`). One use, for that site's own host only; only its SHA-256 is kept.
  - `off` while hosts are off; `gone` for a site taken down; `none` for a site not live; `limited` with `retryAfter`
    (seconds) while the member holds 30 open passes. Nothing is written for these.
- Using it: a form `POST` to `action`, `application/x-www-form-urlencoded`, fields `pass` and optionally `path` (a
  path of the site such as `about/`, with or without its leading `/`; anything else opens the top), submitted so that
  the frame navigates (a form with the frame as its `target`, or a form in the frame's own document). The answer is
  303 to that path with the session cookie, or the site's password page (401) for a pass that failed. Ask a new pass
  for each open and each reload; never put a pass in a URL.
- **The submitting document must send its real `Origin`.** The door takes only an `Origin` exactly one of the web's
  origins; `null` is refused. A form POST from a document under `Referrer-Policy: no-referrer` sends `Origin: null`
  (Fetch: a non-CORS request's origin is serialized as null under that policy), and app.qorpera.com is served with
  `no-referrer` (`packages/web/public/_headers`, and the `<meta name="referrer">` of `index.html`). Its CSP also has
  `form-action 'self'` and no `frame-src` (so `default-src 'self'` blocks a frame of a site host). So the web, as
  built today, cannot use the door; V2 must change one of these, and the choice is a security-header decision for the
  web's lead:
  - **A door page (recommended: the app keeps `no-referrer`).** A static same-origin page, say `/site-door/`, with its
    own `_headers` entry. Cloudflare Pages applies the `/*` block to it too, and a browser enforces every CSP it gets,
    so the entry first removes what it inherits, as `/page-preview/*` does: `! Content-Security-Policy`,
    `! X-Frame-Options` and `! Referrer-Policy`. Then it sets `Referrer-Policy: strict-origin` (it sends only
    `https://app.qorpera.com`), `X-Frame-Options: SAMEORIGIN` (or none), and a CSP of its own with
    `form-action https://*.qorpera.com`, `frame-ancestors 'self'` and its script from `'self'`. The page has no
    `<meta name="referrer">` of `no-referrer`. The site view's frame loads it; the app hands it the pass by
    `postMessage` (target origin its own, checked on receipt); the page submits the form to `action` in its own
    document, so the frame navigates to the site.
  - The app itself: `frame-src 'self' https://*.qorpera.com` in its CSP (the frame's every navigation is checked
    against the app's `frame-src`, the site host after the door's 303 too). Its `form-action 'self'` and
    `no-referrer` then stay as they are.
  - Or the app as a whole moves to `strict-origin-when-cross-origin` and adds `https://*.qorpera.com` to
    `form-action` (simpler; every request from the app then carries its origin as Referer).
- The frame: own-host answers may be framed by the web's origins (`frame-ancestors 'self' <origins>`, no
  `X-Frame-Options`); a next host's may not. Views of a member's session are not counted (`site-*` questions).

### What's new: a repository's site, put live by a member (20260930729000_code_releases)

A repository kept in Qorpera whose checks file has a `site` key: the checks of each change that goes in build its
website, Qorpera keeps it as a version of the repository's own site (at `https://sites.qorpera.com/<slug>/`, or at
`https://<slug>.qorpera.com/` once hosts are on, behind its password, which is in Sites), and only an owner or admin puts a version live, or goes back to the one before, on
the What's new page. Nothing goes live by itself.

- `qorpera_list_code_releases(profile)`: `{schema: "qorpera.code-releases/v1", canRelease, sites: [{owner, name, site,
  live, back, ready, waiting, problem, givenUp}]}` for any member of the company (viewers too; 42501 "Releases unavailable" for
  anyone else). `canRelease` is true for owners and admins. One entry per repository that has a site or made one, at
  most 10: every repository with a site first (a company has at most 10 sites), live ones before the rest, then those
  that made a site and have none now, a `problem` first, the newest change first (by owner and name within each):
  - `site`: `{slug, url, title}`, or null until the first version was kept.
  - `live`: `{version, kind, since, by, from}` or null when nothing is live. `version` is the number members see;
    `kind` is `release` (a member put it live) or `back` (a member went back to it, showing its number again, and
    `from` is the version it took off); `by` is the member's user id.
  - `back`: `{version}`, what Go back puts live, or null when no earlier version is kept.
  - `ready`: what goes live with the next yes, or null: `{change, token, agent, changes: [{key, notice, picture, at,
    wasLive}], quiet}`. `change` and `token` are what the yes names. `changes` are the ready changes that say what a
    customer will notice, newest first (at most 20): `picture` a Company File path or null, `at` when it went in,
    `wasLive` true for a change that was live before a Go back took it off; `key` is for the list only, never shown.
    `quiet` counts the other ready changes ("behind the scenes"). `agent` is the staff agent to tell "Not yet", or null.
  - `waiting`: changes that went in and are not ready yet.
  - `problem`: why the site of the change due now could not be prepared: the code of its last failed upload, while
    that change is the newest one that left a site and its version is not ready yet (`SITE_LIMIT`: the company has 10
    sites, and the site is made once one of them goes; `SITE_NAME_TAKEN`: every name the site may take is taken, and
    it is made once one is free). Otherwise null: as soon as that version is ready (also when an upload's last answer
    was lost), when a newer change that leaves a site overtook it, after a member took the site offline, and while
    Qorpera's operators have the repository's sites switched off (then nothing is prepared and nothing is said).
  - `givenUp`: true while Qorpera has stopped trying: `problem` is set, its change failed five times, and nothing has
    changed since that lets it try again. False otherwise, and always when `problem` is null. It turns false with a
    newer change that leaves a site, an upload that finishes, a member taking the site offline, and, for `SITE_LIMIT`,
    once the company has fewer than 10 sites, or for `SITE_NAME_TAKEN`, once one of the names is free. A `problem`
    with `givenUp` false means Qorpera tries again.
- `qorpera_put_code_release_live(profile, owner, name, shown)`: owners and admins (42501 otherwise). `shown` is exactly
  what the page showed, `{live: <live.version, or null>, change: <ready.change>, token: <ready.token>}` (22023
  otherwise); a repository the company does not keep is P0002 "No such repository". Answers
  `{schema: "qorpera.code-release/v1", state: "live", version, url}`, or `{schema, state: "moved"}` when the page is
  no longer what is live and ready (read it again; nothing changed). Changes ready after the page was drawn wait for
  the next version. The site serves the new version from the visitor's next request.
- `qorpera_code_release_back(profile, owner, name, shown)`: owners and admins. `shown` is exactly `{live:
  <live.version>, to: <back.version>}`. Answers as above; the changes of the version it took off are ready again.
- Both writes give up after 3 s of waiting for the repository (55P03; nothing changed). Since 20260930756000 both may
  also answer `{schema, state: "refused", code: "SITE_TAKEN_DOWN"}`: Qorpera took the site down, and nothing changed.
- Since 20260930756000 (site hosts): while hosts are on, `qorpera_list_code_releases` has a top-level `preview`, true
  for owners and admins (absent while hosts are off: read it as false), and `site.url` and the writes' `url` name the
  site's own host.
- `qorpera_open_site_preview(profile, owner, name, change)` (Look first): owners and admins (42501 "Releases
  unavailable" otherwise); `change` is the page's `ready.change` (22023 "Look first request is invalid" when it is no
  positive number); P0002 "No such repository". Answers `{schema: "qorpera.site-preview/v1", state}`: `off` while hosts
  are off (hide the button); `moved` when that change is no longer a ready point with a version (say "Something
  changed while you looked" and read the page again); `gone` when Qorpera took the site down; or `open` with `url`,
  `https://<slug>--next.qorpera.com/.qorpera/enter?t=<43 characters>`: a one-time ticket of 2 minutes. Open a blank tab
  within the click, set its `opener` to null, then send it to `url` (close it on any other answer). The next host shows
  exactly the version Put it live would put live, for 12 hours, under a "Not live yet" bar, to the member who opened it.
- The tables are closed to every API role; the executor's calls are not a member's.

### Downloading the company's code (20260930720000_code_change_record)

The repositories a company keeps in Qorpera (`code/<owner>/<name>/` in the company folder), and their code as one file
a member downloads: the coding executor makes it under `code/<owner>/<name>/downloads/`, and the web reads it there
with the member folder client. Storage → the repository's folder → "Download the code".

- `qorpera_list_code_repositories(profile)`: `{schema: "qorpera.code-repositories/v1", canDownload, repositories:
  [{owner, name, changes, downloads: [{requestId, file, state, path, bytes, madeAt, expiresAt}]}]}` for any member of
  the company (viewers too; 42501 "Code unavailable" for anyone else). `canDownload` is true for owners and admins.
  `changes` is how many changes the repository's record holds. `downloads` are the ones on their way (`state`
  `queued` or `running`) and the made ones whose file is still there (`ready`, with `path` and `bytes`): a made
  download is over after 7 days, as soon as the job of a newer download of the same `file` begins (it replaces the
  file), and as soon as a restore of the repository from its copy begins to move its folder aside. It is over
  before the file goes, whatever becomes of that job, so `ready` always has its file. Since
  `20260930735000_code_restore_follow_ups` also `githubCopies: [{owner, name, github}]`: the folders under `code/`
  that hold a copy of a GitHub project (made by the company's GitHub coding sessions, archived ones too) where no
  repository is kept in Qorpera. `owner` and `name` are the folder's (`code/<owner>/<name>/`, lower case), `github`
  the project as GitHub names it (`Owner/Name`, as its newest session there named it). At most 100, ordered by
  folder. A client from before the key ignores it; a cloud from before it has no such key (read it as `[]`).
  Since `20260930736000_code_import` also, always, `bringing: [{owner, name, from, step, waiting, startedAt}]`: the
  code being brought in now (oldest first; `[]` when none; a cloud without the key cannot bring code in). `from` is
  `{github: "Owner/Name"}` or `{file: "<the bundle's name>"}`; `step` null before its first step, else `fetch`, `read`,
  `look`, `close`, `set-aside`, `build`, `open` or `tidy`; `waiting` null or why it waits for the company's agents
  (`SESSIONS_BUSY`, `SESSIONS_ATTACHED`, `SESSIONS_OPEN`). `lastImport`: null, or `{owner, name, from, state, reason}`
  for the company's newest import of the last 24 hours, when it ended `refused` or `failed` (`reason` its code, as
  `IMPORT_USES_LFS`; a suffix after `:` may follow). Each repository gains `importedFrom`
  (`{kind: "github", repository: "Owner/Name"}`, `{kind: "file", name}`, or null for code begun in Qorpera),
  `importedAt` and `earlierChanges` (how many earlier changes came with it, or null). No commit, path or byte count.
  A repository whose import has not ended yet (recorded, but its folder not open yet) is in `bringing` (at step
  `open`), not in `repositories`, until its import's end puts it there. Since
  `20260930741000_code_import_follow_ups` each repository also has `otherWork`: `{lines, changes}` when other lines of
  work came with it that held changes its main version did not have (`lines` how many such lines, `changes` how many
  such changes, each at least 1), else null (none came, the code began in Qorpera, or it came in before the key). A
  client from before the key ignores it; a cloud from before it has no such key (read it as null). No line's name.
- `qorpera_request_code_download(profile, owner, name, file)`: owners and admins (42501 otherwise). `file` is `files`
  (main's files, a `.zip`) or `history` (main with its history, a git `.bundle`); anything else is 22023, a repository
  the company does not keep is P0002 "No such repository". Answers `{schema: "qorpera.code-download/v1", requestId,
  file, state, reason, path, bytes}`: `ready` with the made file when the code has not changed since; else the open
  request of that file (`queued` or `running`); else `refused` with `reason` `too_many` (20 download requests of the
  company in 24 hours) or `no_executor`; else a new request, `queued`.
- `qorpera_code_download(profile, request)`: owners and admins; how that request stands, in the same shape. Besides
  the states above: `failed` with `reason` `too_large` (over 200 MiB), `busy` (it was put off behind coding work until
  it ended) or `failed` (anything else, a made file that is over included: its 7 days passed, a newer download
  began to replace it, or a restore began to move the repository's folder; ask again). P0002 "No such download" for
  a request that is not one of the company's downloads.
- `qorpera_request_code_import(profile, owner, name, github)` (`20260930736000_code_import`): owners and admins of
  the company (42501 "Code unavailable" otherwise) bring a GitHub project in as `code/<owner>/<name>/`. `owner` and
  `name` follow a repository's rules (lower case), `github` is exactly `Owner/Name` (22023 "Code import request is
  invalid" otherwise). Answers `{schema: "qorpera.code-import/v1", state: "queued", requestId}` or
  `{schema, state: "refused", reason}` with `reason` one of `kept_here` (a project is kept at that place),
  `already_here` (that GitHub project was brought in at another place), `busy` (other code is being brought in),
  `sessions_open` (agents still work on it on GitHub), `no_executor`, `file_missing`, `deleting`. Asked again for the
  same place and project it answers `queued` with the request that has it (the open one, or the one that brought it
  in). The list says how it goes (`bringing`, `lastImport`, `importedFrom`).
- The tables are closed to every API role; the executor's, the agent's and the operator's calls are not a member's.

### The company's numbers: door `money` (20260930767000_company_numbers_money)

The platform's own numbers of a company, asked by the reserved database name `qorpera` (no company database may carry
it): an interface app's `qorpera.query("qorpera/money-now")` and `qorpera.watch(...)`, a kit's live number, an agent's
`data_query {database: "qorpera"}`. Read only, from the vault's bank summary; sums only, never a name, a transfer's
text, an account number, a single payment or the summary's items. Design: the company-views lane's DESIGN-3.md §E.

- `qorpera_member_company_numbers(environment, question, params)` (authenticated): a member of a folder-v2 company
  (42501 "Company numbers are unavailable" for anyone else). `question` is the name after `qorpera/`, `params` an
  object of named values (`{}` or null for none). Answers the data gateway's answer shape `{columns, rows, more,
  asOf, etag}`: `columns` the names, `rows` arrays in their order, `more` false, `asOf` the time of the answer (ISO,
  UTC), `etag` 32 hex that stay the same while the answer does (a client polls and compares it).
- The `money-*` questions answer only a member who may read `bank/summary.json` by the folder's path authority; for
  anyone else, and for a question that is not there, P0002 "No question qorpera/<question> that you may read" (the
  same words). Kroner are JSON numbers rounded to øre (Danish kroner only); days are `YYYY-MM-DD`. "Today" and "this
  month" (the default range, `money-kinds`' month) are the company's own, in its time zone (`time_zone` of
  `qorpera_profile_team_info`, 20260930739000), or Europe/Copenhagen's while it has none or one the database does not
  know. The answer does not name the zone (the shape has no place for it); a client that shows days reads the
  company's zone from the team read. Until the vault counts in the company's zone (slice M2, migration
  `20260930769000`), the summary's own days and month are the vault's UTC ones, taken at its fetch, and can lead or
  lag the company's by hours: `money-balance`'s default range ends on the summary's newest day when that is the
  company's tomorrow, and `money-kinds`' "this month" is the summary's own month when that is the month of the
  company's today or tomorrow (a month that leads, in a zone behind UTC; either month may be named as `month`, and the
  company's own then has no rows). A summary of an earlier month is never this month's: the company's month has no
  rows until the vault fetches again.
  - `money-now`: one row always: `state` (`none` no bank or disconnected, `waiting` no summary yet, `current`,
    `paused` the bank stopped sharing), `bank`, `balance`, `available`, `reserved`, `as_of` (the summary's time),
    `paused_since`; the numbers are null without a summary.
  - `money-balance` (`from`, `to`; default the 90 days to today, at most 366 days): `day`, `balance` (end of day).
  - `money-expected`: `day`, `balance`, the summary's forecast (an estimate).
  - `money-months`: `month` (`YYYY-MM`), `money_in`, `money_out`, the summary's months (twelve at most).
  - `money-kinds` (`month`, this month only, the default): `direction` (`in`, `out`), `kind`, `amount`, `count`. Out
    kinds `salaries`, `taxes`, `rent`, `utilities`, `subscriptions`, `fees`, `other`; money in is one kind, `all`.
    `count` is null for now (the summary keeps no count of payments).
- The `site-*` questions and `sites` (20260930768000_company_numbers_site) answer any member of the company (viewers
  too) and any run of it, for the company's files sites (never an app link). `site` is a site's name (its slug),
  optional: without it every files site of the company, in name order (22023 `:site is not one of the company's sites`
  for any other name). Hours are UTC hours; days are the company's, by the same zone rule as money. Views are counted
  by site-serve: a page (a `text/html` file) of the live version opened by a visitor's password session (never a
  member's, 20260930774000); a visit is a view whose session had no view of that site in the 30 minutes before; at
  most 60 views a session an hour count. An
  answer has at most 2000 rows (`more` true when it was cut). The upkeep (pg_cron, every 10 minutes) adds finished
  hours to days, keeps hours 35 days and deletes a session's last view time about an hour after it (70 minutes at most).
  - Hours are UTC hours: in a zone offset by half an hour, an hour falls on the local day it starts in, so that day's
    edges are off by up to 30 minutes.
  - Days already added keep the zone the company had then; a later change of zone moves only days added after it.
  - A count that waits more than 100 ms for a lock is dropped (never waited for), so a very busy page can lose a few
    views.
  - `sites`: `site`, `title`, `url` (its own host while hosts are on), `live` (visitors can open it now).
  - `site-now` (`site`): `site`, `here_now` (sessions with a view in the last 5 minutes), `views_today`,
    `visits_today`; one row a site.
  - `site-hours` (`site`, `from`, `to`; default the 48 hours to this one, at most 7 days): `site`, `hour` (ISO, UTC),
    `hour_local` (`YYYY-MM-DDTHH:MI`, the company's), `views`, `visits`; every hour, zeros included. `from` and `to`
    are a time with its zone (`2026-11-14T08:00Z`, `2026-11-14T09:00+01:00`) or a day of the company's (its first or
    its last hour).
  - `site-days` (`site`, `from`, `to`; default the 30 days to today, at most 400): `site`, `day`, `views`, `visits`;
    every day, zeros included.
  - `site-pages` (`site`, `from`, `to` as `site-days`, `limit` 1 to 50, default 10): `site`, `path` (the file's path in
    the site, `index.html`, `about/index.html`), `views`, `visits` (the visits that began there); the most viewed paths
    a site.
- The `orders-*` questions (20260930776000_company_numbers_orders, door `orders`) answer any member of the company
  (viewers too) and any run of it (the founder, 15 Nov 2026: everyone in the company, as site visits; the rule lives in
  one SQL function, `qorpera_company_numbers_orders_readable`). They count the company's orders from its Stripe hooks:
  when the vault verifies a Stripe delivery, the platform keeps one counts-only row a payment (when, how much, in what
  currency, refunded so far, dispute, state), never a buyer's name, email, phone, address, country, IP, card, Stripe's
  customer id, metadata, description or line items, and never Stripe's ids (a hash only). The events read are
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
  `charge.refunded`, `charge.dispute.created` and `charge.dispute.closed`: an agent picks these when it adds the hook's
  endpoint at Stripe. Only Checkout Sessions of mode `payment` are orders: a subscription's later refunds and disputes name its invoices' payments, which its session never names, so subscriptions are left out for now (and `setup` is no order). Events
  may come in any order (a refund before its session is kept and counted once the session comes).
  - Every question takes `currency` (three letters, any case; by default the currency of most of the orders in the
    last 90 days, else DKK) and `test` (`true` answers Stripe test-mode orders, kept apart from live ones; also the
    string `"true"`). Money is a JSON number in the currency's major unit: two decimals, Stripe's zero-decimal
    currencies (JPY, KRW, ...) whole, its three-decimal ones (KWD, BHD, ...) three. An order is a paid one: a session
    still unpaid or whose payment failed is not counted (except in `orders-states`' `failed`). Only counts and sums,
    never one order. Days and months are the company's, by the zone rule above; refunds count on the order's day.
  - `orders-now` (`currency`, `test`): one row always: `stripe` (`none` no Stripe hook, `waiting` none has verified a
    delivery yet, `live`), `orders_today`, `sales_today`, `to_pack` (paid, not refunded in full, a free one too, no state of the
    company's yet, and made no earlier than the first order of the same mode, live or test, that the company ever gave
    a state of its own, so a shop that starts marking on day 40 sees only orders from then on; null while the company
    has set no state of its own in 90 days, so it never grows for a shop that ships nothing), `on_the_way`, `refunds_30d` (refunded on the orders of the 30 days to today), `disputes_open`,
    `last_order_at` (ISO, UTC, or null). `to_pack`, `on_the_way`, `disputes_open` and `last_order_at` count every
    currency; the rest the one asked.
  - `orders-hours` (`currency`, `test`, `from`, `to` as `site-hours` takes them; default the 48 hours to this one, at
    most 7 days): `hour` (ISO, UTC), `hour_local`, `orders`, `sales`; every hour, zeros included.
  - `orders-days` (`currency`, `test`, `from`, `to`; default the 30 days to today, at most 400): `day`, `orders`,
    `sales`, `refunds`; every day, zeros included.
  - `orders-months` (`currency`, `test`): `month` (`YYYY-MM`), `orders`, `sales`, `refunds`: this month and the 11
    before.
  - `orders-states` (`currency`, `test`, `from`, `to` as `orders-days`, for the orders made then; `from` at most 400
    days back, since order rows go then: 22023 otherwise): `state`, `orders`,
    `amount`, one row each of `paid`, `packed`, `on_the_way`, `delivered`, `cancelled`, `failed`, in that order.
    `packed` to `cancelled` are the company's own word (a later slice lets agents and members set them).
  - Order rows are kept 400 days after the order; the days as long as the company. The upkeep (pg_cron, every 10
    minutes) adds changed orders to their days and retries a delivery whose order was locked when it came (while its
    body is kept, 7 days); until then the answers read the order rows, so a day is whole at any time. A day added keeps
    the zone the company had then.
- A name of another shape, a parameter the question does not take or a value out of its bounds: 22023 in plain words
  (`The question takes no :x`, `:from is a day as YYYY-MM-DD`, `From :from to :to is at most 366 days`, ...).
- A run asks the same with `qorpera_run_company_numbers(environment, actor, question, params)` through the native
  host's call (scope folder), with its own path authority.

### The company's reading and standing (20260930765000_company_reading)

The company keeps one short reading of itself, `QorperaOS/vision/reading.md` (Jonas, 14 Nov 2026: "It should feel
like the company is conscious almost"). It is a structured file like the vision: members read it with the company
folder reads above and parse it with `parseCompanyStateFile` (kind `reading`, format in
deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2). There is none until the Co-Founder writes the first one; a
member may delete it. A company whose routines stand still cannot write its own reading, so the platform says it:

- `qorpera_read_company_standing(profile)`: `{schema: "qorpera.company-standing/v1", stopped, since, why, member,
  resetsAt, waiting}`. `waiting` counts the company's routine wakes that are due and still queued; `since` is the
  time the oldest of them has waited from (null when none waits). `stopped` is true when that one has waited more than
  30 minutes and no routine wake of the company was given a run in the last 30 minutes: a member's own turn, a room
  delivery or a worker's run does not count, so a company whose members chat while its routines wait for days reads
  as stopped. `why` reads the login of the member each waiting wake would
  be paid by (its routine's payer, the member who saved it; else the member its agent works for), in the order the
  wakes wait, and names the first that is not ready: `login_full` (with `resetsAt`, when the login's window resets),
  `sign_in` (a new sign-in is needed) or `no_login`; `member` is that member's user id. `why`, `member` and `resetsAt`
  are null when every such login is ready. Any member reads it, a viewer too; anyone else is 42501 "Standing
  unavailable". Read it when the company page opens and every 30 s while it is open.
- The Co-Founder's facts for the reading are a host call of its run, never a member's:
  `qorpera_describe_company_senses(binding)`.

## 3. Realtime

Every private topic's policies on `realtime.messages` also require the row's
topic to be the joined one (`realtime.messages.topic = (select realtime.topic())`;
presence and room drafts since migration `20260928469300_realtime_topic_equality`):
a client joined to one topic reads, and where it may publish writes, only that
topic's rows. A new private topic's policies must do the same.

- `qorpera-live-{profileId}-{userId}` — a company's change hints for one member, pushed by the database
  (migration `20260930653000_member_live_hints`, perf T3). Private broadcast channel, events `sessions`, `staff`,
  `access`, `company-file`, `sidebar` (the tables `qorpera_shared_sessions`, `qorpera_profile_staff`,
  `qorpera_profile_access_state`, `qorpera_company_files`, `qorpera_company_sidebar_revisions`), payload
  `{"schema":"qorpera.live-hint/v1"}` and nothing else: never a row or its id. Ids lower-case,
  as the database writes them. Since `20260930715000_member_messages` also `member-chats`, to the two members of a
  member chat whose message or read mark changed (not the company's other members); a client that falls back to
  `postgres_changes` gets no such hint and reads the member chats on its slow poll. Since
  `20260930712000_machine_member_screens` also `machines`, to every member of the company, when one of its machines is
  made, wanted on or off, removed or fails, another agent drives its screen (or one drives it again after 10 minutes),
  or its placement is made, starts, gets a boot, retires or goes, and since `20260930713000_machine_member_control` when
  a member takes its desktop over or hands it back (not on an action or a heartbeat, nor when a lease runs out: read the
  list again at its `until`): read `qorpera_list_agent_machines` again. Who hears a change is decided per change, at commit: only the topics of the members
  who may read the changed row under its table's read policy then, so a member who leaves hears nothing of the company
  from that commit on but the change to their own access row (which they may read). A member may join only their own
  topic, of a company they are a member of or have an access row in (RLS on `realtime.messages` via
  `qorpera_live_hint_member`), checked at join and at each token refresh; nobody publishes but the database. One hint
  per topic and event per transaction. A nudge only, as before: re-read through the RPCs, keep the slow poll for hints
  missed while disconnected. It replaces the `postgres_changes` subscriptions below, which keep Realtime polling the
  WAL while any client holds one: a client listens by push, and by `postgres_changes` only where its push join is
  refused twice running (a database without the migration). The tables stay in the publication for clients from
  before the push.
- `qorpera-profile-{profileId}` — durable-lane invalidation hints for a profile
  (sub-channels seen in the shell: `sessions`, `staff`, `trail`,
  `company-tree`, `company-projection`, `workspace-inbox`). Hints only: the
  client re-reads through RPCs; large bodies never travel on this channel. The web's
  `postgres_changes` subscriptions on the four tables above (filter `profile_id=eq.{profileId}`) are its fallback
  since the push; Realtime checks each subscriber's read policy per change for them.
- `postgres_changes` on `qorpera_company_sidebar_revisions` (filter
  `profile_id=eq.{profileId}`, member-readable, one row per company) — the
  shared sidebar changed, by a member or an agent: one hint per change however
  many agents it renumbered; re-read with `qorpera_read_company_sidebar`. The
  section and placement tables themselves are not readable or published. The web
  follows it only after the read RPC answered: by push, the `sidebar` event of the
  member's live topic; by `postgres_changes`, on its own channel, so a cloud
  without the table never degrades the company channel. Pins and hidden agents
  are not published.
- `qorpera-presence-{profileId}` — lossy presence (typing, who-is-viewing).
  Private channel authorized by membership through RLS on
  `realtime.messages`; never stored; must never carry durable content.
  Topic name from `qorpera_presence_topic_profile`. Agent presence over the
  live Company File (contract 5.2) will extend this channel at Order 4.
  The web client tracks the open conversation's session id in the tracked
  `staff_agent_id` field (the desktop's staff thread), signed the same way,
  and `null` while its tab is hidden; it shows other members' faces in that
  conversation's header. It joins only when the company has another member.
- `qorpera-room-drafts-{roomId}` — shared drafts (migration
  `20260928000500_room_shared_drafts`): a room member's unsent message, which
  the room's other members see and edit live. Private broadcast channel, event
  `draft`, payload `qorpera.room-draft/v1` (`ownerUserId`, `body`, `revision`,
  `editorUserId`, `contributors`, `updatedAt`, and `quotes` when the draft has
  any). Members of the room receive it
  (RLS on `realtime.messages` via `qorpera_can_share_room_draft`); nobody
  publishes: only `qorpera_put_room_draft` sends, through `realtime.send`, so a
  change always names the editor the token did. Lossy: `qorpera_list_room_drafts`
  re-reads, and a write from a stale revision returns the current draft.
  `qorpera_put_room_draft(room, owner, base revision, body, quotes?)` writes only from the
  current revision (0 starts the caller's own draft; only the owner starts one);
  any active member of the room edits an existing draft. Access is the room post
  rule: an active member of an active room. Drafts never send, wake or sponsor
  anything; the owner sends with `qorpera_post_company_room_message` as before.
- `qorpera-folder-{environmentId}` — a folder-v2 company's folder changed (migration
  `20260928469260_folder_core_member_hint`, folder core C4 P30). Private broadcast channel, event `folder`,
  payload `{"schema":"qorpera.folder-hint/v1","seq":<n>}` and nothing else: the folder's clock reached seq `n` (a
  change set or an authority change; the same number as the feed's seq and a run's `companySeq`). Members of the
  company receive it, not while it is being deleted (RLS on `realtime.messages` via `qorpera_folder_hint_member`);
  nobody publishes but the database. `CloudMemberFolderHints` (cloud-client) follows it.
  Topic name from `qorpera_folder_hint_topic`. A nudge only: on a hint, ask `qorpera_member_folder_changes` from the
  position you hold, at most about once a second, and keep a slow poll for hints missed while disconnected.
- `qorpera-orchestrator-wake-{64 hex}` — **node only, not for clients**
  (migration `20260928319550_runtime_orchestrator_wake`). A runner orchestrator's
  wake-up: while `qorpera_orchestrator_wake_settings.enabled` is on, the database
  broadcasts event `wake`, payload `{"schema":"qorpera.orchestrator-wake/v1"}`
  and nothing else, when claimable work may have appeared. Private channel read
  by `anon` (the orchestrator joins with the publishable key) on that topic only.
  The name derives from the control token's sha256, which only the database
  keeps; nobody publishes but the database.

## 4. Object gateway (HTTP, `packages/object-gateway`)

Member requests authenticate with the user token; the gateway checks
Supabase authority, hashes uploads server-side, and confirms the catalog
only after durable storage.

- `GET /v1/member-folder-objects/<environmentId>/<sha256>` — a folder-v2 company's bytes for a member (folder core
  C4, P27b), one manifest or chunk of a file the member may read, now or in a version they may read
  (`qorpera_member_folder_object`, checked before and after the read). Behind the member company gateway like the
  other member routes. `CloudMemberFolderClient.readFile` fetches the manifest, then its chunks, and checks each
  against its hash and the whole against the file's.
- `PUT /v1/member-session-attachments/upload/<sessionId>/<clientInputId>/<sha256>` and
  `GET /v1/member-session-attachments/input/<sessionId>/<inputId>/<sha256>` — a member's chat images (§2 "Chat images").
  On folder-v2 the routes move onto `qorpera_room_image_begin`, `qorpera_room_image_commit` and
  `qorpera_room_image_download` with the gateway change that follows 20260930260000; until it deploys they serve
  snapshot-v1 sessions only.
- `POST /v1/member-message-erases/<environmentId>/<sessionId>/<eventId>` (no body) and
  `GET /v1/member-message-erases/<environmentId>/<eraseId>` — an owner's or admin's erase of one message of a
  conversation, and where it stands (M3c; `qorpera_memory_message_erase_request` and `_status` for the member the
  token names). Both answer `qorpera.memory-message-erase/v1` (`eraseId`, `state`, `sessionId`, `eventId`, `blocks`,
  `runsPending`, and `copies`, migration `20260930470000`: each `{environmentId, path, live}`, a file at another path,
  in any environment of the company, that holds the message's memory, which the erase leaves and the member erases
  there by its path; `live` when the path is in that folder now, else only its history holds it); 403 for someone who
  is no member, and for a member who is no owner or admin on POST (GET answers them 404, as an erase they may not see);
  404 for a missing conversation, message or erase; 423 in a paused company.
  Behind the member company gateway like the other member routes.
- `/healthz`, `/livez`, `/readyz`
- `GET /v1/member-machine-screens/<companyId>/<machineId>[/watching]` (20260930712000; not the object gateway's: the
  node's mux sends it to the coding executor's member listener) — a member's look at an agent's desktop, with the
  member's token and, when the member has a picture, `If-None-Match: "<etag>"`. `/watching` says the member still
  watches (the window opened, a touch in it, or "Still watching?" answered), which keeps the desktop on 30 minutes from
  then. 200 `image/png` with `etag`; 304 when it is the member's picture; 409 `{code}`: `MACHINE_NOT_RUNNING`,
  `MACHINE_NEEDS_COMPANY_VIEW`, `SCREEN_TOO_SOON` (within 400 ms of the last look), `DESKTOP_NOT_RUNNING` (the screen
  is off), `MACHINE_BOOT_CHANGED`, `MACHINE_IMAGE_WITHOUT_SCREEN`, `SCREEN_HIDDEN` (the machine holds a read of the
  company folder this member may not read) or `SCREEN_HELD` (the folder has not released what the machine read: look
  again); 401 for a token the database does not take; 403 for a machine that is not there for the member. Behind the
  member company gateway like the other member routes. Since 20260930713000 also `DESKTOP_MEMBER_IN_CONTROL`: another
  member holds the desktop (the list says who), or took it over while this look was on its way (its picture never
  leaves: review r1 F1).
- `POST /v1/member-machine-screens/<companyId>/<machineId>/act` (20260930713000; the same listener) — an action of the
  member who holds the desktop, with their token, `content-type: application/json` and `{"action": {...}, "epoch": n,
  "seat": s}` (at most 16 KiB; `epoch` and `seat` the hold the input was captured under, each a whole number from 0:
  F24 and F26 of #1661): `{type: click, x, y, button?}`, `{type: double|move, x, y}`, `{type: drag, x, y, toX, toY}`, `{type: type,
  text}` (1 to 500 characters, no control character but a line break or a tab), `{type: key, keys}` (1 to 16 names such
  as Return or ctrl+l, none an xdotool command word), `{type: scroll, direction, steps?, x?, y?}`; positions are the
  screen's pixels (the picture's own size). Never `open`. 200 `{schema: "qorpera.member-machine-act/v1", exitCode}`
  (the action's exit; null when it was cut off); 400 for a body that is not one action; 409 `{code}`:
  `MACHINE_NOT_RUNNING`, `MACHINE_NEEDS_COMPANY_VIEW`, `DESKTOP_MEMBER_IN_CONTROL`, `DESKTOP_CONTROL_ENDED` (the
  hold the action names ended: handed back, run out, or seated anew by another take-over of the member's), `DESKTOP_BUSY` (another action runs on the desktop: an agent's that
  began before the take-over), `DESKTOP_NOT_RUNNING` (the screen is off), `MACHINE_BOOT_CHANGED`,
  `MACHINE_IMAGE_WITHOUT_SCREEN`, `SCREEN_ACTION_TAKEN`, or the screen helper's own refusals; 401 and 403 as a look.
  The text goes to the machine and nowhere else: never to the database, a log or an answer. Nothing of the screen comes
  back: the client looks again. Behind the member company gateway, which reads a body only for a signed-in member.
- `POST /v1/member-machine-screens/<companyId>/<machineId>/start` (20260930714000; the same listener) — turns the
  desktop on, with the member's token, `content-type: application/json` and the body `{}` (at most 1 KiB; any key is a
  bad request: what to open there is for a later stage). 200 `{schema: "qorpera.member-machine-start/v1", outcome}`:
  `started` (it was off and is drawn now) or `running` (it ran already); 409 `{code}`:
  `MACHINE_NOT_RUNNING`, `MACHINE_NEEDS_COMPANY_VIEW`, `DESKTOP_MACHINE_TOO_SMALL`, `DESKTOP_START_TOO_SOON` (a start
  of this machine within 5 s), `MACHINE_BOOT_CHANGED`, `MACHINE_IMAGE_WITHOUT_SCREEN` or `DESKTOP_DID_NOT_START`; 400,
  401 and 403 as an action. Never refused because an agent runs or acts on the machine (it takes no hold); the client
  looks again at once.
- `POST /v1/company-data/<environmentId>/query`, `/watch`, `/apply` and `/describe` (not the object gateway's: the
  node's mux sends them to the data gateway, `deploy/company-data/`; `deploy/first-node/RUNTIME-COMPANY-DATABASES.md`
  §3 and §5) — a member's question to the company's databases, a held watch of questions, steps to apply, or what a
  database holds, with the member's token, `content-type: application/json` and a JSON body: at most 1 MiB for
  `apply`, 512 KiB for `watch` (up to 24 question texts of 16 KiB each), 64 KiB for `query` and `describe`. Answers
  are JSON with `cache-control: no-store`, passed back with their status. A watch is held up to 20 s by the data
  gateway after its own reads; the bridge allows it 30 s, the others the default 25 s. Behind the member company
  gateway, which reads a body only for a signed-in member.

`/v1/profile-objects/<profileId>/<sha256>` answers only the private `DELETE` folder GC and erasure use (with the
gateway control token, never a member token); the gateway serves no raw object reads or uploads by hash, no read
leases and no member file exports.

Uploads and downloads are always explicit, typed member interactions
(contract 12.2); a client never grants an agent access to the member's
machine.

## 5. Edge Functions

- `native-provider-login` — a member starts the provider-native login handoff
  (Codex / Claude) that runs in an isolated cloud login VM; the client only
  hands the member the link and shows status.
- `computer-billing` (20260928248910) — computer hours payments. The web app
  calls `POST /functions/v1/computer-billing/checkout` with the member's
  bearer token and `{itemKey, profileId?}` (`profileId` for credits, which
  only a founder of that company may buy) and gets `{url}` (Stripe Checkout)
  or `409 {refused: "not_a_founder" | "has_plan" | "item_unavailable"}`;
  `POST .../portal` returns `{url}` (Stripe's billing page) or
  `409 {refused: "no_customer"}`. Only origins in `QORPERA_WEB_ORIGINS` may
  call; every answer from these two routes, errors too, carries the CORS
  headers. `/webhook` is Stripe's alone. Stripe returns the member to
  `QORPERA_BILLING_RETURN_URL` (`https://app.qorpera.com/#/account`) with
  `?checkout=done` or `?checkout=cancelled` after the hash; hours arrive with
  Stripe's webhook, not with the return.
- `event-intake` (20260928259260) — the public address of a company's
  hooks: `POST /functions/v1/event-intake/<address>` from the sender, not
  from clients. Answers 202 (accepted), 200 (duplicate), 400 (malformed), 404
  (not a hook address, by its shape, or no such hook), 405 (not POST), 409
  (paused or not ready), 413 (over the hook's size limit or 256 KiB), 429
  (over the hook's minute or the company's hourly budget, with `Retry-After`),
  431 (headers too large) or 503 (switched off, or retry).
- `mail-intake` (20260928299650) — the mail provider's (Resend's) webhook for
  received email, not for clients: `POST /functions/v1/mail-intake`, signed
  with the platform's signing secret (Standard Webhooks). Answers 200 (every
  recipient settled, other event types ignored, or a message the database
  refuses as malformed, which is logged), 400 (a payload that is not JSON, or
  an `email.received` without a valid message id), 401 (bad or stale
  signature), 405, 413 (over 64 KiB), 429 (a mailbox over its limits, with
  `Retry-After`) or 503 (mail switched off, or retry).
- `site-serve` (20260930550000) — the company sites' public host,
  `https://sites.qorpera.com/<slug>/` (the front proxy sends that host, and no
  other, to `/functions/v1/site-serve/`, and the function answers 404 unless
  `X-Forwarded-Host` is exactly that host), not for clients: a visitor's
  password page, the unlock (`POST /<slug>/.qorpera/unlock`) and the site's
  static files under the visitor's session (`/<slug>/~<token>/<path>`), each
  file sandboxed (`Content-Security-Policy: sandbox`), never framed or indexed.
  Since 20260930756000, while hosts are on (`qorpera_site_settings.hosts_enabled`), it also answers a site's own host
  `https://<slug>.qorpera.com/` and its next host `https://<slug>--next.qorpera.com/` (the front's `site-hosts`
  route), and the old host's links move to the own host (308, or 303 for its unlock). On those hosts nothing is
  sandboxed and every path is the site's: the visitor's session is the host-only cookie `__Host-qorpera_site` (no
  `Domain`, `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax`), the password posts to `/.qorpera/unlock` (Origin
  `https://<host>`), Look first's ticket is taken at `/.qorpera/enter?t=`, a missing path gets the site's own
  `404.html` with 404, a site taken down answers 410, and private and next answers carry
  `Cross-Origin-Resource-Policy: same-origin`, `frame-ancestors 'self'` and an explicit `Cache-Control` with
  `no-transform`. Service worker scripts are refused (404) on every site host. Since 20260930774000 an own host's
  answers name the web's origins (`QORPERA_WEB_ORIGINS`, exact https origins; `https://app.qorpera.com` when unset) in
  `frame-ancestors` and carry no `X-Frame-Options`, a frame's navigation passes its Fetch Metadata check, and
  `POST /__qorpera/member` (`Origin` exactly one of the web's) redeems a member's pass
  (`qorpera_site_member_pass_redeem`, service role only) for a member's session; the folder `/__qorpera/` is never
  served from a site's files. Every answer of site-serve, the old
  host's too, carries an explicit `Cache-Control` with `no-transform` (D23).
  Since 20260930768000 it counts a page view after answering it (`qorpera_site_count_view`, service role only): a GET
  answered 200 or 304 with a `text/html` file of the live version for a visitor's session, with no `Range`,
  `Sec-Fetch-Dest` `document` or absent and no `Sec-Purpose`/`Purpose` (prefetch), on the own host or the old host's
  session path; never on a next host, for an asset, a HEAD, the password page or a refusal. It sends the host, the
  file's path and the session token only; no address, user agent, referrer, query or other header is stored, and no
  cookie is added. The count never changes the answer and delays it by at most 200 ms (none where the edge runtime
  has `EdgeRuntime.waitUntil`).
- `profile-invitation-email`, `artifact-gc-worker`, `runner-control`,
  `runner-broker`, `runner-orchestrator`,
  `computer-hour-notices` (20260928249160, founders' hour emails),
  `mail-outbox` (20260928309740, email agents send from company mailboxes) —
  service or runner authority only. Clients never call them.

## 6. Stability by Order (what a client may build now)

| Surface | State | Client may |
| --- | --- | --- |
| Auth, profiles, membership, invitations, friends, presence | live | build fully |
| Conversations: sessions, inputs, events, replay, Realtime | live (Order 1 mouth writes the canonical transcript) | build fully; render only send operations |
| Approvals | `authorization_request` answered through `qorpera_answer_interaction` (bundle v75) | build the inbox; Approve and Decline call the answer RPC |
| Auto-review rules and approval cards | kernel + runtime in bundle v130 | rules at the bottom of Settings → General; approval cards with Allow once / Deny / Always allow through `qorpera_answer_action_review`; show no live controls until v130 is live |
| Thread interactions (typed cards) | kernel in bundle v75; runtime tool and web cards follow | render `interaction_request` events as cards; answer through the RPC |
| Company File: published snapshots, objects, proposals | live | build browsing/review |
| Company File: live logical paths with ACLs | Order 0 gateway in progress | read-only projection, then live |
| Organization: Co-Founder, responsibilities, projects, rooms, staff | in rework (departments → responsibilities) | build against the semantic projection (contract 14.5); no department UI |
| Screens (Company Computer viewer) | Order 4, plus a browser-facing authenticated websocket gateway (viewer traffic is private-network today) | later |
| Routines, memory | Orders 6, 8 | later |
| Connectors (Gmail, Google Drive, GitHub), company-owned | Order 7 (bundle v87) | web Settings → Connections → Services |
| Coding sessions (thread element: list, read, answer, delegate) | Order 9 part 1 (PR #211); no executor yet, so no session exists in production until part 3 | build the thread element against the RPCs above; render nothing when the list RPC is not deployed |
| Repositories, coding executors, preview route | Order 9 parts 3–4 | later |

> **Scope reset, 2026-10-17.** The preview route (development server previews, step 5i) is deferred and outside
> this rebuild ([the scope amendment](../QORPERA-REBUILD-SCOPE-AMENDMENT-2026-10-17.md), §3). Repositories and
> coding executors stay.

### Thread interactions (typed cards, bundle v75)

An agent asks the member for something by appending an `interaction_request`
event to its thread (a runner custom entry, `entry.customType =
"interaction_request"`, `entry.data` = a `qorpera.interaction/v1` object). The
kernel validates the data per surface and refuses anything else, so a client
renders only these surfaces and never agent-authored HTML:

| `surface` | `payload` (closed object) | Member outcomes | `answer` |
| --- | --- | --- | --- |
| `question` | `options[1..6]{label,value?,description?,style?}`, `multiSelect?`, `allowCustom?`, `dismissOnMoveOn?` | `answered`, `declined` | `{values: string[]}` for answered, else `{}` |
| `secret` | `name`, `label`, `purpose`, `kind?` (`token`/`password`/`text`), `connectorId?` (default `vault`; bundle v81), `repository?` (20260930693000: only with `connectorId: environment`, owner/name in lower case) | `provided`, `declined` | send `{}`; the value goes to the cloud secret custody (`qorpera_begin_cloud_secret_capture` → POST to the broker's `/v1/captures/<ticket>`), and `provided` is accepted only when an active secret with that connector and name exists (owned by the company or by you); the kernel writes `{secretId, version}` into the answer. A coding value (`connectorId: environment`, a name `qorpera_coding_environment_name_allowed` takes) is an environment variable coding sessions get: with `repository`, an owner or admin saves it for the company and gives it to that repository (`qorpera_grant_coding_environment_secret`); otherwise it is the member's own, which reaches their coding sessions in every repository |
| `form` | `domain`, `reason?`, `submitAfterFill?`, `fields[1..8]{id,label,type,required?,placeholder?,options?,secret?,target?,vaultName?}` | `answered`, `declined` | `{values: {id: string|boolean}, fields: {id: filled|failed|skipped}}`; values for secret fields are refused |
| `takeover` | `instruction`, `reason?`, `domain?`, `idpDomain?` | `handed_back`, `dismissed` | `{}` |
| `draft` | `platform`, `connectorId`, `from`, `to[]`, `cc?[]`, `subject?`, `body`, `replyTo?`, `threadRef?` | `sent`, `discarded` | `{sentSummary?}` for sent |
| `credential` | `name`, `domain`, `purpose?` | none (the computer answers) | refused |
| approval (an `authorization_request` event) | the request's own data | `approved`, `declined` | `{reason?}`; needs owner or admin |

Common request fields: `schema`, `surface`, `title` (1–200), `body?` (≤ 2000),
`expiresAt?` (UTC timestamp; answers after it are refused as expired).

`qorpera_answer_interaction(p_session_id, p_client_input_id, p_interaction_id,
p_outcome, p_answer, p_sponsor_binding_id?, p_sponsor_version?)` — `p_interaction_id` is the request's `event_id`. The
answer is queued as an ordinary session input (`kind = user_message`, body
`qorpera.interaction-answer/v1` = `{schema, interactionId, surface, outcome,
answer}`), so it wakes the agent in its own thread like a message; the client
sees it in `qorpera_list_session_inputs` until the run admits it, when it
materializes as a member-authored `interaction_answer` event (or an
`authorization_decision` for an approval) with `entry.data = {schema,
interactionId, requestEventId, surface, outcome, answer, answeredBy}` (+
`decision` for approvals). Rules: one answer per request (a second one is
refused with `55000`, also while the first is still queued); author only (the
member a private thread belongs to, or the creator of a company-visible one);
idempotent on `p_client_input_id`; `22023` for a shape the surface does not
allow; `42501` for authority. Expired means a client shows the card as
expired; the kernel does not synthesize an event for it. Group chats never
carry cards (the runtime withholds the tool there and the kernel refuses a
card on the native path). Design: `THREAD-WIDGETS-DESIGN-20260922.md` in the takeover workspace
outputs.

*An agent's shared thread (bundle v100)* — a room bound to one agent
(`executionScope.agentThread`). The agent raises cards there in reply to
members' posts. Only the member the card was raised for answers it: the
request event's `actor_user_id` (the member whose post, routine or first run
the raising run serves), while still a member of the room; approvals still
need owner or admin. The answer is delivered like a post, on the member's own
model account: pass `p_sponsor_binding_id` and `p_sponsor_version` (the
conversation's selected sponsor, as for `qorpera_post_company_room_message`).
The kernel checks them as the wake materializer will (binding active and
created by you, connection active, native credential present) and refuses
with `42501` "Room sponsor is unavailable" otherwise, or `55000` while company
execution is paused; a refused answer records nothing. An accepted answer's
input is complete at once, its `interaction_answer` event is in the transcript
when the RPC returns (never in the pending list), and a room wake runs the
thread's agent. A client shows live card controls only to that member; against
a cloud before bundle v100 (`PGRST202` for the seven named arguments) it keeps
the card open and says answering there is not available yet (the old function
would queue an answer that never wakes the agent).

*A plain conversation (bundle v105)* — a company conversation that is not a
room. The answer is delivered the way a message there is: pass the same two
sponsor arguments, and the kernel queues the answer with a session turn
request on your own model account, checked as `qorpera_request_session_turn`
checks a `member_connection` request (sponsor kind `member_connection`, your
connection, active binding, connection and authorization, a native credential
whose compute identity is yours and active). It refuses with `42501` "Session
sponsor is unavailable" otherwise, or `55000` while company execution is
paused; a refused answer records nothing. The answer shows in the pending list
until its turn is admitted as a human wake whose current input is the answer.
A conversation with its own execution binding (`qorpera_configure_session_
execution`) still queues an answer that names no sponsor. Before bundle v105
the kernel ignored the sponsor there and queued an answer that never woke the
agent; the v105 migration marks every answer queued where nothing admits it as
failed. If the turn request fails at admission, the answer never reached the
agent and no longer counts as the card's answer: the member may answer again.
`qorpera_list_session_inputs` lists such a failed answer (`status: "failed"`,
with its `failure_reason`) while its card has no other answer, so a client can
show the card open again and say why; it lists no other failed input.

*A group chat* (a room bound to no agent) carries no cards; an answer there is
refused with `22023` "cards are not answered in a group chat" (bundle v105).

## 7. Desktop IPC channels → cloud equivalents

The desktop UI (`packages/shell/userland`, HTML/JS) reaches Electron through
these channels. A web client replaces the bridge with a cloud adapter; the
mapping is the adapter's checklist and the audit of what the desktop still
does locally that the contract forbids.

| Channel | Cloud equivalent |
| --- | --- |

| `account:info` | Supabase Auth session + qorpera_get_account_entitlement |
| `account:sign-in` | Supabase Auth (signInWithEmail / OTP / OAuth, exchangeCodeForSession) |
| `account:sign-out` | Supabase Auth signOut |
| `app:info` | client build info |
| `backend:authorized-post` | direct authenticated calls to Edge Functions / object gateway with the user token |
| `chat:open` | qorpera_ensure_staff_session / qorpera_ensure_member_private_staff_session |
| `companies:list` | qorpera_list_hosted_profiles |
| `company:close` | client state |
| `company:new` | the founding lobby (qorpera_open_company_founding, qorpera_start_company_founding); the old create RPCs and the bootstrap went with legacy sweep D1 (20260930330000) |
| `company:open` | select cloud profile (no folder; desktop-only local projection is transitional) |
| `company:pending-creation` | client state over the same RPCs |
| `company:product-add` | Order 9 (coding workers / repositories) — not yet |
| `company:product-source-choose` | Order 9 — not yet |
| `company:remove` | qorpera_delete_hosted_profile / qorpera_leave_hosted_profile |
| `company:scheduled-job-create` | qorpera_upsert_cloud_routine |
| `company:scheduled-job-delete` | qorpera_upsert_cloud_routine (archive) |
| `company:scheduled-job-run` | manual 'run now' = founder-intent cloud run (SESSIONS.md); review RPC |
| `company:scheduled-job-update` | qorpera_upsert_cloud_routine |
| `company:set-icon` | review (profile metadata RPC) |
| `connection:cancel` | review |
| `connection:connect` | qorpera_begin_cloud_secret_capture / qorpera_begin_native_provider_login (+ native-provider-login Edge Function). Step 7 connectors (company-owned, owner/admin): the browser posts the ticket and the SHA-256 of a tab-held proof to the broker origin (`POST <serviceOrigin>/v1/oauth/<ticketId>/start?company=<profileId>` → provider consent → `GET /v1/oauth/callback` → back to the web page with `?connector=<id>&connection=confirm&confirmation=…` or `connection=failed` in the hash → `POST /v1/oauth/<ticketId>/confirm?company=<profileId>` with the proof, which seals the account), or `POST /v1/captures/<ticketId>?company=<profileId>` for a typed GitHub token. Since bundle v88 sealing the connection shares it with every agent; qorpera_grant_cloud_connector remains only as the idempotent repair |
| `connection:disconnect` | qorpera_revoke_cloud_secret / qorpera_revoke_native_provider_connection |
| `feedback:submit` | qorpera_submit_product_feedback |
| `friends:list` | qorpera_list_friends |
| `friends:remove` | qorpera_remove_friend |
| `friends:request` | qorpera_send_friend_request |
| `friends:respond` | qorpera_respond_friend_request |
| `hub:show` | client navigation |
| `intelligence:configure` | qorpera_put_staff_provider_model / qorpera_configure_session_execution |
| `intelligence:info` | qorpera_list_member_native_execution_connections |
| `intelligence:sign-out` | qorpera_revoke_native_provider_connection |
| `presence:thread` | Realtime qorpera-presence-{profileId} (lossy) |
| `presence:typing` | Realtime qorpera-presence-{profileId} (lossy) |
| `profile:accept-invitation` | qorpera_accept_profile_invitation |
| `profile:decline-invitation` | qorpera_decline_profile_invitation |
| `profile:delete-cloud` | qorpera_delete_hosted_profile |
| `profile:leave-cloud` | qorpera_leave_hosted_profile |
| `profile:list-invitations` | qorpera_list_profile_invitations |
| `profile:materialize-cloud` | desktop-only transitional (local checkout) — no web equivalent by design |
| `profile:migrate-local` | desktop-only transitional — no web equivalent by design (qorpera_promote_local_profile went with legacy sweep D1, 20260930330000) |
| `room:archive` | qorpera_close_shared_session |
| `room:create` | rooms: Order 3 fan-out (the plain shared session creators went with legacy sweep D15, 20260930414000) |
| `room:open` | qorpera_read_session_events_tail (the newest page; older pages on "Show earlier") + qorpera_read_session_events (new events) + Realtime |
| `room:restore` | review |
| `room:send` | qorpera_append_session_input |
| `room:update` | review |
| `rpc:send` | qorpera_append_session_input (the mouth is server-side; clients never run it) |
| `settings:background` | client-local preference |
| `settings:info` | client-local preference |
| `settings:local-execution` | desktop-only transitional — must not exist on the web |
| `settings:overlay` | client-local preference |
| `settings:sidebar-translucency` | client-local preference |
| `staff:archive` | review (staff lifecycle RPC, Order 0 organization kernel) |
| `staff:bootstrap` | none: the company's creation seeds the Co-Founder (qorpera_company_organization_bootstrap went with legacy sweep D1, 20260930330000) |
| `staff:catalog` | qorpera_company_organization_json / qorpera_list_profile_staff |
| `staff:copy-conversation-id` | client |
| `staff:create` | organization kernel RPC (in rework: responsibilities) — review |
| `staff:delete` | review (an agent's files in the company folder; qorpera_delete_profile_staff went with legacy sweep D1, 20260930330000) |
| `staff:intro-ready` | review |
| `staff:open` | qorpera_ensure_staff_session |
| `staff:restore` | review |
| `staff:update` | review (organization kernel, in rework) |
| `update:check` | n/a on the web |
| `update:install` | n/a on the web |
| `update:state` | n/a on the web |

## 8. Change control

- Additive changes (new RPC, new topic) append here in the same commit.
- Breaking changes ship a `_v2` function and keep the old one until every
  client has moved; this file records both and the removal date.
- Client sessions rebase onto `codex/steps-0-2-fable-handoff` regularly and
  read this file's diff first.

## Requests

Client sessions append dated requests here; the runtime session answers in
place. Nothing below changes the contract until the runtime session records it
above.

### 2026-09-02 — from the web client session (`packages/web`, branch `web/client-app`)

1. **Object gateway CORS for browser origins.** `packages/object-gateway`
   sends no `Access-Control-*` headers, so a browser at the web origin cannot
   call `/v1/member-company-objects`, `/v1/member-company-file` or
   `/v1/member-session-attachments` at all — the preflight fails before the
   gateway's authority checks run. Request: an allow-list of web origins
   (production `https://app.qorpera.com`; development `http://127.0.0.1:5180`
   and `http://localhost:5180`), methods `GET, PUT, POST, OPTIONS`, request headers
   `authorization, content-type, x-qorpera-company-path`, exposed headers
   `etag, x-qorpera-access-mode`, and a `204` answer to preflight. Until then
   the web app cannot upload attachments or read gateway-served objects; it
   says so instead of pretending.
2. **Approvals.** *Answered 2026-09-22 (bundle v75): `qorpera_answer_interaction`
   records the decision as a queued input that wakes the agent and
   materializes as `authorization_decision`; see "Thread interactions" in §6.
   A pending-requests read RPC is still open.* The only member-callable way to record an
   `authorization_decision` today is `qorpera_append_account_event(uuid, uuid,
   text, jsonb, bigint, text, uuid, uuid)`, which is granted to `authenticated`
   but absent from §2. Request: either list it (with the body shape a decision
   must carry) or name the typed decision RPC Order 2 introduces; and add a
   read RPC that lists pending authorization requests per profile, so a client
   does not have to scan every session's events to build the inbox. The web
   inbox is read-only until one of these exists.
3. **Undocumented granted functions.** Replaying every grant/revoke in the
   migrations in statement order yields the 151 functions in §2 plus these 14
   granted to `authenticated` and not listed: `qorpera_append_account_event`,
   `qorpera_authorize_member_company_path_object`,
   `qorpera_authorize_member_session_attachment`,
   `qorpera_begin_member_company_path_command`,
   `qorpera_begin_member_session_attachment_upload`, `qorpera_can_read_session`,
   `qorpera_cancel_session_run`, `qorpera_claim_session_turn`,
   `qorpera_consent_identity_recovery`, `qorpera_get_session_run_control`,
   `qorpera_list_member_recovery_identities`, `qorpera_put_profile_staff`,
   `qorpera_read_company_path`, `qorpera_set_company_path_resource`. Request:
   document the ones clients may use (at least `qorpera_read_company_path` with
   its return shape, for live logical-path browsing) and state which are
   desktop-transitional or should be revoked.
4. **Object bytes for browsers.** `qorpera_authorize_profile_object_download`
   returns only `backend` and `bytes`; the desktop then reads Storage bucket
   `qorpera-profile-objects` at `{profileId}/{sha256}`. Request: record that
   path convention in §4 so clients do not infer it from desktop code, and
   state whether it stays valid for companies served by the path gateway
   (the RPC refuses those with `42501`).
5. **Supabase Auth redirect URLs.** Register `https://app.qorpera.com/`,
   `http://127.0.0.1:5180/` and `http://localhost:5180/` in the project's
   redirect allow-list for OAuth PKCE and magic links (decided 2026-09-02:
   the web app stays in the monorepo and is served from `app.qorpera.com`),
   and confirm the email template includes the six-digit `{{ .Token }}` so
   code entry works without a redirect.
6. **Deployment status of Order 0 on the target project.** On
   `wovsmjvghnbcbfazdtvr.supabase.co` (the project the desktop is compiled
   against) these listed functions answer `PGRST202` as of 2026-09-02:
   `qorpera_company_organization_json`, `qorpera_company_organization_bootstrap`,
   `qorpera_ensure_member_private_staff_session`,
   `qorpera_company_uses_path_gateway` (and the undocumented
   `qorpera_read_company_path`). Request: note in §6 when Order 0 lands there,
   and confirm this is the project the web app should target rather than the
   preview `hurfdoempkqpzxggemhc`.
7. **Screens (Order 4), early.** The web viewer needs a browser-facing,
   authenticated websocket gateway: member token → short-lived viewer lease,
   origin allow-list, one socket per screen session, a stated frame/input
   protocol, and lifecycle records that distinguish viewer closure from
   computer shutdown (§21 item 27). Request: the design note before Order 4
   implementation so the web client can be built against it.
8. **Two member RPCs added on `codex/steps-0-2-fable-handoff` today without a
   contract entry.** After rebasing onto `ebbd1e734`, the grant replay shows
   `qorpera_list_member_notifications(p_profile_id, p_limit)` and
   `qorpera_company_execution_ceiling_json(p_profile_id)` (migrations
   `20260828019980`, `20260828019995`) granted to `authenticated`. Request:
   add both to §2 with their return shapes; the web client will render member
   notifications (`provider_usage_limit`, `company_ceiling_tripped`) and the
   company ceiling state once they are listed, and not before. Note also that
   this file exists only on `web/client-app` so far — the runtime branch tip
   has no copy — so the runtime session needs to adopt it (or say where the
   canonical copy lives) for the "same commit" rule in §8 to hold.
9. **Done directly on 2026-09-02, for the record (founder-approved, in the
   Supabase dashboard):** request 5's redirect URLs are registered
   (`https://app.qorpera.com/**`, `http://localhost:5180/**`,
   `http://127.0.0.1:5180/**`; the Site URL stays `https://qorpera.com`).
   The "Magic link or OTP" and "Confirm sign up" templates now carry the
   six-digit `{{ .Token }}` with Qorpera copy (sources in
   `packages/web/auth-email/`), subject "Your Qorpera sign-in code". Custom
   SMTP through Resend (`smtp.resend.com:465`, sender
   `Qorpera <no-reply@mail.qorpera.com>`) was prepared; the founder holds the
   key. The desktop's loopback and `qorpera://` redirect entries are untouched.
10. **A company's logo should be cloud state.** Every client shows a company
    picture, and today none of them can agree on it. The desktop hub gives a
    company one of four characters (`renderer.js` `COMPANY_AVATARS`: halo,
    bloom, folio, pebble) and stores that choice per user under the desktop's
    own userData (`readCompanyIcon`/`writeCompanyIcon`, IPC `company:set-icon`);
    `qorpera_create_hosted_profile(p_profile_name, p_environment_name,
    p_contract_version)` takes no picture and `qorpera_list_hosted_profiles`
    returns none. So a company that shows Folio on the founder's laptop shows
    something else on the web, on mobile, and to every colleague.

    Treat this as the company's **logo**, not decoration: the placeholder
    character is what a company wears until someone gives it the real thing.
    Request, in two parts:

    - **State.** A logo on the profile row, returned by
      `qorpera_list_hosted_profiles` (and by the invitation list, so an
      invitation can show the company it comes from), accepted by
      `qorpera_create_hosted_profile`, and set through a member RPC bounded by
      the profile's `manageMembers`/owner capability. Two forms in one field:
      one of the named characters, or an uploaded image.
    - **The uploaded image.** A logo a member supplies is an object like any
      other — `qorpera_authorize_profile_object_upload(p_profile_id, p_sha256,
      p_bytes)` into `qorpera-profile-objects/{profileId}/{sha256}` already
      exists — so the logo field only needs to carry the sha256 and media type,
      and the read path has to serve it to every member of the profile (the
      gateway route, plus the CORS answer in request 1). Bounds worth stating:
      accepted media types, a maximum size, and whether a square render is
      expected.

    Until this lands the web client derives the placeholder character from the
    profile id (stable across renames) and says so in its own code; it offers
    no logo picker, because there is nowhere to put the answer.

    *`qorpera_create_hosted_profile` went with legacy sweep D1
    (20260930330000); a company is created through the founding lobby.*
11. **A member cannot set an agent's appearance once a company is bootstrapped.**
    `qorpera_put_profile_staff` is listed in §2 and granted to `authenticated`,
    but on a company whose bootstrap job has completed every member write to
    `qorpera_profile_staff` is refused by the
    `qorpera_profile_staff_company_file_writer` trigger with 42501 "Company
    File-backed staff must be changed through its lifecycle operation"
    (`20260828019600_runtime_step0_company_agents.sql`). Verified on
    `wovsmjvghnbcbfazdtvr` on 2026-09-02: creating a company seeds the
    Co-Founder (`brain`, `qorpera-blue`, template `co-founder`, lifecycle
    `setup`), and setting its figure and colour is refused.

    The stated path — advance the source Company File path in the same
    transaction — is not reachable from a browser: writing a document's bytes
    needs the object gateway, and the gateway still sends no `Access-Control-*`
    headers (request 1), so the preflight fails before any authority check.

    Request, either:
    - a member-callable RPC that sets an agent's `appearance_creature` and
      `appearance_color` and advances the projection itself, bounded by the
      profile's write capability; or
    - the gateway CORS answer from request 1 plus a worked example of the
      member path-command sequence for editing one agent document, so a client
      can do it the long way.

    Until one exists, §2 should note that `qorpera_put_profile_staff` is
    member-callable only before bootstrap completes; a client reading §2 today
    would build exactly the screen that this trigger refuses, which is what
    happened here.

    *Legacy sweep D1 (20260930330000) dropped `qorpera_put_profile_staff`,
    `qorpera_delete_profile_staff` and the trigger. A `folder-v2` agent
    changes through its files in the company folder.*

### 2026-09-19 — from the web client session (`packages/web`, PR #118)

12. **The web client no longer reads member notifications.** At the founder's
    request the web client removed its notification inbox and the rail's
    unread count. No client now calls `qorpera_list_member_notifications` or
    `qorpera_acknowledge_member_notification` (the desktop list/acknowledge
    surface in the Steps 0–2 amendment ratification was never built), so
    request 8's "the web client will render member notifications" no longer
    holds. Two consequences on the runtime side:
    - The usage-limit notice and the "never silent" sponsor handoff of
      `QORPERA-RUNTIME-CONTRACT.md` §17 reach no member in any client.
    - Nothing acknowledges a row, and the open-row unique index in
      `20260828019980_provider_usage_signals.sql` keeps an unacknowledged
      row in place, so repeat usage-limit and ceiling notices for the same key
      are dropped (handoffs, keyed per handoff, keep accumulating).

    Request: decide where these notices reach a member now — a surface a
    client still shows, such as the run or conversation state — or record
    in §17 that they are paused until a client shows them again.

    Resolution (2026-09-19): the web workspace now presents member-addressed
    execution updates inline, without restoring the removed inbox or unread
    rail count. It reads usage limits, sponsor handoffs, company ceilings and
    pause/resume notices, with an explicit acknowledgment per record. Opening
    the workspace never acknowledges a notice; an uncertain acknowledgment
    requires a fresh read before another attempt. Reads and writes are scoped
    to the current member and company and stop on account or access changes.
    The existing RPC returns the latest 50 records, including acknowledged
    records, so this surface labels that window and does not promise a complete
    pending backlog. Older pending records need backend filtering/pagination.

### 2026-09-19 — from the web client session (`packages/web`, PR #124)

13. **Request 12 understated what stops reaching members.** Replacing its
    consequences:
    - No notice reaches a member in any client: the usage-limit notice and the
      "never silent" sponsor handoff of `QORPERA-RUNTIME-CONTRACT.md` §17, the
      ceiling-trip notice of §7.4, and the founder stop notice of §21 item 30.
      Web Settings still shows the paused state and the month's trip count,
      but nothing tells a member when either changes.
    - Nothing acknowledges a row. Where the dedupe key is fixed — usage limits
      (connection and version, `20260828019980`) and spend/token trips
      (profile, month and dimension, `20260828019995`) — the open-row unique
      index keeps the first unacknowledged row and later notices are dropped.
      Where the key is new each time — pause/resume, hourly wake trips,
      machine-capacity refusals and handoffs — one unacknowledged row is added
      per event and never cleared.

    Request: decide where these notices reach a member now — a surface a
    client still shows, such as the run or conversation state — or record in
    §7.4, §17 and §21 that they are paused until a client shows them again,
    and whether rows should keep being written meanwhile.

    Follow-up: PR #129 restores member execution notices in the web workspace;
    the resolution recorded under request 12 above also addresses request 13.

### 2026-09-24 — from the runtime (bundle v89, `20260924080000_runtime_remove_company_ceilings.sql`)

14. **Company execution ceilings are gone; the pause is operator-only.** At the
    founder's request ("get rid of this … not just in settings, but as policy
    configurations/settings") there are no per-company monthly spend, monthly
    token or hourly wake ceilings. Removed, with no `_v2`:
    - `qorpera_company_execution_ceiling_json(p_profile_id)` and
      `qorpera_set_company_execution_ceiling(uuid,bigint,bigint,bigint,bigint)`
      (request 8), plus the private helpers, the ceiling table and the trip
      records. The only client, the web Settings panel, was removed first
      (web PR #247, no bundle), so the cut must follow that deploy.
    - `qorpera_set_company_execution_pause` is no longer granted to
      `authenticated`, and it no longer writes member notifications. The
      legacy sweep dropped it (20260930240000): the operator brake of a
      runtime cut is the folder core's `qorpera_folder_pause` and
      `qorpera_folder_resume`, which no API role can call.
    - Notification kinds `company_execution_paused` and
      `company_execution_resumed` are removed, together with the open and
      acknowledged rows of both and every `company-ceiling-tripped/v1` row.
      `company_ceiling_tripped` remains, carrying only the machine-capacity
      subject (`qorpera.member-notification.machine-capacity/v1`).

    Per-connection provider quotas, the provider's own usage limits and the
    running-machine limit are unchanged.

### 2026-09-24 — from the runtime (bundle v92, `20260924130000_runtime_remove_run_and_machine_caps.sql`)

15. **No machine limit, no API-key budget, no run deadline.** Removed, with no
    `_v2`: `qorpera_company_machine_capacity(p_profile_id)` and
    `qorpera_set_company_machine_limit(uuid,integer,bigint)` (no client calls
    them) and the machine-capacity notice. Its rows go, and so does the
    `company_ceiling_tripped` kind, so a web build that still parses that
    notice only ever sees none. Node capacity is the only bound on company
    computers. API-key connections keep only their concurrency. A run's
    `deadline_at` is set a century out, and usage records runs of any
    length. A queued run that no computer starts within a day of being queued
    (a retry counts from its requeue) still fails, with the job error "No
    computer could start the run within a day".

    A run's work has no count either (founder, 2026-09-24). What a client may
    see change:
    - A wake policy's `maxPublicSends` is `null` (no limit) or `0` (the wake may
      not speak publicly); the numbers 64, 3 and 2 are gone.
    - Coworker messages have no hop budget and no hourly pair budget, so a send
      no longer returns `causal-fence` for those reasons and the pair transcript
      gets no budget line. Nothing but a member's Stop (or the operator pause)
      ends a loop between two agents.
    - Hiring and group chats have no per-run count ("This run reached its limit
      for new agents/rooms" is gone), and neither do Company File reads, model
      requests, screenshots, tool calls, worker follow-up turns or workers per
      todo ("This todo already has eight workers" is gone).
    - What still refuses is listed in the runtime contract, section 7.4. It
      includes one open limit, 128 tool outputs per model request, which
      leaves with a Codex rebuild.

### 2026-09-24 — from the runtime (bundle v95, `20260924160000_runtime_remove_standing_counts.sql`)

16. **No standing counts.** Removed, with no `_v2`: 32 routines per agent
    ("Agent routine limit reached"), 64 open todos per agent ("Too many open
    todos"), 4 active workers per agent ("Four workers are already active") and
    40 sidebar sections per company ("A company can have at most 40 sections",
    from `qorpera_manage_company_sidebar` as well as the agent tool). A client
    that showed or guarded one of these limits should drop it. A Company File
    change may now wake an agent already earlier in its causal chain; an
    agent's own write still never wakes its own watch routine.

### 2026-09-24 — from the runtime (bundle v104, `20260924230000_runtime_native_view_no_output_count.sql`)

17. **No count of tool outputs per model request.** The open limit named in
    item 15 is gone with the Codex rebuild: a model request may carry any
    number of tool outputs (the pinned Codex refused 128 or more). Nothing a
    client calls changes; a long run simply no longer fails after about 128
    tool calls between compactions.

### 2026-09-25 — from the runtime (bundle v130, `20260926130000_runtime_auto_review_rules.sql`)

18. **Auto-review rules and approval cards.** Members write rules ("When an
    agent wants to …, it should: Ask first | Allow automatically"), for
    themselves or, owners and admins, for the whole company. Before an agent's
    acting call runs (connection writes, computer steps that act, shell,
    deletions, hiring, routines, workers), a reviewer decides allow / ask /
    deny. An ask raises an `authorization_request` card of schema
    `qorpera.action-review/v1` in the conversation the agent works in (its
    own thread or a plain conversation; never a group chat). The web needs the
    rules at the bottom of Settings → General (the three rule RPCs; web #360
    replaced the first Rules tab) and live controls on these cards
    (`qorpera_answer_action_review`, section 2). Older approval cards without
    `reviewId` keep the v75 path.

