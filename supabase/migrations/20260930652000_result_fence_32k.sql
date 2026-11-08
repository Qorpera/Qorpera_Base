-- One tool result may now take up to 32 KiB, not 8 KiB (perf sprint round 2, T2): the database's bounds on a result
-- move with the patched Codex's result fence (MAX_RESULT_BYTES) and the runtime's (MAX_CLOUD_TOOL_RESULT_BYTES). Only
-- the bounds move. Every check on a result stays, and each result stays one host-issued envelope.
-- 1. The run's context view (qorpera_folder_record_context_view, 20260928279560): an output's envelope bytes and the
--    included bytes of the read it cites, each up to 32,768 and so up to five digits (they were 8,192 and four).
--    The view records sizes and digests, never text, so a view row does not grow.
-- 2. A run log's step line (qorpera_memory_run_step_line, 20260928549100): a step keeps the envelope the model got, so
--    its `result` may take up to 32,768 bytes as stored; `args`, `text` and `paths` keep 8 KiB and `reads` 16 KiB. A
--    step past this bound does not parse, and its block is refused.
-- Larger bounds harm nothing while runtimes at 8 KiB still run, so this goes before the bundle that raises the
-- runtime's bound (with the new Codex pin); that bundle's activation should require it. The legacy view
-- (qorpera_record_native_context_view) is unchanged: on folder-v2 it answers with the folder view first, and the fence
-- (qorpera_fence_native_context) serves folder-v2 only.
set local lock_timeout = '3s';

do $body$
declare
	v_view constant regprocedure := 'public.qorpera_folder_record_context_view(uuid,jsonb,jsonb)'::regprocedure;
	v_step constant regprocedure := 'public.qorpera_memory_run_step_line(text)'::regprocedure;
	v_definition text;
	v_anchor record;
begin
	if strpos(pg_get_functiondef(v_view), '20260930652000') > 0 or strpos(pg_get_functiondef(v_step), '20260930652000') > 0 then
		raise exception '20260930652000 is already applied'; end if;
	v_definition := pg_get_functiondef(v_view);
	for v_anchor in select * from (values
		(E'\t\t\tor coalesce(v_output ->> ''bytes'','''') !~ ''^[1-9][0-9]{0,3}$''\n'
			|| E'\t\t\tor (v_output ->> ''bytes'')::integer > 8192 then\n',
		 E'\t\t\t-- 20260930652000: one result is up to 32 KiB, as the patched Codex fences it.\n'
			|| E'\t\t\tor coalesce(v_output ->> ''bytes'','''') !~ ''^[1-9][0-9]{0,4}$''\n'
			|| E'\t\t\tor (v_output ->> ''bytes'')::integer > 32768 then\n'),
		(E'\t\t\t\tor coalesce(v_output ->> ''includedBytes'','''') !~ ''^(0|[1-9][0-9]{0,3})$''\n'
			|| E'\t\t\t\tor (v_output ->> ''includedBytes'')::integer > 8192\n',
		 E'\t\t\t\tor coalesce(v_output ->> ''includedBytes'','''') !~ ''^(0|[1-9][0-9]{0,4})$''\n'
			|| E'\t\t\t\tor (v_output ->> ''includedBytes'')::integer > 32768\n')) a(old, new) loop
		if (length(v_definition) - length(replace(v_definition, v_anchor.old, ''))) / length(v_anchor.old) <> 1 then
			raise exception '20260930652000 anchor differs in qorpera_folder_record_context_view: %', v_anchor.old; end if;
		v_definition := replace(v_definition, v_anchor.old, v_anchor.new);
	end loop;
	execute v_definition;
	v_definition := pg_get_functiondef(v_step);
	for v_anchor in select * from (values
		(E'\t\tif octet_length((v_json -> ''args'')::text) > 8192 or octet_length((v_json -> ''text'')::text) > 8192\n'
			|| E'\t\t\tor octet_length((v_json -> ''result'')::text) > 8192 or octet_length((v_json -> ''reads'')::text) > 16384 then\n',
		 E'\t\t-- 20260930652000: a step keeps its whole result envelope, up to one result''s 32 KiB.\n'
			|| E'\t\tif octet_length((v_json -> ''args'')::text) > 8192 or octet_length((v_json -> ''text'')::text) > 8192\n'
			|| E'\t\t\tor octet_length((v_json -> ''result'')::text) > 32768 or octet_length((v_json -> ''reads'')::text) > 16384 then\n')) a(old, new) loop
		if (length(v_definition) - length(replace(v_definition, v_anchor.old, ''))) / length(v_anchor.old) <> 1 then
			raise exception '20260930652000 anchor differs in qorpera_memory_run_step_line: %', v_anchor.old; end if;
		v_definition := replace(v_definition, v_anchor.old, v_anchor.new);
	end loop;
	execute v_definition;
end
$body$;
