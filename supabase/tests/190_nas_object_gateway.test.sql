-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A deleted folder-v2 company's bytes are removed only under a durable, exact deletion authorization (20260821009000,
-- 20260913000200): the service role cannot call the retired post-delete RPC; an unknown authorization is refused for a
-- catalogued object; a cleanup lease that holds nothing authorizes nothing; the live deleted-company cleanup lease
-- authorizes the deletion and the catalog row stays until storage confirms; finalize removes it once and is idempotent
-- (ported from snapshot-v1 in the legacy sweep).

-- The company is deleted and purged, as 922 does it; its folder objects' catalog rows outlive the purge as the
-- deleted-company cleanup's queue.
do $$
declare v_result jsonb;
begin
	perform pg_temp.base_assert((select count(*) from public.qorpera_profile_objects
		where profile_id = '92400000-0000-4000-8000-000000000010' and backend = 'nas-object-gateway') > 0,
		'the company holds catalogued folder objects');
	perform public.qorpera_request_company_deletion('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001');
	v_result := public.qorpera_finish_company_deletion('92400000-0000-4000-8000-000000000010');
	perform pg_temp.base_assert(v_result ->> 'state' = 'purged'
		and not exists (select 1 from public.qorpera_profiles where id = '92400000-0000-4000-8000-000000000010'),
		'the company is purged: ' || v_result::text);
end
$$;

-- The deleted-company cleanup claims it (other deleted companies may come first) under a live lease.
select pg_temp.base_claims('service_role');
set local role service_role;
do $$
declare v_job jsonb; v_lease uuid; v_attempts integer := 0;
begin
	loop
		v_attempts := v_attempts + 1;
		v_lease := ('19000000-0000-4000-8000-' || lpad(v_attempts::text, 12, '0'))::uuid;
		v_job := public.qorpera_claim_deleted_profile_object_gc(100, v_lease);
		exit when v_job is null or v_job ->> 'profile_id' = '92400000-0000-4000-8000-000000000010' or v_attempts > 50;
	end loop;
	perform pg_temp.base_assert(v_job ->> 'profile_id' = '92400000-0000-4000-8000-000000000010',
		'the deleted-company cleanup claims the company: ' || coalesce(v_job::text, 'nothing'));
	perform set_config('qorpera_test.og_lease', v_lease::text, true);
	perform set_config('qorpera_test.og_object', v_job -> 'objects' ->> 0, true);
end
$$;

-- Physical deletion is accepted only after a durable exact authorization.
do $$
declare
	v_lease uuid := current_setting('qorpera_test.og_lease')::uuid;
	v_sha text := current_setting('qorpera_test.og_object')::jsonb ->> 'sha256';
	v_bytes bigint := (current_setting('qorpera_test.og_object')::jsonb ->> 'bytes')::bigint;
	v_backend text := current_setting('qorpera_test.og_object')::jsonb ->> 'backend';
	v_authorization jsonb;
	v_authorization_id uuid;
begin
	perform pg_temp.base_assert(not has_function_privilege('service_role',
		'public.qorpera_confirm_profile_object_deletion(uuid,text,bigint,text,uuid)', 'EXECUTE'),
		'service role can call the retired post-delete authorization RPC');
	perform pg_temp.base_error(format('select public.qorpera_describe_profile_object_deletion_authorization(%L, %L, %L, %s, %L)',
		'19000000-0000-4000-8000-000000000098', '92400000-0000-4000-8000-000000000010', v_sha, v_bytes, v_backend),
		'55000', 'object deletion authorization is unavailable');
	perform pg_temp.base_error(format('select public.qorpera_authorize_profile_object_deletion(%L, %L, %s, %L, %L)',
		'92400000-0000-4000-8000-000000000010', v_sha, v_bytes, v_backend, '19000000-0000-4000-8000-000000000099'), 'PGRST');
	v_authorization := public.qorpera_authorize_profile_object_deletion('92400000-0000-4000-8000-000000000010', v_sha, v_bytes,
		v_backend, v_lease);
	v_authorization_id := (v_authorization ->> 'authorization_id')::uuid;
	perform pg_temp.base_assert(v_authorization ->> 'state' = 'authorized' and v_authorization_id is not null,
		'live cleanup lease did not create durable deletion authority: ' || v_authorization::text);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_profile_objects as object
		where object.profile_id = '92400000-0000-4000-8000-000000000010' and object.sha256 = v_sha),
		'deletion authorization removed the catalog before storage confirmation');
	perform pg_temp.base_assert(public.qorpera_finalize_profile_object_deletion(v_authorization_id,
		'92400000-0000-4000-8000-000000000010', v_sha, v_bytes, v_backend),
		'authorized physical deletion did not finalize the NAS catalog row');
	perform pg_temp.base_assert(not public.qorpera_finalize_profile_object_deletion(v_authorization_id,
		'92400000-0000-4000-8000-000000000010', v_sha, v_bytes, v_backend),
		'deletion finalization was not idempotent');
end
$$;
reset role;

do $$
begin
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_profile_objects as object
		where object.profile_id = '92400000-0000-4000-8000-000000000010'
			and object.sha256 = current_setting('qorpera_test.og_object')::jsonb ->> 'sha256'),
		'NAS catalog row survived confirmed cleanup');
end
$$;

rollback;
