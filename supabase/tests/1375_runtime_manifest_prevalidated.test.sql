-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
reset role;

do $$
declare
	v_active_id uuid := (select runtime_bundle_id from public.qorpera_execution_runs
		where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid);
	v_active jsonb;
	v_state text;
	v_components boolean;
	v_proc pg_proc;
	v_id uuid;
	v_sha text;
	v_manifest jsonb;
begin
	select manifest, implementation_state, components_valid
	into strict v_active, v_state, v_components
	from public.qorpera_runtime_bundles where id = v_active_id;
	perform pg_temp.base_assert(v_state = 'ok' and v_components = true, 'active bundle prevalidated');

	v_manifest := v_active || '{"implementation":[]}'::jsonb;
	v_sha := encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex');
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	values ('test-1375-array', 1, v_manifest, v_sha) returning id into v_id;
	select implementation_state into strict v_state from public.qorpera_runtime_bundles where id = v_id;
	perform pg_temp.base_assert(v_state = 'bundle', 'array implementation classified as bundle error');

	v_manifest := jsonb_set(v_active, '{implementation,test-1375/bad.sql}', '"not-hex"');
	v_sha := encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex');
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	values ('test-1375-bad-impl', 1, v_manifest, v_sha) returning id into v_id;
	select implementation_state into strict v_state from public.qorpera_runtime_bundles where id = v_id;
	perform pg_temp.base_assert(v_state = 'components', 'invalid implementation hash classified as components error');

	v_manifest := v_active #- '{components,kernel}';
	v_sha := encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex');
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	values ('test-1375-bad-comp', 1, v_manifest, v_sha) returning id into v_id;
	select components_valid into strict v_components from public.qorpera_runtime_bundles where id = v_id;
	perform pg_temp.base_assert(v_components = false, 'missing component classified as invalid');

	select * into strict v_proc from pg_proc
	where oid = 'public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)'::regprocedure;
	perform pg_temp.base_assert(position('jsonb_each_text' in v_proc.prosrc) = 0, 'manifest validation performs no runtime jsonb_each_text scan');
	perform pg_temp.base_assert(not exists (
		select 1 from unnest(array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker']) as r(name)
		where has_function_privilege(r.name, 'public.qorpera_runtime_bundle_implementation_state(jsonb)'::regprocedure, 'execute')
			or has_function_privilege(r.name, 'public.qorpera_runtime_bundle_components_valid(jsonb)'::regprocedure, 'execute')
	), 'prevalidation helpers revoke execute');
end $$;

rollback;
