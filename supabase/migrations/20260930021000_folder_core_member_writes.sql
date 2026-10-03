-- Company folder core C4, P34a (deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §5): member writes for the
-- web's editors. Two reads for members, both without a lock:
-- 1. the writer check the object gateway calls with the member's own token, which answers the member's actor; the
--    gateway then stages and commits as that actor with the service key, and the core checks each path as for any
--    member;
-- 2. the files of the live agents and group chats a member may read, so the web finds an id's folder without reading
--    every agent.md.
-- Folder-v2 only. A member's save under human-tasks/ waits for P31 (H2c): the gateway's route refuses it.

set local lock_timeout = '3s';

-- 1. The writer check ---------------------------------------------------------------------------------------------

create function public.qorpera_member_folder_writer(p_environment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor jsonb := public.qorpera_member_folder_actor(p_environment_id); v_profile uuid;
begin
	-- C4 P34a (20260930021000): a member of a folder-v2 company (42501 otherwise), not being deleted and not paused
	-- (55000). Staging refuses a paused company for every actor while the commit does not, so the check refuses it for
	-- every member write alike; members still read while paused.
	perform public.qorpera_folder_read_actor(p_environment_id, v_actor);
	select file.profile_id into v_profile from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and file.core = 'folder-v2';
	if exists (select 1 from public.qorpera_company_execution_pauses as pause where pause.profile_id = v_profile) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	return jsonb_build_object('schema', 'qorpera.member-folder-writer/v1', 'actor', v_actor, 'profileId', v_profile);
end $$;

-- 2. The agents' and group chats' files --------------------------------------------------------------------------

create function public.qorpera_member_company_state_folders(p_environment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor jsonb := public.qorpera_member_folder_actor(p_environment_id); v_profile uuid;
begin
	-- C4 P34a (20260930021000): live rows only (a retired folder is gone), and only files the member may read.
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
			'[]'::jsonb));
end $$;

revoke all on function public.qorpera_member_folder_writer(uuid) from public, anon, service_role;
revoke all on function public.qorpera_member_company_state_folders(uuid) from public, anon, service_role;
grant execute on function public.qorpera_member_folder_writer(uuid) to authenticated;
grant execute on function public.qorpera_member_company_state_folders(uuid) to authenticated;
