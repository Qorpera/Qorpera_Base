-- @fixture 761_folder_core_bytes.test.sql until "-- 1. The version-2 manifest"
-- Company folder core, SECURITY (migration 20260930062000): near the company's storage limit, an upload's authorization
-- answers an actor the same for a hash the company stores and one it does not, unless the actor holds or put the
-- object already under its intent (C1D §3). Before, a stored hash was let through and any other refused, which told the hash's existence.

do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	b jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a2', 'human', '63400000-0000-4000-8000-000000000001');
	v_secret jsonb; v_res uuid; v_open jsonb; v_mine jsonb; v_new jsonb;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'quota-seed-01', '[{"op":"mkdir","path":"vault"}]'), 1, 'saved');
	-- Agent A keeps a file in a folder only it may read.
	v_secret := pg_temp.stage_v2(a, array['the secret ', 'plan']);
	perform pg_temp.expect(pg_temp.commit(a, 'quota-secret-01', jsonb_build_array(
		jsonb_build_object('op','write','path','vault/plan.md','file',v_secret))), 1, 'saved');
	v_res := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'vault', 'subtree', 'company_shared', 'normal') ->> 'resourceId';
	perform public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', '63400000-0000-4000-8000-0000000000a1',
		array['read','write']);
	-- The company is at its limit.
	update public.qorpera_company_files set storage_limit_bytes = (pg_temp.usage()).bytes where profile_id = c_profile;

	-- Agent B, who may not read A's file, asks to put its stored chunk, and a chunk nobody stored, of the same size: the
	-- same answer for both (the limit), so the answer tells nothing about what the company stores.
	v_mine := pg_temp.open(b, pg_temp.manifest(array['the secret ', 'plan']));
	if v_mine -> 'present' <> '[]'::jsonb then raise exception 'B holds nothing of A''s: %', v_mine; end if;
	v_new := pg_temp.open(b, pg_temp.manifest(array['the secret ', 'pfan']));
	perform pg_temp.raises(format('select public.qorpera_folder_authorize_object_upload(%L, %L, %L, %L, 4)', c_env, b,
		v_mine ->> 'intentId', pg_temp.hash('plan')), '23514');
	perform pg_temp.raises(format('select public.qorpera_folder_authorize_object_upload(%L, %L, %L, %L, 4)', c_env, b,
		v_new ->> 'intentId', pg_temp.hash('pfan')), '23514');

	-- Agent A holds its own chunk (open reported it present): putting it again costs nothing, even at the limit.
	v_open := pg_temp.open(a, pg_temp.manifest(array['the secret ', 'plan', 'more']));
	if not (v_open -> 'present') ? pg_temp.hash('plan') then raise exception 'A holds its own chunk: %', v_open; end if;
	if public.qorpera_folder_authorize_object_upload(c_env, a, (v_open ->> 'intentId')::uuid, pg_temp.hash('plan'), 4)
		->> 'profileId' <> c_profile::text then
		raise exception 'A held object is let through at the limit'; end if;
	-- A new chunk of A's own is checked as new.
	perform pg_temp.raises(format('select public.qorpera_folder_authorize_object_upload(%L, %L, %L, %L, 4)', c_env, a,
		v_open ->> 'intentId', pg_temp.hash('more')), '23514');

	-- A chunk an actor put under its own intent is its own too: a retried put passes at the limit.
	perform pg_temp.confirm(b, (v_new ->> 'intentId')::uuid, 'pfan');
	update public.qorpera_company_files set storage_limit_bytes = (pg_temp.usage()).bytes where profile_id = c_profile;
	if public.qorpera_folder_authorize_object_upload(c_env, b, (v_new ->> 'intentId')::uuid, pg_temp.hash('pfan'), 4)
		->> 'profileId' <> c_profile::text then
		raise exception 'A put object is let through at the limit'; end if;
end $$;

-- The patched body carries the marker and no longer asks the catalog.
do $$
declare v_body text := (select prosrc from pg_proc
	where oid = 'public.qorpera_folder_authorize_object_upload(uuid,jsonb,uuid,text,bigint)'::regprocedure);
begin
	if strpos(v_body, '20260930062000') = 0 or strpos(v_body, 'qorpera_profile_objects') > 0 then
		raise exception 'The upload quota depends on the catalog'; end if;
end $$;

rollback;
