set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_member_default_models') is null
		or to_regprocedure('public.qorpera_get_member_default_models(uuid)') is null
		or to_regprocedure('public.qorpera_set_member_default_models(uuid,text,text,text,text,bigint)') is null
		or to_regprocedure('public.qorpera_member_gemini_default_available(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_revoke_gemini_key(uuid)') is null then
		raise exception '20260930882000 requires 20260930858000_member_default_models_and_gemini_health';
	end if;
	if exists (
		select 1 from information_schema.columns
		where table_schema = 'public' and table_name = 'qorpera_member_default_models' and column_name = 'voice_model'
	) then
		raise exception '20260930882000 is already applied';
	end if;
end $$;

create function pg_temp.mdv_replace(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_hits integer;
begin
	v_hits := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
	if v_hits <> 1 then
		raise exception '20260930882000: anchor matched % time(s) in %', v_hits, p_target;
	end if;
	execute replace(v_def, p_old, p_new);
end $$;

create function public.qorpera_voice_model_profiles(p_model text)
returns jsonb language sql immutable set search_path = '' as $$
	select case
		when p_model in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts') then
			'["Charon","Kore","Puck","Zephyr","Aoede","Fenrir","Leda","Orus","Callirrhoe","Autonoe","Enceladus","Iapetus","Umbriel","Algieba","Despina","Erinome","Algenib","Rasalgethi","Laomedeia","Achernar","Alnilam","Schedar","Gacrux","Pulcherrima","Achird","Zubenelgenubi","Vindemiatrix","Sadachbia","Sadaltager","Sulafat"]'::jsonb
		when p_model = 'chatgpt-voice' then
			'["cove","juniper","maple","spruce","ember","vale","breeze","arbor","sol"]'::jsonb
		else '[]'::jsonb
	end
$$;

create function public.qorpera_voice_model_default_profile(p_model text)
returns text language sql immutable set search_path = '' as $$
	select case
		when p_model in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts') then 'Charon'
		when p_model = 'chatgpt-voice' then 'cove'
		else null
	end
$$;

revoke all on function
	public.qorpera_voice_model_profiles(text),
	public.qorpera_voice_model_default_profile(text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

alter table public.qorpera_member_default_models
	add column voice_model text,
	add column voice_name text,
	add constraint qorpera_member_default_models_voice_model_check check (
		voice_model is null or voice_model in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'chatgpt-voice')
	),
	add constraint qorpera_member_default_models_voice_name_check check (
		voice_name is null or (
			voice_model is not null
			and public.qorpera_voice_model_profiles(voice_model) ? voice_name
		)
	);

create function public.qorpera_resolve_member_voice_preference(p_profile_id uuid, p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_row public.qorpera_member_default_models%rowtype;
	v_gemini boolean;
	v_voice_model text;
	v_voice_name text;
begin
	if p_user_id is not null then
		select * into v_row from public.qorpera_member_default_models where user_id = p_user_id;
	end if;
	v_gemini := public.qorpera_member_gemini_default_available(p_profile_id, p_user_id);
	v_voice_model := case
		when v_row.voice_model in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts') and v_gemini then v_row.voice_model
		else 'chatgpt-voice'
	end;
	v_voice_name := case
		when v_row.voice_name is not null and public.qorpera_voice_model_profiles(v_voice_model) ? v_row.voice_name
			then v_row.voice_name
		else public.qorpera_voice_model_default_profile(v_voice_model)
	end;
	return jsonb_build_object(
		'voiceModel', v_voice_model,
		'voiceName', v_voice_name
	);
end $$;

revoke all on function public.qorpera_resolve_member_voice_preference(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.mdv_replace(
	'public.qorpera_revoke_gemini_key(uuid)'::regprocedure,
	$old$	update public.qorpera_member_default_models
	set conversation_model = null,
		version = version + 1,
		updated_at = clock_timestamp()
	where user_id = v_user and conversation_model = 'gemini-4-neon';$old$,
	$new$	update public.qorpera_member_default_models
	set conversation_model = case when conversation_model = 'gemini-4-neon' then null else conversation_model end,
		voice_model = case when voice_model in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts') then null else voice_model end,
		voice_name = case when voice_model in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts') then null else voice_name end,
		version = version + 1,
		updated_at = clock_timestamp()
	where user_id = v_user
		and (conversation_model = 'gemini-4-neon' or voice_model in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'));$new$);

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
	v_voice jsonb;
	v_voice_model text;
	v_voice_name text;
	v_conv_models jsonb;
	v_coding_models jsonb;
	v_voice_models jsonb;
	v_conv_efforts jsonb;
	v_coding_efforts jsonb;
	v_voice_profiles jsonb;
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
		when v_row.conversation_model in ('claude-fable-5-2', 'claude-opus-5-5') and v_claude then v_row.conversation_model
		when v_row.conversation_model in ('gpt-6.2-sol', 'gpt-6-astra') then v_row.conversation_model
		when v_row.conversation_model is null and v_gemini_legacy_default then 'gemini-4-neon'
		else 'gpt-6.2-sol'
	end;
	v_conv_display_model := coalesce(v_row.conversation_model, v_conv_model);
	v_conv_effort := coalesce(v_row.conversation_effort, v_policy ->> 'effort', 'low');
	if v_conv_effort = 'max' and v_conv_display_model not in ('claude-fable-5-2', 'claude-opus-5-5') then
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
	v_voice := public.qorpera_resolve_member_voice_preference(p_profile_id, v_user);
	v_voice_model := v_voice ->> 'voiceModel';
	v_voice_name := v_voice ->> 'voiceName';
	v_conv_models := '["gpt-6.2-sol","gpt-6-astra"]'::jsonb
		|| case when v_claude then '["claude-opus-5-5","claude-fable-5-2"]'::jsonb else '[]'::jsonb end
		|| case when v_gemini then '["gemini-4-neon"]'::jsonb else '[]'::jsonb end;
	v_coding_models := case when v_claude then '["claude-opus-5-5","claude-fable-5-2"]'::jsonb else '[]'::jsonb end
		|| '["gpt-6.2-sol","gpt-6-astra"]'::jsonb;
	v_voice_models := case when v_gemini then '["gemini-3.8-flash-tts","gemini-3.8-flash-lite-tts"]'::jsonb else '[]'::jsonb end
		|| '["chatgpt-voice"]'::jsonb;
	select jsonb_object_agg(model.id,
		case
			when model.id in ('claude-fable-5-2', 'claude-opus-5-5') then '["low","medium","high","xhigh","max"]'::jsonb
			when model.id = 'gemini-4-neon' then '["low","medium","high","xhigh"]'::jsonb
			else '["low","medium","high"]'::jsonb || public.qorpera_model_policy_thread_efforts(v_policy)
		end)
	into v_conv_efforts
	from jsonb_array_elements_text('["gpt-6.2-sol","gpt-6-astra","claude-opus-5-5","claude-fable-5-2","gemini-4-neon"]'::jsonb) as model(id);
	select jsonb_object_agg(model.id,
		case
			when model.id in ('claude-fable-5-2', 'claude-opus-5-5') then '["low","medium","high","xhigh","max"]'::jsonb
			else '["low","medium","high"]'::jsonb
		end)
	into v_coding_efforts
	from jsonb_array_elements_text('["gpt-6.2-sol","gpt-6-astra","claude-opus-5-5","claude-fable-5-2"]'::jsonb) as model(id);
	select jsonb_object_agg(model.id, public.qorpera_voice_model_profiles(model.id))
	into v_voice_profiles
	from jsonb_array_elements_text('["gemini-3.8-flash-tts","gemini-3.8-flash-lite-tts","chatgpt-voice"]'::jsonb) as model(id);
	return jsonb_build_object(
		'schema', 'qorpera.member-default-models/v1',
		'conversationModel', v_conv_model,
		'conversationEffort', v_conv_effort,
		'codingModel', v_coding_model,
		'codingEffort', v_coding_effort,
		'voiceModel', v_voice_model,
		'voiceName', v_voice_name,
		'storedConversationModel', v_row.conversation_model,
		'storedCodingModel', v_row.coding_model,
		'storedVoiceModel', v_row.voice_model,
		'storedVoiceName', v_row.voice_name,
		'conversationModels', v_conv_models,
		'codingModels', v_coding_models,
		'voiceModels', v_voice_models,
		'conversationEfforts', v_conv_efforts,
		'codingEfforts', v_coding_efforts,
		'voiceProfiles', v_voice_profiles,
		'version', coalesce(v_row.version, 0)
	);
end $$;

drop function public.qorpera_set_member_default_models(uuid, text, text, text, text, bigint);

create function public.qorpera_set_member_default_models(
	p_profile_id uuid,
	p_conversation_model text,
	p_conversation_effort text,
	p_coding_model text,
	p_coding_effort text,
	p_expected_version bigint,
	p_voice_model text default null,
	p_voice_name text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_row public.qorpera_member_default_models%rowtype;
	v_conv_model text;
	v_conv_effort text;
	v_coding_model text;
	v_coding_effort text;
	v_voice_model text;
	v_voice_name text;
	v_effective_voice_model text;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Default model settings require member authority' using errcode = '42501'; end if;
	if p_profile_id is not null and not exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and member.user_id = v_user
			and member.role in ('owner', 'admin', 'contributor')) then
		raise exception 'Default model settings require member authority' using errcode = '42501'; end if;
	if (p_conversation_model is null and p_conversation_effort is null
			and p_coding_model is null and p_coding_effort is null
			and p_voice_model is null and p_voice_name is null)
		or (p_conversation_model is not null and p_conversation_model not in (
			'gpt-6.2-sol', 'gpt-6-astra', 'claude-fable-5-2', 'claude-opus-5-5', 'gemini-4-neon'))
		or (p_conversation_effort is not null and p_conversation_effort not in ('low', 'medium', 'high', 'xhigh', 'max'))
		or (p_coding_model is not null and p_coding_model not in (
			'gpt-6.2-sol', 'gpt-6-astra', 'claude-fable-5-2', 'claude-opus-5-5'))
		or (p_coding_effort is not null and p_coding_effort not in ('low', 'medium', 'high', 'xhigh', 'max'))
		or (p_voice_model is not null and p_voice_model not in (
			'gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'chatgpt-voice'))
		or (p_voice_name is not null and not (
			public.qorpera_voice_model_profiles('gemini-3.8-flash-tts') ? p_voice_name
			or public.qorpera_voice_model_profiles('chatgpt-voice') ? p_voice_name
		))
		or p_expected_version is null or p_expected_version < 0 then
		raise exception 'Default model settings are invalid' using errcode = '22023'; end if;
	if p_conversation_model is not null or p_voice_model is not null or p_voice_name is not null then
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
	if (p_conversation_model in ('claude-fable-5-2', 'claude-opus-5-5') or p_coding_model in ('claude-fable-5-2', 'claude-opus-5-5'))
		and not public.qorpera_member_claude_default_available(p_profile_id, v_user) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC02',
			'message', 'Sign in to Claude in Settings before choosing a Claude default model',
			'details', null, 'hint', null)::text,
			detail = '{"status":403,"headers":{}}'; end if;
	if (p_conversation_model = 'gemini-4-neon'
			or p_voice_model in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'))
		and not public.qorpera_member_gemini_default_available(p_profile_id, v_user) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC02',
			'message', 'Add a Gemini API key in Settings before choosing a Gemini default model',
			'details', null, 'hint', null)::text,
			detail = '{"status":403,"headers":{}}'; end if;
	v_conv_model := coalesce(p_conversation_model, v_row.conversation_model);
	v_conv_effort := coalesce(p_conversation_effort, v_row.conversation_effort);
	v_coding_model := coalesce(p_coding_model, v_row.coding_model);
	v_coding_effort := coalesce(p_coding_effort, v_row.coding_effort);
	v_voice_model := coalesce(p_voice_model, v_row.voice_model);
	v_voice_name := coalesce(p_voice_name, v_row.voice_name);
	if p_conversation_model is not null and p_conversation_effort is null
		and v_conv_effort = 'max' and v_conv_model not in ('claude-fable-5-2', 'claude-opus-5-5') then
		v_conv_effort := 'xhigh';
	end if;
	if p_coding_model is not null and p_coding_effort is null
		and v_coding_effort in ('xhigh', 'max') and v_coding_model not in ('claude-fable-5-2', 'claude-opus-5-5') then
		v_coding_effort := 'high';
	end if;
	if p_voice_model is not null and p_voice_name is null then
		if v_voice_name is null or not (public.qorpera_voice_model_profiles(v_voice_model) ? v_voice_name) then
			v_voice_name := public.qorpera_voice_model_default_profile(v_voice_model);
		end if;
	end if;
	if p_voice_model is null and p_voice_name is not null and v_voice_model is null then
		v_effective_voice_model := public.qorpera_resolve_member_voice_preference(p_profile_id, v_user) ->> 'voiceModel';
		if not (public.qorpera_voice_model_profiles(v_effective_voice_model) ? p_voice_name) then
			raise exception 'Voice profile % does not belong to %', p_voice_name, v_effective_voice_model using errcode = '22023';
		end if;
		v_voice_model := v_effective_voice_model;
	end if;
	if v_voice_name is not null and (v_voice_model is null or not (public.qorpera_voice_model_profiles(v_voice_model) ? v_voice_name)) then
		raise exception 'Voice profile % does not belong to %', v_voice_name, coalesce(v_voice_model, 'none') using errcode = '22023';
	end if;
	if v_conv_effort = 'max' and coalesce(v_conv_model not in ('claude-fable-5-2', 'claude-opus-5-5'), true) then
		raise exception 'Conversational effort max needs a Claude model' using errcode = '22023'; end if;
	if v_coding_effort in ('xhigh', 'max') and coalesce(v_coding_model not in ('claude-fable-5-2', 'claude-opus-5-5'), true) then
		raise exception 'Coding effort % needs a Claude model', v_coding_effort using errcode = '22023'; end if;
	if p_expected_version = 0 then
		insert into public.qorpera_member_default_models (
			user_id, conversation_model, conversation_effort, coding_model, coding_effort,
			voice_model, voice_name, version, updated_at
		) values (
			v_user, v_conv_model, v_conv_effort, v_coding_model, v_coding_effort,
			v_voice_model, v_voice_name, 1, clock_timestamp()
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
			voice_model = v_voice_model,
			voice_name = v_voice_name,
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

revoke all on function
	public.qorpera_get_member_default_models(uuid),
	public.qorpera_set_member_default_models(uuid, text, text, text, text, bigint, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function
	public.qorpera_get_member_default_models(uuid),
	public.qorpera_set_member_default_models(uuid, text, text, text, text, bigint, text, text)
	to authenticated;
