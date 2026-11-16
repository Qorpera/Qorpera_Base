do $$ begin
	if exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.qorpera_execution_runs'::regclass
		and attname = 'claude_model' and not attisdropped) then
		raise exception '20260930784000 is already applied'; end if;
	if to_regprocedure('public.qorpera_claude_worker_problem(uuid,uuid,uuid)') is null
		or to_regprocedure('public.qorpera_claude_worker_on_home(public.qorpera_company_machines,uuid,uuid)') is null
		or to_regprocedure('public.qorpera_resolve_run_reasoning_effort(public.qorpera_execution_runs,jsonb)') is null
		or to_regprocedure('public.qorpera_set_session_service_tier(uuid,text,bigint)') is null then
		raise exception '20260930784000 needs Claude Code workers (20260930770000, 20260930772000), core work effort (20260930532000) and thread fast mode (20260927161500)';
	end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.cm_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930784000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

alter table public.qorpera_session_models drop constraint qorpera_session_models_model_id_check;
alter table public.qorpera_session_models drop constraint qorpera_session_models_reasoning_effort_check;
alter table public.qorpera_session_models
	add constraint qorpera_session_models_model_id_check check (model_id in ('gpt-6-astra','gpt-6.1-sol','gpt-6-sol',
		'gpt-6-luna','claude-fable-5-2','claude-opus-5-5')),
	add constraint qorpera_session_models_reasoning_effort_check
		check (reasoning_effort in ('low','medium','high','xhigh','max')),
	add constraint qorpera_session_models_claude_effort check (coalesce(reasoning_effort in ('low','medium','high'), true)
		or coalesce(model_id in ('claude-fable-5-2','claude-opus-5-5'), false));

alter table public.qorpera_execution_runs
	add column claude_model text
		constraint qorpera_execution_runs_claude_model_check check (claude_model in ('claude-fable-5-2','claude-opus-5-5')),
	add column claude_effort text
		constraint qorpera_execution_runs_claude_effort_check check (claude_effort in ('low','medium','high','xhigh','max')),
	add constraint qorpera_execution_runs_claude_choice check ((claude_model is null) = (claude_effort is null));

alter table public.qorpera_runtime_workers
	add column claude_model text
		constraint qorpera_runtime_workers_claude_model_check check (claude_model in ('claude-fable-5-2','claude-opus-5-5')),
	add column claude_effort text
		constraint qorpera_runtime_workers_claude_effort_check check (claude_effort in ('low','medium','high','xhigh','max')),
	add constraint qorpera_runtime_workers_claude_choice check ((claude_model is null) = (claude_effort is null)
		and (claude_model is null or harness = 'claude-code'));

select pg_temp.cm_replace('public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)',
	$old$		or (v_manifest -> 'modelPolicy') - array['schema','effort','overrides','allowed','fastMode','unattended'] <> '{}'::jsonb$old$,
	$new$		or (v_manifest -> 'modelPolicy') - array['schema','effort','overrides','allowed','fastMode','unattended','claudeChoice'] <> '{}'::jsonb
		or ((v_manifest -> 'modelPolicy') ? 'claudeChoice'
			and v_manifest -> 'modelPolicy' -> 'claudeChoice' is distinct from '"thread"'::jsonb)$new$);

create function public.qorpera_member_may_pick_claude(p_profile_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce(p_profile_id is not null and p_user_id is not null
		and exists (select 1 from public.qorpera_profile_members member
			where member.profile_id = p_profile_id and member.user_id = p_user_id)
		and public.qorpera_claude_sign_in_open(p_profile_id, p_user_id)
		and exists (select 1 from public.qorpera_claude_logins login
			where login.owner_user_id = p_user_id and login.status = 'active')
		and public.qorpera_company_home_allowed(p_profile_id), false)
$$;
revoke all on function public.qorpera_member_may_pick_claude(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_active_bundle_claude_choice()
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce((select bundle.manifest #>> '{modelPolicy,claudeChoice}' = 'thread'
		from public.qorpera_active_runtime_bundle active
		join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
		where active.singleton), false)
$$;
revoke all on function public.qorpera_active_bundle_claude_choice()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_pin_execution_claude_choice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_choice public.qorpera_session_models%rowtype; v_manifest jsonb;
begin
	if tg_op = 'UPDATE' then
		if (new.claude_model, new.claude_effort) is distinct from (old.claude_model, old.claude_effort) then
			raise exception 'Execution Claude choice is immutable' using errcode = '42501'; end if;
		return new;
	end if;
	new.claude_model := null;
	new.claude_effort := null;
	if new.source_kind in ('session_turn','room_delivery') and new.session_id is not null then
		v_manifest := public.qorpera_execution_runtime_manifest(new);
		if v_manifest #>> '{modelPolicy,claudeChoice}' = 'thread' then
			select * into v_choice from public.qorpera_session_models choice where choice.session_id = new.session_id;
			if v_choice.model_id in ('claude-fable-5-2','claude-opus-5-5')
				and public.qorpera_member_may_pick_claude(new.profile_id,
					coalesce(new.requested_by_user_id, new.created_by_user_id)) then
				new.claude_model := v_choice.model_id;
				new.claude_effort := coalesce(v_choice.reasoning_effort, v_manifest #>> '{modelPolicy,effort}', 'low');
			end if;
		end if;
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_pin_execution_claude_choice()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_execution_run_claude_choice
before insert or update of claude_model, claude_effort on public.qorpera_execution_runs
for each row execute function public.qorpera_pin_execution_claude_choice();

select pg_temp.cm_replace('public.qorpera_execution_run_model_authority()',
	$old$		where choice.session_id = new.session_id and choice.model_id is not null;$old$,
	$new$		where choice.session_id = new.session_id and choice.model_id is not null
			and choice.model_id not in ('claude-fable-5-2','claude-opus-5-5');$new$);

select pg_temp.cm_replace('public.qorpera_resolve_run_reasoning_effort(public.qorpera_execution_runs,jsonb)',
	$old$			from public.qorpera_session_models choice where choice.session_id = p_run.session_id;$old$,
	$new$			from public.qorpera_session_models choice where choice.session_id = p_run.session_id
				and coalesce(choice.model_id not in ('claude-fable-5-2','claude-opus-5-5'), true);$new$);

select pg_temp.cm_replace('public.qorpera_describe_company_run_context(jsonb)',
	$old$			else jsonb_build_object('serviceTier',v_run.service_tier) end$old$,
	$new$			else jsonb_build_object('serviceTier',v_run.service_tier) end
		|| case when v_run.claude_model is null then '{}'::jsonb
			else jsonb_build_object('claude',jsonb_build_object('model',v_run.claude_model,'effort',v_run.claude_effort)) end$new$);

select pg_temp.cm_replace('public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)',
	$old$			update public.qorpera_runtime_workers set harness = 'claude-code',
				claude_login_id = public.qorpera_claude_worker_login(p_profile_id, v_commit.requester_id)
			where id = v_worker.id returning * into v_worker;$old$,
	$new$			update public.qorpera_runtime_workers set harness = 'claude-code',
				claude_login_id = public.qorpera_claude_worker_login(p_profile_id, v_commit.requester_id),
				(claude_model, claude_effort) = (select run.claude_model, run.claude_effort
					from (select 1) as one left join public.qorpera_execution_runs run on run.id = v_commit.run_id)
			where id = v_worker.id returning * into v_worker;$new$);

select pg_temp.cm_replace('public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)',
	$old$			set claude_login_id = public.qorpera_claude_worker_login(p_profile_id, v_worker.requested_by_user_id)
			where id = v_worker.id returning * into v_worker;$old$,
	$new$			set claude_login_id = public.qorpera_claude_worker_login(p_profile_id, v_worker.requested_by_user_id),
				(claude_model, claude_effort) = (select coalesce(run.claude_model, v_worker.claude_model),
						case when run.claude_model is null then v_worker.claude_effort else run.claude_effort end
					from (select 1) as one left join public.qorpera_execution_runs run on run.id = v_commit.run_id)
			where id = v_worker.id returning * into v_worker;$new$);

select pg_temp.cm_replace('public.qorpera_folder_worker_dispatch_payload(public.qorpera_runtime_workers,public.qorpera_runtime_agent_todos)',
	$old$		|| case when p_worker.harness is null then '{}'::jsonb else jsonb_build_object('harness', p_worker.harness) end$old$,
	$new$		|| case when p_worker.harness is null then '{}'::jsonb else jsonb_build_object('harness', p_worker.harness) end
		|| case when p_worker.claude_model is null then '{}'::jsonb
			else jsonb_build_object('claude', jsonb_build_object('model', p_worker.claude_model, 'effort', p_worker.claude_effort)) end$new$);

select pg_temp.cm_replace('public.qorpera_get_session_model(uuid)',
	$old$			coalesce(v_choice.service_tier,'fast')) else '{}'::jsonb end;$old$,
	$new$			coalesce(v_choice.service_tier,'fast')) else '{}'::jsonb end
		|| jsonb_build_object('models', '["gpt-6-astra","gpt-6.1-sol"]'::jsonb
			|| case when v_policy ->> 'claudeChoice' = 'thread'
				and public.qorpera_member_may_pick_claude(v_session.profile_id, auth.uid())
				then '["claude-fable-5-2","claude-opus-5-5"]'::jsonb else '[]'::jsonb end);$new$);

create or replace function public.qorpera_set_session_model(
	p_session_id uuid,p_model_id text,p_expected_version bigint,p_reasoning_effort text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_choice public.qorpera_session_models%rowtype; v_user uuid; v_model text; v_effort text;
begin
	v_user := public.qorpera_session_model_writer(p_session_id);
	if (p_model_id is null and p_reasoning_effort is null)
		or (p_model_id is not null and p_model_id not in ('gpt-6-astra','gpt-6.1-sol','gpt-6-sol','gpt-6-luna',
			'claude-fable-5-2','claude-opus-5-5'))
		or (p_reasoning_effort is not null and p_reasoning_effort not in ('low','medium','high','xhigh','max'))
		or p_expected_version is null or p_expected_version < 0 then
		raise exception 'Conversation model is invalid' using errcode = '22023'; end if;
	select * into v_choice from public.qorpera_session_models where session_id = p_session_id;
	if coalesce(v_choice.version,0) <> p_expected_version then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code','QRC01',
			'message','Conversation model changed; refresh before retrying','details',null,'hint',null)::text,
			detail = '{"status":409,"headers":{}}'; end if;
	if p_model_id in ('claude-fable-5-2','claude-opus-5-5') and not (public.qorpera_active_bundle_claude_choice()
		and public.qorpera_member_may_pick_claude(
			(select session.profile_id from public.qorpera_shared_sessions session where session.id = p_session_id), v_user)) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code','QRC02',
			'message','Claude is not open for you in this company: sign in to Claude in Settings, Model accounts',
			'details',null,'hint',null)::text,
			detail = '{"status":403,"headers":{}}'; end if;
	v_model := coalesce(p_model_id, v_choice.model_id);
	v_effort := coalesce(p_reasoning_effort, v_choice.reasoning_effort);
	if v_effort in ('xhigh','max') and coalesce(v_model not in ('claude-fable-5-2','claude-opus-5-5'), true) then
		raise exception 'Conversation effort % needs a Claude model', v_effort using errcode = '22023'; end if;
	insert into public.qorpera_session_models(session_id,model_id,reasoning_effort,version,updated_by_user_id)
	values(p_session_id,v_model,v_effort,p_expected_version + 1,v_user)
	on conflict(session_id) do update set model_id = excluded.model_id,reasoning_effort = excluded.reasoning_effort,
		version = excluded.version,updated_by_user_id = excluded.updated_by_user_id,updated_at = clock_timestamp();
	return public.qorpera_get_session_model(p_session_id);
end $$;
