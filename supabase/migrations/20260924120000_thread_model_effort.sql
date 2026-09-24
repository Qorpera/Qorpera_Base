-- Thread model and effort (founder decision 2026-09-24). The composer's Model
-- menu in an agent thread offers the GPT-6 family (Astra, Sol, Luna) and a
-- thinking effort (low, medium or high). Both belong to that one conversation:
-- a member's reply in it runs with them, while routines, coworker wakes and
-- other conversations keep their own. Existing GPT-5.6 choices move to their
-- GPT-6 counterparts (Sol -> Sol, Terra -> Luna); the version advances so an
-- open client refreshes before it saves over the moved choice.

alter table public.qorpera_session_models drop constraint qorpera_session_models_model_id_check;
update public.qorpera_session_models
set model_id = case model_id when 'gpt-5.6-sol' then 'gpt-6-sol' else 'gpt-6-luna' end,
	version = version + 1, updated_at = clock_timestamp()
where model_id in ('gpt-5.6-sol','gpt-5.6-terra');
alter table public.qorpera_session_models
	add constraint qorpera_session_models_model_id_check check (model_id in ('gpt-6-astra','gpt-6-sol','gpt-6-luna')),
	-- Null keeps the admitted bundle's default effort.
	add column reasoning_effort text
		constraint qorpera_session_models_reasoning_effort_check check (reasoning_effort in ('low','medium','high'));

-- A bundle declares which runs may choose from its allowed efforts: routine
-- wakes ('routine', bundles v66-v90) or routine wakes and attended thread turns
-- ('routine-and-thread', from v91). Runs admitted under either stay valid.
create or replace function public.qorpera_manifest_allows_reasoning_effort(p_manifest jsonb, p_effort text)
returns boolean language sql immutable set search_path = '' as $$
	select p_effort is not null and (
		p_effort = p_manifest #>> '{modelPolicy,effort}'
		or (p_manifest #>> '{modelPolicy,overrides}' in ('routine','routine-and-thread')
			and jsonb_typeof(p_manifest #> '{modelPolicy,allowed}') = 'array'
			and (p_manifest #> '{modelPolicy,allowed}') ? p_effort))
$$;
revoke all on function public.qorpera_manifest_allows_reasoning_effort(jsonb, text) from public, anon, authenticated, service_role;

create or replace function public.qorpera_execution_runtime_manifest(p_run public.qorpera_execution_runs)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_manifest jsonb;
begin
	select manifest into v_manifest from public.qorpera_runtime_bundles
	where id = p_run.runtime_bundle_id and sha256 = p_run.runtime_bundle_sha256;
	if v_manifest ->> 'schema' is distinct from 'qorpera.runtime-bundle/v2'
		or jsonb_typeof(v_manifest -> 'modelPolicy') is distinct from 'object'
		or (v_manifest -> 'modelPolicy') - array['schema','effort','overrides','allowed'] <> '{}'::jsonb
		or v_manifest #>> '{modelPolicy,schema}' is distinct from 'qorpera.model-reasoning/v1'
		or coalesce(v_manifest #>> '{modelPolicy,effort}','') not in ('low','medium','high')
		or coalesce(v_manifest #>> '{modelPolicy,overrides}','') not in ('none','routine','routine-and-thread')
		or (v_manifest #>> '{modelPolicy,overrides}' in ('routine','routine-and-thread') and (
			jsonb_typeof(v_manifest #> '{modelPolicy,allowed}') is distinct from 'array'
			or exists (select 1 from jsonb_array_elements_text(v_manifest #> '{modelPolicy,allowed}') allowed
				where allowed.value not in ('low','medium','high'))))
		or (v_manifest #>> '{modelPolicy,overrides}' = 'none' and v_manifest -> 'modelPolicy' ? 'allowed')
		or coalesce(v_manifest ->> 'nativeBinarySha256','') !~ '^[0-9a-f]{64}$'
		or jsonb_typeof(v_manifest -> 'implementation') is distinct from 'object'
		or v_manifest -> 'implementation' = '{}'::jsonb
		or jsonb_typeof(v_manifest -> 'components') is distinct from 'object' then
		raise exception 'Run requires an executable runtime bundle' using errcode = '42501'; end if;
	if not (v_manifest -> 'components' ?& array['kernel','constitution','toolCatalog','wakeAndSilence',
		'contextComposer','providerBootstrap','authorization','inboundSafety','outboundSafety',
		'interactionSurfaces','workerLifecycle','memoryAndSkills'])
		or exists(select 1 from jsonb_each_text(v_manifest -> 'components') component where component.value !~ '^[0-9a-f]{64}$')
		or exists(select 1 from jsonb_each_text(v_manifest -> 'implementation') source where source.value !~ '^[0-9a-f]{64}$') then
		raise exception 'Run runtime components are unavailable' using errcode = '42501'; end if;
	return v_manifest;
end
$$;

create or replace function public.qorpera_pin_execution_reasoning_policy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_manifest jsonb; v_effort text; v_chosen_effort text;
begin
	if tg_op = 'UPDATE' then
		if (new.reasoning_effort,new.reasoning_policy_sha256) is distinct from
			(old.reasoning_effort,old.reasoning_policy_sha256) then
			raise exception 'Execution reasoning policy is immutable' using errcode = '42501'; end if;
	else
		v_manifest := public.qorpera_execution_runtime_manifest(new);
		-- Caller hints and job flags cannot override the admitted bundle. A
		-- routine wake takes the effort its routine version declares (contract
		-- 17), and a member's turn in a conversation takes that conversation's
		-- choice, when the bundle allows the override; anything else runs at
		-- the bundle default.
		v_effort := v_manifest #>> '{modelPolicy,effort}';
		if v_manifest #>> '{modelPolicy,overrides}' in ('routine','routine-and-thread') and new.source_kind = 'wake' then
			select version.effort into v_chosen_effort
			from public.qorpera_wake_occurrences wake
			join public.qorpera_cloud_routine_versions version
				on version.routine_id = wake.routine_id and version.version = wake.routine_version
			where wake.id = new.source_id and wake.wake_kind = 'routine';
		elsif v_manifest #>> '{modelPolicy,overrides}' = 'routine-and-thread'
			and new.source_kind in ('session_turn','room_delivery') then
			select choice.reasoning_effort into v_chosen_effort
			from public.qorpera_session_models choice where choice.session_id = new.session_id;
		end if;
		if v_chosen_effort is not null and public.qorpera_manifest_allows_reasoning_effort(v_manifest, v_chosen_effort) then
			v_effort := v_chosen_effort; end if;
		new.reasoning_effort := v_effort;
		new.reasoning_policy_sha256 := encode(extensions.digest(convert_to((v_manifest -> 'modelPolicy')::text,'utf8'),'sha256'),'hex');
	end if;
	return new;
end
$$;

create or replace function public.qorpera_get_session_model(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_session public.qorpera_shared_sessions%rowtype; v_choice public.qorpera_session_models%rowtype;
	v_model text; v_default_effort text;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null
		or not public.qorpera_can_read_session(p_session_id) then
		raise exception 'Conversation model unavailable' using errcode = '42501'; end if;
	select * into strict v_session from public.qorpera_shared_sessions where id = p_session_id;
	select * into v_choice from public.qorpera_session_models where session_id = p_session_id;
	if v_choice.session_id is not null then v_model := v_choice.model_id;
	else
		select mapping.model_id into v_model from public.qorpera_staff_provider_models mapping
		where mapping.profile_id = v_session.profile_id and mapping.staff_agent_id::text = v_session.staff_agent_id
			and mapping.provider = 'openai';
	end if;
	select bundle.manifest #>> '{modelPolicy,effort}' into v_default_effort
	from public.qorpera_active_runtime_bundle active
	join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
	where active.singleton;
	return jsonb_build_object('session_id',p_session_id,'model_id',coalesce(v_model,'gpt-6-astra'),
		'reasoning_effort',coalesce(v_choice.reasoning_effort,v_default_effort,'low'),
		'version',coalesce(v_choice.version,0));
end $$;

-- The effort argument is optional so a client that predates it keeps the
-- conversation's effort when it changes only the model.
drop function public.qorpera_set_session_model(uuid,text,bigint);
create function public.qorpera_set_session_model(
	p_session_id uuid,p_model_id text,p_expected_version bigint,p_reasoning_effort text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.qorpera_shared_sessions%rowtype; v_choice public.qorpera_session_models%rowtype;
	v_user uuid := auth.uid();
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Conversation model requires a member' using errcode = '42501'; end if;
	select * into v_session from public.qorpera_shared_sessions where id = p_session_id;
	if not found or v_session.status <> 'open' or not public.qorpera_can_write_session(p_session_id) then
		raise exception 'Conversation model unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profile_members where profile_id = v_session.profile_id
		and user_id = v_user and role in ('owner','admin','contributor') for share;
	if not found then raise exception 'Conversation model unavailable' using errcode = '42501'; end if;
	if v_session.execution_scope ? 'roomId' then
		perform 1 from public.qorpera_company_rooms room
		join public.qorpera_company_room_members member on member.room_id = room.id
		where room.session_id = p_session_id and room.profile_id = v_session.profile_id and room.status = 'active'
			and member.principal_kind = 'member' and member.principal_id = v_user and member.status = 'active'
		for share of room,member;
		if not found then raise exception 'Conversation model unavailable' using errcode = '42501'; end if;
	end if;
	-- Membership/room locks precede the session lock, matching room post admission.
	select * into v_session from public.qorpera_shared_sessions where id = p_session_id for update;
	if not found or v_session.status <> 'open' or not public.qorpera_can_write_session(p_session_id) then
		raise exception 'Conversation model unavailable' using errcode = '42501'; end if;
	if p_model_id is null or p_model_id not in ('gpt-6-astra','gpt-6-sol','gpt-6-luna')
		or (p_reasoning_effort is not null and p_reasoning_effort not in ('low','medium','high'))
		or p_expected_version is null or p_expected_version < 0 then
		raise exception 'Conversation model is invalid' using errcode = '22023'; end if;
	select * into v_choice from public.qorpera_session_models where session_id = p_session_id;
	if coalesce(v_choice.version,0) <> p_expected_version then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code','QRC01',
			'message','Conversation model changed; refresh before retrying','details',null,'hint',null)::text,
			detail = '{"status":409,"headers":{}}'; end if;
	insert into public.qorpera_session_models(session_id,model_id,reasoning_effort,version,updated_by_user_id)
	values(p_session_id,p_model_id,p_reasoning_effort,p_expected_version + 1,v_user)
	on conflict(session_id) do update set model_id = excluded.model_id,
		reasoning_effort = coalesce(excluded.reasoning_effort,public.qorpera_session_models.reasoning_effort),
		version = excluded.version,updated_by_user_id = excluded.updated_by_user_id,updated_at = clock_timestamp();
	return public.qorpera_get_session_model(p_session_id);
end $$;
revoke all on function public.qorpera_get_session_model(uuid),public.qorpera_set_session_model(uuid,text,bigint,text)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_get_session_model(uuid),public.qorpera_set_session_model(uuid,text,bigint,text)
	to authenticated;
