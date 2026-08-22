begin;

insert into auth.users (id, email)
values ('18000000-0000-4000-8000-000000000001', 'head-substrate-owner@example.test');

insert into public.qorpera_profiles (id, name, created_by_user_id)
values (
	'18000000-0000-4000-8000-000000000010', 'Head substrate company',
	'18000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (
	'18000000-0000-4000-8000-000000000010',
	'18000000-0000-4000-8000-000000000001',
	'head-substrate-owner@example.test', 'Head substrate owner', 'owner'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"18000000-0000-4000-8000-000000000001","email":"head-substrate-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);

insert into public.qorpera_company_environments (
	id, profile_id, name, contract_version, created_by_user_id
) values (
	'18000000-0000-4000-8000-000000000020',
	'18000000-0000-4000-8000-000000000010',
	'Head substrate environment', 1, '18000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_company_snapshots (
	id, profile_id, environment_id, workspace_id, client_snapshot_id,
	tree_manifest_sha256, tree_manifest_bytes, tree_contract_version,
	file_count, total_bytes, created_by_user_id
) values (
	'18000000-0000-4000-8000-000000000030',
	'18000000-0000-4000-8000-000000000010',
	'18000000-0000-4000-8000-000000000020',
	(select canonical_workspace_id from public.qorpera_company_files
		where environment_id = '18000000-0000-4000-8000-000000000020'),
	'18000000-0000-4000-8000-000000000031', repeat('1', 64), 2, 3, 0, 0,
	'18000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_company_snapshot_publications (
	snapshot_id, restricted_content_sha256, status, published_at
) values (
	'18000000-0000-4000-8000-000000000030', repeat('2', 64),
	'published', statement_timestamp()
);

update public.qorpera_company_files
set head_snapshot_id = '18000000-0000-4000-8000-000000000030',
	state = 'ready', logical_bytes = 0, updated_at = statement_timestamp()
where environment_id = '18000000-0000-4000-8000-000000000020';

insert into public.qorpera_profile_staff (
	profile_id, staff_agent_id, display_name, role, charter,
	appearance_color, appearance_shape, employment_status, lifecycle_state,
	model_provider, model_id, created_at, updated_at, updated_by_user_id
) values (
	'18000000-0000-4000-8000-000000000010',
	'18000000-0000-4000-8000-000000000040',
	'Head substrate agent', 'Operations', 'Exercise current-head substrate creation.',
	'blue', 'round', 'active', 'active', 'openai', 'gpt-test',
	statement_timestamp(), statement_timestamp(), '18000000-0000-4000-8000-000000000001'
);

do $$
begin
	if not exists (
		select 1
		from public.qorpera_company_substrate_versions as substrate
		join public.qorpera_profile_operation_clocks as clock
			on clock.profile_id = substrate.profile_id
		where substrate.profile_id = '18000000-0000-4000-8000-000000000010'
			and substrate.environment_id = '18000000-0000-4000-8000-000000000020'
			and substrate.company_snapshot_id = '18000000-0000-4000-8000-000000000030'
			and substrate.operation_sequence = clock.last_sequence
	) then
		raise exception 'staff state did not refresh the current cloud substrate';
	end if;
end
$$;

insert into public.qorpera_company_snapshots (
	id, profile_id, environment_id, workspace_id, client_snapshot_id,
	parent_snapshot_id, tree_manifest_sha256, tree_manifest_bytes,
	tree_contract_version, file_count, total_bytes, created_by_user_id
) values (
	'18000000-0000-4000-8000-000000000050',
	'18000000-0000-4000-8000-000000000010',
	'18000000-0000-4000-8000-000000000020',
	(select canonical_workspace_id from public.qorpera_company_files
		where environment_id = '18000000-0000-4000-8000-000000000020'),
	'18000000-0000-4000-8000-000000000051',
	'18000000-0000-4000-8000-000000000030', repeat('3', 64), 2, 3, 0, 0,
	'18000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_company_snapshot_publications (
	snapshot_id, expected_head_snapshot_id, restricted_content_sha256, status, published_at
) values (
	'18000000-0000-4000-8000-000000000050',
	'18000000-0000-4000-8000-000000000030', repeat('2', 64),
	'published', statement_timestamp()
);

update public.qorpera_company_workspaces
set head_snapshot_id = '18000000-0000-4000-8000-000000000050', updated_at = statement_timestamp()
where id = (
	select canonical_workspace_id from public.qorpera_company_files
	where environment_id = '18000000-0000-4000-8000-000000000020'
);

update public.qorpera_company_files
set head_snapshot_id = '18000000-0000-4000-8000-000000000050',
	state = 'ready', logical_bytes = 0, updated_at = statement_timestamp()
where environment_id = '18000000-0000-4000-8000-000000000020';

do $$
begin
	if not exists (
		select 1
		from public.qorpera_company_substrate_versions as substrate
		join public.qorpera_profile_operation_clocks as clock
			on clock.profile_id = substrate.profile_id
		where substrate.profile_id = '18000000-0000-4000-8000-000000000010'
			and substrate.environment_id = '18000000-0000-4000-8000-000000000020'
			and substrate.company_snapshot_id = '18000000-0000-4000-8000-000000000050'
			and substrate.operation_sequence = clock.last_sequence
	) then
		raise exception 'published cloud revision did not create a runnable current-head substrate';
	end if;
end
$$;

rollback;
