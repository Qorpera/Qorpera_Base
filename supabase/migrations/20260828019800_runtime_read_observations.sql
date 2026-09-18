-- Exact read provenance is an audit/data-flow projection, not a Company File
-- checkout or a new work queue. Reads remain live; effects retain path-version CAS.

create table public.qorpera_company_read_observations (
	id uuid primary key default extensions.gen_random_uuid(),
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	environment_id uuid not null references public.qorpera_company_files(environment_id) on delete restrict,
	snapshot_id uuid not null references public.qorpera_company_snapshots(id) on delete restrict,
	path text not null check (public.qorpera_company_path_valid(path,true)),
	kind text not null check (kind in ('file','directory','absent','list')),
	version uuid,
	-- Server-authored immutable entry or directory-page metadata; never file contents.
	source jsonb not null check (jsonb_typeof(source) = 'object' and pg_column_size(source) <= 65536),
	requested_offset integer not null check (requested_offset between 0 and 268435456),
	requested_limit integer not null check (requested_limit between 0 and 4096),
	created_at timestamptz not null default clock_timestamp(),
	unique(run_id,id)
);
create table public.qorpera_company_read_confirmations (
	read_id uuid primary key references public.qorpera_company_read_observations(id) on delete restrict,
	included_bytes integer not null check (included_bytes between 0 and 4096),
	result_sha256 text not null check (result_sha256 ~ '^[0-9a-f]{64}$'),
	confirmed_at timestamptz not null default clock_timestamp()
);
create table public.qorpera_native_context_views (
	id uuid primary key default extensions.gen_random_uuid(),
	run_id uuid not null references public.qorpera_native_execution_launches(run_id) on delete restrict,
	ordinal integer not null check (ordinal between 1 and 256),
	parent_id uuid references public.qorpera_native_context_views(id) on delete restrict,
	request_id text not null check (request_id ~ '^[A-Za-z0-9_:.-]{1,160}$'),
	-- Exact fenced-output digests plus read references; not private scratchpad or secrets.
	view jsonb not null check (jsonb_typeof(view) = 'object' and pg_column_size(view) <= 131072),
	sha256 text generated always as (encode(extensions.digest(view::text,'sha256'),'hex')) stored,
	created_at timestamptz not null default clock_timestamp(),
	unique(run_id,request_id), unique(run_id,ordinal)
);
alter table public.qorpera_company_read_observations enable row level security;
alter table public.qorpera_company_read_confirmations enable row level security;
alter table public.qorpera_native_context_views enable row level security;
revoke all on public.qorpera_company_read_observations,public.qorpera_company_read_confirmations,
	public.qorpera_native_context_views from public,anon,authenticated,service_role;
create trigger qorpera_company_read_observations_immutable before update or delete on public.qorpera_company_read_observations
for each row execute function public.qorpera_reject_runtime_bundle_mutation();
create trigger qorpera_company_read_confirmations_immutable before update or delete on public.qorpera_company_read_confirmations
for each row execute function public.qorpera_reject_runtime_bundle_mutation();
create trigger qorpera_native_context_views_immutable before update or delete on public.qorpera_native_context_views
for each row execute function public.qorpera_reject_runtime_bundle_mutation();

create function public.qorpera_read_company_path_v2(
	p_environment_id uuid,p_path text,p_offset integer,p_limit integer,p_binding jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_read jsonb; v_snapshot uuid; v_id uuid; v_kind text;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Native read provenance requires cloud authority' using errcode = '42501'; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	if p_offset is null or p_offset not between 0 and 268435456 or p_limit is null or p_limit not between 4 and 4096 then
		raise exception 'Read range is invalid' using errcode = '22023'; end if;
	if (select count(*) from public.qorpera_company_read_observations where run_id = (v_actor ->> 'runId')::uuid) >= 128 then
		raise exception 'Read observation budget exceeded' using errcode = '54000'; end if;
	v_read := public.qorpera_read_company_path(p_environment_id,p_path,p_binding);
	select head_snapshot_id into strict v_snapshot from public.qorpera_company_files where environment_id = p_environment_id;
	v_kind := coalesce(v_read #>> '{entry,kind}','absent');
	if v_kind = 'file' and p_offset > (v_read #>> '{entry,file,bytes}')::bigint then
		raise exception 'Read range exceeds the file' using errcode = '22023'; end if;
	insert into public.qorpera_company_read_observations(run_id,environment_id,snapshot_id,path,kind,version,source,requested_offset,requested_limit)
	values ((v_actor ->> 'runId')::uuid,p_environment_id,v_snapshot,p_path,v_kind,(v_read ->> 'version')::uuid,
		v_read,p_offset,p_limit) returning id into v_id;
	return v_read || jsonb_build_object('snapshotId',v_snapshot,'readObservationId',v_id);
end
$$;

create function public.qorpera_list_company_paths_v2(
	p_environment_id uuid,p_path text,p_after text,p_snapshot_id uuid,p_limit integer,p_binding jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_page jsonb; v_id uuid;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Native read provenance requires cloud authority' using errcode = '42501'; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	if p_limit is null or p_limit not between 1 and 50 then
		raise exception 'Native page size is invalid' using errcode = '22023'; end if;
	if (select count(*) from public.qorpera_company_read_observations where run_id = (v_actor ->> 'runId')::uuid) >= 128 then
		raise exception 'Read observation budget exceeded' using errcode = '54000'; end if;
	v_page := public.qorpera_list_company_paths(p_environment_id,p_path,p_after,p_snapshot_id,p_limit,p_binding);
	insert into public.qorpera_company_read_observations(run_id,environment_id,snapshot_id,path,kind,source,requested_offset,requested_limit)
	values((v_actor ->> 'runId')::uuid,p_environment_id,(v_page ->> 'snapshotId')::uuid,p_path,'list',
		jsonb_build_object('page',v_page,'after',p_after,'limit',p_limit),0,0) returning id into v_id;
	return v_page || jsonb_build_object('readObservationId',v_id);
end
$$;

create function public.qorpera_confirm_company_path_read(
	p_environment_id uuid,p_binding jsonb,p_read_id uuid,p_included_bytes integer,p_result_sha256 text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_read public.qorpera_company_read_observations%rowtype;
	v_existing public.qorpera_company_read_confirmations%rowtype;
	v_entry public.qorpera_company_path_entries%rowtype; v_item jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Native read confirmation requires cloud authority' using errcode = '42501'; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	select * into v_read from public.qorpera_company_read_observations where id = p_read_id
		and run_id = (v_actor ->> 'runId')::uuid and environment_id = p_environment_id;
	if not found then raise exception 'Read observation is unavailable' using errcode = '42501'; end if;
	if coalesce(p_result_sha256,'') !~ '^[0-9a-f]{64}$' or p_included_bytes is null
		or p_included_bytes not between 0 and v_read.requested_limit
		or (v_read.kind <> 'file' and p_included_bytes <> 0)
		or (v_read.kind = 'file' and
			(p_included_bytes > (v_read.source #>> '{entry,file,bytes}')::bigint - v_read.requested_offset
			or (p_included_bytes = 0 and (v_read.source #>> '{entry,file,bytes}')::bigint > v_read.requested_offset))) then
		raise exception 'Read confirmation is invalid' using errcode = '22023'; end if;
	perform public.qorpera_company_path_require(v_actor,v_read.path,'read');
	select * into v_existing from public.qorpera_company_read_confirmations where read_id = p_read_id;
	if found then
		if (v_existing.included_bytes,v_existing.result_sha256) is distinct from (p_included_bytes,p_result_sha256) then
			raise exception 'Read confirmation differs' using errcode = '23505'; end if;
	else
		if v_read.kind = 'list' then
			for v_item in select value from jsonb_array_elements(v_read.source #> '{page,items}') loop
				perform public.qorpera_company_path_require(v_actor,v_item ->> 'path','read');
			end loop;
		else
			-- Transport confirmation is tied to the same opaque version, not a
			-- whole-company head. A concurrent disjoint write does not invalidate it.
			select * into v_entry from public.qorpera_company_path_entries
			where environment_id = p_environment_id
				and path_key_sha256 = extensions.digest(public.qorpera_company_path_key(v_read.path),'sha256');
			if v_entry.version is distinct from v_read.version
				or coalesce(v_entry.entry,'null'::jsonb) is distinct from v_read.source -> 'entry' then
				raise exception 'Company File changed during read' using errcode = '40001'; end if;
		end if;
		insert into public.qorpera_company_read_confirmations(read_id,included_bytes,result_sha256)
		values(p_read_id,p_included_bytes,p_result_sha256);
	end if;
	return jsonb_build_object('schema','qorpera.company-read-confirmation/v1','readId',p_read_id,'resultSha256',p_result_sha256);
end
$$;

create function public.qorpera_record_native_context_view(p_environment_id uuid,p_binding jsonb,p_view jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_view public.qorpera_native_context_views%rowtype; v_parent uuid; v_ordinal integer;
	v_output jsonb; v_read public.qorpera_company_read_confirmations%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Context view requires cloud authority' using errcode = '42501'; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	if not exists(select 1 from public.qorpera_native_execution_launches where run_id = (v_actor ->> 'runId')::uuid) then
		raise exception 'Native launch provenance is unavailable' using errcode = '42501'; end if;
	if jsonb_typeof(p_view) is distinct from 'object' or pg_column_size(p_view) > 131072
		or p_view - array['schema','requestId','threadId','turnId','purpose','outputs'] <> '{}'::jsonb
		or p_view ->> 'schema' is distinct from 'qorpera.native-context-view/v1'
		or coalesce(p_view ->> 'requestId','') !~ '^[A-Za-z0-9_:.-]{1,160}$'
		or coalesce(p_view ->> 'threadId','') !~ '^[A-Za-z0-9_:.-]{1,160}$'
		or (p_view -> 'turnId' is distinct from 'null'::jsonb and
			coalesce(p_view ->> 'turnId','') !~ '^[A-Za-z0-9_:.-]{1,160}$')
		or coalesce(p_view ->> 'purpose','') not in ('prewarm','turn','compaction')
		or jsonb_typeof(p_view -> 'outputs') is distinct from 'array' then
		raise exception 'Context view is invalid' using errcode = '22023'; end if;
	if jsonb_array_length(p_view -> 'outputs') > 128
		or (p_view ->> 'purpose' = 'prewarm' and p_view -> 'outputs' <> '[]'::jsonb) then
		raise exception 'Context view budget is invalid' using errcode = '22023'; end if;
	for v_output in select value from jsonb_array_elements(p_view -> 'outputs') loop
		if jsonb_typeof(v_output) is distinct from 'object'
			or v_output - array['callId','kind','sha256','bytes','readId','readSha256','includedBytes','includedSha256'] <> '{}'::jsonb
			or coalesce(v_output ->> 'callId','') !~ '^[A-Za-z0-9_:.-]{1,160}$'
			or coalesce(v_output ->> 'kind','') not in ('function_call_output','custom_tool_call_output')
			or coalesce(v_output ->> 'sha256','') !~ '^[0-9a-f]{64}$'
			or coalesce(v_output ->> 'bytes','') !~ '^[1-9][0-9]{0,3}$'
			or (v_output ->> 'bytes')::integer > 8192 then
			raise exception 'Context output is invalid' using errcode = '22023'; end if;
		if v_output -> 'readId' is distinct from 'null'::jsonb then
			select confirmation.* into v_read from public.qorpera_company_read_confirmations confirmation
			join public.qorpera_company_read_observations observation on observation.id = confirmation.read_id
			where observation.id = (v_output ->> 'readId')::uuid and observation.run_id = (v_actor ->> 'runId')::uuid
				and observation.environment_id = p_environment_id;
			if not found or v_read.result_sha256 is distinct from v_output ->> 'readSha256'
				or coalesce(v_output ->> 'includedBytes','') !~ '^(0|[1-9][0-9]{0,3})$'
				or (v_output ->> 'includedBytes')::integer > 8192
				or coalesce(v_output ->> 'includedSha256','') !~ '^[0-9a-f]{64}$' then
				raise exception 'Context read provenance differs' using errcode = '42501'; end if;
		elsif v_output -> 'readSha256' is distinct from 'null'::jsonb
			or v_output -> 'includedBytes' is distinct from 'null'::jsonb
			or v_output -> 'includedSha256' is distinct from 'null'::jsonb then
			raise exception 'Unexpected context read provenance' using errcode = '22023'; end if;
	end loop;
	if (select count(distinct output ->> 'callId') from jsonb_array_elements(p_view -> 'outputs') output)
		<> jsonb_array_length(p_view -> 'outputs') then
		raise exception 'Duplicate context output' using errcode = '22023'; end if;
	select * into v_view from public.qorpera_native_context_views where run_id = (v_actor ->> 'runId')::uuid
		and request_id = p_view ->> 'requestId';
	if found then
		if v_view.view <> p_view then raise exception 'Context request replay differs' using errcode = '23505'; end if;
	else
		select id,ordinal into v_parent,v_ordinal from public.qorpera_native_context_views
		where run_id = (v_actor ->> 'runId')::uuid order by ordinal desc limit 1;
		if coalesce(v_ordinal,0) >= 256 then raise exception 'Context view budget exceeded' using errcode = '54000'; end if;
		-- Parent lineage retains evidence used to derive a compacted summary even
		-- when that provider request no longer repeats an old tool output.
		insert into public.qorpera_native_context_views(run_id,ordinal,parent_id,request_id,view)
		values((v_actor ->> 'runId')::uuid,coalesce(v_ordinal,0)+1,v_parent,p_view ->> 'requestId',p_view)
		returning * into v_view;
	end if;
	return jsonb_build_object('schema','qorpera.native-context-view-receipt/v1',
		'viewId',v_view.id,'requestId',v_view.request_id,'sha256',v_view.sha256,'ordinal',v_view.ordinal);
end
$$;

-- Keep the bytes behind read evidence for the existing 30-day audit window,
-- and for any still-active run. No secret body or entire checkout is retained.
alter function public.qorpera_company_additional_retained_object_hashes(uuid)
	rename to qorpera_company_pre_observation_retained_object_hashes;
create function public.qorpera_company_additional_retained_object_hashes(p_profile_id uuid)
returns table(object_sha256 text) language sql stable security definer set search_path = '' as $$
	with retained as (
		select observation.* from public.qorpera_company_read_observations observation
		join public.qorpera_execution_runs run on run.id = observation.run_id
		join public.qorpera_runner_jobs job on job.id = run.job_id
		where run.profile_id = p_profile_id and
			(job.status in ('queued','leased') or observation.created_at >= statement_timestamp() - interval '30 days')
	)
	select object_sha256 from public.qorpera_company_pre_observation_retained_object_hashes(p_profile_id)
	union select snapshot.tree_manifest_sha256 from retained
	join public.qorpera_company_snapshots snapshot on snapshot.id = retained.snapshot_id
	union select object ->> 'sha256' from retained
	join public.qorpera_verified_company_file_objects proof on proof.profile_id = p_profile_id
		and proof.manifest_sha256 = retained.source #>> '{entry,file,manifestSha256}'
	cross join lateral jsonb_array_elements(proof.objects) object
$$;
revoke all on function public.qorpera_company_pre_observation_retained_object_hashes(uuid),
	public.qorpera_company_additional_retained_object_hashes(uuid),
	public.qorpera_read_company_path_v2(uuid,text,integer,integer,jsonb),
	public.qorpera_list_company_paths_v2(uuid,text,text,uuid,integer,jsonb),
	public.qorpera_confirm_company_path_read(uuid,jsonb,uuid,integer,text),
	public.qorpera_record_native_context_view(uuid,jsonb,jsonb)
	from public,anon,authenticated,service_role;
do $$
declare v_owner name;
begin
	select role.rolname into strict v_owner from pg_proc procedure
	join pg_roles role on role.oid = procedure.proowner
	where procedure.oid = 'public.qorpera_company_retained_object_hashes(uuid)'::regprocedure;
	execute format('grant execute on function public.qorpera_company_additional_retained_object_hashes(uuid) to %I',v_owner);
end
$$;
grant execute on function public.qorpera_read_company_path_v2(uuid,text,integer,integer,jsonb),
	public.qorpera_list_company_paths_v2(uuid,text,text,uuid,integer,jsonb),
	public.qorpera_confirm_company_path_read(uuid,jsonb,uuid,integer,text),
	public.qorpera_record_native_context_view(uuid,jsonb,jsonb) to service_role;
