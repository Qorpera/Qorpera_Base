-- The trusted native host can stage immutable bytes for its admitted company.
-- This is not a model tool, a raw member read path, or Company File publication.
-- Neither the gateway's private credential nor an old lease can grant a path.
create function public.qorpera_native_company_object_actor(p_binding jsonb,p_profile_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_actor jsonb;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if p_profile_id is null or v_run.profile_id <> p_profile_id then
		raise exception 'Native object company is unavailable' using errcode = '42501'; end if;
	v_actor := public.qorpera_company_path_actor(v_run.environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	return v_actor;
end
$$;

create function public.qorpera_authorize_native_company_object_upload(
	p_binding jsonb,p_profile_id uuid,p_sha256 text,p_bytes bigint
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_bytes bigint;
begin
	v_actor := public.qorpera_native_company_object_actor(p_binding,p_profile_id);
	if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_bytes is null or p_bytes not between 0 and 8388608 then
		raise exception 'Native object identity is invalid' using errcode = '22023'; end if;
	select bytes into v_bytes from public.qorpera_profile_objects where profile_id = p_profile_id and sha256 = p_sha256;
	if found and v_bytes <> p_bytes then
		raise exception 'Native object address changed' using errcode = '23505'; end if;
	return true;
end
$$;

create function public.qorpera_confirm_native_company_object_upload(
	p_binding jsonb,p_profile_id uuid,p_sha256 text,p_bytes bigint
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
	-- Recheck after physical storage; authorization and catalog confirmation
	-- share the existing company/principal/GC transaction locks.
	perform public.qorpera_authorize_native_company_object_upload(p_binding,p_profile_id,p_sha256,p_bytes);
	perform public.qorpera_confirm_profile_object_upload(p_profile_id,p_sha256,p_bytes,'nas-object-gateway');
	return true;
end
$$;

create function public.qorpera_authorize_native_company_object_download(p_binding jsonb,p_profile_id uuid,p_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	perform public.qorpera_native_company_object_actor(p_binding,p_profile_id);
	return public.qorpera_authorize_profile_object_download(p_profile_id,p_sha256);
end
$$;

revoke all on function public.qorpera_native_company_object_actor(jsonb,uuid) from public,anon,authenticated,service_role;
revoke all on function public.qorpera_authorize_native_company_object_upload(jsonb,uuid,text,bigint),
	public.qorpera_confirm_native_company_object_upload(jsonb,uuid,text,bigint),
	public.qorpera_authorize_native_company_object_download(jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.qorpera_authorize_native_company_object_upload(jsonb,uuid,text,bigint),
	public.qorpera_confirm_native_company_object_upload(jsonb,uuid,text,bigint),
	public.qorpera_authorize_native_company_object_download(jsonb,uuid,text) to service_role;
