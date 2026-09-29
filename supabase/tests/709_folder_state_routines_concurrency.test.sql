-- Company state files, F2-6, under concurrency (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §4): a routine save takes
-- the company row FOR KEY SHARE at rank 0 and the routine FOR NO KEY UPDATE at rank 5, before its paths and the clock. The
-- scheduler (qorpera_enqueue_routine_wake) takes the company row FOR UPDATE (the fence), then the routine and its schedule
-- position, so whichever starts first, the other waits at the company row and nothing waits in a circle. A save that makes
-- a new version supersedes the slot the scheduler queued and carries it to the new version; a scheduler that finds a
-- new version refuses (QRC01) and reads again. A member's edit and a dynamic routine's own run meet at the routine row,
-- before either has a path or the clock. The fixture is committed so other connections see it, and removed at the end.
-- Waits are detected with pg_blocking_pids, never by wall-clock time.

insert into auth.users(id,email) values
	('70900000-0000-4000-8000-000000000001','routines-race-owner@example.test'),
	('70900000-0000-4000-8000-000000000002','routines-race-member@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('70900000-0000-4000-8000-000000000010','Nordlys Routine Race','70900000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('70900000-0000-4000-8000-000000000010','70900000-0000-4000-8000-000000000001','routines-race-owner@example.test','Owner','owner'),
	('70900000-0000-4000-8000-000000000010','70900000-0000-4000-8000-000000000002','routines-race-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('70900000-0000-4000-8000-000000000020','70900000-0000-4000-8000-000000000010','Environment',1,'70900000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', false) \g /dev/null
select public.qorpera_folder_enable('70900000-0000-4000-8000-000000000020') \g /dev/null
-- Verified bytes for a text, as the object gateway leaves them.
create function pg_temp.stage(p_text text, p_profile uuid default '70900000-0000-4000-8000-000000000010')
returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects',p_profile::text || '/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',case when p_text = '' then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects',p_profile::text || '/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file(p_profile,v_manifest);
	return jsonb_build_object('manifestSha256',v_manifest_hash,'fileSha256',v_hash,'bytes',octet_length(p_text),
		'mediaType','text/markdown','executable',false);
end $$;

-- A structured entry as the TS parser sends it.
create function pg_temp.entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.write(p_path text, p_kind text, p_text text, p_parse jsonb, p_expected uuid default null) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text),
		'structured', jsonb_build_array(pg_temp.entry(p_path, p_kind, p_text, p_parse)))
		|| case when p_expected is not null then jsonb_build_object('expectedVersion', p_expected) else '{}'::jsonb end
$$;
create function pg_temp.agent_text(p_id uuid, p_name text, p_kind text default 'agent', p_status text default 'active')
returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Sales\nkind: %s\nstatus: %s\n---\nSell.\n', p_id, p_name, p_kind, p_status)
$$;
create function pg_temp.agent_parse(p_id uuid, p_name text, p_kind text default 'agent', p_status text default 'active')
returns jsonb language sql as $$
	select jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Sales','agentKind',p_kind,'status',p_status,
		'colour',null,'figure',null,'model',null,'effort',null,'instructions','Sell.')
$$;
-- A new agent folder with its agent.md, as one unit.
create function pg_temp.hire(p_handle text, p_id uuid, p_name text, p_kind text default 'agent') returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_name, p_kind))),
			jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry('agents/' || p_handle || '/agent.md', 'agent',
			pg_temp.agent_text(p_id, p_name, p_kind), pg_temp.agent_parse(p_id, p_name, p_kind))))
$$;
create function pg_temp.vision(p_name text) returns jsonb language sql as $$
	select pg_temp.write('vision/vision.md', 'vision', E'# ' || p_name || E'\n\n## What we build\n',
		jsonb_build_object('kind','vision','name',p_name),
		(select version from public.qorpera_folder_entries where environment_id = '70900000-0000-4000-8000-000000000020'
			and key_text = 'vision/vision.md'))
$$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_commit('70900000-0000-4000-8000-000000000020', p_actor, p_key, p_units)
$$;
create function pg_temp.owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"70900000-0000-4000-8000-000000000001"}'::jsonb
$$;
create function pg_temp.expect(p_result jsonb, p_unit integer, p_outcome text, p_reason text default null)
returns jsonb language plpgsql as $$
declare v jsonb := p_result -> 'units' -> (p_unit - 1);
begin
	if v ->> 'outcome' is distinct from p_outcome or v ->> 'reason' is distinct from p_reason then
		raise exception 'Unit % expected % (%), got %', p_unit, p_outcome, p_reason, p_result using errcode = 'QTF01'; end if;
	return v;
end $$;
create function pg_temp.version(p_key text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '70900000-0000-4000-8000-000000000020' and key_text = p_key
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '70900000-0000-4000-8000-000000000020'
$$;
create function pg_temp.staff(p_id uuid) returns public.qorpera_profile_staff language sql as $$
	select * from public.qorpera_profile_staff where profile_id = '70900000-0000-4000-8000-000000000010' and staff_agent_id = p_id
$$;

set session_replication_role = replica;
insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider, created_by_user_id) values
	('70900000-0000-4000-8000-0000000000c1', '70900000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'70900000-0000-4000-8000-000000000001', 'openai', '70900000-0000-4000-8000-000000000001'),
	('70900000-0000-4000-8000-0000000000c2', '70900000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'70900000-0000-4000-8000-000000000002', 'openai', '70900000-0000-4000-8000-000000000002');
insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness, billing_source,
	consent_version, consented_by_user_id, allow_autonomous, created_by_user_id, credential_capsule_id, max_native_concurrency,
	quota_policy)
select c.id, 1, 'native_subscription', 'codex-cli', 'personal-subscription', 'fixture', c.owner, c.allow, c.owner,
	extensions.gen_random_uuid(), 1, '{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,'
		'"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}'
from (values ('70900000-0000-4000-8000-0000000000c1'::uuid, '70900000-0000-4000-8000-000000000001'::uuid, true),
	('70900000-0000-4000-8000-0000000000c2'::uuid, '70900000-0000-4000-8000-000000000002'::uuid, false)) c(id, owner, allow);
insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id) values
	('70900000-0000-4000-8000-0000000000b1', '70900000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'70900000-0000-4000-8000-000000000001'),
	('70900000-0000-4000-8000-0000000000b2', '70900000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'70900000-0000-4000-8000-000000000002');
insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id, provider_connection_version,
	allow_autonomous, created_by_user_id) values
	('70900000-0000-4000-8000-0000000000b1', 1, 'member_connection', '70900000-0000-4000-8000-0000000000c1', 1, true,
		'70900000-0000-4000-8000-000000000001'),
	('70900000-0000-4000-8000-0000000000b2', 1, 'member_connection', '70900000-0000-4000-8000-0000000000c2', 1, true,
		'70900000-0000-4000-8000-000000000002');
set session_replication_role = origin;

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
create function pg_temp.rv(p_id uuid) returns public.qorpera_cloud_routine_versions language sql as $$
	select v.* from public.qorpera_cloud_routine_versions v join public.qorpera_cloud_routines r on r.id = v.routine_id
	where r.id = p_id and v.version = r.current_version
$$;
create function pg_temp.cursor(p_id uuid) returns public.qorpera_cloud_routine_schedule_cursors language sql as $$
	select c.* from public.qorpera_cloud_routine_schedule_cursors c join public.qorpera_cloud_routines r on r.id = c.routine_id
	where r.id = p_id and c.routine_version = r.current_version
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
	v_profile uuid := '70900000-0000-4000-8000-000000000010'; v_env uuid := '70900000-0000-4000-8000-000000000020';
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
create function pg_temp.reviewed(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
declare v_review uuid;
begin
	insert into public.qorpera_folder_reviews(environment_id, run_id, change_set_sha256, units, decision)
	values ('70900000-0000-4000-8000-000000000020', (p_actor ->> 'runId')::uuid, public.qorpera_folder_change_set_sha256(p_units),
		array(select generate_series(1, jsonb_array_length(p_units))), 'allow')
	returning id into v_review;
	return public.qorpera_folder_commit('70900000-0000-4000-8000-000000000020', p_actor, p_key, p_units, v_review);
end $$;

-- The creation commit, a hire with a routines folder, an every-hour routine and a dynamic one, committed.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'race-seed-0001', jsonb_build_array(
	jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Routine Race'),
	jsonb_build_object('op','mkdir','path','agents'),
	pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
	pg_temp.hire('co-founder', '70900000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'))), 5, 'saved') \g /dev/null
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'race-hire-0001', jsonb_build_array(
	pg_temp.hire('nora', '70900000-0000-4000-8000-0000000000a1', 'Nora'),
	jsonb_build_object('op','mkdir','path','agents/nora/routines'))), 2, 'saved') \g /dev/null
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'race-routine-0001', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
	pg_temp.rparse('70900000-0000-4000-8000-0000000000e1', 'Inbox', pg_temp.every())))), 1, 'saved') \g /dev/null
select pg_temp.expect(pg_temp.reviewed(pg_temp.routine_run('70900000-0000-4000-8000-0000000000e1'), 'race-dynamic-0001', jsonb_build_array(
	pg_temp.routine('agents/nora/routines/follow-up.md', pg_temp.rparse('70900000-0000-4000-8000-0000000000e2', 'Follow up',
		pg_temp.once('2030-01-01T09:00:00Z'))))), 1, 'saved') \g /dev/null
-- The saves, staged now: staging an object inside the save's own transaction would lock the company row itself.
select set_config('qorpera_test.slot', (date_trunc('milliseconds', clock_timestamp()) + interval '1 minute')::text, false) \g /dev/null
select set_config('qorpera_test.retitle', format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '70900000-0000-4000-8000-000000000020',
	pg_temp.owner()::text, 'race-retitle-0001', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse('70900000-0000-4000-8000-0000000000e1', 'Inbox, first look', pg_temp.every())))::text), false) \g /dev/null
select set_config('qorpera_test.enqueue', format('select public.qorpera_enqueue_routine_wake(%L, 1, %L, %L, %L, %L, null, %L)::text',
	'70900000-0000-4000-8000-0000000000e1', '70900000-0000-4000-8000-0000000000f1', 'race-slot-1', 'file',
	current_setting('qorpera_test.slot'), current_setting('qorpera_test.slot')::timestamptz + interval '1 hour'), false) \g /dev/null

select dblink_connect(name, 'dbname=qorpera_test') from unnest(array['rrace_sched','rrace_save','rrace_hold']) name;
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"service_role"}'$q$) from unnest(array['rrace_sched','rrace_save','rrace_hold']) name;
select set_config('qorpera_test.pid_' || name, pid::text, false)
from unnest(array['rrace_sched','rrace_save','rrace_hold']) name, lateral dblink(name, 'select pg_backend_pid()') as t(pid integer);

create function pg_temp.waits_for(p_waiter text, p_holder text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if current_setting('qorpera_test.pid_' || p_holder)::integer = any (pg_blocking_pids(current_setting('qorpera_test.pid_' || p_waiter)::integer)) then
			return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;

-- A. The scheduler holds the company fence and the routine (it waits on the schedule position another connection holds).
-- The save waits for it at the company row, before the routine. Then the new version supersedes the queued slot and
-- carries it: the slot is offered again at the new version.
do $$
declare v jsonb; v_slot timestamptz := current_setting('qorpera_test.slot')::timestamptz;
	c public.qorpera_cloud_routine_schedule_cursors; o public.qorpera_wake_occurrences;
begin
	perform dblink_exec('rrace_hold', 'begin');
	perform * from dblink('rrace_hold', $q$select 1 from public.qorpera_cloud_routine_schedule_cursors
		where routine_id = '70900000-0000-4000-8000-0000000000e1' and routine_version = 1 for update$q$) as t(x integer);
	perform dblink_send_query('rrace_sched', current_setting('qorpera_test.enqueue'));
	if not pg_temp.waits_for('rrace_sched', 'rrace_hold') then raise exception 'The scheduler must wait on the held position'; end if;
	perform dblink_send_query('rrace_save', current_setting('qorpera_test.retitle'));
	if not pg_temp.waits_for('rrace_save', 'rrace_sched') then raise exception 'The save must wait for the scheduler''s company fence'; end if;
	perform dblink_exec('rrace_hold', 'rollback');
	select t.r::jsonb into v from dblink_get_result('rrace_sched') as t(r text);
	perform * from dblink_get_result('rrace_sched') as t(r text);
	if v ->> 'status' is distinct from 'queued' then raise exception 'The scheduler queues its slot: %', v; end if;
	select r into v from dblink_get_result('rrace_save') as t(r jsonb);
	perform * from dblink_get_result('rrace_save') as t(r jsonb);
	if v -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The save saves after the scheduler: %', v; end if;
	select * into o from public.qorpera_wake_occurrences where id = '70900000-0000-4000-8000-0000000000f1';
	c := pg_temp.cursor('70900000-0000-4000-8000-0000000000e1');
	if o.status is distinct from 'cancelled' or o.blocked_reason is distinct from 'Superseded by a newer version'
		or c.routine_version is distinct from 2::bigint or c.last_scheduled_for is distinct from v_slot - interval '1 millisecond'
		or c.next_due_at is distinct from v_slot then
		raise exception 'The new version carries the queued slot: %, %', to_jsonb(o), to_jsonb(c); end if;
end $$;

-- B. The other order: the save holds the company row and the routine (it waits on a path another connection holds), and
-- the scheduler starts. The scheduler waits for the save at its company fence, before the routine, and then finds a new
-- version: it refuses, and reads the routine again.
select set_config('qorpera_test.retitle_2', format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '70900000-0000-4000-8000-000000000020',
	pg_temp.owner()::text, 'race-retitle-0002', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse('70900000-0000-4000-8000-0000000000e1', 'Inbox, second look', pg_temp.every())))::text), false) \g /dev/null
select set_config('qorpera_test.enqueue_2', format('select public.qorpera_enqueue_routine_wake(%L, 2, %L, %L, %L, %L, %L, %L)::text',
	'70900000-0000-4000-8000-0000000000e1', '70900000-0000-4000-8000-0000000000f2', 'race-slot-2', 'file',
	current_setting('qorpera_test.slot'), current_setting('qorpera_test.slot')::timestamptz - interval '1 millisecond',
	current_setting('qorpera_test.slot')::timestamptz + interval '1 hour'), false) \g /dev/null
do $$
declare v jsonb;
begin
	perform dblink_exec('rrace_hold', 'begin');
	perform * from dblink('rrace_hold', $q$select 1 from public.qorpera_folder_entries
		where environment_id = '70900000-0000-4000-8000-000000000020' and key_text = 'agents/nora/routines/inbox.md' for update$q$) as t(x integer);
	perform dblink_send_query('rrace_save', current_setting('qorpera_test.retitle_2'));
	if not pg_temp.waits_for('rrace_save', 'rrace_hold') then raise exception 'The save must wait on the held path'; end if;
	perform dblink_send_query('rrace_sched', current_setting('qorpera_test.enqueue_2'));
	if not pg_temp.waits_for('rrace_sched', 'rrace_save') then raise exception 'The scheduler must wait for the save at its fence'; end if;
	perform dblink_exec('rrace_hold', 'rollback');
	select r into v from dblink_get_result('rrace_save') as t(r jsonb);
	perform * from dblink_get_result('rrace_save') as t(r jsonb);
	if v -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The save saves before the scheduler: %', v; end if;
	perform * from dblink_get_result('rrace_sched', false) as t(r text);
	perform * from dblink_get_result('rrace_sched', false) as t(r text);
	if dblink_error_message('rrace_sched') not like '%QRC01%wake routine version is unavailable%' then
		raise exception 'The scheduler refuses a routine that changed: %', dblink_error_message('rrace_sched'); end if;
	if exists (select 1 from public.qorpera_wake_occurrences where id = '70900000-0000-4000-8000-0000000000f2')
		or (pg_temp.rv('70900000-0000-4000-8000-0000000000e1')).version is distinct from 3::bigint then
		raise exception 'Nothing is queued for a superseded version'; end if;
end $$;

-- C. A member's edit and a dynamic routine's own decision meet at the routine row, before either takes a path or the
-- clock. The member's edit (held on a path) goes first; the decision waits at the routine and then conflicts with the
-- file it no longer matches, and the run owes no decision any more: the member's version superseded it.
select set_config('qorpera_test.decider', pg_temp.routine_run('70900000-0000-4000-8000-0000000000e2')::text, false) \g /dev/null
select set_config('qorpera_test.member_edit', format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '70900000-0000-4000-8000-000000000020',
	pg_temp.owner()::text, 'race-edit-0001', jsonb_build_array(pg_temp.routine('agents/nora/routines/follow-up.md',
		pg_temp.rparse('70900000-0000-4000-8000-0000000000e2', 'Follow up with Otto', pg_temp.once('2030-01-01T09:00:00Z'))))::text), false) \g /dev/null
select set_config('qorpera_test.decision', format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '70900000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.decider'), 'race-decide-0001', jsonb_build_array(pg_temp.routine('agents/nora/routines/follow-up.md',
		pg_temp.rparse('70900000-0000-4000-8000-0000000000e2', 'Follow up', pg_temp.once('2030-02-01T09:00:00Z'))))::text), false) \g /dev/null
do $$
declare v jsonb;
begin
	if not public.qorpera_routine_decision_pending((current_setting('qorpera_test.decider')::jsonb ->> 'runId')::uuid) then
		raise exception 'The run owes its decision'; end if;
	perform dblink_exec('rrace_hold', 'begin');
	perform * from dblink('rrace_hold', $q$select 1 from public.qorpera_folder_entries
		where environment_id = '70900000-0000-4000-8000-000000000020' and key_text = 'agents/nora/routines/follow-up.md' for update$q$) as t(x integer);
	perform dblink_send_query('rrace_save', current_setting('qorpera_test.member_edit'));
	if not pg_temp.waits_for('rrace_save', 'rrace_hold') then raise exception 'The edit must wait on the held path'; end if;
	perform dblink_send_query('rrace_sched', current_setting('qorpera_test.decision'));
	if not pg_temp.waits_for('rrace_sched', 'rrace_save') then raise exception 'The decision must wait for the edit at the routine'; end if;
	perform dblink_exec('rrace_hold', 'rollback');
	select r into v from dblink_get_result('rrace_save') as t(r jsonb);
	perform * from dblink_get_result('rrace_save') as t(r jsonb);
	if v -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The edit saves first: %', v; end if;
	select r into v from dblink_get_result('rrace_sched') as t(r jsonb);
	perform * from dblink_get_result('rrace_sched') as t(r jsonb);
	if v -> 'units' -> 0 ->> 'outcome' is distinct from 'conflict' then raise exception 'The decision conflicts with the edited file: %', v; end if;
	if public.qorpera_routine_decision_pending((current_setting('qorpera_test.decider')::jsonb ->> 'runId')::uuid)
		or (pg_temp.rv('70900000-0000-4000-8000-0000000000e2')).title is distinct from 'Follow up with Otto' then
		raise exception 'The member''s version supersedes the owed decision'; end if;
end $$;

-- D. A save that makes a version never waits for a login: it reads who pays without the lock an admission takes, so a
-- login's own change, which holds its row, never meets a commit that holds the clock.
select set_config('qorpera_test.retitle_3', format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '70900000-0000-4000-8000-000000000020',
	pg_temp.owner()::text, 'race-retitle-0003', jsonb_build_array(pg_temp.routine('agents/nora/routines/inbox.md',
		pg_temp.rparse('70900000-0000-4000-8000-0000000000e1', 'Inbox, third look', pg_temp.every())))::text), false) \g /dev/null
do $$
declare v jsonb;
begin
	perform dblink_exec('rrace_hold', 'begin');
	perform * from dblink('rrace_hold', $q$select 1 from public.qorpera_provider_connections
		where id = '70900000-0000-4000-8000-0000000000c1' for update$q$) as t(x integer);
	perform dblink_exec('rrace_save', $q$set lock_timeout = '5s'$q$);
	select r into v from dblink('rrace_save', current_setting('qorpera_test.retitle_3')) as t(r jsonb);
	perform dblink_exec('rrace_save', 'reset lock_timeout');
	perform dblink_exec('rrace_hold', 'rollback');
	if v -> 'units' -> 0 ->> 'outcome' is distinct from 'saved'
		or (pg_temp.rv('70900000-0000-4000-8000-0000000000e1')).title is distinct from 'Inbox, third look'
		or (pg_temp.rv('70900000-0000-4000-8000-0000000000e1')).sponsor_binding_id is distinct from '70900000-0000-4000-8000-0000000000b1' then
		raise exception 'A save does not wait for a login: %', v; end if;
end $$;

select dblink_disconnect(name) from unnest(array['rrace_sched','rrace_save','rrace_hold']) name;

-- The committed fixture leaves the shared suite database.
set session_replication_role = replica;
delete from public.qorpera_folder_reviews where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_wake_occurrences where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_runs where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_runner_jobs where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_cloud_routine_schedule_cursors where routine_id in (select id from public.qorpera_cloud_routines
	where profile_id = '70900000-0000-4000-8000-000000000010');
delete from public.qorpera_cloud_routine_versions where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_cloud_routines where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_sponsor_versions where binding_id in (select id from public.qorpera_execution_sponsor_bindings
	where profile_id = '70900000-0000-4000-8000-000000000010');
delete from public.qorpera_execution_sponsor_bindings where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_provider_connection_versions where connection_id in (select id from public.qorpera_provider_connections
	where profile_id = '70900000-0000-4000-8000-000000000010');
delete from public.qorpera_provider_connections where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_company_index where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_journal where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_operation_keys where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_company_cofounders where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_company_room_members where room_id in (select id from public.qorpera_company_rooms where profile_id = '70900000-0000-4000-8000-000000000010');
delete from public.qorpera_company_rooms where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_shared_sessions where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_profile_staff where profile_id = '70900000-0000-4000-8000-000000000010';
set session_replication_role = origin;
-- With triggers on, so the object mirror (qorpera_profile_objects) goes too.
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '70900000-0000-4000-8000-000000000010/%';
delete from public.qorpera_profiles where id = '70900000-0000-4000-8000-000000000010';
delete from auth.users where id in ('70900000-0000-4000-8000-000000000001','70900000-0000-4000-8000-000000000002');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '70900000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_cloud_routines where profile_id = '70900000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_profile_staff where profile_id = '70900000-0000-4000-8000-000000000010')
		or exists (select 1 from storage.objects where name like '70900000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '70900000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
