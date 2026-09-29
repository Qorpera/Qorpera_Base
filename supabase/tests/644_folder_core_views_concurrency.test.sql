-- Company folder core, C1b-3a: views under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1B.md, "C1b-3: views"
-- §3 and §4). Other connections race view saves: a holder change that commits while a save waits at its anchor step
-- refuses the save; the office's and the coding archive's plain updates wait for a save in flight; the company row at
-- rank 0 never deadlocks with #462's order (company row, then member). The fixture is committed so the connections can
-- see it, and removed at the end. Waits are detected with pg_blocking_pids, never by wall-clock time.

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
-- Keeps a view's 120 s lease fresh before each race.
create function pg_temp.renew(p_name text) returns void language plpgsql as $$
declare v jsonb := current_setting('qorpera_test.' || p_name)::jsonb; r jsonb;
begin
	r := public.qorpera_folder_view_renew((v ->> 'viewId')::uuid, v ->> 'pass', null);
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

-- D. The company row is locked at rank 0, before the member at rank 1, so a hook that names it (F2's roster files) never
-- deadlocks with #462's order: qorpera_update_profile_member_role (and its siblings) locks the company row FOR UPDATE,
-- then the member row FOR UPDATE. A third connection holds the member row, so the role change stops between its two
-- locks; a member's save and a view's save then wait for the company row holding nothing the role change needs. With
-- the company row at rank 2 the save would take the member row first and wait on the third connection instead, then
-- deadlock with the role change. The hook is replaced for this company only, and its current definition (F2's) comes
-- back after.
select pg_get_functiondef('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure) as structured_targets_def \gset
create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
returns table(rank smallint, tbl text, key text, mode text) language sql stable set search_path = '' as $f$
	select 0::smallint, 'qorpera_profiles', '64400000-0000-4000-8000-000000000010', 'keyshare'
	where p_environment_id = '64400000-0000-4000-8000-000000000020'
$f$;
select pg_temp.hold(current_setting('qorpera_test.run_one')::jsonb);
select pg_temp.renew('desk');
select dblink_connect('view_three', 'dbname=' || current_database());
select set_config('qorpera_test.pid_view_three', pid::text, false) from dblink('view_three', 'select pg_backend_pid()') as t(pid integer);
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
			and user_id = '64400000-0000-4000-8000-000000000002' for update$q$) as t(x integer);
		perform dblink_send_query('view_one', format('select public.qorpera_update_profile_member_role(%L, %L, %L)',
			'64400000-0000-4000-8000-000000000010', '64400000-0000-4000-8000-000000000002', v_role));
		if not pg_temp.waits_for('view_one', 'view_three') then raise exception 'The role change did not stop at the member row'; end if;
		perform dblink_send_query('view_two', pg_temp.sql_commit(v_actor, 'rank-zero-' || v_n, jsonb_build_array(jsonb_build_object('op','mkdir',
			'path','shared/rank-zero-' || v_n))));
		if not pg_temp.waits_for('view_two', 'view_one') then
			raise exception 'Save % must wait for the company row, before the member row', v_n; end if;
		perform dblink_exec('view_three', 'commit');
		v_state := pg_temp.outcome('view_one');
		if v_state <> 'ok' then raise exception 'The role change beside save %: %', v_n, v_state; end if;
		r := pg_temp.result('view_two');
		if r -> 'units' -> 0 ->> 'outcome' <> 'saved' then raise exception 'Save % after the role change: %', v_n, r; end if;
		if (select role::text from public.qorpera_profile_members where profile_id = '64400000-0000-4000-8000-000000000010'
			and user_id = '64400000-0000-4000-8000-000000000002') <> v_role then raise exception 'The role change % must land', v_n; end if;
	end loop;

	-- The other order: a save in flight holds the company row KEY SHARE and the member row; the role change waits at
	-- the company row and goes on once the save commits.
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
		or exists (select 1 from public.qorpera_runtime_offices where profile_id = '64400000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
