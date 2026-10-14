-- Summary trees M1b-4b-2 (RUNTIME-AGENT-MEMORY-TREE.md §4.2-§4.4, §7, §13): the conversation tree writer's SQL.
-- A run's memory commit without runLog writes only its own conversation tree, naming exactly its generation, and as
-- with its run log needs no folder grant there.
-- Two binding calls expose bounded raw events and record compaction costs per batch of an attempt. Neither enables
-- the runtime writer or lists a company in qorpera_memory_tree_companies.

set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_memory_compactions') is not null then
		raise exception 'M1b-4b-2 (20260930300000) is already applied'; end if;
	if to_regprocedure('public.qorpera_memory_run_log_paths(uuid,jsonb,text,text,jsonb,text)') is null
		or to_regprocedure('public.qorpera_memory_run_log_admits(uuid,text,jsonb,text,text,jsonb)') is null
		or to_regprocedure('public.qorpera_memory_conversation_root(uuid,uuid,uuid)') is null then
		raise exception 'M1b-4b-2 (20260930300000) needs W1b (20260930231000)'; end if;
end $$;

-- With no runLog, a run's memory commit writes only its own conversation's tree, under the root its owner gives (also
-- before the first tree.toml; a live index must agree by key), and every unit, even the empty root, names exactly that
-- conversation's generation. The units: mkdir of the root and of t0 to t14, writes of tree.toml and of
-- t<n>/<8 digits>.jsonl (§4.2). The commit has validated and locked the generations already. Null for such a unit;
-- otherwise the problem.
create function public.qorpera_memory_run_tree_problem(p_environment_id uuid, p_actor jsonb, p_op text, p_key text)
returns text language plpgsql stable set search_path = '' as $$
-- 20260930300000 (M1b-4b-2)
declare
	v_request jsonb := public.qorpera_folder_memory_request(); v_session uuid; v_root text; v_indexed_root text;
	v_generations jsonb; v_relative text;
begin
	if v_request is null or v_request #> '{preconditions,runLog}' is not null
		or p_actor ->> 'kind' is distinct from 'staff_agent'
		or coalesce(p_actor ->> 'runId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		return 'a run writes only its own run log'; end if;
	select r.session_id, public.qorpera_memory_conversation_root(r.environment_id, r.profile_id, r.session_id), t.root_key
	into v_session, v_root, v_indexed_root
	from public.qorpera_execution_runs r
	left join public.qorpera_memory_trees t
		on t.environment_id = r.environment_id and t.session_id = r.session_id and t.retired_at is null
	where r.id = (p_actor ->> 'runId')::uuid and r.environment_id = p_environment_id;
	v_generations := coalesce(v_request #> '{preconditions,sessionGenerations}', '[]'::jsonb);
	if v_session is null or v_root is null or (v_indexed_root is not null and v_indexed_root <> v_root)
		or jsonb_array_length(v_generations) <> 1 or v_generations #>> '{0,sessionId}' is distinct from v_session::text then
		return 'a run tree change names exactly its own conversation and generation'; end if;
	v_relative := case when p_key = v_root then ''
		when left(p_key, char_length(v_root) + 1) = v_root || '/' then substr(p_key, char_length(v_root) + 2) end;
	if (p_op = 'mkdir' and (v_relative = '' or v_relative ~ '^t([0-9]|1[0-4])$'))
		or (p_op = 'write' and (v_relative = 'tree.toml' or v_relative ~ '^t([0-9]|1[0-4])/[0-9]{8}\.jsonl$')) then
		return null; end if;
	return 'a run writes only its own conversation tree folders, tree.toml and blocks';
end $$;
revoke all on function public.qorpera_memory_run_tree_problem(uuid, jsonb, text, text)
	from public, anon, authenticated, service_role;

-- Preserve W1b's run-log rules. Only the former no-runLog refusal gains the conversation writer's narrow admission.
create or replace function public.qorpera_memory_run_log_paths(p_environment_id uuid, p_actor jsonb, p_op text, p_key text, p_unit jsonb,
	p_eff_path text)
returns jsonb language plpgsql stable set search_path = '' as $$
-- 20260930231000 (W1b)
declare
	v_request jsonb := public.qorpera_folder_memory_request(); v_log jsonb; v_run uuid; v_log_key text; v_touch record;
	v_root text; v_row public.qorpera_memory_run_logs%rowtype; v_gen public.qorpera_memory_run_generations%rowtype;
	v_home jsonb; v_problem text;
	v_own_log constant jsonb := jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
		public.qorpera_company_state_problem('value', null, null, 'a run writes only its own run log')));
begin
	if v_request is null then return null; end if;
	v_log := v_request -> 'preconditions' -> 'runLog';
	-- 20260930300000 (M1b-4b-2): with no runLog, a run writes only its own conversation's tree.
	if v_log is null and p_actor ->> 'kind' is distinct from 'platform' then
		v_problem := public.qorpera_memory_run_tree_problem(p_environment_id, p_actor, p_op, p_key);
		if v_problem is null then return null; end if;
		return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
			public.qorpera_company_state_problem('value', null, null, v_problem)));
	end if;
	if v_log is not null then
		v_run := (v_log ->> 'run')::uuid;
		v_log_key := public.qorpera_folder_key(v_log ->> 'path');
		if public.qorpera_memory_run_folder_key(v_log_key) is distinct from v_log_key
			or right(v_log_key, 42) <> '/runs/' || v_run::text then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, 'a run log''s folder is <tree>/runs/<its run>'))); end if;
		if p_actor ->> 'kind' is distinct from 'platform'
			and (p_actor ->> 'kind' is distinct from 'staff_agent' or p_actor ->> 'runId' is distinct from v_run::text) then
			return v_own_log; end if;
		if p_op = 'delete' and p_actor ->> 'kind' is distinct from 'platform' then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, 'only the platform deletes a run log''s files'))); end if;
	end if;
	for v_touch in select p_key as key
		union all
		select public.qorpera_folder_key(c.path)
		from public.qorpera_folder_spelled_contents(p_eff_path,
			case when p_op = 'new_folder' then p_unit -> 'contents' else '[]'::jsonb end) c
	loop
		if v_log is null then
			v_root := public.qorpera_memory_tree_root_key(v_touch.key);
			if v_root is not null and ltrim(substr(v_touch.key, char_length(v_root) + 1), '/') ~ '^runs(/|$)' then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'a run log''s change names its run (runLog)'))); end if;
		elsif v_touch.key <> v_log_key and left(v_log_key, char_length(v_touch.key) + 1) <> v_touch.key || '/'
			and left(v_touch.key, char_length(v_log_key) + 1) <> v_log_key || '/' then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, 'a run log''s change writes only its own log folder')));
		elsif left(v_touch.key, char_length(v_log_key) + 1) = v_log_key || '/'
			and substr(v_touch.key, char_length(v_log_key) + 2) ~ '^t([0-9]|1[0-4])(/|$)'
			and not exists (select 1 from jsonb_array_elements(coalesce(v_request -> 'preconditions' -> 'runGenerations',
				'[]'::jsonb)) g where g.value ->> 'runId' = v_run::text) then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, 'a run tree''s change names its run''s generation')));
		end if;
	end loop;
	if v_log is null then return null; end if;
	-- Where the log is, or where it goes.
	select * into v_row from public.qorpera_memory_run_logs l where l.environment_id = p_environment_id and l.run_id = v_run;
	if v_row.run_id is not null and v_row.retired_at is null then
		if v_row.run_key <> v_log_key then return jsonb_build_object('ok', false, 'reason', 'memory_run_log_moved'); end if;
		return null;
	end if;
	select * into v_gen from public.qorpera_memory_run_generations g where g.environment_id = p_environment_id and g.run_id = v_run;
	if v_row.run_id is not null or v_gen.log_created_at is not null then
		return jsonb_build_object('ok', false, 'reason', 'memory_run_log_gone'); end if;
	v_home := public.qorpera_memory_run_log_home(p_environment_id, v_run);
	if v_home is null then return jsonb_build_object('ok', false, 'reason', 'memory_run_log_gone'); end if;
	if (v_home ->> 'root') || '/runs/' || v_run::text <> v_log_key then
		return jsonb_build_object('ok', false, 'reason', 'memory_run_log_moved'); end if;
	return null;
end $$;
revoke all on function public.qorpera_memory_run_log_paths(uuid, jsonb, text, text, jsonb, text)
	from public, anon, authenticated, service_role;

-- A run writes its own conversation's tree as itself, as it writes its own run log: the tree is the platform's
-- (contract 5.6), so neither the member it works for nor its agent needs a grant there (§4.3). W1b's body, with the
-- no-runLog case added.
create or replace function public.qorpera_memory_run_log_admits(p_environment_id uuid, p_operation_key text, p_actor jsonb,
	p_op text, p_path text, p_unit jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
-- 20260930231000 (W1b)
declare v_request jsonb := public.qorpera_folder_memory_request(); v_run text; v_log_key text;
begin
	if v_request is null or v_request ->> 'environmentId' is distinct from p_environment_id::text
		or v_request ->> 'operationKey' is distinct from p_operation_key or p_op not in ('write','mkdir','new_folder') then
		return false; end if;
	-- 20260930300000 (M1b-4b-2): with no runLog, exactly the units the paths hook admits in the run's own tree.
	if v_request #> '{preconditions,runLog}' is null then
		return public.qorpera_memory_run_tree_problem(p_environment_id, p_actor, p_op, public.qorpera_folder_key(p_path)) is null;
	end if;
	v_run := v_request #>> '{preconditions,runLog,run}';
	if v_run is null or p_actor ->> 'kind' is distinct from 'staff_agent' or p_actor ->> 'runId' is distinct from v_run then
		return false; end if;
	v_log_key := public.qorpera_folder_key(v_request #>> '{preconditions,runLog,path}');
	if public.qorpera_memory_run_folder_key(v_log_key) is distinct from v_log_key or right(v_log_key, 42) <> '/runs/' || v_run then
		return false; end if;
	return not exists (select 1
		from (select public.qorpera_folder_key(p_path) as key
			union all
			select public.qorpera_folder_key(p_path || '/' || (c.value ->> 'path'))
			from jsonb_array_elements(case when p_op = 'new_folder' and jsonb_typeof(p_unit -> 'contents') = 'array'
				then p_unit -> 'contents' else '[]'::jsonb end) c) t
		where t.key is null or not (t.key = v_log_key or left(t.key, char_length(v_log_key) + 1) = v_log_key || '/'
			or (left(v_log_key, char_length(t.key) + 1) = t.key || '/' and t.key ~ '^agents/([^/]+|groups/[^/]+)/memory(/|$)')));
end $$;
revoke all on function public.qorpera_memory_run_log_admits(uuid, text, jsonb, text, text, jsonb)
	from public, anon, authenticated, service_role;

-- Raw included events [start,start+count), with the same sequence and eventHash as zoom and the level-0 validator.
-- This distinct native name leaves the internal qorpera_memory_events(uuid,bigint,integer) unexposed and unambiguous.
-- The request is exactly {session,start,count}; start is a nonnegative safe integer, count 1..128. No receipt stores
-- compactor input or output (§7.1). Its batch's generation precondition fences any intervening erase at commit.
create function public.qorpera_memory_events_run(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_start bigint; v_count integer;
begin
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs,
		public.qorpera_folder_tool_run(p_binding, '[]'::jsonb) -> 'run');
	if jsonb_typeof(p_request) is distinct from 'object' then
		raise exception 'memory events request is malformed' using errcode = '22023'; end if;
	if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_request) k)
		is distinct from array['count','session','start'] then
		raise exception 'memory events request is malformed' using errcode = '22023'; end if;
	if jsonb_typeof(p_request -> 'session') <> 'string'
		or (p_request ->> 'session') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		or jsonb_typeof(p_request -> 'start') <> 'number' or (p_request ->> 'start') !~ '^(0|[1-9][0-9]{0,15})$'
		or jsonb_typeof(p_request -> 'count') <> 'number' or (p_request ->> 'count') !~ '^[1-9][0-9]{0,2}$' then
		raise exception 'memory events request is malformed' using errcode = '22023'; end if;
	v_start := (p_request ->> 'start')::bigint; v_count := (p_request ->> 'count')::integer;
	if v_start > 9007199254740991 or v_count > 128 then
		raise exception 'memory events request is malformed' using errcode = '22023'; end if;
	if p_request ->> 'session' is distinct from v_run.session_id::text
		or public.qorpera_memory_conversation_root(v_run.environment_id, v_run.profile_id, v_run.session_id) is null then
		raise exception 'A run reads only its own conversation for compaction' using errcode = '42501'; end if;
	return public.qorpera_memory_events(v_run.session_id, v_start, v_count);
end $$;
revoke all on function public.qorpera_memory_events_run(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_memory_events_run(jsonb, jsonb) to service_role;

-- Counts only: no model input, output, prompt, summary or receipt. A batch id is local to an assignment, so settle,
-- closing and run-step batches can all be recorded without treating another attempt's batch as a replay.
create table public.qorpera_memory_compactions (
	run_id uuid not null references public.qorpera_execution_runs(id) on delete cascade,
	assignment_id uuid not null,
	batch integer not null check (batch >= 0),
	profile_id uuid not null,
	environment_id uuid not null,
	staff_agent_id uuid not null,
	session_id uuid,
	kind text not null check (kind in ('conversation','run')),
	calls integer not null check (calls >= 0),
	free integer not null check (free >= 0),
	input bigint not null check (input >= 0),
	cached bigint not null check (cached >= 0),
	output bigint not null check (output >= 0),
	overshoots integer not null check (overshoots >= 0),
	failures integer not null check (failures >= 0),
	stopped text check (stopped in ('usage-limit','rate-limit','outage')),
	-- Derived from this run's pinned sponsor version, never from the recording request. No new payer is selected.
	payer_connection_id uuid,
	recorded_at timestamptz not null default clock_timestamp(),
	primary key (run_id, assignment_id, batch)
);
alter table public.qorpera_memory_compactions enable row level security;
revoke all on public.qorpera_memory_compactions from public, anon, authenticated, service_role;
grant select on public.qorpera_memory_compactions to service_role;
comment on table public.qorpera_memory_compactions is
	'Summary trees (RUNTIME-AGENT-MEMORY-TREE.md §13): one memory_compaction count record per batch of a run attempt, '
	'with its own payer connection, no model content. Written by qorpera_memory_compaction_record.';

-- Closed {batch,kind,calls,free,input,cached,output,overshoots,failures,stopped}, matching MemoryCompactStats plus its
-- per-attempt batch number. Counts 0..999,999,999; stopped is null or the MemoryCompactStop reason. Run check first,
-- then malformed 22023; the same batch replays its answer, changed content refuses 23505. Returned payer is the saved
-- row's: replay cannot acquire the payer of a later attempt or of a changed sponsor setting.
create function public.qorpera_memory_compaction_record(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_tool jsonb; v_run public.qorpera_execution_runs%rowtype; v_assignment uuid; v_key text; v_payer uuid;
	v_row public.qorpera_memory_compactions%rowtype;
begin
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	v_assignment := (v_tool #>> '{actor,assignmentId}')::uuid;
	if jsonb_typeof(p_request) is distinct from 'object' then
		raise exception 'memory compaction record is malformed' using errcode = '22023'; end if;
	if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_request) k)
		is distinct from array['batch','cached','calls','failures','free','input','kind','output','overshoots','stopped'] then
		raise exception 'memory compaction record is malformed' using errcode = '22023'; end if;
	foreach v_key in array array['batch','calls','free','input','cached','output','overshoots','failures'] loop
		if jsonb_typeof(p_request -> v_key) <> 'number' or (p_request ->> v_key) !~ '^(0|[1-9][0-9]{0,8})$' then
			raise exception 'memory compaction record is malformed' using errcode = '22023'; end if;
	end loop;
	if jsonb_typeof(p_request -> 'kind') <> 'string' or p_request ->> 'kind' not in ('conversation','run') then
		raise exception 'memory compaction record is malformed' using errcode = '22023'; end if;
	if p_request -> 'stopped' <> 'null'::jsonb then
		if jsonb_typeof(p_request -> 'stopped') <> 'string'
			or p_request ->> 'stopped' not in ('usage-limit','rate-limit','outage') then
			raise exception 'memory compaction record is malformed' using errcode = '22023'; end if;
	end if;
	select s.provider_connection_id into v_payer from public.qorpera_execution_sponsor_versions s
	where s.binding_id = v_run.sponsor_binding_id and s.version = v_run.sponsor_version;
	insert into public.qorpera_memory_compactions(run_id, assignment_id, batch, profile_id, environment_id, staff_agent_id,
		session_id, kind, calls, free, input, cached, output, overshoots, failures, stopped, payer_connection_id)
	values (v_run.id, v_assignment, (p_request ->> 'batch')::integer, v_run.profile_id, v_run.environment_id,
		v_run.staff_agent_id, v_run.session_id, p_request ->> 'kind', (p_request ->> 'calls')::integer,
		(p_request ->> 'free')::integer, (p_request ->> 'input')::bigint, (p_request ->> 'cached')::bigint,
		(p_request ->> 'output')::bigint, (p_request ->> 'overshoots')::integer, (p_request ->> 'failures')::integer,
		p_request ->> 'stopped', v_payer)
	on conflict (run_id, assignment_id, batch) do nothing;
	select * into strict v_row from public.qorpera_memory_compactions c
	where c.run_id = v_run.id and c.assignment_id = v_assignment and c.batch = (p_request ->> 'batch')::integer;
	if jsonb_build_object('batch', v_row.batch, 'kind', v_row.kind, 'calls', v_row.calls, 'free', v_row.free,
		'input', v_row.input, 'cached', v_row.cached, 'output', v_row.output, 'overshoots', v_row.overshoots,
		'failures', v_row.failures, 'stopped', v_row.stopped) <> p_request then
		raise exception 'memory compaction batch was recorded otherwise' using errcode = '23505'; end if;
	return jsonb_build_object('schema', 'qorpera.memory-compaction-record/v1', 'batch', v_row.batch,
		'payerConnectionId', v_row.payer_connection_id);
end $$;
revoke all on function public.qorpera_memory_compaction_record(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_memory_compaction_record(jsonb, jsonb) to service_role;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_memory_events_run', 'binding'),
	('qorpera_memory_compaction_record', 'binding');
