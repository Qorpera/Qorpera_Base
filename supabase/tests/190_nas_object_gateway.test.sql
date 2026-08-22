-- The NAS gateway must be the only path that can convert verified bytes into
-- catalog authority. Client roles authorize operations but cannot confirm or
-- delete catalog rows themselves.

select set_config(
	'request.jwt.claims',
	'{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
select set_config(
	'qorpera_test.nas_profile',
	public.qorpera_create_hosted_profile('NAS gateway', 'main', 1) ->> 'profile_id',
	false
);

do $$
declare
	v_authority jsonb;
	v_denied boolean := false;
begin
	v_authority := public.qorpera_authorize_profile_object_upload(
		current_setting('qorpera_test.nas_profile')::uuid,
		repeat('9', 64),
		23
	);
	if (v_authority ->> 'allowed')::boolean is not true
		or (v_authority ->> 'exists')::boolean is not false then
		raise exception 'member upload authority is invalid: %', v_authority;
	end if;
	begin
		perform public.qorpera_confirm_profile_object_upload(
			current_setting('qorpera_test.nas_profile')::uuid,
			repeat('9', 64),
			23,
			'nas-object-gateway'
		);
	exception when insufficient_privilege then
		v_denied := true;
	end;
	if not v_denied then
		raise exception 'authenticated member can confirm an object catalog row';
	end if;
end
$$;

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;
select public.qorpera_confirm_profile_object_upload(
	current_setting('qorpera_test.nas_profile')::uuid,
	repeat('9', 64),
	23,
	'nas-object-gateway'
);
reset role;
select set_config('request.jwt.claims', '', false);

do $$
declare
	v_backend text;
	v_bytes bigint;
begin
	select object.backend, object.bytes into v_backend, v_bytes
	from public.qorpera_profile_objects as object
	where object.profile_id = current_setting('qorpera_test.nas_profile')::uuid
		and object.sha256 = repeat('9', 64);
	if v_backend is distinct from 'nas-object-gateway' or v_bytes is distinct from 23 then
		raise exception 'gateway confirmation did not create the exact NAS catalog row';
	end if;
end
$$;

-- Legacy catalog rows are exposed only to the service migration cursor.
insert into storage.objects (bucket_id, name, metadata)
values (
	'qorpera-profile-objects',
	current_setting('qorpera_test.nas_profile') || '/' || repeat('8', 64),
	'{"size":"11"}'
);
select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;
do $$
declare
	v_batch jsonb;
begin
	v_batch := public.qorpera_list_profile_objects_for_migration(
		current_setting('qorpera_test.nas_profile')::uuid,
		repeat('7', 64),
		10
	);
	if jsonb_array_length(v_batch) < 1
		or v_batch -> 0 ->> 'profile_id' <> current_setting('qorpera_test.nas_profile')
		or v_batch -> 0 ->> 'sha256' <> repeat('8', 64)
		or (v_batch -> 0 ->> 'bytes')::bigint <> 11 then
		raise exception 'legacy object migration cursor is invalid: %', v_batch;
	end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);

-- A legacy duplicate can exist during migration. Its mirror may neither flip
-- nor delete the authoritative NAS row, and drift excludes the migrated row.
insert into storage.objects (bucket_id, name, metadata)
values (
	'qorpera-profile-objects',
	current_setting('qorpera_test.nas_profile') || '/' || repeat('9', 64),
	'{"size":"23"}'
);
delete from storage.objects
where bucket_id = 'qorpera-profile-objects'
	and name = current_setting('qorpera_test.nas_profile') || '/' || repeat('9', 64);

do $$
declare
	v_backend text;
begin
	select object.backend into v_backend
	from public.qorpera_profile_objects as object
	where object.profile_id = current_setting('qorpera_test.nas_profile')::uuid
		and object.sha256 = repeat('9', 64);
	if v_backend is distinct from 'nas-object-gateway' then
		raise exception 'legacy Storage deletion removed or changed the NAS catalog row';
	end if;
	if public.qorpera_object_catalog_drift() <> 0 then
		raise exception 'NAS catalog rows are incorrectly reported as Storage drift';
	end if;
end
$$;

-- The owner can resolve the object location; an unrelated account cannot.
select set_config(
	'request.jwt.claims',
	'{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
declare
	v_authority jsonb;
begin
	v_authority := public.qorpera_authorize_profile_object_download(
		current_setting('qorpera_test.nas_profile')::uuid,
		repeat('9', 64)
	);
	if v_authority ->> 'backend' <> 'nas-object-gateway'
		or (v_authority ->> 'bytes')::bigint <> 23 then
		raise exception 'member download authority is invalid: %', v_authority;
	end if;
end
$$;
reset role;

select set_config(
	'request.jwt.claims',
	'{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
declare
	v_denied boolean := false;
begin
	begin
		perform public.qorpera_authorize_profile_object_download(
			current_setting('qorpera_test.nas_profile')::uuid,
			repeat('9', 64)
		);
	exception when insufficient_privilege then
		v_denied := true;
	end;
	if not v_denied then
		raise exception 'unrelated member can authorize a NAS object read';
	end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);

-- Deletion confirmation is accepted only under a live exact GC lease.
insert into public.qorpera_company_object_gc_leases (profile_id, lease_id, lease_expires_at)
values (
	current_setting('qorpera_test.nas_profile')::uuid,
	'99000000-0000-4000-8000-000000000001',
	statement_timestamp() + interval '10 minutes'
);
insert into public.qorpera_company_object_gc_entries (profile_id, lease_id, object_sha256, bytes)
values (
	current_setting('qorpera_test.nas_profile')::uuid,
	'99000000-0000-4000-8000-000000000001',
	repeat('9', 64),
	23
);

select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;
do $$
begin
	if not public.qorpera_confirm_profile_object_deletion(
		current_setting('qorpera_test.nas_profile')::uuid,
		repeat('9', 64),
		23,
		'nas-object-gateway',
		'99000000-0000-4000-8000-000000000001'
	) then
		raise exception 'live cleanup lease did not delete the NAS catalog row';
	end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);

do $$
begin
	if exists (
		select 1 from public.qorpera_profile_objects as object
		where object.profile_id = current_setting('qorpera_test.nas_profile')::uuid
			and object.sha256 = repeat('9', 64)
	) then
		raise exception 'NAS catalog row survived confirmed cleanup';
	end if;
end
$$;
