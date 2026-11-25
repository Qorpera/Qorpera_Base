-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
reset role;

do $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_full jsonb;
	v_head jsonb;
	v_proc pg_proc;
	v_bad_id uuid;
	v_bad_manifest jsonb;
	v_bad_sha text;
	v_bad_run public.qorpera_execution_runs%rowtype;
begin
	select * into strict v_run from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
	v_full := public.qorpera_execution_runtime_manifest(v_run);
	v_head := public.qorpera_execution_runtime_manifest_head(v_run);
	perform pg_temp.base_assert(v_head = (v_full - 'implementation' - 'components'),
		'manifest_head matches full manifest minus implementation and components');
	perform pg_temp.base_assert(not (v_head ? 'implementation') and not (v_head ? 'components'),
		'manifest_head omits large keys');

	select * into strict v_proc from pg_proc
	where oid = 'public.qorpera_execution_runtime_manifest_head(public.qorpera_execution_runs)'::regprocedure;
	perform pg_temp.base_assert(position('select manifest_head,' in v_proc.prosrc) > 0
		and position('select manifest ' in v_proc.prosrc) = 0,
		'manifest_head helper never detoasts full manifest');
	perform pg_temp.base_assert(not exists (
		select 1 from unnest(array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker']) as r(name)
		where has_function_privilege(r.name, v_proc.oid, 'execute')
	), 'manifest_head helper revokes execute');

	v_bad_manifest := v_full || '{"components":[]}'::jsonb;
	v_bad_sha := encode(extensions.digest(convert_to(v_bad_manifest::text, 'utf8'), 'sha256'), 'hex');
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	values ('test-1376-bad-comp-type', 1, v_bad_manifest, v_bad_sha) returning id into v_bad_id;
	v_bad_run := v_run;
	v_bad_run.runtime_bundle_id := v_bad_id;
	v_bad_run.runtime_bundle_sha256 := v_bad_sha;
	perform pg_temp.base_error(format(
		'select public.qorpera_execution_runtime_manifest_head(jsonb_populate_record(null::public.qorpera_execution_runs, %L::jsonb))',
		jsonb_build_object('runtime_bundle_id', v_bad_id, 'runtime_bundle_sha256', v_bad_sha)::text
	), '42501', 'Run requires an executable runtime bundle');

	perform pg_temp.base_assert(not exists (
		select 1 from pg_proc p join pg_language l on l.oid = p.prolang
		where p.oid in (
			'public.qorpera_folder_actor_rules(uuid,uuid,jsonb,text)'::regprocedure,
			'public.qorpera_folder_agent_grant(public.qorpera_company_path_resources,uuid,text)'::regprocedure,
			'public.qorpera_environment_is_folder_v2(uuid)'::regprocedure,
			'public.qorpera_company_is_folder_v2(uuid)'::regprocedure,
			'public.qorpera_member_role(uuid)'::regprocedure,
			'public.qorpera_company_deleting(uuid)'::regprocedure,
			'public.qorpera_can_read_profile(uuid)'::regprocedure,
			'public.qorpera_can_authorize_profile(uuid)'::regprocedure,
			'public.qorpera_can_write_profile(uuid)'::regprocedure,
			'public.qorpera_can_read_session(uuid)'::regprocedure,
			'public.qorpera_company_machine_placement(uuid)'::regprocedure,
			'public.qorpera_provider_execution_enabled(text,text,text)'::regprocedure,
			'public.qorpera_company_at_zero(uuid,timestamptz)'::regprocedure
		) and l.lanname <> 'plpgsql'
	), 'all 13 hot helpers converted to plpgsql');

	perform pg_temp.base_assert(
		public.qorpera_company_machine_placement(extensions.gen_random_uuid()) is null,
		'qorpera_company_machine_placement returns real NULL when missing');

	select * into strict v_proc from pg_proc
	where oid = 'public.qorpera_fence_native_context(uuid,jsonb,text[],jsonb)'::regprocedure;
	perform pg_temp.base_assert(position('path_key_sha256' in v_proc.prosrc) > 0,
		'qorpera_fence_native_context probes kept read paths by path_key_sha256');

	perform pg_temp.base_assert(exists (
		select 1 from pg_indexes where schemaname = 'public' and indexname = 'qorpera_profile_members_user_profile'
	) and exists (
		select 1 from pg_indexes where schemaname = 'public' and indexname = 'qorpera_runner_jobs_leased_expires'
	) and exists (
		select 1 from pg_indexes where schemaname = 'public' and indexname = 'qorpera_company_path_grants_staff_active'
	), 'new hot indexes present');

	perform pg_temp.base_assert(not exists (
		select 1 from pg_indexes where schemaname = 'public' and indexname in (
			'qorpera_folder_object_gc_due',
			'qorpera_surface_changes_session',
			'qorpera_runner_model_requests_job',
			'qorpera_agent_works_for_asks_profile',
			'qorpera_coding_snapshots_node'
		)
	), '5 redundant prefix indexes removed');
end $$;

rollback;
