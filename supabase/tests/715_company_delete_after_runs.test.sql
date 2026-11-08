-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Deleting a folder-v2 company that has used its agents (20260928248920, and since 20260928249150 in two steps: the request
-- hides the company and stops its work, the finisher purges it), ported from snapshot-v1 in the legacy sweep. Before,
-- qorpera_delete_hosted_profile failed with 23503 for any company with a run: runner assignments, claims, leases and events
-- restrict their parents and have no link to the company. Here the base company finishes one real run (Alice's, the
-- fixture's) that wrote a note through a folder commit, keeps a second run working (Bob's, from a thread post), has a
-- routine file, and is then deleted by its last member. Everything that depends on it goes; usage records and the
-- stored-object catalog stay. (The deleted company's bytes then go through the deleted-company cleanup: 922 §2–3.)

create function pg_temp.del_refused(p_sql text, p_state text, p_message text) returns void language plpgsql as $$
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
			or has_function_privilege(v_role, 'public.qorpera_request_company_deletion(uuid,uuid)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_stop_company_work(uuid)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_finish_company_deletion(uuid)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_finish_company_deletions(integer)', 'EXECUTE')
			or has_table_privilege(v_role, 'public.qorpera_company_deletions', 'INSERT,SELECT,UPDATE,DELETE')
			or has_function_privilege(v_role, 'public.qorpera_company_deleting(uuid)', 'EXECUTE')
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
			'public.qorpera_guard_office_delete_disposition()'::regprocedure,
			-- The live hint (20260930653000) is deferred and absorbs every error: it never refuses a delete.
			'public.qorpera_live_hint_internal()'::regprocedure);
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
		('qorpera_guard_office_delete_disposition', '42501', 'Office delete disposition is immutable')) as guard(name, state, message)
	loop
		execute format('create trigger purge_guard before delete on purge_guard_probe for each row execute function public.%I()', v_guard.name);
		insert into purge_guard_probe values (extensions.gen_random_uuid());
		if v_guard.state is not null then
			perform pg_temp.del_refused('delete from purge_guard_probe', v_guard.state, v_guard.message);
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

-- 1. Alice's run (the base fixture's) records its native start, acknowledges, writes a note through a folder commit,
-- reads it and releases the read, records a model request's context, answers and completes with the governed v6
-- completion's folder lane (result, usage record, lease history).
select pg_temp.base_claims('service_role');
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_identity jsonb; v_actor jsonb;
	v_read jsonb; v_done jsonb; v_sends integer; v_final text;
begin
	v_actor := jsonb_build_object('kind', 'run', 'runId', v_binding ->> 'runId', 'jobId', v_binding ->> 'jobId',
		'runnerId', v_binding ->> 'runnerId', 'assignmentId', v_binding ->> 'assignmentId');
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	perform public.qorpera_begin_native_company_execution_v2(v_binding,
		(select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
			join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
		v_identity ->> 'runtimeBundleSha256', v_identity ->> 'reasoningPolicySha256',
		'{"type":"namespace","name":"qorpera","description":"Synthetic native fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
		repeat('c', 64), 10);
	perform pg_temp.base_public_send(v_binding, 'progress', 'delete-ack');
	perform pg_temp.base_commit(v_actor, 'delete-note', jsonb_build_array(jsonb_build_object('op', 'write', 'path', 'note.md',
		'file', pg_temp.base_stage('Written before the company is deleted'))));
	-- A read and a model request's context view: immutable history of the company.
	v_read := public.qorpera_folder_read('92400000-0000-4000-8000-000000000020', v_actor, 'note.md') -> 'entry';
	perform public.qorpera_folder_record_release('92400000-0000-4000-8000-000000000020', v_actor, extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', v_read ->> 'path', 'version', v_read ->> 'version', 'authority', v_read -> 'authority')),
		repeat('0', 64));
	perform public.qorpera_record_native_context_view('92400000-0000-4000-8000-000000000020', v_binding, jsonb_build_object(
		'schema', 'qorpera.native-context-view/v1', 'requestId', 'delete-request', 'threadId', 'thread-1',
		'turnId', 'turn-1', 'purpose', 'turn', 'outputs', '[]'::jsonb));
	perform pg_temp.base_public_send(v_binding, 'final', 'delete-final');
	select count(*), max(send.event_id::text) filter (where send.phase = 'final') into v_sends, v_final
	from public.qorpera_agent_sends as send where send.run_id = (v_binding ->> 'runId')::uuid;
	v_done := public.qorpera_complete_runner_job_v6((v_binding ->> 'runnerId')::uuid, repeat('2', 64), (v_binding ->> 'jobId')::uuid,
		repeat('3', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(), null,
		jsonb_build_object('schema', 'qorpera.runner-result/v1', 'runtime', 'company-path-v1', 'backend', 'native-company-runtime',
			'native_lease_id', v_binding ->> 'leaseId', 'substrate_version_id', null,
			'output_count', 0, 'output_bytes', 0, 'publication', null,
			'backend_result', jsonb_build_object('schema', 'qorpera.native-harness-result/v2', 'run_id', v_binding ->> 'runId',
				'message_count', v_sends, 'final_message_id', v_final, 'provider_session_id', 'delete-fixture'),
			'usage', '{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,
				"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,
					"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb));
	perform pg_temp.base_assert(v_done ->> 'status' = 'completed' and v_done #>> '{result,company_file,disposition}' = 'published',
		'The fixture run completes, publishing its note: ' || v_done::text);
end
$$;

-- 2. A second run is still working when the company goes (the owner's post in Bob's thread, materialized, claimed,
-- assigned and leased), and Bob has a routine file the owner saved.
do $$
declare v_pass jsonb; v_binding jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031', 'Check the numbers.');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'Bob''s run: ' || v_pass::text);
	v_binding := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	perform pg_temp.base_public_send(v_binding, 'progress', 'delete-working-ack');
	perform set_config('qorpera_test.delete_working', v_binding::text, true);
	perform pg_temp.base_commit(pg_temp.base_owner(), 'delete-routine', jsonb_build_array(pg_temp.base_write(
		'QorperaOS/agents/bob/routines/daily.md', 'routine', E'---\ntitle: Daily\n---\n',
		jsonb_build_object('kind', 'routine', 'id', '71500000-0000-4000-8000-0000000000e1', 'title', 'Daily', 'status', 'active',
			'trigger', jsonb_build_object('when', 'every', 'minutes', 1440, 'starts', null), 'timezone', null, 'ends', null,
			'runs', null, 'quiet', null, 'effort', 'medium', 'reply', 'optional', 'conclusion', null,
			'instructions', 'Look at the numbers.'))));
end
$$;
select pg_temp.base_claims('service_role');

-- Another folder-v2 company (made as the base makes its own), untouched by all of this: its rows are counted now and
-- after the delete.
insert into auth.users(id, email) values ('71500000-0000-4000-8000-000000000005', 'delete-neighbour@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('71500000-0000-4000-8000-000000000010', 'Neighbour company', '71500000-0000-4000-8000-000000000005');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('71500000-0000-4000-8000-000000000010', '71500000-0000-4000-8000-000000000005', 'delete-neighbour@example.test', 'Neighbour',
	'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('71500000-0000-4000-8000-000000000020', '71500000-0000-4000-8000-000000000010', 'Environment', 1,
	'71500000-0000-4000-8000-000000000005');
select public.qorpera_folder_enable('71500000-0000-4000-8000-000000000020') \g /dev/null
select set_config('qorpera_test.delete_neighbour', '71500000-0000-4000-8000-000000000010', true) \g /dev/null
create function pg_temp.del_company_rows(p_profile_id uuid) returns jsonb language plpgsql as $$
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
select pg_temp.base_assert(public.qorpera_company_is_folder_v2(current_setting('qorpera_test.delete_neighbour')::uuid)
	and pg_temp.del_company_rows(current_setting('qorpera_test.delete_neighbour')::uuid) ? 'qorpera_company_files',
	'The neighbour is a folder-v2 company');
select set_config('qorpera_test.delete_neighbour_rows',
	pg_temp.del_company_rows(current_setting('qorpera_test.delete_neighbour')::uuid)::text, true) \g /dev/null

-- What the company has now, to check after the delete.
create temp table delete_before as
select
	(select array_agg(id) from public.qorpera_execution_runs where profile_id = '92400000-0000-4000-8000-000000000010') as runs,
	(select array_agg(id) from public.qorpera_runner_jobs where profile_id = '92400000-0000-4000-8000-000000000010') as jobs,
	(select array_agg(distinct runner_id) from public.qorpera_runner_assignments
		where run_id in (select id from public.qorpera_execution_runs where profile_id = '92400000-0000-4000-8000-000000000010')) as runners,
	(select count(*) from public.qorpera_runner_usage_observations where profile_id = '92400000-0000-4000-8000-000000000010') as usage_rows,
	(select count(*) from public.qorpera_profile_objects where profile_id = '92400000-0000-4000-8000-000000000010') as objects;
do $$
declare v delete_before%rowtype;
begin
	select * into strict v from delete_before;
	if cardinality(v.runs) < 2 or cardinality(v.runners) < 2 or v.usage_rows < 1 or v.objects < 1 then
		raise exception 'The fixture company has not run enough to test deletion: %', row_to_json(v);
	end if;
	-- A run's published folder commit, a working lease, the run history, the folder's byte path and a routine.
	if not exists (select 1 from public.qorpera_folder_commits as commit_row
			join public.qorpera_execution_run_results as result on result.folder_commit_id = commit_row.id
			where commit_row.run_id = any(v.runs) and result.company_disposition = 'published')
		or not exists (select 1 from public.qorpera_native_provider_connection_leases
			where run_id = any(v.runs) and status = 'active')
		or not exists (select 1 from public.qorpera_native_execution_launches where run_id = any(v.runs))
		or not exists (select 1 from public.qorpera_folder_run_releases where run_id = any(v.runs))
		or not exists (select 1 from public.qorpera_native_context_views where run_id = any(v.runs))
		or not exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '92400000-0000-4000-8000-000000000010')
		or not exists (select 1 from public.qorpera_folder_file_chunks where profile_id = '92400000-0000-4000-8000-000000000010')
		or not exists (select 1 from public.qorpera_folder_storage_usage where profile_id = '92400000-0000-4000-8000-000000000010')
		or not exists (select 1 from public.qorpera_cloud_routines where profile_id = '92400000-0000-4000-8000-000000000010'
			and folder_path = 'QorperaOS/agents/bob/routines/daily.md') then
		raise exception 'The fixture company lacks a published commit, a working lease, history, folder bytes or a routine';
	end if;
end
$$;

-- 3. The other members leave; the owner is the last member.
do $$
declare v_member uuid;
begin
	foreach v_member in array array['92400000-0000-4000-8000-000000000002', '92400000-0000-4000-8000-000000000003',
		'92400000-0000-4000-8000-000000000004']::uuid[] loop
		perform pg_temp.base_claims('authenticated', v_member);
		perform public.qorpera_leave_hosted_profile('92400000-0000-4000-8000-000000000010');
	end loop;
	perform pg_temp.base_claims('service_role');
	if (select array_agg(user_id) from public.qorpera_profile_members where profile_id = '92400000-0000-4000-8000-000000000010')
		<> array['92400000-0000-4000-8000-000000000001']::uuid[] then
		raise exception 'The owner is not the last member';
	end if;
end
$$;

-- A pending invitation, which the delete withdraws.
insert into public.qorpera_profile_invitations(profile_id, email, role, invited_by_user_id, expires_at)
values ('92400000-0000-4000-8000-000000000010', 'late-invitee@example.test', 'contributor',
	'92400000-0000-4000-8000-000000000001', clock_timestamp() + interval '7 days');
select set_config('qorpera_test.delete_fence', (select revision::text from public.qorpera_folder_fences
	where profile_id = '92400000-0000-4000-8000-000000000010'), true) \g /dev/null

-- 4. The last member deletes the company (20260928249150). It disappears at once and all its work
-- stops, but its rows stay until the nodes hold nothing of it.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_delete_hosted_profile('92400000-0000-4000-8000-000000000010') \g /dev/null
do $$
begin
	if public.qorpera_member_role('92400000-0000-4000-8000-000000000010') is not null
		or public.qorpera_list_hosted_profiles() @> jsonb_build_array(jsonb_build_object(
			'profile_id', '92400000-0000-4000-8000-000000000010'))
		or exists (select 1 from public.qorpera_company_environments
			where profile_id = '92400000-0000-4000-8000-000000000010')
		or (select status from public.qorpera_profile_access_state
			where profile_id = '92400000-0000-4000-8000-000000000010'
				and user_id = '92400000-0000-4000-8000-000000000001') is distinct from 'revoked' then
		raise exception 'A company being deleted is still visible to its member';
	end if;
end
$$;
select pg_temp.del_refused($q$select public.qorpera_profile_team_info('92400000-0000-4000-8000-000000000010')$q$,
	'42501', 'profile read access is required');
select pg_temp.del_refused($q$select public.qorpera_delete_hosted_profile('92400000-0000-4000-8000-000000000010')$q$,
	'42501', 'deleting a company requires membership');
reset role;
do $$
declare v_working jsonb := current_setting('qorpera_test.delete_working')::jsonb;
begin
	if not public.qorpera_company_execution_paused('92400000-0000-4000-8000-000000000010')
		or not exists (select 1 from public.qorpera_company_execution_pauses
			where profile_id = '92400000-0000-4000-8000-000000000010' and reason = 'Company deleted') then
		raise exception 'A company being deleted is not paused';
	end if;
	if exists (select 1 from public.qorpera_runner_jobs
			where profile_id = '92400000-0000-4000-8000-000000000010' and status in ('queued', 'leased'))
		or (select status from public.qorpera_runner_jobs where id = (v_working ->> 'jobId')::uuid) <> 'failed'
		or exists (select 1 from public.qorpera_profile_invitations where profile_id = '92400000-0000-4000-8000-000000000010') then
		raise exception 'A company being deleted still has work or invitations';
	end if;
	if not exists (select 1 from public.qorpera_profiles where id = '92400000-0000-4000-8000-000000000010')
		or (select count(*) from public.qorpera_execution_runs where profile_id = '92400000-0000-4000-8000-000000000010')
			<> (select cardinality(runs) from delete_before) then
		raise exception 'Requesting the deletion removed rows before the nodes were clear';
	end if;
end
$$;
-- Nothing resumes it: the folder's resume refuses a company being deleted.
select pg_temp.del_refused($q$select public.qorpera_folder_resume('92400000-0000-4000-8000-000000000010')$q$,
	'55000', 'The company is being deleted');

-- 5. A machine still on a node keeps the deletion waiting, and nothing is removed. A released machine
-- is only a record and goes with the company. A sign-in identity a node may still hold waits too,
-- released or not, until that node retires it (D4); so does a node's latest update target naming the company; and a row of another
-- company that depends on this one fails the purge, which is recorded and retried.
create function pg_temp.del_finish() returns jsonb language sql as $$
	select public.qorpera_finish_company_deletion('92400000-0000-4000-8000-000000000010')
$$;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, run_id, runner_id, provider_adapter, instance_sha256)
select '71500000-0000-4000-8000-000000000160', '92400000-0000-4000-8000-000000000010',
	(binding ->> 'runId')::uuid, (binding ->> 'runnerId')::uuid, 'lxd', repeat('7', 64)
from (select current_setting('qorpera_test.delete_working')::jsonb as binding) as working;
do $$
declare v_result jsonb := pg_temp.del_finish();
begin
	if v_result ->> 'state' <> 'waiting' or v_result #>> '{holdings,machines}' <> '1'
		or (select holdings #>> '{machines}' from public.qorpera_company_deletions
			where profile_id = '92400000-0000-4000-8000-000000000010') <> '1'
		or not exists (select 1 from public.qorpera_profiles where id = '92400000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_company_purges) then
		raise exception 'A machine on a node did not keep the deletion waiting: %', v_result;
	end if;
	-- The finisher's pass drained the folder fence first (the folder pause's second phase, for deletion).
	if (select revision from public.qorpera_folder_fences where profile_id = '92400000-0000-4000-8000-000000000010')
		<= current_setting('qorpera_test.delete_fence')::bigint then
		raise exception 'The finisher did not drain the company''s folder fence';
	end if;
end
$$;
update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp()
where id = '71500000-0000-4000-8000-000000000160';

savepoint signed_in_identity;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, login_session_id, login_compute_identity_id,
	provider_adapter, instance_sha256, released_at)
values ('71500000-0000-4000-8000-000000000161', '92400000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.base_login')::jsonb ->> 'login_id')::uuid,
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid,
	'lxd-login', repeat('8', 64), clock_timestamp());
-- Only a sign-in placed on a node can have left a volume there (20260928269450, D4).
savepoint unplaced_identity;
select pg_temp.base_assert(pg_temp.del_finish() ->> 'state' = 'purged', 'A sign-in never placed on a node holds nothing');
rollback to unplaced_identity;
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes,
	headroom_cpu_millis, headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
values ('71500000-0000-4000-8000-000000000181', repeat('9', 64), 'delete-login-node', 1, 8000, 17179869184, 1000,
	1073741824, 4000, 8589934592, true);
insert into public.qorpera_runtime_node_providers(provider_kind, provider_id, node_id, policy_sha256, cpu_millis, memory_bytes)
values ('login', 'lxd-login', '71500000-0000-4000-8000-000000000181', repeat('2', 64), 2000, 4294967296);
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256,
	cpu_millis, memory_bytes, reserved_at, released_at)
values ('71500000-0000-4000-8000-000000000161', '71500000-0000-4000-8000-000000000181', 'login', 'lxd-login',
	repeat('2', 64), 2000, 4294967296, clock_timestamp(), clock_timestamp());
select pg_temp.base_assert(pg_temp.del_finish() #>> '{holdings,identities}' = '1', 'A sign-in a node may still hold keeps the deletion waiting');
rollback to signed_in_identity;

savepoint node_update;
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes,
	headroom_cpu_millis, headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
values ('71500000-0000-4000-8000-000000000180', repeat('9', 64), 'delete-node', 1, 8000, 17179869184, 1000,
	1073741824, 4000, 8589934592, true);
insert into public.qorpera_node_update_enrollments(node_id, capability_revision, capability_sha256, enabled,
	current_revision, current_release_sha256, current_artifact_sha256)
values ('71500000-0000-4000-8000-000000000180', 1, repeat('a', 64), true, 0, repeat('b', 64), repeat('c', 64));
insert into public.qorpera_node_update_targets(node_id, revision, release_sha256, release_text, signature,
	publication_evidence_sha256, company_ids)
values ('71500000-0000-4000-8000-000000000180', 1, repeat('d', 64), '{}', 'fixture', repeat('e', 64),
	array['92400000-0000-4000-8000-000000000010'::uuid]);
select pg_temp.base_assert(pg_temp.del_finish() #>> '{holdings,node_updates}' = '1', 'An update target keeps the deletion waiting');
select pg_temp.del_refused($q$select public.qorpera_purge_company('92400000-0000-4000-8000-000000000010')$q$,
	'55000', 'This company is part of a server update, so it cannot be deleted yet');
rollback to node_update;

savepoint neighbour_row;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, run_id, runner_id, provider_adapter, instance_sha256,
	released_at)
select '71500000-0000-4000-8000-000000000162', current_setting('qorpera_test.delete_neighbour')::uuid,
	(binding ->> 'runId')::uuid, (binding ->> 'runnerId')::uuid, 'lxd', repeat('6', 64), clock_timestamp()
from (select current_setting('qorpera_test.base_binding')::jsonb as binding) as first_run;
do $$
declare v_result jsonb := pg_temp.del_finish();
begin
	if v_result ->> 'state' <> 'failed'
		or v_result ->> 'error' <> '55000: Rows of another company depend on this company (public.qorpera_runtime_machine_allocations)'
		or (select last_error from public.qorpera_company_deletions where profile_id = '92400000-0000-4000-8000-000000000010')
			<> v_result ->> 'error'
		or not exists (select 1 from public.qorpera_profiles where id = '92400000-0000-4000-8000-000000000010') then
		raise exception 'A failed purge was not recorded, or it changed the company: %', v_result;
	end if;
end
$$;
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
	v_found := public.qorpera_purge_company('92400000-0000-4000-8000-000000000010');
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
		or (select value from jsonb_each_text(v_found) where key::regclass = 'public.qorpera_profiles'::regclass) <> '1'
		or (select value::bigint from jsonb_each_text(v_found) where key::regclass = 'public.qorpera_folder_commits'::regclass) < 1 then
		raise exception 'The purge removed other rows than it found (removed/found): %', v_wrong;
	end if;
end
$$;
rollback to exact_rows;

-- 6. With the nodes clear, the operator's finisher purges the company; the deletion record stays.
do $$
declare v_result jsonb := public.qorpera_finish_company_deletions(5);
begin
	if not v_result -> 'companies' @> jsonb_build_array(jsonb_build_object(
			'profileId', '92400000-0000-4000-8000-000000000010', 'state', 'purged'))
		or (select purged_at is null or last_error is not null from public.qorpera_company_deletions
			where profile_id = '92400000-0000-4000-8000-000000000010')
		or pg_temp.del_finish() ->> 'state' <> 'purged'
		or public.qorpera_finish_company_deletions(5) -> 'companies' @> jsonb_build_array(jsonb_build_object(
			'profileId', '92400000-0000-4000-8000-000000000010')) then
		raise exception 'The finisher did not purge the company once: %', v_result;
	end if;
end
$$;

-- 7. Nothing that depended on the company is left: no row with its id in any table but the usage
-- ledgers, the computer-hour records, the stored-object catalog and the deletion record, and no run,
-- job, runner or folder row of it. The follow-up queue's work rows have no foreign key (nothing holding the fence waits
-- on them): the queue's own sweep takes those of an environment that is gone, and then none is left.
do $$
declare v delete_before%rowtype; v_table record; v_rows bigint; v_left text[] := '{}'; i integer;
begin
	select * into strict v from delete_before;
	if exists (select 1 from public.qorpera_profiles where id = '92400000-0000-4000-8000-000000000010') then
		raise exception 'The company was not deleted';
	end if;
	if not exists (select 1 from public.qorpera_folder_follow_ups where environment_id = '92400000-0000-4000-8000-000000000020') then
		raise exception 'Fixture: the company''s follow-up rows were not left for the sweep';
	end if;
	for i in 1..50 loop exit when public.qorpera_folder_follow_up_sweep() = 0; end loop;
	if exists (select 1 from public.qorpera_folder_follow_ups where environment_id = '92400000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_follow_up_marks where environment_id = '92400000-0000-4000-8000-000000000020') then
		raise exception 'The follow-up queue''s sweep left the deleted company''s work';
	end if;
	for v_table in
		select class.oid::regclass as name from pg_class as class
		join pg_attribute as column_row on column_row.attrelid = class.oid and column_row.attname = 'profile_id'
			and not column_row.attisdropped
		where class.relnamespace = 'public'::regnamespace and class.relkind = 'r'
			and class.relname not in ('qorpera_runner_usage_observations', 'qorpera_runner_model_usage_observations',
				'qorpera_profile_objects', 'qorpera_deleted_profile_object_gc_leases', 'qorpera_deleted_profile_object_gc_entries',
				'qorpera_company_deletions')
			and class.relname not like 'qorpera\_computer\_hour\_%'
	loop
		execute format('select count(*) from %s where profile_id = %L', v_table.name, '92400000-0000-4000-8000-000000000010')
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
			where id = '71500000-0000-4000-8000-000000000160') then
		raise exception 'Runtime rows of the deleted company are left';
	end if;
	-- The folder's environment-keyed rows go with it.
	if exists (select 1 from public.qorpera_folder_entries where environment_id = '92400000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_commits where environment_id = '92400000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_run_releases where run_id = any(v.runs))
		or exists (select 1 from public.qorpera_folder_clocks where environment_id = '92400000-0000-4000-8000-000000000020') then
		raise exception 'Folder rows of the deleted company are left';
	end if;
	-- Usage records stay for bookkeeping, with the deleted company's ids as plain values.
	if (select count(*) from public.qorpera_runner_usage_observations
			where profile_id = '92400000-0000-4000-8000-000000000010') <> v.usage_rows then
		raise exception 'Usage records did not outlive the company';
	end if;
	if (select count(*) from public.qorpera_profile_objects
			where profile_id = '92400000-0000-4000-8000-000000000010') <> v.objects then
		raise exception 'The stored-object catalog of the deleted company changed';
	end if;
	if exists (select 1 from public.qorpera_company_purges) then
		raise exception 'The purge left its marker';
	end if;
	if pg_temp.del_company_rows(current_setting('qorpera_test.delete_neighbour')::uuid)
		<> current_setting('qorpera_test.delete_neighbour_rows')::jsonb then
		raise exception 'Deleting one company changed another';
	end if;
end
$$;

-- 8. Outside a purge, history stays immutable.
select pg_temp.del_refused($q$delete from public.qorpera_runner_usage_observations
	where profile_id = '92400000-0000-4000-8000-000000000010'$q$, '55000', 'usage observations are immutable');
select pg_temp.del_refused($q$update public.qorpera_runner_usage_observations set execution_ms = execution_ms
	where profile_id = '92400000-0000-4000-8000-000000000010'$q$, '55000', 'usage observations are immutable');
select pg_temp.del_refused($q$delete from public.qorpera_runtime_bundles
	where id = (select runtime_bundle_id from public.qorpera_active_runtime_bundle)$q$, '42501', 'Runtime bundles are immutable');

rollback;
