do $$ begin
	if to_regclass('public.qorpera_member_default_models') is not null then
		raise exception '20260930858000 is already applied'; end if;
	if to_regclass('public.qorpera_gemini_keys') is null
		or to_regprocedure('public.qorpera_claude_worker_resolve(uuid,uuid,uuid)') is null
		or to_regprocedure('public.qorpera_claude_usage_valid(jsonb)') is null
		or to_regprocedure('public.qorpera_record_model_login_account_metadata(uuid,text,uuid,text,uuid,uuid,bigint,text,jsonb,text)') is null
		or to_regprocedure('public.qorpera_record_native_provider_account_metadata(uuid,bigint,uuid,bigint,uuid,text,jsonb,text)') is null
		or to_regprocedure('public.qorpera_resolve_run_gemini_choice(public.qorpera_execution_runs,jsonb)') is null
		or to_regprocedure('public.qorpera_resolve_run_claude_choice(public.qorpera_execution_runs,jsonb)') is null then
		raise exception '20260930858000 needs Gemini 4 Neon (20260930823000), Claude login usage (20260930793000), and Claude-first workers (20260930787000)';
	end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.md_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930858000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

create function public.qorpera_usage_credits_valid(p_credits jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select jsonb_typeof(p_credits) = 'object'
		and octet_length(p_credits::text) <= 512
		and (select coalesce(bool_and(key in ('hasCredits', 'unlimited', 'balance', 'used', 'limit', 'currency')), false)
			from jsonb_object_keys(p_credits) as key)
		and (p_credits ? 'unlimited' or p_credits ? 'balance' or p_credits ? 'used' or p_credits ? 'limit')
		and (not p_credits ? 'hasCredits' or jsonb_typeof(p_credits -> 'hasCredits') = 'boolean')
		and (not p_credits ? 'unlimited' or jsonb_typeof(p_credits -> 'unlimited') = 'boolean')
		and (not p_credits ? 'balance' or (jsonb_typeof(p_credits -> 'balance') = 'number'
			and (p_credits ->> 'balance')::numeric between 0 and 1000000000))
		and (not p_credits ? 'used' or (jsonb_typeof(p_credits -> 'used') = 'number'
			and (p_credits ->> 'used')::numeric between 0 and 1000000000))
		and (not p_credits ? 'limit' or (jsonb_typeof(p_credits -> 'limit') = 'number'
			and (p_credits ->> 'limit')::numeric between 0 and 1000000000))
		and (not p_credits ? 'currency' or (jsonb_typeof(p_credits -> 'currency') = 'string'
			and p_credits ->> 'currency' ~ '^[A-Z]{3}$'))
$$;
revoke all on function public.qorpera_usage_credits_valid(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_claude_usage_valid(p_usage jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select jsonb_typeof(p_usage) = 'object'
		and octet_length(p_usage::text) <= 4096
		and (select coalesce(bool_and(key in ('observedAt', 'windows', 'limitResetAt', 'limitType', 'credits')), false)
			from jsonb_object_keys(p_usage) as key)
		and jsonb_typeof(p_usage -> 'observedAt') = 'string'
		and p_usage ->> 'observedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
		and (not p_usage ? 'limitResetAt' or (jsonb_typeof(p_usage -> 'limitResetAt') = 'string'
			and p_usage ->> 'limitResetAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'))
		and (not p_usage ? 'limitType' or (p_usage ? 'limitResetAt' and jsonb_typeof(p_usage -> 'limitType') = 'string'
			and p_usage ->> 'limitType' ~ '^[a-z0-9_]{1,40}$'))
		and (not p_usage ? 'credits' or public.qorpera_usage_credits_valid(p_usage -> 'credits'))
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

select pg_temp.md_replace(
	'public.qorpera_record_model_login_account_metadata(uuid,text,uuid,text,uuid,uuid,bigint,text,jsonb,text)'::regprocedure,
	$old$		if jsonb_typeof(p_provider_account_usage) <> 'object' or pg_column_size(p_provider_account_usage) > 4096
			or p_provider_account_usage - array['observedAt','windows'] <> '{}'::jsonb
			or jsonb_typeof(p_provider_account_usage -> 'observedAt') is distinct from 'string'
			or jsonb_typeof(p_provider_account_usage -> 'windows') is distinct from 'array' then$old$,
	$new$		if jsonb_typeof(p_provider_account_usage) <> 'object' or pg_column_size(p_provider_account_usage) > 4096
			or p_provider_account_usage - array['observedAt','windows','credits'] <> '{}'::jsonb
			or (p_provider_account_usage ? 'credits' and not public.qorpera_usage_credits_valid(p_provider_account_usage -> 'credits'))
			or jsonb_typeof(p_provider_account_usage -> 'observedAt') is distinct from 'string'
			or jsonb_typeof(p_provider_account_usage -> 'windows') is distinct from 'array' then$new$);

select pg_temp.md_replace(
	'public.qorpera_record_native_provider_account_metadata(uuid,bigint,uuid,bigint,uuid,text,jsonb,text)'::regprocedure,
	$old$        if jsonb_typeof(p_provider_account_usage) <> 'object' or pg_column_size(p_provider_account_usage) > 4096
          or p_provider_account_usage - array['observedAt','windows'] <> '{}'::jsonb
          or jsonb_typeof(p_provider_account_usage -> 'observedAt') is distinct from 'string'
          or jsonb_typeof(p_provider_account_usage -> 'windows') is distinct from 'array' then$old$,
	$new$        if jsonb_typeof(p_provider_account_usage) <> 'object' or pg_column_size(p_provider_account_usage) > 4096
          or p_provider_account_usage - array['observedAt','windows','credits'] <> '{}'::jsonb
          or (p_provider_account_usage ? 'credits' and not public.qorpera_usage_credits_valid(p_provider_account_usage -> 'credits'))
          or jsonb_typeof(p_provider_account_usage -> 'observedAt') is distinct from 'string'
          or jsonb_typeof(p_provider_account_usage -> 'windows') is distinct from 'array' then$new$);

alter table public.qorpera_gemini_keys
	add column last_error_code text check (last_error_code is null or last_error_code in (
		'key_rejected', 'billing_required', 'quota_exhausted', 'model_unavailable',
		'invalid_request', 'provider_outage', 'transport_unavailable'
	)),
	add column last_error_at timestamptz,
	add column last_checked_at timestamptz,
	add constraint qorpera_gemini_keys_last_error_pair check ((last_error_code is null) = (last_error_at is null));

alter table public.qorpera_gemini_key_tickets
	add column purpose text not null default 'save' check (purpose in ('save', 'check'));

create table public.qorpera_member_default_models (
	user_id uuid primary key references auth.users(id) on delete cascade,
	conversation_model text check (conversation_model is null or conversation_model in (
		'gpt-6.2-sol', 'gpt-6-astra', 'claude-fable-5-2', 'claude-opus-5-5', 'gemini-4-neon'
	)),
	conversation_effort text check (conversation_effort is null or conversation_effort in (
		'low', 'medium', 'high', 'xhigh', 'max'
	)),
	coding_model text check (coding_model is null or coding_model in (
		'gpt-6.2-sol', 'gpt-6-astra', 'claude-fable-5-2', 'claude-opus-5-5'
	)),
	coding_effort text check (coding_effort is null or coding_effort in (
		'low', 'medium', 'high', 'xhigh', 'max'
	)),
	version bigint not null default 1 check (version >= 1),
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	constraint qorpera_member_default_models_conv_effort check (
		conversation_effort is null
		or conversation_effort in ('low', 'medium', 'high', 'xhigh')
		or conversation_model in ('claude-fable-5-2', 'claude-opus-5-5')
	),
	constraint qorpera_member_default_models_coding_effort check (
		coding_effort is null
		or coding_effort in ('low', 'medium', 'high', 'xhigh')
		or coding_model in ('claude-fable-5-2', 'claude-opus-5-5')
	)
);
alter table public.qorpera_member_default_models enable row level security;
revoke all on public.qorpera_member_default_models from public, anon, authenticated, service_role, qorpera_secret_broker;

insert into public.qorpera_member_default_models (user_id, conversation_model)
select distinct key.owner_user_id, 'gemini-4-neon'
from public.qorpera_gemini_keys as key
where key.status = 'active' and key.default_for_chats = true
on conflict (user_id) do nothing;

alter table public.qorpera_execution_runs drop constraint qorpera_execution_runs_model_selection_check;
alter table public.qorpera_execution_runs
	add constraint qorpera_execution_runs_model_selection_check
		check (model_selection in ('provider_mapping', 'provider_default', 'session_override', 'member_default'));

create or replace function public.qorpera_get_gemini_key(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_principal uuid;
	v_key public.qorpera_gemini_keys%rowtype;
	v_month text := public.qorpera_gemini_current_month();
	v_same_month boolean;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null
		or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = v_user) then
		raise exception 'Gemini key settings are unavailable' using errcode = '42501'; end if;
	v_principal := public.qorpera_company_account_vault(p_profile_id);
	if v_principal is not null then
		select key.* into v_key from public.qorpera_gemini_keys as key
		where key.owner_user_id = v_user and key.status = 'active' and key.principal_id = v_principal;
	end if;
	if v_key.id is null then
		return jsonb_build_object(
			'schema', 'qorpera.gemini-key/v1',
			'vaultAvailable', v_principal is not null,
			'key', null
		);
	end if;
	v_same_month := v_key.spend_month = v_month;
	return jsonb_build_object(
		'schema', 'qorpera.gemini-key/v1',
		'vaultAvailable', true,
		'key', jsonb_build_object(
			'id', v_key.id,
			'keyHint', v_key.key_hint,
			'defaultForChats', v_key.default_for_chats,
			'monthlyCapCents', v_key.monthly_cap_cents,
			'spendMonth', v_month,
			'monthSpendMicrodollars', case when v_same_month then v_key.month_spend_microdollars else 0::bigint end,
			'monthInputTokens', case when v_same_month then v_key.month_input_tokens else 0::bigint end,
			'monthCachedTokens', case when v_same_month then v_key.month_cached_tokens else 0::bigint end,
			'monthOutputTokens', case when v_same_month then v_key.month_output_tokens else 0::bigint end,
			'capReached', public.qorpera_gemini_key_cap_reached(v_key),
			'lastErrorCode', v_key.last_error_code,
			'lastErrorAt', v_key.last_error_at,
			'lastCheckedAt', v_key.last_checked_at,
			'version', v_key.version,
			'createdAt', v_key.created_at,
			'updatedAt', v_key.updated_at
		)
	);
end $$;

create function public.qorpera_begin_gemini_key_check(p_profile_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_key public.qorpera_gemini_keys%rowtype;
	v_ticket public.qorpera_gemini_key_tickets%rowtype;
	v_capability text := encode(extensions.gen_random_bytes(32), 'hex');
begin
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null
		or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = v_user
				and member.role in ('owner', 'admin', 'contributor')) then
		raise exception 'Gemini key check requires member authority' using errcode = '42501'; end if;
	select authority.* into v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority
	join public.qorpera_cloud_secret_broker_principals as principal on principal.id = authority.principal_id
	where authority.profile_id = p_profile_id and authority.status = 'active' and principal.status = 'active'
	order by authority.created_at desc, authority.id
	limit 1;
	if v_authority.id is null or v_authority.principal_id is null then
		raise exception 'The shared vault is unavailable for this company' using errcode = '55000'; end if;
	select key.* into v_key from public.qorpera_gemini_keys as key
	where key.owner_user_id = v_user and key.status = 'active' and key.principal_id = v_authority.principal_id;
	if v_key.id is null then
		raise exception 'No active Gemini API key is configured' using errcode = '55000'; end if;
	update public.qorpera_gemini_key_tickets
	set status = 'expired'
	where owner_user_id = v_user and status = 'pending' and expires_at <= clock_timestamp();
	insert into public.qorpera_gemini_key_tickets (
		profile_id, owner_user_id, broker_authority_id, principal_id, key_id,
		gemini_key_id, purpose, default_for_chats, monthly_cap_cents, capability_sha256, expires_at
	) values (
		p_profile_id, v_user, v_authority.id, v_authority.principal_id, v_key.key_id,
		v_key.id, 'check', v_key.default_for_chats, v_key.monthly_cap_cents,
		encode(extensions.digest(v_capability, 'sha256'), 'hex'),
		clock_timestamp() + interval '5 minutes'
	) returning * into v_ticket;
	return jsonb_build_object(
		'schema', 'qorpera.gemini-key-ticket/v1',
		'ticketId', v_ticket.id,
		'capability', v_capability,
		'serviceOrigin', v_authority.service_origin,
		'profileId', p_profile_id,
		'expiresAt', v_ticket.expires_at
	);
end $$;
revoke all on function public.qorpera_begin_gemini_key_check(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_begin_gemini_key_check(uuid) to authenticated;

select pg_temp.md_replace(
	'public.qorpera_describe_gemini_key_ticket(uuid,text,uuid,text)'::regprocedure,
	$old$		or v_ticket.status <> 'pending' or v_ticket.expires_at <= clock_timestamp()$old$,
	$new$		or v_ticket.purpose is distinct from 'save'
		or v_ticket.status <> 'pending' or v_ticket.expires_at <= clock_timestamp()$new$);

select pg_temp.md_replace(
	'public.qorpera_complete_gemini_key_save(uuid,text,uuid,text,text,text,text,text)'::regprocedure,
	$old$		or v_ticket.status <> 'pending' or v_ticket.expires_at <= clock_timestamp()$old$,
	$new$		or v_ticket.purpose is distinct from 'save'
		or v_ticket.status <> 'pending' or v_ticket.expires_at <= clock_timestamp()$new$);

select pg_temp.md_replace(
	'public.qorpera_complete_gemini_key_save(uuid,text,uuid,text,text,text,text,text)'::regprocedure,
	$old$	insert into public.qorpera_gemini_keys (
		id, owner_user_id, principal_id, key_id, encrypted_envelope, envelope_sha256,
		key_hint, default_for_chats, monthly_cap_cents,
		spend_month, month_spend_microdollars, month_input_tokens, month_cached_tokens, month_output_tokens
	) values (
		v_ticket.gemini_key_id, v_ticket.owner_user_id, v_ticket.principal_id, p_key_id, v_envelope, p_envelope_sha256,
		btrim(p_key_hint), v_ticket.default_for_chats, v_ticket.monthly_cap_cents,
		v_month,
		case when v_carry then v_previous.month_spend_microdollars else 0::bigint end,
		case when v_carry then v_previous.month_input_tokens else 0::bigint end,
		case when v_carry then v_previous.month_cached_tokens else 0::bigint end,
		case when v_carry then v_previous.month_output_tokens else 0::bigint end
	) returning * into v_saved;$old$,
	$new$	insert into public.qorpera_gemini_keys (
		id, owner_user_id, principal_id, key_id, encrypted_envelope, envelope_sha256,
		key_hint, default_for_chats, monthly_cap_cents,
		spend_month, month_spend_microdollars, month_input_tokens, month_cached_tokens, month_output_tokens,
		last_checked_at
	) values (
		v_ticket.gemini_key_id, v_ticket.owner_user_id, v_ticket.principal_id, p_key_id, v_envelope, p_envelope_sha256,
		btrim(p_key_hint), v_ticket.default_for_chats, v_ticket.monthly_cap_cents,
		v_month,
		case when v_carry then v_previous.month_spend_microdollars else 0::bigint end,
		case when v_carry then v_previous.month_input_tokens else 0::bigint end,
		case when v_carry then v_previous.month_cached_tokens else 0::bigint end,
		case when v_carry then v_previous.month_output_tokens else 0::bigint end,
		clock_timestamp()
	) returning * into v_saved;
	if v_saved.default_for_chats then
		insert into public.qorpera_member_default_models (user_id, conversation_model)
		values (v_ticket.owner_user_id, 'gemini-4-neon')
		on conflict (user_id) do update set
			conversation_model = 'gemini-4-neon',
			conversation_effort = case when public.qorpera_member_default_models.conversation_effort = 'max'
				then 'xhigh' else public.qorpera_member_default_models.conversation_effort end,
			version = public.qorpera_member_default_models.version + 1,
			updated_at = clock_timestamp();
	end if;$new$);

create function public.qorpera_describe_gemini_key_check(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_ticket_id uuid,
	p_capability_sha256 text
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_ticket public.qorpera_gemini_key_tickets%rowtype;
	v_key public.qorpera_gemini_keys%rowtype;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_ticket_id is null or coalesce(p_capability_sha256, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'Gemini key check request is invalid' using errcode = '22023'; end if;
	select ticket.* into v_ticket from public.qorpera_gemini_key_tickets as ticket where ticket.id = p_ticket_id;
	if v_ticket.id is null or v_ticket.purpose is distinct from 'check'
		or v_ticket.broker_authority_id <> v_authority.id
		or v_ticket.principal_id is distinct from v_authority.principal_id
		or v_ticket.capability_sha256 <> p_capability_sha256
		or v_ticket.status <> 'pending' or v_ticket.expires_at <= clock_timestamp()
		or public.qorpera_company_account_vault(v_authority.profile_id) is distinct from v_authority.principal_id then
		raise exception 'Gemini key check ticket is unavailable' using errcode = '42501'; end if;
	select key.* into v_key from public.qorpera_gemini_keys as key
	where key.id = v_ticket.gemini_key_id and key.owner_user_id = v_ticket.owner_user_id
		and key.principal_id = v_authority.principal_id and key.status = 'active';
	if v_key.id is null then
		raise exception 'Gemini key is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object(
		'schema', 'qorpera.gemini-key-check-description/v1',
		'ticketId', v_ticket.id,
		'profileId', v_ticket.profile_id,
		'ownerUserId', v_key.owner_user_id,
		'geminiKeyId', v_key.id,
		'keyId', v_key.key_id,
		'version', v_key.version,
		'envelopeSha256', v_key.envelope_sha256,
		'encryptedEnvelopeBase64', encode(v_key.encrypted_envelope, 'base64')
	);
end $$;

create function public.qorpera_complete_gemini_key_check(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_ticket_id uuid,
	p_capability_sha256 text,
	p_status text,
	p_error_code text default null
)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_ticket public.qorpera_gemini_key_tickets%rowtype;
	v_checked_at timestamptz := clock_timestamp();
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_ticket_id is null or coalesce(p_capability_sha256, '') !~ '^[0-9a-f]{64}$'
		or coalesce(p_status, '') not in ('ok', 'error')
		or (p_status = 'ok' and p_error_code is not null)
		or (p_status = 'error' and coalesce(p_error_code, '') not in (
			'key_rejected', 'billing_required', 'quota_exhausted', 'model_unavailable',
			'invalid_request', 'provider_outage', 'transport_unavailable'
		)) then
		raise exception 'Gemini key check completion is invalid' using errcode = '22023'; end if;
	select ticket.* into v_ticket from public.qorpera_gemini_key_tickets as ticket
	where ticket.id = p_ticket_id for update;
	if v_ticket.id is null or v_ticket.purpose is distinct from 'check'
		or v_ticket.broker_authority_id <> v_authority.id
		or v_ticket.principal_id is distinct from v_authority.principal_id
		or v_ticket.capability_sha256 <> p_capability_sha256
		or v_ticket.status <> 'pending' or v_ticket.expires_at <= clock_timestamp()
		or public.qorpera_company_account_vault(v_authority.profile_id) is distinct from v_authority.principal_id then
		raise exception 'Gemini key check ticket is unavailable' using errcode = '42501'; end if;
	update public.qorpera_gemini_keys
	set last_checked_at = v_checked_at,
		last_error_code = case when p_status = 'ok' then null else p_error_code end,
		last_error_at = case when p_status = 'ok' then null else v_checked_at end,
		updated_at = v_checked_at
	where id = v_ticket.gemini_key_id and owner_user_id = v_ticket.owner_user_id
		and principal_id = v_authority.principal_id and status = 'active';
	update public.qorpera_gemini_key_tickets
	set status = 'completed', completed_at = v_checked_at
	where id = v_ticket.id;
	return jsonb_build_object(
		'schema', 'qorpera.gemini-key-checked/v1',
		'ok', p_status = 'ok',
		'errorCode', p_error_code,
		'checkedAt', v_checked_at
	);
end $$;

revoke all on function
	public.qorpera_describe_gemini_key_check(uuid, text, uuid, text),
	public.qorpera_complete_gemini_key_check(uuid, text, uuid, text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function
	public.qorpera_describe_gemini_key_check(uuid, text, uuid, text),
	public.qorpera_complete_gemini_key_check(uuid, text, uuid, text, text, text)
	to qorpera_secret_broker;

create function public.qorpera_record_gemini_key_error(p_binding jsonb, p_error_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Gemini key errors are the runtime''s' using errcode = '42501'; end if;
	if coalesce(p_error_code, '') not in (
		'key_rejected', 'billing_required', 'quota_exhausted', 'model_unavailable',
		'invalid_request', 'provider_outage', 'transport_unavailable'
	) then
		raise exception 'Gemini key error code is invalid' using errcode = '22023'; end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if v_run.gemini_model is null or v_run.gemini_key_id is null then
		raise exception 'The run is not a Gemini run' using errcode = '42501'; end if;
	update public.qorpera_gemini_keys
	set last_error_code = p_error_code,
		last_error_at = v_now,
		updated_at = v_now
	where id = v_run.gemini_key_id and status = 'active';
	return jsonb_build_object('schema', 'qorpera.gemini-key-error-recorded/v1', 'recorded', found);
end $$;
revoke all on function public.qorpera_record_gemini_key_error(jsonb, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_record_gemini_key_error(jsonb, text) to service_role;
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_record_gemini_key_error', 'binding');

select pg_temp.md_replace(
	'public.qorpera_record_gemini_run_usage(jsonb,jsonb)'::regprocedure,
	$old$	update public.qorpera_gemini_keys
	set spend_month = v_month,
		month_spend_microdollars = v_key.month_spend_microdollars + v_delta_spend,
		month_input_tokens = v_key.month_input_tokens + v_delta_input,
		month_cached_tokens = v_key.month_cached_tokens + v_delta_cached,
		month_output_tokens = v_key.month_output_tokens + v_delta_output,
		updated_at = clock_timestamp()
	where id = v_key.id$old$,
	$new$	update public.qorpera_gemini_keys
	set spend_month = v_month,
		month_spend_microdollars = v_key.month_spend_microdollars + v_delta_spend,
		month_input_tokens = v_key.month_input_tokens + v_delta_input,
		month_cached_tokens = v_key.month_cached_tokens + v_delta_cached,
		month_output_tokens = v_key.month_output_tokens + v_delta_output,
		last_error_code = null,
		last_error_at = null,
		last_checked_at = clock_timestamp(),
		updated_at = clock_timestamp()
	where id = v_key.id$new$);

select pg_temp.md_replace(
	'public.qorpera_update_gemini_key_settings(uuid,boolean,bigint,bigint)'::regprocedure,
	$old$	if not public.qorpera_gemini_key_cap_reached(v_key) then$old$,
	$new$	if p_default_for_chats then
		insert into public.qorpera_member_default_models (user_id, conversation_model)
		values (v_user, 'gemini-4-neon')
		on conflict (user_id) do update set
			conversation_model = 'gemini-4-neon',
			conversation_effort = case when public.qorpera_member_default_models.conversation_effort = 'max'
				then 'xhigh' else public.qorpera_member_default_models.conversation_effort end,
			version = public.qorpera_member_default_models.version + 1,
			updated_at = clock_timestamp();
	else
		update public.qorpera_member_default_models
		set conversation_model = null,
			version = version + 1,
			updated_at = clock_timestamp()
		where user_id = v_user and conversation_model = 'gemini-4-neon';
	end if;
	if not public.qorpera_gemini_key_cap_reached(v_key) then$new$);

select pg_temp.md_replace(
	'public.qorpera_revoke_gemini_key(uuid)'::regprocedure,
	$old$	update public.qorpera_member_notifications$old$,
	$new$	update public.qorpera_member_default_models
	set conversation_model = null,
		version = version + 1,
		updated_at = clock_timestamp()
	where user_id = v_user and conversation_model = 'gemini-4-neon';
	update public.qorpera_member_notifications$new$);

create function public.qorpera_member_claude_default_available(p_profile_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select case
		when p_user_id is null then false
		when p_profile_id is not null then public.qorpera_active_bundle_claude_choice()
			and public.qorpera_member_may_pick_claude(p_profile_id, p_user_id)
		else public.qorpera_active_bundle_claude_choice()
			and exists (select 1 from public.qorpera_claude_logins as login
				where login.owner_user_id = p_user_id and login.status = 'active')
	end
$$;

create function public.qorpera_member_gemini_default_available(p_profile_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select case
		when p_user_id is null then false
		when p_profile_id is not null then public.qorpera_active_bundle_gemini_choice()
			and public.qorpera_member_may_pick_gemini(p_profile_id, p_user_id)
		else public.qorpera_active_bundle_gemini_choice()
			and exists (select 1 from public.qorpera_gemini_keys as key
				where key.owner_user_id = p_user_id and key.status = 'active')
	end
$$;

revoke all on function
	public.qorpera_member_claude_default_available(uuid, uuid),
	public.qorpera_member_gemini_default_available(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_get_member_default_models(p_profile_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_row public.qorpera_member_default_models%rowtype;
	v_policy jsonb;
	v_claude boolean;
	v_gemini boolean;
	v_gemini_legacy_default boolean := false;
	v_conv_model text;
	v_conv_effort text;
	v_coding_model text;
	v_coding_effort text;
	v_conv_models jsonb;
	v_coding_models jsonb;
	v_all_models jsonb;
	v_efforts jsonb;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Default model settings are unavailable' using errcode = '42501'; end if;
	if p_profile_id is not null and not exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and member.user_id = v_user) then
		raise exception 'Default model settings are unavailable' using errcode = '42501'; end if;
	select * into v_row from public.qorpera_member_default_models where user_id = v_user;
	select bundle.manifest -> 'modelPolicy' into v_policy
	from public.qorpera_active_runtime_bundle active
	join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
	where active.singleton;
	v_claude := public.qorpera_member_claude_default_available(p_profile_id, v_user);
	v_gemini := public.qorpera_member_gemini_default_available(p_profile_id, v_user);
	if v_row.user_id is null and v_gemini then
		select exists (select 1 from public.qorpera_gemini_keys as key
			where key.owner_user_id = v_user and key.status = 'active' and key.default_for_chats)
		into v_gemini_legacy_default;
	end if;
	v_conv_model := case
		when v_row.conversation_model = 'gemini-4-neon' and v_gemini then 'gemini-4-neon'
		when v_row.conversation_model in ('claude-fable-5-2', 'claude-opus-5-5') and v_claude then v_row.conversation_model
		when v_row.conversation_model in ('gpt-6.2-sol', 'gpt-6-astra') then v_row.conversation_model
		when v_row.conversation_model is null and v_gemini_legacy_default then 'gemini-4-neon'
		else 'gpt-6.2-sol'
	end;
	v_conv_effort := coalesce(v_row.conversation_effort, v_policy ->> 'effort', 'low');
	if v_conv_effort = 'max' and v_conv_model not in ('claude-fable-5-2', 'claude-opus-5-5') then
		v_conv_effort := 'xhigh';
	end if;
	v_coding_model := case
		when v_row.coding_model in ('claude-fable-5-2', 'claude-opus-5-5') and v_claude then v_row.coding_model
		when v_row.coding_model in ('gpt-6.2-sol', 'gpt-6-astra') then v_row.coding_model
		when v_claude then 'claude-opus-5-5'
		else 'gpt-6.2-sol'
	end;
	v_coding_effort := coalesce(v_row.coding_effort, v_policy ->> 'unattended', 'high');
	if v_coding_effort = 'max' and v_coding_model not in ('claude-fable-5-2', 'claude-opus-5-5') then
		v_coding_effort := 'xhigh';
	end if;
	v_conv_models := '["gpt-6.2-sol","gpt-6-astra"]'::jsonb
		|| case when v_claude then '["claude-opus-5-5","claude-fable-5-2"]'::jsonb else '[]'::jsonb end
		|| case when v_gemini then '["gemini-4-neon"]'::jsonb else '[]'::jsonb end;
	v_coding_models := case when v_claude then '["claude-opus-5-5","claude-fable-5-2"]'::jsonb else '[]'::jsonb end
		|| '["gpt-6.2-sol","gpt-6-astra"]'::jsonb;
	v_all_models := '["gpt-6.2-sol","gpt-6-astra","claude-opus-5-5","claude-fable-5-2","gemini-4-neon"]'::jsonb;
	select jsonb_object_agg(model.id,
		case
			when model.id in ('claude-fable-5-2', 'claude-opus-5-5') then '["low","medium","high","xhigh","max"]'::jsonb
			when model.id = 'gemini-4-neon' then '["low","medium","high","xhigh"]'::jsonb
			else '["low","medium","high"]'::jsonb || public.qorpera_model_policy_thread_efforts(v_policy)
		end)
	into v_efforts
	from jsonb_array_elements_text(v_all_models) as model(id);
	return jsonb_build_object(
		'schema', 'qorpera.member-default-models/v1',
		'conversationModel', v_conv_model,
		'conversationEffort', v_conv_effort,
		'codingModel', v_coding_model,
		'codingEffort', v_coding_effort,
		'conversationModels', v_conv_models,
		'codingModels', v_coding_models,
		'efforts', v_efforts,
		'version', coalesce(v_row.version, 0)
	);
end $$;

create function public.qorpera_set_member_default_models(
	p_profile_id uuid,
	p_conversation_model text,
	p_conversation_effort text,
	p_coding_model text,
	p_coding_effort text,
	p_expected_version bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_row public.qorpera_member_default_models%rowtype;
	v_conv_model text;
	v_conv_effort text;
	v_coding_model text;
	v_coding_effort text;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Default model settings require member authority' using errcode = '42501'; end if;
	if p_profile_id is not null and not exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and member.user_id = v_user
			and member.role in ('owner', 'admin', 'contributor')) then
		raise exception 'Default model settings require member authority' using errcode = '42501'; end if;
	if (p_conversation_model is not null and p_conversation_model not in (
			'gpt-6.2-sol', 'gpt-6-astra', 'claude-fable-5-2', 'claude-opus-5-5', 'gemini-4-neon'))
		or (p_conversation_effort is not null and p_conversation_effort not in ('low', 'medium', 'high', 'xhigh', 'max'))
		or (p_coding_model is not null and p_coding_model not in (
			'gpt-6.2-sol', 'gpt-6-astra', 'claude-fable-5-2', 'claude-opus-5-5'))
		or (p_coding_effort is not null and p_coding_effort not in ('low', 'medium', 'high', 'xhigh', 'max'))
		or p_expected_version is null or p_expected_version < 0 then
		raise exception 'Default model settings are invalid' using errcode = '22023'; end if;
	select * into v_row from public.qorpera_member_default_models where user_id = v_user for update;
	if coalesce(v_row.version, 0) <> p_expected_version then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01',
			'message', 'Default model settings changed; refresh before retrying', 'details', null, 'hint', null)::text,
			detail = '{"status":409,"headers":{}}'; end if;
	v_conv_model := coalesce(p_conversation_model, v_row.conversation_model);
	v_conv_effort := coalesce(p_conversation_effort, v_row.conversation_effort);
	v_coding_model := coalesce(p_coding_model, v_row.coding_model);
	v_coding_effort := coalesce(p_coding_effort, v_row.coding_effort);
	if (v_conv_model in ('claude-fable-5-2', 'claude-opus-5-5') or v_coding_model in ('claude-fable-5-2', 'claude-opus-5-5'))
		and not public.qorpera_member_claude_default_available(p_profile_id, v_user) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC02',
			'message', 'Sign in to Claude in Settings before choosing a Claude default model',
			'details', null, 'hint', null)::text,
			detail = '{"status":403,"headers":{}}'; end if;
	if v_conv_model = 'gemini-4-neon'
		and not public.qorpera_member_gemini_default_available(p_profile_id, v_user) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC02',
			'message', 'Add a Gemini API key in Settings before choosing Gemini 4 Neon as your default',
			'details', null, 'hint', null)::text,
			detail = '{"status":403,"headers":{}}'; end if;
	if v_conv_effort = 'max' and coalesce(v_conv_model not in ('claude-fable-5-2', 'claude-opus-5-5'), true) then
		raise exception 'Conversational effort max needs a Claude model' using errcode = '22023'; end if;
	if v_coding_effort = 'max' and coalesce(v_coding_model not in ('claude-fable-5-2', 'claude-opus-5-5'), true) then
		raise exception 'Coding effort max needs a Claude model' using errcode = '22023'; end if;
	insert into public.qorpera_member_default_models (
		user_id, conversation_model, conversation_effort, coding_model, coding_effort, version, updated_at
	) values (
		v_user, v_conv_model, v_conv_effort, v_coding_model, v_coding_effort, p_expected_version + 1, clock_timestamp()
	)
	on conflict (user_id) do update set
		conversation_model = excluded.conversation_model,
		conversation_effort = excluded.conversation_effort,
		coding_model = excluded.coding_model,
		coding_effort = excluded.coding_effort,
		version = excluded.version,
		updated_at = clock_timestamp();
	update public.qorpera_gemini_keys
	set default_for_chats = (v_conv_model = 'gemini-4-neon'),
		updated_at = clock_timestamp()
	where owner_user_id = v_user and status = 'active'
		and default_for_chats is distinct from (v_conv_model = 'gemini-4-neon');
	return public.qorpera_get_member_default_models(p_profile_id);
end $$;

revoke all on function
	public.qorpera_get_member_default_models(uuid),
	public.qorpera_set_member_default_models(uuid, text, text, text, text, bigint)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function
	public.qorpera_get_member_default_models(uuid),
	public.qorpera_set_member_default_models(uuid, text, text, text, text, bigint)
	to authenticated;

create or replace function public.qorpera_resolve_run_gemini_choice(p_run public.qorpera_execution_runs, p_manifest jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_choice public.qorpera_session_models%rowtype;
	v_defaults public.qorpera_member_default_models%rowtype;
	v_key public.qorpera_gemini_keys%rowtype;
	v_user uuid := coalesce(p_run.requested_by_user_id, p_run.created_by_user_id);
	v_effort text;
begin
	if p_manifest #>> '{modelPolicy,geminiChoice}' is distinct from 'thread' then return null; end if;
	if p_run.source_kind not in ('session_turn', 'room_delivery') or p_run.session_id is null then return null; end if;
	select * into v_choice from public.qorpera_session_models as choice where choice.session_id = p_run.session_id;
	v_key := public.qorpera_member_gemini_key_open(p_run.profile_id, v_user);
	if v_key.id is null then return null; end if;
	select * into v_defaults from public.qorpera_member_default_models where user_id = v_user;
	if v_choice.model_id = 'gemini-4-neon'
		or (v_choice.model_id is null and (
			v_defaults.conversation_model = 'gemini-4-neon'
			or (v_defaults.conversation_model is null and v_key.default_for_chats)
		)) then
		v_effort := coalesce(v_choice.reasoning_effort, v_defaults.conversation_effort, p_manifest #>> '{modelPolicy,effort}', 'low');
		if v_effort not in ('low', 'medium', 'high', 'xhigh') then v_effort := 'xhigh'; end if;
		return jsonb_build_object('model', 'gemini-4-neon', 'effort', v_effort, 'keyId', v_key.id);
	end if;
	return null;
end $$;

create or replace function public.qorpera_resolve_run_claude_choice(p_run public.qorpera_execution_runs, p_manifest jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_choice public.qorpera_session_models%rowtype;
	v_defaults public.qorpera_member_default_models%rowtype;
	v_origin public.qorpera_execution_runs%rowtype;
	v_user uuid := coalesce(p_run.requested_by_user_id, p_run.created_by_user_id);
	v_model text;
begin
	if p_manifest #>> '{modelPolicy,claudeChoice}' is distinct from 'thread' then return null; end if;
	if p_run.source_kind in ('session_turn', 'room_delivery') and p_run.session_id is not null then
		select * into v_choice from public.qorpera_session_models choice where choice.session_id = p_run.session_id;
		select * into v_defaults from public.qorpera_member_default_models where user_id = v_user;
		v_model := coalesce(v_choice.model_id, v_defaults.conversation_model);
		if v_model in ('claude-fable-5-2', 'claude-opus-5-5')
			and public.qorpera_member_may_pick_claude(p_run.profile_id, v_user) then
			return jsonb_build_object('model', v_model,
				'effort', coalesce(v_choice.reasoning_effort, v_defaults.conversation_effort,
					p_manifest #>> '{modelPolicy,effort}', 'low'));
		end if;
		return null;
	end if;
	if p_run.source_kind = 'wake' then
		select origin.* into v_origin
		from public.qorpera_wake_occurrences wake
		join public.qorpera_execution_runs origin on origin.id = wake.origin_run_id
		where wake.id = p_run.source_id and wake.source_kind is distinct from 'worker-dispatch'
			and origin.profile_id = p_run.profile_id and origin.environment_id = p_run.environment_id
			and origin.staff_agent_id = p_run.staff_agent_id and origin.claude_model is not null;
		if v_origin.id is not null
			and public.qorpera_member_may_pick_claude(p_run.profile_id, v_origin.requested_by_user_id) then
			return jsonb_build_object('model', v_origin.claude_model, 'effort', v_origin.claude_effort);
		end if;
	end if;
	return null;
end $$;

create or replace function public.qorpera_execution_run_model_authority()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_staff public.qorpera_profile_staff%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_connection_version public.qorpera_provider_connection_versions%rowtype;
	v_mapping public.qorpera_staff_provider_models%rowtype;
	v_defaults public.qorpera_member_default_models%rowtype;
	v_user uuid := coalesce(new.requested_by_user_id, new.created_by_user_id);
	v_has_session_model boolean := false;
begin
	select staff.* into strict v_staff
	from public.qorpera_profile_staff as staff
	where staff.profile_id = new.profile_id and staff.staff_agent_id = new.staff_agent_id
		and staff.version = new.staff_version and staff.employment_status = 'active';
	select connection.* into strict v_connection
	from public.qorpera_execution_sponsor_versions as sponsor
	join public.qorpera_provider_connections as connection
		on connection.id = sponsor.provider_connection_id
	where sponsor.binding_id = new.sponsor_binding_id and sponsor.version = new.sponsor_version
		and connection.profile_id = new.profile_id;
	select version.* into strict v_connection_version
	from public.qorpera_execution_sponsor_versions as sponsor
	join public.qorpera_provider_connection_versions as version
		on version.connection_id = sponsor.provider_connection_id
		and version.version = sponsor.provider_connection_version
	where sponsor.binding_id = new.sponsor_binding_id and sponsor.version = new.sponsor_version;
	if new.source_kind in ('session_turn', 'room_delivery') and v_connection.provider = 'openai'
		and v_connection_version.authentication_mode = 'native_subscription' then
		select choice.model_id into new.model_id from public.qorpera_session_models choice
		where choice.session_id = new.session_id and choice.model_id is not null
			and choice.model_id not in ('claude-fable-5-2', 'claude-opus-5-5', 'gemini-4-neon');
		if found then
			new.model_provider := 'openai';
			new.model_selection := 'session_override';
			new.model_mapping_version := null;
			return new;
		end if;
		select exists (select 1 from public.qorpera_session_models choice
			where choice.session_id = new.session_id and choice.model_id is not null)
		into v_has_session_model;
		if not v_has_session_model and v_user is not null then
			select * into v_defaults from public.qorpera_member_default_models where user_id = v_user;
			if v_defaults.conversation_model in ('gpt-6.2-sol', 'gpt-6-astra') then
				new.model_provider := 'openai';
				new.model_id := v_defaults.conversation_model;
				new.model_selection := 'member_default';
				new.model_mapping_version := null;
				return new;
			end if;
		end if;
	elsif new.source_kind = 'wake' and v_connection_version.authentication_mode = 'native_subscription'
		and v_user is not null
		and exists (select 1 from public.qorpera_wake_occurrences wake
			where wake.id = new.source_id and wake.source_kind = 'worker-dispatch') then
		select * into v_defaults from public.qorpera_member_default_models where user_id = v_user;
		if v_connection.provider = 'openai' and v_defaults.coding_model in ('gpt-6.2-sol', 'gpt-6-astra') then
			new.model_provider := 'openai';
			new.model_id := v_defaults.coding_model;
			new.model_selection := 'member_default';
			new.model_mapping_version := null;
			return new;
		elsif v_connection.provider = 'anthropic' and v_defaults.coding_model in ('claude-fable-5-2', 'claude-opus-5-5') then
			new.model_provider := 'anthropic';
			new.model_id := v_defaults.coding_model;
			new.model_selection := 'member_default';
			new.model_mapping_version := null;
			return new;
		end if;
	end if;
	select mapping.* into v_mapping
	from public.qorpera_staff_provider_models as mapping
	where mapping.profile_id = new.profile_id and mapping.staff_agent_id = new.staff_agent_id
		and mapping.provider = v_connection.provider;
	new.model_provider := v_connection.provider;
	if found then
		new.model_id := v_mapping.model_id;
		new.model_selection := 'provider_mapping';
		new.model_mapping_version := v_mapping.version;
	elsif v_connection_version.authentication_mode = 'native_subscription' then
		new.model_id := 'provider-default';
		new.model_selection := 'provider_default';
		new.model_mapping_version := null;
	else
		raise exception 'staff has no model authority for the selected provider' using errcode = '42501';
	end if;
	return new;
end $$;

create or replace function public.qorpera_resolve_run_reasoning_effort(p_run public.qorpera_execution_runs, p_manifest jsonb)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
	v_policy jsonb := p_manifest -> 'modelPolicy';
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_defaults public.qorpera_member_default_models%rowtype;
	v_user uuid := coalesce(p_run.requested_by_user_id, p_run.created_by_user_id);
	v_first_run boolean := false;
	v_chosen text;
begin
	if p_run.source_kind = 'wake' then
		select * into v_wake from public.qorpera_wake_occurrences where id = p_run.source_id;
	elsif p_run.source_kind = 'session_turn' and (v_policy ? 'unattended') then
		v_first_run := exists (select 1 from public.qorpera_session_inputs input
				where input.id = any(p_run.input_ids) and input.kind = 'kickoff')
			and not exists (select 1 from public.qorpera_session_inputs input
				where input.id = any(p_run.input_ids) and input.kind is distinct from 'kickoff');
	end if;
	if v_wake.wake_kind = 'routine' then
		if v_policy ->> 'overrides' in ('routine', 'routine-and-thread') then
			select version.effort into v_chosen from public.qorpera_cloud_routine_versions version
			where version.routine_id = v_wake.routine_id and version.version = v_wake.routine_version;
		end if;
		return case when public.qorpera_manifest_allows_reasoning_effort(p_manifest, v_chosen) then v_chosen
			else v_policy ->> 'effort' end;
	end if;
	if p_run.source_kind = 'room_delivery' or (p_run.source_kind = 'session_turn' and not v_first_run) then
		if v_policy ->> 'overrides' = 'routine-and-thread' then
			select choice.reasoning_effort into v_chosen
			from public.qorpera_session_models choice where choice.session_id = p_run.session_id
				and coalesce(choice.model_id not in ('claude-fable-5-2', 'claude-opus-5-5', 'gemini-4-neon'), true);
			if v_chosen is null and v_user is not null then
				select * into v_defaults from public.qorpera_member_default_models where user_id = v_user;
				v_chosen := case when v_defaults.conversation_effort = 'max' then 'xhigh'
					else v_defaults.conversation_effort end;
			end if;
		end if;
		return case when public.qorpera_manifest_allows_reasoning_effort(p_manifest, v_chosen)
				or public.qorpera_model_policy_thread_efforts(v_policy) ? v_chosen then v_chosen
			when v_chosen = 'xhigh' and public.qorpera_manifest_allows_reasoning_effort(p_manifest, 'high') then 'high'
			else v_policy ->> 'effort' end;
	end if;
	if p_run.source_kind = 'wake' and v_wake.source_kind = 'worker-dispatch' and v_user is not null then
		select * into v_defaults from public.qorpera_member_default_models where user_id = v_user;
		if v_defaults.coding_effort is not null then
			v_chosen := case when v_defaults.coding_effort in ('xhigh', 'max') then 'high' else v_defaults.coding_effort end;
			return case when public.qorpera_manifest_allows_reasoning_effort(p_manifest, v_chosen) then v_chosen
				else coalesce(v_policy ->> 'unattended', v_policy ->> 'effort') end;
		end if;
	end if;
	if not (v_policy ? 'unattended') or p_run.source_kind not in ('wake', 'session_turn') then
		return v_policy ->> 'effort'; end if;
	if v_wake.origin_run_id is not null and v_wake.source_kind is distinct from 'worker-dispatch' then
		select origin.reasoning_effort into v_chosen from public.qorpera_execution_runs origin
		where origin.id = v_wake.origin_run_id and origin.profile_id = p_run.profile_id
			and origin.environment_id = p_run.environment_id and origin.staff_agent_id = p_run.staff_agent_id
			and origin.requested_by_user_id = p_run.requested_by_user_id
			and origin.source_kind = 'wake';
		if public.qorpera_manifest_allows_reasoning_effort(p_manifest, v_chosen) then return v_chosen; end if;
	end if;
	select version.structured #>> '{parse,effort}' into v_chosen
	from public.qorpera_profile_staff staff
	join public.qorpera_folder_path_versions version on version.version = staff.folder_path_version
	where staff.profile_id = p_run.profile_id and staff.staff_agent_id = p_run.staff_agent_id
		and version.structured ->> 'kind' = 'agent';
	return case when public.qorpera_manifest_allows_reasoning_effort(p_manifest, v_chosen) then v_chosen
		else v_policy ->> 'unattended' end;
end $$;

create or replace function public.qorpera_claude_worker_resolve(p_worker_id uuid, p_run_id uuid, p_requester_user_id uuid)
returns public.qorpera_runtime_workers language plpgsql security definer set search_path = '' as $$
declare
	v_worker public.qorpera_runtime_workers%rowtype;
	v_login uuid;
	v_run public.qorpera_execution_runs%rowtype;
	v_defaults public.qorpera_member_default_models%rowtype;
	v_claude_model text;
	v_claude_effort text;
begin
	select * into strict v_worker from public.qorpera_runtime_workers where id = p_worker_id;
	if not v_worker.harness_default then
		raise exception 'Only a worker whose brief names no harness is resolved' using errcode = '22023'; end if;
	select * into v_run from public.qorpera_execution_runs where id = p_run_id;
	if p_requester_user_id is not null then
		select * into v_defaults from public.qorpera_member_default_models where user_id = p_requester_user_id;
	end if;
	if v_worker.species = 'in-house' and v_worker.access = 'write'
		and v_worker.requested_by_user_id is not distinct from p_requester_user_id
		and coalesce(v_defaults.coding_model not in ('gpt-6.2-sol', 'gpt-6-astra'), true) then
		v_login := public.qorpera_claude_worker_default_login(v_worker.profile_id, v_worker.staff_agent_id, p_run_id,
			p_requester_user_id);
	end if;
	if v_login is not null then
		if v_defaults.coding_model in ('claude-fable-5-2', 'claude-opus-5-5') then
			v_claude_model := v_defaults.coding_model;
			v_claude_effort := coalesce(v_defaults.coding_effort, 'high');
		else
			v_claude_model := coalesce(v_run.claude_model, v_worker.claude_model);
			v_claude_effort := case
				when v_claude_model is null then null
				when v_defaults.coding_effort is not null then v_defaults.coding_effort
				when v_run.claude_model is null then v_worker.claude_effort
				else v_run.claude_effort
			end;
		end if;
	end if;
	update public.qorpera_runtime_workers
	set harness = case when v_login is null then null else 'claude-code' end,
		claude_login_id = v_login,
		claude_machine_id = null,
		claude_machine_since = null,
		claude_model = v_claude_model,
		claude_effort = v_claude_effort
	where id = v_worker.id returning * into v_worker;
	return v_worker;
end $$;

select pg_temp.md_replace(
	'public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$		if p_parse ->> 'species' = 'in-house' and p_parse ->> 'harness' = 'claude-code' then
			update public.qorpera_runtime_workers set harness = 'claude-code',
				claude_login_id = public.qorpera_claude_worker_login(p_profile_id, v_commit.requester_id),
				(claude_model, claude_effort) = (select run.claude_model, run.claude_effort
					from (select 1) as one left join public.qorpera_execution_runs run on run.id = v_commit.run_id)
			where id = v_worker.id returning * into v_worker;$old$,
	$new$		if p_parse ->> 'species' = 'in-house' and p_parse ->> 'harness' = 'claude-code' then
			update public.qorpera_runtime_workers set harness = 'claude-code',
				claude_login_id = public.qorpera_claude_worker_login(p_profile_id, v_commit.requester_id),
				(claude_model, claude_effort) = (select
					coalesce(case when def.coding_model in ('claude-fable-5-2', 'claude-opus-5-5') then def.coding_model end,
						run.claude_model),
					case
						when def.coding_model in ('claude-fable-5-2', 'claude-opus-5-5') then coalesce(def.coding_effort, 'high')
						when run.claude_model is not null then coalesce(def.coding_effort, run.claude_effort)
						else null
					end
					from (select 1) as one
					left join public.qorpera_execution_runs run on run.id = v_commit.run_id
					left join public.qorpera_member_default_models def on def.user_id = v_commit.requester_id)
			where id = v_worker.id returning * into v_worker;$new$);

create or replace function public.qorpera_get_session_model(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_session public.qorpera_shared_sessions%rowtype;
	v_choice public.qorpera_session_models%rowtype;
	v_defaults public.qorpera_member_default_models%rowtype;
	v_model text;
	v_effort text;
	v_policy jsonb;
	v_gemini public.qorpera_gemini_keys%rowtype;
	v_claude_open boolean;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null
		or not public.qorpera_can_read_session(p_session_id) then
		raise exception 'Conversation model unavailable' using errcode = '42501'; end if;
	select * into strict v_session from public.qorpera_shared_sessions where id = p_session_id;
	select * into v_choice from public.qorpera_session_models where session_id = p_session_id;
	select * into v_defaults from public.qorpera_member_default_models where user_id = auth.uid();
	select bundle.manifest -> 'modelPolicy' into v_policy
	from public.qorpera_active_runtime_bundle active
	join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
	where active.singleton;
	v_gemini := public.qorpera_member_gemini_key_open(v_session.profile_id, auth.uid());
	v_claude_open := v_policy ->> 'claudeChoice' = 'thread'
		and public.qorpera_member_may_pick_claude(v_session.profile_id, auth.uid());
	v_model := v_choice.model_id;
	if v_model is null then
		if v_defaults.conversation_model = 'gemini-4-neon'
			and v_policy ->> 'geminiChoice' = 'thread' and v_gemini.id is not null then
			v_model := 'gemini-4-neon';
		elsif v_defaults.conversation_model in ('claude-fable-5-2', 'claude-opus-5-5') and v_claude_open then
			v_model := v_defaults.conversation_model;
		elsif v_defaults.conversation_model in ('gpt-6.2-sol', 'gpt-6-astra') then
			v_model := v_defaults.conversation_model;
		elsif v_defaults.conversation_model is null and v_policy ->> 'geminiChoice' = 'thread'
			and v_gemini.id is not null and v_gemini.default_for_chats then
			v_model := 'gemini-4-neon';
		end if;
	end if;
	if v_model is null then
		select mapping.model_id into v_model from public.qorpera_staff_provider_models mapping
		where mapping.profile_id = v_session.profile_id and mapping.staff_agent_id::text = v_session.staff_agent_id
			and mapping.provider = 'openai';
	end if;
	if v_choice.reasoning_effort is not null then
		v_effort := v_choice.reasoning_effort;
	else
		v_effort := coalesce(v_defaults.conversation_effort, v_policy ->> 'effort', 'low');
		if v_effort = 'max' and coalesce(v_model not in ('claude-fable-5-2', 'claude-opus-5-5'), true) then
			v_effort := 'xhigh';
		end if;
		if v_effort = 'xhigh'
			and coalesce(v_model not in ('claude-fable-5-2', 'claude-opus-5-5', 'gemini-4-neon'), true)
			and not (public.qorpera_model_policy_thread_efforts(v_policy) ? 'xhigh') then
			v_effort := 'high';
		end if;
	end if;
	return jsonb_build_object('session_id', p_session_id,
		'model_id', case when v_model is null and v_session.staff_agent_id is null then null
			else coalesce(v_model, 'gpt-6.2-sol') end,
		'version', coalesce(v_choice.version, 0))
		|| case when v_policy ->> 'overrides' = 'routine-and-thread' then jsonb_build_object('reasoning_effort', v_effort)
			else '{}'::jsonb end
		|| case when v_policy ->> 'fastMode' = 'thread' then jsonb_build_object('service_tier',
			coalesce(v_choice.service_tier, 'fast')) else '{}'::jsonb end
		|| case when v_gemini.id is not null and public.qorpera_gemini_key_cap_reached(v_gemini)
			then jsonb_build_object('gemini_cap_reached', true) else '{}'::jsonb end
		|| (select jsonb_build_object('models', listed.models, 'efforts', (select jsonb_object_agg(model.id,
				case when model.id in ('claude-fable-5-2', 'claude-opus-5-5') then '["low","medium","high","xhigh","max"]'::jsonb
				when model.id = 'gemini-4-neon' then '["low","medium","high","xhigh"]'::jsonb
				else '["low","medium","high"]'::jsonb || public.qorpera_model_policy_thread_efforts(v_policy) end)
			from jsonb_array_elements_text(listed.models) as model(id)))
		from (select '["gpt-6-astra","gpt-6.2-sol"]'::jsonb
			|| case when v_claude_open then '["claude-fable-5-2","claude-opus-5-5"]'::jsonb else '[]'::jsonb end
			|| case when v_policy ->> 'geminiChoice' = 'thread' and v_gemini.id is not null
				then '["gemini-4-neon"]'::jsonb else '[]'::jsonb end as models) as listed);
end $$;

create or replace function public.qorpera_set_session_model(
	p_session_id uuid,
	p_model_id text,
	p_expected_version bigint,
	p_reasoning_effort text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_choice public.qorpera_session_models%rowtype;
	v_defaults public.qorpera_member_default_models%rowtype;
	v_user uuid;
	v_profile_id uuid;
	v_gemini public.qorpera_gemini_keys%rowtype;
	v_model text;
	v_effort text;
begin
	v_user := public.qorpera_session_model_writer(p_session_id);
	if (p_model_id is null and p_reasoning_effort is null)
		or (p_model_id is not null and p_model_id not in ('gpt-6-astra', 'gpt-6.2-sol', 'gpt-6-sol', 'gpt-6-luna',
			'claude-fable-5-2', 'claude-opus-5-5', 'gemini-4-neon'))
		or (p_reasoning_effort is not null and p_reasoning_effort not in ('low', 'medium', 'high', 'xhigh', 'max'))
		or p_expected_version is null or p_expected_version < 0 then
		raise exception 'Conversation model is invalid' using errcode = '22023'; end if;
	select * into v_choice from public.qorpera_session_models where session_id = p_session_id;
	if coalesce(v_choice.version, 0) <> p_expected_version then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01',
			'message', 'Conversation model changed; refresh before retrying', 'details', null, 'hint', null)::text,
			detail = '{"status":409,"headers":{}}'; end if;
	select session.profile_id into strict v_profile_id from public.qorpera_shared_sessions as session
	where session.id = p_session_id;
	v_model := coalesce(p_model_id, v_choice.model_id);
	v_effort := coalesce(p_reasoning_effort, v_choice.reasoning_effort);
	if v_model is null and p_model_id is null then
		select * into v_defaults from public.qorpera_member_default_models where user_id = v_user;
		if v_defaults.conversation_model = 'gemini-4-neon' and public.qorpera_active_bundle_gemini_choice() then
			v_gemini := public.qorpera_member_gemini_key_open(v_profile_id, v_user);
			if v_gemini.id is not null then v_model := 'gemini-4-neon'; end if;
		elsif v_defaults.conversation_model in ('claude-fable-5-2', 'claude-opus-5-5')
			and public.qorpera_active_bundle_claude_choice()
			and public.qorpera_member_may_pick_claude(v_profile_id, v_user) then
			v_model := v_defaults.conversation_model;
		elsif v_defaults.conversation_model in ('gpt-6.2-sol', 'gpt-6-astra') then
			v_model := v_defaults.conversation_model;
		elsif v_defaults.conversation_model is null and public.qorpera_active_bundle_gemini_choice() then
			v_gemini := public.qorpera_member_gemini_key_open(v_profile_id, v_user);
			if v_gemini.id is not null and v_gemini.default_for_chats then
				v_model := 'gemini-4-neon';
			end if;
		end if;
	end if;
	if v_model in ('claude-fable-5-2', 'claude-opus-5-5') and not (public.qorpera_active_bundle_claude_choice()
		and public.qorpera_member_may_pick_claude(v_profile_id, v_user)) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC02',
			'message', 'Claude is not open for you in this company: sign in to Claude in Settings, Model accounts',
			'details', null, 'hint', null)::text,
			detail = '{"status":403,"headers":{}}'; end if;
	if v_model = 'gemini-4-neon' and not (public.qorpera_active_bundle_gemini_choice()
		and public.qorpera_member_may_pick_gemini(v_profile_id, v_user)) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC03',
			'message', 'Gemini 4 Neon is not configured: add your Gemini API key in Settings, AI subscriptions',
			'details', null, 'hint', null)::text,
			detail = '{"status":403,"headers":{}}'; end if;
	if v_effort in ('xhigh', 'max') and coalesce(v_model not in ('claude-fable-5-2', 'claude-opus-5-5'), true)
		and not (v_effort = 'xhigh' and coalesce(v_model = 'gemini-4-neon', false))
		and not (v_effort = 'xhigh' and v_model is not null and public.qorpera_active_bundle_thread_efforts() ? 'xhigh') then
		raise exception 'Conversation effort % is not open for this model', v_effort using errcode = '22023'; end if;
	insert into public.qorpera_session_models(session_id, model_id, reasoning_effort, version, updated_by_user_id)
	values(p_session_id, v_model, v_effort, p_expected_version + 1, v_user)
	on conflict(session_id) do update set model_id = excluded.model_id, reasoning_effort = excluded.reasoning_effort,
		version = excluded.version, updated_by_user_id = excluded.updated_by_user_id, updated_at = clock_timestamp();
	return public.qorpera_get_session_model(p_session_id);
end $$;
