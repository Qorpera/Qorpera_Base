-- Company folder core, P13: sign-in machines on the folder core's order (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md
-- §6.12; C1B §8). F3's activation check 838 lists these sites as gc fence holders. A sign-in's or an account refresh's
-- login machine was reserved and released with the sign-in (or refresh request) FOR UPDATE and then the gc fence, the
-- company row FOR UPDATE: the reverse of the core's order, and on folder-v2 a stall of every effect of the company,
-- which holds the row KEY SHARE. On folder-v2 now:
-- * The reservation (qorpera_reserve_runtime_login_machine, _account_refresh_machine) first reads the sign-in with no
--   lock and checks its capability: a caller without it takes nothing. It then takes the folder fence KEY SHARE and the
--   company row KEY SHARE (rank 0, qorpera_folder_machine_fence, no pause read: the pause is read after the locks, as
--   before), the requester's member row FOR SHARE (rank 1), the identity's machine lock, then the sign-in FOR UPDATE
--   (rank 5, before the model logins), the identity FOR SHARE, the provider policy, the machine request and the
--   allocation, as before. No gc fence.
-- * The identity's machine lock is a transaction advisory lock, not a row, with the key
--   hashtextextended('qorpera.identity-machine:' || <compute identity id>::text, 0). The gc fence used to serialize two
--   machines of one identity, so the "identity already has a machine" check could not race; KEY SHARE does not.
--   Locking the identity row more strongly would deadlock with a new sign-in, whose epoch trigger holds the identity
--   FOR SHARE while it cancels the earlier sign-in. A run's own machine reservation still takes the gc fence on
--   folder-v2 (it conflicts with this KEY SHARE, so the two stay serialized); when it leaves the gc fence (C1c-3n) it
--   takes this same lock.
-- * The release takes the fence and rank 0, then the sign-in, the machine request and the allocation; no pause read,
--   so a paused company's sign-in machines are released.
-- * The node reservation of a login machine (qorpera_reserve_runtime_node_machine, kind 'login', the gateway's own call
--   after the company reservation) takes the fence and rank 0 as the other folder-v2 kinds do (C1c-3f), not the gc
--   fence. Kind 'native' (a run's machine) moves with C1c-3n.
-- * Rank 5's order (C1B §8: model logins, their versions, then compute identities) in the two paths that took an
--   identity before its model login: a member removal's prelude (qorpera_folder_member_change_enter) took the
--   identities FOR NO KEY UPDATE and then the connections, a deadlock with a sign-in's completion, which takes the
--   connection and then, through the sign-in's epoch trigger, the identity FOR SHARE; and the account metadata
--   (qorpera_record_native_provider_account_metadata) took the identity FOR SHARE before the connection, which would
--   deadlock with the removal in its new order. Both now take the model login first. Both completions
--   (qorpera_complete_native_provider_login, _model_login_sign_in_kind) already follow it and are unchanged.
-- Snapshot-v1 keeps every patched statement in the else branch (test 900 reverses the patches to the text before).
-- The patches are exact text: an anchor that is missing or found twice stops the migration.

create function pg_temp.p13_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'P13 anchor found % time(s) in %, expected %: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, p_count, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. A sign-in machine's locks on folder-v2 -------------------------------------------------------------------------

-- Null (and nothing locked) for a sign-in that does not exist, a reservation whose capability does not match (the
-- caller refuses after its own read) or a snapshot-v1 company (the caller takes the gc fence as before). Otherwise the
-- folder fence and rank 0, and for a reservation the requester's member row and the identity's machine lock; it
-- returns what it read, which the caller compares with the sign-in it then locks.
create function public.qorpera_folder_sign_in_machine_locks(p_kind text, p_id uuid, p_capability_sha256 text, p_reserve boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_profile uuid; v_identity uuid; v_user uuid; v_capability text;
begin
	-- 20260930035000
	if p_kind = 'login' then
		select login.profile_id, login.compute_identity_id, login.requested_by_user_id, login.capability_sha256
		into v_profile, v_identity, v_user, v_capability
		from public.qorpera_native_provider_login_sessions as login where login.id = p_id;
	elsif p_kind = 'account_refresh' then
		select request.profile_id, request.compute_identity_id, request.requested_by_user_id, request.capability_sha256
		into v_profile, v_identity, v_user, v_capability
		from public.qorpera_native_account_refresh_requests as request where request.id = p_id;
	else
		raise exception 'Sign-in machine kind is invalid' using errcode = '22023';
	end if;
	if v_profile is null or (p_reserve and v_capability is distinct from p_capability_sha256)
		or not public.qorpera_company_is_folder_v2(v_profile) then
		return null; end if;
	perform public.qorpera_folder_machine_fence(v_profile);
	if p_reserve then
		perform 1 from public.qorpera_profile_members where profile_id = v_profile and user_id = v_user for share;
		perform pg_advisory_xact_lock(hashtextextended('qorpera.identity-machine:' || v_identity::text, 0));
	end if;
	return jsonb_build_object('profileId', v_profile, 'computeIdentityId', v_identity, 'requestedByUserId', v_user);
end $$;
revoke all on function public.qorpera_folder_sign_in_machine_locks(text, uuid, text, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. The reservations and releases, rank 5's order in the member removal and the account metadata, and the login
-- kind of the node reservation ------------------------------------------------------------------------------------

select pg_temp.p13_replace('public.qorpera_reserve_runtime_login_machine(uuid,text,text,uuid,text)'::regprocedure,
	$p13old$ v_role text; v_reason text; v_placement jsonb;
$p13old$,
	$p13new$ v_role text; v_reason text; v_placement jsonb; v_folder jsonb;
$p13new$, 1);
select pg_temp.p13_replace('public.qorpera_reserve_runtime_login_machine(uuid,text,text,uuid,text)'::regprocedure,
	$p13old$ select * into v_login from public.qorpera_native_provider_login_sessions where id=p_login_id for update;
 if not found or v_login.capability_sha256 is distinct from p_capability_sha256 then
  raise exception 'Login machine authority unavailable' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
$p13old$,
	$p13new$ -- 20260930035000: on folder-v2 the folder fence, rank 0, the requester (rank 1) and the identity's machine lock come
 -- first, then the sign-in (rank 5, before the model logins: C1B §8), and no gc fence.
 v_folder:=public.qorpera_folder_sign_in_machine_locks('login',p_login_id,p_capability_sha256,true);
 select * into v_login from public.qorpera_native_provider_login_sessions where id=p_login_id for update;
 if not found or v_login.capability_sha256 is distinct from p_capability_sha256 then
  raise exception 'Login machine authority unavailable' using errcode='42501'; end if;
 if v_folder is null then
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
 elsif v_folder is distinct from jsonb_build_object('profileId',v_login.profile_id,'computeIdentityId',v_login.compute_identity_id,
  'requestedByUserId',v_login.requested_by_user_id) then
  raise exception 'Login machine authority unavailable' using errcode='42501'; end if;
$p13new$, 1);
select pg_temp.p13_replace('public.qorpera_reserve_runtime_account_refresh_machine(uuid,text,text,uuid,text)'::regprocedure,
	$p13old$ v_role text; v_reason text; v_placement jsonb;
$p13old$,
	$p13new$ v_role text; v_reason text; v_placement jsonb; v_folder jsonb;
$p13new$, 1);
select pg_temp.p13_replace('public.qorpera_reserve_runtime_account_refresh_machine(uuid,text,text,uuid,text)'::regprocedure,
	$p13old$ select * into v_login from public.qorpera_native_account_refresh_requests where id=p_request_id for update;
 if not found or v_login.capability_sha256 is distinct from p_capability_sha256 then
  raise exception 'Login machine authority unavailable' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
$p13old$,
	$p13new$ -- 20260930035000: on folder-v2 the folder fence, rank 0, the requester (rank 1) and the identity's machine lock come
 -- first, then the sign-in (rank 5, before the model logins: C1B §8), and no gc fence.
 v_folder:=public.qorpera_folder_sign_in_machine_locks('account_refresh',p_request_id,p_capability_sha256,true);
 select * into v_login from public.qorpera_native_account_refresh_requests where id=p_request_id for update;
 if not found or v_login.capability_sha256 is distinct from p_capability_sha256 then
  raise exception 'Login machine authority unavailable' using errcode='42501'; end if;
 if v_folder is null then
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
 elsif v_folder is distinct from jsonb_build_object('profileId',v_login.profile_id,'computeIdentityId',v_login.compute_identity_id,
  'requestedByUserId',v_login.requested_by_user_id) then
  raise exception 'Login machine authority unavailable' using errcode='42501'; end if;
$p13new$, 1);
select pg_temp.p13_replace('public.qorpera_release_runtime_login_machine(uuid,text,text,uuid)'::regprocedure,
	$p13old$ v_allocation public.qorpera_runtime_machine_allocations%rowtype; v_released timestamptz;
$p13old$,
	$p13new$ v_allocation public.qorpera_runtime_machine_allocations%rowtype; v_released timestamptz; v_folder jsonb;
$p13new$, 1);
select pg_temp.p13_replace('public.qorpera_release_runtime_login_machine(uuid,text,text,uuid)'::regprocedure,
	$p13old$ select * into strict v_login from public.qorpera_native_provider_login_sessions where id=p_login_id for update;
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
$p13old$,
	$p13new$ -- 20260930035000: on folder-v2 the folder fence and rank 0 come first, then the sign-in, and no gc fence; no pause
 -- read, so a paused company's sign-in machines are released.
 v_folder:=public.qorpera_folder_sign_in_machine_locks('login',p_login_id,null,false);
 select * into strict v_login from public.qorpera_native_provider_login_sessions where id=p_login_id for update;
 if v_folder is null then
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
 elsif (v_folder->>'profileId')::uuid is distinct from v_login.profile_id then
  raise exception 'Login machine deletion identity differs' using errcode='42501'; end if;
$p13new$, 1);
select pg_temp.p13_replace('public.qorpera_release_runtime_account_refresh_machine(uuid,text,text,uuid)'::regprocedure,
	$p13old$ v_allocation public.qorpera_runtime_machine_allocations%rowtype; v_released timestamptz;
$p13old$,
	$p13new$ v_allocation public.qorpera_runtime_machine_allocations%rowtype; v_released timestamptz; v_folder jsonb;
$p13new$, 1);
select pg_temp.p13_replace('public.qorpera_release_runtime_account_refresh_machine(uuid,text,text,uuid)'::regprocedure,
	$p13old$ select * into strict v_login from public.qorpera_native_account_refresh_requests where id=p_request_id for update;
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
$p13old$,
	$p13new$ -- 20260930035000: on folder-v2 the folder fence and rank 0 come first, then the sign-in, and no gc fence; no pause
 -- read, so a paused company's sign-in machines are released.
 v_folder:=public.qorpera_folder_sign_in_machine_locks('account_refresh',p_request_id,null,false);
 select * into strict v_login from public.qorpera_native_account_refresh_requests where id=p_request_id for update;
 if v_folder is null then
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
 elsif (v_folder->>'profileId')::uuid is distinct from v_login.profile_id then
  raise exception 'Login machine deletion identity differs' using errcode='42501'; end if;
$p13new$, 1);
select pg_temp.p13_replace('public.qorpera_folder_member_change_enter(uuid,uuid,text)'::regprocedure,
	$p13old$		-- Rank 5: the member's compute identities and connections (retired and revoked by the triggers).
		perform 1 from public.qorpera_member_compute_identities where profile_id = p_profile_id and ownership_kind = 'member'
			and owner_user_id = p_user_id and status <> 'retired' order by id for no key update;
		perform 1 from public.qorpera_provider_connections where profile_id = p_profile_id and owner_user_id = p_user_id
			and status <> 'revoked' order by id for no key update;
$p13old$,
	$p13new$		-- Rank 5 in C1B §8's order (20260930035000): the member's model logins, then its compute identities (revoked and
		-- retired by the triggers), as a sign-in's completion and the run materializer take them.
		perform 1 from public.qorpera_provider_connections where profile_id = p_profile_id and owner_user_id = p_user_id
			and status <> 'revoked' order by id for no key update;
		perform 1 from public.qorpera_member_compute_identities where profile_id = p_profile_id and ownership_kind = 'member'
			and owner_user_id = p_user_id and status <> 'retired' order by id for no key update;
$p13new$, 1);
select pg_temp.p13_replace('public.qorpera_record_native_provider_account_metadata(uuid,bigint,uuid,bigint,uuid,text,jsonb,text)'::regprocedure,
	$p13old$    perform 1 from public.qorpera_member_compute_identities i where i.id = p_compute_identity_id
      and i.status = 'active' and i.recovery_pending_id is null and i.recovery_epoch = p_recovery_epoch for share;
    if not found then raise exception 'Account metadata identity unavailable' using errcode = '42501'; end if;
    perform 1 from public.qorpera_provider_connections c
      join public.qorpera_provider_connection_versions v on v.connection_id = c.id and v.version = p_connection_version
      join public.qorpera_native_credential_capsules capsule on capsule.id = v.credential_capsule_id
      where c.id = p_connection_id and c.status = 'active' and v.authorization_state = 'active'
        and c.provider = 'openai' and v.native_harness = 'codex-cli' and v.authentication_mode = 'native_subscription'
        and capsule.id = p_credential_capsule_id and capsule.status = 'active'
        and capsule.compute_identity_id = p_compute_identity_id
        and not exists(select 1 from public.qorpera_provider_connection_versions newer
            where newer.connection_id = c.id and newer.version > v.version)
      for share of c, v, capsule;
    if not found then raise exception 'Account metadata connection unavailable' using errcode = '42501'; end if;
$p13old$,
	$p13new$    -- 20260930035000: the model login, its version and capsule, then the identity (C1B §8 rank 5), as a member removal
    -- takes them.
    perform 1 from public.qorpera_provider_connections c
      join public.qorpera_provider_connection_versions v on v.connection_id = c.id and v.version = p_connection_version
      join public.qorpera_native_credential_capsules capsule on capsule.id = v.credential_capsule_id
      where c.id = p_connection_id and c.status = 'active' and v.authorization_state = 'active'
        and c.provider = 'openai' and v.native_harness = 'codex-cli' and v.authentication_mode = 'native_subscription'
        and capsule.id = p_credential_capsule_id and capsule.status = 'active'
        and capsule.compute_identity_id = p_compute_identity_id
        and not exists(select 1 from public.qorpera_provider_connection_versions newer
            where newer.connection_id = c.id and newer.version > v.version)
      for share of c, v, capsule;
    if not found then raise exception 'Account metadata connection unavailable' using errcode = '42501'; end if;
    perform 1 from public.qorpera_member_compute_identities i where i.id = p_compute_identity_id
      and i.status = 'active' and i.recovery_pending_id is null and i.recovery_epoch = p_recovery_epoch for share;
    if not found then raise exception 'Account metadata identity unavailable' using errcode = '42501'; end if;
$p13new$, 1);
select pg_temp.p13_replace('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure,
	$p13old$ -- office kind.
 if p_provider_kind in ('machine', 'coding', 'office') and public.qorpera_company_is_folder_v2(v_profile) then
$p13old$,
	$p13new$ -- office kind. 20260930035000: a sign-in's or refresh's login machine too (the gateway's own call, after the
 -- company reservation).
 if p_provider_kind in ('machine', 'coding', 'office', 'login') and public.qorpera_company_is_folder_v2(v_profile) then
$p13new$, 1);
