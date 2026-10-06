-- @fixture 761_folder_core_bytes.test.sql until "-- 1. The version-2 manifest"
-- F3 step 3c-2 (#867): which files one commit kept as conflict copies (qorpera_folder_conflict_copies_of,
-- 20260930101000). The node's folder service drops a conflicting save's pending bytes only once every file of the unit
-- is listed here: by unit and file, with the path and the manifest; nothing for a conflict whose bytes were not kept,
-- nor for another commit or environment; the service role only.

create function pg_temp.copies_of(p_commit jsonb, p_env uuid default '63400000-0000-4000-8000-000000000020') returns jsonb
language sql as $$
	select public.qorpera_folder_conflict_copies_of(p_env, (p_commit ->> 'commitId')::uuid)
$$;
create function pg_temp.version_of(p_key text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries
	where environment_id = '63400000-0000-4000-8000-000000000020' and key_text = p_key and kind <> 'claim'
$$;

-- 1. The copies of one commit, by unit -----------------------------------------------------------------------------------
do $$
declare
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	v_first uuid; v_mine jsonb; v_inside jsonb; r jsonb; v_list jsonb;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'c3c2-seed-01', '[{"op":"mkdir","path":"Plans"}]'), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'c3c2-first-01', jsonb_build_array(jsonb_build_object(
		'op','write','path','Plans/q3.md','file',pg_temp.stage_v2(pg_temp.member(1), array['first'])))), 1, 'saved');
	v_first := pg_temp.version_of('plans/q3.md');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'c3c2-theirs-01', jsonb_build_array(jsonb_build_object(
		'op','write','path','Plans/q3.md','file',pg_temp.stage_v2(pg_temp.member(1), array['theirs']),
		'expectedVersion',v_first))), 1, 'saved');
	-- A stale write and a new folder onto a taken path conflict and keep their files; a third unit saves.
	v_mine := pg_temp.stage_v2(a, array['mine']);
	v_inside := pg_temp.stage_v2(a, array['inside']);
	r := pg_temp.commit(a, 'c3c2-mine-01', jsonb_build_array(
		jsonb_build_object('op','write','path','Plans/q3.md','file',v_mine,'expectedVersion',v_first),
		jsonb_build_object('op','new_folder','path','Plans','contents',jsonb_build_array(
			jsonb_build_object('path','x.md','kind','file','file',v_inside))),
		jsonb_build_object('op','write','path','Plans/q4.md','file',pg_temp.stage_v2(a, array['q4']))));
	perform pg_temp.expect(r, 1, 'conflict', 'version_changed');
	perform pg_temp.expect(r, 2, 'conflict', 'exists');
	perform pg_temp.expect(r, 3, 'saved');
	v_list := pg_temp.copies_of(r);
	if v_list is distinct from jsonb_build_array(
		jsonb_build_object('unit',1,'file',1,'path','Plans/q3.md','manifestSha256',v_mine ->> 'manifestSha256'),
		jsonb_build_object('unit',2,'file',1,'path','Plans/x.md','manifestSha256',v_inside ->> 'manifestSha256')) then
		raise exception 'The commit''s copies, by unit and file: %', v_list; end if;
	-- Another environment, or a commit that kept nothing, lists nothing.
	if pg_temp.copies_of(r, '63400000-0000-4000-8000-000000000099') <> '[]'::jsonb then
		raise exception 'Another environment lists nothing'; end if;
	r := pg_temp.commit(a, 'c3c2-plain-01', jsonb_build_array(jsonb_build_object(
		'op','write','path','Plans/q5.md','file',pg_temp.stage_v2(a, array['q5']))));
	perform pg_temp.expect(r, 1, 'saved');
	if pg_temp.copies_of(r) <> '[]'::jsonb then raise exception 'A commit with no conflict lists nothing: %', pg_temp.copies_of(r); end if;
end $$;

-- 2. A conflict whose bytes would not have passed keeps nothing, and lists nothing --------------------------------------
do $$
declare
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	v_theirs jsonb; r jsonb;
begin
	-- The agent names bytes only the platform staged: it does not hold them, so P17 keeps no copy of its conflict.
	v_theirs := pg_temp.stage_v2('{"kind":"platform"}', array['not the agent''s']);
	r := pg_temp.commit(a, 'c3c2-unproved-01', jsonb_build_array(jsonb_build_object(
		'op','write','path','Plans/q3.md','file',v_theirs,'expectedVersion','63400000-0000-4000-8000-0000000000ff')));
	perform pg_temp.expect(r, 1, 'conflict', 'version_changed');
	if pg_temp.copies_of(r) <> '[]'::jsonb then
		raise exception 'A conflict whose bytes were not kept lists nothing: %', pg_temp.copies_of(r); end if;
end $$;

-- 3. Arguments and grants ----------------------------------------------------------------------------------------------
do $$
begin
	begin
		perform public.qorpera_folder_conflict_copies_of(null, gen_random_uuid());
		raise exception 'A missing environment is refused';
	exception when sqlstate '22023' then null;
	end;
	if has_function_privilege('authenticated', 'public.qorpera_folder_conflict_copies_of(uuid,uuid)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_folder_conflict_copies_of(uuid,uuid)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_folder_conflict_copies_of(uuid,uuid)', 'execute') then
		raise exception 'Only the service role reads a commit''s copies'; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
do $$
begin
	begin
		perform public.qorpera_folder_conflict_copies_of('63400000-0000-4000-8000-000000000020', gen_random_uuid());
		raise exception 'A member may not read a commit''s copies';
	exception when insufficient_privilege then null;
	end;
end $$;
