-- Closure membership is a set of exact (sha256, bytes) objects. Earlier
-- verified-file ingestion could retain a different array order; an identical
-- manifest must reverify without a manual cache repair. Compare both set
-- directions, preserve all file/manifest metadata checks, and normalize only
-- an equivalent closure to the verifier's canonical order. Changed members or
-- byte lengths still fail. Existing definer ownership and ACLs are preserved.

create or replace function public.qorpera_verify_company_path_file(p_profile_id uuid, p_manifest_text text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_manifest jsonb; v_sha text; v_objects jsonb; v_bytes integer;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Company File verifier authority is required' using errcode = '42501'; end if;
	v_bytes := octet_length(p_manifest_text);
	if p_manifest_text is null or v_bytes not between 1 and 8388608 then
		raise exception 'Company File manifest is invalid' using errcode = '22023'; end if;
	v_manifest := p_manifest_text::jsonb;
	v_sha := encode(extensions.digest(convert_to(p_manifest_text,'utf8'),'sha256'),'hex');
	if v_manifest ->> 'schema' is distinct from 'qorpera.cloud-file-manifest/v1'
		or v_manifest - array['schema','fileSha256','bytes','mediaType','chunks'] <> '{}'::jsonb
		or not public.qorpera_company_path_entry_valid(jsonb_build_object('kind','file','path','verified',
			'executable',false,'file',jsonb_build_object('manifestSha256',v_sha,
				'fileSha256',v_manifest -> 'fileSha256','bytes',v_manifest -> 'bytes','mediaType',v_manifest -> 'mediaType')))
		or jsonb_typeof(v_manifest -> 'chunks') is distinct from 'array' then
		raise exception 'Company File manifest is invalid' using errcode = '22023'; end if;
	-- This existing verified-file cache has a 256 MiB/64-chunk contract. The
	-- model tools are ranged; expanding the storage codec is a separate change.
	if jsonb_array_length(v_manifest -> 'chunks') > 64 or (v_manifest ->> 'bytes')::bigint > 268435456
		or exists (select 1 from jsonb_array_elements(v_manifest -> 'chunks') with ordinality as c(value,n)
			where jsonb_typeof(value) <> 'object' or value - array['sha256','bytes'] <> '{}'::jsonb
				or coalesce(value ->> 'sha256','') !~ '^[0-9a-f]{64}$'
				or coalesce(value ->> 'bytes','') !~ '^[1-9][0-9]{0,6}$'
				or jsonb_typeof(value -> 'bytes') <> 'number'
				or (value ->> 'bytes')::bigint > 4194304
				or (n < jsonb_array_length(v_manifest -> 'chunks') and (value ->> 'bytes')::bigint <> 4194304))
		or (select coalesce(sum((value ->> 'bytes')::bigint),0) from jsonb_array_elements(v_manifest -> 'chunks'))
			<> (v_manifest ->> 'bytes')::bigint then
		raise exception 'Company File chunks are invalid' using errcode = '22023'; end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	if public.qorpera_profile_gc_deletion_active(p_profile_id) then
		raise exception 'Company File storage is busy' using errcode = '40001'; end if;
	select jsonb_agg(object order by object ->> 'sha256') into v_objects from (
		select distinct value as object from jsonb_array_elements(v_manifest -> 'chunks')
		union select jsonb_build_object('sha256',v_sha,'bytes',v_bytes)
	) as closure;
	if exists (select 1 from jsonb_array_elements(v_objects) as o(value)
		left join public.qorpera_profile_objects as stored
			on stored.profile_id = p_profile_id and stored.sha256 = o.value ->> 'sha256'
		where stored.sha256 is null or stored.bytes <> (o.value ->> 'bytes')::bigint) then
		raise exception 'Company File objects are unavailable' using errcode = '55000'; end if;
	insert into public.qorpera_verified_company_file_objects (
		profile_id,manifest_sha256,manifest_bytes,file_sha256,bytes,media_type,objects
	) values (p_profile_id,v_sha,v_bytes,v_manifest ->> 'fileSha256',(v_manifest ->> 'bytes')::bigint,
		'application/octet-stream',v_objects)
	on conflict (profile_id,manifest_sha256,verifier_version) do update
	set verified_at = clock_timestamp(), objects = excluded.objects
	where qorpera_verified_company_file_objects.file_sha256 = excluded.file_sha256
		and qorpera_verified_company_file_objects.bytes = excluded.bytes
		and qorpera_verified_company_file_objects.manifest_bytes = excluded.manifest_bytes
		and qorpera_verified_company_file_objects.media_type = excluded.media_type
		and qorpera_verified_company_file_objects.objects @> excluded.objects
		and qorpera_verified_company_file_objects.objects <@ excluded.objects;
	if not found then raise exception 'Company File verification differs' using errcode = '23505'; end if;
end
$$;
