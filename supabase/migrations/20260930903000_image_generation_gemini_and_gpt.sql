set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_member_default_models') is null
		or to_regprocedure('public.qorpera_get_member_default_models(uuid)') is null
		or to_regprocedure('public.qorpera_set_member_default_models(uuid,text,text,text,text,bigint,text,text)') is null
		or to_regprocedure('public.qorpera_member_gemini_default_available(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_revoke_gemini_key(uuid)') is null
		or to_regprocedure('public.qorpera_open_gemini_key_for_run(uuid,text,jsonb)') is null
		or to_regprocedure('public.qorpera_record_gemini_cap_reached(jsonb)') is null
		or to_regprocedure('public.qorpera_record_gemini_key_error(jsonb,text)') is null
		or to_regprocedure('public.qorpera_describe_company_run_context(jsonb)') is null
		or to_regprocedure('public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)') is null
		or to_regprocedure('public.qorpera_run_voice_gemini_key(public.qorpera_execution_runs)') is null
		or to_regprocedure('public.qorpera_run_worker(uuid)') is null
		or to_regprocedure('public.qorpera_surface_turn_requester(public.qorpera_surface_sessions)') is null
		or to_regprocedure('public.qorpera_surface_turn_member_initiated(public.qorpera_surface_sessions)') is null
		or to_regprocedure('public.qorpera_surface_coding_member_initiated(public.qorpera_surface_sessions,uuid)') is null
		or to_regprocedure('public.qorpera_member_gemini_key_open(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_native_tool_locked_run(jsonb)') is null
		or not exists (
			select 1 from information_schema.columns
			where table_schema = 'public' and table_name = 'qorpera_member_default_models' and column_name = 'voice_model'
		) then
		raise exception '20260930903000: prerequisite voice, Gemini, worker, or surface functions are missing';
	end if;
	if exists (
		select 1 from information_schema.columns
		where table_schema = 'public' and table_name = 'qorpera_member_default_models' and column_name = 'image_model'
	) then
		raise exception '20260930903000 is already applied';
	end if;
end $$;

create temporary table image_gen_before as
select oid, prosecdef, proconfig, provolatile, proacl from pg_proc
where oid in (
	'public.qorpera_revoke_gemini_key(uuid)'::regprocedure,
	'public.qorpera_open_gemini_key_for_run(uuid,text,jsonb)'::regprocedure,
	'public.qorpera_record_gemini_cap_reached(jsonb)'::regprocedure,
	'public.qorpera_record_gemini_key_error(jsonb,text)'::regprocedure,
	'public.qorpera_describe_company_run_context(jsonb)'::regprocedure,
	'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure
);

create function pg_temp.img_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930903000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930903000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

alter table public.qorpera_member_default_models
	add column image_model text,
	add constraint qorpera_member_default_models_image_model_check check (
		image_model is null or image_model in ('gemini-3-pro-image', 'chatgpt-image')
	);

create function public.qorpera_resolve_member_image_preference(p_profile_id uuid, p_user_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
	v_row public.qorpera_member_default_models%rowtype;
	v_gemini boolean;
begin
	if p_user_id is not null then
		select * into v_row from public.qorpera_member_default_models where user_id = p_user_id;
	end if;
	v_gemini := public.qorpera_member_gemini_default_available(p_profile_id, p_user_id);
	return case
		when v_row.image_model = 'gemini-3-pro-image' and v_gemini then 'gemini-3-pro-image'
		else 'chatgpt-image'
	end;
end $$;

create function public.qorpera_gemini_image_microdollars(
	p_model text,
	p_input bigint,
	p_cached bigint,
	p_text_output bigint,
	p_image_output bigint
)
returns bigint language sql immutable set search_path = '' as $$
	select case p_model
		when 'gemini-3-pro-image' then
			greatest(0::bigint, coalesce(p_input, 0) - least(greatest(0::bigint, coalesce(p_cached, 0)), greatest(0::bigint, coalesce(p_input, 0)))) * 2::bigint
			+ ((least(greatest(0::bigint, coalesce(p_cached, 0)), greatest(0::bigint, coalesce(p_input, 0))) + 3::bigint) / 4::bigint)
			+ greatest(0::bigint, coalesce(p_text_output, 0)) * 12::bigint
			+ greatest(0::bigint, coalesce(p_image_output, 0)) * 120::bigint
		else 0::bigint
	end
$$;

create function public.qorpera_bundle_supports_image_model(p_bundle_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (
		select 1 from public.qorpera_runtime_bundles as bundle
		where bundle.id = p_bundle_id
			and (
				bundle.manifest -> 'implementation' ? 'packages/runtime/src/cloud-run-picture-lane.ts'
				or bundle.manifest #>> '{modelPolicy,imageChoice}' = 'member'
			)
	)
$$;

create function public.qorpera_run_is_gemini_conversation(p_run public.qorpera_execution_runs)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_run.id is not null
		and p_run.gemini_model is not null
		and p_run.gemini_key_id is not null
		and (
			p_run.source_kind in ('session_turn', 'room_delivery')
			or (p_run.source_kind = 'wake' and exists (
				select 1 from public.qorpera_wake_occurrences as wake
				where wake.id = p_run.source_id
					and wake.profile_id = p_run.profile_id
					and wake.wake_kind <> 'routine'
					and wake.source_kind in ('worker-completion', 'machine-event', 'machine-checkin', 'office-activation')
			))
		)
$$;

create function public.qorpera_run_image_gemini_key(p_run public.qorpera_execution_runs)
returns public.qorpera_gemini_keys language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := coalesce(p_run.requested_by_user_id, p_run.created_by_user_id);
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_key public.qorpera_gemini_keys%rowtype;
	v_eligible boolean := false;
begin
	if p_run.id is null or v_user is null then
		return null;
	end if;
	if public.qorpera_run_is_gemini_conversation(p_run) then
		select key.* into v_key from public.qorpera_gemini_keys as key
		where key.id = p_run.gemini_key_id
			and key.status = 'active'
			and key.owner_user_id = v_user
			and key.principal_id = public.qorpera_company_account_vault(p_run.profile_id);
		if v_key.id is not null then
			return v_key;
		end if;
	end if;
	if public.qorpera_resolve_member_image_preference(p_run.profile_id, v_user) <> 'gemini-3-pro-image' then
		return null;
	end if;
	if p_run.source_kind in ('session_turn', 'room_delivery') then
		v_eligible := true;
	elsif p_run.source_kind = 'wake' then
		select wake.* into v_wake
		from public.qorpera_wake_occurrences as wake
		where wake.id = p_run.source_id and wake.profile_id = p_run.profile_id;
		if v_wake.id is null or v_wake.wake_kind = 'routine' then
			return null;
		end if;
		if v_wake.causal_root_id is not null and exists (
			select 1 from public.qorpera_wake_occurrences as root
			where root.id = v_wake.causal_root_id and root.wake_kind = 'routine'
		) then
			return null;
		end if;
		if v_wake.source_kind in ('worker-completion', 'machine-event', 'machine-checkin', 'office-activation', 'input', 'room') then
			v_eligible := p_run.requested_by_user_id is not null and p_run.requested_by_user_id = v_user;
		elsif v_wake.source_kind = 'surface-session' then
			v_eligible := exists (
				select 1
				from public.qorpera_surface_sessions as sess
				join public.qorpera_surfaces as surf
					on surf.id = sess.surface_id and surf.profile_id = v_wake.profile_id
				where sess.id = v_wake.source_id
					and sess.profile_id = v_wake.profile_id
					and surf.source_kind = 'folder'
					and not sess.is_internal
					and public.qorpera_surface_turn_member_initiated(sess)
					and public.qorpera_surface_turn_requester(sess) = v_user
			);
		elsif v_wake.source_kind = 'worker-dispatch' then
			v_worker := public.qorpera_run_worker(p_run.id);
			if v_worker.id is not null and v_worker.species = 'in-house' and v_worker.access = 'write' then
				v_eligible := v_worker.requested_by_user_id is not null
					and v_worker.requested_by_user_id = v_user
					and p_run.requested_by_user_id = v_user;
			elsif v_worker.id is not null and v_worker.species = 'coding' then
				v_eligible := coalesce(v_worker.owner_user_id, v_worker.requested_by_user_id) = v_user
					and (
						v_worker.surface_session_id is null
						or exists (
							select 1 from public.qorpera_surface_sessions as sess
							where sess.id = v_worker.surface_session_id
								and sess.profile_id = p_run.profile_id
								and not sess.is_internal
								and public.qorpera_surface_coding_member_initiated(sess, v_user)
						)
					);
			end if;
		end if;
	end if;
	if not v_eligible then
		return null;
	end if;
	v_key := public.qorpera_member_gemini_key_open(p_run.profile_id, v_user);
	if v_key.id is null then
		return null;
	end if;
	return v_key;
end $$;

revoke all on function
	public.qorpera_resolve_member_image_preference(uuid, uuid),
	public.qorpera_gemini_image_microdollars(text, bigint, bigint, bigint, bigint),
	public.qorpera_bundle_supports_image_model(uuid),
	public.qorpera_run_is_gemini_conversation(public.qorpera_execution_runs),
	public.qorpera_run_image_gemini_key(public.qorpera_execution_runs)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.img_patch(
	'public.qorpera_revoke_gemini_key(uuid)'::regprocedure,
	array[
$old$	update public.qorpera_member_default_models
	set conversation_model = case when conversation_model = 'gemini-4-neon' then null else conversation_model end,
		voice_model = case when voice_model in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts') then null else voice_model end,
		voice_name = case when voice_model in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts') then null else voice_name end,
		version = version + 1,
		updated_at = clock_timestamp()
	where user_id = v_user
		and (conversation_model = 'gemini-4-neon' or voice_model in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'));$old$,
$new$	update public.qorpera_member_default_models
	set conversation_model = case when conversation_model = 'gemini-4-neon' then null else conversation_model end,
		voice_model = case when voice_model in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts') then null else voice_model end,
		voice_name = case when voice_model in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts') then null else voice_name end,
		image_model = case when image_model = 'gemini-3-pro-image' then null else image_model end,
		version = version + 1,
		updated_at = clock_timestamp()
	where user_id = v_user
		and (
			conversation_model = 'gemini-4-neon'
			or voice_model in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts')
			or image_model = 'gemini-3-pro-image'
		);$new$
	]
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
	v_voice jsonb;
	v_voice_model text;
	v_voice_name text;
	v_image_model text;
	v_conv_models jsonb;
	v_coding_models jsonb;
	v_voice_models jsonb;
	v_image_models jsonb;
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
	v_voice := public.qorpera_resolve_member_voice_preference(p_profile_id, v_user);
	v_voice_model := v_voice ->> 'voiceModel';
	v_voice_name := v_voice ->> 'voiceName';
	v_image_model := public.qorpera_resolve_member_image_preference(p_profile_id, v_user);
	v_conv_models := '["gpt-6.2-sol","gpt-6-astra"]'::jsonb
		|| case when v_gemini then '["gemini-4-neon"]'::jsonb else '[]'::jsonb end;
	v_coding_models := case when v_claude then '["claude-opus-5-5","claude-fable-5-2"]'::jsonb else '[]'::jsonb end
		|| '["gpt-6.2-sol","gpt-6-astra"]'::jsonb;
	v_voice_models := case when v_gemini then '["gemini-3.8-flash-tts","gemini-3.8-flash-lite-tts"]'::jsonb else '[]'::jsonb end
		|| '["chatgpt-voice"]'::jsonb;
	v_image_models := case when v_gemini then '["gemini-3-pro-image"]'::jsonb else '[]'::jsonb end
		|| '["chatgpt-image"]'::jsonb;
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
		'imageModel', v_image_model,
		'storedConversationModel', v_row.conversation_model,
		'storedCodingModel', v_row.coding_model,
		'storedVoiceModel', v_row.voice_model,
		'storedVoiceName', v_row.voice_name,
		'storedImageModel', v_row.image_model,
		'conversationModels', v_conv_models,
		'codingModels', v_coding_models,
		'voiceModels', v_voice_models,
		'imageModels', v_image_models,
		'conversationEfforts', v_conv_efforts,
		'codingEfforts', v_coding_efforts,
		'voiceProfiles', v_voice_profiles,
		'version', coalesce(v_row.version, 0)
	);
end $$;

drop function public.qorpera_set_member_default_models(uuid, text, text, text, text, bigint, text, text);

create function public.qorpera_set_member_default_models(
	p_profile_id uuid,
	p_conversation_model text,
	p_conversation_effort text,
	p_coding_model text,
	p_coding_effort text,
	p_expected_version bigint,
	p_voice_model text default null,
	p_voice_name text default null,
	p_image_model text default null
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
	v_image_model text;
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
			and p_voice_model is null and p_voice_name is null
			and p_image_model is null)
		or (p_conversation_model is not null and p_conversation_model not in (
			'gpt-6.2-sol', 'gpt-6-astra', 'gemini-4-neon'))
		or (p_conversation_effort is not null and p_conversation_effort not in ('low', 'medium', 'high', 'xhigh'))
		or (p_coding_model is not null and p_coding_model not in (
			'gpt-6.2-sol', 'gpt-6-astra', 'claude-fable-5-2', 'claude-opus-5-5'))
		or (p_coding_effort is not null and p_coding_effort not in ('low', 'medium', 'high', 'xhigh', 'max'))
		or (p_voice_model is not null and p_voice_model not in (
			'gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'chatgpt-voice'))
		or (p_voice_name is not null and not (
			public.qorpera_voice_model_profiles('gemini-3.8-flash-tts') ? p_voice_name
			or public.qorpera_voice_model_profiles('chatgpt-voice') ? p_voice_name
		))
		or (p_image_model is not null and p_image_model not in ('gemini-3-pro-image', 'chatgpt-image'))
		or p_expected_version is null or p_expected_version < 0 then
		raise exception 'Default model settings are invalid' using errcode = '22023'; end if;
	if p_conversation_model is not null or p_voice_model is not null or p_voice_name is not null or p_image_model is not null then
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
	if (p_conversation_model = 'gemini-4-neon'
			or p_voice_model in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts')
			or p_image_model = 'gemini-3-pro-image')
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
	v_image_model := coalesce(p_image_model, v_row.image_model);
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
	if v_coding_effort in ('xhigh', 'max') and coalesce(v_coding_model not in ('claude-fable-5-2', 'claude-opus-5-5'), true) then
		raise exception 'Coding effort % needs a Claude model', v_coding_effort using errcode = '22023'; end if;
	if p_expected_version = 0 then
		insert into public.qorpera_member_default_models (
			user_id, conversation_model, conversation_effort, coding_model, coding_effort,
			voice_model, voice_name, image_model, version, updated_at
		) values (
			v_user, v_conv_model, v_conv_effort, v_coding_model, v_coding_effort,
			v_voice_model, v_voice_name, v_image_model, 1, clock_timestamp()
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
			image_model = v_image_model,
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
	public.qorpera_set_member_default_models(uuid, text, text, text, text, bigint, text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function
	public.qorpera_get_member_default_models(uuid),
	public.qorpera_set_member_default_models(uuid, text, text, text, text, bigint, text, text, text)
	to authenticated;

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
	v_run_authorized boolean := false;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	v_lease := public.qorpera_model_login_run_binding(p_binding);
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_lease.run_id;
	select principal.* into v_principal from public.qorpera_cloud_secret_broker_principals as principal
	where principal.id = v_authority.principal_id and principal.status = 'active';
	if public.qorpera_run_is_gemini_conversation(v_run) then
		select key.* into v_key from public.qorpera_gemini_keys as key where key.id = v_run.gemini_key_id;
		v_run_authorized := true;
	elsif v_run.id is not null then
		v_key := public.qorpera_run_image_gemini_key(v_run);
		if v_key.id is null and v_run.source_kind = 'wake' then
			v_key := public.qorpera_run_voice_gemini_key(v_run);
		end if;
		v_run_authorized := v_key.id is not null;
	end if;
	if v_run.id is null or not v_run_authorized
		or v_run.profile_id is distinct from v_authority.profile_id
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

create or replace function public.qorpera_record_gemini_cap_reached(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_key_id uuid;
	v_key public.qorpera_gemini_keys%rowtype;
	v_month text := public.qorpera_gemini_current_month();
	v_spend bigint;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Gemini cap notice is the runtime''s' using errcode = '42501'; end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_key_id := coalesce(
		case when public.qorpera_run_is_gemini_conversation(v_run) then v_run.gemini_key_id end,
		(public.qorpera_run_image_gemini_key(v_run)).id,
		(public.qorpera_run_voice_gemini_key(v_run)).id
	);
	if v_key_id is null then
		raise exception 'The run is not a Gemini run' using errcode = '42501'; end if;
	select key.* into v_key from public.qorpera_gemini_keys as key where key.id = v_key_id;
	if v_key.id is null or v_key.monthly_cap_cents is null or not public.qorpera_gemini_key_cap_reached(v_key) then
		return jsonb_build_object('schema', 'qorpera.gemini-cap-notice/v1', 'recorded', false); end if;
	v_spend := public.qorpera_gemini_key_month_spend(v_key);
	insert into public.qorpera_member_notifications (profile_id, user_id, kind, subject, dedupe_key)
	values (
		v_run.profile_id,
		v_key.owner_user_id,
		'gemini_cap_reached',
		jsonb_build_object(
			'schema', 'qorpera.member-notification.gemini-cap-reached/v1',
			'month', v_month,
			'spendMicrodollars', v_spend,
			'monthlyCapCents', v_key.monthly_cap_cents,
			'runId', v_run.id,
			'sessionId', v_run.session_id
		),
		'gemini-cap:' || v_key.id::text || ':' || v_month || ':' || v_key.monthly_cap_cents::text
	)
	on conflict (profile_id, user_id, kind, dedupe_key) where acknowledged_at is null do nothing;
	return jsonb_build_object('schema', 'qorpera.gemini-cap-notice/v1', 'recorded', true);
end $$;
revoke all on function public.qorpera_record_gemini_cap_reached(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_record_gemini_cap_reached(jsonb)
	to service_role;

create or replace function public.qorpera_record_gemini_key_error(p_binding jsonb, p_error_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_key_id uuid;
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
	v_key_id := coalesce(
		case when public.qorpera_run_is_gemini_conversation(v_run) then v_run.gemini_key_id end,
		(public.qorpera_run_image_gemini_key(v_run)).id,
		(public.qorpera_run_voice_gemini_key(v_run)).id
	);
	if v_key_id is null then
		raise exception 'The run is not a Gemini run' using errcode = '42501'; end if;
	update public.qorpera_gemini_keys
	set last_error_code = p_error_code,
		last_error_at = v_now,
		updated_at = v_now
	where id = v_key_id and status = 'active';
	return jsonb_build_object('schema', 'qorpera.gemini-key-error-recorded/v1', 'recorded', found);
end $$;
revoke all on function public.qorpera_record_gemini_key_error(jsonb, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_record_gemini_key_error(jsonb, text)
	to service_role;

create function public.qorpera_record_gemini_image_usage(
	p_binding jsonb,
	p_model text,
	p_usage jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_image_key public.qorpera_gemini_keys%rowtype;
	v_key public.qorpera_gemini_keys%rowtype;
	v_month text := public.qorpera_gemini_current_month();
	v_input bigint;
	v_cached bigint;
	v_text_output bigint;
	v_image_output bigint;
	v_delta_spend bigint;
	v_cap_reached boolean;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Gemini image usage is the runtime''s' using errcode = '42501'; end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if p_model is null or p_model <> 'gemini-3-pro-image' then
		raise exception 'Gemini image model is invalid' using errcode = '22023'; end if;
	if jsonb_typeof(p_usage) <> 'object'
		or (select count(*) from jsonb_object_keys(p_usage)) <> 4
		or not (
			p_usage ? 'inputTokens'
			and p_usage ? 'cachedTokens'
			and p_usage ? 'textOutputTokens'
			and p_usage ? 'imageOutputTokens'
		)
		or jsonb_typeof(p_usage -> 'inputTokens') <> 'number'
		or jsonb_typeof(p_usage -> 'cachedTokens') <> 'number'
		or jsonb_typeof(p_usage -> 'textOutputTokens') <> 'number'
		or jsonb_typeof(p_usage -> 'imageOutputTokens') <> 'number'
		or (p_usage ->> 'inputTokens') !~ '^\d{1,7}$'
		or (p_usage ->> 'cachedTokens') !~ '^\d{1,7}$'
		or (p_usage ->> 'textOutputTokens') !~ '^\d{1,7}$'
		or (p_usage ->> 'imageOutputTokens') !~ '^\d{1,7}$' then
		raise exception 'Gemini image usage is invalid' using errcode = '22023'; end if;
	v_input := (p_usage ->> 'inputTokens')::bigint;
	v_cached := (p_usage ->> 'cachedTokens')::bigint;
	v_text_output := (p_usage ->> 'textOutputTokens')::bigint;
	v_image_output := (p_usage ->> 'imageOutputTokens')::bigint;
	if v_input > 1000000 or v_cached > v_input or v_text_output > 1000000 or v_image_output > 1000000 then
		raise exception 'Gemini image usage is invalid' using errcode = '22023'; end if;
	v_image_key := public.qorpera_run_image_gemini_key(v_run);
	if v_image_key.id is null then
		raise exception 'Gemini image usage is unavailable to this run' using errcode = '42501'; end if;
	select key.* into v_key from public.qorpera_gemini_keys as key
	where key.id = v_image_key.id for update;
	if v_key.id is null or v_key.status <> 'active' then
		raise exception 'Gemini key is unavailable' using errcode = '42501'; end if;
	if v_key.spend_month <> v_month then
		v_key.spend_month := v_month;
		v_key.month_spend_microdollars := 0;
		v_key.month_input_tokens := 0;
		v_key.month_cached_tokens := 0;
		v_key.month_output_tokens := 0;
	end if;
	v_delta_spend := public.qorpera_gemini_image_microdollars(
		p_model, v_input, v_cached, v_text_output, v_image_output
	);
	update public.qorpera_gemini_keys
	set spend_month = v_month,
		month_spend_microdollars = v_key.month_spend_microdollars + v_delta_spend,
		month_input_tokens = v_key.month_input_tokens + v_input,
		month_cached_tokens = v_key.month_cached_tokens + v_cached,
		month_output_tokens = v_key.month_output_tokens + v_text_output + v_image_output,
		last_error_code = null,
		last_error_at = null,
		last_checked_at = clock_timestamp(),
		updated_at = clock_timestamp()
	where id = v_key.id
	returning * into v_key;
	v_cap_reached := public.qorpera_gemini_key_cap_reached(v_key);
	if v_cap_reached and v_key.monthly_cap_cents is not null then
		insert into public.qorpera_member_notifications (profile_id, user_id, kind, subject, dedupe_key)
		values (
			v_run.profile_id,
			v_key.owner_user_id,
			'gemini_cap_reached',
			jsonb_build_object(
				'schema', 'qorpera.member-notification.gemini-cap-reached/v1',
				'month', v_month,
				'spendMicrodollars', v_key.month_spend_microdollars,
				'monthlyCapCents', v_key.monthly_cap_cents,
				'runId', v_run.id,
				'sessionId', v_run.session_id
			),
			'gemini-cap:' || v_key.id::text || ':' || v_month || ':' || v_key.monthly_cap_cents::text
		)
		on conflict (profile_id, user_id, kind, dedupe_key) where acknowledged_at is null do nothing;
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.gemini-image-usage/v1',
		'spendMonth', v_key.spend_month,
		'monthSpendMicrodollars', v_key.month_spend_microdollars,
		'monthlyCapCents', v_key.monthly_cap_cents,
		'capReached', v_cap_reached
	);
end $$;
revoke all on function public.qorpera_record_gemini_image_usage(jsonb, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_record_gemini_image_usage(jsonb, text, jsonb)
	to service_role;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_record_gemini_image_usage', 'binding');

select pg_temp.img_patch(
	'public.qorpera_describe_company_run_context(jsonb)'::regprocedure,
	array[
$old$		|| case when v_run.gemini_model is null then '{}'::jsonb
			else jsonb_build_object('gemini',jsonb_build_object('model',v_run.gemini_model,'effort',v_run.gemini_effort,'keyId',v_run.gemini_key_id)) end$old$,
$new$		|| case when v_run.gemini_model is null then '{}'::jsonb
			else jsonb_build_object('gemini',jsonb_build_object('model',v_run.gemini_model,'effort',v_run.gemini_effort,'keyId',v_run.gemini_key_id)) end
		|| case when coalesce(v_run.requested_by_user_id, v_run.created_by_user_id) is null
				or not public.qorpera_bundle_supports_image_model(v_run.runtime_bundle_id)
			then '{}'::jsonb
			else jsonb_build_object('imageModel', case
				when public.qorpera_resolve_member_image_preference(
						v_run.profile_id, coalesce(v_run.requested_by_user_id, v_run.created_by_user_id)) = 'gemini-3-pro-image'
					and (public.qorpera_run_image_gemini_key(v_run)).id is not null
				then 'gemini-3-pro-image'
				else 'chatgpt-image'
			end) end$new$
	]
);

select pg_temp.img_patch(
	'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure,
	array[
$old$		'voiceModel', v_voice ->> 'voiceModel',
		'voiceName', v_voice ->> 'voiceName',
		'openScenesOps', v_open_scenes_ops,$old$,
$new$		'voiceModel', v_voice ->> 'voiceModel',
		'voiceName', v_voice ->> 'voiceName',
		'imageModel', case
			when v_surface.source_kind = 'folder'
				and not v_session.is_internal
				and public.qorpera_surface_turn_member_initiated(v_session)
			then public.qorpera_resolve_member_image_preference(
				p_profile_id,
				public.qorpera_surface_turn_requester(v_session)
			)
			else 'chatgpt-image'
		end,
		'openScenesOps', v_open_scenes_ops,$new$
	]
);

drop function pg_temp.img_patch(regprocedure, text[]);

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid in (
			'public.qorpera_get_member_default_models(uuid)'::regprocedure,
			'public.qorpera_set_member_default_models(uuid,text,text,text,text,bigint,text,text,text)'::regprocedure,
			'public.qorpera_open_gemini_key_for_run(uuid,text,jsonb)'::regprocedure,
			'public.qorpera_record_gemini_cap_reached(jsonb)'::regprocedure,
			'public.qorpera_record_gemini_key_error(jsonb,text)'::regprocedure,
			'public.qorpera_record_gemini_image_usage(jsonb,text,jsonb)'::regprocedure,
			'public.qorpera_describe_company_run_context(jsonb)'::regprocedure,
			'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure
		)
	loop
		execute format(
			'grant execute on function public.qorpera_resolve_member_image_preference(uuid,uuid), public.qorpera_gemini_image_microdollars(text,bigint,bigint,bigint,bigint), public.qorpera_bundle_supports_image_model(uuid), public.qorpera_run_is_gemini_conversation(public.qorpera_execution_runs), public.qorpera_run_image_gemini_key(public.qorpera_execution_runs), public.qorpera_run_voice_gemini_key(public.qorpera_execution_runs) to %I',
			v_owner
		);
	end loop;
end $$;

do $$ begin
	if exists (
		select 1 from pg_temp.image_gen_before as prior
		join pg_proc as patched on patched.oid = prior.oid
		where patched.prosecdef is distinct from prior.prosecdef
			or patched.proconfig is distinct from prior.proconfig
			or patched.provolatile is distinct from prior.provolatile
			or patched.proacl::text is distinct from prior.proacl::text
	) or (select count(*) from pg_temp.image_gen_before) <> 6 then
		raise exception '20260930903000: patched function attributes or grants drifted';
	end if;
end $$;
