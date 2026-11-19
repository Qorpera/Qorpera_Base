-- @fixture 1270_claude_code_worker_on_home.test.sql until "-- The checks start here"

do $$
declare v jsonb; v_run uuid := pg_temp.c4c_run('claude'); v_owner uuid := pg_temp.c4_owner_id();
	v_other uuid := pg_temp.c4c_other_member();
begin
	perform pg_temp.base_assert((select sponsored_by_user_id from public.qorpera_execution_runs where id = v_run) = v_owner
		and (public.qorpera_run_worker(v_run)).requested_by_user_id = v_owner,
		'0: the Claude Code worker''s run is the owner''s word, on the owner''s own Codex login');
	v := public.qorpera_claude_worker_run_facts(pg_temp.c4c_binding('claude'));
	perform pg_temp.base_assert(v -> 'ownCodexLogin' = 'true'::jsonb and v ->> 'member' = pg_temp.c4_name()
		and v -> 'outputs' = '[]'::jsonb and v ? 'earlier',
		'1: the run''s Codex login is its member''s own: ' || v::text);
	begin
		set local session_replication_role = replica;
		update public.qorpera_execution_runs set sponsored_by_user_id = v_other where id = v_run;
		set local session_replication_role = origin;
		v := public.qorpera_claude_worker_run_facts(pg_temp.c4c_binding('claude'));
		perform pg_temp.base_assert(v -> 'ownCodexLogin' = 'false'::jsonb,
			'2: another member''s Codex login is not the worker''s own: ' || v::text);
		set local session_replication_role = replica;
		update public.qorpera_execution_runs set sponsored_by_user_id = null where id = v_run;
		set local session_replication_role = origin;
		v := public.qorpera_claude_worker_run_facts(pg_temp.c4c_binding('claude'));
		perform pg_temp.base_assert(v -> 'ownCodexLogin' = 'false'::jsonb,
			'3: a login no member owns (the company''s) is not the worker''s own: ' || v::text);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	perform pg_temp.base_assert(v_other is not null and v_other <> v_owner, '4: the fixture has another member');
	perform pg_temp.base_error(format('select public.qorpera_claude_worker_run_facts(%L)', pg_temp.c4c_binding('codex_write')),
		'42501');
	if has_function_privilege('authenticated', 'public.qorpera_claude_worker_run_facts(jsonb)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_claude_worker_run_facts(jsonb)', 'execute') then
		raise exception '5: only the runtime reads a worker run''s facts'; end if;
	if position('20260930812000' in pg_get_functiondef('public.qorpera_claude_worker_run_facts(jsonb)'::regprocedure)) = 0 then
		raise exception '5: the facts do not name 20260930812000'; end if;
end $$;
