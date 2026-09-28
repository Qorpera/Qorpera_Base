-- Deleting a company must leave its immutable bytes in a durable, service-
-- claimed cleanup path. The gateway still requires the exact live lease, and
-- a lost confirmation response is safe to retry.

select set_config(
	'request.jwt.claims',
	'{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
select set_config(
	'qorpera_test.deleted_nas_profile',
	public.qorpera_create_hosted_profile('Deleted NAS gateway', 'main', 1) ->> 'profile_id',
	false
);
reset role;

select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;
select public.qorpera_confirm_profile_object_upload(
	current_setting('qorpera_test.deleted_nas_profile')::uuid,
	repeat('6', 64),
	37,
	'nas-object-gateway'
);
reset role;

select set_config(
	'request.jwt.claims',
	'{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
select public.qorpera_delete_hosted_profile(current_setting('qorpera_test.deleted_nas_profile')::uuid);
reset role;
-- Deleting hides the company and stops its work; the deletion finishes once no node holds anything
-- of it (20260929150000). This company has nothing on a node.
select public.qorpera_finish_company_deletion(current_setting('qorpera_test.deleted_nas_profile')::uuid);

select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;
do $$
declare
	v_job jsonb;
	v_authorization jsonb;
	v_authorization_id uuid;
	v_hashes text[] := array[repeat('6', 64)];
begin
	v_job := public.qorpera_claim_deleted_profile_object_gc(
		100,
		'99000000-0000-4000-8000-000000000002'
	);
	if v_job ->> 'profile_id' <> current_setting('qorpera_test.deleted_nas_profile')
		or v_job ->> 'lease_id' <> '99000000-0000-4000-8000-000000000002'
		or jsonb_array_length(v_job -> 'objects') <> 1
		or v_job -> 'objects' -> 0 ->> 'sha256' <> repeat('6', 64)
		or (v_job -> 'objects' -> 0 ->> 'bytes')::bigint <> 37
		or v_job -> 'objects' -> 0 ->> 'backend' <> 'nas-object-gateway' then
		raise exception 'deleted profile object claim is invalid: %', v_job;
	end if;
	begin
		perform public.qorpera_complete_deleted_profile_object_gc(
			current_setting('qorpera_test.deleted_nas_profile')::uuid,
			'99000000-0000-4000-8000-000000000002',
			null
		);
		raise exception 'null object completion unexpectedly succeeded';
	exception
		when insufficient_privilege then null;
	end;
	if not exists (
		select 1 from public.qorpera_deleted_profile_object_gc_leases as lease
		where lease.profile_id = current_setting('qorpera_test.deleted_nas_profile')::uuid
			and lease.lease_id = '99000000-0000-4000-8000-000000000002'
	) then
		raise exception 'invalid completion released the cleanup lease';
	end if;
	perform public.qorpera_renew_deleted_profile_object_gc(
		current_setting('qorpera_test.deleted_nas_profile')::uuid,
		'99000000-0000-4000-8000-000000000002',
		v_hashes
	);
	v_authorization := public.qorpera_authorize_profile_object_deletion(
		current_setting('qorpera_test.deleted_nas_profile')::uuid,
		repeat('6', 64),
		37,
		'nas-object-gateway',
		'99000000-0000-4000-8000-000000000002'
	);
	v_authorization_id := (v_authorization ->> 'authorization_id')::uuid;
	if v_authorization ->> 'state' <> 'authorized' or v_authorization_id is null then
		raise exception 'deleted profile cleanup did not authorize physical deletion';
	end if;
	if not public.qorpera_finalize_profile_object_deletion(
		v_authorization_id,
		current_setting('qorpera_test.deleted_nas_profile')::uuid,
		repeat('6', 64),
		37,
		'nas-object-gateway'
	) then
		raise exception 'deleted profile cleanup did not finalize the catalog row';
	end if;
	if public.qorpera_finalize_profile_object_deletion(
		v_authorization_id,
		current_setting('qorpera_test.deleted_nas_profile')::uuid,
		repeat('6', 64),
		37,
		'nas-object-gateway'
	) then
		raise exception 'retrying a finalized deleted profile object reported a second deletion';
	end if;
	if public.qorpera_complete_deleted_profile_object_gc(
		current_setting('qorpera_test.deleted_nas_profile')::uuid,
		'99000000-0000-4000-8000-000000000002',
		v_hashes
	) <> 1 then
		raise exception 'deleted profile object cleanup completion count is invalid';
	end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);

do $$
begin
	if exists (
		select 1 from public.qorpera_profile_objects as object
		where object.profile_id = current_setting('qorpera_test.deleted_nas_profile')::uuid
	) or exists (
		select 1 from public.qorpera_deleted_profile_object_gc_leases as lease
		where lease.profile_id = current_setting('qorpera_test.deleted_nas_profile')::uuid
	) then
		raise exception 'deleted profile object cleanup left durable state behind';
	end if;
end
$$;
