set local lock_timeout = '3s';

create function public.qorpera_member_folder_may_write(p_environment_id uuid, p_path text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_writer jsonb := public.qorpera_member_folder_writer(p_environment_id);
begin
	if p_path is null or length(p_path) > 4096 or p_path !~ '^[^/]+(/[^/]+)*/?$'
			or p_path ~ '(^|/)\.\.?(/|$)' or position(E'\\' in p_path) > 0 then
		raise exception 'Path is invalid' using errcode = '22023'; end if;
	return jsonb_build_object('schema', 'qorpera.member-folder-may-write/v1', 'path', p_path,
		'write', public.qorpera_folder_member_allowed(p_environment_id, (v_writer ->> 'profileId')::uuid,
			(v_writer #>> '{actor,userId}')::uuid, rtrim(p_path, '/'), 'write'));
end $$;

revoke all on function public.qorpera_member_folder_may_write(uuid, text) from public, anon, service_role;
grant execute on function public.qorpera_member_folder_may_write(uuid, text) to authenticated;
