-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- C5 (20260930508000): the company's memory choice in Settings, Agent notebooks (the default) or Shared context — Beta,
-- and the mode every run is recorded in. Members read the choice, what runs use now, whether the beta is offered and how
-- many runs still work in the other mode; owners and admins choose. Shared context is chosen only while the operator's
-- test list offers it, and runs use it only while both hold. A new run gets the company's effective mode from its row's
-- trigger, notebooks when the lookup fails, and keeps it: a change of choice applies to new runs only, and a run's mode
-- never changes. Test 924's run of Alice's (leased) was made with notebooks; posts in Bob's and Carol's threads make the
-- new runs.

create function pg_temp.mm_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; v_claims text := current_setting('request.jwt.claims', true);
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	execute p_sql into v;
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return v;
end
$$;
-- The company's memory as a member reads it.
create function pg_temp.mm_read(p_user uuid default '92400000-0000-4000-8000-000000000001') returns jsonb language sql as $$
	select pg_temp.mm_call(p_user, 'select public.qorpera_company_memory_mode(''92400000-0000-4000-8000-000000000010'')')
$$;
-- A member's choice.
create function pg_temp.mm_set(p_user uuid, p_mode text) returns jsonb language sql as $$
	select pg_temp.mm_call(p_user, format('select public.qorpera_set_company_memory_mode(%L, %L)',
		'92400000-0000-4000-8000-000000000010', p_mode))
$$;
-- A post in an agent's thread, made into a run by the next pass; answers the run.
create function pg_temp.mm_run(p_staff uuid) returns public.qorpera_execution_runs language plpgsql as $$
declare v_pass jsonb; v_run public.qorpera_execution_runs;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', p_staff, 'Look at the numbers.');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'the run: ' || v_pass::text);
	select * into strict v_run from public.qorpera_execution_runs where id = (v_pass -> 'run_ids' ->> 0)::uuid;
	return v_run;
end
$$;
create function pg_temp.mm_mode(p_run uuid) returns text language sql as $$
	select memory_mode from public.qorpera_execution_runs where id = p_run
$$;
create function pg_temp.mm_alice() returns uuid language sql as $$
	select (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
$$;

-- 1. Members read and owners and admins set, through the two calls alone; the choice, the effective mode, the offer and
--    the trigger are no one else's. The run's mode is a nullable column with no default (no table rewrite), checked.
do $$
declare v_role text; v_name text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		foreach v_name in array array['public.qorpera_company_memory_mode(uuid)', 'public.qorpera_set_company_memory_mode(uuid,text)'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_name, 'EXECUTE') = (v_role = 'authenticated'),
				format('%s for %s', v_name, v_role));
		end loop;
		foreach v_name in array array['public.qorpera_company_memory_mode_effective(uuid)',
			'public.qorpera_company_memory_beta_offered(uuid)', 'public.qorpera_pin_execution_memory_mode()'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_name, 'EXECUTE'), format('%s is open to %s', v_name, v_role));
		end loop;
		perform pg_temp.base_assert(not has_table_privilege(v_role, 'public.qorpera_company_memory_modes',
			'SELECT, INSERT, UPDATE, DELETE'), 'the choice is open to ' || v_role);
	end loop;
	perform pg_temp.base_assert((select relrowsecurity from pg_class where oid = 'public.qorpera_company_memory_modes'::regclass),
		'the choice has row security');
	perform pg_temp.base_assert((select not a.attnotnull and not a.atthasdef from pg_attribute a
		where a.attrelid = 'public.qorpera_execution_runs'::regclass and a.attname = 'memory_mode'), 'the run''s mode is nullable, no default');
	perform pg_temp.base_assert(exists (select 1 from pg_trigger where tgrelid = 'public.qorpera_execution_runs'::regclass
		and tgname = 'qorpera_execution_run_memory_mode' and tgenabled = 'O'
		and tgfoid = 'public.qorpera_pin_execution_memory_mode()'::regprocedure), 'the run row''s trigger pins the mode');
	-- A resume queues the same job again for the same run row, which keeps its mode.
	perform pg_temp.base_assert(strpos((select prosrc from pg_proc
		where oid = 'public.qorpera_resume_run_from_log(uuid,text,boolean)'::regprocedure), 'insert into public.qorpera_execution_runs') = 0,
		'a resume makes no new run');
end
$$;

-- 2. The default: Agent notebooks, never set, not offered, nothing in another mode. Every member reads it; owners and
--    admins may change it. Outsiders and calls with no user read nothing.
do $$
declare v jsonb := pg_temp.mm_read(); v_user uuid;
begin
	perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.company-memory-mode/v1',
		'profileId', '92400000-0000-4000-8000-000000000010', 'mode', 'notebooks', 'setAt', null, 'effective', 'notebooks',
		'betaOffered', false, 'canManage', true, 'runsInOtherMode', 0), 'the default: ' || v::text);
	foreach v_user in array array['92400000-0000-4000-8000-000000000002', '92400000-0000-4000-8000-000000000003',
		'92400000-0000-4000-8000-000000000004']::uuid[] loop
		v := pg_temp.mm_read(v_user);
		perform pg_temp.base_assert(v ->> 'mode' = 'notebooks' and v ->> 'effective' = 'notebooks'
			and (v ->> 'canManage')::boolean = (v_user = '92400000-0000-4000-8000-000000000004'), 'a member reads it: ' || v::text);
	end loop;
	perform pg_temp.base_error($q$select pg_temp.mm_read('92400000-0000-4000-8000-000000000005')$q$, '42501',
		'Only members of this company can read its memory');
	perform pg_temp.base_error($q$select pg_temp.mm_call(null, 'select public.qorpera_company_memory_mode(''92400000-0000-4000-8000-000000000010'')')$q$,
		'42501', 'authentication required');
	perform pg_temp.base_claims('service_role');
end
$$;

-- 3. Alice's run was made with notebooks, and a run's mode never changes, not even to no mode.
do $$
begin
	perform pg_temp.base_assert(pg_temp.mm_mode(pg_temp.mm_alice()) = 'notebooks', 'Alice''s run: '
		|| coalesce(pg_temp.mm_mode(pg_temp.mm_alice()), 'no mode'));
	perform pg_temp.base_error(format('update public.qorpera_execution_runs set memory_mode = %L where id = %L', 'tree', pg_temp.mm_alice()),
		'42501', 'Execution memory mode is immutable');
	perform pg_temp.base_error(format('update public.qorpera_execution_runs set memory_mode = null where id = %L', pg_temp.mm_alice()),
		'42501', 'Execution memory mode is immutable');
	update public.qorpera_execution_runs set memory_mode = 'notebooks' where id = pg_temp.mm_alice();
	perform pg_temp.base_assert(pg_temp.mm_mode(pg_temp.mm_alice()) = 'notebooks', 'the same mode again changes nothing');
end
$$;

-- 4. Contributors, viewers and outsiders don't choose; a mode is notebooks or tree; Shared context only while offered.
--    Notebooks can always be chosen.
do $$
declare v jsonb;
begin
	perform pg_temp.base_error($q$select pg_temp.mm_set('92400000-0000-4000-8000-000000000002', 'notebooks')$q$, '42501',
		'Only owners and admins change the company''s memory');
	perform pg_temp.base_error($q$select pg_temp.mm_set('92400000-0000-4000-8000-000000000003', 'notebooks')$q$, '42501',
		'Only owners and admins change the company''s memory');
	perform pg_temp.base_error($q$select pg_temp.mm_set('92400000-0000-4000-8000-000000000005', 'notebooks')$q$, '42501',
		'Only members of this company can change its memory');
	perform pg_temp.base_error($q$select pg_temp.mm_set(null, 'notebooks')$q$, '42501', 'authentication required');
	perform pg_temp.base_error($q$select pg_temp.mm_set('92400000-0000-4000-8000-000000000001', 'x')$q$, '22023', 'Memory mode is invalid');
	perform pg_temp.base_error($q$select pg_temp.mm_set('92400000-0000-4000-8000-000000000001', null)$q$, '22023', 'Memory mode is invalid');
	perform pg_temp.base_error($q$select pg_temp.mm_set('92400000-0000-4000-8000-000000000001', 'tree')$q$, '55000',
		'Shared context is not available for this company yet');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_memory_modes
		where profile_id = '92400000-0000-4000-8000-000000000010'), 'a refused choice leaves none');
	v := pg_temp.mm_set('92400000-0000-4000-8000-000000000001', 'notebooks');
	perform pg_temp.base_assert(v ->> 'mode' = 'notebooks' and v ->> 'setAt' is not null and v ->> 'effective' = 'notebooks',
		'notebooks is chosen: ' || v::text);
	perform pg_temp.base_claims('service_role');
end
$$;

-- 5. The test list alone offers the beta and turns nothing on; an admin's choice of it does, for new runs: Alice's run,
--    leased, goes on with notebooks, the one run in the other mode. The same choice again changes nothing.
do $$
declare v jsonb; v_set jsonb;
begin
	insert into public.qorpera_memory_tree_companies(profile_id) values ('92400000-0000-4000-8000-000000000010');
	v := pg_temp.mm_read();
	perform pg_temp.base_assert(v ->> 'mode' = 'notebooks' and v ->> 'effective' = 'notebooks' and (v ->> 'betaOffered')::boolean
		and (v ->> 'runsInOtherMode')::integer = 0, 'the list offers the beta: ' || v::text);
	v_set := pg_temp.mm_set('92400000-0000-4000-8000-000000000004', 'tree');
	perform pg_temp.base_assert(v_set ->> 'mode' = 'tree' and v_set ->> 'effective' = 'tree' and (v_set ->> 'runsInOtherMode')::integer = 1
		and v_set ->> 'setAt' is distinct from v ->> 'setAt', 'the admin chose Shared context: ' || v_set::text);
	perform pg_temp.base_assert(pg_temp.mm_mode(pg_temp.mm_alice()) = 'notebooks', 'Alice''s run keeps notebooks');
	v := pg_temp.mm_set('92400000-0000-4000-8000-000000000001', 'tree');
	perform pg_temp.base_assert(v = v_set, 'the same choice again: ' || v::text);
	perform pg_temp.base_claims('service_role');
end
$$;

-- 6. A run made while the lookup fails is recorded with notebooks, never the beta. The broken lookup lasts this block alone
--    (its error undoes it, and the run).
do $$
begin
	begin
		create or replace function public.qorpera_company_memory_mode_effective(p_profile_id uuid)
		returns text language plpgsql stable security definer set search_path = '' as $f$
		begin raise exception 'the lookup fails'; end $f$;
		perform pg_temp.base_assert((pg_temp.mm_run('92400000-0000-4000-8000-000000000032')).memory_mode = 'notebooks',
			'a failed lookup records notebooks');
		raise exception 'undo the lookup' using errcode = 'QG686';
	exception when sqlstate 'QG686' then null;
	end;
	perform pg_temp.base_assert(public.qorpera_company_memory_mode_effective('92400000-0000-4000-8000-000000000010') = 'tree',
		'the lookup is back');
end
$$;

-- 7. Bob's new run is recorded in the beta. Back to notebooks: Bob's run keeps the beta (the one run in the other mode),
--    Carol's new run has notebooks.
do $$
declare v_bob public.qorpera_execution_runs := pg_temp.mm_run('92400000-0000-4000-8000-000000000031');
	v_carol public.qorpera_execution_runs; v jsonb;
begin
	perform set_config('qorpera_test.mm_bob', v_bob.id::text, true);
	perform pg_temp.base_assert(v_bob.memory_mode = 'tree' and pg_temp.mm_mode(pg_temp.mm_alice()) = 'notebooks',
		'Bob''s run is in the beta, Alice''s is not: ' || coalesce(v_bob.memory_mode, 'no mode'));
	perform pg_temp.base_assert((pg_temp.mm_read() ->> 'runsInOtherMode')::integer = 1, 'Alice''s run is the one in the other mode');
	v := pg_temp.mm_set('92400000-0000-4000-8000-000000000001', 'notebooks');
	perform pg_temp.base_assert(v ->> 'mode' = 'notebooks' and v ->> 'effective' = 'notebooks' and (v ->> 'runsInOtherMode')::integer = 1,
		'back to notebooks, Bob''s run finishes in the beta: ' || v::text);
	perform pg_temp.base_assert(pg_temp.mm_mode(v_bob.id) = 'tree', 'Bob''s run keeps the beta');
	v_carol := pg_temp.mm_run('92400000-0000-4000-8000-000000000032');
	perform set_config('qorpera_test.mm_carol', v_carol.id::text, true);
	perform pg_temp.base_assert(v_carol.memory_mode = 'notebooks', 'Carol''s new run has notebooks');
	perform pg_temp.base_assert((pg_temp.mm_read() ->> 'runsInOtherMode')::integer = 1, 'still Bob''s run alone');
	perform pg_temp.base_claims('service_role');
end
$$;

-- 8. Shared context chosen while the company leaves the test list: runs use notebooks, and the beta can't be chosen
--    again until it is offered again. Back on the list, runs use the beta at once.
do $$
declare v jsonb;
begin
	perform pg_temp.mm_set('92400000-0000-4000-8000-000000000001', 'tree');
	delete from public.qorpera_memory_tree_companies where profile_id = '92400000-0000-4000-8000-000000000010';
	v := pg_temp.mm_read();
	perform pg_temp.base_assert(v ->> 'mode' = 'tree' and v ->> 'effective' = 'notebooks' and not (v ->> 'betaOffered')::boolean
		and (v ->> 'runsInOtherMode')::integer = 1, 'off the list: ' || v::text);
	perform pg_temp.base_error($q$select pg_temp.mm_set('92400000-0000-4000-8000-000000000004', 'tree')$q$, '55000',
		'Shared context is not available for this company yet');
	insert into public.qorpera_memory_tree_companies(profile_id) values ('92400000-0000-4000-8000-000000000010');
	v := pg_temp.mm_read();
	perform pg_temp.base_assert(v ->> 'effective' = 'tree' and (v ->> 'runsInOtherMode')::integer = 2,
		'back on the list, Alice''s and Carol''s runs are in the other mode: ' || v::text);
	perform pg_temp.base_assert(pg_temp.mm_mode(current_setting('qorpera_test.mm_bob')::uuid) = 'tree'
		and pg_temp.mm_mode(current_setting('qorpera_test.mm_carol')::uuid) = 'notebooks', 'no run changed its mode');
	perform pg_temp.base_claims('service_role');
end
$$;
