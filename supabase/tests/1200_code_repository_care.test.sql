-- @fixture 1170_own_code_repositories.test.sql until "-- 3. One place under code/"
-- Nightly care of the repositories kept in Qorpera (migration 20260930710000): the registry and the coding executor's
-- three calls. 1170's fixture: the company's own repository company/shop with Alice's sessions b1 (queued) and b2
-- (cancelled) on it, the company enrolled with exec-1170; and another company exec-1170 serves.
--   1. Rights: no API role reads or writes the registry; the service role alone calls due, step and finish, as a coding
--      executor (owner and machine id well formed).
--   2. The trigger: two sessions on one repository are one row; a GitHub session is none; another repository is another.
--   3. Due: each thing that keeps a repository out, the order and the limit.
--   4. Step: begin, renew, lost, busy and not-due.
--   5. Step 'retire': the sessions whose worktrees may go, 20 a call, going round, only while retiring is on.
--   6. Finish: the outcome's shape, lost, what each part writes, the problem and since when, the next care.
--   7. The next care's time, at fixed instants.
--   8. Three starts and no finish.

-- This company's environment and the other company's.
create function pg_temp.care_here() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000020'::uuid
$$;
create function pg_temp.care_there() returns uuid language sql immutable as $$
	select '91170000-0000-4000-8000-000000000020'::uuid
$$;
create function pg_temp.care_shop() returns public.qorpera_code_repositories language sql as $$
	select * from public.qorpera_code_repositories
	where environment_id = pg_temp.care_here() and owner = 'company' and name = 'shop'
$$;
-- The three calls as the coding executor makes them: the service role, with its claims.
create function pg_temp.care_due(p_owner text default 'exec-1170', p_machine text default repeat('5', 64),
	p_limit integer default 50) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_care_due(p_owner, p_machine, p_limit);
	reset role;
	return v;
end $$;
create function pg_temp.care_step(p_token uuid, p_step text, p_owner text default 'exec-1170',
	p_machine text default repeat('5', 64), p_environment uuid default pg_temp.care_here(),
	p_repository_owner text default 'company', p_name text default 'shop') returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_care_step(p_owner, p_machine, p_environment, p_repository_owner, p_name, p_token, p_step);
	reset role;
	return v;
end $$;
create function pg_temp.care_finish(p_token uuid, p_outcome jsonb, p_owner text default 'exec-1170',
	p_machine text default repeat('5', 64), p_environment uuid default pg_temp.care_here(),
	p_repository_owner text default 'company', p_name text default 'shop') returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_care_finish(p_owner, p_machine, p_environment, p_repository_owner, p_name, p_token, p_outcome);
	reset role;
	return v;
end $$;
-- The names due now, in the order due gives them.
create function pg_temp.care_names(p_owner text default 'exec-1170', p_machine text default repeat('5', 64),
	p_limit integer default 50) returns text language sql as $$
	select coalesce(string_agg(due.repository ->> 'name', ',' order by due.n), '')
	from jsonb_array_elements(pg_temp.care_due(p_owner, p_machine, p_limit) -> 'repositories') with ordinality due(repository, n)
$$;
-- company/shop is due, and a run of it begins: its token.
create function pg_temp.care_begin() returns uuid language plpgsql as $$
declare v jsonb;
begin
	update public.qorpera_code_repositories set next_care_at = clock_timestamp() - interval '1 second' where name = 'shop';
	v := pg_temp.care_step(null, 'begin');
	perform pg_temp.base_assert(v ->> 'state' = 'go', 'a run begins: ' || v::text);
	return (v ->> 'token')::uuid;
end $$;
-- The lease of company/shop's run ended a second ago.
create function pg_temp.care_lapse() returns void language sql as $$
	update public.qorpera_code_repositories set care_until = clock_timestamp() - interval '1 second' where name = 'shop'
$$;
-- A run's outcome in which every part was skipped, with the keys given changed.
create function pg_temp.care_outcome(p_change jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.code-care-outcome/v1', 'state', 'done', 'problem', null,
		'mainSha', repeat('a', 40), 'refsSha256', repeat('b', 64), 'repaired', 'none', 'deep', false,
		'fsck', jsonb_build_object('state', 'skipped', 'detail', null),
		'bundle', jsonb_build_object('state', 'skipped', 'name', null, 'sha256', null, 'bytes', null, 'refsSha256', null),
		'gc', jsonb_build_object('state', 'skipped'), 'worktrees', null, 'retired', 0) || p_change
$$;
-- A bundle part that stored nothing, in that state.
create function pg_temp.care_no_bundle(p_state text) returns jsonb language sql as $$
	select jsonb_build_object('state', p_state, 'name', null, 'sha256', null, 'bytes', null, 'refsSha256', null)
$$;
-- Session b1's phase, as its turns would move it.
create function pg_temp.care_phase(p_phase text, p_ago interval default interval '0') returns void language sql as $$
	update public.qorpera_coding_sessions set phase = p_phase, updated_at = clock_timestamp() - p_ago
	where worker_id = '91170000-0000-4000-8000-0000000000b1'
$$;
-- The id of the n-th copy of a session.
create function pg_temp.care_copy(p_n integer) returns uuid language sql immutable as $$
	select format('91200000-0000-4000-8000-%s', lpad(p_n::text, 12, '0'))::uuid
$$;
-- A copy of the cancelled session b2 and its worker under a new id, archived that long ago, with the session's and
-- the worker's columns given changed.
create function pg_temp.care_archived(p_n integer, p_ago interval default interval '8 days', p_session jsonb default '{}',
	p_worker jsonb default '{}') returns uuid language plpgsql as $$
declare v_id uuid := pg_temp.care_copy(p_n);
begin
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_runtime_workers
	select (jsonb_populate_record(null::public.qorpera_runtime_workers,
		to_jsonb(w) || jsonb_build_object('id', v_id, 'worker_key', 'care-' || p_n) || p_worker)).*
	from public.qorpera_runtime_workers w where w.id = '91170000-0000-4000-8000-0000000000b2';
	insert into public.qorpera_coding_sessions
	select (jsonb_populate_record(null::public.qorpera_coding_sessions,
		to_jsonb(s) || jsonb_build_object('worker_id', v_id, 'branch', 'qorpera/coding/' || v_id::text,
			'archived_at', clock_timestamp() - p_ago, 'archived_by', 'kernel') || p_session)).*
	from public.qorpera_coding_sessions s where s.worker_id = '91170000-0000-4000-8000-0000000000b2';
	perform set_config('session_replication_role', 'origin', true);
	return v_id;
end $$;

-- 1. Rights -----------------------------------------------------------------------------------------------------------
do $$
declare v_role text; v_function text;
begin
	perform pg_temp.base_assert((select relrowsecurity from pg_class
		where oid = 'public.qorpera_code_repositories'::regclass), 'row level security is on');
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(not has_table_privilege(v_role, 'public.qorpera_code_repositories',
			'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'the registry is closed to ' || v_role);
		foreach v_function in array array['public.qorpera_code_repository_register()',
			'public.qorpera_code_care_holder(uuid,text,text)',
			'public.qorpera_code_care_next_at(text,text,boolean,timestamptz)',
			'public.qorpera_code_care_text_valid(jsonb,text)', 'public.qorpera_code_care_outcome_valid(jsonb)'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_function, 'EXECUTE'),
				v_function || ' is closed to ' || v_role);
		end loop;
		foreach v_function in array array['public.qorpera_code_care_due(text,text,integer)',
			'public.qorpera_code_care_step(text,text,uuid,text,text,uuid,text)',
			'public.qorpera_code_care_finish(text,text,uuid,text,text,uuid,jsonb)'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_function, 'EXECUTE') = (v_role = 'service_role'),
				v_function || ' is the service role''s only: ' || v_role);
			perform pg_temp.base_assert((select prosecdef and proconfig = array['search_path=""'] from pg_proc
				where oid = v_function::regprocedure), v_function || ' is a definer with an empty search path');
		end loop;
	end loop;
	-- The company's purge takes the registry with the company, and nothing stops its delete.
	perform pg_temp.base_assert((select count(*) from pg_constraint
		where conrelid = 'public.qorpera_code_repositories'::regclass and contype = 'f'
			and ((confrelid = 'public.qorpera_profiles'::regclass and confdeltype = 'c')
				or (confrelid = 'public.qorpera_company_environments'::regclass and confdeltype = 'r'))) = 2
		and not exists (select 1 from pg_trigger where tgrelid = 'public.qorpera_code_repositories'::regclass
			and not tgisinternal), 'the registry goes with its company');
end $$;
-- The service role itself cannot read or write the registry.
set local role service_role;
select pg_temp.base_error('select count(*) from public.qorpera_code_repositories', '42501') \g /dev/null
select pg_temp.base_error('update public.qorpera_code_repositories set gc_enabled = true', '42501') \g /dev/null
reset role;
-- A call with no custody: 42501, in the words of the executor's other calls.
create function pg_temp.care_no_custody(p_call text, p_caller text) returns void language sql as $$
	select pg_temp.base_error(format(p_call, p_caller), '42501', 'Coding machine custody required')
$$;
do $$
declare v_call text; v_role text;
begin
	-- Without the service role's claims, and with an owner or a machine id that is none: no custody.
	foreach v_call in array array[
		$q$select public.qorpera_code_care_due(%s, 50)$q$,
		$q$select public.qorpera_code_care_step(%s, pg_temp.care_here(), 'company', 'shop', null, 'begin')$q$,
		$q$select public.qorpera_code_care_finish(%s, pg_temp.care_here(), 'company', 'shop',
			'91200000-0000-4000-8000-0000000000aa', pg_temp.care_outcome())$q$] loop
		foreach v_role in array array['anon', 'authenticated'] loop
			perform pg_temp.base_claims(v_role);
			perform pg_temp.care_no_custody(v_call, $q$'exec-1170', repeat('5', 64)$q$);
		end loop;
		perform pg_temp.base_claims('service_role');
		perform pg_temp.care_no_custody(v_call, $q$null, repeat('5', 64)$q$);
		perform pg_temp.care_no_custody(v_call, $q$'exec 1170', repeat('5', 64)$q$);
		perform pg_temp.care_no_custody(v_call, $q$repeat('e', 121), repeat('5', 64)$q$);
		perform pg_temp.care_no_custody(v_call, $q$'exec-1170', null$q$);
		perform pg_temp.care_no_custody(v_call, $q$'exec-1170', repeat('A', 64)$q$);
		perform pg_temp.care_no_custody(v_call, $q$'exec-1170', repeat('5', 63)$q$);
	end loop;
end $$;

-- 2. The trigger ------------------------------------------------------------------------------------------------------
do $$
declare v_alice jsonb := pg_temp.c3_alice(); v_result jsonb; r public.qorpera_code_repositories%rowtype;
	v_todo text := 'QorperaOS/agents/alice/todos/fix-login/';
begin
	-- 1170's two sessions on company/shop registered it once, due at once, with packing and retiring off.
	perform pg_temp.base_assert((select count(*) from public.qorpera_coding_sessions s
			where s.repository = pg_temp.own_repo()) = 2
		and (select count(*) from public.qorpera_code_repositories) = 1, 'two sessions, one repository');
	r := pg_temp.care_shop();
	perform pg_temp.base_assert(r.profile_id = '92400000-0000-4000-8000-000000000010' and r.care_enabled
		and r.gc_enabled and r.retire_enabled and r.next_care_at <= clock_timestamp() and r.care_token is null
		and r.care_owner is null and r.care_until is null and r.care_attempts = 0 and r.last_care_at is null
		and r.problem is null and r.retired = 0 and r.retire_cursor is null and r.outcome is null,
		'the registered repository: ' || to_jsonb(r)::text);
	-- A session on a GitHub repository registers nothing.
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_set_coding_repository_grant(pg_temp.care_here(), '92400000-0000-4000-8000-000000000030',
		pg_temp.c3_repo(), true);
	v_result := pg_temp.c3_dispatch(v_alice, 'care-github-1', v_todo || 'github',
		pg_temp.c3_brief('91200000-0000-4000-8000-0000000000b3'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved'
		and (pg_temp.c3_session('91200000-0000-4000-8000-0000000000b3')).repository ->> 'host' = 'github.com'
		and (select count(*) from public.qorpera_code_repositories) = 1, 'a GitHub session: ' || v_result::text);
	-- A session on another repository of the company registers that one.
	v_result := pg_temp.c3_dispatch(v_alice, 'care-site-1', v_todo || 'site',
		pg_temp.own_brief('91200000-0000-4000-8000-0000000000b4', pg_temp.own_repo('company', 'site')));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved'
		and (select count(*) from public.qorpera_code_repositories) = 2
		and exists (select 1 from public.qorpera_code_repositories where environment_id = pg_temp.care_here()
			and profile_id = '92400000-0000-4000-8000-000000000010' and owner = 'company' and name = 'site'),
		'another repository: ' || v_result::text);
	perform pg_temp.base_assert(to_jsonb(pg_temp.care_shop()) = to_jsonb(r), 'the first stays as it was');
end $$;

-- 3. Due --------------------------------------------------------------------------------------------------------------
-- exec-1170 runs on machine 5…5. The other company has a repository company/app, due before this company's two.
update public.qorpera_coding_executors set nas_machine_id_sha256 = repeat('5', 64) where owner = 'exec-1170';
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, next_care_at)
values (pg_temp.care_there(), '91170000-0000-4000-8000-000000000010', 'company', 'app', clock_timestamp() - interval '4 hours');
update public.qorpera_code_repositories set next_care_at = clock_timestamp() - interval '3 hours' where name = 'shop';
update public.qorpera_code_repositories set next_care_at = clock_timestamp() - interval '2 hours' where name = 'site';
do $$
declare v_alice jsonb := pg_temp.c3_alice(); v_due jsonb; v_phase text;
	v_todo text := 'QorperaOS/agents/alice/todos/fix-login/';
	v_company jsonb := jsonb_build_object('companyId', '92400000-0000-4000-8000-000000000010',
		'environmentId', pg_temp.care_here(), 'owner', 'company');
begin
	-- This company's sessions b1, b3 and b4 wait for an executor: only the other company's repository is due.
	perform pg_temp.base_assert(pg_temp.care_names() = 'app', 'three sessions queued: ' || pg_temp.care_names());
	perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder', v_todo || 'site',
		'operationKey', 'care-cancel-site'));
	perform pg_temp.care_phase('completed');
	-- A queued session on a GitHub repository keeps the company's repositories out too.
	perform pg_temp.base_assert(pg_temp.care_names() = 'app', 'the GitHub session is queued');
	perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder', v_todo || 'github',
		'operationKey', 'care-cancel-github'));
	-- Quiet: all three, oldest due first, each with its company, environment, owner and name.
	v_due := pg_temp.care_due();
	perform pg_temp.base_assert(v_due = jsonb_build_object('schema', 'qorpera.code-care-due/v1', 'repositories',
		jsonb_build_array(jsonb_build_object('companyId', '91170000-0000-4000-8000-000000000010',
				'environmentId', pg_temp.care_there(), 'owner', 'company', 'name', 'app'),
			v_company || '{"name":"shop"}', v_company || '{"name":"site"}')), 'all three are due: ' || v_due::text);
	-- The limit keeps the oldest, and is 1 to 50.
	perform pg_temp.base_assert(pg_temp.care_names(p_limit => 2) = 'app,shop' and pg_temp.care_names(p_limit => 1) = 'app',
		'the limit keeps the oldest');
	perform pg_temp.base_error($q$select pg_temp.care_due(p_limit => 0)$q$, '22023', 'Code care limit invalid');
	perform pg_temp.base_error($q$select pg_temp.care_due(p_limit => 51)$q$, '22023', 'Code care limit invalid');
	perform pg_temp.base_error($q$select pg_temp.care_due(p_limit => null)$q$, '22023', 'Code care limit invalid');
	-- A session of the company that waits for an executor or is in a turn keeps both its repositories out; one that
	-- waits for its member or has ended does not.
	foreach v_phase in array array['queued', 'input_ready', 'preparing', 'running', 'publishing'] loop
		perform pg_temp.care_phase(v_phase);
		perform pg_temp.base_assert(pg_temp.care_names() = 'app', 'a session is ' || v_phase);
	end loop;
	foreach v_phase in array array['awaiting_input', 'failed', 'cancelled', 'completed'] loop
		perform pg_temp.care_phase(v_phase);
		perform pg_temp.base_assert(pg_temp.care_names() = 'app,shop,site', 'a session is ' || v_phase);
	end loop;
	-- A session that has waited for an executor for more than 15 minutes waits for something that can take hours (its
	-- login's usage limit): care does not wait with it. A turn, however long it lasts, keeps care away.
	foreach v_phase in array array['queued', 'input_ready'] loop
		perform pg_temp.care_phase(v_phase, interval '14 minutes');
		perform pg_temp.base_assert(pg_temp.care_names() = 'app', 'a session is ' || v_phase || ' for 14 minutes');
		perform pg_temp.care_phase(v_phase, interval '16 minutes');
		perform pg_temp.base_assert(pg_temp.care_names() = 'app,shop,site', 'a session is ' || v_phase || ' for 16 minutes');
	end loop;
	foreach v_phase in array array['preparing', 'running', 'publishing'] loop
		perform pg_temp.care_phase(v_phase, interval '3 hours');
		perform pg_temp.base_assert(pg_temp.care_names() = 'app', 'a session is ' || v_phase || ' for 3 hours');
	end loop;
	perform pg_temp.care_phase('completed');

	-- Care switched off.
	update public.qorpera_code_repositories set care_enabled = false where name = 'shop';
	perform pg_temp.base_assert(pg_temp.care_names() = 'app,site', 'care is off');
	update public.qorpera_code_repositories set care_enabled = true where name = 'shop';
	-- Not due yet.
	update public.qorpera_code_repositories set next_care_at = clock_timestamp() + interval '1 minute' where name = 'site';
	perform pg_temp.base_assert(pg_temp.care_names() = 'app,shop', 'not due yet');
	update public.qorpera_code_repositories set next_care_at = clock_timestamp() - interval '2 hours' where name = 'site';
	-- A run holds the lease; one whose lease ended does not.
	update public.qorpera_code_repositories set care_token = '91200000-0000-4000-8000-0000000000aa',
		care_owner = 'exec-1170', care_until = clock_timestamp() + interval '1 minute' where name = 'shop';
	perform pg_temp.base_assert(pg_temp.care_names() = 'app,site', 'a live lease');
	perform pg_temp.care_lapse();
	perform pg_temp.base_assert(pg_temp.care_names() = 'app,shop,site', 'a lease that ended');
	update public.qorpera_code_repositories set care_token = null, care_owner = null, care_until = null where name = 'shop';

	-- Another executor's company: exec-other on machine 6…6 serves the other company now.
	update public.qorpera_coding_executors set owner = 'exec-other', nas_machine_id_sha256 = repeat('6', 64)
	where environment_id = pg_temp.care_there();
	perform pg_temp.base_assert(pg_temp.care_names() = 'shop,site'
		and pg_temp.care_names('exec-other', repeat('6', 64)) = 'app', 'each executor its own companies');
	-- The executor on another machine, an executor nobody enrolled, and one switched off: none.
	perform pg_temp.base_assert(pg_temp.care_names('exec-1170', repeat('6', 64)) = ''
		and pg_temp.care_names('exec-other', repeat('5', 64)) = '' and pg_temp.care_names('exec-none') = '',
		'another machine, or no executor of it');
	update public.qorpera_coding_executors set enabled = false where environment_id = pg_temp.care_here();
	perform pg_temp.base_assert(pg_temp.care_names() = '', 'the executor is switched off');
	update public.qorpera_coding_executors set enabled = true where environment_id = pg_temp.care_here();
	insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256)
	values (pg_temp.care_here(), 'exec-two', true, array['codex'], repeat('6', 64));
	perform pg_temp.base_assert(pg_temp.care_names() = 'shop,site' and pg_temp.care_names('exec-two', repeat('6', 64)) = '',
		'two executors: primary holds care');
	update public.qorpera_coding_executors set enabled = false where owner = 'exec-1170';
	perform pg_temp.base_assert(pg_temp.care_names() = '' and pg_temp.care_names('exec-two', repeat('6', 64)) = 'shop,site',
		'two executors: failover to secondary');
	update public.qorpera_coding_executors set enabled = true where owner = 'exec-1170';
	update public.qorpera_coding_executors set enabled = false where owner = 'exec-two';
	perform pg_temp.base_assert(pg_temp.care_names() = 'shop,site'
		and pg_temp.care_names('exec-two', repeat('6', 64)) = '', 'the second is off');
	-- The company is being deleted.
	insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
	values ('92400000-0000-4000-8000-000000000010', null);
	perform pg_temp.base_assert(pg_temp.care_names() = '', 'the company is being deleted');
	delete from public.qorpera_company_deletions where profile_id = '92400000-0000-4000-8000-000000000010';
	perform pg_temp.base_assert(pg_temp.care_names() = 'shop,site', 'as before');
	-- It wrote nothing.
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_code_repositories
		where care_token is not null or care_attempts <> 0 or last_care_at is not null), 'due writes nothing');
end $$;

-- 4. Step -------------------------------------------------------------------------------------------------------------
do $$
declare v jsonb; v_token uuid; v_second uuid; r public.qorpera_code_repositories%rowtype;
	v_lost jsonb := '{"schema":"qorpera.code-care-step/v1","state":"lost"}';
	v_not_due jsonb := '{"schema":"qorpera.code-care-step/v1","state":"not-due"}';
	v_busy jsonb := '{"schema":"qorpera.code-care-step/v1","state":"busy"}';
	v_other uuid := '91200000-0000-4000-8000-0000000000aa';
begin
	-- A step is one of the eight and names a repository; begin has no token and every other step has one.
	perform pg_temp.base_error($q$select pg_temp.care_step(null, 'pack')$q$, '22023', 'Code care step invalid');
	perform pg_temp.base_error($q$select pg_temp.care_step(null, null)$q$, '22023', 'Code care step invalid');
	perform pg_temp.base_error($q$select pg_temp.care_step(null, 'check')$q$, '22023', 'Code care step invalid');
	perform pg_temp.base_error(format('select pg_temp.care_step(%L, %L)', v_other, 'begin'), '22023', 'Code care step invalid');
	perform pg_temp.base_error($q$select pg_temp.care_step(null, 'begin', p_environment => null)$q$,
		'22023', 'Code care step invalid');
	perform pg_temp.base_error($q$select pg_temp.care_step(null, 'begin', p_name => null)$q$,
		'22023', 'Code care step invalid');
	-- A repository nobody registered: not due, and no run's.
	perform pg_temp.base_assert(pg_temp.care_step(null, 'begin', p_name => 'none') = v_not_due
		and pg_temp.care_step(v_other, 'check', p_name => 'none') = v_lost, 'no such repository');
	-- A session is in a turn: no run begins.
	perform pg_temp.care_phase('running');
	perform pg_temp.base_assert(pg_temp.care_step(null, 'begin') = v_busy and (pg_temp.care_shop()).care_token is null
		and (pg_temp.care_shop()).care_attempts = 0, 'busy at the start');
	perform pg_temp.care_phase('completed');
	-- Not due yet.
	update public.qorpera_code_repositories set next_care_at = clock_timestamp() + interval '1 minute' where name = 'shop';
	perform pg_temp.base_assert(pg_temp.care_step(null, 'begin') = v_not_due and (pg_temp.care_shop()).care_token is null,
		'not due yet');
	update public.qorpera_code_repositories set next_care_at = clock_timestamp() - interval '3 hours' where name = 'shop';

	-- Begin: a token and a lease of two hours, the two switches and an empty record; one start counted.
	v := pg_temp.care_step(null, 'begin');
	v_token := (v ->> 'token')::uuid;
	r := pg_temp.care_shop();
	perform pg_temp.base_assert(v - 'token' - 'leaseUntil' = jsonb_build_object('schema', 'qorpera.code-care-step/v1',
			'state', 'go', 'flags', jsonb_build_object('gc', true, 'retire', true),
			'last', jsonb_build_object('refsSha256', null, 'fsckState', null, 'fsckAt', null, 'bundleRefsSha256', null,
				'bundleName', null, 'deepAt', null))
		and v_token is not null and r.care_token = v_token and r.care_owner = 'exec-1170' and r.care_attempts = 1
		and r.care_until = (v ->> 'leaseUntil')::timestamptz
		and r.care_until between clock_timestamp() + interval '119 minutes' and clock_timestamp() + interval '2 hours',
		'begin: ' || v::text);
	-- While its lease lives the repository is not due, and no second run begins.
	perform pg_temp.base_assert(pg_temp.care_names() = 'site' and pg_temp.care_step(null, 'begin') = v_not_due
		and (pg_temp.care_shop()).care_token = v_token and (pg_temp.care_shop()).care_attempts = 1, 'a second begin');
	-- A step with the token renews the lease and starts nothing.
	update public.qorpera_code_repositories set care_until = clock_timestamp() + interval '10 minutes' where name = 'shop';
	v := pg_temp.care_step(v_token, 'check');
	r := pg_temp.care_shop();
	perform pg_temp.base_assert(v ->> 'state' = 'go' and (v ->> 'token')::uuid = v_token and not v ? 'retire'
		and r.care_token = v_token and r.care_attempts = 1 and r.care_until = (v ->> 'leaseUntil')::timestamptz
		and r.care_until > clock_timestamp() + interval '119 minutes', 'a step renews: ' || v::text);
	perform pg_temp.base_assert(pg_temp.care_step(v_token, 'fsck') ->> 'state' = 'go'
		and pg_temp.care_step(v_token, 'bundle') ->> 'state' = 'go' and pg_temp.care_step(v_token, 'gc') ->> 'state' = 'go'
		and pg_temp.care_step(v_token, 'verify') ->> 'state' = 'go'
		and pg_temp.care_step(v_token, 'retire-git') ->> 'state' = 'go', 'every step of a run');
	-- Another token, the token in another executor's hand or for another repository: lost, and the run goes on.
	perform pg_temp.base_assert(pg_temp.care_step(v_other, 'check') = v_lost
		and pg_temp.care_step(v_token, 'check', 'exec-two', repeat('6', 64)) = v_lost
		and pg_temp.care_step(v_token, 'check', p_name => 'site') = v_lost
		and (pg_temp.care_shop()).care_token = v_token, 'a wrong token is lost');

	-- A session of the company starts: the run's next step is busy, and its lease is not renewed.
	update public.qorpera_code_repositories set care_until = clock_timestamp() + interval '10 minutes' where name = 'shop';
	perform pg_temp.care_phase('preparing');
	perform pg_temp.base_assert(pg_temp.care_step(v_token, 'fsck') = v_busy
		and (pg_temp.care_shop()).care_until < clock_timestamp() + interval '11 minutes', 'busy in a run');
	perform pg_temp.care_phase('completed');
	-- No longer due there: care switched off, the company being deleted, a second executor, the executor off or on
	-- another machine.
	update public.qorpera_code_repositories set care_enabled = false where name = 'shop';
	perform pg_temp.base_assert(pg_temp.care_step(v_token, 'fsck') = v_not_due, 'care is switched off in a run');
	update public.qorpera_code_repositories set care_enabled = true where name = 'shop';
	insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
	values ('92400000-0000-4000-8000-000000000010', null);
	perform pg_temp.base_assert(pg_temp.care_step(v_token, 'fsck') = v_not_due, 'the company is being deleted in a run');
	delete from public.qorpera_company_deletions where profile_id = '92400000-0000-4000-8000-000000000010';
	update public.qorpera_coding_executors set enabled = true where owner = 'exec-two';
	perform pg_temp.base_assert(pg_temp.care_step(v_token, 'fsck') ->> 'state' = 'go', 'secondary executor does not preempt primary');
	insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256)
	values (pg_temp.care_here(), 'exec-0000', true, array['codex'], repeat('7', 64));
	perform pg_temp.base_assert(pg_temp.care_step(v_token, 'fsck') = v_not_due, 'higher-precedence primary preempts in a run');
	delete from public.qorpera_coding_executors where owner in ('exec-two', 'exec-0000');
	update public.qorpera_coding_executors set enabled = false where environment_id = pg_temp.care_here();
	perform pg_temp.base_assert(pg_temp.care_step(v_token, 'fsck') = v_not_due, 'the executor is switched off in a run');
	update public.qorpera_coding_executors set enabled = true where environment_id = pg_temp.care_here();
	perform pg_temp.base_assert(pg_temp.care_step(v_token, 'fsck', 'exec-1170', repeat('6', 64)) = v_not_due,
		'the executor on another machine');
	perform pg_temp.base_assert(pg_temp.care_step(v_token, 'fsck') ->> 'state' = 'go', 'and the run goes on');

	-- The lease ends: the token is lost, the repository is due again, and the next begin is a new run.
	perform pg_temp.care_lapse();
	perform pg_temp.base_assert(pg_temp.care_step(v_token, 'check') = v_lost and pg_temp.care_names() = 'shop,site',
		'a lease that ended is lost');
	v := pg_temp.care_step(null, 'begin');
	v_second := (v ->> 'token')::uuid;
	perform pg_temp.base_assert(v ->> 'state' = 'go' and v_second <> v_token and (pg_temp.care_shop()).care_attempts = 2
		and pg_temp.care_step(v_token, 'check') = v_lost and pg_temp.care_step(v_second, 'check') ->> 'state' = 'go',
		'a new run: ' || v::text);
	perform set_config('qorpera_test.care_token', v_second::text, true);
end $$;

-- 5. Step 'retire' ----------------------------------------------------------------------------------------------------
-- 25 sessions of company/shop archived 8 days ago, and eight that may not go: archived for 6 days, attached to a
-- machine, its worker active, a turn unsettled, not archived, another repository, a GitHub repository at the same
-- owner and name, and the same repository's name in the other company.
select pg_temp.care_archived(n) from generate_series(1, 25) n \g /dev/null
select pg_temp.care_archived(101, interval '6 days') \g /dev/null
select pg_temp.care_archived(102, p_session => jsonb_build_object('attached_machine_id', pg_temp.care_copy(901),
	'attachment_token', pg_temp.care_copy(902), 'attachment_until', clock_timestamp(), 'attachment_turn', 1,
	'attached_at', clock_timestamp())) \g /dev/null
select pg_temp.care_archived(103, p_worker => '{"state":"active","result":null}') \g /dev/null
select pg_temp.care_archived(104) \g /dev/null
insert into public.qorpera_coding_session_turns(worker_id, sequence, input_from)
values (pg_temp.care_copy(104), 1, 'dispatch');
select pg_temp.care_archived(105, p_session => '{"archived_at":null,"archived_by":null}') \g /dev/null
select pg_temp.care_archived(106, p_session => jsonb_build_object('repository', pg_temp.own_repo('company', 'other')))
\g /dev/null
select pg_temp.care_archived(107, p_session => jsonb_build_object('repository', pg_temp.own_repo() || '{"host":"github.com"}'))
\g /dev/null
select pg_temp.care_archived(108, p_session => jsonb_build_object('environment_id', pg_temp.care_there(),
	'profile_id', '91170000-0000-4000-8000-000000000010')) \g /dev/null
do $$
declare v jsonb; v_token uuid := current_setting('qorpera_test.care_token')::uuid; v_named uuid[];
	v_all uuid[] := array(select pg_temp.care_copy(n) from generate_series(1, 25) n order by n);
begin
	update public.qorpera_code_repositories set retire_enabled = false where name = 'shop';
	v := pg_temp.care_step(v_token, 'retire');
	perform pg_temp.base_assert(v ->> 'state' = 'go' and v -> 'retire' = '[]'::jsonb
		and (pg_temp.care_shop()).retire_cursor is null, 'retiring is off: ' || v::text);
	update public.qorpera_code_repositories set retire_enabled = true where name = 'shop';
	-- On: the first 20 of the 25, and the flag says so. No other step names anybody.
	v := pg_temp.care_step(v_token, 'retire');
	v_named := array(select e::uuid from jsonb_array_elements_text(v -> 'retire') e);
	perform pg_temp.base_assert(v ->> 'state' = 'go' and (v #>> '{flags,retire}')::boolean and v_named = v_all[1:20]
		and (pg_temp.care_shop()).retire_cursor = v_all[20], 'the first 20: ' || v::text);
	perform pg_temp.base_assert(not pg_temp.care_step(v_token, 'retire-git') ? 'retire'
		and not pg_temp.care_step(v_token, 'check') ? 'retire', 'only step retire names sessions');
	-- The next call goes on after the last one named, then starts again: nobody waits behind the same 20.
	v := pg_temp.care_step(v_token, 'retire');
	v_named := array(select e::uuid from jsonb_array_elements_text(v -> 'retire') e);
	perform pg_temp.base_assert(v_named = v_all[21:25] || v_all[1:15] and (pg_temp.care_shop()).retire_cursor = v_all[15],
		'the next 20: ' || v::text);
	-- A session archived for 7 days joins them; one a turn reopened leaves.
	update public.qorpera_coding_sessions set archived_at = clock_timestamp() - interval '169 hours'
	where worker_id = pg_temp.care_copy(101);
	update public.qorpera_coding_sessions set archived_at = null, archived_by = null where worker_id = v_all[16];
	v := pg_temp.care_step(v_token, 'retire');
	v_named := array(select e::uuid from jsonb_array_elements_text(v -> 'retire') e);
	perform pg_temp.base_assert(v_named = v_all[17:25] || pg_temp.care_copy(101) || v_all[1:10],
		'seven days, and a reopened session: ' || v::text);
	-- The other repository of the company has no archived session.
	update public.qorpera_code_repositories set retire_enabled = true where name = 'site';
	v := pg_temp.care_step(null, 'begin', p_name => 'site');
	v := pg_temp.care_step((v ->> 'token')::uuid, 'retire', p_name => 'site');
	perform pg_temp.base_assert(v ->> 'state' = 'go' and v -> 'retire' = '[]'::jsonb,
		'nobody in the other repository: ' || v::text);
end $$;

-- 6. Finish -----------------------------------------------------------------------------------------------------------
do $$
declare v_bad jsonb; v_token uuid := current_setting('qorpera_test.care_token')::uuid; v jsonb;
	r public.qorpera_code_repositories%rowtype; q public.qorpera_code_repositories%rowtype; v_outcome jsonb;
	v_lost jsonb := '{"schema":"qorpera.code-care-finish/v1","state":"lost"}';
	v_stored jsonb := jsonb_build_object('state', 'stored', 'name', '20261111T021455Z-aaaaaaaaaaaa.bundle',
		'sha256', repeat('c', 64), 'bytes', 12345, 'refsSha256', repeat('b', 64));
begin
	-- The outcome has exactly its keys, each of its kind.
	perform pg_temp.base_assert(public.qorpera_code_care_outcome_valid(pg_temp.care_outcome())
		and public.qorpera_code_care_outcome_valid(pg_temp.care_outcome(jsonb_build_object('state', 'failed',
			'problem', 'FSCK_PROBLEMS:2', 'mainSha', null, 'refsSha256', null, 'repaired', null, 'deep', true,
			'fsck', jsonb_build_object('state', 'problems', 'detail', repeat('å', 2000)), 'bundle', v_stored,
			'gc', '{"state":"damaged"}'::jsonb, 'worktrees', 12, 'retired', 20))), 'two outcomes that are valid');
	foreach v_bad in array array[
		'null'::jsonb, '[]'::jsonb, '"done"'::jsonb,
		pg_temp.care_outcome() - 'problem', pg_temp.care_outcome() - 'worktrees', pg_temp.care_outcome() - 'gc',
		pg_temp.care_outcome('{"extra":1}'),
		pg_temp.care_outcome('{"schema":"qorpera.code-care-outcome/v2"}'),
		pg_temp.care_outcome('{"state":"ok"}'), pg_temp.care_outcome('{"state":null}'),
		pg_temp.care_outcome('{"problem":"fsck problems"}'), pg_temp.care_outcome('{"problem":""}'),
		pg_temp.care_outcome('{"problem":7}'), pg_temp.care_outcome(jsonb_build_object('problem', repeat('P', 121))),
		pg_temp.care_outcome(jsonb_build_object('mainSha', repeat('a', 39))),
		pg_temp.care_outcome(jsonb_build_object('mainSha', repeat('A', 40))),
		pg_temp.care_outcome(jsonb_build_object('refsSha256', repeat('b', 40))),
		pg_temp.care_outcome('{"repaired":"all"}'), pg_temp.care_outcome('{"deep":null}'),
		pg_temp.care_outcome('{"deep":"true"}'),
		pg_temp.care_outcome('{"fsck":"ok"}'), pg_temp.care_outcome('{"fsck":{"state":"ok"}}'),
		pg_temp.care_outcome('{"fsck":{"state":"ok","detail":null,"exitCode":0}}'),
		pg_temp.care_outcome('{"fsck":{"state":"clean","detail":null}}'),
		pg_temp.care_outcome('{"fsck":{"state":"problems","detail":7}}'),
		pg_temp.care_outcome(jsonb_build_object('fsck', jsonb_build_object('state', 'problems', 'detail', repeat('d', 2001)))),
		pg_temp.care_outcome('{"bundle":{"state":"skipped"}}'),
		pg_temp.care_outcome(jsonb_build_object('bundle', v_stored || '{"gitVersion":"2.56.0"}')),
		pg_temp.care_outcome(jsonb_build_object('bundle', v_stored || '{"state":"kept"}')),
		pg_temp.care_outcome(jsonb_build_object('bundle', v_stored || '{"name":null}')),
		pg_temp.care_outcome(jsonb_build_object('bundle', v_stored || '{"name":"a/b.bundle"}')),
		pg_temp.care_outcome(jsonb_build_object('bundle', v_stored || '{"sha256":null}')),
		pg_temp.care_outcome(jsonb_build_object('bundle', v_stored || '{"sha256":"cc"}')),
		pg_temp.care_outcome(jsonb_build_object('bundle', v_stored || '{"bytes":null}')),
		pg_temp.care_outcome(jsonb_build_object('bundle', v_stored || '{"bytes":-1}')),
		pg_temp.care_outcome(jsonb_build_object('bundle', v_stored || '{"bytes":1.5}')),
		pg_temp.care_outcome(jsonb_build_object('bundle', v_stored || '{"bytes":"12345"}')),
		pg_temp.care_outcome(jsonb_build_object('bundle', v_stored || '{"refsSha256":null}')),
		pg_temp.care_outcome('{"gc":{}}'), pg_temp.care_outcome('{"gc":{"state":"packed"}}'),
		pg_temp.care_outcome('{"gc":{"state":"held","held":2}}'),
		pg_temp.care_outcome('{"worktrees":-1}'), pg_temp.care_outcome('{"worktrees":"3"}'),
		pg_temp.care_outcome('{"retired":null}'), pg_temp.care_outcome('{"retired":-1}'),
		pg_temp.care_outcome('{"retired":10000}')] loop
		perform pg_temp.base_assert(not public.qorpera_code_care_outcome_valid(v_bad), 'no outcome: ' || v_bad::text);
		perform pg_temp.base_error(format('select pg_temp.care_finish(%L, %L)', v_token, v_bad),
			'22023', 'Code care outcome invalid');
	end loop;
	perform pg_temp.base_assert(not public.qorpera_code_care_outcome_valid(null), 'no outcome at all');
	perform pg_temp.base_error(format('select pg_temp.care_finish(%L, null)', v_token), '22023', 'Code care outcome invalid');
	perform pg_temp.base_error(format('select pg_temp.care_finish(%L, %L, p_name => null)', v_token, pg_temp.care_outcome()),
		'22023', 'Code care outcome invalid');

	-- No token, another token, another executor's hand, another machine, a repository nobody registered: lost, and
	-- nothing written.
	r := pg_temp.care_shop();
	perform pg_temp.base_assert(pg_temp.care_finish('91200000-0000-4000-8000-0000000000aa', pg_temp.care_outcome()) = v_lost
		and pg_temp.care_finish(null, pg_temp.care_outcome()) = v_lost
		and pg_temp.care_finish(v_token, pg_temp.care_outcome(), 'exec-other', repeat('6', 64)) = v_lost
		and pg_temp.care_finish(v_token, pg_temp.care_outcome(), 'exec-1170', repeat('6', 64)) = v_lost
		and pg_temp.care_finish(v_token, pg_temp.care_outcome(), p_name => 'none') = v_lost
		and to_jsonb(pg_temp.care_shop()) = to_jsonb(r), 'a wrong token is lost');
	-- The executor switched off, or the lease ended: lost too.
	update public.qorpera_coding_executors set enabled = false where environment_id = pg_temp.care_here();
	perform pg_temp.base_assert(pg_temp.care_finish(v_token, pg_temp.care_outcome()) = v_lost
		and to_jsonb(pg_temp.care_shop()) = to_jsonb(r), 'the executor is switched off');
	update public.qorpera_coding_executors set enabled = true where environment_id = pg_temp.care_here();
	perform pg_temp.care_lapse();
	r := pg_temp.care_shop();
	perform pg_temp.base_assert(pg_temp.care_finish(v_token, pg_temp.care_outcome()) = v_lost
		and to_jsonb(pg_temp.care_shop()) = to_jsonb(r), 'the lease ended');

	-- A run in which every part did its work: each part's columns, no problem, the lease ended and the starts at none.
	update public.qorpera_code_repositories set gc_enabled = true where name = 'shop';
	v_token := pg_temp.care_begin();
	v_outcome := pg_temp.care_outcome(jsonb_build_object('repaired', 'head', 'deep', true,
		'fsck', '{"state":"ok","detail":null}'::jsonb, 'bundle', v_stored, 'gc', '{"state":"collected"}'::jsonb,
		'worktrees', 3, 'retired', 2));
	v := pg_temp.care_finish(v_token, v_outcome);
	r := pg_temp.care_shop();
	perform pg_temp.base_assert(v - 'nextCareAt' = '{"schema":"qorpera.code-care-finish/v1","state":"recorded"}'
		and (v ->> 'nextCareAt')::timestamptz = r.next_care_at
		and r.next_care_at = public.qorpera_code_care_next_at('company', 'shop', false, r.last_care_at)
		and r.care_token is null and r.care_owner is null and r.care_until is null and r.care_attempts = 0
		and r.last_care_at between clock_timestamp() - interval '1 minute' and clock_timestamp()
		and r.last_ok_at = r.last_care_at and r.deep_at = r.last_care_at and r.problem is null and r.problem_since is null
		and r.main_sha = repeat('a', 40) and r.refs_sha256 = repeat('b', 64) and r.fsck_state = 'ok'
		and r.fsck_at = r.last_care_at and r.bundle_at = r.last_care_at
		and r.bundle_name = '20261111T021455Z-aaaaaaaaaaaa.bundle' and r.bundle_sha256 = repeat('c', 64)
		and r.bundle_bytes = 12345 and r.bundle_refs_sha256 = repeat('b', 64) and r.gc_at = r.last_care_at
		and r.gc_enabled and r.worktrees = 3 and r.retired = 2 and r.outcome = v_outcome,
		'a whole run: ' || to_jsonb(r)::text);
	-- Its token is no run's any more, and with no run there is none to finish.
	perform pg_temp.base_assert(pg_temp.care_finish(v_token, v_outcome) = v_lost
		and pg_temp.care_finish(null, v_outcome) = v_lost and to_jsonb(pg_temp.care_shop()) = to_jsonb(r)
		and pg_temp.care_step(v_token, 'check') ->> 'state' = 'lost', 'a finished run''s token');

	-- The next run starts from that record. Every part skipped or with nothing new: its columns stay; main and the
	-- retired count move; refs no fsck passed are not recorded.
	v_token := pg_temp.care_begin();
	v := pg_temp.care_step(v_token, 'check');
	perform pg_temp.base_assert(v -> 'last' = jsonb_build_object('refsSha256', repeat('b', 64), 'fsckState', 'ok',
			'fsckAt', r.fsck_at, 'bundleRefsSha256', repeat('b', 64), 'bundleName', '20261111T021455Z-aaaaaaaaaaaa.bundle',
			'deepAt', r.deep_at)
		and v -> 'flags' = '{"gc":true,"retire":true}', 'the last record: ' || v::text);
	v_outcome := pg_temp.care_outcome(jsonb_build_object('mainSha', repeat('d', 40), 'refsSha256', repeat('e', 64),
		'bundle', pg_temp.care_no_bundle('unchanged'), 'gc', '{"state":"held"}'::jsonb, 'retired', 1));
	perform pg_temp.care_finish(v_token, v_outcome);
	q := pg_temp.care_shop();
	perform pg_temp.base_assert(q.last_care_at > r.last_care_at and q.last_ok_at = q.last_care_at
		and q.main_sha = repeat('d', 40) and q.retired = 3 and q.outcome = v_outcome and q.refs_sha256 = r.refs_sha256
		and (q.deep_at, q.fsck_state, q.fsck_at, q.bundle_at, q.bundle_name, q.bundle_sha256, q.bundle_bytes,
			q.bundle_refs_sha256, q.gc_at, q.gc_enabled, q.worktrees)
			is not distinct from (r.deep_at, r.fsck_state, r.fsck_at, r.bundle_at, r.bundle_name, r.bundle_sha256,
			r.bundle_bytes, r.bundle_refs_sha256, r.gc_at, r.gc_enabled, r.worktrees),
		'skipped parts leave their columns: ' || to_jsonb(q)::text);

	-- A failed run: fsck found problems on new refs, and no bundle was made. The fsck is recorded, the refs it did not
	-- pass are not, the bundle's and main's columns stay, and the problem is there since now; it was no good run.
	v_token := pg_temp.care_begin();
	perform pg_temp.care_finish(v_token, pg_temp.care_outcome(jsonb_build_object('state', 'failed',
		'problem', 'FSCK_PROBLEMS', 'mainSha', null, 'refsSha256', repeat('e', 64),
		'fsck', jsonb_build_object('state', 'problems', 'detail', 'missing blob 1234'),
		'bundle', pg_temp.care_no_bundle('failed'))));
	r := pg_temp.care_shop();
	perform pg_temp.base_assert(r.problem = 'FSCK_PROBLEMS' and r.problem_since = r.last_care_at
		and r.last_ok_at = q.last_ok_at and r.fsck_state = 'problems' and r.fsck_at = r.last_care_at
		and r.refs_sha256 = repeat('b', 64) and r.main_sha = repeat('d', 40) and r.bundle_at = q.bundle_at
		and r.bundle_name = q.bundle_name
		and r.next_care_at = public.qorpera_code_care_next_at('company', 'shop', false, r.last_care_at)
		and r.outcome #>> '{fsck,detail}' = 'missing blob 1234', 'a failed run: ' || to_jsonb(r)::text);
	-- The same problem the next night keeps the time it was first seen; a timeout is recorded as one, and a bundle too
	-- large leaves the bundle's columns.
	update public.qorpera_code_repositories set problem_since = clock_timestamp() - interval '1 day' where name = 'shop';
	q := pg_temp.care_shop();
	v_token := pg_temp.care_begin();
	perform pg_temp.care_finish(v_token, pg_temp.care_outcome(jsonb_build_object('state', 'failed',
		'problem', 'FSCK_PROBLEMS', 'fsck', '{"state":"timeout","detail":null}'::jsonb,
		'bundle', pg_temp.care_no_bundle('too-large'))));
	r := pg_temp.care_shop();
	perform pg_temp.base_assert(r.problem = 'FSCK_PROBLEMS' and r.problem_since = q.problem_since
		and r.fsck_state = 'timeout' and r.fsck_at = r.last_care_at and r.refs_sha256 = repeat('b', 64)
		and r.bundle_at = q.bundle_at and r.last_ok_at = q.last_ok_at, 'the same problem: ' || to_jsonb(r)::text);
	-- Another problem is there since now, also on a run that is done.
	v_token := pg_temp.care_begin();
	perform pg_temp.care_finish(v_token, pg_temp.care_outcome('{"problem":"BUNDLE_FAILED"}'));
	r := pg_temp.care_shop();
	perform pg_temp.base_assert(r.problem = 'BUNDLE_FAILED' and r.problem_since = r.last_care_at
		and r.last_ok_at = q.last_ok_at, 'another problem: ' || to_jsonb(r)::text);
	-- A pack the check after it found damaged switches packing off.
	v_token := pg_temp.care_begin();
	perform pg_temp.care_finish(v_token,
		pg_temp.care_outcome('{"state":"failed","problem":"GC_DAMAGED","gc":{"state":"damaged"}}'));
	r := pg_temp.care_shop();
	perform pg_temp.base_assert(r.problem = 'GC_DAMAGED' and not r.gc_enabled and r.gc_at = q.gc_at,
		'a damaged pack: ' || to_jsonb(r)::text);
	v_token := pg_temp.care_begin();
	perform pg_temp.base_assert(pg_temp.care_step(v_token, 'gc') -> 'flags' = '{"gc":false,"retire":true}', 'no more packing');
	-- A run put off as busy: 30 minutes on while that is before 05:00 UTC, else the next night (7 has both at fixed
	-- instants). Its problem is the outcome's, like any run's.
	perform pg_temp.care_finish(v_token, pg_temp.care_outcome('{"state":"busy","problem":"GC_DAMAGED"}'));
	r := pg_temp.care_shop();
	perform pg_temp.base_assert(r.next_care_at = public.qorpera_code_care_next_at('company', 'shop', true, r.last_care_at)
		and (r.next_care_at = r.last_care_at + interval '30 minutes'
			or r.next_care_at = public.qorpera_code_care_next_at('company', 'shop', false, r.last_care_at))
		and r.problem = 'GC_DAMAGED' and r.problem_since < r.last_care_at and r.last_ok_at = q.last_ok_at
		and r.care_token is null and r.care_attempts = 0, 'a busy run: ' || to_jsonb(r)::text);
	-- A busy run that names no problem looked at too little to clear one: last night's stays, with its time.
	q := r;
	v_token := pg_temp.care_begin();
	perform pg_temp.care_finish(v_token, pg_temp.care_outcome('{"state":"busy"}'));
	r := pg_temp.care_shop();
	perform pg_temp.base_assert(r.problem = 'GC_DAMAGED' and r.problem_since = q.problem_since
		and r.last_ok_at is not distinct from q.last_ok_at and r.care_token is null,
		'a busy run with no problem: ' || to_jsonb(r)::text);
	-- No problem: the problem and its time go, and the run was a good one. Packing stays off.
	v_token := pg_temp.care_begin();
	perform pg_temp.care_finish(v_token, pg_temp.care_outcome());
	r := pg_temp.care_shop();
	perform pg_temp.base_assert(r.problem is null and r.problem_since is null and r.last_ok_at = r.last_care_at
		and not r.gc_enabled, 'the problem is gone: ' || to_jsonb(r)::text);
end $$;

-- 7. The next care's time ---------------------------------------------------------------------------------------------
create function pg_temp.care_next(p_now timestamptz, p_busy boolean default false, p_owner text default 'company',
	p_name text default 'shop') returns timestamptz language sql as $$
	select public.qorpera_code_care_next_at(p_owner, p_name, p_busy, p_now)
$$;
do $$
declare v_night timestamptz := pg_temp.care_next('2026-11-11 02:00:00+00');
	v_spread interval := v_night - timestamptz '2026-11-12 01:00:00+00';
begin
	-- The next night: tomorrow between 01:00 and 04:00 UTC, at the second the owner and name pick, whenever today.
	perform pg_temp.base_assert(v_spread >= interval '0' and v_spread < interval '3 hours',
		'the night''s time: ' || v_night::text);
	perform pg_temp.base_assert(pg_temp.care_next('2026-11-11 00:00:00+00') = v_night
		and pg_temp.care_next('2026-11-11 04:59:59+00') = v_night and pg_temp.care_next('2026-11-11 14:00:00+00') = v_night
		and pg_temp.care_next('2026-11-11 23:59:59+00') = v_night
		and pg_temp.care_next('2026-11-11 01:30:00+02') = v_night - interval '1 day', 'tomorrow, by the UTC day');
	perform pg_temp.base_assert(pg_temp.care_next('2026-11-11 02:00:00+00', p_name => 'site') <> v_night
		and pg_temp.care_next('2026-11-11 02:00:00+00', p_owner => 'other') <> v_night, 'another owner or name, another time');
	-- Put off as busy: 30 minutes on, until 05:00 UTC, then the next night.
	perform pg_temp.base_assert(pg_temp.care_next('2026-11-11 02:00:00+00', true) = timestamptz '2026-11-11 02:30:00+00'
		and pg_temp.care_next('2026-11-11 04:29:59+00', true) = timestamptz '2026-11-11 04:59:59+00'
		and pg_temp.care_next('2026-11-11 04:30:00+00', true) = v_night
		and pg_temp.care_next('2026-11-11 14:00:00+00', true) = v_night
		and pg_temp.care_next('2026-11-11 23:29:59+00', true) = v_night
		and pg_temp.care_next('2026-11-11 23:50:00+00', true) = timestamptz '2026-11-12 00:20:00+00',
		'30 minutes on until 05:00 UTC');
end $$;

-- 8. Three starts and no finish ---------------------------------------------------------------------------------------
do $$
declare v_token uuid; r public.qorpera_code_repositories%rowtype; q public.qorpera_code_repositories%rowtype; i integer;
	v_not_due jsonb := '{"schema":"qorpera.code-care-step/v1","state":"not-due"}';
begin
	-- Three runs begin and none finishes: each lease ends.
	for i in 1..3 loop
		v_token := pg_temp.care_begin();
		perform pg_temp.care_lapse();
	end loop;
	q := pg_temp.care_shop();
	perform pg_temp.base_assert(q.care_attempts = 3 and q.problem is null and pg_temp.care_names() = 'shop',
		'three starts: ' || to_jsonb(q)::text);
	-- No fourth: the repository says so and waits for the next night, with the starts at none again.
	perform pg_temp.base_assert(pg_temp.care_step(null, 'begin') = v_not_due, 'no fourth start');
	r := pg_temp.care_shop();
	perform pg_temp.base_assert(r.problem = 'CARE_DID_NOT_FINISH'
		and r.problem_since between clock_timestamp() - interval '1 minute' and clock_timestamp()
		and r.next_care_at = public.qorpera_code_care_next_at('company', 'shop', false, r.problem_since)
		and r.care_token is null and r.care_owner is null and r.care_until is null and r.care_attempts = 0
		and r.last_care_at = q.last_care_at and r.outcome = q.outcome, 'care did not finish: ' || to_jsonb(r)::text);
	perform pg_temp.base_assert(pg_temp.care_step(null, 'begin') = v_not_due
		and to_jsonb(pg_temp.care_shop()) = to_jsonb(r) and pg_temp.care_names() = '', 'it waits for the next night');
	-- The same again the next night keeps the time it was first seen.
	for i in 1..3 loop
		v_token := pg_temp.care_begin();
		perform pg_temp.care_lapse();
	end loop;
	perform pg_temp.base_assert(pg_temp.care_step(null, 'begin') = v_not_due
		and (pg_temp.care_shop()).problem = 'CARE_DID_NOT_FINISH' and (pg_temp.care_shop()).problem_since = r.problem_since
		and (pg_temp.care_shop()).care_attempts = 0, 'the same problem again');
	-- A run that finishes clears it, and the starts count from none.
	v_token := pg_temp.care_begin();
	perform pg_temp.base_assert((pg_temp.care_shop()).care_attempts = 1, 'one start');
	perform pg_temp.care_finish(v_token, pg_temp.care_outcome());
	r := pg_temp.care_shop();
	perform pg_temp.base_assert(r.problem is null and r.problem_since is null and r.care_attempts = 0,
		'a finished run clears it');
end $$;
