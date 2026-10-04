-- @fixture 634_folder_core_authority.test.sql until "-- Mutators: owners and admins"
-- Company folder core, P24c (migration 20260930039500): an upload's presence check reads only what it must. The set-based
-- qorpera_folder_object_readable answers what the per-path one answered, for every object and both agents; under a plan
-- that scans the company's catalog first, open_upload checks readability on the upload's own objects only (the per-path
-- filter in one statement with the catalog checked every object the company stores); and an object 3,000 paths the agent
-- cannot read name is decided at once. 634's fixture, rolled back.

-- The company's files, written by the platform: wide/ holds 3,000 files of one text in an area only agent B may read;
-- docs/ holds 100 files of their own texts, which both agents read; docs/old.md was overwritten, so only its path version
-- still names its first text.
do $$
declare
	c_owner constant jsonb := pg_temp.member(1); c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	v_wide jsonb := pg_temp.stage(E'Wide file.\n'); v_root uuid;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p24c-dirs', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'wide'), jsonb_build_object('op', 'mkdir', 'path', 'docs'))), 1, 'saved');
	for w in 1 .. 3 loop
		perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p24c-wide-' || w, jsonb_build_array(jsonb_build_object('op', 'new_folder',
			'path', 'wide/w' || w, 'contents', (select jsonb_agg(jsonb_build_object('path', 'f' || f || '.md', 'kind', 'file', 'file', v_wide))
				from generate_series(1, 1000) f)))), 1, 'saved');
	end loop;
	for d in 1 .. 4 loop
		perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p24c-docs-' || d, jsonb_build_array(jsonb_build_object('op', 'new_folder',
			'path', 'docs/d' || d, 'contents', (select jsonb_agg(jsonb_build_object('path', 'f' || f || '.md', 'kind', 'file',
				'file', pg_temp.stage('Doc ' || d || '/' || f || E'.\n'))) from generate_series(1, 25) f)))), 1, 'saved');
	end loop;
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p24c-old-1', jsonb_build_array(jsonb_build_object('op', 'write',
		'path', 'docs/old.md', 'file', pg_temp.stage(E'First text.\n')))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p24c-old-2', jsonb_build_array(jsonb_build_object('op', 'write',
		'path', 'docs/old.md', 'file', pg_temp.stage(E'Second text.\n'),
		'expectedVersion', (pg_temp.read('docs/old.md') -> 'entry' ->> 'version')))), 1, 'saved');
	-- Both agents read the root; only agent B reads wide/.
	select id into v_root from public.qorpera_company_path_resources where environment_id = c_env and path = '';
	perform public.qorpera_folder_grant(c_env, c_owner, v_root, 'staff_agent', staff, array['read'])
	from unnest(array['63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-0000000000a2']::uuid[]) staff;
	perform public.qorpera_folder_set_resource(c_env, c_owner, 'wide', 'subtree', 'company_shared', 'normal');
	perform public.qorpera_folder_grant(c_env, c_owner,
		(select id from public.qorpera_company_path_resources where environment_id = c_env and path = 'wide'),
		'staff_agent', '63400000-0000-4000-8000-0000000000a2', array['read']);
end $$;
select set_config('qorpera_test.run_a', pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human',
	'63400000-0000-4000-8000-000000000002')::text, true) \g /dev/null
select set_config('qorpera_test.run_b', pg_temp.run('63400000-0000-4000-8000-0000000000a2', 'human',
	'63400000-0000-4000-8000-000000000002')::text, true) \g /dev/null

-- The per-path definition the set-based one replaced (20260928279520), for comparison.
create function pg_temp.readable_before(p_auth jsonb, p_sha256 text) returns boolean language sql stable as $$
	select exists (select 1 from (select p_sha256 as manifest
			union all
			select c.manifest_sha256 from public.qorpera_folder_file_chunks c
			where c.profile_id = '63400000-0000-4000-8000-000000000010' and c.chunk_sha256 = p_sha256) m
		cross join lateral (
			select e.path from public.qorpera_folder_entries e
			where e.environment_id = '63400000-0000-4000-8000-000000000020' and e.kind = 'file' and e.manifest_sha256 = m.manifest
			union all
			select v.path from public.qorpera_folder_path_versions v
			where v.environment_id = '63400000-0000-4000-8000-000000000020' and v.manifest_sha256 = m.manifest) p
		where public.qorpera_folder_actor_allowed('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010',
			p_auth, p.path, 'read'))
$$;
create function pg_temp.readable_calls() returns bigint language sql as $$
	select coalesce((select calls from pg_stat_xact_user_functions where schemaname = 'public'
		and funcname = 'qorpera_folder_object_readable'), 0)
$$;
create function pg_temp.sha(p_text text) returns text language sql immutable as $$
	select encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex')
$$;

-- A. The set-based check answers what the per-path one did, for every object of the company (manifests and chunks, live
-- or only in a path version, read through a grant or not) and both agents.
do $$
declare v_auth jsonb; v_bad text[]; v_agent text;
begin
	foreach v_agent in array array['run_a', 'run_b'] loop
		v_auth := pg_temp.resolved(current_setting('qorpera_test.' || v_agent)::jsonb);
		select array_agg(o.sha256) into v_bad from public.qorpera_profile_objects o
		where o.profile_id = '63400000-0000-4000-8000-000000000010'
			and public.qorpera_folder_object_readable('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010',
				v_auth, o.sha256) is distinct from pg_temp.readable_before(v_auth, o.sha256);
		if v_bad is not null then raise exception 'A: % differs on %', v_agent, v_bad; end if;
	end loop;
	-- The cases are there: agent A reads a doc, not the wide file; agent B reads both; an old version's text is read.
	v_auth := pg_temp.resolved(current_setting('qorpera_test.run_a')::jsonb);
	if public.qorpera_folder_object_readable('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010', v_auth,
			pg_temp.sha(E'Wide file.\n'))
		or not public.qorpera_folder_object_readable('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010',
			v_auth, pg_temp.sha(E'Doc 1/1.\n'))
		or not public.qorpera_folder_object_readable('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010',
			v_auth, pg_temp.sha(E'First text.\n'))
		or not public.qorpera_folder_object_readable('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010',
			pg_temp.resolved(current_setting('qorpera_test.run_b')::jsonb), pg_temp.sha(E'Wide file.\n')) then
		raise exception 'A: the cases are not exercised'; end if;
end $$;

-- B. Under a plan that scans the company's catalog first (no index scans), the per-path filter in one statement with the
-- catalog checked every object the company stores; open_upload checks the upload's own objects only, and an upload of
-- the wide file's bytes by agent A, who cannot read them, is decided at once.
set track_functions = 'all';
set enable_indexscan = off;
set enable_bitmapscan = off;
set enable_indexonlyscan = off;
do $$
declare
	v_run jsonb := current_setting('qorpera_test.run_a')::jsonb; v_auth jsonb := pg_temp.resolved(v_run); v_open jsonb;
	v_before bigint; v_objects bigint; v_started timestamptz; v_ms numeric;
begin
	select count(*) into v_objects from public.qorpera_profile_objects where profile_id = '63400000-0000-4000-8000-000000000010';
	-- The statement as it was: the filter runs on the catalog rows before the join narrows them.
	v_open := public.qorpera_folder_open_upload('63400000-0000-4000-8000-000000000020', v_run, pg_temp.manifest_v2(E'Doc 1/1.\n'));
	v_before := pg_temp.readable_calls();
	perform count(*) from public.qorpera_profile_objects o
	join public.qorpera_folder_upload_intent_objects i on i.intent_id = (v_open ->> 'intentId')::uuid and i.sha256 = o.sha256
		and i.bytes = o.bytes
	where o.profile_id = '63400000-0000-4000-8000-000000000010'
		and public.qorpera_folder_object_readable('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010', v_auth,
			o.sha256);
	if pg_temp.readable_calls() - v_before < v_objects then
		raise exception 'B: the old statement must check every object under this plan (% of %)',
			pg_temp.readable_calls() - v_before, v_objects; end if;
	-- A text the company has and agent A reads: both of its objects are present, two checks.
	v_before := pg_temp.readable_calls();
	v_open := public.qorpera_folder_open_upload('63400000-0000-4000-8000-000000000020', v_run, pg_temp.manifest_v2(E'Doc 2/2.\n'));
	if pg_temp.readable_calls() - v_before <> 2 or jsonb_array_length(v_open -> 'present') <> 2 then
		raise exception 'B: a read text is present, after two checks (% checks, %)', pg_temp.readable_calls() - v_before, v_open; end if;
	-- New bytes: nothing is present, nothing is checked.
	v_before := pg_temp.readable_calls();
	v_open := public.qorpera_folder_open_upload('63400000-0000-4000-8000-000000000020', v_run, pg_temp.manifest_v2(E'New text.\n'));
	if pg_temp.readable_calls() - v_before <> 0 or jsonb_array_length(v_open -> 'present') <> 0 then
		raise exception 'B: new bytes are not present and need no check (% checks, %)', pg_temp.readable_calls() - v_before, v_open; end if;
	-- The wide file's bytes, which agent A cannot read: not present (A must put them), decided at once.
	v_before := pg_temp.readable_calls();
	v_started := clock_timestamp();
	v_open := public.qorpera_folder_open_upload('63400000-0000-4000-8000-000000000020', v_run, pg_temp.manifest_v2(E'Wide file.\n'));
	v_ms := extract(epoch from clock_timestamp() - v_started) * 1000;
	if pg_temp.readable_calls() - v_before <> 2 or jsonb_array_length(v_open -> 'present') <> 0 then
		raise exception 'B: the wide file is checked twice and not present to agent A (% checks, %)',
			pg_temp.readable_calls() - v_before, v_open; end if;
	if v_ms > 1000 then raise exception 'B: deciding an object 3,000 unreadable paths name took % ms', round(v_ms); end if;
	-- Agent B reads it: present.
	v_open := public.qorpera_folder_open_upload('63400000-0000-4000-8000-000000000020', current_setting('qorpera_test.run_b')::jsonb,
		pg_temp.manifest_v2(E'Wide file.\n'));
	if jsonb_array_length(v_open -> 'present') <> 2 then raise exception 'B: agent B reads the wide file, got %', v_open; end if;
end $$;
reset enable_indexscan;
reset enable_bitmapscan;
reset enable_indexonlyscan;
reset track_functions;

-- C. Every patched body carries the marker.
do $$
begin
	if exists (select 1 from unnest(array['public.qorpera_folder_object_readable(uuid,uuid,jsonb,text)',
			'public.qorpera_folder_open_upload(uuid,jsonb,text)']) f
		where position('20260930039500' in pg_get_functiondef(f::regprocedure)) = 0) then
		raise exception 'C: a patched body lacks its marker'; end if;
end $$;

rollback;
