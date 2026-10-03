-- @fixture 664_folder_core_member_management.test.sql until "-- 1. Snapshot-v1 keeps its text"
-- Company folder core, C1c-3d-1 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.5): joins, the founding lobby and
-- the member triggers on the folder fence. A join refuses a caller who is not the invitee of a live invitation; a join
-- and a role change refresh the agent threads without a conversation state operation, unless a title or a status
-- changes; the founding lobby opens, edits, seats and removes founders on folder-v2 (a removed founder's own login and
-- the run it pays for end); an account deletion of a folder-v2 member. Snapshot-v1 keeps its text. Races are in 818.

-- Conversation state operations written for this company.
create function pg_temp.state_ops() returns bigint language sql as $$
	select count(*) from public.qorpera_company_operations where profile_id = '63400000-0000-4000-8000-000000000010'
		and operation_type = 'session_state'
$$;
create function pg_temp.in_thread(p_agent uuid, p_user uuid) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_company_room_members m join public.qorpera_company_rooms r on r.id = m.room_id
		where r.profile_id = '63400000-0000-4000-8000-000000000010' and r.bound_staff_agent_id = p_agent
			and m.principal_kind = 'member' and m.principal_id = p_user and m.status = 'active')
$$;
create function pg_temp.as_verified(p_user uuid) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user,
		'email', (select email from auth.users where id = p_user))::text, true)::text::void
$$;
create function pg_temp.revision() returns bigint language sql as $$
	select revision from public.qorpera_company_foundings where profile_id = '63400000-0000-4000-8000-000000000010'
$$;

-- 1. Snapshot-v1 keeps its text: each body with its patch reversed is the definition before this migration.
do $$
declare v_case record;
begin
	for v_case in select * from (values
		('public.qorpera_accept_profile_invitation(uuid)',
			E'\t-- 20260930000200: only the invitee of a live invitation (the select below refuses anyone else) takes the fence.\n'
			|| E'\tperform public.qorpera_folder_member_change_enter(invitation.profile_id, v_user_id, ''join'')\n'
			|| E'\tfrom public.qorpera_profile_invitations as invitation\n'
			|| E'\twhere invitation.id = p_invitation_id and invitation.email = v_email and invitation.expires_at > statement_timestamp()\n'
			|| E'\t\tand public.qorpera_company_is_folder_v2(invitation.profile_id);\n',
			E'\tperform public.qorpera_folder_member_change_enter(invitation.profile_id, v_user_id, ''join'')\n'
			|| E'\tfrom public.qorpera_profile_invitations as invitation\n'
			|| E'\twhere invitation.id = p_invitation_id and public.qorpera_company_is_folder_v2(invitation.profile_id);\n',
			'2781f8337546c41056325c9c97768a62'),
		('public.qorpera_lock_company_founding(uuid)',
			E'\t-- 20260930000200: on folder-v2 the folder fence FOR NO KEY UPDATE, where member changes serialize (a seat taken or\n'
			|| E'\t-- given up is one), then the company row FOR NO KEY UPDATE (the table''s name is the company''s), not FOR UPDATE.\n'
			|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
			|| E'\t\tperform 1 from public.qorpera_folder_fences where profile_id = p_profile_id for no key update;\n'
			|| E'\t\tif not found then raise exception ''Company folder is unavailable'' using errcode = ''42501''; end if;\n'
			|| E'\t\tperform 1 from public.qorpera_profiles where id = p_profile_id for no key update;\n'
			|| E'\telse\n'
			|| E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'
			|| E'\tend if;\n',
			E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n',
			'62c4c7f019cd60d8c7ea805e9f802e8f'),
		('public.qorpera_open_company_founding(uuid,text)',
			E'\t-- 20260930000200: on folder-v2 the folder fence and the company row FOR NO KEY UPDATE, as every lobby function.\n'
			|| E'\tif public.qorpera_company_is_folder_v2(v_profile) then\n'
			|| E'\t\tperform 1 from public.qorpera_folder_fences where profile_id = v_profile for no key update;\n'
			|| E'\t\tif not found then raise exception ''Company folder is unavailable'' using errcode = ''42501''; end if;\n'
			|| E'\t\tperform 1 from public.qorpera_profiles where id = v_profile for no key update;\n'
			|| E'\telse\n'
			|| E'\tperform 1 from public.qorpera_profiles where id = v_profile for update;\n'
			|| E'\tend if;\n',
			E'\tperform 1 from public.qorpera_profiles where id = v_profile for update;\n',
			'64b237af494e3f7534b351ae407d2c89'),
		('public.qorpera_remove_company_founder(uuid,uuid)',
			E'\t-- 20260930000200: on folder-v2 the jobs a joined founder''s removal ends, before the fence, as removing a member.\n'
			|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) and public.qorpera_company_founding_seated(p_profile_id)\n'
			|| E'\t\tand exists (select 1 from public.qorpera_company_founder_seats as seat\n'
			|| E'\t\t\tjoin public.qorpera_company_foundings as founding on founding.profile_id = seat.profile_id\n'
			|| E'\t\t\twhere seat.profile_id = p_profile_id and seat.user_id = p_user_id and seat.state = ''joined''\n'
			|| E'\t\t\t\tand founding.phase = ''open'' and p_user_id <> founding.created_by_user_id\n'
			|| E'\t\t\t\tand (p_user_id = auth.uid() or auth.uid() = founding.created_by_user_id)) then\n'
			|| E'\t\tperform public.qorpera_folder_member_change_enter(p_profile_id, p_user_id, ''jobs'');\n'
			|| E'\tend if;\n',
			'', '385f016d9ec6092c8db78b60f2ea07c9'),
		('public.qorpera_respond_company_founding(uuid,boolean)',
			E'\t-- 20260930000200: on folder-v2 the thread rooms and their conversations, as a join takes them (the fence and the\n'
			|| E'\t-- company row are held).\n'
			|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
			|| E'\t\tperform public.qorpera_folder_member_change_enter(p_profile_id, auth.uid(), ''join'');\n'
			|| E'\tend if;\n',
			'', '62a7f1c3c331e04950e2b91de40eb687'),
		('public.qorpera_start_company_founding(uuid,bigint,uuid)',
			E'\t-- 20260930000200: on folder-v2 the member rows the role changes write (and the starter''s) in key order (rank 1),\n'
			|| E'\t-- then the thread rooms and their conversations as a join takes them (the fence and the company row are held), so\n'
			|| E'\t-- the role changes'' thread trigger finds them held.\n'
			|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
			|| E'\t\tperform 1 from public.qorpera_profile_members as member where member.profile_id = p_profile_id\n'
			|| E'\t\t\tand (member.user_id = auth.uid() or (member.role <> ''owner'' and exists (\n'
			|| E'\t\t\t\tselect 1 from public.qorpera_company_founder_seats as seat where seat.profile_id = member.profile_id\n'
			|| E'\t\t\t\t\tand seat.user_id = member.user_id and seat.state = ''joined'')))\n'
			|| E'\t\torder by member.user_id for no key update;\n'
			|| E'\t\tperform public.qorpera_folder_member_change_enter(p_profile_id, auth.uid(), ''join'');\n'
			|| E'\tend if;\n',
			'', '62d1d515ee29b8fed2a8644c3dd67342'),
		('public.qorpera_cascade_provider_connection_unavailability()',
			E'\t-- 20260930000200: on folder-v2, when the login''s owner is no longer a member (its departure, earlier in this\n'
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
			|| E'\tend if;\n',
			'', 'a3b048c5422327546ff8de56a189b359'),
		('public.qorpera_ensure_agent_thread_internal(uuid,uuid,uuid,uuid)',
			E' where id = v_session\n'
			|| E'\t\t\t-- 20260930000200: on folder-v2 only when the title or the status changes.\n'
			|| E'\t\t\tand (not public.qorpera_company_is_folder_v2(p_profile_id)\n'
			|| E'\t\t\t\tor status is distinct from (case when v_active then ''open'' else ''closed'' end)::public.qorpera_session_status\n'
			|| E'\t\t\t\tor title is distinct from v_staff.display_name);\n',
			E' where id = v_session;\n', 'c49cd98d167b85ffcab0dafbb7b56388')) c(fn, patched, original, digest) loop
		if position(v_case.patched in pg_get_functiondef(v_case.fn::regprocedure)) = 0
			or md5(replace(pg_get_functiondef(v_case.fn::regprocedure), v_case.patched, v_case.original)) <> v_case.digest then
			raise exception 'The snapshot-v1 text of % changed', v_case.fn; end if;
	end loop;
end $$;

-- 2. Joining by invitation: someone else than the invitee, and the invitee of an expired invitation, are refused (and,
-- 818 A, take no fence). The invitee joins and is in the agents' threads; neither the join nor a role change writes a
-- conversation state operation for the threads, whose title and status stay.
insert into auth.users(id, email, email_confirmed_at) values
	('81700000-0000-4000-8000-000000000006', 'joiner@example.test', clock_timestamp()),
	('81700000-0000-4000-8000-000000000007', 'stranger@example.test', clock_timestamp());
insert into public.qorpera_profile_invitations(id, profile_id, email, role, invited_by_user_id, created_at, expires_at) values
	('81700000-0000-4000-8000-0000000000e1', '63400000-0000-4000-8000-000000000010', 'joiner@example.test', 'contributor',
		'63400000-0000-4000-8000-000000000001', clock_timestamp(), clock_timestamp() + interval '1 day'),
	('81700000-0000-4000-8000-0000000000e2', '63400000-0000-4000-8000-000000000010', 'stranger@example.test', 'contributor',
		'63400000-0000-4000-8000-000000000001', clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day');
do $$
declare v_ops bigint := pg_temp.state_ops();
begin
	perform pg_temp.as_verified('81700000-0000-4000-8000-000000000007');
	perform pg_temp.raises_like($q$select public.qorpera_accept_profile_invitation('81700000-0000-4000-8000-0000000000e1')$q$, 'P0002',
		'profile invitation was not found');
	perform pg_temp.raises_like($q$select public.qorpera_accept_profile_invitation('81700000-0000-4000-8000-0000000000e2')$q$, 'P0002',
		'profile invitation was not found');
	perform pg_temp.as_verified('81700000-0000-4000-8000-000000000006');
	if public.qorpera_accept_profile_invitation('81700000-0000-4000-8000-0000000000e1') <> 'true'::jsonb then
		raise exception 'The invitee''s join must return true'; end if;
	perform pg_temp.path_claims('service_role');
	if not pg_temp.in_thread('63400000-0000-4000-8000-0000000000a1', '81700000-0000-4000-8000-000000000006')
		or not pg_temp.in_thread('63400000-0000-4000-8000-0000000000a2', '81700000-0000-4000-8000-000000000006') then
		raise exception 'The joiner must be in both agents'' threads'; end if;
	if pg_temp.state_ops() <> v_ops then raise exception 'A join must write no conversation state operation for the threads'; end if;
	perform pg_temp.as_member('63400000-0000-4000-8000-000000000001');
	perform public.qorpera_update_profile_member_role('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000002', 'viewer');
	perform pg_temp.path_claims('service_role');
	if pg_temp.in_thread('63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-000000000002') then
		raise exception 'A viewer must leave the agents'' threads'; end if;
	if pg_temp.state_ops() <> v_ops then raise exception 'A role change must write no conversation state operation for the threads'; end if;
end $$;

-- 3. A thread whose title or status changed is still refreshed by a member change: its conversation is updated, with
-- its state operation. (Set by hand, triggers off.)
do $$
declare v_ops bigint; v_thread uuid;
begin
	select session_id into strict v_thread from public.qorpera_company_rooms where profile_id = '63400000-0000-4000-8000-000000000010'
		and bound_staff_agent_id = '63400000-0000-4000-8000-0000000000a1';
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set title = %L where id = %L', 'Stale title', v_thread));
	v_ops := pg_temp.state_ops();
	perform pg_temp.as_member('63400000-0000-4000-8000-000000000001');
	perform public.qorpera_update_profile_member_role('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000002',
		'contributor');
	perform pg_temp.path_claims('service_role');
	if (select title from public.qorpera_shared_sessions where id = v_thread) <> 'Agent A' or pg_temp.state_ops() <> v_ops + 1 then
		raise exception 'A changed title must be refreshed with one state operation: % and %',
			(select title from public.qorpera_shared_sessions where id = v_thread), pg_temp.state_ops() - v_ops; end if;
	-- And a status that changed: the active agent's thread, closed by hand, reopens.
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set status = %L where id = %L', 'closed', v_thread));
	v_ops := pg_temp.state_ops();
	perform pg_temp.as_member('63400000-0000-4000-8000-000000000001');
	perform public.qorpera_update_profile_member_role('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000002',
		'viewer');
	perform pg_temp.path_claims('service_role');
	if (select status from public.qorpera_shared_sessions where id = v_thread) <> 'open' or pg_temp.state_ops() <> v_ops + 1 then
		raise exception 'A changed status must be refreshed with one state operation: % and %',
			(select status from public.qorpera_shared_sessions where id = v_thread), pg_temp.state_ops() - v_ops; end if;
end $$;

-- 4. The founding lobby on folder-v2. The fixture company becomes an open table (by hand): the owner 01 opened it;
-- 02 and 04 sit at it; 08 is invited. C2's open and the availability switch are stand-ins, as in 705.
insert into auth.users(id, email, email_confirmed_at) values
	('81700000-0000-4000-8000-000000000008', 'seat@example.test', clock_timestamp());
update auth.users set email_confirmed_at = clock_timestamp() where id in ('63400000-0000-4000-8000-000000000001',
	'63400000-0000-4000-8000-000000000002', '63400000-0000-4000-8000-000000000004');
insert into public.qorpera_company_foundings(profile_id, created_by_user_id, vision_draft)
values ('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000001', '');
insert into public.qorpera_company_founder_seats(profile_id, user_id, invited_by_user_id, state, joined_at) values
	('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000001', '63400000-0000-4000-8000-000000000001', 'joined', clock_timestamp()),
	('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000002', '63400000-0000-4000-8000-000000000001', 'joined', clock_timestamp()),
	('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000004', '63400000-0000-4000-8000-000000000001', 'joined', clock_timestamp()),
	('63400000-0000-4000-8000-000000000010', '81700000-0000-4000-8000-000000000008', '63400000-0000-4000-8000-000000000001', 'invited', null);
create or replace function public.qorpera_folder_company_open(p_user_id uuid, p_client_creation_id uuid, p_name text)
returns jsonb language sql security definer set search_path = '' as $$
	select jsonb_build_object('profile_id', '63400000-0000-4000-8000-000000000010')
$$;
create or replace function public.qorpera_company_founding_available() returns boolean language sql stable security definer
set search_path = '' as $$ select true $$;
do $$
declare w jsonb := pg_temp.native(pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000004'));
	v_revision bigint;
begin
	-- 04's run is paid by its own login (binding b4, connection b5).
	perform pg_temp.prepare(w);
	perform pg_temp.fx(format('update public.qorpera_execution_runs set sponsor_binding_id = %L, sponsor_version = 1 where id = %L',
		'63400000-0000-4000-8000-0000000000b4', w ->> 'runId'));
	-- The opener's repeat open of its own table.
	perform pg_temp.as_verified('63400000-0000-4000-8000-000000000001');
	if public.qorpera_open_company_founding(extensions.gen_random_uuid(), 'Folder authority fixture') ->> 'phase' <> 'open' then
		raise exception 'The repeat open must return the open table'; end if;
	-- A founder edits the table.
	perform pg_temp.as_verified('63400000-0000-4000-8000-000000000002');
	v_revision := pg_temp.revision();
	perform public.qorpera_update_company_founding('63400000-0000-4000-8000-000000000010', v_revision, 'Folder lobby', 'We build.');
	if pg_temp.revision() <> v_revision + 1 or (select name from public.qorpera_profiles where id = '63400000-0000-4000-8000-000000000010')
			<> 'Folder lobby' then
		raise exception 'The edit must move the revision and rename the company'; end if;
	-- Someone without a seat is refused.
	perform pg_temp.as_verified('63400000-0000-4000-8000-000000000005');
	perform pg_temp.raises_like($q$select public.qorpera_remove_company_founder('63400000-0000-4000-8000-000000000010',
		'63400000-0000-4000-8000-000000000004')$q$, '42501', 'This founding table is unavailable');
	-- A founder cannot remove another joined founder; nobody removes the opener.
	perform pg_temp.as_verified('63400000-0000-4000-8000-000000000002');
	perform pg_temp.raises_like($q$select public.qorpera_remove_company_founder('63400000-0000-4000-8000-000000000010',
		'63400000-0000-4000-8000-000000000004')$q$, '42501', 'You cannot remove this seat');
	perform pg_temp.raises_like($q$select public.qorpera_remove_company_founder('63400000-0000-4000-8000-000000000010',
		'63400000-0000-4000-8000-000000000001')$q$, '42501', 'You cannot remove this seat');
	-- The invitee takes its seat: a member, in the agents' threads.
	perform pg_temp.as_verified('81700000-0000-4000-8000-000000000008');
	v_revision := pg_temp.revision();
	perform public.qorpera_respond_company_founding('63400000-0000-4000-8000-000000000010', true);
	perform pg_temp.path_claims('service_role');
	if (pg_temp.member_row('81700000-0000-4000-8000-000000000008')).role is distinct from 'contributor'
		or (select state from public.qorpera_company_founder_seats where profile_id = '63400000-0000-4000-8000-000000000010'
			and user_id = '81700000-0000-4000-8000-000000000008') <> 'joined'
		or pg_temp.revision() <> v_revision + 1
		or not pg_temp.in_thread('63400000-0000-4000-8000-0000000000a1', '81700000-0000-4000-8000-000000000008') then
		raise exception 'The seat taken: a contributor at the table, in agent A''s thread'; end if;
	-- The opener removes 04: its seat and its row go, its own login is revoked and the run that login pays for ends.
	perform pg_temp.as_verified('63400000-0000-4000-8000-000000000001');
	v_revision := pg_temp.revision();
	perform public.qorpera_remove_company_founder('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000004');
	perform pg_temp.path_claims('service_role');
	if (pg_temp.member_row('63400000-0000-4000-8000-000000000004')).user_id is not null
		or exists (select 1 from public.qorpera_company_founder_seats where profile_id = '63400000-0000-4000-8000-000000000010'
			and user_id = '63400000-0000-4000-8000-000000000004')
		or pg_temp.revision() <> v_revision + 1 then
		raise exception 'The removed founder''s seat and row must go, with the revision'; end if;
	if (select status from public.qorpera_runner_jobs where id = (w ->> 'jobId')::uuid) not in ('failed','cancelled')
		or (select status from public.qorpera_provider_connections where id = '63400000-0000-4000-8000-0000000000b5') <> 'revoked' then
		raise exception 'The removed founder''s login must be revoked and its run must end'; end if;
	-- 02 leaves the table (and the company).
	perform pg_temp.as_verified('63400000-0000-4000-8000-000000000002');
	if public.qorpera_remove_company_founder('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000002') ->> 'state'
			<> 'left' then
		raise exception 'Leaving the table must say left'; end if;
	perform pg_temp.path_claims('service_role');
	if (pg_temp.member_row('63400000-0000-4000-8000-000000000002')).user_id is not null then raise exception 'The leaver''s row must go'; end if;
end $$;

-- 5. An account deletion of a folder-v2 member who never acted: its row goes, and it leaves the agents' threads.
do $$
begin
	delete from auth.users where id = '81700000-0000-4000-8000-000000000006';
	if (pg_temp.member_row('81700000-0000-4000-8000-000000000006')).user_id is not null
		or pg_temp.in_thread('63400000-0000-4000-8000-0000000000a1', '81700000-0000-4000-8000-000000000006') then
		raise exception 'The deleted account''s member must go, and leave the threads'; end if;
end $$;

-- 6. The prelude's 'jobs' mode serves folder-v2 only.
do $$
begin
	perform pg_temp.raises_like($q$select public.qorpera_folder_member_change_enter('64700000-0000-4000-8000-000000000011',
		'63400000-0000-4000-8000-000000000001', 'jobs')$q$, '42501', 'Company folder is unavailable');
	perform pg_temp.raises_like($q$select public.qorpera_folder_member_change_enter('63400000-0000-4000-8000-000000000010',
		'63400000-0000-4000-8000-000000000001', 'other')$q$, 'XX000', 'Member change mode is invalid');
end $$;

rollback;
