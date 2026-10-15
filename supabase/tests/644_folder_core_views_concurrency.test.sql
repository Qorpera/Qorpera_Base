-- Company folder core, C1b-3a: views under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1B.md, "C1b-3: views"
-- §3 and §4). Other connections race view saves: a holder change that commits while a save waits at its anchor step
-- refuses the save; the office's and the coding archive's plain updates wait for a save in flight; the company row at
-- rank 0 never deadlocks with #462's order (company row, then member); a shell command's end and its view's final race
-- the view's saves (20260930183000). The fixture is committed so the connections can see it, and removed at the end.
-- Waits are detected with pg_blocking_pids, never by wall-clock time.

insert into auth.users(id,email) values ('64400000-0000-4000-8000-000000000001','views-race-owner@example.test'),
	('64400000-0000-4000-8000-000000000002','views-race-member@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('64400000-0000-4000-8000-000000000010','Folder views race fixture','64400000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('64400000-0000-4000-8000-000000000010','64400000-0000-4000-8000-000000000001','views-race-owner@example.test','Owner','owner'),
	('64400000-0000-4000-8000-000000000010','64400000-0000-4000-8000-000000000002','views-race-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('64400000-0000-4000-8000-000000000020','64400000-0000-4000-8000-000000000010','Environment',1,'64400000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter, appearance_color, appearance_shape,
	employment_status, lifecycle_state, created_at, updated_at, updated_by_user_id) values
	('64400000-0000-4000-8000-000000000010','64400000-0000-4000-8000-0000000000a1','Agent A','QA','Test.','green','round','active','active',
		statement_timestamp(), statement_timestamp(), '64400000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select public.qorpera_folder_enable('64400000-0000-4000-8000-000000000020');
-- The runs' sponsor (binding id = agent A's id): a company login, which pays for any member's work (20260928230000).
-- Then a company machine with one seat for agent A, as in 639: office, current activation, the seat's screen, access.
set session_replication_role = replica;
insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, provider, created_by_user_id)
values ('64400000-0000-4000-8000-0000000000b3', '64400000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), 'openai', '64400000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id)
values ('64400000-0000-4000-8000-0000000000a1', '64400000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), '64400000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id, provider_connection_version,
	created_by_user_id)
values ('64400000-0000-4000-8000-0000000000a1', 1, 'company_service_account', '64400000-0000-4000-8000-0000000000b3', 1, '64400000-0000-4000-8000-000000000001');
insert into public.qorpera_runtime_offices(id, profile_id, environment_id, logical_computer_id, client_computer_id, image_sha256,
	bootstrap_sha256, state, generation, revision, max_screens, created_by_user_id, privacy_state, privacy_version, computer_number)
values ('64400000-0000-4000-8000-0000000000e0', '64400000-0000-4000-8000-000000000010', '64400000-0000-4000-8000-000000000020',
	extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('1', 64), repeat('2', 64), 'active', 1, 1, 6,
	'64400000-0000-4000-8000-000000000001', 'shared', 0, 1);
insert into public.qorpera_runtime_machine_allocations(id, profile_id, provider_adapter, instance_sha256, office_id, computer_generation, reserved_at)
values ('64400000-0000-4000-8000-0000000000e1', '64400000-0000-4000-8000-000000000010', 'lxd', repeat('3', 64),
	'64400000-0000-4000-8000-0000000000e0', 1, clock_timestamp());
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis, memory_bytes, reserved_at)
values ('64400000-0000-4000-8000-0000000000e1', '64400000-0000-4000-8000-0000000000e2', 'lxd', 'node', repeat('4', 64), 1000, 1073741824,
	clock_timestamp());
insert into public.qorpera_runtime_office_activations(intent_id, activation_id, office_id, computer_generation, allocation_id, provider_id,
	provider_policy_sha256, provider_binding_sha256, instance_sha256, image_sha256, bootstrap_sha256, attestation, mappings, state,
	service_invocation_id, ready_at, activated_at)
values (extensions.gen_random_uuid(), '64400000-0000-4000-8000-0000000000e3', '64400000-0000-4000-8000-0000000000e0', 1,
	'64400000-0000-4000-8000-0000000000e1', extensions.gen_random_uuid(), repeat('5', 64), repeat('6', 64), repeat('3', 64),
	repeat('1', 64), repeat('2', 64), '{}', '{}', 'active', repeat('7', 32), clock_timestamp(), clock_timestamp());
insert into public.qorpera_runtime_office_screens(id, office_id, ordinal, staff_agent_id, generation, epoch, power)
values ('64400000-0000-4000-8000-0000000000e4', '64400000-0000-4000-8000-0000000000e0', 1, '64400000-0000-4000-8000-0000000000a1',
	1, 1, 'open');
insert into public.qorpera_runtime_office_access(office_id, staff_agent_id, profile_id, version, state, capabilities, configured_by_user_id)
values ('64400000-0000-4000-8000-0000000000e0', '64400000-0000-4000-8000-0000000000a1', '64400000-0000-4000-8000-000000000010', 1,
	'active', '["desktop","shell"]', '64400000-0000-4000-8000-000000000001');
set session_replication_role = origin;

-- A hand-built leased human run of agent A for the member (see 635), committed. Returns the run actor.
create function pg_temp.run() returns jsonb language plpgsql as $$
declare
	v_profile uuid := '64400000-0000-4000-8000-000000000010'; v_env uuid := '64400000-0000-4000-8000-000000000020';
	v_staff uuid := '64400000-0000-4000-8000-0000000000a1'; v_requester uuid := '64400000-0000-4000-8000-000000000002';
	v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid(); v_wake uuid := extensions.gen_random_uuid();
	v_runner uuid := extensions.gen_random_uuid(); v_assignment uuid := extensions.gen_random_uuid();
	v_session uuid; v_input uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	select id into v_session from public.qorpera_shared_sessions where profile_id = v_profile and staff_agent_id = v_staff::text and status = 'open';
	if v_session is null then
		insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id, staff_agent_id, staff_version)
		values (extensions.gen_random_uuid(), v_profile, v_env, 'Agent thread', v_requester, v_staff::text, 1) returning id into v_session;
	end if;
	insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
		runtime_bundle_id, runtime_bundle_sha256, execution_run_id)
	values (v_input, v_session, extensions.gen_random_uuid(), v_requester, 'human', 'user_message', v_staff, repeat('b', 64), v_run);
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		v_requester, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids)
	values (v_run, v_profile, v_env, 'session_turn', v_input, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		v_staff, 1, v_staff, 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_requester, v_requester, 'openai', 'gpt-test',
		'provider_default', 'company', v_staff, repeat('b', 64), v_session, array[v_input]);
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
		sponsor_version, session_id, causal_root_id, causal_agent_ids, payload)
	values (v_wake, v_profile, v_env, 'input', v_wake::text, clock_timestamp(), clock_timestamp(), 'human', 'input', v_input,
		v_run, 'materialized', v_staff, 1, v_requester, v_staff, 1, v_session, v_wake, array[v_staff],
		jsonb_build_object('inputIds', jsonb_build_array(v_input)));
	set local session_replication_role = origin;
	return jsonb_build_object('kind','run','runId',v_run,'jobId',v_job,'runnerId',v_runner,'assignmentId',v_assignment);
end $$;

-- The statement that makes the screen held by a run, as the office's legacy writers do: a plain UPDATE.
create function pg_temp.sql_hold(p_run jsonb) returns text language sql as $$
	select format('update public.qorpera_runtime_office_screens set lease_id = extensions.gen_random_uuid(), run_id = %L,
		lease_expires_at = clock_timestamp() + interval ''10 minutes'', grant_version = 1, native_binding = ''{}'', takeover_user_id = null,
		epoch = epoch + 1 where id = ''64400000-0000-4000-8000-0000000000e4''', p_run ->> 'runId')
$$;
create function pg_temp.hold(p_run jsonb) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute pg_temp.sql_hold(p_run);
	set local session_replication_role = origin;
end $$;

create function pg_temp.fx_release_screen() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runtime_office_screens set lease_id = null, run_id = null, lease_expires_at = null, grant_version = null,
		native_binding = null, takeover_user_id = null, epoch = epoch + 1 where id = '64400000-0000-4000-8000-0000000000e4';
	set local session_replication_role = origin;
end $$;

select set_config('qorpera_test.run_one', pg_temp.run()::text, false);
select set_config('qorpera_test.run_two', pg_temp.run()::text, false);
select pg_temp.hold(current_setting('qorpera_test.run_one')::jsonb);

-- A coding session of agent A, owned by the member, attached to the member's coding machine (as in 639).
set session_replication_role = replica;
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
values ('64400000-0000-4000-8000-0000000000c1', '64400000-0000-4000-8000-000000000010', '64400000-0000-4000-8000-000000000020',
	'64400000-0000-4000-8000-0000000000a1', extensions.gen_random_uuid(), 'w-coding', 'coding', 'Code', 'read', 'each', '{}',
	'64400000-0000-4000-8000-000000000002', (current_setting('qorpera_test.run_one')::jsonb ->> 'runId')::uuid,
	'64400000-0000-4000-8000-000000000002', '64400000-0000-4000-8000-0000000000a1', 1);
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values ('64400000-0000-4000-8000-0000000000c2', 'member', '64400000-0000-4000-8000-000000000010', '64400000-0000-4000-8000-000000000020',
	'64400000-0000-4000-8000-000000000002', 'exec-644', repeat('8', 64), '{}');
insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, attached_machine_id,
	attachment_token, attachment_until, attachment_turn, attached_at)
values ('64400000-0000-4000-8000-0000000000c1', '64400000-0000-4000-8000-000000000010', '64400000-0000-4000-8000-000000000020',
	'claude-code', '{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'qorpera/w-coding',
	'64400000-0000-4000-8000-0000000000c2', '64400000-0000-4000-8000-0000000000c3', clock_timestamp() + interval '30 minutes', 1, clock_timestamp());
insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
values ('64400000-0000-4000-8000-000000000020', '64400000-0000-4000-8000-0000000000a1',
	'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', true);
insert into public.qorpera_coding_executors(environment_id, owner, enabled) values ('64400000-0000-4000-8000-000000000020', 'exec-644', true);
insert into public.qorpera_runtime_machine_allocations(id, profile_id, provider_adapter, instance_sha256, coding_machine_id, reserved_at)
values ('64400000-0000-4000-8000-0000000000c2', '64400000-0000-4000-8000-000000000010', 'lxd', repeat('9', 64),
	'64400000-0000-4000-8000-0000000000c2', clock_timestamp());
set session_replication_role = origin;

-- The two views, committed: the desktop held by run one, and the coding session.
select set_config('qorpera_test.desk', public.qorpera_folder_view_open('64400000-0000-4000-8000-000000000020', '{"kind":"platform"}',
	'computer_desktop', jsonb_build_object('screenId','64400000-0000-4000-8000-0000000000e4',
		'holderRunId', current_setting('qorpera_test.run_one')::jsonb ->> 'runId'))::text, false);
select set_config('qorpera_test.coding', public.qorpera_folder_view_open('64400000-0000-4000-8000-000000000020', '{"kind":"platform"}',
	'coding_session', jsonb_build_object('workerId','64400000-0000-4000-8000-0000000000c1',
		'attachmentToken','64400000-0000-4000-8000-0000000000c3'))::text, false);

create function pg_temp.vactor(p_name text) returns jsonb language sql as $$
	select jsonb_build_object('kind','view','viewId',v ->> 'viewId','pass',v ->> 'pass')
	from (select current_setting('qorpera_test.' || p_name)::jsonb v) x
$$;
-- Keeps a view's 120 s lease fresh before each race. One folder service renews them all (a coding session's view needs
-- one, 20260930446000).
create function pg_temp.renew(p_name text) returns void language plpgsql as $$
declare v jsonb := current_setting('qorpera_test.' || p_name)::jsonb; r jsonb;
begin
	r := public.qorpera_folder_view_renew((v ->> 'viewId')::uuid, v ->> 'pass', null, '64400000-0000-4000-8000-0000000005e1');
	if (select state from public.qorpera_folder_views where id = (v ->> 'viewId')::uuid) <> 'open' then
		raise exception 'The % view must still be open: %', p_name, r; end if;
end $$;
create function pg_temp.sql_commit(p_actor jsonb, p_key text, p_units jsonb) returns text language sql as $$
	select format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '64400000-0000-4000-8000-000000000020',
		p_actor::text, p_key, p_units::text)
$$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_commit('64400000-0000-4000-8000-000000000020', p_actor, p_key, p_units)
$$;
create function pg_temp.result(p_conn text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	select r into v from dblink_get_result(p_conn) as t(r jsonb);
	perform * from dblink_get_result(p_conn) as t(r jsonb);
	return v;
end $$;
-- Reads a sent statement's error (state and message) or 'ok', and drains the connection.
create function pg_temp.outcome(p_conn text) returns text language plpgsql as $$
declare v_state text := 'ok';
begin
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then v_state := sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return v_state;
end $$;

select pg_temp.commit('{"kind":"platform"}', 'views-race-setup', '[{"op":"mkdir","path":"shared"},{"op":"mkdir","path":"code"}]');

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['view_one','view_two']) name;
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"service_role"}'$q$) from unnest(array['view_one','view_two']) name;
select set_config('qorpera_test.pid_' || name, pid::text, false)
from unnest(array['view_one','view_two']) name, lateral dblink(name, 'select pg_backend_pid()') as t(pid integer);

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
create function pg_temp.finishes_unblocked(p_conn text, p_holder text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if dblink_is_busy(p_conn) = 0 then return true; end if;
		if current_setting('qorpera_test.pid_' || p_holder)::integer = any (pg_blocking_pids(current_setting('qorpera_test.pid_' || p_conn)::integer))
			or clock_timestamp() > v_until then return false; end if;
		perform pg_sleep(0.02);
	end loop;
end $$;

-- A. The anchor step: a desktop save that has applied its units waits for the screen row, then re-checks the view in a
-- new statement. A holder that goes away without a change lets it save; a holder change that commits in that window
-- (another run acquires the screen) refuses it.
select pg_temp.renew('desk');
do $$
declare v_state text;
begin
	perform dblink_exec('view_one', 'begin');
	perform * from dblink('view_one', $q$select 1 from public.qorpera_runtime_office_screens
		where id = '64400000-0000-4000-8000-0000000000e4' for update$q$) as t(x integer);
	perform dblink_send_query('view_two', pg_temp.sql_commit(pg_temp.vactor('desk'), 'anchor-free-1', '[{"op":"mkdir","path":"shared/anchor-free"}]'));
	if not pg_temp.waits_for('view_two', 'view_one') then raise exception 'The desktop save did not wait at its anchor step'; end if;
	perform dblink_exec('view_one', 'rollback');
	v_state := pg_temp.outcome('view_two');
	if v_state <> 'ok' then raise exception 'The save after an unchanged screen: %', v_state; end if;
	if not exists (select 1 from public.qorpera_folder_entries where environment_id = '64400000-0000-4000-8000-000000000020'
		and key_text = 'shared/anchor-free') then raise exception 'The save after an unchanged screen must land'; end if;

	perform dblink_exec('view_one', 'begin');
	perform * from dblink('view_one', $q$select 1 from public.qorpera_runtime_office_screens
		where id = '64400000-0000-4000-8000-0000000000e4' for update$q$) as t(x integer);
	perform dblink_send_query('view_two', pg_temp.sql_commit(pg_temp.vactor('desk'), 'anchor-moved-1', '[{"op":"mkdir","path":"shared/anchor-moved"}]'));
	if not pg_temp.waits_for('view_two', 'view_one') then raise exception 'The desktop save did not wait at its anchor step'; end if;
	perform dblink_exec('view_one', 'set local session_replication_role = replica');
	perform dblink_exec('view_one', pg_temp.sql_hold(current_setting('qorpera_test.run_two')::jsonb));
	perform dblink_exec('view_one', 'commit');
	v_state := pg_temp.outcome('view_two');
	if v_state not like '42501 %Folder view has ended%' then
		raise exception 'A holder change in the anchor window must refuse the save, got %', v_state; end if;
	if exists (select 1 from public.qorpera_folder_entries where environment_id = '64400000-0000-4000-8000-000000000020'
		and key_text = 'shared/anchor-moved') then raise exception 'The refused save must leave nothing'; end if;
end $$;

-- B. The office's plain updates of the screen wait for a desktop save in flight, and land after it.
select pg_temp.hold(current_setting('qorpera_test.run_one')::jsonb);
select pg_temp.renew('desk');
do $$
declare r jsonb; v_state text;
begin
	perform dblink_exec('view_one', 'begin');
	select t.r into r from dblink('view_one', pg_temp.sql_commit(pg_temp.vactor('desk'), 'desk-flight-1', '[{"op":"mkdir","path":"shared/in-flight"}]'))
		as t(r jsonb);
	if r -> 'units' -> 0 ->> 'outcome' <> 'saved' then raise exception 'The desktop save in flight: %', r; end if;
	perform dblink_exec('view_two', 'set session_replication_role = replica');
	perform dblink_send_query('view_two', pg_temp.sql_hold(current_setting('qorpera_test.run_two')::jsonb));
	if not pg_temp.waits_for('view_two', 'view_one') then raise exception 'The screen update did not wait for the save in flight'; end if;
	perform dblink_exec('view_one', 'commit');
	v_state := pg_temp.outcome('view_two');
	perform dblink_exec('view_two', 'set session_replication_role = origin');
	if v_state <> 'ok' then raise exception 'The screen update after the save: %', v_state; end if;
	if (select run_id from public.qorpera_runtime_office_screens where id = '64400000-0000-4000-8000-0000000000e4')
		<> (current_setting('qorpera_test.run_two')::jsonb ->> 'runId')::uuid then raise exception 'The screen update must land'; end if;
end $$;

-- C. The same two races for a coding session: its plain updates wait for a save in flight; an archive that commits in
-- the anchor window refuses the save.
select pg_temp.renew('coding');
do $$
declare r jsonb; v_state text;
begin
	perform dblink_exec('view_one', 'begin');
	select t.r into r from dblink('view_one', pg_temp.sql_commit(pg_temp.vactor('coding'), 'coding-flight-1', '[{"op":"mkdir","path":"code/in-flight"}]'))
		as t(r jsonb);
	if r -> 'units' -> 0 ->> 'outcome' <> 'saved' then raise exception 'The coding save in flight: %', r; end if;
	perform dblink_send_query('view_two', $q$update public.qorpera_coding_sessions set attachment_until = attachment_until + interval '1 second'
		where worker_id = '64400000-0000-4000-8000-0000000000c1'$q$);
	if not pg_temp.waits_for('view_two', 'view_one') then raise exception 'The coding session update did not wait for the save in flight'; end if;
	perform dblink_exec('view_one', 'commit');
	v_state := pg_temp.outcome('view_two');
	if v_state <> 'ok' then raise exception 'The coding session update after the save: %', v_state; end if;

	perform dblink_exec('view_one', 'begin');
	perform * from dblink('view_one', $q$select 1 from public.qorpera_coding_sessions
		where worker_id = '64400000-0000-4000-8000-0000000000c1' for update$q$) as t(x integer);
	perform dblink_send_query('view_two', pg_temp.sql_commit(pg_temp.vactor('coding'), 'coding-archived-1', '[{"op":"mkdir","path":"code/archived"}]'));
	if not pg_temp.waits_for('view_two', 'view_one') then raise exception 'The coding save did not wait at its anchor step'; end if;
	perform dblink_exec('view_one', $q$update public.qorpera_coding_sessions set archived_at = clock_timestamp(), archived_by = 'member'
		where worker_id = '64400000-0000-4000-8000-0000000000c1'$q$);
	perform dblink_exec('view_one', 'commit');
	v_state := pg_temp.outcome('view_two');
	if v_state not like '42501 %Folder view has ended%' then
		raise exception 'An archive in the anchor window must refuse the save, got %', v_state; end if;
end $$;

select dblink_connect('view_three', 'dbname=' || current_database());
select dblink_exec('view_three', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
select set_config('qorpera_test.pid_view_three', pid::text, false) from dblink('view_three', 'select pg_backend_pid()') as t(pid integer);
-- E. A desktop save that resolved detached (the holder had let go) and finds the holder back after waiting holds no
-- lock on the run's job, so it refuses as retryable (folder_view_changed); the retry takes the job and saves as the
-- run. The save waits at the view row, which the first connection holds FOR UPDATE (as a close or a supersede does).
select pg_temp.fx_release_screen();
select pg_temp.renew('desk');
do $$
declare v_state text; r jsonb;
begin
	perform dblink_exec('view_one', 'begin');
	perform * from dblink('view_one', format('select 1 from public.qorpera_folder_views where id = %L for update',
		current_setting('qorpera_test.desk')::jsonb ->> 'viewId')) as t(x integer);
	perform dblink_send_query('view_two', pg_temp.sql_commit(pg_temp.vactor('desk'), 'holder-back-1', '[{"op":"mkdir","path":"shared/holder-back"}]'));
	if not pg_temp.waits_for('view_two', 'view_one') then raise exception 'The save did not wait at the view row'; end if;
	perform dblink_exec('view_three', 'set session_replication_role = replica');
	perform dblink_exec('view_three', pg_temp.sql_hold(current_setting('qorpera_test.run_one')::jsonb));
	perform dblink_exec('view_three', 'set session_replication_role = origin');
	perform dblink_exec('view_one', 'rollback');
	v_state := pg_temp.outcome('view_two');
	if v_state not like 'PGRST %folder_view_changed%' then
		raise exception 'A save that finds the holder back must refuse as retryable, got %', v_state; end if;
	r := pg_temp.commit(pg_temp.vactor('desk'), 'holder-back-1', '[{"op":"mkdir","path":"shared/holder-back"}]');
	if r -> 'units' -> 0 ->> 'outcome' <> 'saved' or (select run_id from public.qorpera_folder_commits where id = (r ->> 'commitId')::uuid)
		<> (current_setting('qorpera_test.run_one')::jsonb ->> 'runId')::uuid then raise exception 'The retry saves as the run: %', r; end if;
end $$;

-- F. The anchor step after a lock wait sees changes to other rows too: a revocation of the agent's computer access
-- that commits while the save waits for the screen refuses the save.
select pg_temp.renew('desk');
do $$
declare v_state text;
begin
	perform dblink_exec('view_one', 'begin');
	perform * from dblink('view_one', $q$select 1 from public.qorpera_runtime_office_screens
		where id = '64400000-0000-4000-8000-0000000000e4' for update$q$) as t(x integer);
	perform dblink_send_query('view_two', pg_temp.sql_commit(pg_temp.vactor('desk'), 'access-gone-1', '[{"op":"mkdir","path":"shared/access-gone"}]'));
	if not pg_temp.waits_for('view_two', 'view_one') then raise exception 'The save did not wait at its anchor step'; end if;
	perform dblink_exec('view_one', 'set local session_replication_role = replica');
	perform dblink_exec('view_one', $q$update public.qorpera_runtime_office_access set state = 'revoked'
		where office_id = '64400000-0000-4000-8000-0000000000e0'$q$);
	perform dblink_exec('view_one', 'commit');
	v_state := pg_temp.outcome('view_two');
	if v_state not like '42501 %Folder view has ended%' then
		raise exception 'An access revocation in the anchor window must refuse the save, got %', v_state; end if;
end $$;
set session_replication_role = replica;
update public.qorpera_runtime_office_access set state = 'active' where office_id = '64400000-0000-4000-8000-0000000000e0';
set session_replication_role = origin;

-- D. The company row is locked at rank 0, before the member at rank 1, so a hook that names it (F2's roster files) never
-- deadlocks with a role change. Before C1c-3c the role change locked the company row FOR UPDATE, then the member row
-- (#462's order), and a save at rank 0 waited for it holding nothing it needed. Since C1c-3c a role change on folder-v2
-- takes the fence FOR NO KEY UPDATE and the company row KEY SHARE only, then the member row FOR UPDATE: a save never
-- waits for it at all, and the two meet only at the member row. A third connection holds the member row FOR KEY SHARE,
-- so the role change stops there; a save goes on beside it (its KEY SHARE does not queue behind a waiting FOR UPDATE)
-- and lands, then the role change. The hook is replaced for this company only, and its current definition (F2's) comes
-- back after.
select pg_get_functiondef('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure) as structured_targets_def \gset
create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
returns table(rank smallint, tbl text, key text, mode text) language sql stable set search_path = '' as $f$
	select 0::smallint, 'qorpera_profiles', '64400000-0000-4000-8000-000000000010', 'keyshare'
	where p_environment_id = '64400000-0000-4000-8000-000000000020'
$f$;
select pg_temp.hold(current_setting('qorpera_test.run_one')::jsonb);
select pg_temp.renew('desk');
-- The founder's session, for the role changes.
select dblink_exec('view_one', $q$set request.jwt.claims = '{"role":"authenticated","sub":"64400000-0000-4000-8000-000000000001"}'$q$);
do $$
declare v_actor jsonb; v_n integer := 0; v_state text; r jsonb; v_role text;
begin
	foreach v_actor in array array['{"kind":"member","userId":"64400000-0000-4000-8000-000000000002"}'::jsonb, pg_temp.vactor('desk')] loop
		v_n := v_n + 1;
		v_role := case when v_n = 1 then 'admin' else 'contributor' end;
		perform dblink_exec('view_three', 'begin');
		perform * from dblink('view_three', $q$select 1 from public.qorpera_profile_members where profile_id = '64400000-0000-4000-8000-000000000010'
			and user_id = '64400000-0000-4000-8000-000000000002' for key share$q$) as t(x integer);
		perform dblink_send_query('view_one', format('select public.qorpera_update_profile_member_role(%L, %L, %L)',
			'64400000-0000-4000-8000-000000000010', '64400000-0000-4000-8000-000000000002', v_role));
		if not pg_temp.waits_for('view_one', 'view_three') then raise exception 'The role change did not stop at the member row'; end if;
		perform dblink_send_query('view_two', pg_temp.sql_commit(v_actor, 'rank-zero-' || v_n, jsonb_build_array(jsonb_build_object('op','mkdir',
			'path','shared/rank-zero-' || v_n))));
		if not pg_temp.finishes_unblocked('view_two', 'view_one') then raise exception 'Save % must not wait for the role change', v_n; end if;
		perform dblink_exec('view_three', 'commit');
		v_state := pg_temp.outcome('view_one');
		if v_state <> 'ok' then raise exception 'The role change beside save % (a deadlock if the save held the member row): %', v_n, v_state; end if;
		v_state := pg_temp.outcome('view_two');
		if v_state <> 'ok' then raise exception 'Save % beside the role change: %', v_n, v_state; end if;
		if not exists (select 1 from public.qorpera_folder_entries where environment_id = '64400000-0000-4000-8000-000000000020'
			and key_text = 'shared/rank-zero-' || v_n) then raise exception 'Save % must land', v_n; end if;
		if (select role::text from public.qorpera_profile_members where profile_id = '64400000-0000-4000-8000-000000000010'
			and user_id = '64400000-0000-4000-8000-000000000002') <> v_role then raise exception 'The role change % must land', v_n; end if;
	end loop;

	-- The other order: a save in flight holds the company row KEY SHARE and the member row KEY SHARE; the role change
	-- waits at the member row and goes on once the save commits.
	perform dblink_exec('view_two', 'begin');
	select t.r into r from dblink('view_two', pg_temp.sql_commit('{"kind":"member","userId":"64400000-0000-4000-8000-000000000002"}',
		'rank-zero-first', '[{"op":"mkdir","path":"shared/rank-zero-first"}]')) as t(r jsonb);
	if r -> 'units' -> 0 ->> 'outcome' <> 'saved' then raise exception 'The save in flight: %', r; end if;
	perform dblink_send_query('view_one', format('select public.qorpera_update_profile_member_role(%L, %L, %L)',
		'64400000-0000-4000-8000-000000000010', '64400000-0000-4000-8000-000000000002', 'admin'));
	if not pg_temp.waits_for('view_one', 'view_two') then raise exception 'The role change did not wait for the save in flight'; end if;
	perform dblink_exec('view_two', 'commit');
	v_state := pg_temp.outcome('view_one');
	if v_state <> 'ok' then raise exception 'The role change after the save: %', v_state; end if;
end $$;
select :'structured_targets_def' \gexec

-- G. A release through a view that an open is superseding waits for the open, then refuses: its reads never land in
-- the closed view after the new view has carried the old view's set. (The open here runs in the holder change's own
-- transaction, which the office service must not do; it is the easiest way to hold the open in flight.)
select pg_temp.fx_release_screen();
select pg_temp.renew('desk');
select dblink_exec('view_one', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
do $$
declare v_state text; e jsonb := public.qorpera_folder_read('64400000-0000-4000-8000-000000000020', pg_temp.vactor('desk'), 'shared') -> 'entry';
begin
	if e -> 'authority' is null then raise exception 'The detached view reads shared/'; end if;
	perform dblink_exec('view_one', 'begin');
	perform dblink_exec('view_one', 'set local session_replication_role = replica');
	perform dblink_exec('view_one', pg_temp.sql_hold(current_setting('qorpera_test.run_two')::jsonb));
	perform dblink_exec('view_one', 'set local session_replication_role = origin');
	perform * from dblink('view_one', format('select public.qorpera_folder_view_open(%L, %L, %L, %L)', '64400000-0000-4000-8000-000000000020',
		'{"kind":"platform"}', 'computer_desktop', jsonb_build_object('screenId', '64400000-0000-4000-8000-0000000000e4',
			'holderRunId', current_setting('qorpera_test.run_two')::jsonb ->> 'runId'))) as t(r jsonb);
	perform dblink_send_query('view_two', format('select public.qorpera_folder_record_release(%L, %L, %L, %L, %L)',
		'64400000-0000-4000-8000-000000000020', pg_temp.vactor('desk'), extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')), repeat('8', 64)));
	if not pg_temp.waits_for('view_two', 'view_one') then raise exception 'The release did not wait for the open'; end if;
	perform dblink_exec('view_one', 'commit');
	v_state := pg_temp.outcome('view_two');
	if v_state not like '42501 %' then raise exception 'A release through a superseded view must refuse, got %', v_state; end if;
	if exists (select 1 from public.qorpera_folder_view_reads where view_id = (current_setting('qorpera_test.desk')::jsonb ->> 'viewId')::uuid) then
		raise exception 'Nothing lands in the superseded view'; end if;
end $$;

-- H. An open locks the machine's newest view even when it is already closed: a release that took the view row while
-- the view was valid, and is still in flight when renew closes the view, is carried into the next view. The release
-- is held mid-flight at the view's read set, whose row for the root the first connection holds FOR UPDATE (an
-- earlier release of shared/ made it).
select pg_temp.hold(current_setting('qorpera_test.run_one')::jsonb);
select set_config('qorpera_test.desk2', public.qorpera_folder_view_open('64400000-0000-4000-8000-000000000020', '{"kind":"platform"}',
	'computer_desktop', jsonb_build_object('screenId','64400000-0000-4000-8000-0000000000e4',
		'holderRunId', current_setting('qorpera_test.run_one')::jsonb ->> 'runId'))::text, false);
select public.qorpera_folder_record_release('64400000-0000-4000-8000-000000000020', pg_temp.vactor('desk2'), extensions.gen_random_uuid(),
	jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')), repeat('9', 64))
from (select public.qorpera_folder_read('64400000-0000-4000-8000-000000000020', pg_temp.vactor('desk2'), 'shared') -> 'entry' as e) x;
do $$
declare v_state text; v_new jsonb;
	e jsonb := public.qorpera_folder_read('64400000-0000-4000-8000-000000000020', pg_temp.vactor('desk2'), 'shared/in-flight') -> 'entry';
begin
	perform dblink_exec('view_one', 'begin');
	perform * from dblink('view_one', format('select 1 from public.qorpera_folder_view_reads where view_id = %L for update',
		current_setting('qorpera_test.desk2')::jsonb ->> 'viewId')) as t(x integer);
	perform dblink_send_query('view_two', format('select public.qorpera_folder_record_release(%L, %L, %L, %L, %L)',
		'64400000-0000-4000-8000-000000000020', pg_temp.vactor('desk2'), extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')), repeat('a', 64)));
	if not pg_temp.waits_for('view_two', 'view_one') then raise exception 'The release did not stop at the view''s read set'; end if;
	-- Run two takes the screen; renew closes the old view.
	perform dblink_exec('view_three', 'set session_replication_role = replica');
	perform dblink_exec('view_three', pg_temp.sql_hold(current_setting('qorpera_test.run_two')::jsonb));
	perform dblink_exec('view_three', 'set session_replication_role = origin');
	perform * from dblink('view_three', format('select public.qorpera_folder_view_renew(%L, %L)',
		current_setting('qorpera_test.desk2')::jsonb ->> 'viewId', current_setting('qorpera_test.desk2')::jsonb ->> 'pass')) as t(r jsonb);
	if (select state from public.qorpera_folder_views where id = (current_setting('qorpera_test.desk2')::jsonb ->> 'viewId')::uuid) <> 'closed' then
		raise exception 'Renew closes the old view'; end if;
	perform dblink_send_query('view_three', format('select public.qorpera_folder_view_open(%L, %L, %L, %L)', '64400000-0000-4000-8000-000000000020',
		'{"kind":"platform"}', 'computer_desktop', jsonb_build_object('screenId', '64400000-0000-4000-8000-0000000000e4',
			'holderRunId', current_setting('qorpera_test.run_two')::jsonb ->> 'runId')));
	if not pg_temp.waits_for('view_three', 'view_two') then raise exception 'The open did not wait for the release in flight'; end if;
	perform dblink_exec('view_one', 'rollback');
	v_state := pg_temp.outcome('view_two');
	if v_state <> 'ok' then raise exception 'The release in flight: %', v_state; end if;
	v_new := pg_temp.result('view_three');
	if not exists (select 1 from public.qorpera_folder_view_read_records rec, jsonb_array_elements(rec.reads) x
		where rec.view_id = (v_new ->> 'viewId')::uuid and x ->> 'path' = 'shared/in-flight') then
		raise exception 'The next view carries the release that was in flight'; end if;
end $$;

-- I. A release keeps the commit's lock order too (job, then view row): one that resolved detached and finds the holder
-- back after waiting at the view row refuses as retryable, never files into the run without its job lock.
select pg_temp.hold(current_setting('qorpera_test.run_one')::jsonb);
select set_config('qorpera_test.desk3', public.qorpera_folder_view_open('64400000-0000-4000-8000-000000000020', '{"kind":"platform"}',
	'computer_desktop', jsonb_build_object('screenId','64400000-0000-4000-8000-0000000000e4',
		'holderRunId', current_setting('qorpera_test.run_one')::jsonb ->> 'runId'))::text, false);
select pg_temp.fx_release_screen();
do $$
declare v_state text; e jsonb := public.qorpera_folder_read('64400000-0000-4000-8000-000000000020', pg_temp.vactor('desk3'), 'shared') -> 'entry';
begin
	perform dblink_exec('view_one', 'begin');
	perform * from dblink('view_one', format('select 1 from public.qorpera_folder_views where id = %L for update',
		current_setting('qorpera_test.desk3')::jsonb ->> 'viewId')) as t(x integer);
	perform dblink_send_query('view_two', format('select public.qorpera_folder_record_release(%L, %L, %L, %L, %L)',
		'64400000-0000-4000-8000-000000000020', pg_temp.vactor('desk3'), extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')), repeat('b', 64)));
	if not pg_temp.waits_for('view_two', 'view_one') then raise exception 'The release did not wait at the view row'; end if;
	perform dblink_exec('view_three', 'set session_replication_role = replica');
	perform dblink_exec('view_three', pg_temp.sql_hold(current_setting('qorpera_test.run_one')::jsonb));
	perform dblink_exec('view_three', 'set session_replication_role = origin');
	perform dblink_exec('view_one', 'rollback');
	v_state := pg_temp.outcome('view_two');
	if v_state not like 'PGRST %folder_view_changed%' then
		raise exception 'A release that finds the holder back must refuse as retryable, got %', v_state; end if;
end $$;

-- J. So a transaction that ends a run and closes its view (the run's job, then the view row, both FOR UPDATE) never
-- deadlocks with a release in flight: the release waits at the job, holding no lock on the view.
select pg_temp.renew('desk3');
do $$
declare v_state text; e jsonb := public.qorpera_folder_read('64400000-0000-4000-8000-000000000020', pg_temp.vactor('desk3'), 'shared') -> 'entry';
begin
	perform dblink_exec('view_one', 'begin');
	perform * from dblink('view_one', format('select 1 from public.qorpera_runner_jobs where id = %L for update',
		current_setting('qorpera_test.run_one')::jsonb ->> 'jobId')) as t(x integer);
	perform dblink_send_query('view_two', format('select public.qorpera_folder_record_release(%L, %L, %L, %L, %L)',
		'64400000-0000-4000-8000-000000000020', pg_temp.vactor('desk3'), extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')), repeat('c', 64)));
	if not pg_temp.waits_for('view_two', 'view_one') then raise exception 'The release did not wait at the run''s job'; end if;
	perform dblink_send_query('view_one', format('select 1 from public.qorpera_folder_views where id = %L for update',
		current_setting('qorpera_test.desk3')::jsonb ->> 'viewId'));
	if not pg_temp.finishes_unblocked('view_one', 'view_two') then
		raise exception 'The release holds the view row while it waits for the job'; end if;
	v_state := pg_temp.outcome('view_one');
	if v_state <> 'ok' then raise exception 'The view lock beside the release: %', v_state; end if;
	perform dblink_exec('view_one', 'rollback');
	v_state := pg_temp.outcome('view_two');
	if v_state <> 'ok' then raise exception 'The release after the job was free: %', v_state; end if;
end $$;

-- K. The view row comes before the fence and the principal rows too: a transaction that closes a member's views (the
-- view, then the member row, both FOR UPDATE) never deadlocks with a release in flight, which waits at the view
-- holding only its job.
select pg_temp.renew('desk3');
do $$
declare v_state text; e jsonb := public.qorpera_folder_read('64400000-0000-4000-8000-000000000020', pg_temp.vactor('desk3'), 'shared') -> 'entry';
begin
	perform dblink_exec('view_one', 'begin');
	perform * from dblink('view_one', format('select 1 from public.qorpera_folder_views where id = %L for update',
		current_setting('qorpera_test.desk3')::jsonb ->> 'viewId')) as t(x integer);
	perform dblink_send_query('view_two', format('select public.qorpera_folder_record_release(%L, %L, %L, %L, %L)',
		'64400000-0000-4000-8000-000000000020', pg_temp.vactor('desk3'), extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')), repeat('d', 64)));
	if not pg_temp.waits_for('view_two', 'view_one') then raise exception 'The release did not wait at the view row'; end if;
	perform dblink_send_query('view_one', $q$select 1 from public.qorpera_profile_members where profile_id = '64400000-0000-4000-8000-000000000010'
		and user_id = '64400000-0000-4000-8000-000000000002' for update$q$);
	if not pg_temp.finishes_unblocked('view_one', 'view_two') then
		raise exception 'The release holds the member row while it waits for the view'; end if;
	v_state := pg_temp.outcome('view_one');
	if v_state <> 'ok' then raise exception 'The member lock beside the release: %', v_state; end if;
	perform dblink_exec('view_one', 'rollback');
	v_state := pg_temp.outcome('view_two');
	if v_state <> 'ok' then raise exception 'The release after the view was free: %', v_state; end if;
end $$;

-- L. A shell command's view (20260930183000) anchors on the command's row, FOR SHARE. Every end of the command takes a
-- row lock that conflicts with it: the report's upsert, and the plain UPDATEs of the report's sweeps, the idle sleep
-- and the computer's stop. An end that commits while a save waits there refuses the save, which only the final may then
-- be; one rolled back lets it save. A save in flight makes the end wait, and the end lands after it. A final in flight
-- holds the clock and has closed its view: a save of the same view passes its anchor step, waits at the clock, and then
-- finds the view closed. Each race has its own command, started by run one, which holds the screen.
create function pg_temp.command() returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid(); v_run uuid := (current_setting('qorpera_test.run_one')::jsonb ->> 'runId')::uuid;
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_office_shell_commands(id, receipt_id, office_id, computer_generation, screen_id, screen_generation,
		staff_agent_id, run_id, requested_by_user_id, conversation_run_id, command, network, started_at, worked_at)
	select v_id, v_id, o.id, o.generation, s.id, s.generation, s.staff_agent_id, v_run, '64400000-0000-4000-8000-000000000002', v_run,
		'make', false, clock_timestamp(), clock_timestamp()
	from public.qorpera_runtime_office_screens s join public.qorpera_runtime_offices o on o.id = s.office_id
	where s.id = '64400000-0000-4000-8000-0000000000e4';
	set local session_replication_role = origin;
	return v_id;
end $$;
create function pg_temp.open_command(p_name text) returns void language sql as $$
	select set_config('qorpera_test.' || p_name, public.qorpera_folder_view_open('64400000-0000-4000-8000-000000000020',
		'{"kind":"platform"}', 'computer_shell_command', jsonb_build_object('shellCommandId', pg_temp.command()))::text, false)
$$;
-- An end of a view's command, in the plain UPDATE the report's sweeps, the idle sleep and the computer's stop use (its
-- reason does not matter to the anchor).
create function pg_temp.sql_end(p_name text) returns text language sql as $$
	select format('update public.qorpera_runtime_office_shell_commands set ended_at = clock_timestamp(), end_reason = ''exited''
		where id = (select shell_command_id from public.qorpera_folder_views where id = %L)',
		current_setting('qorpera_test.' || p_name)::jsonb ->> 'viewId')
$$;
-- Where a waiter waits: a row lock's waiter holds that row's tuple lock while it waits for the holder (unless it holds a
-- lock on the row already).
create function pg_temp.waits_at(p_waiter text, p_table regclass) returns boolean language sql as $$
	select exists (select 1 from pg_locks where pid = current_setting('qorpera_test.pid_' || p_waiter)::integer
		and locktype = 'tuple' and relation = p_table)
$$;
-- A command view's save past its anchor step: it holds the command table's ROW SHARE, which only the anchor's FOR SHARE
-- takes, and waits at no row it did not lock before. The next row it locks is the clock's, which it holds KEY SHARE
-- already through its foreign keys: it waits there for the holder's transaction, with no tuple lock.
create function pg_temp.past_anchor(p_waiter text) returns boolean language sql as $$
	select exists (select 1 from pg_locks where pid = current_setting('qorpera_test.pid_' || p_waiter)::integer and granted
			and locktype = 'relation' and relation = 'public.qorpera_runtime_office_shell_commands'::regclass and mode = 'RowShareLock')
		and not exists (select 1 from pg_locks where pid = current_setting('qorpera_test.pid_' || p_waiter)::integer and locktype = 'tuple')
$$;
select pg_temp.hold(current_setting('qorpera_test.run_one')::jsonb);
select pg_temp.open_command(name) from unnest(array['cmd1','cmd2','cmd3']) name;
do $$
declare v_state text; r jsonb;
begin
	perform dblink_exec('view_one', 'begin');
	perform dblink_exec('view_one', 'set local session_replication_role = replica');
	perform dblink_exec('view_one', pg_temp.sql_end('cmd1'));
	perform dblink_send_query('view_two', pg_temp.sql_commit(pg_temp.vactor('cmd1'), 'cmd-anchor-free',
		'[{"op":"mkdir","path":"shared/cmd-anchor-free"}]'));
	if not pg_temp.waits_for('view_two', 'view_one') or not pg_temp.waits_at('view_two', 'public.qorpera_runtime_office_shell_commands') then
		raise exception 'The command view''s save did not wait at its anchor step'; end if;
	perform dblink_exec('view_one', 'rollback');
	v_state := pg_temp.outcome('view_two');
	if v_state <> 'ok' then raise exception 'The save after an end rolled back: %', v_state; end if;
	if not exists (select 1 from public.qorpera_folder_entries where environment_id = '64400000-0000-4000-8000-000000000020'
		and key_text = 'shared/cmd-anchor-free') then raise exception 'The save after an end rolled back must land'; end if;

	perform dblink_exec('view_one', 'begin');
	perform dblink_exec('view_one', 'set local session_replication_role = replica');
	perform dblink_exec('view_one', pg_temp.sql_end('cmd1'));
	perform dblink_send_query('view_two', pg_temp.sql_commit(pg_temp.vactor('cmd1'), 'cmd-anchor-ended',
		'[{"op":"mkdir","path":"shared/cmd-anchor-ended"}]'));
	if not pg_temp.waits_for('view_two', 'view_one') or not pg_temp.waits_at('view_two', 'public.qorpera_runtime_office_shell_commands') then
		raise exception 'The command view''s save did not wait at its anchor step'; end if;
	perform dblink_exec('view_one', 'commit');
	v_state := pg_temp.outcome('view_two');
	if v_state not like '42501 %Folder view command has ended%' then
		raise exception 'An end in the anchor window must refuse a save that is not the final, got %', v_state; end if;
	if exists (select 1 from public.qorpera_folder_entries where environment_id = '64400000-0000-4000-8000-000000000020'
		and key_text = 'shared/cmd-anchor-ended') then raise exception 'The refused save must leave nothing'; end if;
	-- Last in this block: until it ends, this transaction holds the clock.
	r := pg_temp.commit(pg_temp.vactor('cmd1') || '{"final":true}', 'cmd-anchor-final', '[{"op":"mkdir","path":"shared/cmd-anchor-final"}]');
	if r -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The final after the end: %', r; end if;
end $$;
do $$
declare v_state text; r jsonb;
begin
	perform dblink_exec('view_one', 'begin');
	select t.r into r from dblink('view_one', pg_temp.sql_commit(pg_temp.vactor('cmd2'), 'cmd-flight-1',
		'[{"op":"mkdir","path":"shared/cmd-in-flight"}]')) as t(r jsonb);
	if r -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The command view''s save in flight: %', r; end if;
	perform dblink_exec('view_two', 'set session_replication_role = replica');
	perform dblink_send_query('view_two', pg_temp.sql_end('cmd2'));
	if not pg_temp.waits_for('view_two', 'view_one') or not pg_temp.waits_at('view_two', 'public.qorpera_runtime_office_shell_commands') then
		raise exception 'The end of the command did not wait for the save in flight'; end if;
	perform dblink_exec('view_one', 'commit');
	v_state := pg_temp.outcome('view_two');
	perform dblink_exec('view_two', 'set session_replication_role = origin');
	if v_state <> 'ok' then raise exception 'The end of the command after the save: %', v_state; end if;
	if not exists (select 1 from public.qorpera_folder_entries where environment_id = '64400000-0000-4000-8000-000000000020'
			and key_text = 'shared/cmd-in-flight')
		or not exists (select 1 from public.qorpera_runtime_office_shell_commands c join public.qorpera_folder_views v
			on v.shell_command_id = c.id where v.id = (current_setting('qorpera_test.cmd2')::jsonb ->> 'viewId')::uuid
			and c.ended_at is not null) then
		raise exception 'The save in flight, then the end, must land'; end if;
end $$;
do $$
declare v_state text; r jsonb;
begin
	perform dblink_exec('view_one', 'begin');
	select t.r into r from dblink('view_one', pg_temp.sql_commit(pg_temp.vactor('cmd3') || '{"final":true}', 'cmd-final-flight',
		'[{"op":"mkdir","path":"shared/cmd-final-flight"}]')) as t(r jsonb);
	if r -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The final in flight: %', r; end if;
	perform dblink_send_query('view_two', pg_temp.sql_commit(pg_temp.vactor('cmd3'), 'cmd-behind-final',
		'[{"op":"mkdir","path":"shared/cmd-behind-final"}]'));
	if not pg_temp.waits_for('view_two', 'view_one') or not pg_temp.past_anchor('view_two') then
		raise exception 'The save did not wait for the final at the clock'; end if;
	perform dblink_exec('view_one', 'commit');
	v_state := pg_temp.outcome('view_two');
	if v_state not like '42501 %Folder view has ended%' then
		raise exception 'A save behind the final must find the view closed, got %', v_state; end if;
	if exists (select 1 from public.qorpera_folder_entries where environment_id = '64400000-0000-4000-8000-000000000020'
		and key_text = 'shared/cmd-behind-final') then raise exception 'The save behind the final must leave nothing'; end if;
	if (select state from public.qorpera_folder_views where id = (current_setting('qorpera_test.cmd3')::jsonb ->> 'viewId')::uuid)
		is distinct from 'closed' then raise exception 'The final closes its view'; end if;
end $$;

-- M. A coding view's commit checks its own read set and its machine's at rank 10 without writing them (20260930445000),
-- so it holds no read-set row while it waits for its session at the anchor step. A commit that re-stamped a moved pair
-- there would close a cycle: qorpera_keep_coding_attachments holds the session FOR UPDATE and waits to mark the machine
-- busy, and a release holds the machine FOR SHARE and waits for the pair (40P01). The session archived in C comes back;
-- its view releases P (code) under resource X, so the view's set and the machine's both hold (X, grant), and X moves
-- without P becoming unreadable.
set session_replication_role = replica;
update public.qorpera_coding_sessions set archived_at = null, archived_by = null, attachment_until = clock_timestamp() + interval '30 minutes'
where worker_id = '64400000-0000-4000-8000-0000000000c1';
set session_replication_role = origin;
create function pg_temp.open_coding(p_name text) returns void language sql as $$
	select set_config('qorpera_test.' || p_name, public.qorpera_folder_view_open('64400000-0000-4000-8000-000000000020', '{"kind":"platform"}',
		'coding_session', jsonb_build_object('workerId','64400000-0000-4000-8000-0000000000c1',
			'attachmentToken','64400000-0000-4000-8000-0000000000c3'))::text, false)
$$;
select pg_temp.open_coding('coding2');
do $$
declare e jsonb := public.qorpera_folder_read('64400000-0000-4000-8000-000000000020', pg_temp.vactor('coding2'), 'code') -> 'entry';
	v_x public.qorpera_company_path_resources%rowtype;
begin
	if e -> 'authority' is null then raise exception 'The coding view reads code/: %', e; end if;
	perform public.qorpera_folder_record_release('64400000-0000-4000-8000-000000000020', pg_temp.vactor('coding2'), extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')), repeat('b', 64));
	select * into v_x from public.qorpera_company_path_resources where id = (e -> 'authority' ->> 'resourceId')::uuid;
	if not exists (select 1 from public.qorpera_coding_machine_reads where coding_machine_id = '64400000-0000-4000-8000-0000000000c2'
		and resource_id = v_x.id and resource_revision = v_x.authority_revision)
		or not exists (select 1 from public.qorpera_folder_view_reads where view_id = (pg_temp.vactor('coding2') ->> 'viewId')::uuid
			and resource_id = v_x.id and resource_revision = v_x.authority_revision) then
		raise exception 'The release lands in the view''s set and the machine''s: %', e; end if;
	-- A narrower resource beside P bumps X.
	perform public.qorpera_folder_set_resource('64400000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"64400000-0000-4000-8000-000000000001"}', concat_ws('/', nullif(v_x.path, ''), 'moved-aside'),
		'subtree', 'company_shared', 'normal');
	if (select authority_revision from public.qorpera_company_path_resources where id = v_x.id) <= v_x.authority_revision then
		raise exception 'X must move'; end if;
end $$;
-- Connections: view_one is the release (B), view_two the attachment renewal (A), view_three the save (C).
do $$
declare v_release text; v_busy text; v_save text; r jsonb;
	e jsonb := public.qorpera_folder_read('64400000-0000-4000-8000-000000000020', pg_temp.vactor('coding2'), 'code/in-flight') -> 'entry';
begin
	-- B takes the machine FOR SHARE, as the release does before it writes the machine's set.
	perform dblink_exec('view_one', 'begin');
	perform * from dblink('view_one', $q$select 1 from public.qorpera_coding_machines where id = '64400000-0000-4000-8000-0000000000c2'
		for share$q$) as t(x integer);
	-- A, as qorpera_keep_coding_attachments: the session FOR UPDATE, then the machine's busy mark, which waits for B.
	perform dblink_exec('view_two', 'begin');
	perform * from dblink('view_two', $q$select 1 from public.qorpera_coding_sessions where worker_id = '64400000-0000-4000-8000-0000000000c1'
		for update$q$) as t(x integer);
	perform dblink_send_query('view_two', $q$update public.qorpera_coding_machines set busy_at = clock_timestamp()
		where id = '64400000-0000-4000-8000-0000000000c2'$q$);
	if not pg_temp.waits_for('view_two', 'view_one') or not pg_temp.waits_at('view_two', 'public.qorpera_coding_machines') then
		raise exception 'The busy mark did not wait for the machine''s share lock'; end if;
	-- C saves through the view: past its check of the moved pair, it waits for A at its anchor step.
	perform dblink_send_query('view_three', pg_temp.sql_commit(pg_temp.vactor('coding2'), 'machine-read-save',
		'[{"op":"mkdir","path":"code/machine-read"}]'));
	if not pg_temp.waits_for('view_three', 'view_two') or not pg_temp.waits_at('view_three', 'public.qorpera_coding_sessions') then
		raise exception 'The coding save did not wait at its anchor step'; end if;
	-- B releases a path under X in the same transaction: the save holds no row it writes, so it finishes.
	perform dblink_send_query('view_one', format('select public.qorpera_folder_record_release(%L, %L, %L, %L, %L)',
		'64400000-0000-4000-8000-000000000020', pg_temp.vactor('coding2'), extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')), repeat('c', 64)));
	if not pg_temp.finishes_unblocked('view_one', 'view_three') then raise exception 'The release waited for the save'; end if;
	v_release := pg_temp.outcome('view_one');
	perform dblink_exec('view_one', 'commit');
	v_busy := pg_temp.outcome('view_two');
	perform dblink_exec('view_two', 'commit');
	begin
		r := pg_temp.result('view_three');
	exception when others then v_save := sqlstate || ' ' || sqlerrm;
	end;
	if v_release <> 'ok' or v_busy <> 'ok' or v_save is not null or r -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then
		raise exception 'Release %, busy mark %, save % %', v_release, v_busy, v_save, r; end if;
	if not exists (select 1 from public.qorpera_coding_machine_read_records rec, jsonb_array_elements(rec.reads) x
		where rec.coding_machine_id = '64400000-0000-4000-8000-0000000000c2' and x ->> 'path' = 'code/in-flight') then
		raise exception 'The release lands in the machine''s set'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['view_one','view_two','view_three']) name;

-- The committed fixture leaves the shared suite database.
set session_replication_role = replica;
delete from public.qorpera_folder_run_inheritances where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_view_reads where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_view_read_records where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_view_releases where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_authority_changes where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_run_reads where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_run_read_records where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_run_releases where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_coding_machine_reads where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_coding_machine_read_records where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_journal where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_reviews where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_views where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_operation_keys where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_runtime_machine_allocations where profile_id = '64400000-0000-4000-8000-000000000010';
delete from public.qorpera_coding_executors where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_coding_repository_grants where environment_id = '64400000-0000-4000-8000-000000000020';
delete from public.qorpera_coding_sessions where profile_id = '64400000-0000-4000-8000-000000000010';
delete from public.qorpera_coding_machines where profile_id = '64400000-0000-4000-8000-000000000010';
delete from public.qorpera_runtime_workers where profile_id = '64400000-0000-4000-8000-000000000010';
delete from public.qorpera_runtime_office_shell_commands where office_id = '64400000-0000-4000-8000-0000000000e0';
delete from public.qorpera_runtime_office_access where office_id = '64400000-0000-4000-8000-0000000000e0';
delete from public.qorpera_runtime_office_screens where office_id = '64400000-0000-4000-8000-0000000000e0';
delete from public.qorpera_runtime_office_activations where office_id = '64400000-0000-4000-8000-0000000000e0';
delete from public.qorpera_runtime_node_demands where allocation_id = '64400000-0000-4000-8000-0000000000e1';
delete from public.qorpera_runtime_offices where id = '64400000-0000-4000-8000-0000000000e0';
delete from public.qorpera_wake_occurrences where profile_id = '64400000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_runs where profile_id = '64400000-0000-4000-8000-000000000010';
delete from public.qorpera_runner_jobs where profile_id = '64400000-0000-4000-8000-000000000010';
delete from public.qorpera_session_inputs where session_id in (select id from public.qorpera_shared_sessions where profile_id = '64400000-0000-4000-8000-000000000010');
delete from public.qorpera_shared_sessions where profile_id = '64400000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_sponsor_versions where binding_id = '64400000-0000-4000-8000-0000000000a1';
delete from public.qorpera_execution_sponsor_bindings where id = '64400000-0000-4000-8000-0000000000a1';
delete from public.qorpera_provider_connections where id = '64400000-0000-4000-8000-0000000000b3';
set session_replication_role = origin;
delete from public.qorpera_profiles where id = '64400000-0000-4000-8000-000000000010';
delete from auth.users where id in ('64400000-0000-4000-8000-000000000001','64400000-0000-4000-8000-000000000002');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '64400000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64400000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_views where environment_id = '64400000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_runtime_offices where profile_id = '64400000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_runtime_office_shell_commands where office_id = '64400000-0000-4000-8000-0000000000e0') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
