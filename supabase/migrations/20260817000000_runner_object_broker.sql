-- Job-scoped object broker authority for outbound runners.
--
-- Runner session and lease secrets remain hashed before reaching Postgres.
-- Input objects must belong to a completed reachability graph rooted in the
-- leased job's exact substrate. Output objects are bounded per job and become
-- durable roots only through an immutable artifact record.

create table public.qorpera_runner_job_output_objects (
	job_id uuid not null references public.qorpera_runner_jobs(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	object_sha256 text not null check (object_sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint not null check (bytes between 0 and 8388608),
	media_type text not null check (
		char_length(media_type) between 3 and 256
		and media_type = lower(btrim(media_type))
		and media_type like '%/%'
		and media_type !~ E'[\r\n]'
	),
	authorized_at timestamptz not null default statement_timestamp(),
	uploaded_at timestamptz,
	primary key (job_id, object_sha256)
);

create index qorpera_runner_job_output_objects_profile
	on public.qorpera_runner_job_output_objects (profile_id, authorized_at);

alter table public.qorpera_runner_job_output_objects enable row level security;
revoke all on public.qorpera_runner_job_output_objects from anon, authenticated;

create function public.qorpera_runner_broker_job(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text
)
returns public.qorpera_runner_jobs
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
begin
	if auth.role() <> 'service_role'
		or p_session_token_sha256 !~ '^[0-9a-f]{64}$'
		or p_lease_token_sha256 !~ '^[0-9a-f]{64}$'
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner broker authorization is invalid' using errcode = '42501';
	end if;
	select job.* into v_job
	from public.qorpera_runner_jobs as job
	where job.id = p_job_id
		and job.runner_id = p_runner_id
		and job.status = 'leased'
		and job.lease_token_sha256 = p_lease_token_sha256
		and job.lease_expires_at > statement_timestamp();
	if not found then
		raise exception 'runner job lease is unavailable' using errcode = '40001';
	end if;
	return v_job;
end
$$;

create function public.qorpera_runner_broker_describe(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_version public.qorpera_company_substrate_versions%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_index public.qorpera_artifact_indexes%rowtype;
begin
	v_job := public.qorpera_runner_broker_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select version.* into strict v_version
	from public.qorpera_company_substrate_versions as version
	where version.id = v_job.substrate_version_id;
	select snapshot.* into strict v_snapshot
	from public.qorpera_company_snapshots as snapshot
	where snapshot.id = v_version.company_snapshot_id;
	if v_version.artifact_index_id is not null then
		select artifact_index.* into strict v_index
		from public.qorpera_artifact_indexes as artifact_index
		where artifact_index.id = v_version.artifact_index_id;
	end if;
	if v_version.profile_id <> v_job.profile_id
		or v_version.environment_id <> v_job.environment_id
		or v_snapshot.profile_id <> v_job.profile_id
		or v_snapshot.environment_id <> v_job.environment_id
		or (v_index.id is not null and (
			v_index.profile_id <> v_job.profile_id
			or v_index.environment_id <> v_job.environment_id
			or v_index.content_sha256 is distinct from v_version.artifact_manifest_sha256
		)) then
		raise exception 'runner job substrate is inconsistent' using errcode = '55000';
	end if;
	if not exists (
		select 1
		from public.qorpera_object_reachability_graphs as graph
		where graph.root_kind = 'company_snapshot'
			and graph.root_id = v_snapshot.id
			and graph.status = 'complete'
	) or exists (
		select 1
		from public.qorpera_artifact_index_entries as entry
		where entry.index_id = v_index.id
			and not exists (
				select 1
				from public.qorpera_object_reachability_graphs as graph
				where graph.root_kind = 'artifact'
					and graph.root_id = entry.artifact_id
					and graph.status = 'complete'
			)
	) then
		raise exception 'runner job substrate objects are not ready' using errcode = '55000';
	end if;
	return jsonb_build_object(
		'job', public.qorpera_runner_job_json(v_job),
		'version', public.qorpera_company_substrate_version_json(v_version),
		'snapshot', jsonb_build_object(
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
		),
		'artifact_index', case
			when v_index.id is null then 'null'::jsonb
			else public.qorpera_artifact_index_json(v_index)
		end,
		'output_limits', jsonb_build_object(
			'max_object_bytes', 8388608,
			'max_object_count', 100,
			'max_total_bytes', 67108864,
			'root_contract', 'qorpera.object/v1'
		)
	);
end
$$;

create function public.qorpera_runner_broker_locked_job(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text
)
returns public.qorpera_runner_jobs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
begin
	v_job := public.qorpera_runner_broker_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select job.* into v_job
	from public.qorpera_runner_jobs as job
	where job.id = p_job_id
		and job.runner_id = p_runner_id
		and job.status = 'leased'
		and job.lease_token_sha256 = p_lease_token_sha256
		and job.lease_expires_at > statement_timestamp()
	for update;
	if not found then
		raise exception 'runner job lease is unavailable' using errcode = '40001';
	end if;
	return v_job;
end
$$;

create function public.qorpera_runner_broker_list_operations(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_after_sequence bigint default 0,
	p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_version public.qorpera_company_substrate_versions%rowtype;
begin
	v_job := public.qorpera_runner_broker_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select version.* into strict v_version
	from public.qorpera_company_substrate_versions as version
	where version.id = v_job.substrate_version_id;
	if p_after_sequence < 0 or p_after_sequence > v_version.operation_sequence
		or p_limit not between 1 and 500 then
		raise exception 'runner operation page is invalid' using errcode = '22023';
	end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'profile_id', operation.profile_id,
			'sequence', operation.sequence,
			'environment_id', operation.environment_id,
			'operation_type', operation.operation_type,
			'entity_id', operation.entity_id,
			'entity_version', operation.entity_version,
			'content_sha256', operation.content_sha256,
			'payload', operation.payload,
			'actor_user_id', operation.actor_user_id,
			'created_at', operation.created_at
		) order by operation.sequence)
		from (
			select source.*
			from public.qorpera_company_operations as source
			where source.profile_id = v_job.profile_id
				and source.sequence > p_after_sequence
				and source.sequence <= v_version.operation_sequence
				and (source.environment_id is null or source.environment_id = v_job.environment_id)
			order by source.sequence
			limit p_limit
		) as operation
	), '[]'::jsonb);
end
$$;

create function public.qorpera_runner_broker_list_artifacts(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
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
	v_job public.qorpera_runner_jobs%rowtype;
	v_version public.qorpera_company_substrate_versions%rowtype;
	v_index public.qorpera_artifact_indexes%rowtype;
begin
	v_job := public.qorpera_runner_broker_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select version.* into strict v_version
	from public.qorpera_company_substrate_versions as version
	where version.id = v_job.substrate_version_id;
	if v_version.artifact_index_id is null then return '[]'::jsonb; end if;
	select artifact_index.* into strict v_index
	from public.qorpera_artifact_indexes as artifact_index
	where artifact_index.id = v_version.artifact_index_id;
	if p_after_ordinal < 0 or p_after_ordinal > v_index.artifact_count
		or p_limit not between 1 and 500 then
		raise exception 'runner artifact page is invalid' using errcode = '22023';
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
			where index_entry.index_id = v_index.id
				and index_entry.ordinal > p_after_ordinal
			order by index_entry.ordinal
			limit p_limit
		) as entry
	), '[]'::jsonb);
end
$$;

create function public.qorpera_runner_broker_authorize_input_object(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_object_sha256 text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_bytes bigint;
begin
	v_job := public.qorpera_runner_broker_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	if p_object_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'runner input object is invalid' using errcode = '22023';
	end if;
	select authorized.bytes into v_bytes
	from (
		select entry.bytes
		from public.qorpera_object_reachability_graphs as graph
		join public.qorpera_object_reachability_entries as entry on entry.graph_id = graph.id
		join public.qorpera_company_substrate_versions as version
			on version.id = v_job.substrate_version_id
		where graph.status = 'complete'
			and entry.object_sha256 = p_object_sha256
			and (
				(graph.root_kind = 'company_snapshot' and graph.root_id = version.company_snapshot_id)
				or (graph.root_kind = 'artifact' and exists (
					select 1
					from public.qorpera_artifact_index_entries as index_entry
					where index_entry.index_id = version.artifact_index_id
						and index_entry.artifact_id = graph.root_id
				))
			)
		union
		select output.bytes
		from public.qorpera_runner_job_output_objects as output
		where output.job_id = v_job.id
			and output.object_sha256 = p_object_sha256
			and output.uploaded_at is not null
	) as authorized
	limit 1;
	if not found then
		raise exception 'runner input object is outside the job substrate' using errcode = '42501';
	end if;
	if not exists (
		select 1
		from storage.objects as object
		where object.bucket_id = 'qorpera-profile-objects'
			and object.name = v_job.profile_id::text || '/' || p_object_sha256
			and case
				when (object.metadata ->> 'size') ~ '^[0-9]+$' then (object.metadata ->> 'size')::bigint
				else -1
			end = v_bytes
	) then
		raise exception 'runner input object is unavailable' using errcode = '55000';
	end if;
	return jsonb_build_object(
		'profile_id', v_job.profile_id,
		'object_sha256', p_object_sha256,
		'bytes', v_bytes
	);
end
$$;

create function public.qorpera_runner_broker_authorize_output_object(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_object_sha256 text,
	p_bytes bigint,
	p_media_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_existing public.qorpera_runner_job_output_objects%rowtype;
	v_count integer;
	v_total_bytes bigint;
	v_media_type text := lower(btrim(p_media_type));
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	if p_object_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes not between 0 and 8388608
		or char_length(v_media_type) not between 3 and 256
		or v_media_type not like '%/%'
		or v_media_type ~ E'[\r\n]' then
		raise exception 'runner output object is invalid' using errcode = '22023';
	end if;
	select output.* into v_existing
	from public.qorpera_runner_job_output_objects as output
	where output.job_id = v_job.id and output.object_sha256 = p_object_sha256;
	if found then
		if v_existing.bytes <> p_bytes or v_existing.media_type <> v_media_type then
			raise exception 'runner output hash is already bound to different metadata' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'profile_id', v_existing.profile_id,
			'object_sha256', v_existing.object_sha256,
			'bytes', v_existing.bytes,
			'uploaded', v_existing.uploaded_at is not null
		);
	end if;
	select count(*), coalesce(sum(output.bytes), 0)
	into v_count, v_total_bytes
	from public.qorpera_runner_job_output_objects as output
	where output.job_id = v_job.id;
	if v_count >= 100 or v_total_bytes + p_bytes > 67108864 then
		raise exception 'runner job output limit is exhausted' using errcode = '55000';
	end if;
	insert into public.qorpera_runner_job_output_objects (
		job_id, profile_id, object_sha256, bytes, media_type
	) values (
		v_job.id, v_job.profile_id, p_object_sha256, p_bytes, v_media_type
	) returning * into v_existing;
	return jsonb_build_object(
		'profile_id', v_existing.profile_id,
		'object_sha256', v_existing.object_sha256,
		'bytes', v_existing.bytes,
		'uploaded', false
	);
end
$$;

create function public.qorpera_runner_broker_confirm_output_object(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_object_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_output public.qorpera_runner_job_output_objects%rowtype;
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select output.* into v_output
	from public.qorpera_runner_job_output_objects as output
	where output.job_id = v_job.id and output.object_sha256 = p_object_sha256
	for update;
	if not found or not exists (
		select 1
		from storage.objects as object
		where object.bucket_id = 'qorpera-profile-objects'
			and object.name = v_job.profile_id::text || '/' || p_object_sha256
			and case
				when (object.metadata ->> 'size') ~ '^[0-9]+$' then (object.metadata ->> 'size')::bigint
				else -1
			end = v_output.bytes
	) then
		raise exception 'runner output object is unavailable' using errcode = '55000';
	end if;
	update public.qorpera_runner_job_output_objects
	set uploaded_at = coalesce(uploaded_at, statement_timestamp())
	where job_id = v_job.id and object_sha256 = p_object_sha256
	returning * into v_output;
	return jsonb_build_object(
		'profile_id', v_output.profile_id,
		'object_sha256', v_output.object_sha256,
		'bytes', v_output.bytes,
		'uploaded', true
	);
end
$$;

create function public.qorpera_runner_broker_register_artifact(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_client_artifact_id uuid,
	p_artifact_type text,
	p_name text,
	p_object_sha256 text,
	p_bytes bigint,
	p_media_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_existing public.qorpera_artifacts%rowtype;
	v_artifact public.qorpera_artifacts%rowtype;
	v_graph public.qorpera_object_reachability_graphs%rowtype;
	v_name text := btrim(p_name);
	v_media_type text := lower(btrim(p_media_type));
	v_graph_sha256 text;
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	if p_client_artifact_id is null
		or p_artifact_type !~ '^[a-z][a-z0-9_-]{0,63}$'
		or char_length(v_name) not between 1 and 256
		or p_object_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes not between 0 and 8388608
		or char_length(v_media_type) not between 3 and 256
		or v_media_type not like '%/%'
		or v_media_type ~ E'[\r\n]' then
		raise exception 'runner output artifact is invalid' using errcode = '22023';
	end if;
	if not exists (
		select 1
		from public.qorpera_runner_job_output_objects as output
		join storage.objects as object
			on object.bucket_id = 'qorpera-profile-objects'
			and object.name = v_job.profile_id::text || '/' || output.object_sha256
		where output.job_id = v_job.id
			and output.object_sha256 = p_object_sha256
			and output.bytes = p_bytes
			and output.media_type = v_media_type
			and output.uploaded_at is not null
			and case
				when (object.metadata ->> 'size') ~ '^[0-9]+$' then (object.metadata ->> 'size')::bigint
				else -1
			end = output.bytes
	) then
		raise exception 'runner output artifact object is unavailable' using errcode = '55000';
	end if;
	select artifact.* into v_existing
	from public.qorpera_artifacts as artifact
	where artifact.profile_id = v_job.profile_id
		and artifact.client_artifact_id = p_client_artifact_id;
	if found then
		if v_existing.environment_id <> v_job.environment_id
			or v_existing.session_id is distinct from v_job.session_id
			or v_existing.artifact_type <> p_artifact_type
			or v_existing.name <> v_name
			or v_existing.root_object_sha256 <> p_object_sha256
			or v_existing.root_contract <> 'qorpera.object/v1'
			or v_existing.content_sha256 <> p_object_sha256
			or v_existing.bytes <> p_bytes
			or v_existing.media_type <> v_media_type then
			raise exception 'runner artifact id is already bound to different content' using errcode = '23505';
		end if;
		return public.qorpera_artifact_json(v_existing);
	end if;
	insert into public.qorpera_artifacts (
		profile_id, environment_id, client_artifact_id, session_id,
		artifact_type, name, root_object_sha256, root_contract,
		content_sha256, bytes, media_type, created_by_user_id
	) values (
		v_job.profile_id, v_job.environment_id, p_client_artifact_id, v_job.session_id,
		p_artifact_type, v_name, p_object_sha256, 'qorpera.object/v1',
		p_object_sha256, p_bytes, v_media_type, v_job.created_by_user_id
	) returning * into v_artifact;
	v_graph_sha256 := encode(
		extensions.digest(convert_to(p_object_sha256 || ':' || p_bytes::text, 'utf8'), 'sha256'),
		'hex'
	);
	insert into public.qorpera_object_reachability_graphs (
		profile_id, environment_id, root_kind, root_id, client_graph_id,
		root_object_sha256, contract_version, content_sha256,
		object_count, storage_bytes, status, created_by_user_id, completed_at
	) values (
		v_job.profile_id, v_job.environment_id, 'artifact', v_artifact.id, extensions.gen_random_uuid(),
		p_object_sha256, 1, v_graph_sha256,
		1, p_bytes, 'complete', v_job.created_by_user_id, statement_timestamp()
	) returning * into v_graph;
	insert into public.qorpera_object_reachability_entries (graph_id, object_sha256, bytes)
	values (v_graph.id, p_object_sha256, p_bytes);
	insert into public.qorpera_object_restore_proofs (
		graph_id, profile_id, client_proof_id, restored_content_sha256,
		restored_bytes, verified_by_user_id
	) values (
		v_graph.id, v_job.profile_id, extensions.gen_random_uuid(), p_object_sha256,
		p_bytes, v_job.created_by_user_id
	);
	return public.qorpera_artifact_json(v_artifact);
end
$$;

revoke all on function public.qorpera_runner_broker_job(uuid, text, uuid, text) from public;
revoke all on function public.qorpera_runner_broker_locked_job(uuid, text, uuid, text) from public;
revoke all on function public.qorpera_runner_broker_describe(uuid, text, uuid, text) from public;
revoke all on function public.qorpera_runner_broker_list_operations(uuid, text, uuid, text, bigint, integer) from public;
revoke all on function public.qorpera_runner_broker_list_artifacts(uuid, text, uuid, text, integer, integer) from public;
revoke all on function public.qorpera_runner_broker_authorize_input_object(uuid, text, uuid, text, text) from public;
revoke all on function public.qorpera_runner_broker_authorize_output_object(uuid, text, uuid, text, text, bigint, text) from public;
revoke all on function public.qorpera_runner_broker_confirm_output_object(uuid, text, uuid, text, text) from public;
revoke all on function public.qorpera_runner_broker_register_artifact(uuid, text, uuid, text, uuid, text, text, text, bigint, text) from public;

grant execute on function public.qorpera_runner_broker_describe(uuid, text, uuid, text) to service_role;
grant execute on function public.qorpera_runner_broker_list_operations(uuid, text, uuid, text, bigint, integer) to service_role;
grant execute on function public.qorpera_runner_broker_list_artifacts(uuid, text, uuid, text, integer, integer) to service_role;
grant execute on function public.qorpera_runner_broker_authorize_input_object(uuid, text, uuid, text, text) to service_role;
grant execute on function public.qorpera_runner_broker_authorize_output_object(uuid, text, uuid, text, text, bigint, text) to service_role;
grant execute on function public.qorpera_runner_broker_confirm_output_object(uuid, text, uuid, text, text) to service_role;
grant execute on function public.qorpera_runner_broker_register_artifact(uuid, text, uuid, text, uuid, text, text, text, bigint, text) to service_role;
