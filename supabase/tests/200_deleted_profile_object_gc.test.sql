-- Deleting a company must leave its immutable bytes in a durable, service-
-- claimed cleanup path. The gateway still requires the exact live lease, and
-- a lost confirmation response is safe to retry.
--
-- The company is a folder-v2 company of 040's account A, and its bytes are one
-- file staged through the folder upload (its chunk and its manifest, both kept
-- by the NAS object gateway), as the platform stores every folder-v2 object.
-- 922 drives the cleanup's happy path end to end; this keeps its edge cases: a
-- null completion is refused and keeps the lease, the renew, a retried
-- finalize reports no second deletion, and the completion count.

select set_config('qorpera_test.deleted_nas_company', public.qorpera_folder_company_open('80000000-0000-4000-8000-00000000000a',
	'99000000-0000-4000-8000-0000000000e1', 'Deleted NAS gateway')::text, false);
select set_config('qorpera_test.deleted_nas_profile',
	current_setting('qorpera_test.deleted_nas_company')::jsonb ->> 'profile_id', false);

do $$
begin
	if not public.qorpera_company_is_folder_v2(current_setting('qorpera_test.deleted_nas_profile')::uuid) then
		raise exception 'the deleted company is not a folder-v2 company';
	end if;
end
$$;

-- The platform stages one file: its upload intent, each object confirmed as the gateway stored it, then sealed.
create function pg_temp.manifest_v2(p_text text) returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"text/plain","executable":false,"chunks":[{"sha256":"%s","bytes":%s}]}',
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'), octet_length(convert_to(p_text, 'utf8')),
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'), octet_length(convert_to(p_text, 'utf8')))
$$;
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
set role service_role;
do $$
declare
	v_environment uuid := (current_setting('qorpera_test.deleted_nas_company')::jsonb ->> 'environment_id')::uuid;
	v_manifest text := pg_temp.manifest_v2('Bytes of a company that is deleted.');
	v_actor constant jsonb := '{"kind":"platform"}';
	v_open jsonb; v_object jsonb; v_seal jsonb;
begin
	v_open := public.qorpera_folder_open_upload(v_environment, v_actor, v_manifest);
	for v_object in select c from jsonb_array_elements(v_manifest::jsonb -> 'chunks') c
		union all select jsonb_build_object('sha256', encode(extensions.digest(convert_to(v_manifest, 'utf8'), 'sha256'), 'hex'),
			'bytes', octet_length(convert_to(v_manifest, 'utf8'))) loop
		perform public.qorpera_folder_confirm_object(v_environment, v_actor, (v_open ->> 'intentId')::uuid, v_object ->> 'sha256',
			(v_object ->> 'bytes')::bigint);
	end loop;
	v_seal := public.qorpera_folder_seal_upload(v_environment, v_actor, (v_open ->> 'intentId')::uuid);
	if v_seal ->> 'state' is distinct from 'sealed' then raise exception 'the staged file did not seal: %', v_seal; end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);

-- What the cleanup has to remove: the company's catalog, two objects kept by the gateway.
create temporary table deleted_nas_objects as
select object.sha256, object.bytes, object.backend from public.qorpera_profile_objects as object
where object.profile_id = current_setting('qorpera_test.deleted_nas_profile')::uuid;
grant select on deleted_nas_objects to service_role;
do $$
begin
	if (select count(*) from deleted_nas_objects) <> 2
		or exists (select 1 from deleted_nas_objects where backend <> 'nas-object-gateway') then
		raise exception 'the staged file is not two gateway objects in the catalog: %',
			(select jsonb_agg(to_jsonb(object)) from deleted_nas_objects as object);
	end if;
end
$$;

select set_config(
	'request.jwt.claims',
	'{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
select public.qorpera_delete_hosted_profile(current_setting('qorpera_test.deleted_nas_profile')::uuid);
reset role;
-- Deleting hides the company and stops its work; the deletion finishes once no node holds anything
-- of it (20260928249150). This company has nothing on a node.
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
	v_first_authorization_id uuid;
	v_object record;
	v_hashes text[] := array(select sha256 from deleted_nas_objects order by sha256);
begin
	v_job := public.qorpera_claim_deleted_profile_object_gc(
		100,
		'99000000-0000-4000-8000-000000000002'
	);
	if v_job ->> 'profile_id' <> current_setting('qorpera_test.deleted_nas_profile')
		or v_job ->> 'lease_id' <> '99000000-0000-4000-8000-000000000002'
		or jsonb_array_length(v_job -> 'objects') <> 2
		or (select jsonb_agg(jsonb_build_object('sha256', sha256, 'bytes', bytes,
				'path', current_setting('qorpera_test.deleted_nas_profile') || '/' || sha256, 'backend', backend) order by sha256)
			from deleted_nas_objects) is distinct from v_job -> 'objects' then
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
	for v_object in select * from deleted_nas_objects order by sha256 loop
		v_authorization := public.qorpera_authorize_profile_object_deletion(
			current_setting('qorpera_test.deleted_nas_profile')::uuid,
			v_object.sha256,
			v_object.bytes,
			v_object.backend,
			'99000000-0000-4000-8000-000000000002'
		);
		v_authorization_id := (v_authorization ->> 'authorization_id')::uuid;
		if v_authorization ->> 'state' <> 'authorized' or v_authorization_id is null then
			raise exception 'deleted profile cleanup did not authorize physical deletion';
		end if;
		if not public.qorpera_finalize_profile_object_deletion(
			v_authorization_id,
			current_setting('qorpera_test.deleted_nas_profile')::uuid,
			v_object.sha256,
			v_object.bytes,
			v_object.backend
		) then
			raise exception 'deleted profile cleanup did not finalize the catalog row';
		end if;
		v_first_authorization_id := coalesce(v_first_authorization_id, v_authorization_id);
	end loop;
	select * into v_object from deleted_nas_objects order by sha256 limit 1;
	if public.qorpera_finalize_profile_object_deletion(
		v_first_authorization_id,
		current_setting('qorpera_test.deleted_nas_profile')::uuid,
		v_object.sha256,
		v_object.bytes,
		v_object.backend
	) then
		raise exception 'retrying a finalized deleted profile object reported a second deletion';
	end if;
	if public.qorpera_complete_deleted_profile_object_gc(
		current_setting('qorpera_test.deleted_nas_profile')::uuid,
		'99000000-0000-4000-8000-000000000002',
		v_hashes
	) <> 2 then
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
