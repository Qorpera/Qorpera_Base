-- Supabase promotion is a service-only, explicit, graph-atomic authority
-- change. The exact current verified Company File graph, catalog closure, and
-- physical Storage metadata must exist while no cleanup fence is active.

select set_config(
	'request.jwt.claims',
	'{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}',
	false
);
-- Privileged legacy-company fixture; client creation now uses founding.
select set_config(
	'qorpera_test.supabase_promotion_profile',
	public.qorpera_create_hosted_profile('Supabase promotion', 'main', 1) ->> 'profile_id',
	false
);
reset role;

select set_config(
	'qorpera_test.supabase_promotion_environment',
	(
		select environment.id::text
		from public.qorpera_company_environments as environment
		where environment.profile_id = current_setting('qorpera_test.supabase_promotion_profile')::uuid
	),
	false
);
select set_config(
	'qorpera_test.supabase_promotion_workspace',
	(
		select file.canonical_workspace_id::text
		from public.qorpera_company_files as file
		where file.profile_id = current_setting('qorpera_test.supabase_promotion_profile')::uuid
	),
	false
);

insert into public.qorpera_company_snapshots (
	id, profile_id, environment_id, workspace_id, client_snapshot_id,
	tree_manifest_sha256, tree_manifest_bytes, tree_contract_version,
	file_count, total_bytes, created_by_user_id
)
values (
	'99000000-0000-4000-8000-000000000071',
	current_setting('qorpera_test.supabase_promotion_profile')::uuid,
	current_setting('qorpera_test.supabase_promotion_environment')::uuid,
	current_setting('qorpera_test.supabase_promotion_workspace')::uuid,
	'99000000-0000-4000-8000-000000000072',
	repeat('6', 64), 23, 3, 1, 17,
	'80000000-0000-4000-8000-00000000000a'
);
update public.qorpera_company_workspaces
set head_snapshot_id = '99000000-0000-4000-8000-000000000071'
where id = current_setting('qorpera_test.supabase_promotion_workspace')::uuid;
update public.qorpera_company_files
set head_snapshot_id = '99000000-0000-4000-8000-000000000071',
	state = 'ready',
	logical_bytes = 17
where profile_id = current_setting('qorpera_test.supabase_promotion_profile')::uuid;

select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;
select public.qorpera_confirm_profile_object_upload(
	current_setting('qorpera_test.supabase_promotion_profile')::uuid,
	repeat('6', 64),
	23,
	'nas-object-gateway'
);
select public.qorpera_confirm_profile_object_upload(
	current_setting('qorpera_test.supabase_promotion_profile')::uuid,
	repeat('7', 64),
	17,
	'nas-object-gateway'
);
reset role;

insert into public.qorpera_object_reachability_graphs (
	id, profile_id, environment_id, root_kind, root_id, client_graph_id,
	root_object_sha256, contract_version, content_sha256, object_count,
	storage_bytes, status, created_by_user_id
)
values (
	'99000000-0000-4000-8000-000000000073',
	current_setting('qorpera_test.supabase_promotion_profile')::uuid,
	current_setting('qorpera_test.supabase_promotion_environment')::uuid,
	'company_snapshot',
	'99000000-0000-4000-8000-000000000071',
	'99000000-0000-4000-8000-000000000074',
	repeat('6', 64), 1, repeat('8', 64), 2, 40,
	'uploading',
	'80000000-0000-4000-8000-00000000000a'
);
insert into public.qorpera_object_reachability_entries (graph_id, object_sha256, bytes)
values
	('99000000-0000-4000-8000-000000000073', repeat('6', 64), 23),
	('99000000-0000-4000-8000-000000000073', repeat('7', 64), 17);

select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;
update public.qorpera_object_reachability_graphs
set status = 'complete', completed_at = statement_timestamp(), closure_verified = true
where id = '99000000-0000-4000-8000-000000000073';
reset role;
select set_config('request.jwt.claims', '', false);

insert into storage.objects (bucket_id, name, metadata)
values
	(
		'qorpera-profile-objects',
		current_setting('qorpera_test.supabase_promotion_profile') || '/' || repeat('6', 64),
		'{"size":"23"}'
	),
	(
		'qorpera-profile-objects',
		current_setting('qorpera_test.supabase_promotion_profile') || '/' || repeat('7', 64),
		'{"size":"16"}'
	);

do $$
begin
	if has_function_privilege(
		'anon',
		'public.qorpera_promote_company_file_graph_to_supabase(uuid,uuid)',
		'EXECUTE'
	) or has_function_privilege(
		'authenticated',
		'public.qorpera_promote_company_file_graph_to_supabase(uuid,uuid)',
		'EXECUTE'
	) or not has_function_privilege(
		'service_role',
		'public.qorpera_promote_company_file_graph_to_supabase(uuid,uuid)',
		'EXECUTE'
	) then
		raise exception 'Supabase graph promotion ACL is invalid';
	end if;
end
$$;

select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;
do $$
declare
	v_denied boolean := false;
begin
	begin
		perform public.qorpera_promote_company_file_graph_to_supabase(
			current_setting('qorpera_test.supabase_promotion_profile')::uuid,
			'99000000-0000-4000-8000-000000000073'
		);
	exception when object_not_in_prerequisite_state then
		v_denied := true;
	end;
	if not v_denied then
		raise exception 'incomplete Supabase closure was promoted';
	end if;
end
$$;
reset role;

do $$
begin
	if exists (
		select 1
		from public.qorpera_profile_objects as object
		where object.profile_id = current_setting('qorpera_test.supabase_promotion_profile')::uuid
			and object.sha256 in (repeat('6', 64), repeat('7', 64))
			and object.backend <> 'nas-object-gateway'
	) then
		raise exception 'failed graph promotion partially changed catalog authority';
	end if;
end
$$;

update storage.objects
set metadata = '{"size":"17"}'
where bucket_id = 'qorpera-profile-objects'
	and name = current_setting('qorpera_test.supabase_promotion_profile') || '/' || repeat('7', 64);

select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;
do $$
declare
	v_result jsonb;
begin
	v_result := public.qorpera_promote_company_file_graph_to_supabase(
		current_setting('qorpera_test.supabase_promotion_profile')::uuid,
		'99000000-0000-4000-8000-000000000073'
	);
	if (v_result ->> 'changed_objects')::bigint <> 2
		or (v_result ->> 'object_count')::bigint <> 2
		or (v_result ->> 'storage_bytes')::bigint <> 40
		or v_result ->> 'backend' <> 'supabase-storage' then
		raise exception 'exact Supabase graph promotion returned an invalid receipt: %', v_result;
	end if;
	v_result := public.qorpera_promote_company_file_graph_to_supabase(
		current_setting('qorpera_test.supabase_promotion_profile')::uuid,
		'99000000-0000-4000-8000-000000000073'
	);
	if (v_result ->> 'changed_objects')::bigint <> 0 then
		raise exception 'Supabase graph promotion is not idempotent: %', v_result;
	end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);

do $$
declare
	v_promoted bigint;
begin
	select count(*) into v_promoted
	from public.qorpera_profile_objects as object
	where object.profile_id = current_setting('qorpera_test.supabase_promotion_profile')::uuid
		and object.sha256 in (repeat('6', 64), repeat('7', 64))
		and object.backend = 'supabase-storage';
	if v_promoted <> 2 then
		raise exception 'complete graph was not promoted atomically';
	end if;
end
$$;

insert into public.qorpera_company_object_gc_leases (profile_id, lease_id, lease_expires_at)
values (
	current_setting('qorpera_test.supabase_promotion_profile')::uuid,
	'99000000-0000-4000-8000-000000000077',
	statement_timestamp() + interval '10 minutes'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;
do $$
declare
	v_denied boolean := false;
begin
	begin
		perform public.qorpera_promote_company_file_graph_to_supabase(
			current_setting('qorpera_test.supabase_promotion_profile')::uuid,
			'99000000-0000-4000-8000-000000000073'
		);
	exception when sqlstate 'PGRST' then
		v_denied := true;
	end;
	if not v_denied then
		raise exception 'active cleanup fence allowed Supabase graph promotion';
	end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);
