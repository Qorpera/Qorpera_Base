-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Interfaces and tables under concurrency, P16a (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (P16)", "The
-- index and the locks"): a rows save and a definition change both take the table's index row at rank 5, so each waits
-- for the other and never decides on what the other is about to replace; a save that named no row (the table was made
-- after it read its locks) answers version_changed; a table's move or delete and a rows save wait for each other. Two
-- promotions take no lock, so both pass and leave two mains, the price of no company-wide lock. 648's committed fixture,
-- removed at the end. Waits are detected with pg_blocking_pids, never by wall-clock time.

create function pg_temp.owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}'::jsonb
$$;
create function pg_temp.member() returns jsonb language sql as $$
	select '{"kind":"member","userId":"64800000-0000-4000-8000-000000000002"}'::jsonb
$$;
create function pg_temp.def(p_id uuid, p_units text[]) returns jsonb language sql as $$
	select jsonb_build_object('kind','table','id',p_id,'name','Race','about',null,'rows','file','key','["what"]'::jsonb,'holder',null,
		'time',null,'write','{"agents":"all","members":"all"}'::jsonb,'columns',jsonb_build_array(
			jsonb_build_object('name','what','type','text','optional',false,'needsYes',false,'max',60,'choices','[]'::jsonb,'currency',null,'to',null),
			jsonb_build_object('name','unit','type','choice','optional',false,'needsYes',false,'max',null,'choices',to_jsonb(p_units),
				'currency',null,'to',null)))
$$;
create function pg_temp.rows(p_rows text[][]) returns jsonb language sql as $$
	select jsonb_build_object('kind','table-rows','header','["what","unit"]'::jsonb,'rows',coalesce((select jsonb_agg(jsonb_build_object(
		'line', n + 1, 'fields', jsonb_build_array(p_rows[n][1], p_rows[n][2])) order by n)
		from generate_series(1, coalesce(array_length(p_rows, 1), 0)) n), '[]'::jsonb))
$$;
create function pg_temp.iface(p_id uuid, p_main boolean) returns jsonb language sql as $$
	select jsonb_build_object('kind','interface','id',p_id,'name','Race page','about',null,'emblem',null,'colour',null,'main',p_main,
		'status','active','needs','[]'::jsonb,'badge',null,'template',null,
		'access','{"members":"all","agents":"all","edit":"anyone"}'::jsonb,
		'views','[{"name":"Now","fromView":null,"where":null,"blocks":[]}]'::jsonb,'buttons','[]'::jsonb)
$$;
create function pg_temp.w(p_path text, p_parse jsonb) returns jsonb language sql as $$
	select pg_temp.write(p_path, p_parse ->> 'kind', p_parse::text, p_parse, pg_temp.version(p_path))
$$;
create function pg_temp.table_folder(p_path text, p_def jsonb, p_rows jsonb) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path',p_path,
		'contents', jsonb_build_array(jsonb_build_object('path','table.toml','kind','file','file',pg_temp.stage(p_def::text)),
			jsonb_build_object('path','rows.csv','kind','file','file',pg_temp.stage(p_rows::text))),
		'structured', jsonb_build_array(pg_temp.entry(p_path || '/table.toml', 'table', p_def::text, p_def),
			pg_temp.entry(p_path || '/rows.csv', 'table-rows', p_rows::text, p_rows)))
$$;
create function pg_temp.sql_commit(p_actor jsonb, p_key text, p_units jsonb) returns text language sql as $$
	select format('select public.qorpera_folder_commit(%L, %L, %L, %L)::text', '64800000-0000-4000-8000-000000000020', p_actor, p_key,
		p_units)
$$;
-- A sent statement's one text row, or its error as 'ERROR <state> <message>'; the connection is drained.
create function pg_temp.result(p_conn text) returns text language plpgsql as $$
declare v_text text;
begin
	begin
		select r into v_text from dblink_get_result(p_conn) as t(r text);
	exception when others then v_text := 'ERROR ' || sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return v_text;
end $$;
-- The stored rows of a table fit its stored definition.
create function pg_temp.fits(p_folder text) returns boolean language sql as $$
	select jsonb_array_length(public.qorpera_interface_rows(
		public.qorpera_interface_stored('64800000-0000-4000-8000-000000000020', p_folder || '/table.toml'),
		public.qorpera_interface_stored('64800000-0000-4000-8000-000000000020', p_folder || '/rows.csv')) -> 'problems') = 0
$$;
create function pg_temp.trow(p_folder text) returns public.qorpera_folder_table_index language sql as $$
	select * from public.qorpera_folder_table_index where environment_id = '64800000-0000-4000-8000-000000000020'
		and folder_key = p_folder and retired_at is null
$$;

-- The tables and pages, committed: each race's table holds one row in euros under a definition of euros and counts;
-- two pages, neither main.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p16-race-seed', jsonb_build_array(
	jsonb_build_object('op','mkdir','path','interfaces'),
	jsonb_build_object('op','mkdir','path','tables'),
	pg_temp.table_folder('tables/race-a', pg_temp.def('86600000-0000-4000-8000-00000000000a', array['€','count']),
		pg_temp.rows(array[array['Revenue','€']])),
	pg_temp.table_folder('tables/race-b', pg_temp.def('86600000-0000-4000-8000-00000000000b', array['€','count']),
		pg_temp.rows(array[array['Revenue','€']])),
	pg_temp.table_folder('tables/race-m', pg_temp.def('86600000-0000-4000-8000-00000000000c', array['€','count']),
		pg_temp.rows(array[array['Revenue','€']])),
	pg_temp.table_folder('tables/race-d', pg_temp.def('86600000-0000-4000-8000-00000000000d', array['€','count']),
		pg_temp.rows(array[array['Revenue','€']])),
	pg_temp.table_folder('tables/race-g', pg_temp.def('86600000-0000-4000-8000-00000000000f', array['€','count']),
		pg_temp.rows(array[array['Revenue','€']])),
	jsonb_build_object('op','mkdir','path','tables/race-w'),
	jsonb_build_object('op','new_folder','path','interfaces/one','contents',jsonb_build_array(jsonb_build_object('path','interface.toml',
		'kind','file','file',pg_temp.stage(pg_temp.iface('86600000-0000-4000-8000-000000000001', false)::text))),
		'structured',jsonb_build_array(pg_temp.entry('interfaces/one/interface.toml','interface',
			pg_temp.iface('86600000-0000-4000-8000-000000000001', false)::text, pg_temp.iface('86600000-0000-4000-8000-000000000001', false)))),
	jsonb_build_object('op','new_folder','path','interfaces/two','contents',jsonb_build_array(jsonb_build_object('path','interface.toml',
		'kind','file','file',pg_temp.stage(pg_temp.iface('86600000-0000-4000-8000-000000000002', false)::text))),
		'structured',jsonb_build_array(pg_temp.entry('interfaces/two/interface.toml','interface',
			pg_temp.iface('86600000-0000-4000-8000-000000000002', false)::text, pg_temp.iface('86600000-0000-4000-8000-000000000002', false)))))),
	10, 'saved') \g /dev/null

-- Each race's units, staged and held by the member who commits them, committed before the blocks that drive the fences:
-- a row this session wrote and has not committed would make the other sessions wait on it while it waits on them.
select set_config('qorpera_test.a_def', jsonb_build_array(pg_temp.w('tables/race-a/table.toml',
	pg_temp.def('86600000-0000-4000-8000-00000000000a', array['€'])))::text, false) \g /dev/null
select set_config('qorpera_test.a_rows', jsonb_build_array(pg_temp.w('tables/race-a/rows.csv',
	pg_temp.rows(array[array['Revenue','€'], array['Visits','count']])))::text, false) \g /dev/null
select set_config('qorpera_test.b_def', jsonb_build_array(pg_temp.w('tables/race-b/table.toml',
	pg_temp.def('86600000-0000-4000-8000-00000000000b', array['€'])))::text, false) \g /dev/null
select set_config('qorpera_test.b_rows', jsonb_build_array(pg_temp.w('tables/race-b/rows.csv',
	pg_temp.rows(array[array['Revenue','€'], array['Visits','count']])))::text, false) \g /dev/null
select set_config('qorpera_test.m_move', jsonb_build_array(jsonb_build_object('op','move','from','tables/race-m','to','tables/race-n',
	'expectedVersion',pg_temp.version('tables/race-m'),
	'asOfSeq',(select last_seq from public.qorpera_folder_clocks where environment_id = '64800000-0000-4000-8000-000000000020')))::text,
	false) \g /dev/null
select set_config('qorpera_test.m_rows', jsonb_build_array(pg_temp.w('tables/race-m/rows.csv',
	pg_temp.rows(array[array['Revenue','€'], array['Visits','count']])))::text, false) \g /dev/null
select set_config('qorpera_test.d_delete', jsonb_build_array(jsonb_build_object('op','delete','path','tables/race-d',
	'expectedVersion',pg_temp.version('tables/race-d'),
	'asOfSeq',(select last_seq from public.qorpera_folder_clocks where environment_id = '64800000-0000-4000-8000-000000000020')))::text,
	false) \g /dev/null
select set_config('qorpera_test.d_rows', jsonb_build_array(pg_temp.w('tables/race-d/rows.csv',
	pg_temp.rows(array[array['Visits','count']])))::text, false) \g /dev/null
-- The window: the table is made in a change set that also writes its README; the rows save writes the README first.
select set_config('qorpera_test.w_make', jsonb_build_array(
	pg_temp.write('tables/race-w/README.md', 'plain', 'About the table.', null),
	pg_temp.w('tables/race-w/table.toml', pg_temp.def('86600000-0000-4000-8000-00000000000e', array['€'])))::text, false) \g /dev/null
select set_config('qorpera_test.w_rows', jsonb_build_array(
	pg_temp.write('tables/race-w/README.md', 'plain', 'About the rows.', null),
	pg_temp.w('tables/race-w/rows.csv', pg_temp.rows(array[array['Visits','count']])))::text, false) \g /dev/null
select set_config('qorpera_test.p_one', jsonb_build_array(pg_temp.w('interfaces/one/interface.toml',
	pg_temp.iface('86600000-0000-4000-8000-000000000001', true)))::text, false) \g /dev/null
select set_config('qorpera_test.p_two', jsonb_build_array(pg_temp.w('interfaces/two/interface.toml',
	pg_temp.iface('86600000-0000-4000-8000-000000000002', true)))::text, false) \g /dev/null
select set_config('qorpera_test.g_rows', jsonb_build_array(pg_temp.w('tables/race-g/rows.csv',
	pg_temp.rows(array[array['Revenue','€'], array['Visits','count']])))::text, false) \g /dev/null
-- (An asOfSeq past every change, so the core's unseen_change never answers first and the table guard does.)
select set_config('qorpera_test.g_move', jsonb_build_array(jsonb_build_object('op','move','from','tables/race-g','to','tables/race-h',
	'expectedVersion',pg_temp.version('tables/race-g'),
	'asOfSeq',(select last_seq + 1000000 from public.qorpera_folder_clocks where environment_id = '64800000-0000-4000-8000-000000000020')))::text,
	false) \g /dev/null
-- Two new tables with one id, in two folders.
select set_config('qorpera_test.t_one', jsonb_build_array(pg_temp.table_folder('tables/twin-one',
	pg_temp.def('86600000-0000-4000-8000-000000000010', array['€']), pg_temp.rows(array[]::text[][])))::text, false) \g /dev/null
select set_config('qorpera_test.t_two', jsonb_build_array(pg_temp.table_folder('tables/twin-two',
	pg_temp.def('86600000-0000-4000-8000-000000000010', array['€']), pg_temp.rows(array[]::text[][])))::text, false) \g /dev/null
select pg_temp.possess('64800000-0000-4000-8000-000000000020', pg_temp.owner(), current_setting('qorpera_test.' || name)::jsonb)
from unnest(array['a_def','b_def','m_move','d_delete','w_make','p_one','g_move','t_one']) name \g /dev/null
select pg_temp.possess('64800000-0000-4000-8000-000000000020', pg_temp.member(), current_setting('qorpera_test.' || name)::jsonb)
from unnest(array['a_rows','b_rows','m_rows','d_rows','w_rows','p_two','g_rows','t_two']) name \g /dev/null
-- (A plain README carries no structured entry.)
select set_config('qorpera_test.w_make', (select jsonb_agg(u - case when u ->> 'path' like '%README.md' then 'structured' else '' end)
	from jsonb_array_elements(current_setting('qorpera_test.w_make')::jsonb) u)::text, false) \g /dev/null
select set_config('qorpera_test.w_rows', (select jsonb_agg(u - case when u ->> 'path' like '%README.md' then 'structured' else '' end)
	from jsonb_array_elements(current_setting('qorpera_test.w_rows')::jsonb) u)::text, false) \g /dev/null

-- A. A definition change holds the table's row; a rows save waits there, then reads again (version_changed): the rows
-- never land under a definition they don't fit ----------------------------------------------------------------------------
do $$
declare r jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	r := (select x::jsonb from dblink('fence_one', pg_temp.sql_commit(pg_temp.owner(), 'p16-race-a-def',
		current_setting('qorpera_test.a_def')::jsonb)) as t(x text));
	perform pg_temp.expect(r, 1, 'saved');
	perform dblink_send_query('fence_two', pg_temp.sql_commit(pg_temp.member(), 'p16-race-a-rows', current_setting('qorpera_test.a_rows')::jsonb));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A rows save must wait for a definition change'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_folder_table_index'::regclass then
		raise exception 'The rows save must queue on the table''s row, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	r := pg_temp.result('fence_two')::jsonb;
	if r -> 'units' -> 0 ->> 'reason' is distinct from 'version_changed' then raise exception 'A rows save behind a definition: %', r; end if;
	if not pg_temp.fits('tables/race-a') then raise exception 'Rows that don''t fit their definition landed'; end if;
end $$;

-- B. A rows save holds the row; a definition change waits there, then reads again: the definition never lands over rows
-- it doesn't fit ----------------------------------------------------------------------------------------------------------
do $$
declare r jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	r := (select x::jsonb from dblink('fence_one', pg_temp.sql_commit(pg_temp.member(), 'p16-race-b-rows',
		current_setting('qorpera_test.b_rows')::jsonb)) as t(x text));
	perform pg_temp.expect(r, 1, 'saved');
	perform dblink_send_query('fence_two', pg_temp.sql_commit(pg_temp.owner(), 'p16-race-b-def', current_setting('qorpera_test.b_def')::jsonb));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A definition change must wait for a rows save'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_folder_table_index'::regclass then
		raise exception 'The definition change must queue on the table''s row, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	r := pg_temp.result('fence_two')::jsonb;
	if r -> 'units' -> 0 ->> 'reason' is distinct from 'version_changed' then raise exception 'A definition behind a rows save: %', r; end if;
	if not pg_temp.fits('tables/race-b') then raise exception 'A definition landed over rows it doesn''t fit'; end if;
end $$;

-- C. A table's folder moved holds its row; a rows save in the old folder waits, then is refused; the row follows the
-- folder with its files' versions ----------------------------------------------------------------------------------------
do $$
declare r jsonb; t public.qorpera_folder_table_index;
begin
	perform dblink_exec('fence_one', 'begin');
	r := (select x::jsonb from dblink('fence_one', pg_temp.sql_commit(pg_temp.owner(), 'p16-race-m-move',
		current_setting('qorpera_test.m_move')::jsonb)) as t(x text));
	perform pg_temp.expect(r, 1, 'saved');
	perform dblink_send_query('fence_two', pg_temp.sql_commit(pg_temp.member(), 'p16-race-m-rows', current_setting('qorpera_test.m_rows')::jsonb));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A rows save must wait for its table''s move'; end if;
	perform dblink_exec('fence_one', 'commit');
	r := pg_temp.result('fence_two')::jsonb;
	if r -> 'units' -> 0 ->> 'outcome' = 'saved' then raise exception 'A rows save landed in a moved table''s old folder: %', r; end if;
	t := pg_temp.trow('tables/race-n');
	if t.id is distinct from '86600000-0000-4000-8000-00000000000c' or t.rows_version is distinct from pg_temp.version('tables/race-n/rows.csv')
		or t.definition_version is distinct from pg_temp.version('tables/race-n/table.toml') or not pg_temp.fits('tables/race-n') then
		raise exception 'The moved table''s row: %', to_jsonb(t); end if;
end $$;

-- D. A table's folder deleted holds its row; a rows save waits, then is refused; the row retires --------------------------
do $$
declare r jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	r := (select x::jsonb from dblink('fence_one', pg_temp.sql_commit(pg_temp.owner(), 'p16-race-d-delete',
		current_setting('qorpera_test.d_delete')::jsonb)) as t(x text));
	perform pg_temp.expect(r, 1, 'saved');
	perform dblink_send_query('fence_two', pg_temp.sql_commit(pg_temp.member(), 'p16-race-d-rows', current_setting('qorpera_test.d_rows')::jsonb));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A rows save must wait for its table''s delete'; end if;
	perform dblink_exec('fence_one', 'commit');
	r := pg_temp.result('fence_two')::jsonb;
	if r -> 'units' -> 0 ->> 'outcome' = 'saved' then raise exception 'A rows save landed in a deleted table: %', r; end if;
	if (pg_temp.trow('tables/race-d')).id is not null or pg_temp.version('tables/race-d/rows.csv') is not null then
		raise exception 'The deleted table''s row retires and its rows stay gone'; end if;
end $$;

-- E. The window: a rows save read its locks before the table was made, so it holds no row; it waits behind the change
-- set that makes the table (at the README both write), then reads again (version_changed) ------------------------------
do $$
declare r jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	r := (select x::jsonb from dblink('fence_one', pg_temp.sql_commit(pg_temp.owner(), 'p16-race-w-make',
		current_setting('qorpera_test.w_make')::jsonb)) as t(x text));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	perform dblink_send_query('fence_two', pg_temp.sql_commit(pg_temp.member(), 'p16-race-w-rows', current_setting('qorpera_test.w_rows')::jsonb));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The rows save must wait at the README'; end if;
	perform dblink_exec('fence_one', 'commit');
	r := pg_temp.result('fence_two')::jsonb;
	if r -> 'units' -> 1 ->> 'reason' is distinct from 'version_changed' then
		raise exception 'A rows save that holds no row of a table made meanwhile: %', r; end if;
	if pg_temp.version('tables/race-w/rows.csv') is not null then raise exception 'The rows landed unlocked'; end if;
end $$;

-- G. A rows save holds the table's row; the table's folder moved behind it waits at that row (before its paths, so it
-- never holds a path the save needs while waiting), then reads again ----------------------------------------------------
do $$
declare r jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	r := (select x::jsonb from dblink('fence_one', pg_temp.sql_commit(pg_temp.member(), 'p16-race-g-rows',
		current_setting('qorpera_test.g_rows')::jsonb)) as t(x text));
	perform pg_temp.expect(r, 1, 'saved');
	perform dblink_send_query('fence_two', pg_temp.sql_commit(pg_temp.owner(), 'p16-race-g-move', current_setting('qorpera_test.g_move')::jsonb));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A table''s move must wait for a rows save in it'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_folder_table_index'::regclass then
		raise exception 'The move must queue on the table''s row, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	r := pg_temp.result('fence_two')::jsonb;
	if r -> 'units' -> 0 ->> 'reason' is distinct from 'version_changed' then
		raise exception 'A move behind a rows save reads again: %', r; end if;
	if (pg_temp.trow('tables/race-g')).rows_version is distinct from pg_temp.version('tables/race-g/rows.csv') then
		raise exception 'The table stays with its new rows'; end if;
end $$;

-- H. Two new tables with one id, at once: both pass their checks; the second waits at the index row's key, then fails
-- whole, and the first table keeps its row ----------------------------------------------------------------------------
do $$
declare r jsonb; v text;
begin
	perform dblink_exec('fence_one', 'begin');
	r := (select x::jsonb from dblink('fence_one', pg_temp.sql_commit(pg_temp.owner(), 'p16-race-t-one',
		current_setting('qorpera_test.t_one')::jsonb)) as t(x text));
	perform pg_temp.expect(r, 1, 'saved');
	perform dblink_send_query('fence_two', pg_temp.sql_commit(pg_temp.member(), 'p16-race-t-two', current_setting('qorpera_test.t_two')::jsonb));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The second table must wait for the first'; end if;
	perform dblink_exec('fence_one', 'commit');
	v := pg_temp.result('fence_two');
	if v not like 'ERROR 23505 %' then raise exception 'The second table with one id must fail whole: %', v; end if;
	if (pg_temp.trow('tables/twin-one')).id is distinct from '86600000-0000-4000-8000-000000000010'
		or pg_temp.version('tables/twin-two') is not null then
		raise exception 'The first table keeps its row and the second never lands'; end if;
end $$;

-- F. Two promotions at once, from no main: no lock orders their decisions (the second waits only at the folder's
-- clock, after it decided), so both pass and leave two mains, the price of no company-wide lock, which the web shows --
do $$
declare r jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	r := (select x::jsonb from dblink('fence_one', pg_temp.sql_commit(pg_temp.owner(), 'p16-race-p-one',
		current_setting('qorpera_test.p_one')::jsonb)) as t(x text));
	perform pg_temp.expect(r, 1, 'saved');
	perform dblink_send_query('fence_two', pg_temp.sql_commit(pg_temp.member(), 'p16-race-p-two',
		current_setting('qorpera_test.p_two')::jsonb));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The second commit waits at the folder''s clock'; end if;
	perform dblink_exec('fence_one', 'commit');
	perform pg_temp.expect(pg_temp.result('fence_two')::jsonb, 1, 'saved');
	if (select count(*) from public.qorpera_interface_mains('64800000-0000-4000-8000-000000000020')) <> 2 then
		raise exception 'Two promotions at once leave two mains'; end if;
end $$;

-- Remove the fixture: every row of the company, its environment, its runs, jobs, sessions, rooms and login.
select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;
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
		or exists (select 1 from public.qorpera_folder_table_index where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_entries where environment_id = '64800000-0000-4000-8000-000000000020') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
