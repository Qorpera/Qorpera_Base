-- @fixture 510_folder_test_machine_views.test.sql until "-- The migration's marker is in every function it patches"

create function pg_temp.mp_same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
create function pg_temp.mp_redeem(p_pass text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	v := public.qorpera_data_pass_redeem(p_pass);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return v;
end $$;
create function pg_temp.mp_pass(p_view jsonb, p_database text default 'shop') returns jsonb language sql as $$
	select public.qorpera_machine_data_pass('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_database)
$$;

select pg_temp.commit('{"kind":"platform"}', 'machine-pass-seed', jsonb_build_array(
	jsonb_build_object('op', 'mkdir', 'path', 'data'),
	jsonb_build_object('op', 'mkdir', 'path', 'data/shop'),
	jsonb_build_object('op', 'write', 'path', 'data/shop/database.toml',
		'file', pg_temp.stage(E'format = "qorpera.database/v1"\nname = "Shop"\n')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/shop/tables'),
	jsonb_build_object('op', 'write', 'path', 'data/shop/tables/001-orders.sql',
		'file', pg_temp.stage(E'create table orders (id int primary key, amount int);\n')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/shop/queries'),
	jsonb_build_object('op', 'write', 'path', 'data/shop/queries/count.sql',
		'file', pg_temp.stage(E'-- How many orders.\nselect count(*) from orders;\n')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/shop/actions'),
	jsonb_build_object('op', 'write', 'path', 'data/shop/actions/add.sql',
		'file', pg_temp.stage(E'-- Add order :id.\ninsert into orders values (:id, 0);\n')),
	jsonb_build_object('op', 'write', 'path', 'data/shop/notes.md', 'file', pg_temp.stage('Notes')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/stock'),
	jsonb_build_object('op', 'write', 'path', 'data/stock/database.toml',
		'file', pg_temp.stage(E'format = "qorpera.database/v1"\n')))) \g /dev/null

do $$ begin
	if has_function_privilege('anon', 'public.qorpera_machine_data_pass(uuid,jsonb,text)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_machine_data_pass(uuid,jsonb,text)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_machine_data_pass(uuid,jsonb,text)', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_data_pass_listing(uuid,jsonb,text)', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_data_pass_listing(uuid,jsonb,text)', 'EXECUTE') then
		raise exception '1: the grants are wrong'; end if;
	perform pg_temp.violates($q$insert into public.qorpera_data_passes(pass_sha256, kind, environment_id, staff_agent_id,
		requester_user_id, files, expires_at) values (extensions.digest('a', 'sha256'), 'machine',
		'63200000-0000-4000-8000-000000000020', extensions.gen_random_uuid(), extensions.gen_random_uuid(), '[]', now())$q$,
		'qorpera_data_passes_kind_columns');
	perform pg_temp.violates($q$insert into public.qorpera_data_passes(pass_sha256, kind, environment_id, staff_agent_id,
		requester_user_id, files, expires_at, view_id, machine_id) values (extensions.digest('b', 'sha256'), 'desktop',
		'63200000-0000-4000-8000-000000000020', extensions.gen_random_uuid(), extensions.gen_random_uuid(), '[]', now(),
		extensions.gen_random_uuid(), extensions.gen_random_uuid())$q$, 'qorpera_data_passes_kind_check');
end $$;

do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); a jsonb := pg_temp.place(pg_temp.machine(v, 'data'));
	s jsonb := pg_temp.open_machine(a); made jsonb; redeemed jsonb; row public.qorpera_data_passes%rowtype; e jsonb;
	box jsonb;
begin
	made := pg_temp.mp_pass(s);
	perform pg_temp.mp_same(made ->> 'schema', 'qorpera.machine-data-pass/v1', '2: the schema');
	perform pg_temp.mp_same(((made ->> 'pass') ~ '^[A-Za-z0-9_-]{43}$')::text, 'true', '2: the pass');
	perform pg_temp.mp_same(made ->> 'files', '4', '2: the files kept');
	perform pg_temp.mp_same((select string_agg(x.value ->> 'path', ' ' order by x.ordinality)
		from jsonb_array_elements(made -> 'entries') with ordinality x),
		'data/shop/database.toml data/shop/tables/001-orders.sql data/shop/queries/count.sql data/shop/actions/add.sql',
		'2: the entries, in the listing''s order');
	for e in select x.value from jsonb_array_elements(made -> 'entries') x loop
		if e -> 'version' is distinct from pg_temp.read(e ->> 'path', pg_temp.vactor(s)) #> '{entry,version}'
			or e -> 'authority' is distinct from pg_temp.read(e ->> 'path', pg_temp.vactor(s)) #> '{entry,authority}'
			or jsonb_typeof(e -> 'authority') is distinct from 'object' or e - array['path','version','authority'] <> '{}'::jsonb then
			raise exception '2: the entry of % is not the view''s read: %', e ->> 'path', e; end if;
	end loop;
	select p.* into strict row from public.qorpera_data_passes p where p.pass_sha256 = extensions.digest(made ->> 'pass', 'sha256');
	if row.kind <> 'machine' or row.view_id::text is distinct from s ->> 'viewId' or row.machine_id::text is distinct from a ->> 'placementId'
		or row.run_id is not null or row.job_id is not null or row.database <> 'shop' or row.allow is not null
		or row.requester_user_id <> '63200000-0000-4000-8000-000000000002' then
		raise exception '2: the pass''s row: %', to_jsonb(row) - 'files'; end if;
	redeemed := pg_temp.mp_redeem(made ->> 'pass');
	perform pg_temp.mp_same((redeemed - 'files')::text, jsonb_build_object('schema', 'qorpera.data-pass-redeemed/v1', 'kind', 'machine',
		'environmentId', '63200000-0000-4000-8000-000000000020', 'viewId', s ->> 'viewId', 'machineId', a ->> 'placementId',
		'staffAgentId', row.staff_agent_id, 'requesterUserId', '63200000-0000-4000-8000-000000000002', 'database', 'shop')::text,
		'2: what the pass kept');
	perform pg_temp.mp_same((select string_agg(f.value ->> 'path', ' ' order by f.ordinality)
		from jsonb_array_elements(redeemed -> 'files') with ordinality f),
		'data/shop/database.toml data/shop/tables/001-orders.sql data/shop/queries/count.sql data/shop/actions/add.sql',
		'2: the files redeemed');
	if exists (select 1 from jsonb_array_elements(redeemed -> 'files') f where f.value - array['path','sha256','bytes'] <> '{}'::jsonb
			or f.value ->> 'sha256' !~ '^[0-9a-f]{64}$') then raise exception '2: a kept file is not path, sha256 and bytes'; end if;
	perform pg_temp.mp_same(pg_temp.mp_redeem(made ->> 'pass')::text, null, '2: a redeemed pass');
	perform pg_temp.mp_same(pg_temp.mp_pass(s, null) ->> 'files', '5', '2: every database');

	perform pg_temp.refused(format('select pg_temp.mp_pass(%L, %L)', s, 'nothing'), 'P0002', 'Data pass has no such database');
	perform pg_temp.refused(format('select pg_temp.mp_pass(%L, %L)', s, 'qorpera'), '22023', 'Database name is invalid');
	perform pg_temp.refused(format('select public.qorpera_machine_data_pass(%L, %L, %L)', '63200000-0000-4000-8000-000000000020',
		v, 'shop'), '22023', 'A machine''s data pass is for a view');
	perform pg_temp.refused(format('select public.qorpera_machine_data_pass(%L, %L, %L)', '63200000-0000-4000-8000-000000000020',
		'{"kind":"platform"}', 'shop'), '22023', 'A machine''s data pass is for a view');
	perform pg_temp.refused(format('select pg_temp.mp_pass(%L)', jsonb_build_object('viewId', s ->> 'viewId', 'pass', repeat('A', 43))),
		'42501', 'Folder view is unavailable');
	box := pg_temp.open('run_box', '{}', v);
	if pg_temp.read('data/shop/database.toml', pg_temp.vactor(box)) ->> 'found' is distinct from 'true' then
		raise exception '3: the run box''s view does not read the database''s file'; end if;
	perform pg_temp.refused(format('select pg_temp.mp_pass(%L)', box), '22023', 'A machine''s data pass is for a company machine''s view');
	perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"63200000-0000-4000-8000-000000000002"}', true);
	perform pg_temp.refused(format('select pg_temp.mp_pass(%L)', s), '42501', 'Folder core authority is required');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

	made := pg_temp.mp_pass(s);
	perform pg_temp.fx(format('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values (%L, %L, %L)',
		'63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000001', 'A test pause'));
	perform pg_temp.refused(format('select pg_temp.mp_pass(%L)', s), '55000', 'Company execution is paused');
	perform pg_temp.mp_same(pg_temp.mp_redeem(made ->> 'pass')::text, null, '4: a pass made before the pause, redeemed in it');
	perform pg_temp.fx($q$delete from public.qorpera_company_execution_pauses where profile_id = '63200000-0000-4000-8000-000000000010'$q$);
	perform pg_temp.mp_same(pg_temp.mp_redeem(pg_temp.mp_pass(s) ->> 'pass') ->> 'kind', 'machine', '4: after the pause');

	made := pg_temp.mp_pass(s);
	perform public.qorpera_folder_view_close((s ->> 'viewId')::uuid, s ->> 'pass');
	perform pg_temp.refused(format('select pg_temp.mp_pass(%L)', s), '42501', 'Folder view has ended');
	perform pg_temp.mp_same(pg_temp.mp_redeem(made ->> 'pass')::text, null, '5: a pass of a closed view');
	s := pg_temp.open_machine(pg_temp.reboot(a));
	perform pg_temp.mp_same(pg_temp.mp_redeem(pg_temp.mp_pass(s) ->> 'pass') ->> 'kind', 'machine', '5: the next boot''s view');
end $$;
