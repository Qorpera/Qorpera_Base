set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_take_claude_login_renewal(uuid,text,uuid,text)') is null
		or to_regclass('public.qorpera_claude_worker_leases') is null
		or to_regclass('public.qorpera_native_account_refresh_requests') is null then
		raise exception 'Claude login read renews (20260930871000) requires 20260930810000 first'; end if;
	if position('''read''' in pg_get_functiondef(
		'public.qorpera_take_claude_login_renewal(uuid,text,uuid,text)'::regprocedure)) > 0 then
		raise exception 'Claude login read renews (20260930871000) is already applied'; end if;
end $$;

create or replace function public.qorpera_take_claude_login_renewal(p_principal_id uuid, p_capability_sha256 text,
	p_claude_login_id uuid, p_purpose text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_now timestamptz := clock_timestamp();
	v_login public.qorpera_claude_logins%rowtype;
	v_age interval;
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	v_age := case p_purpose when 'open' then interval '30 seconds' when 'poll' then interval '90 seconds'
		when 'read' then interval '30 seconds' end;
	if v_age is null or p_claude_login_id is null then
		raise exception 'Claude login renewal is invalid' using errcode = '22023'; end if;
	update public.qorpera_claude_logins as login
	set renewal_token = extensions.gen_random_uuid(), renewal_until = v_now + interval '2 minutes'
	where login.id = p_claude_login_id and login.principal_id = v_principal.id and login.status = 'active'
		and (login.renewal_until is null or login.renewal_until < v_now)
		and (login.checked_at is null or login.checked_at < v_now - v_age)
		and public.qorpera_claude_login_renewal_rested(login, v_now)
		and case when p_purpose = 'read' then
			exists (select 1 from public.qorpera_native_account_refresh_requests request
				where request.claude_login_id = login.id and request.requested_by_user_id = login.owner_user_id
					and request.status = 'pending' and request.expires_at > v_now
					and (request.claude_usage or request.claude_resets or request.claude_reset_kind is not null))
		else
			exists (select 1 from public.qorpera_claude_worker_leases lease
				where lease.owner_user_id = login.owner_user_id and lease.claude_login_id = login.id
					and public.qorpera_claude_worker_lease_live(lease))
		end
	returning login.* into v_login;
	if v_login.id is null then
		return jsonb_build_object('schema', 'qorpera.claude-login-renewal/v1', 'renewal', null,
			'busy', exists (select 1 from public.qorpera_claude_logins login where login.id = p_claude_login_id
				and login.principal_id = v_principal.id and login.status = 'active' and login.renewal_until >= v_now));
	end if;
	return public.qorpera_claude_login_renewal_answer(v_login);
end $$;

revoke all on function public.qorpera_take_claude_login_renewal(uuid, text, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_take_claude_login_renewal(uuid, text, uuid, text) to qorpera_secret_broker;
