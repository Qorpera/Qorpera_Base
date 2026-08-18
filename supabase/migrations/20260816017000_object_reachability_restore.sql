-- Verified object reachability and restore proofs.
--
-- Reachability graphs are uploaded in bounded batches, checked against the
-- private Storage catalog, and completed only when their canonical hash and
-- root object match. Restore proofs expire after seven days. Garbage
-- collection remains analysis-only: physical deletion requires a separate
-- service-role Storage worker and is never exposed to authenticated clients.

alter table public.qorpera_artifacts
	add column root_contract text not null default 'qorpera.unverified-root/v1'
	check (root_contract in (
		'qorpera.unverified-root/v1',
		'qorpera.object/v1',
		'qorpera.cloud-file-manifest/v1'
	));

create or replace function public.qorpera_artifact_json(p_artifact public.qorpera_artifacts)
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
		'root_contract', p_artifact.root_contract,
		'content_sha256', p_artifact.content_sha256,
		'bytes', p_artifact.bytes,
		'media_type', p_artifact.media_type,
		'created_by_user_id', p_artifact.created_by_user_id,
		'created_at', p_artifact.created_at,
		'eligible_for_gc_at', p_artifact.eligible_for_gc_at
	)
$$;

create function public.qorpera_register_artifact_v2(
	p_environment_id uuid,
	p_client_artifact_id uuid,
	p_session_id uuid,
	p_artifact_type text,
	p_name text,
	p_root_object_sha256 text,
	p_root_contract text,
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
		or p_root_contract not in ('qorpera.object/v1', 'qorpera.cloud-file-manifest/v1')
		or p_content_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes not between 0 and 1099511627776
		or char_length(v_media_type) not between 3 and 256
		or v_media_type not like '%/%'
		or v_media_type ~ E'[\\r\\n]' then
		raise exception 'artifact is invalid' using errcode = '22023';
	end if;
	if p_root_contract = 'qorpera.object/v1'
		and (p_root_object_sha256 <> p_content_sha256 or p_bytes > 8388608) then
		raise exception 'direct artifact object does not match its content' using errcode = '22023';
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
			or v_existing.root_contract <> p_root_contract
			or v_existing.content_sha256 <> p_content_sha256
			or v_existing.bytes <> p_bytes
			or v_existing.media_type <> v_media_type then
			raise exception 'artifact client id is already bound to different content' using errcode = '23505';
		end if;
		return public.qorpera_artifact_json(v_existing);
	end if;

	insert into public.qorpera_artifacts (
		profile_id, environment_id, client_artifact_id, session_id,
		artifact_type, name, root_object_sha256, root_contract,
		content_sha256, bytes, media_type, created_by_user_id
	)
	values (
		v_profile_id, p_environment_id, p_client_artifact_id, p_session_id,
		p_artifact_type, v_name, p_root_object_sha256, p_root_contract,
		p_content_sha256, p_bytes, v_media_type, v_user_id
	)
	returning * into v_artifact;

	return public.qorpera_artifact_json(v_artifact);
end
$$;

create table public.qorpera_object_reachability_graphs (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	root_kind text not null check (root_kind in ('artifact', 'company_snapshot')),
	root_id uuid not null,
	client_graph_id uuid not null,
	root_object_sha256 text not null check (root_object_sha256 ~ '^[0-9a-f]{64}$'),
	contract_version integer not null check (contract_version = 1),
	content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
	object_count integer not null check (object_count between 1 and 400000),
	storage_bytes bigint not null check (storage_bytes between 0 and 2199023255552),
	status text not null default 'uploading' check (status in ('uploading', 'complete')),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	completed_at timestamptz,
	unique (profile_id, client_graph_id),
	unique (root_kind, root_id),
	check ((status = 'complete') = (completed_at is not null))
);

create table public.qorpera_object_reachability_entries (
	graph_id uuid not null references public.qorpera_object_reachability_graphs(id) on delete cascade,
	object_sha256 text not null check (object_sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint not null check (bytes between 0 and 8388608),
	primary key (graph_id, object_sha256)
);

create index qorpera_object_reachability_entries_object
	on public.qorpera_object_reachability_entries (object_sha256, graph_id);

create table public.qorpera_object_restore_proofs (
	id uuid primary key default extensions.gen_random_uuid(),
	graph_id uuid not null references public.qorpera_object_reachability_graphs(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	client_proof_id uuid not null,
	restored_content_sha256 text not null check (restored_content_sha256 ~ '^[0-9a-f]{64}$'),
	restored_bytes bigint not null check (restored_bytes between 0 and 1099511627776),
	verified_by_user_id uuid not null references auth.users(id) on delete restrict,
	verified_at timestamptz not null default statement_timestamp(),
	valid_until timestamptz not null default statement_timestamp() + interval '7 days',
	unique (profile_id, client_proof_id),
	check (valid_until = verified_at + interval '7 days')
);

create index qorpera_object_restore_proofs_current
	on public.qorpera_object_restore_proofs (graph_id, valid_until desc);

alter table public.qorpera_object_reachability_graphs enable row level security;
alter table public.qorpera_object_reachability_entries enable row level security;
alter table public.qorpera_object_restore_proofs enable row level security;

revoke all on public.qorpera_object_reachability_graphs from anon, authenticated;
revoke all on public.qorpera_object_reachability_entries from anon, authenticated;
revoke all on public.qorpera_object_restore_proofs from anon, authenticated;

create function public.qorpera_object_reachability_graph_json(
	p_graph public.qorpera_object_reachability_graphs
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'graph_id', p_graph.id,
		'profile_id', p_graph.profile_id,
		'environment_id', p_graph.environment_id,
		'root_kind', p_graph.root_kind,
		'root_id', p_graph.root_id,
		'client_graph_id', p_graph.client_graph_id,
		'root_object_sha256', p_graph.root_object_sha256,
		'contract_version', p_graph.contract_version,
		'content_sha256', p_graph.content_sha256,
		'object_count', p_graph.object_count,
		'storage_bytes', p_graph.storage_bytes,
		'status', p_graph.status,
		'created_by_user_id', p_graph.created_by_user_id,
		'created_at', p_graph.created_at,
		'completed_at', p_graph.completed_at
	)
$$;

create function public.qorpera_object_restore_proof_json(
	p_proof public.qorpera_object_restore_proofs
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'proof_id', p_proof.id,
		'graph_id', p_proof.graph_id,
		'profile_id', p_proof.profile_id,
		'client_proof_id', p_proof.client_proof_id,
		'restored_content_sha256', p_proof.restored_content_sha256,
		'restored_bytes', p_proof.restored_bytes,
		'verified_by_user_id', p_proof.verified_by_user_id,
		'verified_at', p_proof.verified_at,
		'valid_until', p_proof.valid_until
	)
$$;

create function public.qorpera_object_graph_objects_available(p_graph_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select not exists (
		select 1
		from public.qorpera_object_reachability_entries as entry
		left join storage.objects as object
			on object.bucket_id = 'qorpera-profile-objects'
			and object.name = graph.profile_id::text || '/' || entry.object_sha256
		where entry.graph_id = p_graph_id
			and (
				object.id is null
				or case
					when (object.metadata ->> 'size') ~ '^[0-9]+$'
						then (object.metadata ->> 'size')::bigint
					else -1
				end <> entry.bytes
			)
	)
	from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id
$$;

create function public.qorpera_object_root_has_current_proof(p_root_kind text, p_root_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1
		from public.qorpera_object_reachability_graphs as graph
		join public.qorpera_object_restore_proofs as proof on proof.graph_id = graph.id
		where graph.root_kind = p_root_kind
			and graph.root_id = p_root_id
			and graph.status = 'complete'
			and proof.valid_until > statement_timestamp()
			and public.qorpera_object_graph_objects_available(graph.id)
	)
$$;

revoke all on function public.qorpera_object_reachability_graph_json(public.qorpera_object_reachability_graphs) from public;
revoke all on function public.qorpera_object_restore_proof_json(public.qorpera_object_restore_proofs) from public;
revoke all on function public.qorpera_object_graph_objects_available(uuid) from public;
revoke all on function public.qorpera_object_root_has_current_proof(text, uuid) from public;

create function public.qorpera_begin_object_reachability_graph(
	p_root_kind text,
	p_root_id uuid,
	p_client_graph_id uuid,
	p_root_object_sha256 text,
	p_contract_version integer,
	p_content_sha256 text,
	p_object_count integer,
	p_storage_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_profile_id uuid;
	v_environment_id uuid;
	v_expected_root text;
	v_root_creator_user_id uuid;
	v_existing public.qorpera_object_reachability_graphs%rowtype;
	v_graph public.qorpera_object_reachability_graphs%rowtype;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if p_root_kind = 'artifact' then
		select artifact.profile_id, artifact.environment_id, artifact.root_object_sha256, artifact.created_by_user_id
		into v_profile_id, v_environment_id, v_expected_root, v_root_creator_user_id
		from public.qorpera_artifacts as artifact
		where artifact.id = p_root_id
			and artifact.root_contract <> 'qorpera.unverified-root/v1';
	elsif p_root_kind = 'company_snapshot' then
		select snapshot.profile_id, snapshot.environment_id, snapshot.tree_manifest_sha256, snapshot.created_by_user_id
		into v_profile_id, v_environment_id, v_expected_root, v_root_creator_user_id
		from public.qorpera_company_snapshots as snapshot
		where snapshot.id = p_root_id;
	else
		raise exception 'object reachability root is invalid' using errcode = '22023';
	end if;
	if v_profile_id is null or v_root_creator_user_id is distinct from v_user_id
		or not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'object reachability requires root-creator access' using errcode = '42501';
	end if;
	if p_client_graph_id is null
		or p_root_object_sha256 is distinct from v_expected_root
		or p_contract_version <> 1
		or p_content_sha256 !~ '^[0-9a-f]{64}$'
		or p_object_count not between 1 and 400000
		or p_storage_bytes not between 0 and 2199023255552 then
		raise exception 'object reachability graph is invalid' using errcode = '22023';
	end if;

	select graph.* into v_existing
	from public.qorpera_object_reachability_graphs as graph
	where graph.root_kind = p_root_kind and graph.root_id = p_root_id;
	if found then
		if v_existing.profile_id <> v_profile_id
			or v_existing.environment_id <> v_environment_id
			or v_existing.client_graph_id <> p_client_graph_id
			or v_existing.root_object_sha256 <> p_root_object_sha256
			or v_existing.contract_version <> p_contract_version
			or v_existing.content_sha256 <> p_content_sha256
			or v_existing.object_count <> p_object_count
			or v_existing.storage_bytes <> p_storage_bytes then
			raise exception 'object reachability root is already bound to different content' using errcode = '23505';
		end if;
		return public.qorpera_object_reachability_graph_json(v_existing);
	end if;

	insert into public.qorpera_object_reachability_graphs (
		profile_id, environment_id, root_kind, root_id, client_graph_id,
		root_object_sha256, contract_version, content_sha256,
		object_count, storage_bytes, created_by_user_id
	)
	values (
		v_profile_id, v_environment_id, p_root_kind, p_root_id, p_client_graph_id,
		p_root_object_sha256, p_contract_version, p_content_sha256,
		p_object_count, p_storage_bytes, v_user_id
	)
	returning * into v_graph;

	return public.qorpera_object_reachability_graph_json(v_graph);
end
$$;

create function public.qorpera_append_object_reachability_entries(
	p_graph_id uuid,
	p_entries jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_graph public.qorpera_object_reachability_graphs%rowtype;
	v_input_count integer;
	v_valid_count integer;
begin
	select graph.* into v_graph
	from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id
	for update;
	if auth.uid() is null or not found or v_graph.created_by_user_id <> auth.uid()
		or not public.qorpera_can_write_profile(v_graph.profile_id) then
		raise exception 'object reachability requires graph-creator access' using errcode = '42501';
	end if;
	if v_graph.status <> 'uploading' or jsonb_typeof(p_entries) <> 'array'
		or jsonb_array_length(p_entries) not between 1 and 500 then
		raise exception 'object reachability entry batch is invalid' using errcode = '22023';
	end if;

	select count(*), count(*) filter (
		where entry.sha256 ~ '^[0-9a-f]{64}$'
			and entry.bytes between 0 and 8388608
	)
	into v_input_count, v_valid_count
	from jsonb_to_recordset(p_entries) as entry(sha256 text, bytes bigint);
	if v_input_count <> jsonb_array_length(p_entries)
		or v_valid_count <> v_input_count
		or v_input_count <> (
			select count(distinct entry.sha256)
			from jsonb_to_recordset(p_entries) as entry(sha256 text, bytes bigint)
		) then
		raise exception 'object reachability entry batch is invalid' using errcode = '22023';
	end if;
	if exists (
		select 1
		from jsonb_to_recordset(p_entries) as entry(sha256 text, bytes bigint)
		left join storage.objects as object
			on object.bucket_id = 'qorpera-profile-objects'
			and object.name = v_graph.profile_id::text || '/' || entry.sha256
		where object.id is null
			or case
				when (object.metadata ->> 'size') ~ '^[0-9]+$'
					then (object.metadata ->> 'size')::bigint
				else -1
			end <> entry.bytes
	) then
		raise exception 'object reachability entry is unavailable or has the wrong size' using errcode = '22023';
	end if;
	if exists (
		select 1
		from jsonb_to_recordset(p_entries) as entry(sha256 text, bytes bigint)
		join public.qorpera_object_reachability_entries as existing
			on existing.graph_id = p_graph_id and existing.object_sha256 = entry.sha256
		where existing.bytes <> entry.bytes
	) then
		raise exception 'object reachability entry is already bound to a different size' using errcode = '23505';
	end if;

	insert into public.qorpera_object_reachability_entries (graph_id, object_sha256, bytes)
	select p_graph_id, entry.sha256, entry.bytes
	from jsonb_to_recordset(p_entries) as entry(sha256 text, bytes bigint)
	on conflict (graph_id, object_sha256) do nothing;

	select count(*) into v_input_count
	from public.qorpera_object_reachability_entries as entry
	where entry.graph_id = p_graph_id;
	if v_input_count > v_graph.object_count then
		raise exception 'object reachability graph exceeds its declared size' using errcode = '22023';
	end if;
	return v_input_count;
end
$$;

create function public.qorpera_complete_object_reachability_graph(p_graph_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_graph public.qorpera_object_reachability_graphs%rowtype;
	v_object_count integer;
	v_storage_bytes bigint;
	v_content_sha256 text;
	v_direct_artifact_bytes bigint;
begin
	select graph.* into v_graph
	from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id
	for update;
	if auth.uid() is null or not found or v_graph.created_by_user_id <> auth.uid()
		or not public.qorpera_can_write_profile(v_graph.profile_id) then
		raise exception 'object reachability requires graph-creator access' using errcode = '42501';
	end if;
	if v_graph.status = 'complete' then
		return public.qorpera_object_reachability_graph_json(v_graph);
	end if;

	select count(*), coalesce(sum(entry.bytes), 0), encode(
		extensions.digest(
			convert_to(coalesce(string_agg(
				entry.object_sha256 || ':' || entry.bytes::text,
				E'\n' order by entry.object_sha256
			), ''), 'utf8'),
			'sha256'
		),
		'hex'
	)
	into v_object_count, v_storage_bytes, v_content_sha256
	from public.qorpera_object_reachability_entries as entry
	where entry.graph_id = p_graph_id;
	if v_object_count <> v_graph.object_count
		or v_storage_bytes <> v_graph.storage_bytes
		or v_content_sha256 <> v_graph.content_sha256
		or not exists (
			select 1
			from public.qorpera_object_reachability_entries as entry
			where entry.graph_id = p_graph_id
				and entry.object_sha256 = v_graph.root_object_sha256
		)
		or not public.qorpera_object_graph_objects_available(p_graph_id) then
		raise exception 'object reachability graph does not match its declaration' using errcode = '22023';
	end if;
	if v_graph.root_kind = 'artifact' then
		select artifact.bytes into v_direct_artifact_bytes
		from public.qorpera_artifacts as artifact
		where artifact.id = v_graph.root_id and artifact.root_contract = 'qorpera.object/v1';
		if found and (v_object_count <> 1 or v_storage_bytes <> v_direct_artifact_bytes) then
			raise exception 'direct artifact reachability must contain exactly its root object' using errcode = '22023';
		end if;
	end if;

	update public.qorpera_object_reachability_graphs
	set status = 'complete', completed_at = statement_timestamp()
	where id = p_graph_id
	returning * into v_graph;
	return public.qorpera_object_reachability_graph_json(v_graph);
end
$$;

create function public.qorpera_get_object_reachability_graph(p_graph_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_graph public.qorpera_object_reachability_graphs%rowtype;
begin
	select graph.* into v_graph
	from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id;
	if not found or not public.qorpera_can_read_profile(v_graph.profile_id) then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;
	return public.qorpera_object_reachability_graph_json(v_graph);
end
$$;

create function public.qorpera_create_object_restore_proof(
	p_graph_id uuid,
	p_client_proof_id uuid,
	p_restored_content_sha256 text,
	p_restored_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_graph public.qorpera_object_reachability_graphs%rowtype;
	v_expected_sha256 text;
	v_expected_bytes bigint;
	v_existing public.qorpera_object_restore_proofs%rowtype;
	v_proof public.qorpera_object_restore_proofs%rowtype;
begin
	select graph.* into v_graph
	from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id;
	if v_user_id is null or not found or v_graph.created_by_user_id <> v_user_id
		or not public.qorpera_can_write_profile(v_graph.profile_id) then
		raise exception 'object restore proof requires graph-creator access' using errcode = '42501';
	end if;
	if v_graph.status <> 'complete' or p_client_proof_id is null
		or p_restored_content_sha256 !~ '^[0-9a-f]{64}$'
		or p_restored_bytes not between 0 and 1099511627776 then
		raise exception 'object restore proof is invalid' using errcode = '22023';
	end if;
	if v_graph.root_kind = 'artifact' then
		select artifact.content_sha256, artifact.bytes
		into v_expected_sha256, v_expected_bytes
		from public.qorpera_artifacts as artifact
		where artifact.id = v_graph.root_id;
	else
		select snapshot.tree_manifest_sha256, snapshot.total_bytes
		into v_expected_sha256, v_expected_bytes
		from public.qorpera_company_snapshots as snapshot
		where snapshot.id = v_graph.root_id;
	end if;
	if v_expected_sha256 is null
		or p_restored_content_sha256 <> v_expected_sha256
		or p_restored_bytes <> v_expected_bytes
		or not public.qorpera_object_graph_objects_available(p_graph_id) then
		raise exception 'object restore proof does not match its root' using errcode = '22023';
	end if;

	select proof.* into v_existing
	from public.qorpera_object_restore_proofs as proof
	where proof.profile_id = v_graph.profile_id and proof.client_proof_id = p_client_proof_id;
	if found then
		if v_existing.graph_id <> p_graph_id
			or v_existing.restored_content_sha256 <> p_restored_content_sha256
			or v_existing.restored_bytes <> p_restored_bytes then
			raise exception 'object restore proof id is already bound to different content' using errcode = '23505';
		end if;
		return public.qorpera_object_restore_proof_json(v_existing);
	end if;

	insert into public.qorpera_object_restore_proofs (
		graph_id, profile_id, client_proof_id, restored_content_sha256,
		restored_bytes, verified_by_user_id
	)
	values (
		p_graph_id, v_graph.profile_id, p_client_proof_id, p_restored_content_sha256,
		p_restored_bytes, v_user_id
	)
	returning * into v_proof;
	return public.qorpera_object_restore_proof_json(v_proof);
end
$$;

create or replace function public.qorpera_list_artifact_gc_candidates(
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
			public.qorpera_artifact_json(assessed.artifact)
			|| jsonb_build_object(
				'reachability_graph_id', assessed.graph_id,
				'reachability_ready', assessed.reachability_ready,
				'deletable_object_count', assessed.deletable_object_count,
				'deletable_storage_bytes', assessed.deletable_storage_bytes,
				'object_deletion_ready', false,
				'blocked_reason', case
					when not assessed.candidate_has_graph then 'artifact reachability graph is incomplete'
					when not assessed.candidate_has_proof then 'artifact restore proof is missing or expired'
					when not assessed.profile_coverage then 'profile reachability coverage is incomplete'
					when not assessed.objects_available then 'one or more reachable objects are unavailable'
					else 'physical deletion worker is not deployed'
				end
			)
			order by (assessed.artifact).eligible_for_gc_at, (assessed.artifact).id
		)
		from (
			select
				candidate as artifact,
				graph.id as graph_id,
				(graph.id is not null and graph.status = 'complete') as candidate_has_graph,
				coalesce(public.qorpera_object_root_has_current_proof('artifact', candidate.id), false) as candidate_has_proof,
				coalesce(public.qorpera_object_graph_objects_available(graph.id), false) as objects_available,
				(
					not exists (
						select 1
						from public.qorpera_artifacts as other_artifact
						where other_artifact.profile_id = p_profile_id
							and other_artifact.id <> candidate.id
							and not public.qorpera_object_root_has_current_proof('artifact', other_artifact.id)
					)
					and not exists (
						select 1
						from public.qorpera_company_snapshots as snapshot
						where snapshot.profile_id = p_profile_id
							and not public.qorpera_object_root_has_current_proof('company_snapshot', snapshot.id)
					)
				) as profile_coverage,
				coalesce((
					select count(*)
					from public.qorpera_object_reachability_entries as candidate_entry
					where candidate_entry.graph_id = graph.id
						and not exists (
							select 1
							from public.qorpera_object_reachability_entries as retained_entry
							join public.qorpera_object_reachability_graphs as retained_graph
								on retained_graph.id = retained_entry.graph_id
							where retained_entry.object_sha256 = candidate_entry.object_sha256
								and retained_graph.id <> graph.id
								and retained_graph.profile_id = p_profile_id
								and retained_graph.status = 'complete'
						)
				), 0)::integer as deletable_object_count,
				coalesce((
					select sum(candidate_entry.bytes)
					from public.qorpera_object_reachability_entries as candidate_entry
					where candidate_entry.graph_id = graph.id
						and not exists (
							select 1
							from public.qorpera_object_reachability_entries as retained_entry
							join public.qorpera_object_reachability_graphs as retained_graph
								on retained_graph.id = retained_entry.graph_id
							where retained_entry.object_sha256 = candidate_entry.object_sha256
								and retained_graph.id <> graph.id
								and retained_graph.profile_id = p_profile_id
								and retained_graph.status = 'complete'
						)
				), 0)::bigint as deletable_storage_bytes,
				(
					graph.id is not null
					and graph.status = 'complete'
					and public.qorpera_object_root_has_current_proof('artifact', candidate.id)
					and public.qorpera_object_graph_objects_available(graph.id)
					and not exists (
						select 1
						from public.qorpera_artifacts as other_artifact
						where other_artifact.profile_id = p_profile_id
							and other_artifact.id <> candidate.id
							and not public.qorpera_object_root_has_current_proof('artifact', other_artifact.id)
					)
					and not exists (
						select 1
						from public.qorpera_company_snapshots as snapshot
						where snapshot.profile_id = p_profile_id
							and not public.qorpera_object_root_has_current_proof('company_snapshot', snapshot.id)
					)
				) as reachability_ready
			from public.qorpera_artifacts as candidate
			left join public.qorpera_object_reachability_graphs as graph
				on graph.root_kind = 'artifact' and graph.root_id = candidate.id
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
		) as assessed
	), '[]'::jsonb);
end
$$;

revoke execute on function public.qorpera_register_artifact(uuid, uuid, uuid, text, text, text, text, bigint, text) from authenticated;
revoke all on function public.qorpera_register_artifact_v2(uuid, uuid, uuid, text, text, text, text, text, bigint, text) from public;
revoke all on function public.qorpera_begin_object_reachability_graph(text, uuid, uuid, text, integer, text, integer, bigint) from public;
revoke all on function public.qorpera_append_object_reachability_entries(uuid, jsonb) from public;
revoke all on function public.qorpera_complete_object_reachability_graph(uuid) from public;
revoke all on function public.qorpera_get_object_reachability_graph(uuid) from public;
revoke all on function public.qorpera_create_object_restore_proof(uuid, uuid, text, bigint) from public;

grant execute on function public.qorpera_register_artifact_v2(uuid, uuid, uuid, text, text, text, text, text, bigint, text) to authenticated;
grant execute on function public.qorpera_begin_object_reachability_graph(text, uuid, uuid, text, integer, text, integer, bigint) to authenticated;
grant execute on function public.qorpera_append_object_reachability_entries(uuid, jsonb) to authenticated;
grant execute on function public.qorpera_complete_object_reachability_graph(uuid) to authenticated;
grant execute on function public.qorpera_get_object_reachability_graph(uuid) to authenticated;
grant execute on function public.qorpera_create_object_restore_proof(uuid, uuid, text, bigint) to authenticated;
