-- @fixture 652_folder_core_run_effects.test.sql until "-- 2. The native send"
-- 20260930652000: one tool result may take up to 32 KiB. The run's context view takes an output's envelope and its
-- read's included text up to 32,768 bytes each (8,192 before), and refuses one byte more; a run log's step keeps a
-- result envelope up to 32,768 bytes as stored and refuses one byte more, while args, text and paths keep 8 KiB.

-- A step line as the run log writes it, with a result envelope whose text is `p_text` bytes of x.
create function pg_temp.result_step(p_text integer, p_args integer default 2) returns text language sql as $$
	select jsonb_build_object('j', 0, 'tool', 'company_read', 'call', 'c0', 'args', repeat('a', p_args), 'args_bytes', p_args,
		'args_hash', repeat('a', 64), 'result', jsonb_build_object('schema', 'qorpera.cloud-tool-result/v1',
			'trust', 'untrusted_data', 'status', 'ok', 'content', jsonb_build_object('kind', 'text', 'text', repeat('x', p_text))),
		'reads', '[]'::jsonb, 'releases', '[]'::jsonb, 'paths', '[]'::jsonb, 'text', '', 'at', '2026-11-08T10:00:00Z')::text
$$;
create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
	if p_ok is not true then raise exception 'Failed: %', p_what; end if;
end $$;
-- The bytes the step's result takes as stored, as the parser counts them.
create function pg_temp.result_bytes(p_line text) returns integer language sql as $$
	select octet_length((p_line::json -> 'result')::text)
$$;

do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	w jsonb := pg_temp.human(); p jsonb := w -> 'actor'; b jsonb := w -> 'binding'; v_release uuid := extensions.gen_random_uuid();
	v_out text := repeat('7', 64); v_view jsonb; x jsonb; v_over integer; v_at integer;
begin
	perform pg_temp.fx(format('insert into public.qorpera_native_execution_launches(run_id, runtime_bundle_id, runtime_bundle_sha256, binary_sha256,
		reasoning_effort, reasoning_policy_sha256, tool_catalog_text, context_sha256, context_bytes) values (%L, %L, %L, %L, ''low'', %L, ''{}'', %L, 1)',
		b ->> 'runId', extensions.gen_random_uuid(), repeat('b', 64), repeat('c', 64), repeat('d', 64), repeat('e', 64)));
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'fence-32k-setup', jsonb_build_array(jsonb_build_object('op','write',
		'path','long.md','file',pg_temp.stage('a long file')))), 1, 'saved');
	perform public.qorpera_folder_record_release(c_env, p, v_release,
		(select jsonb_agg(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority'))
			from (select pg_temp.read('long.md', p) -> 'entry' e) x), v_out);
	v_view := jsonb_build_object('schema', 'qorpera.native-context-view/v1', 'requestId', 'k-1', 'threadId', 't', 'turnId', null,
		'purpose', 'turn', 'outputs', jsonb_build_array(
			jsonb_build_object('callId', 'c1', 'kind', 'function_call_output', 'sha256', repeat('8', 64), 'bytes', 32768,
				'readId', v_release, 'readSha256', v_out, 'includedBytes', 32768, 'includedSha256', repeat('9', 64)),
			jsonb_build_object('callId', 'c2', 'kind', 'function_call_output', 'sha256', repeat('8', 64), 'bytes', 8193,
				'readId', null, 'readSha256', null, 'includedBytes', null, 'includedSha256', null)));

	-- A full 32 KiB envelope citing its read, and one past the old 8 KiB, are recorded.
	x := public.qorpera_record_native_context_view(c_env, b, v_view);
	perform pg_temp.check(x ->> 'ordinal' = '1', 'a view of 32 KiB outputs is recorded: ' || x::text);
	-- One byte more, in the envelope or in the read's included text, is refused, and so is a sixth digit.
	perform pg_temp.raises_like(format('select public.qorpera_record_native_context_view(%L, %L, %L)', c_env, b,
		jsonb_set(jsonb_set(v_view, '{requestId}', '"k-2"'), '{outputs,0,bytes}', '32769')), '22023', 'Context output is invalid');
	perform pg_temp.raises_like(format('select public.qorpera_record_native_context_view(%L, %L, %L)', c_env, b,
		jsonb_set(jsonb_set(v_view, '{requestId}', '"k-3"'), '{outputs,1,bytes}', '100000')), '22023', 'Context output is invalid');
	perform pg_temp.raises_like(format('select public.qorpera_record_native_context_view(%L, %L, %L)', c_env, b,
		jsonb_set(jsonb_set(v_view, '{requestId}', '"k-4"'), '{outputs,0,includedBytes}', '32769')), '42501',
		'Context read provenance differs');
	perform pg_temp.raises_like(format('select public.qorpera_record_native_context_view(%L, %L, %L)', c_env, b,
		jsonb_set(jsonb_set(v_view, '{requestId}', '"k-5"'), '{outputs,1,bytes}', '0')), '22023', 'Context output is invalid');

	-- A run log step: a result envelope of exactly 32,768 bytes as stored parses; one byte more does not.
	v_over := pg_temp.result_bytes(pg_temp.result_step(0));
	v_at := 32768 - v_over;
	perform pg_temp.check(pg_temp.result_bytes(pg_temp.result_step(v_at)) = 32768, 'the step result is 32,768 bytes as stored');
	x := public.qorpera_memory_run_step_line(pg_temp.result_step(v_at));
	perform pg_temp.check(x is not null and (x ->> 'finished')::boolean, 'a step with a 32 KiB result parses');
	perform pg_temp.check(public.qorpera_memory_run_step_line(pg_temp.result_step(v_at + 1)) is null,
		'a step with a result one byte past 32 KiB does not parse');
	-- What 8 KiB refused before now parses; args keep their 8 KiB.
	perform pg_temp.check(public.qorpera_memory_run_step_line(pg_temp.result_step(8192)) is not null,
		'a step with a result past 8 KiB parses');
	perform pg_temp.check(public.qorpera_memory_run_step_line(pg_temp.result_step(10, 8191)) is null,
		'args past 8 KiB as stored still do not parse');

	-- Both bodies name the migration.
	perform pg_temp.check(strpos(pg_get_functiondef('public.qorpera_folder_record_context_view(uuid,jsonb,jsonb)'::regprocedure),
		'20260930652000') > 0 and strpos(pg_get_functiondef('public.qorpera_memory_run_step_line(text)'::regprocedure),
		'20260930652000') > 0, 'the bodies name their migration');
end $$;
