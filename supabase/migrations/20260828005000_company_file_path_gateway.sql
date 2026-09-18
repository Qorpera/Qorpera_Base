-- Runtime Step 2. The immutable tree remains the Company File; this index is
-- its transactionally maintained path/version projection, not another store.
-- Nothing is enabled implicitly. Cutover imports a verified head and closes
-- legacy hash reads and whole-tree writes before admitting gateway effects.

create function public.qorpera_company_path_key(p_path text)
returns text language sql immutable set search_path = '' as $$
	select normalize(lower(upper(normalize(p_path, NFKC))), NFKC)
$$;

create function public.qorpera_company_path_valid(p_path text, p_root boolean default false)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_candidate text; v_part text;
begin
	if p_root and p_path = '' then return true; end if;
	if p_path is null or octet_length(p_path) not between 1 and 4096
		or p_path <> normalize(p_path, NFC) then return false; end if;
	foreach v_candidate in array array[p_path, public.qorpera_company_path_key(p_path)] loop
		if v_candidate ~ '[[:cntrl:]]' or strpos(v_candidate, chr(92)) > 0
			or strpos(v_candidate, '%') > 0
			or cardinality(string_to_array(v_candidate,'/')) <> cardinality(string_to_array(p_path,'/')) then return false; end if;
		foreach v_part in array string_to_array(v_candidate, '/') loop
			if v_part in ('', '.', '..') or strpos(v_part, ':') > 0 or v_part ~ '[. ]$'
				or v_part ~* '^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(\..*)?$'
				then return false; end if;
		end loop;
	end loop;
	return true;
end
$$;

create function public.qorpera_company_path_entry_valid(p_entry jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_file jsonb;
begin
	if jsonb_typeof(p_entry) is distinct from 'object'
		or jsonb_typeof(p_entry -> 'path') is distinct from 'string'
		or not public.qorpera_company_path_valid(p_entry ->> 'path') then return false; end if;
	if p_entry ->> 'kind' = 'directory' then
		return p_entry - array['path','kind'] = '{}'::jsonb;
	end if;
	v_file := p_entry -> 'file';
	return coalesce(p_entry ->> 'kind' = 'file'
		and p_entry - array['path','kind','executable','file'] = '{}'::jsonb
		and jsonb_typeof(p_entry -> 'executable') = 'boolean'
		and jsonb_typeof(v_file) = 'object'
		and v_file - array['manifestSha256','fileSha256','bytes','mediaType'] = '{}'::jsonb
		and jsonb_typeof(v_file -> 'manifestSha256') = 'string'
		and v_file ->> 'manifestSha256' ~ '^[0-9a-f]{64}$'
		and jsonb_typeof(v_file -> 'fileSha256') = 'string'
		and v_file ->> 'fileSha256' ~ '^[0-9a-f]{64}$'
		and jsonb_typeof(v_file -> 'bytes') = 'number'
		and v_file ->> 'bytes' ~ '^(0|[1-9][0-9]{0,12})$'
		and (v_file ->> 'bytes')::numeric between 0 and 1099511627776
		and v_file ->> 'mediaType' = 'application/octet-stream', false);
exception when numeric_value_out_of_range or invalid_text_representation then return false;
end
$$;

alter table public.qorpera_company_files
	add column path_gateway_version integer check (path_gateway_version = 1),
	add column path_index_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete restrict,
	add check ((path_gateway_version is null) = (path_index_snapshot_id is null));

create table public.qorpera_company_path_entries (
	environment_id uuid not null references public.qorpera_company_files(environment_id) on delete cascade,
	path text collate "C" not null check (public.qorpera_company_path_valid(path)),
	path_key_sha256 bytea generated always as (extensions.digest(public.qorpera_company_path_key(path), 'sha256')) stored,
	version uuid not null default extensions.gen_random_uuid(),
	-- Tombstones retain an opaque version. Delete/recreate cannot revive an old
	-- absence precondition or a content hash which happened to occur before.
	entry jsonb check (entry is null or (public.qorpera_company_path_entry_valid(entry) and entry ->> 'path' = path)),
	updated_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, path_key_sha256)
);

-- Durable data-flow guard, not memory or a second Company File. A restarted
-- host cannot forget which paths already entered this run's model context.
create table public.qorpera_company_run_read_paths (
	run_id uuid not null references public.qorpera_execution_runs(id) on delete cascade,
	path text collate "C" not null check (public.qorpera_company_path_valid(path,true)),
	path_key_sha256 bytea generated always as (extensions.digest(public.qorpera_company_path_key(path),'sha256')) stored,
	created_at timestamptz not null default clock_timestamp(),
	primary key (run_id,path_key_sha256)
);
alter table public.qorpera_company_run_read_paths enable row level security;
revoke all on public.qorpera_company_run_read_paths from public,anon,authenticated,service_role;

create table public.qorpera_company_path_resources (
	id uuid primary key default extensions.gen_random_uuid(),
	environment_id uuid not null references public.qorpera_company_files(environment_id) on delete cascade,
	path text collate "C" not null check (public.qorpera_company_path_valid(path, true)),
	path_key text collate "C" generated always as (public.qorpera_company_path_key(path)) stored,
	path_key_sha256 bytea generated always as (extensions.digest(public.qorpera_company_path_key(path), 'sha256')) stored,
	path_match text not null check (path_match in ('exact','subtree')),
	scope text not null check (scope in ('company_shared','member_private')),
	owner_user_id uuid references auth.users(id) on delete restrict,
	policy text not null check (policy in ('normal','protected')),
	version uuid not null default extensions.gen_random_uuid(),
	revoked_at timestamptz,
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	unique (environment_id, path_key_sha256),
	check ((scope = 'member_private') = (owner_user_id is not null)),
	check (path <> '' or (path_match = 'subtree' and scope = 'company_shared'))
);

create table public.qorpera_company_path_grants (
	id uuid primary key default extensions.gen_random_uuid(),
	resource_id uuid not null references public.qorpera_company_path_resources(id) on delete cascade,
	resource_version uuid not null,
	principal_kind text not null check (principal_kind in ('member','staff_agent')),
	principal_id uuid not null,
	permissions text[] not null check (
		permissions = array['read']::text[] or permissions = array['read','write']::text[]
	),
	expires_at timestamptz,
	revoked_at timestamptz,
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default clock_timestamp(),
	check (expires_at is null or expires_at > created_at)
);
create index qorpera_company_path_grants_active
	on public.qorpera_company_path_grants(resource_id, principal_kind, principal_id) where revoked_at is null;

create table public.qorpera_company_path_proposals (
	id uuid primary key default extensions.gen_random_uuid(),
	environment_id uuid not null references public.qorpera_company_files(environment_id) on delete cascade,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	receipt_id uuid not null unique references public.qorpera_run_operation_receipts(id) deferrable initially deferred,
	plan jsonb not null check (jsonb_typeof(plan) = 'object' and pg_column_size(plan) <= 32768),
	plan_sha256 text not null check (plan_sha256 ~ '^[0-9a-f]{64}$'),
	resource_id uuid not null references public.qorpera_company_path_resources(id) on delete restrict,
	resource_version uuid not null,
	status text not null default 'open' check (status in ('open','approved','applied','rejected')),
	created_at timestamptz not null default clock_timestamp(),
	approved_by_user_id uuid references auth.users(id) on delete restrict,
	approval_expires_at timestamptz,
	resolved_by_user_id uuid references auth.users(id) on delete restrict,
	resolved_at timestamptz,
	output_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete restrict,
	check ((status in ('open','approved')) = (resolved_at is null)),
	check ((status in ('open','approved')) = (resolved_by_user_id is null)),
	check ((approved_by_user_id is null) = (approval_expires_at is null)),
	check (status not in ('approved','applied') or approved_by_user_id is not null),
	check ((status = 'applied') = (output_snapshot_id is not null))
);

alter table public.qorpera_run_operation_receipts
	add column company_path_proposal_id uuid references public.qorpera_company_path_proposals(id) on delete restrict,
	add check (company_path_proposal_id is null or (proposal_id is null and output_snapshot_id is null));

-- A revision is also the durable change event. Wake fan-out consumes this
-- later; it must never be a second, lossy publish after the Company changed.
create table public.qorpera_company_path_revisions (
	snapshot_id uuid primary key references public.qorpera_company_snapshots(id) deferrable initially deferred,
	environment_id uuid not null references public.qorpera_company_files(environment_id) on delete cascade,
	parent_snapshot_id uuid not null references public.qorpera_company_snapshots(id) on delete restrict,
	tree_sha256 text not null check (tree_sha256 ~ '^[0-9a-f]{64}$'),
	tree_bytes integer not null check (tree_bytes between 1 and 8388608),
	file_count integer not null check (file_count between 0 and 50000),
	total_bytes bigint not null check (total_bytes between 0 and 1099511627776),
	run_id uuid references public.qorpera_execution_runs(id) on delete restrict,
	receipt_id uuid references public.qorpera_run_operation_receipts(id) deferrable initially deferred,
	proposal_id uuid unique references public.qorpera_company_path_proposals(id) on delete restrict,
	actor_user_id uuid not null references auth.users(id) on delete restrict,
	actor_staff_id uuid,
	change jsonb not null check (jsonb_typeof(change) = 'object' and pg_column_size(change) <= 65536),
	created_at timestamptz not null default clock_timestamp()
);

alter table public.qorpera_company_path_entries enable row level security;
alter table public.qorpera_company_path_resources enable row level security;
alter table public.qorpera_company_path_grants enable row level security;
alter table public.qorpera_company_path_proposals enable row level security;
alter table public.qorpera_company_path_revisions enable row level security;
revoke all on public.qorpera_company_path_entries, public.qorpera_company_path_resources,
	public.qorpera_company_path_grants, public.qorpera_company_path_proposals,
	public.qorpera_company_path_revisions from public, anon, authenticated, service_role;

create function public.qorpera_company_path_resource(p_environment_id uuid, p_path text)
returns public.qorpera_company_path_resources
language plpgsql stable security definer set search_path = '' as $$
declare v_resource public.qorpera_company_path_resources%rowtype; v_key text;
begin
	if not public.qorpera_company_path_valid(p_path, true) then return null; end if;
	v_key := public.qorpera_company_path_key(p_path);
	if split_part(v_key,'/',1) in ('credentials','secrets') then return null; end if;
	-- A revoked narrower boundary remains a boundary, never an inherited grant.
	select resource.* into v_resource from public.qorpera_company_path_resources as resource
	where resource.environment_id = p_environment_id and (
		resource.path_key = v_key or (resource.path_match = 'subtree' and (
			resource.path_key = '' or left(v_key, length(resource.path_key) + 1) = resource.path_key || '/'
		))
	) order by length(resource.path_key) desc limit 1;
	if split_part(v_key, '/', 1) = 'members' and split_part(v_key, '/', 3) = 'private'
		and (v_resource.scope is distinct from 'member_private'
			or v_resource.owner_user_id::text is distinct from split_part(v_key, '/', 2)) then return null; end if;
	return v_resource;
end
$$;

create function public.qorpera_company_path_principal_allowed(
	p_profile_id uuid, p_resource public.qorpera_company_path_resources,
	p_kind text, p_id uuid, p_permission text
)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_role public.qorpera_profile_role;
begin
	if p_resource.id is null or p_resource.revoked_at is not null or p_permission not in ('read','write') then return false; end if;
	if p_kind = 'member' then
		select role into v_role from public.qorpera_profile_members
		where profile_id = p_profile_id and user_id = p_id;
		if v_role is null then return false; end if;
		if p_resource.scope = 'company_shared' then
			return p_permission = 'read' or v_role in ('owner','admin','contributor');
		end if;
		if p_resource.scope = 'member_private' and p_resource.owner_user_id = p_id then return true; end if;
	elsif p_kind = 'staff_agent' then
		if not exists (select 1 from public.qorpera_profile_staff
			where profile_id = p_profile_id and staff_agent_id = p_id and employment_status = 'active') then return false; end if;
	else return false;
	end if;
	return exists (select 1 from public.qorpera_company_path_grants as g
		where g.resource_id = p_resource.id and g.principal_kind = p_kind and g.principal_id = p_id
			and g.resource_version = p_resource.version
			and p_permission = any(g.permissions) and g.revoked_at is null
			and (g.expires_at is null or g.expires_at > clock_timestamp()));
end
$$;

-- The caller is either a verified human or the native host's closed binding.
-- There is no caller-supplied agent, requester, sponsor or audience parameter.
create function public.qorpera_company_path_actor(p_environment_id uuid, p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_file public.qorpera_company_files%rowtype; v_run public.qorpera_execution_runs%rowtype; v_user uuid;
begin
	if p_binding is not null then
		v_run := public.qorpera_native_tool_locked_run(p_binding);
		if v_run.environment_id <> p_environment_id or v_run.source_kind = 'proposal_review' then
			raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
		if v_run.session_id is not null then
			perform 1 from public.qorpera_shared_sessions where id = v_run.session_id and profile_id = v_run.profile_id
				and environment_id = v_run.environment_id and staff_agent_id = v_run.staff_agent_id::text and status = 'open' for share;
			if not found then raise exception 'Company File audience is unavailable' using errcode = '42501'; end if;
		end if;
		if exists (select 1 from unnest(v_run.input_ids) requested(id)
			left join public.qorpera_session_inputs input on input.id = requested.id
			where input.id is null or input.session_id is distinct from v_run.session_id
				or input.execution_run_id is distinct from v_run.id
				or input.author_user_id is distinct from v_run.requested_by_user_id) then
			raise exception 'Company File requesting input changed' using errcode = '42501'; end if;
		v_user := v_run.requested_by_user_id;
	else
		v_user := auth.uid();
		if auth.role() is distinct from 'authenticated' or v_user is null then
			raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
	end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.path_gateway_version is distinct from 1
		or v_file.path_index_snapshot_id is distinct from v_file.head_snapshot_id then
		raise exception 'Company File gateway is unavailable' using errcode = '55000'; end if;
	-- Profile/GC before File, followed by exact principal rows. All path ACL
	-- mutations take the same locks. Authority is rechecked after lock waits.
	perform public.qorpera_lock_profile_gc_fence(v_file.profile_id);
	select * into strict v_file from public.qorpera_company_files where environment_id = p_environment_id for update;
	if v_file.path_gateway_version is distinct from 1
		or v_file.path_index_snapshot_id is distinct from v_file.head_snapshot_id then
		raise exception 'Company File gateway is unavailable' using errcode = '55000'; end if;
	perform 1 from public.qorpera_profile_members
	where profile_id = v_file.profile_id and user_id = v_user for share;
	if not found then raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
	if p_binding is not null then
		perform 1 from public.qorpera_profile_staff
		where profile_id = v_file.profile_id and staff_agent_id = v_run.staff_agent_id and version = v_run.staff_version for share;
		if not found then raise exception 'Company File staff version changed' using errcode = '42501'; end if;
		perform 1 from public.qorpera_profile_members
		where profile_id = v_file.profile_id and user_id = v_run.sponsored_by_user_id for share;
		perform 1 from public.qorpera_execution_sponsor_bindings where id = v_run.sponsor_binding_id for share;
		perform 1 from public.qorpera_provider_connections as connection
		join public.qorpera_execution_sponsor_versions as sponsor on sponsor.provider_connection_id = connection.id
		where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version for share of connection;
		perform 1 from public.qorpera_runner_assignments where id = (p_binding ->> 'assignmentId')::uuid for share;
		perform 1 from public.qorpera_runners where id = (p_binding ->> 'runnerId')::uuid for share;
		perform 1 from public.qorpera_member_compute_identities where id = v_run.compute_identity_id for share;
		perform 1 from public.qorpera_native_credential_capsules where id = (p_binding ->> 'credentialCapsuleId')::uuid for share;
		perform public.qorpera_native_tool_locked_run(p_binding);
	end if;
	if public.qorpera_profile_gc_deletion_active(v_file.profile_id) then
		raise exception 'Company File storage is busy' using errcode = '40001'; end if;
	return jsonb_build_object('companyId',v_file.profile_id,'environmentId',p_environment_id,
		'userId',v_user,'staffAgentId',v_run.staff_agent_id,'runId',v_run.id,
		'jobId',v_run.job_id,'assignmentId',p_binding ->> 'assignmentId',
		'sponsorBindingId',v_run.sponsor_binding_id,'sponsorVersion',v_run.sponsor_version,
		'audience',case when p_binding is null then 'human' else 'company' end);
end
$$;

create function public.qorpera_company_path_allowed(p_actor jsonb, p_path text, p_permission text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_resource public.qorpera_company_path_resources%rowtype; v_profile uuid := (p_actor ->> 'companyId')::uuid;
begin
	v_resource := public.qorpera_company_path_resource((p_actor ->> 'environmentId')::uuid, p_path);
	if not public.qorpera_company_path_principal_allowed(v_profile,v_resource,'member',
		(p_actor ->> 'userId')::uuid,p_permission) then return false; end if;
	if p_actor ->> 'audience' = 'company' then
		-- All currently hosted agent sessions have a company audience. Even the
		-- requesting owner's private file cannot enter that shared model context.
		return v_resource.scope = 'company_shared' and public.qorpera_company_path_principal_allowed(
			v_profile,v_resource,'staff_agent',(p_actor ->> 'staffAgentId')::uuid,p_permission);
	end if;
	return true;
end
$$;

create function public.qorpera_company_path_require(p_actor jsonb, p_path text, p_permission text)
returns public.qorpera_company_path_resources language plpgsql security definer set search_path = '' as $$
declare v_resource public.qorpera_company_path_resources%rowtype; v_part text; v_prefix text := ''; v_existing text;
begin
	if not public.qorpera_company_path_valid(p_path, true)
		or not public.qorpera_company_path_allowed(p_actor,p_path,p_permission) then
		raise exception 'Company File path is unavailable' using errcode = '42501'; end if;
	-- Aliases can locate a policy boundary but never choose a second spelling
	-- for an existing file or ancestor (including a tombstone).
	foreach v_part in array string_to_array(p_path,'/') loop
		v_prefix := case when v_prefix = '' then v_part else v_prefix || '/' || v_part end;
		select path into v_existing from public.qorpera_company_path_entries
		where environment_id = (p_actor ->> 'environmentId')::uuid
			and path_key_sha256 = extensions.digest(public.qorpera_company_path_key(v_prefix),'sha256');
		if found and v_existing <> v_prefix then
			raise exception 'Company File path is unavailable' using errcode = '42501'; end if;
	end loop;
	v_resource := public.qorpera_company_path_resource((p_actor ->> 'environmentId')::uuid,p_path);
	return v_resource;
end
$$;

create function public.qorpera_company_path_remember_read(p_actor jsonb,p_path text)
returns void language plpgsql security definer set search_path = '' as $$
begin
	perform public.qorpera_company_path_require(p_actor,p_path,'read');
	if p_actor ->> 'runId' is null then return; end if;
	insert into public.qorpera_company_run_read_paths(run_id,path) values ((p_actor ->> 'runId')::uuid,p_path)
	on conflict do nothing;
	if (select count(*) from public.qorpera_company_run_read_paths where run_id = (p_actor ->> 'runId')::uuid) > 128 then
		raise exception 'Company File context read set is full' using errcode = '54000'; end if;
end
$$;

create function public.qorpera_company_path_assert_context(p_actor jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_path text;
begin
	if p_actor ->> 'runId' is null then return; end if;
	for v_path in select path from public.qorpera_company_run_read_paths where run_id = (p_actor ->> 'runId')::uuid loop
		perform public.qorpera_company_path_require(p_actor,v_path,'read');
	end loop;
end
$$;

create function public.qorpera_enforce_company_context_send()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_binding jsonb; v_actor jsonb;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = new.run_id;
	if not exists (select 1 from public.qorpera_company_files where environment_id = v_run.environment_id and path_gateway_version = 1) then
		return new; end if;
	select * into v_lease from public.qorpera_native_provider_connection_leases
	where run_id = new.run_id and assignment_id = new.assignment_id and status = 'active' and expires_at > clock_timestamp();
	if not found then raise exception 'Company File send authority is unavailable' using errcode = '42501'; end if;
	v_binding := jsonb_build_object('leaseId',v_lease.id,'runId',v_run.id,'jobId',v_run.job_id,
		'runnerId',v_lease.runner_id,'assignmentId',v_lease.assignment_id,'credentialCapsuleId',v_lease.credential_capsule_id,
		'computeIdentityId',v_run.compute_identity_id,'provider',v_run.model_provider,'nativeHarness','codex-cli','model',v_run.model_id);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id,v_binding);
	-- All public send routes hit this trigger before their event can exist.
	-- Revocation cannot race between an in-process check and the database send.
	perform public.qorpera_company_path_assert_context(v_actor);
	return new;
end
$$;
create trigger qorpera_agent_sends_context_authority before insert on public.qorpera_agent_sends
for each row execute function public.qorpera_enforce_company_context_send();

create function public.qorpera_read_company_path(p_environment_id uuid, p_path text, p_binding jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_entry public.qorpera_company_path_entries%rowtype; v_manifest_bytes bigint;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	perform public.qorpera_company_path_require(v_actor,p_path,'read');
	perform public.qorpera_company_path_remember_read(v_actor,p_path);
	select * into v_entry from public.qorpera_company_path_entries
	where environment_id = p_environment_id and path_key_sha256 = extensions.digest(public.qorpera_company_path_key(p_path),'sha256');
	if v_entry.entry ->> 'kind' = 'file' then
		select bytes into v_manifest_bytes from public.qorpera_profile_objects
		where profile_id = (v_actor ->> 'companyId')::uuid and sha256 = v_entry.entry #>> '{file,manifestSha256}';
		if not found then raise exception 'Company File storage is unavailable' using errcode = '55000'; end if;
	end if;
	return jsonb_build_object('path',p_path,'version',v_entry.version,'entry',v_entry.entry,
		'manifestBytes',v_manifest_bytes,'companyId',v_actor ->> 'companyId');
end
$$;

create function public.qorpera_list_company_paths(
	p_environment_id uuid, p_path text, p_after text default null,
	p_snapshot_id uuid default null, p_limit integer default 50, p_binding jsonb default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_head uuid; v_items jsonb; v_more boolean; v_item jsonb;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	perform public.qorpera_company_path_require(v_actor,p_path,'read');
	if p_limit is null or p_limit not between 1 and 100
		or (p_after is not null and not public.qorpera_company_path_valid(p_after))
		or (p_after is not null and p_snapshot_id is null) then
		raise exception 'Company File page is invalid' using errcode = '22023'; end if;
	select head_snapshot_id into v_head from public.qorpera_company_files where environment_id = p_environment_id;
	if p_snapshot_id is not null and p_snapshot_id <> v_head then
		raise exception 'Company File page changed' using errcode = '40001'; end if;
	with visible as (
		select e.path,e.version,e.entry from public.qorpera_company_path_entries e
		where e.environment_id = p_environment_id and e.entry is not null
			and (case when strpos(e.path,'/') = 0 then '' else regexp_replace(e.path,'/[^/]+$','') end) = p_path
			and (p_after is null or e.path > p_after collate "C")
			and public.qorpera_company_path_allowed(v_actor,e.path,'read')
		order by e.path limit p_limit + 1
	), page as (select * from visible order by path limit p_limit)
	select coalesce((select jsonb_agg(jsonb_build_object('path',path,'version',version,
		'kind',entry ->> 'kind','bytes',entry #> '{file,bytes}') order by path) from page),'[]'::jsonb),
		(select count(*) > p_limit from visible) into v_items,v_more;
	perform public.qorpera_company_path_remember_read(v_actor,p_path);
	for v_item in select value from jsonb_array_elements(v_items) loop
		perform public.qorpera_company_path_remember_read(v_actor,v_item ->> 'path');
	end loop;
	return jsonb_build_object('snapshotId',v_head,'items',v_items,'hasMore',v_more,
		'nextAfter',case when v_more then v_items -> -1 ->> 'path' else null end);
end
$$;

-- The trusted gateway verifies the bytes before registering either cache.
-- Neither cache is permission, a live revision, or an independently writable
-- Company File. Every use rechecks the catalog under the profile GC fence.
create table public.qorpera_company_path_tree_cache (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	sha256 text not null,
	bytes integer not null check (bytes between 1 and 8388608),
	manifest jsonb not null check (pg_column_size(manifest) <= 16777216),
	file_count integer not null check (file_count between 0 and 50000),
	total_bytes bigint not null check (total_bytes between 0 and 1099511627776),
	verified_at timestamptz not null default clock_timestamp(),
	primary key (profile_id,sha256),
	foreign key (profile_id,sha256) references public.qorpera_profile_objects(profile_id,sha256) on delete cascade
);
alter table public.qorpera_company_path_tree_cache enable row level security;
revoke all on public.qorpera_company_path_tree_cache from public, anon, authenticated, service_role;

create function public.qorpera_verify_company_path_file(p_profile_id uuid, p_manifest_text text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_manifest jsonb; v_sha text; v_objects jsonb; v_bytes integer;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Company File verifier authority is required' using errcode = '42501'; end if;
	v_bytes := octet_length(p_manifest_text);
	if p_manifest_text is null or v_bytes not between 1 and 8388608 then
		raise exception 'Company File manifest is invalid' using errcode = '22023'; end if;
	v_manifest := p_manifest_text::jsonb;
	v_sha := encode(extensions.digest(convert_to(p_manifest_text,'utf8'),'sha256'),'hex');
	if v_manifest ->> 'schema' is distinct from 'qorpera.cloud-file-manifest/v1'
		or v_manifest - array['schema','fileSha256','bytes','mediaType','chunks'] <> '{}'::jsonb
		or not public.qorpera_company_path_entry_valid(jsonb_build_object('kind','file','path','verified',
			'executable',false,'file',jsonb_build_object('manifestSha256',v_sha,
				'fileSha256',v_manifest -> 'fileSha256','bytes',v_manifest -> 'bytes','mediaType',v_manifest -> 'mediaType')))
		or jsonb_typeof(v_manifest -> 'chunks') is distinct from 'array' then
		raise exception 'Company File manifest is invalid' using errcode = '22023'; end if;
	-- This existing verified-file cache has a 256 MiB/64-chunk contract. The
	-- model tools are ranged; expanding the storage codec is a separate change.
	if jsonb_array_length(v_manifest -> 'chunks') > 64 or (v_manifest ->> 'bytes')::bigint > 268435456
		or exists (select 1 from jsonb_array_elements(v_manifest -> 'chunks') with ordinality as c(value,n)
			where jsonb_typeof(value) <> 'object' or value - array['sha256','bytes'] <> '{}'::jsonb
				or coalesce(value ->> 'sha256','') !~ '^[0-9a-f]{64}$'
				or coalesce(value ->> 'bytes','') !~ '^[1-9][0-9]{0,6}$'
				or jsonb_typeof(value -> 'bytes') <> 'number'
				or (value ->> 'bytes')::bigint > 4194304
				or (n < jsonb_array_length(v_manifest -> 'chunks') and (value ->> 'bytes')::bigint <> 4194304))
		or (select coalesce(sum((value ->> 'bytes')::bigint),0) from jsonb_array_elements(v_manifest -> 'chunks'))
			<> (v_manifest ->> 'bytes')::bigint then
		raise exception 'Company File chunks are invalid' using errcode = '22023'; end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	if public.qorpera_profile_gc_deletion_active(p_profile_id) then
		raise exception 'Company File storage is busy' using errcode = '40001'; end if;
	select jsonb_agg(object order by object ->> 'sha256') into v_objects from (
		select distinct value as object from jsonb_array_elements(v_manifest -> 'chunks')
		union select jsonb_build_object('sha256',v_sha,'bytes',v_bytes)
	) as closure;
	if exists (select 1 from jsonb_array_elements(v_objects) as o(value)
		left join public.qorpera_profile_objects as stored
			on stored.profile_id = p_profile_id and stored.sha256 = o.value ->> 'sha256'
		where stored.sha256 is null or stored.bytes <> (o.value ->> 'bytes')::bigint) then
		raise exception 'Company File objects are unavailable' using errcode = '55000'; end if;
	insert into public.qorpera_verified_company_file_objects (
		profile_id,manifest_sha256,manifest_bytes,file_sha256,bytes,media_type,objects
	) values (p_profile_id,v_sha,v_bytes,v_manifest ->> 'fileSha256',(v_manifest ->> 'bytes')::bigint,
		'application/octet-stream',v_objects)
	on conflict (profile_id,manifest_sha256,verifier_version) do update set verified_at = clock_timestamp()
	where qorpera_verified_company_file_objects.file_sha256 = excluded.file_sha256
		and qorpera_verified_company_file_objects.bytes = excluded.bytes
		and qorpera_verified_company_file_objects.objects = excluded.objects;
	if not found then raise exception 'Company File verification differs' using errcode = '23505'; end if;
end
$$;

create function public.qorpera_company_path_file_available(p_profile_id uuid, p_file jsonb)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_verified_company_file_objects as proof
		where proof.profile_id = p_profile_id and proof.manifest_sha256 = p_file ->> 'manifestSha256'
			and proof.file_sha256 = p_file ->> 'fileSha256' and to_jsonb(proof.bytes) = p_file -> 'bytes'
			and proof.media_type = p_file ->> 'mediaType' and proof.verifier_version = 1
			and not exists (select 1 from jsonb_array_elements(proof.objects) as o(value)
				left join public.qorpera_profile_objects as stored
					on stored.profile_id = p_profile_id and stored.sha256 = o.value ->> 'sha256'
				where stored.sha256 is null or stored.bytes <> (o.value ->> 'bytes')::bigint))
$$;

create function public.qorpera_verify_company_path_tree(p_profile_id uuid, p_manifest_text text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_tree jsonb; v_sha text; v_count integer; v_total bigint; v_entries jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Company File verifier authority is required' using errcode = '42501'; end if;
	if p_manifest_text is null or octet_length(p_manifest_text) not between 1 and 8388608 then
		raise exception 'Company File tree is invalid' using errcode = '22023'; end if;
	v_tree := p_manifest_text::jsonb; v_entries := v_tree -> 'entries';
	v_sha := encode(extensions.digest(convert_to(p_manifest_text,'utf8'),'sha256'),'hex');
	if v_tree ->> 'schema' is distinct from 'qorpera.company-tree/v1'
		or v_tree -> 'contractVersion' is distinct from '3'::jsonb
		or v_tree - array['schema','contractVersion','omittedLayers','entries'] <> '{}'::jsonb
		or v_tree -> 'omittedLayers' is distinct from '["company-git-history","session-trail","staff-registry", "product-git-checkouts","dependency-caches","staff-instructions","system-metadata"]'::jsonb
		or jsonb_typeof(v_entries) is distinct from 'array' then
		raise exception 'Company File tree is invalid' using errcode = '22023'; end if;
	if jsonb_array_length(v_entries) > 50000
		or exists (select 1 from jsonb_array_elements(v_entries) where not public.qorpera_company_path_entry_valid(value))
		or (select count(distinct public.qorpera_company_path_key(value ->> 'path')) from jsonb_array_elements(v_entries)) <> jsonb_array_length(v_entries)
		or exists (select 1 from jsonb_array_elements(v_entries) child
			where strpos(child ->> 'path','/') > 0 and not exists (
				select 1 from jsonb_array_elements(v_entries) parent where parent ->> 'kind' = 'directory'
					and parent ->> 'path' = regexp_replace(child ->> 'path','/[^/]+$','')))
		then raise exception 'Company File tree paths are invalid' using errcode = '22023'; end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	if public.qorpera_profile_gc_deletion_active(p_profile_id) then
		raise exception 'Company File storage is busy' using errcode = '40001'; end if;
	if not exists (select 1 from public.qorpera_profile_objects where profile_id = p_profile_id
		and sha256 = v_sha and bytes = octet_length(p_manifest_text))
		or exists (select 1 from jsonb_array_elements(v_entries) where value ->> 'kind' = 'file'
			and not public.qorpera_company_path_file_available(p_profile_id,value -> 'file')) then
		raise exception 'Company File tree objects are unavailable' using errcode = '55000'; end if;
	select count(*),coalesce(sum((value #>> '{file,bytes}')::bigint),0) into v_count,v_total
	from jsonb_array_elements(v_entries) where value ->> 'kind' = 'file';
	insert into public.qorpera_company_path_tree_cache(profile_id,sha256,bytes,manifest,file_count,total_bytes)
	values (p_profile_id,v_sha,octet_length(p_manifest_text),v_tree,v_count,v_total)
	on conflict (profile_id,sha256) do update set verified_at = clock_timestamp()
	where qorpera_company_path_tree_cache.manifest = excluded.manifest and qorpera_company_path_tree_cache.bytes = excluded.bytes;
	if not found then raise exception 'Company File tree verification differs' using errcode = '23505'; end if;
	return v_sha;
end
$$;

create function public.qorpera_enable_company_path_gateway(p_environment_id uuid, p_snapshot_id uuid, p_authorized_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_file public.qorpera_company_files%rowtype; v_tree public.qorpera_company_path_tree_cache%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Company File cutover requires service authority' using errcode = '42501'; end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	perform public.qorpera_lock_profile_gc_fence(v_file.profile_id);
	select * into strict v_file from public.qorpera_company_files where environment_id = p_environment_id for update;
	perform 1 from public.qorpera_profile_members where profile_id = v_file.profile_id
		and user_id = p_authorized_user_id and role in ('owner','admin') for share;
	if not found then raise exception 'Company File cutover authorization is unavailable' using errcode = '42501'; end if;
	if v_file.head_snapshot_id is distinct from p_snapshot_id or v_file.path_gateway_version is not null
		or public.qorpera_profile_gc_deletion_active(v_file.profile_id)
		or exists (select 1 from public.qorpera_runner_jobs where environment_id = p_environment_id and status in ('queued','leased')) then
		raise exception 'Company File cutover is not quiescent' using errcode = '55000'; end if;
	select cache.* into v_tree from public.qorpera_company_path_tree_cache cache
	join public.qorpera_company_snapshots s on s.tree_manifest_sha256 = cache.sha256 and s.profile_id = cache.profile_id
	where s.id = p_snapshot_id and s.environment_id = p_environment_id and cache.bytes = s.tree_manifest_bytes
		and cache.file_count = s.file_count and cache.total_bytes = s.total_bytes;
	if not found or not public.qorpera_object_root_has_current_proof('company_snapshot',p_snapshot_id)
		or exists (select 1 from jsonb_array_elements(v_tree.manifest -> 'entries')
			where value ->> 'kind' = 'file' and not public.qorpera_company_path_file_available(v_file.profile_id,value -> 'file')) then
		raise exception 'Company File cutover is not verified' using errcode = '55000'; end if;
	insert into public.qorpera_company_path_entries(environment_id,path,entry)
	select p_environment_id,value ->> 'path',value from jsonb_array_elements(v_tree.manifest -> 'entries');
	-- Root is explicit company policy, not an implicit agent grant. Owners
	-- grant each employee the scopes they need through the human-only API.
	insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,policy,created_by_user_id)
	values (p_environment_id,'','subtree','company_shared','normal',p_authorized_user_id);
	update public.qorpera_company_files set path_gateway_version = 1,path_index_snapshot_id = p_snapshot_id
	where environment_id = p_environment_id;
end
$$;

create function public.qorpera_set_company_path_resource(
	p_environment_id uuid,p_path text,p_path_match text,p_scope text,p_policy text,p_expected_version uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_current public.qorpera_company_path_resources%rowtype; v_parent public.qorpera_company_path_resources%rowtype;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,null);
	if not public.qorpera_company_path_valid(p_path,true) or p_path_match not in ('exact','subtree')
		or p_scope not in ('company_shared','member_private') or p_policy not in ('normal','protected') then
		raise exception 'Company File resource is invalid' using errcode = '22023'; end if;
	v_parent := public.qorpera_company_path_resource(p_environment_id,p_path);
	if (p_scope = 'company_shared' and not public.qorpera_can_authorize_profile((v_actor ->> 'companyId')::uuid))
		or (p_scope = 'member_private' and not public.qorpera_can_authorize_profile((v_actor ->> 'companyId')::uuid)
			and not (public.qorpera_company_path_key(p_path) = 'members/' || auth.uid()::text || '/private'
				or starts_with(public.qorpera_company_path_key(p_path),'members/' || auth.uid()::text || '/private/')))
		or (v_parent.scope = 'member_private' and v_parent.owner_user_id <> auth.uid())
		or (split_part(public.qorpera_company_path_key(p_path),'/',1) = 'members'
			and split_part(public.qorpera_company_path_key(p_path),'/',3) = 'private'
			and (p_scope <> 'member_private' or split_part(public.qorpera_company_path_key(p_path),'/',2) <> auth.uid()::text)) then
		raise exception 'Company File resource authorization is required' using errcode = '42501'; end if;
	select * into v_current from public.qorpera_company_path_resources where environment_id = p_environment_id
		and path_key_sha256 = extensions.digest(public.qorpera_company_path_key(p_path),'sha256');
	if v_current.version is distinct from p_expected_version or (v_current.path is not null and v_current.path <> p_path)
		or (v_current.scope = 'member_private' and (p_scope <> 'member_private' or v_current.owner_user_id <> auth.uid())) then
		raise exception 'Company File resource changed' using errcode = '40001'; end if;
	insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,owner_user_id,policy,created_by_user_id)
	values (p_environment_id,p_path,p_path_match,p_scope,case when p_scope = 'member_private' then auth.uid() else null end,p_policy,auth.uid())
	on conflict (environment_id,path_key_sha256) do update set path_match = excluded.path_match,scope = excluded.scope,
		owner_user_id = excluded.owner_user_id,policy = excluded.policy,version = extensions.gen_random_uuid(),revoked_at = null
	returning * into v_current;
	return jsonb_build_object('resourceId',v_current.id,'version',v_current.version);
end
$$;

create function public.qorpera_grant_company_path(p_resource_id uuid,p_resource_version uuid,p_principal_kind text,
	p_principal_id uuid,p_permissions text[],p_expires_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_resource public.qorpera_company_path_resources%rowtype; v_id uuid;
begin
	select * into v_resource from public.qorpera_company_path_resources where id = p_resource_id;
	v_actor := public.qorpera_company_path_actor(v_resource.environment_id,null);
	select * into strict v_resource from public.qorpera_company_path_resources where id = p_resource_id;
	if v_resource.version <> p_resource_version or v_resource.revoked_at is not null
		or (v_resource.scope = 'company_shared' and not public.qorpera_can_authorize_profile((v_actor ->> 'companyId')::uuid))
		or (v_resource.scope = 'member_private' and v_resource.owner_user_id <> auth.uid()) then
		raise exception 'Company File grant authorization is required' using errcode = '42501'; end if;
	if p_principal_kind = 'member' then
		perform 1 from public.qorpera_profile_members where profile_id = (v_actor ->> 'companyId')::uuid and user_id = p_principal_id for share;
	elsif p_principal_kind = 'staff_agent' then
		perform 1 from public.qorpera_profile_staff where profile_id = (v_actor ->> 'companyId')::uuid
			and staff_agent_id = p_principal_id and employment_status = 'active' for share;
	else raise exception 'Company File grant principal is invalid' using errcode = '22023'; end if;
	if not found then raise exception 'Company File grant principal is unavailable' using errcode = '42501'; end if;
	insert into public.qorpera_company_path_grants(resource_id,resource_version,principal_kind,principal_id,permissions,expires_at,created_by_user_id)
	values (p_resource_id,p_resource_version,p_principal_kind,p_principal_id,p_permissions,p_expires_at,auth.uid()) returning id into v_id;
	return v_id;
end
$$;

create function public.qorpera_revoke_company_path(p_resource_id uuid,p_expected_version uuid,p_grant_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_resource public.qorpera_company_path_resources%rowtype;
begin
	select * into v_resource from public.qorpera_company_path_resources where id = p_resource_id;
	v_actor := public.qorpera_company_path_actor(v_resource.environment_id,null);
	select * into strict v_resource from public.qorpera_company_path_resources where id = p_resource_id;
	if v_resource.version <> p_expected_version
		or (v_resource.scope = 'company_shared' and not public.qorpera_can_authorize_profile((v_actor ->> 'companyId')::uuid))
		or (v_resource.scope = 'member_private' and v_resource.owner_user_id <> auth.uid()) then
		raise exception 'Company File revocation authorization is required' using errcode = '42501'; end if;
	if p_grant_id is null then
		update public.qorpera_company_path_resources set revoked_at = coalesce(revoked_at,clock_timestamp()) where id = p_resource_id;
	else
		update public.qorpera_company_path_grants set revoked_at = coalesce(revoked_at,clock_timestamp())
		where id = p_grant_id and resource_id = p_resource_id;
		if not found then raise exception 'Company File grant is unavailable' using errcode = '42501'; end if;
	end if;
end
$$;

create function public.qorpera_company_path_plan_digest(p_actor jsonb,p_plan jsonb)
returns text language sql immutable set search_path = '' as $$
	select encode(extensions.digest(convert_to(jsonb_build_object('schema','qorpera.company-path-operation/v1',
		'actor',p_actor - 'assignmentId','plan',p_plan)::text,'utf8'),'sha256'),'hex')
$$;

create function public.qorpera_company_path_plan(p_actor jsonb,p_plan jsonb,p_check_version boolean,p_check_bytes boolean default true)
returns public.qorpera_company_path_resources language plpgsql security definer set search_path = '' as $$
declare v_resource public.qorpera_company_path_resources%rowtype; v_entry public.qorpera_company_path_entries%rowtype; v_key text;
begin
	if jsonb_typeof(p_plan) is distinct from 'object' or pg_column_size(p_plan) > 32768
		or p_plan - array['schema','operationKey','path','expectedVersion','entry'] <> '{}'::jsonb
		or not (p_plan ?& array['schema','operationKey','path','expectedVersion','entry'])
		or p_plan ->> 'schema' is distinct from 'qorpera.company-path-mutation/v1'
		or jsonb_typeof(p_plan -> 'operationKey') is distinct from 'string'
		or p_plan ->> 'operationKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'
		or jsonb_typeof(p_plan -> 'path') is distinct from 'string'
		or not public.qorpera_company_path_valid(p_plan ->> 'path')
		or (p_plan -> 'expectedVersion' <> 'null'::jsonb and (jsonb_typeof(p_plan -> 'expectedVersion') <> 'string'
			or p_plan ->> 'expectedVersion' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
		or (p_plan -> 'entry' <> 'null'::jsonb and (not public.qorpera_company_path_entry_valid(p_plan -> 'entry')
			or p_plan #>> '{entry,path}' <> p_plan ->> 'path')) then
		raise exception 'Company File mutation is invalid' using errcode = '22023'; end if;
	v_resource := public.qorpera_company_path_require(p_actor,p_plan ->> 'path','write');
	perform public.qorpera_company_path_require(p_actor,p_plan ->> 'path','read');
	v_key := public.qorpera_company_path_key(p_plan ->> 'path');
	-- These operational surfaces have existing database projections. A generic
	-- file write cannot impersonate hiring, a routine, a message or credentials.
	-- Their dedicated cloud adapters must own both projections before exposure.
	if split_part(v_key,'/',1) in ('.qorpera','.git','trail','inbox','credentials','secrets')
		or 'node_modules' = any(string_to_array(v_key,'/'))
		or (split_part(v_key,'/',1) = 'agents' and split_part(v_key,'/',3) = 'instructions.md')
		or (split_part(v_key,'/',1) = 'departments' and split_part(v_key,'/',3) in ('repository','worktrees')) then
		raise exception 'Company File path requires its dedicated adapter' using errcode = '42501'; end if;
	select * into v_entry from public.qorpera_company_path_entries
	where environment_id = (p_actor ->> 'environmentId')::uuid
		and path_key_sha256 = extensions.digest(v_key,'sha256');
	if p_check_version and v_entry.version is distinct from (p_plan ->> 'expectedVersion')::uuid then
		raise exception 'Company File path version changed' using errcode = '40001'; end if;
	if p_check_version and p_plan -> 'entry' = 'null'::jsonb and v_entry.entry is null then
		raise exception 'Company File deletion target is unavailable' using errcode = '40001'; end if;
	if p_check_bytes and p_plan #>> '{entry,kind}' = 'file' and not public.qorpera_company_path_file_available(
		(p_actor ->> 'companyId')::uuid,p_plan #> '{entry,file}') then
		raise exception 'Company File mutation bytes are not verified' using errcode = '55000'; end if;
	return v_resource;
end
$$;

create function public.qorpera_company_path_protected(p_resource public.qorpera_company_path_resources,p_plan jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select p_resource.policy = 'protected' or p_plan -> 'entry' = 'null'::jsonb
		or public.qorpera_company_path_key(p_plan ->> 'path') in ('authority.toml','agents.md','claude.md')
		or split_part(public.qorpera_company_path_key(p_plan ->> 'path'),'/',1)
			in ('finance','money','identity','membership','production')
$$;

-- Preflight exact content hashes before immutable staging. It permits no
-- effect, but avoids using an ungranted path as an object-upload capability.
-- A completed retry is checked before its now-obsolete version precondition.
create function public.qorpera_check_company_path_mutation(p_environment_id uuid,p_binding jsonb,p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_resource public.qorpera_company_path_resources%rowtype; v_receipt public.qorpera_run_operation_receipts%rowtype;
begin
	if p_binding is null then raise exception 'Native Company File binding is required' using errcode = '42501'; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	v_resource := public.qorpera_company_path_plan(v_actor,p_plan,false,false);
	select * into v_receipt from public.qorpera_run_operation_receipts where run_id = (v_actor ->> 'runId')::uuid
		and logical_operation_key = 'company_path:' || (p_plan ->> 'operationKey');
	if found then
		if v_receipt.input_sha256 <> public.qorpera_company_path_plan_digest(v_actor,p_plan) then
			raise exception 'Company File operation key is bound to different work' using errcode = '23505'; end if;
		if v_receipt.status <> 'completed' then
			raise exception 'Company File operation requires recovery' using errcode = '55000'; end if;
		return jsonb_build_object('state','completed','result',v_receipt.result);
	end if;
	perform public.qorpera_company_path_plan(v_actor,p_plan,true,false);
	return jsonb_build_object('state',case when public.qorpera_company_path_protected(v_resource,p_plan) then 'protected' else 'ready' end);
end
$$;

create function public.qorpera_prepare_company_path_mutation(p_environment_id uuid,p_binding jsonb,p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_checked jsonb;
begin
	v_checked := public.qorpera_check_company_path_mutation(p_environment_id,p_binding,p_plan);
	if v_checked ->> 'state' = 'completed' then return v_checked; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	perform public.qorpera_company_path_plan(v_actor,p_plan,true);
	if v_checked ->> 'state' = 'protected' then return v_checked; end if;
	return jsonb_build_object('state','ready','snapshotId',(
		select head_snapshot_id from public.qorpera_company_files where environment_id = p_environment_id),
		'entries',(select coalesce(jsonb_agg(entry order by path),'[]'::jsonb)
			from public.qorpera_company_path_entries where environment_id = p_environment_id and entry is not null));
end
$$;

-- Preserve the existing snapshot writer guard, adding only the private,
-- deferred revision intent created by the atomic path publisher below.
create or replace function public.qorpera_enforce_company_workspace_writer()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_workspace public.qorpera_company_workspaces%rowtype;
begin
	select * into v_workspace from public.qorpera_company_workspaces where id = new.workspace_id;
	if not found or v_workspace.profile_id <> new.profile_id or v_workspace.environment_id <> new.environment_id then
		raise exception 'company snapshot workspace is invalid' using errcode = '22023'; end if;
	if exists (select 1 from public.qorpera_company_path_revisions r
		join public.qorpera_company_files f on f.environment_id = r.environment_id
		where r.snapshot_id = new.id and r.environment_id = new.environment_id and f.profile_id = new.profile_id
			and f.canonical_workspace_id = new.workspace_id and f.path_gateway_version = 1
			and r.parent_snapshot_id = new.parent_snapshot_id and r.tree_sha256 = new.tree_manifest_sha256
			and r.tree_bytes = new.tree_manifest_bytes and new.tree_contract_version = 3
			and r.file_count = new.file_count and r.total_bytes = new.total_bytes and r.actor_user_id = new.created_by_user_id)
		then return new; end if;
	if auth.uid() is not null and v_workspace.created_by_user_id = auth.uid() and new.created_by_user_id = auth.uid() then return new; end if;
	if exists (select 1 from public.qorpera_runner_company_revision_intents i
		where i.client_revision_id = new.client_snapshot_id and i.profile_id = new.profile_id
			and i.environment_id = new.environment_id and i.workspace_id = new.workspace_id
			and i.parent_snapshot_id is not distinct from new.parent_snapshot_id
			and i.tree_manifest_sha256 = new.tree_manifest_sha256 and i.tree_manifest_bytes = new.tree_manifest_bytes
			and i.tree_contract_version = new.tree_contract_version and i.file_count = new.file_count
			and i.total_bytes = new.total_bytes and i.created_by_user_id = new.created_by_user_id) then return new; end if;
	raise exception 'company workspace head belongs to another writer' using errcode = '42501';
end
$$;

create function public.qorpera_publish_company_path(
	p_actor jsonb,p_binding jsonb,p_plan jsonb,p_expected_head uuid,p_tree_sha256 text,p_receipt_id uuid,p_proposal_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_file public.qorpera_company_files%rowtype; v_tree public.qorpera_company_path_tree_cache%rowtype;
	v_resource public.qorpera_company_path_resources%rowtype; v_snapshot uuid := extensions.gen_random_uuid();
	v_version uuid := extensions.gen_random_uuid(); v_graph uuid := extensions.gen_random_uuid(); v_objects jsonb;
	v_object_count integer; v_storage_bytes bigint; v_closure_sha text; v_restricted_sha text;
	v_entry jsonb := nullif(p_plan -> 'entry','null'::jsonb);
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Company File publisher authority is required' using errcode = '42501'; end if;
	v_resource := public.qorpera_company_path_plan(p_actor,p_plan,true);
	select * into strict v_file from public.qorpera_company_files where environment_id = (p_actor ->> 'environmentId')::uuid for update;
	if v_file.head_snapshot_id is distinct from p_expected_head or v_file.path_index_snapshot_id is distinct from p_expected_head then
		raise exception 'Company File head changed' using errcode = 'PT409'; end if;
	select * into v_tree from public.qorpera_company_path_tree_cache where profile_id = v_file.profile_id and sha256 = p_tree_sha256;
	if not found then raise exception 'Company File candidate is not verified' using errcode = '55000'; end if;
	-- This write is private to this SQL transaction. Any later validation,
	-- lease, storage, trigger or receipt failure rolls it back with the head.
	insert into public.qorpera_company_path_entries(environment_id,path,version,entry)
	values (v_file.environment_id,p_plan ->> 'path',v_version,v_entry)
	on conflict (environment_id,path_key_sha256) do update set version = excluded.version,entry = excluded.entry,updated_at = clock_timestamp();
	if exists ((select entry from public.qorpera_company_path_entries where environment_id = v_file.environment_id and entry is not null)
		except (select value from jsonb_array_elements(v_tree.manifest -> 'entries')))
		or exists ((select value from jsonb_array_elements(v_tree.manifest -> 'entries')) except
			(select entry from public.qorpera_company_path_entries where environment_id = v_file.environment_id and entry is not null)) then
		raise exception 'Company File candidate does not match the exact mutation' using errcode = '22023'; end if;
	if exists (select 1 from jsonb_array_elements(v_tree.manifest -> 'entries') where value ->> 'kind' = 'file'
		and not public.qorpera_company_path_file_available(v_file.profile_id,value -> 'file')) then
		raise exception 'Company File candidate objects are unavailable' using errcode = '55000'; end if;
	select jsonb_agg(object order by object ->> 'sha256') into v_objects from (
		select distinct o.value as object from jsonb_array_elements(v_tree.manifest -> 'entries') e
		join public.qorpera_verified_company_file_objects proof
			on proof.profile_id = v_file.profile_id and proof.manifest_sha256 = e #>> '{file,manifestSha256}'
		cross join lateral jsonb_array_elements(proof.objects) o(value)
		union select jsonb_build_object('sha256',v_tree.sha256,'bytes',v_tree.bytes)
	) closure;
	select count(*),sum((value ->> 'bytes')::bigint),encode(extensions.digest(convert_to(string_agg(
		(value ->> 'sha256') || ':' || (value ->> 'bytes'),E'\n' order by value ->> 'sha256'),'utf8'),'sha256'),'hex')
	into v_object_count,v_storage_bytes,v_closure_sha from jsonb_array_elements(v_objects);
	if v_object_count > 400000 or exists (select 1 from jsonb_array_elements(v_objects) o
		left join public.qorpera_profile_objects stored on stored.profile_id = v_file.profile_id and stored.sha256 = o ->> 'sha256'
		where stored.sha256 is null or stored.bytes <> (o ->> 'bytes')::bigint) then
		raise exception 'Company File closure is unavailable' using errcode = '55000'; end if;
	select encode(extensions.digest(convert_to(coalesce(jsonb_agg(value order by value ->> 'path'),'[]'::jsonb)::text,'utf8'),'sha256'),'hex')
	into v_restricted_sha from jsonb_array_elements(v_tree.manifest -> 'entries') where public.qorpera_company_path_key(value ->> 'path')
		in ('authority.toml','agents.md','claude.md','.qorpera/authority.sig.json');
	insert into public.qorpera_company_path_revisions(snapshot_id,environment_id,parent_snapshot_id,tree_sha256,tree_bytes,
		file_count,total_bytes,run_id,receipt_id,proposal_id,actor_user_id,actor_staff_id,change)
	values (v_snapshot,v_file.environment_id,p_expected_head,v_tree.sha256,v_tree.bytes,v_tree.file_count,v_tree.total_bytes,
		(p_actor ->> 'runId')::uuid,p_receipt_id,p_proposal_id,(p_actor ->> 'userId')::uuid,(p_actor ->> 'staffAgentId')::uuid,
		jsonb_build_object('plan',p_plan,'version',v_version,'actor',p_actor - 'assignmentId',
			'resourceId',v_resource.id,'resourceVersion',v_resource.version));
	insert into public.qorpera_company_snapshots(id,profile_id,environment_id,workspace_id,client_snapshot_id,parent_snapshot_id,
		tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes,created_by_user_id)
	values (v_snapshot,v_file.profile_id,v_file.environment_id,v_file.canonical_workspace_id,v_snapshot,p_expected_head,
		v_tree.sha256,v_tree.bytes,3,v_tree.file_count,v_tree.total_bytes,(p_actor ->> 'userId')::uuid);
	insert into public.qorpera_company_snapshot_publications(snapshot_id,expected_head_snapshot_id,restricted_content_sha256)
	values (v_snapshot,p_expected_head,v_restricted_sha);
	insert into public.qorpera_object_reachability_graphs(id,profile_id,environment_id,root_kind,root_id,client_graph_id,
		root_object_sha256,contract_version,content_sha256,object_count,storage_bytes,created_by_user_id)
	values (v_graph,v_file.profile_id,v_file.environment_id,'company_snapshot',v_snapshot,v_graph,
		v_tree.sha256,1,v_closure_sha,v_object_count,v_storage_bytes,(p_actor ->> 'userId')::uuid);
	insert into public.qorpera_object_reachability_entries(graph_id,object_sha256,bytes)
	select v_graph,value ->> 'sha256',(value ->> 'bytes')::bigint from jsonb_array_elements(v_objects);
	update public.qorpera_object_reachability_graphs set status = 'complete',completed_at = clock_timestamp(),closure_verified = true where id = v_graph;
	insert into public.qorpera_object_restore_proofs(graph_id,profile_id,client_proof_id,restored_content_sha256,restored_bytes,verified_by_user_id)
	values (v_graph,v_file.profile_id,v_graph,v_tree.sha256,v_tree.total_bytes,(p_actor ->> 'userId')::uuid);
	-- Time is checked after the expensive work and lock waits, immediately
	-- before the live pointer. Revocation rows remain locked through commit.
	if p_binding is not null then perform public.qorpera_native_tool_locked_run(p_binding); end if;
	perform public.qorpera_company_path_assert_context(p_actor);
	perform public.qorpera_company_path_require(p_actor,p_plan ->> 'path','write');
	if p_proposal_id is not null and not exists (select 1 from public.qorpera_company_path_proposals
		where id = p_proposal_id and status = 'approved' and approval_expires_at > clock_timestamp()
			and approved_by_user_id = (p_actor ->> 'userId')::uuid and resource_version = v_resource.version) then
		raise exception 'Company File approval expired or changed' using errcode = '42501'; end if;
	update public.qorpera_company_snapshot_publications set status = 'published',published_at = clock_timestamp() where snapshot_id = v_snapshot;
	update public.qorpera_company_files set head_snapshot_id = v_snapshot,path_index_snapshot_id = v_snapshot,
		logical_bytes = v_tree.total_bytes,state = 'ready',updated_at = clock_timestamp() where environment_id = v_file.environment_id;
	update public.qorpera_company_workspaces set head_snapshot_id = v_snapshot,updated_at = clock_timestamp() where id = v_file.canonical_workspace_id;
	return jsonb_build_object('schema','qorpera.company-path-result/v1','state','applied','receiptId',p_receipt_id,
		'operationKey',p_plan ->> 'operationKey','path',p_plan ->> 'path','version',v_version,'snapshotId',v_snapshot,'proposalId',p_proposal_id);
end
$$;

create function public.qorpera_commit_company_path_mutation(p_environment_id uuid,p_binding jsonb,p_plan jsonb,
	p_expected_head uuid default null,p_tree_sha256 text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_resource public.qorpera_company_path_resources%rowtype; v_prepared jsonb;
	v_receipt_id uuid := extensions.gen_random_uuid(); v_proposal_id uuid; v_digest text; v_begun jsonb; v_result jsonb;
begin
	v_prepared := public.qorpera_prepare_company_path_mutation(p_environment_id,p_binding,p_plan);
	if v_prepared ->> 'state' = 'completed' then return v_prepared -> 'result'; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	v_resource := public.qorpera_company_path_plan(v_actor,p_plan,true);
	v_digest := public.qorpera_company_path_plan_digest(v_actor,p_plan);
	v_begun := public.qorpera_begin_native_tool_operation(p_binding,v_receipt_id,'company_path:' || (p_plan ->> 'operationKey'),
		v_digest,encode(extensions.digest(convert_to((v_actor ->> 'runId') || ':' || (p_plan ->> 'operationKey'),'utf8'),'sha256'),'hex'),true);
	if v_begun ->> 'receipt_id' <> v_receipt_id::text or v_begun ->> 'state' <> 'executing' then
		raise exception 'Company File operation requires recovery' using errcode = '55000'; end if;
	if public.qorpera_company_path_protected(v_resource,p_plan) then
		if p_expected_head is not null or p_tree_sha256 is not null then
			raise exception 'Protected Company File mutation requires a proposal' using errcode = '42501'; end if;
		perform public.qorpera_company_path_assert_context(v_actor);
		insert into public.qorpera_company_path_proposals(environment_id,run_id,receipt_id,plan,plan_sha256,resource_id,resource_version)
		values (p_environment_id,(v_actor ->> 'runId')::uuid,v_receipt_id,p_plan,v_digest,v_resource.id,v_resource.version) returning id into v_proposal_id;
		v_result := jsonb_build_object('schema','qorpera.company-path-result/v1','state','proposed','receiptId',v_receipt_id,
			'operationKey',p_plan ->> 'operationKey','path',p_plan ->> 'path','version',p_plan -> 'expectedVersion',
			'snapshotId',null,'proposalId',v_proposal_id);
	else
		v_result := public.qorpera_publish_company_path(v_actor,p_binding,p_plan,p_expected_head,p_tree_sha256,v_receipt_id,null);
	end if;
	update public.qorpera_run_operation_receipts set status = 'completed',result = v_result,completed_at = clock_timestamp(),
		output_snapshot_id = (v_result ->> 'snapshotId')::uuid,company_path_proposal_id = v_proposal_id where id = v_receipt_id;
	return v_result;
end
$$;

create function public.qorpera_assert_company_path_reads(p_environment_id uuid,p_binding jsonb,p_paths text[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_path text;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	if p_paths is null or cardinality(p_paths) > 128 then
		raise exception 'Company File context read set is invalid' using errcode = '22023'; end if;
	foreach v_path in array p_paths loop perform public.qorpera_company_path_remember_read(v_actor,v_path); end loop;
	perform public.qorpera_company_path_assert_context(v_actor);
end
$$;

create function public.qorpera_review_company_path_proposal(p_proposal_id uuid,p_plan_sha256 text,p_decision text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_proposal public.qorpera_company_path_proposals%rowtype; v_actor jsonb; v_resource public.qorpera_company_path_resources%rowtype;
begin
	select * into v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id;
	v_actor := public.qorpera_company_path_actor(v_proposal.environment_id,null);
	select * into strict v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id for update;
	v_resource := public.qorpera_company_path_require(v_actor,v_proposal.plan ->> 'path','read');
	perform public.qorpera_company_path_require(v_actor,v_proposal.plan ->> 'path','write');
	perform public.qorpera_company_path_assert_context(v_actor || jsonb_build_object('runId',v_proposal.run_id));
	if p_decision not in ('approve','reject','skip') or p_plan_sha256 is distinct from v_proposal.plan_sha256 then
		raise exception 'Company File review differs from its proposal' using errcode = '22023'; end if;
	if (v_resource.scope = 'company_shared' and not public.qorpera_can_authorize_profile((v_actor ->> 'companyId')::uuid))
		or (v_resource.scope = 'member_private' and v_resource.owner_user_id <> auth.uid()) then
		raise exception 'Company File review authority is required' using errcode = '42501'; end if;
	if v_proposal.status in ('applied','rejected') then return jsonb_build_object('state',v_proposal.status); end if;
	if v_resource.id <> v_proposal.resource_id or v_resource.version <> v_proposal.resource_version then
		raise exception 'Company File proposal policy changed' using errcode = '40001'; end if;
	if p_decision = 'approve' then
		perform public.qorpera_company_path_plan(v_actor,v_proposal.plan,true);
		-- A retry does not silently extend a prior approval's lifetime.
		if v_proposal.status = 'approved' then
			if v_proposal.approved_by_user_id <> auth.uid() or v_proposal.approval_expires_at <= clock_timestamp() then
				raise exception 'Company File approval is unavailable' using errcode = '42501'; end if;
		else
			update public.qorpera_company_path_proposals set status = 'approved',approved_by_user_id = auth.uid(),
				approval_expires_at = clock_timestamp() + interval '10 minutes' where id = p_proposal_id;
		end if;
	elsif p_decision = 'reject' then
		update public.qorpera_company_path_proposals set status = 'rejected',resolved_by_user_id = auth.uid(),resolved_at = clock_timestamp()
		where id = p_proposal_id;
	else
		-- Dismissal/skip is not consent. It also withdraws an unexecuted approval.
		update public.qorpera_company_path_proposals set status = 'open',approved_by_user_id = null,approval_expires_at = null
		where id = p_proposal_id;
	end if;
	return jsonb_build_object('state',case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'skipped' end);
end
$$;

create function public.qorpera_company_path_approved_actor(p_proposal_id uuid,p_plan_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_proposal public.qorpera_company_path_proposals%rowtype; v_file public.qorpera_company_files%rowtype;
	v_resource public.qorpera_company_path_resources%rowtype; v_run public.qorpera_execution_runs%rowtype; v_actor jsonb; v_role public.qorpera_profile_role;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Company File publisher authority is required' using errcode = '42501'; end if;
	select * into v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id;
	select * into v_file from public.qorpera_company_files where environment_id = v_proposal.environment_id;
	perform public.qorpera_lock_profile_gc_fence(v_file.profile_id);
	select * into strict v_file from public.qorpera_company_files where environment_id = v_proposal.environment_id for update;
	select * into strict v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id for update;
	select role into v_role from public.qorpera_profile_members where profile_id = v_file.profile_id
		and user_id = v_proposal.approved_by_user_id for share;
	if not found or v_proposal.plan_sha256 is distinct from p_plan_sha256
		or v_proposal.status not in ('approved','applied') or v_file.path_gateway_version is distinct from 1
		or v_file.path_index_snapshot_id is distinct from v_file.head_snapshot_id
		or public.qorpera_profile_gc_deletion_active(v_file.profile_id) then
		raise exception 'Company File approval authority is unavailable' using errcode = '42501'; end if;
	v_actor := jsonb_build_object('companyId',v_file.profile_id,'environmentId',v_file.environment_id,
		'userId',v_proposal.approved_by_user_id,'staffAgentId',null,'runId',v_proposal.run_id,'audience','human');
	v_resource := public.qorpera_company_path_require(v_actor,v_proposal.plan ->> 'path','read');
	perform public.qorpera_company_path_require(v_actor,v_proposal.plan ->> 'path','write');
	if (v_resource.scope = 'company_shared' and v_role not in ('owner','admin'))
		or (v_resource.scope = 'member_private' and v_resource.owner_user_id <> v_proposal.approved_by_user_id)
		or v_resource.id <> v_proposal.resource_id or v_resource.version <> v_proposal.resource_version then
		raise exception 'Company File approval policy changed' using errcode = '42501'; end if;
	if v_proposal.status = 'applied' then return v_actor; end if;
	if v_proposal.approval_expires_at <= clock_timestamp() then
		raise exception 'Company File approval expired' using errcode = '42501'; end if;
	select * into strict v_run from public.qorpera_execution_runs where id = v_proposal.run_id;
	perform 1 from public.qorpera_profile_members where profile_id = v_file.profile_id and user_id = v_run.requested_by_user_id for share;
	perform 1 from public.qorpera_profile_staff where profile_id = v_file.profile_id and staff_agent_id = v_run.staff_agent_id for share;
	if not public.qorpera_company_path_principal_allowed(v_file.profile_id,v_resource,'member',v_run.requested_by_user_id,'write')
		or not public.qorpera_company_path_principal_allowed(v_file.profile_id,v_resource,'staff_agent',v_run.staff_agent_id,'write') then
		raise exception 'Company File proposal source authority was revoked' using errcode = '42501'; end if;
	perform public.qorpera_company_path_assert_context(jsonb_build_object(
		'companyId',v_file.profile_id,'environmentId',v_file.environment_id,'runId',v_run.id,
		'userId',v_run.requested_by_user_id,'staffAgentId',v_run.staff_agent_id,'audience','company'));
	perform public.qorpera_company_path_assert_context(v_actor);
	-- This is a new, exact human-authorized effect. It does not renew the old
	-- run, release credentials, replay its model context, or publish a send.
	perform public.qorpera_company_path_plan(v_actor,v_proposal.plan,true);
	return v_actor;
end
$$;

create function public.qorpera_prepare_company_path_approval(p_proposal_id uuid,p_plan_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_proposal public.qorpera_company_path_proposals%rowtype;
begin
	v_actor := public.qorpera_company_path_approved_actor(p_proposal_id,p_plan_sha256);
	select * into strict v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id;
	return jsonb_build_object('state',v_proposal.status,'plan',v_proposal.plan,'companyId',v_actor ->> 'companyId',
		'environmentId',v_actor ->> 'environmentId','outputSnapshotId',v_proposal.output_snapshot_id,
		'snapshotId',(select head_snapshot_id from public.qorpera_company_files where environment_id = v_proposal.environment_id),
		'entries',case when v_proposal.status = 'applied' then '[]'::jsonb else (
			select coalesce(jsonb_agg(entry order by path),'[]'::jsonb) from public.qorpera_company_path_entries
			where environment_id = v_proposal.environment_id and entry is not null) end);
end
$$;

create function public.qorpera_apply_company_path_approval(p_proposal_id uuid,p_plan_sha256 text,p_expected_head uuid,p_tree_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_proposal public.qorpera_company_path_proposals%rowtype; v_result jsonb;
begin
	v_actor := public.qorpera_company_path_approved_actor(p_proposal_id,p_plan_sha256);
	select * into strict v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id;
	if v_proposal.status = 'applied' then
		return jsonb_build_object('state','applied','proposalId',p_proposal_id,'snapshotId',v_proposal.output_snapshot_id);
	end if;
	v_result := public.qorpera_publish_company_path(v_actor,null,v_proposal.plan,p_expected_head,p_tree_sha256,v_proposal.receipt_id,p_proposal_id);
	update public.qorpera_company_path_proposals set status = 'applied',resolved_by_user_id = approved_by_user_id,
		resolved_at = clock_timestamp(),output_snapshot_id = (v_result ->> 'snapshotId')::uuid where id = p_proposal_id;
	return jsonb_build_object('state','applied','proposalId',p_proposal_id,'snapshotId',v_result ->> 'snapshotId');
end
$$;

create function public.qorpera_get_company_path_proposal(p_proposal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_proposal public.qorpera_company_path_proposals%rowtype;
begin
	select * into v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id;
	v_actor := public.qorpera_company_path_actor(v_proposal.environment_id,null);
	select * into strict v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id;
	perform public.qorpera_company_path_require(v_actor,v_proposal.plan ->> 'path','read');
	perform public.qorpera_company_path_assert_context(v_actor || jsonb_build_object('runId',v_proposal.run_id));
	return jsonb_build_object('proposalId',v_proposal.id,'plan',v_proposal.plan,'planSha256',v_proposal.plan_sha256,
		'state',v_proposal.status,'snapshotId',v_proposal.output_snapshot_id);
end
$$;

-- No grandfathered broad hash capability for a governed company. Verified
-- services can still transport immutable bytes, but end-user and model reads
-- go through paths. Previously downloaded data cannot be made secret again.
create function public.qorpera_company_uses_path_gateway(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_company_files where profile_id = p_profile_id and path_gateway_version = 1)
$$;

create or replace function public.qorpera_authorize_profile_object_download(p_profile_id uuid,p_sha256 text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_object public.qorpera_profile_objects%rowtype; v_role text := coalesce(auth.role(),'');
begin
	if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or v_role not in ('authenticated','service_role') then
		raise exception 'object download authority is invalid' using errcode = '22023'; end if;
	if v_role = 'authenticated' and (auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id)
		or public.qorpera_company_uses_path_gateway(p_profile_id)) then
		raise exception 'authorized Company File path read is required' using errcode = '42501'; end if;
	select * into v_object from public.qorpera_profile_objects where profile_id = p_profile_id and sha256 = p_sha256;
	if not found then raise exception 'profile object is unavailable' using errcode = '55000'; end if;
	return jsonb_build_object('backend',v_object.backend,'bytes',v_object.bytes);
end
$$;

alter policy qorpera_profile_objects_member_read on storage.objects using (
	bucket_id = 'qorpera-profile-objects'
	and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{64}$'
	and public.qorpera_can_read_profile(((storage.foldername(name))[1])::uuid)
	and not public.qorpera_company_uses_path_gateway(((storage.foldername(name))[1])::uuid)
);

create function public.qorpera_enforce_company_path_head()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if old.path_gateway_version = 1 and (new.path_gateway_version is distinct from 1
		or new.path_index_snapshot_id is distinct from new.head_snapshot_id
		or new.canonical_workspace_id is distinct from old.canonical_workspace_id
		or (new.head_snapshot_id is distinct from old.head_snapshot_id and not exists (
			select 1 from public.qorpera_company_path_revisions where snapshot_id = new.head_snapshot_id
				and environment_id = new.environment_id and parent_snapshot_id = old.head_snapshot_id))) then
		raise exception 'Company File changes require the path gateway' using errcode = '42501'; end if;
	return new;
end
$$;
create trigger qorpera_company_path_head_guard before update on public.qorpera_company_files
for each row execute function public.qorpera_enforce_company_path_head();

create function public.qorpera_enforce_company_path_workspace()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if new.head_snapshot_id is distinct from old.head_snapshot_id and exists (
		select 1 from public.qorpera_company_files where canonical_workspace_id = new.id and path_gateway_version = 1
			and head_snapshot_id is distinct from new.head_snapshot_id) then
		raise exception 'Company File workspace changes require the path gateway' using errcode = '42501'; end if;
	return new;
end
$$;
create trigger qorpera_company_path_workspace_guard before update on public.qorpera_company_workspaces
for each row execute function public.qorpera_enforce_company_path_workspace();

create or replace function public.qorpera_company_additional_retained_object_hashes(p_profile_id uuid)
returns table (object_sha256 text) language sql stable security definer set search_path = '' as $$
	select computer.encrypted_volume_object_sha256 from public.qorpera_logical_computers computer
	where computer.profile_id = p_profile_id and computer.status <> 'retired' and computer.encrypted_volume_object_sha256 is not null
	union
	select provider_session.context_checkpoint_object_sha256
	from public.qorpera_execution_provider_sessions provider_session
	join public.qorpera_execution_runs run on run.id = provider_session.run_id
	join public.qorpera_runner_jobs job on job.id = run.job_id
	where provider_session.profile_id = p_profile_id and provider_session.context_checkpoint_object_sha256 is not null and (
		job.status in ('queued','leased') or provider_session.created_at >= statement_timestamp() - interval '30 days'
		or (run.session_id is not null and exists (select 1 from public.qorpera_shared_sessions s where s.id = run.session_id and s.status = 'open')
			and not exists (select 1 from public.qorpera_execution_provider_sessions newer_session
				join public.qorpera_execution_runs newer_run on newer_run.id = newer_session.run_id
				where newer_run.session_id = run.session_id and newer_session.profile_id = provider_session.profile_id
					and (newer_session.created_at,newer_session.run_id) > (provider_session.created_at,provider_session.run_id))))
	union
	select attachment ->> 'objectSha256' from public.qorpera_shared_sessions session
	join public.qorpera_session_events event on event.session_id = session.id
	cross join lateral jsonb_array_elements(coalesce(event.body #> '{entry,qorperaAttachments}','[]'::jsonb)) attachment
	where session.profile_id = p_profile_id and event.session_input_id is not null and attachment ->> 'objectSha256' ~ '^[0-9a-f]{64}$'
	union
	select object ->> 'sha256' from public.qorpera_company_path_proposals proposal
	join public.qorpera_company_files file on file.environment_id = proposal.environment_id
	join public.qorpera_verified_company_file_objects proof on proof.profile_id = file.profile_id
		and proof.manifest_sha256 = proposal.plan #>> '{entry,file,manifestSha256}'
	cross join lateral jsonb_array_elements(proof.objects) object
	where file.profile_id = p_profile_id and (proposal.status in ('open','approved')
		or proposal.resolved_at >= statement_timestamp() - interval '30 days')
$$;

-- Revoke defaults explicitly, including service-role defaults for helpers.
do $$
declare v_function regprocedure;
begin
	for v_function in select p.oid::regprocedure from pg_catalog.pg_proc p
	join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any(array[
		'qorpera_company_path_key','qorpera_company_path_valid','qorpera_company_path_entry_valid','qorpera_company_path_resource',
		'qorpera_company_path_principal_allowed','qorpera_company_path_actor','qorpera_company_path_allowed','qorpera_company_path_require',
		'qorpera_company_path_remember_read','qorpera_company_path_assert_context','qorpera_enforce_company_context_send',
		'qorpera_read_company_path','qorpera_list_company_paths','qorpera_verify_company_path_file','qorpera_company_path_file_available',
		'qorpera_verify_company_path_tree','qorpera_enable_company_path_gateway','qorpera_set_company_path_resource','qorpera_grant_company_path',
		'qorpera_revoke_company_path','qorpera_company_path_plan_digest','qorpera_company_path_plan','qorpera_company_path_protected',
		'qorpera_check_company_path_mutation','qorpera_prepare_company_path_mutation','qorpera_publish_company_path','qorpera_commit_company_path_mutation',
		'qorpera_assert_company_path_reads','qorpera_review_company_path_proposal','qorpera_company_path_approved_actor',
		'qorpera_prepare_company_path_approval','qorpera_apply_company_path_approval','qorpera_get_company_path_proposal',
		'qorpera_company_uses_path_gateway','qorpera_enforce_company_path_head','qorpera_enforce_company_path_workspace'
	]) loop execute format('revoke all on function %s from public, anon, authenticated, service_role',v_function); end loop;
end
$$;
grant execute on function public.qorpera_company_uses_path_gateway(uuid) to authenticated,service_role;
grant execute on function public.qorpera_read_company_path(uuid,text,jsonb),public.qorpera_list_company_paths(uuid,text,text,uuid,integer,jsonb)
	to authenticated,service_role;
grant execute on function public.qorpera_set_company_path_resource(uuid,text,text,text,text,uuid),
	public.qorpera_grant_company_path(uuid,uuid,text,uuid,text[],timestamptz),public.qorpera_revoke_company_path(uuid,uuid,uuid),
	public.qorpera_review_company_path_proposal(uuid,text,text),public.qorpera_get_company_path_proposal(uuid) to authenticated;
grant execute on function public.qorpera_verify_company_path_file(uuid,text),public.qorpera_verify_company_path_tree(uuid,text),
	public.qorpera_check_company_path_mutation(uuid,jsonb,jsonb),
	public.qorpera_enable_company_path_gateway(uuid,uuid,uuid),public.qorpera_prepare_company_path_mutation(uuid,jsonb,jsonb),
	public.qorpera_commit_company_path_mutation(uuid,jsonb,jsonb,uuid,text),public.qorpera_assert_company_path_reads(uuid,jsonb,text[]),
	public.qorpera_prepare_company_path_approval(uuid,text),public.qorpera_apply_company_path_approval(uuid,text,uuid,text) to service_role;
