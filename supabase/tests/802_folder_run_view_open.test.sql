-- @fixture 647_folder_core_run_fence.test.sql until "-- The checks start here: a test that runs after this file's fixture part stops at this line."
-- F3, the server-side folder search (20260928439970): the native host opens its run's own folder view through G2's
-- entry point with the job's lease token, the node lists it with each entry's receipt and renews it by its pass, and
-- the native host releases what an answer showed with the run actor (P8), which the next model request cites. A second
-- open in the same job supersedes the first; another job's actor, a platform actor and a job that is not current are
-- refused; only service_role and the G2 entry point reach the function.

create function pg_temp.human() returns jsonb language plpgsql as $$
declare p jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002');
begin
	return jsonb_build_object('actor', p, 'binding', pg_temp.native(p));
end $$;
create function pg_temp.vactor(p_view jsonb) returns jsonb language sql as $$
	select jsonb_build_object('kind','view','viewId',p_view ->> 'viewId','pass',p_view ->> 'pass')
$$;
-- Raises with this SQLSTATE and a message like this one.
create function pg_temp.raises_with(p_sql text, p_state text, p_message text) returns void language plpgsql as $$
begin
	execute p_sql;
	raise exception 'Expected SQLSTATE % from %', p_state, p_sql using errcode = 'QTF02';
exception when others then
	if sqlstate = 'QTF02' or sqlstate <> p_state or sqlerrm not like p_message then raise; end if;
end $$;
-- Gives a job a lease token the test knows (its hash, as the runner's claim sets it); the hand-built job's other
-- references are fixtures, so the update goes in with triggers off.
create function pg_temp.token(p_job uuid, p_token text) returns void language sql as $$
	select pg_temp.fx(format('update public.qorpera_runner_jobs set lease_token_sha256 = %L where id = %L',
		encode(extensions.digest(convert_to(p_token, 'utf8'), 'sha256'), 'hex'), p_job))
$$;
-- A call as the native host makes it: the publishable key's role, G2's entry point, the job's lease token. Returns the
-- result, or 'refused' for the entry point's own refusal, or the SQLSTATE; the caller's claims and role come back.
create function pg_temp.g2(p_job uuid, p_token text, p_name text, p_args jsonb) returns jsonb language plpgsql as $$
declare v_result jsonb; v_claims text := current_setting('request.jwt.claims', true);
	v_path text := current_setting('request.path', true);
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform set_config('request.path', '/rpc/qorpera_native_host_call', true);
	execute 'set local role anon';
	begin
		execute 'select public.qorpera_native_host_call($1, $2, $3, $4)' into v_result using p_job, p_token, p_name, p_args;
	exception when others then
		v_result := to_jsonb(case when sqlstate = '42501' and sqlerrm = 'native host call is refused' then 'refused' else sqlstate end);
	end;
	execute 'reset role';
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	perform set_config('request.path', coalesce(v_path, ''), true);
	return v_result;
end $$;

-- 1. The read path of a search answer, end to end.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	w jsonb := pg_temp.human(); p jsonb := w -> 'actor'; b jsonb := w -> 'binding';
	c_token constant text := 'f3-search-lease-token-0123456789';
	v_view jsonb; v_entries jsonb; v_reads jsonb; v_release uuid := extensions.gen_random_uuid();
	v_out text := repeat('7', 64); v_context jsonb; x jsonb;
begin
	perform pg_temp.fx(format('insert into public.qorpera_native_execution_launches(run_id, runtime_bundle_id, runtime_bundle_sha256, binary_sha256,
		reasoning_effort, reasoning_policy_sha256, tool_catalog_text, context_sha256, context_bytes) values (%L, %L, %L, %L, ''low'', %L, ''{}'', %L, 1)',
		b ->> 'runId', extensions.gen_random_uuid(), repeat('b', 64), repeat('c', 64), repeat('d', 64), repeat('e', 64)));
	x := pg_temp.commit('{"kind":"platform"}', 'search-setup', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','search'),
		jsonb_build_object('op','write','path','search/plan.md','file',pg_temp.stage('the plan')),
		jsonb_build_object('op','write','path','search/notes.md','file',pg_temp.stage('notes'))));
	perform pg_temp.expect(x, 1, 'saved');
	perform pg_temp.expect(x, 3, 'saved');
	perform pg_temp.token((p ->> 'jobId')::uuid, c_token);

	-- The native host opens its run's view with the run actor, through G2 (scope folder).
	v_view := pg_temp.g2((p ->> 'jobId')::uuid, c_token, 'qorpera_folder_run_view_open',
		jsonb_build_object('p_environment_id', c_env, 'p_actor', p));
	if v_view ->> 'schema' is distinct from 'qorpera.folder-view/v1' or v_view ->> 'pass' !~ '^[A-Za-z0-9_-]{43}$' then
		raise exception 'The run view through G2: %', v_view; end if;
	if not exists (select 1 from public.qorpera_folder_views where id = (v_view ->> 'viewId')::uuid and kind = 'run_box'
			and state = 'open' and run_id = (p ->> 'runId')::uuid and job_id = (p ->> 'jobId')::uuid
			and runner_id = (p ->> 'runnerId')::uuid and client_lease_id = (p ->> 'assignmentId')::uuid) then
		raise exception 'The run view is the run''s own'; end if;

	-- The node's folder service lists it as the run's agent, every entry with its receipt, and renews it by its pass.
	v_entries := (select jsonb_agg(e) from jsonb_array_elements(
			public.qorpera_folder_list(c_env, pg_temp.vactor(v_view), '', null, 1000, true) -> 'entries') e
		where e ->> 'path' like 'search%');
	if jsonb_array_length(v_entries) <> 3 or exists (select 1 from jsonb_array_elements(v_entries) e
			where coalesce(e -> 'authority' ->> 'resourceId', '') !~ '^[0-9a-f-]{36}$') then
		raise exception 'The run view lists each entry with its receipt: %', v_entries; end if;
	if public.qorpera_folder_view_renew((v_view ->> 'viewId')::uuid, v_view ->> 'pass') ->> 'state' <> 'open' then
		raise exception 'The folder service renews the run view'; end if;

	-- The native host releases what an answer showed, with the run actor, through G2 (P8; scope folder).
	v_reads := (select jsonb_agg(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority'))
		from jsonb_array_elements(v_entries) e);
	x := pg_temp.g2((p ->> 'jobId')::uuid, c_token, 'qorpera_folder_record_release', jsonb_build_object('p_environment_id', c_env,
		'p_actor', p, 'p_release_id', v_release, 'p_reads', v_reads, 'p_output_sha256', v_out));
	if (x ->> 'reads')::integer is distinct from 3 then raise exception 'The run release through G2: %', x; end if;

	-- The next model request cites it.
	v_context := jsonb_build_object('schema', 'qorpera.native-context-view/v1', 'requestId', 'search-1', 'threadId', 't',
		'turnId', null, 'purpose', 'turn', 'outputs', jsonb_build_array(jsonb_build_object('callId', 'search-1',
			'kind', 'function_call_output', 'sha256', repeat('8', 64), 'bytes', 100, 'readId', v_release, 'readSha256', v_out,
			'includedBytes', 90, 'includedSha256', repeat('9', 64))));
	if public.qorpera_record_native_context_view(c_env, b, v_context) ->> 'ordinal' <> '1' then
		raise exception 'The context view cites the run release'; end if;
	perform set_config('qorpera_test.search_actor', p::text, false);
	perform set_config('qorpera_test.search_view', v_view::text, false);
end $$;

-- 2. A second open in the same job (a native host that started again) supersedes the first, and only this job's run
-- view: another job's stays open.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	p jsonb := current_setting('qorpera_test.search_actor')::jsonb; v_first jsonb := current_setting('qorpera_test.search_view')::jsonb;
	v_second jsonb; x jsonb; v_neighbour jsonb := pg_temp.human() -> 'actor'; v_theirs jsonb;
begin
	v_theirs := public.qorpera_folder_run_view_open(c_env, v_neighbour);
	v_second := public.qorpera_folder_run_view_open(c_env, p);
	if public.qorpera_folder_view_renew((v_theirs ->> 'viewId')::uuid, v_theirs ->> 'pass') ->> 'state' <> 'open' then
		raise exception 'Another job''s run view was closed by this job''s open'; end if;
	x := public.qorpera_folder_view_renew((v_first ->> 'viewId')::uuid, v_first ->> 'pass');
	if x ->> 'state' <> 'closed' or x ->> 'reason' <> 'superseded' then raise exception 'The first view: %', x; end if;
	if public.qorpera_folder_view_renew((v_second ->> 'viewId')::uuid, v_second ->> 'pass') ->> 'state' <> 'open' then
		raise exception 'The second view is open'; end if;
	if (select count(*) from public.qorpera_folder_views where job_id = (p ->> 'jobId')::uuid and state = 'open') <> 1 then
		raise exception 'One open run view per job'; end if;
end $$;

-- 3. Refusals.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	p jsonb := current_setting('qorpera_test.search_actor')::jsonb; other jsonb := pg_temp.human() -> 'actor';
	c_token constant text := 'f3-search-lease-token-0123456789'; x jsonb;
begin
	-- Through G2, only this job's run actor: another job's is refused before the function runs.
	x := pg_temp.g2((p ->> 'jobId')::uuid, c_token, 'qorpera_folder_run_view_open',
		jsonb_build_object('p_environment_id', c_env, 'p_actor', other));
	if x is distinct from '"refused"'::jsonb then raise exception 'Another job''s actor through G2: %', x; end if;
	x := pg_temp.g2((p ->> 'jobId')::uuid, 'not-the-lease-token-0123456789', 'qorpera_folder_run_view_open',
		jsonb_build_object('p_environment_id', c_env, 'p_actor', p));
	if x is distinct from '"refused"'::jsonb then raise exception 'A wrong lease token: %', x; end if;
	-- Directly: a platform or member opener, a run actor with extra fields, a job that is not this run's or not current.
	perform pg_temp.raises_with(format('select public.qorpera_folder_run_view_open(%L, ''{"kind":"platform"}'')', c_env),
		'22023', 'Folder view opener is invalid');
	perform pg_temp.raises_with(format('select public.qorpera_folder_run_view_open(%L, %L)', c_env, p || '{"extra":1}'),
		'22023', 'Folder view opener is invalid');
	perform pg_temp.raises_with(format('select public.qorpera_folder_run_view_open(%L, %L)', c_env,
		jsonb_set(p, '{runId}', to_jsonb(other ->> 'runId'))), '42501', 'Folder run is not current');
	perform pg_temp.raises_with(format('select public.qorpera_folder_run_view_open(%L, %L)',
		'64700000-0000-4000-8000-000000000021', p), '42501', 'Folder run is not current');
	perform pg_temp.fx(format('update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval ''1 second'' where id = %L',
		other ->> 'jobId'));
	perform pg_temp.raises_with(format('select public.qorpera_folder_run_view_open(%L, %L)', c_env, other), '42501',
		'Folder run is not current');
end $$;

-- 4. Who reaches it: service_role and G2's entry point (scope folder), no API role.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'qorpera_secret_broker'] loop
		if has_function_privilege(v_role, 'public.qorpera_folder_run_view_open(uuid,jsonb)', 'EXECUTE') then
			raise exception 'The run view open is exposed to %', v_role; end if;
	end loop;
	if not has_function_privilege('service_role', 'public.qorpera_folder_run_view_open(uuid,jsonb)', 'EXECUTE') then
		raise exception 'The run view open lost its caller'; end if;
	if not exists (select 1 from public.qorpera_native_host_calls where name = 'qorpera_folder_run_view_open' and scope = 'folder'
			and budget = 'standard') then
		raise exception 'The native host cannot reach the run view open'; end if;
end $$;

rollback;
