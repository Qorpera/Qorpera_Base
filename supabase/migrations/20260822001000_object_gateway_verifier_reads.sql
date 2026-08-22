-- Allow the trusted NAS object gateway to resolve catalog-backed downloads for
-- the Company File verifier without impersonating a member. Physical bytes
-- remain behind a separate gateway verifier token; this RPC exposes only the
-- immutable backend and byte-length authority already held by Supabase.

create or replace function public.qorpera_authorize_profile_object_download(
	p_profile_id uuid,
	p_sha256 text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_object public.qorpera_profile_objects%rowtype;
	v_role text := coalesce(auth.role(), '');
begin
	if p_sha256 !~ '^[0-9a-f]{64}$'
		or v_role not in ('authenticated', 'service_role') then
		raise exception 'object download authority is invalid' using errcode = '22023';
	end if;
	if v_role = 'authenticated'
		and (auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id)) then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;
	select object.* into v_object
	from public.qorpera_profile_objects as object
	where object.profile_id = p_profile_id and object.sha256 = p_sha256;
	if not found then
		raise exception 'profile object is unavailable' using errcode = '55000';
	end if;
	return jsonb_build_object('backend', v_object.backend, 'bytes', v_object.bytes);
end
$$;

revoke all on function public.qorpera_authorize_profile_object_download(uuid, text) from public, anon;
grant execute on function public.qorpera_authorize_profile_object_download(uuid, text) to authenticated, service_role;
