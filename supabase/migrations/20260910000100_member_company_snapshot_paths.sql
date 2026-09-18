-- Historical content remains bound to a published, verified snapshot and to
-- the human's CURRENT path policy. A snapshot identifier is not an object
-- capability, and the browser never receives an unfiltered tree manifest.
create function public.qorpera_member_company_snapshot_tree(p_actor jsonb,p_snapshot_id uuid)
returns public.qorpera_company_path_tree_cache
language plpgsql security definer set search_path = '' as $$
declare v_tree public.qorpera_company_path_tree_cache%rowtype;
begin
	select cache.* into v_tree
	from public.qorpera_company_snapshots snapshot
	join public.qorpera_company_snapshot_publications publication
		on publication.snapshot_id = snapshot.id and publication.status = 'published'
	join public.qorpera_company_path_tree_cache cache
		on cache.profile_id = snapshot.profile_id and cache.sha256 = snapshot.tree_manifest_sha256
		and cache.bytes = snapshot.tree_manifest_bytes and cache.file_count = snapshot.file_count
		and cache.total_bytes = snapshot.total_bytes
	join public.qorpera_profile_objects object
		on object.profile_id = cache.profile_id and object.sha256 = cache.sha256 and object.bytes = cache.bytes
	join public.qorpera_object_reachability_graphs graph
		on graph.root_kind = 'company_snapshot' and graph.root_id = snapshot.id
		and graph.profile_id = snapshot.profile_id and graph.environment_id = snapshot.environment_id
		and graph.root_object_sha256 = snapshot.tree_manifest_sha256
		and graph.status = 'complete' and graph.closure_verified
	where snapshot.id = p_snapshot_id and snapshot.profile_id = (p_actor ->> 'companyId')::uuid
		and snapshot.environment_id = (p_actor ->> 'environmentId')::uuid
		and snapshot.tree_contract_version = 3
		and public.qorpera_object_graph_objects_available(graph.id);
	-- ARTIFACT-GC.md: historical roots require independently verified closure,
	-- not weekly full-content restore proofs. Current member path policy and
	-- catalog availability are checked here; byte integrity is checked on read.
	if not found then
		raise exception 'Company File snapshot is unavailable' using errcode = '42501'; end if;
	return v_tree;
end
$$;

create function public.qorpera_list_member_company_snapshot_paths(
	p_environment_id uuid,p_snapshot_id uuid,p_after text default null,p_limit integer default 100
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_tree public.qorpera_company_path_tree_cache%rowtype;
	v_items jsonb; v_more boolean;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,null);
	perform public.qorpera_company_path_require(v_actor,'','read');
	if p_snapshot_id is null or p_limit is null or p_limit not between 1 and 100
		or (p_after is not null and not public.qorpera_company_path_valid(p_after)) then
		raise exception 'Company File snapshot page is invalid' using errcode = '22023'; end if;
	v_tree := public.qorpera_member_company_snapshot_tree(v_actor,p_snapshot_id);
	with visible as materialized (
		select entry from jsonb_array_elements(v_tree.manifest -> 'entries') entry
		where (p_after is null or (entry ->> 'path') collate "C" > p_after collate "C")
			and public.qorpera_company_path_allowed(v_actor,entry ->> 'path','read')
		order by (entry ->> 'path') collate "C" limit p_limit + 1
	), page as (select entry from visible order by (entry ->> 'path') collate "C" limit p_limit)
	select coalesce((select jsonb_agg(entry order by (entry ->> 'path') collate "C") from page),'[]'::jsonb),
		(select count(*) > p_limit from visible) into v_items,v_more;
	return jsonb_build_object('companyId',v_actor ->> 'companyId','environmentId',p_environment_id,
		'snapshotId',p_snapshot_id,'items',v_items,'hasMore',v_more,
		'nextAfter',case when v_more then v_items -> -1 ->> 'path' else null end);
end
$$;

create function public.qorpera_read_member_company_snapshot_path(p_environment_id uuid,p_snapshot_id uuid,p_path text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_tree public.qorpera_company_path_tree_cache%rowtype;
	v_entry jsonb; v_manifest_bytes bigint;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,null);
	perform public.qorpera_company_path_require(v_actor,p_path,'read');
	if p_snapshot_id is null then
		raise exception 'Company File snapshot identity is invalid' using errcode = '22023'; end if;
	v_tree := public.qorpera_member_company_snapshot_tree(v_actor,p_snapshot_id);
	select entry into v_entry from jsonb_array_elements(v_tree.manifest -> 'entries') entry
	where entry ->> 'path' = p_path;
	if v_entry ->> 'kind' = 'file' then
		if not public.qorpera_company_path_file_available((v_actor ->> 'companyId')::uuid,v_entry -> 'file') then
			raise exception 'Company File snapshot storage is unavailable' using errcode = '55000'; end if;
		select bytes into v_manifest_bytes from public.qorpera_profile_objects
		where profile_id = (v_actor ->> 'companyId')::uuid and sha256 = v_entry #>> '{file,manifestSha256}';
	end if;
	return jsonb_build_object('companyId',v_actor ->> 'companyId','path',p_path,
		'version',p_snapshot_id,'entry',v_entry,'manifestBytes',v_manifest_bytes);
end
$$;

create function public.qorpera_authorize_member_company_snapshot_object(
	p_environment_id uuid,p_path text,p_snapshot_id uuid,p_sha256 text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_resource public.qorpera_company_path_resources%rowtype;
	v_tree public.qorpera_company_path_tree_cache%rowtype; v_entry jsonb;
	v_company uuid; v_object public.qorpera_profile_objects%rowtype;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,null);
	v_resource := public.qorpera_company_path_require(v_actor,p_path,'read');
	if p_snapshot_id is null or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'Company File snapshot object identity is invalid' using errcode = '22023'; end if;
	v_company := (v_actor ->> 'companyId')::uuid;
	v_tree := public.qorpera_member_company_snapshot_tree(v_actor,p_snapshot_id);
	select entry into v_entry from jsonb_array_elements(v_tree.manifest -> 'entries') entry
	where entry ->> 'path' = p_path;
	if v_entry ->> 'kind' is distinct from 'file' then
		raise exception 'Company File snapshot content is unavailable' using errcode = '42501'; end if;
	if not public.qorpera_company_path_file_available(v_company,v_entry -> 'file') then
		raise exception 'Company File snapshot storage is unavailable' using errcode = '55000'; end if;
	select object.* into v_object from public.qorpera_profile_objects object
	where object.profile_id = v_company and object.sha256 = p_sha256 and object.bytes between 0 and 8388608
		and exists(select 1 from public.qorpera_verified_company_file_objects proof,
			lateral jsonb_array_elements(proof.objects) part(value)
			where proof.profile_id = v_company and proof.verifier_version = 1
				and proof.manifest_sha256 = v_entry #>> '{file,manifestSha256}'
				and proof.file_sha256 = v_entry #>> '{file,fileSha256}'
				and part.value ->> 'sha256' = p_sha256 and (part.value ->> 'bytes')::bigint = object.bytes);
	if not found then raise exception 'Company File snapshot content is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('schema','qorpera.member-company-object/v2','companyId',v_company,
		'environmentId',p_environment_id,'path',p_path,'version',p_snapshot_id,'sha256',p_sha256,
		'bytes',v_object.bytes,'backend',v_object.backend,'actorUserId',v_actor ->> 'userId',
		'resourceId',v_resource.id,'resourceVersion',v_resource.version);
end
$$;

revoke all on function public.qorpera_member_company_snapshot_tree(jsonb,uuid),
	public.qorpera_list_member_company_snapshot_paths(uuid,uuid,text,integer),
	public.qorpera_read_member_company_snapshot_path(uuid,uuid,text),
	public.qorpera_authorize_member_company_snapshot_object(uuid,text,uuid,text)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_list_member_company_snapshot_paths(uuid,uuid,text,integer),
	public.qorpera_read_member_company_snapshot_path(uuid,uuid,text),
	public.qorpera_authorize_member_company_snapshot_object(uuid,text,uuid,text) to authenticated;
