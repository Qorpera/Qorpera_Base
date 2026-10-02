-- @fixture 647_folder_core_run_fence.test.sql until "-- 1. Snapshot-v1 keeps its text"
-- F3 step 2b-3 (deploy/first-node/RUNTIME-FOLDER-SERVICE.md, "Step 2b"): the run box's read path as the shared
-- execution service, the node's folder service and the native host use it. The run actor opens the run's box; the box's
-- view lists the folder with each entry's receipt (what the box's folder program logs with a read); the native host
-- releases those reads with the run actor, and the next model request's context view cites that release. A release by
-- the view itself is not citable, a stale or missing receipt is checked again, and a company without a folder-v2 folder
-- refuses the box with the text the service knows it by. The observation vocabulary names the box's tools.

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

-- 1. The read path, end to end.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	w jsonb := pg_temp.human(); p jsonb := w -> 'actor'; b jsonb := w -> 'binding';
	v_view jsonb; v_list jsonb; v_entries jsonb; v_reads jsonb; v_release uuid := extensions.gen_random_uuid();
	v_out text := repeat('7', 64); v_context jsonb; x jsonb; v_view_release uuid := extensions.gen_random_uuid();
	v_stale uuid := extensions.gen_random_uuid(); v_bare uuid := extensions.gen_random_uuid(); v_root uuid;
begin
	perform pg_temp.fx(format('insert into public.qorpera_native_execution_launches(run_id, runtime_bundle_id, runtime_bundle_sha256, binary_sha256,
		reasoning_effort, reasoning_policy_sha256, tool_catalog_text, context_sha256, context_bytes) values (%L, %L, %L, %L, ''low'', %L, ''{}'', %L, 1)',
		b ->> 'runId', extensions.gen_random_uuid(), repeat('b', 64), repeat('c', 64), repeat('d', 64), repeat('e', 64)));
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'box-setup', jsonb_build_array(
		jsonb_build_object('op','write','path','box/plan.md','file',pg_temp.stage('the plan')),
		jsonb_build_object('op','write','path','box/notes.md','file',pg_temp.stage('notes')))), 1, 'saved');

	-- The shared execution service opens the run's box with the run actor (its pass goes only into the box's view file).
	v_view := public.qorpera_folder_view_open(c_env, p, 'run_box', '{}');
	if v_view ->> 'schema' <> 'qorpera.folder-view/v1' or v_view ->> 'pass' !~ '^[A-Za-z0-9_-]{43}$' then
		raise exception 'The box view: %', v_view; end if;

	-- The node lists the view as the run's agent: every entry with its receipt.
	v_list := public.qorpera_folder_list(c_env, pg_temp.vactor(v_view), '', null, 1000, true);
	v_entries := (select jsonb_agg(e) from jsonb_array_elements(v_list -> 'entries') e where e ->> 'path' like 'box%');
	if jsonb_array_length(v_entries) <> 3 or exists (select 1 from jsonb_array_elements(v_entries) e
			where coalesce(e -> 'authority' ->> 'resourceId', '') !~ '^[0-9a-f-]{36}$'
				or coalesce(e -> 'authority' ->> 'resourceRevision', '') !~ '^[0-9]+$') then
		raise exception 'The box listing names each entry with its receipt: %', v_entries; end if;

	-- The native host releases what the box read, with the run actor, under the answer's hash.
	v_reads := (select jsonb_agg(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority'))
		from jsonb_array_elements(v_entries) e);
	x := public.qorpera_folder_record_release(c_env, p, v_release, v_reads, v_out);
	if (x ->> 'reads')::integer <> 3 or (x ->> 'replay')::boolean then raise exception 'The run release: %', x; end if;

	-- The next model request cites it.
	v_context := jsonb_build_object('schema', 'qorpera.native-context-view/v1', 'requestId', 'box-1', 'threadId', 't', 'turnId', null,
		'purpose', 'turn', 'outputs', jsonb_build_array(jsonb_build_object('callId', 'exec-1', 'kind', 'function_call_output',
			'sha256', repeat('8', 64), 'bytes', 100, 'readId', v_release, 'readSha256', v_out, 'includedBytes', 90,
			'includedSha256', repeat('9', 64))));
	if public.qorpera_record_native_context_view(c_env, b, v_context) ->> 'ordinal' <> '1' then
		raise exception 'The context view cites the run release'; end if;

	-- A release by the view itself records the run's reads too, but a context view cannot cite it.
	x := public.qorpera_folder_record_release(c_env, pg_temp.vactor(v_view), v_view_release, v_reads, v_out);
	if x ->> 'runId' is distinct from p ->> 'runId' then raise exception 'The view release names its run: %', x; end if;
	perform pg_temp.raises_with(format('select public.qorpera_record_native_context_view(%L, %L, %L)', c_env, b,
		jsonb_set(jsonb_set(v_context, '{requestId}', '"box-2"'), '{outputs,0,readId}', to_jsonb(v_view_release))), '42501',
		'Context read provenance differs');

	-- A receipt that no longer holds, or none at all (the native host's stand-in), is checked again and filed with the
	-- current one.
	x := public.qorpera_folder_record_release(c_env, p, v_stale,
		jsonb_set(v_reads, '{0,authority,resourceRevision}', to_jsonb(((v_reads -> 0 -> 'authority' ->> 'resourceRevision')::bigint + 1000))),
		v_out);
	if (x ->> 'reads')::integer <> 3 then raise exception 'A stale receipt: %', x; end if;
	x := public.qorpera_folder_record_release(c_env, p, v_bare, jsonb_build_array(jsonb_build_object('path', 'box/plan.md',
		'version', (select e ->> 'version' from jsonb_array_elements(v_entries) e where e ->> 'path' = 'box/plan.md'),
		'authority', jsonb_build_object('resourceId', '00000000-0000-0000-0000-000000000000',
			'resourceRevision', 0, 'grantId', null, 'grantRevision', null))), v_out);
	if (x ->> 'reads')::integer <> 1 then raise exception 'No receipt: %', x; end if;
	select (r -> 'authority' ->> 'resourceId')::uuid into v_root from public.qorpera_folder_run_read_records rr,
		jsonb_array_elements(rr.reads) r where rr.run_id = (p ->> 'runId')::uuid and rr.release_id = v_bare;
	if v_root is distinct from (select (e -> 'authority' ->> 'resourceId')::uuid from jsonb_array_elements(v_entries) e
			where e ->> 'path' = 'box/plan.md') then
		raise exception 'A read without a receipt is filed under its current one'; end if;
end $$;

-- 2. A company without a folder-v2 folder refuses the box with exactly the refusal the shared execution service treats
-- as "no box" (RUN_BOX_NO_FOLDER_MESSAGE in packages/runner-orchestrator/src/shared-execution-backend.ts).
select pg_temp.raises_with(format('select public.qorpera_folder_view_open(%L, %L, ''run_box'', ''{}'')',
	'64700000-0000-4000-8000-000000000021', jsonb_build_object('kind','run','runId',extensions.gen_random_uuid(),
		'jobId','64700000-0000-4000-8000-0000000000c1','runnerId',extensions.gen_random_uuid(),'assignmentId',extensions.gen_random_uuid())),
	'42501', 'Company folder is unavailable');

-- 3. Observations name the box's tools; the list around them is unchanged.
do $$ begin
	if position('''read_event'',''send_mail'',''exec_command'',''write_stdin'',' in
			pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure)) = 0 then
		raise exception 'The observation vocabulary names exec_command and write_stdin'; end if;
end $$;
