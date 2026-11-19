-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- 20260930616000: the run check's eight helpers moved from LANGUAGE sql to PL/pgSQL to keep their plans. On 648's committed
-- company and its real leased run of Ada:
-- 1. each helper keeps its grants and its attributes;
-- 2. the old statement (a copy of the definition before the migration, as pg_temp functions) and the new function give the
--    same answer in every state that changes one, and each state does change it;
-- 3. the run mutex orders them as before, and a plan the connection kept never hides a commit: a call that waited at the
--    mutex, on a connection that has already run the check many times, sees the stop, the recovery and the closed login
--    committed during its wait, and refuses.

-- 1. Grants and attributes. The migration compares each with its value before; these are the values production had.
do $$
declare v_row record;
begin
	for v_row in select * from (values
		('public.qorpera_execution_compute_available(public.qorpera_execution_runs)'::regprocedure, 'v', false),
		('public.qorpera_execution_sponsor_available(public.qorpera_execution_runs)'::regprocedure, 'v', false),
		('public.qorpera_company_execution_paused(uuid)'::regprocedure, 's', true),
		('public.qorpera_sponsor_serves_requester(uuid,uuid,bigint,uuid)'::regprocedure, 's', true),
		('public.qorpera_connection_is_chatgpt_plan(uuid)'::regprocedure, 's', false),
		('public.qorpera_sponsor_version_is_chatgpt_plan(uuid,bigint)'::regprocedure, 's', false),
		('public.qorpera_run_worker(uuid)'::regprocedure, 's', false),
		('public.qorpera_runner_session_valid(uuid,text)'::regprocedure, 's', false)) as t(fn, volatility, service) loop
		if not exists (select 1 from pg_proc p
				where p.oid = v_row.fn and p.prosecdef and p.provolatile = v_row.volatility::"char"
					and p.proconfig = array['search_path=""'] and pg_get_userbyid(p.proowner) = 'postgres') then
			raise exception '% is not as expected', v_row.fn; end if;
		if has_function_privilege('public', v_row.fn, 'execute') or has_function_privilege('anon', v_row.fn, 'execute')
			or has_function_privilege('authenticated', v_row.fn, 'execute')
			or has_function_privilege('qorpera_secret_broker', v_row.fn, 'execute')
			or has_function_privilege('service_role', v_row.fn, 'execute') <> v_row.service then
			raise exception 'The grants of % changed', v_row.fn; end if;
	end loop;
end $$;

create function pg_temp.d6_answers() returns jsonb language plpgsql as $$
declare
	v_run public.qorpera_execution_runs; v_answers jsonb := '{}'; v_pair record;
	c_profile constant uuid := '64800000-0000-4000-8000-000000000010'; c_binding constant uuid := '64800000-0000-4000-8000-0000000000b1';
	c_connection constant uuid := '64800000-0000-4000-8000-0000000000b3'; c_runner constant uuid := '64800000-0000-4000-8000-0000000000f4';
	c_owner constant uuid := '64800000-0000-4000-8000-000000000001'; c_member constant uuid := '64800000-0000-4000-8000-000000000002';
	c_other constant uuid := '64800000-0000-4000-8000-00000000ffff';
begin
	select * into strict v_run from public.qorpera_execution_runs where id = '64800000-0000-4000-8000-0000000000f1';
	for v_pair in select * from (values
		('compute', to_jsonb(public.qorpera_execution_compute_available(v_run))),
		('sponsor', to_jsonb(public.qorpera_execution_sponsor_available(v_run))),
		('compute_null', to_jsonb(public.qorpera_execution_compute_available(null))),
		('sponsor_null', to_jsonb(public.qorpera_execution_sponsor_available(null))),
		('paused', to_jsonb(public.qorpera_company_execution_paused(c_profile))),
		('paused_null', to_jsonb(public.qorpera_company_execution_paused(null))),
		('serves_owner', to_jsonb(public.qorpera_sponsor_serves_requester(c_profile, c_binding, 1, c_owner))),
		('serves_member', to_jsonb(public.qorpera_sponsor_serves_requester(c_profile, c_binding, 1, c_member))),
		('serves_no_version', to_jsonb(public.qorpera_sponsor_serves_requester(c_profile, c_binding, 99, c_owner))),
		('serves_no_binding', to_jsonb(public.qorpera_sponsor_serves_requester(c_profile, c_other, 1, c_owner))),
		('serves_null', to_jsonb(public.qorpera_sponsor_serves_requester(null, null, null, null))),
		('plan', to_jsonb(public.qorpera_connection_is_chatgpt_plan(c_connection))),
		('plan_other', to_jsonb(public.qorpera_connection_is_chatgpt_plan(c_other))),
		('version_plan', to_jsonb(public.qorpera_sponsor_version_is_chatgpt_plan(c_binding, 1))),
		('version_plan_none', to_jsonb(public.qorpera_sponsor_version_is_chatgpt_plan(c_binding, 99))),
		('worker', to_jsonb(public.qorpera_run_worker(v_run.id))),
		('worker_is_null', to_jsonb(public.qorpera_run_worker(v_run.id) is null)),
		('worker_is_distinct', to_jsonb(public.qorpera_run_worker(v_run.id) is distinct from null)),
		('session', to_jsonb(public.qorpera_runner_session_valid(c_runner, repeat('f', 64)))),
		('session_previous', to_jsonb(public.qorpera_runner_session_valid(c_runner, repeat('c', 64)))),
		('session_other', to_jsonb(public.qorpera_runner_session_valid(c_other, repeat('f', 64)))),
		('session_null', to_jsonb(public.qorpera_runner_session_valid(null, null)))
		) as t(name, new_answer) loop
		v_answers := v_answers || jsonb_build_object(v_pair.name, coalesce(v_pair.new_answer, 'null'::jsonb));
	end loop;
	return v_answers;
end $$;
create function pg_temp.d6_state(p_label text, p_expected jsonb) returns void language plpgsql as $$
declare v_answers jsonb := pg_temp.d6_answers(); v_key text;
begin
	for v_key in select jsonb_object_keys(p_expected) loop
		if v_answers -> v_key is distinct from p_expected -> v_key then
			raise exception '%: % should be %, got %', p_label, v_key, p_expected -> v_key, v_answers -> v_key; end if;
	end loop;
end $$;

begin;
set local session_replication_role = replica;
select pg_temp.d6_state('as the fixture left it', '{"compute":true,"sponsor":true,"compute_null":true,"sponsor_null":false,"paused":false,"paused_null":false,
	"serves_owner":true,"serves_member":true,"serves_no_version":false,"serves_no_binding":false,"serves_null":false,
	"plan":false,"plan_other":false,"version_plan":false,"version_plan_none":false,"worker":null,"worker_is_null":true,
	"worker_is_distinct":false,"session":true,"session_previous":false,"session_other":false,"session_null":false}');

-- The compute identity.
savepoint s; update public.qorpera_member_compute_identities set status = 'disabled' where id = '64800000-0000-4000-8000-0000000000d1';
select pg_temp.d6_state('identity disabled', '{"compute":false,"sponsor":true}'); rollback to s;
savepoint s; update public.qorpera_member_compute_identities set recovery_pending_id = '64800000-0000-4000-8000-00000000ffff' where id = '64800000-0000-4000-8000-0000000000d1';
select pg_temp.d6_state('identity recovering', '{"compute":false}'); rollback to s;
savepoint s; update public.qorpera_member_compute_identities set recovery_epoch = recovery_epoch + 1 where id = '64800000-0000-4000-8000-0000000000d1';
select pg_temp.d6_state('identity recovered since the run began', '{"compute":false}'); rollback to s;
savepoint s; update public.qorpera_member_compute_identities set profile_id = '64800000-0000-4000-8000-000000000011' where id = '64800000-0000-4000-8000-0000000000d1';
select pg_temp.d6_state('identity of another company', '{"compute":false}'); rollback to s;
savepoint s; update public.qorpera_execution_runs set compute_identity_id = null where id = '64800000-0000-4000-8000-0000000000f1';
select pg_temp.d6_state('a run with no identity', '{"compute":true}'); rollback to s;

-- The logical computer.
insert into public.qorpera_logical_computers(id, profile_id, client_computer_id, display_name, template_key, template_version, capabilities,
	created_by_user_id)
values ('64800000-0000-4000-8000-0000000000fa', '64800000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), 'Race computer', 'race', '1',
	'["agent_turn"]', '64800000-0000-4000-8000-000000000001');
update public.qorpera_execution_runs set logical_computer_id = '64800000-0000-4000-8000-0000000000fa' where id = '64800000-0000-4000-8000-0000000000f1';
select pg_temp.d6_state('on a computer that can run it', '{"compute":true}');
savepoint s; update public.qorpera_logical_computers set status = 'disabled' where id = '64800000-0000-4000-8000-0000000000fa';
select pg_temp.d6_state('computer disabled', '{"compute":false}'); rollback to s;
savepoint s; update public.qorpera_logical_computers set capabilities = '["git_worktree"]' where id = '64800000-0000-4000-8000-0000000000fa';
select pg_temp.d6_state('computer without the capability', '{"compute":false}'); rollback to s;
savepoint s; update public.qorpera_logical_computers set profile_id = '64800000-0000-4000-8000-000000000011' where id = '64800000-0000-4000-8000-0000000000fa';
select pg_temp.d6_state('computer of another company', '{"compute":false}'); rollback to s;
savepoint s; update public.qorpera_execution_runs set logical_computer_id = '64800000-0000-4000-8000-00000000ffff' where id = '64800000-0000-4000-8000-0000000000f1';
select pg_temp.d6_state('a computer that is gone', '{"compute":false}'); rollback to s;
update public.qorpera_execution_runs set logical_computer_id = null where id = '64800000-0000-4000-8000-0000000000f1';

-- The sponsor: its binding, its connection, the run's reservation and model policy, the member behind a member's login.
savepoint s; update public.qorpera_execution_sponsor_bindings set status = 'disabled' where id = '64800000-0000-4000-8000-0000000000b1';
select pg_temp.d6_state('binding disabled', '{"sponsor":false,"compute":true}'); rollback to s;
savepoint s; update public.qorpera_execution_sponsor_bindings set profile_id = '64800000-0000-4000-8000-000000000011' where id = '64800000-0000-4000-8000-0000000000b1';
select pg_temp.d6_state('binding of another company', '{"sponsor":false,"serves_owner":false,"serves_member":false}'); rollback to s;
savepoint s; update public.qorpera_provider_connections set status = 'revoked' where id = '64800000-0000-4000-8000-0000000000b3';
select pg_temp.d6_state('login revoked', '{"sponsor":false}'); rollback to s;
savepoint s; update public.qorpera_provider_connections set profile_id = '64800000-0000-4000-8000-000000000011' where id = '64800000-0000-4000-8000-0000000000b3';
select pg_temp.d6_state('login of another company', '{"sponsor":false,"serves_owner":false}'); rollback to s;
savepoint s; update public.qorpera_execution_sponsor_reservations set status = 'settled', actual_microusd = 1, settled_at = clock_timestamp()
	where run_id = '64800000-0000-4000-8000-0000000000f1';
select pg_temp.d6_state('reservation settled', '{"sponsor":false}'); rollback to s;
savepoint s; delete from public.qorpera_runner_model_policies where job_id = '64800000-0000-4000-8000-0000000000f2';
select pg_temp.d6_state('no model policy', '{"sponsor":false}'); rollback to s;
savepoint s; update public.qorpera_execution_runs set sponsor_version = 99 where id = '64800000-0000-4000-8000-0000000000f1';
select pg_temp.d6_state('a sponsor version that is gone', '{"sponsor":false}'); rollback to s;
savepoint s;
update public.qorpera_execution_sponsor_versions set sponsor_kind = 'member_connection' where binding_id = '64800000-0000-4000-8000-0000000000b1';
update public.qorpera_provider_connections set owner_user_id = '64800000-0000-4000-8000-000000000001' where id = '64800000-0000-4000-8000-0000000000b3';
select pg_temp.d6_state('a member''s login', '{"sponsor":true,"serves_owner":true,"serves_member":false}');
delete from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010' and user_id = '64800000-0000-4000-8000-000000000001';
select pg_temp.d6_state('the member left', '{"sponsor":false}');
rollback to s;
savepoint s; update public.qorpera_provider_connections set owner_user_id = '64800000-0000-4000-8000-000000000001' where id = '64800000-0000-4000-8000-0000000000b3';
select pg_temp.d6_state('a company login with an owner', '{"serves_owner":false,"serves_member":false}'); rollback to s;
-- A wake run needs the sponsor's consent to unattended work.
savepoint s;
do $$
declare v_run public.qorpera_execution_runs;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = '64800000-0000-4000-8000-0000000000f1';
	v_run.source_kind := 'wake';
	if public.qorpera_execution_sponsor_available(v_run) then
		raise exception 'A wake with no consent must not be available'; end if;
end $$;
rollback to s;

-- The stop.
savepoint s; insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id) values ('64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000001');
select pg_temp.d6_state('paused', '{"paused":true}'); rollback to s;
savepoint s; insert into public.qorpera_company_deletions(profile_id) values ('64800000-0000-4000-8000-000000000010');
select pg_temp.d6_state('being deleted', '{"paused":true}'); rollback to s;
savepoint s; insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id) values ('64800000-0000-4000-8000-000000000011', '64800000-0000-4000-8000-000000000003');
select pg_temp.d6_state('another company paused', '{"paused":false}'); rollback to s;

-- A ChatGPT plan login.
savepoint s; insert into public.qorpera_model_logins(id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id, provider, native_harness,
	current_version, access_issued_at, access_expires_at, login_kind)
values ('64800000-0000-4000-8000-0000000000fb', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-0000000000d1',
	'64800000-0000-4000-8000-0000000000d2', '64800000-0000-4000-8000-00000000ffff', 'openai', 'codex-cli', 1, clock_timestamp(),
	clock_timestamp() + interval '1 hour', 'chatgpt_plan');
select pg_temp.d6_state('a ChatGPT plan', '{"plan":true,"version_plan":true,"plan_other":false,"version_plan_none":false}');
update public.qorpera_model_logins set login_kind = 'codex' where id = '64800000-0000-4000-8000-0000000000fb';
select pg_temp.d6_state('another kind of login', '{"plan":false,"version_plan":false}'); rollback to s;

-- A worker's run: its row, the same row both ways.
savepoint s; insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
values ('64800000-0000-4000-8000-0000000000fc', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-00000000ffff', 'race-worker', 'coding', 'Race worker', 'read', 'each', '{}',
	'64800000-0000-4000-8000-000000000001', '64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-000000000001',
	'64800000-0000-4000-8000-0000000000b1', 1);
update public.qorpera_wake_occurrences set wake_kind = 'agent', source_kind = 'worker-dispatch', source_id = '64800000-0000-4000-8000-0000000000fc'
	where id = '64800000-0000-4000-8000-0000000000f3';
do $$
declare v_answers jsonb := pg_temp.d6_answers();
begin
	if v_answers #>> '{worker,id}' <> '64800000-0000-4000-8000-0000000000fc' or v_answers -> 'worker_is_null' <> 'false' or v_answers -> 'worker_is_distinct' <> 'true' then
		raise exception 'A worker''s run: %', v_answers; end if;
	if (public.qorpera_run_worker('64800000-0000-4000-8000-0000000000f1')).species <> 'coding' then raise exception 'A field of the worker''s row'; end if;
end $$;
rollback to s;

-- The runner's session.
savepoint s; update public.qorpera_runners set previous_session_token_sha256 = repeat('c', 64), previous_session_expires_at = clock_timestamp() + interval '1 hour'
	where id = '64800000-0000-4000-8000-0000000000f4';
select pg_temp.d6_state('the previous token, in its time', '{"session":true,"session_previous":true}');
update public.qorpera_runners set previous_session_expires_at = clock_timestamp() - interval '1 second' where id = '64800000-0000-4000-8000-0000000000f4';
select pg_temp.d6_state('the previous token, too late', '{"session":true,"session_previous":false}'); rollback to s;
savepoint s; update public.qorpera_runners set session_expires_at = clock_timestamp() - interval '1 second' where id = '64800000-0000-4000-8000-0000000000f4';
select pg_temp.d6_state('the session ran out', '{"session":false}'); rollback to s;
savepoint s; update public.qorpera_runners set status = 'revoked', revoked_at = clock_timestamp(), revoked_by_user_id = '64800000-0000-4000-8000-000000000001', session_token_sha256 = null, session_expires_at = null
	where id = '64800000-0000-4000-8000-0000000000f4';
select pg_temp.d6_state('runner revoked', '{"session":false}'); rollback to s;
rollback;

-- 3. The order, on connections that have run the check enough to keep a generic plan of every helper.
create function pg_temp.d6_warm(p_conn text) returns void language plpgsql as $$
begin
	for attempt in 1 .. 8 loop
		perform * from dblink(p_conn, pg_temp.sql_tool()) as t(x text);
	end loop;
end $$;
do $$
declare v_state text;
begin
	perform pg_temp.d6_warm('fence_one'); perform pg_temp.d6_warm('fence_two');
	-- A second tool call waits at the run mutex, not at the job, and runs once the first commits.
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_tool()) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_tool());
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A second tool call of the run must wait for the first'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_execution_run_budgets'::regclass then
		raise exception 'The second tool call must queue on the run mutex, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The second tool call after the first: %', v_state; end if;
end $$;

-- Each change below commits while a warmed tool call waits at the mutex; it refuses, then a call after the undo answers.
create function pg_temp.d6_behind_the_mutex(p_label text, p_change text, p_undo text, p_refusal text) returns void language plpgsql as $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_tool()) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_tool());
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception '%: the tool call must wait', p_label; end if;
	perform dblink_exec('fence_three', format('set session_replication_role = replica; %s; set session_replication_role = origin', p_change));
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state not like p_refusal then raise exception '%: the tool call behind it must refuse (%), got %', p_label, p_refusal, v_state; end if;
	perform dblink_exec('fence_three', format('set session_replication_role = replica; %s; set session_replication_role = origin', p_undo));
	perform * from dblink('fence_two', pg_temp.sql_tool()) as t(x text);
end $$;
select pg_temp.d6_behind_the_mutex('the identity disabled',
	$q$update public.qorpera_member_compute_identities set status = 'disabled' where id = '64800000-0000-4000-8000-0000000000d1'$q$,
	$q$update public.qorpera_member_compute_identities set status = 'active' where id = '64800000-0000-4000-8000-0000000000d1'$q$, '42501 %');
select pg_temp.d6_behind_the_mutex('the identity recovering',
	$q$update public.qorpera_member_compute_identities set recovery_pending_id = '64800000-0000-4000-8000-00000000ffff' where id = '64800000-0000-4000-8000-0000000000d1'$q$,
	$q$update public.qorpera_member_compute_identities set recovery_pending_id = null where id = '64800000-0000-4000-8000-0000000000d1'$q$, '42501 %');
select pg_temp.d6_behind_the_mutex('the company stopped',
	$q$insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id) values ('64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000001')$q$,
	$q$delete from public.qorpera_company_execution_pauses where profile_id = '64800000-0000-4000-8000-000000000010'$q$, '55000 %');
select pg_temp.d6_behind_the_mutex('the login revoked',
	$q$update public.qorpera_provider_connections set status = 'revoked' where id = '64800000-0000-4000-8000-0000000000b3'$q$,
	$q$update public.qorpera_provider_connections set status = 'active' where id = '64800000-0000-4000-8000-0000000000b3'$q$, '42501 %');
select pg_temp.d6_behind_the_mutex('the runner revoked',
	$q$update public.qorpera_runners set status = 'revoked', revoked_at = clock_timestamp(), revoked_by_user_id = '64800000-0000-4000-8000-000000000001', session_token_sha256 = null, session_expires_at = null where id = '64800000-0000-4000-8000-0000000000f4'$q$,
	$q$update public.qorpera_runners set status = 'active', revoked_at = null, revoked_by_user_id = null, session_token_sha256 = repeat('f', 64), session_expires_at = clock_timestamp() + interval '1 hour' where id = '64800000-0000-4000-8000-0000000000f4'$q$, '42501 %');

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture: every row of the company, its environment, its runs, jobs, sessions, rooms and login.
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000011')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_entries where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_profile_staff where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_runners where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from storage.objects where name like '64800000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
