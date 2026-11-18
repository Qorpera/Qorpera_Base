do $$ begin
	if to_regprocedure('public.qorpera_begin_claude_login_read(uuid,uuid,text,boolean,text)') is null then
		raise exception 'Several Claude logins (20260930804000) needs 20260930793000 first'; end if;
	if exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.qorpera_claude_logins'::regclass
		and attname = 'in_use' and not attisdropped) then
		raise exception 'Several Claude logins (20260930804000) is already applied'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.scl_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930804000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

alter table public.qorpera_claude_logins
	add column in_use boolean not null default false,
	add constraint qorpera_claude_logins_in_use_active check (not in_use or status = 'active');
update public.qorpera_claude_logins set in_use = true where status = 'active';
drop index public.qorpera_claude_logins_one_active;
create unique index qorpera_claude_logins_one_in_use on public.qorpera_claude_logins(owner_user_id) where in_use;

create function public.qorpera_claude_login_in_use_default()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if new.status <> 'active' then
		new.in_use := false;
	elsif (tg_op = 'INSERT' or old.status <> 'active') and not new.in_use then
		perform pg_advisory_xact_lock(hashtextextended('qorpera.claude_logins:' || new.owner_user_id::text, 0));
		new.in_use := not exists (select 1 from public.qorpera_claude_logins as claude
			where claude.owner_user_id = new.owner_user_id and claude.status = 'active' and claude.in_use);
	end if;
	return new;
end $$;
revoke all on function public.qorpera_claude_login_in_use_default()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_claude_logins_in_use_default before insert or update of status
	on public.qorpera_claude_logins for each row execute function public.qorpera_claude_login_in_use_default();

create function public.qorpera_claude_login_in_use_held()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if exists (select 1 from public.qorpera_claude_logins as claude
			where claude.owner_user_id = new.owner_user_id and claude.status = 'active')
		and not exists (select 1 from public.qorpera_claude_logins as claude
			where claude.owner_user_id = new.owner_user_id and claude.status = 'active' and claude.in_use) then
		raise exception 'A member''s active Claude logins have one In use' using errcode = '23514'; end if;
	return null;
end $$;
revoke all on function public.qorpera_claude_login_in_use_held()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
create constraint trigger qorpera_claude_logins_in_use_held after insert or update of status, in_use
	on public.qorpera_claude_logins deferrable initially deferred
	for each row execute function public.qorpera_claude_login_in_use_held();

select pg_temp.scl_replace('public.qorpera_complete_claude_login_sign_in(uuid,text,uuid,text,uuid,text,text,text,text,text)'::regprocedure,
	$old$		update public.qorpera_claude_logins
		set status = 'revoked', revoked_at = statement_timestamp(), key_id = null, encrypted_envelope = null,
			envelope_sha256 = null
		where owner_user_id = v_identity.owner_user_id and status = 'active';$old$,
	$new$		perform pg_advisory_xact_lock(hashtextextended('qorpera.claude_logins:' || v_identity.owner_user_id::text, 0));
		update public.qorpera_claude_logins
		set status = 'revoked', revoked_at = statement_timestamp(), key_id = null, encrypted_envelope = null,
			envelope_sha256 = null
		where owner_user_id = v_identity.owner_user_id and status = 'active'
			and lower(provider_account_email) is not distinct from lower(nullif(btrim(p_provider_account_email), ''));$new$);

create function public.qorpera_claude_login_used_up_until(p_login public.qorpera_claude_logins)
returns timestamptz language sql stable security definer set search_path = '' as $$
	select greatest(
		case when (p_login.usage ->> 'limitResetAt')::timestamptz > statement_timestamp()
			then (p_login.usage ->> 'limitResetAt')::timestamptz end,
		(select max((item.window_row ->> 'resetAt')::timestamptz)
			from jsonb_array_elements(coalesce(p_login.usage -> 'windows', '[]'::jsonb)) as item(window_row)
			where item.window_row ->> 'id' in ('five_hour', 'seven_day')
				and (item.window_row ->> 'usedPercent')::numeric >= 100
				and (item.window_row ->> 'resetAt')::timestamptz > statement_timestamp()))
	where p_login.status = 'active'
$$;
revoke all on function public.qorpera_claude_login_used_up_until(public.qorpera_claude_logins)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_claude_login_listed(p_login public.qorpera_claude_logins)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'loginId', p_login.id,
		'providerAccountEmail', p_login.provider_account_email,
		'createdAt', p_login.created_at,
		'clientConnectionId', p_login.client_connection_id,
		'inUse', p_login.in_use,
		'usedUpUntil', to_char(public.qorpera_claude_login_used_up_until(p_login) at time zone 'UTC',
			'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		'usage', p_login.usage,
		'resets', p_login.resets,
		'lastReset', p_login.last_reset)
$$;

create function public.qorpera_claude_logins_listed(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	select coalesce(jsonb_agg(public.qorpera_claude_login_listed(claude) order by claude.created_at, claude.id), '[]'::jsonb)
	from public.qorpera_claude_logins as claude
	where claude.owner_user_id = p_user_id and claude.status = 'active'
$$;
revoke all on function public.qorpera_claude_logins_listed(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.scl_replace('public.qorpera_list_claude_logins(uuid)'::regprocedure,
	$old$		'logins', coalesce((select jsonb_agg(public.qorpera_claude_login_listed(claude) order by claude.created_at, claude.id)
			from public.qorpera_claude_logins as claude
			where claude.owner_user_id = v_user and claude.status = 'active'), '[]'::jsonb)$old$,
	$new$		'logins', public.qorpera_claude_logins_listed(v_user)$new$);

create function public.qorpera_use_claude_login(p_login_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_user uuid := auth.uid();
	v_login public.qorpera_claude_logins%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null or p_login_id is null then
		raise exception 'Claude login is unavailable' using errcode = '42501'; end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera.claude_logins:' || v_user::text, 0));
	select claude.* into v_login from public.qorpera_claude_logins as claude
	where claude.id = p_login_id and claude.owner_user_id = v_user and claude.status = 'active'
	for update;
	if v_login.id is null then
		raise exception 'Claude login is unavailable' using errcode = '42501'; end if;
	update public.qorpera_claude_logins set in_use = false
	where owner_user_id = v_user and in_use and id <> v_login.id;
	update public.qorpera_claude_logins set in_use = true where id = v_login.id and not in_use;
	return jsonb_build_object('schema', 'qorpera.claude-login-use/v1', 'loginId', v_login.id,
		'logins', public.qorpera_claude_logins_listed(v_user));
end $$;
revoke all on function public.qorpera_use_claude_login(uuid) from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_use_claude_login(uuid) to authenticated;

create function public.qorpera_sign_out_claude_login(p_login_id uuid, p_next_login_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_user uuid := auth.uid();
	v_login public.qorpera_claude_logins%rowtype;
	v_next public.qorpera_claude_logins%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Claude login is unavailable' using errcode = '42501'; end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera.claude_logins:' || v_user::text, 0));
	select claude.* into v_login from public.qorpera_claude_logins as claude
	where claude.id = p_login_id and claude.owner_user_id = v_user
	for update;
	if v_login.id is null then
		raise exception 'Claude login is unavailable' using errcode = '42501'; end if;
	if v_login.status = 'active' and v_login.in_use and exists (select 1 from public.qorpera_claude_logins as claude
		where claude.owner_user_id = v_user and claude.status = 'active' and claude.id <> v_login.id) then
		select claude.* into v_next from public.qorpera_claude_logins as claude
		where claude.id = p_next_login_id and claude.owner_user_id = v_user and claude.status = 'active'
			and claude.id <> v_login.id
		for update;
		if v_next.id is null then
			raise exception 'This Claude login is in use. Choose the Claude login that new Claude work moves to, then sign out.'
				using errcode = '55000'; end if;
	elsif v_login.status = 'active' and p_next_login_id is not null then
		raise exception 'A next Claude login is chosen only when you sign out of the one in use while others remain.'
			using errcode = '22023';
	end if;
	update public.qorpera_claude_logins
	set status = 'revoked', revoked_at = coalesce(revoked_at, statement_timestamp()), key_id = null,
		encrypted_envelope = null, envelope_sha256 = null, in_use = false
	where id = v_login.id and status = 'active';
	if v_next.id is not null then
		update public.qorpera_claude_logins set in_use = true where id = v_next.id;
	end if;
	return jsonb_build_object('schema', 'qorpera.claude-login-sign-out/v1', 'loginId', v_login.id, 'status', 'revoked');
end
$$;
revoke all on function public.qorpera_sign_out_claude_login(uuid, uuid) from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_sign_out_claude_login(uuid, uuid) to authenticated;

create or replace function public.qorpera_sign_out_claude_login(p_login_id uuid)
returns jsonb
language sql security definer set search_path = '' as $$
	select public.qorpera_sign_out_claude_login(p_login_id, null)
$$;

select pg_temp.scl_replace('public.qorpera_claude_worker_login(uuid,uuid)'::regprocedure,
	$old$where login.owner_user_id = p_member_user_id and login.status = 'active'$old$,
	$new$where login.owner_user_id = p_member_user_id and login.status = 'active' and login.in_use$new$);

do $$ begin
	-- WHY: 20260930787000 (Claude-first) is on master but not under 20260930793000's branch;
	-- a tree with it gets its picker patched too.
	if to_regprocedure('public.qorpera_claude_worker_default_login(uuid,uuid,uuid,uuid)') is not null then
		perform pg_temp.scl_replace('public.qorpera_claude_worker_default_login(uuid,uuid,uuid,uuid)'::regprocedure,
			$old$where login.owner_user_id = p_member_user_id and login.status = 'active'$old$,
			$new$where login.owner_user_id = p_member_user_id and login.status = 'active' and login.in_use$new$);
	end if;
end $$;

create function public.qorpera_begin_claude_login_read(p_profile_id uuid, p_claude_login_id uuid, p_client_request_id uuid,
	p_capability_sha256 text, p_force boolean, p_reset_kind text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_login public.qorpera_claude_logins%rowtype;
	v_request public.qorpera_native_account_refresh_requests%rowtype;
	v_usage boolean;
	v_resets boolean;
	v_created timestamptz;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_profile_id is null
		or p_client_request_id is null or coalesce(p_capability_sha256, '') !~ '^[0-9a-f]{64}$'
		or (p_reset_kind is not null and p_reset_kind not in ('session', 'weekly', 'fable', 'full')) then
		raise exception 'Claude login read requires member authority' using errcode = '42501'; end if;
	select identity.* into v_identity from public.qorpera_member_compute_identities as identity
	where identity.profile_id = p_profile_id and identity.ownership_kind = 'member'
		and identity.owner_user_id = auth.uid() and identity.status = 'active' and identity.recovery_pending_id is null
	for share;
	if v_identity.id is null or not exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and member.user_id = auth.uid()
			and member.role in ('owner', 'admin', 'contributor')) then
		raise exception 'Claude login read unavailable' using errcode = '42501'; end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera.account_refresh:' || v_identity.id::text, 0));
	select claude.* into v_login from public.qorpera_claude_logins as claude
	where claude.id = p_claude_login_id and claude.owner_user_id = auth.uid() and claude.status = 'active'
	for update;
	if not public.qorpera_claude_sign_in_open(p_profile_id, auth.uid()) then
		raise exception 'Claude login read unavailable' using errcode = '42501'; end if;
	if v_login.id is null or v_login.principal_id is distinct from public.qorpera_company_account_vault(p_profile_id)
		or public.qorpera_model_login_vault_url(p_profile_id) is null then
		raise exception 'No Claude login to read here' using errcode = '55000'; end if;
	select request.* into v_request from public.qorpera_native_account_refresh_requests as request
	where request.profile_id = p_profile_id and request.requested_by_user_id = auth.uid()
		and request.client_request_id = p_client_request_id;
	if v_request.id is not null then
		if v_request.capability_sha256 is distinct from p_capability_sha256 or v_request.compute_identity_id <> v_identity.id
			or v_request.claude_login_id is distinct from v_login.id
			or v_request.claude_reset_kind is distinct from p_reset_kind then
			raise exception 'Account refresh request already bound' using errcode = '23505'; end if;
		if v_request.expires_at <= clock_timestamp() or v_request.status not in ('pending', 'completed') then
			raise exception 'Account refresh expired' using errcode = '55000'; end if;
		return public.qorpera_native_account_refresh_json(v_request);
	end if;
	if p_reset_kind is not null and not exists (select 1
		from jsonb_array_elements(coalesce(v_login.resets -> 'entries', '[]'::jsonb)) as item(entry)
		where item.entry ->> 'kind' = p_reset_kind and item.entry ->> 'usable' = 'now'
			and (item.entry ->> 'left')::int > 0) then
		raise exception 'No such Claude reset to use' using errcode = '55000'; end if;
	v_usage := p_reset_kind is null and (coalesce(p_force, false) or v_login.usage_read_at is null
		or v_login.usage_read_at <= statement_timestamp() - interval '60 seconds');
	v_resets := p_reset_kind is null and (coalesce(p_force, false) or v_login.resets is null
		or (v_login.resets ->> 'observedAt')::timestamptz <= statement_timestamp() - interval '10 minutes');
	update public.qorpera_native_account_refresh_requests set status = 'expired'
	where compute_identity_id = v_identity.id and status = 'pending' and expires_at <= clock_timestamp();
	if exists (select 1 from public.qorpera_native_account_refresh_requests
		where compute_identity_id = v_identity.id and status = 'pending') then
		raise exception 'Account refresh already in progress' using errcode = '55000'; end if;
	v_created := clock_timestamp();
	insert into public.qorpera_native_account_refresh_requests(profile_id, client_request_id, compute_identity_id,
		requested_by_user_id, capability_sha256, compute_recovery_epoch, status, created_at, expires_at, completed_at,
		claude_login_id, claude_usage, claude_resets, claude_reset_kind, claude_reset_state)
	values (p_profile_id, p_client_request_id, v_identity.id, auth.uid(), p_capability_sha256, v_identity.recovery_epoch,
		case when p_reset_kind is null and not v_usage and not v_resets then 'completed' else 'pending' end,
		v_created, v_created + interval '5 minutes',
		case when p_reset_kind is null and not v_usage and not v_resets then v_created end,
		v_login.id, v_usage, v_resets, p_reset_kind, case when p_reset_kind is not null then 'asked' end)
	returning * into v_request;
	return public.qorpera_native_account_refresh_json(v_request);
end $$;
revoke all on function public.qorpera_begin_claude_login_read(uuid, uuid, uuid, text, boolean, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_begin_claude_login_read(uuid, uuid, uuid, text, boolean, text) to authenticated;

create or replace function public.qorpera_begin_claude_login_read(p_profile_id uuid, p_client_request_id uuid,
	p_capability_sha256 text, p_force boolean, p_reset_kind text)
returns jsonb language sql security definer set search_path = '' as $$
	select public.qorpera_begin_claude_login_read(p_profile_id,
		(select claude.id from public.qorpera_claude_logins as claude
			where claude.owner_user_id = auth.uid() and claude.status = 'active' and claude.in_use),
		p_client_request_id, p_capability_sha256, p_force, p_reset_kind)
$$;
