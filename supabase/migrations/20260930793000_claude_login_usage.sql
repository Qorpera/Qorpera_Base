set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_claude_login_run(uuid,text,jsonb,boolean,boolean)') is null then
		raise exception 'Claude login usage (20260930793000) needs 20260930771000 first'; end if;
	if to_regprocedure('public.qorpera_begin_claude_login_read(uuid,uuid,text,boolean,text)') is not null then
		raise exception 'Claude login usage (20260930793000) is already applied'; end if;
end $$;

create function public.qorpera_claude_usage_valid(p_usage jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select jsonb_typeof(p_usage) = 'object'
		and octet_length(p_usage::text) <= 4096
		and (select coalesce(bool_and(key in ('observedAt', 'windows', 'limitResetAt')), false)
			from jsonb_object_keys(p_usage) as key)
		and jsonb_typeof(p_usage -> 'observedAt') = 'string'
		and p_usage ->> 'observedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
		and (not p_usage ? 'limitResetAt' or (jsonb_typeof(p_usage -> 'limitResetAt') = 'string'
			and p_usage ->> 'limitResetAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'))
		and jsonb_typeof(p_usage -> 'windows') = 'array'
		and jsonb_array_length(p_usage -> 'windows') between 1 and 4
		and not exists (select 1 from jsonb_array_elements(p_usage -> 'windows') as item(window_row)
			where jsonb_typeof(item.window_row) <> 'object'
				or exists (select 1 from jsonb_object_keys(item.window_row) as key
					where key not in ('id', 'label', 'usedPercent', 'resetAt'))
				or coalesce(item.window_row ->> 'id', '') not in ('five_hour', 'seven_day', 'seven_day_model')
				or jsonb_typeof(item.window_row -> 'label') <> 'string'
				or char_length(item.window_row ->> 'label') not between 1 and 64
				or jsonb_typeof(item.window_row -> 'usedPercent') <> 'number'
				or (item.window_row ->> 'usedPercent')::numeric not between 0 and 100
				or (item.window_row ? 'resetAt' and (jsonb_typeof(item.window_row -> 'resetAt') <> 'string'
					or item.window_row ->> 'resetAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$')))
$$;

create function public.qorpera_claude_resets_valid(p_resets jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select jsonb_typeof(p_resets) = 'object'
		and octet_length(p_resets::text) <= 4096
		and (select coalesce(bool_and(key in ('observedAt', 'entries')), false) from jsonb_object_keys(p_resets) as key)
		and jsonb_typeof(p_resets -> 'observedAt') = 'string'
		and p_resets ->> 'observedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
		and jsonb_typeof(p_resets -> 'entries') = 'array'
		and jsonb_array_length(p_resets -> 'entries') <= 4
		and not exists (select 1 from jsonb_array_elements(p_resets -> 'entries') as item(entry)
			where jsonb_typeof(item.entry) <> 'object'
				or exists (select 1 from jsonb_object_keys(item.entry) as key
					where key not in ('kind', 'left', 'refills', 'weekStays', 'useBy', 'usable'))
				or not (item.entry -> 'kind' = 'null'::jsonb
					or coalesce(item.entry ->> 'kind', '') in ('session', 'weekly', 'fable', 'full'))
				or jsonb_typeof(item.entry -> 'left') <> 'number'
				or (item.entry ->> 'left') !~ '^\d{1,3}$'
				or coalesce(item.entry ->> 'usable', '') not in ('now', 'at_limit')
				or (item.entry ->> 'usable' = 'now' and item.entry -> 'kind' = 'null'::jsonb)
				or exists (select 1 from unnest(array['refills', 'weekStays', 'useBy']) as field(name)
					where not (coalesce(item.entry -> field.name, 'null'::jsonb) = 'null'::jsonb
						or (jsonb_typeof(item.entry -> field.name) = 'string'
							and char_length(item.entry ->> field.name) between 1 and 120))))
$$;
revoke all on function public.qorpera_claude_usage_valid(jsonb), public.qorpera_claude_resets_valid(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

alter table public.qorpera_claude_logins
	add column usage jsonb check (usage is null or public.qorpera_claude_usage_valid(usage)),
	add column resets jsonb check (resets is null or public.qorpera_claude_resets_valid(resets)),
	add column last_reset jsonb check (last_reset is null or (jsonb_typeof(last_reset) = 'object'
		and octet_length(last_reset::text) <= 512));

alter table public.qorpera_native_account_refresh_requests
	add column claude_login_id uuid references public.qorpera_claude_logins(id),
	add column claude_usage boolean not null default false,
	add column claude_resets boolean not null default false,
	add column claude_reset_kind text check (claude_reset_kind in ('session', 'weekly', 'fable', 'full')),
	add column claude_reset_state text check (claude_reset_state in ('asked', 'using', 'reset', 'failed', 'unconfirmed')),
	add constraint qorpera_account_refresh_claude_read check (claude_login_id is not null
		or (not claude_usage and not claude_resets and claude_reset_kind is null)),
	add constraint qorpera_account_refresh_claude_reset check ((claude_reset_kind is null) = (claude_reset_state is null)
		and (claude_reset_kind is null or (not claude_usage and not claude_resets)));

create function public.qorpera_claude_login_listed(p_login public.qorpera_claude_logins)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'loginId', p_login.id,
		'providerAccountEmail', p_login.provider_account_email,
		'createdAt', p_login.created_at,
		'clientConnectionId', p_login.client_connection_id,
		'usage', p_login.usage,
		'resets', p_login.resets,
		'lastReset', p_login.last_reset)
$$;
revoke all on function public.qorpera_claude_login_listed(public.qorpera_claude_logins)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_list_claude_logins(p_profile_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
begin
	if auth.role() is distinct from 'authenticated' or v_user is null or not exists (
		select 1 from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and member.user_id = v_user) then
		raise exception 'Claude logins are unavailable' using errcode = '42501';
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.claude-logins/v1',
		'signInOpen', public.qorpera_claude_sign_in_open(p_profile_id, v_user),
		'readable', public.qorpera_model_login_vault_url(p_profile_id) is not null and exists (
			select 1 from public.qorpera_claude_logins as claude
			where claude.owner_user_id = v_user and claude.status = 'active'
				and claude.principal_id = public.qorpera_company_account_vault(p_profile_id)),
		'logins', coalesce((select jsonb_agg(public.qorpera_claude_login_listed(claude) order by claude.created_at, claude.id)
			from public.qorpera_claude_logins as claude
			where claude.owner_user_id = v_user and claude.status = 'active'), '[]'::jsonb)
	);
end
$$;

create function public.qorpera_begin_claude_login_read(p_profile_id uuid, p_client_request_id uuid,
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
	where claude.owner_user_id = auth.uid() and claude.status = 'active'
	for update;
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
	v_usage := p_reset_kind is null and (coalesce(p_force, false) or v_login.usage is null
		or (v_login.usage ->> 'observedAt')::timestamptz <= statement_timestamp() - interval '60 seconds');
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
revoke all on function public.qorpera_begin_claude_login_read(uuid, uuid, text, boolean, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_begin_claude_login_read(uuid, uuid, text, boolean, text) to authenticated;

create function public.qorpera_claude_login_read_request(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_request_id uuid, p_capability_sha256 text, p_lock boolean)
returns public.qorpera_native_account_refresh_requests
language plpgsql security definer set search_path = '' as $$
declare
	v_request public.qorpera_native_account_refresh_requests%rowtype;
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_login public.qorpera_claude_logins%rowtype;
begin
	v_request := public.qorpera_model_login_account_refresh(
		p_broker_authority_id, p_broker_capability_sha256, p_request_id, p_capability_sha256);
	if p_lock then
		select request.* into strict v_request from public.qorpera_native_account_refresh_requests as request
		where request.id = p_request_id for update;
	end if;
	select authority.* into strict v_authority from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id;
	select claude.* into v_login from public.qorpera_claude_logins as claude where claude.id = v_request.claude_login_id;
	if v_login.id is null or v_login.status <> 'active' or v_login.owner_user_id <> v_request.requested_by_user_id
		or v_login.principal_id is distinct from v_authority.principal_id
		or public.qorpera_company_account_vault(v_authority.profile_id) is distinct from v_login.principal_id then
		raise exception 'Claude login read is unavailable' using errcode = '42501'; end if;
	return v_request;
end $$;
revoke all on function public.qorpera_claude_login_read_request(uuid, text, uuid, text, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_describe_claude_login_read(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_request_id uuid, p_capability_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_request public.qorpera_native_account_refresh_requests%rowtype;
	v_login public.qorpera_claude_logins%rowtype;
begin
	v_request := public.qorpera_model_login_account_refresh(
		p_broker_authority_id, p_broker_capability_sha256, p_request_id, p_capability_sha256);
	if v_request.claude_login_id is null then
		return jsonb_build_object('schema', 'qorpera.claude-login-read-description/v1', 'state', 'none'); end if;
	v_request := public.qorpera_claude_login_read_request(p_broker_authority_id, p_broker_capability_sha256,
		p_request_id, p_capability_sha256, false);
	select claude.* into strict v_login from public.qorpera_claude_logins as claude where claude.id = v_request.claude_login_id;
	if v_request.status <> 'pending' then
		return jsonb_build_object('schema', 'qorpera.claude-login-read-description/v1', 'state', 'completed'); end if;
	return jsonb_build_object('schema', 'qorpera.claude-login-read-description/v1', 'state', 'open',
		'claudeLoginId', v_login.id, 'ownerUserId', v_login.owner_user_id, 'keyId', v_login.key_id,
		'version', v_login.version, 'envelopeSha256', v_login.envelope_sha256,
		'encryptedEnvelopeBase64', encode(v_login.encrypted_envelope, 'base64'),
		'usage', v_request.claude_usage, 'resets', v_request.claude_resets,
		'reset', v_request.claude_reset_kind, 'resetState', v_request.claude_reset_state);
end $$;

create function public.qorpera_claim_claude_login_reset(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_request_id uuid, p_capability_sha256 text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_request public.qorpera_native_account_refresh_requests%rowtype;
begin
	v_request := public.qorpera_claude_login_read_request(p_broker_authority_id, p_broker_capability_sha256,
		p_request_id, p_capability_sha256, true);
	if v_request.status <> 'pending' or v_request.claude_reset_state is distinct from 'asked' then return false; end if;
	update public.qorpera_native_account_refresh_requests set claude_reset_state = 'using' where id = v_request.id;
	return true;
end $$;

create function public.qorpera_record_claude_login_read(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_request_id uuid, p_capability_sha256 text, p_usage jsonb, p_resets jsonb, p_reset jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_request public.qorpera_native_account_refresh_requests%rowtype;
	v_login public.qorpera_claude_logins%rowtype;
	v_outcome text;
	v_left jsonb;
begin
	v_request := public.qorpera_claude_login_read_request(p_broker_authority_id, p_broker_capability_sha256,
		p_request_id, p_capability_sha256, true);
	if v_request.status <> 'pending' then
		raise exception 'Claude login read has ended' using errcode = '55000'; end if;
	select claude.* into strict v_login from public.qorpera_claude_logins as claude
	where claude.id = v_request.claude_login_id for update;
	if p_usage is not null and (not v_request.claude_usage or not public.qorpera_claude_usage_valid(p_usage)
		or (p_usage ->> 'observedAt')::timestamptz > statement_timestamp() + interval '60 seconds') then
		raise exception 'Claude login usage is invalid' using errcode = '22023'; end if;
	if p_resets is not null and (not v_request.claude_resets or not public.qorpera_claude_resets_valid(p_resets)
		or (p_resets ->> 'observedAt')::timestamptz > statement_timestamp() + interval '60 seconds') then
		raise exception 'Claude login resets are invalid' using errcode = '22023'; end if;
	if p_reset is not null then
		v_outcome := p_reset ->> 'outcome';
		v_left := coalesce(p_reset -> 'left', 'null'::jsonb);
		if v_request.claude_reset_state is distinct from 'using' or jsonb_typeof(p_reset) <> 'object'
			or v_outcome is null or v_outcome not in ('reset', 'failed', 'unconfirmed')
			or not (v_left = 'null'::jsonb or (jsonb_typeof(v_left) = 'number' and v_left::text ~ '^\d{1,3}$'))
			or exists (select 1 from jsonb_object_keys(p_reset) as key where key not in ('outcome', 'left')) then
			raise exception 'Claude reset outcome is invalid' using errcode = '22023'; end if;
		update public.qorpera_native_account_refresh_requests set claude_reset_state = v_outcome where id = v_request.id;
	end if;
	update public.qorpera_claude_logins as claude set
		usage = case when p_usage is not null and (claude.usage is null
			or (claude.usage ->> 'observedAt')::timestamptz < (p_usage ->> 'observedAt')::timestamptz)
			then p_usage else claude.usage end,
		resets = case when p_reset is not null and v_outcome = 'reset' then null
			when p_resets is not null then p_resets else claude.resets end,
		last_reset = case when p_reset is not null then jsonb_build_object('requestId', v_request.id,
			'kind', v_request.claude_reset_kind, 'outcome', v_outcome, 'left', v_left,
			'at', to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
			else claude.last_reset end
	where claude.id = v_login.id;
	return jsonb_build_object('schema', 'qorpera.claude-login-read-recorded/v1', 'requestId', v_request.id);
end $$;
revoke all on function
	public.qorpera_describe_claude_login_read(uuid, text, uuid, text),
	public.qorpera_claim_claude_login_reset(uuid, text, uuid, text),
	public.qorpera_record_claude_login_read(uuid, text, uuid, text, jsonb, jsonb, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function
	public.qorpera_describe_claude_login_read(uuid, text, uuid, text),
	public.qorpera_claim_claude_login_reset(uuid, text, uuid, text),
	public.qorpera_record_claude_login_read(uuid, text, uuid, text, jsonb, jsonb, jsonb)
	to qorpera_secret_broker;

create function public.qorpera_record_claude_run_usage(p_binding jsonb, p_usage jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_recorded boolean;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Claude run usage is the runtime''s' using errcode = '42501'; end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_worker := public.qorpera_run_worker(v_run.id);
	if v_worker.id is null or v_worker.harness is distinct from 'claude-code' or v_worker.claude_login_id is null then
		raise exception 'The run is no Claude Code worker''s' using errcode = '42501'; end if;
	if not public.qorpera_claude_usage_valid(p_usage)
		or (p_usage ->> 'observedAt')::timestamptz > statement_timestamp() + interval '60 seconds'
		or exists (select 1 from jsonb_array_elements(p_usage -> 'windows') as item(window_row)
			where item.window_row ->> 'id' = 'seven_day_model') then
		raise exception 'Claude run usage is invalid' using errcode = '22023'; end if;
	update public.qorpera_claude_logins as claude set usage = jsonb_set(p_usage, '{windows}',
		(p_usage -> 'windows') || coalesce((select jsonb_agg(item.window_row)
			from jsonb_array_elements(claude.usage -> 'windows') as item(window_row)
			where item.window_row ->> 'id' = 'seven_day_model'), '[]'::jsonb))
	where claude.id = v_worker.claude_login_id and claude.status = 'active'
		and claude.owner_user_id = v_worker.requested_by_user_id
		and (claude.usage is null or (claude.usage ->> 'observedAt')::timestamptz < (p_usage ->> 'observedAt')::timestamptz);
	v_recorded := found;
	return jsonb_build_object('schema', 'qorpera.claude-run-usage/v1', 'recorded', v_recorded);
end $$;
revoke all on function public.qorpera_record_claude_run_usage(jsonb, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_record_claude_run_usage(jsonb, jsonb) to service_role;
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_record_claude_run_usage', 'binding');

do $$
declare
	v_target regprocedure := 'public.qorpera_runtime_account_refresh_gateway_choose(text)'::regprocedure;
	v_definition text := pg_get_functiondef(v_target);
	v_anchor text := 'public.qorpera_model_login_usage_in_vault(v_session.compute_identity_id)';
	v_count integer;
begin
	v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
	if v_count <> 1 then raise exception 'Account refresh chooser source differs (% matches)', v_count; end if;
	execute replace(v_definition, v_anchor,
		'(' || v_anchor || ' or v_session.claude_login_id is not null)');
end $$;
