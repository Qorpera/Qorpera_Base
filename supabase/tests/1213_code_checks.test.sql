-- @fixture 1211_code_requests.test.sql until "-- 1. An agent asks for an undo"
-- A repository's checks before a change goes into main (migration 20260930721000): the operator's switch, what a
-- landing's report says of the checks and what its row keeps, the record files' two keys, the rows of an undo and of a
-- restore, the platform's line after a landing, and the failure words of the checks with the session's rounds.
-- 1211's fixture (1210's helpers before it): company/shop with six rows, session copies that hand commits in, the record
-- call, and an undo and a restore from the call that asks for it to the executor's finish. This file's repositories
-- are company/gate, large, back, late, wide, kept and said, and its session copies are numbered from 1300.
--   1. Rights, the columns and their rule, the marker.
--   2. The record call: v1 as before; v2 none, off and passed; every invalid v2; a filler first and a filler taken
--      over; a replay; the largest value a real checks file gives (C1's count: 8,145 bytes).
--   3. The switch: the lease holder only, a GitHub repository refused, no registry row is on, off is off.
--   4. The record files: checksState and checks.
--   5. Undo: one change, andLater over a passed row, over a none row and over an inherited one, andLater of a row that
--      took a wider filler over, and a late finish that takes over a row whose checks passed.
--   6. Restore: inherited from a passed row and from an inherited one, not, and to a commit the record does not know;
--      and an undo back to a commit two rows put main at.
--   7. The platform's line after a landing, for each state and for no row.
--   8. The failure words: each code keeps the executor's words and is the reason; the rounds counted, passed over and
--      reset; any other code as before.

-- A repository of this file's own, registered: company/p_name.
create function pg_temp.chk_repository(p_name text) returns void language sql as $$
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
	values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', p_name)
$$;
-- What passed, as the executor reports it for a landing that put main at commit p_after by p_how; the keys given
-- changed.
create function pg_temp.chk_passed(p_after text, p_how text default 'fast-forward', p_keys jsonb default '{}')
returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-checks/v1', 'commit', pg_temp.rec_sha(p_after), 'how', p_how,
		'file', pg_temp.rec_sha('checks.json'), 'ms', 61012, 'copyMs', 900,
		'checks', '[{"name":"install","run":"npm ci","ms":38012},{"name":"test","run":"npm test","ms":21000}]'::jsonb,
		'changed', null, 'tries', 1) || p_keys
$$;
-- The same at its bounds: 20 checks with names of 40 characters and commands of 200 bytes, and p_changed of the names
-- in each list of what changed.
create function pg_temp.chk_wide(p_after text, p_changed integer) returns jsonb language sql immutable as $$
	select pg_temp.chk_passed(p_after, 'fast-forward', jsonb_build_object(
		'checks', (select jsonb_agg(jsonb_build_object('name', 'check-' || lpad(i::text, 34, '0'),
			'run', repeat('r', 198) || 'å', 'ms', i * 1000) order by i) from generate_series(1, 20) i),
		'changed', (select jsonb_build_object('added', coalesce(jsonb_agg(n), '[]'), 'removed', coalesce(jsonb_agg(n), '[]'),
				'run', coalesce(jsonb_agg(n), '[]'))
			from (select 'check-' || lpad(i::text, 34, '0') as n from generate_series(1, p_changed) i) names)))
$$;
-- The largest value a real checks file gives (C1, code-checks.ts): 20 checks with names of 40 bytes and commands of
-- 200, 20 names added and 20 removed (then none can be changed), merged, tried twice, every time at the largest the row
-- takes (15 digits; a number of 16 digits takes no more room).
create function pg_temp.chk_largest(p_after text) returns jsonb language sql immutable as $$
	select pg_temp.chk_passed(p_after, 'merged', jsonb_build_object('ms', 999999999999999, 'copyMs', 999999999999999,
		'tries', 2, 'checks', (select jsonb_agg(jsonb_build_object('name', 'check-' || lpad(i::text, 34, '0'),
			'run', repeat('r', 200), 'ms', 999999999999999) order by i) from generate_series(1, 20) i),
		'changed', jsonb_build_object('added', (select jsonb_agg('check-' || lpad(i::text, 34, '0') order by i)
				from generate_series(1, 20) i),
			'removed', (select jsonb_agg('gone-' || lpad(i::text, 35, '0') order by i) from generate_series(1, 20) i),
			'run', '[]'::jsonb)))
$$;
-- What passed, as the `checks` of a report.
create function pg_temp.chk_ok(p_result jsonb) returns jsonb language sql immutable as $$
	select jsonb_build_object('state', 'passed', 'result', p_result)
$$;
-- A report of schema v2: rec_report's (commits as they are given), with what the checks did, and the keys given changed.
create function pg_temp.chk_report(p_state text, p_head text, p_before text, p_after text, p_checks jsonb,
	p_change jsonb default '{}') returns jsonb language sql as $$
	select pg_temp.rec_report(p_state, p_head, p_before, p_after, jsonb_build_object('schema',
		'qorpera.code-change-report/v2', 'checks', p_checks) || p_change)
$$;
-- Session copy p_n hands in commit p_after on company/p_name and reports that it landed on main at p_before, with
-- what the checks did.
create function pg_temp.chk_land(p_n integer, p_before text, p_after text, p_checks jsonb, p_name text default 'gate',
	p_in_line boolean default true, p_how text default 'fast-forward') returns jsonb language sql as $$
	select pg_temp.rec_record(pg_temp.rec_turn(p_n, 1, pg_temp.rec_sha(p_after), '{}', pg_temp.own_repo('company', p_name)),
		pg_temp.chk_report('landed', pg_temp.rec_sha(p_after), pg_temp.rec_sha(p_before), pg_temp.rec_sha(p_after), p_checks,
			jsonb_build_object('inLine', p_in_line, 'how', p_how)))
$$;
-- What row p_n of company/p_name keeps of the checks.
create function pg_temp.chk_said(p_n integer, p_name text default 'gate') returns jsonb language sql as $$
	select jsonb_build_object('state', c.checks_state, 'checks', c.checks) from pg_temp.rec_row(p_n, p_name) c
$$;
create function pg_temp.chk_none() returns jsonb language sql immutable as $$
	select '{"state":null,"checks":null}'::jsonb
$$;
create function pg_temp.chk_as(p_state text, p_as integer default null) returns jsonb language sql immutable as $$
	select jsonb_build_object('state', p_state, 'checks', case when p_as is not null
		then jsonb_build_object('schema', 'qorpera.code-checks/v1', 'as', p_as) end)
$$;
-- The switch, as the executor asks it.
create function pg_temp.chk_switch(p_worker uuid, p_token uuid default pg_temp.rec_token()) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_checks_switch(p_worker, p_token);
	reset role;
	return v;
end $$;
-- (Since 20260930729000 the switch also says whether a site is kept: on here; 1216 switches it.)
create function pg_temp.chk_enabled(p_enabled boolean) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-checks-switch/v1', 'enabled', p_enabled, 'site', true)
$$;
-- A session copy's turn as a turn that is ending: its submission (whose receipt rec_turn made up, so the settle of the
-- turn would find no such receipt) is read already.
create function pg_temp.chk_ending(p_worker uuid) returns void language plpgsql as $$
begin
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_coding_session_turns turn set submission = null, submission_receipt_id = null, submitted_at = null
	where turn.worker_id = p_worker and turn.sequence = (select w.sequence from public.qorpera_runtime_workers w where w.id = p_worker);
	perform set_config('session_replication_role', 'origin', true);
end $$;
-- The executor ends a session copy's turn that landed commit p_after on company/said: what the agent reads.
create function pg_temp.chk_complete(p_worker uuid, p_after text) returns text language plpgsql as $$
begin
	perform pg_temp.chk_ending(p_worker);
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_coding_turn(p_worker, pg_temp.rec_token(), 'succeeded', 'Done.', null, null, null,
		jsonb_build_array(jsonb_build_object('kind', 'landed', 'state', 'fast-forward', 'branch', 'main',
			'headSha', pg_temp.rec_sha(p_after), 'mainSha', pg_temp.rec_sha(p_after))), null, 1);
	return (select w.result ->> 'summary' from public.qorpera_runtime_workers w where w.id = p_worker);
end $$;
-- The line the agent reads after a landing of commit p_after on company/said: 2b's with change p_n (none when null),
-- then p_said.
create function pg_temp.chk_line(p_after text, p_n integer, p_said text) returns text language sql immutable as $$
	select E'Done.\n\nQorpera landed this commit on main: main is at ' || left(pg_temp.rec_sha(p_after), 12)
		|| ', and the files are in the company folder at code/company/said/main/.'
		|| coalesce(' It is change ' || p_n || ' of this repository; its record is code/company/said/changes/' || p_n || '.md.', '')
		|| p_said
$$;
-- Turn p_sequence of session copy p_n ends failed with the executor's summary: what the worker's result says, the code
-- of its failed event, and the reason its turn keeps.
create function pg_temp.chk_fail(p_n integer, p_sequence integer, p_summary text) returns jsonb language plpgsql as $$
declare v_worker uuid := pg_temp.rec_turn(p_n, p_sequence, pg_temp.rec_sha('f' || p_sequence), '{}',
	pg_temp.own_repo('company', 'said'));
begin
	perform pg_temp.chk_ending(v_worker);
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_coding_turn(v_worker, pg_temp.rec_token(), 'failed', p_summary);
	return (select jsonb_build_object('summary', w.result ->> 'summary', 'reason', w.result ->> 'reason',
			'code', (select e.body ->> 'code' from public.qorpera_coding_session_events e
				where e.worker_id = w.id and e.kind = 'failed' order by e.id desc limit 1),
			'outcome', (select t.outcome ->> 'reason' from public.qorpera_coding_session_turns t
				where t.worker_id = w.id and t.sequence = p_sequence))
		from public.qorpera_runtime_workers w where w.id = v_worker);
end $$;
-- What chk_fail answers for words that were reported with that code.
create function pg_temp.chk_failed(p_summary text, p_code text) returns jsonb language sql immutable as $$
	select jsonb_build_object('summary', p_summary, 'reason', p_code, 'code', p_code, 'outcome', p_code)
$$;

select pg_temp.chk_repository(name) from unnest(array['gate', 'large', 'back', 'late', 'wide', 'kept', 'said']) name \g /dev/null

-- 1. Rights, the columns, the marker ------------------------------------------------------------------------------------
do $$
declare v_role text; v_function text; v_bad record;
begin
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(has_function_privilege(v_role, 'public.qorpera_code_checks_switch(uuid,uuid)', 'EXECUTE')
			= (v_role = 'service_role'), 'the switch is the service role''s only: ' || v_role);
		foreach v_function in array array['public.qorpera_code_checks_passed_valid(jsonb,text,text)',
			'public.qorpera_code_change_checks_valid(jsonb)'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_function, 'EXECUTE'),
				v_function || ' is closed to ' || v_role);
		end loop;
	end loop;
	perform pg_temp.base_assert((select prosecdef and proconfig = array['search_path=""'] from pg_proc
		where oid = 'public.qorpera_code_checks_switch(uuid,uuid)'::regprocedure), 'the switch is a definer with an empty search path');
	-- Every repository starts with its checks on, those of before this step too; no row of before says anything of them.
	perform pg_temp.base_assert((select bool_and(r.checks_enabled) and count(*) = 8 from public.qorpera_code_repositories r
		where r.environment_id = pg_temp.rec_here() and r.name in ('shop', 'gate', 'large', 'back', 'late', 'wide', 'kept', 'said')),
		'checks are on');
	perform pg_temp.base_assert((select count(*) = 6 and bool_and(c.checks_state is null and c.checks is null)
		from public.qorpera_code_changes c where c.environment_id = pg_temp.rec_here() and c.name = 'shop'), 'shop''s six rows');
	-- passed and inherited carry their checks, and nothing else does; a state is one of five; checks are an object of at
	-- most 8 KiB.
	for v_bad in select * from (values ('passed', null::jsonb), ('inherited', null), ('none', '{"as":1}'),
		('off', '{"as":1}'), ('not_run', '{"as":1}'), (null, '{"as":1}'), ('skipped', null), ('passed', '[]'),
		('passed', '"passed"'), ('inherited', jsonb_build_object('as', 1, 'pad', repeat('p', 8192)))) bad(state, checks) loop
		perform pg_temp.base_error(format($q$insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id,
			kind, state, main_after, title, checks_state, checks) values (pg_temp.rec_here(), 'company', 'gate', 99,
			'92400000-0000-4000-8000-000000000010', 'found', 'landed', pg_temp.rec_sha('x'), 'A row', %L, %L)$q$,
			v_bad.state, v_bad.checks), '23514');
	end loop;
end $$;

-- 2. The record call --------------------------------------------------------------------------------------------------
do $$
declare v jsonb; v_bad jsonb; v_place integer; w uuid; r public.qorpera_code_changes%rowtype;
	q public.qorpera_code_repositories%rowtype; h text := pg_temp.rec_sha('gh'); a text := pg_temp.rec_sha('ga'); b text := pg_temp.rec_sha('gb');
	v_ok jsonb := pg_temp.chk_ok(pg_temp.chk_passed('ga'));
	v_refusal jsonb := '{"refusal":{"code":"CODE_HOST_NAMES_DIFFER_BY_CASE","paths":["Readme.md","README.md"]}}';
	v_test jsonb := '{"name":"test","run":"npm test","ms":21000}';
begin
	-- v2 reports that are valid: every state, a landing's three, merged and made after the job, and 20 checks with names
	-- of 40 characters and commands of 200 bytes. A v1 report is still one.
	perform pg_temp.base_assert(pg_column_size(pg_temp.chk_wide('ga', 5)) <= 8192
		and public.qorpera_code_change_report_valid(pg_temp.chk_report('landed', h, b, a, '{"state":"none"}'))
		and public.qorpera_code_change_report_valid(pg_temp.chk_report('landed', h, b, a, '{"state":"off"}'))
		and public.qorpera_code_change_report_valid(pg_temp.chk_report('landed', h, b, a, v_ok))
		and public.qorpera_code_change_report_valid(pg_temp.chk_report('landed', h, b, a,
			pg_temp.chk_ok(pg_temp.chk_passed('ga', 'merged', '{"tries":2}')), '{"how":"merged","inLine":false}'))
		and public.qorpera_code_change_report_valid(pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_wide('ga', 5))))
		and public.qorpera_code_change_report_valid(pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga',
			'fast-forward', '{"changed":{"added":["e2e"],"removed":[],"run":["test"]}}'))))
		and public.qorpera_code_change_report_valid(pg_temp.chk_report('unchanged', h, a, a, null))
		and public.qorpera_code_change_report_valid(pg_temp.chk_report('conflict', h, null, null, null))
		and public.qorpera_code_change_report_valid(pg_temp.chk_report('refused', h, null, null, null, v_refusal))
		and public.qorpera_code_change_report_valid(pg_temp.rec_report('landed', h, b, a)), 'reports that are valid');
	-- Each that is not: checks for a state that did not land, none or a wrong one for a landing, v1 with checks, and
	-- every way a passed result can be wrong.
	w := pg_temp.rec_turn(1310, 1, h, '{}', pg_temp.own_repo('company', 'gate'));
	for v_bad, v_place in select bad.item, bad.place from unnest(array[
		pg_temp.chk_report('conflict', h, null, null, '{"state":"none"}'),
		pg_temp.chk_report('unchanged', h, a, a, '{"state":"none"}'),
		pg_temp.chk_report('refused', h, null, null, '{"state":"off"}', v_refusal),
		pg_temp.chk_report('conflict', h, null, null, v_ok),
		pg_temp.chk_report('landed', h, b, a, null), pg_temp.chk_report('landed', h, b, a, v_ok) - 'checks',
		pg_temp.rec_report('landed', h, b, a, '{"checks":null}'), pg_temp.rec_report('landed', h, b, a, jsonb_build_object('checks', v_ok)),
		pg_temp.chk_report('landed', h, b, a, v_ok, '{"schema":"qorpera.code-change-report/v3"}'),
		pg_temp.chk_report('landed', h, b, a, v_ok, '{"schema":null}'),
		pg_temp.chk_report('landed', h, b, a, '"none"'), pg_temp.chk_report('landed', h, b, a, '{}'),
		pg_temp.chk_report('landed', h, b, a, '{"state":"none","result":null}'),
		pg_temp.chk_report('landed', h, b, a, '{"state":"off","more":1}'),
		pg_temp.chk_report('landed', h, b, a, '{"state":"skipped"}'), pg_temp.chk_report('landed', h, b, a, '{"state":null}'),
		pg_temp.chk_report('landed', h, b, a, '{"state":"inherited"}'), pg_temp.chk_report('landed', h, b, a, '{"state":"not_run","more":1}'),
		pg_temp.chk_report('landed', h, b, a, '{"state":"passed"}'),
		pg_temp.chk_report('landed', h, b, a, '{"state":"passed","result":null}'),
		pg_temp.chk_report('landed', h, b, a, v_ok || '{"more":1}'),
		-- The result: of another commit than mainAfter, of another how, a key too many or too few, another schema.
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('gb'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'merged'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"extra":1}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga') - 'tries')),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga') - 'changed')),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga') - 'file')),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward',
			'{"schema":"qorpera.code-checks/v2"}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok('[]')),
		-- Its values: the commit, the file, the times, the tries.
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', jsonb_build_object('commit', upper(a))))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"file":"abc"}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"file":null}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"ms":-1}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"ms":1.5}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"ms":"61012"}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"copyMs":null}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"tries":3}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"tries":0}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"tries":"1"}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"tries":1.0}'))),
		-- The checks: none, 21, not a list, a check with a key too many or too few or no object, a name a check may not
		-- have, a name twice, a command empty, of 201 bytes or no text, a time that is not one.
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"checks":[]}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', jsonb_build_object('checks',
			(select jsonb_agg(jsonb_build_object('name', 'c' || i, 'run', 'true', 'ms', 1)) from generate_series(1, 21) i))))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"checks":{}}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"checks":null}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', jsonb_build_object('checks',
			jsonb_build_array(v_test || '{"cwd":"."}'))))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', jsonb_build_object('checks',
			jsonb_build_array(v_test - 'ms'))))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"checks":["test"]}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', jsonb_build_object('checks',
			jsonb_build_array(v_test || '{"name":"Test"}'))))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', jsonb_build_object('checks',
			jsonb_build_array(v_test || '{"name":"-test"}'))))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', jsonb_build_object('checks',
			jsonb_build_array(v_test || jsonb_build_object('name', repeat('t', 41))))))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', jsonb_build_object('checks',
			jsonb_build_array(v_test || '{"name":7}'))))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', jsonb_build_object('checks',
			jsonb_build_array(v_test, v_test || '{"run":"npm run test"}'))))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', jsonb_build_object('checks',
			jsonb_build_array(v_test || '{"run":""}'))))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', jsonb_build_object('checks',
			jsonb_build_array(v_test || jsonb_build_object('run', repeat('r', 199) || 'å')))))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', jsonb_build_object('checks',
			jsonb_build_array(v_test || '{"run":7}'))))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', jsonb_build_object('checks',
			jsonb_build_array(v_test || '{"ms":-1}'))))),
		-- What changed: a list left out or one too many, no list, a list of 21, a name a check may not have, no object.
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward',
			'{"changed":{"added":[],"removed":[]}}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward',
			'{"changed":{"added":[],"removed":[],"run":[],"moved":[]}}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward',
			'{"changed":{"added":"e2e","removed":[],"run":[]}}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', jsonb_build_object('changed',
			jsonb_build_object('added', (select jsonb_agg('c' || i) from generate_series(1, 21) i), 'removed', '[]'::jsonb,
				'run', '[]'::jsonb))))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward',
			'{"changed":{"added":["E2E"],"removed":[],"run":[]}}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward',
			'{"changed":{"added":[7],"removed":[],"run":[]}}'))),
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_passed('ga', 'fast-forward', '{"changed":[]}'))),
		-- And all of it over 8 KiB, every other rule kept.
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(pg_temp.chk_wide('ga', 20)))]) with ordinality bad(item, place) loop
		perform pg_temp.base_assert(not public.qorpera_code_change_report_valid(v_bad),
			'no report ' || v_place || ': ' || left(v_bad::text, 600));
		perform pg_temp.base_error(format('select pg_temp.rec_record(%L, %L)', w, v_bad), '22023', 'Code change report invalid');
	end loop;
	perform pg_temp.base_assert(pg_column_size(pg_temp.chk_wide('ga', 20)) > 8192
		and public.qorpera_code_checks_passed_valid(pg_temp.chk_wide('ga', 20) - 'changed' || '{"changed":null}', a, 'fast-forward'),
		'only its size is wrong');
	perform pg_temp.base_assert((pg_temp.rec_shop('gate')).last_change = 0, 'none of them wrote a row');

	-- v1, as before: its row says nothing of the checks.
	perform pg_temp.base_assert(pg_temp.rec_land(1300, 'k0', 'k1', p_name => 'gate') = pg_temp.rec_answer('recorded', 1)
		and pg_temp.chk_said(1) = pg_temp.chk_none(), 'v1: ' || pg_temp.chk_said(1)::text);
	-- v2: none, off and passed, each kept on its row; passed with what passed.
	perform pg_temp.base_assert(pg_temp.chk_land(1301, 'k1', 'k2', '{"state":"none"}') = pg_temp.rec_answer('recorded', 2)
		and pg_temp.chk_said(2) = '{"state":"none","checks":null}'
		and pg_temp.chk_land(1302, 'k2', 'k3', '{"state":"off"}') = pg_temp.rec_answer('recorded', 3)
		and pg_temp.chk_said(3) = '{"state":"off","checks":null}'
		and pg_temp.chk_land(1303, 'k3', 'k4', pg_temp.chk_ok(pg_temp.chk_passed('k4'))) = pg_temp.rec_answer('recorded', 4)
		and pg_temp.chk_said(4) = jsonb_build_object('state', 'passed', 'checks', pg_temp.chk_passed('k4'))
		and pg_temp.rec_is(4, 'landing', 'landed', 'k3', 'k4', 'gate'), 'none, off, passed: ' || pg_temp.chk_said(4)::text);
	-- A merge whose report is made after the job, and a passed run at its bounds.
	perform pg_temp.base_assert(pg_temp.chk_land(1304, 'k4', 'k5', pg_temp.chk_ok(pg_temp.chk_passed('k5', 'merged', '{"tries":2}')),
			p_in_line => false, p_how => 'merged') = pg_temp.rec_answer('recorded', 5)
		and pg_temp.chk_said(5) = jsonb_build_object('state', 'passed', 'checks', pg_temp.chk_passed('k5', 'merged', '{"tries":2}'))
		and (pg_temp.rec_row(5, 'gate')).how = 'merged'
		and pg_temp.chk_land(1305, 'k5', 'k6', pg_temp.chk_ok(pg_temp.chk_wide('k6', 5))) = pg_temp.rec_answer('recorded', 6)
		and (pg_temp.rec_row(6, 'gate')).checks = pg_temp.chk_wide('k6', 5), 'merged and late, and at the bounds');
	-- A conflict of v2: its row says nothing of the checks.
	v := pg_temp.rec_record(pg_temp.rec_turn(1306, 1, pg_temp.rec_sha('g6'), '{}', pg_temp.own_repo('company', 'gate')),
		pg_temp.chk_report('conflict', pg_temp.rec_sha('g6'), null, null, null));
	perform pg_temp.base_assert(v = pg_temp.rec_answer('recorded', 7) and pg_temp.rec_is(7, 'landing', 'conflict', null, null, 'gate')
		and pg_temp.chk_said(7) = pg_temp.chk_none(), 'a conflict');
	-- In line, main somewhere else: a filler first, which says nothing of the checks, then the landing, which does.
	perform pg_temp.base_assert(pg_temp.chk_land(1307, 'k8', 'k9', '{"state":"none"}') = pg_temp.rec_answer('recorded', 9)
		and pg_temp.rec_is(8, 'found', 'landed', 'k6', 'k8', 'gate') and pg_temp.chk_said(8) = pg_temp.chk_none()
		and pg_temp.chk_said(9) = '{"state":"none","checks":null}', 'a filler first');
	-- Made after the job, and a filler ends at the commit: the turn takes the filler over, with what the checks did.
	perform pg_temp.base_assert(pg_temp.chk_land(1308, 'k10', 'k11', '{"state":"off"}') = pg_temp.rec_answer('recorded', 11)
		and pg_temp.rec_is(10, 'found', 'landed', 'k9', 'k10', 'gate'), 'a filler to take over');
	v := pg_temp.chk_land(1309, 'k9', 'k10', pg_temp.chk_ok(pg_temp.chk_passed('k10')), p_in_line => false);
	r := pg_temp.rec_row(10, 'gate');
	perform pg_temp.base_assert(v = pg_temp.rec_answer('adopted', 10) and pg_temp.rec_is(10, 'landing', 'landed', 'k9', 'k10', 'gate')
		and r.worker_id = pg_temp.rec_copy(1309) and r.file_version = 2
		and pg_temp.chk_said(10) = jsonb_build_object('state', 'passed', 'checks', pg_temp.chk_passed('k10')),
		'a filler taken over: ' || to_jsonb(r)::text);
	-- A replay answers the row as it is, whatever the report says of the checks.
	q := pg_temp.rec_shop('gate');
	perform pg_temp.base_assert(pg_temp.rec_record(pg_temp.rec_copy(1309), pg_temp.chk_report('landed', pg_temp.rec_sha('k10'),
			pg_temp.rec_sha('k9'), pg_temp.rec_sha('k10'), '{"state":"off"}', '{"inLine":false}')) = pg_temp.rec_answer('replayed', 10)
		and pg_temp.rec_record(pg_temp.rec_copy(1309), pg_temp.rec_report('landed', pg_temp.rec_sha('k10'), pg_temp.rec_sha('k9'),
			pg_temp.rec_sha('k10'), '{"inLine":false}')) = pg_temp.rec_answer('replayed', 10)
		and to_jsonb(pg_temp.rec_row(10, 'gate')) = to_jsonb(r) and to_jsonb(pg_temp.rec_shop('gate')) = to_jsonb(q), 'a replay');
	-- The largest value a real checks file gives fits the row, and is kept as it was sent.
	perform pg_temp.base_assert(pg_column_size(pg_temp.chk_largest('x1')) <= 8192
		and pg_temp.chk_land(1390, 'x0', 'x1', pg_temp.chk_ok(pg_temp.chk_largest('x1')), 'large', p_how => 'merged')
			= pg_temp.rec_answer('recorded', 1)
		and (pg_temp.rec_row(1, 'large')).checks = pg_temp.chk_largest('x1'),
		'the largest value: ' || pg_column_size(pg_temp.chk_largest('x1')) || ' bytes');
end $$;

-- 3. The switch -------------------------------------------------------------------------------------------------------
do $$
declare w uuid := pg_temp.rec_turn(1330, 1, pg_temp.rec_sha('s1'), '{}', pg_temp.own_repo('company', 'gate'));
	v_shop uuid := pg_temp.rec_turn(1331, 1, pg_temp.rec_sha('s1'), '{}', pg_temp.own_repo('company', 'shop'));
	q public.qorpera_code_repositories%rowtype; s public.qorpera_coding_sessions%rowtype;
begin
	-- On, and read-only.
	q := pg_temp.rec_shop('gate'); s := pg_temp.c3_session(w);
	perform pg_temp.base_assert(pg_temp.chk_switch(w) = pg_temp.chk_enabled(true)
		and to_jsonb(pg_temp.rec_shop('gate')) = to_jsonb(q) and to_jsonb(pg_temp.c3_session(w)) = to_jsonb(s), 'on');
	-- The operator switches one repository off: off for its sessions, on for another's.
	update public.qorpera_code_repositories set checks_enabled = false
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = 'gate';
	perform pg_temp.base_assert(pg_temp.chk_switch(w) = pg_temp.chk_enabled(false)
		and pg_temp.chk_switch(v_shop) = pg_temp.chk_enabled(true), 'off is off, for that repository');
	update public.qorpera_code_repositories set checks_enabled = true
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = 'gate';
	perform pg_temp.base_assert(pg_temp.chk_switch(w) = pg_temp.chk_enabled(true), 'on again');
	-- A repository kept in Qorpera that nobody registered: on.
	perform pg_temp.base_assert(pg_temp.chk_switch(pg_temp.rec_turn(1332, 1, pg_temp.rec_sha('s1'), '{}',
		pg_temp.own_repo('company', 'nowhere'))) = pg_temp.chk_enabled(true), 'no row is on');
	-- A GitHub repository has no such checks.
	perform pg_temp.base_error(format('select pg_temp.chk_switch(%L)', pg_temp.rec_turn(1333, 1, pg_temp.rec_sha('s1'), '{}',
		pg_temp.c3_repo())), '22023', 'Code repository is not kept in Qorpera');
	-- Only the executor that holds the turn's lease.
	perform pg_temp.base_error(format('select pg_temp.chk_switch(%L, %L)', w, pg_temp.rec_copy(999)), '42501',
		'Coding session lease unavailable');
	perform pg_temp.base_error(format('select pg_temp.chk_switch(%L)', pg_temp.rec_copy(1399)), '42501',
		'Coding session lease unavailable');
	update public.qorpera_coding_sessions set lease_until = clock_timestamp() - interval '1 second' where worker_id = w;
	perform pg_temp.base_error(format('select pg_temp.chk_switch(%L)', w), '42501', 'Coding session lease unavailable');
	update public.qorpera_coding_sessions set lease_until = clock_timestamp() + interval '10 minutes' where worker_id = w;
	-- Without the service role's claims nobody asks it, and no other API role runs it.
	perform pg_temp.base_claims('anon');
	set local role service_role;
	perform pg_temp.base_error(format('select public.qorpera_code_checks_switch(%L, %L)', w, pg_temp.rec_token()), '42501',
		'Coding executor authority required');
	reset role;
	perform pg_temp.base_claims('service_role');
	set local role authenticated;
	perform pg_temp.base_error(format('select public.qorpera_code_checks_switch(%L, %L)', w, pg_temp.rec_token()), '42501',
		'permission denied for function qorpera_code_checks_switch');
	reset role;
end $$;

-- 4. The record files ---------------------------------------------------------------------------------------------------
do $$
declare v jsonb := pg_temp.rec_files(20, 'gate');
begin
	-- Each change says what its row keeps of the checks: nothing (v1, a conflict, a filler), none, off, or what passed.
	perform pg_temp.base_assert(jsonb_array_length(v -> 'changes') = 11
		and (select bool_and(c ? 'checksState' and c ? 'checks') from jsonb_array_elements(v -> 'changes') c)
		and v -> 'changes' -> 0 -> 'checksState' = 'null' and v -> 'changes' -> 0 -> 'checks' = 'null'
		and v -> 'changes' -> 1 -> 'checksState' = '"none"' and v -> 'changes' -> 1 -> 'checks' = 'null'
		and v -> 'changes' -> 2 -> 'checksState' = '"off"' and v -> 'changes' -> 2 -> 'checks' = 'null'
		and v -> 'changes' -> 3 -> 'checksState' = '"passed"' and v -> 'changes' -> 3 -> 'checks' = pg_temp.chk_passed('k4')
		and v -> 'changes' -> 6 ->> 'state' = 'conflict' and v -> 'changes' -> 6 -> 'checksState' = 'null'
		and v -> 'changes' -> 7 ->> 'kind' = 'found' and v -> 'changes' -> 7 -> 'checks' = 'null'
		and v -> 'changes' -> 9 -> 'checksState' = '"passed"' and v -> 'changes' -> 9 -> 'checks' = pg_temp.chk_passed('k10'),
		'the files'' changes: ' || left((v -> 'changes')::text, 2000));
end $$;

-- 5. Undo -------------------------------------------------------------------------------------------------------------
-- company/back: change 1 passed, 2 had no checks file, 3 and 4 passed.
do $$
declare v jsonb; v_id uuid; v_item jsonb; v_bundle text;
begin
	perform pg_temp.base_assert(pg_temp.chk_land(1340, 'b0', 'b1', pg_temp.chk_ok(pg_temp.chk_passed('b1')), 'back')
			= pg_temp.rec_answer('recorded', 1)
		and pg_temp.chk_land(1341, 'b1', 'b2', '{"state":"none"}', 'back') = pg_temp.rec_answer('recorded', 2)
		and pg_temp.chk_land(1342, 'b2', 'b3', pg_temp.chk_ok(pg_temp.chk_passed('b3')), 'back') = pg_temp.rec_answer('recorded', 3)
		and pg_temp.chk_land(1343, 'b3', 'b4', pg_temp.chk_ok(pg_temp.chk_passed('b4')), 'back') = pg_temp.rec_answer('recorded', 4),
		'back''s changes');
	-- An undo of one change makes a commit nobody checked, though main before that change passed its checks.
	perform pg_temp.base_assert(pg_temp.req_undone('chk-undo-1', 4, false, 'b4', 'u1', '{}', 'back') = pg_temp.req_recorded(5)
		and pg_temp.rec_is(5, 'undo', 'landed', 'b4', 'u1', 'back') and pg_temp.chk_said(5, 'back') = pg_temp.chk_as('not_run'),
		'one change: ' || pg_temp.chk_said(5, 'back')::text);
	-- With every later change, main goes back to where change 3 began, which change 2 made and no check ran on.
	perform pg_temp.base_assert(pg_temp.req_undone('chk-undo-2', 3, true, 'u1', 'u2', '{}', 'back') = pg_temp.req_recorded(6)
		and pg_temp.chk_said(6, 'back') = pg_temp.chk_as('not_run'), 'andLater over a none row: ' || pg_temp.chk_said(6, 'back')::text);
	-- Back to where change 2 began, which change 1 made and whose checks passed: inherited, as change 1.
	perform pg_temp.base_assert(pg_temp.req_undone('chk-undo-3', 2, true, 'u2', 'u3', '{}', 'back') = pg_temp.req_recorded(7)
		and pg_temp.chk_said(7, 'back') = pg_temp.chk_as('inherited', 1), 'andLater over a passed row: ' || pg_temp.chk_said(7, 'back')::text);
	-- A change after it, and then that change with every later one undone: back to what change 7 inherited.
	perform pg_temp.base_assert(pg_temp.chk_land(1344, 'u3', 'b5', '{"state":"none"}', 'back') = pg_temp.rec_answer('recorded', 8)
		and pg_temp.req_undone('chk-undo-4', 8, true, 'b5', 'u4', '{}', 'back') = pg_temp.req_recorded(9)
		and pg_temp.chk_said(9, 'back') = pg_temp.chk_as('inherited', 7), 'andLater over an inherited row: ' || pg_temp.chk_said(9, 'back')::text);

	-- company/wide: main goes back to where the undo's job is told, which for a row that took a wider filler over is
	-- where its own movement began, not where its span began. Change 1 passed, from w1 to w2. Two movements nobody saw,
	-- w2 to w2b and w2b to w3, then a landing in line: a filler from w2 to w3. The second movement's report comes late,
	-- passed, and takes the filler: its own movement began at w2b, whose files no check ran on.
	perform pg_temp.base_assert(pg_temp.chk_land(1345, 'w1', 'w2', pg_temp.chk_ok(pg_temp.chk_passed('w2')), 'wide')
			= pg_temp.rec_answer('recorded', 1)
		and pg_temp.chk_land(1346, 'w3', 'w4', '{"state":"none"}', 'wide') = pg_temp.rec_answer('recorded', 3)
		and pg_temp.chk_land(1347, 'w2b', 'w3', pg_temp.chk_ok(pg_temp.chk_passed('w3')), 'wide', false) = pg_temp.rec_answer('adopted', 2)
		and pg_temp.rec_is(2, 'landing', 'landed', 'w2', 'w3', 'wide') and (pg_temp.rec_row(2, 'wide')).own_before = pg_temp.rec_sha('w2b'),
		'wide''s changes');
	perform pg_temp.base_assert(pg_temp.req_undone('chk-wide-1', 2, true, 'w4', 'v1', '{}', 'wide') = pg_temp.req_recorded(4)
		and current_setting('qorpera_test.req_item')::jsonb -> 'change' ->> 'mainBefore' = pg_temp.rec_sha('w2b')
		and pg_temp.chk_said(4, 'wide') = pg_temp.chk_as('not_run'), 'andLater of a wider row: ' || pg_temp.chk_said(4, 'wide')::text);
	-- A turn's report that comes late never takes a filler that goes on past its own landing. Two movements nobody saw:
	-- v1 to x1, whose checks passed, and x1 to x2, of which nothing is known. Then a landing in line: a filler from v1
	-- to x2. The first movement's report is late and takes nothing: the filler ends at x2, with files no check ran on,
	-- and says nothing of checks. Neither an undo back to x2 nor a restore to x2 inherits anything.
	perform pg_temp.base_assert(pg_temp.chk_land(1354, 'x2', 'x3', '{"state":"none"}', 'wide') = pg_temp.rec_answer('recorded', 6)
		and pg_temp.chk_land(1355, 'v1', 'x1', pg_temp.chk_ok(pg_temp.chk_passed('x1')), 'wide', false) = pg_temp.rec_answer('late', null)
		and pg_temp.rec_is(5, 'found', 'landed', 'v1', 'x2', 'wide') and pg_temp.chk_said(5, 'wide') = pg_temp.chk_none(),
		'a late landing does not take a filler that goes on: ' || pg_temp.chk_said(5, 'wide')::text);
	perform pg_temp.base_assert(pg_temp.req_undone('chk-wide-2', 6, true, 'x3', 'v2', '{}', 'wide') = pg_temp.req_recorded(7)
		and current_setting('qorpera_test.req_item')::jsonb -> 'change' ->> 'mainBefore' = pg_temp.rec_sha('x2')
		and pg_temp.chk_said(7, 'wide') = pg_temp.chk_as('not_run'),
		'andLater back to the end of such a row: ' || pg_temp.chk_said(7, 'wide')::text);
	v_bundle := '20261111T060000Z-' || repeat('f', 12);
	v := pg_temp.req_restore_to(v_bundle, 'x2', 'wide', 'v2');
	perform pg_temp.base_assert(v ->> 'change' = '8' and v -> 'keptThrough' = '5' and pg_temp.chk_said(8, 'wide') = pg_temp.chk_as('not_run')
		and pg_temp.req_restore_end(v_bundle, 'x2') = pg_temp.req_recorded(8), 'a restore to the end of such a row: ' || v::text);

	-- company/late: an undo's finish that comes late, after a landing reported late took over the filler that covers the
	-- undo and itself (1211's company/eight, change 10). The landing's checks passed; the row becomes the undo's, and
	-- says what the undo's checks are, not the landing's.
	perform pg_temp.base_assert(pg_temp.chk_land(1350, 'l0', 'l1', pg_temp.chk_ok(pg_temp.chk_passed('l1')), 'late')
			= pg_temp.rec_answer('recorded', 1)
		and pg_temp.chk_land(1351, 'l1', 'l2', pg_temp.chk_ok(pg_temp.chk_passed('l2')), 'late') = pg_temp.rec_answer('recorded', 2),
		'late''s changes');
	v_id := (pg_temp.req_undo('chk-late-1', 2, false, '{}', 'late') ->> 'requestId')::uuid;
	select item into v_item from jsonb_array_elements(pg_temp.req_claim()) item where item ->> 'requestId' = v_id::text;
	-- The undo's job moved main from l2 to m2 (not heard); a landing went from m2 to l3 (not heard either); the next
	-- landing leaves a filler from l2 to l3; then the first landing's report comes and takes that filler, passed.
	perform pg_temp.base_assert(pg_temp.chk_land(1352, 'l3', 'l4', '{"state":"none"}', 'late') = pg_temp.rec_answer('recorded', 4)
		and pg_temp.rec_is(3, 'found', 'landed', 'l2', 'l3', 'late')
		and pg_temp.chk_land(1353, 'm2', 'l3', pg_temp.chk_ok(pg_temp.chk_passed('l3')), 'late', false) = pg_temp.rec_answer('adopted', 3)
		and pg_temp.chk_said(3, 'late') = jsonb_build_object('state', 'passed', 'checks', pg_temp.chk_passed('l3')),
		'a late landing takes the filler, passed');
	v := pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_moved('l2', 'm2'));
	perform pg_temp.base_assert(v = pg_temp.req_recorded(3) and pg_temp.rec_is(3, 'undo', 'landed', 'l2', 'l3', 'late')
		and (pg_temp.rec_row(3, 'late')).undoes = array[2] and pg_temp.chk_said(3, 'late') = pg_temp.chk_as('not_run'),
		'the undo''s row: ' || v::text || ' ' || pg_temp.chk_said(3, 'late')::text);

	-- The same for an undo with every later change (review round 1 of this step, F1). Change 5 passed (l4 to l5) and
	-- change 6 had no checks file (l5 to l6). The undo of change 6 and all after it moved main from l6 to n1, back to
	-- l5's files, and its finish was not heard. A landing nobody recorded went from n1 to n2, and the next landing in
	-- line left a filler from l6 to n2. The undo's finish takes that filler: the row ends at n2, with the unrecorded
	-- landing's files, which no check ran on. It does not inherit change 5's checks.
	perform pg_temp.base_assert(pg_temp.chk_land(1356, 'l4', 'l5', pg_temp.chk_ok(pg_temp.chk_passed('l5')), 'late')
			= pg_temp.rec_answer('recorded', 5)
		and pg_temp.chk_land(1357, 'l5', 'l6', '{"state":"none"}', 'late') = pg_temp.rec_answer('recorded', 6), 'late''s later changes');
	v_id := (pg_temp.req_undo('chk-late-2', 6, true, '{}', 'late') ->> 'requestId')::uuid;
	select item into v_item from jsonb_array_elements(pg_temp.req_claim()) item where item ->> 'requestId' = v_id::text;
	perform pg_temp.base_assert(v_item -> 'change' ->> 'mainBefore' = pg_temp.rec_sha('l5')
		and pg_temp.chk_land(1358, 'n2', 'l7', '{"state":"none"}', 'late') = pg_temp.rec_answer('recorded', 8)
		and pg_temp.rec_is(7, 'found', 'landed', 'l6', 'n2', 'late'), 'a filler over the undo and the landing after it');
	v := pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_moved('l6', 'n1'));
	perform pg_temp.base_assert(v = pg_temp.req_recorded(7) and pg_temp.rec_is(7, 'undo', 'landed', 'l6', 'n2', 'late')
		and (pg_temp.rec_row(7, 'late')).undoes = array[6] and (pg_temp.rec_row(7, 'late')).own_after = pg_temp.rec_sha('n1')
		and pg_temp.chk_said(7, 'late') = pg_temp.chk_as('not_run'),
		'a late undo of a range that took a wider filler: ' || v::text || ' ' || pg_temp.chk_said(7, 'late')::text);
end $$;

-- 6. Restore ----------------------------------------------------------------------------------------------------------
-- company/kept: change 1 passed, 2 had no checks file, 3 passed.
do $$
declare v jsonb; v_bundle text;
begin
	perform pg_temp.base_assert(pg_temp.chk_land(1360, 'r0', 'r1', pg_temp.chk_ok(pg_temp.chk_passed('r1')), 'kept')
			= pg_temp.rec_answer('recorded', 1)
		and pg_temp.chk_land(1361, 'r1', 'r2', '{"state":"none"}', 'kept') = pg_temp.rec_answer('recorded', 2)
		and pg_temp.chk_land(1362, 'r2', 'r3', pg_temp.chk_ok(pg_temp.chk_passed('r3')), 'kept') = pg_temp.rec_answer('recorded', 3),
		'kept''s changes');
	-- Back to where change 1 put main: its checks passed, so the restore inherits them.
	v_bundle := '20261111T010000Z-' || repeat('a', 12);
	v := pg_temp.req_restore_to(v_bundle, 'r1', 'kept', 'r3');
	perform pg_temp.base_assert(v ->> 'change' = '4' and v -> 'keptThrough' = '1'
		and pg_temp.rec_is(4, 'restore', 'landed', 'r3', 'r1', 'kept') and pg_temp.chk_said(4, 'kept') = pg_temp.chk_as('inherited', 1)
		and pg_temp.req_restore_end(v_bundle, 'r1') = pg_temp.req_recorded(4), 'back to a passed row: ' || v::text);
	-- To where change 2 put main, with no checks file: not run.
	v_bundle := '20261111T020000Z-' || repeat('b', 12);
	v := pg_temp.req_restore_to(v_bundle, 'r2', 'kept', 'r1');
	perform pg_temp.base_assert(v ->> 'change' = '5' and v -> 'keptThrough' = '2' and pg_temp.chk_said(5, 'kept') = pg_temp.chk_as('not_run')
		and pg_temp.req_restore_end(v_bundle, 'r2') = pg_temp.req_recorded(5), 'to a none row: ' || v::text);
	-- Forward again to change 3: inherited from it.
	v_bundle := '20261111T030000Z-' || repeat('c', 12);
	v := pg_temp.req_restore_to(v_bundle, 'r3', 'kept', 'r2');
	perform pg_temp.base_assert(v ->> 'change' = '6' and v -> 'keptThrough' = '3' and pg_temp.chk_said(6, 'kept') = pg_temp.chk_as('inherited', 3)
		and pg_temp.req_restore_end(v_bundle, 'r3') = pg_temp.req_recorded(6), 'forward to a passed row: ' || v::text);
	-- company/back to where its change 7 put main: an undo that inherited its checks, so the restore inherits them too.
	v_bundle := '20261111T050000Z-' || repeat('e', 12);
	v := pg_temp.req_restore_to(v_bundle, 'u3', 'back', 'u4');
	perform pg_temp.base_assert(v ->> 'change' = '10' and v -> 'keptThrough' = '7'
		and pg_temp.chk_said(10, 'back') = pg_temp.chk_as('inherited', 7)
		and pg_temp.req_restore_end(v_bundle, 'u3') = pg_temp.req_recorded(10), 'back to an inherited row: ' || v::text);
	-- Two rows have put main at u3 now, both vouched for: an undo back to it names the newer.
	perform pg_temp.base_assert(pg_temp.chk_land(1348, 'u3', 'b6', '{"state":"none"}', 'back') = pg_temp.rec_answer('recorded', 11)
		and pg_temp.req_undone('chk-undo-5', 11, true, 'b6', 'u5', '{}', 'back') = pg_temp.req_recorded(12)
		and pg_temp.chk_said(12, 'back') = pg_temp.chk_as('inherited', 10), 'the newest of two: ' || pg_temp.chk_said(12, 'back')::text);
	-- A commit no row put main at: nothing vouches for it.
	v_bundle := '20261111T040000Z-' || repeat('d', 12);
	v := pg_temp.req_restore_to(v_bundle, 'r9', 'kept', 'r3');
	perform pg_temp.base_assert(v ->> 'change' = '7' and v ->> 'boundary' = 'unknown' and pg_temp.chk_said(7, 'kept') = pg_temp.chk_as('not_run')
		and pg_temp.req_restore_end(v_bundle, 'r9') = pg_temp.req_recorded(7), 'to an unknown commit: ' || v::text);
end $$;

-- 7. The platform's line after a landing --------------------------------------------------------------------------------
do $$
declare w uuid;
begin
	-- Passed: their names, in the file's order.
	w := pg_temp.rec_turn(1370, 1, pg_temp.rec_sha('d1'), '{}', pg_temp.own_repo('company', 'said'));
	perform pg_temp.base_assert(pg_temp.rec_record(w, pg_temp.chk_report('landed', pg_temp.rec_sha('d1'), pg_temp.rec_sha('d0'),
		pg_temp.rec_sha('d1'), pg_temp.chk_ok(pg_temp.chk_passed('d1')))) = pg_temp.rec_answer('recorded', 1)
		and pg_temp.chk_complete(w, 'd1') = pg_temp.chk_line('d1', 1, ' Its checks passed: install, test.'),
		'passed: ' || (select result ->> 'summary' from public.qorpera_runtime_workers where id = w));
	-- No checks file.
	w := pg_temp.rec_turn(1371, 1, pg_temp.rec_sha('d2'), '{}', pg_temp.own_repo('company', 'said'));
	perform pg_temp.base_assert(pg_temp.rec_record(w, pg_temp.chk_report('landed', pg_temp.rec_sha('d2'), pg_temp.rec_sha('d1'),
		pg_temp.rec_sha('d2'), '{"state":"none"}')) = pg_temp.rec_answer('recorded', 2)
		and pg_temp.chk_complete(w, 'd2') = pg_temp.chk_line('d2', 2, ' The repository has no checks file (.qorpera/checks.json), '
			|| 'so nothing checked this change: have the next change add one.'),
		'none: ' || (select result ->> 'summary' from public.qorpera_runtime_workers where id = w));
	-- Switched off.
	w := pg_temp.rec_turn(1372, 1, pg_temp.rec_sha('d3'), '{}', pg_temp.own_repo('company', 'said'));
	perform pg_temp.base_assert(pg_temp.rec_record(w, pg_temp.chk_report('landed', pg_temp.rec_sha('d3'), pg_temp.rec_sha('d2'),
		pg_temp.rec_sha('d3'), '{"state":"off"}')) = pg_temp.rec_answer('recorded', 3)
		and pg_temp.chk_complete(w, 'd3') = pg_temp.chk_line('d3', 3,
			' Checks are switched off for this repository, so nothing checked this change.'),
		'off: ' || (select result ->> 'summary' from public.qorpera_runtime_workers where id = w));
	-- A v1 report: 2b's line alone. And a turn with no row: the line of before 2b.
	w := pg_temp.rec_turn(1373, 1, pg_temp.rec_sha('d4'), '{}', pg_temp.own_repo('company', 'said'));
	perform pg_temp.base_assert(pg_temp.rec_record(w, pg_temp.rec_report('landed', pg_temp.rec_sha('d4'), pg_temp.rec_sha('d3'),
		pg_temp.rec_sha('d4'))) = pg_temp.rec_answer('recorded', 4)
		and pg_temp.chk_complete(w, 'd4') = pg_temp.chk_line('d4', 4, ''),
		'v1: ' || (select result ->> 'summary' from public.qorpera_runtime_workers where id = w));
	w := pg_temp.rec_turn(1374, 1, pg_temp.rec_sha('d5'), '{}', pg_temp.own_repo('company', 'said'));
	perform pg_temp.base_assert(pg_temp.chk_complete(w, 'd5') = pg_temp.chk_line('d5', null, ''),
		'no row: ' || (select result ->> 'summary' from public.qorpera_runtime_workers where id = w));
end $$;

-- 8. The failure words and the rounds ------------------------------------------------------------------------------------
do $$
declare w public.qorpera_runtime_workers%rowtype; v jsonb;
	-- The executor's words for each code (C1's), the failed one with output that names a code of its own.
	v_failed constant text := 'Nothing went into main: the check "test" failed on this change. It ran `npm test` and ended '
		|| E'with exit code 1 after 41 s. The end of its output:\n\n    # FAIL src/cart.test.ts\n    expected [code=NOT_THIS] '
		|| E'to be fine\n\nIts whole output is in ~/.qorpera-checks/out/2-test.log on the session''s machine. Checks that '
		|| 'passed before it: install. Fix the cause in the code, never by removing or weakening the check or its tests; '
		|| 'run the checks yourself from a clean copy, commit and finish again.';
	v_refused constant text := 'Nothing went into main: the repository''s checks file, .qorpera/checks.json, is gone in this '
		|| 'change, and a repository that has checks keeps them. Fix the file, commit and finish again.';
	v_not_run constant text := 'Nothing went into main: Qorpera could not run the repository''s checks on this change (the '
		|| 'session''s machine stopped). This is not a fault in the code. The work is kept on the session''s branch; '
		|| 'finishing again runs the checks again.';
	v_moved constant text := 'Nothing went into main yet: main changed twice while this change''s checks ran, so they never '
		|| 'ran on what would go in. This is not a fault in the code. The work is kept on the session''s branch; finishing '
		|| 'again checks it once more.';
	v_two constant text := ' The checks failed for this session 2 times in a row.';
	v_long text := repeat(repeat('x', 63) || E'\n', 60) || repeat('y', 100);
begin
	-- Each code keeps the executor's words, without the code, and the code is the reason: in the result, the failed
	-- event and the turn's outcome. A failure counts the rounds; checks that could not run or met a moving main are
	-- passed over and count none.
	perform pg_temp.base_assert(pg_temp.chk_fail(1380, 1, v_failed || ' [code=CODING_CHECKS_FAILED]')
		= pg_temp.chk_failed(v_failed, 'CODING_CHECKS_FAILED'), 'failed, the first round');
	perform pg_temp.base_assert(pg_temp.chk_fail(1380, 2, v_not_run || ' [code=CODING_CHECKS_DID_NOT_RUN]')
		= pg_temp.chk_failed(v_not_run, 'CODING_CHECKS_DID_NOT_RUN'), 'could not run');
	v := pg_temp.chk_fail(1380, 3, v_refused || ' [code=CODING_CHECKS_REFUSED]');
	perform pg_temp.base_assert(v = pg_temp.chk_failed(v_refused || v_two, 'CODING_CHECKS_REFUSED'), 'refused, the second round: ' || v::text);
	perform pg_temp.base_assert(pg_temp.chk_fail(1380, 4, v_moved || ' [code=CODING_CHECKS_MAIN_MOVED]')
		= pg_temp.chk_failed(v_moved, 'CODING_CHECKS_MAIN_MOVED'), 'main moved');
	v := pg_temp.chk_fail(1380, 5, v_failed || ' [code=CODING_CHECKS_FAILED]');
	perform pg_temp.base_assert(v = pg_temp.chk_failed(v_failed || ' The checks failed for this session 3 times in a row: '
		|| 'instead of another follow-up that tries again, narrow the change or drop it.', 'CODING_CHECKS_FAILED'),
		'the third round: ' || v::text);
	v := pg_temp.chk_fail(1380, 6, v_failed || ' [code=CODING_CHECKS_FAILED]');
	perform pg_temp.base_assert(v = pg_temp.chk_failed(v_failed || ' The checks failed for this session 4 times in a row: '
		|| 'instead of another follow-up that tries again, narrow the change or drop it.', 'CODING_CHECKS_FAILED'),
		'the fourth round: ' || v::text);
	-- A turn that succeeded ends the rounds.
	perform pg_temp.chk_ending(pg_temp.rec_turn(1380, 7, pg_temp.rec_sha('f7'), '{}', pg_temp.own_repo('company', 'said')));
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_coding_turn(pg_temp.rec_copy(1380), pg_temp.rec_token(), 'succeeded', 'Fixed.');
	perform pg_temp.base_assert(pg_temp.chk_fail(1380, 8, v_failed || ' [code=CODING_CHECKS_FAILED]')
		= pg_temp.chk_failed(v_failed, 'CODING_CHECKS_FAILED'), 'reset by a turn that succeeded');
	-- Any other code is as before (no run here, so its words stay), and ends the rounds too.
	perform pg_temp.base_assert(pg_temp.chk_fail(1380, 9, 'Broke. [code=CODING_SOMETHING_ELSE]')
		= pg_temp.chk_failed('Broke. [code=CODING_SOMETHING_ELSE]', 'CODING_SOMETHING_ELSE'), 'another code');
	perform pg_temp.base_assert(pg_temp.chk_fail(1380, 10, v_failed || ' [code=CODING_CHECKS_FAILED]')
		= pg_temp.chk_failed(v_failed, 'CODING_CHECKS_FAILED'), 'reset by another code');
	-- The second round in words that would not fit the 4000 bytes the results file keeps, one more per line, with it:
	-- the words alone.
	perform pg_temp.base_assert(octet_length(v_long || v_two) <= 4000
		and octet_length(v_long || v_two) + cardinality(string_to_array(v_long || v_two, E'\n')) > 4000
		and pg_temp.chk_fail(1380, 11, v_long || ' [code=CODING_CHECKS_FAILED]') = pg_temp.chk_failed(v_long, 'CODING_CHECKS_FAILED'),
		'no room for the round');
	v := pg_temp.chk_fail(1380, 12, v_refused || ' [code=CODING_CHECKS_REFUSED]');
	perform pg_temp.base_assert(v = pg_temp.chk_failed(v_refused || ' The checks failed for this session 3 times in a row: '
		|| 'instead of another follow-up that tries again, narrow the change or drop it.', 'CODING_CHECKS_REFUSED'),
		'the third round after it: ' || v::text);
	-- A code of the checks that is not at the end of the words is as before; a summary that is only the code keeps it.
	select * into w from public.qorpera_runtime_workers where id = pg_temp.rec_copy(1380);
	perform pg_temp.base_assert(public.qorpera_coding_turn_failure(w, 'It said [code=CODING_CHECKS_FAILED] and more.')
			= '{"reason":"CODING_CHECKS_FAILED","summary":"It said [code=CODING_CHECKS_FAILED] and more."}'
		and public.qorpera_coding_turn_failure(w, '[code=CODING_CHECKS_MAIN_MOVED]')
			= '{"reason":"CODING_CHECKS_MAIN_MOVED","summary":"[code=CODING_CHECKS_MAIN_MOVED]"}', 'the code not at the end');
end $$;

do $$
declare h text := pg_temp.rec_sha('sp-h'); a text := pg_temp.rec_sha('sp-a'); b text := pg_temp.rec_sha('sp-b');
	v_skip_ok jsonb := pg_temp.chk_passed('sp-a', 'fast-forward',
		'{"checks":[{"name":"lint","run":"npm run lint","ms":1200},{"name":"web","run":"npm test","ms":0,"skipped":"paths_unmatched"}]}'::jsonb);
	v_skip_bad_val jsonb := pg_temp.chk_passed('sp-a', 'fast-forward',
		'{"checks":[{"name":"web","run":"npm test","ms":0,"skipped":"manual"}]}'::jsonb);
	v_skip_bad_type jsonb := pg_temp.chk_passed('sp-a', 'fast-forward',
		'{"checks":[{"name":"web","run":"npm test","ms":0,"skipped":true}]}'::jsonb);
begin
	perform pg_temp.base_assert(public.qorpera_code_change_report_valid(
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(v_skip_ok))), 'skipped paths_unmatched is valid');
	perform pg_temp.base_assert(not public.qorpera_code_change_report_valid(
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(v_skip_bad_val))), 'unknown skipped reason rejected');
	perform pg_temp.base_assert(not public.qorpera_code_change_report_valid(
		pg_temp.chk_report('landed', h, b, a, pg_temp.chk_ok(v_skip_bad_type))), 'non-string skipped rejected');
end $$;
