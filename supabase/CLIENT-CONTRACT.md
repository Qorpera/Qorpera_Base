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

151 functions, grouped for navigation. Signatures: see the migration that defines each.


### Members, presence, friends, feedback (9)

- `qorpera_list_friends`
- `qorpera_list_presence_devices`
- `qorpera_presence_topic_profile`
- `qorpera_register_presence_device`
- `qorpera_remove_friend`
- `qorpera_respond_friend_request`
- `qorpera_send_friend_request`
- `qorpera_submit_product_feedback`
- `qorpera_unregister_presence_device`


### Routines (2)

- `qorpera_list_cloud_routines`
- `qorpera_upsert_cloud_routine`


### Credentials, provider connections, identity recovery (12)

- `qorpera_begin_cloud_secret_capture`
- `qorpera_begin_native_provider_login`
- `qorpera_grant_cloud_secret_operation`
- `qorpera_list_cloud_secret_connections`
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


### Conversations, turns, wakes (27)

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
- `qorpera-presence-{profileId}` — lossy presence (typing, who-is-viewing).
  Private channel authorized by membership through RLS on
  `realtime.messages`; never stored; must never carry durable content.
  Topic name from `qorpera_presence_topic_profile`. Agent presence over the
  live Company File (contract 5.2) will extend this channel at Order 4.

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
| Approvals | `authorization_decision` today; typed interaction surfaces at Order 2 | build the inbox; typed cards as Order 2 lands |
| Company File: published snapshots, objects, proposals | live | build browsing/review |
| Company File: live logical paths with ACLs | Order 0 gateway in progress | read-only projection, then live |
| Organization: Co-Founder, responsibilities, projects, rooms, staff | in rework (departments → responsibilities) | build against the semantic projection (contract 14.5); no department UI |
| Screens (Company Computer viewer) | Order 4, plus a browser-facing authenticated websocket gateway (viewer traffic is private-network today) | later |
| Routines, memory, connectors | Orders 6–8 | later |
| Repositories, coding workers | Order 9 | later |

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
| `connection:connect` | qorpera_begin_cloud_secret_capture / qorpera_begin_native_provider_login (+ native-provider-login Edge Function) |
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
2. **Approvals.** The only member-callable way to record an
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
    holds. Consequences on the runtime side:
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
