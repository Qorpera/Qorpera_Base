do $$ begin
	if exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.qorpera_runtime_workers'::regclass
		and attname = 'harness_default' and not attisdropped) then
		raise exception '20260930787000 is already applied'; end if;
	if to_regprocedure('public.qorpera_claude_worker_problem(uuid,uuid,uuid)') is null
		or to_regprocedure('public.qorpera_claude_worker_on_home(public.qorpera_company_machines,uuid,uuid)') is null
		or not exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.qorpera_runtime_workers'::regclass
			and attname = 'claude_model' and not attisdropped) then
		raise exception '20260930787000 needs Claude Code workers (20260930770000, 20260930772000) and conversation models (20260930784000)';
	end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.cf_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930787000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

alter table public.qorpera_runtime_workers
	add column harness_default boolean not null default false,
	add column claude_fallback_sequence integer,
	add constraint qorpera_runtime_workers_harness_default check (not harness_default or species = 'in-house'),
	add constraint qorpera_runtime_workers_claude_fallback check (claude_fallback_sequence is null
		or (harness_default and claude_fallback_sequence between 1 and sequence));

alter table public.qorpera_runtime_worker_events
	drop constraint qorpera_runtime_worker_events_kind_check,
	add constraint qorpera_runtime_worker_events_kind_check check (kind in ('dispatched','followup','reported','ended',
		'cancelled','accepted','rejected','undeliverable','fell_back'));

create function public.qorpera_claude_worker_default_login(p_profile_id uuid, p_staff_agent_id uuid, p_run_id uuid,
	p_member_user_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
	select login.id from public.qorpera_claude_logins login
	where login.owner_user_id = p_member_user_id and login.status = 'active'
		and p_member_user_id = (select run.requested_by_user_id from public.qorpera_execution_runs run where run.id = p_run_id)
		and public.qorpera_claude_sign_in_open(p_profile_id, p_member_user_id)
		and public.qorpera_claude_worker_problem(p_profile_id, p_staff_agent_id, p_run_id) is null
$$;
revoke all on function public.qorpera_claude_worker_default_login(uuid, uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_claude_worker_resolve(p_worker_id uuid, p_run_id uuid, p_requester_user_id uuid)
returns public.qorpera_runtime_workers language plpgsql security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype; v_login uuid; v_run public.qorpera_execution_runs%rowtype;
begin
	select * into strict v_worker from public.qorpera_runtime_workers where id = p_worker_id;
	if not v_worker.harness_default then
		raise exception 'Only a worker whose brief names no harness is resolved' using errcode = '22023'; end if;
	select * into v_run from public.qorpera_execution_runs where id = p_run_id;
	if v_worker.species = 'in-house' and v_worker.access = 'write'
		and v_worker.requested_by_user_id is not distinct from p_requester_user_id then
		v_login := public.qorpera_claude_worker_default_login(v_worker.profile_id, v_worker.staff_agent_id, p_run_id,
			p_requester_user_id);
	end if;
	update public.qorpera_runtime_workers
	set harness = case when v_login is null then null else 'claude-code' end, claude_login_id = v_login,
		claude_model = case when v_login is null then null else coalesce(v_run.claude_model, v_worker.claude_model) end,
		claude_effort = case when v_login is null then null
			when v_run.claude_model is null then v_worker.claude_effort else v_run.claude_effort end
	where id = v_worker.id returning * into v_worker;
	return v_worker;
end $$;
revoke all on function public.qorpera_claude_worker_resolve(uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.cf_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$			and p_parse -> 'harness' is distinct from '"claude-code"'::jsonb then$old$,
	$new$			and p_parse -> 'harness' not in ('"claude-code"'::jsonb, '"codex"'::jsonb) then$new$);

select pg_temp.cf_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$or (v_request ? 'harness' and v_request -> 'harness' is distinct from '"claude-code"'::jsonb))) then$old$,
	$new$or (v_request ? 'harness' and v_request -> 'harness' not in ('"claude-code"'::jsonb, '"codex"'::jsonb)))) then$new$);

select pg_temp.cf_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$elsif v_species = 'in-house' and v_request ? 'harness' and v_request ->> 'access' is distinct from 'write' then$old$,
	$new$elsif v_species = 'in-house' and v_request ->> 'harness' = 'claude-code' and v_request ->> 'access' is distinct from 'write' then$new$);

select pg_temp.cf_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$elsif v_species = 'in-house' and v_request ? 'harness'
				and public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id) is not null then$old$,
	$new$elsif v_species = 'in-house' and v_request ->> 'harness' = 'claude-code'
				and public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id) is not null then$new$);

select pg_temp.cf_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$elsif v_worker.harness = 'claude-code'
				and v_worker.requested_by_user_id is distinct from (p_actor ->> 'requesterUserId')::uuid then$old$,
	$new$elsif v_worker.harness = 'claude-code' and not v_worker.harness_default
				and v_worker.requested_by_user_id is distinct from (p_actor ->> 'requesterUserId')::uuid then$new$);

select pg_temp.cf_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$elsif v_worker.harness = 'claude-code'
				and public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id) is not null then$old$,
	$new$elsif v_worker.harness = 'claude-code' and not v_worker.harness_default
				and public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id) is not null then$new$);

select pg_temp.cf_replace('public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$			where id = v_worker.id returning * into v_worker;
		end if;
		insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
		values (v_worker.id, v_worker.sequence, 'dispatched'$old$,
	$new$			where id = v_worker.id returning * into v_worker;
		elsif p_parse ->> 'species' = 'in-house' and not p_parse ? 'harness' then
			update public.qorpera_runtime_workers set harness_default = true where id = v_worker.id;
			v_worker := public.qorpera_claude_worker_resolve(v_worker.id, v_commit.run_id, v_commit.requester_id);
		end if;
		insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
		values (v_worker.id, v_worker.sequence, 'dispatched'$new$);

select pg_temp.cf_replace('public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$		if v_worker.harness = 'claude-code' then
			update public.qorpera_runtime_workers
			set claude_login_id$old$,
	$new$		if v_worker.harness_default then
			v_worker := public.qorpera_claude_worker_resolve(v_worker.id, v_commit.run_id, v_commit.requester_id);
		elsif v_worker.harness = 'claude-code' then
			update public.qorpera_runtime_workers
			set claude_login_id$new$);

select pg_temp.cf_replace('public.qorpera_folder_workers_company(uuid,integer)'::regprocedure,
	$old$'worker-dispatch:' || v_worker.id::text || ':' || v_worker.sequence::text, clock_timestamp(), clock_timestamp(),$old$,
	$new$'worker-dispatch:' || v_worker.id::text || ':' || v_worker.sequence::text
							|| case when v_worker.claude_fallback_sequence = v_worker.sequence then ':codex' else '' end,
							clock_timestamp(), clock_timestamp(),$new$);

create function public.qorpera_claude_worker_fall_back(p_binding jsonb, p_reason text, p_changed jsonb)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_worker public.qorpera_runtime_workers%rowtype; v_targets jsonb := '[]'::jsonb; v_tool jsonb;
	v_run public.qorpera_execution_runs%rowtype; v_words text; v_note text; v_member text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Claude Code worker fallback is the runtime''s' using errcode = '42501'; end if;
	if p_reason is null or p_reason not in ('signed_out','not_open','limit','could_not_start')
		or jsonb_typeof(p_changed) is distinct from 'array' or jsonb_array_length(p_changed) > 8
		or exists (select 1 from jsonb_array_elements(p_changed) path where jsonb_typeof(path) <> 'string'
			or char_length(path #>> '{}') not between 1 and 256 or (path #>> '{}') ~ E'[\\r\\n]') then
		raise exception 'Claude Code worker fallback is invalid' using errcode = '22023'; end if;
	if coalesce(p_binding ->> 'runId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		v_worker := public.qorpera_run_worker((p_binding ->> 'runId')::uuid);
	end if;
	if v_worker.id is not null then
		v_targets := jsonb_build_array(
			jsonb_build_object('rank', 5, 'tbl', 'qorpera_runtime_agent_todos', 'key', v_worker.todo_id::text, 'mode', 'share',
				'required', false),
			jsonb_build_object('rank', 5, 'tbl', 'qorpera_runtime_workers', 'key', v_worker.id::text, 'mode', 'nokeyupdate',
				'required', false));
	end if;
	v_tool := public.qorpera_folder_tool_run(p_binding, v_targets);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	select worker.* into v_worker from public.qorpera_runtime_workers worker
	where worker.id = (public.qorpera_run_worker(v_run.id)).id;
	if v_worker.claude_fallback_sequence = v_worker.sequence and exists (select 1 from public.qorpera_runtime_worker_events event
		where event.worker_id = v_worker.id and event.sequence = v_worker.sequence and event.kind = 'fell_back'
			and event.run_id = v_run.id) then
		return jsonb_build_object('schema', 'qorpera.claude-worker-fallback/v1', 'state', 'fell_back');
	end if;
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_worker.id is null or v_worker.species is distinct from 'in-house' or v_worker.harness is distinct from 'claude-code'
		or not v_worker.harness_default or v_worker.state is distinct from 'active' or v_worker.folder_retired_at is not null
		or not exists (select 1 from public.qorpera_wake_occurrences wake
			where wake.id = v_worker.occurrence_id and wake.run_id = v_run.id) then
		return jsonb_build_object('schema', 'qorpera.claude-worker-fallback/v1', 'state', 'kept');
	end if;
	v_member := public.qorpera_claude_worker_member_name(v_worker.profile_id, v_worker.requested_by_user_id);
	v_words := case p_reason
		when 'signed_out' then format('%s''s Claude sign-in had ended', v_member)
		when 'not_open' then format('Claude Code was not open for %s', v_member)
		when 'limit' then format('%s''s Claude plan reached its limit', v_member)
		else 'Claude Code could not start' end;
	if jsonb_array_length(p_changed) > 0 then
		v_note := format('Claude Code started this work and stopped before it finished (%s). It changed: %s. Read those '
			|| 'files first and carry on from where it stopped.', v_words,
			(select string_agg(path #>> '{}', ', ' order by ordinality) from jsonb_array_elements(p_changed)
				with ordinality as changed(path, ordinality)));
	end if;
	update public.qorpera_runtime_workers
	set harness = null, claude_login_id = null, claude_model = null, claude_effort = null, occurrence_id = null,
		claude_fallback_sequence = sequence, updated_at = clock_timestamp(),
		dispatch = case when v_note is null then dispatch
			else jsonb_set(dispatch, '{context}', to_jsonb(concat_ws(E'\n\n', nullif(dispatch ->> 'context', ''), v_note))) end
	where id = v_worker.id returning * into v_worker;
	insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
	values (v_worker.id, v_worker.sequence, 'fell_back', v_run.id,
		jsonb_build_object('reason', p_reason, 'words', v_words, 'changed', p_changed));
	return jsonb_build_object('schema', 'qorpera.claude-worker-fallback/v1', 'state', 'fell_back');
end $$;
revoke all on function public.qorpera_claude_worker_fall_back(jsonb, text, jsonb)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_claude_worker_fall_back(jsonb, text, jsonb) to service_role;
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_claude_worker_fall_back', 'binding');

do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
		'public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'A Claude-first function has an API owner'; end if;
		if v_owner is distinct from current_user then
			execute format('grant execute on function public.qorpera_claude_worker_default_login(uuid, uuid, uuid, uuid), '
				'public.qorpera_claude_worker_resolve(uuid, uuid, uuid) to %I', v_owner);
		end if;
	end loop;
end $$;
