-- @fixture 1170_own_code_repositories.test.sql until "-- 4. The completion"
-- The change record of the repositories kept in Qorpera (migration 20260930720000): the rows, the executor's record
-- call, the record files' three calls, the backfill and the existing rules it changed. 1170's fixture: the company's own
-- repository company/shop with Alice's sessions b1 (queued) and b2 (cancelled) on it, the company enrolled with
-- exec-1170; and another company exec-1170 serves. 1211 (the requests) runs after this file's helpers.
--   1. Rights: no API role reads or writes the two tables; each call is its caller's alone; the purge reaches both.
--   2. A real turn, twice: the submit call with notice and picture, each bad shape and a replay, the landing recorded
--      and the completion's sentence; then a turn that sends neither and is not recorded: stored and told as before.
--   3. The record call: the report's shape, who may record, and every line of its table.
--   4. Numbers have no gaps after an insert that was rolled back.
--   5. The record files: due, what they say, written, a diff filling a row, the pause after a problem.
--   6. The backfill, twice, and once more after a new landing.
--   7. The folder's rules for changes/, downloads/, restoring.json and code/_set-aside/, and a member's refs.

-- This company's environment, and its repositories' rows.
create function pg_temp.rec_here() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000020'::uuid
$$;
create function pg_temp.rec_shop(p_name text default 'shop') returns public.qorpera_code_repositories language sql as $$
	select * from public.qorpera_code_repositories
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = p_name
$$;
create function pg_temp.rec_row(p_n integer, p_name text default 'shop') returns public.qorpera_code_changes language sql as $$
	select * from public.qorpera_code_changes
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = p_name and n = p_n
$$;
-- A commit's name, from a word; no word is no commit.
create function pg_temp.rec_sha(p_word text) returns text language sql immutable as $$
	select encode(extensions.digest(p_word, 'sha1'), 'hex')
$$;
-- Whether row p_n is of that kind and state, and moved main from one commit to the other.
create function pg_temp.rec_is(p_n integer, p_kind text, p_state text, p_before text, p_after text, p_name text default 'shop')
returns boolean language sql as $$
	select coalesce((select c.kind = p_kind and c.state = p_state
			and c.main_before is not distinct from pg_temp.rec_sha(p_before)
			and c.main_after is not distinct from pg_temp.rec_sha(p_after) from pg_temp.rec_row(p_n, p_name) c), false)
$$;
-- The id of the n-th copy of a session, and the lease token every copy's turn is held with.
create function pg_temp.rec_copy(p_n integer) returns uuid language sql immutable as $$
	select format('91210000-0000-4000-8000-%s', lpad(p_n::text, 12, '0'))::uuid
$$;
create function pg_temp.rec_token() returns uuid language sql immutable as $$
	select '91210000-0000-4000-8000-0000000000aa'::uuid
$$;
-- The n-th copy of the cancelled session b2 and its worker, under a new id, in turn p_sequence: leased to exec-1170,
-- handing in, with the turn's submission of commit p_head (and the submission's keys given changed).
create function pg_temp.rec_turn(p_n integer, p_sequence integer, p_head text, p_submission jsonb default '{}',
	p_repository jsonb default pg_temp.own_repo()) returns uuid language plpgsql as $$
declare v_id uuid := pg_temp.rec_copy(p_n);
begin
	perform set_config('session_replication_role', 'replica', true);
	if not exists (select 1 from public.qorpera_runtime_workers where id = v_id) then
		insert into public.qorpera_runtime_workers
		select (jsonb_populate_record(null::public.qorpera_runtime_workers, to_jsonb(w) || jsonb_build_object('id', v_id,
			'worker_key', 'rec-' || p_n, 'title', 'Session ' || p_n, 'state', 'active', 'result', null,
			'folder_path', 'QorperaOS/agents/alice/todos/fix-login/rec-' || p_n,
			'folder_key', 'qorperaos/agents/alice/todos/fix-login/rec-' || p_n))).*
		from public.qorpera_runtime_workers w where w.id = '91170000-0000-4000-8000-0000000000b2';
		insert into public.qorpera_coding_sessions
		select (jsonb_populate_record(null::public.qorpera_coding_sessions, to_jsonb(s) || jsonb_build_object('worker_id', v_id,
			'branch', 'qorpera/coding/' || v_id::text, 'repository', p_repository, 'base_sha', pg_temp.rec_sha('base')))).*
		from public.qorpera_coding_sessions s where s.worker_id = '91170000-0000-4000-8000-0000000000b2';
	end if;
	update public.qorpera_runtime_workers set sequence = p_sequence, state = 'active', result = null where id = v_id;
	update public.qorpera_coding_sessions set phase = 'publishing', lease_owner = 'exec-1170', lease_token = pg_temp.rec_token(),
		lease_until = clock_timestamp() + interval '10 minutes' where worker_id = v_id;
	insert into public.qorpera_coding_session_turns(worker_id, sequence, input_from, input_text, submission,
		submission_receipt_id, submitted_at)
	values (v_id, p_sequence, case when p_sequence = 1 then 'dispatch' else 'agent' end,
		case when p_sequence > 1 then 'Go on.' end,
		jsonb_build_object('schema', 'qorpera.coding-submission/v1', 'workerId', v_id, 'sequence', p_sequence, 'kind', 'finish',
			'state', 'submitted', 'summary', format('Summary of session %s, turn %s.', p_n, p_sequence), 'headSha', p_head,
			'question', null, 'options', '[]'::jsonb, 'operationKey', format('rec-%s-%s', p_n, p_sequence)) || p_submission,
		extensions.gen_random_uuid(), clock_timestamp());
	perform set_config('session_replication_role', 'origin', true);
	return v_id;
end $$;
-- A landing's report, with the keys given changed.
create function pg_temp.rec_report(p_state text, p_head text, p_before text, p_after text, p_change jsonb default '{}')
returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.code-change-report/v1', 'state', p_state, 'inLine', true,
		'how', case when p_state = 'landed' then 'fast-forward' end, 'headSha', p_head, 'mainBefore', p_before,
		'mainAfter', p_after, 'filesChanged', case when p_state = 'landed' then 2 end,
		'paths', case when p_state = 'landed'
			then '[{"path":"src/a.ts","change":"changed"},{"path":"src/b.ts","change":"added"}]'::jsonb end,
		'pathsMore', 0, 'picture', null, 'refusal', case when p_state in ('conflict','refused')
			then '{"code":"CODE_HOST_LAND_CONFLICT","paths":["src/a.ts"]}'::jsonb end) || p_change
$$;
-- The record call as the executor makes it: the service role, with its claims.
create function pg_temp.rec_record(p_worker uuid, p_report jsonb, p_token uuid default pg_temp.rec_token())
returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_record_code_change(p_worker, p_token, p_report);
	reset role;
	return v;
end $$;
-- What the record call answers.
create function pg_temp.rec_answer(p_state text, p_change integer) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-change-recorded/v1', 'state', p_state, 'change', p_change)
$$;
-- Session copy p_n hands in commit p_after and reports that it landed on main, which was at p_before: a fast-forward.
create function pg_temp.rec_land(p_n integer, p_before text, p_after text, p_in_line boolean default true,
	p_sequence integer default 1, p_submission jsonb default '{}', p_report jsonb default '{}', p_name text default 'shop')
returns jsonb language sql as $$
	select pg_temp.rec_record(pg_temp.rec_turn(p_n, p_sequence, pg_temp.rec_sha(p_after), p_submission,
			pg_temp.own_repo('company', p_name)),
		pg_temp.rec_report('landed', pg_temp.rec_sha(p_after), pg_temp.rec_sha(p_before), pg_temp.rec_sha(p_after),
			jsonb_build_object('inLine', p_in_line) || p_report))
$$;
-- Session copy p_n hands in commit p_head and reports that main, now at p_now, already held it since p_at.
create function pg_temp.rec_unchanged(p_n integer, p_head text, p_now text, p_at text) returns jsonb language sql as $$
	select pg_temp.rec_record(pg_temp.rec_turn(p_n, 1, pg_temp.rec_sha(p_head)),
		pg_temp.rec_report('unchanged', pg_temp.rec_sha(p_head), pg_temp.rec_sha(p_now), pg_temp.rec_sha(p_at)))
$$;
-- The record files' three calls as the executor makes them.
create function pg_temp.rec_due(p_owner text default 'exec-1170', p_machine text default repeat('5', 64),
	p_limit integer default 50) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_change_files_due(p_owner, p_machine, p_limit);
	reset role;
	return v;
end $$;
create function pg_temp.rec_files(p_limit integer default 20, p_name text default 'shop', p_owner text default 'exec-1170',
	p_machine text default repeat('5', 64), p_environment uuid default pg_temp.rec_here()) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_change_files(p_owner, p_machine, p_environment, 'company', p_name, p_limit);
	reset role;
	return v;
end $$;
create function pg_temp.rec_written(p_written jsonb, p_name text default 'shop', p_owner text default 'exec-1170',
	p_machine text default repeat('5', 64)) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_change_files_written(p_owner, p_machine, pg_temp.rec_here(), 'company', p_name, p_written);
	reset role;
	return v;
end $$;
-- What a job says it wrote: these rows at these versions, the list at that version, and a problem or none.
create function pg_temp.rec_wrote(p_changes jsonb default '[]', p_index bigint default null, p_problem text default null)
returns jsonb language sql immutable as $$
	select jsonb_build_object('changes', p_changes, 'indexVersion', p_index, 'problem', p_problem)
$$;
-- The names due now, in the order due gives them.
create function pg_temp.rec_due_names(p_owner text default 'exec-1170', p_machine text default repeat('5', 64),
	p_limit integer default 50) returns text language sql as $$
	select coalesce(string_agg(due.repository ->> 'name', ',' order by due.n), '')
	from jsonb_array_elements(pg_temp.rec_due(p_owner, p_machine, p_limit) -> 'repositories') with ordinality due(repository, n)
$$;

-- The checks start here: a test that runs after this file's fixture part stops at this line.

-- 1. Rights -----------------------------------------------------------------------------------------------------------
do $$
declare v_role text; v_function text; v_table text;
begin
	foreach v_table in array array['public.qorpera_code_changes', 'public.qorpera_code_requests'] loop
		perform pg_temp.base_assert((select relrowsecurity from pg_class where oid = v_table::regclass),
			'row level security is on: ' || v_table);
		-- The company's purge takes both with the company (their profile's key, and the registry row's), and nothing
		-- stops its delete.
		perform pg_temp.base_assert((select count(*) from pg_constraint
			where conrelid = v_table::regclass and contype = 'f' and confdeltype = 'c'
				and confrelid in ('public.qorpera_profiles'::regclass, 'public.qorpera_code_repositories'::regclass)) = 2
			and not exists (select 1 from pg_trigger where tgrelid = v_table::regclass and not tgisinternal),
			v_table || ' goes with its company');
	end loop;
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_table in array array['public.qorpera_code_changes', 'public.qorpera_code_requests'] loop
			perform pg_temp.base_assert(not has_table_privilege(v_role, v_table,
				'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), v_table || ' is closed to ' || v_role);
		end loop;
		-- What the calls share, the operator's call and the backfill: no role's.
		foreach v_function in array array['public.qorpera_code_executor_custody(text,text)',
			'public.qorpera_code_json_text(jsonb,text)', 'public.qorpera_code_json_count(jsonb)',
			'public.qorpera_code_json_strings(jsonb,integer)', 'public.qorpera_code_notice_valid(text)',
			'public.qorpera_code_change_paths_valid(jsonb)', 'public.qorpera_code_change_fit(jsonb,integer,integer)',
			'public.qorpera_code_change_append(uuid,text,text,jsonb)', 'public.qorpera_code_change_found(uuid,text,text,text,text)',
			'public.qorpera_code_change_set(uuid,text,text,integer,boolean,integer)',
			'public.qorpera_code_changes_restored(uuid,text,text,text)',
			'public.qorpera_code_undo_message(integer,text,boolean)', 'public.qorpera_code_request_lease(text)',
			'public.qorpera_code_restore_waits(uuid,text,text,timestamptz)', 'public.qorpera_code_restore_holds(jsonb)',
			'public.qorpera_code_change_report_valid(jsonb)',
			'public.qorpera_code_change_files_written_valid(jsonb)', 'public.qorpera_code_request_outcome_valid(text,jsonb)',
			'public.qorpera_code_agent_run(jsonb)', 'public.qorpera_code_download_view(public.qorpera_code_requests,timestamptz)',
			'public.qorpera_request_code_restore(uuid,text,text,text,text,text,text)',
			'public.qorpera_code_changes_backfill()'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_function, 'EXECUTE'),
				v_function || ' is closed to ' || v_role);
		end loop;
		-- The executor's and the agent's calls: the service role's only. The member's: role authenticated's only.
		foreach v_function in array array['public.qorpera_record_code_change(uuid,uuid,jsonb)',
			'public.qorpera_code_change_files_due(text,text,integer)',
			'public.qorpera_code_change_files(text,text,uuid,text,text,integer)',
			'public.qorpera_code_change_files_written(text,text,uuid,text,text,jsonb)',
			'public.qorpera_code_requests_claim(text,text,integer)',
			'public.qorpera_code_request_step(text,text,uuid,uuid,jsonb)',
			'public.qorpera_code_restore_record(text,text,uuid,uuid,jsonb)',
			'public.qorpera_code_request_finish(text,text,uuid,uuid,jsonb)',
			'public.qorpera_folder_request_code_undo(jsonb,jsonb)', 'public.qorpera_folder_code_request(jsonb,uuid)',
			'public.qorpera_folder_describe_code_change(jsonb,jsonb)'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_function, 'EXECUTE') = (v_role = 'service_role'),
				v_function || ' is the service role''s only: ' || v_role);
		end loop;
		foreach v_function in array array['public.qorpera_list_code_repositories(uuid)',
			'public.qorpera_request_code_download(uuid,text,text,text)', 'public.qorpera_code_download(uuid,uuid)'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_function, 'EXECUTE') = (v_role = 'authenticated'),
				v_function || ' is a member''s only: ' || v_role);
		end loop;
	end loop;
	-- Every call an API role makes is a definer with an empty search path.
	perform pg_temp.base_assert(not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
		and proname in ('qorpera_record_code_change', 'qorpera_code_change_files_due', 'qorpera_code_change_files',
			'qorpera_code_change_files_written', 'qorpera_code_requests_claim', 'qorpera_code_request_step',
			'qorpera_code_restore_record', 'qorpera_code_changes_restored',
			'qorpera_code_request_finish', 'qorpera_folder_request_code_undo', 'qorpera_folder_code_request',
			'qorpera_folder_describe_code_change', 'qorpera_list_code_repositories', 'qorpera_request_code_download',
			'qorpera_code_download', 'qorpera_request_code_restore', 'qorpera_code_changes_backfill')
		and not (prosecdef and proconfig = array['search_path=""'])), 'definers with an empty search path');
	-- The native host may call the agent's three, with the binding's scope.
	perform pg_temp.base_assert((select count(*) from public.qorpera_native_host_calls where scope = 'binding'
		and budget = 'standard' and name in ('qorpera_folder_request_code_undo', 'qorpera_folder_code_request',
			'qorpera_folder_describe_code_change')) = 3, 'the native host''s list');
	-- The registry starts a repository with no change, no main and nothing to write.
	perform pg_temp.base_assert((select r.last_change = 0 and r.last_main is null and r.index_version = 0
		and r.index_written = 0 and r.files_attempts = 0 and r.files_not_before is null and r.files_problem is null
		and r.restored_at is null and r.restored_from is null from pg_temp.rec_shop() r), 'the registry''s nine columns');
end $$;
-- The service role itself reads and writes neither table, and no API role runs the operator's call or the backfill.
set local role service_role;
select pg_temp.base_error('select count(*) from public.qorpera_code_changes', '42501') \g /dev/null
select pg_temp.base_error('select count(*) from public.qorpera_code_requests', '42501') \g /dev/null
select pg_temp.base_error('update public.qorpera_code_changes set state = ''landed''', '42501') \g /dev/null
select pg_temp.base_error('select public.qorpera_code_changes_backfill()', '42501',
	'permission denied for function qorpera_code_changes_backfill') \g /dev/null
reset role;
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		perform pg_temp.base_claims(v_role);
		execute format('set local role %I', v_role);
		perform pg_temp.base_error($q$select public.qorpera_request_code_restore(pg_temp.rec_here(), 'company', 'shop', 'restore',
			'fresh', 'keep', 'A drill.')$q$, '42501', 'permission denied for function qorpera_request_code_restore');
		reset role;
	end loop;
	-- Without the service role's claims nobody records a landing, whatever role runs the call.
	foreach v_role in array array['anon', 'authenticated'] loop
		perform pg_temp.base_claims(v_role);
		perform pg_temp.base_error(format('select public.qorpera_record_code_change(%L, %L, %L)', pg_temp.rec_copy(1),
			pg_temp.rec_token(), pg_temp.rec_report('conflict', pg_temp.rec_sha('h1'), null, null)),
			'42501', 'Coding executor authority required');
		perform pg_temp.base_error($q$select public.qorpera_code_change_files_due('exec-1170', repeat('5', 64), 50)$q$,
			'42501', 'Coding machine custody required');
		perform pg_temp.base_error($q$select public.qorpera_code_requests_claim('exec-1170', repeat('5', 64), 5)$q$,
			'42501', 'Coding machine custody required');
	end loop;
	perform pg_temp.base_claims('service_role');
end $$;

-- 2. A real turn, twice -----------------------------------------------------------------------------------------------
-- A second session on company/shop waits behind b1.
do $$
declare v_result jsonb;
begin
	v_result := pg_temp.c3_dispatch(pg_temp.c3_alice(), 'rec-dispatch-5', 'QorperaOS/agents/alice/todos/fix-login/shop-5',
		pg_temp.own_brief('91210000-0000-4000-8000-0000000000b5'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the second session: ' || v_result::text);
end $$;
set local session_replication_role = replica;
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values ('91210000-0000-4000-8000-0000000000d1', 'member', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-1170', repeat('7', 64), '{}');
set local session_replication_role = origin;
do $$
declare v_claim jsonb; v_pass jsonb; v_turn jsonb; v_token uuid; v_finish jsonb; v_sent jsonb; v_bad jsonb; v jsonb;
	v_landed jsonb; b1 uuid := '91170000-0000-4000-8000-0000000000b1'; b5 uuid := '91210000-0000-4000-8000-0000000000b5';
	w public.qorpera_runtime_workers%rowtype; s public.qorpera_coding_sessions%rowtype; r public.qorpera_code_changes%rowtype;
	v_def text := pg_get_functiondef('public.qorpera_submit_coding_turn(jsonb,jsonb)'::regprocedure);
begin
	perform pg_temp.base_assert(strpos(v_def, '20260930720000') > 0 and strpos(pg_get_functiondef(
		'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure),
		'20260930720000') > 0 and strpos(pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure),
		$q$/* 20260930720000 */'manage_code',$q$) > 0, 'the changed bodies carry the marker');
	-- The turn as 928 runs one: claimed, begun, its run started, its machine ready.
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-1170', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = b1::text, 'the claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session(b1)).lease_token;
	perform public.qorpera_begin_coding_turn(b1, v_token, '{}');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'the turn''s run: ' || v_pass::text);
	v_turn := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	update public.qorpera_coding_sessions set vm_allocation_id = '91210000-0000-4000-8000-0000000000d2' where worker_id = b1;
	perform public.qorpera_authorize_coding_turn(v_turn);
	v_finish := jsonb_build_object('kind', 'finish', 'operationKey', 'rec-finish-1', 'summary', 'The shop has a cart.',
		'headSha', pg_temp.rec_sha('c1'));
	-- The two new keys, each bad shape: a notice that is no text, empty, too long or more than a line; a picture that is
	-- no text, too long, no picture's name, an absolute path, a path that climbs, or one with a part git would not keep.
	foreach v_bad in array array['{"notice":7}'::jsonb, '{"notice":null}', '{"notice":""}',
		jsonb_build_object('notice', repeat('n', 201)), jsonb_build_object('notice', E'One line.\nAnother.'),
		jsonb_build_object('notice', E'A\ttab.'), jsonb_build_object('notice', E'A return.\r'),
		'{"picture":7}', '{"picture":null}', '{"picture":""}', '{"picture":"docs/changes/cart.gif"}',
		'{"picture":"docs/changes/cart"}', '{"picture":"/company/code/company/shop/docs/cart.png"}',
		'{"picture":"docs/../cart.png"}', '{"picture":"./cart.png"}', '{"picture":"docs//cart.png"}',
		'{"picture":"docs/ cart.png"}', '{"picture":"docs/c:art.png"}', '{"picture":"docs\\cart.png"}',
		jsonb_build_object('picture', repeat('d', 297) || '.png'), '{"note":"Something else."}'] loop
		perform pg_temp.base_error(format('select public.qorpera_submit_coding_turn(%L, %L)', v_turn, v_finish || v_bad),
			'22023', 'Coding submission invalid');
	end loop;
	-- A question carries neither.
	perform pg_temp.base_error(format('select public.qorpera_submit_coding_turn(%L, %L)', v_turn, jsonb_build_object('kind', 'ask',
		'operationKey', 'rec-ask-1', 'summary', 'Stuck.', 'question', 'Which colour?', 'notice', 'A new colour.')),
		'22023', 'Coding submission invalid');
	perform pg_temp.base_assert((select turn.submission is null from public.qorpera_coding_session_turns turn
		where turn.worker_id = b1 and turn.sequence = 1), 'nothing was submitted');
	-- With both: 200 characters of two bytes each are a notice, and a picture's path may hold spaces and upper case.
	v_finish := v_finish || jsonb_build_object('notice', repeat('å', 200), 'picture', 'docs/changes/The cart 2.PNG');
	v_sent := public.qorpera_submit_coding_turn(v_turn, v_finish);
	perform pg_temp.base_assert(v_sent = jsonb_build_object('schema', 'qorpera.coding-submission/v1', 'workerId', b1,
			'sequence', 1, 'kind', 'finish', 'state', 'submitted', 'summary', 'The shop has a cart.',
			'headSha', pg_temp.rec_sha('c1'), 'question', null, 'options', '[]'::jsonb, 'operationKey', 'rec-finish-1',
			'notice', repeat('å', 200), 'picture', 'docs/changes/The cart 2.PNG')
		and (select turn.submission = v_sent from public.qorpera_coding_session_turns turn
			where turn.worker_id = b1 and turn.sequence = 1), 'the submission with both: ' || v_sent::text);
	-- A replay answers the same; another notice, or none, is another submission.
	perform pg_temp.base_assert(public.qorpera_submit_coding_turn(v_turn, v_finish) = v_sent, 'a replay');
	perform pg_temp.base_error(format('select public.qorpera_submit_coding_turn(%L, %L)', v_turn,
		v_finish || '{"notice":"Something else."}'), '23505', 'Coding submission replay differs');
	perform pg_temp.base_error(format('select public.qorpera_submit_coding_turn(%L, %L)', v_turn, v_finish - 'picture'),
		'23505', 'Coding submission replay differs');

	-- The executor hands the commit in and records the landing inside its job: the repository's first row. Its words
	-- are the kernel's own, and the picture the job checked is the record's from now on.
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_record_coding_progress(b1, v_token, 'publishing', 'Landing the change');
	v := pg_temp.rec_record(b1, pg_temp.rec_report('landed', pg_temp.rec_sha('c1'), pg_temp.rec_sha('c0'), pg_temp.rec_sha('c1'),
		jsonb_build_object('picture', jsonb_build_object('state', 'ok', 'blob', pg_temp.rec_sha('blob'), 'bytes', 4321,
			'type', 'png'))), v_token);
	r := pg_temp.rec_row(1);
	w := pg_temp.c3_worker(b1);
	perform pg_temp.base_assert(v = pg_temp.rec_answer('recorded', 1) and pg_temp.rec_is(1, 'landing', 'landed', 'c0', 'c1')
		and r.profile_id = '92400000-0000-4000-8000-000000000010' and r.how = 'fast-forward' and r.head_sha = pg_temp.rec_sha('c1')
		and r.worker_id = b1 and r.sequence = 1 and r.staff_agent_id = '92400000-0000-4000-8000-000000000030'
		and r.owner_user_id is not distinct from w.owner_user_id and r.request_id is null and r.title = 'Fix the login page'
		and r.summary = 'The shop has a cart.' and r.notice = repeat('å', 200)
		and r.picture = jsonb_build_object('source', 'commit', 'path', 'docs/changes/The cart 2.PNG',
			'blob', pg_temp.rec_sha('blob'), 'bytes', 4321, 'type', 'png', 'at', 'code/company/shop/changes/1.png')
		and r.picture_problem is null and r.files_changed = 2 and jsonb_array_length(r.paths) = 2 and r.paths_more = 0
		and r.refusal is null and r.undoes is null and r.reverted_by is null and r.restored_from is null
		and r.created_at between clock_timestamp() - interval '1 minute' and clock_timestamp()
		and r.file_version = 1 and r.file_written = 0, 'the first row: ' || to_jsonb(r)::text);
	perform pg_temp.base_assert((select q.last_change = 1 and q.last_main = pg_temp.rec_sha('c1') and q.index_version = 1
		and q.index_written = 0 from pg_temp.rec_shop() q), 'the registry after the first row');
	-- The same report once more, made after the job: the turn has its row.
	perform pg_temp.base_assert(pg_temp.rec_record(b1, pg_temp.rec_report('landed', pg_temp.rec_sha('c1'), pg_temp.rec_sha('c0'),
		pg_temp.rec_sha('c1'), '{"inLine":false}'), v_token) = pg_temp.rec_answer('replayed', 1)
		and (pg_temp.rec_shop()).last_change = 1, 'a replay of the report');

	-- The completion: the platform's line ends with the change's number and where its record is, and the card gets the
	-- landing's own count of files.
	v_landed := jsonb_build_object('kind', 'landed', 'state', 'fast-forward', 'branch', 'main',
		'headSha', pg_temp.rec_sha('c1'), 'mainSha', pg_temp.rec_sha('c1'));
	perform public.qorpera_complete_coding_turn(b1, v_token, 'succeeded', 'The shop has a cart.', null, null, null,
		jsonb_build_array(v_landed), null, 2);
	w := pg_temp.c3_worker(b1); s := pg_temp.c3_session(b1);
	perform pg_temp.base_assert(w.state = 'succeeded' and s.phase = 'completed' and s.files_changed = 2
		and w.result -> 'landed' = v_landed
		and w.result ->> 'summary' = E'The shop has a cart.\n\nQorpera landed this commit on main: main is at '
			|| left(pg_temp.rec_sha('c1'), 12) || ', and the files are in the company folder at code/company/shop/main/. '
			|| 'It is change 1 of this repository; its record is code/company/shop/changes/1.md.',
		'the recorded landing''s line: ' || coalesce(w.result ->> 'summary', 'none'));

	-- The second session's turn sends neither key: its submission is stored with the keys it always had.
	v_claim := public.qorpera_claim_coding_session('exec-1170', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = b5::text, 'the second claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session(b5)).lease_token;
	perform public.qorpera_begin_coding_turn(b5, v_token, '{}');
	v_pass := pg_temp.base_materialize();
	v_turn := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	update public.qorpera_coding_sessions set vm_allocation_id = '91210000-0000-4000-8000-0000000000d3' where worker_id = b5;
	perform public.qorpera_authorize_coding_turn(v_turn);
	v_sent := public.qorpera_submit_coding_turn(v_turn, jsonb_build_object('kind', 'finish', 'operationKey', 'rec-finish-5',
		'summary', 'Nothing more to do.', 'headSha', pg_temp.rec_sha('c1')));
	perform pg_temp.base_assert(v_sent = jsonb_build_object('schema', 'qorpera.coding-submission/v1', 'workerId', b5,
		'sequence', 1, 'kind', 'finish', 'state', 'submitted', 'summary', 'Nothing more to do.',
		'headSha', pg_temp.rec_sha('c1'), 'question', null, 'options', '[]'::jsonb, 'operationKey', 'rec-finish-5'),
		'the submission with neither: ' || v_sent::text);
	-- Its landing is not recorded (an executor of before this step): the line is the one of before, with no sentence.
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_coding_turn(b5, v_token, 'succeeded', 'Nothing more to do.', null, null, null,
		jsonb_build_array(v_landed || '{"state":"unchanged"}'));
	w := pg_temp.c3_worker(b5);
	perform pg_temp.base_assert(w.state = 'succeeded' and w.result ->> 'summary' = E'Nothing more to do.\n\nQorpera landed '
		|| 'this commit on main, which already held it: main is at ' || left(pg_temp.rec_sha('c1'), 12)
		|| ', and the files are in the company folder at code/company/shop/main/.',
		'a landing with no row: ' || coalesce(w.result ->> 'summary', 'none'));
	perform pg_temp.base_assert((pg_temp.rec_shop()).last_change = 1, 'still one row');
end $$;

-- 3. The record call --------------------------------------------------------------------------------------------------
do $$
declare v jsonb; v_bad jsonb; w uuid; r public.qorpera_code_changes%rowtype; q public.qorpera_code_repositories%rowtype;
	h text := pg_temp.rec_sha('h1'); a text := pg_temp.rec_sha('ca'); b text := pg_temp.rec_sha('cb');
	v_ok jsonb := jsonb_build_object('state', 'ok', 'blob', pg_temp.rec_sha('blob'), 'bytes', 10, 'type', 'jpeg');
	v_refusal jsonb := '{"code":"CODE_HOST_LAND_CONFLICT","paths":["src/a.ts"]}';
begin
	-- The report has exactly its keys, each of its kind, and what its state asks for.
	perform pg_temp.base_assert(public.qorpera_code_change_report_valid(pg_temp.rec_report('landed', h, b, a))
		and public.qorpera_code_change_report_valid(pg_temp.rec_report('landed', h, b, a, jsonb_build_object('how', 'merged',
			'inLine', false, 'filesChanged', null, 'paths', null, 'pathsMore', 7, 'picture', v_ok)))
		and public.qorpera_code_change_report_valid(pg_temp.rec_report('landed', h, b, a, '{"picture":{"state":"not_a_file"}}'))
		and public.qorpera_code_change_report_valid(pg_temp.rec_report('unchanged', h, a, a))
		and public.qorpera_code_change_report_valid(pg_temp.rec_report('conflict', h, null, null))
		and public.qorpera_code_change_report_valid(pg_temp.rec_report('refused', h, null, null,
			'{"refusal":{"code":"CODE_HOST_NAMES_DIFFER_BY_CASE","paths":[]}}')), 'reports that are valid');
	w := pg_temp.rec_turn(1, 1, h);
	foreach v_bad in array array['null'::jsonb, '[]', '"landed"',
		pg_temp.rec_report('landed', h, b, a) - 'picture', pg_temp.rec_report('landed', h, b, a) - 'pathsMore',
		pg_temp.rec_report('landed', h, b, a) - 'refusal', pg_temp.rec_report('landed', h, b, a, '{"extra":1}'),
		pg_temp.rec_report('landed', h, b, a, '{"schema":"qorpera.code-change-report/v2"}'),
		pg_temp.rec_report('landed', h, b, a, '{"state":"merged"}'), pg_temp.rec_report('landed', h, b, a, '{"state":null}'),
		pg_temp.rec_report('landed', h, b, a, '{"inLine":"true"}'), pg_temp.rec_report('landed', h, b, a, '{"inLine":null}'),
		pg_temp.rec_report('landed', h, b, a, '{"how":null}'), pg_temp.rec_report('landed', h, b, a, '{"how":"rebased"}'),
		pg_temp.rec_report('landed', h, null, a), pg_temp.rec_report('landed', h, b, null),
		pg_temp.rec_report('landed', h, b, left(a, 39)), pg_temp.rec_report('landed', h, upper(b), a),
		pg_temp.rec_report('landed', h, b, a, jsonb_build_object('mainAfter', 1111111111)),
		pg_temp.rec_report('landed', h, b, a, jsonb_build_object('refusal', v_refusal)),
		pg_temp.rec_report('landed', null, b, a), pg_temp.rec_report('landed', left(h, 12), b, a),
		pg_temp.rec_report('unchanged', h, a, a, '{"how":"fast-forward"}'), pg_temp.rec_report('unchanged', h, a, null),
		pg_temp.rec_report('unchanged', h, a, a, jsonb_build_object('refusal', v_refusal)),
		pg_temp.rec_report('conflict', h, b, null), pg_temp.rec_report('conflict', h, null, a),
		pg_temp.rec_report('conflict', h, null, null, '{"how":"merged"}'),
		pg_temp.rec_report('conflict', h, null, null, '{"refusal":null}'),
		pg_temp.rec_report('conflict', h, null, null, '{"refusal":"CODE_HOST_LAND_CONFLICT"}'),
		pg_temp.rec_report('conflict', h, null, null, '{"refusal":{"code":"CODE_HOST_LAND_CONFLICT"}}'),
		pg_temp.rec_report('conflict', h, null, null, '{"refusal":{"code":"CODE_HOST_LAND_CONFLICT","paths":[],"more":1}}'),
		pg_temp.rec_report('conflict', h, null, null, '{"refusal":{"code":"a conflict","paths":[]}}'),
		pg_temp.rec_report('conflict', h, null, null, '{"refusal":{"code":null,"paths":[]}}'),
		pg_temp.rec_report('conflict', h, null, null, '{"refusal":{"code":"CODE_HOST_LAND_CONFLICT","paths":null}}'),
		pg_temp.rec_report('conflict', h, null, null, '{"refusal":{"code":"CODE_HOST_LAND_CONFLICT","paths":[7]}}'),
		pg_temp.rec_report('conflict', h, null, null, jsonb_build_object('refusal', jsonb_build_object(
			'code', 'CODE_HOST_LAND_CONFLICT', 'paths', (select jsonb_agg('p' || i) from generate_series(1, 21) i)))),
		pg_temp.rec_report('landed', h, b, a, '{"filesChanged":-1}'), pg_temp.rec_report('landed', h, b, a, '{"filesChanged":1.5}'),
		pg_temp.rec_report('landed', h, b, a, '{"filesChanged":"2"}'),
		pg_temp.rec_report('landed', h, b, a, '{"paths":"src/a.ts"}'), pg_temp.rec_report('landed', h, b, a, '{"paths":["src/a.ts"]}'),
		pg_temp.rec_report('landed', h, b, a, '{"paths":[{"path":"src/a.ts"}]}'),
		pg_temp.rec_report('landed', h, b, a, '{"paths":[{"path":"src/a.ts","change":"renamed"}]}'),
		pg_temp.rec_report('landed', h, b, a, '{"paths":[{"path":"","change":"added"}]}'),
		pg_temp.rec_report('landed', h, b, a, '{"paths":[{"path":7,"change":"added"}]}'),
		pg_temp.rec_report('landed', h, b, a, '{"paths":[{"path":"src/a.ts","change":"added","from":"b"}]}'),
		pg_temp.rec_report('landed', h, b, a, '{"pathsMore":null}'), pg_temp.rec_report('landed', h, b, a, '{"pathsMore":-1}'),
		pg_temp.rec_report('landed', h, b, a, '{"picture":"ok"}'), pg_temp.rec_report('landed', h, b, a, '{"picture":{}}'),
		pg_temp.rec_report('landed', h, b, a, '{"picture":{"state":"ok"}}'),
		pg_temp.rec_report('landed', h, b, a, jsonb_build_object('picture', v_ok || '{"path":"docs/a.png"}')),
		pg_temp.rec_report('landed', h, b, a, jsonb_build_object('picture', v_ok || '{"type":"gif"}')),
		pg_temp.rec_report('landed', h, b, a, jsonb_build_object('picture', v_ok || '{"bytes":-1}')),
		pg_temp.rec_report('landed', h, b, a, jsonb_build_object('picture', v_ok || '{"blob":"abc"}')),
		pg_temp.rec_report('landed', h, b, a, '{"picture":{"state":"gone"}}'),
		pg_temp.rec_report('landed', h, b, a, '{"picture":{"state":"not_shared"}}'),
		pg_temp.rec_report('landed', h, b, a, '{"picture":{"state":"missing","blob":null}}')] loop
		perform pg_temp.base_assert(not public.qorpera_code_change_report_valid(v_bad), 'no report: ' || v_bad::text);
		perform pg_temp.base_error(format('select pg_temp.rec_record(%L, %L)', w, v_bad), '22023', 'Code change report invalid');
	end loop;
	perform pg_temp.base_assert(not public.qorpera_code_change_report_valid(null), 'no report at all');
	perform pg_temp.base_error(format('select pg_temp.rec_record(%L, null)', w), '22023', 'Code change report invalid');
	-- The report is of the commit the turn handed in, in a repository kept in Qorpera, from the executor that holds the
	-- turn's lease.
	perform pg_temp.base_error(format('select pg_temp.rec_record(%L, %L)', w, pg_temp.rec_report('conflict', a, null, null)),
		'22023', 'Code change report invalid');
	perform pg_temp.base_error(format('select pg_temp.rec_record(%L, %L)', pg_temp.rec_turn(90, 1, h, '{}', pg_temp.c3_repo()),
		pg_temp.rec_report('conflict', h, null, null)), '22023', 'Code change report invalid');
	perform pg_temp.base_error(format('select pg_temp.rec_record(%L, %L, %L)', w, pg_temp.rec_report('conflict', h, null, null),
		pg_temp.rec_copy(999)), '42501', 'Coding session lease unavailable');
	perform pg_temp.base_error(format('select pg_temp.rec_record(%L, %L)', pg_temp.rec_copy(998),
		pg_temp.rec_report('conflict', h, null, null)), '42501', 'Coding session lease unavailable');
	perform pg_temp.base_error(format('select pg_temp.rec_record(%L, %L, %L)', '91170000-0000-4000-8000-0000000000b1',
		pg_temp.rec_report('unchanged', pg_temp.rec_sha('c1'), pg_temp.rec_sha('c1'), pg_temp.rec_sha('c1')), pg_temp.rec_token()),
		'42501', 'Coding session lease unavailable');
	update public.qorpera_coding_sessions set lease_until = clock_timestamp() - interval '1 second' where worker_id = w;
	perform pg_temp.base_error(format('select pg_temp.rec_record(%L, %L)', w, pg_temp.rec_report('conflict', h, null, null)),
		'42501', 'Coding session lease unavailable');
	perform pg_temp.base_assert((pg_temp.rec_shop()).last_change = 1, 'none of them wrote a row');

	-- Its table, line by line. Main is at c1, and row 1 says so.
	-- A conflict is a row with no main: the record's main stays.
	w := pg_temp.rec_turn(1, 2, h, '{"picture":"docs/changes/a.png"}');
	v := pg_temp.rec_record(w, pg_temp.rec_report('conflict', h, null, null, '{"inLine":false}'));
	r := pg_temp.rec_row(2); q := pg_temp.rec_shop();
	perform pg_temp.base_assert(v = pg_temp.rec_answer('recorded', 2) and pg_temp.rec_is(2, 'landing', 'conflict', null, null)
		and r.refusal = v_refusal and r.how is null and r.head_sha = h and r.worker_id = w and r.sequence = 2
		and r.title = 'Session 1' and r.summary = 'Summary of session 1, turn 2.' and r.notice is null and r.picture is null
		and r.picture_problem is null and r.files_changed is null and r.paths is null
		and q.last_change = 2 and q.last_main = pg_temp.rec_sha('c1') and q.index_version = 2, 'a conflict: ' || to_jsonb(r)::text);
	-- Any report of a turn that has its row: replayed.
	perform pg_temp.base_assert(pg_temp.rec_record(w, pg_temp.rec_report('conflict', h, null, null)) = pg_temp.rec_answer('replayed', 2)
		and pg_temp.rec_record(w, pg_temp.rec_report('landed', h, pg_temp.rec_sha('c1'), h)) = pg_temp.rec_answer('replayed', 2)
		and (pg_temp.rec_shop()).last_change = 2, 'replayed');
	-- In line, main where the record has it: one row. A picture the job found good is the row's, a .jpg for a JPEG.
	v := pg_temp.rec_land(2, 'c1', 'c2', p_submission => '{"notice":"Each price says free returns.","picture":"docs/changes/free returns.JPG"}',
		p_report => jsonb_build_object('how', 'merged', 'picture', v_ok));
	r := pg_temp.rec_row(3);
	perform pg_temp.base_assert(v = pg_temp.rec_answer('recorded', 3) and pg_temp.rec_is(3, 'landing', 'landed', 'c1', 'c2')
		and r.how = 'merged' and r.notice = 'Each price says free returns.' and r.title = 'Session 2'
		and r.picture = jsonb_build_object('source', 'commit', 'path', 'docs/changes/free returns.JPG',
			'blob', pg_temp.rec_sha('blob'), 'bytes', 10, 'type', 'jpeg', 'at', 'code/company/shop/changes/3.jpg')
		and (pg_temp.rec_shop()).last_main = pg_temp.rec_sha('c2'), 'in line, main as recorded: ' || to_jsonb(r)::text);
	-- In line, main somewhere else: a filler for the gap first. A picture the job found wanting is named as that.
	v := pg_temp.rec_land(3, 'c3', 'c4', p_submission => '{"picture":"docs/changes/b.png"}',
		p_report => '{"picture":{"state":"too_large"}}');
	r := pg_temp.rec_row(4);
	perform pg_temp.base_assert(v = pg_temp.rec_answer('recorded', 5) and pg_temp.rec_is(4, 'found', 'landed', 'c2', 'c3')
		and r.title = 'A change whose record was lost' and r.worker_id is null and r.sequence is null and r.head_sha is null
		and r.summary is null and r.files_changed is null and r.paths is null and r.how is null
		and pg_temp.rec_is(5, 'landing', 'landed', 'c3', 'c4') and (pg_temp.rec_row(5)).picture is null
		and (pg_temp.rec_row(5)).picture_problem = 'too_large'
		and (select q2.last_change = 5 and q2.last_main = pg_temp.rec_sha('c4') and q2.index_version = 5 from pg_temp.rec_shop() q2),
		'in line, main elsewhere: ' || to_jsonb(r)::text);
	-- Not in line, and a filler ends at the commit: the turn takes the filler over. Its span, number and state stay.
	perform pg_temp.base_assert(pg_temp.rec_land(4, 'c6', 'c7') = pg_temp.rec_answer('recorded', 7)
		and pg_temp.rec_is(6, 'found', 'landed', 'c4', 'c6'), 'a filler to take over');
	v := pg_temp.rec_land(5, 'c5', 'c6', false, p_submission => '{"notice":"A basket.","picture":"docs/c.webp"}',
		p_report => jsonb_build_object('how', 'merged', 'picture', v_ok || '{"type":"webp"}'));
	r := pg_temp.rec_row(6);
	perform pg_temp.base_assert(v = pg_temp.rec_answer('adopted', 6) and pg_temp.rec_is(6, 'landing', 'landed', 'c4', 'c6')
		and r.worker_id = pg_temp.rec_copy(5) and r.sequence = 1 and r.title = 'Session 5' and r.head_sha = pg_temp.rec_sha('c6')
		and r.summary = 'Summary of session 5, turn 1.' and r.notice = 'A basket.' and r.how = 'merged'
		and r.staff_agent_id = '92400000-0000-4000-8000-000000000030' and r.picture ->> 'at' = 'code/company/shop/changes/6.webp'
		and r.files_changed is null and r.paths is null and r.file_version = 2
		and (select q2.last_change = 7 and q2.last_main = pg_temp.rec_sha('c7') and q2.index_version = 8 from pg_temp.rec_shop() q2),
		'a filler taken over: ' || to_jsonb(r)::text);
	-- Not in line, main where the record has it: one row. A picture the session never named is not the row's, and 60
	-- paths are the first 50 and ten more.
	v := pg_temp.rec_land(6, 'c7', 'c8', false, p_report => jsonb_build_object('picture', v_ok, 'pathsMore', 3, 'filesChanged', 63,
		'paths', (select jsonb_agg(jsonb_build_object('path', 'src/' || i || '.ts', 'change', 'added') order by i)
			from generate_series(1, 60) i)));
	r := pg_temp.rec_row(8);
	perform pg_temp.base_assert(v = pg_temp.rec_answer('recorded', 8) and pg_temp.rec_is(8, 'landing', 'landed', 'c7', 'c8')
		and r.picture is null and r.picture_problem is null and r.files_changed = 63 and jsonb_array_length(r.paths) = 50
		and r.paths -> 49 ->> 'path' = 'src/50.ts' and r.paths_more = 13, 'not in line, main as recorded: ' || to_jsonb(r)::text);
	-- Not in line, main somewhere else and no filler for it: late, and nothing is written.
	perform pg_temp.base_assert(pg_temp.rec_land(7, 'c20', 'c21', false) = pg_temp.rec_answer('late', null)
		and (pg_temp.rec_shop()).last_change = 8 and (pg_temp.rec_shop()).last_main = pg_temp.rec_sha('c8'), 'late');
	-- Main already held the commit, and a filler ends where it first did: taken over. A picture the session named and no
	-- job looked at is nothing. Paths too long for a row are as many as fit, and the rest counted.
	v := pg_temp.rec_land(8, 'c10', 'c11', p_submission => '{"picture":"docs/d.png"}', p_report => jsonb_build_object(
		'paths', (select jsonb_agg(jsonb_build_object('path', md5(i::text) || repeat('/long', 180), 'change', 'removed'))
			from generate_series(1, 50) i)));
	r := pg_temp.rec_row(10);
	perform pg_temp.base_assert(v = pg_temp.rec_answer('recorded', 10) and pg_temp.rec_is(9, 'found', 'landed', 'c8', 'c10')
		and r.picture is null and r.picture_problem is null and pg_column_size(r.paths) <= 16384
		and jsonb_array_length(r.paths) between 1 and 49 and r.paths_more = 50 - jsonb_array_length(r.paths),
		'paths that fit: ' || jsonb_array_length(r.paths));
	perform pg_temp.base_assert(pg_temp.rec_unchanged(9, 'c10', 'c11', 'c10') = pg_temp.rec_answer('adopted', 9)
		and pg_temp.rec_is(9, 'landing', 'landed', 'c8', 'c10') and (pg_temp.rec_row(9)).worker_id = pg_temp.rec_copy(9)
		and (pg_temp.rec_row(9)).how is null and (pg_temp.rec_row(9)).file_version = 2, 'unchanged, a filler taken over');
	-- Main already held it and another row says so: known, and nothing is written.
	q := pg_temp.rec_shop();
	perform pg_temp.base_assert(pg_temp.rec_unchanged(10, 'c11', 'c11', 'c11') = pg_temp.rec_answer('known', 10)
		and pg_temp.rec_unchanged(11, 'c10', 'c11', 'c10') = pg_temp.rec_answer('known', 9)
		and to_jsonb(pg_temp.rec_shop()) = to_jsonb(q) and (pg_temp.rec_row(10)).worker_id = pg_temp.rec_copy(8), 'known');
	-- No row for the commit, and main is not where the record has it: a filler for the gap. It is the turn's when it
	-- ends at the commit that first held the turn's own; else the turn has no row.
	perform pg_temp.base_assert(pg_temp.rec_unchanged(12, 'c12', 'c13', 'c12') = pg_temp.rec_answer('nothing', null)
		and pg_temp.rec_is(11, 'found', 'landed', 'c11', 'c13') and (pg_temp.rec_shop()).last_main = pg_temp.rec_sha('c13'),
		'unchanged, a filler that is not the turn''s');
	perform pg_temp.base_assert(pg_temp.rec_unchanged(13, 'c14', 'c14', 'c14') = pg_temp.rec_answer('adopted', 12)
		and pg_temp.rec_is(12, 'landing', 'landed', 'c13', 'c14') and (pg_temp.rec_row(12)).worker_id = pg_temp.rec_copy(13)
		and (pg_temp.rec_row(12)).title = 'Session 13' and (pg_temp.rec_row(12)).file_version = 2,
		'unchanged, a filler that is the turn''s');
	-- No row for the commit and main where the record has it: nothing.
	q := pg_temp.rec_shop();
	perform pg_temp.base_assert(pg_temp.rec_unchanged(14, 'c99', 'c14', 'c99') = pg_temp.rec_answer('nothing', null)
		and to_jsonb(pg_temp.rec_shop()) = to_jsonb(q), 'nothing');
	-- A landing refused by a rule is a row too.
	v := pg_temp.rec_record(pg_temp.rec_turn(15, 1, h), pg_temp.rec_report('refused', h, null, null,
		'{"refusal":{"code":"CODE_HOST_NAMES_DIFFER_BY_CASE","paths":["Readme.md","README.md"]}}'));
	perform pg_temp.base_assert(v = pg_temp.rec_answer('recorded', 13) and pg_temp.rec_is(13, 'landing', 'refused', null, null)
		and (pg_temp.rec_row(13)).refusal = '{"code":"CODE_HOST_NAMES_DIFFER_BY_CASE","paths":["Readme.md","README.md"]}'
		and (select q2.last_change = 13 and q2.last_main = pg_temp.rec_sha('c14') from pg_temp.rec_shop() q2), 'refused');
	-- The rows that moved main cover its history end to end: each starts where the one before it ended.
	perform pg_temp.base_assert((select count(*) = 11 and bool_and(coalesce(chain.main_before = chain.previous, chain.n = 1))
		from (select c.n, c.main_before, lag(c.main_after) over (order by c.n) as previous
			from public.qorpera_code_changes c where c.environment_id = pg_temp.rec_here() and c.name = 'shop'
				and c.main_after is not null) chain), 'the rows cover main''s history');
	-- A repository with no row yet, and a report made after the job: there is nothing it could have missed, so it is
	-- the first row. A repository nobody registered has no record.
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
	values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'site');
	w := pg_temp.rec_turn(16, 1, pg_temp.rec_sha('s1'), '{}', pg_temp.own_repo('company', 'site'));
	v := pg_temp.rec_record(w, pg_temp.rec_report('landed', pg_temp.rec_sha('s1'), pg_temp.rec_sha('s0'), pg_temp.rec_sha('s1'),
		'{"inLine":false}'));
	perform pg_temp.base_assert(v = pg_temp.rec_answer('recorded', 1) and pg_temp.rec_is(1, 'landing', 'landed', 's0', 's1', 'site')
		and (pg_temp.rec_shop('site')).last_main = pg_temp.rec_sha('s1') and (pg_temp.rec_shop()).last_change = 13,
		'another repository has its own numbers');
	perform pg_temp.base_error(format('select pg_temp.rec_record(%L, %L)',
		pg_temp.rec_turn(17, 1, h, '{}', pg_temp.own_repo('company', 'nowhere')), pg_temp.rec_report('conflict', h, null, null)),
		'55000', 'Code repository is not registered');
end $$;

-- 4. Numbers have no gaps ---------------------------------------------------------------------------------------------
do $$
declare v jsonb; v_failed boolean := false;
begin
	-- A landing is recorded and its transaction fails: the number goes back with the row.
	begin
		v := pg_temp.rec_land(20, 'c14', 'c15');
		perform pg_temp.base_assert(v = pg_temp.rec_answer('recorded', 14) and (pg_temp.rec_shop()).last_change = 14, 'row 14');
		raise exception 'the job failed' using errcode = 'P0001';
	exception when raise_exception then
		v_failed := sqlerrm = 'the job failed';
	end;
	perform pg_temp.base_assert(v_failed and (pg_temp.rec_shop()).last_change = 13 and pg_temp.rec_row(14) is null
		and (pg_temp.rec_shop()).last_main = pg_temp.rec_sha('c14'), 'the number went back');
	-- The next row takes it.
	v := pg_temp.rec_land(20, 'c14', 'c15');
	perform pg_temp.base_assert(v = pg_temp.rec_answer('recorded', 14)
		and (select count(*) = 14 and min(c.n) = 1 and max(c.n) = 14 from public.qorpera_code_changes c
			where c.environment_id = pg_temp.rec_here() and c.name = 'shop'), 'fourteen rows, one to fourteen: ' || v::text);
	-- A row is one number in one repository, and one turn's.
	perform pg_temp.base_error($q$insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind, state,
		main_after, title) values (pg_temp.rec_here(), 'company', 'shop', 14, '92400000-0000-4000-8000-000000000010', 'found',
		'landed', pg_temp.rec_sha('x'), 'Twice')$q$, '23505');
	perform pg_temp.base_error(format($q$insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind,
		state, main_after, title, worker_id, sequence) values (pg_temp.rec_here(), 'company', 'shop', 15,
		'92400000-0000-4000-8000-000000000010', 'landing', 'landed', pg_temp.rec_sha('x'), 'Twice', %L, 1)$q$, pg_temp.rec_copy(20)),
		'23505');
	-- What a row may be: a landing names its turn, an undo its targets, a refusal says why, a row that is in main says
	-- where main went, and a reverted row says by which.
	perform pg_temp.base_error($q$insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind, state,
		main_after, title) values (pg_temp.rec_here(), 'company', 'shop', 15, '92400000-0000-4000-8000-000000000010', 'landing',
		'landed', pg_temp.rec_sha('x'), 'No turn')$q$, '23514');
	perform pg_temp.base_error($q$insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind, state,
		main_after, title) values (pg_temp.rec_here(), 'company', 'shop', 15, '92400000-0000-4000-8000-000000000010', 'undo',
		'landed', pg_temp.rec_sha('x'), 'No targets')$q$, '23514');
	perform pg_temp.base_error($q$insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind, state,
		title) values (pg_temp.rec_here(), 'company', 'shop', 15, '92400000-0000-4000-8000-000000000010', 'found', 'landed',
		'No main')$q$, '23514');
	perform pg_temp.base_error($q$insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind, state,
		title) values (pg_temp.rec_here(), 'company', 'shop', 15, '92400000-0000-4000-8000-000000000010', 'found', 'conflict',
		'No refusal')$q$, '23514');
	perform pg_temp.base_error($q$insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind, state,
		main_after, title) values (pg_temp.rec_here(), 'company', 'shop', 15, '92400000-0000-4000-8000-000000000010', 'found',
		'reverted', pg_temp.rec_sha('x'), 'By nothing')$q$, '23514');
	perform pg_temp.base_error($q$insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind, state,
		main_after, title, notice) values (pg_temp.rec_here(), 'company', 'shop', 15, '92400000-0000-4000-8000-000000000010',
		'found', 'landed', pg_temp.rec_sha('x'), 'Two lines', E'One.\nTwo.')$q$, '23514');
	perform pg_temp.base_error($q$insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind, state,
		main_after, title) values (pg_temp.rec_here(), 'company', 'nowhere', 1, '92400000-0000-4000-8000-000000000010', 'found',
		'landed', pg_temp.rec_sha('x'), 'No repository')$q$, '23503');
end $$;

-- 5. The record files -------------------------------------------------------------------------------------------------
-- exec-1170 runs on machine 5…5 and holds this company's code alone.
update public.qorpera_coding_executors set nas_machine_id_sha256 = repeat('5', 64) where owner = 'exec-1170';
do $$
declare v jsonb; v_row jsonb; v_bad jsonb; q public.qorpera_code_repositories%rowtype; r public.qorpera_code_changes%rowtype;
	v_shop jsonb := jsonb_build_object('companyId', '92400000-0000-4000-8000-000000000010',
		'environmentId', pg_temp.rec_here(), 'owner', 'company', 'name', 'shop');
begin
	-- Due: both repositories have rows whose file is behind, and a list to write. Each with its company and name.
	v := pg_temp.rec_due();
	perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.code-change-files-due/v1', 'repositories',
		jsonb_build_array(v_shop, v_shop || '{"name":"site"}')), 'both are due: ' || v::text);
	perform pg_temp.base_assert(pg_temp.rec_due_names(p_limit => 1) = 'shop', 'the limit');
	perform pg_temp.base_error($q$select pg_temp.rec_due(p_limit => 0)$q$, '22023', 'Code change files limit invalid');
	perform pg_temp.base_error($q$select pg_temp.rec_due(p_limit => 51)$q$, '22023', 'Code change files limit invalid');
	perform pg_temp.base_error($q$select pg_temp.rec_due(p_limit => null)$q$, '22023', 'Code change files limit invalid');
	perform pg_temp.base_error($q$select pg_temp.rec_due('exec 1170')$q$, '42501', 'Coding machine custody required');
	perform pg_temp.base_error($q$select pg_temp.rec_due('exec-1170', repeat('5', 63))$q$, '42501', 'Coding machine custody required');
	-- Another machine, an executor nobody enrolled, a second enabled executor, a company being deleted: none.
	perform pg_temp.base_assert(pg_temp.rec_due_names('exec-1170', repeat('6', 64)) = '' and pg_temp.rec_due_names('exec-none') = '',
		'another machine, or no executor of it');
	insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256)
	values (pg_temp.rec_here(), 'exec-two', true, array['codex'], repeat('6', 64));
	perform pg_temp.base_assert(pg_temp.rec_due_names() = '' and pg_temp.rec_due_names('exec-two', repeat('6', 64)) = ''
		and pg_temp.rec_files() -> 'changes' = '[]'::jsonb, 'two executors');
	delete from public.qorpera_coding_executors where owner = 'exec-two';
	insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
	values ('92400000-0000-4000-8000-000000000010', null);
	perform pg_temp.base_assert(pg_temp.rec_due_names() = '' and pg_temp.rec_files() -> 'changes' = '[]'::jsonb,
		'the company is being deleted');
	delete from public.qorpera_company_deletions where profile_id = '92400000-0000-4000-8000-000000000010';

	-- What the files should say: the rows whose file is behind, oldest first, and the list, newest first.
	v := pg_temp.rec_files();
	r := pg_temp.rec_row(3);
	perform pg_temp.base_assert(v - 'changes' - 'index' = jsonb_build_object('schema', 'qorpera.code-change-files/v1',
			'repository', v_shop)
		and jsonb_array_length(v -> 'changes') = 14
		and (select string_agg(c ->> 'n', ',' order by i) from jsonb_array_elements(v -> 'changes') with ordinality t(c, i))
			= '1,2,3,4,5,6,7,8,9,10,11,12,13,14', 'the files to write: ' || (v - 'changes' - 'index')::text);
	-- A landing: every key, the session by its folder, the turn, the picture as the row has it.
	perform pg_temp.base_assert(v -> 'changes' -> 2 = jsonb_build_object('n', 3, 'version', 1, 'kind', 'landing', 'state', 'landed',
			'how', 'merged', 'createdAt', r.created_at, 'title', 'Session 2',
			'session', 'QorperaOS/agents/alice/todos/fix-login/rec-2', 'turn', 1, 'mainBefore', pg_temp.rec_sha('c1'),
			'mainAfter', pg_temp.rec_sha('c2'), 'headSha', pg_temp.rec_sha('c2'), 'summary', 'Summary of session 2, turn 1.',
			'notice', 'Each price says free returns.', 'picture', r.picture, 'pictureProblem', null)
			|| jsonb_build_object('filesChanged', 2, 'paths', r.paths, 'pathsMore', 0, 'needsDiff', false, 'refusal', null,
			'undoes', null, 'revertedBy', null, 'restoredFrom', null), 'a landing''s file: ' || (v -> 'changes' -> 2)::text);
	-- A filler needs its files counted; a row with no main, and a row that has them, do not.
	v_row := v -> 'changes' -> 3;
	perform pg_temp.base_assert(v_row ->> 'kind' = 'found' and (v_row ->> 'needsDiff')::boolean and v_row -> 'session' = 'null'
		and v_row -> 'turn' = 'null' and v_row -> 'filesChanged' = 'null' and v_row -> 'paths' = 'null'
		and v_row ->> 'title' = 'A change whose record was lost', 'a filler''s file: ' || v_row::text);
	perform pg_temp.base_assert(v -> 'changes' -> 1 ->> 'state' = 'conflict' and not (v -> 'changes' -> 1 ->> 'needsDiff')::boolean
		and v -> 'changes' -> 1 -> 'refusal' = '{"code":"CODE_HOST_LAND_CONFLICT","paths":["src/a.ts"]}'
		and v -> 'changes' -> 1 -> 'mainAfter' = 'null'
		-- A filler a turn took over is a landing whose files are still to count, at its second version.
		and v -> 'changes' -> 5 ->> 'kind' = 'landing' and (v -> 'changes' -> 5 ->> 'needsDiff')::boolean
		and v -> 'changes' -> 5 ->> 'version' = '2' and v -> 'changes' -> 4 ->> 'pictureProblem' = 'too_large',
		'a conflict''s and a taken filler''s file');
	-- The list: its version, and a line per row, newest first; the notice when there is one, else the title.
	q := pg_temp.rec_shop();
	perform pg_temp.base_assert(v -> 'index' ->> 'version' = q.index_version::text
		and jsonb_array_length(v -> 'index' -> 'lines') = 14
		and v -> 'index' -> 'lines' -> 0 = jsonb_build_object('n', 14, 'createdAt', (pg_temp.rec_row(14)).created_at,
			'state', 'landed', 'kind', 'landing', 'line', 'Session 20')
		and v -> 'index' -> 'lines' -> 11 ->> 'line' = 'Each price says free returns.'
		and v -> 'index' -> 'lines' -> 12 = jsonb_build_object('n', 2, 'createdAt', (pg_temp.rec_row(2)).created_at,
			'state', 'conflict', 'kind', 'landing', 'line', 'Session 1')
		and v -> 'index' -> 'lines' -> 13 ->> 'line' = repeat('å', 200), 'the list: ' || (v -> 'index')::text);
	-- The limit keeps the oldest rows, and is 1 to 20.
	perform pg_temp.base_assert(jsonb_array_length(pg_temp.rec_files(2) -> 'changes') = 2
		and pg_temp.rec_files(2) -> 'changes' -> 1 ->> 'n' = '2' and pg_temp.rec_files(2) -> 'index' = v -> 'index', 'two rows');
	perform pg_temp.base_error($q$select pg_temp.rec_files(0)$q$, '22023', 'Code change files request invalid');
	perform pg_temp.base_error($q$select pg_temp.rec_files(21)$q$, '22023', 'Code change files request invalid');
	perform pg_temp.base_error($q$select pg_temp.rec_files(5, null)$q$, '22023', 'Code change files request invalid');
	-- An executor that does not hold the company, and a repository nobody registered: no row, no list, no company.
	perform pg_temp.base_assert(pg_temp.rec_files(p_machine => repeat('6', 64)) = jsonb_build_object(
			'schema', 'qorpera.code-change-files/v1', 'repository', v_shop || '{"companyId":null}', 'changes', '[]'::jsonb,
			'index', null)
		and pg_temp.rec_files(p_name => 'nowhere') -> 'repository' = v_shop || '{"companyId":null,"name":"nowhere"}'
		and pg_temp.rec_files(p_name => 'nowhere') -> 'index' = 'null', 'not the holder''s, or no such repository');

	-- Written: each row's file at the version written, and the list. The filler's files were counted by the job.
	foreach v_bad in array array['null'::jsonb, '[]', pg_temp.rec_wrote() - 'problem', pg_temp.rec_wrote() - 'indexVersion',
		pg_temp.rec_wrote() || '{"extra":1}', pg_temp.rec_wrote('{}'), pg_temp.rec_wrote('[7]'),
		pg_temp.rec_wrote('[{"n":1}]'), pg_temp.rec_wrote('[{"version":1}]'), pg_temp.rec_wrote('[{"n":0,"version":1}]'),
		pg_temp.rec_wrote('[{"n":1,"version":0}]'), pg_temp.rec_wrote('[{"n":"1","version":1}]'),
		pg_temp.rec_wrote('[{"n":1,"version":1,"written":true}]'), pg_temp.rec_wrote('[{"n":1,"version":1,"filesChanged":-1}]'),
		pg_temp.rec_wrote('[{"n":1,"version":1,"paths":null}]'), pg_temp.rec_wrote('[{"n":1,"version":1,"paths":["a"]}]'),
		pg_temp.rec_wrote('[{"n":1,"version":1,"pathsMore":1.5}]'),
		pg_temp.rec_wrote() || '{"indexVersion":-1}', pg_temp.rec_wrote() || '{"indexVersion":"3"}',
		pg_temp.rec_wrote() || '{"problem":"it broke"}', pg_temp.rec_wrote() || '{"problem":7}',
		pg_temp.rec_wrote((select jsonb_agg(jsonb_build_object('n', i, 'version', 1)) from generate_series(1, 51) i))] loop
		perform pg_temp.base_error(format('select pg_temp.rec_written(%L)', v_bad), '22023', 'Code change files report invalid');
	end loop;
	perform pg_temp.base_error($q$select pg_temp.rec_written(null)$q$, '22023', 'Code change files report invalid');
	perform pg_temp.base_assert(pg_temp.rec_written(pg_temp.rec_wrote(), p_machine => repeat('6', 64))
			= '{"schema":"qorpera.code-change-files-written/v1","state":"lost"}'
		and pg_temp.rec_written(pg_temp.rec_wrote(), 'nowhere') ->> 'state' = 'lost'
		and pg_temp.rec_written(pg_temp.rec_wrote('[{"n":1,"version":1}]', q.index_version), p_owner => 'exec-none') ->> 'state' = 'lost'
		and (pg_temp.rec_row(1)).file_written = 0 and (pg_temp.rec_shop()).index_written = 0, 'not the holder''s is lost');
	v := pg_temp.rec_written(pg_temp.rec_wrote(jsonb_build_array('{"n":1,"version":1}'::jsonb, '{"n":2,"version":1}'::jsonb,
		-- A diff for a row that has its files changes nothing in it.
		'{"n":3,"version":1,"filesChanged":9,"paths":[{"path":"other","change":"removed"}],"pathsMore":4}'::jsonb,
		'{"n":4,"version":1,"filesChanged":3,"paths":[{"path":"a","change":"added"},{"path":"b","change":"changed"}],"pathsMore":1}'::jsonb,
		-- The taken filler was written at its first version: its file is still behind. A version the row never had
		-- counts as the row's own, no more.
		'{"n":6,"version":1,"filesChanged":0,"paths":[]}'::jsonb, '{"n":5,"version":7}'::jsonb,
		-- A row that is not there is nobody's.
		'{"n":99,"version":1}'::jsonb), q.index_version - 1));
	perform pg_temp.base_assert(v = '{"schema":"qorpera.code-change-files-written/v1","state":"recorded"}'
		and (select bool_and(c.file_written = 1) from public.qorpera_code_changes c
			where c.environment_id = pg_temp.rec_here() and c.name = 'shop' and c.n in (1, 2, 3, 4, 5, 6))
		and (pg_temp.rec_row(5)).file_version = 1 and (pg_temp.rec_row(6)).file_version = 2
		and (pg_temp.rec_row(3)).files_changed = 2 and jsonb_array_length((pg_temp.rec_row(3)).paths) = 2
		and (pg_temp.rec_row(3)).paths_more = 0
		and (pg_temp.rec_row(4)).files_changed = 3 and (pg_temp.rec_row(4)).paths = '[{"path":"a","change":"added"},{"path":"b","change":"changed"}]'
		and (pg_temp.rec_row(4)).paths_more = 1 and (pg_temp.rec_row(4)).file_version = 1
		and (pg_temp.rec_row(6)).files_changed = 0 and (pg_temp.rec_row(6)).paths = '[]'::jsonb
		and (pg_temp.rec_row(7)).file_written = 0
		and (pg_temp.rec_shop()).index_written = q.index_version - 1 and (pg_temp.rec_shop()).files_problem is null,
		'written: ' || v::text);
	-- What is still behind: the taken filler at its second version, the rows after it, and the list.
	v := pg_temp.rec_files();
	perform pg_temp.base_assert((select string_agg(c ->> 'n', ',' order by i)
			from jsonb_array_elements(v -> 'changes') with ordinality t(c, i)) = '6,7,8,9,10,11,12,13,14'
		and not (v -> 'changes' -> 0 ->> 'needsDiff')::boolean and v -> 'index' ->> 'version' = q.index_version::text,
		'still behind: ' || (v -> 'changes' -> 0)::text);
	-- An older list version never moves the written one back, and a newer one than the list's is the list's own.
	perform pg_temp.rec_written(pg_temp.rec_wrote('[]', 1));
	perform pg_temp.base_assert((pg_temp.rec_shop()).index_written = q.index_version - 1, 'an older list');
	perform pg_temp.rec_written(pg_temp.rec_wrote('[]', q.index_version + 50));
	perform pg_temp.base_assert((pg_temp.rec_shop()).index_written = q.index_version and pg_temp.rec_files() -> 'index' = 'null',
		'the list is written');

	-- A problem pauses the repository's files, twice as long each time, to 10 minutes at most.
	perform pg_temp.rec_written(pg_temp.rec_wrote(p_problem => 'CODE_HOST_JOB_FAILED'));
	q := pg_temp.rec_shop();
	perform pg_temp.base_assert(q.files_problem = 'CODE_HOST_JOB_FAILED' and q.files_attempts = 1
		and q.files_not_before between clock_timestamp() + interval '1 second' and clock_timestamp() + interval '2 seconds'
		and pg_temp.rec_due_names() = 'site', 'a problem: ' || to_jsonb(q)::text);
	perform pg_temp.rec_written(pg_temp.rec_wrote('[{"n":6,"version":2}]', null, 'CODE_HOST_FOLDER_UNAVAILABLE'));
	q := pg_temp.rec_shop();
	perform pg_temp.base_assert(q.files_problem = 'CODE_HOST_FOLDER_UNAVAILABLE' and q.files_attempts = 2
		and q.files_not_before between clock_timestamp() + interval '3 seconds' and clock_timestamp() + interval '4 seconds'
		and (pg_temp.rec_row(6)).file_written = 2, 'a second problem: ' || to_jsonb(q)::text);
	update public.qorpera_code_repositories set files_attempts = 8 where name = 'shop';
	perform pg_temp.rec_written(pg_temp.rec_wrote(p_problem => 'CODE_HOST_JOB_FAILED'));
	perform pg_temp.base_assert((select r2.files_attempts = 9 and r2.files_not_before between clock_timestamp() + interval '511 seconds'
		and clock_timestamp() + interval '512 seconds' from pg_temp.rec_shop() r2), 'the ninth problem');
	perform pg_temp.rec_written(pg_temp.rec_wrote(p_problem => 'CODE_HOST_JOB_FAILED'));
	update public.qorpera_code_repositories set files_attempts = 400 where name = 'shop';
	perform pg_temp.rec_written(pg_temp.rec_wrote(p_problem => 'CODE_HOST_JOB_FAILED'));
	perform pg_temp.base_assert((select r2.files_attempts = 401 and r2.files_not_before between clock_timestamp() + interval '599 seconds'
		and clock_timestamp() + interval '10 minutes' from pg_temp.rec_shop() r2), 'ten minutes at most');
	-- The pause over, it is due again; a write with no problem ends the pause.
	update public.qorpera_code_repositories set files_not_before = clock_timestamp() - interval '1 second' where name = 'shop';
	perform pg_temp.base_assert(pg_temp.rec_due_names() = 'shop,site', 'due again');
	perform pg_temp.rec_written(pg_temp.rec_wrote((select jsonb_agg(jsonb_build_object('n', c.n, 'version', c.file_version))
		from public.qorpera_code_changes c where c.environment_id = pg_temp.rec_here() and c.name = 'shop')));
	q := pg_temp.rec_shop();
	perform pg_temp.base_assert(q.files_problem is null and q.files_attempts = 0 and q.files_not_before is null
		and pg_temp.rec_due_names() = 'site' and pg_temp.rec_files() -> 'changes' = '[]'::jsonb, 'all written: ' || to_jsonb(q)::text);
	-- A row whose file is behind again makes the repository due, and so does the list alone.
	update public.qorpera_code_changes set file_version = file_version + 1 where name = 'shop' and n = 2;
	perform pg_temp.base_assert(pg_temp.rec_due_names() = 'shop,site' and pg_temp.rec_files() -> 'changes' -> 0 ->> 'version' = '2'
		and pg_temp.rec_files() -> 'index' = 'null', 'one row behind');
	perform pg_temp.rec_written(pg_temp.rec_wrote('[{"n":2,"version":2}]'));
	update public.qorpera_code_repositories set index_version = index_version + 1 where name = 'shop';
	perform pg_temp.base_assert(pg_temp.rec_due_names() = 'shop,site' and pg_temp.rec_files() -> 'changes' = '[]'::jsonb
		and pg_temp.rec_files() -> 'index' ->> 'version' = (q.index_version + 1)::text, 'the list alone');
end $$;

-- 6. The backfill -----------------------------------------------------------------------------------------------------
-- The record starts empty again; what the workers reported is all there is. Session b1's own report is there (2): its
-- landing on c1. Beside it: copy 2 reported two landings and copy 3 one, a merge; copy 4 reported a commit main already
-- held, copy 5 a turn that landed nothing, a session on GitHub a pull request, and copy 16 a landing in company/site.
delete from public.qorpera_code_changes;
update public.qorpera_code_repositories set last_change = 0, last_main = null, index_version = 0, index_written = 0;
create function pg_temp.rec_reported(p_n integer, p_sequence integer, p_ago interval, p_body jsonb) returns void
language plpgsql as $$
begin
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body, created_at)
	values (pg_temp.rec_copy(p_n), p_sequence, 'reported', null, p_body, clock_timestamp() - p_ago);
	perform set_config('session_replication_role', 'origin', true);
end $$;
create function pg_temp.rec_landed(p_state text, p_main text, p_summary text) returns jsonb language sql as $$
	select jsonb_build_object('outcome', 'succeeded', 'summary', p_summary || E'\n\nQorpera landed this commit on main: main is at '
		|| left(pg_temp.rec_sha(p_main), 12) || ', and the files are in the company folder at code/company/shop/main/.',
		'landed', jsonb_build_object('kind', 'landed', 'state', p_state, 'branch', 'main', 'headSha', pg_temp.rec_sha('h-' || p_main),
			'mainSha', pg_temp.rec_sha(p_main)))
$$;
select pg_temp.rec_reported(2, 1, interval '5 hours', pg_temp.rec_landed('fast-forward', 'd1', 'The first.')) \g /dev/null
select pg_temp.rec_reported(3, 1, interval '4 hours', pg_temp.rec_landed('merged', 'd2',
	E'The second.\n\nQorpera landed this commit on a branch of my own, I thought.')) \g /dev/null
select pg_temp.rec_reported(2, 2, interval '3 hours', pg_temp.rec_landed('fast-forward', 'd3', 'The third.')) \g /dev/null
select pg_temp.rec_reported(4, 1, interval '2 hours', pg_temp.rec_landed('unchanged', 'd3', 'Nothing new.')) \g /dev/null
select pg_temp.rec_reported(5, 1, interval '2 hours', '{"outcome":"failed","summary":"It broke."}') \g /dev/null
select pg_temp.rec_reported(90, 1, interval '2 hours', pg_temp.rec_landed('fast-forward', 'g1', 'On GitHub.')) \g /dev/null
select pg_temp.rec_reported(16, 1, interval '1 hour', pg_temp.rec_landed('fast-forward', 's1', 'The site.')) \g /dev/null
do $$
declare v_count integer; r public.qorpera_code_changes%rowtype; q public.qorpera_code_repositories%rowtype;
	v_before jsonb; b1 uuid := '91170000-0000-4000-8000-0000000000b1';
begin
	update public.qorpera_coding_sessions set base_sha = pg_temp.rec_sha('base-2') where worker_id = pg_temp.rec_copy(2);
	v_count := public.qorpera_code_changes_backfill();
	perform pg_temp.base_assert(v_count = 5 and (select count(*) from public.qorpera_code_changes) = 5, 'five landings: ' || v_count);
	-- In time order. The first row starts at its session's base; each later one where the row before it ended.
	r := pg_temp.rec_row(1);
	perform pg_temp.base_assert(r.kind = 'landing' and r.state = 'landed' and r.how = 'fast-forward'
		and r.main_before = pg_temp.rec_sha('base-2') and r.main_after = pg_temp.rec_sha('d1') and r.head_sha = pg_temp.rec_sha('h-d1')
		and r.worker_id = pg_temp.rec_copy(2) and r.sequence = 1 and r.title = 'Session 2' and r.summary = 'The first.'
		and r.staff_agent_id = '92400000-0000-4000-8000-000000000030' and r.notice is null and r.picture is null
		and r.files_changed is null and r.paths is null and r.file_version = 1 and r.file_written = 0
		and r.created_at between clock_timestamp() - interval '301 minutes' and clock_timestamp() - interval '299 minutes',
		'the first landing: ' || to_jsonb(r)::text);
	r := pg_temp.rec_row(2);
	-- The summary is the session's words up to the platform's own line, which is the last of its kind.
	perform pg_temp.base_assert(r.how = 'merged' and r.main_before = pg_temp.rec_sha('d1') and r.main_after = pg_temp.rec_sha('d2')
		and r.worker_id = pg_temp.rec_copy(3) and r.title = 'Session 3'
		and r.summary = E'The second.\n\nQorpera landed this commit on a branch of my own, I thought.', 'the second: ' || to_jsonb(r)::text);
	r := pg_temp.rec_row(3);
	perform pg_temp.base_assert(r.main_before = pg_temp.rec_sha('d2') and r.main_after = pg_temp.rec_sha('d3')
		and r.worker_id = pg_temp.rec_copy(2) and r.sequence = 2 and r.summary = 'The third.', 'the third: ' || to_jsonb(r)::text);
	r := pg_temp.rec_row(4);
	perform pg_temp.base_assert(r.main_before = pg_temp.rec_sha('d3') and r.main_after = pg_temp.rec_sha('c1') and r.worker_id = b1
		and r.sequence = 1 and r.title = 'Fix the login page' and r.summary = 'The shop has a cart.' and r.how = 'fast-forward',
		'the real turn''s: ' || to_jsonb(r)::text);
	q := pg_temp.rec_shop();
	perform pg_temp.base_assert(q.last_change = 4 and q.last_main = pg_temp.rec_sha('c1') and q.index_version = 4
		and pg_temp.rec_is(1, 'landing', 'landed', 'base', 's1', 'site') and (pg_temp.rec_shop('site')).last_change = 1
		and (pg_temp.rec_shop('site')).last_main = pg_temp.rec_sha('s1'), 'the registry: ' || to_jsonb(q)::text);
	-- Its rows need their files counted when their files are written.
	perform pg_temp.base_assert((select bool_and((c ->> 'needsDiff')::boolean) and count(*) = 4
		from jsonb_array_elements(pg_temp.rec_files() -> 'changes') c), 'the files are counted later');
	-- Again: nothing new, and nothing changed.
	select jsonb_agg(to_jsonb(c) order by c.name, c.n) into v_before from public.qorpera_code_changes c;
	v_count := public.qorpera_code_changes_backfill();
	perform pg_temp.base_assert(v_count = 0 and (select jsonb_agg(to_jsonb(c) order by c.name, c.n) from public.qorpera_code_changes c) = v_before
		and to_jsonb(pg_temp.rec_shop()) = to_jsonb(q), 'a second backfill: ' || v_count);
	-- A landing reported since, by an executor of before this step, is one more row. One reported before the last row,
	-- that no row knows, is not put in between: the record's next movement finds it as a gap.
	perform pg_temp.rec_reported(3, 2, interval '-1 second', pg_temp.rec_landed('fast-forward', 'd5', 'The fifth.'));
	perform pg_temp.rec_reported(6, 1, interval '30 minutes', pg_temp.rec_landed('fast-forward', 'd4', 'Out of order.'));
	v_count := public.qorpera_code_changes_backfill();
	r := pg_temp.rec_row(5);
	perform pg_temp.base_assert(v_count = 1 and r.main_before = pg_temp.rec_sha('c1') and r.main_after = pg_temp.rec_sha('d5')
		and r.worker_id = pg_temp.rec_copy(3) and r.sequence = 2 and (pg_temp.rec_shop()).last_change = 5
		and (pg_temp.rec_shop()).last_main = pg_temp.rec_sha('d5'), 'a landing since: ' || to_jsonb(r)::text);
	perform pg_temp.base_assert(public.qorpera_code_changes_backfill() = 0, 'and nothing after it');
	-- A landing the executor recorded is a row already, whenever its report came.
	perform pg_temp.base_assert(pg_temp.rec_land(21, 'd5', 'd6') = pg_temp.rec_answer('recorded', 6), 'a recorded landing');
	perform pg_temp.rec_reported(21, 1, interval '-2 seconds', pg_temp.rec_landed('fast-forward', 'd6', 'The sixth.'));
	perform pg_temp.base_assert(public.qorpera_code_changes_backfill() = 0 and (pg_temp.rec_shop()).last_change = 6,
		'a recorded landing is not added twice');
end $$;

-- 7. The folder's rules -----------------------------------------------------------------------------------------------
do $$
declare w uuid := pg_temp.rec_copy(1); d text := 'code/company/shop/'; s text := 'code/_set-aside/'; v_wrong text;
	v_here uuid := pg_temp.rec_here(); g text := 'code/company/shop/repo.git/';
begin
	perform pg_temp.base_assert(strpos(pg_get_functiondef('public.qorpera_folder_git_refusal(text,text,text,uuid)'::regprocedure),
		'20260930720000') > 0 and strpos(pg_get_functiondef(
		'public.qorpera_folder_git_unit_refusal(uuid,jsonb,text,text,text,uuid)'::regprocedure), '20260930720000') > 0
		and strpos(pg_get_functiondef('public.qorpera_folder_git_refusal(text,text,text,uuid)'::regprocedure), '20260930707000') > 0,
		'the rules carry their markers');
	-- The rule, key by key and per class: a repository's change record, its downloads and a restore's mark are the
	-- platform's, as main/ is, and so is everything a restore set aside.
	select string_agg(format('%s %s %s: %s', t.k, t.op, t.cls, coalesce(public.qorpera_folder_git_refusal(t.k, t.op, t.cls,
			case when t.own then w end), 'null')), '; ') into v_wrong
	from (values
		(d || 'changes', 'mkdir', 'member', false, 'git_platform_only'),
		(d || 'changes', 'mkdir', 'session', true, 'git_platform_only'),
		(d || 'changes', 'rmdir', 'member', false, 'git_platform_only'),
		(d || 'changes', 'mkdir', 'platform', false, null),
		(d || 'changes/14.md', 'write', 'member', false, 'git_platform_only'),
		(d || 'changes/14.md', 'write', 'session', true, 'git_platform_only'),
		(d || 'changes/14.md', 'write', 'session', false, 'git_platform_only'),
		(d || 'changes/14.md', 'delete', 'member', false, 'git_platform_only'),
		(d || 'changes/14.md', 'delete', 'session', true, 'git_platform_only'),
		(d || 'changes/14.md', 'move', 'session', true, 'git_platform_only'),
		(d || 'changes/14.md', 'symlink', 'session', true, 'git_platform_only'),
		(d || 'changes/14.md', 'write', 'platform', false, null),
		(d || 'changes/14.md', 'delete', 'platform', false, null),
		(d || 'changes/index.md', 'write', 'member', false, 'git_platform_only'),
		(d || 'changes/14.png', 'write', 'session', true, 'git_platform_only'),
		(d || 'changes/deep/er.md', 'write', 'member', false, 'git_platform_only'),
		(d || 'downloads', 'mkdir', 'session', true, 'git_platform_only'),
		(d || 'downloads/shop-2026-11-10.zip', 'write', 'member', false, 'git_platform_only'),
		(d || 'downloads/shop-2026-11-10.zip', 'write', 'session', true, 'git_platform_only'),
		(d || 'downloads/shop-2026-11-10.zip', 'delete', 'member', false, 'git_platform_only'),
		(d || 'downloads/shop-2026-11-10.bundle', 'move', 'member', false, 'git_platform_only'),
		(d || 'downloads/shop-2026-11-10.zip', 'write', 'platform', false, null),
		(d || 'restoring.json', 'write', 'member', false, 'git_platform_only'),
		(d || 'restoring.json', 'write', 'session', true, 'git_platform_only'),
		(d || 'restoring.json', 'delete', 'session', true, 'git_platform_only'),
		(d || 'restoring.json', 'write', 'platform', false, null),
		(s || 'company', 'mkdir', 'member', false, 'git_platform_only'),
		(s || 'company/at-20261110T120000Z', 'mkdir', 'session', true, 'git_platform_only'),
		(s || 'company/at-20261110T120000Z/shop', 'rmdir', 'member', false, 'git_platform_only'),
		(s || 'company/at-20261110T120000Z/shop/main/a.ts', 'write', 'member', false, 'git_platform_only'),
		(s || 'company/at-20261110T120000Z/shop/worktrees/' || w || '/a.ts', 'write', 'session', true, 'git_platform_only'),
		(s || 'company/at-20261110T120000Z/shop/worktrees/' || w || '/a.ts', 'delete', 'member', false, 'git_platform_only'),
		(s || 'company/at-20261110T120000Z/shop/repo.git/refs/heads/main', 'write', 'session', true, 'git_platform_only'),
		(s || 'company/at-20261110T120000Z/shop/notes.md', 'move', 'member', false, 'git_platform_only'),
		(s || 'company/at-20261110T120000Z/shop/main/a.ts', 'delete', 'platform', false, null),
		('code/_set-aside', 'mkdir', 'member', false, 'git_platform_only'),
		('code/_set-aside', 'rmdir', 'session', true, 'git_platform_only'),
		('code/_set-aside', 'mkdir', 'platform', false, null),
		-- As before: the other places of a repository, and names that only look alike.
		(d || 'main/x', 'write', 'member', false, 'git_platform_only'),
		(d || 'notes.md', 'write', 'session', true, null),
		(d || 'changesx/14.md', 'write', 'session', true, null),
		(d || 'downloads.md', 'write', 'member', false, null),
		(d || 'restoring.json.bak', 'write', 'member', false, null),
		(d || 'worktrees/' || w || '/changes/14.md', 'write', 'session', true, null),
		(d || 'worktrees/' || w || '/downloads/a.zip', 'write', 'session', true, null),
		('code/company/shop', 'mkdir', 'session', true, null),
		('code/company', 'mkdir', 'member', false, null),
		('code/_set-asides/company', 'mkdir', 'member', false, null),
		('code/company/_set-aside/x', 'write', 'member', false, null),
		('notes/_set-aside/x', 'write', 'member', false, null),
		('code', 'mkdir', 'member', false, null)) t(k, op, cls, own, want)
	where public.qorpera_folder_git_refusal(t.k, t.op, t.cls, case when t.own then w end) is distinct from t.want;
	perform pg_temp.base_assert(v_wrong is null, 'git_refusal: ' || coalesce(v_wrong, ''));

	-- In a repository kept in Qorpera a member writes and removes no ref, and neither of the two files that would move
	-- main for every reader; a session's rule and the reflog's are as they were. company/shop is registered.
	select string_agg(format('%s %s %s: %s', t.k, t.op, t.cls, coalesce(public.qorpera_folder_git_unit_refusal(v_here,
			jsonb_build_object('op', t.op), t.k, null, t.cls, case when t.cls = 'session' then w end), 'null')), '; ') into v_wrong
	from (values
		(g || 'refs/heads/main', 'write', 'member', 'git_platform_only'),
		(g || 'refs/heads/qorpera/coding/' || w, 'write', 'member', 'git_platform_only'),
		(g || 'refs/tags/v1', 'write', 'member', 'git_platform_only'),
		(g || 'refs/heads', 'mkdir', 'member', 'git_platform_only'),
		(g || 'refs', 'mkdir', 'member', 'git_platform_only'),
		(g || 'packed-refs', 'write', 'member', 'git_platform_only'),
		(g || 'shallow', 'write', 'member', 'git_platform_only'),
		(g || 'refs/qorpera/kept-here', 'write', 'member', 'git_platform_only'),
		(g || 'logs/refs/heads/main', 'write', 'member', null),
		(g || 'refsx', 'write', 'member', 'git_platform_only'),
		(g || 'refs/heads/main', 'write', 'session', 'git_lease_required'),
		(g || 'packed-refs', 'write', 'session', 'git_lease_required'),
		(g || 'refs/heads', 'mkdir', 'session', null),
		(d || 'worktrees/' || w || '/refs/heads/main', 'write', 'member', null),
		-- A place nobody registered, with no mark: a copy of a GitHub repository, as it was.
		('code/acme/app/repo.git/refs/heads/main', 'write', 'member', null),
		('code/acme/app/repo.git/packed-refs', 'write', 'member', null),
		('code/acme/app/repo.git/refs/heads', 'mkdir', 'member', null),
		('code/acme/app/repo.git/refs/heads/main', 'write', 'session', 'git_lease_required')) t(k, op, cls, want)
	where public.qorpera_folder_git_unit_refusal(v_here, jsonb_build_object('op', t.op), t.k, null, t.cls,
		case when t.cls = 'session' then w end) is distinct from t.want;
	perform pg_temp.base_assert(v_wrong is null, 'git_unit_refusal: ' || coalesce(v_wrong, ''));
	-- The other company's place of the same name is its own: nobody registered a repository there.
	perform pg_temp.base_assert(public.qorpera_folder_git_unit_refusal('91170000-0000-4000-8000-000000000020',
		'{"op":"write"}', g || 'refs/heads/main', null, 'member', null) is null, 'another company''s place');
end $$;
-- The same through the folder's commit: a member's write of a repository's main branch, of its record and of what a
-- restore set aside is refused, and nothing is saved. The platform (the code host) writes all of them.
do $$
declare v_file jsonb := pg_temp.base_seal(pg_temp.base_owner(), pg_temp.base_manifest('ref: a member''s')) -> 'file';
	v_result jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v_result := public.qorpera_folder_commit(pg_temp.rec_here(), pg_temp.base_owner(), 'rec-member-refs', jsonb_build_array(
		jsonb_build_object('op', 'write', 'path', 'code/company/shop/repo.git/refs/heads/main', 'file', v_file),
		jsonb_build_object('op', 'write', 'path', 'code/company/shop/repo.git/packed-refs', 'file', v_file),
		jsonb_build_object('op', 'write', 'path', 'code/company/shop/changes/1.md', 'file', v_file),
		jsonb_build_object('op', 'write', 'path', 'code/company/shop/downloads/shop.zip', 'file', v_file),
		jsonb_build_object('op', 'write', 'path', 'code/company/shop/restoring.json', 'file', v_file),
		jsonb_build_object('op', 'mkdir', 'path', 'code/_set-aside')));
	perform pg_temp.base_assert(jsonb_array_length(v_result -> 'units') = 6 and not exists (
		select 1 from jsonb_array_elements(v_result -> 'units') u
		where u ->> 'outcome' is distinct from 'refused' or u ->> 'reason' is distinct from 'git_platform_only')
		and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = pg_temp.rec_here()
			and e.key_text like 'code/%'), 'a member''s writes are refused: ' || v_result::text);
	perform pg_temp.base_commit('{"kind":"platform"}', 'rec-platform-record',
		(select jsonb_agg(jsonb_build_object('op', 'mkdir', 'path', t.p) order by t.n) from unnest(array['code', 'code/company',
			'code/company/shop', 'code/company/shop/changes', 'code/company/shop/downloads', 'code/_set-aside',
			'code/_set-aside/company', 'code/_set-aside/company/at-20261110T120000Z',
			'code/_set-aside/company/at-20261110T120000Z/shop', 'code/_set-aside/company/at-20261110T120000Z/shop/repo.git'])
			with ordinality t(p, n))
		|| (select jsonb_agg(jsonb_build_object('op', 'write', 'path', t.p, 'file', pg_temp.base_stage('The platform''s.')) order by t.n)
			from unnest(array['code/company/shop/changes/1.md', 'code/company/shop/changes/index.md',
				'code/company/shop/downloads/shop-2026-11-10.zip', 'code/company/shop/restoring.json',
				'code/_set-aside/company/at-20261110T120000Z/shop/repo.git/HEAD']) with ordinality t(p, n)));
	-- A member removes and moves none of it: not a file, and not a folder with what it holds.
	v_result := public.qorpera_folder_commit(pg_temp.rec_here(), pg_temp.base_owner(), 'rec-member-removes', jsonb_build_array(
		jsonb_build_object('op', 'delete', 'path', 'code/company/shop/changes/1.md',
			'expectedVersion', pg_temp.base_version('code/company/shop/changes/1.md')),
		jsonb_build_object('op', 'delete', 'path', 'code/company/shop/changes'),
		jsonb_build_object('op', 'move', 'from', 'code/company/shop/downloads', 'to', 'downloads-of-mine'),
		jsonb_build_object('op', 'delete', 'path', 'code/_set-aside'),
		jsonb_build_object('op', 'delete', 'path', 'code/company/shop/restoring.json',
			'expectedVersion', pg_temp.base_version('code/company/shop/restoring.json'))));
	perform pg_temp.base_assert(jsonb_array_length(v_result -> 'units') = 5 and not exists (
		select 1 from jsonb_array_elements(v_result -> 'units') u
		where u ->> 'outcome' is distinct from 'refused' or u ->> 'reason' is distinct from 'git_platform_only')
		and (select count(*) from public.qorpera_folder_entries e where e.environment_id = pg_temp.rec_here()
			and e.key_text like 'code/%') = 14, 'a member removes none of it: ' || v_result::text);
end $$;
