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

## 2. Member-callable RPCs (security-definer, granted to `authenticated`)

163 functions, grouped for navigation. Signatures: see the migration that defines each.


### Members, presence, friends, feedback (17)

- `qorpera_can_read_member_picture(p_object_name)` — the picture bucket's
  read policy: anything in your own folder, and another account's current
  picture when `qorpera_can_see_member_picture` allows it.
- `qorpera_can_see_member_picture(p_user_id)` — yourself, company colleagues,
  accepted friends, and accounts that sent you a friend request (a request you
  sent reveals nothing until it is accepted).
- `qorpera_clear_member_picture` — back to initials; returns
  `previous_object_name`, which the caller deletes from storage.
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
- `qorpera_upsert_cloud_routine`


### Credentials, provider connections, identity recovery (13)

- `qorpera_begin_cloud_secret_capture`
- `qorpera_begin_native_provider_login`
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


### Objects, artifacts, retention (23)

- `qorpera_append_object_reachability_entries`
- `qorpera_authorize_profile_object_download`
- `qorpera_authorize_profile_object_upload`
- `qorpera_begin_object_reachability_graph`
- `qorpera_cancel_artifact_gc_plan`
- `qorpera_cancel_artifact_gc_plan_v2`
- `qorpera_complete_object_reachability_graph`
- `qorpera_create_artifact_gc_plan`
- `qorpera_create_artifact_index`
- `qorpera_create_artifact_retention_hold`
- `qorpera_create_object_restore_proof`
- `qorpera_get_artifact_index`
- `qorpera_get_object_reachability_graph`
- `qorpera_issue_profile_object_read_lease`
- `qorpera_list_artifact_gc_audit`
- `qorpera_list_artifact_gc_candidates`
- `qorpera_list_artifact_gc_plans`
- `qorpera_list_artifact_index_entries`
- `qorpera_profile_object_writes_allowed`
- `qorpera_register_artifact_v2`
- `qorpera_release_artifact_retention_hold`
- `qorpera_retry_artifact_gc_plan`
- `qorpera_stage_operation_receipt_objects`


### Company File, snapshots, proposals, workspaces (21)

- `qorpera_accept_company_proposal`
- `qorpera_append_company_proposal_comment`
- `qorpera_capture_company_substrate_version`
- `qorpera_capture_company_substrate_version_v2`
- `qorpera_company_uses_path_gateway`
- `qorpera_get_company_file`
- `qorpera_get_company_proposal`
- `qorpera_get_company_snapshot`
- `qorpera_get_company_substrate_version`
- `qorpera_list_company_proposal_comments`
- `qorpera_list_company_proposals`
- `qorpera_list_company_snapshots`
- `qorpera_list_company_substrate_operations`
- `qorpera_list_company_workspaces`
- `qorpera_prepare_company_file_proposal`
- `qorpera_prepare_company_file_revision`
- `qorpera_publish_company_file_revision`
- `qorpera_rebase_company_proposal`
- `qorpera_reject_company_proposal`
- `qorpera_retry_company_proposal_review`
- `qorpera_submit_company_proposal`


### Organization and staff (6)

- `qorpera_company_organization_bootstrap`
- `qorpera_company_organization_json`
- `qorpera_configure_staff_execution_authority`
- `qorpera_delete_profile_staff`
- `qorpera_list_profile_staff`
- `qorpera_put_staff_provider_model`

### Company sidebar (2) — bundle v90

- `qorpera_read_company_sidebar(p_profile_id)` → `qorpera.company-sidebar/v1`:
  `sections` (`sectionId`, `name`, in order), `placements` (`staffAgentId`,
  `sectionId` or null for Unassigned, `position`), and the caller's own
  `pinned` (ordered) and `hidden` agent ids. Any member.
- `qorpera_manage_company_sidebar(p_profile_id, p_request)` answers the same
  shape after the change. Shared, owner/admin/contributor:
  `create_section {sectionId, name, staffAgentId?, unpin?}`,
  `rename_section {sectionId, name}`, `delete_section {sectionId}` (its agents
  go to the end of Unassigned), `move_agent {staffAgentId, sectionId|null,
  order?, unpin?}`. The member's own, any member: `set_pins {order}` (at most
  24; pinning unhides), `set_hidden {staffAgentId, hidden}` (hiding unpins).
  Section names are 1-60 characters, unique per company ignoring case; any
  number of sections (at most 40 until bundle v95). The Co-Founder is never
  placed, pinned or hidden. Agents change the same shared sections through the
  runtime tool `organize_sidebar` (`qorpera_manage_agent_sidebar`, runner only).

### Auto-review rules and approvals (4) — bundle v130

- `qorpera_list_review_rules(p_profile_id)` → `qorpera.review-rules/v1`:
  `canManageCompanyRules` (owner or admin) and `rules`: every active company
  rule plus the caller's own (`id`, `scope` `company|member`, `memberUserId`,
  `when`, `outcome` `ask_first|allow_automatically`, `createdVia`
  `settings|card|agent`, `createdByUserId`, `createdByStaffAgentId`,
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
  the reviewer reads for one action). Returns the rule.
- `qorpera_archive_review_rule(p_profile_id, p_rule_id)`: removes a rule
  (again: no change). Company rules: owners and admins; personal: its author.
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

### Conversations, turns, wakes (28)

- `qorpera_answer_interaction` (2026-09-22, bundle v75): answers a typed card
  the agent raised in the thread. See "Thread interactions" under §6.
- `qorpera_append_session_input`
- `qorpera_approve_session_turn_sponsorship`
- `qorpera_claim_wake_v2`
- `qorpera_close_shared_session`
- `qorpera_complete_session_turn_v2`
- `qorpera_complete_wake`
- `qorpera_configure_session_execution`
- `qorpera_create_shared_session`
- `qorpera_create_shared_session_v2`
- `qorpera_create_shared_session_v4`
- `qorpera_ensure_member_private_staff_session`
- `qorpera_ensure_staff_session`
- `qorpera_get_session_turn_status`
- `qorpera_get_shared_session_by_client`
- `qorpera_list_session_execution_run_recoveries`
- `qorpera_list_session_inputs`
- `qorpera_list_session_recoveries`
- `qorpera_list_session_turn_requests`
- `qorpera_list_shared_sessions`
- `qorpera_list_shared_sessions_page`
- `qorpera_list_wake_occurrences`
- `qorpera_quarantine_session_turn`
- `qorpera_read_session_events`
- `qorpera_renew_session_turn_v2`
- `qorpera_renew_wake`
- `qorpera_request_session_turn_v2`
- `qorpera_resolve_session_recovery`


### Coding sessions (4) — Order 9, part 1 (PR #211)

- `qorpera_list_coding_sessions(p_session_id)` — the coding sessions the agent dispatched from this conversation, each as `qorpera.coding-session/v1` plus `isOwner`; the thread renders each one as a centered system element (the "sandwich": a start line, a collapsible body, a status line) from this view and the session's own events, never from the agent's prose
- `qorpera_read_coding_session(p_worker_id, p_after_event, p_limit)` — the session view plus its event stream (`phase`, `step`, `text`, `needs_input`, `input`, `delegated`, `published`, `finished`, `failed`), cursor on the event id
- `qorpera_answer_coding_session(p_worker_id, p_text, p_client_request_id)` — owner only; idempotent on the client request id; refused while the session is working
- `qorpera_delegate_coding_session(p_worker_id, p_client_request_id)` — owner only; "let the agent decide" a question the session asked

### Execution, sponsors, runners, computers (29)

- `qorpera_begin_operation_receipt`
- `qorpera_cancel_runner_job`
- `qorpera_complete_operation_receipt`
- `qorpera_configure_runner_model_policy`
- `qorpera_create_execution_sponsor_binding`
- `qorpera_create_member_execution_sponsor`
- `qorpera_create_runner_registration`
- `qorpera_describe_governed_company_computer`
- `qorpera_enqueue_execution_run`
- `qorpera_enqueue_runner_job`
- `qorpera_get_execution_run_recovery`
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
- `qorpera_resolve_operation_receipt`
- `qorpera_resolve_run_operation_receipt`
- `qorpera_revoke_runner`
- `qorpera_set_execution_sponsor_status`
- `qorpera_set_logical_computer_status`
- `qorpera_upsert_logical_computer`
- `qorpera_upsert_member_compute_identity`
- `qorpera_upsert_scoped_compute_identity`


### Accounts, profiles, membership (22)

- `qorpera_accept_profile_invitation`
- `qorpera_accept_profile_invitations`
- `qorpera_can_authorize_profile`
- `qorpera_can_read_profile`
- `qorpera_can_write_profile`
- `qorpera_cancel_profile_invitation`
- `qorpera_create_cloud_company`
- `qorpera_create_hosted_profile`
- `qorpera_decline_profile_invitation`
- `qorpera_delete_hosted_profile`
- `qorpera_get_account_entitlement`
- `qorpera_invite_profile_member`
- `qorpera_leave_hosted_profile`
- `qorpera_list_hosted_profiles`
- `qorpera_list_profile_invitations`
- `qorpera_member_role`
- `qorpera_profile_team_info`
- `qorpera_promote_local_profile`
- `qorpera_remove_profile_member`
- `qorpera_retry_profile_invitation_delivery`
- `qorpera_session_profile_id`
- `qorpera_update_profile_member_role`


## 3. Realtime

- `qorpera-profile-{profileId}` — durable-lane invalidation hints for a profile
  (sub-channels seen in the shell: `sessions`, `staff`, `trail`,
  `company-tree`, `company-projection`, `workspace-inbox`). Hints only: the
  client re-reads through RPCs; large bodies never travel on this channel.
- `postgres_changes` on `qorpera_company_sidebar_revisions` (filter
  `profile_id=eq.{profileId}`, member-readable, one row per company) — the
  shared sidebar changed, by a member or an agent: one hint per change however
  many agents it renumbered; re-read with `qorpera_read_company_sidebar`. The
  section and placement tables themselves are not readable or published. The web
  subscribes on its own channel, only after the read RPC answered, so a cloud
  without the table never degrades the company channel. Pins and hidden agents
  are not published.
- `qorpera-presence-{profileId}` — lossy presence (typing, who-is-viewing).
  Private channel authorized by membership through RLS on
  `realtime.messages`; never stored; must never carry durable content.
  Topic name from `qorpera_presence_topic_profile`. Agent presence over the
  live Company File (contract 5.2) will extend this channel at Order 4.
- `qorpera-room-drafts-{roomId}` — shared drafts (migration
  `20260927180000_room_shared_drafts`): a room member's unsent message, which
  the room's other members see and edit live. Private broadcast channel, event
  `draft`, payload `qorpera.room-draft/v1` (`ownerUserId`, `body`, `revision`,
  `editorUserId`, `contributors`, `updatedAt`). Members of the room receive it
  (RLS on `realtime.messages` via `qorpera_can_share_room_draft`); nobody
  publishes: only `qorpera_put_room_draft` sends, through `realtime.send`, so a
  change always names the editor the token did. Lossy: `qorpera_list_room_drafts`
  re-reads, and a write from a stale revision returns the current draft.
  `qorpera_put_room_draft(room, owner, base revision, body)` writes only from the
  current revision (0 starts the caller's own draft; only the owner starts one);
  any active member of the room edits an existing draft. Access is the room post
  rule: an active member of an active room. Drafts never send, wake or sponsor
  anything; the owner sends with `qorpera_post_company_room_message` as before.

## 4. Object gateway (HTTP, `packages/object-gateway`)

Member requests authenticate with the user token; the gateway checks
Supabase authority, hashes uploads server-side, and confirms the catalog
only after durable storage.

- `GET/PUT /v1/member-company-file/…` — logical Company File reads and writes
  through the authority layer
- `GET/PUT /v1/member-company-objects/…` — content-addressed objects
- `/v1/member-session-attachments/…` — attachments on canonical sessions
- `POST /v1/read-leases/revoke` — revoke a read lease
- `/v1/native-company-objects/…` — runner-only, not for clients
- `/healthz`, `/livez`, `/readyz`

Uploads and downloads are always explicit, typed member interactions
(contract 12.2); a client never grants an agent access to the member's
machine.

## 5. Edge Functions

- `native-provider-login` — a member starts the provider-native login handoff
  (Codex / Claude) that runs in an isolated cloud login VM; the client only
  hands the member the link and shows status.
- `profile-invitation-email`, `company-file-verifier`, `artifact-gc-worker`,
  `runner-control`, `runner-broker`, `runner-orchestrator` — service or
  runner authority only. Clients never call them.

## 6. Stability by Order (what a client may build now)

| Surface | State | Client may |
| --- | --- | --- |
| Auth, profiles, membership, invitations, friends, presence | live | build fully |
| Conversations: sessions, inputs, events, replay, Realtime | live (Order 1 mouth writes the canonical transcript) | build fully; render only send operations |
| Approvals | `authorization_request` answered through `qorpera_answer_interaction` (bundle v75) | build the inbox; Approve and Decline call the answer RPC |
| Auto-review rules and approval cards | kernel + runtime in bundle v130 | Settings → Rules; approval cards with Allow once / Deny / Always allow through `qorpera_answer_action_review`; show no live controls until v130 is live |
| Thread interactions (typed cards) | kernel in bundle v75; runtime tool and web cards follow | render `interaction_request` events as cards; answer through the RPC |
| Company File: published snapshots, objects, proposals | live | build browsing/review |
| Company File: live logical paths with ACLs | Order 0 gateway in progress | read-only projection, then live |
| Organization: Co-Founder, responsibilities, projects, rooms, staff | in rework (departments → responsibilities) | build against the semantic projection (contract 14.5); no department UI |
| Screens (Company Computer viewer) | Order 4, plus a browser-facing authenticated websocket gateway (viewer traffic is private-network today) | later |
| Routines, memory | Orders 6, 8 | later |
| Connectors (Gmail, Google Drive, GitHub), company-owned | Order 7 (bundle v87) | web Settings → Connections → Services |
| Coding sessions (thread element: list, read, answer, delegate) | Order 9 part 1 (PR #211); no executor yet, so no session exists in production until part 3 | build the thread element against the RPCs above; render nothing when the list RPC is not deployed |
| Repositories, coding executors, preview route | Order 9 parts 3–4 | later |

### Thread interactions (typed cards, bundle v75)

An agent asks the member for something by appending an `interaction_request`
event to its thread (a runner custom entry, `entry.customType =
"interaction_request"`, `entry.data` = a `qorpera.interaction/v1` object). The
kernel validates the data per surface and refuses anything else, so a client
renders only these surfaces and never agent-authored HTML:

| `surface` | `payload` (closed object) | Member outcomes | `answer` |
| --- | --- | --- | --- |
| `question` | `options[1..6]{label,value?,description?,style?}`, `multiSelect?`, `allowCustom?`, `dismissOnMoveOn?` | `answered`, `declined` | `{values: string[]}` for answered, else `{}` |
| `secret` | `name`, `label`, `purpose`, `kind?` (`token`/`password`/`text`), `connectorId?` (default `vault`; bundle v81) | `provided`, `declined` | send `{}`; the value goes to the cloud secret custody (`qorpera_begin_cloud_secret_capture` → POST to the broker's `/v1/captures/<ticket>`), and `provided` is accepted only when an active secret with that connector and name exists (owned by the company or by you); the kernel writes `{secretId, version}` into the answer |
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
| `company:new` | qorpera_create_cloud_company + qorpera_company_organization_bootstrap |
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
| `profile:migrate-local` | desktop-only transitional (qorpera_promote_local_profile) — no web equivalent by design |
| `room:archive` | qorpera_close_shared_session |
| `room:create` | rooms: Order 3 fan-out; today shared sessions (qorpera_create_shared_session_v4) |
| `room:open` | qorpera_read_session_events + Realtime |
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
| `staff:bootstrap` | qorpera_company_organization_bootstrap |
| `staff:catalog` | qorpera_company_organization_json / qorpera_list_profile_staff |
| `staff:copy-conversation-id` | client |
| `staff:create` | organization kernel RPC (in rework: responsibilities) — review |
| `staff:delete` | qorpera_delete_profile_staff |
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
      `authenticated`. It stays as the operator brake of every runtime cut
      (an operator session with a founder's claims), and it no longer writes
      member notifications.
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
    own thread or a plain conversation; never a group chat). The web needs a
    Settings → Rules tab (the three rule RPCs) and live controls on these
    cards (`qorpera_answer_action_review`, section 2). Older approval cards
    without `reviewId` keep the v75 path.

