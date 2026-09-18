-- Return only identity already resolved by the existing human read authority.
-- The gateway uses it for optional operator-only request observations; it is
-- not a new grant, read route or authority cache. All 19950 preconditions and
-- closure checks are unchanged. CREATE OR REPLACE retains OID, owner and ACL.
create or replace function public.qorpera_authorize_member_company_path_object(
	p_environment_id uuid,p_path text,p_version uuid,p_sha256 text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_resource public.qorpera_company_path_resources%rowtype;
	v_entry public.qorpera_company_path_entries%rowtype;
	v_object public.qorpera_profile_objects%rowtype; v_company uuid;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,null);
	v_resource := public.qorpera_company_path_require(v_actor,p_path,'read');
	if p_version is null or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'Company File object identity is invalid' using errcode = '22023'; end if;
	v_company := (v_actor ->> 'companyId')::uuid;
	select * into v_entry from public.qorpera_company_path_entries
	where environment_id = p_environment_id
		and path_key_sha256 = extensions.digest(public.qorpera_company_path_key(p_path),'sha256');
	if not found or v_entry.entry ->> 'kind' is distinct from 'file' then
		raise exception 'Company File content is unavailable' using errcode = '42501'; end if;
	if v_entry.version <> p_version then
		raise exception 'Company File path version changed' using errcode = 'PT412'; end if;
	if not public.qorpera_company_path_file_available(v_company,v_entry.entry -> 'file') then
		raise exception 'Company File storage is unavailable' using errcode = '55000'; end if;
	select o.* into v_object from public.qorpera_profile_objects o
	where o.profile_id = v_company and o.sha256 = p_sha256 and o.bytes between 0 and 8388608
		and exists(select 1 from public.qorpera_verified_company_file_objects proof,
			lateral jsonb_array_elements(proof.objects) part(value)
			where proof.profile_id = v_company and proof.verifier_version = 1
				and proof.manifest_sha256 = v_entry.entry #>> '{file,manifestSha256}'
				and proof.file_sha256 = v_entry.entry #>> '{file,fileSha256}'
				and part.value ->> 'sha256' = p_sha256 and (part.value ->> 'bytes')::bigint = o.bytes);
	if not found then raise exception 'Company File content is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('schema','qorpera.member-company-object/v2','companyId',v_company,
		'environmentId',p_environment_id,'path',p_path,'version',p_version,'sha256',p_sha256,
		'bytes',v_object.bytes,'backend',v_object.backend,'actorUserId',v_actor ->> 'userId',
		'resourceId',v_resource.id,'resourceVersion',v_resource.version);
end
$$;
