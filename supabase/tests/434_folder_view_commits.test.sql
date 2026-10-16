-- @fixture 639_folder_core_views.test.sql until "-- A run box: opened by its run"
-- A desktop view's commits for its report (20260930495000; F3 4f-2a: deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md,
-- "How 4f-2 carries the report"). qorpera_folder_view_commits lists them in the order they were made, after a cursor,
-- with the view's pass, also once the view is closed. The office, screen and helpers are 639's.

-- The service's alone.
do $$
begin
	if has_function_privilege('authenticated', 'public.qorpera_folder_view_commits(uuid,text,uuid,integer)', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_folder_view_commits(uuid,text,uuid,integer)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_folder_view_commits(uuid,text,uuid,integer)', 'EXECUTE') then
		raise exception 'view commits'' privileges'; end if;
end $$;

-- Who made each commit, its outcomes, and the cursor. A commit that saved nothing is listed; one through another view
-- is not, and its id is no cursor here.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); d jsonb; b jsonb; r jsonb;
	a jsonb := pg_temp.stage('view-commits'); c1 jsonb; c2 jsonb; c3 jsonb; cb jsonb; l jsonb; x jsonb;
begin
	perform pg_temp.hold(v);
	d := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4','holderRunId',v ->> 'runId'));
	l := public.qorpera_folder_view_commits((d ->> 'viewId')::uuid, d ->> 'pass');
	if l is distinct from jsonb_build_object('schema','qorpera.folder-view-commits/v1','viewId',d ->> 'viewId','state','open',
		'closeReason',null,'commits','[]'::jsonb,'more',false) then raise exception 'No commits yet: %', l; end if;
	c1 := pg_temp.vcommit(d, 'view-commits-1', jsonb_build_array(jsonb_build_object('op','write','path','shared/vc.txt','file',a),
		jsonb_build_object('op','write','path','secret/vc.txt','file',a)));
	perform pg_temp.expect(c1, 1, 'saved'); perform pg_temp.expect(c1, 2, 'denied', 'denied');
	c2 := pg_temp.vcommit(d, 'view-commits-2', jsonb_build_array(jsonb_build_object('op','write','path','rules/vc.txt','file',a)));
	perform pg_temp.expect(c2, 1, 'denied', 'denied');
	if c2 ->> 'commitId' is null or c2 ->> 'seq' is not null then raise exception 'A commit that saved nothing: %', c2; end if;
	-- A run box of another run, between them: its commit is not the desktop's.
	b := pg_temp.open('run_box', '{}', pg_temp.run('human', '63200000-0000-4000-8000-000000000002'));
	cb := pg_temp.vcommit(b, 'view-commits-box', jsonb_build_array(jsonb_build_object('op','write','path','shared/box.txt','file',a)));
	perform pg_temp.expect(cb, 1, 'saved');
	c3 := pg_temp.vcommit(d, 'view-commits-3', jsonb_build_array(jsonb_build_object('op','mkdir','path','shared/vc')));
	perform pg_temp.expect(c3, 1, 'saved');

	l := public.qorpera_folder_view_commits((d ->> 'viewId')::uuid, d ->> 'pass');
	if jsonb_array_length(l -> 'commits') <> 3 or (l ->> 'more')::boolean
		or l -> 'commits' -> 0 ->> 'commitId' is distinct from c1 ->> 'commitId'
		or l -> 'commits' -> 1 ->> 'commitId' is distinct from c2 ->> 'commitId'
		or l -> 'commits' -> 2 ->> 'commitId' is distinct from c3 ->> 'commitId' then raise exception 'The view''s commits: %', l; end if;
	x := l -> 'commits' -> 0;
	if x ->> 'seq' is distinct from c1 ->> 'seq' or x -> 'by' is distinct from '{"kind":"agent","staffAgentId":"63200000-0000-4000-8000-0000000000a1"}'
		or x ->> 'runId' is distinct from v ->> 'runId' or x ->> 'at' is null
		or x -> 'units' is distinct from c1 -> 'units' then raise exception 'A live desktop commit: %', x; end if;
	if (select count(*) from jsonb_object_keys(x)) <> 6 then raise exception 'A commit''s fields: %', x; end if;
	x := l -> 'commits' -> 1;
	if jsonb_typeof(x -> 'seq') is distinct from 'null' or x -> 'units' is distinct from c2 -> 'units'
		or x -> 'units' -> 0 ->> 'path' is distinct from 'rules/vc.txt' then raise exception 'A commit that saved nothing: %', x; end if;

	-- The limit counts units and never splits a commit: the first comes whole even over it (c1 has two units).
	l := public.qorpera_folder_view_commits((d ->> 'viewId')::uuid, d ->> 'pass', null, 1);
	if jsonb_array_length(l -> 'commits') <> 1 or l -> 'commits' -> 0 -> 'units' is distinct from c1 -> 'units'
		or not (l ->> 'more')::boolean then raise exception 'The first, whole: %', l; end if;
	l := public.qorpera_folder_view_commits((d ->> 'viewId')::uuid, d ->> 'pass', null, 2);
	if jsonb_array_length(l -> 'commits') <> 1 or not (l ->> 'more')::boolean then raise exception 'Two units: %', l; end if;
	l := public.qorpera_folder_view_commits((d ->> 'viewId')::uuid, d ->> 'pass', null, 3);
	if jsonb_array_length(l -> 'commits') <> 2 or l -> 'commits' -> 1 ->> 'commitId' is distinct from c2 ->> 'commitId'
		or not (l ->> 'more')::boolean then raise exception 'Three units: %', l; end if;
	l := public.qorpera_folder_view_commits((d ->> 'viewId')::uuid, d ->> 'pass', null, 4);
	if jsonb_array_length(l -> 'commits') <> 3 or (l ->> 'more')::boolean then raise exception 'Four units: %', l; end if;

	-- The cursor: after a commit, one at a time.
	l := public.qorpera_folder_view_commits((d ->> 'viewId')::uuid, d ->> 'pass', (c1 ->> 'commitId')::uuid, 1);
	if jsonb_array_length(l -> 'commits') <> 1 or l -> 'commits' -> 0 ->> 'commitId' is distinct from c2 ->> 'commitId'
		or not (l ->> 'more')::boolean then raise exception 'After the first, one: %', l; end if;
	l := public.qorpera_folder_view_commits((d ->> 'viewId')::uuid, d ->> 'pass', (c2 ->> 'commitId')::uuid, 1);
	if jsonb_array_length(l -> 'commits') <> 1 or l -> 'commits' -> 0 ->> 'commitId' is distinct from c3 ->> 'commitId'
		or (l ->> 'more')::boolean then raise exception 'After the second, one: %', l; end if;
	l := public.qorpera_folder_view_commits((d ->> 'viewId')::uuid, d ->> 'pass', (c3 ->> 'commitId')::uuid);
	if l -> 'commits' is distinct from '[]'::jsonb or (l ->> 'more')::boolean then raise exception 'After the last: %', l; end if;

	-- Refused: another view's commit or no commit as the cursor, a limit outside 1..1000, a run box, a wrong pass, no view.
	perform pg_temp.raises(format('select public.qorpera_folder_view_commits(%L, %L, %L)', d ->> 'viewId', d ->> 'pass',
		cb ->> 'commitId'), '22023');
	perform pg_temp.raises(format('select public.qorpera_folder_view_commits(%L, %L, %L)', d ->> 'viewId', d ->> 'pass',
		extensions.gen_random_uuid()), '22023');
	perform pg_temp.raises(format('select public.qorpera_folder_view_commits(%L, %L, null, 0)', d ->> 'viewId', d ->> 'pass'), '22023');
	perform pg_temp.raises(format('select public.qorpera_folder_view_commits(%L, %L, null, 1001)', d ->> 'viewId', d ->> 'pass'), '22023');
	perform pg_temp.raises(format('select public.qorpera_folder_view_commits(%L, %L, null, null)', d ->> 'viewId', d ->> 'pass'), '22023');
	perform pg_temp.raises(format('select public.qorpera_folder_view_commits(%L, %L)', b ->> 'viewId', b ->> 'pass'), '22023');
	perform pg_temp.raises(format('select public.qorpera_folder_view_commits(%L, %L)', d ->> 'viewId', 'wrong'), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_view_commits(%L, null)', d ->> 'viewId'), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_view_commits(%L, %L)', extensions.gen_random_uuid(), d ->> 'pass'), '42501');
	-- Not for anyone but the service.
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.raises(format('select public.qorpera_folder_view_commits(%L, %L)', d ->> 'viewId', d ->> 'pass'), '42501');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

	-- The run lets go: the detached view's commits name no run. Closed, the view still answers.
	perform pg_temp.hold(null);
	r := pg_temp.vcommit(d, 'view-commits-detached', jsonb_build_array(jsonb_build_object('op','write','path','shared/vc-detached.txt','file',a)));
	perform pg_temp.expect(r, 1, 'saved');
	perform public.qorpera_folder_view_close((d ->> 'viewId')::uuid, d ->> 'pass');
	l := public.qorpera_folder_view_commits((d ->> 'viewId')::uuid, d ->> 'pass', (c3 ->> 'commitId')::uuid);
	if l ->> 'state' is distinct from 'closed' or l ->> 'closeReason' is distinct from 'closed' or jsonb_array_length(l -> 'commits') <> 1
		or l -> 'commits' -> 0 ->> 'commitId' is distinct from r ->> 'commitId' or jsonb_typeof(l -> 'commits' -> 0 -> 'runId') is distinct from 'null'
		or l -> 'commits' -> 0 -> 'by' is distinct from '{"kind":"agent","staffAgentId":"63200000-0000-4000-8000-0000000000a1"}' then
		raise exception 'A closed view''s commits: %', l; end if;
	perform public.qorpera_folder_view_close((b ->> 'viewId')::uuid, b ->> 'pass');
end $$;

-- A commit carries all its units: a conflict and a denial after the twentieth reach the report.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); d jsonb; r jsonb; l jsonb; u jsonb;
	a jsonb := pg_temp.stage('view-commits-later');
begin
	perform pg_temp.hold(v);
	d := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4','holderRunId',v ->> 'runId'));
	select jsonb_agg(jsonb_build_object('op','mkdir','path','shared/many-' || n) order by n) into u from generate_series(1, 20) as n;
	r := pg_temp.vcommit(d, 'view-commits-many', u || jsonb_build_array(jsonb_build_object('op','write','path','shared/vc.txt','file',a),
		jsonb_build_object('op','write','path','secret/many.txt','file',a)));
	perform pg_temp.expect(r, 20, 'saved'); perform pg_temp.expect(r, 21, 'conflict', 'exists');
	perform pg_temp.expect(r, 22, 'denied', 'denied');
	l := public.qorpera_folder_view_commits((d ->> 'viewId')::uuid, d ->> 'pass');
	if jsonb_array_length(l -> 'commits') <> 1 or l -> 'commits' -> 0 -> 'units' is distinct from r -> 'units'
		or jsonb_array_length(l -> 'commits' -> 0 -> 'units') <> 22
		or l -> 'commits' -> 0 -> 'units' -> 20 ->> 'outcome' is distinct from 'conflict'
		or l -> 'commits' -> 0 -> 'units' -> 21 ->> 'path' is distinct from 'secret/many.txt' then raise exception 'A long commit: %', l; end if;
	perform public.qorpera_folder_view_close((d ->> 'viewId')::uuid, d ->> 'pass');
	perform pg_temp.hold(null);
end $$;
