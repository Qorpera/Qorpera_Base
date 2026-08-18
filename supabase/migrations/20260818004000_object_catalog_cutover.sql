-- Step 2 of the self-owned object backend (see supabase/OBJECT-BACKEND.md).
--
-- Cuts every server-side object-existence read over from storage.objects to
-- the catalog introduced in 20260818003000. Nine read sites across seven
-- functions asked one of two questions -- does this object exist for this
-- profile, or does it exist at exactly this size -- so both collapse into a
-- single predicate, qorpera_object_exists, and the retention system's trust
-- root now has one definition instead of nine.
--
-- The upload path is untouched: the storage RLS policies (profile-prefix
-- containment, write access, the GC fence) still govern how bytes arrive,
-- and the mirror trigger keeps the catalog identical to storage.objects.
-- Equivalence is not assumed: the drift function must read zero across the
-- whole regression suite, and 060_object_catalog_cutover.test.sql proves the
-- trust actually moved by deleting a catalog row out from under a completed
-- graph and watching availability flip while storage still holds the bytes.

create function public.qorpera_object_exists(
	p_profile_id uuid,
	p_sha256 text,
	p_bytes bigint default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1
		from public.qorpera_profile_objects as object
		where object.profile_id = p_profile_id
			and object.sha256 = p_sha256
			and (p_bytes is null or object.bytes = p_bytes)
	)
$$;

revoke all on function public.qorpera_object_exists(uuid, text, bigint) from public;

-- The drift function shipped in 20260818003000 with an operator-precedence
-- defect: except and union all share precedence and associate left, so its
-- body evaluated as ((live except catalog) union all catalog) except live,
-- which reads zero exactly when the catalog is missing rows -- the one
-- divergence that matters most. The 050 suite never noticed because it only
-- asserts drift in agreeing states, where the broken shape also reads zero;
-- the forced-divergence experiment in 060 exposed it. Both directions are
-- now parenthesized explicitly.
create or replace function public.qorpera_object_catalog_drift()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
	with live as (
		select identity.profile_id, identity.sha256, identity.bytes
		from storage.objects as object
		cross join lateral
			public.qorpera_profile_object_identity(object.bucket_id, object.name, object.metadata) as identity
		where identity.profile_id is not null
			and identity.sha256 is not null
			and identity.bytes is not null
	)
	select count(*)
	from (
		(
			select profile_id, sha256, bytes from live
			except
			select profile_id, sha256, bytes from public.qorpera_profile_objects
		)
		union all
		(
			select profile_id, sha256, bytes from public.qorpera_profile_objects
			except
			select profile_id, sha256, bytes from live
		)
	) as divergence
$$;

create or replace function public.qorpera_register_artifact(
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
	if not public.qorpera_object_exists(v_profile_id, p_root_object_sha256) then
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

create or replace function public.qorpera_register_artifact_v2(
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
	if not public.qorpera_object_exists(v_profile_id, p_root_object_sha256) then
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

create or replace function public.qorpera_object_graph_objects_available(p_graph_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select not exists (
		select 1
		from public.qorpera_object_reachability_entries as entry
		left join public.qorpera_profile_objects as object
			on object.profile_id = graph.profile_id
			and object.sha256 = entry.object_sha256
		where entry.graph_id = p_graph_id
			and (object.profile_id is null or object.bytes <> entry.bytes)
	)
	from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id
$$;

create or replace function public.qorpera_append_object_reachability_entries(
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
		left join public.qorpera_profile_objects as object
			on object.profile_id = v_graph.profile_id
			and object.sha256 = entry.sha256
		where object.profile_id is null
			or object.bytes <> entry.bytes
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

create or replace function public.qorpera_complete_artifact_gc_plan(p_plan_id uuid, p_lease_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_plan public.qorpera_artifact_gc_plans%rowtype;
	v_artifact public.qorpera_artifacts%rowtype;
begin
	if auth.role() <> 'service_role' then
		raise exception 'artifact cleanup completion requires the worker' using errcode = '42501';
	end if;
	select plan.* into v_plan from public.qorpera_artifact_gc_plans as plan
	where plan.id = p_plan_id and plan.status = 'deleting'
		and plan.lease_id = p_lease_id and plan.lease_expires_at > statement_timestamp()
	for update;
	if not found then raise exception 'artifact cleanup lease is unavailable' using errcode = '40001'; end if;
	perform public.qorpera_claim_artifact_gc_objects(p_plan_id, p_lease_id, 100);
	if exists (
		select 1 from public.qorpera_artifact_gc_plan_entries as entry
		where entry.plan_id = p_plan_id and entry.status = 'pending'
	) then
		raise exception 'artifact cleanup still has pending objects' using errcode = '40001';
	end if;
	if exists (
		select 1
		from public.qorpera_artifact_gc_plan_entries as entry
		join public.qorpera_profile_objects as object
			on object.profile_id = v_plan.profile_id
			and object.sha256 = entry.object_sha256
		where entry.plan_id = p_plan_id and entry.status = 'deleted'
	) then
		raise exception 'artifact cleanup storage removal is not yet visible' using errcode = '40001';
	end if;
	select artifact.* into v_artifact from public.qorpera_artifacts as artifact
	where artifact.id = v_plan.artifact_id for update;
	if exists (
		select 1 from public.qorpera_artifact_retention_holds as hold
		where hold.artifact_id = v_artifact.id and hold.released_at is null
			and (hold.expires_at is null or hold.expires_at > statement_timestamp())
	) or exists (
		select 1 from public.qorpera_artifact_index_entries as index_entry
		join public.qorpera_company_substrate_versions as version
			on version.artifact_index_id = index_entry.index_id
		where index_entry.artifact_id = v_artifact.id
	) then
		raise exception 'artifact cleanup became retained before completion' using errcode = '40001';
	end if;
	update public.qorpera_artifacts set gc_completed_at = statement_timestamp()
	where id = v_artifact.id;
	update public.qorpera_artifact_gc_plans
	set status = 'completed', completed_at = statement_timestamp(),
		lease_id = null, lease_expires_at = null, last_error = null
	where id = p_plan_id returning * into v_plan;
	perform public.qorpera_append_artifact_gc_audit(
		v_plan, 'completed', jsonb_build_object(
			'deleted_object_count', (
				select count(*) from public.qorpera_artifact_gc_plan_entries as entry
				where entry.plan_id = p_plan_id and entry.status = 'deleted'
			),
			'retained_object_count', (
				select count(*) from public.qorpera_artifact_gc_plan_entries as entry
				where entry.plan_id = p_plan_id and entry.status = 'retained'
			)
		), null
	);
	return public.qorpera_artifact_gc_plan_json(v_plan);
end
$$;

create or replace function public.qorpera_runner_broker_authorize_input_object(
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
	if not public.qorpera_object_exists(v_job.profile_id, p_object_sha256, v_bytes) then
		raise exception 'runner input object is unavailable' using errcode = '55000';
	end if;
	return jsonb_build_object(
		'profile_id', v_job.profile_id,
		'object_sha256', p_object_sha256,
		'bytes', v_bytes
	);
end
$$;

create or replace function public.qorpera_runner_broker_confirm_output_object(
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
	if not found or not public.qorpera_object_exists(v_job.profile_id, p_object_sha256, v_output.bytes) then
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
		join public.qorpera_profile_objects as object
			on object.profile_id = v_job.profile_id
			and object.sha256 = output.object_sha256
		where output.job_id = v_job.id
			and output.object_sha256 = p_object_sha256
			and output.bytes = p_bytes
			and output.media_type = v_media_type
			and output.uploaded_at is not null
			and object.bytes = output.bytes
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
