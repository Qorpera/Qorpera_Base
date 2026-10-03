-- Company folder core, C1c-3d-1: joins, the founding lobby and the member triggers on the folder fence
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.6).
--
-- Changes only folder-v2 behaviour; snapshot-v1 keeps every path.
-- * Joining by invitation (#581 N1): the prelude runs only for the invitee of a live invitation (its email and expiry
--   in the prelude's WHERE, as in the select that follows), so a caller the join refuses takes no folder fence. A
--   join also takes the agent thread rooms (rank 4) and their conversations (rank 11) in its prelude, before its
--   invitation and its member row, so the thread trigger finds them held.
-- * The founding lobby: `qorpera_lock_company_founding` takes the folder fence FOR NO KEY UPDATE (a seat taken or given
--   up is a member change), the company row FOR NO KEY UPDATE (the table's name is the company's; effects' KEY SHARE
--   does not wait for it) and then the founding row, in place of the company row FOR UPDATE; opening a table takes
--   the fence and the company row the same way. Removing a joined founder takes the jobs its login's revoke will end
--   first, before the fence (a prelude mode 'jobs'), as removing a member does. Taking a seat, and Start's role
--   changes, take the thread rooms and conversations as a join does, before the member rows.
-- * The member triggers, for the rows no prelude took (an account deletion, which runs no prelude, or a row that
--   appeared after the prelude read): when a departed member's login is revoked, the connection cascade takes the jobs
--   it ends FOR UPDATE NOWAIT (any other status change, a Disconnect or a switch-off, waits as before), and the thread
--   trigger takes the thread rooms and conversations NOWAIT. A row held elsewhere refuses the change as a retryable
--   conflict (QRC01, 409), never a wait behind a run or a post that may be waiting for this change's rows. Rows a
--   prelude holds are taken again at once. (The private conversations' trigger keeps its waits: an account deletion
--   of a member with a private conversation refuses anyway, its audience_user_id being ON DELETE RESTRICT, 23503.)
-- * A join and Start take the existing member rows they write before the thread rooms (rank 1 before rank 4), as a
--   removal does; a new member's row (a join's or a seat's) is an insert after them.
-- * The thread refresh skips the conversation update when its title and status do not change, so a member change
--   writes no conversation state operation (and takes no operation clock) for the agent threads.
-- Each inserted text names this migration (20260930002650), for deploy guards.

set local lock_timeout = '3s';

-- 1. Patch helper (a name unique to this migration: pg_temp lives for the whole session) ---------------------------

create function pg_temp.c1c3d1_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-3d-1 patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 2. The member change prelude: a 'jobs' mode and the join's thread rows --------------------------------------------

do $$
begin
	perform pg_temp.c1c3d1_replace('public.qorpera_folder_member_change_enter(uuid,uuid,text)',
		E'\tif p_mode is null or p_mode not in (''remove'',''role'',''join'') then\n',
		E'\t-- 20260930002650: ''jobs'' takes only the jobs a removal ends, for a caller that takes the fence itself next (the\n'
		|| E'\t-- founding lobby removing a founder).\n'
		|| E'\tif p_mode is null or p_mode not in (''remove'',''role'',''join'',''jobs'') then\n', 1);
	perform pg_temp.c1c3d1_replace('public.qorpera_folder_member_change_enter(uuid,uuid,text)',
		E'\tif p_mode = ''remove'' then\n\t\tperform 1 from public.qorpera_runner_jobs as job\n',
		E'\tif p_mode in (''remove'',''jobs'') then\n\t\tperform 1 from public.qorpera_runner_jobs as job\n', 1);
	perform pg_temp.c1c3d1_replace('public.qorpera_folder_member_change_enter(uuid,uuid,text)',
		E'\t\torder by job.id for update;\n\tend if;\n',
		E'\t\torder by job.id for update;\n\tend if;\n'
		|| E'\tif p_mode = ''jobs'' then return; end if;\n', 1);
	perform pg_temp.c1c3d1_replace('public.qorpera_folder_member_change_enter(uuid,uuid,text)',
		E'\tif p_mode = ''join'' then return; end if;\n',
		E'\t-- 20260930002650: a join takes the joiner''s member row if it exists (rank 1: an existing member accepting an\n'
		|| E'\t-- invitation updates it), then the agent thread rooms (rank 4) and their conversations (rank 11), before its\n'
		|| E'\t-- invitation or seat; the thread trigger then finds them held (its NOWAIT refuses only rows no prelude took).\n'
		|| E'\tif p_mode = ''join'' then\n'
		|| E'\t\tperform 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = p_user_id\n'
		|| E'\t\t\tfor no key update;\n'
		|| E'\t\tperform 1 from public.qorpera_company_rooms where profile_id = p_profile_id and bound_staff_agent_id is not null\n'
		|| E'\t\t\torder by id for update;\n'
		|| E'\t\tperform 1 from public.qorpera_shared_sessions as session where session.profile_id = p_profile_id\n'
		|| E'\t\t\tand session.id in (select room.session_id from public.qorpera_company_rooms as room\n'
		|| E'\t\t\t\twhere room.profile_id = p_profile_id and room.bound_staff_agent_id is not null)\n'
		|| E'\t\torder by session.id for update;\n'
		|| E'\t\treturn;\n'
		|| E'\tend if;\n', 1);
end $$;

-- 3. Joining by invitation: only the invitee of a live invitation takes the fence (#581 N1) -------------------------

do $$
begin
	perform pg_temp.c1c3d1_replace('public.qorpera_accept_profile_invitation(uuid)',
		E'\tperform public.qorpera_folder_member_change_enter(invitation.profile_id, v_user_id, ''join'')\n'
		|| E'\tfrom public.qorpera_profile_invitations as invitation\n'
		|| E'\twhere invitation.id = p_invitation_id and public.qorpera_company_is_folder_v2(invitation.profile_id);\n',
		E'\t-- 20260930002650: only the invitee of a live invitation (the select below refuses anyone else) takes the fence.\n'
		|| E'\tperform public.qorpera_folder_member_change_enter(invitation.profile_id, v_user_id, ''join'')\n'
		|| E'\tfrom public.qorpera_profile_invitations as invitation\n'
		|| E'\twhere invitation.id = p_invitation_id and invitation.email = v_email and invitation.expires_at > statement_timestamp()\n'
		|| E'\t\tand public.qorpera_company_is_folder_v2(invitation.profile_id);\n', 1);
end $$;

-- 4. The founding lobby on the fence -----------------------------------------------------------------------------------

do $$
begin
	-- Every lobby function: the fence and the company row FOR NO KEY UPDATE, then the founding row (as before).
	perform pg_temp.c1c3d1_replace('public.qorpera_lock_company_founding(uuid)',
		E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n',
		E'\t-- 20260930002650: on folder-v2 the folder fence FOR NO KEY UPDATE, where member changes serialize (a seat taken or\n'
		|| E'\t-- given up is one), then the company row FOR NO KEY UPDATE (the table''s name is the company''s), not FOR UPDATE.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\tperform 1 from public.qorpera_folder_fences where profile_id = p_profile_id for no key update;\n'
		|| E'\t\tif not found then raise exception ''Company folder is unavailable'' using errcode = ''42501''; end if;\n'
		|| E'\t\tperform 1 from public.qorpera_profiles where id = p_profile_id for no key update;\n'
		|| E'\telse\n'
		|| E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'
		|| E'\tend if;\n', 1);
	-- Opening a table (or its repeat): the same two locks.
	perform pg_temp.c1c3d1_replace('public.qorpera_open_company_founding(uuid,text)',
		E'\tperform 1 from public.qorpera_profiles where id = v_profile for update;\n',
		E'\t-- 20260930002650: on folder-v2 the folder fence and the company row FOR NO KEY UPDATE, as every lobby function.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(v_profile) then\n'
		|| E'\t\tperform 1 from public.qorpera_folder_fences where profile_id = v_profile for no key update;\n'
		|| E'\t\tif not found then raise exception ''Company folder is unavailable'' using errcode = ''42501''; end if;\n'
		|| E'\t\tperform 1 from public.qorpera_profiles where id = v_profile for no key update;\n'
		|| E'\telse\n'
		|| E'\tperform 1 from public.qorpera_profiles where id = v_profile for update;\n'
		|| E'\tend if;\n', 1);
	-- Removing a joined founder: the jobs its login's revoke will end first, before the fence (core §3 step 2), for a
	-- caller the checks under the lock let through (read here without a lock).
	perform pg_temp.c1c3d1_replace('public.qorpera_remove_company_founder(uuid,uuid)',
		E'\tv_f := public.qorpera_lock_company_founding(p_profile_id);\n',
		E'\t-- 20260930002650: on folder-v2 the jobs a joined founder''s removal ends, before the fence, as removing a member.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) and public.qorpera_company_founding_seated(p_profile_id)\n'
		|| E'\t\tand exists (select 1 from public.qorpera_company_founder_seats as seat\n'
		|| E'\t\t\tjoin public.qorpera_company_foundings as founding on founding.profile_id = seat.profile_id\n'
		|| E'\t\t\twhere seat.profile_id = p_profile_id and seat.user_id = p_user_id and seat.state = ''joined''\n'
		|| E'\t\t\t\tand founding.phase = ''open'' and p_user_id <> founding.created_by_user_id\n'
		|| E'\t\t\t\tand (p_user_id = auth.uid() or auth.uid() = founding.created_by_user_id)) then\n'
		|| E'\t\tperform public.qorpera_folder_member_change_enter(p_profile_id, p_user_id, ''jobs'');\n'
		|| E'\tend if;\n'
		|| E'\tv_f := public.qorpera_lock_company_founding(p_profile_id);\n', 1);
	-- Start makes every founder at the table an owner: the thread rooms and conversations first, as a join takes them.
	perform pg_temp.c1c3d1_replace('public.qorpera_start_company_founding(uuid,bigint,uuid)',
		E'\tupdate public.qorpera_profile_members member set role = ''owner'' where member.profile_id = p_profile_id\n',
		E'\t-- 20260930002650: on folder-v2 the member rows the role changes write (and the starter''s) in key order (rank 1),\n'
		|| E'\t-- then the thread rooms and their conversations as a join takes them (the fence and the company row are held), so\n'
		|| E'\t-- the role changes'' thread trigger finds them held.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\tperform 1 from public.qorpera_profile_members as member where member.profile_id = p_profile_id\n'
		|| E'\t\t\tand (member.user_id = auth.uid() or (member.role <> ''owner'' and exists (\n'
		|| E'\t\t\t\tselect 1 from public.qorpera_company_founder_seats as seat where seat.profile_id = member.profile_id\n'
		|| E'\t\t\t\t\tand seat.user_id = member.user_id and seat.state = ''joined'')))\n'
		|| E'\t\torder by member.user_id for no key update;\n'
		|| E'\t\tperform public.qorpera_folder_member_change_enter(p_profile_id, auth.uid(), ''join'');\n'
		|| E'\tend if;\n'
		|| E'\tupdate public.qorpera_profile_members member set role = ''owner'' where member.profile_id = p_profile_id\n', 1);
	-- Taking a seat: the thread rooms and their conversations, as a join takes them, before the member row.
	perform pg_temp.c1c3d1_replace('public.qorpera_respond_company_founding(uuid,boolean)',
		E'\tinsert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)\n',
		E'\t-- 20260930002650: on folder-v2 the thread rooms and their conversations, as a join takes them (the fence and the\n'
		|| E'\t-- company row are held).\n'
		|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_member_change_enter(p_profile_id, auth.uid(), ''join'');\n'
		|| E'\tend if;\n'
		|| E'\tinsert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)\n', 1);
end $$;

-- 5. The member triggers: NOWAIT for rows no prelude took ------------------------------------------------------------

do $$
begin
	-- The connection cascade, revoking a departed member's login: the jobs it ends.
	perform pg_temp.c1c3d1_replace('public.qorpera_cascade_provider_connection_unavailability()',
		E'\tif old.status = new.status or new.status = ''active'' then return new; end if;\n',
		E'\tif old.status = new.status or new.status = ''active'' then return new; end if;\n'
		|| E'\t-- 20260930002650: on folder-v2, when the login''s owner is no longer a member (its departure, earlier in this\n'
		|| E'\t-- transaction), the jobs to end FOR UPDATE NOWAIT first, in id order. The departure''s prelude holds them already;\n'
		|| E'\t-- one it did not take (queued after its read) and held elsewhere refuses the change as a retryable conflict, never\n'
		|| E'\t-- a wait behind a run that may wait for this change''s rows. Any other status change (a Disconnect, a switch-off)\n'
		|| E'\t-- waits for the job as before.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(new.profile_id) and new.owner_user_id is not null\n'
		|| E'\t\tand not exists (select 1 from public.qorpera_profile_members as member\n'
		|| E'\t\t\twhere member.profile_id = new.profile_id and member.user_id = new.owner_user_id) then\n'
		|| E'\t\tbegin\n'
		|| E'\t\t\tperform 1 from public.qorpera_runner_jobs as job\n'
		|| E'\t\t\twhere job.id in (select run.job_id from public.qorpera_execution_runs as run\n'
		|| E'\t\t\t\tjoin public.qorpera_execution_sponsor_versions as sponsor\n'
		|| E'\t\t\t\t\ton sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version\n'
		|| E'\t\t\t\twhere sponsor.provider_connection_id = new.id) and job.status in (''queued'', ''leased'')\n'
		|| E'\t\t\torder by job.id for update nowait;\n'
		|| E'\t\texception when lock_not_available then\n'
		|| E'\t\t\traise sqlstate ''PGRST'' using message = jsonb_build_object(''code'', ''QRC01'', ''message'',\n'
		|| E'\t\t\t\t''A run this login pays for is busy; try again'', ''details'', null, ''hint'', null)::text,\n'
		|| E'\t\t\t\tdetail = ''{"status":409,"headers":{}}'';\n'
		|| E'\t\tend;\n'
		|| E'\tend if;\n', 1);

	-- The thread trigger's locks (folder-v2 only): the thread rooms, then their conversations, NOWAIT.
	perform pg_temp.c1c3d1_replace('public.qorpera_folder_lock_agent_threads(uuid)',
		E'begin\n'
		|| E'\tperform 1 from public.qorpera_company_rooms where profile_id = p_profile_id and bound_staff_agent_id is not null\n'
		|| E'\t\torder by id for update;\n'
		|| E'\tperform 1 from public.qorpera_shared_sessions where id in (select session_id from public.qorpera_company_rooms\n'
		|| E'\t\twhere profile_id = p_profile_id and bound_staff_agent_id is not null) order by id for update;\n'
		|| E'end',
		E'begin\n'
		|| E'\t-- 20260930002650: NOWAIT. A member change''s prelude holds these rows already; a row it did not take (an account\n'
		|| E'\t-- deletion runs no prelude) and held elsewhere refuses the change as a retryable conflict.\n'
		|| E'\tperform 1 from public.qorpera_company_rooms where profile_id = p_profile_id and bound_staff_agent_id is not null\n'
		|| E'\t\torder by id for update nowait;\n'
		|| E'\tperform 1 from public.qorpera_shared_sessions where id in (select session_id from public.qorpera_company_rooms\n'
		|| E'\t\twhere profile_id = p_profile_id and bound_staff_agent_id is not null) order by id for update nowait;\n'
		|| E'exception when lock_not_available then\n'
		|| E'\traise sqlstate ''PGRST'' using message = jsonb_build_object(''code'', ''QRC01'', ''message'',\n'
		|| E'\t\t''An agent thread is busy; try again'', ''details'', null, ''hint'', null)::text,\n'
		|| E'\t\tdetail = ''{"status":409,"headers":{}}'';\n'
		|| E'end', 1);

	-- The thread refresh: no conversation update (and no state operation) when its title and status stay.
	perform pg_temp.c1c3d1_replace('public.qorpera_ensure_agent_thread_internal(uuid,uuid,uuid,uuid)',
		E'\t\t\ttitle = v_staff.display_name, updated_at = statement_timestamp() where id = v_session;\n',
		E'\t\t\ttitle = v_staff.display_name, updated_at = statement_timestamp() where id = v_session\n'
		|| E'\t\t\t-- 20260930002650: on folder-v2 only when the title or the status changes.\n'
		|| E'\t\t\tand (not public.qorpera_company_is_folder_v2(p_profile_id)\n'
		|| E'\t\t\t\tor status is distinct from (case when v_active then ''open'' else ''closed'' end)::public.qorpera_session_status\n'
		|| E'\t\t\t\tor title is distinct from v_staff.display_name);\n', 1);
end $$;
