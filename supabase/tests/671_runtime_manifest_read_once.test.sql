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
set local track_functions = 'all';

create function pg_temp.h_calls(p_name text) returns bigint language sql as $$
	select coalesce((select sum(f.calls) from pg_stat_xact_user_functions f
		where f.schemaname = 'public' and f.funcname = p_name), 0)::bigint
$$;
create function pg_temp.h_count(p_text text, p_part text) returns integer language sql as $$
	select (length(p_text) - length(replace(p_text, p_part, ''))) / length(p_part)
$$;
-- This transaction's scans of the bundles' TOAST index. Reading a value out of TOAST (heap_fetch_toast_slice) is one
-- ordered scan of that index, whatever its number of chunks, so the count is the number of times a manifest was read.
select set_config('qorpera_test.h_toast_index', (select string_agg(i.indexrelid::text, ',') from pg_class c
	join pg_index i on i.indrelid = c.reltoastrelid where c.oid = 'public.qorpera_runtime_bundles'::regclass), true)
\g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.h_toast_index') ~ '^[0-9]+$', 'the bundles have one TOAST index');
create function pg_temp.h_toast() returns bigint language sql as $$
	select pg_stat_get_xact_numscans(current_setting('qorpera_test.h_toast_index')::oid)
$$;
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

-- The old body: the patched definition with the migration's two replacements reversed (their comment lines dropped,
-- the select back to `select manifest into v_manifest`, the implementation check back to its regex), as
-- pg_temp.h_manifest_before. Each part matches exactly once. For the timing only, pg_temp.h_manifest_read_once has the
-- single read but the old implementation check.
do $$
declare v_text text := pg_get_functiondef('public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)'::regprocedure);
	c_comment constant text := E'\t*-- 20260930486000:[^\n]*\n';
	c_new constant text := 'select manifest #> ''{}''::text[] into v_manifest from public.qorpera_runtime_bundles';
	c_old constant text := 'select manifest into v_manifest from public.qorpera_runtime_bundles';
	c_new_check constant text := 'where length(source.value) <> 64 or source.value ~ ''[^0-9a-f]'') then';
	c_old_check constant text := 'where source.value !~ ''^[0-9a-f]{64}$'') then';
	c_name constant text := 'public.qorpera_execution_runtime_manifest(';
begin
	perform pg_temp.base_assert(regexp_count(v_text, c_comment) = 2 and pg_temp.h_count(v_text, '20260930486000') = 2
		and pg_temp.h_count(v_text, c_new) = 1 and pg_temp.h_count(v_text, c_old) = 0
		and pg_temp.h_count(v_text, c_new_check) = 1 and pg_temp.h_count(v_text, c_old_check) = 0
		and pg_temp.h_count(v_text, c_name) = 1, 'the patched manifest has the migration''s replacements once: ' || v_text);
	v_text := replace(regexp_replace(v_text, c_comment, '', 'g'), c_new_check, c_old_check);
	execute replace(v_text, c_name, 'pg_temp.h_manifest_read_once(');
	v_text := replace(replace(v_text, c_new, c_old), c_name, 'pg_temp.h_manifest_before(');
	perform pg_temp.base_assert(pg_temp.h_count(v_text, c_old) = 1 and pg_temp.h_count(v_text, c_old_check) = 1
		and position('#>' || ' ''{}''' in v_text) = 0 and position('length(source.value)' in v_text) = 0
		and position('20260930486000' in v_text) = 0, 'the old body is rebuilt: ' || v_text);
	execute v_text;
end $$;

-- The large bundle: the active manifest with its implementation replaced by 1,500 sha256 entries (about the size of
-- the generated bundle's), so it is stored out of line whatever the active bundle is.
select pg_temp.h_bundle('large', manifest || jsonb_build_object('implementation', (select jsonb_object_agg(
	format('test-671/%s.sql', lpad(i::text, 4, '0')), md5(i::text) || md5((i + 1)::text)) from generate_series(1, 1500) i)))
from public.qorpera_runtime_bundles where id = (pg_temp.h_active()).runtime_bundle_id
\g /dev/null

-- 1. The cost. Calibration first: one read of the manifest's value is one TOAST index scan, so the counter counts and
--    both manifests are stored out of line. Then each body's first eight calls (custom plans, then the plan cache's
--    choice) on both bundles: the new body reads the manifest out of TOAST exactly once a call (its select); the old
--    body read it once per check, 18 on the valid path (printed; checked as at least 10).
do $$
declare v_run public.qorpera_execution_runs; v_at bigint; v_calibration bigint[] := '{}'; v_before bigint[];
	v_after bigint[]; v_after_once boolean := true; v_before_each boolean := true; v_report text := '';
begin
	for r in 1 .. 2 loop
		v_run := case r when 1 then pg_temp.h_active() else pg_temp.h_large() end;
		v_at := pg_temp.h_toast();
		perform manifest -> 'schema' from public.qorpera_runtime_bundles where id = v_run.runtime_bundle_id;
		v_calibration := v_calibration || (pg_temp.h_toast() - v_at);
		v_before := '{}'; v_after := '{}';
		for i in 1 .. 8 loop
			v_at := pg_temp.h_toast();
			perform pg_temp.h_manifest_before(v_run);
			v_before := v_before || (pg_temp.h_toast() - v_at);
			v_at := pg_temp.h_toast();
			perform public.qorpera_execution_runtime_manifest(v_run);
			v_after := v_after || (pg_temp.h_toast() - v_at);
		end loop;
		v_after_once := v_after_once and v_after = array_fill(1::bigint, array[8]);
		v_before_each := v_before_each and 10 <= all(v_before);
		v_report := v_report || format('%s bundle: before %s, after %s; ', case r when 1 then 'active' else 'large' end,
			v_before, v_after);
	end loop;
	v_report := format('calibration %s; %s', v_calibration, v_report);
	raise notice '671 toast reads per call: %', v_report;
	perform set_config('qorpera_test.h_reads', v_report, true);
	perform pg_temp.base_assert(v_calibration = array[1, 1]::bigint[], 'one read of a manifest is one TOAST index scan: '
		|| v_report);
	perform pg_temp.base_assert(v_after_once, 'the new body reads the manifest once a call: ' || v_report);
	perform pg_temp.base_assert(v_before_each, 'the old body read the manifest once per check: ' || v_report);
end $$;
select current_setting('qorpera_test.h_reads') as h_reads \gset
\echo 671 toast reads per call: :h_reads

-- 2. The timing on both bundles, 50 calls of each body (printed, not checked; the test machines are shared): the old
--    body, the single read with the old implementation check, and the new body. Callers of the old body then read its
--    returned pointer out of TOAST again for their own checks; that is not in here.
do $$
declare v_run public.qorpera_execution_runs; v_at bigint; v_start timestamptz; v_before numeric; v_read_once numeric;
	v_after numeric; v_reads_before bigint; v_reads_after bigint; v_report text := '';
begin
	for r in 1 .. 2 loop
		v_run := case r when 1 then pg_temp.h_active() else pg_temp.h_large() end;
		v_at := pg_temp.h_toast(); v_start := clock_timestamp();
		for i in 1 .. 50 loop perform pg_temp.h_manifest_before(v_run); end loop;
		v_before := extract(epoch from clock_timestamp() - v_start) * 1000 / 50; v_reads_before := pg_temp.h_toast() - v_at;
		v_start := clock_timestamp();
		for i in 1 .. 50 loop perform pg_temp.h_manifest_read_once(v_run); end loop;
		v_read_once := extract(epoch from clock_timestamp() - v_start) * 1000 / 50;
		v_at := pg_temp.h_toast(); v_start := clock_timestamp();
		for i in 1 .. 50 loop perform public.qorpera_execution_runtime_manifest(v_run); end loop;
		v_after := extract(epoch from clock_timestamp() - v_start) * 1000 / 50; v_reads_after := pg_temp.h_toast() - v_at;
		v_report := v_report || format('%s bundle (%s implementation entries, %s bytes stored, %s as text): before %s ms, '
			|| 'read once with the old implementation check %s ms, after %s ms, toast reads before %s, after %s; ',
			case r when 1 then 'active' else 'large' end,
			(select count(*) from public.qorpera_runtime_bundles, jsonb_object_keys(manifest -> 'implementation')
				where id = v_run.runtime_bundle_id),
			(select pg_column_size(manifest) from public.qorpera_runtime_bundles where id = v_run.runtime_bundle_id),
			(select octet_length(manifest::text) from public.qorpera_runtime_bundles where id = v_run.runtime_bundle_id),
			round(v_before, 3), round(v_read_once, 3), round(v_after, 3), v_reads_before, v_reads_after);
	end loop;
	perform set_config('qorpera_test.h_timing', v_report, true);
end $$;
select current_setting('qorpera_test.h_timing') as h_timing \gset
\echo 671 timing (50 calls each): :h_timing

-- 3. The same manifest: as text, as jsonb, the stored value, and its sha256 is the run's bundle hash. On the active
--    bundle, the large one, a valid bundle with overrides 'none' and no allowed list (the `?` check's path), and one
--    with a JSON null implementation value (NULL stays NULL: neither implementation check refuses it).
create function pg_temp.h_same(p_run public.qorpera_execution_runs, p_case text) returns void language plpgsql as $$
declare v_before jsonb := pg_temp.h_manifest_before(p_run); v_after jsonb := public.qorpera_execution_runtime_manifest(p_run);
	v_stored jsonb;
begin
	select manifest into strict v_stored from public.qorpera_runtime_bundles where id = p_run.runtime_bundle_id;
	perform pg_temp.base_assert(v_after is not null and v_after::text = v_before::text and v_after = v_before
		and v_after = v_stored and encode(extensions.digest(convert_to(v_after::text, 'utf8'), 'sha256'), 'hex')
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

-- 4. The implementation check is the same test: on each edge value, and on every implementation and components value
--    of both bundles, `length(v) <> 64 or v ~ '[^0-9a-f]'` gives what `v !~ '^[0-9a-f]{64}$'` gave, NULL included;
--    and the edge values get the answers expected of them (only 64 lowercase hex characters pass).
do $$
declare v_edges integer; v_values integer; v_wrong text;
begin
	select count(*), string_agg(format('%L: old %s, new %s, expected %s', e.v, e.v !~ '^[0-9a-f]{64}$',
			length(e.v) <> 64 or e.v ~ '[^0-9a-f]', e.refused), '; ') filter (where
			(e.v !~ '^[0-9a-f]{64}$') is distinct from (length(e.v) <> 64 or e.v ~ '[^0-9a-f]')
			or (e.v !~ '^[0-9a-f]{64}$') is distinct from e.refused)
		into v_edges, v_wrong
	from (values
		(md5('671') || md5('672'), false),
		(repeat('a', 63), true),
		(repeat('a', 65), true),
		('ABCDEF' || repeat('0', 58), true),
		(repeat('a', 63) || 'g', true),
		(md5('671') || md5('672') || E'\n', true),
		(E'\n' || repeat('a', 63), true),
		(repeat('a', 63) || E'\n', true),
		('', true),
		(null, null),
		(chr(233) || repeat('a', 63), true),
		(repeat('a', 32) || ' ' || repeat('a', 31), true)
	) as e(v, refused);
	perform pg_temp.base_assert(v_edges = 12 and v_wrong is null, 'the implementation predicates differ: ' || coalesce(v_wrong, v_edges::text));
	select count(*), string_agg(format('%L', m.value), ', ') filter (where
			(m.value !~ '^[0-9a-f]{64}$') is distinct from (length(m.value) <> 64 or m.value ~ '[^0-9a-f]')
			or m.value !~ '^[0-9a-f]{64}$')
		into v_values, v_wrong
	from public.qorpera_runtime_bundles b
	cross join lateral (select value from jsonb_each_text(b.manifest -> 'implementation')
		union all select value from jsonb_each_text(b.manifest -> 'components')) as m
	where b.id in ((pg_temp.h_active()).runtime_bundle_id, (pg_temp.h_large()).runtime_bundle_id);
	perform pg_temp.base_assert(v_values > 1500 and v_wrong is null, 'the bundles'' values: ' || coalesce(v_wrong, v_values::text));
end $$;

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
		perform pg_temp.base_error(format('select pg_temp.h_manifest_before(pg_temp.h_run(%L, %L))', v_run.runtime_bundle_id,
			v_run.runtime_bundle_sha256), '42501', v_case.message);
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
	perform pg_temp.base_assert(pg_temp.h_count(v_proc.prosrc, '20260930486000') = 2
		and pg_temp.h_count(v_proc.prosrc, 'manifest #> ''{}''::text[] into v_manifest') = 1
		and pg_temp.h_count(v_proc.prosrc, '#>') = 1 + pg_temp.h_count((select before.prosrc from pg_proc as before
			where before.oid = 'pg_temp.h_manifest_before(public.qorpera_execution_runs)'::regprocedure), '#>'),
		'the manifest is read once with the empty path');
	perform pg_temp.base_assert(
		pg_temp.h_count(v_proc.prosrc, 'where length(source.value) <> 64 or source.value ~ ''[^0-9a-f]'') then') = 1
		and pg_temp.h_count(v_proc.prosrc, 'source.value !~') = 0
		and pg_temp.h_count(v_proc.prosrc, 'component.value !~ ''^[0-9a-f]{64}$''') = 1
		and pg_temp.h_count(v_proc.prosrc, '''nativeBinarySha256'','''') !~ ''^[0-9a-f]{64}$''') = 1,
		'the implementation check has no bounded regex; the components and binary checks keep theirs');
	perform pg_temp.base_assert(not exists (select 1 from unnest(array['public', 'anon', 'authenticated', 'service_role']) as r(name)
		where has_function_privilege(r.name, v_proc.oid, 'execute')), 'the manifest keeps its grants');
end $$;

-- 7. The callers on test 924's run: describe makes one manifest call and reads the manifest out of TOAST once (the run
--    check alone reads it none); the native launch the same; the context fence after it (as test 666 sets it up)
--    makes one describe, one manifest call and one read.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_run public.qorpera_execution_runs := pg_temp.h_active();
	v_binary text; v_identity jsonb; v_at bigint; v_describes bigint; v_manifests bigint;
	v_lock bigint; v_describe bigint[]; v_launch bigint[]; v_fence bigint[]; v_answer jsonb;
begin
	select manifest ->> 'nativeBinarySha256' into strict v_binary from public.qorpera_runtime_bundles where id = v_run.runtime_bundle_id;
	v_at := pg_temp.h_toast();
	perform public.qorpera_native_tool_locked_run(v_binding);
	v_lock := pg_temp.h_toast() - v_at;

	v_describes := pg_temp.h_calls('qorpera_describe_native_tool_authority');
	v_manifests := pg_temp.h_calls('qorpera_execution_runtime_manifest');
	v_at := pg_temp.h_toast();
	set local role service_role;
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	reset role;
	v_describe := array[pg_temp.h_toast() - v_at, pg_temp.h_calls('qorpera_describe_native_tool_authority') - v_describes,
		pg_temp.h_calls('qorpera_execution_runtime_manifest') - v_manifests];

	v_describes := pg_temp.h_calls('qorpera_describe_native_tool_authority');
	v_manifests := pg_temp.h_calls('qorpera_execution_runtime_manifest');
	v_at := pg_temp.h_toast();
	set local role service_role;
	perform public.qorpera_begin_native_company_execution_v2(v_binding, v_binary,
		v_identity ->> 'runtimeBundleSha256', v_identity ->> 'reasoningPolicySha256',
		'{"type":"namespace","name":"qorpera","description":"Synthetic native fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
		repeat('c', 64), 10);
	reset role;
	v_launch := array[pg_temp.h_toast() - v_at, pg_temp.h_calls('qorpera_describe_native_tool_authority') - v_describes,
		pg_temp.h_calls('qorpera_execution_runtime_manifest') - v_manifests];

	perform pg_temp.base_public_send(v_binding, 'progress', 't671-ack');
	v_describes := pg_temp.h_calls('qorpera_describe_native_tool_authority');
	v_manifests := pg_temp.h_calls('qorpera_execution_runtime_manifest');
	v_at := pg_temp.h_toast();
	set local role service_role;
	v_answer := public.qorpera_fence_native_context('92400000-0000-4000-8000-000000000020', v_binding, '{}',
		jsonb_build_object('schema', 'qorpera.native-context-view/v1', 'requestId', 't671-fence', 'threadId', 'thread-1',
			'turnId', 'turn-1', 'purpose', 'turn', 'outputs', '[]'::jsonb));
	reset role;
	v_fence := array[pg_temp.h_toast() - v_at, pg_temp.h_calls('qorpera_describe_native_tool_authority') - v_describes,
		pg_temp.h_calls('qorpera_execution_runtime_manifest') - v_manifests];

	raise notice '671 callers (toast reads, describes, manifest calls): run check alone % reads, describe %, launch %, fence %',
		v_lock, v_describe, v_launch, v_fence;
	perform set_config('qorpera_test.h_callers', format('run check alone %s reads, describe %s, launch %s, fence %s',
		v_lock, v_describe, v_launch, v_fence), true);
	perform pg_temp.base_assert(v_answer ->> 'schema' = 'qorpera.native-context-fence/v1', 'the fence answers: ' || v_answer::text);
	perform pg_temp.base_assert(v_lock = 0, 'the run check reads no manifest');
	perform pg_temp.base_assert(v_describe = array[1, 1, 1]::bigint[], 'describe: ' || v_describe::text);
	perform pg_temp.base_assert(v_launch = array[1, 0, 1]::bigint[], 'the launch: ' || v_launch::text);
	perform pg_temp.base_assert(v_fence = array[1, 1, 1]::bigint[], 'the fence: ' || v_fence::text);
end $$;
select current_setting('qorpera_test.h_callers') as h_callers \gset
\echo 671 callers (toast reads, describes, manifest calls): :h_callers
rollback;
