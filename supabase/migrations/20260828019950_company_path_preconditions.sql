-- A stale path/version is a failed request precondition, not a retryable
-- PostgreSQL serialization failure. Retrying the same caller-supplied version
-- cannot succeed and managed PostgREST versions may retry SQLSTATE 40001.
-- Keep authorization before version disclosure, and retain PT409 exclusively
-- for the gateway's separately bounded head-rebuild path. CREATE OR REPLACE
-- preserves the existing function identity, owner and EXECUTE grants.
create or replace function public.qorpera_company_path_plan(p_actor jsonb,p_plan jsonb,p_check_version boolean,p_check_bytes boolean default true)
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
		raise exception 'Company File path version changed' using errcode = 'PT412'; end if;
	if p_check_version and p_plan -> 'entry' = 'null'::jsonb and v_entry.entry is null then
		raise exception 'Company File deletion target is unavailable' using errcode = 'PT412'; end if;
	if p_check_bytes and p_plan #>> '{entry,kind}' = 'file' and not public.qorpera_company_path_file_available(
		(p_actor ->> 'companyId')::uuid,p_plan #> '{entry,file}') then
		raise exception 'Company File mutation bytes are not verified' using errcode = '55000'; end if;
	return v_resource;
end
$$;

create or replace function public.qorpera_authorize_member_company_path_object(
	p_environment_id uuid,p_path text,p_version uuid,p_sha256 text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_entry public.qorpera_company_path_entries%rowtype;
	v_object public.qorpera_profile_objects%rowtype; v_company uuid;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,null);
	perform public.qorpera_company_path_require(v_actor,p_path,'read');
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
	return jsonb_build_object('schema','qorpera.member-company-object/v1','companyId',v_company,
		'environmentId',p_environment_id,'path',p_path,'version',p_version,'sha256',p_sha256,
		'bytes',v_object.bytes,'backend',v_object.backend);
end
$$;
