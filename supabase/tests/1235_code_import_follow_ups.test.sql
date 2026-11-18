-- @fixture 1229_code_import.test.sql until "-- 1. Rights, the tables' rules, the native host's list"
-- The import's follow-ups (migration 20260930741000). 1229's helpers (1211's fixture, 1210's helpers before it):
-- company/shop, exec-1170 on machine 5…5 holding the company, Alice's own company run (Alice …30; Bob …31, Carol …32).
--   1. Rights: the table and the new functions are no API role's; a telling goes with its import; the markers.
--   2. The look's lines: taken with and without, every rule alone; a look at every bound fits its 16,000 bytes.
--   3. Code brought in: the record keeps lines when some came (not for none, not for a look without the key), and drops
--      entries of shown from the end to keep the column's 2,048 bytes; the list's otherWork; the record files' list
--      says imported for 30 days.
--   4. The open work: codeBroughtIn, told once to every agent but the one that asked, 7 days, at most 8, oldest first,
--      the same run again, a run with no agent, a private run refused as before, a telling gone with its import.
--   5. The agent's read: file, for a file brought in, with the folder entry's version while the file is still the bytes
--      the import read (the version company_read reports and company_delete takes); null for GitHub, before the end
--      and for a look.
--   6. Races on two connections (committed, removed at the end): two runs of one agent at once, one is told; and when
--      the first does not commit, the other is.

-- The other lines of work a look measured, and one of them.
create function pg_temp.fu_lines(p_count bigint, p_changes bigint, p_shown jsonb default '[]') returns jsonb
language sql immutable as $$
	select jsonb_build_object('count', p_count, 'changes', p_changes, 'shown', p_shown)
$$;
create function pg_temp.fu_line(p_name text, p_ahead integer, p_behind integer default 0,
	p_last text default '2026-11-01T10:00:00Z', p_fits boolean default true) returns jsonb language sql immutable as $$
	select jsonb_build_object('name', p_name, 'ahead', p_ahead, 'behind', p_behind, 'lastAt', p_last, 'fits', p_fits)
$$;
-- Whether the look takes these lines.
create function pg_temp.fu_takes(p_lines jsonb) returns boolean language sql as $$
	select public.qorpera_code_import_look_valid(pg_temp.imp_look(jsonb_build_object('lines', p_lines)))
$$;
-- Ten lines with names of 200 bytes, most ahead first. The names are of quotes, each 2 bytes of JSON text (B's widest:
-- 400 bytes a name as JSON): a jsonb value keeps a string's own bytes, so the kernel's bounds count 200.
create function pg_temp.fu_ten() returns jsonb language sql immutable as $$
	select jsonb_agg(jsonb_build_object('name', lpad(n::text, 200, '"'), 'ahead', 40 - n, 'behind', n * 1000,
		'lastAt', '2026-11-01T10:00:00.123456+01:00', 'fits', case n % 3 when 0 then true when 1 then false end) order by n)
	from generate_series(1, 10) n
$$;
-- A look at every bound: every count of 15 digits, the longest times, 30 strings shown with 200-byte paths and 40-letter
-- kinds, 10 refused paths, the longest default branch, biggest path and codes, and ten lines with 200-byte names.
create function pg_temp.fu_widest() returns jsonb language sql as $$
	select pg_temp.imp_look(jsonb_build_object('defaultBranch', repeat('b', 200),
		'bytes', 999999999999999, 'commits', 999999999999999, 'authors30d', 999999999999999, 'leftOut', 999999999999999,
		'files', 999999999999999, 'entries', 999999999999999, 'submodules', 999999999999999,
		'firstAt', '2026-11-01T10:00:00.123456+01:00', 'lastAt', '2026-11-01T10:00:00.123456+01:00',
		'tags', '{"seen":999999999999999,"kept":999999999999999}'::jsonb,
		'branches', '{"seen":999999999999999,"kept":999999999999999}'::jsonb,
		'lfs', '{"pointers":999999999999999}'::jsonb,
		'biggest', jsonb_build_object('path', repeat('"', 200), 'bytes', 999999999999999),
		'refused', jsonb_build_object('code', 'IMPORT_' || repeat('X', 100), 'paths',
			(select jsonb_agg(lpad(n::text, 200, '\')) from generate_series(1, 10) n), 'more', 999999999999999),
		'secrets', jsonb_build_object('found', 999999999999999, 'shown', (select jsonb_agg(jsonb_build_object(
				'kind', 'k' || repeat('y', 39), 'path', lpad(n::text, 200, '"'), 'inMain', true)) from generate_series(1, 30) n),
			'scan', '{"blobs":999999999999999,"bytes":999999999999999,"all":true}'::jsonb),
		'why', 'IMPORT_' || repeat('W', 100), 'fits', false,
		'lines', pg_temp.fu_lines(200, 999999999999999, pg_temp.fu_ten())))
$$;
-- An import from the agent's (or a member's) ask to the executor's finish, as 1229 runs one: claimed, fetched, let go to
-- look, looked (after p_refused, a look the kernel must refuse, when given), closed, recorded and in; or, asked to look
-- only, looked. Before the end the agent's read names no file. Answers the request.
create function pg_temp.fu_life(p_key text, p_name text, p_from jsonb, p_look jsonb, p_member boolean default false,
	p_refused jsonb default null, p_look_only boolean default false) returns uuid language plpgsql as $$
declare v jsonb; v_id uuid; v_item jsonb; v_token uuid;
begin
	perform pg_temp.req_quiet();
	v := case when p_member then pg_temp.imp_member('92400000-0000-4000-8000-000000000001', 'company', p_name, p_from ->> 'github')
		else pg_temp.imp_ask(p_key, 'company', p_name, p_from, p_look_only) end;
	perform pg_temp.base_assert(v ->> 'state' = 'queued', p_name || ' is asked for: ' || v::text);
	v_id := (v ->> 'requestId')::uuid;
	v_item := pg_temp.imp_claim(array['import']) -> 0;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text, p_name || ' is claimed: ' || coalesce(v_item::text, 'none'));
	v_token := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_token, '{"step":"fetch"}') ->> 'state' = 'go'
		and pg_temp.req_step(v_id, v_token, jsonb_build_object('step', 'look', 'raw', pg_temp.imp_raw())) ->> 'state' = 'go',
		p_name || ' is fetched and let go to look');
	if p_refused is not null then
		perform pg_temp.imp_error(p_name || '''s refused look', format('select pg_temp.imp_looked(%L, %L, %L)', v_id, v_token,
			p_refused), '22023', 'Code import look invalid');
	end if;
	perform pg_temp.base_assert(pg_temp.imp_looked(v_id, v_token, p_look) ->> 'state' = 'recorded', p_name || ' is looked at');
	if p_look_only then
		perform pg_temp.base_assert(pg_temp.req_finish(v_id, v_token, pg_temp.req_outcome('{"state":"done","result":"looked"}'))
			= pg_temp.req_recorded(null), p_name || ' is looked at only');
		return v_id;
	end if;
	perform pg_temp.req_step(v_id, v_token, jsonb_build_object('step', 'close', 'kept', pg_temp.imp_kept()));
	perform pg_temp.base_assert(pg_temp.imp_record(v_id, v_token, pg_temp.imp_imported()) ->> 'state' = 'recorded',
		p_name || ' is recorded');
	perform pg_temp.base_assert(pg_temp.imp_read(v_id) -> 'file' = 'null'::jsonb and pg_temp.imp_read(v_id) ->> 'state' = 'running',
		p_name || ': no file before the end: ' || pg_temp.imp_read(v_id)::text);
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, v_token, pg_temp.imp_outcome()) = pg_temp.req_recorded(1),
		p_name || ' is in');
	return v_id;
end $$;
-- What the registry row of a GitHub repository brought in by p_id says it came from, without lines.
create function pg_temp.fu_from(p_id uuid) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'github', 'repository', q.input -> 'from' ->> 'github', 'via', q.input ->> 'via',
		'branch', q.look -> 'defaultBranch', 'commit', pg_temp.rec_sha('m1'), 'commits', q.look -> 'commits')
	from public.qorpera_code_requests q where q.id = p_id
$$;
-- A run of an agent, as the open work hands it to the take (only its id, agent and environment are read).
create function pg_temp.fu_take(p_run uuid, p_staff uuid, p_environment uuid default '92400000-0000-4000-8000-000000000020')
returns jsonb language sql as $$
	select public.qorpera_take_agent_code_imports(jsonb_populate_record(null::public.qorpera_execution_runs,
		jsonb_build_object('id', p_run, 'staff_agent_id', p_staff, 'environment_id', p_environment)))
$$;
-- The open work of Alice's own run, as the native host asks for it.
create function pg_temp.fu_open_work() returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_describe_agent_open_work(pg_temp.c3_alice());
end $$;
-- An import of this company that ended (p_state, p_result) at p_finished, asked by an agent (or a member when null),
-- with its registry row unless p_registry is false. Answers the request.
create function pg_temp.fu_ended(p_name text, p_finished timestamptz, p_agent uuid default null, p_state text default 'done',
	p_result text default 'imported', p_registry boolean default true,
	p_environment uuid default '92400000-0000-4000-8000-000000000020',
	p_profile uuid default '92400000-0000-4000-8000-000000000010') returns uuid language plpgsql as $$
declare v_id uuid;
begin
	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, state, by_kind, by_user_id,
		by_agent_id, finished_at, outcome)
	values (p_environment, 'company', p_name, p_profile, 'import', jsonb_build_object('from',
			jsonb_build_object('github', 'Acme/' || p_name), 'via', 'public', 'look', p_result = 'looked', 'maximumBytes', 1073741824),
		p_state, case when p_agent is null then 'member' else 'agent' end, '92400000-0000-4000-8000-000000000001', p_agent,
		p_finished, pg_temp.req_outcome(jsonb_build_object('state', p_state)
			|| case when p_result is not null then jsonb_build_object('result', p_result) else '{}'::jsonb end))
	returning id into v_id;
	if p_registry then
		insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, imported_from, imported_at)
		values (p_environment, p_profile, 'company', p_name, jsonb_build_object('kind', 'github', 'repository', 'Acme/' || p_name,
			'via', 'public', 'branch', 'main', 'commit', pg_temp.rec_sha(p_name), 'commits', 7), p_finished);
	end if;
	return v_id;
end $$;
-- The names a take or the open work lists, in its order.
create function pg_temp.fu_names(p_list jsonb) returns text language sql immutable as $$
	select coalesce(string_agg(item ->> 'name', ' ' order by n), '') from jsonb_array_elements(p_list) with ordinality t(item, n)
$$;
-- A file the platform saves in the company folder, its folders made first; over p_expected when given.
create function pg_temp.fu_put(p_key text, p_path text, p_text text, p_expected uuid default null) returns uuid
language plpgsql as $$
declare v_units jsonb := '[]'; v_folder text;
begin
	foreach v_folder in array array['code', 'code/_incoming', regexp_replace(p_path, '/[^/]*$', '')] loop
		if pg_temp.base_version(v_folder) is null then
			v_units := v_units || jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', v_folder)); end if;
	end loop;
	perform pg_temp.base_commit('{"kind":"platform"}', p_key, v_units || jsonb_build_array(jsonb_build_object('op', 'write',
		'path', p_path, 'file', pg_temp.base_stage(p_text))
		|| case when p_expected is not null then jsonb_build_object('expectedVersion', p_expected) else '{}'::jsonb end));
	return pg_temp.base_version(p_path);
end $$;

-- 1. Rights -------------------------------------------------------------------------------------------------------------
do $$
declare v_role text; v_function text;
begin
	perform pg_temp.base_assert((select relrowsecurity from pg_class where oid = 'public.qorpera_code_import_tellings'::regclass),
		'row level security is on');
	-- A telling goes with its import (and so with the company), and nothing stops that delete.
	perform pg_temp.base_assert((select count(*) from pg_constraint where conrelid = 'public.qorpera_code_import_tellings'::regclass
			and contype = 'f' and confdeltype = 'c' and confrelid = 'public.qorpera_code_requests'::regclass) = 1
		and (select count(*) from pg_constraint where conrelid = 'public.qorpera_code_import_tellings'::regclass and contype = 'f') = 1
		and not exists (select 1 from pg_trigger where tgrelid = 'public.qorpera_code_import_tellings'::regclass and not tgisinternal),
		'a telling goes with its import');
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(not has_table_privilege(v_role, 'public.qorpera_code_import_tellings',
			'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'the tellings are closed to ' || v_role);
		foreach v_function in array array['public.qorpera_code_import_lines_valid(jsonb,jsonb)',
			'public.qorpera_code_import_other_work(jsonb)',
			'public.qorpera_take_agent_code_imports(public.qorpera_execution_runs)'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_function, 'EXECUTE'), v_function || ' is internal: ' || v_role);
		end loop;
		-- The functions it changed keep their callers.
		perform pg_temp.base_assert(has_function_privilege(v_role, 'public.qorpera_describe_agent_open_work(jsonb)', 'EXECUTE')
				= (v_role = 'service_role')
			and has_function_privilege(v_role, 'public.qorpera_folder_code_import(jsonb,uuid)', 'EXECUTE') = (v_role = 'service_role')
			and has_function_privilege(v_role, 'public.qorpera_code_import_record(text,text,uuid,uuid,jsonb)', 'EXECUTE')
				= (v_role = 'service_role')
			and has_function_privilege(v_role, 'public.qorpera_list_code_repositories(uuid)', 'EXECUTE') = (v_role = 'authenticated')
			and not has_function_privilege(v_role, 'public.qorpera_code_import_look_valid(jsonb)', 'EXECUTE'),
			'the changed functions keep their callers: ' || v_role);
	end loop;
	perform pg_temp.base_assert((select prosecdef and proconfig = array['search_path=""'] from pg_proc
		where oid = 'public.qorpera_take_agent_code_imports(public.qorpera_execution_runs)'::regprocedure), 'the take is a definer');
end $$;

-- 2. The look's lines ---------------------------------------------------------------------------------------------------
-- Lines as codeImportLook writes them (B):
--   "lines":{"count":2,"changes":3,"shown":[{"name":"feature/a","ahead":3,"behind":1,"lastAt":"2026-11-01T10:00:00Z",
--     "fits":true},{"name":null,"ahead":1,"behind":0,"lastAt":null,"fits":null}]}
-- and what an import's record keeps of them in imported_from (the same, with entries of shown dropped from the end to
-- keep 2,048 bytes), the list's otherWork ({"lines":2,"changes":3}) and the open work's.
do $$
declare v_long text := repeat('ø', 100);
begin
	-- Taken: none at all (a look from before), none that came, some, at every bound, names not shown, an equal ahead.
	perform pg_temp.base_assert(public.qorpera_code_import_look_valid(pg_temp.imp_look()), 'a look without lines');
	perform pg_temp.base_assert(pg_temp.fu_takes(pg_temp.fu_lines(0, 0)), 'no other line came');
	perform pg_temp.base_assert(pg_temp.fu_takes(('{"count":2,"changes":3,"shown":[{"name":"feature/a","ahead":3,"behind":1,'
		'"lastAt":"2026-11-01T10:00:00Z","fits":true},{"name":null,"ahead":1,"behind":0,"lastAt":null,"fits":null}]}')::jsonb),
		'B''s lines');
	perform pg_temp.base_assert(pg_temp.fu_takes(pg_temp.fu_lines(200, 999999999999999, pg_temp.fu_ten())), 'at every bound');
	perform pg_temp.base_assert(pg_temp.fu_takes(pg_temp.fu_lines(3, 2, '[]')), 'shown left out, more lines than changes');
	perform pg_temp.base_assert(pg_temp.fu_takes(pg_temp.fu_lines(2, 2, jsonb_build_array(pg_temp.fu_line('a', 2),
		pg_temp.fu_line('b', 2, 5, '2026-11-01T10:00:00.5-03:30', false)))), 'an equal ahead, a time with an offset');
	perform pg_temp.base_assert(pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line(repeat('ø', 100), 1)))),
		'a name of 200 bytes');
	-- Refused, each alone.
	perform pg_temp.base_assert(not pg_temp.fu_takes('[]') and not pg_temp.fu_takes('"lines"') and not pg_temp.fu_takes('null'),
		'lines of another kind');
	perform pg_temp.base_assert(not pg_temp.fu_takes(pg_temp.fu_lines(0, 0) || '{"more":1}')
		and not pg_temp.fu_takes(pg_temp.fu_lines(0, 0) - 'shown') and not pg_temp.fu_takes(pg_temp.fu_lines(0, 0) - 'count')
		and not pg_temp.fu_takes(pg_temp.fu_lines(0, 0) - 'changes'), 'a key more or less');
	perform pg_temp.base_assert(not pg_temp.fu_takes('{"count":-1,"changes":0,"shown":[]}')
		and not pg_temp.fu_takes('{"count":1.5,"changes":1,"shown":[]}') and not pg_temp.fu_takes('{"count":"1","changes":1,"shown":[]}')
		and not pg_temp.fu_takes('{"count":1,"changes":"1","shown":[]}') and not pg_temp.fu_takes('{"count":1,"changes":null,"shown":[]}')
		and not pg_temp.fu_takes('{"count":1,"changes":1.5,"shown":[]}') and not pg_temp.fu_takes('{"count":0,"changes":-1,"shown":[]}')
		and not public.qorpera_code_import_lines_valid(pg_temp.fu_lines(1, 1), '1.5'),
		'counts that are not counts');
	perform pg_temp.base_assert(not pg_temp.fu_takes(pg_temp.fu_lines(201, 201)), 'more lines than were kept (200)');
	perform pg_temp.base_assert(public.qorpera_code_import_look_valid(pg_temp.imp_look(jsonb_build_object('branches',
			'{"seen":5,"kept":3}'::jsonb, 'lines', pg_temp.fu_lines(3, 3))))
		and not public.qorpera_code_import_look_valid(pg_temp.imp_look(jsonb_build_object('branches',
			'{"seen":5,"kept":3}'::jsonb, 'lines', pg_temp.fu_lines(4, 4)))), 'the look''s own branches.kept');
	perform pg_temp.base_assert(not pg_temp.fu_takes(pg_temp.fu_lines(1, 0)) and not pg_temp.fu_takes(pg_temp.fu_lines(0, 1)),
		'changes exactly when lines');
	perform pg_temp.base_assert(not pg_temp.fu_takes('{"count":1,"changes":1,"shown":{}}')
		and not pg_temp.fu_takes('{"count":1,"changes":1,"shown":null}'), 'shown of another kind');
	perform pg_temp.base_assert(not pg_temp.fu_takes(pg_temp.fu_lines(11, 40, pg_temp.fu_ten() || jsonb_build_array(pg_temp.fu_line('x', 1)))),
		'11 shown');
	perform pg_temp.base_assert(not pg_temp.fu_takes(pg_temp.fu_lines(2, 3, jsonb_build_array(pg_temp.fu_line('a', 3),
		pg_temp.fu_line('b', 2), pg_temp.fu_line('c', 1)))), 'more shown than lines');
	perform pg_temp.base_assert(not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, '["a"]'))
		and not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 1) || '{"more":1}')))
		and not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 1) - 'name')))
		and not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 1) - 'ahead')))
		and not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 1) - 'behind')))
		and not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 1) - 'lastAt')))
		and not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 1) - 'fits'))),
		'a line not of its shape');
	perform pg_temp.base_assert(not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('', 1))))
		and not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line(v_long || 'x', 1))))
		and not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 1) || '{"name":7}'))),
		'a name empty, over 200 bytes, or no string');
	perform pg_temp.base_assert(not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 0))))
		and not pg_temp.fu_takes(pg_temp.fu_lines(1, 3, jsonb_build_array(pg_temp.fu_line('a', 4))))
		and not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 1) || '{"ahead":"1"}')))
		and not pg_temp.fu_takes(pg_temp.fu_lines(1, 2, jsonb_build_array(pg_temp.fu_line('a', 1) || '{"ahead":1.5}'))),
		'ahead 0, over changes, or no count');
	perform pg_temp.base_assert(not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 1, -1))))
		and not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 1) || '{"behind":null}'))),
		'behind no count');
	perform pg_temp.base_assert(not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 1, 0, 'yesterday'))))
		and not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 1, 0, '2026-11-01'))))
		and not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 1) || '{"lastAt":1}'))),
		'a time of another form');
	perform pg_temp.base_assert(not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 1) || '{"fits":"yes"}')))
		and not pg_temp.fu_takes(pg_temp.fu_lines(1, 1, jsonb_build_array(pg_temp.fu_line('a', 1) || '{"fits":1}'))),
		'fits no boolean');
	perform pg_temp.base_assert(not pg_temp.fu_takes(pg_temp.fu_lines(2, 2, jsonb_build_array(pg_temp.fu_line('a', 1),
		pg_temp.fu_line('b', 2)))), 'the line most ahead comes first');
	-- What a member and an agent read of them: only a count of at least 1 is other work.
	perform pg_temp.base_assert(public.qorpera_code_import_other_work(jsonb_build_object('lines', pg_temp.fu_lines(2, 3)))
			= '{"lines":2,"changes":3}'
		and public.qorpera_code_import_other_work(jsonb_build_object('lines', pg_temp.fu_lines(0, 0))) is null
		and public.qorpera_code_import_other_work('{"lines":{"count":"2","changes":3}}') is null
		and public.qorpera_code_import_other_work('{"lines":{"count":true,"changes":3}}') is null
		and public.qorpera_code_import_other_work('{"kind":"github"}') is null and public.qorpera_code_import_other_work(null) is null,
		'other work');
	-- A look at every bound stays under the kernel's 16,000 bytes, with room to spare.
	perform pg_temp.base_assert(public.qorpera_code_import_look_valid(pg_temp.fu_widest())
		and pg_column_size(pg_temp.fu_widest()) <= 16000, format('the widest look: %s bytes', pg_column_size(pg_temp.fu_widest())));
end $$;

-- 2b. The looks the executor writes (the cross-check of the merged parts): what codeImportLook makes of no measure, a
-- measure that found no other line, one line, ten shown of twelve with names of 200 bytes (one of them with quotes,
-- one of two-byte letters), and a name not shown beside fits false and null and a time not shown, each taken whole and
-- within the 16,000 bytes qorpera_code_import_looked keeps; and lines this rule refuses. The lists between the markers
-- are shared: runner-orchestrator's test/code-import.test.ts makes each look from its facts with codeImportLook and
-- refuses each of the refused lines with codeImportLookOf (the executor's look always passes it, so it never writes
-- one), and runtime's test/cloud-company-folder-client.test.ts reads each look as the agent's read hands it on.
do $$
declare v text;
begin
	foreach v in array array[
-- BEGIN THE LOOKS PART B WRITES
	'{"schema":"qorpera.code-import-look/v1","bytes":2048,"defaultBranch":"main","mainSha":"cccccccccccccccccccccccccccccccccccccccc","commits":7,"firstAt":"2025-01-02T03:04:05Z","lastAt":"2026-11-12T10:00:00Z","authors30d":1,"tags":{"seen":1,"kept":1},"branches":{"seen":14,"kept":12},"leftOut":2,"files":9,"entries":11,"biggest":{"path":"README.md","bytes":300},"lfs":{"pointers":0},"submodules":0,"refused":{"code":null,"paths":[],"more":0},"secrets":{"found":0,"shown":[],"scan":{"blobs":9,"bytes":3000,"all":true}},"fits":true,"why":null}',
	'{"schema":"qorpera.code-import-look/v1","bytes":2048,"defaultBranch":"main","mainSha":"cccccccccccccccccccccccccccccccccccccccc","commits":7,"firstAt":"2025-01-02T03:04:05Z","lastAt":"2026-11-12T10:00:00Z","authors30d":1,"tags":{"seen":1,"kept":1},"branches":{"seen":14,"kept":12},"lines":{"count":0,"changes":0,"shown":[]},"leftOut":2,"files":9,"entries":11,"biggest":{"path":"README.md","bytes":300},"lfs":{"pointers":0},"submodules":0,"refused":{"code":null,"paths":[],"more":0},"secrets":{"found":0,"shown":[],"scan":{"blobs":9,"bytes":3000,"all":true}},"fits":true,"why":null}',
	'{"schema":"qorpera.code-import-look/v1","bytes":2048,"defaultBranch":"main","mainSha":"cccccccccccccccccccccccccccccccccccccccc","commits":7,"firstAt":"2025-01-02T03:04:05Z","lastAt":"2026-11-12T10:00:00Z","authors30d":1,"tags":{"seen":1,"kept":1},"branches":{"seen":14,"kept":12},"lines":{"count":1,"changes":2,"shown":[{"name":"feature/cart","ahead":2,"behind":3,"lastAt":"2025-11-12T14:00:00Z","fits":true}]},"leftOut":2,"files":9,"entries":11,"biggest":{"path":"README.md","bytes":300},"lfs":{"pointers":0},"submodules":0,"refused":{"code":null,"paths":[],"more":0},"secrets":{"found":0,"shown":[],"scan":{"blobs":9,"bytes":3000,"all":true}},"fits":true,"why":null}',
	'{"schema":"qorpera.code-import-look/v1","bytes":2048,"defaultBranch":"main","mainSha":"cccccccccccccccccccccccccccccccccccccccc","commits":7,"firstAt":"2025-01-02T03:04:05Z","lastAt":"2026-11-12T10:00:00Z","authors30d":1,"tags":{"seen":1,"kept":1},"branches":{"seen":14,"kept":12},"lines":{"count":12,"changes":90,"shown":[{"name":"feature/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ahead":12,"behind":1,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"øøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøøø","ahead":11,"behind":2,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"it''s \"q\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","ahead":10,"behind":3,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"04/yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy","ahead":9,"behind":4,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"05/yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy","ahead":8,"behind":5,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"06/yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy","ahead":7,"behind":6,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"07/yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy","ahead":6,"behind":7,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"08/yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy","ahead":5,"behind":8,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"09/yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy","ahead":4,"behind":9,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"10/yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy","ahead":3,"behind":10,"lastAt":"2025-11-12T14:00:00Z","fits":true}]},"leftOut":2,"files":9,"entries":11,"biggest":{"path":"README.md","bytes":300},"lfs":{"pointers":0},"submodules":0,"refused":{"code":null,"paths":[],"more":0},"secrets":{"found":0,"shown":[],"scan":{"blobs":9,"bytes":3000,"all":true}},"fits":true,"why":null}',
	'{"schema":"qorpera.code-import-look/v1","bytes":2048,"defaultBranch":"main","mainSha":"cccccccccccccccccccccccccccccccccccccccc","commits":7,"firstAt":"2025-01-02T03:04:05Z","lastAt":"2026-11-12T10:00:00Z","authors30d":1,"tags":{"seen":1,"kept":1},"branches":{"seen":14,"kept":12},"lines":{"count":3,"changes":3,"shown":[{"name":"release/1.x","ahead":2,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":false},{"name":null,"ahead":1,"behind":4,"lastAt":"2025-11-12T14:00:00Z","fits":null},{"name":"old-work","ahead":1,"behind":9,"lastAt":null,"fits":true}]},"leftOut":2,"files":9,"entries":11,"biggest":{"path":"README.md","bytes":300},"lfs":{"pointers":0},"submodules":0,"refused":{"code":null,"paths":[],"more":0},"secrets":{"found":0,"shown":[],"scan":{"blobs":9,"bytes":3000,"all":true}},"fits":true,"why":null}'
-- END THE LOOKS PART B WRITES
	] loop
		perform pg_temp.base_assert(public.qorpera_code_import_look_valid(v::jsonb) and pg_column_size(v::jsonb) <= 16000,
			'the executor''s look: ' || left(v, 400));
	end loop;
	foreach v in array array[
-- BEGIN LINES THE LOOK REFUSES
	'{"count":1,"changes":1,"shown":[{"name":"","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true}]}',
	'{"count":1,"changes":1,"shown":[{"name":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true}]}',
	'{"count":201,"changes":201,"shown":[]}',
	'{"count":1,"changes":0,"shown":[]}',
	'{"count":0,"changes":1,"shown":[]}',
	'{"count":1,"changes":1,"shown":[{"name":"a","ahead":0,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true}]}',
	'{"count":1,"changes":1,"shown":[{"name":"a","ahead":2,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true}]}',
	'{"count":2,"changes":3,"shown":[{"name":"a","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"b","ahead":2,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true}]}',
	'{"count":11,"changes":11,"shown":[{"name":"n00","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"n01","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"n02","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"n03","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"n04","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"n05","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"n06","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"n07","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"n08","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"n09","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"n10","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true}]}',
	'{"count":1,"changes":2,"shown":[{"name":"a","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true},{"name":"b","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true}]}',
	'{"count":1,"changes":1,"shown":[{"name":"a","ahead":1,"behind":0,"lastAt":"yesterday","fits":true}]}',
	'{"count":1,"changes":1,"shown":[{"name":"a","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":"yes"}]}',
	'{"count":0,"changes":0,"shown":[],"more":1}',
	'{"count":1,"changes":1,"shown":[{"name":"a","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z"}]}',
	'{"count":1,"changes":1,"shown":[{"name":"a","ahead":1,"behind":0,"lastAt":"2025-11-12T14:00:00Z","fits":true,"more":1}]}',
	'{"count":-1,"changes":0,"shown":[]}',
	'{"count":1.5,"changes":1,"shown":[]}',
	'{"count":"1","changes":1,"shown":[]}',
	'{"count":1,"changes":1,"shown":[{"name":"a","ahead":1,"behind":-1,"lastAt":"2025-11-12T14:00:00Z","fits":true}]}',
	'{"count":1,"changes":1,"shown":{}}'
-- END LINES THE LOOK REFUSES
	] loop
		perform pg_temp.base_assert(not pg_temp.fu_takes(v::jsonb), 'refused lines: ' || left(v, 400));
	end loop;
end $$;

-- 3. Code brought in -------------------------------------------------------------------------------------------------
-- Alice brings Acme/Mine in (no other line came); the owner brings Acme/Theirs in (two other lines); Alice brings
-- Acme/Big in (its look at every bound); Alice brings a bundle in from the folder (a look without lines).
do $$
declare v jsonb; v_mine uuid; v_theirs uuid; v_big uuid; v_bundle uuid; r public.qorpera_code_repositories%rowtype;
	v_lines jsonb := ('{"count":2,"changes":3,"shown":[{"name":"feature/a","ahead":3,"behind":1,'
		'"lastAt":"2026-11-01T10:00:00Z","fits":true},{"name":null,"ahead":1,"behind":0,"lastAt":null,"fits":null}]}')::jsonb;
	v_kept jsonb; v_shown integer; v_version uuid;
begin
	-- Before any code came in the open work has no such key.
	perform pg_temp.base_assert(not pg_temp.fu_open_work() ? 'codeBroughtIn', 'nothing brought in: ' || pg_temp.fu_open_work()::text);
	v_mine := pg_temp.fu_life('fu-mine', 'mine', pg_temp.imp_gh('Acme/Mine'),
		pg_temp.imp_look(jsonb_build_object('lines', pg_temp.fu_lines(0, 0))));
	v_theirs := pg_temp.fu_life(null, 'theirs', pg_temp.imp_gh('Acme/Theirs'), pg_temp.imp_look(jsonb_build_object('lines', v_lines)),
		true, pg_temp.imp_look(jsonb_build_object('lines', pg_temp.fu_lines(1, 0))));
	v_big := pg_temp.fu_life('fu-big', 'big', pg_temp.imp_gh('Acme/Big'), pg_temp.fu_widest());
	v_version := pg_temp.fu_put('fu-put-bundle', 'code/_incoming/fu/x.bundle', 'the bundle''s bytes');
	v_bundle := pg_temp.fu_life('fu-bundle', 'bundled', '{"file":"code/_incoming/fu/x.bundle"}', pg_temp.imp_look());
	perform set_config('qorpera_test.fu_ids', jsonb_build_object('mine', v_mine, 'theirs', v_theirs, 'big', v_big,
		'bundle', v_bundle)::text, false);

	-- The record: no lines when none came, or the look did not measure them; the look's lines when some came.
	perform pg_temp.base_assert((pg_temp.rec_shop('mine')).imported_from = pg_temp.fu_from(v_mine),
		'none came: ' || (pg_temp.rec_shop('mine')).imported_from::text);
	perform pg_temp.base_assert((pg_temp.rec_shop('theirs')).imported_from = pg_temp.fu_from(v_theirs) || jsonb_build_object('lines', v_lines),
		'two came: ' || (pg_temp.rec_shop('theirs')).imported_from::text);
	perform pg_temp.base_assert((pg_temp.rec_shop('bundled')).imported_from = jsonb_build_object('kind', 'file', 'name', 'x.bundle',
			'sha256', encode(extensions.digest(convert_to('the bundle''s bytes', 'utf8'), 'sha256'), 'hex'), 'branch', 'master',
			'commit', pg_temp.rec_sha('m1'), 'commits', 5210),
		'a look without lines: ' || (pg_temp.rec_shop('bundled')).imported_from::text);
	-- At every bound: count and changes stay, and as many of the first lines shown as fit 2,048 bytes.
	r := pg_temp.rec_shop('big');
	v_kept := r.imported_from -> 'lines';
	v_shown := jsonb_array_length(v_kept -> 'shown');
	perform pg_temp.base_assert(r.imported_from - 'lines' = pg_temp.fu_from(v_big)
		and v_kept -> 'count' = '200' and v_kept -> 'changes' = '999999999999999'
		and v_shown between 1 and 9 and v_kept -> 'shown' = (select jsonb_agg(line order by n) from jsonb_array_elements(
			pg_temp.fu_ten()) with ordinality t(line, n) where n <= v_shown)
		and pg_column_size(r.imported_from) <= 2048
		and pg_column_size(jsonb_set(r.imported_from, '{lines,shown}', (v_kept -> 'shown') || (pg_temp.fu_ten() -> v_shown))) > 2048,
		format('the first %s lines shown, %s bytes: %s', v_shown, pg_column_size(r.imported_from), r.imported_from::text));

	-- The list: other work beside the earlier changes, null where none came and for code begun here.
	v := pg_temp.req_list();
	perform pg_temp.base_assert((select jsonb_object_agg(e ->> 'name', e -> 'otherWork') from jsonb_array_elements(v -> 'repositories') e)
			= '{"shop":null,"mine":null,"theirs":{"lines":2,"changes":3},"big":{"lines":200,"changes":999999999999999},"bundled":null}'
		and (select e - 'downloads' from jsonb_array_elements(v -> 'repositories') e where e ->> 'name' = 'theirs')
			= jsonb_build_object('owner', 'company', 'name', 'theirs', 'changes', 1,
				'importedFrom', '{"kind":"github","repository":"Acme/Theirs"}'::jsonb,
				'importedAt', (pg_temp.rec_shop('theirs')).imported_at, 'earlierChanges', 5210,
				'otherWork', '{"lines":2,"changes":3}'::jsonb), 'the list: ' || v::text);

	-- The record files' list: for 30 days, when it came and the lines, beside what it lists.
	v := pg_temp.rec_files(p_name => 'theirs') -> 'index';
	perform pg_temp.base_assert(v -> 'imported' = jsonb_build_object('at', (pg_temp.rec_shop('theirs')).imported_at,
			'lines', v_lines) and v ? 'lines' and v ? 'version', 'the index of theirs: ' || coalesce(v::text, 'none'));
	perform pg_temp.base_assert(pg_temp.rec_files(p_name => 'big') -> 'index' -> 'imported' -> 'lines' = v_kept,
		'the index of big: what the record kept');
	perform pg_temp.base_assert(not (pg_temp.rec_files(p_name => 'mine') -> 'index') ? 'imported'
		and not (pg_temp.rec_files(p_name => 'bundled') -> 'index') ? 'imported'
		and jsonb_typeof(pg_temp.rec_files(p_name => 'mine') -> 'index') = 'object', 'no imported where no other line came');
	update public.qorpera_code_repositories set imported_at = clock_timestamp() - interval '29 days 23 hours'
	where environment_id = pg_temp.rec_here() and name = 'theirs';
	perform pg_temp.base_assert(pg_temp.rec_files(p_name => 'theirs') -> 'index' ? 'imported', 'still within 30 days');
	update public.qorpera_code_repositories set imported_at = clock_timestamp() - interval '30 days 1 minute'
	where environment_id = pg_temp.rec_here() and name = 'theirs';
	perform pg_temp.base_assert(not (pg_temp.rec_files(p_name => 'theirs') -> 'index') ? 'imported'
		and pg_temp.rec_files(p_name => 'theirs') -> 'index' ? 'lines', 'after 30 days');
	update public.qorpera_code_repositories set imported_at = (select finished_at from public.qorpera_code_requests where id = v_theirs)
	where environment_id = pg_temp.rec_here() and name = 'theirs';
end $$;

-- 4. The open work ------------------------------------------------------------------------------------------------------
do $$
declare v jsonb; v_ids jsonb := current_setting('qorpera_test.fu_ids')::jsonb; v_alice uuid := (pg_temp.c3_alice() ->> 'runId')::uuid;
	v_bob uuid := '92400000-0000-4000-8000-000000000031'; v_carol uuid := '92400000-0000-4000-8000-000000000032';
	v_dan uuid := '92400000-0000-4000-8000-000000000035'; v_id uuid; v_gone uuid;
begin
	-- Alice is told of what the owner brought in, not of what she brought in herself; the same run again, the same.
	v := pg_temp.fu_open_work();
	perform pg_temp.base_assert(v -> 'codeBroughtIn' = jsonb_build_array(jsonb_build_object('owner', 'company', 'name', 'theirs',
			'from', '{"github":"Acme/Theirs"}'::jsonb, 'by', 'member',
			'at', (pg_temp.req_row((v_ids ->> 'theirs')::uuid)).finished_at, 'earlierChanges', 5210,
			'otherWork', '{"lines":2,"changes":3}'::jsonb))
		and v ->> 'schema' = 'qorpera.agent-open-work/v1' and v ? 'todos' and v ? 'workers',
		'Alice is told of the owner''s: ' || v::text);
	perform pg_temp.base_assert(pg_temp.fu_open_work() -> 'codeBroughtIn' = v -> 'codeBroughtIn', 'the same run, the same');
	perform pg_temp.base_assert((select told_run_id from public.qorpera_code_import_tellings
		where request_id = (v_ids ->> 'theirs')::uuid and staff_agent_id = '92400000-0000-4000-8000-000000000030') = v_alice,
		'told in her run');
	-- Another run of hers is told of nothing again.
	perform pg_temp.base_assert(pg_temp.fu_take('12350000-0000-4000-8000-0000000001a2', '92400000-0000-4000-8000-000000000030') is null,
		'another run of Alice''s');
	-- Bob is told of all four, oldest first, Alice's as an agent's and the bundle by its name.
	v := pg_temp.fu_take('12350000-0000-4000-8000-0000000001b1', v_bob);
	perform pg_temp.base_assert(pg_temp.fu_names(v) = 'mine theirs big bundled'
		and v -> 0 = jsonb_build_object('owner', 'company', 'name', 'mine', 'from', '{"github":"Acme/Mine"}'::jsonb, 'by', 'agent',
			'at', (pg_temp.req_row((v_ids ->> 'mine')::uuid)).finished_at, 'earlierChanges', 5210, 'otherWork', null)
		and v -> 3 -> 'from' = '{"file":"x.bundle"}' and v -> 3 ->> 'by' = 'agent'
		and v -> 2 -> 'otherWork' = '{"lines":200,"changes":999999999999999}', 'Bob: ' || coalesce(v::text, 'none'));
	perform pg_temp.base_assert(pg_temp.fu_take('12350000-0000-4000-8000-0000000001b1', v_bob) = v
		and pg_temp.fu_take('12350000-0000-4000-8000-0000000001b2', v_bob) is null, 'Bob''s run again; his next run');
	-- A run with no agent, or no run, is told nothing and marks nothing.
	perform pg_temp.base_assert(pg_temp.fu_take('12350000-0000-4000-8000-0000000001c0', null) is null
		and pg_temp.fu_take(null, v_carol) is null
		and not exists (select 1 from public.qorpera_code_import_tellings where staff_agent_id = v_carol
			or told_run_id = '12350000-0000-4000-8000-0000000001c0'), 'no agent, no run');

	-- Carol: within 7 days, oldest first, at most 8 a run. Six more came in over the last days; what did not come in, what
	-- came in over 7 days ago, another company's, and one whose repository is not there are never told.
	perform pg_temp.fu_ended('d6', clock_timestamp() - interval '6 days 23 hours');
	perform pg_temp.fu_ended('d5', clock_timestamp() - interval '5 days', v_bob);
	perform pg_temp.fu_ended('d4', clock_timestamp() - interval '4 days');
	perform pg_temp.fu_ended('d3', clock_timestamp() - interval '3 days');
	perform pg_temp.fu_ended('d2', clock_timestamp() - interval '2 days', v_dan);
	perform pg_temp.fu_ended('d1', clock_timestamp() - interval '1 day');
	perform pg_temp.fu_ended('old', clock_timestamp() - interval '7 days 1 minute');
	perform pg_temp.fu_ended('looked', clock_timestamp() - interval '6 days', null, 'done', 'looked');
	perform pg_temp.fu_ended('refused', clock_timestamp() - interval '6 days', null, 'refused', null);
	perform pg_temp.fu_ended('failed', clock_timestamp() - interval '6 days', null, 'failed', 'imported');
	v_gone := pg_temp.fu_ended('gone', clock_timestamp() - interval '6 days', null, 'done', 'imported', false);
	-- (Nor one whose place holds a repository that was not brought in.)
	perform pg_temp.fu_ended('shop', clock_timestamp() - interval '6 days', p_registry => false);
	perform pg_temp.fu_ended('elsewhere', clock_timestamp() - interval '6 days', null, 'done', 'imported', true,
		'91170000-0000-4000-8000-000000000020', '91170000-0000-4000-8000-000000000010');
	-- (A request of another kind that says it brought code in, at a place brought in, is no import.)
	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, state, by_kind, finished_at, outcome)
	values (pg_temp.rec_here(), 'company', 'd4', '92400000-0000-4000-8000-000000000010', 'download',
		'{"file":"files","fileName":"shop.zip"}', 'done', 'member', clock_timestamp() - interval '6 days',
		pg_temp.req_outcome('{"state":"done","result":"imported"}'));
	v := pg_temp.fu_take('12350000-0000-4000-8000-0000000001d1', v_carol);
	perform pg_temp.base_assert(pg_temp.fu_names(v) = 'd6 d5 d4 d3 d2 d1 mine theirs', 'Carol''s first run: ' || coalesce(v::text, 'none'));
	-- Once a run was told of 8 it is told of no more, even of code that came in since.
	perform pg_temp.fu_ended('later', clock_timestamp());
	perform pg_temp.base_assert(pg_temp.fu_take('12350000-0000-4000-8000-0000000001d1', v_carol) = v, 'Carol''s first run again');
	perform pg_temp.base_assert(pg_temp.fu_names(pg_temp.fu_take('12350000-0000-4000-8000-0000000001d2', v_carol)) = 'big bundled later'
		and pg_temp.fu_take('12350000-0000-4000-8000-0000000001d3', v_carol) is null, 'Carol''s next runs');
	-- Dan asked for d2 himself; Bob for d5.
	perform pg_temp.base_assert(pg_temp.fu_names(pg_temp.fu_take('12350000-0000-4000-8000-0000000001e1', v_dan))
			= 'd6 d5 d4 d3 d1 mine theirs big'
		and pg_temp.fu_names(pg_temp.fu_take('12350000-0000-4000-8000-0000000001b3', v_bob)) = 'd6 d4 d3 d2 d1 later',
		'each but the one who asked');
	-- Alice's same run, asked again later: what it was told, and what came in since up to 8 (not hers); a private run of an
	-- agent is refused before anything is taken, as before.
	perform pg_temp.base_assert(pg_temp.fu_names(pg_temp.fu_open_work() -> 'codeBroughtIn') = 'd6 d5 d4 d3 d2 d1 theirs later',
		'Alice''s run, later: ' || (pg_temp.fu_open_work() -> 'codeBroughtIn')::text);
	begin
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_execution_runs set audience_kind = 'member_private',
			audience_user_id = '92400000-0000-4000-8000-000000000001' where id = v_alice;
		perform set_config('session_replication_role', 'origin', true);
		perform pg_temp.base_error(format('select public.qorpera_describe_agent_open_work(%L)', pg_temp.c3_alice()), '42501');
		raise exception 'fu-private-probe';
	exception when raise_exception then
		if sqlerrm <> 'fu-private-probe' then raise; end if;
	end;
	-- A telling goes with its import.
	v_id := (v_ids ->> 'theirs')::uuid;
	perform pg_temp.base_assert((select count(*) from public.qorpera_code_import_tellings where request_id = v_id) = 4
		and not exists (select 1 from public.qorpera_code_import_tellings where request_id = v_gone), 'theirs was told to four agents');
	delete from public.qorpera_code_requests where id = v_id;
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_code_import_tellings where request_id = v_id), 'gone with it');
end $$;

-- 5. The agent's read: the bundle a file import read -----------------------------------------------------------------
do $$
declare v jsonb; v_ids jsonb := current_setting('qorpera_test.fu_ids')::jsonb; v_bundle uuid := (v_ids ->> 'bundle')::uuid;
	v_path text := 'code/_incoming/fu/x.bundle'; v_first uuid := pg_temp.base_version('code/_incoming/fu/x.bundle');
	v_other uuid; v_back uuid; v_look uuid;
begin
	-- In, and the file still the bytes it read: its path, and the entry's version, the one company_read reports.
	v := pg_temp.imp_read(v_bundle);
	perform pg_temp.base_assert(v_first is not null and v = jsonb_build_object('schema', 'qorpera.code-import/v1',
			'requestId', v_bundle, 'owner', 'company', 'name', 'bundled', 'state', 'done', 'step', 'close', 'waiting', null,
			'look', pg_temp.imp_look(), 'result', 'imported', 'change', 1, 'code', null,
			'file', jsonb_build_object('path', v_path, 'version', v_first)), 'the read: ' || v::text);
	perform pg_temp.base_assert(public.qorpera_folder_read(pg_temp.rec_here(), pg_temp.base_owner(), v_path) -> 'entry' ->> 'version'
		= v_first::text, 'the version company_read reports');
	-- GitHub code has none; nor has a look of the same bundle.
	perform pg_temp.base_assert(pg_temp.imp_read((v_ids ->> 'mine')::uuid) -> 'file' = 'null'
		and pg_temp.imp_read((v_ids ->> 'big')::uuid) -> 'file' = 'null', 'GitHub: no file');
	v_look := pg_temp.fu_life('fu-bundle-look', 'lookbundle', jsonb_build_object('file', v_path), pg_temp.imp_look(), false, null, true);
	perform pg_temp.base_assert(pg_temp.imp_read(v_look) ->> 'result' = 'looked' and pg_temp.imp_read(v_look) -> 'file' = 'null',
		'a look: no file: ' || pg_temp.imp_read(v_look)::text);
	-- A delete on another version deletes nothing (company_delete's unit, as the folder takes it).
	v := public.qorpera_folder_commit(pg_temp.rec_here(), '{"kind":"platform"}', 'fu-delete-stale', jsonb_build_array(
		jsonb_build_object('op', 'delete', 'path', v_path, 'expectedVersion', extensions.gen_random_uuid())));
	perform pg_temp.base_assert(v -> 'units' -> 0 ->> 'outcome' = 'conflict' and v -> 'units' -> 0 ->> 'reason' = 'version_changed'
		and pg_temp.base_version(v_path) = v_first, 'another version: ' || v::text);
	-- Other bytes there: no version. The bundle's bytes again, as a new version: that version.
	v_other := pg_temp.fu_put('fu-put-other', v_path, 'other bytes', v_first);
	perform pg_temp.base_assert(v_other <> v_first
		and pg_temp.imp_read(v_bundle) -> 'file' = jsonb_build_object('path', v_path, 'version', null), 'other bytes');
	v_back := pg_temp.fu_put('fu-put-back', v_path, 'the bundle''s bytes', v_other);
	perform pg_temp.base_assert(pg_temp.imp_read(v_bundle) -> 'file' = jsonb_build_object('path', v_path, 'version', v_back),
		'the same bytes again');
	-- The delete on the version the read gave: the file goes, and the read gives no version.
	perform pg_temp.base_commit('{"kind":"platform"}', 'fu-delete', jsonb_build_array(jsonb_build_object('op', 'delete',
		'path', v_path, 'expectedVersion', (pg_temp.imp_read(v_bundle) -> 'file' ->> 'version')::uuid)));
	perform pg_temp.base_assert(pg_temp.base_version(v_path) is null
		and pg_temp.imp_read(v_bundle) -> 'file' = jsonb_build_object('path', v_path, 'version', null), 'deleted');
	-- The same bytes at another path, and at that path in another company: not the file it read.
	perform pg_temp.fu_put('fu-put-copy', 'code/_incoming/fu/copy.bundle', 'the bundle''s bytes');
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_folder_entries(environment_id, path, kind, version, commit_id, manifest_sha256, file_sha256,
		bytes, media_type, executable)
	values ('91170000-0000-4000-8000-000000000020', v_path, 'file', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		repeat('f', 64), encode(extensions.digest(convert_to('the bundle''s bytes', 'utf8'), 'sha256'), 'hex'), 18,
		'application/octet-stream', false);
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.base_assert(pg_temp.imp_read(v_bundle) -> 'file' = jsonb_build_object('path', v_path, 'version', null),
		'elsewhere: ' || (pg_temp.imp_read(v_bundle) -> 'file')::text);
end $$;

-- (Item 4's two optional rows, a session's move onto and link at restoring.json, are in 1210.)

rollback;

-- 6. Races ------------------------------------------------------------------------------------------------------------
-- One import that came in, committed, of a company of its own (its rows only: foreign keys and triggers are off while
-- they go in), removed at the end. Two runs of one agent take at once: the second waits for the first; it is told
-- nothing when the first commits, and is told when the first does not. Every connection gives up after 20 s.
set session_replication_role = replica;
insert into public.qorpera_code_requests(id, environment_id, owner, name, profile_id, kind, input, state, by_kind, by_user_id,
	finished_at, outcome)
values ('12350000-0000-4000-8000-000000000301', '12350000-0000-4000-8000-000000000201', 'race', 'shop',
	'12350000-0000-4000-8000-000000000101', 'import',
	'{"from":{"github":"Acme/Race"},"via":"public","look":false,"maximumBytes":1073741824}', 'done', 'member',
	'12350000-0000-4000-8000-00000000000a', clock_timestamp(),
	'{"schema":"qorpera.code-request-outcome/v1","state":"done","result":"imported"}');
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, imported_from, imported_at)
values ('12350000-0000-4000-8000-000000000201', '12350000-0000-4000-8000-000000000101', 'race', 'shop',
	'{"kind":"github","repository":"Acme/Race","via":"public","branch":"main","commit":"0000000000000000000000000000000000000001","commits":3}',
	clock_timestamp());
set session_replication_role = origin;

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['fu_hold', 'fu_act']) name;
select set_config('qorpera_test.fu_hold_pid', (select pid::text from dblink('fu_hold', 'select pg_backend_pid()') as b(pid integer)),
	false) \g /dev/null
select set_config('qorpera_test.fu_act_pid', (select pid::text from dblink('fu_act', 'select pg_backend_pid()') as b(pid integer)),
	false) \g /dev/null
select dblink_exec(name, 'set lock_timeout = ''20s''') from unnest(array['fu_hold', 'fu_act']) name \g /dev/null

-- Whether fu_act's call waits on fu_hold; false when the call ended first.
create function pg_temp.fu_waits() returns boolean language plpgsql as $$
declare v_by integer := current_setting('qorpera_test.fu_hold_pid')::integer;
	v_conn integer := current_setting('qorpera_test.fu_act_pid')::integer;
begin
	for attempt in 1..400 loop
		if v_by = any(pg_blocking_pids(v_conn)) then return true; end if;
		exit when dblink_is_busy('fu_act') = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end $$;
-- The answer of fu_act's call (its text), or its error as {"error":<sqlstate>,"message":…}.
create function pg_temp.fu_answer() returns jsonb language plpgsql as $$
declare v text; v_state text; v_message text;
begin
	begin
		select answer into v from dblink_get_result('fu_act') as call(answer text);
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		perform * from dblink_get_result('fu_act') as call(answer text);
		return jsonb_build_object('error', v_state, 'message', v_message);
	end;
	perform * from dblink_get_result('fu_act') as call(answer text);
	return coalesce(v::jsonb, '"none"');
end $$;
-- A take by run p_run of the race's agent, as a connection sends it.
create function pg_temp.fu_race_take(p_run text) returns text language sql immutable as $$
	select format($q$select coalesce(public.qorpera_take_agent_code_imports(jsonb_populate_record(null::public.qorpera_execution_runs,
		jsonb_build_object('id', %L::uuid, 'staff_agent_id', '12350000-0000-4000-8000-000000000501'::uuid,
			'environment_id', '12350000-0000-4000-8000-000000000201'::uuid))), '"none"')::text$q$, p_run)
$$;

-- R1. The first run commits: the second waits for it, then is told nothing (never 23505).
do $$
declare v jsonb; v_first jsonb;
begin
	perform dblink_exec('fu_hold', 'begin');
	select answer::jsonb into v_first from dblink('fu_hold', pg_temp.fu_race_take('12350000-0000-4000-8000-000000000401'))
		as call(answer text);
	perform dblink_send_query('fu_act', pg_temp.fu_race_take('12350000-0000-4000-8000-000000000402'));
	if not pg_temp.fu_waits() then
		perform dblink_exec('fu_hold', 'rollback');
		raise exception 'R1: the second run did not wait for the first: %', pg_temp.fu_answer(); end if;
	perform dblink_exec('fu_hold', 'commit');
	v := pg_temp.fu_answer();
	if jsonb_typeof(v_first) is distinct from 'array' or jsonb_array_length(v_first) <> 1 or v_first -> 0 ->> 'name' <> 'shop'
		or v is distinct from '"none"'::jsonb
		or (select array_agg(told_run_id) from public.qorpera_code_import_tellings
			where request_id = '12350000-0000-4000-8000-000000000301') is distinct from array['12350000-0000-4000-8000-000000000401'::uuid] then
		raise exception 'R1: the first % and the second %', v_first, v; end if;
end $$;

-- R2. The first run does not commit: the second waits for it, then is told.
delete from public.qorpera_code_import_tellings where request_id = '12350000-0000-4000-8000-000000000301';
do $$
declare v jsonb; v_first jsonb;
begin
	perform dblink_exec('fu_hold', 'begin');
	select answer::jsonb into v_first from dblink('fu_hold', pg_temp.fu_race_take('12350000-0000-4000-8000-000000000403'))
		as call(answer text);
	perform dblink_send_query('fu_act', pg_temp.fu_race_take('12350000-0000-4000-8000-000000000404'));
	if not pg_temp.fu_waits() then
		perform dblink_exec('fu_hold', 'rollback');
		raise exception 'R2: the second run did not wait for the first: %', pg_temp.fu_answer(); end if;
	perform dblink_exec('fu_hold', 'rollback');
	v := pg_temp.fu_answer();
	if jsonb_array_length(v_first) <> 1 or jsonb_typeof(v) is distinct from 'array' or v -> 0 ->> 'name' <> 'shop'
		or (select array_agg(told_run_id) from public.qorpera_code_import_tellings
			where request_id = '12350000-0000-4000-8000-000000000301') is distinct from array['12350000-0000-4000-8000-000000000404'::uuid] then
		raise exception 'R2: the first % and the second %', v_first, v; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fu_hold', 'fu_act']) name \g /dev/null

-- Remove the race's rows: its import (its telling goes with it) and its repository.
delete from public.qorpera_code_requests where id = '12350000-0000-4000-8000-000000000301';
delete from public.qorpera_code_repositories where environment_id = '12350000-0000-4000-8000-000000000201';
do $$
begin
	if exists (select 1 from public.qorpera_code_import_tellings where request_id = '12350000-0000-4000-8000-000000000301')
		or exists (select 1 from public.qorpera_code_requests where environment_id = '12350000-0000-4000-8000-000000000201')
		or exists (select 1 from public.qorpera_code_repositories where environment_id = '12350000-0000-4000-8000-000000000201') then
		raise exception 'the races left rows behind'; end if;
end $$;
