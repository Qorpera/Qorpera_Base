-- Canonical Company File creation, revision CAS, quota, and session pinning.

insert into auth.users (id, email, raw_user_meta_data)
values (
	'14000000-0000-4000-8000-000000000001',
	'cloud-company-owner@example.test',
	'{"full_name":"Cloud Company Owner"}'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"14000000-0000-4000-8000-000000000001","email":"cloud-company-owner@example.test","role":"authenticated","user_metadata":{"full_name":"Cloud Company Owner"}}',
	false
);
set role authenticated;

select set_config(
	'qorpera_test.cloud_company',
	public.qorpera_create_cloud_company(
		'14000000-0000-4000-8000-000000000010', 'Canonical Company', 2
	)::text,
	false
);

do $$
declare
	v_first jsonb := current_setting('qorpera_test.cloud_company')::jsonb;
	v_second jsonb;
	v_file jsonb;
	v_rebound boolean := false;
begin
	v_second := public.qorpera_create_cloud_company(
		'14000000-0000-4000-8000-000000000010', 'Canonical Company', 2
	);
	if v_first ->> 'profile_id' is distinct from v_second ->> 'profile_id'
		or v_first ->> 'environment_id' is distinct from v_second ->> 'environment_id' then
		raise exception 'cloud company creation is not idempotent';
	end if;
	begin
		perform public.qorpera_create_cloud_company(
			'14000000-0000-4000-8000-000000000010', 'Different Company', 2
		);
	exception when unique_violation then
		v_rebound := true;
	end;
	if not v_rebound then
		raise exception 'cloud company creation id accepted different request content';
	end if;
	begin
		perform public.qorpera_create_cloud_company(
			'14000000-0000-4000-8000-000000000011', 'Canonical Company', 3
		);
		raise exception 'unsupported company creation contract was accepted';
	exception when sqlstate '22023' then null;
	end;
	v_file := public.qorpera_get_company_file((v_first ->> 'environment_id')::uuid);
	if v_file ->> 'state' is distinct from 'provisioning'
		or (v_file ->> 'head_snapshot_id') is not null
		or (v_file ->> 'storage_limit_bytes')::bigint <> 53687091200 then
		raise exception 'new Company File is not a provisioned 50 GiB cloud authority: %', v_file;
	end if;
end
$$;

do $$
declare v_rejected boolean := false;
begin
	begin
		perform public.qorpera_prepare_company_file_revision(
			(current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid,
			'14000000-0000-4000-8000-000000000020', null,
			repeat('a', 64), 128, 3, 1, 4
		);
	exception when sqlstate '22023' then v_rejected := true;
	end;
	if not v_rejected then
		raise exception 'revision was prepared without its exact manifest object';
	end if;
end
$$;

reset role;
insert into storage.objects (bucket_id, name, metadata)
values (
	'qorpera-profile-objects',
	(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id') || '/' || repeat('a', 64),
	'{"size":128}'
);
set role authenticated;

select set_config('qorpera_test.cloud_company_snapshot',
	public.qorpera_prepare_company_file_revision(
		(current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid,
		'14000000-0000-4000-8000-000000000020', null,
		repeat('a', 64), 128, 3, 1, 4
	)::text, false);

do $$
declare v_rejected boolean := false;
begin
	begin
		perform public.qorpera_publish_company_file_revision(
			(current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid,
			(current_setting('qorpera_test.cloud_company_snapshot')::jsonb ->> 'snapshot_id')::uuid,
			null
		);
	exception when sqlstate '55000' then v_rejected := true;
	end;
	if not v_rejected then
		raise exception 'revision advanced the head without a verified reachable restore';
	end if;
end
$$;

select set_config('qorpera_test.cloud_company_graph',
	public.qorpera_begin_object_reachability_graph(
		'company_snapshot',
		(current_setting('qorpera_test.cloud_company_snapshot')::jsonb ->> 'snapshot_id')::uuid,
		'14000000-0000-4000-8000-000000000022', repeat('a', 64), 1,
		encode(extensions.digest(convert_to(repeat('a', 64) || ':128', 'utf8'), 'sha256'), 'hex'),
		1, 128
	) ->> 'graph_id', false);
select public.qorpera_append_object_reachability_entries(
	current_setting('qorpera_test.cloud_company_graph')::uuid,
	jsonb_build_array(jsonb_build_object('sha256', repeat('a', 64), 'bytes', 128))
);
select public.qorpera_complete_object_reachability_graph(
	current_setting('qorpera_test.cloud_company_graph')::uuid
);
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;
select public.qorpera_verify_company_snapshot_closure(
	(current_setting('qorpera_test.cloud_company_snapshot')::jsonb ->> 'snapshot_id')::uuid,
	current_setting('qorpera_test.cloud_company_graph')::uuid,
	'14000000-0000-4000-8000-000000000001',
	encode(extensions.digest(convert_to(repeat('a', 64) || ':128', 'utf8'), 'sha256'), 'hex'),
	1, 128, repeat('a', 64), 4
);
reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"14000000-0000-4000-8000-000000000001","email":"cloud-company-owner@example.test","role":"authenticated","user_metadata":{"full_name":"Cloud Company Owner"}}',
	false
);
set role authenticated;
select public.qorpera_create_object_restore_proof(
	current_setting('qorpera_test.cloud_company_graph')::uuid,
	'14000000-0000-4000-8000-000000000023', repeat('a', 64), 4
);
select public.qorpera_publish_company_file_revision(
	(current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid,
	(current_setting('qorpera_test.cloud_company_snapshot')::jsonb ->> 'snapshot_id')::uuid,
	null
);

reset role;
insert into storage.objects (bucket_id, name, metadata)
values (
	'qorpera-profile-objects',
	(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id') || '/' || repeat('b', 64),
	'{"size":128}'
);
set role authenticated;

do $$
declare
	v_company jsonb := current_setting('qorpera_test.cloud_company')::jsonb;
	v_snapshot jsonb := current_setting('qorpera_test.cloud_company_snapshot')::jsonb;
	v_file jsonb;
	v_session jsonb;
	v_pinned uuid;
	v_conflicted boolean := false;
begin
	v_file := public.qorpera_get_company_file((v_company ->> 'environment_id')::uuid);
	if v_file ->> 'state' is distinct from 'ready'
		or v_file ->> 'head_snapshot_id' is distinct from v_snapshot ->> 'snapshot_id'
		or (v_file ->> 'logical_bytes')::bigint <> 4 then
		raise exception 'canonical head did not advance: %', v_file;
	end if;

	begin
		perform public.qorpera_prepare_company_file_revision(
			(v_company ->> 'environment_id')::uuid,
			'14000000-0000-4000-8000-000000000021',
			null,
			repeat('b', 64),
			128,
			3,
			1,
			4
		);
	exception when sqlstate 'PT409' then
		v_conflicted := true;
	end;
	if not v_conflicted then
		raise exception 'stale Company File head was accepted';
	end if;

	begin
		perform public.qorpera_prepare_company_file_revision(
			(v_company ->> 'environment_id')::uuid,
			'14000000-0000-4000-8000-000000000024',
			(v_snapshot ->> 'snapshot_id')::uuid,
			repeat('b', 64), 128, 999, 1, 4
		);
		raise exception 'unsupported Company File contract version was accepted';
	exception when sqlstate '22023' then null;
	end;

	v_session := public.qorpera_create_shared_session_v2(
		(v_company ->> 'environment_id')::uuid,
		'14000000-0000-4000-8000-000000000030',
		'Pinned session',
		null,
		null
	);
	select session.company_snapshot_id into v_pinned
	from public.qorpera_shared_sessions as session
	where session.id = (v_session ->> 'session_id')::uuid;
	if v_pinned::text is distinct from v_snapshot ->> 'snapshot_id' then
		raise exception 'session did not pin the canonical Company File revision';
	end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

do $$
begin
	if has_function_privilege(
		'authenticated',
		'public.qorpera_create_shared_session_v3(uuid, uuid, text, text, uuid, jsonb)',
		'execute'
	) then
		raise exception 'authenticated clients can bypass revision-pinned session creation';
	end if;
end
$$;

-- The object catalog counts content-addressed bytes once and refuses a new
-- object that would cross the allowance before Storage records it.
update public.qorpera_company_files
set storage_limit_bytes = 261
where environment_id = (current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid;

insert into storage.objects (bucket_id, name, metadata)
values (
	'qorpera-profile-objects',
	(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id') || '/' || repeat('c', 64),
	'{"size":4}'
);

do $$
declare
	v_blocked boolean := false;
	v_file public.qorpera_company_files%rowtype;
begin
	begin
		insert into storage.objects (bucket_id, name, metadata)
		values (
			'qorpera-profile-objects',
			(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id') || '/' || repeat('d', 64),
			'{"size":2}'
		);
	exception when check_violation then
		v_blocked := true;
	end;
	if not v_blocked then raise exception 'storage quota accepted an over-limit object'; end if;
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = (current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid;
	if v_file.storage_used_bytes <> 260 then
		raise exception 'storage usage counter is %, expected 260', v_file.storage_used_bytes;
	end if;
end
$$;

-- Usage distinguishes the live logical file, retained replayable storage, and
-- physical uploaded storage. An abandoned object becomes reclaimable only
-- after the grace period and under a service-role deletion lease.
do $$
declare
	v_file jsonb;
begin
	v_file := public.qorpera_company_file_json((
		select file from public.qorpera_company_files as file
		where file.environment_id = (current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid
	));
	if (v_file ->> 'logical_bytes')::bigint <> 4
		or (v_file ->> 'retained_storage_bytes')::bigint <> 128
		or (v_file ->> 'storage_used_bytes')::bigint <> 260 then
		raise exception 'Company File usage layers are inaccurate: %', v_file;
	end if;
end
$$;

update public.qorpera_profile_objects
set created_at = statement_timestamp() - interval '25 hours'
where profile_id = (current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id')::uuid
	and sha256 = repeat('c', 64);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;

do $$
declare
	v_claim jsonb;
	v_profile_id uuid := (current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id')::uuid;
	v_lease_id uuid := '14000000-0000-4000-8000-000000000080';
	v_deleted integer;
begin
	v_claim := public.qorpera_claim_company_object_gc(10, v_lease_id);
	if v_claim ->> 'profile_id' is distinct from v_profile_id::text
		or jsonb_array_length(v_claim -> 'objects') <> 1
		or v_claim -> 'objects' -> 0 ->> 'sha256' is distinct from repeat('c', 64) then
		raise exception 'company object GC did not isolate the abandoned object: %', v_claim;
	end if;
	perform public.qorpera_renew_company_object_gc(v_profile_id, v_lease_id, array[repeat('c', 64)]);
	perform set_config('storage.allow_delete_query', 'true', true);
	delete from storage.objects
	where bucket_id = 'qorpera-profile-objects'
		and name = v_profile_id::text || '/' || repeat('c', 64);
	perform set_config('storage.allow_delete_query', 'false', true);
	v_deleted := public.qorpera_complete_company_object_gc(v_profile_id, v_lease_id, array[repeat('c', 64)]);
	if v_deleted <> 1 then raise exception 'company object GC completion count is %', v_deleted; end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

do $$
declare
	v_file public.qorpera_company_files%rowtype;
begin
	select file.* into strict v_file
	from public.qorpera_company_files as file
	where file.environment_id = (current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid;
	if v_file.storage_used_bytes <> 256 then
		raise exception 'company object GC left physical usage at %', v_file.storage_used_bytes;
	end if;
end
$$;

insert into auth.users (id, email, raw_user_meta_data)
values (
	'14000000-0000-4000-8000-000000000002',
	'cloud-company-member@example.test',
	'{"full_name":"Cloud Company Member"}'
);
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (
	(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id')::uuid,
	'14000000-0000-4000-8000-000000000002',
	'cloud-company-member@example.test', 'Cloud Company Member', 'contributor'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"14000000-0000-4000-8000-000000000001","email":"cloud-company-owner@example.test","role":"authenticated","user_metadata":{"full_name":"Cloud Company Owner"}}',
	false
);
set role authenticated;
select public.qorpera_register_presence_device(
	(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id')::uuid,
	'14000000-0000-4000-8000-000000000090'
);
reset role;

select set_config(
	'request.jwt.claims',
	'{"sub":"14000000-0000-4000-8000-000000000002","email":"cloud-company-member@example.test","role":"authenticated","user_metadata":{"full_name":"Cloud Company Member"}}',
	false
);
set role authenticated;

do $$
declare
	v_rejected boolean := false;
	v_devices jsonb;
begin
	begin
		perform public.qorpera_register_presence_device(
			(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id')::uuid,
			'14000000-0000-4000-8000-000000000090'
		);
	exception when unique_violation then v_rejected := true;
	end;
	if not v_rejected then raise exception 'active presence device identity was reassigned'; end if;
	v_devices := public.qorpera_list_presence_devices(
		(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id')::uuid,
		array['14000000-0000-4000-8000-000000000090'::uuid]
	);
	if v_devices -> 0 ->> 'user_id' is distinct from '14000000-0000-4000-8000-000000000001'
		or v_devices -> 0 ->> 'name' is distinct from 'Cloud Company Owner' then
		raise exception 'presence identity was not resolved from membership: %', v_devices;
	end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);
