-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Deleting a company that has used its agents (20260928248920). Before, qorpera_delete_hosted_profile
-- failed with 23503 for any company with a run: runner assignments, claims, leases and events restrict
-- their parents and have no link to the company. Here the fixture company finishes one real run that
-- wrote a Company File note, keeps a second run working, has a routine, and is then deleted by its
-- last member. Everything that depends on it goes; usage records and the stored-object queue stay.
reset role;

create function pg_temp.refused(p_sql text, p_state text, p_message text) returns void language plpgsql as $$
begin
	begin
		execute p_sql;
	exception when others then
		if sqlstate = p_state and sqlerrm = p_message then return; end if;
		raise exception 'Expected % "%", got %: %', p_state, p_message, sqlstate, sqlerrm;
	end;
	raise exception 'Not refused: %', p_sql;
end
$$;

-- The internals are nobody's to call.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		if has_function_privilege(v_role, 'public.qorpera_purge_company(uuid)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_company_purge_active()', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_company_node_holdings(uuid)', 'EXECUTE')
			or has_table_privilege(v_role, 'public.qorpera_company_purges', 'INSERT,SELECT,UPDATE,DELETE')
			or has_table_privilege(v_role, 'public.qorpera_runner_usage_observations', 'INSERT,UPDATE,DELETE,TRUNCATE')
			or has_table_privilege(v_role, 'public.qorpera_runner_model_usage_observations', 'INSERT,UPDATE,DELETE,TRUNCATE') then
			raise exception 'the company purge or the usage ledgers are open to %', v_role;
		end if;
	end loop;
end
$$;

-- Every delete trigger on a table the purge can reach lets the purge through: a new one must too.
do $$
declare v_unexpected text;
begin
	with recursive reachable(table_id) as (
		select 'public.qorpera_profiles'::regclass::oid
		union
		select constraint_row.conrelid from pg_constraint as constraint_row
		join reachable on constraint_row.confrelid = reachable.table_id
		where constraint_row.contype = 'f' and constraint_row.confdeltype in ('c', 'r', 'a')
	)
	select string_agg(trigger_row.tgrelid::regclass || '.' || trigger_row.tgname, ', ') into v_unexpected
	from pg_trigger as trigger_row
	where trigger_row.tgrelid in (select table_id from reachable) and not trigger_row.tgisinternal
		and trigger_row.tgtype & 8 = 8
		and trigger_row.tgrelid <> 'public.qorpera_profile_members'::regclass
		and trigger_row.tgfoid not in (
			'public.qorpera_reject_runtime_bundle_mutation()'::regprocedure,
			'public.qorpera_guard_native_launch_replacement()'::regprocedure,
			'public.qorpera_coding_session_turn_guard()'::regprocedure,
			'public.qorpera_guard_legacy_company_computer_teardown()'::regprocedure,
			'public.qorpera_guard_torn_down_legacy_company_computer()'::regprocedure,
			'public.qorpera_guard_office_delete_disposition()'::regprocedure);
	if v_unexpected is not null then
		raise exception 'Delete triggers the company purge does not know: %', v_unexpected;
	end if;
end
$$;

-- Each immutable history guard refuses a delete outside a purge and lets it through inside one.
create temp table purge_guard_probe (id uuid primary key);
do $$
declare v_guard record;
begin
	for v_guard in select * from (values
		('qorpera_reject_runtime_bundle_mutation', '42501', 'Runtime bundles are immutable'),
		('qorpera_guard_native_launch_replacement', '42501', 'Native launch provenance is immutable'),
		('qorpera_coding_session_turn_guard', '55000', 'A coding turn is history and cannot be removed'),
		('qorpera_guard_legacy_company_computer_teardown', '42501', 'Legacy company computer teardown evidence is immutable'),
		('qorpera_guard_torn_down_legacy_company_computer', null, null),
		('qorpera_guard_office_delete_disposition', '42501', 'Office delete disposition is immutable')) as guard(name, state, message)
	loop
		execute format('create trigger purge_guard before delete on purge_guard_probe for each row execute function public.%I()', v_guard.name);
		insert into purge_guard_probe values (extensions.gen_random_uuid());
		if v_guard.state is not null then
			perform pg_temp.refused('delete from purge_guard_probe', v_guard.state, v_guard.message);
		end if;
		insert into public.qorpera_company_purges (xact_id, profile_id) values (pg_current_xact_id(), extensions.gen_random_uuid());
		delete from purge_guard_probe;
		if found is not true or exists (select 1 from purge_guard_probe) then
			raise exception '% did not let a purge through', v_guard.name;
		end if;
		delete from public.qorpera_company_purges;
		drop trigger purge_guard on purge_guard_probe;
	end loop;
end
$$;
drop table purge_guard_probe;

-- 1. The fixture's human run acknowledges, writes a note through the Company File, reads it, records
-- a model request's context, answers and completes with the governed v6 completion (result, usage
-- record, lease history).
select pg_temp.path_claims('service_role');
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_identity jsonb;
	v_job public.qorpera_runner_jobs%rowtype; v_done jsonb; v_sends integer; v_final text;
begin
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	perform public.qorpera_begin_native_company_execution_v2(v_binding,
		(select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
			join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
		v_identity ->> 'runtimeBundleSha256', v_identity ->> 'reasoningPolicySha256',
		'{"type":"namespace","name":"qorpera","description":"Synthetic native fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
		repeat('c', 64), 10);
	perform pg_temp.wake_public_send(v_binding, 'progress');
	perform pg_temp.path_commit(pg_temp.path_plan('delete-note', 'note.md',
		pg_temp.path_stage_file('note.md', 'Written before the company is deleted')));
	-- A read and a model request's context view: immutable history of the company.
	perform public.qorpera_read_company_path_v2('30000000-0000-4000-8000-000000000020', 'note.md', 0, 16, v_binding);
	perform public.qorpera_record_native_context_view('30000000-0000-4000-8000-000000000020', v_binding, jsonb_build_object(
		'schema', 'qorpera.native-context-view/v1', 'requestId', 'delete-request', 'threadId', 'thread-1',
		'turnId', 'turn-1', 'purpose', 'turn', 'outputs', '[]'::jsonb));
	perform pg_temp.wake_public_send(v_binding, 'final');
	select * into strict v_job from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid;
	select count(*), max(send.event_id::text) filter (where send.phase = 'final') into v_sends, v_final
	from public.qorpera_agent_sends as send where send.run_id = (v_binding ->> 'runId')::uuid;
	v_done := public.qorpera_complete_runner_job_v6((v_binding ->> 'runnerId')::uuid, repeat('2', 64), v_job.id, repeat('3', 64),
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), null,
		jsonb_build_object('schema', 'qorpera.runner-result/v1', 'runtime', 'company-path-v1', 'backend', 'native-company-runtime',
			'native_lease_id', v_binding ->> 'leaseId', 'substrate_version_id', v_job.substrate_version_id,
			'output_count', 0, 'output_bytes', 0, 'publication', null,
			'backend_result', jsonb_build_object('schema', 'qorpera.native-harness-result/v2', 'run_id', v_binding ->> 'runId',
				'message_count', v_sends, 'final_message_id', v_final, 'provider_session_id', 'delete-fixture'),
			'usage', '{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,
				"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,
					"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb));
	perform pg_temp.wake_assert(v_done ->> 'status' = 'completed', 'The fixture run completes');
end
$$;

-- 2. A second run is still working when the company goes (claimed, assigned, leased), and a routine
-- is scheduled.
insert into public.qorpera_session_inputs(id, session_id, client_input_id, kind, author_user_id, body)
values ('30000000-0000-4000-8000-000000000150', '30000000-0000-4000-8000-000000000042', extensions.gen_random_uuid(),
	'kickoff', '30000000-0000-4000-8000-000000000001', '{"schema":"qorpera.staff-kickoff/v1"}');
do $$
declare v_run uuid; v_binding jsonb;
begin
	v_run := pg_temp.wake_input_run(array['30000000-0000-4000-8000-000000000150'::uuid]);
	v_binding := pg_temp.wake_start(v_run);
	perform pg_temp.wake_public_send(v_binding, 'progress');
	perform set_config('qorpera_test.delete_working', v_binding::text, true);
	perform pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
		'{"id":"daily","kind":"schedule","intervalMinutes":1440,"replyPolicy":"optional"}');
end
$$;
reset role;

-- Another company, untouched by all of this: its rows are counted now and after the delete.
insert into auth.users(id, email) values ('30000000-0000-4000-8000-000000000005', 'delete-neighbour@example.test');
select set_config('request.jwt.claims',
	'{"sub":"30000000-0000-4000-8000-000000000005","email":"delete-neighbour@example.test","role":"authenticated","user_metadata":{}}', true);
set local role authenticated;
select set_config('qorpera_test.delete_neighbour',
	public.qorpera_create_hosted_profile('Neighbour company', 'main', 1) ->> 'profile_id', true);
reset role;
create function pg_temp.company_rows(p_profile_id uuid) returns jsonb language plpgsql as $$
declare v_table regclass; v_rows bigint; v_result jsonb := '{}';
begin
	for v_table in
		select class.oid::regclass from pg_class as class
		join pg_attribute as column_row on column_row.attrelid = class.oid and column_row.attname = 'profile_id'
			and not column_row.attisdropped
		where class.relnamespace = 'public'::regnamespace and class.relkind = 'r'
		order by 1
	loop
		execute format('select count(*) from %s where profile_id = %L', v_table, p_profile_id) into v_rows;
		if v_rows > 0 then v_result := v_result || jsonb_build_object(v_table::text, v_rows); end if;
	end loop;
	return v_result;
end
$$;
select set_config('qorpera_test.delete_neighbour_rows',
	pg_temp.company_rows(current_setting('qorpera_test.delete_neighbour')::uuid)::text, true);

-- What the company has now, to check after the delete.
create temp table delete_before as
select
	(select array_agg(id) from public.qorpera_execution_runs where profile_id = '30000000-0000-4000-8000-000000000010') as runs,
	(select array_agg(id) from public.qorpera_runner_jobs where profile_id = '30000000-0000-4000-8000-000000000010') as jobs,
	(select array_agg(distinct runner_id) from public.qorpera_runner_assignments
		where run_id in (select id from public.qorpera_execution_runs where profile_id = '30000000-0000-4000-8000-000000000010')) as runners,
	(select count(*) from public.qorpera_runner_usage_observations where profile_id = '30000000-0000-4000-8000-000000000010') as usage_rows,
	(select count(*) from public.qorpera_profile_objects where profile_id = '30000000-0000-4000-8000-000000000010') as objects;
do $$
declare v delete_before%rowtype;
begin
	select * into strict v from delete_before;
	if cardinality(v.runs) < 2 or cardinality(v.runners) < 2 or v.usage_rows < 1 or v.objects < 1 then
		raise exception 'The fixture company has not run enough to test deletion: %', row_to_json(v);
	end if;
	if not exists (select 1 from public.qorpera_company_snapshot_publications as publication
			join public.qorpera_company_snapshots as snapshot on snapshot.id = publication.snapshot_id
			where snapshot.profile_id = '30000000-0000-4000-8000-000000000010'
				and publication.expected_head_snapshot_id is not null)
		or not exists (select 1 from public.qorpera_native_provider_connection_leases
			where run_id = any(v.runs) and status = 'active')
		or not exists (select 1 from public.qorpera_native_execution_launches where run_id = any(v.runs))
		or not exists (select 1 from public.qorpera_company_read_observations where run_id = any(v.runs))
		or not exists (select 1 from public.qorpera_native_context_views where run_id = any(v.runs))
		or not exists (select 1 from public.qorpera_cloud_routines where profile_id = '30000000-0000-4000-8000-000000000010') then
		raise exception 'The fixture company lacks a publication, a working lease, history or a routine';
	end if;
end
$$;

-- 3. The other members leave; the owner is the last member.
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_leave_hosted_profile('30000000-0000-4000-8000-000000000010');
reset role;
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000003');
set local role authenticated;
select public.qorpera_leave_hosted_profile('30000000-0000-4000-8000-000000000010');
reset role;

-- 4. A machine still on a node refuses the delete, and nothing is removed. A released machine is
-- only a record and goes with the company. A sign-in identity a node may still hold refuses it too,
-- released or not; so do a node's latest update target naming the company, and a row of another
-- company that depends on this one.
insert into public.qorpera_runtime_machine_allocations(id, profile_id, run_id, runner_id, provider_adapter, instance_sha256)
select '30000000-0000-4000-8000-000000000160', '30000000-0000-4000-8000-000000000010',
	(binding ->> 'runId')::uuid, (binding ->> 'runnerId')::uuid, 'lxd', repeat('7', 64)
from (select current_setting('qorpera_test.delete_working')::jsonb as binding) as working;
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.refused($q$select public.qorpera_delete_hosted_profile('30000000-0000-4000-8000-000000000010')$q$,
	'55000', 'This company still has machines running on our servers, so it cannot be deleted yet');
reset role;
do $$
begin
	if not exists (select 1 from public.qorpera_profiles where id = '30000000-0000-4000-8000-000000000010')
		or (select count(*) from public.qorpera_execution_runs where profile_id = '30000000-0000-4000-8000-000000000010')
			<> (select cardinality(runs) from delete_before)
		or exists (select 1 from public.qorpera_company_purges) then
		raise exception 'A refused delete changed the company';
	end if;
end
$$;
update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp()
where id = '30000000-0000-4000-8000-000000000160';

savepoint signed_in_identity;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, login_session_id, login_compute_identity_id,
	provider_adapter, instance_sha256, released_at)
values ('30000000-0000-4000-8000-000000000161', '30000000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.wake_login')::jsonb ->> 'login_id')::uuid,
	(current_setting('qorpera_test.wake_identity')::jsonb ->> 'compute_identity_id')::uuid,
	'lxd-login', repeat('8', 64), clock_timestamp());
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.refused($q$select public.qorpera_delete_hosted_profile('30000000-0000-4000-8000-000000000010')$q$,
	'55000', 'This company still has sign-ins stored on our servers, so it cannot be deleted yet');
reset role;
rollback to signed_in_identity;

savepoint node_update;
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes,
	headroom_cpu_millis, headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
values ('30000000-0000-4000-8000-000000000180', repeat('9', 64), 'delete-node', 1, 8000, 17179869184, 1000,
	1073741824, 4000, 8589934592, true);
insert into public.qorpera_node_update_enrollments(node_id, capability_revision, capability_sha256, enabled,
	current_revision, current_release_sha256, current_artifact_sha256)
values ('30000000-0000-4000-8000-000000000180', 1, repeat('a', 64), true, 0, repeat('b', 64), repeat('c', 64));
insert into public.qorpera_node_update_targets(node_id, revision, release_sha256, release_text, signature,
	publication_evidence_sha256, company_ids)
values ('30000000-0000-4000-8000-000000000180', 1, repeat('d', 64), '{}', 'fixture', repeat('e', 64),
	array['30000000-0000-4000-8000-000000000010'::uuid]);
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.refused($q$select public.qorpera_delete_hosted_profile('30000000-0000-4000-8000-000000000010')$q$,
	'55000', 'This company is part of a server update, so it cannot be deleted yet');
reset role;
rollback to node_update;

savepoint neighbour_row;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, run_id, runner_id, provider_adapter, instance_sha256,
	released_at)
select '30000000-0000-4000-8000-000000000162', current_setting('qorpera_test.delete_neighbour')::uuid,
	(binding ->> 'runId')::uuid, (binding ->> 'runnerId')::uuid, 'lxd', repeat('6', 64), clock_timestamp()
from (select current_setting('qorpera_test.wake_binding')::jsonb as binding) as first_run;
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.refused($q$select public.qorpera_delete_hosted_profile('30000000-0000-4000-8000-000000000010')$q$,
	'55000', 'Rows of another company depend on this company (public.qorpera_runtime_machine_allocations)');
reset role;
rollback to neighbour_row;

-- The purge deletes exactly the rows it found, table by table: no cascade reaches further.
savepoint exact_rows;
create temp table purge_table_rows (table_id oid primary key, before_rows bigint, after_rows bigint);
do $$
declare v_table oid; v_rows bigint; v_found jsonb; v_wrong text;
begin
	for v_table in select oid from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' loop
		execute format('select count(*) from %s', v_table::regclass) into v_rows;
		insert into purge_table_rows values (v_table, v_rows, null);
	end loop;
	v_found := public.qorpera_purge_company('30000000-0000-4000-8000-000000000010');
	for v_table in select oid from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' loop
		execute format('select count(*) from %s', v_table::regclass) into v_rows;
		update purge_table_rows set after_rows = v_rows where table_id = v_table;
	end loop;
	select string_agg(counted.table_id::regclass || ' ' || (counted.before_rows - counted.after_rows) || '/'
		|| coalesce(found.value, '0'), ', ')
	into v_wrong
	from purge_table_rows as counted
	left join jsonb_each_text(v_found) as found on found.key::regclass::oid = counted.table_id
	where counted.before_rows - counted.after_rows <> coalesce(found.value::bigint, 0);
	if v_wrong is not null or (select count(*) from jsonb_each_text(v_found)) < 40
		or (select value from jsonb_each_text(v_found) where key::regclass = 'public.qorpera_profiles'::regclass) <> '1' then
		raise exception 'The purge removed other rows than it found (removed/found): %', v_wrong;
	end if;
end
$$;
rollback to exact_rows;

-- 5. The last member deletes the company.
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_delete_hosted_profile('30000000-0000-4000-8000-000000000010');
reset role;

-- 6. Nothing that depended on the company is left: no row with its id in any table but the usage
-- ledgers, the computer-hour records and the stored-object queue, and no run, job or runner of it.
do $$
declare v delete_before%rowtype; v_table record; v_rows bigint; v_left text[] := '{}';
begin
	select * into strict v from delete_before;
	if exists (select 1 from public.qorpera_profiles where id = '30000000-0000-4000-8000-000000000010') then
		raise exception 'The company was not deleted';
	end if;
	for v_table in
		select class.oid::regclass as name from pg_class as class
		join pg_attribute as column_row on column_row.attrelid = class.oid and column_row.attname = 'profile_id'
			and not column_row.attisdropped
		where class.relnamespace = 'public'::regnamespace and class.relkind = 'r'
			and class.relname not in ('qorpera_runner_usage_observations', 'qorpera_runner_model_usage_observations',
				'qorpera_profile_objects', 'qorpera_deleted_profile_object_gc_leases', 'qorpera_deleted_profile_object_gc_entries')
			and class.relname not like 'qorpera\_computer\_hour\_%'
	loop
		execute format('select count(*) from %s where profile_id = %L', v_table.name, '30000000-0000-4000-8000-000000000010')
		into v_rows;
		if v_rows > 0 then v_left := v_left || (v_table.name::text || '=' || v_rows); end if;
	end loop;
	if cardinality(v_left) > 0 then
		raise exception 'Company rows left after the delete: %', v_left;
	end if;
	if exists (select 1 from public.qorpera_execution_runs where id = any(v.runs))
		or exists (select 1 from public.qorpera_runner_jobs where id = any(v.jobs))
		or exists (select 1 from public.qorpera_runners where id = any(v.runners))
		or exists (select 1 from public.qorpera_runner_assignments where run_id = any(v.runs) or runner_id = any(v.runners))
		or exists (select 1 from public.qorpera_runner_job_claims where run_id = any(v.runs))
		or exists (select 1 from public.qorpera_native_provider_connection_leases where run_id = any(v.runs))
		or exists (select 1 from public.qorpera_execution_run_events where run_id = any(v.runs))
		or exists (select 1 from public.qorpera_native_execution_launches where run_id = any(v.runs))
		or exists (select 1 from public.qorpera_runtime_machine_allocations
			where id = '30000000-0000-4000-8000-000000000160') then
		raise exception 'Runtime rows of the deleted company are left';
	end if;
	-- Usage records stay for bookkeeping, with the deleted company's ids as plain values.
	if (select count(*) from public.qorpera_runner_usage_observations
			where profile_id = '30000000-0000-4000-8000-000000000010') <> v.usage_rows then
		raise exception 'Usage records did not outlive the company';
	end if;
	if (select count(*) from public.qorpera_profile_objects
			where profile_id = '30000000-0000-4000-8000-000000000010') <> v.objects then
		raise exception 'The stored-object queue of the deleted company changed';
	end if;
	if exists (select 1 from public.qorpera_company_purges) then
		raise exception 'The purge left its marker';
	end if;
	if pg_temp.company_rows(current_setting('qorpera_test.delete_neighbour')::uuid)
		<> current_setting('qorpera_test.delete_neighbour_rows')::jsonb then
		raise exception 'Deleting one company changed another';
	end if;
end
$$;

-- 7. Outside a purge, history stays immutable.
select pg_temp.refused($q$delete from public.qorpera_runner_usage_observations
	where profile_id = '30000000-0000-4000-8000-000000000010'$q$, '55000', 'usage observations are immutable');
select pg_temp.refused($q$delete from public.qorpera_runtime_bundles
	where id = (select runtime_bundle_id from public.qorpera_active_runtime_bundle)$q$, '42501', 'Runtime bundles are immutable');

-- 8. The stored bytes go through the deleted-company cleanup, as before.
select set_config('qorpera_test.delete_objects', (select objects::text from delete_before), true);
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare v_job jsonb; v_attempt integer := 0;
begin
	loop
		v_attempt := v_attempt + 1;
		v_job := public.qorpera_claim_deleted_profile_object_gc(100, extensions.gen_random_uuid());
		exit when v_job ->> 'profile_id' = '30000000-0000-4000-8000-000000000010' or v_job ->> 'profile_id' is null or v_attempt > 50;
	end loop;
	if v_job ->> 'profile_id' is distinct from '30000000-0000-4000-8000-000000000010'
		or jsonb_array_length(v_job -> 'objects') <> current_setting('qorpera_test.delete_objects')::integer then
		raise exception 'The deleted company''s bytes are not queued for cleanup: %', v_job;
	end if;
end
$$;
reset role;

rollback;
