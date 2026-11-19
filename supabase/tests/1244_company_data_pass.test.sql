-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Company databases, slice 5 (20260930750000) on 924's real native run of Alice's: the run's data pass and the data
-- gateway's redeem. A run gets a pass for a database it may read, through the native host's entry point, and none for
-- one it may not or that is not there; the kept list holds exactly the files the run may read under data/<name>/
-- (database.toml, tables/, queries/, actions/), with their hashes and sizes; a pass for no name keeps every database the
-- run may read; a pass is redeemed once, then answers nothing, as an expired one, an unknown one and one whose run's
-- job is no longer leased do; more than 1,000 files kept is refused with 54000, also when one database holds exactly
-- 1,000 and another follows, and 1,001 empty folders under data/ keep nothing and are no reason to refuse; the grants (anon may redeem, nobody reads the table,
-- only the service role makes a pass); the hourly retention deletes passes a day old and answers as before.

create function pg_temp.dp_same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
create function pg_temp.dp_state(p_sql text) returns text language plpgsql as $$
begin
	execute p_sql;
	return 'ok';
exception when others then
	return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.dp_binding() returns jsonb language sql as $$
	select current_setting('qorpera_test.base_binding')::jsonb
$$;
create function pg_temp.dp_actor() returns jsonb language sql as $$
	select jsonb_build_object('kind', 'run', 'runId', b ->> 'runId', 'jobId', b ->> 'jobId', 'runnerId', b ->> 'runnerId',
		'assignmentId', b ->> 'assignmentId') from pg_temp.dp_binding() b
$$;
create function pg_temp.dp_sha(p_text text) returns text language sql immutable as $$
	select encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex')
$$;
-- A pass as the service role makes it (the native host's dispatch runs the call as the service role).
create function pg_temp.dp_pass(p_database text default null) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v := public.qorpera_run_data_pass('92400000-0000-4000-8000-000000000020', pg_temp.dp_actor(), p_database);
	return v;
end $$;
-- The gateway's redeem, as the publishable key's role calls it.
create function pg_temp.dp_redeem(p_pass text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('anon');
	v := public.qorpera_data_pass_redeem(p_pass);
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
-- The kept files as `path sha256 bytes` lines, sorted.
create function pg_temp.dp_files(p_redeemed jsonb) returns text language sql as $$
	select string_agg(f ->> 'path' || ' ' || (f ->> 'sha256') || ' ' || (f ->> 'bytes'), E'\n' order by f ->> 'path')
	from jsonb_array_elements(p_redeemed -> 'files') f
$$;
create function pg_temp.dp_expect(p_files text[]) returns text language sql as $$
	select string_agg(f || ' ' || pg_temp.dp_sha(t.body) || ' ' || octet_length(convert_to(t.body, 'utf8')), E'\n' order by f)
	from unnest(p_files) f
	join (values
		('data/shop/database.toml', E'format = "qorpera.database/v1"\nname = "Shop"\n'),
		('data/shop/tables/001-orders.sql', E'create table orders (id int primary key, amount int);\n'),
		('data/shop/tables/002-notes.sql', E'alter table orders add column note text;\n'),
		('data/shop/queries/count.sql', E'-- How many orders.\nselect count(*) from orders;\n'),
		('data/shop/actions/mark.sql', E'-- Mark :id.\nupdate orders set note = ''x'' where id = :id;\n'),
		('data/stock/database.toml', E'format = "qorpera.database/v1"\n'),
		('data/stock/tables/001-items.sql', E'create table items (id int primary key);\n')) as t(path, body) on t.path = f
$$;

-- The company's databases, written by the platform: shop (with a snapshot and a nested folder the pass leaves out),
-- stock, payroll in a folder private to a member (no agent in a company conversation reads it), a folder without a
-- database.toml, and folders whose names are not a database's.
insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id, policy,
	created_by_user_id)
values ('92400000-0000-4000-8000-000000000020', 'data/payroll', 'subtree', 'member_private',
	'92400000-0000-4000-8000-000000000002', 'normal', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_commit('{"kind":"platform"}', 'data-pass-seed', jsonb_build_array(
	jsonb_build_object('op', 'mkdir', 'path', 'data'),
	jsonb_build_object('op', 'mkdir', 'path', 'data/shop'),
	jsonb_build_object('op', 'write', 'path', 'data/shop/database.toml',
		'file', pg_temp.base_stage(E'format = "qorpera.database/v1"\nname = "Shop"\n')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/shop/tables'),
	jsonb_build_object('op', 'write', 'path', 'data/shop/tables/001-orders.sql',
		'file', pg_temp.base_stage(E'create table orders (id int primary key, amount int);\n')),
	jsonb_build_object('op', 'write', 'path', 'data/shop/tables/002-notes.sql',
		'file', pg_temp.base_stage(E'alter table orders add column note text;\n')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/shop/tables/old'),
	jsonb_build_object('op', 'write', 'path', 'data/shop/tables/old/000-draft.sql', 'file', pg_temp.base_stage('select 1;')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/shop/queries'),
	jsonb_build_object('op', 'write', 'path', 'data/shop/queries/count.sql',
		'file', pg_temp.base_stage(E'-- How many orders.\nselect count(*) from orders;\n')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/shop/actions'),
	jsonb_build_object('op', 'write', 'path', 'data/shop/actions/mark.sql',
		'file', pg_temp.base_stage(E'-- Mark :id.\nupdate orders set note = ''x'' where id = :id;\n')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/shop/snapshot'),
	jsonb_build_object('op', 'write', 'path', 'data/shop/snapshot/orders.json', 'file', pg_temp.base_stage('[]')),
	jsonb_build_object('op', 'write', 'path', 'data/shop/notes.md', 'file', pg_temp.base_stage('Notes')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/stock'),
	jsonb_build_object('op', 'write', 'path', 'data/stock/database.toml',
		'file', pg_temp.base_stage(E'format = "qorpera.database/v1"\n')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/stock/tables'),
	jsonb_build_object('op', 'write', 'path', 'data/stock/tables/001-items.sql',
		'file', pg_temp.base_stage(E'create table items (id int primary key);\n')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/payroll'),
	jsonb_build_object('op', 'write', 'path', 'data/payroll/database.toml',
		'file', pg_temp.base_stage(E'format = "qorpera.database/v1"\n')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/payroll/tables'),
	jsonb_build_object('op', 'write', 'path', 'data/payroll/tables/001-salaries.sql',
		'file', pg_temp.base_stage(E'create table salaries (name text);\n')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/empty'),
	jsonb_build_object('op', 'mkdir', 'path', 'data/empty/tables'),
	jsonb_build_object('op', 'write', 'path', 'data/empty/tables/001-a.sql', 'file', pg_temp.base_stage('create table a ();')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/pg_things'),
	jsonb_build_object('op', 'write', 'path', 'data/pg_things/database.toml',
		'file', pg_temp.base_stage(E'format = "qorpera.database/v1"\n')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/qorpera'),
	jsonb_build_object('op', 'write', 'path', 'data/qorpera/database.toml',
		'file', pg_temp.base_stage(E'format = "qorpera.database/v1"\n')),
	jsonb_build_object('op', 'write', 'path', 'data/readme.md', 'file', pg_temp.base_stage('What data/ holds')))) \g /dev/null
select pg_temp.base_claims('service_role');

-- 1. The grants: nobody reads the table; only the service role makes a pass; only anon redeems one. The native host
--    lists the pass with scope folder.
do $$ begin
	if has_table_privilege('anon', 'public.qorpera_data_passes', 'select')
		or has_table_privilege('authenticated', 'public.qorpera_data_passes', 'select')
		or has_table_privilege('service_role', 'public.qorpera_data_passes', 'select')
		or has_table_privilege('service_role', 'public.qorpera_data_passes', 'insert')
		or has_table_privilege('service_role', 'public.qorpera_data_passes', 'update') then
		raise exception 'An API role reaches the passes table'; end if;
	if has_function_privilege('anon', 'public.qorpera_run_data_pass(uuid,jsonb,text)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_run_data_pass(uuid,jsonb,text)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_run_data_pass(uuid,jsonb,text)', 'EXECUTE') then
		raise exception 'qorpera_run_data_pass has the wrong grants'; end if;
	if not has_function_privilege('anon', 'public.qorpera_data_pass_redeem(text)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_data_pass_redeem(text)', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_data_pass_redeem(text)', 'EXECUTE') then
		raise exception 'qorpera_data_pass_redeem has the wrong grants'; end if;
	perform pg_temp.dp_same((select scope || ' ' || budget from public.qorpera_native_host_calls
		where name = 'qorpera_run_data_pass'), 'folder standard', 'the native host''s list');
end $$;

-- 2. A pass for a database the run may read, through the native host's entry point with the job's lease token: it
--    keeps database.toml and the files directly in tables/, queries/ and actions/, with the hashes and sizes the folder
--    gives, and the run, its agent and its requester. Nothing else under data/shop/.
select set_config('qorpera_test.dp_token', 'dp1244-lease-token-0123456789abcdef', false);
update public.qorpera_runner_jobs
set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.dp_token'), 'utf8'), 'sha256'), 'hex')
where id = (pg_temp.dp_binding() ->> 'jobId')::uuid;
do $$
declare v_made jsonb; v_redeemed jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform set_config('request.path', '/rpc/qorpera_native_host_call', true);
	v_made := public.qorpera_native_host_call((pg_temp.dp_binding() ->> 'jobId')::uuid,
		current_setting('qorpera_test.dp_token'), 'qorpera_run_data_pass', jsonb_build_object(
			'p_environment_id', '92400000-0000-4000-8000-000000000020', 'p_actor', pg_temp.dp_actor(), 'p_database', 'shop'));
	perform set_config('request.path', '', true);
	perform pg_temp.dp_same(v_made ->> 'schema', 'qorpera.data-pass/v1', 'the pass''s schema');
	perform pg_temp.dp_same(((v_made ->> 'pass') ~ '^[A-Za-z0-9_-]{43}$')::text, 'true', 'the pass is 32 bytes in base64url');
	perform pg_temp.dp_same(v_made ->> 'files', '5', 'the files kept');
	perform pg_temp.dp_same((((v_made ->> 'expiresAt')::timestamptz - clock_timestamp()) between interval '50 seconds'
		and interval '61 seconds')::text, 'true', 'a pass lasts 60 s');
	-- Only its hash is kept.
	perform pg_temp.dp_same((select count(*) from public.qorpera_data_passes
		where pass_sha256 = extensions.digest(v_made ->> 'pass', 'sha256'))::text, '1', 'the pass''s row');
	perform pg_temp.dp_same((select count(*) from public.qorpera_data_passes
		where strpos(files::text, v_made ->> 'pass') > 0)::text, '0', 'the pass itself is not kept');
	v_redeemed := pg_temp.dp_redeem(v_made ->> 'pass');
	perform pg_temp.dp_same((v_redeemed - 'files')::text, jsonb_build_object('schema', 'qorpera.data-pass-redeemed/v1',
		'kind', 'run', 'environmentId', '92400000-0000-4000-8000-000000000020', 'runId', pg_temp.dp_binding() ->> 'runId',
		'staffAgentId', '92400000-0000-4000-8000-000000000030', 'requesterUserId', '92400000-0000-4000-8000-000000000001',
		'database', 'shop')::text, 'what the pass kept');
	perform pg_temp.dp_same(pg_temp.dp_files(v_redeemed), pg_temp.dp_expect(array['data/shop/database.toml',
		'data/shop/tables/001-orders.sql', 'data/shop/tables/002-notes.sql', 'data/shop/queries/count.sql',
		'data/shop/actions/mark.sql']), 'the files the run may read under data/shop/');
	-- 3. Once: the same pass again answers nothing.
	perform pg_temp.dp_same(pg_temp.dp_redeem(v_made ->> 'pass')::text, null, 'a redeemed pass');
end $$;
select pg_temp.base_claims('service_role');

-- 4. No pass for a database the run may not read (a member's private folder), one that is not there, a folder with no
--    database.toml, or a name that is not a database's; the same answer for the first three. Not for a member or the
--    platform either, and not without the service role.
do $$
declare v_name text;
begin
	foreach v_name in array array['payroll', 'nothing', 'empty'] loop
		perform pg_temp.dp_same(pg_temp.dp_state(format('select pg_temp.dp_pass(%L)', v_name)),
			'P0002 Data pass has no such database', 'no pass for ' || v_name);
	end loop;
	foreach v_name in array array['qorpera', 'pg_things', 'qorpera_x', 'Shop', '1shop', 'a-b', repeat('a', 41)] loop
		perform pg_temp.dp_same(pg_temp.dp_state(format('select pg_temp.dp_pass(%L)', v_name)),
			'22023 Database name is invalid', 'the name ' || v_name);
	end loop;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.dp_same(pg_temp.dp_state($s$select public.qorpera_run_data_pass('92400000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"92400000-0000-4000-8000-000000000001"}', 'shop')$s$),
		'22023 A data pass is for a run', 'a member''s actor');
	perform pg_temp.dp_same(pg_temp.dp_state($s$select public.qorpera_run_data_pass('92400000-0000-4000-8000-000000000020',
		'{"kind":"platform"}', 'shop')$s$), '22023 A data pass is for a run', 'the platform');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.dp_same(pg_temp.dp_state(format('select public.qorpera_run_data_pass(%L, %L::jsonb, %L)',
		'92400000-0000-4000-8000-000000000020', pg_temp.dp_actor(), 'shop')), '42501 Folder core authority is required',
		'a member''s token');
	perform pg_temp.base_claims('service_role');
	-- The native host's entry point refuses another actor's call, whatever the function would say.
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform pg_temp.dp_same(pg_temp.dp_state(format('select public.qorpera_native_host_call(%L::uuid, %L, %L, %L::jsonb)',
		pg_temp.dp_binding() ->> 'jobId', current_setting('qorpera_test.dp_token'), 'qorpera_run_data_pass',
		jsonb_build_object('p_environment_id', '92400000-0000-4000-8000-000000000020',
			'p_actor', '{"kind":"member","userId":"92400000-0000-4000-8000-000000000001"}'::jsonb, 'p_database', 'shop'))),
		'42501 native host call is refused', 'the host''s call with a member''s actor');
	perform pg_temp.base_claims('service_role');
end $$;

-- 5. A pass for no name keeps every database the run may read: shop and stock, not payroll, the folder without a
--    database.toml, the names that are not a database's, or data/'s own files.
do $$
declare v_made jsonb := pg_temp.dp_pass(); v_redeemed jsonb;
begin
	perform pg_temp.dp_same(v_made ->> 'files', '7', 'the files of every database');
	v_redeemed := pg_temp.dp_redeem(v_made ->> 'pass');
	perform pg_temp.dp_same(v_redeemed ->> 'database', null, 'no name');
	perform pg_temp.dp_same(pg_temp.dp_files(v_redeemed), pg_temp.dp_expect(array['data/shop/database.toml',
		'data/shop/tables/001-orders.sql', 'data/shop/tables/002-notes.sql', 'data/shop/queries/count.sql',
		'data/shop/actions/mark.sql', 'data/stock/database.toml', 'data/stock/tables/001-items.sql']),
		'the files of every database the run may read');
end $$;

-- 6. A changed file: the next pass keeps its new hash.
select pg_temp.base_commit('{"kind":"platform"}', 'data-pass-change', jsonb_build_array(
	jsonb_build_object('op', 'write', 'path', 'data/stock/tables/001-items.sql',
		'file', pg_temp.base_stage(E'create table items (id int primary key, name text);\n'),
		'expectedVersion', pg_temp.base_version('data/stock/tables/001-items.sql')))) \g /dev/null
select pg_temp.base_claims('service_role');
do $$
declare v_redeemed jsonb := pg_temp.dp_redeem(pg_temp.dp_pass('stock') ->> 'pass');
begin
	perform pg_temp.dp_same((select f ->> 'sha256' from jsonb_array_elements(v_redeemed -> 'files') f
		where f ->> 'path' = 'data/stock/tables/001-items.sql'),
		pg_temp.dp_sha(E'create table items (id int primary key, name text);\n'), 'the live file''s hash');
end $$;

-- 7. Nothing for an expired pass, an unknown pass, something that is not a pass, or a pass whose run's job is no longer
--    leased: the same null as a redeemed one. The last is spent by the try.
do $$
declare v_made jsonb;
begin
	v_made := pg_temp.dp_pass('shop');
	update public.qorpera_data_passes set expires_at = clock_timestamp() - interval '1 second'
	where pass_sha256 = extensions.digest(v_made ->> 'pass', 'sha256');
	perform pg_temp.dp_same(pg_temp.dp_redeem(v_made ->> 'pass')::text, null, 'an expired pass');
	perform pg_temp.dp_same((select (redeemed_at is null)::text from public.qorpera_data_passes
		where pass_sha256 = extensions.digest(v_made ->> 'pass', 'sha256')), 'true', 'an expired pass is not spent');
	perform pg_temp.dp_same(pg_temp.dp_redeem(repeat('A', 43))::text, null, 'an unknown pass');
	perform pg_temp.dp_same(pg_temp.dp_redeem('not a pass')::text, null, 'not a pass');
	perform pg_temp.dp_same(pg_temp.dp_redeem(null)::text, null, 'no pass');
end $$;
savepoint dp_job;
do $$
declare v_made jsonb := pg_temp.dp_pass('shop');
begin
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
	where id = (pg_temp.dp_binding() ->> 'jobId')::uuid;
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.dp_same(pg_temp.dp_redeem(v_made ->> 'pass')::text, null, 'a pass whose job is no longer leased');
	perform pg_temp.dp_same((select (redeemed_at is not null)::text from public.qorpera_data_passes
		where pass_sha256 = extensions.digest(v_made ->> 'pass', 'sha256')), 'true', 'that pass is spent');
end $$;
rollback to savepoint dp_job;

-- 8. More than 1,000 files: refused, for the database and for a pass for no name; 1,000 is kept. One database of exactly
--    1,000 and another after it: refused with the same words, the moment the next database.toml makes 1,001.
savepoint dp_big;
do $$
declare v_file jsonb := pg_temp.base_stage('select 1;'); v_tables jsonb := '[]'::jsonb; v_queries jsonb := '[]'::jsonb;
begin
	for i in 1..600 loop
		v_tables := v_tables || jsonb_build_array(jsonb_build_object('path', lpad(i::text, 3, '0') || '-t.sql', 'kind', 'file',
			'file', v_file));
	end loop;
	for i in 1..399 loop
		v_queries := v_queries || jsonb_build_array(jsonb_build_object('path', 'q' || i || '.sql', 'kind', 'file', 'file', v_file));
	end loop;
	perform pg_temp.base_commit('{"kind":"platform"}', 'data-pass-big', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'data/big'),
		jsonb_build_object('op', 'write', 'path', 'data/big/database.toml', 'file', pg_temp.base_stage('format = "qorpera.database/v1"')),
		jsonb_build_object('op', 'new_folder', 'path', 'data/big/tables', 'contents', v_tables),
		jsonb_build_object('op', 'new_folder', 'path', 'data/big/queries', 'contents', v_queries)));
	perform pg_temp.dp_same(pg_temp.dp_pass('big') ->> 'files', '1000', '1,000 files');
	perform pg_temp.dp_same(pg_temp.dp_state($s$select pg_temp.dp_pass()$s$),
		'54000 Data pass would keep more than 1,000 files', 'every database: big''s 1,000, then shop''s database.toml');
	perform pg_temp.base_commit('{"kind":"platform"}', 'data-pass-big-2', jsonb_build_array(
		jsonb_build_object('op', 'write', 'path', 'data/big/queries/q400.sql', 'file', v_file)));
	perform pg_temp.dp_same(pg_temp.dp_state($s$select pg_temp.dp_pass('big')$s$),
		'54000 Data pass would keep more than 1,000 files', '1,001 files');
	perform pg_temp.dp_same(pg_temp.dp_state($s$select pg_temp.dp_pass()$s$),
		'54000 Data pass would keep more than 1,000 files', 'every database, past 1,000 files');
	perform pg_temp.dp_same(pg_temp.dp_pass('shop') ->> 'files', '5', 'one database beside it');
end $$;
rollback to savepoint dp_big;
select pg_temp.base_claims('service_role');

-- 8b. 1,001 empty folders with database names under data/: they keep no file, so a pass for no name keeps shop's and
--     stock's seven files as before.
savepoint dp_empty;
do $$
declare v_units jsonb; v_from integer;
begin
	-- Two commits, folders 1 to 500 and 501 to 1,001: a commit takes at most 1,000 changes.
	foreach v_from in array array[1, 501] loop
		v_units := '[]'::jsonb;
		for i in v_from..(case when v_from = 1 then 500 else 1001 end) loop
			v_units := v_units || jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'data/e' || lpad(i::text, 4, '0')));
		end loop;
		perform pg_temp.base_commit('{"kind":"platform"}', 'data-pass-empty-folders-' || v_from, v_units);
	end loop;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.dp_same(pg_temp.dp_pass() ->> 'files', '7', '1,001 empty folders keep nothing');
end $$;
rollback to savepoint dp_empty;
select pg_temp.base_claims('service_role');

-- 9. The hourly retention deletes passes older than a day, redeemed or not, and keeps younger ones; its answer has the
--    same keys as before.
do $$
declare v_old jsonb := pg_temp.dp_pass('shop'); v_young jsonb := pg_temp.dp_pass('stock'); v_result jsonb;
begin
	update public.qorpera_data_passes set created_at = clock_timestamp() - interval '1 day 1 minute'
	where pass_sha256 = extensions.digest(v_old ->> 'pass', 'sha256');
	perform set_config('request.jwt.claims', '', true);
	v_result := public.qorpera_run_runtime_node_receipt_retention();
	perform pg_temp.base_claims('service_role');
	perform pg_temp.dp_same((select string_agg(k, ',' order by k) from jsonb_object_keys(v_result) k),
		'calls,cutoff,healthReceipts,heldByMeter,inventories,observations,schema,stopped', 'the retention''s answer');
	perform pg_temp.dp_same((select count(*) from public.qorpera_data_passes
		where pass_sha256 = extensions.digest(v_old ->> 'pass', 'sha256'))::text, '0', 'a pass a day old');
	perform pg_temp.dp_same((select count(*) from public.qorpera_data_passes
		where pass_sha256 = extensions.digest(v_young ->> 'pass', 'sha256'))::text, '1', 'a young pass');
end $$;

rollback;
