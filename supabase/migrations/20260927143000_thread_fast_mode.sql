-- Thread fast mode (founder decision 2026-09-27). A member's turn in a
-- conversation runs on the provider's Fast tier (Codex service tier "fast",
-- sent as "priority": about 1.5x speed on GPT-6 Sol and Luna, 2x on Astra) by
-- default. The composer's Model menu has a Fast switch that turns it off for
-- that one conversation. Routines, coworker wakes, coding and other
-- conversations run at standard speed.
--
-- The bundle's model policy declares `fastMode: thread` when its host passes
-- the tier to Codex. The kernel resolves the tier when it admits the run and
-- pins it, like the effort. Runs admitted under a bundle without fast mode keep
-- a null tier. The host learns the tier from the run's company context, which
-- only the agent host reads. The shared tool identity is unchanged: company
-- computers update on their own schedule and refuse any field they do not know.

create function pg_temp.fast_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Fast mode patch differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- Null keeps the default: Fast.
alter table public.qorpera_session_models
	add column service_tier text
		constraint qorpera_session_models_service_tier_check check (service_tier in ('fast','standard'));

-- Null: admitted under a bundle without fast mode.
alter table public.qorpera_execution_runs
	add column service_tier text
		constraint qorpera_execution_runs_service_tier_check check (service_tier in ('fast','standard'));

-- A bundle may declare fast mode for thread turns; any other value is refused.
select pg_temp.fast_patch('public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)'::regprocedure,
	$old$		or (v_manifest -> 'modelPolicy') - array['schema','effort','overrides','allowed'] <> '{}'::jsonb$old$,
	$new$		or (v_manifest -> 'modelPolicy') - array['schema','effort','overrides','allowed','fastMode'] <> '{}'::jsonb
		or coalesce(v_manifest #>> '{modelPolicy,fastMode}','thread') <> 'thread'$new$);

create function public.qorpera_pin_execution_service_tier()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_manifest jsonb; v_tier text;
begin
	if tg_op = 'UPDATE' then
		if new.service_tier is distinct from old.service_tier then
			raise exception 'Execution service tier is immutable' using errcode = '42501'; end if;
		return new;
	end if;
	-- Caller hints cannot choose the tier. Under a bundle with fast mode, a
	-- member's Codex turn in a conversation (a session turn or a room delivery)
	-- runs at that conversation's speed, Fast unless a member turned it off;
	-- everything else runs at standard speed.
	v_manifest := public.qorpera_execution_runtime_manifest(new);
	if v_manifest #>> '{modelPolicy,fastMode}' = 'thread' then
		v_tier := 'standard';
		if new.source_kind in ('session_turn','room_delivery') and new.model_provider = 'openai' then
			v_tier := coalesce((select choice.service_tier from public.qorpera_session_models choice
				where choice.session_id = new.session_id),'fast');
		end if;
	end if;
	new.service_tier := v_tier;
	return new;
end
$$;
revoke all on function public.qorpera_pin_execution_service_tier() from public, anon, authenticated, service_role;
-- Alphabetically after the model authority (which sets the provider) and the
-- reasoning policy (which checks the admitted bundle).
create trigger qorpera_execution_run_service_tier
before insert or update of service_tier on public.qorpera_execution_runs
for each row execute function public.qorpera_pin_execution_service_tier();

-- A tier that disagrees with the admitted bundle is refused like a changed
-- effort. The authority's output does not change.
select pg_temp.fast_patch('public.qorpera_describe_native_tool_authority(jsonb)'::regprocedure,
	$old$	if not public.qorpera_manifest_allows_reasoning_effort(v_manifest, v_run.reasoning_effort)
		or v_run.reasoning_policy_sha256 is distinct from$old$,
	$new$	if not public.qorpera_manifest_allows_reasoning_effort(v_manifest, v_run.reasoning_effort)
		or (v_run.service_tier is null) <> (v_manifest #>> '{modelPolicy,fastMode}' is null)
		or v_run.reasoning_policy_sha256 is distinct from$new$);

-- The agent host reads the tier with the run's company context, before it
-- starts Codex. Only runs that have a tier name one.
select pg_temp.fast_patch('public.qorpera_describe_company_run_context(jsonb)'::regprocedure,
	$old$'jobSpecification',v_spec,'continuation',v_continuation);$old$,
	$new$'jobSpecification',v_spec,'continuation',v_continuation)
		|| case when v_run.service_tier is null then '{}'::jsonb
			else jsonb_build_object('serviceTier',v_run.service_tier) end;$new$);

-- The speed is reported only while the active bundle honours it, so a client
-- never shows a switch that runs would ignore.
select pg_temp.fast_patch('public.qorpera_get_session_model(uuid)'::regprocedure,
	$old$			coalesce(v_choice.reasoning_effort,v_policy ->> 'effort','low')) else '{}'::jsonb end;$old$,
	$new$			coalesce(v_choice.reasoning_effort,v_policy ->> 'effort','low')) else '{}'::jsonb end
		|| case when v_policy ->> 'fastMode' = 'thread' then jsonb_build_object('service_tier',
			coalesce(v_choice.service_tier,'fast')) else '{}'::jsonb end;$new$);

-- An omitted speed keeps the conversation's speed, so a client that predates
-- the switch still works and a save sends only what the member changed.
drop function public.qorpera_set_session_model(uuid,text,bigint,text);
create function public.qorpera_set_session_model(
	p_session_id uuid,p_model_id text,p_expected_version bigint,p_reasoning_effort text default null,
	p_service_tier text default null)
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
	if (p_model_id is null and p_reasoning_effort is null and p_service_tier is null)
		or (p_model_id is not null and p_model_id not in ('gpt-6-astra','gpt-6-sol','gpt-6-luna'))
		or (p_reasoning_effort is not null and p_reasoning_effort not in ('low','medium','high'))
		or (p_service_tier is not null and p_service_tier not in ('fast','standard'))
		or p_expected_version is null or p_expected_version < 0 then
		raise exception 'Conversation model is invalid' using errcode = '22023'; end if;
	select * into v_choice from public.qorpera_session_models where session_id = p_session_id;
	if coalesce(v_choice.version,0) <> p_expected_version then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code','QRC01',
			'message','Conversation model changed; refresh before retrying','details',null,'hint',null)::text,
			detail = '{"status":409,"headers":{}}'; end if;
	insert into public.qorpera_session_models(session_id,model_id,reasoning_effort,service_tier,version,updated_by_user_id)
	values(p_session_id,p_model_id,p_reasoning_effort,p_service_tier,p_expected_version + 1,v_user)
	on conflict(session_id) do update set
		model_id = coalesce(excluded.model_id,public.qorpera_session_models.model_id),
		reasoning_effort = coalesce(excluded.reasoning_effort,public.qorpera_session_models.reasoning_effort),
		service_tier = coalesce(excluded.service_tier,public.qorpera_session_models.service_tier),
		version = excluded.version,updated_by_user_id = excluded.updated_by_user_id,updated_at = clock_timestamp();
	return public.qorpera_get_session_model(p_session_id);
end $$;
revoke all on function public.qorpera_set_session_model(uuid,text,bigint,text,text)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_set_session_model(uuid,text,bigint,text,text) to authenticated;
