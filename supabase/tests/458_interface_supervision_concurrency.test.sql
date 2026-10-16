-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Interfaces I9b under concurrency (deploy/first-node/RUNTIME-INTERFACES.md §5.1 "Supervision", §6.1 rule 8): an agent's
-- commit in tables/ holds the areas table's index row FOR SHARE at rank 5, so it reads its area and its supervisor's
-- consent as no save of the areas can change them before it ends. A save that drops the agent from its area holds the
-- row; the agent's take of a claimed cell waits there, then acts for no one and is refused. The agent's take holds the
-- row; the save waits there and lands after it. The take holds the row in its rank-5 place, before its paths: in the
-- order a save that writes the areas and another table takes them, never only in the rules after the paths. A consent
-- called while its live consent is being withdrawn waits at that consent, then makes a new one: never an answer with no
-- consent in it. 648's committed fixture (agent Ada and the agent's run f1 for the member), removed at the end. Waits are
-- detected with pg_blocking_pids, never by wall-clock time.

create function pg_temp.member() returns jsonb language sql as $$
	select '{"kind":"member","userId":"64800000-0000-4000-8000-000000000002"}'::jsonb
$$;
create function pg_temp.ada() returns jsonb language sql as $$
	select jsonb_build_object('kind','run','runId','64800000-0000-4000-8000-0000000000f1','jobId','64800000-0000-4000-8000-0000000000f2',
		'runnerId','64800000-0000-4000-8000-0000000000f4','assignmentId','64800000-0000-4000-8000-0000000000f5')
$$;
create function pg_temp.areas_def() returns jsonb language sql as $$
	select '{"kind":"table","id":"45800000-0000-4000-8000-000000000001","name":"Areas","about":"The company''s areas: whose call each one is, and who its agents answer to.","rows":"file","key":["area"],"holder":"owner","time":null,"columns":[{"name":"area","type":"text","optional":false,"needsYes":false,"max":60,"choices":[],"currency":null,"to":null},{"name":"about","type":"text","optional":true,"needsYes":false,"max":280,"choices":[],"currency":null,"to":null},{"name":"owner","type":"member","optional":true,"needsYes":true,"max":null,"choices":[],"currency":null,"to":null},{"name":"shared","type":"yes-no","optional":false,"needsYes":false,"max":null,"choices":[],"currency":null,"to":null},{"name":"supervisor","type":"member","optional":true,"needsYes":true,"max":null,"choices":[],"currency":null,"to":null},{"name":"agents","type":"agents","optional":true,"needsYes":false,"max":null,"choices":[],"currency":null,"to":null}],"write":{"agents":"all","members":"all"}}'::jsonb
$$;
create function pg_temp.claims_def() returns jsonb language sql as $$
	select jsonb_build_object('kind','table','id','45800000-0000-4000-8000-000000000002','name','Claims','about',null,'rows','file',
		'key',jsonb_build_array('task'),'holder','owner','time',null,'columns',jsonb_build_array(
			jsonb_build_object('name','task','type','text','optional',false,'needsYes',false,'max',60,'choices','[]'::jsonb,'currency',null,'to',null),
			jsonb_build_object('name','owner','type','member','optional',true,'needsYes',true,'max',null,'choices','[]'::jsonb,'currency',null,'to',null),
			jsonb_build_object('name','helper','type','member','optional',true,'needsYes',false,'max',null,'choices','[]'::jsonb,'currency',null,'to',null)),
		'write',jsonb_build_object('agents','all','members','all'))
$$;
-- Rows of a table: header and fields as the client's parse gives them, one line each from line 2.
create function pg_temp.rows(p_header text[], p_rows text[][]) returns jsonb language sql as $$
	select jsonb_build_object('kind','table-rows','header',to_jsonb(p_header),'rows',coalesce((select jsonb_agg(jsonb_build_object('line',
		n + 1, 'fields', (select jsonb_agg(p_rows[n][c] order by c) from generate_series(1, array_length(p_rows, 2)) c)) order by n)
		from generate_series(1, coalesce(array_length(p_rows, 1), 0)) n), '[]'::jsonb))
$$;
-- The one area, Sales: no owner, the member its supervisor, these agents.
create function pg_temp.sales(p_agents text) returns jsonb language sql as $$
	select pg_temp.rows(array['area','owner','supervisor','agents','shared'],
		array[array['Sales', '', pg_temp.member() ->> 'userId', p_agents, 'no']])
$$;
-- The claims: t1 and t2, each owner cell as given.
create function pg_temp.claims(p_t1 text, p_t2 text) returns jsonb language sql as $$
	select pg_temp.rows(array['task','owner','helper'], array[array['t1', p_t1, ''], array['t2', p_t2, '']])
$$;
-- Sales' live consent (null when it has none).
create function pg_temp.live() returns uuid language sql as $$
	select s.id from public.qorpera_interface_supervisions s where s.environment_id = '64800000-0000-4000-8000-000000000020'
		and s.state = 'live' and s.row_key = '["Sales"]'
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
-- A connection calls as the member (they call as themselves), or as the service again.
create function pg_temp.claims_as(p_conn text, p_member boolean) returns void language sql as $$
	select dblink_exec(p_conn, format('set request.jwt.claims = %L', case when p_member
		then jsonb_build_object('role', 'authenticated', 'sub', pg_temp.member() ->> 'userId')::text else '{"role":"service_role"}' end))
$$;

-- The areas (no area yet) and the claims (no one holds t1 or t2), committed. Then the member makes Sales with Ada in its
-- agents and themselves its supervisor: their consent.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'i9b-race-seed', jsonb_build_array(
	jsonb_build_object('op','mkdir','path','tables'),
	pg_temp.table_folder('tables/areas', pg_temp.areas_def(), pg_temp.rows(array['area','owner','supervisor','agents','shared'], '{}')),
	pg_temp.table_folder('tables/claims', pg_temp.claims_def(), pg_temp.claims('', '')))), 3, 'saved') \g /dev/null
select pg_temp.expect(pg_temp.commit(pg_temp.member(), 'i9b-race-sales-1', jsonb_build_array(pg_temp.w('tables/areas/rows.csv',
	pg_temp.sales('64800000-0000-4000-8000-0000000000a1')))), 1, 'saved') \g /dev/null
select set_config('qorpera_test.live', pg_temp.live()::text, false) \g /dev/null
do $$
begin
	if nullif(current_setting('qorpera_test.live'), '') is null then raise exception 'The member''s save must make their consent'; end if;
end $$;

-- Each race's units, staged and held by whoever commits them (Ada's run the take, the member their save), committed
-- before the blocks that drive the fences: a row this session wrote and has not committed would make the other sessions
-- wait on it while it waits on them.
select set_config('qorpera_test.a_take', jsonb_build_array(pg_temp.w('tables/claims/rows.csv',
	pg_temp.claims(pg_temp.member() ->> 'userId', '')))::text, false) \g /dev/null
select set_config('qorpera_test.a_drop', jsonb_build_array(pg_temp.w('tables/areas/rows.csv', pg_temp.sales('')))::text,
	false) \g /dev/null
select pg_temp.possess('64800000-0000-4000-8000-000000000020', pg_temp.ada(), current_setting('qorpera_test.a_take')::jsonb) \g /dev/null
select pg_temp.possess('64800000-0000-4000-8000-000000000020', pg_temp.member(), current_setting('qorpera_test.a_drop')::jsonb)
\g /dev/null

-- A. A save that drops Ada from Sales holds the areas' row; Ada's take of a claimed cell waits there, then reads the area
-- the save left: Ada acts for no one, and the take is refused -----------------------------------------------------------
do $$
declare r jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	r := (select x::jsonb from dblink('fence_one', pg_temp.sql_commit(pg_temp.member(), 'i9b-race-a-drop',
		current_setting('qorpera_test.a_drop')::jsonb)) as t(x text));
	perform pg_temp.expect(r, 1, 'saved');
	perform dblink_send_query('fence_two', pg_temp.sql_commit(pg_temp.ada(), 'i9b-race-a-take', current_setting('qorpera_test.a_take')::jsonb));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'An agent''s take must wait for a save of the areas'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_folder_table_index'::regclass then
		raise exception 'The take must queue on the areas'' row, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	r := pg_temp.result('fence_two')::jsonb;
	if r -> 'units' -> 0 ->> 'outcome' is distinct from 'refused' or r -> 'units' -> 0 ->> 'reason' is distinct from 'structured_rule'
		or r -> 'units' -> 0 -> 'problems' -> 0 ->> 'code' is distinct from 'claim' then
		raise exception 'A take behind the save that dropped the agent: %', r; end if;
end $$;

-- Ada back in Sales (the member's consent stays live: the save keeps the cell), and the next race's units.
select pg_temp.expect(pg_temp.commit(pg_temp.member(), 'i9b-race-sales-2', jsonb_build_array(pg_temp.w('tables/areas/rows.csv',
	pg_temp.sales('64800000-0000-4000-8000-0000000000a1')))), 1, 'saved') \g /dev/null
do $$
begin
	if pg_temp.live() is distinct from current_setting('qorpera_test.live')::uuid then
		raise exception 'A save that keeps the supervisor keeps the consent: %', pg_temp.live(); end if;
end $$;
select set_config('qorpera_test.b_take', jsonb_build_array(pg_temp.w('tables/claims/rows.csv',
	pg_temp.claims('', pg_temp.member() ->> 'userId')))::text, false) \g /dev/null
select set_config('qorpera_test.b_drop', jsonb_build_array(pg_temp.w('tables/areas/rows.csv', pg_temp.sales('')))::text,
	false) \g /dev/null
select pg_temp.possess('64800000-0000-4000-8000-000000000020', pg_temp.ada(), current_setting('qorpera_test.b_take')::jsonb) \g /dev/null
select pg_temp.possess('64800000-0000-4000-8000-000000000020', pg_temp.member(), current_setting('qorpera_test.b_drop')::jsonb)
\g /dev/null

-- B. Ada's take, as the member Ada acts for, holds the areas' row; a save that drops Ada from Sales waits there, then
-- lands after the take: the cell Ada took names the member -------------------------------------------------------------
do $$
declare r jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	r := (select x::jsonb from dblink('fence_one', pg_temp.sql_commit(pg_temp.ada(), 'i9b-race-b-take',
		current_setting('qorpera_test.b_take')::jsonb)) as t(x text));
	perform pg_temp.expect(r, 1, 'saved');
	perform dblink_send_query('fence_two', pg_temp.sql_commit(pg_temp.member(), 'i9b-race-b-drop', current_setting('qorpera_test.b_drop')::jsonb));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A save of the areas must wait for an agent''s take'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_folder_table_index'::regclass then
		raise exception 'The save must queue on the areas'' row, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	perform pg_temp.expect(pg_temp.result('fence_two')::jsonb, 1, 'saved');
	-- (Read in a statement of its own: the take committed before it.)
	if public.qorpera_interface_stored('64800000-0000-4000-8000-000000000020', 'tables/claims/rows.csv') -> 'rows' -> 1 -> 'fields' ->> 1
		is distinct from pg_temp.member() ->> 'userId' then
		raise exception 'The take behind which the save waited: %',
			public.qorpera_interface_stored('64800000-0000-4000-8000-000000000020', 'tables/claims/rows.csv'); end if;
end $$;

-- C. A withdrawal holds the consent (as its FOR UPDATE does); consenting again meanwhile finds it live, waits at it,
-- then finds it withdrawn and makes a new one: never an answer with no consent in it ----------------------------------
do $$
declare r jsonb; v_old uuid := current_setting('qorpera_test.live')::uuid;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', format('select id::text from public.qorpera_interface_supervisions where id = %L for update',
		v_old)) as t(x text);
	perform pg_temp.claims_as('fence_two', true);
	perform dblink_send_query('fence_two', format('select public.qorpera_consent_interface_supervision(%L, %L)::text',
		'64800000-0000-4000-8000-000000000020', '{"key":["Sales"]}'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'Consenting must wait for a withdrawal'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_interface_supervisions'::regclass then
		raise exception 'Consenting must queue on the consent, not on %', pg_temp.queued_on('fence_two'); end if;
	perform pg_temp.claims_as('fence_one', true);
	r := (select x::jsonb from dblink('fence_one', format('select public.qorpera_withdraw_interface_supervision(%L, %L)::text',
		'64800000-0000-4000-8000-000000000020', v_old)) as t(x text));
	if r ->> 'changed' is distinct from 'true' then raise exception 'The withdrawal: %', r; end if;
	perform dblink_exec('fence_one', 'commit');
	perform pg_temp.claims_as('fence_one', false);
	r := pg_temp.result('fence_two')::jsonb;
	perform pg_temp.claims_as('fence_two', false);
	if r ->> 'ok' is distinct from 'true' or r ->> 'created' is distinct from 'true'
		or r -> 'supervision' ->> 'state' is distinct from 'live' or r -> 'supervision' ->> 'id' = v_old::text then
		raise exception 'Consenting behind a withdrawal: %', r; end if;
	-- (Read in a statement of its own: both committed before it.)
	if (select s.state from public.qorpera_interface_supervisions s where s.id = v_old) is distinct from 'withdrawn'
		or pg_temp.live()::text is distinct from r -> 'supervision' ->> 'id' then
		raise exception 'The consents after: %', (select jsonb_agg(to_jsonb(s)) from public.qorpera_interface_supervisions s
			where s.environment_id = '64800000-0000-4000-8000-000000000020'); end if;
end $$;

-- Ada back in Sales (under the new consent), and the last race's take: t1 for the member, t2 as it is.
select pg_temp.expect(pg_temp.commit(pg_temp.member(), 'i9b-race-sales-3', jsonb_build_array(pg_temp.w('tables/areas/rows.csv',
	pg_temp.sales('64800000-0000-4000-8000-0000000000a1')))), 1, 'saved') \g /dev/null
select set_config('qorpera_test.d_take', jsonb_build_array(pg_temp.w('tables/claims/rows.csv',
	pg_temp.claims(pg_temp.member() ->> 'userId', pg_temp.member() ->> 'userId')))::text, false) \g /dev/null
select pg_temp.possess('64800000-0000-4000-8000-000000000020', pg_temp.ada(), current_setting('qorpera_test.d_take')::jsonb) \g /dev/null

-- D. Ada's take holds the areas' row in its rank-5 place, before its paths: stopped at its rows.csv (another session holds
-- that path), it already holds the row, and a save's lock of the row waits for it. Taken only in the rules, after the
-- paths, the row would come after the claims' row, against the order a save that writes both tables takes them ---------
do $$
begin
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', format('select e.path from public.qorpera_folder_entries e where e.environment_id = %L
		and e.key_sha256 = extensions.digest(public.qorpera_folder_key(%L), %L) for update', '64800000-0000-4000-8000-000000000020',
		'tables/claims/rows.csv', 'sha256')) as t(x text);
	perform dblink_send_query('fence_one', pg_temp.sql_commit(pg_temp.ada(), 'i9b-race-d-take', current_setting('qorpera_test.d_take')::jsonb));
	if not pg_temp.waits_for('fence_one', 'fence_three') then raise exception 'The take must wait at its path'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_folder_entries'::regclass then
		raise exception 'The take must queue on its path, not on %', pg_temp.queued_on('fence_one'); end if;
	perform dblink_send_query('fence_two', format('select i.id::text from public.qorpera_folder_table_index i
		where i.environment_id = %L and i.folder_key = %L and i.retired_at is null for no key update',
		'64800000-0000-4000-8000-000000000020', 'tables/areas'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then
		raise exception 'An agent''s take in tables/ must hold the areas'' row before its paths'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_folder_table_index'::regclass then
		raise exception 'The save''s lock must queue on the areas'' row, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_three', 'rollback');
	perform pg_temp.expect(pg_temp.result('fence_one')::jsonb, 1, 'saved');
	if coalesce(pg_temp.result('fence_two'), 'ERROR') like 'ERROR%' then raise exception 'The areas'' row after the take'; end if;
end $$;
do $$
begin
	if public.qorpera_interface_stored('64800000-0000-4000-8000-000000000020', 'tables/claims/rows.csv') -> 'rows' -> 0 -> 'fields' ->> 1
		is distinct from pg_temp.member() ->> 'userId' then
		raise exception 'The take that held the areas'' row: %',
			public.qorpera_interface_stored('64800000-0000-4000-8000-000000000020', 'tables/claims/rows.csv'); end if;
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
		or exists (select 1 from public.qorpera_interface_supervisions where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_entries where environment_id = '64800000-0000-4000-8000-000000000020') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
