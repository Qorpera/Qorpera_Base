set local lock_timeout = '3s';

create function public.qorpera_member_folder_may_write(p_environment_id uuid, p_path text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_writer jsonb := public.qorpera_member_folder_writer(p_environment_id); v_path text;
begin
	v_path := case when right(p_path, 1) = '/' then left(p_path, -1) else p_path end;
	if v_path is null or not public.qorpera_company_path_valid(v_path) then
		raise exception 'Path is invalid' using errcode = '22023'; end if;
	return jsonb_build_object('schema', 'qorpera.member-folder-may-write/v1', 'path', p_path,
		'write', not public.qorpera_folder_path_reserved(public.qorpera_folder_key(v_path))
			and public.qorpera_folder_member_allowed(p_environment_id, (v_writer ->> 'profileId')::uuid,
				(v_writer #>> '{actor,userId}')::uuid, v_path, 'write'));
end $$;

revoke all on function public.qorpera_member_folder_may_write(uuid, text) from public, anon, service_role;
grant execute on function public.qorpera_member_folder_may_write(uuid, text) to authenticated;
