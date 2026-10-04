-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-3i part a (P07 part 2, migration 20260930026000): a coding session's rows on the folder fence,
-- folder-v2 only. The begin, the completion, the owner's answer and the claim enter the company (the fence KEY SHARE,
-- rank 0) and take the owner, the agent and its authority, then the todo and the worker (rank 5), before the session;
-- the begin reads the pause after the fence and admits its wake on the folder admission row. A stop's second phase waits
-- them out, and they wait behind it holding no coding row. The claim takes one company per call. 648's committed
-- fixture with a coding todo, worker and session for Ada, removed at the end.

-- Coding rows (committed): Ada's todo and a coding worker owned by the contributor, paid by the company's login, steered
-- by Ada's run; its session leased by executor exec-827, ready to begin. For the claim: a second, queued session of
-- another worker; an older queued session whose worker (with its own todo) is no longer active; and the oldest, a queued
-- session in the snapshot-v1 company. Each owner's coding machine is on exec-827, so the fleet picks it for them. Foreign keys and triggers are off only
-- while they go in.
set session_replication_role = replica;
insert into public.qorpera_runtime_agent_todos(id, profile_id, environment_id, staff_agent_id, todo_key, title, requested_by_user_id,
	created_by_run_id, updated_by_run_id)
values ('82700000-0000-4000-8000-0000000000a0', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'64800000-0000-4000-8000-0000000000a1', 'code-827', 'Code', '64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-0000000000f1');
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
select ('82700000-0000-4000-8000-0000000000c' || n)::uuid, '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'64800000-0000-4000-8000-0000000000a1', '82700000-0000-4000-8000-0000000000a0', 'w-827-' || n, 'coding', 'Code ' || n, 'read', 'each',
	'{}', '64800000-0000-4000-8000-000000000002', '64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-0000000000b1', 1
from generate_series(1, 2) n;
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
values ('82700000-0000-4000-8000-0000000000c9', '64800000-0000-4000-8000-000000000011', '64800000-0000-4000-8000-000000000021',
	extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'w-827-9', 'coding', 'Code', 'read', 'each', '{}',
	'64800000-0000-4000-8000-000000000003', '64800000-0000-4000-8000-0000000000e3', '64800000-0000-4000-8000-000000000003',
	extensions.gen_random_uuid(), 1);
insert into public.qorpera_runtime_agent_todos(id, profile_id, environment_id, staff_agent_id, todo_key, title, requested_by_user_id,
	created_by_run_id, updated_by_run_id)
values ('82700000-0000-4000-8000-0000000000a3', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'64800000-0000-4000-8000-0000000000a1', 'code-827-3', 'Code 3', '64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-0000000000f1');
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version, state, result)
values ('82700000-0000-4000-8000-0000000000c3', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'64800000-0000-4000-8000-0000000000a1', '82700000-0000-4000-8000-0000000000a3', 'w-827-3', 'coding', 'Code 3', 'read', 'each', '{}',
	'64800000-0000-4000-8000-000000000002', '64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-0000000000b1', 1, 'cancelled', '{"outcome":"cancelled","outputs":[]}');
insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, phase, lease_owner,
	lease_token, lease_until, started_at, updated_at)
values ('82700000-0000-4000-8000-0000000000c1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'codex',
	'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'w-827-1', 'preparing', 'exec-827',
	'82700000-0000-4000-8000-0000000000e1', clock_timestamp() + interval '1 hour', clock_timestamp(), clock_timestamp());
insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, updated_at)
values
	('82700000-0000-4000-8000-0000000000c2', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'codex',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'w-827-2', clock_timestamp()),
	-- Older than c2: a worker that is no longer active.
	('82700000-0000-4000-8000-0000000000c3', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'codex',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'w-827-3', clock_timestamp() - interval '30 minutes'),
	-- The oldest: the snapshot-v1 company's session.
	('82700000-0000-4000-8000-0000000000c9', '64800000-0000-4000-8000-000000000011', '64800000-0000-4000-8000-000000000021', 'codex',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'w-827-9', clock_timestamp() - interval '1 hour');
-- The owner's coding machine is on executor exec-827, so the fleet picks it for the owner's sessions.
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values ('82700000-0000-4000-8000-0000000000d1', 'member', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
		'64800000-0000-4000-8000-000000000002', 'exec-827', repeat('7', 64), '{}'),
	('82700000-0000-4000-8000-0000000000d9', 'member', '64800000-0000-4000-8000-000000000011', '64800000-0000-4000-8000-000000000021',
		'64800000-0000-4000-8000-000000000003', 'exec-827', repeat('7', 64), '{}');
insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256)
values ('64800000-0000-4000-8000-000000000020', 'exec-827', true, array['codex'], repeat('7', 64)),
	('64800000-0000-4000-8000-000000000021', 'exec-827', true, array['codex'], repeat('7', 64));
set session_replication_role = origin;

-- fence_one holds what a folder effect holds (the company row and the fence KEY SHARE), what a stop's second phase holds
-- (the fence FOR UPDATE), or a company row KEY SHARE alone (as 824); until pg_temp.release().
create function pg_temp.hold(p_what text, p_profile uuid default '64800000-0000-4000-8000-000000000010') returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'begin');
	if p_what in ('effect','stop') then
		perform * from dblink('fence_one', format('select 1 from public.qorpera_folder_fences where profile_id = %L for %s', p_profile,
			case p_what when 'effect' then 'key share' else 'update' end)) as t(x integer);
	end if;
	if p_what in ('effect','row') then
		perform * from dblink('fence_one', format('select 1 from public.qorpera_profiles where id = %L for key share', p_profile)) as t(x integer);
	end if;
end $$;
create function pg_temp.release() returns void language sql as $$ select dblink_exec('fence_one', 'rollback') $$;
-- Whether a connection waits at a row of a table (as in 665): it holds that row's tuple lock while blocked.
create function pg_temp.waits_at(p_conn text, p_table regclass) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.pid_' || p_conn)::integer; v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if exists (select 1 from pg_locks where pid = v_pid and locktype = 'tuple' and relation = p_table)
			and cardinality(pg_blocking_pids(v_pid)) > 0 then return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
-- Whether nobody holds a row in a mode that blocks FOR UPDATE: probed with NOWAIT on fence_four (as in 824).
create function pg_temp.row_free(p_sql text) returns boolean language plpgsql as $$
begin
	perform * from dblink('fence_four', p_sql || ' for update nowait') as t(x integer);
	return true;
exception when lock_not_available then return false;
end $$;
-- The executor's begin of worker c1's turn, with its lease.
create function pg_temp.sql_begin() returns text language sql as $$
	select format('select public.qorpera_begin_coding_turn(%L, %L, %L)::text', '82700000-0000-4000-8000-0000000000c1',
		'82700000-0000-4000-8000-0000000000e1', '{}')
$$;

-- A. The begin enters the company: while its transaction is open it holds the fence KEY SHARE (a stop's second phase
-- waits for it), the company row KEY SHARE, and the todo and worker; it queues its wake through the folder admission and
-- the session runs.
do $$
declare v_turn jsonb; v_admitted bigint := (select admitted from public.qorpera_folder_admissions
	where profile_id = '64800000-0000-4000-8000-000000000010');
begin
	perform dblink_exec('fence_two', 'begin');
	select r::jsonb into v_turn from dblink('fence_two', pg_temp.sql_begin()) as t(r text);
	if v_turn ->> 'occurrenceId' is null then raise exception 'A: the begin must answer its wake, got %', v_turn; end if;
	if pg_temp.row_free($q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'$q$)
		or pg_temp.row_free($q$select 1 from public.qorpera_runtime_agent_todos where id = '82700000-0000-4000-8000-0000000000a0'$q$)
		or pg_temp.row_free($q$select 1 from public.qorpera_runtime_workers where id = '82700000-0000-4000-8000-0000000000c1'$q$)
		or pg_temp.row_free($q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'$q$) then
		perform dblink_exec('fence_two', 'rollback');
		raise exception 'A: the begin must hold the fence, the company row, the todo and the worker'; end if;
	-- The stop: its pause commits first, then its second phase waits for the begin.
	perform * from dblink('fence_three', $q$select public.qorpera_folder_pause('64800000-0000-4000-8000-000000000010',
		'64800000-0000-4000-8000-000000000001', 'test 827')::text$q$) as t(r text);
	perform dblink_send_query('fence_three', $q$select public.qorpera_folder_pause_drain('64800000-0000-4000-8000-000000000010')::text$q$);
	if not pg_temp.waits_for('fence_three', 'fence_two') then
		perform dblink_exec('fence_two', 'rollback');
		raise exception 'A: a stop''s second phase must wait for the begin (%)', pg_temp.outcome('fence_three'); end if;
	perform dblink_exec('fence_two', 'commit');
	if pg_temp.outcome('fence_three') <> 'ok' then raise exception 'A: the stop''s second phase'; end if;
	perform * from dblink('fence_three', $q$select public.qorpera_folder_resume('64800000-0000-4000-8000-000000000010')::text$q$)
		as t(r text);
	if (select status from public.qorpera_wake_occurrences where id = (v_turn ->> 'occurrenceId')::uuid) <> 'queued'
		or (select phase from public.qorpera_coding_sessions where worker_id = '82700000-0000-4000-8000-0000000000c1') <> 'running'
		or (select occurrence_id from public.qorpera_runtime_workers where id = '82700000-0000-4000-8000-0000000000c1')
			is distinct from (v_turn ->> 'occurrenceId')::uuid
		or (select admitted from public.qorpera_folder_admissions where profile_id = '64800000-0000-4000-8000-000000000010')
			<> v_admitted + 1 then
		raise exception 'A: the wake is queued and admitted, the session runs'; end if;
	-- Back to the start, for B and C.
	set local session_replication_role = replica;
	update public.qorpera_runtime_workers set occurrence_id = null where id = '82700000-0000-4000-8000-0000000000c1';
	update public.qorpera_coding_sessions set phase = 'preparing' where worker_id = '82700000-0000-4000-8000-0000000000c1';
	delete from public.qorpera_wake_occurrences where id = (v_turn ->> 'occurrenceId')::uuid;
end $$;

-- B. Behind a stop's second phase the begin waits at the fence, holding no coding row; once the stop lets go it begins.
do $$
declare v_state text;
begin
	perform pg_temp.hold('stop');
	perform dblink_exec('fence_two', 'begin');
	perform dblink_send_query('fence_two', pg_temp.sql_begin());
	if not pg_temp.waits_at('fence_two', 'public.qorpera_folder_fences') then
		perform pg_temp.release(); perform dblink_exec('fence_two', 'rollback');
		raise exception 'B: the begin must wait at the folder fence'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_runtime_workers where id = '82700000-0000-4000-8000-0000000000c1'$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_runtime_agent_todos where id = '82700000-0000-4000-8000-0000000000a0'$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_coding_sessions where worker_id = '82700000-0000-4000-8000-0000000000c1'$q$) then
		perform pg_temp.release(); perform pg_temp.outcome('fence_two'); perform dblink_exec('fence_two', 'rollback');
		raise exception 'B: the begin held a coding row before the fence'; end if;
	perform pg_temp.release();
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_two', 'rollback');
	if v_state <> 'ok' then raise exception 'B: the begin after the stop, got %', v_state; end if;
end $$;

-- C. A paused company's begin is refused after the fence (it inserts a wake).
select public.qorpera_folder_pause('64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000001', 'test 827') \g /dev/null
do $$
declare v_state text;
begin
	perform dblink_send_query('fence_two', pg_temp.sql_begin());
	v_state := pg_temp.outcome('fence_two');
	if v_state not like '55000 Company execution is paused%' then raise exception 'C: a paused company''s begin, got %', v_state; end if;
end $$;
select public.qorpera_folder_resume('64800000-0000-4000-8000-000000000010') \g /dev/null

-- D. The rows' entry, as the completion and the answer take it: the company, then the todo and the worker. An agent's
-- worker change (F2's cancel holds the worker FOR NO KEY UPDATE after the fence) and the entry take turns at the worker.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'
		for key share$q$) as t(x integer);
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_runtime_workers where id = '82700000-0000-4000-8000-0000000000c1'
		for no key update$q$) as t(x integer);
	perform dblink_send_query('fence_two', $q$select (public.qorpera_lock_coding_worker('82700000-0000-4000-8000-0000000000c1')).id::text$q$);
	if not pg_temp.waits_at('fence_two', 'public.qorpera_runtime_workers') then
		perform pg_temp.release(); raise exception 'D: the entry must wait at the worker'; end if;
	perform pg_temp.release();
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'D: the entry after the worker change, got %', v_state; end if;
	-- A worker of a company that is not folder-v2 is refused.
	perform dblink_send_query('fence_two', $q$select (public.qorpera_lock_coding_worker('82700000-0000-4000-8000-0000000000c9')).id::text$q$);
	v_state := pg_temp.outcome('fence_two');
	if v_state not like '0A000 %' then raise exception 'D: a snapshot-v1 worker must be refused, got %', v_state; end if;
end $$;

-- E. The claim takes one company. The snapshot-v1 session, the oldest and on this executor, is never a candidate; the
-- next oldest, whose worker is no longer active, is skipped with every lock its entry took; the folder-v2 one is claimed,
-- and the claim holds that company's fence while its transaction is open.
do $$
declare v_claim jsonb;
begin
	if public.qorpera_coding_executor_pick('82700000-0000-4000-8000-0000000000c9') is distinct from 'exec-827' then
		raise exception 'E: the fixture must make the snapshot-v1 session this executor''s'; end if;
	perform dblink_exec('fence_two', 'begin');
	select r::jsonb into v_claim from dblink('fence_two', $q$select public.qorpera_claim_coding_session('exec-827', 60)::text$q$) as t(r text);
	if v_claim ->> 'workerId' is distinct from '82700000-0000-4000-8000-0000000000c2' then
		perform dblink_exec('fence_two', 'rollback');
		raise exception 'E: the claim must take the folder-v2 session, got %', v_claim; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_runtime_workers where id = '82700000-0000-4000-8000-0000000000c9'$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_coding_sessions where worker_id = '82700000-0000-4000-8000-0000000000c9'$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_runtime_agent_todos where id = '82700000-0000-4000-8000-0000000000a3'$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_runtime_workers where id = '82700000-0000-4000-8000-0000000000c3'$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_coding_sessions where worker_id = '82700000-0000-4000-8000-0000000000c3'$q$) then
		perform dblink_exec('fence_two', 'rollback');
		raise exception 'E: the claim keeps nothing of the candidates it skipped'; end if;
	if pg_temp.row_free($q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'$q$)
		or pg_temp.row_free($q$select 1 from public.qorpera_runtime_workers where id = '82700000-0000-4000-8000-0000000000c2'$q$) then
		perform dblink_exec('fence_two', 'rollback');
		raise exception 'E: the claim holds its company''s fence and its worker'; end if;
	perform dblink_exec('fence_two', 'rollback');
end $$;

-- F. Failing an expired lease ends the call: the next call takes the queued session.
do $$
declare v_claim jsonb;
begin
	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set phase = 'running', lease_until = clock_timestamp() - interval '1 minute'
	where worker_id = '82700000-0000-4000-8000-0000000000c1';
	update public.qorpera_coding_sessions set updated_at = clock_timestamp() - interval '2 hours'
	where worker_id = '82700000-0000-4000-8000-0000000000c1';
	set local session_replication_role = origin;
	set local request.jwt.claims = '{"role":"service_role"}';
	set local role service_role;
	v_claim := public.qorpera_claim_coding_session('exec-827', 60);
	reset role;
	if v_claim is not null then raise exception 'F: the call that fails an expired lease claims nothing, got %', v_claim; end if;
	if (select phase from public.qorpera_coding_sessions where worker_id = '82700000-0000-4000-8000-0000000000c1') <> 'failed' then
		raise exception 'F: the expired lease is failed'; end if;
	set local role service_role;
	v_claim := public.qorpera_claim_coding_session('exec-827', 60);
	reset role;
	if v_claim ->> 'workerId' is distinct from '82700000-0000-4000-8000-0000000000c2' then
		raise exception 'F: the next call claims the queued session, got %', v_claim; end if;
end $$;

-- The entry held open on fence_two, as the completion and the answer hold it; a holder on fence_one.
create function pg_temp.enter_open() returns void language plpgsql as $$
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select (public.qorpera_lock_coding_worker('82700000-0000-4000-8000-0000000000c1')).id::text$q$)
		as t(r text);
end $$;

-- H. Rank 5 (602's races 1-3 and 6, on folder-v2). Two entries on one worker (the owner's answer against the executor's
-- completion or begin) take turns: the second waits at the todo, holding neither the worker nor the session. An agent's
-- worker tool (F2's cancel holds the todo FOR SHARE and the worker FOR NO KEY UPDATE) makes the entry wait at the todo.
do $$
declare v_state text;
begin
	perform pg_temp.enter_open();
	perform dblink_send_query('fence_three', $q$select (public.qorpera_lock_coding_worker('82700000-0000-4000-8000-0000000000c1')).id::text$q$);
	if not pg_temp.waits_at('fence_three', 'public.qorpera_runtime_agent_todos') then
		perform dblink_exec('fence_two', 'rollback'); raise exception 'H: a second entry must wait at the todo'; end if;
	perform dblink_exec('fence_two', 'rollback');
	v_state := pg_temp.outcome('fence_three');
	if v_state <> 'ok' then raise exception 'H: the second entry after the first, got %', v_state; end if;
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'
		for key share$q$) as t(x integer);
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_runtime_agent_todos where id = '82700000-0000-4000-8000-0000000000a0'
		for share$q$) as t(x integer);
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_runtime_workers where id = '82700000-0000-4000-8000-0000000000c1'
		for no key update$q$) as t(x integer);
	perform dblink_send_query('fence_two', $q$select (public.qorpera_lock_coding_worker('82700000-0000-4000-8000-0000000000c1')).id::text$q$);
	if not pg_temp.waits_at('fence_two', 'public.qorpera_runtime_agent_todos') then
		perform pg_temp.release(); raise exception 'H: the entry must wait at the todo behind an agent''s worker tool'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_coding_sessions where worker_id = '82700000-0000-4000-8000-0000000000c1'$q$) then
		perform pg_temp.release(); perform pg_temp.outcome('fence_two');
		raise exception 'H: the waiting entry holds no session'; end if;
	perform pg_temp.release();
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'H: the entry after the worker tool, got %', v_state; end if;
end $$;

-- I. A coding machine's admission (602's race 4; 3h's order: the machine fence, then the worker FOR UPDATE, then the
-- session) and the entry: the entry waits at the worker, holding no session, so the admission gets its session.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'
		for key share$q$) as t(x integer);
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_runtime_workers where id = '82700000-0000-4000-8000-0000000000c1'
		for update$q$) as t(x integer);
	perform dblink_send_query('fence_two', $q$select (public.qorpera_lock_coding_worker('82700000-0000-4000-8000-0000000000c1')).id::text$q$);
	if not pg_temp.waits_at('fence_two', 'public.qorpera_runtime_workers') then
		perform pg_temp.release(); raise exception 'I: the entry must wait at the worker behind an admission'; end if;
	-- The admission takes its session next: nothing the entry holds is in its way.
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_coding_sessions where worker_id = '82700000-0000-4000-8000-0000000000c1'
		for update nowait$q$) as t(x integer);
	perform pg_temp.release();
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'I: the entry after the admission, got %', v_state; end if;
end $$;

-- J. Someone who does not own the session locks nothing (602's race 8): a member's answer is refused at once while the
-- worker is held, before the entry.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_runtime_workers where id = '82700000-0000-4000-8000-0000000000c1'
		for update$q$) as t(x integer);
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select set_config('request.jwt.claims',
		'{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}', true)$q$) as t(r text);
	perform dblink_exec('fence_two', 'set local role authenticated');
	perform dblink_send_query('fence_two', $q$select public.qorpera_answer_coding_session('82700000-0000-4000-8000-0000000000c1',
		'Both together.', '82700000-0000-4000-8000-0000000000f7')::text$q$);
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then
		perform pg_temp.release(); perform dblink_exec('fence_two', 'rollback');
		raise exception 'J: a non-owner''s answer must not wait'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_two', 'rollback');
	perform pg_temp.release();
	if v_state not like '42501 Only the owner of this coding session can talk to it%' then
		raise exception 'J: a non-owner''s answer is refused, got %', v_state; end if;
end $$;

-- K. A stop's second phase waits for the entry, as for the completion and the answer that hold it.
do $$
begin
	perform pg_temp.enter_open();
	perform * from dblink('fence_three', $q$select public.qorpera_folder_pause('64800000-0000-4000-8000-000000000010',
		'64800000-0000-4000-8000-000000000001', 'test 827 K')::text$q$) as t(r text);
	perform dblink_send_query('fence_three', $q$select public.qorpera_folder_pause_drain('64800000-0000-4000-8000-000000000010')::text$q$);
	if not pg_temp.waits_for('fence_three', 'fence_two') then
		perform dblink_exec('fence_two', 'rollback');
		raise exception 'K: a stop''s second phase must wait for the entry (%)', pg_temp.outcome('fence_three'); end if;
	perform dblink_exec('fence_two', 'rollback');
	if pg_temp.outcome('fence_three') <> 'ok' then raise exception 'K: the stop''s second phase'; end if;
	perform * from dblink('fence_three', $q$select public.qorpera_folder_resume('64800000-0000-4000-8000-000000000010')::text$q$)
		as t(r text);
end $$;

-- L. The owner's answer checks the owner again under the entry. A removal of the owner that commits while the answer waits
-- at the owner's member row (rank 1) is refused; with the owner back, the answer runs on folder-v2: it holds the fence,
-- the todo, the worker and the session while its transaction is open, and reopens the session for the next turn.
create temporary table l_member on commit preserve rows as
	select profile_id, user_id, email, display_name, role from public.qorpera_profile_members
	where profile_id = '64800000-0000-4000-8000-000000000010' and user_id = '64800000-0000-4000-8000-000000000002';
create function pg_temp.answer_open(p_request uuid) returns void language plpgsql as $$
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select set_config('request.jwt.claims',
		'{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000002"}', true)$q$) as t(r text);
	perform dblink_exec('fence_two', 'set local role authenticated');
	perform dblink_send_query('fence_two', format($q$select public.qorpera_answer_coding_session(%L, 'Try again.', %L)::text$q$,
		'82700000-0000-4000-8000-0000000000c1', p_request));
end $$;
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform dblink_exec('fence_one', 'set local session_replication_role = replica');
	perform dblink_exec('fence_one', $q$delete from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
		and user_id = '64800000-0000-4000-8000-000000000002'$q$);
	perform pg_temp.answer_open('82700000-0000-4000-8000-0000000000f8');
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_members') then
		perform pg_temp.release(); perform pg_temp.outcome('fence_two'); perform dblink_exec('fence_two', 'rollback');
		raise exception 'L: the answer must wait at the owner''s member row'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_two', 'rollback');
	set local session_replication_role = replica;
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	select profile_id, user_id, email, display_name, role from l_member;
	if v_state not like '42501 Coding session is unavailable%' then
		raise exception 'L: an owner removed while the answer waited must be refused, got %', v_state; end if;
end $$;
do $$
declare v_state text;
begin
	if (select state from public.qorpera_runtime_workers where id = '82700000-0000-4000-8000-0000000000c1') = 'active' then
		raise exception 'L: the fixture''s worker must have ended (F)'; end if;
	perform pg_temp.answer_open('82700000-0000-4000-8000-0000000000f9');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then perform dblink_exec('fence_two', 'rollback'); raise exception 'L: the owner''s answer, got %', v_state; end if;
	if pg_temp.row_free($q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'$q$)
		or pg_temp.row_free($q$select 1 from public.qorpera_runtime_agent_todos where id = '82700000-0000-4000-8000-0000000000a0'$q$)
		or pg_temp.row_free($q$select 1 from public.qorpera_runtime_workers where id = '82700000-0000-4000-8000-0000000000c1'$q$)
		or pg_temp.row_free($q$select 1 from public.qorpera_coding_sessions where worker_id = '82700000-0000-4000-8000-0000000000c1'$q$) then
		perform dblink_exec('fence_two', 'rollback');
		raise exception 'L: the answer must hold the fence, the todo, the worker and the session'; end if;
	perform dblink_exec('fence_two', 'commit');
	if (select state from public.qorpera_runtime_workers where id = '82700000-0000-4000-8000-0000000000c1') <> 'active'
		or (select phase from public.qorpera_coding_sessions where worker_id = '82700000-0000-4000-8000-0000000000c1') <> 'input_ready' then
		raise exception 'L: the answer reopens the session for the next turn'; end if;
end $$;

-- G. The entry is internal, and every patched body carries the marker.
do $$
begin
	if exists (select 1 from unnest(array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker']) r
		where has_function_privilege(r, 'public.qorpera_lock_coding_worker(uuid)', 'execute')) then
		raise exception 'G: the coding worker entry must be internal'; end if;
	if exists (select 1 from unnest(array['public.qorpera_lock_coding_worker(uuid)', 'public.qorpera_begin_coding_turn(uuid,uuid,jsonb)',
			'public.qorpera_claim_coding_session(text,integer)', 'public.qorpera_delegate_coding_session(uuid,uuid)',
			'public.qorpera_answer_coding_session(uuid,text,uuid)', 'public.qorpera_archive_coding_session(uuid,uuid)',
			'public.qorpera_archive_quiet_coding_sessions(text)', 'public.qorpera_ask_quiet_coding_sessions(text)']) f
		where position('20260930026000' in pg_get_functiondef(f::regprocedure)) = 0) then
		raise exception 'G: a patched body lacks its marker'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture: 648's company rows (and the coding rows above), as 826 removes them.
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
	-- Rows keyed only by their coding worker.
	delete from public.qorpera_coding_session_events where worker_id in
		(select id from public.qorpera_runtime_workers where profile_id = any (v_profiles));
	delete from public.qorpera_runtime_worker_events where worker_id in
		(select id from public.qorpera_runtime_workers where profile_id = any (v_profiles));
	delete from public.qorpera_coding_session_turns where worker_id in
		(select id from public.qorpera_runtime_workers where profile_id = any (v_profiles));
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
	-- The computer-hour inbox keeps ids of hour-log rows the loop above removed.
	delete from public.qorpera_computer_hour_inbox inbox
	where not exists (select 1 from public.qorpera_computer_hour_log log where log.id = inbox.log_id);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_company_machines where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_runtime_nodes where id = '82400000-0000-4000-8000-000000000410')
		or exists (select 1 from public.qorpera_machine_executors where owner = 'mx-824')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
