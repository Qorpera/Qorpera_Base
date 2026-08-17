-- Immutable artifact catalogs and conservative retention lifecycle.
--
-- Artifact records point at verified profile-scoped storage roots. Immutable
-- indexes bind a set of those records into a company substrate version.
-- Garbage-collection RPCs identify expired, unreferenced catalog records but
-- deliberately expose no storage-object deletion: chunk reachability remains
-- a separate contract that must be proven before physical cleanup is safe.

create table public.qorpera_artifacts (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	client_artifact_id uuid not null,
	session_id uuid references public.qorpera_shared_sessions(id) on delete set null,
	artifact_type text not null check (artifact_type ~ '^[a-z][a-z0-9_-]{0,63}$'),
	name text not null check (char_length(btrim(name)) between 1 and 256),
	root_object_sha256 text not null check (root_object_sha256 ~ '^[0-9a-f]{64}$'),
	content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint not null check (bytes between 0 and 1099511627776),
	media_type text not null check (
		char_length(media_type) between 3 and 256
		and media_type = lower(btrim(media_type))
		and media_type like '%/%'
		and media_type !~ E'[\\r\\n]'
	),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	eligible_for_gc_at timestamptz not null default statement_timestamp() + interval '30 days',
	unique (profile_id, client_artifact_id),
	check (eligible_for_gc_at >= created_at + interval '30 days')
);

create index qorpera_artifacts_environment_created
	on public.qorpera_artifacts (environment_id, created_at desc);

create table public.qorpera_artifact_indexes (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	client_index_id uuid not null,
	contract_version integer not null check (contract_version = 1),
	content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
	artifact_count integer not null check (artifact_count between 0 and 5000),
	total_bytes bigint not null check (total_bytes between 0 and 5497558138880000),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	unique (profile_id, client_index_id)
);

create table public.qorpera_artifact_index_entries (
	index_id uuid not null references public.qorpera_artifact_indexes(id) on delete cascade,
	ordinal integer not null check (ordinal between 1 and 5000),
	artifact_id uuid not null references public.qorpera_artifacts(id) on delete restrict,
	primary key (index_id, ordinal),
	unique (index_id, artifact_id)
);

create index qorpera_artifact_index_entries_artifact
	on public.qorpera_artifact_index_entries (artifact_id, index_id);

create table public.qorpera_artifact_retention_holds (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	artifact_id uuid not null references public.qorpera_artifacts(id) on delete cascade,
	client_hold_id uuid not null,
	reason text not null check (char_length(btrim(reason)) between 1 and 500),
	expires_at timestamptz,
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	released_by_user_id uuid references auth.users(id) on delete restrict,
	released_at timestamptz,
	unique (profile_id, client_hold_id),
	check (expires_at is null or expires_at > created_at),
	check ((released_at is null) = (released_by_user_id is null)),
	check (released_at is null or released_at >= created_at)
);

create index qorpera_artifact_retention_holds_active
	on public.qorpera_artifact_retention_holds (artifact_id, expires_at)
	where released_at is null;

alter table public.qorpera_artifacts enable row level security;
alter table public.qorpera_artifact_indexes enable row level security;
alter table public.qorpera_artifact_index_entries enable row level security;
alter table public.qorpera_artifact_retention_holds enable row level security;

revoke all on public.qorpera_artifacts from anon, authenticated;
revoke all on public.qorpera_artifact_indexes from anon, authenticated;
revoke all on public.qorpera_artifact_index_entries from anon, authenticated;
revoke all on public.qorpera_artifact_retention_holds from anon, authenticated;

create function public.qorpera_artifact_json(p_artifact public.qorpera_artifacts)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'artifact_id', p_artifact.id,
		'profile_id', p_artifact.profile_id,
		'environment_id', p_artifact.environment_id,
		'client_artifact_id', p_artifact.client_artifact_id,
		'session_id', p_artifact.session_id,
		'artifact_type', p_artifact.artifact_type,
		'name', p_artifact.name,
		'root_object_sha256', p_artifact.root_object_sha256,
		'content_sha256', p_artifact.content_sha256,
		'bytes', p_artifact.bytes,
		'media_type', p_artifact.media_type,
		'created_by_user_id', p_artifact.created_by_user_id,
		'created_at', p_artifact.created_at,
		'eligible_for_gc_at', p_artifact.eligible_for_gc_at
	)
$$;

create function public.qorpera_artifact_index_json(p_index public.qorpera_artifact_indexes)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'index_id', p_index.id,
		'profile_id', p_index.profile_id,
		'environment_id', p_index.environment_id,
		'client_index_id', p_index.client_index_id,
		'contract_version', p_index.contract_version,
		'content_sha256', p_index.content_sha256,
		'artifact_count', p_index.artifact_count,
		'total_bytes', p_index.total_bytes,
		'created_by_user_id', p_index.created_by_user_id,
		'created_at', p_index.created_at
	)
$$;

create function public.qorpera_artifact_retention_hold_json(p_hold public.qorpera_artifact_retention_holds)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'hold_id', p_hold.id,
		'profile_id', p_hold.profile_id,
		'artifact_id', p_hold.artifact_id,
		'client_hold_id', p_hold.client_hold_id,
		'reason', p_hold.reason,
		'expires_at', p_hold.expires_at,
		'created_by_user_id', p_hold.created_by_user_id,
		'created_at', p_hold.created_at,
		'released_by_user_id', p_hold.released_by_user_id,
		'released_at', p_hold.released_at
	)
$$;

revoke all on function public.qorpera_artifact_json(public.qorpera_artifacts) from public;
revoke all on function public.qorpera_artifact_index_json(public.qorpera_artifact_indexes) from public;
revoke all on function public.qorpera_artifact_retention_hold_json(public.qorpera_artifact_retention_holds) from public;

create function public.qorpera_register_artifact(
	p_environment_id uuid,
	p_client_artifact_id uuid,
	p_session_id uuid,
	p_artifact_type text,
	p_name text,
	p_root_object_sha256 text,
	p_content_sha256 text,
	p_bytes bigint,
	p_media_type text
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
	v_existing public.qorpera_artifacts%rowtype;
	v_artifact public.qorpera_artifacts%rowtype;
	v_name text := btrim(p_name);
	v_media_type text := lower(btrim(p_media_type));
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
	if p_client_artifact_id is null
		or p_artifact_type !~ '^[a-z][a-z0-9_-]{0,63}$'
		or char_length(v_name) not between 1 and 256
		or p_root_object_sha256 !~ '^[0-9a-f]{64}$'
		or p_content_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes not between 0 and 1099511627776
		or char_length(v_media_type) not between 3 and 256
		or v_media_type not like '%/%'
		or v_media_type ~ E'[\\r\\n]' then
		raise exception 'artifact is invalid' using errcode = '22023';
	end if;
	if p_session_id is not null then
		select session.* into v_session
		from public.qorpera_shared_sessions as session
		where session.id = p_session_id;
		if not found or v_session.profile_id <> v_profile_id or v_session.environment_id <> p_environment_id then
			raise exception 'artifact session is outside the environment' using errcode = '22023';
		end if;
	end if;
	if not exists (
		select 1
		from storage.objects as object
		where object.bucket_id = 'qorpera-profile-objects'
			and object.name = v_profile_id::text || '/' || p_root_object_sha256
	) then
		raise exception 'artifact root object is unavailable' using errcode = '22023';
	end if;

	select artifact.* into v_existing
	from public.qorpera_artifacts as artifact
	where artifact.profile_id = v_profile_id
		and artifact.client_artifact_id = p_client_artifact_id;
	if found then
		if v_existing.environment_id <> p_environment_id
			or v_existing.session_id is distinct from p_session_id
			or v_existing.artifact_type <> p_artifact_type
			or v_existing.name <> v_name
			or v_existing.root_object_sha256 <> p_root_object_sha256
			or v_existing.content_sha256 <> p_content_sha256
			or v_existing.bytes <> p_bytes
			or v_existing.media_type <> v_media_type then
			raise exception 'artifact client id is already bound to different content' using errcode = '23505';
		end if;
		return public.qorpera_artifact_json(v_existing);
	end if;

	insert into public.qorpera_artifacts (
		profile_id,
		environment_id,
		client_artifact_id,
		session_id,
		artifact_type,
		name,
		root_object_sha256,
		content_sha256,
		bytes,
		media_type,
		created_by_user_id
	)
	values (
		v_profile_id,
		p_environment_id,
		p_client_artifact_id,
		p_session_id,
		p_artifact_type,
		v_name,
		p_root_object_sha256,
		p_content_sha256,
		p_bytes,
		v_media_type,
		v_user_id
	)
	returning * into v_artifact;

	return public.qorpera_artifact_json(v_artifact);
end
$$;

create function public.qorpera_create_artifact_index(
	p_environment_id uuid,
	p_client_index_id uuid,
	p_artifact_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_profile_id uuid;
	v_artifact_ids uuid[] := coalesce(p_artifact_ids, '{}'::uuid[]);
	v_artifact_count integer;
	v_total_bytes bigint;
	v_content_sha256 text;
	v_existing public.qorpera_artifact_indexes%rowtype;
	v_index public.qorpera_artifact_indexes%rowtype;
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
	if p_client_index_id is null or cardinality(v_artifact_ids) > 5000 then
		raise exception 'artifact index is invalid' using errcode = '22023';
	end if;
	if cardinality(v_artifact_ids) <> (
		select count(distinct artifact_id)
		from unnest(v_artifact_ids) as artifact_id
	) then
		raise exception 'artifact index contains duplicate ids' using errcode = '22023';
	end if;

	select count(*), coalesce(sum(artifact.bytes), 0)
	into v_artifact_count, v_total_bytes
	from public.qorpera_artifacts as artifact
	where artifact.profile_id = v_profile_id
		and artifact.environment_id = p_environment_id
		and artifact.id = any(v_artifact_ids);
	if v_artifact_count <> cardinality(v_artifact_ids) then
		raise exception 'artifact index contains unavailable artifacts' using errcode = '22023';
	end if;

	select coalesce(array_agg(artifact_id order by artifact_id), '{}'::uuid[])
	into v_artifact_ids
	from unnest(v_artifact_ids) as artifact_id;
	v_content_sha256 := encode(
		extensions.digest(
			convert_to(
				jsonb_build_object(
					'contract_version', 1,
					'profile_id', v_profile_id,
					'environment_id', p_environment_id,
					'artifact_ids', to_jsonb(v_artifact_ids)
				)::text,
				'utf8'
			),
			'sha256'
		),
		'hex'
	);

	select artifact_index.* into v_existing
	from public.qorpera_artifact_indexes as artifact_index
	where artifact_index.profile_id = v_profile_id
		and artifact_index.client_index_id = p_client_index_id;
	if found then
		if v_existing.environment_id <> p_environment_id
			or v_existing.content_sha256 <> v_content_sha256
			or v_existing.artifact_count <> v_artifact_count
			or v_existing.total_bytes <> v_total_bytes then
			raise exception 'artifact client index id is already bound to different content' using errcode = '23505';
		end if;
		return public.qorpera_artifact_index_json(v_existing);
	end if;

	insert into public.qorpera_artifact_indexes (
		profile_id,
		environment_id,
		client_index_id,
		contract_version,
		content_sha256,
		artifact_count,
		total_bytes,
		created_by_user_id
	)
	values (
		v_profile_id,
		p_environment_id,
		p_client_index_id,
		1,
		v_content_sha256,
		v_artifact_count,
		v_total_bytes,
		v_user_id
	)
	returning * into v_index;

	insert into public.qorpera_artifact_index_entries (index_id, ordinal, artifact_id)
	select v_index.id, (row_number() over (order by artifact_id))::integer, artifact_id
	from unnest(v_artifact_ids) as artifact_id;

	return public.qorpera_artifact_index_json(v_index);
end
$$;

create function public.qorpera_get_artifact_index(p_index_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_index public.qorpera_artifact_indexes%rowtype;
begin
	select artifact_index.* into v_index
	from public.qorpera_artifact_indexes as artifact_index
	where artifact_index.id = p_index_id;
	if not found or not public.qorpera_can_read_profile(v_index.profile_id) then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;
	return public.qorpera_artifact_index_json(v_index);
end
$$;

create function public.qorpera_list_artifact_index_entries(
	p_index_id uuid,
	p_after_ordinal integer default 0,
	p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_index public.qorpera_artifact_indexes%rowtype;
begin
	select artifact_index.* into v_index
	from public.qorpera_artifact_indexes as artifact_index
	where artifact_index.id = p_index_id;
	if not found or not public.qorpera_can_read_profile(v_index.profile_id) then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;
	if p_after_ordinal < 0 or p_after_ordinal > v_index.artifact_count
		or p_limit not between 1 and 500 then
		raise exception 'artifact index page is invalid' using errcode = '22023';
	end if;

	return coalesce((
		select jsonb_agg(
			public.qorpera_artifact_json(entry.artifact)
			|| jsonb_build_object('ordinal', entry.ordinal)
			order by entry.ordinal
		)
		from (
			select index_entry.ordinal, artifact
			from public.qorpera_artifact_index_entries as index_entry
			join public.qorpera_artifacts as artifact on artifact.id = index_entry.artifact_id
			where index_entry.index_id = p_index_id
				and index_entry.ordinal > p_after_ordinal
			order by index_entry.ordinal
			limit p_limit
		) as entry
	), '[]'::jsonb);
end
$$;

create function public.qorpera_create_artifact_retention_hold(
	p_artifact_id uuid,
	p_client_hold_id uuid,
	p_reason text,
	p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_artifact public.qorpera_artifacts%rowtype;
	v_existing public.qorpera_artifact_retention_holds%rowtype;
	v_hold public.qorpera_artifact_retention_holds%rowtype;
	v_reason text := btrim(p_reason);
begin
	select artifact.* into v_artifact
	from public.qorpera_artifacts as artifact
	where artifact.id = p_artifact_id;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_artifact.profile_id) then
		raise exception 'artifact retention requires full access' using errcode = '42501';
	end if;
	if p_client_hold_id is null or char_length(v_reason) not between 1 and 500
		or (p_expires_at is not null and p_expires_at <= statement_timestamp()) then
		raise exception 'artifact retention hold is invalid' using errcode = '22023';
	end if;

	select hold.* into v_existing
	from public.qorpera_artifact_retention_holds as hold
	where hold.profile_id = v_artifact.profile_id
		and hold.client_hold_id = p_client_hold_id;
	if found then
		if v_existing.artifact_id <> p_artifact_id
			or v_existing.reason <> v_reason
			or v_existing.expires_at is distinct from p_expires_at then
			raise exception 'artifact retention client id is already bound to different content' using errcode = '23505';
		end if;
		return public.qorpera_artifact_retention_hold_json(v_existing);
	end if;

	insert into public.qorpera_artifact_retention_holds (
		profile_id,
		artifact_id,
		client_hold_id,
		reason,
		expires_at,
		created_by_user_id
	)
	values (
		v_artifact.profile_id,
		p_artifact_id,
		p_client_hold_id,
		v_reason,
		p_expires_at,
		v_user_id
	)
	returning * into v_hold;

	return public.qorpera_artifact_retention_hold_json(v_hold);
end
$$;

create function public.qorpera_release_artifact_retention_hold(p_hold_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_hold public.qorpera_artifact_retention_holds%rowtype;
begin
	select hold.* into v_hold
	from public.qorpera_artifact_retention_holds as hold
	where hold.id = p_hold_id
	for update;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_hold.profile_id) then
		raise exception 'artifact retention requires full access' using errcode = '42501';
	end if;
	if v_hold.released_at is null then
		update public.qorpera_artifact_retention_holds
		set released_by_user_id = v_user_id,
			released_at = statement_timestamp()
		where id = p_hold_id
		returning * into v_hold;
	end if;
	return public.qorpera_artifact_retention_hold_json(v_hold);
end
$$;

alter table public.qorpera_company_substrate_versions
	add column artifact_index_id uuid references public.qorpera_artifact_indexes(id) on delete restrict;

create index qorpera_company_substrate_versions_artifact_index
	on public.qorpera_company_substrate_versions (artifact_index_id)
	where artifact_index_id is not null;

create function public.qorpera_list_artifact_gc_candidates(
	p_profile_id uuid,
	p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
	if auth.uid() is null or not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'artifact garbage collection requires full access' using errcode = '42501';
	end if;
	if p_limit not between 1 and 500 then
		raise exception 'artifact garbage collection page is invalid' using errcode = '22023';
	end if;

	return coalesce((
		select jsonb_agg(
			public.qorpera_artifact_json(artifact)
			|| jsonb_build_object(
				'object_deletion_ready', false,
				'blocked_reason', 'verified object reachability graph is not available'
			)
			order by artifact.eligible_for_gc_at, artifact.id
		)
		from (
			select candidate.*
			from public.qorpera_artifacts as candidate
			where candidate.profile_id = p_profile_id
				and candidate.eligible_for_gc_at <= statement_timestamp()
				and not exists (
					select 1
					from public.qorpera_artifact_retention_holds as hold
					where hold.artifact_id = candidate.id
						and hold.released_at is null
						and (hold.expires_at is null or hold.expires_at > statement_timestamp())
				)
				and not exists (
					select 1
					from public.qorpera_artifact_index_entries as index_entry
					join public.qorpera_company_substrate_versions as version
						on version.artifact_index_id = index_entry.index_id
					where index_entry.artifact_id = candidate.id
				)
			order by candidate.eligible_for_gc_at, candidate.id
			limit p_limit
		) as artifact
	), '[]'::jsonb);
end
$$;

create or replace function public.qorpera_company_substrate_version_json(
	p_version public.qorpera_company_substrate_versions
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'version_id', p_version.id,
		'profile_id', p_version.profile_id,
		'environment_id', p_version.environment_id,
		'company_snapshot_id', p_version.company_snapshot_id,
		'client_version_id', p_version.client_version_id,
		'contract_version', p_version.contract_version,
		'operation_sequence', p_version.operation_sequence,
		'operation_count', p_version.operation_count,
		'artifact_index_id', p_version.artifact_index_id,
		'artifact_manifest_sha256', p_version.artifact_manifest_sha256,
		'content_sha256', p_version.content_sha256,
		'created_by_user_id', p_version.created_by_user_id,
		'created_at', p_version.created_at
	)
$$;

create function public.qorpera_capture_company_substrate_version_v2(
	p_snapshot_id uuid,
	p_client_version_id uuid,
	p_contract_version integer,
	p_artifact_index_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_artifact_index public.qorpera_artifact_indexes%rowtype;
	v_existing public.qorpera_company_substrate_versions%rowtype;
	v_version public.qorpera_company_substrate_versions%rowtype;
	v_operation_sequence bigint := 0;
	v_operation_count bigint := 0;
	v_content_sha256 text;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if p_snapshot_id is null or p_client_version_id is null
		or p_contract_version is null or p_contract_version <> 1
		or p_artifact_index_id is null then
		raise exception 'company substrate version is invalid' using errcode = '22023';
	end if;

	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	where snapshot.id = p_snapshot_id;
	if not found or not public.qorpera_can_write_profile(v_snapshot.profile_id) then
		raise exception 'profile write access is required' using errcode = '42501';
	end if;
	select artifact_index.* into v_artifact_index
	from public.qorpera_artifact_indexes as artifact_index
	where artifact_index.id = p_artifact_index_id;
	if not found
		or v_artifact_index.profile_id <> v_snapshot.profile_id
		or v_artifact_index.environment_id <> v_snapshot.environment_id then
		raise exception 'artifact index is outside the company environment' using errcode = '22023';
	end if;

	select version.* into v_existing
	from public.qorpera_company_substrate_versions as version
	where version.profile_id = v_snapshot.profile_id
		and version.client_version_id = p_client_version_id;
	if found then
		if v_existing.company_snapshot_id <> p_snapshot_id
			or v_existing.contract_version <> p_contract_version
			or v_existing.artifact_index_id is distinct from p_artifact_index_id then
			raise exception 'substrate client version id is already bound to different content' using errcode = '23505';
		end if;
		return public.qorpera_company_substrate_version_json(v_existing);
	end if;

	select clock.last_sequence into v_operation_sequence
	from public.qorpera_profile_operation_clocks as clock
	where clock.profile_id = v_snapshot.profile_id;
	v_operation_sequence := coalesce(v_operation_sequence, 0);

	select count(*) into v_operation_count
	from public.qorpera_company_operations as operation
	where operation.profile_id = v_snapshot.profile_id
		and operation.sequence <= v_operation_sequence
		and (operation.environment_id is null or operation.environment_id = v_snapshot.environment_id);

	v_content_sha256 := encode(
		extensions.digest(
			convert_to(
				jsonb_build_object(
					'contract_version', p_contract_version,
					'profile_id', v_snapshot.profile_id,
					'environment_id', v_snapshot.environment_id,
					'company_snapshot_id', p_snapshot_id,
					'operation_sequence', v_operation_sequence,
					'artifact_manifest_sha256', v_artifact_index.content_sha256
				)::text,
				'utf8'
			),
			'sha256'
		),
		'hex'
	);

	insert into public.qorpera_company_substrate_versions (
		profile_id,
		environment_id,
		company_snapshot_id,
		client_version_id,
		contract_version,
		operation_sequence,
		operation_count,
		artifact_index_id,
		artifact_manifest_sha256,
		content_sha256,
		created_by_user_id
	)
	values (
		v_snapshot.profile_id,
		v_snapshot.environment_id,
		p_snapshot_id,
		p_client_version_id,
		p_contract_version,
		v_operation_sequence,
		v_operation_count,
		p_artifact_index_id,
		v_artifact_index.content_sha256,
		v_content_sha256,
		v_user_id
	)
	returning * into v_version;

	return public.qorpera_company_substrate_version_json(v_version);
end
$$;

revoke all on function public.qorpera_register_artifact(uuid, uuid, uuid, text, text, text, text, bigint, text) from public;
revoke all on function public.qorpera_create_artifact_index(uuid, uuid, uuid[]) from public;
revoke all on function public.qorpera_get_artifact_index(uuid) from public;
revoke all on function public.qorpera_list_artifact_index_entries(uuid, integer, integer) from public;
revoke all on function public.qorpera_create_artifact_retention_hold(uuid, uuid, text, timestamptz) from public;
revoke all on function public.qorpera_release_artifact_retention_hold(uuid) from public;
revoke all on function public.qorpera_list_artifact_gc_candidates(uuid, integer) from public;
revoke all on function public.qorpera_capture_company_substrate_version_v2(uuid, uuid, integer, uuid) from public;

grant execute on function public.qorpera_register_artifact(uuid, uuid, uuid, text, text, text, text, bigint, text) to authenticated;
grant execute on function public.qorpera_create_artifact_index(uuid, uuid, uuid[]) to authenticated;
grant execute on function public.qorpera_get_artifact_index(uuid) to authenticated;
grant execute on function public.qorpera_list_artifact_index_entries(uuid, integer, integer) to authenticated;
grant execute on function public.qorpera_create_artifact_retention_hold(uuid, uuid, text, timestamptz) to authenticated;
grant execute on function public.qorpera_release_artifact_retention_hold(uuid) to authenticated;
grant execute on function public.qorpera_list_artifact_gc_candidates(uuid, integer) to authenticated;
grant execute on function public.qorpera_capture_company_substrate_version_v2(uuid, uuid, integer, uuid) to authenticated;
