-- Company folder core, P13 part 2: identity recovery and retirement on the folder core's order
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.17; C1B §8). F3's activation check 838 lists these sites as gc
-- fence holders. Each took the gc fence (the company row FOR UPDATE), on folder-v2 a stall of every effect of the
-- company, and three took a sign-in before it. On folder-v2 now, no gc fence:
-- * Recovery (activate, cancel, consent, the three requests, recovery_locked, which the service's completion, release
--   and completion authority call): after the authority's or the member's own unlocked check (#575), the fence KEY
--   SHARE and rank 0, then rank 1: every member row of the company FOR SHARE in user id order
--   (qorpera_folder_identity_recovery_locks). The call chain reads members FOR SHARE after the identity (the caller,
--   the recovery's owner of record, the consenting member; activate, which consent and the requests call, reads the
--   last two), and which they are, and their roles, is only known there; holding every row first means none that
--   exists then is newly locked after the identity. It blocks member writes (role changes, removals, rule saves,
--   display names) for the length of a recovery call, never a reader or a KEY SHARE. Then the identity FOR UPDATE, the
--   recovery, the target and the backups, as before.
-- * A member's recovery decision (qorpera_decide_member_identity_recovery) runs a review, which reads the identity FOR
--   SHARE, before the request, consent or cancellation that takes it FOR UPDATE. On folder-v2 it now takes the helper
--   and the identity FOR UPDATE first, so two decisions on one identity, or a decision and the removal of the
--   identity's owner, queue instead of deadlocking.
-- * A login's or refresh's recovery request reads the sign-in with no lock and checks it again under the identity's
--   lock: still pending and unexpired, and re-pinned to no other recovery epoch meanwhile (what the old FOR SHARE held
--   still). Holding it FOR SHARE while waiting for the identity deadlocks with a new sign-in, whose epoch trigger holds
--   the identity FOR SHARE and then cancels the requester's earlier pending sign-in; taking the identity first and the
--   sign-in after deadlocks with a completion (the sign-in, then the identity through its epoch trigger). Nothing needs
--   the sign-in held: while recovery holds the identity FOR UPDATE no completion of its sign-ins can commit (its
--   capsule's foreign key and its epoch trigger wait), and a cancellation meanwhile makes the check refuse. This also
--   closes P13 part 1's window (20260930035000): the requests no longer take a sign-in before the fence.
-- * A key backup's preparation (which the backup's completion calls) takes the fence and rank 0, then its sign-in FOR
--   KEY SHARE before the identity, because the backup and its receipt reference the sign-in: their foreign keys would
--   otherwise take it after the identity. KEY SHARE conflicts only with FOR UPDATE, which completions, repins and
--   machine reservations take before the identity too, and not with a new sign-in's cancellation. The sign-in is
--   checked again under the identity's lock.
-- * A recovery target's registration, the recovery member role and an identity's retirement confirmation take the fence
--   and rank 0 (qorpera_folder_machine_fence) in place of the gc fence; recovery_member_role's member row (rank 1)
--   follows.
-- Snapshot-v1 keeps every patched statement in its else branch. The patches are exact text: an anchor that is missing
-- or found twice stops the migration.

create function pg_temp.p13b_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'P13 part 2 anchor found % time(s) in %, expected %: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, p_count, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. A recovery's company locks on folder-v2 ---------------------------------------------------------------------------

-- The fence KEY SHARE and rank 0, then every member row of the company FOR SHARE in user id order. It blocks only member
-- writes (role changes, removals, rule saves, display names), for the length of a rare recovery call; readers and KEY
-- SHARE go on beside it.
create function public.qorpera_folder_identity_recovery_locks(p_profile_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
	-- 20260930049000
	perform public.qorpera_folder_machine_fence(p_profile_id);
	perform 1 from public.qorpera_profile_members as member where member.profile_id = p_profile_id
	order by member.user_id for share;
end $$;
revoke all on function public.qorpera_folder_identity_recovery_locks(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. The recovery and retirement sites ----------------------------------------------------------------------------

select pg_temp.p13b_replace('public.qorpera_activate_identity_recovery(uuid)'::regprocedure,
	$p13old$	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);
$p13old$,
	$p13new$	-- 20260930049000: on folder-v2 the fence, rank 0 and the company's member rows (rank 1) before the identity; no gc fence.
	if public.qorpera_company_is_folder_v2(v_recovery.profile_id) then
		perform public.qorpera_folder_identity_recovery_locks(v_recovery.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);
	end if;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_cancel_identity_recovery(uuid)'::regprocedure,
	$p13old$	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);
$p13old$,
	$p13new$	-- 20260930049000: on folder-v2 the fence, rank 0 and the company's member rows (rank 1) before the identity; no gc fence.
	if public.qorpera_company_is_folder_v2(v_recovery.profile_id) then
		perform public.qorpera_folder_identity_recovery_locks(v_recovery.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);
	end if;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_consent_identity_recovery(uuid)'::regprocedure,
	$p13old$	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);
$p13old$,
	$p13new$	-- 20260930049000: on folder-v2 the fence, rank 0 and the company's member rows (rank 1) before the identity; no gc fence.
	if public.qorpera_company_is_folder_v2(v_recovery.profile_id) then
		perform public.qorpera_folder_identity_recovery_locks(v_recovery.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);
	end if;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_request_identity_recovery(uuid,uuid,uuid,bigint,text,text)'::regprocedure,
	$p13old$	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id);
$p13old$,
	$p13new$	-- 20260930049000: on folder-v2 the fence, rank 0 and the company's member rows (rank 1) before the identity; no gc fence.
	if public.qorpera_company_is_folder_v2(v_identity.profile_id) then
		perform public.qorpera_folder_identity_recovery_locks(v_identity.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id);
	end if;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_request_login_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
	$p13old$	v_user uuid; v_owner boolean; v_self boolean; v_owner_user uuid;
$p13old$,
	$p13new$	v_user uuid; v_owner boolean; v_self boolean; v_owner_user uuid; v_folder boolean;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_request_login_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
	$p13old$	select * into v_session from public.qorpera_native_provider_login_sessions where id=p_login_id for share;
$p13old$,
	$p13new$	-- 20260930049000: on folder-v2 the sign-in is read with no lock and checked again under the identity's lock
	-- (pending, and re-pinned to no other recovery epoch meanwhile); holding it while waiting for the identity
	-- deadlocks with a new sign-in (C1B §8).
	select * into v_session from public.qorpera_native_provider_login_sessions where id=p_login_id;
	v_folder:=found and public.qorpera_company_is_folder_v2(v_session.profile_id);
	if not v_folder then
	select * into v_session from public.qorpera_native_provider_login_sessions where id=p_login_id for share;
	end if;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_request_login_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
	$p13old$	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id);
$p13old$,
	$p13new$	-- 20260930049000: on folder-v2 the fence, rank 0 and the company's member rows (rank 1) before the identity; no gc fence.
	if v_folder then
		perform public.qorpera_folder_identity_recovery_locks(v_identity.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id);
	end if;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_request_login_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
	$p13old$	select * into strict v_identity from public.qorpera_member_compute_identities where id=v_session.compute_identity_id for update;
$p13old$,
	$p13new$	select * into strict v_identity from public.qorpera_member_compute_identities where id=v_session.compute_identity_id for update;
	if v_folder and not exists(select 1 from public.qorpera_native_provider_login_sessions where id=p_login_id and status='pending'
		and expires_at>clock_timestamp()) then
		raise exception 'login recovery requires a pending login' using errcode='42501'; end if;
	if v_folder and not exists(select 1 from public.qorpera_native_provider_login_sessions where id=p_login_id
		and compute_recovery_epoch=v_session.compute_recovery_epoch) then
		raise exception 'login recovery generation changed' using errcode='42501'; end if;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_request_account_refresh_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
	$p13old$	v_user uuid; v_owner boolean; v_self boolean; v_owner_user uuid;
$p13old$,
	$p13new$	v_user uuid; v_owner boolean; v_self boolean; v_owner_user uuid; v_folder boolean;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_request_account_refresh_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
	$p13old$	select * into v_session from public.qorpera_native_account_refresh_requests where id=p_request_id for share;
$p13old$,
	$p13new$	-- 20260930049000: on folder-v2 the refresh request is read with no lock and checked again under the identity's lock
	-- (pending, and re-pinned to no other recovery epoch meanwhile); holding it while waiting for the identity
	-- deadlocks with a new sign-in (C1B §8).
	select * into v_session from public.qorpera_native_account_refresh_requests where id=p_request_id;
	v_folder:=found and public.qorpera_company_is_folder_v2(v_session.profile_id);
	if not v_folder then
	select * into v_session from public.qorpera_native_account_refresh_requests where id=p_request_id for share;
	end if;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_request_account_refresh_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
	$p13old$	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id);
$p13old$,
	$p13new$	-- 20260930049000: on folder-v2 the fence, rank 0 and the company's member rows (rank 1) before the identity; no gc fence.
	if v_folder then
		perform public.qorpera_folder_identity_recovery_locks(v_identity.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id);
	end if;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_request_account_refresh_identity_recovery(uuid,uuid,uuid,text)'::regprocedure,
	$p13old$	select * into strict v_identity from public.qorpera_member_compute_identities where id=v_session.compute_identity_id for update;
$p13old$,
	$p13new$	select * into strict v_identity from public.qorpera_member_compute_identities where id=v_session.compute_identity_id for update;
	if v_folder and not exists(select 1 from public.qorpera_native_account_refresh_requests where id=p_request_id and status='pending'
		and expires_at>clock_timestamp()) then
		raise exception 'login recovery requires a pending login' using errcode='42501'; end if;
	if v_folder and not exists(select 1 from public.qorpera_native_account_refresh_requests where id=p_request_id
		and compute_recovery_epoch=v_session.compute_recovery_epoch) then
		raise exception 'login recovery generation changed' using errcode='42501'; end if;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_prepare_identity_key_backup(uuid,text,uuid,text,text)'::regprocedure,
	$p13old$	v_revision bigint;
$p13old$,
	$p13new$	v_revision bigint; v_folder boolean;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_prepare_identity_key_backup(uuid,text,uuid,text,text)'::regprocedure,
	$p13old$	perform public.qorpera_lock_profile_gc_fence(v_authority.profile_id);
	select * into v_login from public.qorpera_native_provider_login_sessions
	where id = p_login_id and profile_id = v_authority.profile_id and capability_sha256 = p_login_capability_sha256
		and status in ('pending','completed') and expires_at > clock_timestamp() for share;
$p13old$,
	$p13new$	-- 20260930049000: on folder-v2 the fence and rank 0, then the sign-in KEY SHARE (the backup and its receipt
	-- reference it), which a new sign-in's cancellation does not wait for, checked again under the identity's
	-- lock (C1B §8); no gc fence.
	v_folder:=public.qorpera_company_is_folder_v2(v_authority.profile_id);
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
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_prepare_identity_key_backup(uuid,text,uuid,text,text)'::regprocedure,
	$p13old$	if v_login.compute_recovery_epoch <> v_identity.recovery_epoch then
		raise exception 'recovery source login generation changed' using errcode = '42501'; end if;
$p13old$,
	$p13new$	if v_folder and not exists(select 1 from public.qorpera_native_provider_login_sessions where id = v_login.id
		and status in ('pending','completed') and expires_at > clock_timestamp()
		and compute_recovery_epoch = v_login.compute_recovery_epoch) then
		raise exception 'recovery source login is unavailable' using errcode = '42501'; end if;
	if v_login.compute_recovery_epoch <> v_identity.recovery_epoch then
		raise exception 'recovery source login generation changed' using errcode = '42501'; end if;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_recovery_locked(uuid,text,uuid,text)'::regprocedure,
	$p13old$	perform public.qorpera_lock_profile_gc_fence(v_authority.profile_id);
$p13old$,
	$p13new$	-- 20260930049000: on folder-v2 the fence, rank 0 and the company's member rows (rank 1) before the identity; no gc fence.
	if public.qorpera_company_is_folder_v2(v_authority.profile_id) then
		perform public.qorpera_folder_identity_recovery_locks(v_authority.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_authority.profile_id);
	end if;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_register_identity_recovery_target(uuid,text,uuid,uuid,uuid,text,text,text,text)'::regprocedure,
	$p13old$	perform public.qorpera_lock_profile_gc_fence(v_authority.profile_id);
$p13old$,
	$p13new$	-- 20260930049000: on folder-v2 the fence and rank 0; no gc fence.
	if public.qorpera_company_is_folder_v2(v_authority.profile_id) then
		perform public.qorpera_folder_machine_fence(v_authority.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_authority.profile_id);
	end if;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_recovery_member_role(uuid)'::regprocedure,
	$p13old$  perform public.qorpera_lock_profile_gc_fence(p_company_id);
$p13old$,
	$p13new$  -- 20260930049000: on folder-v2 the fence and rank 0, then the member (rank 1); no gc fence.
  if public.qorpera_company_is_folder_v2(p_company_id) then
    perform public.qorpera_folder_machine_fence(p_company_id);
  else
  perform public.qorpera_lock_profile_gc_fence(p_company_id);
  end if;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_confirm_runtime_identity_retirement(text,text,uuid,jsonb)'::regprocedure,
	$p13old$		perform public.qorpera_lock_profile_gc_fence(v_profile);
$p13old$,
	$p13new$		-- 20260930049000: on folder-v2 the fence and rank 0; no gc fence.
		if public.qorpera_company_is_folder_v2(v_profile) then
			perform public.qorpera_folder_machine_fence(v_profile);
		else
		perform public.qorpera_lock_profile_gc_fence(v_profile);
		end if;
$p13new$, 1);
select pg_temp.p13b_replace('public.qorpera_decide_member_identity_recovery(uuid,uuid,uuid,text,text,uuid,text)'::regprocedure,
	$p13old$begin
  v_review:=public.qorpera_review_member_identity_recovery(p_company_id,p_compute_identity_id,p_target_id);
$p13old$,
	$p13new$begin
  -- 20260930049000: on folder-v2 a decision takes the recovery's locks before the review reads: the fence, rank 0
  -- and every member row, then the identity FOR UPDATE. The review's FOR SHARE reads, and the request, consent
  -- or cancellation after them, then take nothing new, so two decisions on one identity, or a decision and the
  -- removal of the identity's owner, queue instead of deadlocking (C1B §8). A caller the review would refuse
  -- (checked here with no lock) takes none of them.
  if public.qorpera_company_is_folder_v2(p_company_id) and auth.role() = 'authenticated' and exists(
    select 1 from public.qorpera_member_compute_identities as identity
    join public.qorpera_profile_members as member on member.profile_id = identity.profile_id and member.user_id = auth.uid()
    where identity.id = p_compute_identity_id and identity.profile_id = p_company_id
      and (member.role = 'owner' or identity.owner_user_id = auth.uid())) then
    perform public.qorpera_folder_identity_recovery_locks(p_company_id);
    perform 1 from public.qorpera_member_compute_identities where id = p_compute_identity_id for update;
  end if;
  v_review:=public.qorpera_review_member_identity_recovery(p_company_id,p_compute_identity_id,p_target_id);
$p13new$, 1);
