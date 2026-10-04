-- Company folder core C4, P34r (deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §6): the web's routine editor
-- on the folder. A member finds a routine's file, agents/<handle>/routines/<key>.md, in the state folders read, as they
-- find an agent's and a group chat's: the routine list (qorpera_list_cloud_routines) reads the index and does not say
-- where a routine's file is, and adding the path there would show it to every reader of the company, past the path's
-- authority. A read without a lock; folder-v2 only.

set local lock_timeout = '3s';

create or replace function public.qorpera_member_company_state_folders(p_environment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor jsonb := public.qorpera_member_folder_actor(p_environment_id); v_profile uuid;
begin
	-- C4 P34a (20260930021000): live rows only (a retired folder is gone), and only files the member may read.
	-- C4 P34r (20260930038000): routines' files too, by the routine index.
	perform public.qorpera_folder_read_actor(p_environment_id, v_actor);
	select file.profile_id into v_profile from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and file.core = 'folder-v2';
	return jsonb_build_object('schema', 'qorpera.member-company-state-folders/v1',
		'agents', coalesce((select jsonb_agg(jsonb_build_object('staffAgentId', staff.staff_agent_id, 'file', staff.folder_path)
				order by staff.folder_path)
			from public.qorpera_profile_staff as staff
			where staff.profile_id = v_profile and staff.folder_environment_id = p_environment_id
				and staff.folder_retired_at is null and staff.deleted_at is null
				and public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_actor, staff.folder_path, 'read')),
			'[]'::jsonb),
		'groups', coalesce((select jsonb_agg(jsonb_build_object('roomId', room.id, 'file', room.folder_path)
				order by room.folder_path)
			from public.qorpera_company_rooms as room
			where room.profile_id = v_profile and room.folder_environment_id = p_environment_id
				and room.folder_retired_at is null
				and public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_actor, room.folder_path, 'read')),
			'[]'::jsonb),
		'routines', coalesce((select jsonb_agg(jsonb_build_object('routineId', routine.id,
					'staffAgentId', routine.owner_staff_agent_id, 'file', routine.folder_path)
				order by routine.folder_path)
			from public.qorpera_cloud_routines as routine
			where routine.profile_id = v_profile and routine.folder_environment_id = p_environment_id
				and routine.folder_retired_at is null and routine.status <> 'retired'
				and public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_actor, routine.folder_path, 'read')),
			'[]'::jsonb));
end $$;

revoke all on function public.qorpera_member_company_state_folders(uuid) from public, anon, service_role;
grant execute on function public.qorpera_member_company_state_folders(uuid) to authenticated;
