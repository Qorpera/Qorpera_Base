-- Atomically publish successful runner outputs as forked substrate versions.
--
-- Registered output artifacts remain attributable to their exact job. A
-- successful completion carries the parent's company snapshot and operation
-- watermark forward, unions the parent's artifact index with that job's
-- outputs, and records the resulting child substrate on the job. Concurrent
-- jobs fork independently and are never merged implicitly.

create table public.qorpera_runner_job_artifacts (
	job_id uuid not null references public.qorpera_runner_jobs(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	artifact_id uuid not null references public.qorpera_artifacts(id) on delete restrict,
	registered_at timestamptz not null default statement_timestamp(),
	primary key (job_id, artifact_id),
	unique (artifact_id)
);

create index qorpera_runner_job_artifacts_profile
	on public.qorpera_runner_job_artifacts (profile_id, registered_at);

alter table public.qorpera_runner_job_artifacts enable row level security;
revoke all on public.qorpera_runner_job_artifacts from anon, authenticated;

alter table public.qorpera_runner_jobs
	add column output_artifact_count integer not null default 0 check (output_artifact_count between 0 and 100),
	add column output_artifact_index_id uuid references public.qorpera_artifact_indexes(id) on delete restrict,
	add column output_substrate_version_id uuid references public.qorpera_company_substrate_versions(id) on delete restrict,
	add constraint qorpera_runner_jobs_output_substrate check (
		(
			output_artifact_count = 0
			and output_artifact_index_id is null
			and output_substrate_version_id is null
		)
		or (
			output_artifact_count > 0
			and status = 'completed'
			and output_artifact_index_id is not null
			and output_substrate_version_id is not null
		)
	);

create index qorpera_runner_jobs_output_substrate
	on public.qorpera_runner_jobs (output_substrate_version_id)
	where output_substrate_version_id is not null;

create or replace function public.qorpera_runner_job_json(p_job public.qorpera_runner_jobs)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'job_id', p_job.id,
		'profile_id', p_job.profile_id,
		'environment_id', p_job.environment_id,
		'session_id', p_job.session_id,
		'substrate_version_id', p_job.substrate_version_id,
		'client_job_id', p_job.client_job_id,
		'required_capability', p_job.required_capability,
		'job_type', p_job.job_type,
		'payload', p_job.payload,
		'status', p_job.status,
		'attempt_count', p_job.attempt_count,
		'runner_id', p_job.runner_id,
		'result', p_job.result,
		'output_artifact_count', p_job.output_artifact_count,
		'output_artifact_index_id', p_job.output_artifact_index_id,
		'output_substrate_version_id', p_job.output_substrate_version_id,
		'last_error', p_job.last_error,
		'created_by_user_id', p_job.created_by_user_id,
		'created_at', p_job.created_at,
		'started_at', p_job.started_at,
		'lease_expires_at', p_job.lease_expires_at,
		'finished_at', p_job.finished_at,
		'cancelled_by_user_id', p_job.cancelled_by_user_id,
		'cancelled_at', p_job.cancelled_at
	)
$$;

create or replace function public.qorpera_runner_broker_register_artifact(
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
		v_artifact := v_existing;
	else
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
	end if;
	insert into public.qorpera_runner_job_artifacts (job_id, profile_id, artifact_id)
	values (v_job.id, v_job.profile_id, v_artifact.id)
	on conflict (job_id, artifact_id) do nothing;
	return public.qorpera_artifact_json(v_artifact);
end
$$;

create function public.qorpera_complete_runner_job_v2(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_client_artifact_index_id uuid,
	p_client_substrate_version_id uuid,
	p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_source public.qorpera_company_substrate_versions%rowtype;
	v_existing_index public.qorpera_artifact_indexes%rowtype;
	v_index public.qorpera_artifact_indexes%rowtype;
	v_existing_version public.qorpera_company_substrate_versions%rowtype;
	v_version public.qorpera_company_substrate_versions%rowtype;
	v_artifact_ids uuid[];
	v_output_artifact_count integer;
	v_total_artifact_count integer;
	v_total_bytes bigint;
	v_index_sha256 text;
	v_version_sha256 text;
	v_result jsonb;
begin
	if auth.role() <> 'service_role'
		or p_client_artifact_index_id is null
		or p_client_substrate_version_id is null
		or p_result is null
		or jsonb_typeof(p_result) <> 'object'
		or p_result ? 'output_substrate'
		or pg_column_size(p_result) > 64512
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner job completion is invalid' using errcode = '42501';
	end if;
	select job.* into v_job
	from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.runner_id = p_runner_id
	for update;
	if found and v_job.status = 'completed' and v_job.terminal_lease_token_sha256 = p_lease_token_sha256 then
		if (v_job.result - 'output_substrate') <> p_result then
			raise exception 'runner completion replay differs from the stored result' using errcode = '23505';
		end if;
		if v_job.output_artifact_count > 0 and not exists (
			select 1
			from public.qorpera_artifact_indexes as artifact_index
			join public.qorpera_company_substrate_versions as version
				on version.id = v_job.output_substrate_version_id
			where artifact_index.id = v_job.output_artifact_index_id
				and artifact_index.client_index_id = p_client_artifact_index_id
				and version.client_version_id = p_client_substrate_version_id
				and version.artifact_index_id = artifact_index.id
		) then
			raise exception 'runner completion replay uses different publication ids' using errcode = '23505';
		end if;
		return public.qorpera_runner_job_json(v_job);
	end if;
	if not found or v_job.status <> 'leased'
		or v_job.lease_token_sha256 <> p_lease_token_sha256
		or v_job.lease_expires_at <= statement_timestamp() then
		raise exception 'runner job lease is unavailable' using errcode = '40001';
	end if;
	select version.* into strict v_source
	from public.qorpera_company_substrate_versions as version
	where version.id = v_job.substrate_version_id;
	if v_source.profile_id <> v_job.profile_id or v_source.environment_id <> v_job.environment_id then
		raise exception 'runner source substrate is inconsistent' using errcode = '55000';
	end if;
	select count(*) into v_output_artifact_count
	from public.qorpera_runner_job_artifacts as job_artifact
	where job_artifact.job_id = v_job.id;
	if v_output_artifact_count = 0 then
		v_result := p_result || jsonb_build_object('output_substrate', null);
	else
		select coalesce(array_agg(source.artifact_id order by source.artifact_id), '{}'::uuid[])
		into v_artifact_ids
		from (
			select entry.artifact_id
			from public.qorpera_artifact_index_entries as entry
			where entry.index_id = v_source.artifact_index_id
			union
			select job_artifact.artifact_id
			from public.qorpera_runner_job_artifacts as job_artifact
			where job_artifact.job_id = v_job.id
		) as source;
		v_total_artifact_count := cardinality(v_artifact_ids);
		if v_total_artifact_count > 5000 then
			raise exception 'runner output substrate has too many artifacts' using errcode = '55000';
		end if;
		select coalesce(sum(artifact.bytes), 0) into v_total_bytes
		from public.qorpera_artifacts as artifact
		where artifact.id = any(v_artifact_ids)
			and artifact.profile_id = v_job.profile_id
			and artifact.environment_id = v_job.environment_id;
		if (
			select count(*)
			from public.qorpera_artifacts as artifact
			where artifact.id = any(v_artifact_ids)
				and artifact.profile_id = v_job.profile_id
				and artifact.environment_id = v_job.environment_id
		) <> v_total_artifact_count then
			raise exception 'runner output substrate contains unavailable artifacts' using errcode = '55000';
		end if;
		v_index_sha256 := encode(
			extensions.digest(
				convert_to(
					jsonb_build_object(
						'contract_version', 1,
						'profile_id', v_job.profile_id,
						'environment_id', v_job.environment_id,
						'artifact_ids', to_jsonb(v_artifact_ids)
					)::text,
					'utf8'
				),
				'sha256'
			),
			'hex'
		);
		select artifact_index.* into v_existing_index
		from public.qorpera_artifact_indexes as artifact_index
		where artifact_index.profile_id = v_job.profile_id
			and artifact_index.client_index_id = p_client_artifact_index_id;
		if found then
			if v_existing_index.environment_id <> v_job.environment_id
				or v_existing_index.content_sha256 <> v_index_sha256
				or v_existing_index.artifact_count <> v_total_artifact_count
				or v_existing_index.total_bytes <> v_total_bytes then
				raise exception 'runner output artifact index id is already bound to different content' using errcode = '23505';
			end if;
			v_index := v_existing_index;
		else
			insert into public.qorpera_artifact_indexes (
				profile_id, environment_id, client_index_id, contract_version,
				content_sha256, artifact_count, total_bytes, created_by_user_id
			) values (
				v_job.profile_id, v_job.environment_id, p_client_artifact_index_id, 1,
				v_index_sha256, v_total_artifact_count, v_total_bytes, v_job.created_by_user_id
			) returning * into v_index;
			insert into public.qorpera_artifact_index_entries (index_id, ordinal, artifact_id)
			select v_index.id, (row_number() over (order by artifact_id))::integer, artifact_id
			from unnest(v_artifact_ids) as artifact_id;
		end if;
		v_version_sha256 := encode(
			extensions.digest(
				convert_to(
					jsonb_build_object(
						'contract_version', v_source.contract_version,
						'profile_id', v_job.profile_id,
						'environment_id', v_job.environment_id,
						'company_snapshot_id', v_source.company_snapshot_id,
						'operation_sequence', v_source.operation_sequence,
						'artifact_manifest_sha256', v_index.content_sha256
					)::text,
					'utf8'
				),
				'sha256'
			),
			'hex'
		);
		select version.* into v_existing_version
		from public.qorpera_company_substrate_versions as version
		where version.profile_id = v_job.profile_id
			and version.client_version_id = p_client_substrate_version_id;
		if found then
			if v_existing_version.environment_id <> v_job.environment_id
				or v_existing_version.company_snapshot_id <> v_source.company_snapshot_id
				or v_existing_version.contract_version <> v_source.contract_version
				or v_existing_version.operation_sequence <> v_source.operation_sequence
				or v_existing_version.operation_count <> v_source.operation_count
				or v_existing_version.artifact_index_id <> v_index.id
				or v_existing_version.content_sha256 <> v_version_sha256 then
				raise exception 'runner output substrate id is already bound to different content' using errcode = '23505';
			end if;
			v_version := v_existing_version;
		else
			insert into public.qorpera_company_substrate_versions (
				profile_id, environment_id, company_snapshot_id, client_version_id,
				contract_version, operation_sequence, operation_count,
				artifact_index_id, artifact_manifest_sha256, content_sha256,
				created_by_user_id
			) values (
				v_job.profile_id, v_job.environment_id, v_source.company_snapshot_id,
				p_client_substrate_version_id, v_source.contract_version,
				v_source.operation_sequence, v_source.operation_count,
				v_index.id, v_index.content_sha256, v_version_sha256,
				v_job.created_by_user_id
			) returning * into v_version;
		end if;
		v_result := p_result || jsonb_build_object(
			'output_substrate', jsonb_build_object(
				'source_substrate_version_id', v_source.id,
				'artifact_index_id', v_index.id,
				'substrate_version_id', v_version.id,
				'output_artifact_count', v_output_artifact_count,
				'total_artifact_count', v_total_artifact_count
			)
		);
	end if;
	if pg_column_size(v_result) > 65536 then
		raise exception 'runner completion result is too large' using errcode = '22023';
	end if;
	update public.qorpera_runner_jobs
	set status = 'completed', terminal_lease_token_sha256 = lease_token_sha256,
		lease_token_sha256 = null, lease_expires_at = null,
		result = v_result, last_error = null, finished_at = statement_timestamp(),
		output_artifact_count = v_output_artifact_count,
		output_artifact_index_id = case when v_output_artifact_count > 0 then v_index.id else null end,
		output_substrate_version_id = case when v_output_artifact_count > 0 then v_version.id else null end
	where id = p_job_id
	returning * into v_job;
	perform public.qorpera_append_runner_audit(
		v_job.profile_id, p_runner_id, v_job.id, 'job_completed',
		jsonb_build_object(
			'attempt_count', v_job.attempt_count,
			'output_artifact_count', v_job.output_artifact_count,
			'output_artifact_index_id', v_job.output_artifact_index_id,
			'output_substrate_version_id', v_job.output_substrate_version_id
		),
		null
	);
	return public.qorpera_runner_job_json(v_job);
end
$$;

revoke all on function public.qorpera_complete_runner_job_v2(uuid, text, uuid, text, uuid, uuid, jsonb) from public;
revoke execute on function public.qorpera_complete_runner_job(uuid, text, uuid, text, jsonb) from service_role;
grant execute on function public.qorpera_complete_runner_job_v2(uuid, text, uuid, text, uuid, uuid, jsonb) to service_role;
