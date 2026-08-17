-- Immutable logical company-tree snapshots and fork-safe workspace heads.
--
-- Each workspace has one mutable head. Snapshot rows and their referenced
-- content-addressed objects are immutable. A commit advances one head with
-- compare-and-swap semantics; another workspace may fork from the same base
-- and advance independently.

create table public.qorpera_company_workspaces (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	client_workspace_id uuid not null,
	name text not null check (char_length(btrim(name)) between 1 and 160),
	head_snapshot_id uuid,
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	unique (profile_id, client_workspace_id)
);

create table public.qorpera_company_snapshots (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	workspace_id uuid not null references public.qorpera_company_workspaces(id) on delete cascade,
	client_snapshot_id uuid not null,
	parent_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete restrict,
	tree_manifest_sha256 text not null check (tree_manifest_sha256 ~ '^[0-9a-f]{64}$'),
	tree_manifest_bytes integer not null check (tree_manifest_bytes between 1 and 8388608),
	tree_contract_version integer not null check (tree_contract_version > 0),
	file_count integer not null check (file_count between 0 and 50000),
	total_bytes bigint not null check (total_bytes between 0 and 1099511627776),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	unique (profile_id, client_snapshot_id)
);

alter table public.qorpera_company_workspaces
	add constraint qorpera_company_workspaces_head_snapshot_fk
	foreign key (head_snapshot_id) references public.qorpera_company_snapshots(id) on delete set null;

create index qorpera_company_workspaces_environment_updated
	on public.qorpera_company_workspaces (environment_id, updated_at desc);

create index qorpera_company_snapshots_workspace_created
	on public.qorpera_company_snapshots (workspace_id, created_at desc);

alter table public.qorpera_company_workspaces enable row level security;
alter table public.qorpera_company_snapshots enable row level security;

create policy qorpera_company_workspaces_member_read
	on public.qorpera_company_workspaces
	for select
	to authenticated
	using (public.qorpera_can_read_profile(profile_id));

create policy qorpera_company_snapshots_member_read
	on public.qorpera_company_snapshots
	for select
	to authenticated
	using (public.qorpera_can_read_profile(profile_id));

revoke all on public.qorpera_company_workspaces from anon, authenticated;
revoke all on public.qorpera_company_snapshots from anon, authenticated;
grant select on public.qorpera_company_workspaces to authenticated;
grant select on public.qorpera_company_snapshots to authenticated;

create function public.qorpera_ensure_company_workspace(
	p_environment_id uuid,
	p_client_workspace_id uuid,
	p_name text,
	p_base_snapshot_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_profile_id uuid;
	v_workspace public.qorpera_company_workspaces%rowtype;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment
	where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'profile write access is required' using errcode = '42501';
	end if;
	if p_client_workspace_id is null or char_length(btrim(p_name)) not between 1 and 160 then
		raise exception 'workspace identity is invalid' using errcode = '22023';
	end if;
	if p_base_snapshot_id is not null and not exists (
		select 1 from public.qorpera_company_snapshots as snapshot
		where snapshot.id = p_base_snapshot_id
			and snapshot.profile_id = v_profile_id
			and snapshot.environment_id = p_environment_id
	) then
		raise exception 'workspace base snapshot is outside the environment' using errcode = '22023';
	end if;

	insert into public.qorpera_company_workspaces (
		profile_id, environment_id, client_workspace_id, name, head_snapshot_id, created_by_user_id
	)
	values (
		v_profile_id, p_environment_id, p_client_workspace_id, btrim(p_name), p_base_snapshot_id, v_user_id
	)
	on conflict (profile_id, client_workspace_id) do nothing;

	select workspace.* into v_workspace
	from public.qorpera_company_workspaces as workspace
	where workspace.profile_id = v_profile_id and workspace.client_workspace_id = p_client_workspace_id;
	if v_workspace.environment_id <> p_environment_id or v_workspace.name <> btrim(p_name) then
		raise exception 'workspace id is already bound to different content' using errcode = '23505';
	end if;

	return jsonb_build_object(
		'workspace_id', v_workspace.id,
		'profile_id', v_workspace.profile_id,
		'environment_id', v_workspace.environment_id,
		'client_workspace_id', v_workspace.client_workspace_id,
		'name', v_workspace.name,
		'head_snapshot_id', v_workspace.head_snapshot_id,
		'created_by_user_id', v_workspace.created_by_user_id,
		'created_at', v_workspace.created_at,
		'updated_at', v_workspace.updated_at
	);
end
$$;

create function public.qorpera_commit_company_snapshot(
	p_workspace_id uuid,
	p_client_snapshot_id uuid,
	p_expected_head_snapshot_id uuid,
	p_tree_manifest_sha256 text,
	p_tree_manifest_bytes integer,
	p_tree_contract_version integer,
	p_file_count integer,
	p_total_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_workspace public.qorpera_company_workspaces%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select workspace.* into v_workspace
	from public.qorpera_company_workspaces as workspace
	where workspace.id = p_workspace_id
	for update;
	if not found or not public.qorpera_can_write_profile(v_workspace.profile_id) then
		raise exception 'profile write access is required' using errcode = '42501';
	end if;
	if p_client_snapshot_id is null
		or p_tree_manifest_sha256 !~ '^[0-9a-f]{64}$'
		or p_tree_manifest_bytes not between 1 and 8388608
		or p_tree_contract_version is null or p_tree_contract_version < 1
		or p_file_count not between 0 and 50000
		or p_total_bytes not between 0 and 1099511627776 then
		raise exception 'company snapshot is invalid' using errcode = '22023';
	end if;

	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	where snapshot.profile_id = v_workspace.profile_id
		and snapshot.client_snapshot_id = p_client_snapshot_id;
	if found then
		if v_snapshot.workspace_id <> p_workspace_id
			or v_snapshot.parent_snapshot_id is distinct from p_expected_head_snapshot_id
			or v_snapshot.tree_manifest_sha256 <> p_tree_manifest_sha256
			or v_snapshot.tree_manifest_bytes <> p_tree_manifest_bytes
			or v_snapshot.tree_contract_version <> p_tree_contract_version
			or v_snapshot.file_count <> p_file_count
			or v_snapshot.total_bytes <> p_total_bytes then
			raise exception 'snapshot id is already bound to different content' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'snapshot_id', v_snapshot.id,
			'profile_id', v_snapshot.profile_id,
			'environment_id', v_snapshot.environment_id,
			'workspace_id', v_snapshot.workspace_id,
			'client_snapshot_id', v_snapshot.client_snapshot_id,
			'parent_snapshot_id', v_snapshot.parent_snapshot_id,
			'tree_manifest_sha256', v_snapshot.tree_manifest_sha256,
			'tree_manifest_bytes', v_snapshot.tree_manifest_bytes,
			'tree_contract_version', v_snapshot.tree_contract_version,
			'file_count', v_snapshot.file_count,
			'total_bytes', v_snapshot.total_bytes,
			'created_by_user_id', v_snapshot.created_by_user_id,
			'created_at', v_snapshot.created_at
		);
	end if;
	if v_workspace.head_snapshot_id is distinct from p_expected_head_snapshot_id then
		raise exception 'company workspace head changed' using errcode = '40001';
	end if;

	insert into public.qorpera_company_snapshots (
		profile_id, environment_id, workspace_id, client_snapshot_id, parent_snapshot_id,
		tree_manifest_sha256, tree_manifest_bytes, tree_contract_version, file_count,
		total_bytes, created_by_user_id
	)
	values (
		v_workspace.profile_id, v_workspace.environment_id, v_workspace.id, p_client_snapshot_id,
		p_expected_head_snapshot_id, p_tree_manifest_sha256, p_tree_manifest_bytes,
		p_tree_contract_version, p_file_count, p_total_bytes, v_user_id
	)
	returning * into v_snapshot;

	update public.qorpera_company_workspaces
	set head_snapshot_id = v_snapshot.id, updated_at = v_snapshot.created_at
	where id = v_workspace.id;

	return jsonb_build_object(
		'snapshot_id', v_snapshot.id,
		'profile_id', v_snapshot.profile_id,
		'environment_id', v_snapshot.environment_id,
		'workspace_id', v_snapshot.workspace_id,
		'client_snapshot_id', v_snapshot.client_snapshot_id,
		'parent_snapshot_id', v_snapshot.parent_snapshot_id,
		'tree_manifest_sha256', v_snapshot.tree_manifest_sha256,
		'tree_manifest_bytes', v_snapshot.tree_manifest_bytes,
		'tree_contract_version', v_snapshot.tree_contract_version,
		'file_count', v_snapshot.file_count,
		'total_bytes', v_snapshot.total_bytes,
		'created_by_user_id', v_snapshot.created_by_user_id,
		'created_at', v_snapshot.created_at
	);
end
$$;

create function public.qorpera_list_company_workspaces(p_environment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
begin
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment
	where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'workspace_id', workspace.id,
			'profile_id', workspace.profile_id,
			'environment_id', workspace.environment_id,
			'client_workspace_id', workspace.client_workspace_id,
			'name', workspace.name,
			'head_snapshot_id', workspace.head_snapshot_id,
			'created_by_user_id', workspace.created_by_user_id,
			'created_at', workspace.created_at,
			'updated_at', workspace.updated_at
		) order by workspace.created_at, workspace.id)
		from public.qorpera_company_workspaces as workspace
		where workspace.environment_id = p_environment_id
	), '[]'::jsonb);
end
$$;

create function public.qorpera_list_company_snapshots(p_workspace_id uuid, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
begin
	select workspace.profile_id into v_profile_id
	from public.qorpera_company_workspaces as workspace
	where workspace.id = p_workspace_id;
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;
	if p_limit not between 1 and 500 then
		raise exception 'snapshot page size is invalid' using errcode = '22023';
	end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'snapshot_id', snapshot.id,
			'profile_id', snapshot.profile_id,
			'environment_id', snapshot.environment_id,
			'workspace_id', snapshot.workspace_id,
			'client_snapshot_id', snapshot.client_snapshot_id,
			'parent_snapshot_id', snapshot.parent_snapshot_id,
			'tree_manifest_sha256', snapshot.tree_manifest_sha256,
			'tree_manifest_bytes', snapshot.tree_manifest_bytes,
			'tree_contract_version', snapshot.tree_contract_version,
			'file_count', snapshot.file_count,
			'total_bytes', snapshot.total_bytes,
			'created_by_user_id', snapshot.created_by_user_id,
			'created_at', snapshot.created_at
		) order by snapshot.created_at desc, snapshot.id desc)
		from (
			select source.*
			from public.qorpera_company_snapshots as source
			where source.workspace_id = p_workspace_id
			order by source.created_at desc, source.id desc
			limit p_limit
		) as snapshot
	), '[]'::jsonb);
end
$$;

revoke all on function public.qorpera_ensure_company_workspace(uuid, uuid, text, uuid) from public;
revoke all on function public.qorpera_commit_company_snapshot(uuid, uuid, uuid, text, integer, integer, integer, bigint) from public;
revoke all on function public.qorpera_list_company_workspaces(uuid) from public;
revoke all on function public.qorpera_list_company_snapshots(uuid, integer) from public;
grant execute on function public.qorpera_ensure_company_workspace(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.qorpera_commit_company_snapshot(uuid, uuid, uuid, text, integer, integer, integer, bigint) to authenticated;
grant execute on function public.qorpera_list_company_workspaces(uuid) to authenticated;
grant execute on function public.qorpera_list_company_snapshots(uuid, integer) to authenticated;

do $$
begin
	if not exists (
		select 1 from pg_catalog.pg_publication_tables
		where pubname = 'supabase_realtime'
			and schemaname = 'public'
			and tablename = 'qorpera_company_workspaces'
	) then
		alter publication supabase_realtime add table public.qorpera_company_workspaces;
	end if;
end
$$;
