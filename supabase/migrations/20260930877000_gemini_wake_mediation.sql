set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_resolve_run_gemini_choice(public.qorpera_execution_runs,jsonb)') is null
		or to_regprocedure('public.qorpera_pin_execution_gemini_choice()') is null
		or to_regprocedure('public.qorpera_open_gemini_key_for_run(uuid,text,jsonb)') is null
		or to_regprocedure('public.qorpera_member_gemini_key_open(uuid,uuid)') is null then
		raise exception '20260930877000: prerequisite Gemini functions are missing';
	end if;
end $$;

create temporary table gemini_wake_mediation_before as
select oid, prosecdef, proconfig, provolatile, proacl from pg_proc
where oid in (
	'public.qorpera_resolve_run_gemini_choice(public.qorpera_execution_runs,jsonb)'::regprocedure,
	'public.qorpera_pin_execution_gemini_choice()'::regprocedure,
	'public.qorpera_open_gemini_key_for_run(uuid,text,jsonb)'::regprocedure
);

alter table public.qorpera_execution_runs
	drop constraint qorpera_execution_runs_gemini_choice,
	add constraint qorpera_execution_runs_gemini_choice check (
		(gemini_model is null) = (gemini_effort is null)
		and (gemini_model is null) = (gemini_key_id is null)
		and (gemini_model is null or (source_kind in ('session_turn', 'room_delivery', 'wake') and claude_model is null))
	);

create or replace function public.qorpera_resolve_run_gemini_choice(p_run public.qorpera_execution_runs, p_manifest jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_choice public.qorpera_session_models%rowtype;
	v_defaults public.qorpera_member_default_models%rowtype;
	v_origin public.qorpera_execution_runs%rowtype;
	v_key public.qorpera_gemini_keys%rowtype;
	v_user uuid := coalesce(p_run.requested_by_user_id, p_run.created_by_user_id);
	v_effort text;
begin
	if p_manifest #>> '{modelPolicy,geminiChoice}' is distinct from 'thread' then return null; end if;
	if p_run.claude_model is not null then return null; end if;
	if p_run.source_kind in ('session_turn', 'room_delivery') and p_run.session_id is not null then
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
	end if;
	if p_run.source_kind = 'wake' then
		select origin.* into v_origin
		from public.qorpera_wake_occurrences wake
		join public.qorpera_execution_runs origin on origin.id = wake.origin_run_id
		where wake.id = p_run.source_id
			and wake.source_kind in ('worker-completion', 'machine-event', 'machine-checkin', 'office-activation')
			and origin.profile_id = p_run.profile_id and origin.environment_id = p_run.environment_id
			and origin.staff_agent_id = p_run.staff_agent_id and origin.gemini_model is not null
			and origin.claude_model is null;
		if v_origin.id is not null
			and v_origin.requested_by_user_id is not null
			and v_origin.requested_by_user_id is not distinct from v_user then
			v_key := public.qorpera_member_gemini_key_open(p_run.profile_id, v_origin.requested_by_user_id);
			if v_key.id is not null then
				return jsonb_build_object('model', v_origin.gemini_model, 'effort', v_origin.gemini_effort, 'keyId', v_key.id);
			end if;
		end if;
	end if;
	return null;
end $$;
revoke all on function public.qorpera_resolve_run_gemini_choice(public.qorpera_execution_runs, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_pin_execution_gemini_choice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_choice jsonb;
begin
	if tg_op = 'UPDATE' then
		if (new.gemini_model, new.gemini_effort, new.gemini_key_id)
			is distinct from (old.gemini_model, old.gemini_effort, old.gemini_key_id) then
			raise exception 'Execution Gemini choice is immutable' using errcode = '42501'; end if;
		return new;
	end if;
	v_choice := case when new.source_kind in ('session_turn', 'room_delivery', 'wake')
		then public.qorpera_resolve_run_gemini_choice(new, public.qorpera_execution_runtime_manifest(new)) end;
	new.gemini_model := v_choice ->> 'model';
	new.gemini_effort := v_choice ->> 'effort';
	new.gemini_key_id := (v_choice ->> 'keyId')::uuid;
	return new;
end $$;
revoke all on function public.qorpera_pin_execution_gemini_choice()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_open_gemini_key_for_run(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_key public.qorpera_gemini_keys%rowtype;
	v_month text := public.qorpera_gemini_current_month();
	v_spend bigint;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	v_lease := public.qorpera_model_login_run_binding(p_binding);
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_lease.run_id;
	select principal.* into v_principal from public.qorpera_cloud_secret_broker_principals as principal
	where principal.id = v_authority.principal_id and principal.status = 'active';
	select key.* into v_key from public.qorpera_gemini_keys as key where key.id = v_run.gemini_key_id;
	if v_run.id is null or v_run.profile_id is distinct from v_authority.profile_id
		or v_run.gemini_model is null or v_run.gemini_key_id is null
		or v_run.source_kind not in ('session_turn', 'room_delivery', 'wake')
		or (v_run.source_kind = 'wake' and not exists (
			select 1 from public.qorpera_wake_occurrences as wake
			where wake.id = v_run.source_id
				and wake.source_kind in ('worker-completion', 'machine-event', 'machine-checkin', 'office-activation')
		))
		or v_principal.id is null or public.qorpera_company_account_vault(v_authority.profile_id) is distinct from v_principal.id
		or v_key.id is null or v_key.principal_id is distinct from v_principal.id
		or v_key.owner_user_id is distinct from coalesce(v_run.requested_by_user_id, v_run.created_by_user_id) then
		raise exception 'Gemini key is unavailable to this run' using errcode = '42501'; end if;
	if v_key.status <> 'active' then
		return jsonb_build_object(
			'schema', 'qorpera.gemini-key-for-run/v1',
			'state', 'refused',
			'reason', 'REVOKED'
		);
	end if;
	v_spend := public.qorpera_gemini_key_month_spend(v_key);
	if public.qorpera_gemini_key_cap_reached(v_key) then
		return jsonb_build_object(
			'schema', 'qorpera.gemini-key-for-run/v1',
			'state', 'refused',
			'reason', 'CAP_REACHED',
			'spendMonth', v_month,
			'monthSpendMicrodollars', v_spend,
			'monthlyCapCents', v_key.monthly_cap_cents
		);
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.gemini-key-for-run/v1',
		'state', 'open',
		'geminiKeyId', v_key.id,
		'ownerUserId', v_key.owner_user_id,
		'keyId', v_key.key_id,
		'version', v_key.version,
		'envelopeSha256', v_key.envelope_sha256,
		'encryptedEnvelopeBase64', encode(v_key.encrypted_envelope, 'base64'),
		'spendMonth', v_month,
		'monthSpendMicrodollars', v_spend,
		'monthlyCapCents', v_key.monthly_cap_cents
	);
end $$;
revoke all on function public.qorpera_open_gemini_key_for_run(uuid, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_open_gemini_key_for_run(uuid, text, jsonb)
	to qorpera_secret_broker;

do $$ begin
	if exists (
		select 1 from pg_temp.gemini_wake_mediation_before as prior
		join pg_proc as patched on patched.oid = prior.oid
		where patched.prosecdef is distinct from prior.prosecdef
			or patched.proconfig is distinct from prior.proconfig
			or patched.provolatile is distinct from prior.provolatile
			or patched.proacl::text is distinct from prior.proacl::text
	) or (select count(*) from pg_temp.gemini_wake_mediation_before) <> 3 then
		raise exception '20260930877000: patched function attributes or grants drifted';
	end if;
end $$;
