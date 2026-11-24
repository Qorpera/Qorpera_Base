set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_member_default_models') is null
		or to_regprocedure('public.qorpera_get_member_default_models(uuid)') is null
		or to_regprocedure('public.qorpera_set_member_default_models(uuid,text,text,text,text,bigint)') is null
		or to_regprocedure('public.qorpera_resolve_run_claude_choice(public.qorpera_execution_runs,jsonb)') is null
		or to_regprocedure('public.qorpera_get_session_model(uuid)') is null
		or to_regprocedure('public.qorpera_set_session_model(uuid,text,bigint,text)') is null then
		raise exception '20260930882000: prerequisite member default models schema is missing';
	end if;
	if not exists (
		select 1 from pg_constraint
		where conrelid = 'public.qorpera_member_default_models'::regclass
			and conname = 'qorpera_member_default_models_conv_effort'
	) then
		raise exception '20260930882000 is already applied';
	end if;
end $$;

create temporary table conv_default_no_claude_before as
select oid, prosecdef, proconfig, provolatile, proacl from pg_proc
where oid in (
	'public.qorpera_get_member_default_models(uuid)'::regprocedure,
	'public.qorpera_set_member_default_models(uuid,text,text,text,text,bigint)'::regprocedure,
	'public.qorpera_resolve_run_claude_choice(public.qorpera_execution_runs,jsonb)'::regprocedure,
	'public.qorpera_get_session_model(uuid)'::regprocedure,
	'public.qorpera_set_session_model(uuid,text,bigint,text)'::regprocedure
);

update public.qorpera_member_default_models
set conversation_model = case
		when conversation_model in ('claude-fable-5-2', 'claude-opus-5-5') then null
		else conversation_model
	end,
	conversation_effort = case
		when conversation_effort = 'max' then 'xhigh'
		else conversation_effort
	end,
	version = version + 1,
	updated_at = clock_timestamp()
where conversation_model in ('claude-fable-5-2', 'claude-opus-5-5')
	or conversation_effort = 'max';

alter table public.qorpera_member_default_models
	drop constraint qorpera_member_default_models_conversation_model_check,
	drop constraint qorpera_member_default_models_conversation_effort_check,
	drop constraint qorpera_member_default_models_conv_effort,
	add constraint qorpera_member_default_models_conversation_model_check check (
		conversation_model is null or conversation_model in ('gpt-6.2-sol', 'gpt-6-astra', 'gemini-4-neon')
	),
	add constraint qorpera_member_default_models_conversation_effort_check check (
		conversation_effort is null or conversation_effort in ('low', 'medium', 'high', 'xhigh')
	);

create or replace function public.qorpera_get_member_default_models(p_profile_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_row public.qorpera_member_default_models%rowtype;
	v_policy jsonb;
	v_claude boolean;
	v_gemini boolean;
	v_gemini_legacy_default boolean := false;
	v_conv_model text;
	v_conv_display_model text;
	v_conv_effort text;
	v_coding_model text;
	v_coding_display_model text;
	v_coding_effort text;
	v_conv_models jsonb;
	v_coding_models jsonb;
	v_conv_efforts jsonb;
	v_coding_efforts jsonb;
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
	if v_row.conversation_model is null and v_gemini then
		if p_profile_id is not null then
			v_gemini_legacy_default := coalesce(
				(public.qorpera_member_gemini_key_open(p_profile_id, v_user)).default_for_chats, false);
		else
			select exists (select 1 from public.qorpera_gemini_keys as key
				where key.owner_user_id = v_user and key.status = 'active' and key.default_for_chats)
			into v_gemini_legacy_default;
		end if;
	end if;
	v_conv_model := case
		when v_row.conversation_model = 'gemini-4-neon' and v_gemini then 'gemini-4-neon'
		when v_row.conversation_model in ('gpt-6.2-sol', 'gpt-6-astra') then v_row.conversation_model
		when v_row.conversation_model is null and v_gemini_legacy_default then 'gemini-4-neon'
		else 'gpt-6.2-sol'
	end;
	v_conv_display_model := coalesce(v_row.conversation_model, v_conv_model);
	v_conv_effort := coalesce(v_row.conversation_effort, v_policy ->> 'effort', 'low');
	if v_conv_effort = 'max' then
		v_conv_effort := 'xhigh';
	end if;
	if v_conv_effort = 'xhigh'
		and v_conv_display_model in ('gpt-6.2-sol', 'gpt-6-astra')
		and not (public.qorpera_model_policy_thread_efforts(v_policy) ? 'xhigh') then
		v_conv_effort := 'high';
	end if;
	v_coding_model := case
		when v_row.coding_model in ('claude-fable-5-2', 'claude-opus-5-5') and v_claude then v_row.coding_model
		when v_row.coding_model in ('gpt-6.2-sol', 'gpt-6-astra') then v_row.coding_model
		when v_claude then 'claude-opus-5-5'
		else 'gpt-6.2-sol'
	end;
	v_coding_display_model := coalesce(v_row.coding_model, v_coding_model);
	v_coding_effort := coalesce(v_row.coding_effort, v_policy ->> 'unattended', 'high');
	if v_coding_effort in ('xhigh', 'max') and v_coding_display_model not in ('claude-fable-5-2', 'claude-opus-5-5') then
		v_coding_effort := 'high';
	end if;
	v_conv_models := '["gpt-6.2-sol","gpt-6-astra"]'::jsonb
		|| case when v_gemini then '["gemini-4-neon"]'::jsonb else '[]'::jsonb end;
	v_coding_models := case when v_claude then '["claude-opus-5-5","claude-fable-5-2"]'::jsonb else '[]'::jsonb end
		|| '["gpt-6.2-sol","gpt-6-astra"]'::jsonb;
	select jsonb_object_agg(model.id,
		case
			when model.id = 'gemini-4-neon' then '["low","medium","high","xhigh"]'::jsonb
			else '["low","medium","high"]'::jsonb || public.qorpera_model_policy_thread_efforts(v_policy)
		end)
	into v_conv_efforts
	from jsonb_array_elements_text('["gpt-6.2-sol","gpt-6-astra","gemini-4-neon"]'::jsonb) as model(id);
	select jsonb_object_agg(model.id,
		case
			when model.id in ('claude-fable-5-2', 'claude-opus-5-5') then '["low","medium","high","xhigh","max"]'::jsonb
			else '["low","medium","high"]'::jsonb
		end)
	into v_coding_efforts
	from jsonb_array_elements_text('["gpt-6.2-sol","gpt-6-astra","claude-opus-5-5","claude-fable-5-2"]'::jsonb) as model(id);
	return jsonb_build_object(
		'schema', 'qorpera.member-default-models/v1',
		'conversationModel', v_conv_model,
		'conversationEffort', v_conv_effort,
		'codingModel', v_coding_model,
		'codingEffort', v_coding_effort,
		'storedConversationModel', v_row.conversation_model,
		'storedCodingModel', v_row.coding_model,
		'conversationModels', v_conv_models,
		'codingModels', v_coding_models,
		'conversationEfforts', v_conv_efforts,
		'codingEfforts', v_coding_efforts,
		'version', coalesce(v_row.version, 0)
	);
end $$;

create or replace function public.qorpera_set_member_default_models(
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
	if (p_conversation_model is null and p_conversation_effort is null
			and p_coding_model is null and p_coding_effort is null)
		or (p_conversation_model is not null and p_conversation_model not in (
			'gpt-6.2-sol', 'gpt-6-astra', 'gemini-4-neon'))
		or (p_conversation_effort is not null and p_conversation_effort not in ('low', 'medium', 'high', 'xhigh'))
		or (p_coding_model is not null and p_coding_model not in (
			'gpt-6.2-sol', 'gpt-6-astra', 'claude-fable-5-2', 'claude-opus-5-5'))
		or (p_coding_effort is not null and p_coding_effort not in ('low', 'medium', 'high', 'xhigh', 'max'))
		or p_expected_version is null or p_expected_version < 0 then
		raise exception 'Default model settings are invalid' using errcode = '22023'; end if;
	if p_conversation_model is not null then
		perform 1 from public.qorpera_gemini_keys
		where owner_user_id = v_user and status = 'active'
		order by id
		for update;
	end if;
	select * into v_row from public.qorpera_member_default_models where user_id = v_user for update;
	if coalesce(v_row.version, 0) <> p_expected_version then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01',
			'message', 'Default model settings changed; refresh before retrying', 'details', null, 'hint', null)::text,
			detail = '{"status":409,"headers":{}}'; end if;
	if p_coding_model in ('claude-fable-5-2', 'claude-opus-5-5')
		and not public.qorpera_member_claude_default_available(p_profile_id, v_user) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC02',
			'message', 'Sign in to Claude in Settings before choosing a Claude default model',
			'details', null, 'hint', null)::text,
			detail = '{"status":403,"headers":{}}'; end if;
	if p_conversation_model = 'gemini-4-neon'
		and not public.qorpera_member_gemini_default_available(p_profile_id, v_user) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC02',
			'message', 'Add a Gemini API key in Settings before choosing Gemini 4 Neon as your default',
			'details', null, 'hint', null)::text,
			detail = '{"status":403,"headers":{}}'; end if;
	v_conv_model := coalesce(p_conversation_model, v_row.conversation_model);
	v_conv_effort := coalesce(p_conversation_effort, v_row.conversation_effort);
	v_coding_model := coalesce(p_coding_model, v_row.coding_model);
	v_coding_effort := coalesce(p_coding_effort, v_row.coding_effort);
	if p_coding_model is not null and p_coding_effort is null
		and v_coding_effort in ('xhigh', 'max') and v_coding_model not in ('claude-fable-5-2', 'claude-opus-5-5') then
		v_coding_effort := 'high';
	end if;
	if v_coding_effort in ('xhigh', 'max') and coalesce(v_coding_model not in ('claude-fable-5-2', 'claude-opus-5-5'), true) then
		raise exception 'Coding effort % needs a Claude model', v_coding_effort using errcode = '22023'; end if;
	if p_expected_version = 0 then
		insert into public.qorpera_member_default_models (
			user_id, conversation_model, conversation_effort, coding_model, coding_effort, version, updated_at
		) values (
			v_user, v_conv_model, v_conv_effort, v_coding_model, v_coding_effort, 1, clock_timestamp()
		)
		on conflict (user_id) do nothing
		returning * into v_row;
		if not found then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01',
				'message', 'Default model settings changed; refresh before retrying', 'details', null, 'hint', null)::text,
				detail = '{"status":409,"headers":{}}'; end if;
	else
		update public.qorpera_member_default_models
		set conversation_model = v_conv_model,
			conversation_effort = v_conv_effort,
			coding_model = v_coding_model,
			coding_effort = v_coding_effort,
			version = p_expected_version + 1,
			updated_at = clock_timestamp()
		where user_id = v_user and version = p_expected_version
		returning * into v_row;
		if not found then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01',
				'message', 'Default model settings changed; refresh before retrying', 'details', null, 'hint', null)::text,
				detail = '{"status":409,"headers":{}}'; end if;
	end if;
	if p_conversation_model is not null then
		update public.qorpera_gemini_keys
		set default_for_chats = (v_conv_model = 'gemini-4-neon'),
			updated_at = clock_timestamp()
		where owner_user_id = v_user and status = 'active'
			and default_for_chats is distinct from (v_conv_model = 'gemini-4-neon');
	end if;
	return public.qorpera_get_member_default_models(p_profile_id);
end $$;

create or replace function public.qorpera_resolve_run_claude_choice(p_run public.qorpera_execution_runs, p_manifest jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_choice public.qorpera_session_models%rowtype;
	v_defaults public.qorpera_member_default_models%rowtype;
	v_origin public.qorpera_execution_runs%rowtype;
	v_user uuid := coalesce(p_run.requested_by_user_id, p_run.created_by_user_id);
begin
	if p_manifest #>> '{modelPolicy,claudeChoice}' is distinct from 'thread' then return null; end if;
	if p_run.source_kind in ('session_turn', 'room_delivery') and p_run.session_id is not null then
		select * into v_choice from public.qorpera_session_models choice where choice.session_id = p_run.session_id;
		if v_choice.model_id in ('claude-fable-5-2', 'claude-opus-5-5')
			and public.qorpera_member_may_pick_claude(p_run.profile_id, v_user) then
			select * into v_defaults from public.qorpera_member_default_models where user_id = v_user;
			return jsonb_build_object('model', v_choice.model_id,
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

do $$ begin
	if exists (
		select 1 from pg_temp.conv_default_no_claude_before as prior
		join pg_proc as patched on patched.oid = prior.oid
		where patched.prosecdef is distinct from prior.prosecdef
			or patched.proconfig is distinct from prior.proconfig
			or patched.provolatile is distinct from prior.provolatile
			or patched.proacl::text is distinct from prior.proacl::text
	) or (select count(*) from pg_temp.conv_default_no_claude_before) <> 5 then
		raise exception '20260930882000: patched function attributes or grants drifted';
	end if;
end $$;
