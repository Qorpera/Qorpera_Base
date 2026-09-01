-- Step 6: bounded, host-only candidate preparation. Candidate metadata is
-- transient; only emitted sources join the existing durable run read set.
-- No new memory store, retention policy, model tool, or read-set reset.

create function public.qorpera_company_path_metadata(p_actor jsonb, p_path text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_entry public.qorpera_company_path_entries%rowtype; v_manifest_bytes bigint;
begin
	perform public.qorpera_company_path_require(p_actor,p_path,'read');
	select * into v_entry from public.qorpera_company_path_entries
	where environment_id = (p_actor ->> 'environmentId')::uuid
		and path_key_sha256 = extensions.digest(public.qorpera_company_path_key(p_path),'sha256');
	if v_entry.entry ->> 'kind' = 'file' then
		select bytes into v_manifest_bytes from public.qorpera_profile_objects
		where profile_id = (p_actor ->> 'companyId')::uuid and sha256 = v_entry.entry #>> '{file,manifestSha256}';
		if not found then raise exception 'Company File storage is unavailable' using errcode = '55000'; end if;
	end if;
	return jsonb_build_object('path',p_path,'version',v_entry.version,'entry',v_entry.entry,
		'manifestBytes',v_manifest_bytes,'companyId',p_actor ->> 'companyId');
end
$$;

create function public.qorpera_company_path_page(
	p_actor jsonb, p_path text, p_after text, p_snapshot_id uuid, p_limit integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_head uuid; v_items jsonb; v_more boolean;
begin
	perform public.qorpera_company_path_require(p_actor,p_path,'read');
	if p_limit is null or p_limit not between 1 and 100
		or (p_after is not null and not public.qorpera_company_path_valid(p_after))
		or (p_after is not null and p_snapshot_id is null) then
		raise exception 'Company File page is invalid' using errcode = '22023'; end if;
	select head_snapshot_id into v_head from public.qorpera_company_files
	where environment_id = (p_actor ->> 'environmentId')::uuid;
	if p_snapshot_id is not null and p_snapshot_id <> v_head then
		raise exception 'Company File page changed' using errcode = '40001'; end if;
	with visible as (
		select e.path,e.version,e.entry from public.qorpera_company_path_entries e
		where e.environment_id = (p_actor ->> 'environmentId')::uuid and e.entry is not null
			and (case when strpos(e.path,'/') = 0 then '' else regexp_replace(e.path,'/[^/]+$','') end) = p_path
			and (p_after is null or e.path > p_after collate "C")
			and public.qorpera_company_path_allowed(p_actor,e.path,'read')
		order by e.path limit p_limit + 1
	), page as (select * from visible order by path limit p_limit)
	select coalesce((select jsonb_agg(jsonb_build_object('path',path,'version',version,
		'kind',entry ->> 'kind','bytes',entry #> '{file,bytes}') order by path) from page),'[]'::jsonb),
		(select count(*) > p_limit from visible) into v_items,v_more;
	return jsonb_build_object('snapshotId',v_head,'items',v_items,'hasMore',v_more,
		'nextAfter',case when v_more then v_items -> -1 ->> 'path' else null end);
end
$$;

-- Native and human reads keep their original retention behavior. These
-- wrappers and preparation share the same metadata, path and page checks.
create or replace function public.qorpera_read_company_path(p_environment_id uuid, p_path text, p_binding jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	perform public.qorpera_company_path_remember_read(v_actor,p_path);
	return public.qorpera_company_path_metadata(v_actor,p_path);
end
$$;

create or replace function public.qorpera_list_company_paths(
	p_environment_id uuid, p_path text, p_after text default null,
	p_snapshot_id uuid default null, p_limit integer default 50, p_binding jsonb default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_page jsonb; v_item jsonb;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	v_page := public.qorpera_company_path_page(v_actor,p_path,p_after,p_snapshot_id,p_limit);
	perform public.qorpera_company_path_remember_read(v_actor,p_path);
	for v_item in select value from jsonb_array_elements(v_page -> 'items') loop
		perform public.qorpera_company_path_remember_read(v_actor,v_item ->> 'path');
	end loop;
	return v_page;
end
$$;

create function public.qorpera_read_company_path_candidates(p_environment_id uuid, p_binding jsonb, p_paths text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_path text; v_output jsonb := '[]'::jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Company File preparation authority is required' using errcode = '42501'; end if;
	if p_paths is null or cardinality(p_paths) > 32 or coalesce(array_ndims(p_paths),1) <> 1 then
		raise exception 'Company File candidate bound is invalid' using errcode = '22023'; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	foreach v_path in array p_paths loop
		v_output := v_output || jsonb_build_array(public.qorpera_company_path_metadata(v_actor,v_path));
	end loop;
	return v_output;
end
$$;

create function public.qorpera_list_company_path_candidates(
	p_environment_id uuid, p_binding jsonb, p_path text, p_after text, p_snapshot_id uuid, p_limit integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Company File preparation authority is required' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 32 then
		raise exception 'Company File candidate bound is invalid' using errcode = '22023'; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	return public.qorpera_company_path_page(v_actor,p_path,p_after,p_snapshot_id,p_limit);
end
$$;

-- The same transaction rechecks every observed path/version and the entire
-- existing context, then adds only selected sources. A failure rolls back all
-- additions; a lost response can only over-retain, never forget old context.
create function public.qorpera_retain_company_path_sources(
	p_environment_id uuid, p_binding jsonb, p_paths text[], p_sources jsonb, p_retained text[]
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_path text; v_source jsonb; v_current uuid;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Company File preparation authority is required' using errcode = '42501'; end if;
	if p_paths is null or cardinality(p_paths) > 64 or coalesce(array_ndims(p_paths),1) <> 1
		or p_retained is null or cardinality(p_retained) > 64 or coalesce(array_ndims(p_retained),1) <> 1
		or jsonb_typeof(p_sources) is distinct from 'array' or pg_column_size(p_sources) > 524288 then
		raise exception 'Company File source bound is invalid' using errcode = '22023'; end if;
	if jsonb_array_length(p_sources) > 64
		or (select count(distinct path) from unnest(p_paths) as paths(path)) <> cardinality(p_paths)
		or (select count(distinct path) from unnest(p_retained) as paths(path)) <> cardinality(p_retained) then
		raise exception 'Company File source set is invalid' using errcode = '22023'; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	foreach v_path in array p_paths loop
		perform public.qorpera_company_path_require(v_actor,v_path,'read');
	end loop;
	for v_source in select value from jsonb_array_elements(p_sources) loop
		if jsonb_typeof(v_source) is distinct from 'object'
			or v_source - array['path','version'] <> '{}'::jsonb
			or not (v_source ?& array['path','version'])
			or jsonb_typeof(v_source -> 'path') is distinct from 'string'
			or not (v_source ->> 'path' = any(p_paths))
			or (v_source -> 'version' <> 'null'::jsonb and (
				jsonb_typeof(v_source -> 'version') is distinct from 'string'
				or (v_source ->> 'version') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) then
			raise exception 'Company File source is invalid' using errcode = '22023'; end if;
		select version into v_current from public.qorpera_company_path_entries
		where environment_id = p_environment_id and path_key_sha256 = extensions.digest(
			public.qorpera_company_path_key(v_source ->> 'path'),'sha256');
		if v_current is distinct from (v_source ->> 'version')::uuid then
			raise exception 'Company File source changed' using errcode = '40001'; end if;
	end loop;
	if (select count(distinct value ->> 'path') from jsonb_array_elements(p_sources)) <> jsonb_array_length(p_sources) then
		raise exception 'Company File source set is invalid' using errcode = '22023'; end if;
	foreach v_path in array p_retained loop
		if not exists (select 1 from jsonb_array_elements(p_sources) as source(value)
			where value ->> 'path' = v_path and jsonb_typeof(value -> 'version') = 'string') then
			raise exception 'Company File output was not prepared' using errcode = '22023'; end if;
		perform public.qorpera_company_path_remember_read(v_actor,v_path);
	end loop;
	perform public.qorpera_company_path_assert_context(v_actor);
end
$$;

revoke all on function public.qorpera_company_path_metadata(jsonb,text),
	public.qorpera_company_path_page(jsonb,text,text,uuid,integer),
	public.qorpera_read_company_path_candidates(uuid,jsonb,text[]),
	public.qorpera_list_company_path_candidates(uuid,jsonb,text,text,uuid,integer),
	public.qorpera_retain_company_path_sources(uuid,jsonb,text[],jsonb,text[])
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_read_company_path_candidates(uuid,jsonb,text[]),
	public.qorpera_list_company_path_candidates(uuid,jsonb,text,text,uuid,integer),
	public.qorpera_retain_company_path_sources(uuid,jsonb,text[],jsonb,text[])
	to service_role;
