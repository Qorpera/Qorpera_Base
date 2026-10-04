-- @fixture 707_folder_state_todos.test.sql until "-- 1. The company, two agents, and a todo"
-- Company state files, F2-6 (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2, §4): routines on the folder core.
-- A routine file is a routine row and its versions, owned by the agent whose folder holds it. A new version comes only
-- when what a run pins changes, paid by the saver's own login, at the position the 2026-09-25 rules give; the file's
-- status is the saver's word when a save changes it; a dynamic routine's own run decides it, never pauses or removes it,
-- and its decision is not reviewed. Races are in 709.

-- Logins: the owner's, which pays for unattended work, and the member's (…02), which does not. Foreign keys and triggers are off only while the rows go in.
set local session_replication_role = replica;
insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider, created_by_user_id) values
	('70800000-0000-4000-8000-0000000000c1', '70700000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'70700000-0000-4000-8000-000000000001', 'openai', '70700000-0000-4000-8000-000000000001'),
	('70800000-0000-4000-8000-0000000000c2', '70700000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'70700000-0000-4000-8000-000000000002', 'openai', '70700000-0000-4000-8000-000000000002');
insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness, billing_source,
	consent_version, consented_by_user_id, allow_autonomous, created_by_user_id, credential_capsule_id, max_native_concurrency,
	quota_policy)
select c.id, 1, 'native_subscription', 'codex-cli', 'personal-subscription', 'fixture', c.owner, c.allow, c.owner,
	extensions.gen_random_uuid(), 1, '{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,'
		'"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}'
from (values ('70800000-0000-4000-8000-0000000000c1'::uuid, '70700000-0000-4000-8000-000000000001'::uuid, true),
	('70800000-0000-4000-8000-0000000000c2'::uuid, '70700000-0000-4000-8000-000000000002'::uuid, false)) c(id, owner, allow);
insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id) values
	('70800000-0000-4000-8000-0000000000b1', '70700000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'70700000-0000-4000-8000-000000000001'),
	('70800000-0000-4000-8000-0000000000b2', '70700000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'70700000-0000-4000-8000-000000000002');
insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id, provider_connection_version,
	allow_autonomous, created_by_user_id) values
	('70800000-0000-4000-8000-0000000000b1', 1, 'member_connection', '70800000-0000-4000-8000-0000000000c1', 1, true,
		'70700000-0000-4000-8000-000000000001'),
	('70800000-0000-4000-8000-0000000000b2', 1, 'member_connection', '70800000-0000-4000-8000-0000000000c2', 1, true,
		'70700000-0000-4000-8000-000000000002');
set local session_replication_role = origin;

-- A routine's parse as the TS parser returns it; p_extra overrides keys.
create function pg_temp.rparse(p_id uuid, p_title text, p_trigger jsonb, p_extra jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('kind','routine','id',p_id,'title',p_title,'status','active','trigger',p_trigger,
		'timezone',case when p_trigger ->> 'when' = 'every' then null else 'Europe/Copenhagen' end,'ends',null,'runs',null,'quiet',null,
		'effort','medium','reply','optional','conclusion',null,'instructions','Look at the inbox.') || p_extra
$$;
-- The file's text only has to match its staged bytes here; the parse is what the platform checks.
create function pg_temp.routine(p_path text, p_parse jsonb) returns jsonb language sql as $$
	select pg_temp.write(p_path, 'routine', E'---\n' || p_parse::text || E'\n---\n', p_parse, pg_temp.version(p_path))
$$;
create function pg_temp.every(p_minutes integer default 60, p_starts text default null) returns jsonb language sql as $$
	select jsonb_build_object('when','every','minutes',p_minutes,'starts',p_starts)
$$;
create function pg_temp.once(p_at text) returns jsonb language sql as $$
	select jsonb_build_object('when','once','at',p_at)
$$;
create function pg_temp.rt(p_id uuid) returns public.qorpera_cloud_routines language sql as $$
	select * from public.qorpera_cloud_routines where id = p_id
$$;
create function pg_temp.rv(p_id uuid) returns public.qorpera_cloud_routine_versions language sql as $$
	select v.* from public.qorpera_cloud_routine_versions v join public.qorpera_cloud_routines r on r.id = v.routine_id
	where r.id = p_id and v.version = r.current_version
$$;
create function pg_temp.cursor(p_id uuid) returns public.qorpera_cloud_routine_schedule_cursors language sql as $$
	select c.* from public.qorpera_cloud_routine_schedule_cursors c join public.qorpera_cloud_routines r on r.id = c.routine_id
	where r.id = p_id and c.routine_version = r.current_version
$$;
create function pg_temp.problem(p_result jsonb) returns text language sql as $$
	select p_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message'
$$;
-- Changes a fixture row with foreign keys and triggers off.
create function pg_temp.fx(p_sql text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute p_sql;
	set local session_replication_role = origin;
end $$;
-- A leased run of a routine's current version, as the scheduler starts it: the run actor.
create function pg_temp.routine_run(p_routine uuid) returns jsonb language plpgsql as $$
declare
	v_profile uuid := '70700000-0000-4000-8000-000000000010'; v_env uuid := '70700000-0000-4000-8000-000000000020';
	v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid(); v_wake uuid := extensions.gen_random_uuid();
	v_runner uuid := extensions.gen_random_uuid(); v_assignment uuid := extensions.gen_random_uuid();
	v_version public.qorpera_cloud_routine_versions := pg_temp.rv(p_routine); v_staff bigint;
begin
	select version into v_staff from public.qorpera_profile_staff where profile_id = v_profile and staff_agent_id = v_version.staff_agent_id;
	set local session_replication_role = replica;
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		v_version.created_by_user_id, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids)
	values (v_run, v_profile, v_env, 'wake', v_wake, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		v_version.staff_agent_id, v_staff, v_version.sponsor_binding_id, v_version.sponsor_version, 'agent_turn', 'agent_turn',
		repeat('c', 64), 0, v_version.created_by_user_id, v_version.created_by_user_id, 'openai', 'gpt-test', 'provider_default',
		'company', extensions.gen_random_uuid(), repeat('b', 64), null, '{}');
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id, routine_version, trigger_id, occurrence_key,
		scheduled_for, not_before, wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id,
		sponsor_binding_id, sponsor_version, causal_root_id, causal_agent_ids, causal_hop_count, payload)
	values (v_wake, v_profile, v_env, p_routine, v_version.version, 'file', v_wake::text, clock_timestamp(), clock_timestamp(), 'routine',
		'schedule', p_routine, v_run, 'materialized', v_version.staff_agent_id, v_staff, v_version.created_by_user_id,
		v_version.sponsor_binding_id, v_version.sponsor_version, v_wake, array[v_version.staff_agent_id], 0, '{}');
	set local session_replication_role = origin;
	return jsonb_build_object('kind','run','runId',v_run,'jobId',v_job,'runnerId',v_runner,'assignmentId',v_assignment);
end $$;
-- A slot the scheduler queued for a routine's current version (it counts toward runs).
create function pg_temp.occurred(p_routine uuid) returns void language plpgsql as $$
declare v_version public.qorpera_cloud_routine_versions := pg_temp.rv(p_routine); v_wake uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id, routine_version, trigger_id, occurrence_key,
		scheduled_for, not_before, wake_kind, source_kind, source_id, status, staff_agent_id, staff_version, requested_by_user_id,
		sponsor_binding_id, sponsor_version, causal_root_id, causal_agent_ids, causal_hop_count, payload)
	values (v_wake, v_version.profile_id, v_version.environment_id, p_routine, v_version.version, 'file', v_wake::text, clock_timestamp(),
		clock_timestamp(), 'routine', 'schedule', p_routine, 'queued', v_version.staff_agent_id, 1, v_version.created_by_user_id,
		v_version.sponsor_binding_id, v_version.sponsor_version, v_wake, array[v_version.staff_agent_id], 0, '{}');
	set local session_replication_role = origin;
end $$;
-- A run's change set with an allowed review, as an owner's "Allow" leaves it.
create function pg_temp.reviewed(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
declare v_review uuid;
begin
	insert into public.qorpera_folder_reviews(environment_id, run_id, change_set_sha256, units, decision)
	values ('70700000-0000-4000-8000-000000000020', (p_actor ->> 'runId')::uuid, public.qorpera_folder_change_set_sha256(p_units),
		array(select generate_series(1, jsonb_array_length(p_units))), 'allow')
	returning id into v_review;
	perform pg_temp.possess('70700000-0000-4000-8000-000000000020', p_actor, p_units);
	return public.qorpera_folder_commit('70700000-0000-4000-8000-000000000020', p_actor, p_key, p_units, v_review);
end $$;
create function pg_temp.del(p_path text) returns jsonb language sql as $$
	select jsonb_build_object('op','delete','path',p_path,'expectedVersion',pg_temp.version(p_path),'asOfSeq',pg_temp.seq())
$$;
create function pg_temp.review_class(p_actor jsonb, p_unit jsonb) returns text language sql as $$
	select public.qorpera_folder_structured_review_class('70700000-0000-4000-8000-000000000020',
		public.qorpera_folder_run_resolve('70700000-0000-4000-8000-000000000020', '70700000-0000-4000-8000-000000000010', p_actor)
			- 'lockTargets' - 'attribution', p_unit, p_unit ->> 'path', null)
$$;

-- A hire with its routines, as one unit: p_routines is [[name, parse], ...].
create function pg_temp.hire_routines(p_handle text, p_id uuid, p_routines jsonb) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		-- The routines come first, so the agent they need is indexed in the same unit only if apply orders them after it.
		'contents', jsonb_build_array(jsonb_build_object('path','routines','kind','folder'))
			|| (select jsonb_agg(jsonb_build_object('path','routines/' || (t ->> 0) || '.md','kind','file',
				'file',pg_temp.stage(E'---\n' || (t -> 1)::text || E'\n---\n'))) from jsonb_array_elements(p_routines) t)
			|| jsonb_build_array(jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_handle)))),
		'structured', (select jsonb_agg(pg_temp.entry('agents/' || p_handle || '/routines/' || (t ->> 0) || '.md', 'routine',
				E'---\n' || (t -> 1)::text || E'\n---\n', t -> 1)) from jsonb_array_elements(p_routines) t)
			|| jsonb_build_array(pg_temp.entry('agents/' || p_handle || '/agent.md', 'agent', pg_temp.agent_text(p_id, p_handle),
				pg_temp.agent_parse(p_id, p_handle))))
$$;
-- A parse the platform reads differently from its rules: refused, naming the field.
create function pg_temp.misread(p_key text, p_parse jsonb, p_field text) returns void language plpgsql as $$
declare r jsonb := pg_temp.commit(pg_temp.owner(), p_key, jsonb_build_array(pg_temp.routine('agents/nora/routines/misread.md', p_parse)));
begin
	if not pg_temp.refused(r, 'structured_invalid')
		or pg_temp.problem(r) is distinct from 'the platform read this file differently from its rules (' || p_field || ')' then
		raise exception 'Expected % to be misread: %', p_field, r; end if;
end $$;

-- 1. The company and two agents ------------------------------------------------------------------------------------------

do $$
declare r jsonb; i integer;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Routines'),
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', '70700000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder')));
	for i in 1..5 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit(pg_temp.owner(), 'hire-0001', jsonb_build_array(pg_temp.hire('nora', '70700000-0000-4000-8000-0000000000a1', 'Nora'),
		pg_temp.hire('otto', '70700000-0000-4000-8000-0000000000a2', 'Otto')));
	for i in 1..2 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit(pg_temp.owner(), 'mkdir-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','agents/nora/routines'), jsonb_build_object('op','mkdir','path','agents/otto/routines')));
	for i in 1..2 loop perform pg_temp.expect(r, i, 'saved'); end loop;
end $$;

-- 2. A member's routine: its row, its version and its position --------------------------------------------------------------

do $$
declare t jsonb; x public.qorpera_cloud_routines; v public.qorpera_cloud_routine_versions; c public.qorpera_cloud_routine_schedule_cursors;
	e1 constant uuid := '70800000-0000-4000-8000-0000000000e1';
	u jsonb := pg_temp.routine('agents/nora/routines/inbox.md', pg_temp.rparse('70800000-0000-4000-8000-0000000000e1', 'Inbox', pg_temp.every()));
begin
	-- A new routine's save takes the company row only, at rank 0 (20260928259230).
	select coalesce(jsonb_agg(to_jsonb(y)), '[]'::jsonb) into t
	from public.qorpera_folder_structured_targets('70700000-0000-4000-8000-000000000020', pg_temp.owner(), jsonb_build_array(u)) y;
	if t is distinct from '[{"rank":0,"tbl":"qorpera_profiles","key":"70700000-0000-4000-8000-000000000010","mode":"keyshare"}]' then
		raise exception 'A new routine locks the company row only: %', t; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'routine-0001', jsonb_build_array(u)), 1, 'saved');
	x := pg_temp.rt(e1); v := pg_temp.rv(e1); c := pg_temp.cursor(e1);
	if x.origin is distinct from 'member' or x.owner_staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a1'
		or x.routine_key is distinct from 'inbox' or x.status is distinct from 'active' or x.pause_reason is not null
		or x.client_routine_id is distinct from e1 or x.created_by_user_id is distinct from '70700000-0000-4000-8000-000000000001'
		or x.current_version is distinct from 1::bigint or x.folder_path is distinct from 'agents/nora/routines/inbox.md'
		or x.folder_path_version is distinct from pg_temp.version('agents/nora/routines/inbox.md') or x.folder_retired_at is not null
		or x.expires_at is not null or x.max_occurrences is not null or x.quiet_start is not null then
		raise exception 'A routine file is a routine of the agent whose folder holds it: %', to_jsonb(x); end if;
	if v.staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a1' or v.title is distinct from 'Inbox'
		or v.prompt is distinct from 'Look at the inbox.' or v.effort is distinct from 'medium'
		or v.triggers is distinct from '[{"id":"file","kind":"schedule","intervalMinutes":60,"replyPolicy":"optional"}]'
		or v.sponsor_binding_id is distinct from '70800000-0000-4000-8000-0000000000b1' or v.sponsor_version is distinct from 1::bigint
		or v.created_by_user_id is distinct from '70700000-0000-4000-8000-000000000001'
		or v.content_sha256 is distinct from public.qorpera_company_state_routine_sha(v.staff_agent_id, v.title, v.prompt, v.triggers,
			v.effort, v.sponsor_binding_id, v.sponsor_version) then
		raise exception 'Its version is what a run pins, paid by the saver''s login: %', to_jsonb(v); end if;
	if c.trigger_id is distinct from 'file' or c.last_scheduled_for is not null or c.next_due_at is distinct from '-infinity'::timestamptz then
		raise exception 'A new routine starts at a fresh position: %', to_jsonb(c); end if;
	-- Its edit takes its row at rank 5 as well, and so does a move of a folder that holds it.
	select coalesce(jsonb_agg(to_jsonb(y)), '[]'::jsonb) into t
	from public.qorpera_folder_structured_targets('70700000-0000-4000-8000-000000000020', pg_temp.owner(), jsonb_build_array(
		pg_temp.routine('agents/nora/routines/inbox.md', pg_temp.rparse(e1, 'Inbox!', pg_temp.every())))) y;
	if t is distinct from '[{"rank":0,"tbl":"qorpera_profiles","key":"70700000-0000-4000-8000-000000000010","mode":"keyshare"},
			{"rank":5,"tbl":"qorpera_cloud_routines","key":"70800000-0000-4000-8000-0000000000e1","mode":"nokeyupdate"}]' then
		raise exception 'A routine edit locks its row at rank 5: %', t; end if;
	select coalesce(jsonb_agg(to_jsonb(y)), '[]'::jsonb) into t
	from public.qorpera_folder_structured_targets('70700000-0000-4000-8000-000000000020', pg_temp.owner(),
		jsonb_build_array(pg_temp.move('agents/nora/routines', 'agents/nora/routines-old'))) y;
	if t is distinct from '[{"rank":0,"tbl":"qorpera_profiles","key":"70700000-0000-4000-8000-000000000010","mode":"keyshare"},
			{"rank":5,"tbl":"qorpera_cloud_routines","key":"70800000-0000-4000-8000-0000000000e1","mode":"nokeyupdate"}]' then
		raise exception 'A moved folder locks its routines: %', t; end if;
end $$;

-- 3. What a run pins makes a version, paid by the saver; the rest is the row's; positions follow the 2026-09-25 rules ---------

do $$
declare x public.qorpera_cloud_routines; c public.qorpera_cloud_routine_schedule_cursors; v_at timestamptz;
	e1 constant uuid := '70800000-0000-4000-8000-0000000000e1';
begin
	-- The member has no login that pays for unattended work: they pause the routine, limit it and move its quiet hours,
	-- but starting or extending its work needs a paying login (S2).
	perform pg_temp.expect(pg_temp.commit(pg_temp.mem(), 'routine-0002', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox', pg_temp.every(), '{"status":"paused"}')))), 1, 'saved');
	x := pg_temp.rt(e1);
	if x.status is distinct from 'paused' or x.pause_reason is distinct from 'member' or x.current_version is distinct from 1::bigint then
		raise exception 'A pause is the row''s: %', to_jsonb(x); end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.mem(), 'routine-0003', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox', pg_temp.every(), '{"status":"paused","ends":"2031-01-01T00:00:00Z","runs":40,
			"quiet":{"start":"22:00","end":"07:00","timezone":"Europe/Copenhagen"}}')))), 1, 'saved');
	x := pg_temp.rt(e1);
	if x.status is distinct from 'paused' or x.current_version is distinct from 1::bigint
		or x.expires_at is distinct from '2031-01-01T00:00:00Z'::timestamptz or x.max_occurrences is distinct from 40
		or x.quiet_start is distinct from '22:00'::time or x.quiet_end is distinct from '07:00'::time
		or x.quiet_time_zone is distinct from 'Europe/Copenhagen' then
		raise exception 'The end, the runs and quiet hours are the row''s: %', to_jsonb(x); end if;
	if pg_temp.problem(pg_temp.commit(pg_temp.mem(), 'routine-0031', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox', pg_temp.every(), '{"ends":"2031-01-01T00:00:00Z","runs":40,
			"quiet":{"start":"22:00","end":"07:00","timezone":"Europe/Copenhagen"}}'))))) is distinct from
		'a routine runs on the AI login of the member who saves it; connect yours in Settings, then save again' then
		raise exception 'A resume needs the saver''s paying login'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'routine-0032', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox', pg_temp.every(), '{"ends":"2031-01-01T00:00:00Z","runs":40,
			"quiet":{"start":"22:00","end":"07:00","timezone":"Europe/Copenhagen"}}')))), 1, 'saved');
	x := pg_temp.rt(e1);
	if x.status is distinct from 'active' or x.pause_reason is not null or x.current_version is distinct from 1::bigint then
		raise exception 'The owner resumes on the login already pinned: %', to_jsonb(x); end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.mem(), 'routine-0033', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox', pg_temp.every(), '{"ends":"2030-06-01T00:00:00Z","runs":30,
			"quiet":{"start":"22:00","end":"07:00","timezone":"Europe/Copenhagen"}}')))), 1, 'saved');
	if (pg_temp.rt(e1)).max_occurrences is distinct from 30 or (pg_temp.rt(e1)).status is distinct from 'active' then
		raise exception 'Fewer runs and an earlier end need no login: %', to_jsonb(pg_temp.rt(e1)); end if;
	if pg_temp.problem(pg_temp.commit(pg_temp.mem(), 'routine-0034', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox', pg_temp.every(), '{"ends":"2030-06-01T00:00:00Z","runs":50,
			"quiet":{"start":"22:00","end":"07:00","timezone":"Europe/Copenhagen"}}'))))) is distinct from
		'a routine runs on the AI login of the member who saves it; connect yours in Settings, then save again'
		or pg_temp.problem(pg_temp.commit(pg_temp.mem(), 'routine-0035', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox', pg_temp.every(), '{"ends":"2031-06-01T00:00:00Z","runs":30,
			"quiet":{"start":"22:00","end":"07:00","timezone":"Europe/Copenhagen"}}'))))) is distinct from
		'a routine runs on the AI login of the member who saves it; connect yours in Settings, then save again' then
		raise exception 'More runs or a later end need the saver''s paying login'; end if;
	if pg_temp.problem(pg_temp.commit(pg_temp.mem(), 'routine-0004', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox today', pg_temp.every(), '{"ends":"2030-06-01T00:00:00Z","runs":30,
			"quiet":{"start":"22:00","end":"07:00","timezone":"Europe/Copenhagen"}}'))))) is distinct from
		'a routine runs on the AI login of the member who saves it; connect yours in Settings, then save again' then
		raise exception 'A member without a paying login makes no version'; end if;
	-- A second paying login of the owner, newer: an edit stays on the login the routine has.
	perform pg_temp.fx($f$insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider,
		created_by_user_id) values ('70800000-0000-4000-8000-0000000000c3', '70700000-0000-4000-8000-000000000010',
		extensions.gen_random_uuid(), '70700000-0000-4000-8000-000000000001', 'openai', '70700000-0000-4000-8000-000000000001');
		insert into public.qorpera_provider_connection_versions
		select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
			to_jsonb(cv) || '{"connection_id":"70800000-0000-4000-8000-0000000000c3"}'::jsonb)).*
		from public.qorpera_provider_connection_versions cv where connection_id = '70800000-0000-4000-8000-0000000000c1';
		insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id) values
			('70800000-0000-4000-8000-0000000000b3', '70700000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
			'70700000-0000-4000-8000-000000000001');
		insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id,
			provider_connection_version, allow_autonomous, created_by_user_id, created_at) values ('70800000-0000-4000-8000-0000000000b3', 1,
			'member_connection', '70800000-0000-4000-8000-0000000000c3', 1, true, '70700000-0000-4000-8000-000000000001',
			clock_timestamp() + interval '1 second')$f$);
	-- The same timing keeps the position: scheduled up to an hour ago, due again in an hour.
	v_at := date_trunc('milliseconds', statement_timestamp()) - interval '1 hour';
	perform pg_temp.fx(format('update public.qorpera_cloud_routine_schedule_cursors set last_scheduled_for = %L, next_due_at = %L
		where routine_id = %L and routine_version = 1', v_at, v_at + interval '2 hours', e1));
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'routine-0005', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox today', pg_temp.every(), '{"effort":"high"}')))), 1, 'saved');
	x := pg_temp.rt(e1); c := pg_temp.cursor(e1);
	if x.current_version is distinct from 2::bigint or (pg_temp.rv(e1)).title is distinct from 'Inbox today'
		or (pg_temp.rv(e1)).effort is distinct from 'high' or x.expires_at is not null or x.quiet_start is not null
		or (pg_temp.rv(e1)).sponsor_binding_id is distinct from '70800000-0000-4000-8000-0000000000b1'
		or c.routine_version is distinct from 2::bigint or c.last_scheduled_for is distinct from v_at
		or c.next_due_at is distinct from v_at + interval '2 hours' then
		raise exception 'The same timing keeps the position: %, %', to_jsonb(x), to_jsonb(c); end if;
	-- New timing starts again at the save.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'routine-0006', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox today', pg_temp.every(30), '{"effort":"high"}')))), 1, 'saved');
	c := pg_temp.cursor(e1);
	if c.routine_version is distinct from 3::bigint or c.last_scheduled_for is distinct from date_trunc('milliseconds', (pg_temp.rv(e1)).created_at)
		or c.next_due_at is distinct from c.last_scheduled_for + interval '1 millisecond' then
		raise exception 'New timing starts again at the save: %', to_jsonb(c); end if;
	-- The second login goes again.
	perform pg_temp.fx($f$delete from public.qorpera_execution_sponsor_versions where binding_id = '70800000-0000-4000-8000-0000000000b3';
		delete from public.qorpera_execution_sponsor_bindings where id = '70800000-0000-4000-8000-0000000000b3';
		delete from public.qorpera_provider_connection_versions where connection_id = '70800000-0000-4000-8000-0000000000c3';
		delete from public.qorpera_provider_connections where id = '70800000-0000-4000-8000-0000000000c3'$f$);
end $$;

-- 4. The platform's record stays until a save changes the status --------------------------------------------------------------

do $$
declare x public.qorpera_cloud_routines; e1 constant uuid := '70800000-0000-4000-8000-0000000000e1';
begin
	-- Suspended after three authorization failures, as the wake trigger leaves it; the file still says active.
	perform pg_temp.fx(format('update public.qorpera_cloud_routines set status = %L, pause_reason = %L, authorization_failures = 3
		where id = %L', 'paused', 'authorization_failed', e1));
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'record-0001', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox, weekdays', pg_temp.every(30), '{"effort":"high"}')))), 1, 'saved');
	x := pg_temp.rt(e1);
	if x.status is distinct from 'paused' or x.pause_reason is distinct from 'authorization_failed' or x.authorization_failures is distinct from 3
		or x.current_version is distinct from 4::bigint then
		raise exception 'An edit leaves the platform''s pause: %', to_jsonb(x); end if;
	-- The platform writing the pause into the file (core C2's queue) keeps the record's reason.
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'record-0006', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox, weekdays', pg_temp.every(30), '{"effort":"high","status":"paused"}')))), 1, 'saved');
	if (pg_temp.rt(e1)).pause_reason is distinct from 'authorization_failed' or (pg_temp.rt(e1)).current_version is distinct from 4::bigint then
		raise exception 'The platform''s pause keeps its reason: %', to_jsonb(pg_temp.rt(e1)); end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'record-0007', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox, weekdays', pg_temp.every(30), '{"effort":"high"}')))), 1, 'saved');
	-- The file's own pause and resume are the saver's word.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'record-0002', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox, weekdays', pg_temp.every(30), '{"effort":"high","status":"paused"}')))), 1, 'saved');
	if (pg_temp.rt(e1)).pause_reason is distinct from 'member' then raise exception 'A member''s pause: %', to_jsonb(pg_temp.rt(e1)); end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'record-0003', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox, weekdays', pg_temp.every(30), '{"effort":"high"}')))), 1, 'saved');
	x := pg_temp.rt(e1);
	if x.status is distinct from 'active' or x.pause_reason is not null or x.authorization_failures is distinct from 0 then
		raise exception 'A resume clears the failures: %', to_jsonb(x); end if;
	-- An ended routine expires; a save revives it (the sweep expires it again while it has ended).
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'record-0004', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox, weekdays', pg_temp.every(30), '{"effort":"high","ends":"2020-01-01T00:00:00Z"}')))), 1, 'saved');
	perform public.qorpera_expire_cloud_routines();
	if (pg_temp.rt(e1)).status is distinct from 'expired' then raise exception 'An ended routine expires'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'record-0005', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox, weekdays', pg_temp.every(30), '{"effort":"high","ends":"2031-01-01T00:00:00Z"}')))), 1, 'saved');
	x := pg_temp.rt(e1);
	if x.status is distinct from 'active' or x.expired_while_active or x.expires_at is distinct from '2031-01-01T00:00:00Z'::timestamptz then
		raise exception 'A save revives an expired routine: %', to_jsonb(x); end if;
	-- A routine whose runs are used up has ended; more runs start it again.
	perform pg_temp.occurred(e1);
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'record-0008', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox, weekdays', pg_temp.every(30), '{"effort":"high","ends":"2031-01-01T00:00:00Z","runs":1}')))), 1, 'saved');
	if (pg_temp.rt(e1)).status is distinct from 'expired' then raise exception 'Used-up runs end it: %', to_jsonb(pg_temp.rt(e1)); end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'record-0009', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox, weekdays', pg_temp.every(30), '{"effort":"high","ends":"2031-01-01T00:00:00Z"}')))), 1, 'saved');
	if (pg_temp.rt(e1)).status is distinct from 'active' then raise exception 'More runs start it again: %', to_jsonb(pg_temp.rt(e1)); end if;
end $$;

-- 5. The trigger a version stores for weekly and window timing ------------------------------------------------------------------

do $$
declare r jsonb; e2 constant uuid := '70800000-0000-4000-8000-0000000000e2'; e3 constant uuid := '70800000-0000-4000-8000-0000000000e3';
begin
	r := pg_temp.commit(pg_temp.owner(), 'timing-0001', jsonb_build_array(
		pg_temp.routine('agents/nora/routines/weekly-report.md', pg_temp.rparse(e2, 'Weekly report',
			'{"when":"weekly","days":["mon","fri"],"time":"09:00","starts":"2030-01-06T07:00:00Z"}')),
		pg_temp.routine('agents/otto/routines/winter-watch.md', pg_temp.rparse(e3, 'Winter watch',
			'{"when":"window","minutes":30,"from":"08:00","to":"16:00","days":["sat"],"months":[12,1]}',
			'{"reply":"silent","quiet":{"start":"12:00","end":"13:00","timezone":"America/New_York"}}'))));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	if (pg_temp.rv(e2)).triggers is distinct from '[{"id":"file","kind":"schedule","intervalMinutes":1440,"weekdays":["monday","friday"],
		"localTime":"09:00","timeZone":"Europe/Copenhagen","startAt":"2030-01-06T07:00:00.000Z","replyPolicy":"optional"}]' then
		raise exception 'weekly: %', (pg_temp.rv(e2)).triggers; end if;
	if (pg_temp.rv(e3)).triggers is distinct from '[{"id":"file","kind":"schedule","intervalMinutes":30,"windowStart":"08:00",
		"windowEnd":"16:00","weekdays":["saturday"],"months":[12,1],"timeZone":"Europe/Copenhagen","replyPolicy":"silent"}]'
		or (pg_temp.rt(e3)).quiet_time_zone is distinct from 'America/New_York'
		or (pg_temp.rt(e3)).owner_staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a2' then
		raise exception 'window: %, %', (pg_temp.rv(e3)).triggers, to_jsonb(pg_temp.rt(e3)); end if;
end $$;

-- 6. The rules ------------------------------------------------------------------------------------------------------------------

do $$
declare e1 constant uuid := '70800000-0000-4000-8000-0000000000e1'; ea constant uuid := '70800000-0000-4000-8000-0000000000ea';
	e4 constant uuid := '70800000-0000-4000-8000-0000000000e4'; eb constant uuid := '70800000-0000-4000-8000-0000000000eb';
	r jsonb;
begin
	-- A routine lives next to an agent.md.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'ghost-0001', jsonb_build_array(jsonb_build_object('op','new_folder',
		'path','agents/ghost','contents',jsonb_build_array(jsonb_build_object('path','routines','kind','folder'))))), 1, 'saved');
	if pg_temp.problem(pg_temp.commit(pg_temp.owner(), 'rule-0001', jsonb_build_array(pg_temp.routine('agents/ghost/routines/boo.md',
		pg_temp.rparse(ea, 'Boo', pg_temp.every()))))) is distinct from 'a routine lives in an agent''s folder, next to its agent.md' then
		raise exception 'A routine needs an agent'; end if;
	-- The id never changes, and belongs to one file.
	if pg_temp.problem(pg_temp.commit(pg_temp.owner(), 'rule-0002', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(ea, 'Inbox', pg_temp.every()))))) is distinct from 'id never changes; it is ' || e1 then
		raise exception 'A routine''s id never changes'; end if;
	if pg_temp.problem(pg_temp.commit(pg_temp.owner(), 'rule-0003', jsonb_build_array(pg_temp.routine('agents/otto/routines/twin.md',
		pg_temp.rparse(e1, 'Twin', pg_temp.every()))))) is distinct from
		'this id belongs to the routine at agents/nora/routines/inbox.md; give this routine a new id' then
		raise exception 'One file per routine'; end if;
	-- A saved parse is the file's only when the index points at that path for its routine: one that names another
	-- routine's id (say, stored by an older parser) is no base, and the file's own id is saved over it.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'trust-0001', jsonb_build_array(pg_temp.routine('agents/otto/routines/trust.md',
		pg_temp.rparse('70800000-0000-4000-8000-0000000000ed', 'Trust', pg_temp.every())))), 1, 'saved');
	update public.qorpera_folder_path_versions set structured = jsonb_set(structured, '{parse,id}', to_jsonb(e1::text))
	where version = pg_temp.version('agents/otto/routines/trust.md');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'trust-0002', jsonb_build_array(pg_temp.routine('agents/otto/routines/trust.md',
		pg_temp.rparse('70800000-0000-4000-8000-0000000000ed', 'Trust me', pg_temp.every())))), 1, 'saved');
	r := pg_temp.commit(pg_temp.owner(), 'rule-0004', jsonb_build_array(pg_temp.hire_routines('wren', '70800000-0000-4000-8000-0000000000a4',
		jsonb_build_array(jsonb_build_array('one', pg_temp.rparse(ea, 'One', pg_temp.every())),
			jsonb_build_array('two', pg_temp.rparse(ea, 'Two', pg_temp.every()))))));
	if pg_temp.problem(r) is distinct from 'two routine files in one change carry the same id' then
		raise exception 'One file per routine within a unit: %', r; end if;
	-- Timing the scheduler runs: a file-change routine watches only what its agent may read (P29, 20260930020000; 887 has
	-- the rest); time zones the database knows; starts to the millisecond.
	if pg_temp.problem(pg_temp.commit(pg_temp.owner(), 'rule-0005', jsonb_build_array(pg_temp.routine('agents/nora/routines/watch.md',
		pg_temp.rparse(ea, 'Watch', '{"when":"file-change","watch":"members/70700000-0000-4000-8000-000000000002/private","match":"subtree"}'))))) is distinct from
		'this routine''s agent may not read members/70700000-0000-4000-8000-000000000002/private, so it cannot watch it' then
		raise exception 'file-change watches only what its agent may read: %', pg_temp.problem(pg_temp.commit(pg_temp.owner(), 'rule-0005b',
			jsonb_build_array(pg_temp.routine('agents/nora/routines/watch.md', pg_temp.rparse(ea, 'Watch',
				'{"when":"file-change","watch":"members/70700000-0000-4000-8000-000000000002/private","match":"subtree"}'))))); end if;
	if pg_temp.problem(pg_temp.commit(pg_temp.owner(), 'rule-0006', jsonb_build_array(pg_temp.routine('agents/nora/routines/mars.md',
		pg_temp.rparse(ea, 'Mars', '{"when":"weekly","days":["mon"],"time":"09:00","starts":null}', '{"timezone":"Mars/Olympus"}'))))) is distinct from
		'the platform does not know the time zone Mars/Olympus; use a name like Europe/Copenhagen' then
		raise exception 'An unknown time zone'; end if;
	if pg_temp.problem(pg_temp.commit(pg_temp.owner(), 'rule-0007', jsonb_build_array(pg_temp.routine('agents/nora/routines/mars.md',
		pg_temp.rparse(ea, 'Mars', pg_temp.every(), '{"quiet":{"start":"22:00","end":"07:00","timezone":"Mars/Olympus"}}'))))) is distinct from
		'the platform does not know the time zone Mars/Olympus; use a name like Europe/Copenhagen' then
		raise exception 'An unknown quiet time zone'; end if;
	if pg_temp.problem(pg_temp.commit(pg_temp.owner(), 'rule-0008', jsonb_build_array(pg_temp.routine('agents/nora/routines/fine.md',
		pg_temp.rparse(ea, 'Fine', pg_temp.every(60, '2030-01-06T07:00:00.0001Z')))))) is distinct from 'starts is given to the millisecond at most' then
		raise exception 'starts to the millisecond'; end if;
	-- Only an agent makes a routine dynamic.
	if pg_temp.problem(pg_temp.commit(pg_temp.owner(), 'rule-0009', jsonb_build_array(pg_temp.routine('agents/nora/routines/next.md',
		pg_temp.rparse(ea, 'Next', pg_temp.once('2030-01-01T09:00:00Z')))))) is distinct from 'only an agent makes a routine dynamic (when: once)' then
		raise exception 'A member makes no dynamic routine'; end if;
	-- The platform pays for nothing, so it starts no routine.
	if pg_temp.problem(pg_temp.commit('{"kind":"platform"}', 'rule-0013', jsonb_build_array(pg_temp.routine('agents/nora/routines/seeded.md',
		pg_temp.rparse(ea, 'Seeded', pg_temp.every()))))) is distinct from 'the platform does not start routines' then
		raise exception 'The platform starts no routine'; end if;
	-- Rows from before the files: a member's routine (id e4, client id eb) and Nora's routine called legacy.
	perform pg_temp.fx(format($f$insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, status,
		created_by_user_id) values (%L, %L, %L, %L, 'active', %L)$f$, e4, '70700000-0000-4000-8000-000000000010',
		'70700000-0000-4000-8000-000000000020', eb, '70700000-0000-4000-8000-000000000001'));
	perform pg_temp.fx(format($f$insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, status,
		created_by_user_id, origin, owner_staff_agent_id, routine_key) values (%L, %L, %L, %L, 'active', %L, 'agent', %L, 'legacy')$f$,
		'70800000-0000-4000-8000-0000000000e5', '70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000020',
		extensions.gen_random_uuid(), '70700000-0000-4000-8000-000000000001', '70700000-0000-4000-8000-0000000000a1'));
	if pg_temp.problem(pg_temp.commit(pg_temp.owner(), 'rule-0010', jsonb_build_array(pg_temp.routine('agents/nora/routines/old.md',
		pg_temp.rparse(e4, 'Old', pg_temp.every()))))) is distinct from 'this id belongs to another routine; give this routine a new id'
		or pg_temp.problem(pg_temp.commit(pg_temp.owner(), 'rule-0011', jsonb_build_array(pg_temp.routine('agents/nora/routines/old.md',
		pg_temp.rparse(eb, 'Old', pg_temp.every()))))) is distinct from 'this id belongs to another routine; give this routine a new id' then
		raise exception 'A routine row from before the files keeps its ids'; end if;
	if pg_temp.problem(pg_temp.commit(pg_temp.owner(), 'rule-0012', jsonb_build_array(pg_temp.routine('agents/nora/routines/legacy.md',
		pg_temp.rparse(ea, 'Legacy', pg_temp.every()))))) is distinct from 'this agent has another routine called legacy; choose another name' then
		raise exception 'An agent''s routine names stay unique'; end if;
	-- The name index covers file routines of either origin: no row of any origin takes the name of a member's file routine.
	begin
		perform pg_temp.fx(format($f$insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, status,
			created_by_user_id, origin, owner_staff_agent_id, routine_key) values (%L, %L, %L, %L, 'active', %L, 'agent', %L, 'inbox')$f$,
			extensions.gen_random_uuid(), '70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000020',
			extensions.gen_random_uuid(), '70700000-0000-4000-8000-000000000001', '70700000-0000-4000-8000-0000000000a1'));
		raise exception 'A second row took a file routine''s name';
	exception when unique_violation then null;
	end;
	-- The parse's shape, the same rules as the TS parser's.
	perform pg_temp.misread('shape-0001', pg_temp.rparse(ea, 'X', pg_temp.once('2030-01-01T09:00:00Z'), '{"runs":3}'), 'runs');
	perform pg_temp.misread('shape-0002', pg_temp.rparse(ea, 'X', pg_temp.every(), '{"conclusion":"Done."}'), 'conclusion');
	perform pg_temp.misread('shape-0003', pg_temp.rparse(ea, 'X', pg_temp.every(), '{"status":"concluded"}'), 'conclusion');
	perform pg_temp.misread('shape-0004', pg_temp.rparse(ea, 'X', pg_temp.every(), '{"colour":"blue"}'), 'keys');
	perform pg_temp.misread('shape-0005', pg_temp.rparse(ea, 'X', '{"when":"weekly","days":["mon","mon"],"time":"09:00","starts":null}'), 'trigger');
	perform pg_temp.misread('shape-0006', pg_temp.rparse(ea, 'X', '{"when":"window","minutes":30,"from":"08:00","to":"16:00","days":null,"months":[13]}'), 'trigger');
	perform pg_temp.misread('shape-0007', pg_temp.rparse(ea, 'X', '{"when":"window","minutes":30,"from":"16:00","to":"08:00","days":null,"months":null}'), 'trigger');
	perform pg_temp.misread('shape-0008', pg_temp.rparse(ea, 'X', '{"when":"weekly","days":["mon"],"time":"09:00","starts":null}', '{"timezone":null}'), 'timezone');
	perform pg_temp.misread('shape-0009', pg_temp.rparse(ea, 'X', pg_temp.once('2030-01-01T09:00:00Z'), '{"ends":"2029-01-01T00:00:00Z"}'), 'at');
	perform pg_temp.misread('shape-0010', pg_temp.rparse(ea, 'X', pg_temp.every(4)), 'trigger');
	perform pg_temp.misread('shape-0011', pg_temp.rparse(ea, 'X', pg_temp.every() || '{"at":"2030-01-01T09:00:00Z"}'), 'trigger');
	perform pg_temp.misread('shape-0012', pg_temp.rparse(ea, 'X', pg_temp.every(60, 'soon')), 'trigger');
	perform pg_temp.misread('shape-0013', pg_temp.rparse(ea, 'X', '{"when":"file-change","watch":"/sales","match":"subtree"}'), 'trigger');
	perform pg_temp.misread('shape-0014', pg_temp.rparse(ea, 'X', pg_temp.every(), '{"quiet":{"start":"22:00","end":"22:00","timezone":"UTC"}}'), 'quiet');
	perform pg_temp.misread('shape-0015', pg_temp.rparse(ea, 'X', pg_temp.every(), '{"effort":"max"}'), 'effort');
	perform pg_temp.misread('shape-0016', pg_temp.rparse(ea, 'X', pg_temp.every(), '{"ends":"2030-01-01T09:00:00.500000Z"}'), 'ends');
	perform pg_temp.misread('shape-0017', pg_temp.rparse(ea, repeat('t', 161), pg_temp.every()), 'title');
end $$;

-- 7. A hire may bring its routines; renames, handovers, deletes and restores ------------------------------------------------------

do $$
declare x public.qorpera_cloud_routines; c public.qorpera_cloud_routine_schedule_cursors; v_at timestamptz;
	e1 constant uuid := '70800000-0000-4000-8000-0000000000e1'; e2 constant uuid := '70800000-0000-4000-8000-0000000000e2';
	e3 constant uuid := '70800000-0000-4000-8000-0000000000e3'; e6 constant uuid := '70800000-0000-4000-8000-0000000000e6';
	ec constant uuid := '70800000-0000-4000-8000-0000000000ec';
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'hire-0002', jsonb_build_array(pg_temp.hire_routines('vera',
		'70700000-0000-4000-8000-0000000000a3', jsonb_build_array(jsonb_build_array('daily', pg_temp.rparse(e6, 'Daily', pg_temp.every(1440))))))),
		1, 'saved');
	if (pg_temp.rt(e6)).owner_staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a3' or (pg_temp.rv(e6)).staff_agent_id
		is distinct from '70700000-0000-4000-8000-0000000000a3' then
		raise exception 'A hire''s routine is the new agent''s: %', to_jsonb(pg_temp.rt(e6)); end if;
	-- A rename is the new key, nothing a run pins.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'move-0001', jsonb_build_array(
		pg_temp.move('agents/nora/routines/weekly-report.md', 'agents/nora/routines/report.md'))), 1, 'saved');
	x := pg_temp.rt(e2);
	if x.routine_key is distinct from 'report' or x.folder_path is distinct from 'agents/nora/routines/report.md' or x.current_version is distinct from 1::bigint
		or x.folder_path_version is distinct from pg_temp.version('agents/nora/routines/report.md') then
		raise exception 'A renamed routine: %', to_jsonb(x); end if;
	-- A handover: the new agent's runs, paid as before, at the same position (an overdue slot stays due).
	v_at := date_trunc('milliseconds', statement_timestamp()) - interval '1 hour';
	perform pg_temp.fx(format('update public.qorpera_cloud_routine_schedule_cursors set last_scheduled_for = %L, next_due_at = %L
		where routine_id = %L and routine_version = 1', v_at, v_at + interval '30 minutes', e2));
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'move-0002', jsonb_build_array(
		pg_temp.move('agents/nora/routines/report.md', 'agents/otto/routines/report.md'))), 1, 'saved');
	x := pg_temp.rt(e2); c := pg_temp.cursor(e2);
	if x.owner_staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a2' or x.current_version is distinct from 2::bigint
		or (pg_temp.rv(e2)).staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a2'
		or (pg_temp.rv(e2)).title is distinct from 'Weekly report'
		or (pg_temp.rv(e2)).sponsor_binding_id is distinct from '70800000-0000-4000-8000-0000000000b1'
		or (pg_temp.rv(e2)).created_by_user_id is distinct from '70700000-0000-4000-8000-000000000001'
		or c.last_scheduled_for is distinct from v_at or c.next_due_at is distinct from v_at + interval '30 minutes' then
		raise exception 'A handover: %, %', to_jsonb(x), to_jsonb(c); end if;
	-- A routine moves only into an agent's routines folder, onto a free name.
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'move-0003', jsonb_build_array(
		pg_temp.move('agents/otto/routines/report.md', 'agents/otto/todos/report.md'))), 'kind_change') then
		raise exception 'A routine is never moved into todos'; end if;
	if pg_temp.problem(pg_temp.commit(pg_temp.owner(), 'move-0004', jsonb_build_array(
		pg_temp.move('agents/otto/routines/report.md', 'agents/ghost/routines/report.md')))) is distinct from
		'a routine moves only into an agent''s routines folder' then
		raise exception 'A routine moves only to an agent'; end if;
	if pg_temp.problem(pg_temp.commit(pg_temp.owner(), 'move-0005', jsonb_build_array(
		pg_temp.move('agents/otto/routines/report.md', 'agents/nora/routines/legacy.md')))) is distinct from
		'that agent has another routine called legacy; choose another name' then
		raise exception 'A moved routine keeps names unique'; end if;
	-- A handover makes the new agent's runs: a member without a paying login cannot move a routine to another agent.
	if pg_temp.problem(pg_temp.commit(pg_temp.mem(), 'move-0051', jsonb_build_array(
		pg_temp.move('agents/otto/routines/report.md', 'agents/nora/routines/report.md')))) is distinct from
		'a routine handed to another agent runs on the AI login of the member who moves it; connect yours in Settings, then move it again' then
		raise exception 'A handover needs the mover''s paying login'; end if;
	-- An agent's rename carries its routines, which keep their agent and version.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'move-0006', jsonb_build_array(pg_temp.move('agents/otto', 'agents/otis'))), 1, 'saved');
	if (pg_temp.rt(e2)).folder_path is distinct from 'agents/otis/routines/report.md' or (pg_temp.rt(e2)).current_version is distinct from 2::bigint
		or (pg_temp.rt(e3)).folder_path is distinct from 'agents/otis/routines/winter-watch.md'
		or (pg_temp.rt(e3)).owner_staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a2'
		or (pg_temp.rt(e3)).folder_path_version is distinct from pg_temp.version('agents/otis/routines/winter-watch.md') then
		raise exception 'A renamed agent keeps its routines: %, %', to_jsonb(pg_temp.rt(e2)), to_jsonb(pg_temp.rt(e3)); end if;
	-- Deleting retires the routine and frees its name; a restore brings it back.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'del-0001', jsonb_build_array(pg_temp.del('agents/nora/routines/inbox.md'))), 1, 'saved');
	x := pg_temp.rt(e1);
	if x.status is distinct from 'retired' or x.folder_retired_at is null or x.routine_key is distinct from 'inbox.' || replace(e1::text, '-', '') then
		raise exception 'A deleted routine retires: %', to_jsonb(x); end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'del-0002', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse(ec, 'New inbox', pg_temp.every())))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'del-0003', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox-old.md',
		pg_temp.rparse(e1, 'Inbox, weekdays', pg_temp.every(30), '{"effort":"high","ends":"2031-01-01T00:00:00Z"}')))), 1, 'saved');
	x := pg_temp.rt(e1);
	if x.status is distinct from 'active' or x.folder_retired_at is not null or x.routine_key is distinct from 'inbox-old'
		or x.current_version is distinct from 4::bigint then
		raise exception 'A restore brings the routine back: %', to_jsonb(x); end if;
	-- Deleting an agent's folder retires its routines.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'del-0004', jsonb_build_array(pg_temp.del('agents/vera'))), 1, 'saved');
	if (pg_temp.rt(e6)).status is distinct from 'retired' then raise exception 'An agent''s routines retire with its folder'; end if;
end $$;

-- 8. A dynamic routine's run decides it --------------------------------------------------------------------------------------

do $$
declare a jsonb; b jsonb; c jsonb; d jsonb; u jsonb; x public.qorpera_cloud_routines; v public.qorpera_cloud_routine_versions;
	e8 constant uuid := '70800000-0000-4000-8000-0000000000e8'; p text := 'agents/nora/routines/follow-up.md';
	decision_left constant text := 'this run owes its routine''s decision: set a new at (and, if needed, the title, instructions, '
		|| 'effort or reply), or conclude it with a conclusion';
begin
	-- A run of Nora's inbox (a member's routine) never makes that routine dynamic, and starting a dynamic routine of its
	-- own is delegation, so it waits for a review.
	a := pg_temp.routine_run('70800000-0000-4000-8000-0000000000ec');
	if pg_temp.problem(pg_temp.commit(a, 'dynamic-0000', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse('70800000-0000-4000-8000-0000000000ec', 'New inbox', pg_temp.once('2030-01-01T09:00:00Z')))))) is distinct from
		'a routine a member made does not become dynamic (when: once)' then
		raise exception 'A member''s routine does not become dynamic'; end if;
	u := jsonb_build_array(pg_temp.routine(p, pg_temp.rparse(e8, 'Follow up', pg_temp.once('2030-01-01T09:00:00Z'))));
	perform pg_temp.expect(pg_temp.commit(a, 'dynamic-0001', u), 1, 'denied', 'review_required');
	perform pg_temp.expect(pg_temp.reviewed(a, 'dynamic-0002', u), 1, 'saved');
	x := pg_temp.rt(e8); v := pg_temp.rv(e8);
	if x.origin is distinct from 'agent' or x.status is distinct from 'active' or x.created_by_user_id is distinct from '70700000-0000-4000-8000-000000000001'
		or v.triggers is distinct from '[{"id":"file","kind":"once","at":"2030-01-01T09:00:00Z","timeZone":"Europe/Copenhagen","replyPolicy":"optional"}]'
		or v.sponsor_binding_id is distinct from '70800000-0000-4000-8000-0000000000b1' or v.created_by_user_id is distinct from '70700000-0000-4000-8000-000000000001'
		or (pg_temp.cursor(e8)).routine_id is not null then
		raise exception 'An agent''s dynamic routine: %, %', to_jsonb(x), to_jsonb(v); end if;
	-- Its run owes the decision. It never pauses, removes or moves its routine, and until it decides it only decides.
	b := pg_temp.routine_run(e8);
	if not public.qorpera_routine_decision_pending((b ->> 'runId')::uuid) then raise exception 'The run owes its decision'; end if;
	if pg_temp.problem(pg_temp.commit(b, 'dynamic-0003', jsonb_build_array(pg_temp.routine(p,
		pg_temp.rparse(e8, 'Follow up', pg_temp.once('2030-01-01T09:00:00Z'), '{"status":"paused"}'))))) is distinct from
		'this run cannot pause its own routine; conclude it instead' then
		raise exception 'A dynamic routine''s run never pauses it'; end if;
	if pg_temp.problem(pg_temp.commit(b, 'dynamic-0004', jsonb_build_array(pg_temp.del(p)))) is distinct from
		'this run cannot remove or move its own routine; conclude it instead'
		or pg_temp.problem(pg_temp.commit(b, 'dynamic-0005', jsonb_build_array(pg_temp.move('agents/nora/routines', 'agents/nora/later')))) is distinct from
		'this run cannot remove or move its own routine; conclude it instead' then
		raise exception 'A dynamic routine''s run never removes or moves it'; end if;
	if pg_temp.problem(pg_temp.commit(b, 'dynamic-0006', jsonb_build_array(pg_temp.routine(p,
		pg_temp.rparse(e8, 'Follow up', pg_temp.once('2030-01-01T09:00:00Z'), '{"ends":"2031-01-01T00:00:00Z"}'))))) is distinct from decision_left
		or pg_temp.problem(pg_temp.commit(b, 'dynamic-0007', jsonb_build_array(pg_temp.routine(p,
			pg_temp.rparse(e8, 'Follow up', pg_temp.once('2030-01-01T09:00:00Z'), '{"status":"concluded","conclusion":"Done.","effort":"high"}')))))
			is distinct from decision_left then
		raise exception 'Until it decides, the run only decides'; end if;
	-- Its decision is not reviewed; one that changes the title or the instructions is, and so is another run's change.
	if pg_temp.review_class(b, pg_temp.routine(p, pg_temp.rparse(e8, 'Follow up', pg_temp.once('2030-02-01T09:00:00Z'),
			'{"effort":"high","reply":"required"}'))) is distinct from 'plain'
		or pg_temp.review_class(b, pg_temp.routine(p, pg_temp.rparse(e8, 'Follow up', pg_temp.once('2030-01-01T09:00:00Z'),
			'{"status":"concluded","conclusion":"Done."}'))) is distinct from 'plain' then
		raise exception 'A decision is not reviewed'; end if;
	if pg_temp.review_class(b, pg_temp.routine(p, pg_temp.rparse(e8, 'Follow up again', pg_temp.once('2030-02-01T09:00:00Z'))))
			is distinct from 'delegation'
		or pg_temp.review_class(b, pg_temp.routine(p, pg_temp.rparse(e8, 'Follow up', pg_temp.once('2030-01-01T09:00:00Z'),
			'{"status":"concluded","conclusion":"Done.","instructions":"Stop."}'))) is distinct from 'delegation'
		or pg_temp.review_class(a, pg_temp.routine(p, pg_temp.rparse(e8, 'Follow up', pg_temp.once('2030-02-01T09:00:00Z'))))
			is distinct from 'delegation' then
		raise exception 'Other changes are delegation'; end if;
	-- Deciding to run at the same time is a decision too: a new version.
	perform pg_temp.expect(pg_temp.commit(b, 'dynamic-0008', jsonb_build_array(pg_temp.routine(p,
		pg_temp.rparse(e8, 'Follow up', pg_temp.once('2030-01-01T09:00:00Z'))))), 1, 'saved');
	if (pg_temp.rt(e8)).current_version is distinct from 2::bigint or public.qorpera_routine_decision_pending((b ->> 'runId')::uuid) then
		raise exception 'The same at is a decision: %', to_jsonb(pg_temp.rt(e8)); end if;
	-- Once it decided, its further changes are delegation.
	if pg_temp.review_class(b, pg_temp.routine(p, pg_temp.rparse(e8, 'Follow up', pg_temp.once('2030-02-01T09:00:00Z'))))
			is distinct from 'delegation' then
		raise exception 'A decided run''s change is delegation'; end if;
	-- The next run decides a new at and more effort, a new version paid as before.
	c := pg_temp.routine_run(e8);
	perform pg_temp.expect(pg_temp.commit(c, 'dynamic-0009', jsonb_build_array(pg_temp.routine(p,
		pg_temp.rparse(e8, 'Follow up', pg_temp.once('2030-02-01T09:00:00Z'), '{"effort":"high"}')))), 1, 'saved');
	x := pg_temp.rt(e8); v := pg_temp.rv(e8);
	if x.current_version is distinct from 3::bigint or x.status is distinct from 'active' or v.effort is distinct from 'high'
		or v.triggers -> 0 ->> 'at' is distinct from '2030-02-01T09:00:00Z' or v.sponsor_binding_id is distinct from '70800000-0000-4000-8000-0000000000b1'
		or public.qorpera_routine_decision_pending((c ->> 'runId')::uuid) then
		raise exception 'The decision is the routine''s next version: %, %', to_jsonb(x), to_jsonb(v); end if;
	-- The next run concludes it, keeping its version.
	d := pg_temp.routine_run(e8);
	perform pg_temp.expect(pg_temp.commit(d, 'dynamic-0010', jsonb_build_array(pg_temp.routine(p,
		pg_temp.rparse(e8, 'Follow up', pg_temp.once('2030-02-01T09:00:00Z'), '{"effort":"high","status":"concluded","conclusion":"All done."}')))),
		1, 'saved');
	x := pg_temp.rt(e8);
	if x.status is distinct from 'concluded' or x.conclusion is distinct from 'All done.' or x.concluded_at is null
		or x.concluded_by_run_id is distinct from (d ->> 'runId')::uuid or x.current_version is distinct from 3::bigint then
		raise exception 'A run concludes its routine: %', to_jsonb(x); end if;
	-- A member's edit of the conclusion keeps who concluded it; a member reopens it.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'dynamic-0011', jsonb_build_array(pg_temp.routine(p,
		pg_temp.rparse(e8, 'Follow up', pg_temp.once('2030-02-01T09:00:00Z'), '{"effort":"high","status":"concluded","conclusion":"All done, well."}')))),
		1, 'saved');
	x := pg_temp.rt(e8);
	if x.conclusion is distinct from 'All done, well.' or x.concluded_by_run_id is distinct from (d ->> 'runId')::uuid then
		raise exception 'An edited conclusion: %', to_jsonb(x); end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'dynamic-0012', jsonb_build_array(pg_temp.routine(p,
		pg_temp.rparse(e8, 'Follow up', pg_temp.once('2030-03-01T09:00:00Z'), '{"effort":"high"}')))), 1, 'saved');
	x := pg_temp.rt(e8);
	if x.status is distinct from 'active' or x.conclusion is not null or x.concluded_by_run_id is not null or x.current_version is distinct from 4::bigint then
		raise exception 'A member reopens a dynamic routine: %', to_jsonb(x); end if;
	-- A run a schedule woke is no dynamic run, even of a routine that has since become dynamic: its change is delegation.
	perform pg_temp.expect(pg_temp.reviewed(a, 'dynamic-0013', jsonb_build_array(pg_temp.routine('agents/nora/routines/later.md',
		pg_temp.rparse('70800000-0000-4000-8000-0000000000ef', 'Later', pg_temp.every())))), 1, 'saved');
	b := pg_temp.routine_run('70800000-0000-4000-8000-0000000000ef');
	perform pg_temp.expect(pg_temp.reviewed(a, 'dynamic-0014', jsonb_build_array(pg_temp.routine('agents/nora/routines/later.md',
		pg_temp.rparse('70800000-0000-4000-8000-0000000000ef', 'Later', pg_temp.once('2030-01-01T09:00:00Z'))))), 1, 'saved');
	if pg_temp.review_class(b, pg_temp.routine('agents/nora/routines/later.md', pg_temp.rparse('70800000-0000-4000-8000-0000000000ef',
		'Later', pg_temp.once('2030-02-01T09:00:00Z')))) is distinct from 'delegation' then
		raise exception 'A scheduled run''s change is delegation'; end if;
	-- A run of a fixed routine concludes it (a reviewed change) and keeps working to its end.
	perform pg_temp.expect(pg_temp.reviewed(a, 'dynamic-0015', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse('70800000-0000-4000-8000-0000000000ec', 'New inbox', pg_temp.every(), '{"status":"concluded","conclusion":"Inbox zero."}')))),
		1, 'saved');
	if (pg_temp.rt('70800000-0000-4000-8000-0000000000ec')).concluded_by_run_id is distinct from (a ->> 'runId')::uuid then
		raise exception 'The run that concluded its routine: %', to_jsonb(pg_temp.rt('70800000-0000-4000-8000-0000000000ec')); end if;
	perform public.qorpera_folder_run_resolve('70700000-0000-4000-8000-000000000020', '70700000-0000-4000-8000-000000000010', a);
	-- A dynamic routine handed to another agent keeps being dynamic, on the mover's login.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'dynamic-0016', jsonb_build_array(
		pg_temp.move(p, 'agents/otis/routines/follow-up.md'))), 1, 'saved');
	x := pg_temp.rt(e8); v := pg_temp.rv(e8);
	if x.owner_staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a2' or x.current_version is distinct from 5::bigint
		or v.staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a2' or v.triggers -> 0 ->> 'kind' is distinct from 'once'
		or x.origin is distinct from 'agent' then
		raise exception 'A dynamic routine''s handover: %, %', to_jsonb(x), to_jsonb(v); end if;
end $$;

-- 9. A run whose requester has no paying login: the routine waits for one ----------------------------------------------------

do $$
declare a jsonb; x public.qorpera_cloud_routines; v public.qorpera_cloud_routine_versions;
	e9 constant uuid := '70800000-0000-4000-8000-0000000000e9'; p text := 'agents/nora/routines/digest.md';
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'waits-0001', jsonb_build_array(pg_temp.routine(p,
		pg_temp.rparse(e9, 'Digest', pg_temp.every())))), 1, 'saved');
	-- The member made its version, with the login that has since stopped paying for unattended work.
	perform pg_temp.fx(format('update public.qorpera_cloud_routine_versions set created_by_user_id = %L, sponsor_binding_id = %L
		where routine_id = %L', '70700000-0000-4000-8000-000000000002', '70800000-0000-4000-8000-0000000000b2', e9));
	a := pg_temp.routine_run(e9);
	perform pg_temp.expect(pg_temp.reviewed(a, 'waits-0002', jsonb_build_array(pg_temp.routine(p,
		pg_temp.rparse(e9, 'Daily digest', pg_temp.every())))), 1, 'saved');
	x := pg_temp.rt(e9); v := pg_temp.rv(e9);
	if x.status is distinct from 'paused' or x.pause_reason is distinct from 'needs_model_account'
		or v.sponsor_binding_id is distinct from '70800000-0000-4000-8000-0000000000b2' or v.created_by_user_id is distinct from '70700000-0000-4000-8000-000000000002' then
		raise exception 'Without a paying login the routine waits: %, %', to_jsonb(x), to_jsonb(v); end if;
	-- The member's login pays again; their next version ends the wait.
	perform pg_temp.fx($f$insert into public.qorpera_provider_connection_versions
		select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
			to_jsonb(cv) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
		from public.qorpera_provider_connection_versions cv where connection_id = '70800000-0000-4000-8000-0000000000c2' and version = 1$f$);
	perform pg_temp.fx($f$insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id,
		provider_connection_version, allow_autonomous, created_by_user_id) values ('70800000-0000-4000-8000-0000000000b2', 2, 'member_connection',
		'70800000-0000-4000-8000-0000000000c2', 2, true, '70700000-0000-4000-8000-000000000002')$f$);
	perform pg_temp.expect(pg_temp.commit(pg_temp.mem(), 'waits-0003', jsonb_build_array(pg_temp.routine(p,
		pg_temp.rparse(e9, 'Daily digest', pg_temp.every(120))))), 1, 'saved');
	x := pg_temp.rt(e9); v := pg_temp.rv(e9);
	if x.status is distinct from 'active' or x.pause_reason is not null or v.sponsor_binding_id is distinct from '70800000-0000-4000-8000-0000000000b2'
		or v.sponsor_version is distinct from 2::bigint then
		raise exception 'A paying login ends the wait: %, %', to_jsonb(x), to_jsonb(v); end if;
	-- The member hands the owner's routine to Otto: the new agent's runs are on the mover's login.
	perform pg_temp.expect(pg_temp.commit(pg_temp.mem(), 'waits-0031', jsonb_build_array(
		pg_temp.move('agents/nora/routines/inbox-old.md', 'agents/otis/routines/inbox-old.md'))), 1, 'saved');
	v := pg_temp.rv('70800000-0000-4000-8000-0000000000e1');
	if v.staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a2' or v.sponsor_binding_id is distinct from '70800000-0000-4000-8000-0000000000b2'
		or v.created_by_user_id is distinct from '70700000-0000-4000-8000-000000000002' then
		raise exception 'A handover is paid by the mover: %', to_jsonb(v); end if;
	-- That login stops paying again. A resume moves the routine to the saver's login, a new version with the same content.
	perform pg_temp.fx($f$insert into public.qorpera_provider_connection_versions
		select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
			to_jsonb(cv) || '{"version":3,"allow_autonomous":false}'::jsonb)).*
		from public.qorpera_provider_connection_versions cv where connection_id = '70800000-0000-4000-8000-0000000000c2' and version = 2$f$);
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'waits-0004', jsonb_build_array(pg_temp.routine(p,
		pg_temp.rparse(e9, 'Daily digest', pg_temp.every(120), '{"status":"paused"}')))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'waits-0005', jsonb_build_array(pg_temp.routine(p,
		pg_temp.rparse(e9, 'Daily digest', pg_temp.every(120))))), 1, 'saved');
	x := pg_temp.rt(e9); v := pg_temp.rv(e9);
	if x.status is distinct from 'active' or x.current_version is distinct from 4::bigint
		or v.sponsor_binding_id is distinct from '70800000-0000-4000-8000-0000000000b1' or v.created_by_user_id is distinct from '70700000-0000-4000-8000-000000000001'
		or v.title is distinct from 'Daily digest' then
		raise exception 'A resume moves to the saver''s paying login: %, %', to_jsonb(x), to_jsonb(v); end if;
	-- Waiting for a login, as a run's save leaves it: a handover paid by the mover's login ends the wait.
	perform pg_temp.fx(format('update public.qorpera_cloud_routines set status = %L, pause_reason = %L where id = %L',
		'paused', 'needs_model_account', e9));
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'waits-0006', jsonb_build_array(
		pg_temp.move(p, 'agents/otis/routines/digest.md'))), 1, 'saved');
	x := pg_temp.rt(e9); v := pg_temp.rv(e9);
	if x.status is distinct from 'active' or x.pause_reason is not null or v.staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a2'
		or v.sponsor_binding_id is distinct from '70800000-0000-4000-8000-0000000000b1' then
		raise exception 'A paid handover ends the wait: %, %', to_jsonb(x), to_jsonb(v); end if;
	-- An agent acting with no run (a coding session, or a desktop whose run ended: C1b-3a's views) has no login of its own
	-- to pin: the member it acts for pays, as a member's save does, and one without a paying login is refused.
	p := 'agents/otis/routines/digest.md';
	if (public.qorpera_company_state_routine_rules('70700000-0000-4000-8000-000000000020', '70700000-0000-4000-8000-000000000010',
			jsonb_build_object('kind','staff_agent','staffAgentId','70700000-0000-4000-8000-0000000000a2',
				'requesterUserId','70700000-0000-4000-8000-000000000002','audience',jsonb_build_object('kind','company'),
				'sessionKind','coding','workerAccess','write','runId',null),
			p, pg_temp.rparse(e9, 'Digest from code', pg_temp.every(120)), false) -> 'problems' -> 0 ->> 'message') is distinct from
		'a routine runs on the AI login of the member who saves it; connect yours in Settings, then save again' then
		raise exception 'An agent with no run pays with its member''s login'; end if;
	-- The same for a handover it makes.
	if (public.qorpera_folder_structured_decide('70700000-0000-4000-8000-000000000020',
			jsonb_build_object('kind','staff_agent','staffAgentId','70700000-0000-4000-8000-0000000000a2',
				'requesterUserId','70700000-0000-4000-8000-000000000002','audience',jsonb_build_object('kind','company'),
				'sessionKind','coding','workerAccess','write','runId',null),
			extensions.gen_random_uuid(), 1, pg_temp.move(p, 'agents/nora/routines/digest.md'), p, 'agents/nora/routines/digest.md')
			-> 'problems' -> 0 ->> 'message') is distinct from
		'a routine handed to another agent runs on the AI login of the member who moves it; connect yours in Settings, then move it again' then
		raise exception 'An agent with no run hands over on its member''s login'; end if;
	-- Should that login stop paying between the check and the save, the save still lands and waits, pinned to the
	-- member's newest login (the commit row a detached view writes: an agent, no run, no login).
	perform pg_temp.fx(format($f$insert into public.qorpera_folder_commits(id, environment_id, operation_key, actor_kind, actor_id,
		requester_kind, requester_id, session_kind, units, view_id, view_kind) values (%L, %L, 'detached-0001', 'staff_agent', %L, 'member',
		%L, 'coding', '[]', %L, 'coding_session')$f$, '70800000-0000-4000-8000-0000000000f0', '70700000-0000-4000-8000-000000000020',
		'70700000-0000-4000-8000-0000000000a2', '70700000-0000-4000-8000-000000000002', extensions.gen_random_uuid()));
	perform public.qorpera_company_state_index_routine('70700000-0000-4000-8000-000000000020', '70700000-0000-4000-8000-000000000010',
		'70800000-0000-4000-8000-0000000000f0', p, pg_temp.version(p), pg_temp.rparse(e9, 'Digest from code', pg_temp.every(120)));
	x := pg_temp.rt(e9); v := pg_temp.rv(e9);
	if x.status is distinct from 'paused' or x.pause_reason is distinct from 'needs_model_account'
		or v.sponsor_binding_id is distinct from '70800000-0000-4000-8000-0000000000b2' or v.created_by_user_id is distinct from '70700000-0000-4000-8000-000000000002' then
		raise exception 'A save with no paying login waits: %, %', to_jsonb(x), to_jsonb(v); end if;
end $$;

-- 10. The member RPC refuses a folder-v2 company's routines, except rows from before -------------------------------------------

do $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"70700000-0000-4000-8000-000000000001"}', true);
	begin
		perform public.qorpera_upsert_cloud_routine('70700000-0000-4000-8000-000000000020', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
			'70700000-0000-4000-8000-0000000000a1', 'Web routine', 'Do it.', '[{"id":"t1","kind":"schedule","intervalMinutes":60}]', 'low',
			'70800000-0000-4000-8000-0000000000b1', 1, null, 'agent_turn', 'agent_turn', true, 'automatic', null, '{}');
		raise exception 'The member RPC saved a folder-v2 company''s new routine';
	exception when sqlstate '55000' then
		if sqlerrm is distinct from 'This company keeps its routines in its agents'' routines folders; edit those files' then raise; end if;
	end;
	v_result := public.qorpera_upsert_cloud_routine('70700000-0000-4000-8000-000000000020', '70800000-0000-4000-8000-0000000000eb',
		extensions.gen_random_uuid(), '70700000-0000-4000-8000-0000000000a1', 'Legacy', 'Do it.',
		'[{"id":"t1","kind":"schedule","intervalMinutes":60}]', 'low', '70800000-0000-4000-8000-0000000000b1', 1, null, 'agent_turn',
		'agent_turn', true, 'automatic', null, '{}');
	if v_result ->> 'routine_id' is distinct from '70800000-0000-4000-8000-0000000000e4' then
		raise exception 'A routine row from before the files is still saved there: %', v_result; end if;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	-- The agent tools refuse on a folder-v2 company too (their callers need a native tool lease, so the fence is read here).
	if position('routines folders; write the routine' in pg_get_functiondef('public.qorpera_manage_agent_routine(jsonb,jsonb)'::regprocedure)) = 0
		or position('routines folders; write the routine' in pg_get_functiondef('public.qorpera_decide_agent_routine(jsonb,jsonb)'::regprocedure)) = 0 then
		raise exception 'Both agent routine tools carry the folder-v2 fence'; end if;
end $$;

rollback;
