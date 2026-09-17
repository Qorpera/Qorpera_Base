-- Login recovery follow-up (17 Sep 2026): a login whose own recovery advanced
-- the identity's recovery generation continues on the new generation. The
-- node gateway re-pins the pending login after the restore completed; the
-- session trigger admits exactly that re-pin (same transaction, current
-- generation, no pending recovery) and nothing else.

create or replace function public.qorpera_pin_login_recovery_epoch()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
begin
	if tg_op = 'UPDATE' and new.compute_recovery_epoch <> old.compute_recovery_epoch
		and current_setting('qorpera.login_recovery_repin', true) is distinct from new.id::text then
		raise exception 'login recovery generation is immutable' using errcode = '42501'; end if;
	if new.status in ('cancelled','expired') then return new; end if;
	select * into v_identity from public.qorpera_member_compute_identities
	where id = new.compute_identity_id and profile_id = new.profile_id for share;
	if not found or v_identity.status <> 'active' or v_identity.recovery_pending_id is not null
		or (tg_op = 'UPDATE' and new.compute_recovery_epoch <> v_identity.recovery_epoch) then
		raise exception 'native login generation is fenced for recovery' using errcode = '42501'; end if;
	if tg_op = 'INSERT' then new.compute_recovery_epoch := v_identity.recovery_epoch; end if;
	if new.status='completed' and exists(select 1 from public.qorpera_identity_recovery_authorities
		where profile_id=v_identity.profile_id and status='active') and not exists(
		select 1 from public.qorpera_identity_backup_login_receipts receipt
		join public.qorpera_identity_key_backups backup using(compute_identity_id,revision)
		join public.qorpera_identity_recovery_authorities authority on authority.id=backup.authority_id
		where receipt.login_id=new.id and receipt.compute_identity_id=v_identity.id
			and backup.status='ready' and backup.policy_sha256=public.qorpera_compute_policy_sha256(v_identity.policy)
			and authority.status='active' and authority.profile_id=v_identity.profile_id) then
		raise exception 'Native login requires a verified recovery backup' using errcode='42501'; end if;
	return new;
end
$$;

-- Node gateway (service role): after the restore for this login completed.
create function public.qorpera_repin_login_recovery_epoch(p_login_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.qorpera_native_provider_login_sessions%rowtype; v_identity public.qorpera_member_compute_identities%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_login_id is null then
		raise exception 'login re-pin requires the node gateway' using errcode='42501'; end if;
	select * into v_session from public.qorpera_native_provider_login_sessions where id=p_login_id for update;
	if not found or v_session.status<>'pending' or v_session.expires_at<=clock_timestamp() then
		raise exception 'login re-pin requires a pending login' using errcode='42501'; end if;
	select * into v_identity from public.qorpera_member_compute_identities where id=v_session.compute_identity_id for share;
	if not found or v_identity.status<>'active' or v_identity.recovery_pending_id is not null then
		raise exception 'login re-pin requires a restored identity' using errcode='42501'; end if;
	if v_session.compute_recovery_epoch=v_identity.recovery_epoch then
		return jsonb_build_object('loginId',v_session.id,'epoch',v_session.compute_recovery_epoch,'repinned',false); end if;
	if not exists(select 1 from public.qorpera_identity_recoveries r where r.compute_identity_id=v_identity.id
			and r.status='completed' and r.epoch=v_identity.recovery_epoch) then
		raise exception 'login re-pin requires a completed recovery on the current generation' using errcode='42501'; end if;
	perform set_config('qorpera.login_recovery_repin',v_session.id::text,true);
	update public.qorpera_native_provider_login_sessions set compute_recovery_epoch=v_identity.recovery_epoch where id=v_session.id returning * into v_session;
	perform set_config('qorpera.login_recovery_repin','',true);
	return jsonb_build_object('loginId',v_session.id,'epoch',v_session.compute_recovery_epoch,'repinned',true);
end
$$;
revoke all on function public.qorpera_repin_login_recovery_epoch(uuid) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_repin_login_recovery_epoch(uuid) to service_role;
