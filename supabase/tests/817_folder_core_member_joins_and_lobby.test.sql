-- @fixture 664_folder_core_member_management.test.sql until "-- The checks start here: a test that runs after this file's fixture part stops at this line."
-- Company folder core, C1c-3d-1 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.6): joins, the founding lobby and
-- the member triggers on the folder fence. A join refuses a caller who is not the invitee of a live invitation; a join
-- and a role change refresh the agent threads without a conversation state operation, unless a title or a status
-- changes; the founding lobby opens, edits, seats and removes founders on folder-v2 (a removed founder's own login and
-- the run it pays for end); an account deletion of a folder-v2 member. Races are in 818.

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
