-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Production DB slowness, item I (20260930486000): qorpera_execution_runtime_manifest reads the bundle's manifest out
-- of TOAST once a call, not once per check, and its implementation check is the same test without the bounded regex.
-- The old body is rebuilt here from the patched definition (both replacements reversed), so the old and the new body
-- run side by side in one transaction, on test 924's run of the active bundle and on a large bundle made here: one
-- TOAST read a call where the old body made one a check, the same manifest (as text, as jsonb, and its sha256 is the
-- run's bundle hash), the same answer of the old and the new implementation predicate on every value, and the same
-- refusals. Describe, the native launch and the context fence each make one manifest call and read the manifest out
-- of TOAST once. The bodies are timed (printed, not checked).
reset role;

-- A run of a bundle, as the manifest reads it (the bundle's id and sha256); no run is inserted, so no trigger runs.
create function pg_temp.h_run(p_id uuid, p_sha256 text) returns public.qorpera_execution_runs language sql as $$
	select * from jsonb_populate_record(null::public.qorpera_execution_runs,
		jsonb_build_object('runtime_bundle_id', p_id, 'runtime_bundle_sha256', p_sha256))
$$;
create function pg_temp.h_bundle(p_key text, p_manifest jsonb) returns public.qorpera_execution_runs language plpgsql as $$
declare v_sha256 text := encode(extensions.digest(convert_to(p_manifest::text, 'utf8'), 'sha256'), 'hex'); v_id uuid;
begin
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	values ('test-671-' || p_key, 1, p_manifest, v_sha256) returning id into v_id;
	return pg_temp.h_run(v_id, v_sha256);
end $$;
-- Test 924's run of Alice's, and the large bundle below.
create function pg_temp.h_active() returns public.qorpera_execution_runs language sql as $$
	select * from public.qorpera_execution_runs where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
$$;
create function pg_temp.h_large() returns public.qorpera_execution_runs language sql as $$
	select pg_temp.h_run(id, sha256) from public.qorpera_runtime_bundles where bundle_key = 'test-671-large'
$$;

-- The large bundle: the active manifest with its implementation replaced by 1,500 sha256 entries (about the size of
-- the generated bundle's), so it is stored out of line whatever the active bundle is.
select pg_temp.h_bundle('large', manifest || jsonb_build_object('implementation', (select jsonb_object_agg(
	format('test-671/%s.sql', lpad(i::text, 4, '0')), md5(i::text) || md5((i + 1)::text)) from generate_series(1, 1500) i)))
from public.qorpera_runtime_bundles where id = (pg_temp.h_active()).runtime_bundle_id
\g /dev/null

-- 3. The same manifest: as text, as jsonb, the stored value, and its sha256 is the run's bundle hash. On the active
--    bundle, the large one, a valid bundle with overrides 'none' and no allowed list (the `?` check's path), and one
--    with a JSON null implementation value (NULL stays NULL: neither implementation check refuses it).
create function pg_temp.h_same(p_run public.qorpera_execution_runs, p_case text) returns void language plpgsql as $$
declare v_after jsonb := public.qorpera_execution_runtime_manifest(p_run); v_stored jsonb;
begin
	select manifest into strict v_stored from public.qorpera_runtime_bundles where id = p_run.runtime_bundle_id;
	perform pg_temp.base_assert(v_after is not null and v_after = v_stored
		and encode(extensions.digest(convert_to(v_after::text, 'utf8'), 'sha256'), 'hex')
			= p_run.runtime_bundle_sha256, 'the ' || p_case || ' bundle''s manifest is the same');
end $$;
select pg_temp.h_same(pg_temp.h_active(), 'active');
select pg_temp.h_same(pg_temp.h_large(), 'large');
select pg_temp.h_same(pg_temp.h_bundle('none', jsonb_set(manifest, '{modelPolicy,overrides}', '"none"') #- '{modelPolicy,allowed}'),
	'none')
from public.qorpera_runtime_bundles where id = (pg_temp.h_active()).runtime_bundle_id;
select pg_temp.h_same(pg_temp.h_bundle('null-entry', jsonb_set(manifest, '{implementation,test-671/null.sql}', 'null')),
	'null-entry')
from public.qorpera_runtime_bundles where id = (pg_temp.h_active()).runtime_bundle_id;

-- 5. The same refusals: each bad bundle is refused by both bodies with SQLSTATE 42501 and the same message. The
--    implementation-* cases add one bad value to the active bundle's implementation map.
do $$
declare v_active jsonb := (select manifest from public.qorpera_runtime_bundles where id = (pg_temp.h_active()).runtime_bundle_id);
	v_large jsonb := (select manifest from public.qorpera_runtime_bundles where bundle_key = 'test-671-large');
	c_bundle constant text := 'Run requires an executable runtime bundle';
	c_components constant text := 'Run runtime components are unavailable';
	c_bad constant text[] := '{implementation,test-671/bad.sql}';
	v_case record; v_run public.qorpera_execution_runs; v_cases integer := 0;
begin
	for v_case in select * from (values
		('unknown', null::jsonb, c_bundle),
		('schema', v_active || '{"schema":"qorpera.runtime-bundle/v1"}', c_bundle),
		('policy-key', jsonb_set(v_active, '{modelPolicy,extra}', 'true'), c_bundle),
		('fast-mode', jsonb_set(v_active, '{modelPolicy,fastMode}', '"x"'), c_bundle),
		('effort', jsonb_set(v_active, '{modelPolicy,effort}', '"max"'), c_bundle),
		('overrides', jsonb_set(v_active, '{modelPolicy,overrides}', '"thread"'), c_bundle),
		('allowed-type', jsonb_set(jsonb_set(v_active, '{modelPolicy,overrides}', '"routine"'), '{modelPolicy,allowed}', '"high"'),
			c_bundle),
		('allowed-value', jsonb_set(jsonb_set(v_active, '{modelPolicy,overrides}', '"routine"'), '{modelPolicy,allowed}', '["max"]'),
			c_bundle),
		('none-allowed', jsonb_set(jsonb_set(v_active, '{modelPolicy,overrides}', '"none"'), '{modelPolicy,allowed}', '["high"]'),
			c_bundle),
		('binary', v_active || jsonb_build_object('nativeBinarySha256', repeat('A', 64)), c_bundle),
		('implementation-type', v_active || '{"implementation":[]}', c_bundle),
		('implementation-empty', v_active || '{"implementation":{}}', c_bundle),
		('components-type', v_active || '{"components":[]}', c_bundle),
		('component-missing', v_active #- '{components,kernel}', c_components),
		('component-value', jsonb_set(v_active, '{components,kernel}', '"not-hex"'), c_components),
		('implementation-last', jsonb_set(v_large, '{implementation,test-671/1500.sql}', '"not-hex"'), c_components),
		('implementation-63', jsonb_set(v_active, c_bad, to_jsonb(repeat('a', 63))), c_components),
		('implementation-65', jsonb_set(v_active, c_bad, to_jsonb(repeat('a', 65))), c_components),
		('implementation-upper', jsonb_set(v_active, c_bad, to_jsonb('ABCDEF' || repeat('0', 58))), c_components),
		('implementation-g', jsonb_set(v_active, c_bad, to_jsonb(repeat('a', 63) || 'g')), c_components),
		('implementation-newline', jsonb_set(v_active, c_bad, to_jsonb(E'\n' || repeat('a', 63))), c_components)
	) as c(name, manifest, message) loop
		v_run := case when v_case.manifest is null then pg_temp.h_run(extensions.gen_random_uuid(), repeat('0', 64))
			else pg_temp.h_bundle(v_case.name, v_case.manifest) end;
		perform pg_temp.base_error(format('select public.qorpera_execution_runtime_manifest(pg_temp.h_run(%L, %L))',
			v_run.runtime_bundle_id, v_run.runtime_bundle_sha256), '42501', v_case.message);
		v_cases := v_cases + 1;
	end loop;
	perform pg_temp.base_assert(v_cases = 21, 'every refusal case ran');
	perform pg_temp.base_assert((select max(key) from jsonb_each(v_large -> 'implementation')) = 'test-671/1500.sql'
		and (select key from jsonb_each(v_large -> 'implementation') with ordinality as e(key, value, n) order by n desc limit 1)
			= 'test-671/1500.sql', 'the bad implementation entry is the last one the check reads');
end $$;

-- 6. The function's shape: STABLE, SECURITY DEFINER, search_path '', the two markers, the empty-path read once, the
--    implementation check without its bounded regex (the components and binary checks keep theirs), and still no
--    EXECUTE for public, anon, authenticated or service_role.
do $$
declare v_proc pg_proc;
begin
	select * into strict v_proc from pg_proc
	where oid = 'public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)'::regprocedure;
	perform pg_temp.base_assert(v_proc.provolatile = 's' and v_proc.prosecdef and v_proc.proconfig = array['search_path=""']
		and v_proc.prorettype = 'jsonb'::regtype, 'the manifest keeps its settings: ' || coalesce(v_proc.proconfig::text, 'none'));
	perform pg_temp.base_assert(not exists (select 1 from unnest(array['public', 'anon', 'authenticated', 'service_role']) as r(name)
		where has_function_privilege(r.name, v_proc.oid, 'execute')), 'the manifest keeps its grants');
end $$;

rollback;
