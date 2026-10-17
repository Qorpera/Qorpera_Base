-- @fixture 769_folder_core_review_recorder.test.sql until "-- The files the runs delete, written by the member."
-- Interfaces and tables on the folder core, P16a (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (P16)";
-- RUNTIME-INTERFACES.md §6.1 and §7): the four kinds by the path's shape, their parses' shapes (the fixtures' valid
-- parses, embedded), placement and the fixed paths, coding sessions, one main interface per unit, owners-only
-- interfaces, ids, and review classes with the recorder's save_interface. Rows, write, claims and areas are 865's;
-- races 866's. Runs are 647's with their native rows, reviews 769's recorder.

-- The valid parses of packages/cloud-client/test/fixtures/interface-state.json (#751), as parseInterfaceStateFile gives
-- them. P16b checks they stay equal to the fixtures.
create function pg_temp.fixture(p_name text) returns jsonb language sql immutable as $$
	select (case p_name
		when 'interface' then $j${"kind":"interface","id":"5b0e7c52-2f4e-4c1e-9d0a-7f3c1a9e6b21","name":"Pulse","about":"Everything happening in the company now: what needs you, the numbers, the work and what's next.","emblem":"pulse","colour":"coral","main":true,"status":"active","needs":[],"badge":null,"template":{"from":"qorpera/pulse","version":"1.0.0"},"access":{"members":"all","agents":"all","edit":"anyone"},"views":[{"name":"Now","fromView":null,"where":null,"blocks":[{"kind":"text","id":null,"title":null,"from":["vision"],"width":"full","query":{"where":null,"since":null,"order":null,"limit":null,"latestBy":null},"buttons":[],"opens":null,"show":"first-paragraph","text":null,"value":null,"target":null,"trend":null,"chart":null,"line":null,"sub":null,"figure":null,"status":null,"chips":null,"layout":"rows","columns":[],"lookups":{},"fields":[],"lanes":null,"shared":null,"openPile":false,"parts":[],"days":null},{"kind":"list","id":null,"title":"Needs you","from":["waiting"],"width":"full","query":{"where":null,"since":null,"order":null,"limit":4,"latestBy":null},"buttons":["answer"],"opens":null,"show":null,"text":null,"value":null,"target":null,"trend":null,"chart":null,"line":"{title}","sub":null,"figure":null,"status":null,"chips":null,"layout":"cards","columns":[],"lookups":{},"fields":[],"lanes":null,"shared":null,"openPile":false,"parts":[],"days":null},{"kind":"numbers","id":null,"title":"The numbers","from":["table:numbers"],"width":"full","query":{"where":null,"since":null,"order":null,"limit":null,"latestBy":"number"},"buttons":[],"opens":"number","show":null,"text":null,"value":"value","target":"target","trend":{"over":"at","weeks":12},"chart":null,"line":null,"sub":null,"figure":null,"status":null,"chips":null,"layout":"rows","columns":[],"lookups":{},"fields":[],"lanes":null,"shared":null,"openPile":false,"parts":[],"days":null},{"kind":"list","id":null,"title":"Working now","from":["working"],"width":"half","query":{"where":null,"since":null,"order":null,"limit":null,"latestBy":null},"buttons":[],"opens":null,"show":null,"text":null,"value":null,"target":null,"trend":null,"chart":null,"line":"{what}","sub":null,"figure":"agent","status":null,"chips":null,"layout":"rows","columns":[],"lookups":{},"fields":[],"lanes":null,"shared":null,"openPile":false,"parts":[],"days":null},{"kind":"list","id":null,"title":"What happened","from":["activity"],"width":"half","query":{"where":null,"since":"today","order":{"column":"at","descending":true},"limit":null,"latestBy":null},"buttons":[],"opens":null,"show":null,"text":null,"value":null,"target":null,"trend":null,"chart":null,"line":"{line}","sub":null,"figure":null,"status":null,"chips":null,"layout":"rows","columns":[],"lookups":{},"fields":[],"lanes":null,"shared":null,"openPile":false,"parts":[],"days":null},{"kind":"list","id":null,"title":"The work","from":["todos"],"width":"half","query":{"where":{"status":["open","blocked"]},"since":null,"order":{"column":"updated","descending":true},"limit":5,"latestBy":null},"buttons":[],"opens":null,"show":null,"text":null,"value":null,"target":null,"trend":null,"chart":null,"line":"{title}","sub":null,"figure":"agent","status":"status","chips":null,"layout":"rows","columns":[],"lookups":{},"fields":[],"lanes":null,"shared":null,"openPile":false,"parts":[],"days":null},{"kind":"calendar","id":null,"title":"Coming up","from":["routines","human_tasks"],"width":"half","query":{"where":null,"since":null,"order":null,"limit":null,"latestBy":null},"buttons":[],"opens":null,"show":null,"text":null,"value":null,"target":null,"trend":null,"chart":null,"line":null,"sub":null,"figure":null,"status":null,"chips":null,"layout":"rows","columns":[],"lookups":{},"fields":[],"lanes":null,"shared":null,"openPile":false,"parts":[],"days":14},{"kind":"detail","id":"number","title":null,"from":["table:numbers"],"width":"full","query":{"where":null,"since":null,"order":null,"limit":null,"latestBy":null},"buttons":["ask-keeper"],"opens":null,"show":null,"text":null,"value":null,"target":null,"trend":null,"chart":{"type":"line","x":"at","y":"value","by":null,"every":null,"total":null,"target":"target","weeks":12},"line":null,"sub":null,"figure":null,"status":null,"chips":null,"layout":"rows","columns":[],"lookups":{},"fields":[],"lanes":null,"shared":null,"openPile":false,"parts":[],"days":null}]}],"buttons":[{"id":"ask-keeper","verb":"message","label":"Ask {kept_by} about it","who":"all","target":null,"to":"{kept_by}","text":"About {number}: ","table":null,"column":null,"value":null,"fields":[]}]}$j$
		when 'order' then $j${"kind":"interface-order","ids":["5b0e7c52-2f4e-4c1e-9d0a-7f3c1a9e6b21","0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e"]}$j$
		when 'table' then $j${"kind":"table","id":"c41a90e2-6b1d-4f3a-8e57-2d9c0b4a1f68","name":"Numbers","about":"The numbers the company steers by. One row per reading; a number's newest row is its value now.","rows":"file","key":["number","at"],"holder":null,"time":"at","columns":[{"name":"number","type":"text","optional":false,"needsYes":false,"max":60,"choices":[],"currency":null,"to":null},{"name":"at","type":"time","optional":false,"needsYes":false,"max":null,"choices":[],"currency":null,"to":null},{"name":"value","type":"number","optional":false,"needsYes":false,"max":null,"choices":[],"currency":null,"to":null},{"name":"unit","type":"choice","optional":false,"needsYes":false,"max":null,"choices":["€","kr","$","%","count","minutes","hours"],"currency":null,"to":null},{"name":"target","type":"number","optional":true,"needsYes":false,"max":null,"choices":[],"currency":null,"to":null},{"name":"kept_by","type":"agent","optional":false,"needsYes":false,"max":null,"choices":[],"currency":null,"to":null}],"write":{"agents":"all","members":"all"}}$j$
		when 'areas' then $j${"kind":"table","id":"1d6e4a57-8b3c-4f21-9e6d-0a7c5b2f8e14","name":"Areas","about":"The company's areas: whose call each one is, and who its agents answer to.","rows":"file","key":["area"],"holder":"owner","time":null,"columns":[{"name":"area","type":"text","optional":false,"needsYes":false,"max":60,"choices":[],"currency":null,"to":null},{"name":"about","type":"text","optional":true,"needsYes":false,"max":280,"choices":[],"currency":null,"to":null},{"name":"owner","type":"member","optional":true,"needsYes":true,"max":null,"choices":[],"currency":null,"to":null},{"name":"shared","type":"yes-no","optional":false,"needsYes":false,"max":null,"choices":[],"currency":null,"to":null},{"name":"supervisor","type":"member","optional":true,"needsYes":true,"max":null,"choices":[],"currency":null,"to":null},{"name":"agents","type":"agents","optional":true,"needsYes":false,"max":null,"choices":[],"currency":null,"to":null}],"write":{"agents":"all","members":"all"}}$j$
		when 'rows' then $j${"kind":"table-rows","header":["number","at","value","unit","kept_by"],"rows":[{"line":2,"fields":["Revenue","2026-10-02T09:44Z","1200.5","€","11111111-1111-4111-8111-000000000030"]},{"line":3,"fields":["Visits, web","2026-10-02T10:00:00Z","42","count","11111111-1111-4111-8111-000000000030"]}]}$j$
		when 'rows-empty' then $j${"kind":"table-rows","header":["id","card","area","holder","state","added_by","todo"],"rows":[]}$j$
	end)::jsonb
$$;
create function pg_temp.p16_entry(p_path text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_parse ->> 'kind', 'text', p_parse::text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.p16_version(p_path text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '63400000-0000-4000-8000-000000000020' and key_text = p_path
		and kind is distinct from 'claim'
$$;
-- A file's write, staged by the actor that commits it: structured when given a parse, plain when given text.
create function pg_temp.p16_write(p_actor jsonb, p_path text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,
		'file',pg_temp.stage(case when jsonb_typeof(p_parse) = 'string' then p_parse #>> '{}' else p_parse::text end, p_actor))
		|| case when jsonb_typeof(p_parse) = 'string' then '{}'::jsonb
			else jsonb_build_object('structured', jsonb_build_array(pg_temp.p16_entry(p_path, p_parse))) end
		|| case when pg_temp.p16_version(lower(p_path)) is not null then jsonb_build_object('expectedVersion', pg_temp.p16_version(lower(p_path)))
			else '{}'::jsonb end
$$;
-- A new folder with its files (name -> parse, or text for a plain file).
create function pg_temp.p16_folder(p_actor jsonb, p_path text, p_files jsonb) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path',p_path,
		'contents', coalesce((select jsonb_agg(jsonb_build_object('path', f.key, 'kind', 'file', 'file', pg_temp.stage(
			case when jsonb_typeof(f.value) = 'string' then f.value #>> '{}' else f.value::text end, p_actor))) from jsonb_each(p_files) f), '[]'),
		'structured', coalesce((select jsonb_agg(pg_temp.p16_entry(p_path || '/' || f.key, f.value)) from jsonb_each(p_files) f
			where jsonb_typeof(f.value) = 'object'), '[]'))
$$;
create function pg_temp.p16_delete(p_path text) returns jsonb language sql as $$
	select jsonb_build_object('op','delete','path',p_path,'expectedVersion',pg_temp.p16_version(p_path),
		'asOfSeq',(select last_seq from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020'))
$$;
create function pg_temp.p16_move(p_from text, p_to text) returns jsonb language sql as $$
	select jsonb_build_object('op','move','from',p_from,'to',p_to,'expectedVersion',pg_temp.p16_version(p_from),
		'asOfSeq',(select last_seq from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020'))
$$;
-- An interface: the fixture's, with this id, name, main and edit.
create function pg_temp.iface(p_id uuid, p_name text, p_main boolean, p_edit text default 'anyone') returns jsonb language sql as $$
	select pg_temp.fixture('interface') || jsonb_build_object('id', p_id, 'name', p_name, 'main', p_main,
		'access', jsonb_build_object('members','all','agents','all','edit',p_edit))
$$;
create function pg_temp.tbl(p_id uuid, p_base text default 'table') returns jsonb language sql as $$
	select pg_temp.fixture(p_base) || jsonb_build_object('id', p_id)
$$;
create function pg_temp.problem(p_result jsonb, p_unit integer) returns text language sql as $$
	select p_result -> 'units' -> (p_unit - 1) -> 'problems' -> 0 ->> 'message'
$$;
create function pg_temp.code(p_result jsonb, p_unit integer) returns text language sql as $$
	select p_result -> 'units' -> (p_unit - 1) -> 'problems' -> 0 ->> 'code'
$$;
-- A refusal with this reason and, for a rule, this problem code.
create function pg_temp.refused(p_result jsonb, p_unit integer, p_reason text, p_code text default null) returns void
language plpgsql as $$
begin
	perform pg_temp.expect(p_result, p_unit, 'refused', p_reason);
	if p_code is not null and pg_temp.code(p_result, p_unit) is distinct from p_code then
		raise exception 'Unit % expected the code %, got %', p_unit, p_code, p_result using errcode = 'QTF01'; end if;
end $$;
-- Refused for any reason (the core's own, before the hook).
create function pg_temp.refused_any(p_result jsonb, p_unit integer) returns void language plpgsql as $$
begin
	if p_result -> 'units' -> (p_unit - 1) ->> 'outcome' is distinct from 'refused' then
		raise exception 'Unit % expected refused, got %', p_unit, p_result using errcode = 'QTF01'; end if;
end $$;
-- One field of a table's index row damaged, then verify run on the commit that wrote it (it must raise XX000).
create function pg_temp.damaged_verify(p_folder text, p_set text) returns void language plpgsql as $$
declare v_commit uuid := (select commit_id from public.qorpera_folder_table_index where environment_id = '63400000-0000-4000-8000-000000000020'
	and folder_key = p_folder and retired_at is null);
begin
	execute format('update public.qorpera_folder_table_index set %s where environment_id = %L and folder_key = %L and retired_at is null',
		p_set, '63400000-0000-4000-8000-000000000020', p_folder);
	perform public.qorpera_folder_structured_verify('63400000-0000-4000-8000-000000000020', v_commit);
end $$;
create function pg_temp.trow(p_folder text) returns public.qorpera_folder_table_index language sql as $$
	select * from public.qorpera_folder_table_index where environment_id = '63400000-0000-4000-8000-000000000020'
		and folder_key = p_folder and retired_at is null
$$;

-- 0. The seed, as a creation commits it: interfaces/ with order.md, Pulse (main) and Mailbox; tables/ with numbers and
-- areas, each table one new folder with its definition and rows. Each table's index row points at both files.
do $$
declare r jsonb; i integer; t public.qorpera_folder_table_index;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'p16-seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','interfaces'),
		jsonb_build_object('op','mkdir','path','tables'),
		pg_temp.p16_write('{"kind":"platform"}', 'interfaces/order.md', pg_temp.fixture('order')),
		pg_temp.p16_folder('{"kind":"platform"}', 'interfaces/pulse', jsonb_build_object('interface.toml',
			pg_temp.iface('86400000-0000-4000-8000-000000000001', 'Pulse', true), 'README.md', 'About Pulse.')),
		pg_temp.p16_folder('{"kind":"platform"}', 'interfaces/mailbox', jsonb_build_object('interface.toml',
			pg_temp.iface('86400000-0000-4000-8000-000000000002', 'Mailbox', false))),
		pg_temp.p16_folder('{"kind":"platform"}', 'tables/numbers', jsonb_build_object(
			'table.toml', pg_temp.tbl('86400000-0000-4000-8000-000000000011'), 'rows.csv', pg_temp.fixture('rows'))),
		pg_temp.p16_folder('{"kind":"platform"}', 'tables/areas', jsonb_build_object(
			'table.toml', pg_temp.tbl('86400000-0000-4000-8000-000000000012', 'areas'),
			'rows.csv', '{"kind":"table-rows","header":["area","owner","supervisor","agents","shared"],"rows":[]}'::jsonb))));
	for i in 1..7 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	t := pg_temp.trow('tables/numbers');
	if t.id <> '86400000-0000-4000-8000-000000000011' or t.folder_path <> 'tables/numbers'
		or t.definition_version <> pg_temp.p16_version('tables/numbers/table.toml')
		or t.rows_version is distinct from pg_temp.p16_version('tables/numbers/rows.csv') or t.commit_id::text <> r ->> 'commitId' then
		raise exception 'The numbers table''s row: %', to_jsonb(t); end if;
	if (pg_temp.trow('tables/areas')).rows_version is null then raise exception 'The areas row points at its rows'; end if;
end $$;

-- 1. The kinds, by the path's shape alone; the folder places; the fixed paths.
do $$
begin
	if public.qorpera_structured_path_kind('interfaces/order.md') is distinct from 'interface-order'
		or public.qorpera_structured_path_kind('interfaces/x/interface.toml') is distinct from 'interface'
		or public.qorpera_structured_path_kind('interfaces/Bad_Name/interface.toml') is distinct from 'interface'
		or public.qorpera_structured_path_kind('tables/x/table.toml') is distinct from 'table'
		or public.qorpera_structured_path_kind('tables/x/rows.csv') is distinct from 'table-rows'
		or public.qorpera_structured_path_kind('interfaces/x/readme.md') is not null
		or public.qorpera_structured_path_kind('interfaces/x/y/interface.toml') is not null
		or public.qorpera_structured_path_kind('tables/x/other.csv') is not null
		or public.qorpera_structured_path_kind('tables/table.toml') is not null
		or public.qorpera_structured_path_kind('drafts/x/table.toml') is not null then
		raise exception 'The four kinds by shape'; end if;
	if public.qorpera_structured_folder_names('interfaces') <> '{}' or public.qorpera_structured_folder_names('tables') <> '{}'
		or public.qorpera_structured_folder_names('interfaces/x') <> array['2:an interface''s folder']
		or public.qorpera_structured_folder_names('tables/x') <> array['2:a table''s folder'] then
		raise exception 'The folder places'; end if;
	-- A .toml or .csv is never asked to end in .md; a bad folder name is named.
	if jsonb_array_length(public.qorpera_company_state_path_problems('tables/x/rows.csv', false)) <> 0
		or jsonb_array_length(public.qorpera_company_state_path_problems('interfaces/x/interface.toml', false)) <> 0
		or public.qorpera_company_state_path_problems('interfaces/Bad_Name/interface.toml', false) -> 0 ->> 'message'
			not like 'the name of an interface''s folder (Bad_Name)%'
		or public.qorpera_company_state_path_problems('tables/x_y/table.toml', false) -> 0 ->> 'message'
			not like 'the name of a table''s folder (x_y)%' then
		raise exception 'Path problems of the new kinds'; end if;
	if not (public.qorpera_company_state_seeded('interfaces') and public.qorpera_company_state_seeded('interfaces/order.md')
			and public.qorpera_company_state_seeded('tables') and public.qorpera_company_state_seeded('tables/areas')
			and public.qorpera_company_state_seeded('tables/areas/table.toml') and public.qorpera_company_state_seeded('tables/areas/rows.csv'))
		or public.qorpera_company_state_seeded('tables/numbers') then
		raise exception 'The fixed paths'; end if;
end $$;

-- 2. The shapes: every valid fixture parse passes, and each kind refuses what its parser never gives.
do $$
declare v_case record;
begin
	for v_case in select * from (values ('interface', pg_temp.fixture('interface')), ('interface-order', pg_temp.fixture('order')),
		('table', pg_temp.fixture('table')), ('table', pg_temp.fixture('areas')), ('table-rows', pg_temp.fixture('rows')),
		('table-rows', pg_temp.fixture('rows-empty')), ('interface-order', '{"kind":"interface-order","ids":[]}'::jsonb),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,6}', '{"name":"ref","type":"link","optional":true,"needsYes":false,
			"max":null,"choices":[],"currency":null,"to":"table:numbers"}')),
		('interface', pg_temp.fixture('interface') || '{"access":{"members":["11111111-1111-4111-8111-000000000001"],
			"agents":["11111111-1111-4111-8111-000000000002"],"edit":"owners"}}')) as c(kind, parse) loop
		if public.qorpera_company_state_parse_problems(v_case.kind, v_case.parse) <> '[]'::jsonb then
			raise exception 'A valid % parse is refused: %', v_case.kind, public.qorpera_company_state_parse_problems(v_case.kind, v_case.parse); end if;
	end loop;
	for v_case in select * from (values
		-- the table: keys, a loose uuid, the name, the key (a number, an optional column, an unknown one), the flags by type
		('table', pg_temp.fixture('table') || '{"extra":1}', 'keys'),
		('table', pg_temp.fixture('table') || '{"id":"c41a90e2-6b1d-0f3a-8e57-2d9c0b4a1f68"}', 'id'),
		('table', pg_temp.fixture('table') || jsonb_build_object('name', repeat('n', 61)), 'name'),
		('table', pg_temp.fixture('table') || '{"name":"a‮b"}', 'name'),
		('table', pg_temp.fixture('table') || '{"rows":"store"}', 'rows'),
		('table', pg_temp.fixture('table') || '{"key":["value"]}', 'key'),
		('table', pg_temp.fixture('table') || '{"key":["target"]}', 'key'),
		('table', pg_temp.fixture('table') || '{"key":["nope"]}', 'key'),
		('table', pg_temp.fixture('table') || '{"key":["number","number"]}', 'key'),
		('table', pg_temp.fixture('table') || '{"key":[]}', 'key'),
		('table', pg_temp.fixture('table') || '{"holder":"number"}', 'holder'),
		('table', pg_temp.fixture('table') || '{"time":"value"}', 'time'),
		('table', pg_temp.fixture('table') || '{"write":{"agents":[],"members":"all"}}', 'write'),
		('table', pg_temp.fixture('table') || '{"write":{"agents":"all","members":"some"}}', 'write'),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,0,needsYes}', 'true'), 'columns'),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,2,max}', '10'), 'columns'),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,0,max}', '4001'), 'columns'),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,3,choices}', '[]'), 'columns'),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,3,choices}', '["a,b"]'), 'columns'),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,0,name}', '"Number"'), 'columns'),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,1,name}', '"number"'), 'columns'),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,0,type}', '"link"'), 'columns'),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,0,to}', '"todos"'), 'columns'),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,6}', '{"name":"ref","type":"link","optional":true,"needsYes":false,
			"max":null,"choices":[],"currency":null,"to":"table:Numbers"}'), 'columns'),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,6}', '{"name":"ref","type":"link","optional":true,"needsYes":false,
			"max":null,"choices":[],"currency":null,"to":null}'), 'columns'),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,3,choices}', '["a\u2066b"]'), 'columns'),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,3,choices}', '["kr","kr"]'), 'columns'),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,0,currency}', '"EUR"'), 'columns'),
		('table', jsonb_set(pg_temp.fixture('table'), '{columns,0,optional}', '"no"'), 'columns'),
		('table', pg_temp.fixture('table') || jsonb_build_object('about', repeat('a', 281)), 'about'),
		('table', pg_temp.fixture('table') || '{"key":["number","at","unit","kept_by"]}', 'key'),
		('table', pg_temp.fixture('table') || '{"write":{"agents":["not-an-id"],"members":"all"}}', 'write'),
		-- the rows: keys, header, lines, widths, size
		('table-rows', pg_temp.fixture('rows') || '{"extra":1}', 'keys'),
		('table-rows', pg_temp.fixture('rows') || '{"header":["number","number"]}', 'header'),
		('table-rows', pg_temp.fixture('rows') || '{"header":[]}', 'header'),
		('table-rows', pg_temp.fixture('rows') || jsonb_build_object('header', jsonb_build_array(repeat('n', 41))), 'header'),
		('table-rows', jsonb_set(pg_temp.fixture('rows'), '{rows,0,line}', '1'), 'rows'),
		('table-rows', jsonb_set(pg_temp.fixture('rows'), '{rows,1,line}', '2'), 'rows'),
		('table-rows', jsonb_set(pg_temp.fixture('rows'), '{rows,0,line}', '"2"'), 'rows'),
		('table-rows', jsonb_set(pg_temp.fixture('rows'), '{rows,0,fields}', '["a"]'), 'rows'),
		('table-rows', jsonb_set(pg_temp.fixture('rows'), '{rows,0,fields,0}', '1'), 'rows'),
		('table-rows', jsonb_build_object('kind','table-rows','header',jsonb_build_array('a'),'rows',
			jsonb_build_array(jsonb_build_object('line',2,'fields',jsonb_build_array(repeat('x', 65537))))), 'rows'),
		-- the order: unique strict uuids
		('interface-order', '{"kind":"interface-order","ids":["5b0e7c52-2f4e-4c1e-9d0a-7f3c1a9e6b21","5b0e7c52-2f4e-4c1e-9d0a-7f3c1a9e6b21"]}', 'ids'),
		('interface-order', '{"kind":"interface-order","ids":["5B0E7C52-2F4E-4C1E-9D0A-7F3C1A9E6B21"]}', 'ids'),
		('interface-order', '{"kind":"interface-order","ids":[],"extra":1}', 'keys'),
		('table-rows', pg_temp.fixture('rows') || jsonb_build_object('header', (select jsonb_agg('c' || g) from generate_series(1, 41) g)), 'header'),
		-- the interface: keys, the read fields, what review reads, and the rest by type
		('interface', pg_temp.fixture('interface') - 'needs', 'keys'),
		('interface', pg_temp.fixture('interface') || '{"main":"true"}', 'main'),
		('interface', pg_temp.fixture('interface') || '{"id":"5b0e7c52-2f4e-4c1e-0d0a-7f3c1a9e6b21"}', 'id'),
		('interface', pg_temp.fixture('interface') || '{"name":""}', 'name'),
		('interface', pg_temp.fixture('interface') || '{"status":"paused"}', 'status'),
		('interface', pg_temp.fixture('interface') || '{"access":{"members":"all","agents":"all","edit":"all"}}', 'access'),
		('interface', pg_temp.fixture('interface') || '{"access":{"members":"all","agents":"all"}}', 'access'),
		('interface', pg_temp.fixture('interface') || '{"access":{"members":[],"agents":"all","edit":"anyone"}}', 'access'),
		('interface', pg_temp.fixture('interface') || '{"access":{"members":"all","agents":"owners","edit":"anyone"}}', 'access'),
		('interface', pg_temp.fixture('interface') || '{"buttons":[{"verb":"open"}]}', 'buttons'),
		('interface', pg_temp.fixture('interface') || '{"buttons":"none"}', 'buttons'),
		('interface', jsonb_set(pg_temp.fixture('interface'), '{views,0,blocks,1,buttons}', '[1]'), 'views'),
		('interface', jsonb_set(pg_temp.fixture('interface'), '{views,0,blocks,1}', '"text"'), 'views'),
		('interface', pg_temp.fixture('interface') - 'views' || '{"views":[]}', 'views'),
		('interface', pg_temp.fixture('interface') || '{"needs":[1]}', 'needs'),
		('interface', pg_temp.fixture('interface') || '{"emblem":"rocket"}', 'emblem'),
		('interface', pg_temp.fixture('interface') || '{"colour":"red"}', 'colour'),
		('interface', pg_temp.fixture('interface') || '{"badge":"waiting"}', 'badge'),
		('interface', pg_temp.fixture('interface') || '{"template":{"from":"qorpera/pulse"}}', 'template'),
		('interface', pg_temp.fixture('interface') || jsonb_build_object('about', repeat('x', 1048576)), 'about'),
		-- any kind: a parse of another kind
		('table', pg_temp.fixture('rows'), 'does not match')) as c(kind, parse, word) loop
		if public.qorpera_company_state_parse_problems(v_case.kind, v_case.parse::jsonb) = '[]'::jsonb
			or public.qorpera_company_state_parse_problems(v_case.kind, v_case.parse::jsonb) -> 0 ->> 'message' not like '%' || v_case.word || '%' then
			raise exception 'A % parse must be refused for %: %', v_case.kind, v_case.word,
				public.qorpera_company_state_parse_problems(v_case.kind, v_case.parse::jsonb); end if;
	end loop;
end $$;

-- 3. Placement, the fixed paths, and folders moved or copied into or within the roots (a contributor).
do $$
declare m jsonb := pg_temp.member(2); r jsonb; t public.qorpera_folder_table_index;
begin
	r := pg_temp.commit(m, 'p16-place-0001', jsonb_build_array(
		pg_temp.p16_write(m, 'interfaces/notes.txt', '"notes"'),
		jsonb_build_object('op','mkdir','path','interfaces/pulse/sub'),
		pg_temp.p16_write(m, 'interfaces/pulse/extra.md', '"extra"'),
		pg_temp.p16_write(m, 'tables/foo', '"a file"'),
		jsonb_build_object('op','mkdir','path','interfaces/order.md/x')));
	perform pg_temp.refused(r, 1, 'structured_rule', 'placement');
	perform pg_temp.refused(r, 2, 'structured_rule', 'placement');
	perform pg_temp.refused(r, 3, 'structured_rule', 'placement');
	perform pg_temp.refused(r, 4, 'structured_rule', 'placement');
	perform pg_temp.refused_any(r, 5);
	-- A table folder with only its README, then rows without a definition.
	r := pg_temp.commit(m, 'p16-place-0002', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','tables/foo'),
		pg_temp.p16_write(m, 'tables/foo/README.md', '"About foo."'),
		pg_temp.p16_folder(m, 'tables/baz', '{"readme.md":"about baz"}'),
		pg_temp.p16_write(m, 'tables/foo/rows.csv', pg_temp.fixture('rows-empty')),
		pg_temp.p16_folder(m, 'tables/bar', jsonb_build_object('rows.csv', pg_temp.fixture('rows-empty')))));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.expect(r, 3, 'saved');
	perform pg_temp.refused(r, 4, 'structured_rule', 'placement');
	perform pg_temp.refused(r, 5, 'structured_rule', 'placement');
	-- A table's files never go alone; the fixed paths and the main interface stay.
	r := pg_temp.commit(m, 'p16-place-0003', jsonb_build_array(
		pg_temp.p16_delete('tables/numbers/rows.csv'),
		pg_temp.p16_move('tables/numbers/table.toml', 'tables/foo/table.toml'),
		pg_temp.p16_delete('interfaces/order.md'),
		pg_temp.p16_delete('tables/areas'),
		pg_temp.p16_delete('interfaces/pulse'),
		pg_temp.p16_move('interfaces/pulse', 'interfaces/old-pulse'),
		pg_temp.p16_delete('interfaces/pulse/interface.toml'),
		pg_temp.p16_delete('tables'),
		pg_temp.p16_move('interfaces/mailbox', 'interfaces')));
	perform pg_temp.refused(r, 1, 'structured_rule', 'placement');
	perform pg_temp.refused(r, 2, 'structured_rule', 'placement');
	perform pg_temp.expect(r, 3, 'refused', 'seeded');
	perform pg_temp.expect(r, 4, 'refused', 'seeded');
	perform pg_temp.refused(r, 5, 'structured_rule', 'placement');
	perform pg_temp.refused(r, 6, 'structured_rule', 'placement');
	perform pg_temp.refused(r, 7, 'structured_rule', 'placement');
	perform pg_temp.expect(r, 8, 'refused', 'seeded');
	perform pg_temp.expect(r, 9, 'conflict', 'exists');
	-- Folders from elsewhere: a copy of a table is never made; a file named table.toml never becomes a table by moving;
	-- a moved folder's other files are placed too.
	r := pg_temp.commit(m, 'p16-place-0004', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','drafts'),
		jsonb_build_object('op','mkdir','path','drafts/x'),
		pg_temp.p16_write(m, 'drafts/x/table.toml', '"format = \"qorpera.table/v0\""'),
		jsonb_build_object('op','mkdir','path','drafts/y'),
		pg_temp.p16_write(m, 'drafts/y/notes.txt', '"notes"')));
	perform pg_temp.expect(r, 5, 'saved');
	r := pg_temp.commit(m, 'p16-place-0005', jsonb_build_array(
		jsonb_build_object('op','copy','from','tables/numbers','to','tables/numbers-copy'),
		pg_temp.p16_move('drafts/x', 'tables/x'),
		pg_temp.p16_move('drafts/y', 'tables/y'),
		pg_temp.p16_move('drafts/y', 'interfaces/y'),
		pg_temp.p16_move('tables/numbers', 'drafts/numbers')));
	perform pg_temp.expect(r, 1, 'refused', 'structured_copy');
	perform pg_temp.expect(r, 2, 'refused', 'kind_change');
	perform pg_temp.refused(r, 3, 'structured_rule', 'placement');
	perform pg_temp.refused(r, 4, 'structured_rule', 'placement');
	perform pg_temp.expect(r, 5, 'refused', 'kind_change');
	-- A table folder renamed: its row follows, with its files' new versions; verify holds.
	r := pg_temp.commit(m, 'p16-place-0006', jsonb_build_array(pg_temp.p16_move('tables/numbers', 'tables/figures')));
	perform pg_temp.expect(r, 1, 'saved');
	t := pg_temp.trow('tables/figures');
	if t.id <> '86400000-0000-4000-8000-000000000011' or t.folder_path <> 'tables/figures'
		or t.definition_version <> pg_temp.p16_version('tables/figures/table.toml')
		or t.rows_version <> pg_temp.p16_version('tables/figures/rows.csv') or t.commit_id::text <> r ->> 'commitId'
		or (pg_temp.trow('tables/numbers')).id is not null then
		raise exception 'A moved table''s row: %', to_jsonb(t); end if;
	-- Verify checks every row the commit wrote: each field damaged in turn raises.
	perform pg_temp.raises_like(format('select pg_temp.damaged_verify(%L, %L)', 'tables/figures', set_to), 'XX000',
		'A structured index row does not point at its file''s current version')
	from unnest(array['definition_version = gen_random_uuid()', 'rows_version = gen_random_uuid()', 'rows_version = null',
		'folder_path = ''tables/Figures''']) set_to;
	-- A file never lands on a root (only while a root folder is missing can a unit try it).
	if public.qorpera_company_state_interface_paths('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010', m,
			null, 'write', 'tables', null, '{}'::jsonb, 'tables', null) -> 'problems' -> 0 ->> 'code' is distinct from 'placement'
		or public.qorpera_company_state_interface_paths('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010', m,
			null, 'mkdir', 'interfaces', null, '{}'::jsonb, 'interfaces', null) is not null then
		raise exception 'A file on a root is refused; the root folder itself lands'; end if;
	-- Other files in a table's folder, and README's spelling.
	r := pg_temp.commit(m, 'p16-place-0006b', jsonb_build_array(
		pg_temp.p16_write(m, 'tables/figures/other.csv', '"a,b"'),
		pg_temp.p16_folder(m, 'tables/spell', '{"ReadMe.md":"About."}'),
		pg_temp.p16_folder(m, 'interfaces/spell', '{"Readme.md":"About."}')));
	perform pg_temp.refused(r, 1, 'structured_rule', 'placement');
	perform pg_temp.refused(r, 2, 'structured_rule', 'placement');
	perform pg_temp.refused(r, 3, 'structured_rule', 'placement');
	if pg_temp.problem(r, 2) <> 'write README.md or readme.md' then raise exception 'README''s spelling: %', r; end if;
	-- A table folder deleted: its row retires; the same table made again from its text revives it.
	r := pg_temp.commit(m, 'p16-place-0007', jsonb_build_array(
		pg_temp.p16_folder(m, 'tables/scratch', jsonb_build_object('table.toml', pg_temp.tbl('86400000-0000-4000-8000-000000000013'),
			'rows.csv', pg_temp.fixture('rows-empty') || '{"header":["number","at","value","unit","kept_by"]}'))));
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.commit(m, 'p16-place-0008', jsonb_build_array(pg_temp.p16_delete('tables/scratch')));
	perform pg_temp.expect(r, 1, 'saved');
	if exists (select 1 from public.qorpera_folder_table_index where id = '86400000-0000-4000-8000-000000000013' and retired_at is null) then
		raise exception 'A deleted table''s row retires'; end if;
	r := pg_temp.commit(m, 'p16-place-0009', jsonb_build_array(
		pg_temp.p16_folder(m, 'tables/scratch-2', jsonb_build_object('table.toml', pg_temp.tbl('86400000-0000-4000-8000-000000000013')))));
	perform pg_temp.expect(r, 1, 'saved');
	t := pg_temp.trow('tables/scratch-2');
	if t.id is distinct from '86400000-0000-4000-8000-000000000013' or t.rows_version is not null then
		raise exception 'A table made again revives its row, with no rows: %', to_jsonb(t); end if;
end $$;

-- 4. Coding sessions see interfaces/ and table definitions read-only; rows stay theirs to write.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020'; c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	v_coding jsonb := '{"kind":"staff_agent","staffAgentId":"63400000-0000-4000-8000-0000000000a1",
		"requesterUserId":"63400000-0000-4000-8000-000000000002","audience":{"kind":"company"},"sessionKind":"coding","workerAccess":"read"}';
begin
	if public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'interfaces', 'write')
		or public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'interfaces/order.md', 'write')
		or public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'interfaces/pulse/interface.toml', 'write')
		or public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'interfaces/pulse/README.md', 'write')
		or public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'tables/figures/table.toml', 'write')
		or public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'Tables/Figures/Table.toml', 'write')
		or not public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'tables/figures/rows.csv', 'write')
		or not public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'tables/figures/README.md', 'write')
		or not public.qorpera_folder_actor_allowed(c_env, c_profile, v_coding, 'interfaces/pulse/interface.toml', 'read') then
		raise exception 'The coding rule on interfaces and tables'; end if;
	-- A new table folder, a table moved or deleted, and a folder moved into interfaces/: each names a protected key.
	if public.qorpera_folder_actor_keys_allowed(c_env, c_profile, v_coding, 'tables/z', array['tables/z', 'tables/z/table.toml'], 'write')
		or public.qorpera_folder_actor_subtree_allowed(c_env, c_profile, v_coding, 'tables/figures', 'tables/g', 'write')
		or public.qorpera_folder_actor_subtree_allowed(c_env, c_profile, v_coding, 'drafts/y', 'interfaces/y', 'write')
		or not public.qorpera_folder_actor_subtree_allowed(c_env, c_profile, v_coding, 'tables/figures', 'drafts/figures', 'read') then
		raise exception 'The coding rule on subtrees'; end if;
end $$;

-- 5. One main interface per unit: a switch is the old main set to false first; never two, zero in between; a main
-- interface stays. A double main (two promotions at once, which no lock prevents) lets every other save through.
do $$
declare m jsonb := pg_temp.member(2); r jsonb;
begin
	r := pg_temp.commit(m, 'p16-main-0001', jsonb_build_array(
		pg_temp.p16_write(m, 'interfaces/mailbox/interface.toml', pg_temp.iface('86400000-0000-4000-8000-000000000002', 'Mailbox', true))));
	perform pg_temp.refused(r, 1, 'structured_rule', 'main');
	r := pg_temp.commit(m, 'p16-main-0002', jsonb_build_array(
		pg_temp.p16_write(m, 'interfaces/pulse/interface.toml', pg_temp.iface('86400000-0000-4000-8000-000000000001', 'Pulse', false))));
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.commit(m, 'p16-main-0003', jsonb_build_array(
		pg_temp.p16_write(m, 'interfaces/mailbox/interface.toml', pg_temp.iface('86400000-0000-4000-8000-000000000002', 'Mailbox', true))));
	perform pg_temp.expect(r, 1, 'saved');
	-- The other order: the new main's unit is refused and the old main's lands, which leaves none.
	r := pg_temp.commit(m, 'p16-main-0004', jsonb_build_array(
		pg_temp.p16_write(m, 'interfaces/pulse/interface.toml', pg_temp.iface('86400000-0000-4000-8000-000000000001', 'Pulse', true)),
		pg_temp.p16_write(m, 'interfaces/mailbox/interface.toml', pg_temp.iface('86400000-0000-4000-8000-000000000002', 'Mailbox', false))));
	perform pg_temp.refused(r, 1, 'structured_rule', 'main');
	perform pg_temp.expect(r, 2, 'saved');
	if exists (select 1 from public.qorpera_interface_mains('63400000-0000-4000-8000-000000000020')) then
		raise exception 'Zero mains in between'; end if;
	-- Zero mains: an interface that is no longer main is deleted.
	r := pg_temp.commit(m, 'p16-main-0005', jsonb_build_array(
		pg_temp.p16_folder(m, 'interfaces/spare', jsonb_build_object('interface.toml',
			pg_temp.iface('86400000-0000-4000-8000-000000000003', 'Spare', false)))));
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.commit(m, 'p16-main-0006', jsonb_build_array(pg_temp.p16_delete('interfaces/spare')));
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.commit(m, 'p16-main-0007', jsonb_build_array(
		pg_temp.p16_write(m, 'interfaces/pulse/interface.toml', pg_temp.iface('86400000-0000-4000-8000-000000000001', 'Pulse', true))));
	perform pg_temp.expect(r, 1, 'saved');
	-- A double main, as two promotions at once leave it.
	perform pg_temp.fx('update public.qorpera_folder_path_versions v set structured = jsonb_set(v.structured, ''{parse,main}'', ''true'')
		from public.qorpera_folder_entries e where e.environment_id = ''63400000-0000-4000-8000-000000000020''
			and e.key_text = ''interfaces/mailbox/interface.toml'' and v.version = e.version');
	r := pg_temp.commit(m, 'p16-main-0008', jsonb_build_array(
		pg_temp.p16_folder(m, 'interfaces/third', jsonb_build_object('interface.toml',
			pg_temp.iface('86400000-0000-4000-8000-000000000004', 'Third', false))),
		pg_temp.p16_write(m, 'interfaces/pulse/README.md', '"About Pulse, again."'),
		pg_temp.p16_write(m, 'interfaces/mailbox/interface.toml', pg_temp.iface('86400000-0000-4000-8000-000000000002', 'Mail', true)),
		pg_temp.p16_write(m, 'interfaces/mailbox/interface.toml', pg_temp.iface('86400000-0000-4000-8000-000000000002', 'Mailbox', false))));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.refused(r, 3, 'structured_rule', 'main');
	perform pg_temp.expect(r, 4, 'saved');
	if (select count(*) from public.qorpera_interface_mains('63400000-0000-4000-8000-000000000020')) <> 1 then
		raise exception 'Setting one to false resolves a double main'; end if;
end $$;

-- 6. Owners-only interfaces: anyone may make one; then only owners, admins and the platform change anything in its
-- folder, or land anything in it; an agent never.
do $$
declare m jsonb := pg_temp.member(2); o jsonb := pg_temp.member(1); a jsonb := pg_temp.member(5); r jsonb;
	g jsonb := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-000000000001');
begin
	r := pg_temp.commit(m, 'p16-owners-0001', jsonb_build_array(
		pg_temp.p16_folder(m, 'interfaces/board', jsonb_build_object('interface.toml',
			pg_temp.iface('86400000-0000-4000-8000-000000000005', 'Board', false, 'owners'))),
		pg_temp.p16_write(m, 'drafts/readme.md', '"A note."')));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	r := pg_temp.commit(m, 'p16-owners-0002', jsonb_build_array(
		pg_temp.p16_write(m, 'interfaces/board/interface.toml', pg_temp.iface('86400000-0000-4000-8000-000000000005', 'Board 2', false, 'owners')),
		pg_temp.p16_write(m, 'interfaces/board/README.md', '"About the board."'),
		pg_temp.p16_move('drafts/readme.md', 'interfaces/board/readme.md'),
		pg_temp.p16_move('interfaces/board', 'interfaces/board-2'),
		pg_temp.p16_delete('interfaces/board'),
		pg_temp.p16_delete('interfaces/board/interface.toml')));
	perform pg_temp.refused(r, 1, 'structured_rule', 'owners');
	perform pg_temp.refused(r, 2, 'structured_rule', 'owners');
	perform pg_temp.refused(r, 3, 'structured_rule', 'owners');
	perform pg_temp.refused(r, 4, 'structured_rule', 'owners');
	perform pg_temp.refused(r, 5, 'structured_rule', 'owners');
	perform pg_temp.refused(r, 6, 'structured_rule', 'owners');
	r := pg_temp.commit(g -> 'actor', 'p16-owners-0003', jsonb_build_array(
		pg_temp.p16_write(g -> 'actor', 'interfaces/board/README.md', '"An agent''s note."')));
	-- 20260930510000: an agent changes nothing under interfaces/, owners-only or not (689).
	perform pg_temp.refused(r, 1, 'structured_rule', 'layout_authoring');
	r := pg_temp.commit(o, 'p16-owners-0004', jsonb_build_array(
		pg_temp.p16_write(o, 'interfaces/board/interface.toml', pg_temp.iface('86400000-0000-4000-8000-000000000005', 'Board', false, 'owners'))));
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.commit(a, 'p16-owners-0005', jsonb_build_array(pg_temp.p16_write(a, 'interfaces/board/README.md', '"About the board."')));
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.commit('{"kind":"platform"}', 'p16-owners-0006', jsonb_build_array(
		pg_temp.p16_write('{"kind":"platform"}', 'interfaces/board/README.md', '"About the board, by the platform."')));
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.commit(m, 'p16-owners-0006b', jsonb_build_array(
		jsonb_build_object('op','copy','from','interfaces/board/README.md','to','drafts/board-readme.md')));
	perform pg_temp.expect(r, 1, 'saved');
	-- Opened to anyone by an owner: a contributor changes it again.
	r := pg_temp.commit(o, 'p16-owners-0007', jsonb_build_array(
		pg_temp.p16_write(o, 'interfaces/board/interface.toml', pg_temp.iface('86400000-0000-4000-8000-000000000005', 'Board', false))));
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.commit(m, 'p16-owners-0008', jsonb_build_array(pg_temp.p16_write(m, 'interfaces/board/README.md', '"Open now."')));
	perform pg_temp.expect(r, 1, 'saved');
end $$;

-- 7. Ids: one live interface and one live table per id; a table folder keeps its id.
do $$
declare m jsonb := pg_temp.member(2); r jsonb;
begin
	r := pg_temp.commit(m, 'p16-ids-0001', jsonb_build_array(
		pg_temp.p16_folder(m, 'interfaces/twin', jsonb_build_object('interface.toml',
			pg_temp.iface('86400000-0000-4000-8000-000000000002', 'Twin', false))),
		pg_temp.p16_folder(m, 'tables/twin', jsonb_build_object('table.toml', pg_temp.tbl('86400000-0000-4000-8000-000000000011'))),
		pg_temp.p16_write(m, 'tables/figures/table.toml', pg_temp.tbl('86400000-0000-4000-8000-000000000019')),
		pg_temp.p16_write(m, 'interfaces/third/interface.toml', pg_temp.iface('86400000-0000-4000-8000-000000000009', 'Third', false)),
		pg_temp.p16_write(m, 'tables/figures/table.toml', pg_temp.tbl('86400000-0000-4000-8000-000000000011') || '{"key":["value"]}')));
	perform pg_temp.refused(r, 1, 'structured_rule', 'duplicate');
	perform pg_temp.refused(r, 2, 'structured_rule', 'duplicate');
	perform pg_temp.refused(r, 3, 'structured_rule', 'duplicate');
	if pg_temp.problem(r, 3) <> 'a table keeps its id; make a new folder for a new table' then raise exception 'The id rule: %', r; end if;
	perform pg_temp.expect(r, 4, 'saved');
	perform pg_temp.expect(r, 5, 'refused', 'structured_invalid');
end $$;

-- 8. Review (§7): what an agent's change is classed as, and save_interface through the recorder.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	v_agent jsonb := '{"kind":"staff_agent","staffAgentId":"63400000-0000-4000-8000-0000000000a1","sessionKind":"in_house"}';
	v_pulse jsonb := pg_temp.iface('86400000-0000-4000-8000-000000000001', 'Pulse', true); v_case record; v_unit jsonb;
	g jsonb := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-000000000001'); r jsonb; v_units jsonb;
	v_review uuid;
begin
	for v_case in select * from (values
		('interfaces/new/interface.toml', pg_temp.iface('86400000-0000-4000-8000-000000000006', 'New', false), 'delegation'),
		('interfaces/pulse/interface.toml', v_pulse || '{"name":"Pulse now","about":"What happens."}', 'plain'),
		('interfaces/pulse/interface.toml', v_pulse || '{"buttons":[]}', 'delegation'),
		('interfaces/pulse/interface.toml', jsonb_set(v_pulse, '{views,0,blocks,0,buttons}', '["ask-keeper"]'), 'plain'),
		('interfaces/pulse/interface.toml', jsonb_set(v_pulse, '{views,0,blocks,0,buttons}', '["take"]'), 'delegation'),
		('interfaces/pulse/interface.toml', jsonb_set(v_pulse, '{views,0,blocks,1,buttons}', '[]'), 'plain'),
		('interfaces/pulse/interface.toml', jsonb_set(v_pulse, '{views,0,blocks}',
			(select jsonb_agg(b order by n desc) from jsonb_array_elements(v_pulse -> 'views' -> 0 -> 'blocks') with ordinality x(b, n))), 'plain'),
		('interfaces/pulse/interface.toml', v_pulse || '{"access":{"members":"owners","agents":"all","edit":"anyone"}}', 'delegation'),
		('tables/new/table.toml', pg_temp.tbl('86400000-0000-4000-8000-000000000016'), 'delegation'),
		('tables/figures/table.toml', pg_temp.tbl('86400000-0000-4000-8000-000000000011') || '{"name":"Figures"}', 'plain'),
		('tables/figures/table.toml', jsonb_set(pg_temp.tbl('86400000-0000-4000-8000-000000000011'), '{columns,4,optional}', 'false'), 'delegation'),
		('tables/figures/table.toml', pg_temp.tbl('86400000-0000-4000-8000-000000000011') || '{"write":{"agents":"none","members":"all"}}', 'delegation'),
		('tables/figures/rows.csv', pg_temp.fixture('rows-empty'), 'plain'),
		('interfaces/order.md', pg_temp.fixture('order'), 'plain')) as c(path, parse, class) loop
		v_unit := jsonb_build_object('op','write','path',v_case.path,'structured',jsonb_build_array(pg_temp.p16_entry(v_case.path, v_case.parse)));
		if public.qorpera_folder_structured_review_class(c_env, v_agent, v_unit, v_case.path, null) is distinct from v_case.class then
			raise exception 'Review class of % (%): %', v_case.path, v_case.class,
				public.qorpera_folder_structured_review_class(c_env, v_agent, v_unit, v_case.path, null); end if;
	end loop;
	-- A new interface by a run: since 20260930510000 the save check refuses it before any review, and save_interface's
	-- recorded approval saves it no more (689); a change set reaching outside interfaces/ and tables/ is not one
	-- save_interface stands for.
	v_units := jsonb_build_array(pg_temp.p16_folder(g -> 'actor', 'interfaces/agent-page', jsonb_build_object('interface.toml',
		pg_temp.iface('86400000-0000-4000-8000-000000000007', 'Agent page', false))));
	r := pg_temp.commit(g -> 'actor', 'p16-review-0001', v_units);
	perform pg_temp.refused(r, 1, 'structured_rule', 'layout_authoring');
	v_review := (pg_temp.record(g -> 'binding', pg_temp.action(g -> 'binding', 'p16-call-1', 'allow', 'delegation', 'save_interface'),
		v_units) ->> 'reviewId')::uuid;
	r := pg_temp.commit(g -> 'actor', 'p16-review-0002', v_units, v_review);
	perform pg_temp.refused(r, 1, 'structured_rule', 'layout_authoring');
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', g -> 'binding',
		pg_temp.action(g -> 'binding', 'p16-call-2', 'allow', 'delegation', 'save_interface'),
		jsonb_build_array(jsonb_build_object('op','mkdir','path','interfaces/x'), jsonb_build_object('op','mkdir','path','agents/x'))),
		'42501', 'This change has no approval in this run');
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', g -> 'binding',
		pg_temp.action(g -> 'binding', 'p16-call-4', 'allow', 'destructive', 'save_interface'),
		jsonb_build_array(jsonb_build_object('op','mkdir','path','interfaces/y'))),
		'42501', 'This change has no approval in this run');
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', g -> 'binding',
		pg_temp.action(g -> 'binding', 'p16-call-3', 'allow', 'delegation', 'save_interface'),
		jsonb_build_array(jsonb_build_object('op','move','from','interfaces/agent-page','to','drafts/agent-page'))),
		'42501', 'This change has no approval in this run');
end $$;
