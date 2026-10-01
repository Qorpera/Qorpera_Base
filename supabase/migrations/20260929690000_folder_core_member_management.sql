-- Company folder core, C1c-3c: member management on the folder fence (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md
-- §6.1 and §6.4).
--
-- Changes only folder-v2 behaviour; snapshot-v1 keeps every path. On folder-v2 member changes no longer take the
-- company row FOR UPDATE:
-- * qorpera_folder_member_change_enter(profile, member, mode): the prelude of a member change, in core §3's order. A
--   removal first takes the jobs its connection revoke will end (FOR UPDATE, lease-ending), then every member change
--   serializes on the folder fence FOR NO KEY UPDATE (effects hold it KEY SHARE, which that mode does not block), then
--   the company row KEY SHARE (rank 0), an open founding table's row, the member rows (rank 1), the agent thread rooms
--   (rank 4), the member's compute identities and connections (rank 5), its vault rows (rank 8) and the conversations
--   the change writes (rank 11). The delete or update that follows finds each row its triggers write already held.
-- * Removing a member, leaving and a role change take that prelude in place of the company row FOR UPDATE.
-- * The founder guard takes the company row KEY SHARE on folder-v2: the fence FOR NO KEY UPDATE serializes the
--   departures it compares.
-- * Joining by invitation takes the fence FOR NO KEY UPDATE and the company row before the invitation, so a join
--   meets a departure (and deletion's stop, which removes invitations) at the fence.
-- * A save that hires a new agent names every member row KEY SHARE at rank 1 (F2's hook): the new agent's thread copies
--   the roster, and a removal or a demotion (the member row FOR UPDATE) now runs before or after that copy, not
--   beside it.

-- 1. Patch helper (a name unique to this migration: pg_temp lives for the whole session) ---------------------------

create function pg_temp.c1c3c_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-3c patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 2. The prelude of a member change -------------------------------------------------------------------------------

-- p_mode: 'remove' (removing a member, or leaving), 'role' (a role change) or 'join' (the fence and rank 0 only; the
-- join's own statements then take the invitation, the new member row and, in the thread trigger, the rooms and their
-- conversations, in that order). Locks only; the callers keep their checks and messages.
create function public.qorpera_folder_member_change_enter(p_profile_id uuid, p_user_id uuid, p_mode text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_role public.qorpera_profile_role; v_user uuid;
begin
	if p_mode is null or p_mode not in ('remove','role','join') then
		raise exception 'Member change mode is invalid' using errcode = 'XX000'; end if;
	if not public.qorpera_company_is_folder_v2(p_profile_id) then
		raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	-- The jobs the connection revoke will end, lease-ending, before the fence (core §3 step 2): a run of the member's
	-- holds its job and then asks for the member row, so the job comes first.
	if p_mode = 'remove' then
		perform 1 from public.qorpera_runner_jobs as job
		where job.id in (select job2.id from public.qorpera_runner_jobs as job2
			join public.qorpera_execution_runs as run on run.job_id = job2.id
			join public.qorpera_execution_sponsor_versions as sponsor
				on sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version
			join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
			where job2.profile_id = p_profile_id and job2.status in ('queued','leased')
				and connection.profile_id = p_profile_id and connection.owner_user_id = p_user_id and connection.status <> 'revoked')
		order by job.id for update;
	end if;
	-- Member changes serialize here; effects (KEY SHARE) go on beside them; stop and resume (FOR UPDATE) wait.
	perform 1 from public.qorpera_folder_fences where profile_id = p_profile_id for no key update;
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for key share;
	if p_mode = 'join' then return; end if;
	-- An open founding table's row, which a departure updates (before the members, as the founding lobby orders it).
	if p_mode = 'remove' then
		perform 1 from public.qorpera_company_foundings where profile_id = p_profile_id for no key update;
	end if;
	-- Rank 1 in key order: the member FOR UPDATE; when the member is a founder, the other founders KEY SHARE (the guard's
	-- reads). Read under the fence, so the founders cannot change meanwhile.
	select role into v_role from public.qorpera_profile_members where profile_id = p_profile_id and user_id = p_user_id;
	-- Not a member: the caller refuses next (P0002), so nothing more needs holding.
	if not found then return; end if;
	for v_user in select member.user_id from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and (member.user_id = p_user_id or (v_role = 'owner' and member.role = 'owner'))
		order by member.user_id loop
		if v_user = p_user_id then
			perform 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = v_user for update;
		else
			perform 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = v_user for key share;
		end if;
	end loop;
	-- Rank 4: the agent thread rooms, which the thread trigger rewrites (their room members go with them).
	perform 1 from public.qorpera_company_rooms where profile_id = p_profile_id and bound_staff_agent_id is not null
		order by id for update;
	if p_mode = 'remove' then
		-- Rank 5: the member's compute identities and connections (retired and revoked by the triggers).
		perform 1 from public.qorpera_member_compute_identities where profile_id = p_profile_id and ownership_kind = 'member'
			and owner_user_id = p_user_id and status <> 'retired' order by id for no key update;
		perform 1 from public.qorpera_provider_connections where profile_id = p_profile_id and owner_user_id = p_user_id
			and status <> 'revoked' order by id for no key update;
	end if;
	-- Rank 8: the vault rows the triggers revoke: the member's pending capture tickets, the grants on its own secrets
	-- and the grants it issued, and its own secrets.
	perform 1 from public.qorpera_cloud_secret_capture_tickets where profile_id = p_profile_id and created_by_user_id = p_user_id
		and status = 'pending' order by id for no key update;
	perform 1 from public.qorpera_cloud_secret_operation_grants as grant_row
	where grant_row.profile_id = p_profile_id and grant_row.status = 'active' and (grant_row.issued_by_user_id = p_user_id
		or (p_mode = 'remove' and grant_row.secret_id in (select secret.id from public.qorpera_cloud_secrets as secret
			where secret.profile_id = p_profile_id and secret.owner_kind = 'member' and secret.owner_user_id = p_user_id)))
	order by grant_row.id for no key update;
	if p_mode = 'remove' then
		perform 1 from public.qorpera_cloud_secrets where profile_id = p_profile_id and owner_kind = 'member'
			and owner_user_id = p_user_id and status = 'active' order by id for no key update;
	end if;
	-- Rank 11: the conversations the change writes, in id order: the agent threads (the thread trigger) and, for a
	-- removal, the member's open private conversations (closed by their trigger).
	perform 1 from public.qorpera_shared_sessions as session
	where session.profile_id = p_profile_id and (session.id in (select room.session_id from public.qorpera_company_rooms as room
			where room.profile_id = p_profile_id and room.bound_staff_agent_id is not null)
		or (p_mode = 'remove' and session.audience_kind = 'member_private' and session.audience_user_id = p_user_id
			and session.status = 'open'))
	order by session.id for update;
end $$;

-- 3. Patches ------------------------------------------------------------------------------------------------------------

do $$
begin
	-- Removing a member, leaving and a role change: the prelude in place of the company row FOR UPDATE.
	perform pg_temp.c1c3c_replace('public.qorpera_remove_profile_member(uuid,uuid)',
		E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n',
		E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_member_change_enter(p_profile_id, p_member_user_id, ''remove'');\n'
		|| E'\telse\n'
		|| E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3c_replace('public.qorpera_leave_hosted_profile(uuid)',
		E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n',
		E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_member_change_enter(p_profile_id, v_actor_id, ''remove'');\n'
		|| E'\telse\n'
		|| E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3c_replace('public.qorpera_update_profile_member_role(uuid,uuid,qorpera_profile_role)',
		E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n',
		E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_member_change_enter(p_profile_id, p_member_user_id, ''role'');\n'
		|| E'\telse\n'
		|| E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'
		|| E'\tend if;\n', 1);

	-- The founder guard: on folder-v2 the company row KEY SHARE, for its "being deleted" check; the member change's fence
	-- FOR NO KEY UPDATE serializes the departures it compares.
	perform pg_temp.c1c3c_replace('public.qorpera_guard_founder_departure()',
		E'\tperform 1 from public.qorpera_profiles where id = old.profile_id for update;\n',
		E'\tif public.qorpera_company_is_folder_v2(old.profile_id) then\n'
		|| E'\t\tperform 1 from public.qorpera_profiles where id = old.profile_id for key share;\n'
		|| E'\telse\n'
		|| E'\tperform 1 from public.qorpera_profiles where id = old.profile_id for update;\n'
		|| E'\tend if;\n', 1);

	-- Joining by invitation: the fence FOR NO KEY UPDATE and the company row before the invitation row.
	perform pg_temp.c1c3c_replace('public.qorpera_accept_profile_invitation(uuid)',
		E'\tselect invitation.* into v_invitation\n',
		E'\tperform public.qorpera_folder_member_change_enter(invitation.profile_id, v_user_id, ''join'')\n'
		|| E'\tfrom public.qorpera_profile_invitations as invitation\n'
		|| E'\twhere invitation.id = p_invitation_id and public.qorpera_company_is_folder_v2(invitation.profile_id);\n'
		|| E'\tselect invitation.* into v_invitation\n', 1);

	-- F2's hook: a save that creates an agent's staff row names every member row KEY SHARE at rank 1, since the new
	-- agent's thread copies the roster (qorpera_ensure_agent_thread_internal reads it without a lock). A rename or a
	-- status change already names the agent's thread room at rank 4, where a member change meets it.
	perform pg_temp.c1c3c_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)',
		E'\tv_profile uuid; v_unit jsonb; v_op text; v_key text; v_entry jsonb; v_staff record; v_room uuid; v_routine uuid;\n',
		E'\tv_profile uuid; v_unit jsonb; v_op text; v_key text; v_entry jsonb; v_staff record; v_room uuid; v_routine uuid;\n'
		|| E'\tv_member uuid;\n', 1);
	perform pg_temp.c1c3c_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)',
		E'\t\t\t\tif found and (v_staff.display_name is distinct from v_entry -> ''parse'' ->> ''name''\n',
		E'\t\t\t\tif not found then\n'
		|| E'\t\t\t\t\tfor v_member in select m.user_id from public.qorpera_profile_members m where m.profile_id = v_profile loop\n'
		|| E'\t\t\t\t\t\trank := 1; tbl := ''qorpera_profile_members''; key := v_profile::text || '':'' || v_member::text; mode := ''keyshare'';\n'
		|| E'\t\t\t\t\t\treturn next;\n'
		|| E'\t\t\t\t\tend loop;\n'
		|| E'\t\t\t\telsif (v_staff.display_name is distinct from v_entry -> ''parse'' ->> ''name''\n', 1);
end $$;

-- 4. Privileges ------------------------------------------------------------------------------------------------------

-- Internal: reached only through the member functions.
revoke all on function public.qorpera_folder_member_change_enter(uuid, uuid, text) from public, anon, authenticated, service_role;
