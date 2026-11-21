-- @fixture 647_folder_core_run_fence.test.sql until "-- The checks start here: a test that runs after this file's fixture part stops at this line."

create function pg_temp.cd_same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;

create function pg_temp.cd_redeem(p_pass text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	v := public.qorpera_data_pass_redeem(p_pass);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return v;
end $$;

create function pg_temp.cd_session(p_parent jsonb, p_machine uuid) returns jsonb language plpgsql as $$
declare w uuid := pg_temp.worker('63400000-0000-4000-8000-0000000000a1', p_parent, 'coding', 'read', '63400000-0000-4000-8000-000000000002');
	tok uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, vm_allocation_id,
		attached_machine_id, attachment_token, attachment_until, attachment_turn, attached_at)
	values (w, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', 'claude-code',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'qorpera/' || left(w::text, 8),
		p_machine, p_machine, tok, clock_timestamp() + interval '1 hour', 1, clock_timestamp());
	set local session_replication_role = origin;
	return jsonb_build_object('workerId', w, 'attachmentToken', tok);
end $$;

create function pg_temp.cd_open(p_session jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_view_open('63400000-0000-4000-8000-000000000020', '{"kind":"platform"}', 'coding_session', p_session)
$$;

create function pg_temp.cd_vactor(p_view jsonb) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'view', 'viewId', p_view ->> 'viewId', 'pass', p_view ->> 'pass')
$$;

create function pg_temp.cd_pass(p_view jsonb, p_database text default 'shop') returns jsonb language sql as $$
	select public.qorpera_machine_data_pass('63400000-0000-4000-8000-000000000020', pg_temp.cd_vactor(p_view), p_database)
$$;

do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1';
	c_member constant uuid := '63400000-0000-4000-8000-000000000002';
	c_m constant uuid := '13190000-0000-4000-8000-0000000000c1';
	p jsonb := pg_temp.run(c_a, 'human', c_member);
	s1 jsonb; v1 jsonb; t1 jsonb; made jsonb; redeemed jsonb; row public.qorpera_data_passes%rowtype;
	e jsonb; r jsonb; rid uuid := extensions.gen_random_uuid();
	v_res_member_only uuid; v_res_agent_only uuid; v_project_id uuid := extensions.gen_random_uuid(); v_shop_res uuid;
	v_box jsonb; v_code_host jsonb; v_prosrc text;
begin
	if has_function_privilege('anon', 'public.qorpera_machine_data_pass(uuid,jsonb,text)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_machine_data_pass(uuid,jsonb,text)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_machine_data_pass(uuid,jsonb,text)', 'EXECUTE')
		or not has_function_privilege('anon', 'public.qorpera_data_pass_redeem(text)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_data_pass_redeem(text)', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_data_pass_redeem(text)', 'EXECUTE') then
		raise exception '1: function grants are wrong'; end if;

	select prosrc into strict v_prosrc from pg_proc where oid = 'public.qorpera_machine_data_pass(uuid,jsonb,text)'::regprocedure;
	if position('20260930829000' in v_prosrc) = 0 or position('20260930775000' in v_prosrc) = 0 then
		raise exception '1: qorpera_machine_data_pass missing migration markers'; end if;
	select prosrc into strict v_prosrc from pg_proc where oid = 'public.qorpera_data_pass_redeem(text)'::regprocedure;
	if position('20260930829000' in v_prosrc) = 0 or position('20260930775000' in v_prosrc) = 0 then
		raise exception '1: qorpera_data_pass_redeem missing migration markers'; end if;

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding,
		instance_sha256)
	values (c_m, 'member', c_profile, c_env, c_member, 'exec-1', repeat('8', 64), '{}',
		encode(extensions.digest(convert_to('{}', 'utf8'), 'sha256'), 'hex'));
	insert into public.qorpera_runtime_machine_allocations(id, profile_id, provider_adapter, instance_sha256, coding_machine_id, reserved_at)
	values (c_m, c_profile, 'lxd', repeat('9', 64), c_m, clock_timestamp());
	insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
	values (c_env, c_a, '{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', true);
	insert into public.qorpera_coding_executors(environment_id, owner, enabled) values (c_env, 'exec-1', true);
	set local session_replication_role = origin;

	perform pg_temp.commit('{"kind":"platform"}', 'coding-data-seed', jsonb_build_array(
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
			'file', pg_temp.stage(E'format = "qorpera.database/v1"\n')),
		jsonb_build_object('op', 'mkdir', 'path', 'data/member_only'),
		jsonb_build_object('op', 'write', 'path', 'data/member_only/database.toml',
			'file', pg_temp.stage(E'format = "qorpera.database/v1"\n')),
		jsonb_build_object('op', 'mkdir', 'path', 'data/agent_only'),
		jsonb_build_object('op', 'write', 'path', 'data/agent_only/database.toml',
			'file', pg_temp.stage(E'format = "qorpera.database/v1"\n'))));

	v_res_member_only := (public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'data/member_only', 'subtree', 'company_shared', 'normal') ->> 'resourceId')::uuid;
	v_res_agent_only := (public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'data/agent_only', 'subtree', 'company_shared', 'normal') ->> 'resourceId')::uuid;
	set local session_replication_role = replica;
	insert into public.qorpera_company_projects(id, profile_id, environment_id, project_key, name, objective, definition_of_done,
		scope_kind, lead_staff_agent_id, status, source_path, source_path_version, source_snapshot_id, source_file_sha256, created_by_user_id)
	values (v_project_id, c_profile, c_env, 'agent-only', 'Agent only project', 'Test', 'Done',
		'company', c_a, 'active', 'organization/projects/' || v_project_id::text || '.json', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		repeat('a', 64), '63400000-0000-4000-8000-000000000001');
	insert into public.qorpera_project_staff_memberships(profile_id, project_id, staff_agent_id, role, status, created_by_user_id)
	values (c_profile, v_project_id, c_a, 'lead', 'active', '63400000-0000-4000-8000-000000000001');
	update public.qorpera_company_path_resources set scope = 'project_scoped' where id = v_res_agent_only;
	insert into public.qorpera_project_path_resources(profile_id, project_id, resource_id, member_permissions, staff_permissions,
		source_path_version, created_by_user_id)
	values (c_profile, v_project_id, v_res_agent_only, array['read'], array['read'],
		extensions.gen_random_uuid(), '63400000-0000-4000-8000-000000000001');
	set local session_replication_role = origin;

	s1 := pg_temp.cd_session(p, c_m);
	v1 := pg_temp.cd_open(s1);

	made := pg_temp.cd_pass(v1, 'shop');
	perform pg_temp.cd_same(made ->> 'schema', 'qorpera.machine-data-pass/v1', '2: schema');
	perform pg_temp.cd_same(((made ->> 'pass') ~ '^[A-Za-z0-9_-]{43}$')::text, 'true', '2: pass');
	perform pg_temp.cd_same(made ->> 'files', '4', '2: files count');
	perform pg_temp.cd_same((select string_agg(x.value ->> 'path', ' ' order by x.ordinality)
		from jsonb_array_elements(made -> 'entries') with ordinality x),
		'data/shop/database.toml data/shop/tables/001-orders.sql data/shop/queries/count.sql data/shop/actions/add.sql',
		'2: entries order');
	for e in select x.value from jsonb_array_elements(made -> 'entries') x loop
		if e -> 'version' is distinct from pg_temp.read(e ->> 'path', pg_temp.cd_vactor(v1)) #> '{entry,version}'
			or e -> 'authority' is distinct from pg_temp.read(e ->> 'path', pg_temp.cd_vactor(v1)) #> '{entry,authority}'
			or jsonb_typeof(e -> 'authority') is distinct from 'object'
			or e - array['path','version','authority'] <> '{}'::jsonb then
			raise exception '2: entry mismatch for %: %', e ->> 'path', e; end if;
	end loop;

	select dp.* into strict row from public.qorpera_data_passes dp where dp.pass_sha256 = extensions.digest(made ->> 'pass', 'sha256');
	if row.kind <> 'machine' or row.view_id::text is distinct from v1 ->> 'viewId' or row.machine_id <> c_m
		or row.run_id is not null or row.job_id is not null or row.database <> 'shop' or row.allow is not null
		or row.staff_agent_id <> c_a or row.requester_user_id <> c_member then
		raise exception '2: pass row mismatch: %', to_jsonb(row) - 'files'; end if;

	redeemed := pg_temp.cd_redeem(made ->> 'pass');
	perform pg_temp.cd_same((redeemed - 'files')::text, jsonb_build_object('schema', 'qorpera.data-pass-redeemed/v1', 'kind', 'machine',
		'environmentId', c_env, 'viewId', v1 ->> 'viewId', 'machineId', c_m,
		'staffAgentId', c_a, 'requesterUserId', c_member, 'database', 'shop')::text, '2: redeemed payload');
	perform pg_temp.cd_same((select string_agg(f.value ->> 'path', ' ' order by f.ordinality)
		from jsonb_array_elements(redeemed -> 'files') with ordinality f),
		'data/shop/database.toml data/shop/tables/001-orders.sql data/shop/queries/count.sql data/shop/actions/add.sql',
		'2: redeemed files');
	perform pg_temp.cd_same(pg_temp.cd_redeem(made ->> 'pass')::text, null, '2: second redeem');

	perform pg_temp.cd_same((select string_agg(x.value ->> 'path', ' ' order by x.ordinality)
		from jsonb_array_elements(pg_temp.cd_pass(v1, null) -> 'entries') with ordinality x),
		'data/shop/database.toml data/shop/tables/001-orders.sql data/shop/queries/count.sql data/shop/actions/add.sql data/stock/database.toml',
		'3: null database lists intersection only');
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L, %L)', v1, 'member_only'), 'P0002', 'Data pass has no such database');
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L, %L)', v1, 'agent_only'), 'P0002', 'Data pass has no such database');
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L, %L)', v1, 'missing'), 'P0002', 'Data pass has no such database');
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L, %L)', v1, 'qorpera'), '22023', 'Database name is invalid');

	t1 := pg_temp.run(c_a, 'agent', c_member, 'worker-dispatch', p, (s1 ->> 'workerId')::uuid);
	v_shop_res := (made #>> '{entries,0,authority,resourceId}')::uuid;
	r := pg_temp.release(pg_temp.cd_vactor(v1), rid, made -> 'entries', repeat('1', 64));
	if r ->> 'runId' is distinct from t1 ->> 'runId' then
		raise exception '4: release did not answer for coding turn: %', r; end if;
	if not exists (select 1 from public.qorpera_coding_machine_reads where coding_machine_id = c_m and resource_id = v_shop_res)
		or not exists (select 1 from public.qorpera_coding_machine_read_records where coding_machine_id = c_m and release_id = rid
			and reads @> '[{"path":"data/shop/database.toml"}]')
		or not exists (select 1 from public.qorpera_folder_run_reads where run_id = (t1 ->> 'runId')::uuid and resource_id = v_shop_res) then
		raise exception '4: provenance reads did not land in coding machine and turn read sets'; end if;

	v_box := public.qorpera_folder_view_open(c_env, p, 'run_box', '{}');
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L)', v_box), '22023', 'A machine''s data pass is for a company machine''s view');
	v_code_host := public.qorpera_folder_view_open(c_env, '{"kind":"platform"}', 'code_host', '{}');
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L)', v_code_host), '22023', 'A machine''s data pass is for a company machine''s view');
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L)', jsonb_build_object('viewId', v1 ->> 'viewId', 'pass', repeat('A', 43))),
		'42501', 'Folder view is unavailable');
	perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"63400000-0000-4000-8000-000000000002"}', true);
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L)', v1), '42501', 'Folder core authority is required');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

	made := pg_temp.cd_pass(v1, 'shop');
	perform pg_temp.fx(format('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values (%L, %L, %L)',
		c_profile, '63400000-0000-4000-8000-000000000001', 'Pause test'));
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L)', v1), '55000', 'Company execution is paused');
	perform pg_temp.cd_same(pg_temp.cd_redeem(made ->> 'pass')::text, null, '5: redeem during pause');
	perform pg_temp.fx(format('delete from public.qorpera_company_execution_pauses where profile_id = %L', c_profile));

	made := pg_temp.cd_pass(v1, 'shop');
	perform pg_temp.fx(format('insert into public.qorpera_company_deletions(profile_id, requested_by_user_id) values (%L, %L)',
		c_profile, '63400000-0000-4000-8000-000000000001'));
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L)', v1), '55000', 'Company execution is paused');
	perform pg_temp.cd_same(pg_temp.cd_redeem(made ->> 'pass')::text, null, '5: redeem during deletion');
	perform pg_temp.fx(format('delete from public.qorpera_company_deletions where profile_id = %L', c_profile));

	made := pg_temp.cd_pass(v1, 'shop');
	perform pg_temp.fx(format('update public.qorpera_coding_machines set folder_restart_at = clock_timestamp() where id = %L', c_m));
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L)', v1), '42501', 'Folder view has ended');
	perform pg_temp.cd_same(pg_temp.cd_redeem(made ->> 'pass')::text, null, '6: redeem when machine marked for folder restart');
	perform pg_temp.fx(format('update public.qorpera_coding_machines set folder_restart_at = null where id = %L', c_m));

	made := pg_temp.cd_pass(v1, 'shop');
	perform pg_temp.fx(format('update public.qorpera_coding_machines set removing_at = clock_timestamp() where id = %L', c_m));
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L)', v1), '42501', 'Folder view has ended');
	perform pg_temp.cd_same(pg_temp.cd_redeem(made ->> 'pass')::text, null, '6: redeem when machine removing');
	perform pg_temp.fx(format('update public.qorpera_coding_machines set removing_at = null where id = %L', c_m));

	made := pg_temp.cd_pass(v1, 'shop');
	perform pg_temp.fx(format('update public.qorpera_coding_sessions set archived_at = clock_timestamp(), archived_by = ''member'' where worker_id = %L',
		s1 ->> 'workerId'));
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L)', v1), '42501', 'Folder view has ended');
	perform pg_temp.cd_same(pg_temp.cd_redeem(made ->> 'pass')::text, null, '7: redeem during 240s archive grace window');
	perform pg_temp.fx(format('update public.qorpera_coding_sessions set archived_at = null, archived_by = null where worker_id = %L', s1 ->> 'workerId'));

	made := pg_temp.cd_pass(v1, 'shop');
	perform pg_temp.fx(format('update public.qorpera_profile_staff set employment_status = ''archived'' where profile_id = %L and staff_agent_id = %L',
		c_profile, c_a));
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L)', v1), '42501', 'Folder view agent is unavailable');
	perform pg_temp.cd_same(pg_temp.cd_redeem(made ->> 'pass')::text, null, '7: redeem after staff archived');
	perform pg_temp.fx(format('update public.qorpera_profile_staff set employment_status = ''active'' where profile_id = %L and staff_agent_id = %L',
		c_profile, c_a));

	made := pg_temp.cd_pass(v1, 'shop');
	perform pg_temp.fx(format('update public.qorpera_folder_views set lease_until = clock_timestamp() - interval ''1 second'' where id = %L', v1 ->> 'viewId'));
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L)', v1), '42501', 'Folder view has ended');
	perform pg_temp.cd_same(pg_temp.cd_redeem(made ->> 'pass')::text, null, '8: redeem after view lease expired');
	perform pg_temp.fx(format('update public.qorpera_folder_views set lease_until = clock_timestamp() + interval ''2 minutes'' where id = %L', v1 ->> 'viewId'));

	made := pg_temp.cd_pass(v1, 'shop');
	perform public.qorpera_folder_view_close((v1 ->> 'viewId')::uuid, v1 ->> 'pass');
	perform pg_temp.raises_like(format('select pg_temp.cd_pass(%L)', v1), '42501', 'Folder view has ended');
	perform pg_temp.cd_same(pg_temp.cd_redeem(made ->> 'pass')::text, null, '8: redeem after view closed');
end $$;

rollback;
