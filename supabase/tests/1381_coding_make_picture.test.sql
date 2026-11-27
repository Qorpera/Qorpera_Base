-- @fixture 490_folder_git_rules.test.sql until "-- A coding session writes its own worktree"

do $$
declare
	v_commit text := pg_get_functiondef('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure);
	v_begin text := pg_get_functiondef('public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)'::regprocedure);
begin
	if strpos(v_commit, '20260930446200') = 0
		or strpos(v_commit, '20260930446000') = 0
		or strpos(v_commit, '20260930445000') = 0
		or strpos(v_commit, 'qorpera_run_worker') = 0 then
		raise exception 'qorpera_folder_commit missing expected coding make_picture patch or markers';
	end if;
	if strpos(v_begin, '''make_picture''') = 0
		or strpos(v_begin, 'case when v_is_surface then 11 else 7 end') = 0 then
		raise exception 'qorpera_begin_native_coding_execution missing make_picture allowlist update';
	end if;
end $$;

do $$
declare
	w1 text := pg_temp.wk(1);
	w2 text := pg_temp.wk(2);
	d text := 'code/acme/app/';
	g text := 'code/acme/app/repo.git/';
	v_parent uuid;
	v_coding_run jsonb;
	v_inhouse_run jsonb;
	a jsonb := pg_temp.stage('coding-pic-alpha');
	r jsonb;
begin
	select steering_run_id into v_parent from public.qorpera_runtime_workers where id = w1::uuid;
	v_coding_run := pg_temp.turn(jsonb_build_object('runId', v_parent), w1::uuid);

	r := pg_temp.commit(v_coding_run, 'coding-pic-own', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', d || 'worktrees/' || w1 || '/assets'),
		jsonb_build_object('op', 'write', 'path', d || 'worktrees/' || w1 || '/assets/hero.png', 'file', a),
		jsonb_build_object('op', 'write', 'path', d || 'worktrees/' || w2 || '/other.png', 'file', a),
		jsonb_build_object('op', 'write', 'path', d || 'main/hero.png', 'file', a),
		jsonb_build_object('op', 'write', 'path', g || 'config', 'file', a, 'expectedVersion', pg_temp.ver(g || 'config')),
		jsonb_build_object('op', 'write', 'path', g || 'refs/heads/coding-pic', 'file', a),
		jsonb_build_object('op', 'write', 'path', g || 'worktrees/' || w1 || '/HEAD', 'file', a),
		jsonb_build_object('op', 'write', 'path', g || 'worktrees/' || w1 || '/index', 'file', a)
	));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.expect(r, 3, 'refused', 'git_other_worker');
	perform pg_temp.expect(r, 4, 'refused', 'git_platform_only');
	perform pg_temp.expect(r, 5, 'refused', 'git_platform_only');
	perform pg_temp.expect(r, 6, 'refused', 'git_lease_required');
	perform pg_temp.expect(r, 7, 'refused', 'git_other_worker');
	perform pg_temp.expect(r, 8, 'refused', 'git_other_worker');

	v_inhouse_run := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	r := pg_temp.commit(v_inhouse_run, 'inhouse-pic-refused', jsonb_build_array(
		jsonb_build_object('op', 'write', 'path', d || 'worktrees/' || w1 || '/nope.png', 'file', a)
	));
	perform pg_temp.expect(r, 1, 'refused', 'git_other_worker');
end $$;

do $$
declare
	v_err text;
begin
	create or replace function public.qorpera_authorize_coding_turn(p_binding jsonb) returns jsonb language sql as $f$
		select jsonb_build_object('coding', jsonb_build_object('surfaceSessionId', p_binding ->> 'surface'))
	$f$;
	create or replace function public.qorpera_begin_native_company_execution_v2(
		p_binding jsonb, p_binary_sha256 text, p_runtime_bundle_sha256 text, p_reasoning_policy_sha256 text,
		p_tool_catalog_text text, p_context_sha256 text, p_context_bytes integer
	) returns jsonb language sql as $f$ select '{"admitted":true}'::jsonb $f$;

	if public.qorpera_begin_native_coding_execution(
		'{}'::jsonb, repeat('a', 64), repeat('b', 64), repeat('c', 64),
		'{"tools":[{"name":"coding_run_command"},{"name":"coding_read_command"},{"name":"coding_cancel_command"},{"name":"make_picture"},{"name":"coding_finish"},{"name":"coding_ask"}]}',
		repeat('d', 64), 100
	) <> '{"admitted":true}'::jsonb then
		raise exception 'standard coding session did not admit make_picture';
	end if;

	if public.qorpera_begin_native_coding_execution(
		jsonb_build_object('surface', extensions.gen_random_uuid()), repeat('a', 64), repeat('b', 64), repeat('c', 64),
		'{"tools":[{"name":"coding_run_command"},{"name":"coding_read_command"},{"name":"coding_cancel_command"},{"name":"coding_record_change"},{"name":"coding_view_attachment"},{"name":"make_picture"},{"name":"coding_finish"},{"name":"coding_ask"}]}',
		repeat('d', 64), 100
	) <> '{"admitted":true}'::jsonb then
		raise exception 'surface coding session did not admit eight tools including make_picture';
	end if;

	v_err := null;
	begin
		perform public.qorpera_begin_native_coding_execution(
			'{}'::jsonb, repeat('a', 64), repeat('b', 64), repeat('c', 64),
			'{"tools":[{"name":"coding_run_command"},{"name":"coding_read_command"},{"name":"coding_cancel_command"},{"name":"make_picture"},{"name":"coding_finish"},{"name":"company_write"}]}',
			repeat('d', 64), 100
		);
	exception when others then
		v_err := sqlstate || ':' || sqlerrm;
	end;
	if v_err is distinct from '42501:Coding catalog must contain only coding tools' then
		raise exception 'non-coding tool was not refused: %', coalesce(v_err, 'ok');
	end if;

	v_err := null;
	begin
		perform public.qorpera_begin_native_coding_execution(
			'{}'::jsonb, repeat('a', 64), repeat('b', 64), repeat('c', 64),
			'{"tools":[{"name":"coding_run_command"},{"name":"coding_read_command"},{"name":"coding_cancel_command"},{"name":"make_picture"},{"name":"coding_view_attachment"},{"name":"coding_finish"}]}',
			repeat('d', 64), 100
		);
	exception when others then
		v_err := sqlstate || ':' || sqlerrm;
	end;
	if v_err is distinct from '42501:Coding catalog must contain only coding tools' then
		raise exception 'non-surface session did not refuse coding_view_attachment alongside make_picture: %', coalesce(v_err, 'ok');
	end if;
end $$;

rollback;
