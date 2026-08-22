-- One cloud-authoritative Company File per environment.
--
-- The earlier snapshot DAG gave every desktop its own mutable workspace head.
-- Those heads are retained as immutable migration history, but new clients
-- read and advance only the environment's canonical Company File head.

create table public.qorpera_company_files (
	environment_id uuid primary key references public.qorpera_company_environments(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	canonical_workspace_id uuid not null unique references public.qorpera_company_workspaces(id) on delete cascade,
	head_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete set null,
	state text not null default 'provisioning' check (state in ('provisioning', 'ready')),
	logical_bytes bigint not null default 0 check (logical_bytes >= 0),
	storage_used_bytes bigint not null default 0 check (storage_used_bytes >= 0),
	storage_limit_bytes bigint not null default 53687091200 check (storage_limit_bytes > 0),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	check ((state = 'ready') = (head_snapshot_id is not null))
);

create unique index qorpera_company_files_profile_environment
	on public.qorpera_company_files (profile_id, environment_id);

alter table public.qorpera_company_files enable row level security;
revoke all on public.qorpera_company_files from anon, authenticated;
grant select on public.qorpera_company_files to authenticated;

create policy qorpera_company_files_member_read
	on public.qorpera_company_files for select
	to authenticated
	using (public.qorpera_can_read_profile(profile_id));

create function public.qorpera_provision_company_file()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_workspace public.qorpera_company_workspaces%rowtype;
begin
	insert into public.qorpera_company_workspaces (
		profile_id, environment_id, client_workspace_id, name, created_by_user_id
	) values (
		new.profile_id, new.id, extensions.gen_random_uuid(), 'Company File', new.created_by_user_id
	) returning * into v_workspace;

	insert into public.qorpera_company_files (
		environment_id, profile_id, canonical_workspace_id, storage_used_bytes, created_by_user_id
	) values (
		new.id, new.profile_id, v_workspace.id,
		coalesce((
			select sum(object.bytes)
			from public.qorpera_profile_objects as object
			where object.profile_id = new.profile_id
		), 0),
		new.created_by_user_id
	);
	return new;
end
$$;

revoke all on function public.qorpera_provision_company_file() from public, anon, authenticated;

create trigger qorpera_provision_company_file
after insert on public.qorpera_company_environments
for each row execute function public.qorpera_provision_company_file();

-- Adopt existing environments. The most recently advanced historical head is
-- the deterministic migration winner; every old workspace remains readable
-- history, but no longer acts as an independently publishable company.
do $$
declare
	v_environment public.qorpera_company_environments%rowtype;
	v_workspace public.qorpera_company_workspaces%rowtype;
	v_head public.qorpera_company_snapshots%rowtype;
	v_storage_bytes bigint;
begin
	for v_environment in
		select environment.* from public.qorpera_company_environments as environment
		order by environment.created_at, environment.id
	loop
		select snapshot.* into v_head
		from public.qorpera_company_workspaces as workspace
		join public.qorpera_company_snapshots as snapshot on snapshot.id = workspace.head_snapshot_id
		where workspace.environment_id = v_environment.id
		order by workspace.updated_at desc, snapshot.created_at desc, workspace.id
		limit 1;

		insert into public.qorpera_company_workspaces (
			profile_id, environment_id, client_workspace_id, name, head_snapshot_id, created_by_user_id
		) values (
			v_environment.profile_id,
			v_environment.id,
			extensions.gen_random_uuid(),
			'Company File',
			case when found then v_head.id else null end,
			v_environment.created_by_user_id
		) returning * into v_workspace;

		select coalesce(sum(object.bytes), 0) into v_storage_bytes
		from public.qorpera_profile_objects as object
		where object.profile_id = v_environment.profile_id;

		insert into public.qorpera_company_files (
			environment_id, profile_id, canonical_workspace_id, head_snapshot_id,
			state, logical_bytes, storage_used_bytes, created_by_user_id
		) values (
			v_environment.id,
			v_environment.profile_id,
			v_workspace.id,
			case when v_head.id is not null then v_head.id else null end,
			case when v_head.id is not null then 'ready' else 'provisioning' end,
			coalesce(v_head.total_bytes, 0),
			v_storage_bytes,
			v_environment.created_by_user_id
		);
	end loop;
end
$$;

create table public.qorpera_company_creation_requests (
	created_by_user_id uuid not null references auth.users(id) on delete cascade,
	client_creation_id uuid not null,
	profile_name text not null check (char_length(btrim(profile_name)) between 1 and 120),
	contract_version integer not null check (contract_version > 0),
	profile_id uuid references public.qorpera_profiles(id) on delete cascade,
	created_at timestamptz not null default statement_timestamp(),
	primary key (created_by_user_id, client_creation_id)
);

alter table public.qorpera_company_creation_requests enable row level security;
revoke all on public.qorpera_company_creation_requests from anon, authenticated;

create function public.qorpera_company_file_json(p_file public.qorpera_company_files)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'profile_id', p_file.profile_id,
		'environment_id', p_file.environment_id,
		'canonical_workspace_id', p_file.canonical_workspace_id,
		'head_snapshot_id', p_file.head_snapshot_id,
		'state', p_file.state,
		'logical_bytes', p_file.logical_bytes,
		'storage_used_bytes', p_file.storage_used_bytes,
		'storage_limit_bytes', p_file.storage_limit_bytes,
		'created_at', p_file.created_at,
		'updated_at', p_file.updated_at
	)
$$;

revoke all on function public.qorpera_company_file_json(public.qorpera_company_files) from public, anon, authenticated;

create function public.qorpera_create_cloud_company(
	p_client_creation_id uuid,
	p_company_name text,
	p_contract_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_name text := btrim(p_company_name);
	v_request public.qorpera_company_creation_requests%rowtype;
	v_profile jsonb;
	v_file public.qorpera_company_files%rowtype;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if p_client_creation_id is null
		or char_length(v_name) not between 1 and 120
		or p_contract_version is distinct from 2 then
		raise exception 'company creation is invalid' using errcode = '22023';
	end if;

	insert into public.qorpera_company_creation_requests (
		created_by_user_id, client_creation_id, profile_name, contract_version
	) values (
		v_user_id, p_client_creation_id, v_name, p_contract_version
	) on conflict (created_by_user_id, client_creation_id) do nothing
	returning * into v_request;

	if not found then
		select request.* into v_request
		from public.qorpera_company_creation_requests as request
		where request.created_by_user_id = v_user_id
			and request.client_creation_id = p_client_creation_id
		for update;
		if v_request.profile_name <> v_name or v_request.contract_version <> p_contract_version then
			raise exception 'company creation id is already bound to another request' using errcode = '23505';
		end if;
	end if;

	if v_request.profile_id is null then
		v_profile := public.qorpera_create_hosted_profile(v_name, v_name, p_contract_version);
		update public.qorpera_company_creation_requests
		set profile_id = (v_profile ->> 'profile_id')::uuid
		where created_by_user_id = v_user_id and client_creation_id = p_client_creation_id
		returning * into v_request;
	else
		select jsonb_build_object(
			'profile_id', profile.id,
			'environment_id', environment.id,
			'profile_name', profile.name,
			'environment_name', environment.name,
			'role', member.role,
			'contract_version', environment.contract_version,
			'created_at', profile.created_at
		) into v_profile
		from public.qorpera_profiles as profile
		join public.qorpera_profile_members as member on member.profile_id = profile.id
		join public.qorpera_company_environments as environment on environment.profile_id = profile.id
		where profile.id = v_request.profile_id and member.user_id = v_user_id;
	end if;

	select file.* into strict v_file
	from public.qorpera_company_files as file
	where file.profile_id = (v_profile ->> 'profile_id')::uuid
		and file.environment_id = (v_profile ->> 'environment_id')::uuid;

	return v_profile || jsonb_build_object('company_file', public.qorpera_company_file_json(v_file));
end
$$;

create function public.qorpera_get_company_file(p_environment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_file public.qorpera_company_files%rowtype;
begin
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id;
	if not found or not public.qorpera_can_read_profile(v_file.profile_id) then
		raise exception 'company file read access is required' using errcode = '42501';
	end if;
	return public.qorpera_company_file_json(v_file);
end
$$;

create table public.qorpera_company_snapshot_publications (
	snapshot_id uuid primary key references public.qorpera_company_snapshots(id) on delete cascade,
	expected_head_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete restrict,
	restricted_content_sha256 text check (restricted_content_sha256 ~ '^[0-9a-f]{64}$'),
	status text not null default 'prepared' check (status in ('prepared', 'published')),
	prepared_at timestamptz not null default statement_timestamp(),
	published_at timestamptz,
	check ((status = 'published') = (published_at is not null))
);

alter table public.qorpera_company_snapshot_publications enable row level security;
revoke all on public.qorpera_company_snapshot_publications from anon, authenticated;

create table public.qorpera_company_proposals (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	client_proposal_id uuid not null,
	base_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete restrict,
	proposal_snapshot_id uuid not null unique references public.qorpera_company_snapshots(id) on delete restrict,
	execution_kind text not null check (execution_kind in ('turn', 'wake', 'run')),
	execution_id uuid not null,
	execution_claimant_id uuid not null,
	session_id uuid references public.qorpera_shared_sessions(id) on delete set null,
	trail_end_sequence bigint not null check (trail_end_sequence >= 0),
	reason text not null check (reason in ('policy', 'authority', 'conflict', 'recovery')),
	policy_key text check (policy_key is null or char_length(policy_key) between 1 and 128),
	title text not null check (char_length(btrim(title)) between 1 and 256),
	reviewer_staff_ids uuid[] not null default '{}'::uuid[] check (cardinality(reviewer_staff_ids) <= 20),
	status text not null default 'open' check (status in ('open', 'accepted', 'rejected')),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	resolved_by_user_id uuid references auth.users(id) on delete restrict,
	resolved_at timestamptz,
	unique (profile_id, client_proposal_id),
	unique (execution_kind, execution_id),
	check ((status = 'open') = (resolved_at is null)),
	check ((resolved_at is null) = (resolved_by_user_id is null))
);

create index qorpera_company_proposals_open
	on public.qorpera_company_proposals (profile_id, created_at, id)
	where status = 'open';

alter table public.qorpera_company_proposals enable row level security;
revoke all on public.qorpera_company_proposals from anon, authenticated;

create table public.qorpera_company_proposal_comments (
	id uuid primary key default extensions.gen_random_uuid(),
	proposal_id uuid not null references public.qorpera_company_proposals(id) on delete cascade,
	client_comment_id uuid not null,
	body text not null check (char_length(btrim(body)) between 1 and 16384),
	author_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	unique (proposal_id, client_comment_id)
);

create index qorpera_company_proposal_comments_page
	on public.qorpera_company_proposal_comments (proposal_id, created_at, id);

alter table public.qorpera_company_proposal_comments enable row level security;
revoke all on public.qorpera_company_proposal_comments from anon, authenticated;

create table public.qorpera_company_proposal_revisions (
	proposal_id uuid not null references public.qorpera_company_proposals(id) on delete cascade,
	revision bigint not null check (revision > 0),
	base_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete restrict,
	proposal_snapshot_id uuid not null references public.qorpera_company_snapshots(id) on delete restrict,
	change_kind text not null check (change_kind in ('submitted', 'rebased')),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	primary key (proposal_id, revision),
	unique (proposal_id, proposal_snapshot_id)
);

alter table public.qorpera_company_proposal_revisions enable row level security;
revoke all on public.qorpera_company_proposal_revisions from anon, authenticated;

create function public.qorpera_record_company_proposal_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	insert into public.qorpera_company_proposal_revisions (
		proposal_id, revision, base_snapshot_id, proposal_snapshot_id,
		change_kind, created_by_user_id
	) values (
		new.id, 1, new.base_snapshot_id, new.proposal_snapshot_id,
		'submitted', new.created_by_user_id
	);
	return new;
end
$$;

create trigger qorpera_record_company_proposal_submission
after insert on public.qorpera_company_proposals
for each row execute function public.qorpera_record_company_proposal_submission();

revoke all on function public.qorpera_record_company_proposal_submission() from public;

create function public.qorpera_company_snapshot_json(p_snapshot public.qorpera_company_snapshots)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'snapshot_id', p_snapshot.id,
		'profile_id', p_snapshot.profile_id,
		'environment_id', p_snapshot.environment_id,
		'workspace_id', p_snapshot.workspace_id,
		'client_snapshot_id', p_snapshot.client_snapshot_id,
		'parent_snapshot_id', p_snapshot.parent_snapshot_id,
		'tree_manifest_sha256', p_snapshot.tree_manifest_sha256,
		'tree_manifest_bytes', p_snapshot.tree_manifest_bytes,
		'tree_contract_version', p_snapshot.tree_contract_version,
		'file_count', p_snapshot.file_count,
		'total_bytes', p_snapshot.total_bytes,
		'created_by_user_id', p_snapshot.created_by_user_id,
		'created_at', p_snapshot.created_at,
		'publication_state', coalesce((
			select publication.status
			from public.qorpera_company_snapshot_publications as publication
			where publication.snapshot_id = p_snapshot.id
		), 'published')
	)
$$;

revoke all on function public.qorpera_company_snapshot_json(public.qorpera_company_snapshots) from public, anon, authenticated;

-- Preparing records the immutable revision only after the exact manifest
-- object is present. It deliberately does not advance the Company File head;
-- the client must publish and restore the complete reachability graph first.
create function public.qorpera_prepare_company_file_revision(
	p_environment_id uuid,
	p_client_revision_id uuid,
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
	v_file public.qorpera_company_files%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_manifest_bytes bigint;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for update;
	if not found or not public.qorpera_can_write_profile(v_file.profile_id) then
		raise exception 'company file write access is required' using errcode = '42501';
	end if;
	if p_client_revision_id is null
		or p_tree_manifest_sha256 !~ '^[0-9a-f]{64}$'
		or p_tree_manifest_bytes not between 1 and 8388608
		or p_tree_contract_version is distinct from 3
		or p_file_count not between 0 and 50000
		or p_total_bytes < 0 then
		raise exception 'company file revision is invalid' using errcode = '22023';
	end if;
	select object.bytes into v_manifest_bytes
	from public.qorpera_profile_objects as object
	where object.profile_id = v_file.profile_id and object.sha256 = p_tree_manifest_sha256;
	if v_manifest_bytes is distinct from p_tree_manifest_bytes::bigint then
		raise exception 'company file manifest is unavailable or has the wrong size' using errcode = '22023';
	end if;
	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	where snapshot.profile_id = v_file.profile_id
		and snapshot.client_snapshot_id = p_client_revision_id;
	if found then
		if v_snapshot.workspace_id <> v_file.canonical_workspace_id
			or v_snapshot.parent_snapshot_id is distinct from p_expected_head_snapshot_id
			or v_snapshot.tree_manifest_sha256 <> p_tree_manifest_sha256
			or v_snapshot.tree_manifest_bytes <> p_tree_manifest_bytes
			or v_snapshot.tree_contract_version <> p_tree_contract_version
			or v_snapshot.file_count <> p_file_count
			or v_snapshot.total_bytes <> p_total_bytes then
			raise exception 'company file revision id is already bound to different content' using errcode = '23505';
		end if;
		if not exists (
			select 1 from public.qorpera_company_snapshot_publications as publication
			where publication.snapshot_id = v_snapshot.id
		) then
			raise exception 'company file revision id belongs to migration history' using errcode = '23505';
		end if;
		return public.qorpera_company_snapshot_json(v_snapshot);
	end if;
	if v_file.head_snapshot_id is distinct from p_expected_head_snapshot_id then
		raise sqlstate 'PT409' using message = 'company file head changed';
	end if;

	insert into public.qorpera_company_snapshots (
		profile_id, environment_id, workspace_id, client_snapshot_id, parent_snapshot_id,
		tree_manifest_sha256, tree_manifest_bytes, tree_contract_version, file_count,
		total_bytes, created_by_user_id
	) values (
		v_file.profile_id, v_file.environment_id, v_file.canonical_workspace_id,
		p_client_revision_id, p_expected_head_snapshot_id, p_tree_manifest_sha256,
		p_tree_manifest_bytes, p_tree_contract_version, p_file_count, p_total_bytes, v_user_id
	) returning * into v_snapshot;

	insert into public.qorpera_company_snapshot_publications (
		snapshot_id, expected_head_snapshot_id
	) values (
		v_snapshot.id, p_expected_head_snapshot_id
	);

	return public.qorpera_company_snapshot_json(v_snapshot);
end
$$;

-- Review proposals use the same immutable snapshot/object contract as a
-- canonical revision, but may be based on an older pinned execution snapshot.
-- They cannot advance the head through the ordinary publish RPC.
create function public.qorpera_prepare_company_file_proposal(
	p_environment_id uuid,
	p_client_revision_id uuid,
	p_base_snapshot_id uuid,
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
	v_file public.qorpera_company_files%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_manifest_bytes bigint;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for share;
	if not found or not public.qorpera_can_write_profile(v_file.profile_id) then
		raise exception 'company file write access is required' using errcode = '42501';
	end if;
	if p_client_revision_id is null
		or p_tree_manifest_sha256 !~ '^[0-9a-f]{64}$'
		or p_tree_manifest_bytes not between 1 and 8388608
		or p_tree_contract_version is distinct from 3
		or p_file_count not between 0 and 50000
		or p_total_bytes < 0 then
		raise exception 'company file proposal is invalid' using errcode = '22023';
	end if;
	if p_base_snapshot_id is null or not exists (
		select 1
		from public.qorpera_company_snapshots as snapshot
		where snapshot.id = p_base_snapshot_id
			and snapshot.profile_id = v_file.profile_id
			and snapshot.environment_id = v_file.environment_id
	) then
		raise exception 'company file proposal base is invalid' using errcode = '22023';
	end if;
	select object.bytes into v_manifest_bytes
	from public.qorpera_profile_objects as object
	where object.profile_id = v_file.profile_id and object.sha256 = p_tree_manifest_sha256;
	if v_manifest_bytes is distinct from p_tree_manifest_bytes::bigint then
		raise exception 'company file manifest is unavailable or has the wrong size' using errcode = '22023';
	end if;
	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	where snapshot.profile_id = v_file.profile_id
		and snapshot.client_snapshot_id = p_client_revision_id;
	if found then
		if v_snapshot.workspace_id <> v_file.canonical_workspace_id
			or v_snapshot.parent_snapshot_id is distinct from p_base_snapshot_id
			or v_snapshot.tree_manifest_sha256 <> p_tree_manifest_sha256
			or v_snapshot.tree_manifest_bytes <> p_tree_manifest_bytes
			or v_snapshot.tree_contract_version <> p_tree_contract_version
			or v_snapshot.file_count <> p_file_count
			or v_snapshot.total_bytes <> p_total_bytes then
			raise exception 'company file proposal revision id is already bound to different content' using errcode = '23505';
		end if;
		if not exists (
			select 1 from public.qorpera_company_snapshot_publications as publication
			where publication.snapshot_id = v_snapshot.id
		) then
			raise exception 'company file proposal revision belongs to migration history' using errcode = '23505';
		end if;
		return public.qorpera_company_snapshot_json(v_snapshot);
	end if;

	insert into public.qorpera_company_snapshots (
		profile_id, environment_id, workspace_id, client_snapshot_id, parent_snapshot_id,
		tree_manifest_sha256, tree_manifest_bytes, tree_contract_version, file_count,
		total_bytes, created_by_user_id
	) values (
		v_file.profile_id, v_file.environment_id, v_file.canonical_workspace_id,
		p_client_revision_id, p_base_snapshot_id, p_tree_manifest_sha256,
		p_tree_manifest_bytes, p_tree_contract_version, p_file_count, p_total_bytes, v_user_id
	) returning * into v_snapshot;

	insert into public.qorpera_company_snapshot_publications (
		snapshot_id, expected_head_snapshot_id
	) values (
		v_snapshot.id, p_base_snapshot_id
	);

	return public.qorpera_company_snapshot_json(v_snapshot);
end
$$;

-- Finalization is the only operation that advances the canonical head. The
-- graph/proof checks are re-evaluated while the Company File row is locked so
-- object loss or a competing revision cannot create an unreadable head.
create function public.qorpera_publish_company_file_revision(
	p_environment_id uuid,
	p_snapshot_id uuid,
	p_expected_head_snapshot_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_file public.qorpera_company_files%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_publication public.qorpera_company_snapshot_publications%rowtype;
	v_head_restricted_content_sha256 text;
begin
	if auth.uid() is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for update;
	if not found or not public.qorpera_can_write_profile(v_file.profile_id) then
		raise exception 'company file write access is required' using errcode = '42501';
	end if;
	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	join public.qorpera_company_snapshot_publications as publication
		on publication.snapshot_id = snapshot.id
	where snapshot.id = p_snapshot_id
		and snapshot.profile_id = v_file.profile_id
		and snapshot.environment_id = v_file.environment_id
		and snapshot.workspace_id = v_file.canonical_workspace_id;
	if not found then
		raise exception 'prepared company file revision is invalid' using errcode = '22023';
	end if;
	select publication.* into strict v_publication
	from public.qorpera_company_snapshot_publications as publication
	where publication.snapshot_id = v_snapshot.id;
	if v_publication.expected_head_snapshot_id is distinct from p_expected_head_snapshot_id then
		raise exception 'prepared company file revision is invalid' using errcode = '22023';
	end if;
	if v_publication.status = 'published' then
		return public.qorpera_company_snapshot_json(v_snapshot);
	end if;
	if exists (
		select 1
		from public.qorpera_company_proposals as proposal
		where proposal.proposal_snapshot_id = v_snapshot.id and proposal.status = 'open'
	) then
		raise exception 'company file proposal requires an explicit review decision' using errcode = '55000';
	end if;
	if v_file.head_snapshot_id is distinct from p_expected_head_snapshot_id then
		raise sqlstate 'PT409' using message = 'company file head changed';
	end if;
	if not public.qorpera_object_root_has_current_proof('company_snapshot', v_snapshot.id) then
		raise exception 'company file reachability and restore proof are incomplete' using errcode = '55000';
	end if;
	if v_publication.restricted_content_sha256 is null then
		raise exception 'company file authority paths were not server-verified' using errcode = '55000';
	end if;
	select publication.restricted_content_sha256 into v_head_restricted_content_sha256
	from public.qorpera_company_snapshot_publications as publication
	where publication.snapshot_id = v_file.head_snapshot_id;
	if v_publication.restricted_content_sha256 is distinct from v_head_restricted_content_sha256
		and not public.qorpera_can_authorize_profile(v_file.profile_id) then
		raise exception 'company authority changes require authorize access' using errcode = '42501';
	end if;

	update public.qorpera_company_snapshot_publications
	set status = 'published', published_at = statement_timestamp()
	where snapshot_id = v_snapshot.id;
	update public.qorpera_company_workspaces
	set head_snapshot_id = v_snapshot.id, updated_at = statement_timestamp()
	where id = v_file.canonical_workspace_id;
	update public.qorpera_company_files
	set head_snapshot_id = v_snapshot.id,
		state = 'ready',
		logical_bytes = v_snapshot.total_bytes,
		updated_at = statement_timestamp()
	where environment_id = v_file.environment_id;

	return public.qorpera_company_snapshot_json(v_snapshot);
end
$$;

-- Company manifests cannot be marked closure-verified by the desktop that
-- authored them. A trusted Edge verifier restores every manifest and chunk,
-- then supplies the exact reachable-set digest through the service-only RPC
-- below. Extend the generic graph guard to permit only that service transition.
create or replace function public.qorpera_enforce_object_graph_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_root_creator uuid;
	v_direct_artifact_bytes bigint;
	v_entry_count integer;
	v_entry_bytes bigint;
begin
	v_root_creator := public.qorpera_object_root_creator(new.root_kind, new.root_id);
	if v_root_creator is null or new.created_by_user_id is distinct from v_root_creator then
		raise exception 'object reachability requires root-creator access' using errcode = '42501';
	end if;
	if auth.role() is distinct from 'service_role' and auth.uid() is distinct from v_root_creator then
		raise exception 'object reachability requires root-creator access' using errcode = '42501';
	end if;
	if tg_op = 'UPDATE' then
		if new.profile_id is distinct from old.profile_id
			or new.environment_id is distinct from old.environment_id
			or new.root_kind is distinct from old.root_kind
			or new.root_id is distinct from old.root_id
			or new.client_graph_id is distinct from old.client_graph_id
			or new.root_object_sha256 is distinct from old.root_object_sha256
			or new.contract_version is distinct from old.contract_version
			or new.content_sha256 is distinct from old.content_sha256
			or new.object_count is distinct from old.object_count
			or new.storage_bytes is distinct from old.storage_bytes
			or new.created_by_user_id is distinct from old.created_by_user_id then
			raise exception 'object reachability graph identity is immutable' using errcode = '22023';
		end if;
		if new.status = 'complete' and new.root_kind = 'artifact' then
			select artifact.bytes into v_direct_artifact_bytes
			from public.qorpera_artifacts as artifact
			where artifact.id = new.root_id and artifact.root_contract = 'qorpera.object/v1';
			if found and (old.status <> 'complete' or (new.closure_verified and not old.closure_verified)) then
				select count(*), coalesce(sum(entry.bytes), 0)
				into v_entry_count, v_entry_bytes
				from public.qorpera_object_reachability_entries as entry
				where entry.graph_id = new.id;
				if v_entry_count <> 1 or v_entry_bytes <> v_direct_artifact_bytes or not exists (
					select 1
					from public.qorpera_object_reachability_entries as entry
					where entry.graph_id = new.id
						and entry.object_sha256 = new.root_object_sha256
						and entry.bytes = v_direct_artifact_bytes
				) then
					raise exception 'direct artifact reachability must contain exactly its root object'
						using errcode = '22023';
				end if;
				new.closure_verified := true;
			end if;
		end if;
	end if;
	if new.closure_verified and new.root_kind = 'company_snapshot' then
		if new.status <> 'complete' or auth.role() is distinct from 'service_role' then
			raise exception 'company manifest closure requires server verification' using errcode = '42501';
		end if;
	elsif new.closure_verified and (
		new.status <> 'complete'
		or new.root_kind <> 'artifact'
		or not exists (
			select 1
			from public.qorpera_artifacts as artifact
			where artifact.id = new.root_id and artifact.root_contract = 'qorpera.object/v1'
		)
	) then
		raise exception 'manifest reachability closure is not server-verified' using errcode = '42501';
	end if;
	return new;
end
$$;

create function public.qorpera_verify_company_snapshot_closure(
	p_snapshot_id uuid,
	p_graph_id uuid,
	p_verified_user_id uuid,
	p_reachable_content_sha256 text,
	p_object_count integer,
	p_storage_bytes bigint,
	p_restored_content_sha256 text,
	p_restored_bytes bigint,
	p_restricted_content_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_graph public.qorpera_object_reachability_graphs%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'server verification is required' using errcode = '42501';
	end if;
	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	where snapshot.id = p_snapshot_id;
	select graph.* into v_graph
	from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id and graph.root_kind = 'company_snapshot'
		and graph.root_id = p_snapshot_id
	for update;
	if v_snapshot.id is null or v_graph.id is null
		or not exists (
			select 1 from public.qorpera_profile_members as member
			where member.profile_id = v_snapshot.profile_id
				and member.user_id = p_verified_user_id
				and member.role in ('owner', 'admin', 'contributor')
		)
		or v_graph.status <> 'complete'
		or v_graph.root_object_sha256 <> v_snapshot.tree_manifest_sha256
		or v_graph.content_sha256 <> p_reachable_content_sha256
		or v_graph.object_count <> p_object_count
		or v_graph.storage_bytes <> p_storage_bytes
		or p_restored_content_sha256 <> v_snapshot.tree_manifest_sha256
		or p_restored_bytes <> v_snapshot.total_bytes
		or p_restricted_content_sha256 !~ '^[0-9a-f]{64}$'
		or not public.qorpera_object_graph_objects_available(v_graph.id) then
		raise exception 'company snapshot server verification does not match its graph' using errcode = '22023';
	end if;
	update public.qorpera_company_snapshot_publications
	set restricted_content_sha256 = p_restricted_content_sha256
	where snapshot_id = v_snapshot.id
		and (restricted_content_sha256 is null or restricted_content_sha256 = p_restricted_content_sha256);
	if not found then
		raise exception 'company snapshot authority proof changed' using errcode = '22023';
	end if;

	update public.qorpera_object_reachability_graphs
	set closure_verified = true
	where id = v_graph.id and not closure_verified
	returning * into v_graph;
	if not found then
		select graph.* into strict v_graph
		from public.qorpera_object_reachability_graphs as graph
		where graph.id = p_graph_id;
	end if;
	return public.qorpera_object_reachability_graph_json(v_graph);
end
$$;

-- Storage is content addressed, so count each unique object once. This guard
-- runs before Supabase Storage records an object and serializes uploads per
-- profile against the Company File row. The catalog mirror then maintains the
-- visible usage counter after inserts, updates, and deletes.
create function public.qorpera_enforce_company_storage_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_identity record;
	v_limit bigint;
	v_used bigint;
	v_existing_bytes bigint;
begin
	select * into v_identity
	from public.qorpera_profile_object_identity(new.bucket_id, new.name, new.metadata);
	if v_identity.profile_id is null or v_identity.sha256 is null or v_identity.bytes is null then
		return new;
	end if;

	perform 1
	from public.qorpera_company_files as file
	where file.profile_id = v_identity.profile_id
	for update;
	select min(file.storage_limit_bytes), max(file.storage_used_bytes)
	into v_limit, v_used
	from public.qorpera_company_files as file
	where file.profile_id = v_identity.profile_id;
	if v_limit is null then
		-- The object catalog intentionally mirrors validly-shaped orphan objects.
		-- Quota authority begins only when a Company File owns the profile id.
		return new;
	end if;
	select object.bytes into v_existing_bytes
	from public.qorpera_profile_objects as object
	where object.profile_id = v_identity.profile_id and object.sha256 = v_identity.sha256;
	if v_used + v_identity.bytes - coalesce(v_existing_bytes, 0) > v_limit then
		raise exception 'company storage allowance exceeded' using errcode = '23514';
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_enforce_company_storage_quota() from public, anon, authenticated;

create trigger qorpera_enforce_company_storage_quota
before insert or update on storage.objects
for each row execute function public.qorpera_enforce_company_storage_quota();

create function public.qorpera_refresh_company_storage_usage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid := case when tg_op = 'DELETE' then old.profile_id else new.profile_id end;
	v_delta bigint;
begin
	if tg_op = 'UPDATE' and old.profile_id <> new.profile_id then
		update public.qorpera_company_files
		set storage_used_bytes = storage_used_bytes - old.bytes,
			updated_at = statement_timestamp()
		where profile_id = old.profile_id;
		update public.qorpera_company_files
		set storage_used_bytes = storage_used_bytes + new.bytes,
			updated_at = statement_timestamp()
		where profile_id = new.profile_id;
		return new;
	end if;
	v_delta := case tg_op
		when 'INSERT' then new.bytes
		when 'DELETE' then -old.bytes
		else new.bytes - old.bytes
	end;
	if v_delta <> 0 then
		update public.qorpera_company_files
		set storage_used_bytes = storage_used_bytes + v_delta,
			updated_at = statement_timestamp()
		where profile_id = v_profile_id;
	end if;
	return case when tg_op = 'DELETE' then old else new end;
end
$$;

revoke all on function public.qorpera_refresh_company_storage_usage() from public, anon, authenticated;

create trigger qorpera_refresh_company_storage_usage
after insert or update or delete on public.qorpera_profile_objects
for each row execute function public.qorpera_refresh_company_storage_usage();

-- Sessions pin both the Company File revision and the hosted agent
-- configuration they started with. A child inherits its parent's file base;
-- a top-level session pins the canonical head at insertion time.
alter table public.qorpera_shared_sessions
	add column company_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete set null,
	add column staff_version bigint check (staff_version is null or staff_version > 0),
	add column execution_scope jsonb not null default '{}'::jsonb
		check (jsonb_typeof(execution_scope) = 'object' and pg_column_size(execution_scope) <= 8192);

-- Operational trails are open only while their events are uploaded. They must
-- not collide with the one long-lived attended queue session per staff member.
drop index public.qorpera_shared_sessions_one_open_per_staff;
create unique index qorpera_shared_sessions_one_open_per_staff
	on public.qorpera_shared_sessions (profile_id, staff_agent_id)
	where status = 'open'
		and staff_agent_id is not null
		and not (execution_scope ?| array['autonomousLabel', 'roomId', 'group', 'parentSession']);

update public.qorpera_shared_sessions as session
set company_snapshot_id = file.head_snapshot_id
from public.qorpera_company_files as file
where file.environment_id = session.environment_id
	and session.company_snapshot_id is null;

update public.qorpera_shared_sessions as session
set staff_version = staff.version
from public.qorpera_profile_staff as staff
where staff.profile_id = session.profile_id
	and session.staff_agent_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
	and staff.staff_agent_id = session.staff_agent_id::uuid
	and session.staff_version is null;

create function public.qorpera_pin_session_revisions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if new.company_snapshot_id is null and new.parent_session_id is not null then
		select parent.company_snapshot_id into new.company_snapshot_id
		from public.qorpera_shared_sessions as parent
		where parent.id = new.parent_session_id;
	end if;
	if new.company_snapshot_id is null then
		select file.head_snapshot_id into new.company_snapshot_id
		from public.qorpera_company_files as file
		where file.environment_id = new.environment_id;
	end if;
	if new.staff_version is null
		and new.staff_agent_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
		select staff.version into new.staff_version
		from public.qorpera_profile_staff as staff
		where staff.profile_id = new.profile_id and staff.staff_agent_id = new.staff_agent_id::uuid;
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_pin_session_revisions() from public, anon, authenticated;

create trigger qorpera_pin_session_revisions
before insert on public.qorpera_shared_sessions
for each row execute function public.qorpera_pin_session_revisions();

create function public.qorpera_shared_session_json(p_session public.qorpera_shared_sessions)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'session_id', p_session.id,
		'client_session_id', p_session.client_session_id,
		'profile_id', p_session.profile_id,
		'environment_id', p_session.environment_id,
		'title', p_session.title,
		'staff_agent_id', p_session.staff_agent_id,
		'parent_session_id', p_session.parent_session_id,
		'execution_scope', p_session.execution_scope,
		'company_snapshot_id', p_session.company_snapshot_id,
		'staff_version', p_session.staff_version,
		'status', p_session.status,
		'created_by_user_id', p_session.created_by_user_id,
		'created_at', p_session.created_at,
		'updated_at', p_session.updated_at
	)
$$;

revoke all on function public.qorpera_shared_session_json(public.qorpera_shared_sessions)
	from public, anon, authenticated;

create function public.qorpera_list_shared_sessions_page(
	p_environment_id uuid,
	p_after_updated_at timestamptz default null,
	p_after_id uuid default null,
	p_limit integer default 100
)
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
		raise exception 'shared session read access is required' using errcode = '42501';
	end if;
	if p_limit not between 1 and 100
		or ((p_after_updated_at is null) is distinct from (p_after_id is null)) then
		raise exception 'shared session page is invalid' using errcode = '22023';
	end if;
	return (
		with visible as (
			select session.*
			from public.qorpera_shared_sessions as session
			where session.environment_id = p_environment_id
				and (
					p_after_updated_at is null
					or (session.updated_at, session.id) > (p_after_updated_at, p_after_id)
				)
			order by session.updated_at, session.id
			limit p_limit + 1
		), page as (
			select * from visible order by updated_at, id limit p_limit
		)
		select jsonb_build_object(
			'items', coalesce((select jsonb_agg(public.qorpera_shared_session_json(session)
				order by session.updated_at, session.id) from page as session), '[]'::jsonb),
			'has_more', (select count(*) > p_limit from visible),
			'next_updated_at', (select max(updated_at) from page),
			'next_id', (select id from page order by updated_at desc, id desc limit 1)
		)
	);
end
$$;

create function public.qorpera_get_shared_session_by_client(
	p_environment_id uuid,
	p_client_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_session public.qorpera_shared_sessions%rowtype;
begin
	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.environment_id = p_environment_id
		and session.client_session_id = p_client_session_id;
	if not found or not public.qorpera_can_read_profile(v_session.profile_id) then
		return null;
	end if;
	return public.qorpera_shared_session_json(v_session);
end
$$;

-- Bound the legacy aggregate for older clients. New clients use the keyset
-- page above, so routine sync never constructs company-lifetime JSON.
create or replace function public.qorpera_list_shared_sessions(p_environment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce(public.qorpera_list_shared_sessions_page(p_environment_id, null, null, 100) -> 'items', '[]'::jsonb)
$$;

create function public.qorpera_create_shared_session_v3(
	p_environment_id uuid,
	p_client_session_id uuid,
	p_title text,
	p_staff_agent_id text,
	p_parent_session_id uuid,
	p_execution_scope jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_profile_id uuid;
	v_session public.qorpera_shared_sessions%rowtype;
begin
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment
	where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'profile write access is required' using errcode = '42501';
	end if;
	if p_client_session_id is null then
		raise exception 'client session id is required' using errcode = '22023';
	end if;
	if char_length(btrim(p_title)) not between 1 and 256 then
		raise exception 'session title is invalid' using errcode = '22023';
	end if;
	if p_staff_agent_id is not null and char_length(p_staff_agent_id) not between 1 and 128 then
		raise exception 'staff agent id is invalid' using errcode = '22023';
	end if;
	if p_execution_scope is null or jsonb_typeof(p_execution_scope) <> 'object'
		or pg_column_size(p_execution_scope) > 8192 then
		raise exception 'session execution scope is invalid' using errcode = '22023';
	end if;
	if exists (
		select 1 from jsonb_object_keys(p_execution_scope) as key
		where key not in (
			'attended', 'staffAgentId', 'roomId', 'autonomousLabel', 'group', 'parentSession',
			'companySnapshotId', 'staffVersion'
		)
	) or (p_execution_scope ? 'attended' and jsonb_typeof(p_execution_scope -> 'attended') <> 'boolean')
		or (p_execution_scope ? 'staffAgentId' and (
			jsonb_typeof(p_execution_scope -> 'staffAgentId') <> 'string'
			or p_execution_scope ->> 'staffAgentId' is distinct from p_staff_agent_id
		))
		or exists (
			select 1
			from jsonb_each(p_execution_scope) as item
			where item.key in ('roomId', 'autonomousLabel', 'group', 'parentSession')
				and (jsonb_typeof(item.value) <> 'string' or char_length(item.value #>> '{}') not between 1 and 512)
		)
		or ((p_execution_scope ? 'companySnapshotId') is distinct from (p_execution_scope ? 'staffVersion'))
		or (p_execution_scope ? 'companySnapshotId' and (
			jsonb_typeof(p_execution_scope -> 'companySnapshotId') <> 'string'
			or (p_execution_scope ->> 'companySnapshotId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			or jsonb_typeof(p_execution_scope -> 'staffVersion') <> 'number'
			or (p_execution_scope ->> 'staffVersion') !~ '^[1-9][0-9]*$'
		)) then
		raise exception 'session execution scope is invalid' using errcode = '22023';
	end if;
	if p_parent_session_id is not null and not exists (
		select 1 from public.qorpera_shared_sessions as parent
		where parent.id = p_parent_session_id and parent.environment_id = p_environment_id
	) then
		raise exception 'parent session is outside the environment' using errcode = '22023';
	end if;

	insert into public.qorpera_shared_sessions (
		profile_id, environment_id, client_session_id, title, staff_agent_id,
		parent_session_id, execution_scope, status, created_by_user_id
	) values (
		v_profile_id, p_environment_id, p_client_session_id, btrim(p_title),
		nullif(btrim(p_staff_agent_id), ''), p_parent_session_id, p_execution_scope,
		'open'::public.qorpera_session_status,
		v_user_id
	)
	on conflict (profile_id, client_session_id) do nothing
	returning * into v_session;

	if not found then
		select session.* into strict v_session
		from public.qorpera_shared_sessions as session
		where session.profile_id = v_profile_id and session.client_session_id = p_client_session_id;
		if v_session.environment_id <> p_environment_id
			or v_session.title <> btrim(p_title)
			or v_session.staff_agent_id is distinct from nullif(btrim(p_staff_agent_id), '')
			or v_session.parent_session_id is distinct from p_parent_session_id
			or v_session.execution_scope <> p_execution_scope then
			raise exception 'client session id is already bound to different content' using errcode = '23505';
		end if;
	end if;

	return jsonb_build_object(
		'session_id', v_session.id,
		'client_session_id', v_session.client_session_id,
		'profile_id', v_session.profile_id,
		'environment_id', v_session.environment_id,
		'title', v_session.title,
		'staff_agent_id', v_session.staff_agent_id,
		'parent_session_id', v_session.parent_session_id,
		'execution_scope', v_session.execution_scope,
		'company_snapshot_id', v_session.company_snapshot_id,
		'staff_version', v_session.staff_version,
		'status', v_session.status,
		'created_by_user_id', v_session.created_by_user_id,
		'created_at', v_session.created_at,
		'updated_at', v_session.updated_at
	);
end
$$;

create function public.qorpera_close_shared_session(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_session public.qorpera_shared_sessions%rowtype;
begin
	perform public.qorpera_session_profile_for_write(p_session_id);
	select session.* into strict v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
	if not (v_session.execution_scope ?| array['autonomousLabel', 'roomId', 'group', 'parentSession']) then
		raise exception 'only operational trail sessions can be finalized' using errcode = '22023';
	end if;
	if v_session.created_by_user_id <> auth.uid() then
		raise exception 'operational trail session belongs to another executor' using errcode = '42501';
	end if;
	if exists (
		select 1
		from public.qorpera_session_events as event
		where event.session_id = v_session.id
			and event.body ->> 'schema' = 'qorpera.shared-trail-entry-part/v1'
		group by event.body ->> 'entryId', (event.body ->> 'partCount')::integer
		having count(*) <> (event.body ->> 'partCount')::integer
			or count(distinct (event.body ->> 'partIndex')::integer)
				<> (event.body ->> 'partCount')::integer
	) then
		raise exception 'operational trail session has an incomplete multipart entry' using errcode = '55000';
	end if;
	update public.qorpera_shared_sessions
	set status = 'closed', updated_at = statement_timestamp()
	where id = p_session_id and status = 'open';
	return true;
end
$$;

-- Autonomous work is uploaded after it runs, so its trail must carry the
-- exact revisions the executor claimed rather than being re-pinned to
-- whatever happens to be current when synchronization reaches the server.
create function public.qorpera_create_shared_session_v4(
	p_environment_id uuid,
	p_client_session_id uuid,
	p_title text,
	p_staff_agent_id text,
	p_parent_session_id uuid,
	p_execution_scope jsonb,
	p_company_snapshot_id uuid,
	p_staff_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_result jsonb;
	v_current_staff_version bigint;
begin
	if (p_company_snapshot_id is null) is distinct from (p_staff_version is null) then
		raise exception 'session execution revisions must be provided together' using errcode = '22023';
	end if;
	if p_company_snapshot_id is not null then
		if p_staff_version < 1
			or p_execution_scope ->> 'companySnapshotId' is distinct from p_company_snapshot_id::text
			or p_execution_scope ->> 'staffVersion' is distinct from p_staff_version::text
			or not exists (
				select 1 from public.qorpera_company_snapshots as snapshot
				where snapshot.id = p_company_snapshot_id
					and snapshot.environment_id = p_environment_id
			) then
			raise exception 'session execution revision is invalid' using errcode = '22023';
		end if;
		if p_staff_agent_id is null
			or p_staff_agent_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'session staff revision is invalid' using errcode = '22023';
		end if;
		select staff.version into v_current_staff_version
		from public.qorpera_profile_staff as staff
		join public.qorpera_company_environments as environment on environment.profile_id = staff.profile_id
		where environment.id = p_environment_id and staff.staff_agent_id = p_staff_agent_id::uuid;
		if v_current_staff_version is null or p_staff_version > v_current_staff_version then
			raise exception 'session staff revision is invalid' using errcode = '22023';
		end if;
	end if;

	v_result := public.qorpera_create_shared_session_v3(
		p_environment_id, p_client_session_id, p_title, p_staff_agent_id,
		p_parent_session_id, p_execution_scope
	);
	if p_company_snapshot_id is not null then
		update public.qorpera_shared_sessions
		set company_snapshot_id = p_company_snapshot_id,
			staff_version = p_staff_version
		where id = (v_result ->> 'session_id')::uuid;
		v_result := v_result || jsonb_build_object(
			'company_snapshot_id', p_company_snapshot_id,
			'staff_version', p_staff_version
		);
	end if;
	return v_result;
end
$$;

-- A staff session's revision columns are the execution pin for its most
-- recently claimed turn. The ensure response exposes the initial pin; every
-- later claim atomically advances it to the exact Company File/staff revisions
-- already materialized by the claimant.
create or replace function public.qorpera_ensure_staff_session(
	p_environment_id uuid,
	p_staff_agent_id text,
	p_client_session_id uuid,
	p_title text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_profile_id uuid;
	v_session public.qorpera_shared_sessions%rowtype;
	v_created boolean := false;
begin
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment
	where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'profile write access is required' using errcode = '42501';
	end if;
	if p_client_session_id is null then
		raise exception 'client session id is required' using errcode = '22023';
	end if;
	if p_staff_agent_id is null or char_length(btrim(p_staff_agent_id)) not between 1 and 128 then
		raise exception 'staff agent id is invalid' using errcode = '22023';
	end if;
	if char_length(btrim(p_title)) not between 1 and 256 then
		raise exception 'session title is invalid' using errcode = '22023';
	end if;

	insert into public.qorpera_shared_sessions (
		profile_id, environment_id, client_session_id, title, staff_agent_id, created_by_user_id
	) values (
		v_profile_id, p_environment_id, p_client_session_id, btrim(p_title),
		btrim(p_staff_agent_id), v_user_id
	)
	on conflict (profile_id, staff_agent_id) where status = 'open'
		and staff_agent_id is not null
		and not (execution_scope ?| array['autonomousLabel', 'roomId', 'group', 'parentSession'])
	do nothing
	returning * into v_session;
	v_created := found;

	if v_created then
		insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id)
		values (v_session.id, v_session.id, 'kickoff', v_user_id);
	else
		select session.* into v_session
		from public.qorpera_shared_sessions as session
		where session.profile_id = v_profile_id
			and session.staff_agent_id = btrim(p_staff_agent_id)
			and session.status = 'open'
			and not (session.execution_scope ?| array['autonomousLabel', 'roomId', 'group', 'parentSession']);
		if not found then
			raise exception 'staff session could not be adopted' using errcode = '40001';
		end if;
	end if;

	return jsonb_build_object(
		'session_id', v_session.id,
		'client_session_id', v_session.client_session_id,
		'environment_id', v_session.environment_id,
		'title', v_session.title,
		'company_snapshot_id', v_session.company_snapshot_id,
		'staff_version', v_session.staff_version,
		'created', v_created,
		'created_by_user_id', v_session.created_by_user_id,
		'created_at', v_session.created_at
	);
end
$$;

create table public.qorpera_session_turns (
	id uuid primary key default extensions.gen_random_uuid(),
	session_id uuid not null references public.qorpera_shared_sessions(id) on delete cascade,
	claimant_id uuid not null,
	claimed_by_user_id uuid not null references auth.users(id) on delete restrict,
	company_snapshot_id uuid not null references public.qorpera_company_snapshots(id) on delete restrict,
	staff_version bigint not null check (staff_version > 0),
	input_ids uuid[] not null check (cardinality(input_ids) > 0),
	status text not null default 'active' check (status in ('active', 'completed', 'review_pending', 'quarantined')),
	claimed_at timestamptz not null default statement_timestamp(),
	lease_expires_at timestamptz not null,
	trail_start_sequence bigint not null check (trail_start_sequence >= 0),
	trail_end_sequence bigint check (trail_end_sequence is null or trail_end_sequence >= trail_start_sequence),
	completed_at timestamptz,
	failure_reason text check (failure_reason is null or char_length(failure_reason) between 1 and 2048),
	review_resolution text check (review_resolution is null or review_resolution in ('retry', 'discard')),
	review_resolved_by_user_id uuid references auth.users(id) on delete restrict,
	review_resolved_at timestamptz,
	check ((status = 'active') = (completed_at is null)),
	check ((status = 'quarantined') = (failure_reason is not null)),
	check ((review_resolution is null) = (review_resolved_at is null)),
	check ((review_resolution is null) = (review_resolved_by_user_id is null)),
	check (review_resolution is null or status = 'quarantined')
);

create unique index qorpera_session_turns_one_active
	on public.qorpera_session_turns (session_id)
	where status = 'active';
create index qorpera_session_turns_revision_pins
	on public.qorpera_session_turns (company_snapshot_id, status);

alter table public.qorpera_session_turns enable row level security;
revoke all on public.qorpera_session_turns from anon, authenticated;

alter table public.qorpera_session_inputs
	add column turn_id uuid references public.qorpera_session_turns(id) on delete set null,
	add column failed_at timestamptz,
	add column failure_reason text check (failure_reason is null or char_length(failure_reason) between 1 and 2048),
	add check ((failed_at is null) = (failure_reason is null));

create index qorpera_session_inputs_claimable
	on public.qorpera_session_inputs (session_id, position)
	where completed_at is null and failed_at is null;

-- Claiming selects and marks the bounded input batch before it can construct
-- the immutable turn row. Defer this single reference until the RPC's
-- transaction ends so no partially claimed state can commit.
alter table public.qorpera_session_inputs
	alter constraint qorpera_session_inputs_turn_id_fkey deferrable initially deferred;

create or replace function public.qorpera_append_session_input(
	p_session_id uuid,
	p_client_input_id uuid,
	p_kind text,
	p_body jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_input public.qorpera_session_inputs%rowtype;
	v_profile_id uuid;
	v_image jsonb;
	v_image_bytes bigint;
	v_total_image_bytes bigint := 0;
	v_pending_inputs integer;
	v_pending_body_bytes bigint;
begin
	v_profile_id := public.qorpera_session_profile_for_write(p_session_id);
	perform public.qorpera_lock_profile_gc_fence(v_profile_id);
	if public.qorpera_profile_gc_deletion_active(v_profile_id) then
		raise exception 'profile object cleanup is in progress' using errcode = '40001';
	end if;
	if p_client_input_id is null then
		raise exception 'client input id is required' using errcode = '22023';
	end if;
	if p_kind is distinct from 'user_message' then
		raise exception 'input kind is invalid' using errcode = '22023';
	end if;
	if p_body is null or jsonb_typeof(p_body) <> 'object' or pg_column_size(p_body) > 131072 then
		raise exception 'input body is invalid' using errcode = '22023';
	end if;
	if p_body ->> 'schema' = 'qorpera.staff-intro-retry/v1' then
		if p_body <> jsonb_build_object('schema', 'qorpera.staff-intro-retry/v1') then
			raise exception 'introduction retry body is invalid' using errcode = '22023';
		end if;
	elsif p_body ->> 'schema' = 'qorpera.session-prompt/v1' then
		if jsonb_typeof(p_body -> 'text') is distinct from 'string'
			or octet_length(p_body ->> 'text') > 65536
			or (p_body ? 'displayText' and (
				jsonb_typeof(p_body -> 'displayText') is distinct from 'string'
				or octet_length(p_body ->> 'displayText') > 65536
			))
			or jsonb_typeof(p_body -> 'images') is distinct from 'array'
			or jsonb_array_length(p_body -> 'images') > 5
			or p_body - 'schema' - 'text' - 'displayText' - 'images' <> '{}'::jsonb then
			raise exception 'session prompt body is invalid' using errcode = '22023';
		end if;
		for v_image in select value from jsonb_array_elements(p_body -> 'images') loop
			if jsonb_typeof(v_image) is distinct from 'object'
				or v_image - 'objectSha256' - 'bytes' - 'mediaType' <> '{}'::jsonb
				or coalesce(v_image ->> 'objectSha256', '') !~ '^[0-9a-f]{64}$'
				or jsonb_typeof(v_image -> 'bytes') is distinct from 'number'
				or coalesce(v_image ->> 'mediaType', '') not in ('image/png', 'image/jpeg', 'image/gif', 'image/webp') then
				raise exception 'session prompt image is invalid' using errcode = '22023';
			end if;
			begin
				v_image_bytes := (v_image ->> 'bytes')::bigint;
			exception when others then
				raise exception 'session prompt image size is invalid' using errcode = '22023';
			end;
			if to_jsonb(v_image_bytes) <> v_image -> 'bytes' or v_image_bytes not between 1 and 8388608 then
				raise exception 'session prompt image size is invalid' using errcode = '22023';
			end if;
			v_total_image_bytes := v_total_image_bytes + v_image_bytes;
			if v_total_image_bytes > 8388608 then
				raise exception 'session prompt images exceed the turn allowance' using errcode = '22023';
			end if;
			if not exists (
				select 1 from public.qorpera_profile_objects as object
				where object.profile_id = v_profile_id
					and object.sha256 = v_image ->> 'objectSha256'
					and object.bytes = v_image_bytes
			) then
				raise exception 'session prompt image object is unavailable or has the wrong size' using errcode = '22023';
			end if;
		end loop;
	else
		raise exception 'input body schema is invalid' using errcode = '22023';
	end if;

	-- Serialize producers for this session so the pending row/byte limits are
	-- durable rather than a client-side estimate. Idempotent retries return the
	-- original input before consuming queue capacity.
	perform 1
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
	select input.* into v_input
	from public.qorpera_session_inputs as input
	where input.session_id = p_session_id and input.client_input_id = p_client_input_id;
	if found then
		if v_input.author_user_id <> v_user_id
			or v_input.kind <> 'user_message'
			or v_input.body <> p_body then
			raise exception 'client input id is already bound to different content' using errcode = '23505';
		end if;
		return jsonb_build_object('input_id', v_input.id, 'position', v_input.position);
	end if;
	select count(*), coalesce(sum(pg_column_size(input.body)), 0)
	into v_pending_inputs, v_pending_body_bytes
	from public.qorpera_session_inputs as input
	where input.session_id = p_session_id
		and input.completed_at is null
		and input.failed_at is null;
	if v_pending_inputs >= 512 or v_pending_body_bytes + pg_column_size(p_body) > 16777216 then
		raise exception 'session queue capacity is reached' using errcode = '54000';
	end if;

	insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id, body)
	values (p_session_id, p_client_input_id, 'user_message', v_user_id, p_body)
	returning * into v_input;
	update public.qorpera_shared_sessions
	set updated_at = statement_timestamp()
	where id = p_session_id;
	return jsonb_build_object('input_id', v_input.id, 'position', v_input.position);
end
$$;

create function public.qorpera_list_session_inputs(
	p_session_id uuid,
	p_after_position bigint default 0,
	p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid := public.qorpera_session_profile_id(p_session_id);
begin
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'session read access is required' using errcode = '42501';
	end if;
	if p_after_position < 0 or p_limit not between 1 and 100 then
		raise exception 'session input page is invalid' using errcode = '22023';
	end if;
	return (
		with visible as (
			select input.*, coalesce(member.display_name, 'Former company member') as author_display_name
			from public.qorpera_session_inputs as input
			left join public.qorpera_profile_members as member
				on member.profile_id = v_profile_id and member.user_id = input.author_user_id
			where input.session_id = p_session_id
				and input.completed_at is null
				and input.failed_at is null
				and input.position > p_after_position
			order by input.position
			limit p_limit + 1
		), page as (
			select * from visible order by position limit p_limit
		)
		select jsonb_build_object(
			'items', coalesce((
				select jsonb_agg(jsonb_build_object(
					'input_id', input.id,
					'position', input.position,
					'kind', input.kind,
					'author_user_id', input.author_user_id,
					'author_display_name', input.author_display_name,
					'body', input.body,
					'created_at', input.created_at,
					'failure_reason', input.failure_reason,
					'status', case
						when input.failed_at is not null then 'failed'
						when input.claimant_id is not null and input.claim_expires_at > statement_timestamp()
							then 'processing'
						when input.execution_run_id is not null and exists (
							select 1
							from public.qorpera_execution_runs as run
							join public.qorpera_runner_jobs as job on job.id = run.job_id
							where run.id = input.execution_run_id and job.status in ('queued', 'leased')
						) then 'processing'
						else 'queued'
					end
				) order by input.position) from page as input
			), '[]'::jsonb),
			'next_after_position', coalesce((select max(position) from page), p_after_position),
			'has_more', (select count(*) > p_limit from visible)
		)
	);
end
$$;

drop function public.qorpera_claim_session_turn(uuid, uuid, integer);

create function public.qorpera_claim_session_turn(
	p_session_id uuid,
	p_claimant_id uuid,
	p_lease_seconds integer,
	p_company_snapshot_id uuid,
	p_staff_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_session public.qorpera_shared_sessions%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_current_staff_version bigint;
	v_claimed jsonb;
	v_turn_id uuid := extensions.gen_random_uuid();
	v_input_ids uuid[];
	v_trail_start_sequence bigint;
	v_expired_turn_id uuid;
begin
	perform public.qorpera_session_profile_for_write(p_session_id);
	if p_claimant_id is null then
		raise exception 'claimant id is required' using errcode = '22023';
	end if;
	if p_lease_seconds is null or p_lease_seconds not between 15 and 900 then
		raise exception 'lease duration is invalid' using errcode = '22023';
	end if;
	if p_company_snapshot_id is null or p_staff_version is null or p_staff_version < 1 then
		raise exception 'execution revision is invalid' using errcode = '22023';
	end if;

	select session.* into strict v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
	select file.* into strict v_file
	from public.qorpera_company_files as file
	where file.environment_id = v_session.environment_id
	for share;
	if v_session.staff_agent_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
		select staff.version into v_current_staff_version
		from public.qorpera_profile_staff as staff
		where staff.profile_id = v_session.profile_id
			and staff.staff_agent_id = v_session.staff_agent_id::uuid;
	end if;
	if v_file.head_snapshot_id is distinct from p_company_snapshot_id
		or v_current_staff_version is distinct from p_staff_version then
		return jsonb_build_object('claimed', false, 'reason', 'stale-revision');
	end if;

	select turn.id into v_expired_turn_id
	from public.qorpera_session_turns as turn
	where turn.session_id = p_session_id
		and turn.status = 'active'
		and turn.lease_expires_at <= statement_timestamp()
	for update;
	if v_expired_turn_id is not null then
		update public.qorpera_session_turns
		set status = 'quarantined', completed_at = statement_timestamp(),
			failure_reason = 'executor lease expired; review the prior run before retrying',
			trail_end_sequence = (
				select coalesce(max(event.sequence), 0)
				from public.qorpera_session_events as event
				where event.session_id = p_session_id
			)
		where id = v_expired_turn_id;
		update public.qorpera_session_inputs
		set failed_at = statement_timestamp(),
			failure_reason = 'executor lease expired; review the prior run before retrying',
			claim_expires_at = null
		where turn_id = v_expired_turn_id and completed_at is null;
		update public.qorpera_operation_receipts
		set status = 'ambiguous', completed_at = statement_timestamp()
		where execution_kind = 'turn' and execution_id = v_expired_turn_id and status = 'executing';
	end if;

	if exists (
		select 1 from public.qorpera_session_turns as turn
		where turn.session_id = p_session_id
			and turn.status = 'active'
			and turn.lease_expires_at > statement_timestamp()
	) then
		return jsonb_build_object('claimed', false, 'reason', 'turn-in-flight');
	end if;

	with pending as (
		select input.id, input.position, input.body,
			case
				when jsonb_typeof(input.body -> 'images') = 'array'
					then jsonb_array_length(input.body -> 'images')
				else 0
			end as image_count,
			input.body ->> 'schema' = 'qorpera.staff-intro-retry/v1' as intro_retry
		from public.qorpera_session_inputs as input
		where input.session_id = p_session_id
			and input.completed_at is null
			and input.failed_at is null
		order by input.position
		limit 33
	), marked as (
		select pending.*,
			min(pending.position) over () as first_position,
			min(pending.position) filter (where pending.intro_retry) over () as first_intro_retry_position
		from pending
	), turn_segment as (
		select marked.*
		from marked
		where marked.first_intro_retry_position is null
			or (
				marked.first_position = marked.first_intro_retry_position
				and marked.position = marked.first_intro_retry_position
			)
			or (
				marked.first_position < marked.first_intro_retry_position
				and marked.position < marked.first_intro_retry_position
			)
	), bounded as (
		select turn_segment.id,
			row_number() over (order by turn_segment.position) as cumulative_inputs,
			sum(octet_length(turn_segment.body::text)) over (order by turn_segment.position) as cumulative_body_bytes,
			sum(turn_segment.image_count) over (order by turn_segment.position) as cumulative_images,
			sum(coalesce((
				select sum((image ->> 'bytes')::bigint)
				from jsonb_array_elements(coalesce(turn_segment.body -> 'images', '[]'::jsonb)) as image
			), 0)) over (order by turn_segment.position) as cumulative_image_bytes
		from turn_segment
	), turn as (
		update public.qorpera_session_inputs as input
		set claimant_id = p_claimant_id,
			claimed_at = statement_timestamp(),
			claim_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
			turn_id = v_turn_id
		from bounded
		where input.id = bounded.id
			and bounded.cumulative_inputs <= 32
			and bounded.cumulative_body_bytes <= 524288
			and bounded.cumulative_images <= 5
			and bounded.cumulative_image_bytes <= 8388608
		returning input.id, input.position, input.kind, input.author_user_id, input.body, input.created_at
	)
	select jsonb_agg(jsonb_build_object(
		'input_id', turn.id,
		'position', turn.position,
		'kind', turn.kind,
		'author_user_id', turn.author_user_id,
		'author_display_name', coalesce(member.display_name, 'Former company member'),
		'body', turn.body,
		'created_at', turn.created_at
	) order by turn.position) into v_claimed
	from turn
	left join public.qorpera_profile_members as member
		on member.profile_id = v_session.profile_id and member.user_id = turn.author_user_id;

	if v_claimed is null then
		return jsonb_build_object('claimed', false, 'reason', 'queue-empty');
	end if;
	select array_agg(input.id order by input.position) into v_input_ids
	from public.qorpera_session_inputs as input
	where input.turn_id = v_turn_id;
	select coalesce(max(event.sequence), 0) into v_trail_start_sequence
	from public.qorpera_session_events as event
	where event.session_id = p_session_id;
	insert into public.qorpera_session_turns (
		id, session_id, claimant_id, claimed_by_user_id, company_snapshot_id, staff_version,
		input_ids, lease_expires_at, trail_start_sequence
	) values (
		v_turn_id, p_session_id, p_claimant_id, v_user_id, p_company_snapshot_id, p_staff_version,
		v_input_ids, statement_timestamp() + make_interval(secs => p_lease_seconds),
		v_trail_start_sequence
	);
	update public.qorpera_shared_sessions
	set company_snapshot_id = p_company_snapshot_id,
		staff_version = p_staff_version,
		updated_at = statement_timestamp()
	where id = p_session_id;
	return jsonb_build_object(
		'claimed', true,
		'turn_id', v_turn_id,
		'company_snapshot_id', p_company_snapshot_id,
		'staff_version', p_staff_version,
		'inputs', v_claimed
	);
end
$$;

create function public.qorpera_renew_session_turn_v2(
	p_session_id uuid,
	p_turn_id uuid,
	p_claimant_id uuid,
	p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_renewed integer;
begin
	perform public.qorpera_session_profile_for_write(p_session_id);
	if p_lease_seconds is null or p_lease_seconds not between 15 and 900 then
		raise exception 'lease duration is invalid' using errcode = '22023';
	end if;
	update public.qorpera_session_turns as turn
	set lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds)
	where turn.id = p_turn_id
		and turn.session_id = p_session_id
		and turn.claimant_id = p_claimant_id
		and turn.claimed_by_user_id = v_user_id
		and turn.status = 'active'
		and turn.lease_expires_at > statement_timestamp();
	get diagnostics v_renewed = row_count;
	if v_renewed > 0 then
		update public.qorpera_session_inputs
		set claim_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds)
		where turn_id = p_turn_id and completed_at is null;
	end if;
	return jsonb_build_object('renewed', v_renewed);
end
$$;

create table public.qorpera_operation_receipts (
	id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	execution_kind text not null check (execution_kind in ('turn', 'wake')),
	execution_id uuid not null,
	claimant_id uuid not null,
	claimed_by_user_id uuid not null references auth.users(id) on delete restrict,
	operation_kind text not null check (operation_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
	input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
	status text not null default 'executing' check (status in ('executing', 'completed', 'ambiguous', 'cancelled')),
	result jsonb,
	created_at timestamptz not null default statement_timestamp(),
	completed_at timestamptz,
	recovery_resolution text check (
		recovery_resolution is null or recovery_resolution in ('confirmed_completed', 'confirmed_not_run')
	),
	recovery_resolved_by_user_id uuid references auth.users(id) on delete restrict,
	recovery_resolved_at timestamptz,
	unique (profile_id, execution_id, id),
	check ((status = 'executing') = (completed_at is null)),
	check ((status = 'completed') = (result is not null)),
	check ((recovery_resolution is null) = (recovery_resolved_at is null)),
	check ((recovery_resolution is null) = (recovery_resolved_by_user_id is null)),
	check (recovery_resolution is null or status in ('completed', 'cancelled'))
);

create index qorpera_operation_receipts_execution
	on public.qorpera_operation_receipts (profile_id, execution_kind, execution_id);
alter table public.qorpera_operation_receipts enable row level security;
revoke all on public.qorpera_operation_receipts from anon, authenticated;

create table public.qorpera_operation_receipt_objects (
	receipt_id uuid not null references public.qorpera_operation_receipts(id) on delete cascade,
	profile_id uuid not null,
	object_sha256 text not null check (object_sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint not null check (bytes >= 0),
	created_at timestamptz not null default statement_timestamp(),
	primary key (receipt_id, object_sha256),
	foreign key (profile_id, object_sha256)
		references public.qorpera_profile_objects(profile_id, sha256) on delete cascade
);

create index qorpera_operation_receipt_objects_profile
	on public.qorpera_operation_receipt_objects (profile_id, object_sha256);
alter table public.qorpera_operation_receipt_objects enable row level security;
revoke all on public.qorpera_operation_receipt_objects from anon, authenticated;

-- Hosted trail output is attributed to the durable execution that produced
-- it, not inferred later from a mutable session cursor range. Ordinary member
-- events remain valid only while no agent turn owns the attended session.
alter table public.qorpera_session_events
	add column execution_kind text check (execution_kind is null or execution_kind in ('turn', 'wake')),
	add column execution_id uuid,
	add column execution_claimant_id uuid,
	add check (
		(execution_kind is null) = (execution_id is null)
		and (execution_kind is null) = (execution_claimant_id is null)
	);

create index qorpera_session_events_execution
	on public.qorpera_session_events (execution_kind, execution_id, sequence)
	where execution_id is not null;

create function public.qorpera_complete_session_turn_v2(
	p_session_id uuid,
	p_turn_id uuid,
	p_claimant_id uuid,
	p_trail_end_sequence bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_completed integer;
	v_turn public.qorpera_session_turns%rowtype;
begin
	perform public.qorpera_session_profile_for_write(p_session_id);
	select turn.* into v_turn
	from public.qorpera_session_turns as turn
	where turn.id = p_turn_id and turn.session_id = p_session_id
	for update;
	if not found or v_turn.claimant_id <> p_claimant_id
		or v_turn.claimed_by_user_id <> v_user_id
		or v_turn.status <> 'active'
		or v_turn.lease_expires_at <= statement_timestamp() then
		return jsonb_build_object('completed', 0);
	end if;
	if exists (
		select 1
		from public.qorpera_operation_receipts as receipt
		where receipt.profile_id = (
			select session.profile_id from public.qorpera_shared_sessions as session where session.id = p_session_id
		)
			and receipt.execution_kind = 'turn'
			and receipt.execution_id = p_turn_id
			and receipt.status = 'executing'
	) then
		raise exception 'turn has an unresolved operation receipt' using errcode = '55000';
	end if;
	if p_trail_end_sequence is null or p_trail_end_sequence < v_turn.trail_start_sequence
		or (p_trail_end_sequence > 0 and not exists (
			select 1 from public.qorpera_session_events as event
			where event.session_id = p_session_id and event.sequence = p_trail_end_sequence
		))
		or exists (
			select 1
			from public.qorpera_session_events as event
			where event.session_id = p_session_id
				and event.sequence > v_turn.trail_start_sequence
				and event.sequence <= p_trail_end_sequence
				and (
					event.execution_kind is distinct from 'turn'
					or event.execution_id is distinct from v_turn.id
					or event.execution_claimant_id is distinct from v_turn.claimant_id
				)
		)
		or (
			select count(*)
			from public.qorpera_session_events as event
			where event.session_id = p_session_id
				and event.sequence > v_turn.trail_start_sequence
				and event.sequence <= p_trail_end_sequence
		) <> p_trail_end_sequence - v_turn.trail_start_sequence then
		raise exception 'turn trail boundary is invalid' using errcode = '22023';
	end if;
	update public.qorpera_session_inputs as input
	set completed_at = statement_timestamp()
	where input.turn_id = p_turn_id
		and input.completed_at is null
		and input.claim_expires_at > statement_timestamp();
	get diagnostics v_completed = row_count;
	if v_completed > 0 then
		update public.qorpera_session_turns
		set status = 'completed', completed_at = statement_timestamp(),
			trail_end_sequence = p_trail_end_sequence
		where id = p_turn_id;
		update public.qorpera_shared_sessions
		set updated_at = statement_timestamp()
		where id = p_session_id;
	end if;
	return jsonb_build_object('completed', v_completed);
end
$$;

create function public.qorpera_quarantine_session_turn(
	p_session_id uuid,
	p_turn_id uuid,
	p_claimant_id uuid,
	p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_reason text := left(btrim(p_reason), 2048);
	v_quarantined integer;
begin
	perform public.qorpera_session_profile_for_write(p_session_id);
	if char_length(v_reason) < 1 then
		raise exception 'quarantine reason is required' using errcode = '22023';
	end if;
	update public.qorpera_session_turns as turn
	set status = 'quarantined', completed_at = statement_timestamp(), failure_reason = v_reason,
		trail_end_sequence = (
			select coalesce(max(event.sequence), 0)
			from public.qorpera_session_events as event
			where event.session_id = p_session_id
		)
	where turn.id = p_turn_id
		and turn.session_id = p_session_id
		and turn.claimant_id = p_claimant_id
		and turn.claimed_by_user_id = v_user_id
		and turn.status = 'active'
		and turn.lease_expires_at > statement_timestamp();
	get diagnostics v_quarantined = row_count;
	if v_quarantined > 0 then
		update public.qorpera_session_inputs
		set failed_at = statement_timestamp(), failure_reason = v_reason,
			claim_expires_at = null
		where turn_id = p_turn_id and completed_at is null;
		update public.qorpera_operation_receipts
		set status = 'ambiguous', completed_at = statement_timestamp()
		where execution_kind = 'turn' and execution_id = p_turn_id and status = 'executing';
	end if;
	return jsonb_build_object('quarantined', v_quarantined);
end
$$;

create function public.qorpera_list_session_recoveries(
	p_session_id uuid,
	p_after_completed_at timestamptz default null,
	p_after_id uuid default null,
	p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid := public.qorpera_session_profile_id(p_session_id);
begin
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'session recovery read access is required' using errcode = '42501';
	end if;
	if p_limit not between 1 and 20
		or ((p_after_completed_at is null) is distinct from (p_after_id is null)) then
		raise exception 'session recovery page is invalid' using errcode = '22023';
	end if;
	return (
		with visible as (
			select turn.*
			from public.qorpera_session_turns as turn
			where turn.session_id = p_session_id
				and turn.status = 'quarantined'
				and turn.review_resolution is null
				and (
					p_after_completed_at is null
					or (turn.completed_at, turn.id) < (p_after_completed_at, p_after_id)
				)
			order by turn.completed_at desc, turn.id desc
			limit p_limit + 1
		), page as (
			select * from visible order by completed_at desc, id desc limit p_limit
		)
		select jsonb_build_object(
			'items', coalesce((
				select jsonb_agg(jsonb_build_object(
					'turn_id', turn.id,
					'company_snapshot_id', turn.company_snapshot_id,
					'staff_version', turn.staff_version,
					'trail_start_sequence', turn.trail_start_sequence,
					'trail_end_sequence', turn.trail_end_sequence,
					'failure_reason', turn.failure_reason,
					'claimed_at', turn.claimed_at,
					'failed_at', turn.completed_at,
					'operation_receipts', coalesce((
						select jsonb_agg(jsonb_build_object(
							'operation_id', receipt.id,
							'operation_kind', receipt.operation_kind,
							'status', receipt.status,
							'recovery_resolution', receipt.recovery_resolution,
							'created_at', receipt.created_at
						) order by receipt.created_at, receipt.id)
						from public.qorpera_operation_receipts as receipt
						where receipt.profile_id = v_profile_id
							and receipt.execution_kind = 'turn'
							and receipt.execution_id = turn.id
					), '[]'::jsonb),
					'inputs', coalesce((
						select jsonb_agg(jsonb_build_object(
							'input_id', input.id,
							'position', input.position,
							'kind', input.kind,
							'author_user_id', input.author_user_id,
							'author_display_name', coalesce(member.display_name, 'Former company member'),
							'body', input.body,
							'created_at', input.created_at
						) order by input.position)
						from public.qorpera_session_inputs as input
						left join public.qorpera_profile_members as member
							on member.profile_id = v_profile_id and member.user_id = input.author_user_id
						where input.turn_id = turn.id
					), '[]'::jsonb)
				) order by turn.completed_at desc, turn.id desc)
				from page as turn
			), '[]'::jsonb),
			'has_more', (select count(*) > p_limit from visible),
			'next_completed_at', (select min(completed_at) from page),
			'next_id', (select id from page order by completed_at, id limit 1)
		)
	);
end
$$;

create function public.qorpera_resolve_session_recovery(
	p_session_id uuid,
	p_turn_id uuid,
	p_resolution text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_profile_id uuid := public.qorpera_session_profile_id(p_session_id);
	v_turn public.qorpera_session_turns%rowtype;
	v_input_count integer;
begin
	if v_profile_id is null or not public.qorpera_can_authorize_profile(v_profile_id) then
		raise exception 'session recovery authorization is required' using errcode = '42501';
	end if;
	if p_resolution not in ('retry', 'discard') then
		raise exception 'session recovery resolution is invalid' using errcode = '22023';
	end if;
	select turn.* into v_turn
	from public.qorpera_session_turns as turn
	where turn.id = p_turn_id and turn.session_id = p_session_id
	for update;
	if not found or v_turn.status <> 'quarantined' then
		raise exception 'session recovery is unavailable' using errcode = '55000';
	end if;
	if v_turn.review_resolution is not null then
		return jsonb_build_object('resolved', true, 'resolution', v_turn.review_resolution, 'input_count', 0);
	end if;
	if p_resolution = 'retry' and exists (
		select 1 from public.qorpera_operation_receipts as receipt
		where receipt.profile_id = v_profile_id
			and receipt.execution_kind = 'turn'
			and receipt.execution_id = p_turn_id
			and receipt.status <> 'cancelled'
	) then
		raise exception 'session recovery has operation receipts; resolve or discard the prior effects before retrying'
			using errcode = '55000';
	end if;
	if p_resolution = 'retry' then
		update public.qorpera_session_inputs
		set turn_id = null, claimant_id = null, claimed_at = null, claim_expires_at = null,
			failed_at = null, failure_reason = null
		where turn_id = p_turn_id and completed_at is null;
		get diagnostics v_input_count = row_count;
	else
		update public.qorpera_session_inputs
		set completed_at = statement_timestamp(), claim_expires_at = null
		where turn_id = p_turn_id and completed_at is null;
		get diagnostics v_input_count = row_count;
		update public.qorpera_operation_receipts
		set status = 'cancelled', completed_at = coalesce(completed_at, statement_timestamp())
		where profile_id = v_profile_id
			and execution_kind = 'turn'
			and execution_id = p_turn_id
			and status in ('executing', 'ambiguous');
	end if;
	update public.qorpera_session_turns
	set review_resolution = p_resolution,
		review_resolved_by_user_id = v_user_id,
		review_resolved_at = statement_timestamp()
	where id = p_turn_id;
	update public.qorpera_shared_sessions
	set updated_at = statement_timestamp()
	where id = p_session_id;
	return jsonb_build_object('resolved', true, 'resolution', p_resolution, 'input_count', v_input_count);
end
$$;

create function public.qorpera_resolve_operation_receipt(
	p_operation_id uuid,
	p_resolution text,
	p_result jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_receipt public.qorpera_operation_receipts%rowtype;
	v_execution_terminal boolean := false;
begin
	select receipt.* into v_receipt
	from public.qorpera_operation_receipts as receipt
	where receipt.id = p_operation_id
	for update;
	if not found or not public.qorpera_can_authorize_profile(v_receipt.profile_id) then
		raise exception 'operation recovery authorization is required' using errcode = '42501';
	end if;
	if p_resolution not in ('confirmed_completed', 'confirmed_not_run') then
		raise exception 'operation recovery resolution is invalid' using errcode = '22023';
	end if;
	if v_receipt.recovery_resolution is not null then
		if v_receipt.recovery_resolution <> p_resolution
			or (p_resolution = 'confirmed_completed' and p_result is not null and v_receipt.result <> p_result) then
			raise exception 'operation recovery is already bound to a different resolution' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'operation_id', v_receipt.id,
			'status', v_receipt.status,
			'resolution', v_receipt.recovery_resolution,
			'result', v_receipt.result
		);
	end if;
	if v_receipt.status not in ('executing', 'ambiguous') then
		raise exception 'operation receipt does not require recovery' using errcode = '55000';
	end if;
	if v_receipt.execution_kind = 'turn' then
		select turn.status = 'quarantined' into v_execution_terminal
		from public.qorpera_session_turns as turn
		where turn.id = v_receipt.execution_id;
	else
		select claim.failed_at is not null into v_execution_terminal
		from public.qorpera_wake_claims as claim
		where claim.execution_id = v_receipt.execution_id;
	end if;
	if coalesce(v_execution_terminal, false) is not true then
		raise exception 'operation execution is still active' using errcode = '55000';
	end if;
	if p_resolution = 'confirmed_completed' then
		if p_result is not null and (jsonb_typeof(p_result) <> 'object' or pg_column_size(p_result) > 524288) then
			raise exception 'operation recovery result is invalid' using errcode = '22023';
		end if;
		update public.qorpera_operation_receipts
		set status = 'completed',
			result = coalesce(p_result, jsonb_build_object(
				'message', 'An authorized reviewer confirmed that the operation completed.',
				'recovered', true
			)),
			completed_at = coalesce(completed_at, statement_timestamp()),
			recovery_resolution = p_resolution,
			recovery_resolved_by_user_id = v_user_id,
			recovery_resolved_at = statement_timestamp()
		where id = p_operation_id
		returning * into v_receipt;
	else
		if p_result is not null then
			raise exception 'a confirmed-not-run operation cannot have a result' using errcode = '22023';
		end if;
		update public.qorpera_operation_receipts
		set status = 'cancelled', result = null,
			completed_at = coalesce(completed_at, statement_timestamp()),
			recovery_resolution = p_resolution,
			recovery_resolved_by_user_id = v_user_id,
			recovery_resolved_at = statement_timestamp()
		where id = p_operation_id
		returning * into v_receipt;
	end if;
	return jsonb_build_object(
		'operation_id', v_receipt.id,
		'status', v_receipt.status,
		'resolution', v_receipt.recovery_resolution,
		'result', v_receipt.result
	);
end
$$;

create function public.qorpera_get_session_turn_status(
	p_session_id uuid,
	p_turn_id uuid,
	p_claimant_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_turn public.qorpera_session_turns%rowtype;
begin
	perform public.qorpera_session_profile_for_write(p_session_id);
	select turn.* into v_turn
	from public.qorpera_session_turns as turn
	where turn.id = p_turn_id
		and turn.session_id = p_session_id
		and turn.claimant_id = p_claimant_id
		and turn.claimed_by_user_id = v_user_id;
	if not found then
		return jsonb_build_object('status', 'unavailable');
	end if;
	return jsonb_build_object(
		'status', v_turn.status,
		'input_count', cardinality(v_turn.input_ids),
		'remaining_input_count', (
			select count(*)
			from public.qorpera_session_inputs as input
			where input.turn_id = v_turn.id and input.completed_at is null
		)
	);
end
$$;

alter table public.qorpera_wake_claims
	add column company_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete set null,
	add column staff_agent_id uuid,
	add column staff_version bigint check (staff_version is null or staff_version > 0),
	add column execution_id uuid not null default extensions.gen_random_uuid(),
	add column claimed_by_user_id uuid references auth.users(id) on delete restrict,
	add column failed_at timestamptz,
	add column failure_reason text check (failure_reason is null or char_length(failure_reason) between 1 and 2048),
	add check ((failed_at is null) = (failure_reason is null));

create function public.qorpera_claim_wake_v2(
	p_environment_id uuid,
	p_wake_key text,
	p_claimant_id uuid,
	p_lease_seconds integer,
	p_staff_agent_id uuid,
	p_company_snapshot_id uuid,
	p_staff_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_profile_id uuid := public.qorpera_wake_profile_for_write(p_environment_id);
	v_wake_key text := btrim(p_wake_key);
	v_current_snapshot_id uuid;
	v_current_staff_version bigint;
	v_existing public.qorpera_wake_claims%rowtype;
begin
	if p_claimant_id is null or p_staff_agent_id is null then
		raise exception 'wake claimant and staff are required' using errcode = '22023';
	end if;
	if p_wake_key is null or char_length(v_wake_key) not between 1 and 200 then
		raise exception 'wake key is invalid' using errcode = '22023';
	end if;
	if p_lease_seconds is null or p_lease_seconds not between 15 and 900 then
		raise exception 'lease duration is invalid' using errcode = '22023';
	end if;
	if p_company_snapshot_id is null or p_staff_version is null or p_staff_version < 1 then
		raise exception 'wake execution revision is invalid' using errcode = '22023';
	end if;

	select file.head_snapshot_id into v_current_snapshot_id
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and file.profile_id = v_profile_id
	for share;
	select staff.version into v_current_staff_version
	from public.qorpera_profile_staff as staff
	where staff.profile_id = v_profile_id
		and staff.staff_agent_id = p_staff_agent_id
		and staff.employment_status = 'active';
	if v_current_snapshot_id is distinct from p_company_snapshot_id
		or v_current_staff_version is distinct from p_staff_version then
		return jsonb_build_object('claimed', false, 'reason', 'stale-revision');
	end if;

	insert into public.qorpera_wake_claims (
		profile_id, wake_key, claimant_id, claim_expires_at,
		company_snapshot_id, staff_agent_id, staff_version, claimed_by_user_id
	) values (
		v_profile_id, v_wake_key, p_claimant_id,
		statement_timestamp() + make_interval(secs => p_lease_seconds),
		p_company_snapshot_id, p_staff_agent_id, p_staff_version, v_user_id
	)
	on conflict (profile_id, wake_key) do nothing
	returning * into v_existing;
	if found then
		return jsonb_build_object(
			'claimed', true,
			'execution_id', v_existing.execution_id,
			'company_snapshot_id', p_company_snapshot_id,
			'staff_version', p_staff_version
		);
	end if;

	select claim.* into v_existing
	from public.qorpera_wake_claims as claim
	where claim.profile_id = v_profile_id and claim.wake_key = v_wake_key
	for update;
	if not found then
		return jsonb_build_object('claimed', false, 'reason', 'in-flight');
	end if;
	if v_existing.completed_at is not null then
		return jsonb_build_object('claimed', false, 'reason', 'already-run');
	end if;
	if v_existing.claim_expires_at > statement_timestamp() then
		if v_existing.claimant_id is distinct from p_claimant_id
			or v_existing.claimed_by_user_id is distinct from v_user_id then
			return jsonb_build_object('claimed', false, 'reason', 'in-flight');
		end if;
		if v_existing.company_snapshot_id is distinct from p_company_snapshot_id
			or v_existing.staff_agent_id is distinct from p_staff_agent_id
			or v_existing.staff_version is distinct from p_staff_version then
			return jsonb_build_object('claimed', false, 'reason', 'stale-revision');
		end if;
	end if;
	if v_existing.claim_expires_at <= statement_timestamp() then
		update public.qorpera_wake_claims
		set completed_at = statement_timestamp(), failed_at = statement_timestamp(),
			failure_reason = 'executor lease expired; review the prior run before retrying'
		where profile_id = v_profile_id and wake_key = v_wake_key;
		return jsonb_build_object('claimed', false, 'reason', 'requires-review');
	end if;

	update public.qorpera_wake_claims
	set claimant_id = p_claimant_id,
		claimed_by_user_id = v_user_id,
		claimed_at = statement_timestamp(),
		claim_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
		company_snapshot_id = p_company_snapshot_id,
		staff_agent_id = p_staff_agent_id,
		staff_version = p_staff_version
	where profile_id = v_profile_id and wake_key = v_wake_key;
	return jsonb_build_object(
		'claimed', true,
		'execution_id', v_existing.execution_id,
		'company_snapshot_id', p_company_snapshot_id,
		'staff_version', p_staff_version
	);
end
$$;

create function public.qorpera_begin_operation_receipt(
	p_execution_kind text,
	p_execution_id uuid,
	p_claimant_id uuid,
	p_operation_id uuid,
	p_operation_kind text,
	p_input_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_profile_id uuid;
	v_receipt public.qorpera_operation_receipts%rowtype;
	v_started boolean := false;
begin
	if p_execution_kind = 'turn' then
		select session.profile_id into v_profile_id
		from public.qorpera_session_turns as turn
		join public.qorpera_shared_sessions as session on session.id = turn.session_id
		where turn.id = p_execution_id and turn.claimant_id = p_claimant_id
			and turn.claimed_by_user_id = v_user_id
			and turn.status = 'active' and turn.lease_expires_at > statement_timestamp();
	elsif p_execution_kind = 'wake' then
		select claim.profile_id into v_profile_id
		from public.qorpera_wake_claims as claim
		where claim.execution_id = p_execution_id and claim.claimant_id = p_claimant_id
			and claim.claimed_by_user_id = v_user_id
			and claim.completed_at is null and claim.claim_expires_at > statement_timestamp();
	else
		raise exception 'operation execution kind is invalid' using errcode = '22023';
	end if;
	if v_profile_id is null or not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'live operation claim is required' using errcode = '42501';
	end if;
	if p_operation_id is null or p_operation_kind !~ '^[a-z][a-z0-9_]{0,63}$'
		or p_input_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'operation receipt is invalid' using errcode = '22023';
	end if;
	-- One unresolved external effect fences the entire durable execution. A
	-- model/tool retry may choose another ordinal, but it cannot bypass an
	-- outcome-ambiguous receipt and perform the effect twice.
	perform pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(p_execution_kind || ':' || p_execution_id::text, 0)
	);
	select receipt.* into v_receipt
	from public.qorpera_operation_receipts as receipt
	where receipt.id = p_operation_id;
	if found then
		if v_receipt.profile_id <> v_profile_id
			or v_receipt.execution_kind <> p_execution_kind
			or v_receipt.execution_id <> p_execution_id
			or v_receipt.operation_kind <> p_operation_kind
			or v_receipt.input_sha256 <> p_input_sha256 then
			raise exception 'operation id is already bound to different content' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'started', false,
			'status', v_receipt.status,
			'result', v_receipt.result
		);
	end if;
	if exists (
		select 1
		from public.qorpera_operation_receipts as receipt
		where receipt.profile_id = v_profile_id
			and receipt.execution_kind = p_execution_kind
			and receipt.execution_id = p_execution_id
			and receipt.status = 'executing'
	) then
		raise exception 'execution has an unresolved operation receipt' using errcode = '55000';
	end if;
	insert into public.qorpera_operation_receipts (
		id, profile_id, execution_kind, execution_id, claimant_id, claimed_by_user_id, operation_kind, input_sha256
	) values (
		p_operation_id, v_profile_id, p_execution_kind, p_execution_id,
		p_claimant_id, v_user_id, p_operation_kind, p_input_sha256
	)
	returning * into v_receipt;
	v_started := true;
	return jsonb_build_object(
		'started', v_started,
		'status', v_receipt.status,
		'result', v_receipt.result
	);
end
$$;

create function public.qorpera_stage_operation_receipt_objects(
	p_execution_id uuid,
	p_claimant_id uuid,
	p_operation_id uuid,
	p_objects jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_receipt public.qorpera_operation_receipts%rowtype;
	v_object_count integer;
	v_inserted_count integer;
begin
	if p_objects is null or jsonb_typeof(p_objects) <> 'array'
		or jsonb_array_length(p_objects) not between 1 and 65
		or exists (
			select 1
			from jsonb_array_elements(p_objects) as item(value)
			where jsonb_typeof(item.value) <> 'object'
				or item.value - 'sha256' - 'bytes' <> '{}'::jsonb
				or item.value ->> 'sha256' !~ '^[0-9a-f]{64}$'
				or jsonb_typeof(item.value -> 'bytes') <> 'number'
				or (item.value ->> 'bytes')::numeric <> trunc((item.value ->> 'bytes')::numeric)
				or (item.value ->> 'bytes')::numeric not between 0 and 8388608
		) then
		raise exception 'operation receipt objects are invalid' using errcode = '22023';
	end if;
	select receipt.* into v_receipt
	from public.qorpera_operation_receipts as receipt
	where receipt.id = p_operation_id and receipt.execution_id = p_execution_id
	for update;
	if not found or not public.qorpera_can_write_profile(v_receipt.profile_id)
		or v_receipt.claimant_id <> p_claimant_id
		or v_receipt.claimed_by_user_id <> v_user_id
		or v_receipt.status <> 'executing' then
		raise exception 'live operation receipt ownership is required' using errcode = '42501';
	end if;
	select count(distinct item.value ->> 'sha256') into v_object_count
	from jsonb_array_elements(p_objects) as item(value);
	if v_object_count <> jsonb_array_length(p_objects) then
		raise exception 'operation receipt objects contain duplicates' using errcode = '22023';
	end if;
	insert into public.qorpera_operation_receipt_objects (receipt_id, profile_id, object_sha256, bytes)
	select v_receipt.id, v_receipt.profile_id, object.sha256, object.bytes
	from jsonb_array_elements(p_objects) as item(value)
	join public.qorpera_profile_objects as object
		on object.profile_id = v_receipt.profile_id
		and object.sha256 = item.value ->> 'sha256'
		and object.bytes = (item.value ->> 'bytes')::bigint
	on conflict (receipt_id, object_sha256) do update set bytes = excluded.bytes;
	get diagnostics v_inserted_count = row_count;
	if v_inserted_count <> v_object_count then
		raise exception 'operation receipt object is unavailable or has different bytes' using errcode = '23503';
	end if;
	return jsonb_build_object('staged', v_inserted_count);
end
$$;

create function public.qorpera_complete_operation_receipt(
	p_execution_id uuid,
	p_claimant_id uuid,
	p_operation_id uuid,
	p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_receipt public.qorpera_operation_receipts%rowtype;
begin
	if p_result is null or jsonb_typeof(p_result) <> 'object' or pg_column_size(p_result) > 524288 then
		raise exception 'operation result is invalid' using errcode = '22023';
	end if;
	select receipt.* into v_receipt
	from public.qorpera_operation_receipts as receipt
	where receipt.id = p_operation_id and receipt.execution_id = p_execution_id
	for update;
	if not found or not public.qorpera_can_write_profile(v_receipt.profile_id)
		or v_receipt.claimed_by_user_id <> v_user_id then
		raise exception 'operation receipt access is required' using errcode = '42501';
	end if;
	if v_receipt.status = 'completed' then
		if v_receipt.result <> p_result then
			raise exception 'operation result is already bound to different content' using errcode = '23505';
		end if;
		return v_receipt.result;
	end if;
	if v_receipt.claimant_id <> p_claimant_id then
		raise exception 'operation claimant changed before completion' using errcode = '42501';
	end if;
	if p_result ? 'cloudObjects' and (
		jsonb_typeof(p_result -> 'cloudObjects') <> 'array'
		or jsonb_array_length(p_result -> 'cloudObjects') <> (
			select count(*)
			from public.qorpera_operation_receipt_objects as object
			where object.receipt_id = v_receipt.id
		)
		or exists (
			select 1
			from jsonb_array_elements(p_result -> 'cloudObjects') as item(value)
			where not exists (
				select 1
				from public.qorpera_operation_receipt_objects as object
				where object.receipt_id = v_receipt.id
					and object.object_sha256 = item.value ->> 'sha256'
					and object.bytes = (item.value ->> 'bytes')::bigint
			)
		)
	) then
		raise exception 'operation result does not match its staged objects' using errcode = '23503';
	end if;
	update public.qorpera_operation_receipts
	set status = 'completed', result = p_result, completed_at = statement_timestamp()
	where id = p_operation_id
	returning * into v_receipt;
	return v_receipt.result;
end
$$;

create or replace function public.qorpera_renew_wake(
	p_environment_id uuid,
	p_wake_key text,
	p_claimant_id uuid,
	p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_profile_id uuid := public.qorpera_wake_profile_for_write(p_environment_id);
	v_renewed integer;
begin
	if p_lease_seconds is null or p_lease_seconds not between 15 and 900 then
		raise exception 'lease duration is invalid' using errcode = '22023';
	end if;
	update public.qorpera_wake_claims as claim
	set claim_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds)
	from public.qorpera_profile_staff as staff
	where claim.profile_id = v_profile_id
		and claim.wake_key = btrim(p_wake_key)
		and claim.claimant_id = p_claimant_id
		and claim.claimed_by_user_id = v_user_id
		and claim.completed_at is null
		and claim.claim_expires_at > statement_timestamp()
		and staff.profile_id = claim.profile_id
		and staff.staff_agent_id = claim.staff_agent_id
		and staff.employment_status = 'active';
	get diagnostics v_renewed = row_count;
	return jsonb_build_object('renewed', v_renewed);
end
$$;

create or replace function public.qorpera_complete_wake(
	p_environment_id uuid,
	p_wake_key text,
	p_claimant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_profile_id uuid := public.qorpera_wake_profile_for_write(p_environment_id);
	v_completed integer;
begin
	if exists (
		select 1
		from public.qorpera_wake_claims as claim
		join public.qorpera_operation_receipts as receipt
			on receipt.profile_id = claim.profile_id
			and receipt.execution_kind = 'wake'
			and receipt.execution_id = claim.execution_id
		where claim.profile_id = v_profile_id
			and claim.wake_key = btrim(p_wake_key)
			and claim.claimant_id = p_claimant_id
			and claim.claimed_by_user_id = v_user_id
			and receipt.status = 'executing'
	) then
		raise exception 'wake has an unresolved operation receipt' using errcode = '55000';
	end if;
	update public.qorpera_wake_claims as claim
	set completed_at = statement_timestamp()
	from public.qorpera_profile_staff as staff
	where claim.profile_id = v_profile_id
		and claim.wake_key = btrim(p_wake_key)
		and claim.claimant_id = p_claimant_id
		and claim.claimed_by_user_id = v_user_id
		and claim.completed_at is null
		and claim.claim_expires_at > statement_timestamp()
		and staff.profile_id = claim.profile_id
		and staff.staff_agent_id = claim.staff_agent_id
		and staff.employment_status = 'active';
	get diagnostics v_completed = row_count;
	return jsonb_build_object('completed', v_completed);
end
$$;

drop function public.qorpera_append_account_event(uuid, uuid, text, jsonb, bigint);

create function public.qorpera_append_account_event(
	p_session_id uuid,
	p_event_id uuid,
	p_event_type text,
	p_body jsonb,
	p_expected_sequence bigint default null,
	p_execution_kind text default null,
	p_execution_id uuid default null,
	p_execution_claimant_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_session public.qorpera_shared_sessions%rowtype;
	v_existing public.qorpera_session_events%rowtype;
	v_sequence bigint := 0;
	v_previous_hash text;
	v_event_hash text;
	v_created_at timestamptz := statement_timestamp();
	v_execution_valid boolean := false;
	v_body_schema text;
	v_entry jsonb;
	v_entry_type text;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if p_event_type not in (
		'message',
		'session_info',
		'run_receipt',
		'artifact_receipt',
		'authorization_request',
		'authorization_decision'
	) then
		raise exception 'session event type is invalid' using errcode = '22023';
	end if;
	if p_body is null
		or jsonb_typeof(p_body) <> 'object'
		or octet_length(convert_to(p_body::text, 'utf8')) > 262144 then
		raise exception 'session event body is invalid or too large' using errcode = '22023';
	end if;
	if (p_execution_kind is null) is distinct from (p_execution_id is null)
		or (p_execution_kind is null) is distinct from (p_execution_claimant_id is null)
		or (p_execution_kind is not null and p_execution_kind not in ('turn', 'wake')) then
		raise exception 'session event execution identity is invalid' using errcode = '22023';
	end if;
	if p_execution_kind is null and p_event_type <> 'session_info' then
		raise exception 'content-bearing session events require a durable execution' using errcode = '42501';
	end if;

	-- Account-authored trail events use one of two closed envelopes. Session
	-- metadata is the only unbound event, and multipart content must be tied to
	-- a live execution. In particular, an outer session_info event must never
	-- smuggle an assembled message past the execution fence.
	v_body_schema := p_body ->> 'schema';
	if v_body_schema = 'qorpera.shared-session/v1' then
		v_entry := p_body -> 'entry';
		if jsonb_typeof(v_entry) <> 'object' then
			raise exception 'session metadata body is invalid' using errcode = '22023';
		end if;
		if p_event_type <> 'session_info'
			or not (p_body ?& array['schema', 'entry'])
			or (p_body - 'schema' - 'entry') <> '{}'::jsonb
			or not (v_entry ?& array['type', 'id', 'parentId', 'timestamp', 'name'])
			or (v_entry - 'type' - 'id' - 'parentId' - 'timestamp' - 'name') <> '{}'::jsonb
			or v_entry ->> 'type' <> 'session_info'
			or jsonb_typeof(v_entry -> 'id') <> 'string'
			or char_length(v_entry ->> 'id') not between 1 and 512
			or jsonb_typeof(v_entry -> 'parentId') not in ('null', 'string')
			or jsonb_typeof(v_entry -> 'timestamp') <> 'string'
			or char_length(v_entry ->> 'timestamp') not between 1 and 64
			or jsonb_typeof(v_entry -> 'name') <> 'string'
			or char_length(v_entry ->> 'name') not between 1 and 256 then
			raise exception 'session metadata body is invalid' using errcode = '22023';
		end if;
	elsif v_body_schema = 'qorpera.shared-trail-entry-part/v1' then
		v_entry_type := p_body ->> 'entryType';
		if p_execution_kind is null then
			raise exception 'multipart session events require a durable execution' using errcode = '42501';
		end if;
		if not (p_body ?& array['schema', 'entryId', 'entryType', 'partIndex', 'partCount', 'payloadBase64'])
			or (p_body - 'schema' - 'entryId' - 'entryType' - 'partIndex' - 'partCount' - 'payloadBase64') <> '{}'::jsonb
			or jsonb_typeof(p_body -> 'entryId') <> 'string'
			or char_length(p_body ->> 'entryId') not between 1 and 512
			or jsonb_typeof(p_body -> 'entryType') <> 'string'
			or char_length(v_entry_type) not between 1 and 128
			or jsonb_typeof(p_body -> 'partIndex') <> 'number'
			or (p_body ->> 'partIndex') !~ '^(0|[1-9][0-9]*)$'
			or jsonb_typeof(p_body -> 'partCount') <> 'number'
			or (p_body ->> 'partCount') !~ '^[1-9][0-9]*$'
			or jsonb_typeof(p_body -> 'payloadBase64') <> 'string'
			or char_length(p_body ->> 'payloadBase64') not between 4 and 240000
			or char_length(p_body ->> 'payloadBase64') % 4 <> 0
			or (p_body ->> 'payloadBase64') !~ '^[A-Za-z0-9+/]*={0,2}$'
			or (p_event_type = 'message' and v_entry_type <> 'message')
			or (p_event_type = 'session_info' and v_entry_type = 'message')
			or (p_event_type not in ('message', 'session_info') and v_entry_type <> 'custom') then
			raise exception 'session entry part body is invalid' using errcode = '22023';
		end if;
		if (p_body ->> 'partIndex')::numeric < 0
			or (p_body ->> 'partCount')::numeric > 128
			or (p_body ->> 'partIndex')::numeric >= (p_body ->> 'partCount')::numeric then
			raise exception 'session entry part body is invalid' using errcode = '22023';
		end if;
	else
		raise exception 'session event schema is invalid' using errcode = '22023';
	end if;
	if p_execution_kind is null then
		select session.* into v_session
		from public.qorpera_shared_sessions as session
		where session.id = p_session_id;
		if not found or not public.qorpera_can_write_profile(v_session.profile_id) then
			raise exception 'profile write access is required' using errcode = '42501';
		end if;
		if p_body #>> '{entry,id}' <> 'cloud-session-info:' || v_session.client_session_id::text
			or p_body #>> '{entry,name}' <> v_session.title
			or jsonb_typeof(p_body #> '{entry,parentId}') <> 'null' then
			raise exception 'session metadata does not match the hosted session' using errcode = '22023';
		end if;
		begin
			if (p_body #>> '{entry,timestamp}')::timestamptz is distinct from v_session.created_at then
				raise exception 'session metadata does not match the hosted session' using errcode = '22023';
			end if;
		exception when invalid_datetime_format or datetime_field_overflow then
			raise exception 'session metadata does not match the hosted session' using errcode = '22023';
		end;
	end if;

	select event.* into v_existing
	from public.qorpera_session_events as event
	where event.event_id = p_event_id;
	if found then
		if v_existing.session_id <> p_session_id
			or v_existing.event_type <> p_event_type
			or v_existing.body <> p_body
			or v_existing.execution_kind is distinct from p_execution_kind
			or v_existing.execution_id is distinct from p_execution_id
			or v_existing.execution_claimant_id is distinct from p_execution_claimant_id then
			raise exception 'event id is already bound to different content' using errcode = '23505';
		end if;
		if v_existing.actor_user_id <> v_user_id and p_execution_kind is not null then
			raise exception 'session event belongs to another member' using errcode = '42501';
		end if;
		if not public.qorpera_can_write_profile(public.qorpera_session_profile_id(p_session_id)) then
			raise exception 'profile write access is required' using errcode = '42501';
		end if;
		if p_event_type = 'authorization_decision'
			and not public.qorpera_can_authorize_profile(public.qorpera_session_profile_id(p_session_id)) then
			raise exception 'authorization requires full access' using errcode = '42501';
		end if;
		return jsonb_build_object(
			'session_id', v_existing.session_id,
			'sequence', v_existing.sequence,
			'event_id', v_existing.event_id,
			'event_type', v_existing.event_type,
			'actor_user_id', v_existing.actor_user_id,
			'body', v_existing.body,
			'previous_hash', v_existing.previous_hash,
			'event_hash', v_existing.event_hash,
			'execution_kind', v_existing.execution_kind,
			'execution_id', v_existing.execution_id,
			'execution_claimant_id', v_existing.execution_claimant_id,
			'created_at', v_existing.created_at
		);
	end if;

	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
	if not found or not public.qorpera_can_write_profile(v_session.profile_id) then
		raise exception 'profile write access is required' using errcode = '42501';
	end if;
	if v_session.status <> 'open' then
		raise exception 'session is closed' using errcode = '55000';
	end if;
	if p_event_type = 'authorization_decision' and not public.qorpera_can_authorize_profile(v_session.profile_id) then
		raise exception 'authorization requires full access' using errcode = '42501';
	end if;

	if p_execution_kind = 'turn' then
		select exists (
			select 1
			from public.qorpera_session_turns as turn
			where turn.id = p_execution_id
				and turn.session_id = p_session_id
				and turn.claimant_id = p_execution_claimant_id
				and turn.claimed_by_user_id = v_user_id
				and turn.status = 'active'
				and turn.lease_expires_at > statement_timestamp()
				and turn.company_snapshot_id = v_session.company_snapshot_id
				and turn.staff_version = v_session.staff_version
		) into v_execution_valid;
	elsif p_execution_kind = 'wake' then
		select exists (
			select 1
			from public.qorpera_wake_claims as claim
			where claim.execution_id = p_execution_id
				and claim.profile_id = v_session.profile_id
				and claim.claimant_id = p_execution_claimant_id
				and claim.claimed_by_user_id = v_user_id
				and claim.completed_at is null
				and claim.claim_expires_at > statement_timestamp()
				and claim.company_snapshot_id = v_session.company_snapshot_id
				and claim.staff_version = v_session.staff_version
				and (
					v_session.staff_agent_id is null
					or v_session.staff_agent_id = claim.staff_agent_id::text
				)
		) into v_execution_valid;
	else
		v_execution_valid := p_event_type = 'session_info';
	end if;
	if not v_execution_valid then
		raise exception 'live trail execution claim is required' using errcode = '42501';
	end if;

	select event.sequence, event.event_hash
	into v_sequence, v_previous_hash
	from public.qorpera_session_events as event
	where event.session_id = p_session_id
	order by event.sequence desc
	limit 1;
	v_sequence := coalesce(v_sequence, 0);
	if p_expected_sequence is not null and p_expected_sequence <> v_sequence then
		raise exception 'session event sequence changed' using errcode = '40001';
	end if;
	v_sequence := v_sequence + 1;
	v_event_hash := encode(
		extensions.digest(
			convert_to(
				coalesce(v_previous_hash, '') || E'\n' || jsonb_build_object(
					'session_id', p_session_id,
					'sequence', v_sequence,
					'event_id', p_event_id,
					'event_type', p_event_type,
					'actor_user_id', v_user_id,
					'body', p_body,
					'execution_kind', p_execution_kind,
					'execution_id', p_execution_id,
					'execution_claimant_id', p_execution_claimant_id,
					'created_at', v_created_at
				)::text,
				'utf8'
			),
			'sha256'
		),
		'hex'
	);

	insert into public.qorpera_session_events (
		session_id, sequence, event_id, event_type, actor_user_id, body,
		previous_hash, event_hash, execution_kind, execution_id,
		execution_claimant_id, created_at
	) values (
		p_session_id, v_sequence, p_event_id, p_event_type, v_user_id, p_body,
		v_previous_hash, v_event_hash, p_execution_kind, p_execution_id,
		p_execution_claimant_id, v_created_at
	);
	update public.qorpera_shared_sessions set updated_at = v_created_at where id = p_session_id;

	return jsonb_build_object(
		'session_id', p_session_id,
		'sequence', v_sequence,
		'event_id', p_event_id,
		'event_type', p_event_type,
		'actor_user_id', v_user_id,
		'body', p_body,
		'previous_hash', v_previous_hash,
		'event_hash', v_event_hash,
		'execution_kind', p_execution_kind,
		'execution_id', p_execution_id,
		'execution_claimant_id', p_execution_claimant_id,
		'created_at', v_created_at
	);
end
$$;

create function public.qorpera_company_proposal_json(p_proposal public.qorpera_company_proposals)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'proposal_id', p_proposal.id,
		'profile_id', p_proposal.profile_id,
		'environment_id', p_proposal.environment_id,
		'client_proposal_id', p_proposal.client_proposal_id,
		'base_snapshot_id', p_proposal.base_snapshot_id,
		'proposal_snapshot', public.qorpera_company_snapshot_json(snapshot),
		'execution_kind', p_proposal.execution_kind,
		'execution_id', p_proposal.execution_id,
		'session_id', p_proposal.session_id,
		'trail_end_sequence', p_proposal.trail_end_sequence,
		'reason', p_proposal.reason,
		'policy_key', p_proposal.policy_key,
		'title', p_proposal.title,
		'reviewer_staff_ids', to_jsonb(p_proposal.reviewer_staff_ids),
		'status', p_proposal.status,
		'created_by_user_id', p_proposal.created_by_user_id,
		'created_by_name', coalesce(member.display_name, 'Former company member'),
		'created_at', p_proposal.created_at,
		'resolved_by_user_id', p_proposal.resolved_by_user_id,
		'resolved_at', p_proposal.resolved_at
	)
	from public.qorpera_company_snapshots as snapshot
	left join public.qorpera_profile_members as member
		on member.profile_id = p_proposal.profile_id and member.user_id = p_proposal.created_by_user_id
	where snapshot.id = p_proposal.proposal_snapshot_id
$$;

revoke all on function public.qorpera_company_proposal_json(public.qorpera_company_proposals)
	from public, anon, authenticated;

create function public.qorpera_submit_company_proposal(
	p_environment_id uuid,
	p_client_proposal_id uuid,
	p_proposal_snapshot_id uuid,
	p_execution_kind text,
	p_execution_id uuid,
	p_execution_claimant_id uuid,
	p_session_id uuid,
	p_trail_end_sequence bigint,
	p_reason text,
	p_policy_key text,
	p_title text,
	p_reviewer_staff_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_file public.qorpera_company_files%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_publication public.qorpera_company_snapshot_publications%rowtype;
	v_turn public.qorpera_session_turns%rowtype;
	v_wake public.qorpera_wake_claims%rowtype;
	v_session public.qorpera_shared_sessions%rowtype;
	v_proposal public.qorpera_company_proposals%rowtype;
	v_base_snapshot_id uuid;
	v_completed integer;
begin
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for share;
	if v_user_id is null or not found or not public.qorpera_can_write_profile(v_file.profile_id) then
		raise exception 'company proposal write access is required' using errcode = '42501';
	end if;
	if p_client_proposal_id is null or p_proposal_snapshot_id is null
		or p_execution_kind not in ('turn', 'wake')
		or p_execution_id is null or p_execution_claimant_id is null
		or p_session_id is null or p_trail_end_sequence < 0
		or p_reason not in ('policy', 'authority', 'conflict', 'recovery')
		or char_length(btrim(p_title)) not between 1 and 256
		or (p_policy_key is not null and char_length(btrim(p_policy_key)) not between 1 and 128)
		or cardinality(coalesce(p_reviewer_staff_ids, '{}'::uuid[])) > 20 then
		raise exception 'company proposal is invalid' using errcode = '22023';
	end if;
	-- A committed submission may have transitioned the execution before its
	-- response reached the client. Resolve exact replays before requiring the
	-- now-finished lease so retry remains idempotent after process/network loss.
	select proposal.* into v_proposal
	from public.qorpera_company_proposals as proposal
	where proposal.profile_id = v_file.profile_id
		and proposal.client_proposal_id = p_client_proposal_id;
	if found then
		if v_proposal.proposal_snapshot_id <> p_proposal_snapshot_id
			or v_proposal.execution_kind <> p_execution_kind
			or v_proposal.execution_id <> p_execution_id
			or v_proposal.execution_claimant_id <> p_execution_claimant_id
			or v_proposal.session_id <> p_session_id
			or v_proposal.trail_end_sequence <> p_trail_end_sequence
			or v_proposal.reason <> p_reason
			or v_proposal.policy_key is distinct from nullif(btrim(p_policy_key), '')
			or v_proposal.title <> btrim(p_title)
			or v_proposal.reviewer_staff_ids is distinct from coalesce(p_reviewer_staff_ids, '{}'::uuid[])
			or v_proposal.created_by_user_id <> v_user_id then
			raise exception 'company proposal id is already bound to different content' using errcode = '23505';
		end if;
		return public.qorpera_company_proposal_json(v_proposal);
	end if;
	if exists (
		select 1 from unnest(coalesce(p_reviewer_staff_ids, '{}'::uuid[])) as requested(staff_agent_id)
		where not exists (
			select 1 from public.qorpera_profile_staff as staff
			where staff.profile_id = v_file.profile_id
				and staff.staff_agent_id = requested.staff_agent_id
				and staff.employment_status = 'active'
		)
	) then
		raise exception 'company proposal reviewer is unavailable' using errcode = '22023';
	end if;
	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	join public.qorpera_company_snapshot_publications as publication on publication.snapshot_id = snapshot.id
	where snapshot.id = p_proposal_snapshot_id
		and snapshot.profile_id = v_file.profile_id
		and snapshot.environment_id = v_file.environment_id
		and snapshot.workspace_id = v_file.canonical_workspace_id
		and publication.status = 'prepared';
	if not found then
		raise exception 'company proposal snapshot is not durably verified' using errcode = '55000';
	end if;
	select publication.* into strict v_publication
	from public.qorpera_company_snapshot_publications as publication
	where publication.snapshot_id = v_snapshot.id;
	if not public.qorpera_object_root_has_current_proof('company_snapshot', v_snapshot.id)
		or v_publication.restricted_content_sha256 is null then
		raise exception 'company proposal snapshot is not durably verified' using errcode = '55000';
	end if;
	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id and session.profile_id = v_file.profile_id;
	if not found then
		raise exception 'company proposal session is invalid' using errcode = '22023';
	end if;

	if p_execution_kind = 'turn' then
		select turn.* into v_turn
		from public.qorpera_session_turns as turn
		where turn.id = p_execution_id and turn.session_id = p_session_id
		for update;
		if not found or v_turn.claimant_id <> p_execution_claimant_id
			or v_turn.claimed_by_user_id <> v_user_id
			or v_turn.status <> 'active'
			or v_turn.lease_expires_at <= statement_timestamp() then
			raise exception 'live proposal execution is required' using errcode = '42501';
		end if;
		v_base_snapshot_id := v_turn.company_snapshot_id;
		if p_trail_end_sequence < v_turn.trail_start_sequence
			or (p_trail_end_sequence > 0 and not exists (
				select 1 from public.qorpera_session_events as event
				where event.session_id = p_session_id and event.sequence = p_trail_end_sequence
			))
			or exists (
				select 1 from public.qorpera_session_events as event
				where event.session_id = p_session_id
					and event.sequence > v_turn.trail_start_sequence
					and event.sequence <= p_trail_end_sequence
					and (
						event.execution_kind is distinct from 'turn'
						or event.execution_id is distinct from v_turn.id
						or event.execution_claimant_id is distinct from v_turn.claimant_id
					)
			)
			or (
				select count(*) from public.qorpera_session_events as event
				where event.session_id = p_session_id
					and event.sequence > v_turn.trail_start_sequence
					and event.sequence <= p_trail_end_sequence
			) <> p_trail_end_sequence - v_turn.trail_start_sequence then
			raise exception 'company proposal trail boundary is invalid' using errcode = '22023';
		end if;
	else
		select claim.* into v_wake
		from public.qorpera_wake_claims as claim
		where claim.execution_id = p_execution_id and claim.profile_id = v_file.profile_id
		for update;
		if not found or v_wake.claimant_id <> p_execution_claimant_id
			or v_wake.claimed_by_user_id <> v_user_id
			or v_wake.completed_at is not null
			or v_wake.claim_expires_at <= statement_timestamp() then
			raise exception 'live proposal execution is required' using errcode = '42501';
		end if;
		v_base_snapshot_id := v_wake.company_snapshot_id;
		if exists (
			select 1 from public.qorpera_session_events as event
			where event.session_id = p_session_id and event.sequence <= p_trail_end_sequence
				and event.event_type <> 'session_info'
				and (
					event.execution_kind is distinct from 'wake'
					or event.execution_id is distinct from v_wake.execution_id
					or event.execution_claimant_id is distinct from v_wake.claimant_id
				)
		) then
			raise exception 'company proposal trail boundary is invalid' using errcode = '22023';
		end if;
	end if;
	if v_snapshot.parent_snapshot_id is distinct from v_base_snapshot_id
		or v_publication.expected_head_snapshot_id is distinct from v_base_snapshot_id then
		raise exception 'company proposal does not match its execution snapshot' using errcode = '22023';
	end if;
	if exists (
		select 1 from public.qorpera_operation_receipts as receipt
		where receipt.profile_id = v_file.profile_id
			and receipt.execution_kind = p_execution_kind
			and receipt.execution_id = p_execution_id
			and receipt.status = 'executing'
	) then
		raise exception 'company proposal has an unresolved operation receipt' using errcode = '55000';
	end if;

	insert into public.qorpera_company_proposals (
		profile_id, environment_id, client_proposal_id, base_snapshot_id,
		proposal_snapshot_id, execution_kind, execution_id, execution_claimant_id,
		session_id, trail_end_sequence, reason, policy_key, title,
		reviewer_staff_ids, created_by_user_id
	) values (
		v_file.profile_id, v_file.environment_id, p_client_proposal_id, v_base_snapshot_id,
		v_snapshot.id, p_execution_kind, p_execution_id, p_execution_claimant_id,
		p_session_id, p_trail_end_sequence, p_reason, nullif(btrim(p_policy_key), ''),
		btrim(p_title), coalesce(p_reviewer_staff_ids, '{}'::uuid[]), v_user_id
	)
	on conflict (profile_id, client_proposal_id) do nothing
	returning * into v_proposal;
	if not found then
		select proposal.* into strict v_proposal
		from public.qorpera_company_proposals as proposal
		where proposal.profile_id = v_file.profile_id and proposal.client_proposal_id = p_client_proposal_id;
		if v_proposal.proposal_snapshot_id <> p_proposal_snapshot_id
			or v_proposal.execution_kind <> p_execution_kind
			or v_proposal.execution_id <> p_execution_id
			or v_proposal.execution_claimant_id <> p_execution_claimant_id
			or v_proposal.session_id <> p_session_id
			or v_proposal.trail_end_sequence <> p_trail_end_sequence
			or v_proposal.reason <> p_reason
			or v_proposal.policy_key is distinct from nullif(btrim(p_policy_key), '')
			or v_proposal.title <> btrim(p_title)
			or v_proposal.reviewer_staff_ids is distinct from coalesce(p_reviewer_staff_ids, '{}'::uuid[])
			or v_proposal.created_by_user_id <> v_user_id then
			raise exception 'company proposal id is already bound to different content' using errcode = '23505';
		end if;
		return public.qorpera_company_proposal_json(v_proposal);
	end if;

	if p_execution_kind = 'turn' then
		update public.qorpera_session_inputs
		set completed_at = statement_timestamp(), claim_expires_at = null
		where turn_id = p_execution_id and completed_at is null and failed_at is null;
		get diagnostics v_completed = row_count;
		if v_completed <> cardinality(v_turn.input_ids) then
			raise exception 'company proposal inputs changed before submission' using errcode = '40001';
		end if;
		update public.qorpera_session_turns
		set status = 'review_pending', completed_at = statement_timestamp(),
			trail_end_sequence = p_trail_end_sequence
		where id = p_execution_id;
	else
		update public.qorpera_wake_claims
		set completed_at = statement_timestamp()
		where execution_id = p_execution_id;
	end if;
	return public.qorpera_company_proposal_json(v_proposal);
end
$$;

create function public.qorpera_list_company_proposals(
	p_environment_id uuid,
	p_status text default 'open',
	p_after_created_at timestamptz default null,
	p_after_id uuid default null,
	p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
begin
	select file.profile_id into v_profile_id
	from public.qorpera_company_files as file where file.environment_id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'company proposal read access is required' using errcode = '42501';
	end if;
	if p_status not in ('open', 'accepted', 'rejected') or p_limit not between 1 and 100
		or ((p_after_created_at is null) is distinct from (p_after_id is null)) then
		raise exception 'company proposal page is invalid' using errcode = '22023';
	end if;
	return (
		with visible as (
			select proposal.*
			from public.qorpera_company_proposals as proposal
			where proposal.environment_id = p_environment_id and proposal.status = p_status
				and (p_after_created_at is null or (proposal.created_at, proposal.id) < (p_after_created_at, p_after_id))
			order by proposal.created_at desc, proposal.id desc
			limit p_limit + 1
		), page as (
			select * from visible order by created_at desc, id desc limit p_limit
		)
		select jsonb_build_object(
			'items', coalesce((select jsonb_agg(public.qorpera_company_proposal_json(proposal)
				order by proposal.created_at desc, proposal.id desc) from page as proposal), '[]'::jsonb),
			'has_more', (select count(*) > p_limit from visible),
			'next_created_at', (select min(created_at) from page),
			'next_id', (select id from page order by created_at, id limit 1)
		)
	);
end
$$;

create function public.qorpera_accept_company_proposal(
	p_proposal_id uuid,
	p_expected_proposal_snapshot_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_proposal public.qorpera_company_proposals%rowtype;
begin
	select proposal.* into v_proposal
	from public.qorpera_company_proposals as proposal
	where proposal.id = p_proposal_id
	for update;
	if not found or not public.qorpera_can_authorize_profile(v_proposal.profile_id) then
		raise exception 'company proposal authorization is required' using errcode = '42501';
	end if;
	if v_proposal.proposal_snapshot_id is distinct from p_expected_proposal_snapshot_id then
		raise exception 'company proposal changed before acceptance' using errcode = '40001';
	end if;
	if v_proposal.status = 'accepted' then
		return public.qorpera_company_proposal_json(v_proposal);
	end if;
	if v_proposal.status <> 'open' then
		raise exception 'company proposal was resolved before acceptance' using errcode = '40001';
	end if;
	update public.qorpera_company_proposals
	set status = 'accepted', resolved_by_user_id = v_user_id, resolved_at = statement_timestamp()
	where id = v_proposal.id
	returning * into v_proposal;
	perform public.qorpera_publish_company_file_revision(
		v_proposal.environment_id, v_proposal.proposal_snapshot_id, v_proposal.base_snapshot_id
	);
	return public.qorpera_company_proposal_json(v_proposal);
end
$$;

create function public.qorpera_rebase_company_proposal(
	p_proposal_id uuid,
	p_expected_proposal_snapshot_id uuid,
	p_expected_head_snapshot_id uuid,
	p_replacement_snapshot_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_proposal public.qorpera_company_proposals%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_publication public.qorpera_company_snapshot_publications%rowtype;
	v_revision bigint;
begin
	select proposal.* into v_proposal
	from public.qorpera_company_proposals as proposal
	where proposal.id = p_proposal_id for update;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_proposal.profile_id) then
		raise exception 'company proposal rebase authorization is required' using errcode = '42501';
	end if;
	if v_proposal.status <> 'open'
		or v_proposal.proposal_snapshot_id is distinct from p_expected_proposal_snapshot_id
		or p_replacement_snapshot_id is null
		or p_replacement_snapshot_id = v_proposal.proposal_snapshot_id then
		raise exception 'company proposal changed before rebase' using errcode = '40001';
	end if;
	select file.* into strict v_file
	from public.qorpera_company_files as file
	where file.profile_id = v_proposal.profile_id
		and file.environment_id = v_proposal.environment_id
	for update;
	if v_file.head_snapshot_id is distinct from p_expected_head_snapshot_id then
		raise exception 'company head changed before proposal rebase' using errcode = '40001';
	end if;
	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	where snapshot.id = p_replacement_snapshot_id
		and snapshot.profile_id = v_proposal.profile_id
		and snapshot.environment_id = v_proposal.environment_id
		and snapshot.workspace_id = v_file.canonical_workspace_id;
	select publication.* into v_publication
	from public.qorpera_company_snapshot_publications as publication
	where publication.snapshot_id = p_replacement_snapshot_id;
	if v_snapshot.id is null or v_publication.snapshot_id is null
		or v_snapshot.parent_snapshot_id is distinct from v_file.head_snapshot_id
		or v_publication.expected_head_snapshot_id is distinct from v_file.head_snapshot_id
		or v_publication.status <> 'prepared'
		or v_publication.restricted_content_sha256 is null
		or not public.qorpera_object_root_has_current_proof('company_snapshot', v_snapshot.id) then
		raise exception 'rebased company proposal is not durably verified' using errcode = '55000';
	end if;
	select coalesce(max(revision), 0) + 1 into v_revision
	from public.qorpera_company_proposal_revisions
	where proposal_id = v_proposal.id;
	insert into public.qorpera_company_proposal_revisions (
		proposal_id, revision, base_snapshot_id, proposal_snapshot_id,
		change_kind, created_by_user_id
	) values (
		v_proposal.id, v_revision, v_file.head_snapshot_id, v_snapshot.id,
		'rebased', v_user_id
	);
	update public.qorpera_company_proposals
	set base_snapshot_id = v_file.head_snapshot_id,
		proposal_snapshot_id = v_snapshot.id
	where id = v_proposal.id
	returning * into v_proposal;
	return public.qorpera_company_proposal_json(v_proposal);
end
$$;

create function public.qorpera_get_company_proposal(p_proposal_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_proposal public.qorpera_company_proposals%rowtype;
begin
	select proposal.* into v_proposal
	from public.qorpera_company_proposals as proposal where proposal.id = p_proposal_id;
	if not found or not public.qorpera_can_read_profile(v_proposal.profile_id) then
		raise exception 'company proposal read access is required' using errcode = '42501';
	end if;
	return public.qorpera_company_proposal_json(v_proposal);
end
$$;

create function public.qorpera_reject_company_proposal(
	p_proposal_id uuid,
	p_expected_proposal_snapshot_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_proposal public.qorpera_company_proposals%rowtype;
begin
	select proposal.* into v_proposal
	from public.qorpera_company_proposals as proposal
	where proposal.id = p_proposal_id
	for update;
	if not found or not public.qorpera_can_authorize_profile(v_proposal.profile_id) then
		raise exception 'company proposal authorization is required' using errcode = '42501';
	end if;
	if v_proposal.proposal_snapshot_id is distinct from p_expected_proposal_snapshot_id then
		raise exception 'company proposal changed before rejection' using errcode = '40001';
	end if;
	if v_proposal.status = 'rejected' then
		return public.qorpera_company_proposal_json(v_proposal);
	end if;
	if v_proposal.status <> 'open' then
		raise exception 'company proposal was resolved before rejection' using errcode = '40001';
	end if;
	update public.qorpera_company_proposals
	set status = 'rejected', resolved_by_user_id = v_user_id, resolved_at = statement_timestamp()
	where id = v_proposal.id
	returning * into v_proposal;
	return public.qorpera_company_proposal_json(v_proposal);
end
$$;

create function public.qorpera_append_company_proposal_comment(
	p_proposal_id uuid,
	p_client_comment_id uuid,
	p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_proposal public.qorpera_company_proposals%rowtype;
	v_comment public.qorpera_company_proposal_comments%rowtype;
begin
	select proposal.* into v_proposal
	from public.qorpera_company_proposals as proposal where proposal.id = p_proposal_id;
	if v_user_id is null or not found or not public.qorpera_can_read_profile(v_proposal.profile_id) then
		raise exception 'company proposal comment access is required' using errcode = '42501';
	end if;
	if p_client_comment_id is null or char_length(btrim(p_body)) not between 1 and 16384 then
		raise exception 'company proposal comment is invalid' using errcode = '22023';
	end if;
	insert into public.qorpera_company_proposal_comments (
		proposal_id, client_comment_id, body, author_user_id
	) values (
		v_proposal.id, p_client_comment_id, btrim(p_body), v_user_id
	)
	on conflict (proposal_id, client_comment_id) do nothing
	returning * into v_comment;
	if not found then
		select comment.* into strict v_comment
		from public.qorpera_company_proposal_comments as comment
		where comment.proposal_id = v_proposal.id and comment.client_comment_id = p_client_comment_id;
		if v_comment.author_user_id <> v_user_id or v_comment.body <> btrim(p_body) then
			raise exception 'company proposal comment id is already bound to different content' using errcode = '23505';
		end if;
	end if;
	return jsonb_build_object(
		'comment_id', v_comment.id,
		'proposal_id', v_comment.proposal_id,
		'body', v_comment.body,
		'author_user_id', v_comment.author_user_id,
		'author_name', coalesce((
			select member.display_name
			from public.qorpera_profile_members as member
			where member.profile_id = v_proposal.profile_id and member.user_id = v_comment.author_user_id
		), 'Former company member'),
		'created_at', v_comment.created_at
	);
end
$$;

create function public.qorpera_list_company_proposal_comments(
	p_proposal_id uuid,
	p_after_created_at timestamptz default null,
	p_after_id uuid default null,
	p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
begin
	select proposal.profile_id into v_profile_id
	from public.qorpera_company_proposals as proposal where proposal.id = p_proposal_id;
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'company proposal comment access is required' using errcode = '42501';
	end if;
	if p_limit not between 1 and 100 or ((p_after_created_at is null) is distinct from (p_after_id is null)) then
		raise exception 'company proposal comment page is invalid' using errcode = '22023';
	end if;
	return (
		with visible as (
			select comment.*, coalesce(member.display_name, 'Former company member') as author_name
			from public.qorpera_company_proposal_comments as comment
			left join public.qorpera_profile_members as member
				on member.profile_id = v_profile_id and member.user_id = comment.author_user_id
			where comment.proposal_id = p_proposal_id
				and (p_after_created_at is null or (comment.created_at, comment.id) > (p_after_created_at, p_after_id))
			order by comment.created_at, comment.id
			limit p_limit + 1
		), page as (
			select * from visible order by created_at, id limit p_limit
		)
		select jsonb_build_object(
			'items', coalesce((select jsonb_agg(jsonb_build_object(
				'comment_id', comment.id,
				'proposal_id', comment.proposal_id,
				'body', comment.body,
				'author_user_id', comment.author_user_id,
				'author_name', comment.author_name,
				'created_at', comment.created_at
			) order by comment.created_at, comment.id) from page as comment), '[]'::jsonb),
			'has_more', (select count(*) > p_limit from visible),
			'next_created_at', (select max(created_at) from page),
			'next_id', (select id from page order by created_at desc, id desc limit 1)
		)
	);
end
$$;

-- Realtime presence payloads carry only an opaque device id. This registry is
-- the authenticated binding from that device id to the current profile member;
-- display identity is always resolved from membership, never client claims.
create table public.qorpera_presence_devices (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	client_id uuid not null,
	user_id uuid not null references auth.users(id) on delete cascade,
	public_key text not null check (public_key ~ '^[A-Za-z0-9+/]{40,240}={0,2}$'),
	last_seen_at timestamptz not null default statement_timestamp(),
	primary key (profile_id, client_id)
);

create index qorpera_presence_devices_expiry
	on public.qorpera_presence_devices (last_seen_at);
alter table public.qorpera_presence_devices enable row level security;
revoke all on public.qorpera_presence_devices from anon, authenticated;

create function public.qorpera_register_presence_device(p_profile_id uuid, p_client_id uuid, p_public_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_name text;
	v_registered integer;
begin
	if v_user_id is null or p_client_id is null or p_public_key !~ '^[A-Za-z0-9+/]{40,240}={0,2}$'
		or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'profile presence access is required' using errcode = '42501';
	end if;
	select coalesce(member.display_name, 'Company member') into v_name
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	insert into public.qorpera_presence_devices (profile_id, client_id, user_id, public_key)
	values (p_profile_id, p_client_id, v_user_id, p_public_key)
	on conflict (profile_id, client_id) do update
	set user_id = excluded.user_id, public_key = excluded.public_key, last_seen_at = statement_timestamp()
	where qorpera_presence_devices.user_id = excluded.user_id
		or qorpera_presence_devices.last_seen_at < statement_timestamp() - interval '5 minutes';
	get diagnostics v_registered = row_count;
	if v_registered <> 1 then
		raise exception 'presence device id is already active' using errcode = '23505';
	end if;
	delete from public.qorpera_presence_devices
	where last_seen_at < statement_timestamp() - interval '5 minutes';
	return jsonb_build_object(
		'client_id', p_client_id,
		'user_id', v_user_id,
		'name', v_name,
		'public_key', p_public_key
	);
end
$$;

create function public.qorpera_list_presence_devices(p_profile_id uuid, p_client_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
	if auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id)
		or cardinality(p_client_ids) > 200 then
		raise exception 'profile presence access is required' using errcode = '42501';
	end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'client_id', device.client_id,
			'user_id', device.user_id,
			'name', coalesce(member.display_name, 'Company member'),
			'public_key', device.public_key
		) order by device.client_id)
		from public.qorpera_presence_devices as device
		join public.qorpera_profile_members as member
			on member.profile_id = device.profile_id and member.user_id = device.user_id
		where device.profile_id = p_profile_id
			and device.client_id = any(p_client_ids)
			and device.last_seen_at >= statement_timestamp() - interval '2 minutes'
	), '[]'::jsonb);
end
$$;

create function public.qorpera_unregister_presence_device(p_profile_id uuid, p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	delete from public.qorpera_presence_devices
	where profile_id = p_profile_id and client_id = p_client_id and user_id = auth.uid();
end
$$;

create table public.qorpera_verified_company_file_objects (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
	verifier_version integer not null default 1 check (verifier_version = 1),
	manifest_bytes bigint not null check (manifest_bytes between 1 and 8388608),
	file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint not null check (bytes between 0 and 268435456),
	media_type text not null check (media_type = 'application/octet-stream'),
	objects jsonb not null check (
		jsonb_typeof(objects) = 'array'
		and jsonb_array_length(objects) between 1 and 65
		and pg_column_size(objects) <= 32768
	),
	verified_at timestamptz not null default statement_timestamp(),
	primary key (profile_id, manifest_sha256, verifier_version),
	foreign key (profile_id, manifest_sha256)
		references public.qorpera_profile_objects(profile_id, sha256) on delete cascade
);

alter table public.qorpera_verified_company_file_objects enable row level security;
revoke all on public.qorpera_verified_company_file_objects from anon, authenticated;

create table public.qorpera_company_file_verification_progress (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
	verifier_version integer not null default 1 check (verifier_version = 1),
	manifest_bytes bigint not null check (manifest_bytes between 1 and 8388608),
	file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint not null check (bytes between 0 and 268435456),
	media_type text not null check (media_type = 'application/octet-stream'),
	next_chunk_index integer not null check (next_chunk_index between 0 and 64),
	verified_bytes bigint not null check (verified_bytes between 0 and 268435456),
	sha256_state jsonb not null check (jsonb_typeof(sha256_state) = 'object' and pg_column_size(sha256_state) <= 2048),
	objects jsonb not null check (
		jsonb_typeof(objects) = 'array'
		and jsonb_array_length(objects) between 1 and 65
		and pg_column_size(objects) <= 32768
	),
	updated_at timestamptz not null default statement_timestamp(),
	primary key (profile_id, manifest_sha256, verifier_version),
	foreign key (profile_id, manifest_sha256)
		references public.qorpera_profile_objects(profile_id, sha256) on delete cascade
);

alter table public.qorpera_company_file_verification_progress enable row level security;
revoke all on public.qorpera_company_file_verification_progress from anon, authenticated;

-- Profile storage is physical and content addressed. Logical Company File
-- bytes describe only the current tree; retained bytes additionally include
-- revision history, immutable execution pins, queued attachments, artifacts,
-- and runner substrates that must remain replayable. The retained set is also
-- the authority for reclaiming abandoned uploads and expired history.
create function public.qorpera_company_additional_retained_object_hashes(p_profile_id uuid)
returns table (object_sha256 text)
language sql
stable
security definer
set search_path = ''
as $$
	select null::text as object_sha256 where false
$$;

revoke all on function public.qorpera_company_additional_retained_object_hashes(uuid)
	from public, anon, authenticated;

create function public.qorpera_company_retained_object_hashes(p_profile_id uuid)
returns table (object_sha256 text)
language sql
stable
security definer
set search_path = ''
as $$
	with retained_snapshots as (
		select snapshot.id
		from public.qorpera_company_snapshots as snapshot
		where snapshot.profile_id = p_profile_id
			and (
				snapshot.created_at >= statement_timestamp() - interval '30 days'
				or exists (
					select 1 from public.qorpera_company_files as file
					where file.profile_id = p_profile_id and file.head_snapshot_id = snapshot.id
				)
				or exists (
					select 1 from public.qorpera_company_workspaces as workspace
					where workspace.profile_id = p_profile_id and workspace.head_snapshot_id = snapshot.id
				)
				or exists (
					select 1 from public.qorpera_company_snapshot_publications as publication
					where publication.snapshot_id = snapshot.id
						and publication.status = 'prepared'
						and publication.prepared_at >= statement_timestamp() - interval '24 hours'
				)
				or exists (
					select 1 from public.qorpera_session_turns as turn
					where turn.company_snapshot_id = snapshot.id
						and (
							turn.status = 'active'
							or turn.completed_at >= statement_timestamp() - interval '30 days'
						)
				)
				or exists (
					select 1 from public.qorpera_wake_claims as wake
					where wake.company_snapshot_id = snapshot.id
						and (
							wake.completed_at is null
							or wake.completed_at >= statement_timestamp() - interval '30 days'
						)
				)
				or exists (
					select 1 from public.qorpera_company_proposals as proposal
					where proposal.profile_id = p_profile_id
						and snapshot.id in (proposal.base_snapshot_id, proposal.proposal_snapshot_id)
						and (
							proposal.status = 'open'
							or proposal.resolved_at >= statement_timestamp() - interval '30 days'
						)
				)
				or exists (
					select 1
					from public.qorpera_company_substrate_versions as version
					join public.qorpera_runner_jobs as job on job.substrate_version_id = version.id
					where version.company_snapshot_id = snapshot.id
						and (
							job.status in ('queued', 'leased')
							or job.finished_at >= statement_timestamp() - interval '30 days'
						)
				)
			)
	), retained_graphs as (
		select graph.id
		from public.qorpera_object_reachability_graphs as graph
		where graph.profile_id = p_profile_id
			and (
				(graph.status = 'uploading'
					and graph.created_at >= statement_timestamp() - interval '24 hours')
				or (graph.root_kind = 'company_snapshot' and exists (
					select 1 from retained_snapshots as snapshot where snapshot.id = graph.root_id
				))
				or (graph.root_kind = 'artifact' and exists (
					select 1 from public.qorpera_artifacts as artifact
					where artifact.id = graph.root_id
						and artifact.profile_id = p_profile_id
						and artifact.gc_completed_at is null
				))
			)
	), missing_closure as (
		select exists (
			select 1
			from retained_snapshots as snapshot
			left join public.qorpera_object_reachability_graphs as graph
				on graph.root_kind = 'company_snapshot' and graph.root_id = snapshot.id
			where graph.id is null or graph.status <> 'complete' or not graph.closure_verified
		) or exists (
			select 1
			from public.qorpera_artifacts as artifact
			left join public.qorpera_object_reachability_graphs as graph
				on graph.root_kind = 'artifact' and graph.root_id = artifact.id
			where artifact.profile_id = p_profile_id
				and artifact.gc_completed_at is null
				and (graph.id is null or graph.status <> 'complete' or not graph.closure_verified)
		) as present
	), graph_objects as (
		select entry.object_sha256
		from retained_graphs as retained
		join public.qorpera_object_reachability_entries as entry on entry.graph_id = retained.id
	), queued_images as (
		select image ->> 'objectSha256' as object_sha256
		from public.qorpera_shared_sessions as session
		join public.qorpera_session_inputs as input on input.session_id = session.id
		cross join lateral jsonb_array_elements(coalesce(input.body -> 'images', '[]'::jsonb)) as image
		where session.profile_id = p_profile_id
			and input.completed_at is null
			and (
				input.failed_at is null
				or input.failed_at >= statement_timestamp() - interval '30 days'
			)
			and image ->> 'objectSha256' ~ '^[0-9a-f]{64}$'
	), runner_outputs as (
		select output.object_sha256
		from public.qorpera_runner_job_output_objects as output
		join public.qorpera_runner_jobs as job on job.id = output.job_id
		where output.profile_id = p_profile_id
			and output.uploaded_at is not null
			and (
				job.status in ('queued', 'leased')
				or output.authorized_at >= statement_timestamp() - interval '24 hours'
			)
	), operation_outputs as (
		select object.object_sha256
		from public.qorpera_operation_receipt_objects as object
		join public.qorpera_operation_receipts as receipt on receipt.id = object.receipt_id
		where object.profile_id = p_profile_id
			and (
				receipt.status = 'executing'
				or receipt.completed_at >= statement_timestamp() - interval '30 days'
			)
	), direct_roots as (
		select artifact.root_object_sha256 as object_sha256
		from public.qorpera_artifacts as artifact
		where artifact.profile_id = p_profile_id and artifact.gc_completed_at is null
		union
		select snapshot.tree_manifest_sha256
		from retained_snapshots as retained
		join public.qorpera_company_snapshots as snapshot on snapshot.id = retained.id
	), conservative_profile as (
		select object.sha256 as object_sha256
		from public.qorpera_profile_objects as object
		cross join missing_closure
		where object.profile_id = p_profile_id and missing_closure.present
	)
	select object_sha256 from graph_objects
	union select object_sha256 from queued_images
	union select object_sha256 from runner_outputs
	union select object_sha256 from operation_outputs
	union select object_sha256 from direct_roots
	union select object_sha256 from conservative_profile
	union select object_sha256
		from public.qorpera_company_additional_retained_object_hashes(p_profile_id)
$$;

revoke all on function public.qorpera_company_retained_object_hashes(uuid) from public, anon, authenticated;

create table public.qorpera_company_object_gc_leases (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	lease_id uuid not null unique,
	lease_expires_at timestamptz not null,
	created_at timestamptz not null default statement_timestamp(),
	unique (profile_id, lease_id)
);

create table public.qorpera_company_object_gc_entries (
	profile_id uuid not null,
	lease_id uuid not null,
	object_sha256 text not null check (object_sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint not null check (bytes >= 0),
	primary key (profile_id, object_sha256),
	foreign key (profile_id, lease_id)
		references public.qorpera_company_object_gc_leases(profile_id, lease_id)
		on delete cascade
);

alter table public.qorpera_company_object_gc_leases enable row level security;
alter table public.qorpera_company_object_gc_entries enable row level security;
revoke all on public.qorpera_company_object_gc_leases from anon, authenticated;
revoke all on public.qorpera_company_object_gc_entries from anon, authenticated;

create or replace function public.qorpera_profile_gc_deletion_active(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1 from public.qorpera_artifact_gc_plans as plan
		where plan.profile_id = p_profile_id and plan.status = 'deleting'
	) or exists (
		select 1 from public.qorpera_company_object_gc_leases as lease
		where lease.profile_id = p_profile_id
			and lease.lease_expires_at > statement_timestamp()
	)
$$;

revoke all on function public.qorpera_profile_gc_deletion_active(uuid) from public, anon, authenticated;

create function public.qorpera_claim_company_object_gc(p_limit integer, p_lease_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
	v_objects jsonb;
begin
	if auth.role() <> 'service_role' or p_lease_id is null or p_limit not between 1 and 100 then
		raise exception 'company object cleanup authorization is invalid' using errcode = '42501';
	end if;
	delete from public.qorpera_company_object_gc_leases
	where lease_expires_at <= statement_timestamp();

	for v_profile_id in
		select object.profile_id
		from public.qorpera_profile_objects as object
		join public.qorpera_company_files as file on file.profile_id = object.profile_id
		where object.created_at < statement_timestamp() - interval '24 hours'
			and not exists (
				select 1
				from public.qorpera_company_retained_object_hashes(object.profile_id) as retained
				where retained.object_sha256 = object.sha256
			)
		group by object.profile_id
		order by min(object.created_at), object.profile_id
	loop
		perform public.qorpera_lock_profile_gc_fence(v_profile_id);
		if public.qorpera_profile_gc_deletion_active(v_profile_id) then
			continue;
		end if;
		insert into public.qorpera_company_object_gc_leases (profile_id, lease_id, lease_expires_at)
		values (v_profile_id, p_lease_id, statement_timestamp() + interval '10 minutes');
		insert into public.qorpera_company_object_gc_entries (profile_id, lease_id, object_sha256, bytes)
		select object.profile_id, p_lease_id, object.sha256, object.bytes
		from public.qorpera_profile_objects as object
		where object.profile_id = v_profile_id
			and object.created_at < statement_timestamp() - interval '24 hours'
			and not exists (
				select 1
				from public.qorpera_company_retained_object_hashes(v_profile_id) as retained
				where retained.object_sha256 = object.sha256
			)
		order by object.created_at, object.sha256
		limit p_limit;
		select jsonb_agg(jsonb_build_object(
			'sha256', entry.object_sha256,
			'bytes', entry.bytes,
			'path', entry.profile_id::text || '/' || entry.object_sha256
		) order by entry.object_sha256) into v_objects
		from public.qorpera_company_object_gc_entries as entry
		where entry.profile_id = v_profile_id and entry.lease_id = p_lease_id;
		if v_objects is null then
			delete from public.qorpera_company_object_gc_leases
			where profile_id = v_profile_id and lease_id = p_lease_id;
			continue;
		end if;
		return jsonb_build_object(
			'profile_id', v_profile_id,
			'lease_id', p_lease_id,
			'objects', v_objects
		);
	end loop;
	return null;
end
$$;

create function public.qorpera_renew_company_object_gc(
	p_profile_id uuid,
	p_lease_id uuid,
	p_object_sha256s text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_expected integer;
begin
	if auth.role() <> 'service_role' or cardinality(p_object_sha256s) not between 1 and 100 then
		raise exception 'company object cleanup authorization is invalid' using errcode = '42501';
	end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	select count(*) into v_expected
	from public.qorpera_company_object_gc_entries as entry
	where entry.profile_id = p_profile_id and entry.lease_id = p_lease_id
		and entry.object_sha256 = any(p_object_sha256s)
		and not exists (
			select 1
			from public.qorpera_company_retained_object_hashes(p_profile_id) as retained
			where retained.object_sha256 = entry.object_sha256
		);
	if v_expected <> cardinality(p_object_sha256s) or exists (
		select 1 from public.qorpera_company_object_gc_leases as lease
		where lease.profile_id = p_profile_id and lease.lease_id = p_lease_id
			and lease.lease_expires_at <= statement_timestamp()
	) then
		raise exception 'company object cleanup lease is stale' using errcode = '40001';
	end if;
	update public.qorpera_company_object_gc_leases
	set lease_expires_at = statement_timestamp() + interval '10 minutes'
	where profile_id = p_profile_id and lease_id = p_lease_id;
	if not found then
		raise exception 'company object cleanup lease is unavailable' using errcode = '40001';
	end if;
end
$$;

create function public.qorpera_complete_company_object_gc(
	p_profile_id uuid,
	p_lease_id uuid,
	p_object_sha256s text[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_expected integer;
begin
	if auth.role() <> 'service_role' or cardinality(p_object_sha256s) not between 1 and 100 then
		raise exception 'company object cleanup authorization is invalid' using errcode = '42501';
	end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	select count(*) into v_expected
	from public.qorpera_company_object_gc_entries as entry
	where entry.profile_id = p_profile_id and entry.lease_id = p_lease_id
		and entry.object_sha256 = any(p_object_sha256s);
	if v_expected <> cardinality(p_object_sha256s) or exists (
		select 1 from public.qorpera_profile_objects as object
		where object.profile_id = p_profile_id and object.sha256 = any(p_object_sha256s)
	) then
		raise exception 'company object cleanup was not confirmed by storage' using errcode = '55000';
	end if;
	delete from public.qorpera_company_object_gc_leases
	where profile_id = p_profile_id and lease_id = p_lease_id
		and lease_expires_at > statement_timestamp();
	if not found then
		raise exception 'company object cleanup lease is unavailable' using errcode = '40001';
	end if;
	return v_expected;
end
$$;

create function public.qorpera_release_company_object_gc(p_profile_id uuid, p_lease_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	if auth.role() <> 'service_role' then
		raise exception 'company object cleanup authorization is invalid' using errcode = '42501';
	end if;
	delete from public.qorpera_company_object_gc_leases
	where profile_id = p_profile_id and lease_id = p_lease_id;
end
$$;

revoke all on function public.qorpera_claim_company_object_gc(integer, uuid) from public, anon, authenticated;
revoke all on function public.qorpera_renew_company_object_gc(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function public.qorpera_complete_company_object_gc(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function public.qorpera_release_company_object_gc(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qorpera_verify_company_snapshot_closure(uuid, uuid, uuid, text, integer, bigint, text, bigint, text) from public, anon, authenticated;
grant execute on function public.qorpera_claim_company_object_gc(integer, uuid) to service_role;
grant execute on function public.qorpera_renew_company_object_gc(uuid, uuid, text[]) to service_role;
grant execute on function public.qorpera_complete_company_object_gc(uuid, uuid, text[]) to service_role;
grant execute on function public.qorpera_release_company_object_gc(uuid, uuid) to service_role;
grant execute on function public.qorpera_verify_company_snapshot_closure(uuid, uuid, uuid, text, integer, bigint, text, bigint, text) to service_role;

create or replace function public.qorpera_company_file_json(p_file public.qorpera_company_files)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'profile_id', p_file.profile_id,
		'environment_id', p_file.environment_id,
		'canonical_workspace_id', p_file.canonical_workspace_id,
		'head_snapshot_id', p_file.head_snapshot_id,
		'state', p_file.state,
		'logical_bytes', p_file.logical_bytes,
		'retained_storage_bytes', coalesce((
			select sum(object.bytes)
			from public.qorpera_profile_objects as object
			where object.profile_id = p_file.profile_id
				and exists (
					select 1
					from public.qorpera_company_retained_object_hashes(p_file.profile_id) as retained
					where retained.object_sha256 = object.sha256
				)
		), 0),
		'storage_used_bytes', p_file.storage_used_bytes,
		'storage_limit_bytes', p_file.storage_limit_bytes,
		'created_at', p_file.created_at,
		'updated_at', p_file.updated_at
	)
$$;

revoke all on function public.qorpera_create_cloud_company(uuid, text, integer) from public, anon;
revoke all on function public.qorpera_get_company_file(uuid) from public, anon;
revoke all on function public.qorpera_prepare_company_file_revision(uuid, uuid, uuid, text, integer, integer, integer, bigint) from public, anon;
revoke all on function public.qorpera_prepare_company_file_proposal(uuid, uuid, uuid, text, integer, integer, integer, bigint) from public, anon;
revoke all on function public.qorpera_publish_company_file_revision(uuid, uuid, uuid) from public, anon;
revoke all on function public.qorpera_list_session_inputs(uuid, bigint, integer) from public, anon;
revoke all on function public.qorpera_claim_session_turn(uuid, uuid, integer, uuid, bigint) from public, anon;
revoke all on function public.qorpera_renew_session_turn_v2(uuid, uuid, uuid, integer) from public, anon;
revoke all on function public.qorpera_complete_session_turn_v2(uuid, uuid, uuid, bigint) from public, anon;
revoke all on function public.qorpera_quarantine_session_turn(uuid, uuid, uuid, text) from public, anon;
revoke all on function public.qorpera_list_session_recoveries(uuid, timestamptz, uuid, integer) from public, anon;
revoke all on function public.qorpera_resolve_session_recovery(uuid, uuid, text) from public, anon;
revoke all on function public.qorpera_resolve_operation_receipt(uuid, text, jsonb) from public, anon;
revoke all on function public.qorpera_get_session_turn_status(uuid, uuid, uuid) from public, anon;
revoke all on function public.qorpera_create_shared_session_v3(uuid, uuid, text, text, uuid, jsonb) from public, anon;
revoke all on function public.qorpera_create_shared_session_v4(uuid, uuid, text, text, uuid, jsonb, uuid, bigint) from public, anon;
revoke all on function public.qorpera_close_shared_session(uuid) from public, anon;
revoke all on function public.qorpera_list_shared_sessions_page(uuid, timestamptz, uuid, integer) from public, anon;
revoke all on function public.qorpera_get_shared_session_by_client(uuid, uuid) from public, anon;
revoke all on function public.qorpera_claim_wake_v2(uuid, text, uuid, integer, uuid, uuid, bigint) from public, anon;
revoke all on function public.qorpera_begin_operation_receipt(text, uuid, uuid, uuid, text, text) from public, anon;
revoke all on function public.qorpera_stage_operation_receipt_objects(uuid, uuid, uuid, jsonb) from public, anon;
revoke all on function public.qorpera_complete_operation_receipt(uuid, uuid, uuid, jsonb) from public, anon;
revoke all on function public.qorpera_register_presence_device(uuid, uuid, text) from public, anon;
revoke all on function public.qorpera_list_presence_devices(uuid, uuid[]) from public, anon;
revoke all on function public.qorpera_unregister_presence_device(uuid, uuid) from public, anon;
revoke all on function public.qorpera_append_account_event(uuid, uuid, text, jsonb, bigint, text, uuid, uuid) from public, anon;
revoke all on function public.qorpera_submit_company_proposal(uuid, uuid, uuid, text, uuid, uuid, uuid, bigint, text, text, text, uuid[]) from public, anon;
revoke all on function public.qorpera_list_company_proposals(uuid, text, timestamptz, uuid, integer) from public, anon;
revoke all on function public.qorpera_accept_company_proposal(uuid, uuid) from public, anon;
revoke all on function public.qorpera_rebase_company_proposal(uuid, uuid, uuid, uuid) from public, anon;
revoke all on function public.qorpera_reject_company_proposal(uuid, uuid) from public, anon;
revoke all on function public.qorpera_get_company_proposal(uuid) from public, anon;
revoke all on function public.qorpera_append_company_proposal_comment(uuid, uuid, text) from public, anon;
revoke all on function public.qorpera_list_company_proposal_comments(uuid, timestamptz, uuid, integer) from public, anon;
revoke execute on function public.qorpera_claim_wake(uuid, text, uuid, integer) from authenticated;
revoke execute on function public.qorpera_renew_session_turn(uuid, uuid, integer) from authenticated;
revoke execute on function public.qorpera_complete_session_turn(uuid, uuid) from authenticated;
-- Historical workspace heads remain readable migration history, but clients
-- can no longer create or advance independent company forks.
revoke execute on function public.qorpera_ensure_company_workspace(uuid, uuid, text, uuid) from authenticated;
revoke execute on function public.qorpera_commit_company_snapshot(uuid, uuid, uuid, text, integer, integer, integer, bigint) from authenticated;
grant execute on function public.qorpera_create_cloud_company(uuid, text, integer) to authenticated;
grant execute on function public.qorpera_get_company_file(uuid) to authenticated;
grant execute on function public.qorpera_prepare_company_file_revision(uuid, uuid, uuid, text, integer, integer, integer, bigint) to authenticated;
grant execute on function public.qorpera_prepare_company_file_proposal(uuid, uuid, uuid, text, integer, integer, integer, bigint) to authenticated;
grant execute on function public.qorpera_publish_company_file_revision(uuid, uuid, uuid) to authenticated;
grant execute on function public.qorpera_list_session_inputs(uuid, bigint, integer) to authenticated;
grant execute on function public.qorpera_claim_session_turn(uuid, uuid, integer, uuid, bigint) to authenticated;
grant execute on function public.qorpera_renew_session_turn_v2(uuid, uuid, uuid, integer) to authenticated;
grant execute on function public.qorpera_complete_session_turn_v2(uuid, uuid, uuid, bigint) to authenticated;
grant execute on function public.qorpera_quarantine_session_turn(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.qorpera_list_session_recoveries(uuid, timestamptz, uuid, integer) to authenticated;
grant execute on function public.qorpera_resolve_session_recovery(uuid, uuid, text) to authenticated;
grant execute on function public.qorpera_resolve_operation_receipt(uuid, text, jsonb) to authenticated;
grant execute on function public.qorpera_get_session_turn_status(uuid, uuid, uuid) to authenticated;
grant execute on function public.qorpera_create_shared_session_v4(uuid, uuid, text, text, uuid, jsonb, uuid, bigint) to authenticated;
grant execute on function public.qorpera_close_shared_session(uuid) to authenticated;
grant execute on function public.qorpera_list_shared_sessions_page(uuid, timestamptz, uuid, integer) to authenticated;
grant execute on function public.qorpera_get_shared_session_by_client(uuid, uuid) to authenticated;
grant execute on function public.qorpera_claim_wake_v2(uuid, text, uuid, integer, uuid, uuid, bigint) to authenticated;
grant execute on function public.qorpera_begin_operation_receipt(text, uuid, uuid, uuid, text, text) to authenticated;
grant execute on function public.qorpera_stage_operation_receipt_objects(uuid, uuid, uuid, jsonb) to authenticated;
grant execute on function public.qorpera_complete_operation_receipt(uuid, uuid, uuid, jsonb) to authenticated;
grant execute on function public.qorpera_register_presence_device(uuid, uuid, text) to authenticated;
grant execute on function public.qorpera_list_presence_devices(uuid, uuid[]) to authenticated;
grant execute on function public.qorpera_unregister_presence_device(uuid, uuid) to authenticated;
grant execute on function public.qorpera_append_account_event(uuid, uuid, text, jsonb, bigint, text, uuid, uuid) to authenticated;
grant execute on function public.qorpera_submit_company_proposal(uuid, uuid, uuid, text, uuid, uuid, uuid, bigint, text, text, text, uuid[]) to authenticated;
grant execute on function public.qorpera_list_company_proposals(uuid, text, timestamptz, uuid, integer) to authenticated;
grant execute on function public.qorpera_accept_company_proposal(uuid, uuid) to authenticated;
grant execute on function public.qorpera_rebase_company_proposal(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.qorpera_reject_company_proposal(uuid, uuid) to authenticated;
grant execute on function public.qorpera_get_company_proposal(uuid) to authenticated;
grant execute on function public.qorpera_append_company_proposal_comment(uuid, uuid, text) to authenticated;
grant execute on function public.qorpera_list_company_proposal_comments(uuid, timestamptz, uuid, integer) to authenticated;

do $$
begin
	if not exists (
		select 1 from pg_catalog.pg_publication_tables
		where pubname = 'supabase_realtime'
			and schemaname = 'public'
			and tablename = 'qorpera_company_files'
	) then
		alter publication supabase_realtime add table public.qorpera_company_files;
	end if;
end
$$;
