-- @fixture 761_folder_core_bytes.test.sql until "-- 1. The version-2 manifest"
-- Company folder core, SECURITY (migration 20260930043000): the bytes check decides possession before it calls a
-- reference malformed, so an actor who does not hold a file learns nothing about whether the company stores it (C1D §3).
-- A holder, and the platform, still get 22023 for a reference that disagrees with its manifest.

do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	b jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a2', 'human', '63400000-0000-4000-8000-000000000001');
	v_secret jsonb; v_res uuid; v_outcomes jsonb := '[]'::jsonb; v_ref jsonb; v_no integer := 0;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'oracle-seed-01', '[{"op":"mkdir","path":"vault"},{"op":"mkdir","path":"desk"}]'),
		1, 'saved');
	-- Agent A keeps a file in a folder only it may read.
	v_secret := pg_temp.stage_v2(a, array['the secret ', 'plan']);
	perform pg_temp.expect(pg_temp.commit(a, 'oracle-secret-01', jsonb_build_array(
		jsonb_build_object('op','write','path','vault/plan.md','file',v_secret))), 1, 'saved');
	v_res := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'vault', 'subtree', 'company_shared', 'normal') ->> 'resourceId';
	perform public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', '63400000-0000-4000-8000-0000000000a1',
		array['read','write']);
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', b, v_secret ->> 'manifestSha256'), '42501');

	-- Agent B knows the secret file's hashes and size, but does not hold it. Whatever it claims about the type, and
	-- whether or not the company stores the hashes, the answer is the same: bytes_unverified, never 22023.
	foreach v_ref in array array[
		v_secret,
		v_secret || '{"mediaType":"image/png"}',
		v_secret || '{"executable":true}',
		jsonb_build_object('manifestSha256', repeat('e', 64), 'fileSha256', repeat('f', 64), 'bytes', 15, 'mediaType', 'image/png',
			'executable', false)] loop
		v_no := v_no + 1;
		v_outcomes := v_outcomes || jsonb_build_array(pg_temp.commit(b, 'oracle-probe-' || lpad(v_no::text, 2, '0'),
			jsonb_build_array(jsonb_build_object('op','write','path','desk/probe-' || v_no || '.md','file',v_ref))) -> 'units' -> 0);
	end loop;
	-- The same through a new folder's file.
	v_outcomes := v_outcomes || jsonb_build_array(pg_temp.commit(b, 'oracle-probe-folder', jsonb_build_array(jsonb_build_object(
		'op','new_folder','path','desk/probe-folder','contents', jsonb_build_array(jsonb_build_object('kind','file','path','plan.md',
			'file', v_secret || '{"mediaType":"image/png"}'))))) -> 'units' -> 0);
	if jsonb_array_length(v_outcomes) <> 5 or exists (select 1 from jsonb_array_elements(v_outcomes) o
		where o ->> 'outcome' is distinct from 'refused' or o ->> 'reason' is distinct from 'bytes_unverified') then
		raise exception 'An actor who does not hold a file learns nothing about it: %', v_outcomes; end if;

	-- The holder, and the platform, are told the reference disagrees with its manifest.
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', a, 'oracle-holder-01', jsonb_build_array(
		jsonb_build_object('op','write','path','vault/typed.md','file',v_secret || '{"mediaType":"image/png"}'))), '22023');
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', '{"kind":"platform"}', 'oracle-platform-01',
		jsonb_build_array(jsonb_build_object('op','write','path','desk/typed.md','file',v_secret || '{"executable":true}'))), '22023');
	-- And the true reference still saves for the holder.
	perform pg_temp.expect(pg_temp.commit(a, 'oracle-holder-02', jsonb_build_array(
		jsonb_build_object('op','write','path','vault/copy.md','file',v_secret))), 1, 'saved');
end $$;

-- The check is placed after the possession check, and the body carries the marker.
do $$
declare v_body text := (select prosrc from pg_proc
	where oid = 'public.qorpera_folder_file_bytes_problem(uuid,uuid,jsonb,jsonb,jsonb,text[])'::regprocedure);
begin
	if strpos(v_body, '20260930043000') = 0
		or strpos(v_body, 'File reference does not match its manifest') < strpos(v_body, 'qorpera_folder_object_readable(')
		or (length(v_body) - length(replace(v_body, 'File reference does not match its manifest', '')))
			/ length('File reference does not match its manifest') <> 1 then
		raise exception 'The bytes check decides possession before it calls a reference malformed'; end if;
end $$;

rollback;
