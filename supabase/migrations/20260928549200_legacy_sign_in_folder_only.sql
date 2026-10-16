-- 20260930293000: the legacy sweep, step F2d (identity recovery and sign-in machines). Seventeen functions keep only
-- their folder-v2 path (folder-v2 only, the founder's decision of 3 October). Each is patched in place from its live
-- text, so its header, its grants and the other migrations' changes to it stay; each anchor must occur exactly once.
-- 1. Identity recovery (its request by an owner, a sign-in or an account refresh, a member's consent, its activation,
--    cancellation and decision, the service's locked read, a recovery target's registration, a key backup's
--    preparation and the member role the review reads) and an identity's retirement take the folder fence and the
--    folder-v2 locks on every company; the snapshot-v1 branch, the profile gc fence, goes. A company without a folder
--    now fails in the fence ("Company folder is unavailable", 42501).
-- 2. A sign-in's or an account refresh's machine, reserved or released, takes the folder fence through
--    qorpera_folder_sign_in_machine_locks on every company, which no longer answers null for a company without a
--    folder; the profile gc fence goes.
-- Every patched body names this migration (20260930293000), and every earlier marker in it stays.
set local lock_timeout = '3s';

create function pg_temp.f2d_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Legacy sweep F2d anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. Identity recovery and retirement take the folder fence and the folder-v2 locks. ----------------------------------

select pg_temp.f2d_patch('public.qorpera_activate_identity_recovery(uuid)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_recovery.profile_id) then
		perform public.qorpera_folder_identity_recovery_locks(v_recovery.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);
	end if;
$old$,
$new$	-- 20260930293000 (legacy sweep F2d): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_identity_recovery_locks(v_recovery.profile_id);
$new$);

select pg_temp.f2d_patch('public.qorpera_cancel_identity_recovery(uuid)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_recovery.profile_id) then
		perform public.qorpera_folder_identity_recovery_locks(v_recovery.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);
	end if;
$old$,
$new$	-- 20260930293000 (legacy sweep F2d): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_identity_recovery_locks(v_recovery.profile_id);
$new$);

select pg_temp.f2d_patch('public.qorpera_consent_identity_recovery(uuid)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_recovery.profile_id) then
		perform public.qorpera_folder_identity_recovery_locks(v_recovery.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);
	end if;
$old$,
$new$	-- 20260930293000 (legacy sweep F2d): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_identity_recovery_locks(v_recovery.profile_id);
$new$);

select pg_temp.f2d_patch('public.qorpera_recovery_locked(uuid,text,uuid,text)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_authority.profile_id) then
		perform public.qorpera_folder_identity_recovery_locks(v_authority.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_authority.profile_id);
	end if;
$old$,
$new$	-- 20260930293000 (legacy sweep F2d): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_identity_recovery_locks(v_authority.profile_id);
$new$);

select pg_temp.f2d_patch('public.qorpera_request_identity_recovery(uuid,uuid,uuid,bigint,text,text)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_identity.profile_id) then
		perform public.qorpera_folder_identity_recovery_locks(v_identity.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id);
	end if;
$old$,
$new$	-- 20260930293000 (legacy sweep F2d): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_identity_recovery_locks(v_identity.profile_id);
$new$);

select pg_temp.f2d_patch('public.qorpera_register_identity_recovery_target(uuid,text,uuid,uuid,uuid,text,text,text,text)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_authority.profile_id) then
		perform public.qorpera_folder_machine_fence(v_authority.profile_id);
		perform pg_advisory_xact_lock(hashtextextended('qorpera.identity-machine:' || p_compute_identity_id::text, 0));
	else
	perform public.qorpera_lock_profile_gc_fence(v_authority.profile_id);
	end if;
$old$,
$new$	-- 20260930293000 (legacy sweep F2d): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_machine_fence(v_authority.profile_id);
	perform pg_advisory_xact_lock(hashtextextended('qorpera.identity-machine:' || p_compute_identity_id::text, 0));
$new$);

select pg_temp.f2d_patch('public.qorpera_confirm_runtime_identity_retirement(text,text,uuid,jsonb)'::regprocedure,
$old$		if public.qorpera_company_is_folder_v2(v_profile) then
			perform public.qorpera_folder_machine_fence(v_profile);
			perform pg_advisory_xact_lock(hashtextextended('qorpera.identity-machine:' || p_compute_identity_id::text, 0));
		else
		perform public.qorpera_lock_profile_gc_fence(v_profile);
		end if;
$old$,
$new$		-- 20260930293000 (legacy sweep F2d): folder-v2 only, so every company takes this path.
		perform public.qorpera_folder_machine_fence(v_profile);
		perform pg_advisory_xact_lock(hashtextextended('qorpera.identity-machine:' || p_compute_identity_id::text, 0));
$new$);

select pg_temp.f2d_patch('public.qorpera_recovery_member_role(uuid)'::regprocedure,
$old$  if public.qorpera_company_is_folder_v2(p_company_id) then
    perform public.qorpera_folder_machine_fence(p_company_id);
  else
  perform public.qorpera_lock_profile_gc_fence(p_company_id);
  end if;
$old$,
$new$  -- 20260930293000 (legacy sweep F2d): folder-v2 only, so every company takes this path.
  perform public.qorpera_folder_machine_fence(p_company_id);
$new$);

select pg_temp.f2d_patch('public.qorpera_decide_member_identity_recovery(uuid,uuid,uuid,text,text,uuid,text)'::regprocedure,
$old$  if public.qorpera_company_is_folder_v2(p_company_id) and auth.role() = 'authenticated' and exists(
$old$,
$new$  -- 20260930293000 (legacy sweep F2d): folder-v2 only, so every company takes this path.
  if auth.role() = 'authenticated' and exists(
$new$);

select pg_temp.f2d_patch('public.qorpera_prepare_identity_key_backup(uuid,text,uuid,text,text)'::regprocedure,
$old$	v_folder:=public.qorpera_company_is_folder_v2(v_authority.profile_id);
	if v_folder then
		perform public.qorpera_folder_machine_fence(v_authority.profile_id);
		select * into v_login from public.qorpera_native_provider_login_sessions
		where id = p_login_id and profile_id = v_authority.profile_id and capability_sha256 = p_login_capability_sha256
			and status in ('pending','completed') and expires_at > clock_timestamp() for key share;
	else
	perform public.qorpera_lock_profile_gc_fence(v_authority.profile_id);
	select * into v_login from public.qorpera_native_provider_login_sessions
	where id = p_login_id and profile_id = v_authority.profile_id and capability_sha256 = p_login_capability_sha256
		and status in ('pending','completed') and expires_at > clock_timestamp() for share;
	end if;
$old$,
$new$	-- 20260930293000 (legacy sweep F2d): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_machine_fence(v_authority.profile_id);
	select * into v_login from public.qorpera_native_provider_login_sessions
	where id = p_login_id and profile_id = v_authority.profile_id and capability_sha256 = p_login_capability_sha256
		and status in ('pending','completed') and expires_at > clock_timestamp() for key share;
$new$);

select pg_temp.f2d_patch('public.qorpera_prepare_identity_key_backup(uuid,text,uuid,text,text)'::regprocedure,
$old$	if v_folder and not exists(select 1 from public.qorpera_native_provider_login_sessions where id = v_login.id
$old$,
$new$	if not exists(select 1 from public.qorpera_native_provider_login_sessions where id = v_login.id
$new$);

select pg_temp.f2d_patch('public.qorpera_prepare_identity_key_backup(uuid,text,uuid,text,text)'::regprocedure,
$old$	v_revision bigint; v_folder boolean;
$old$,
$new$	v_revision bigint;
$new$);

select pg_temp.f2d_patch('public.qorpera_request_login_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
$old$	select * into v_session from public.qorpera_native_provider_login_sessions where id=p_login_id;
	v_folder:=found and public.qorpera_company_is_folder_v2(v_session.profile_id);
	if not v_folder then
	select * into v_session from public.qorpera_native_provider_login_sessions where id=p_login_id for share;
	end if;
$old$,
$new$	-- 20260930293000 (legacy sweep F2d): folder-v2 only, so every company takes this path.
	select * into v_session from public.qorpera_native_provider_login_sessions where id=p_login_id;
$new$);

select pg_temp.f2d_patch('public.qorpera_request_login_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
$old$	if v_folder then
		perform public.qorpera_folder_identity_recovery_locks(v_identity.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id);
	end if;
$old$,
$new$	-- 20260930293000 (legacy sweep F2d): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_identity_recovery_locks(v_identity.profile_id);
$new$);

select pg_temp.f2d_patch('public.qorpera_request_login_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
$old$	if v_folder and not exists(select 1 from public.qorpera_native_provider_login_sessions where id=p_login_id and status='pending'
$old$,
$new$	if not exists(select 1 from public.qorpera_native_provider_login_sessions where id=p_login_id and status='pending'
$new$);

select pg_temp.f2d_patch('public.qorpera_request_login_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
$old$	if v_folder and not exists(select 1 from public.qorpera_native_provider_login_sessions where id=p_login_id
$old$,
$new$	if not exists(select 1 from public.qorpera_native_provider_login_sessions where id=p_login_id
$new$);

select pg_temp.f2d_patch('public.qorpera_request_login_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
$old$	v_user uuid; v_owner boolean; v_self boolean; v_owner_user uuid; v_folder boolean;
$old$,
$new$	v_user uuid; v_owner boolean; v_self boolean; v_owner_user uuid;
$new$);

select pg_temp.f2d_patch('public.qorpera_request_account_refresh_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
$old$	select * into v_session from public.qorpera_native_account_refresh_requests where id=p_request_id;
	v_folder:=found and public.qorpera_company_is_folder_v2(v_session.profile_id);
	if not v_folder then
	select * into v_session from public.qorpera_native_account_refresh_requests where id=p_request_id for share;
	end if;
$old$,
$new$	-- 20260930293000 (legacy sweep F2d): folder-v2 only, so every company takes this path.
	select * into v_session from public.qorpera_native_account_refresh_requests where id=p_request_id;
$new$);

select pg_temp.f2d_patch('public.qorpera_request_account_refresh_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
$old$	if v_folder then
		perform public.qorpera_folder_identity_recovery_locks(v_identity.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id);
	end if;
$old$,
$new$	-- 20260930293000 (legacy sweep F2d): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_identity_recovery_locks(v_identity.profile_id);
$new$);

select pg_temp.f2d_patch('public.qorpera_request_account_refresh_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
$old$	if v_folder and not exists(select 1 from public.qorpera_native_account_refresh_requests where id=p_request_id and status='pending'
$old$,
$new$	if not exists(select 1 from public.qorpera_native_account_refresh_requests where id=p_request_id and status='pending'
$new$);

select pg_temp.f2d_patch('public.qorpera_request_account_refresh_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
$old$	if v_folder and not exists(select 1 from public.qorpera_native_account_refresh_requests where id=p_request_id
$old$,
$new$	if not exists(select 1 from public.qorpera_native_account_refresh_requests where id=p_request_id
$new$);

select pg_temp.f2d_patch('public.qorpera_request_account_refresh_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
$old$	v_user uuid; v_owner boolean; v_self boolean; v_owner_user uuid; v_folder boolean;
$old$,
$new$	v_user uuid; v_owner boolean; v_self boolean; v_owner_user uuid;
$new$);

-- 2. Sign-in and account refresh machines take the folder fence on every company. -------------------------------------

select pg_temp.f2d_patch('public.qorpera_folder_sign_in_machine_locks(text,uuid,text,boolean)'::regprocedure,
$old$	if v_profile is null or not public.qorpera_company_is_folder_v2(v_profile) then
		return null; end if;
$old$,
$new$	-- 20260930293000 (legacy sweep F2d): folder-v2 only, so a sign-in of any company takes the fence below, and one
	-- of a company without a folder fails in it (42501). Null now means only that the sign-in is unknown.
	if v_profile is null then
		return null; end if;
$new$);

select pg_temp.f2d_patch('public.qorpera_reserve_runtime_login_machine(uuid,text,text,uuid,text)'::regprocedure,
$old$ if v_folder is null then
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
 elsif v_folder is distinct from jsonb_build_object($old$,
$new$ -- 20260930293000 (legacy sweep F2d): the locks above took the folder fence (folder-v2 only, every company).
 if v_folder is distinct from jsonb_build_object($new$);

select pg_temp.f2d_patch('public.qorpera_reserve_runtime_account_refresh_machine(uuid,text,text,uuid,text)'::regprocedure,
$old$ if v_folder is null then
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
 elsif v_folder is distinct from jsonb_build_object($old$,
$new$ -- 20260930293000 (legacy sweep F2d): the locks above took the folder fence (folder-v2 only, every company).
 if v_folder is distinct from jsonb_build_object($new$);

select pg_temp.f2d_patch('public.qorpera_release_runtime_login_machine(uuid,text,text,uuid)'::regprocedure,
$old$ if v_folder is null then
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
 elsif (v_folder->>'profileId')::uuid is distinct from v_login.profile_id then
$old$,
$new$ -- 20260930293000 (legacy sweep F2d): the locks above took the folder fence (folder-v2 only, every company); a
 -- sign-in they did not find yet is refused here.
 if (v_folder->>'profileId')::uuid is distinct from v_login.profile_id then
$new$);

select pg_temp.f2d_patch('public.qorpera_release_runtime_account_refresh_machine(uuid,text,text,uuid)'::regprocedure,
$old$ if v_folder is null then
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
 elsif (v_folder->>'profileId')::uuid is distinct from v_login.profile_id then
$old$,
$new$ -- 20260930293000 (legacy sweep F2d): the locks above took the folder fence (folder-v2 only, every company); a
 -- sign-in they did not find yet is refused here.
 if (v_folder->>'profileId')::uuid is distinct from v_login.profile_id then
$new$);
