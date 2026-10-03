-- @fixture 647_folder_core_run_fence.test.sql until "-- 1. Snapshot-v1 keeps its text"
-- Company folder core, C1c-3c (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.4): member management on the folder
-- fence. Removing a member ends the runs its own login pays for, revokes its login, closes its private conversation and
-- leaves the agent threads; leaving; role changes and the founder guard; joining by invitation. Snapshot-v1 keeps its
-- text. Races are in 665.

create function pg_temp.member_row(p_user uuid) returns public.qorpera_profile_members language sql as $$
	select * from public.qorpera_profile_members where profile_id = '63400000-0000-4000-8000-000000000010' and user_id = p_user
$$;
create function pg_temp.as_member(p_user uuid) returns void language sql as $$
	select pg_temp.path_claims('authenticated', p_user)
$$;
-- A hand-built run's substrate, snapshot, runtime bundle and claim made real (as 658's prepare), so ending it passes
-- the foreign keys that are checked again when its rows change a second time. The runner rows come from 647's native.
create function pg_temp.prepare(p_actor jsonb) returns void language plpgsql as $$
declare v_substrate uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.fx(format($f$insert into public.qorpera_company_substrate_versions(id, profile_id, environment_id, company_snapshot_id,
		client_version_id, contract_version, operation_sequence, operation_count, content_sha256, created_by_user_id)
		values (%L, '64700000-0000-4000-8000-000000000011', '64700000-0000-4000-8000-000000000021', extensions.gen_random_uuid(),
			extensions.gen_random_uuid(), 1, 0, 0, repeat('f', 64), '63400000-0000-4000-8000-000000000001')$f$, v_substrate));
	perform pg_temp.fx(format('update public.qorpera_runner_jobs set substrate_version_id = %L where id = %L', v_substrate, p_actor ->> 'jobId'));
	perform pg_temp.fx(format('update public.qorpera_execution_runs set substrate_version_id = %L where id = %L', v_substrate, p_actor ->> 'runId'));
	perform pg_temp.fx(format($f$insert into public.qorpera_company_snapshots(id, profile_id, environment_id, workspace_id, client_snapshot_id,
		tree_manifest_sha256, tree_manifest_bytes, tree_contract_version, file_count, total_bytes, created_by_user_id)
		select company_snapshot_id, '64700000-0000-4000-8000-000000000011', '64700000-0000-4000-8000-000000000021',
			extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('f', 64), 1, 1, 0, 0, '63400000-0000-4000-8000-000000000001'
		from public.qorpera_execution_runs where id = %L$f$, p_actor ->> 'runId'));
	perform pg_temp.fx(format($f$update public.qorpera_execution_runs set runtime_bundle_id = bundle.id, runtime_bundle_sha256 = bundle.sha256
		from (select id, sha256 from public.qorpera_runtime_bundles order by version desc, id limit 1) bundle
		where qorpera_execution_runs.id = %L$f$, p_actor ->> 'runId'));
	perform pg_temp.fx(format($f$update public.qorpera_session_inputs set runtime_bundle_id = run.runtime_bundle_id,
		runtime_bundle_sha256 = run.runtime_bundle_sha256 from public.qorpera_execution_runs run
		where run.id = %L and qorpera_session_inputs.execution_run_id = run.id$f$, p_actor ->> 'runId'));
	perform pg_temp.fx(format($f$insert into public.qorpera_runner_job_claims(id, orchestrator_id, client_claim_id, job_id, run_id,
		lease_expires_at, status) select claim_id, extensions.gen_random_uuid(), extensions.gen_random_uuid(), job_id, run_id,
		clock_timestamp() + interval '1 hour', 'accepted' from public.qorpera_runner_assignments where id = %L$f$, p_actor ->> 'assignmentId'));
end $$;

-- 1. Snapshot-v1 keeps its text: each body with its patch reversed is the definition before this migration.
do $$
declare v_def text;
begin
	foreach v_def in array array['public.qorpera_remove_profile_member(uuid,uuid)|p_member_user_id|remove|410d6f2552fc5f3691e8d5d70bb74d80',
		'public.qorpera_leave_hosted_profile(uuid)|v_actor_id|remove|86af1292bbe3682782109da6a5e44386',
		'public.qorpera_update_profile_member_role(uuid,uuid,qorpera_profile_role)|p_member_user_id|role|f68cd771bfe58ceabc2678c9c9fdd6f5'] loop
		if md5(replace(pg_get_functiondef(split_part(v_def, '|', 1)::regprocedure),
				E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
				|| E'\t\tperform public.qorpera_folder_member_change_enter(p_profile_id, ' || split_part(v_def, '|', 2) || ', '''
				|| split_part(v_def, '|', 3) || E''');\n'
				|| E'\telse\n'
				|| E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'
				|| E'\tend if;\n',
				E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n')) <> split_part(v_def, '|', 4) then
			raise exception 'The snapshot-v1 text of % changed', split_part(v_def, '|', 1); end if;
	end loop;
	if md5(replace(pg_get_functiondef('public.qorpera_guard_founder_departure()'::regprocedure),
			E'\tif public.qorpera_company_is_folder_v2(old.profile_id) then\n'
			|| E'\t\tperform 1 from public.qorpera_profiles where id = old.profile_id for key share;\n'
			|| E'\telse\n'
			|| E'\tperform 1 from public.qorpera_profiles where id = old.profile_id for update;\n'
			|| E'\tend if;\n',
			E'\tperform 1 from public.qorpera_profiles where id = old.profile_id for update;\n')) <> '488053172974066541f7261c96373d63' then
		raise exception 'The founder guard''s snapshot-v1 text changed'; end if;
	-- The join's prelude as C1c-3d-1 (20260930002250) left it: only the invitee of a live invitation takes it.
	if md5(replace(pg_get_functiondef('public.qorpera_accept_profile_invitation(uuid)'::regprocedure),
			E'\t-- 20260930002250: only the invitee of a live invitation (the select below refuses anyone else) takes the fence.\n'
			|| E'\tperform public.qorpera_folder_member_change_enter(invitation.profile_id, v_user_id, ''join'')\n'
			|| E'\tfrom public.qorpera_profile_invitations as invitation\n'
			|| E'\twhere invitation.id = p_invitation_id and invitation.email = v_email and invitation.expires_at > statement_timestamp()\n'
			|| E'\t\tand public.qorpera_company_is_folder_v2(invitation.profile_id);\n', ''))
		<> '062a100a20d3c8f595b9a22f9d95dc8d' then
		raise exception 'The join''s snapshot-v1 text changed'; end if;
end $$;

-- 2. Removing a member: the run its own login pays for ends, the login is revoked, its private conversation closes,
-- it leaves agent A's thread, and its member row goes. A founder cannot be removed; an admin cannot remove an admin.
do $$
declare w jsonb := pg_temp.native(pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000004'));
	v_private uuid := extensions.gen_random_uuid(); v_room uuid;
begin
	-- The run is paid by the member's own login (binding b4, connection b5).
	perform pg_temp.prepare(w);
	perform pg_temp.fx(format('update public.qorpera_execution_runs set sponsor_binding_id = %L, sponsor_version = 1 where id = %L',
		'63400000-0000-4000-8000-0000000000b4', w ->> 'runId'));
	perform pg_temp.fx(format($f$insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id,
		audience_kind, audience_user_id) values (%L, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', 'Mine',
		'63400000-0000-4000-8000-000000000004', 'member_private', '63400000-0000-4000-8000-000000000004')$f$, v_private));
	select id into v_room from public.qorpera_company_rooms where profile_id = '63400000-0000-4000-8000-000000000010'
		and bound_staff_agent_id = '63400000-0000-4000-8000-0000000000a1';
	if not exists (select 1 from public.qorpera_company_room_members where room_id = v_room and principal_kind = 'member'
			and principal_id = '63400000-0000-4000-8000-000000000004' and status = 'active') then
		raise exception 'The member must be in agent A''s thread before'; end if;
	perform pg_temp.as_member('63400000-0000-4000-8000-000000000005');
	perform pg_temp.raises_like($q$select public.qorpera_remove_profile_member('63400000-0000-4000-8000-000000000010',
		'63400000-0000-4000-8000-000000000001')$q$, '42501', 'A founder cannot be removed; founders leave on their own');
	perform pg_temp.as_member('63400000-0000-4000-8000-000000000001');
	if public.qorpera_remove_profile_member('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000004') <> 'true'::jsonb then
		raise exception 'The removal must return true'; end if;
	perform pg_temp.path_claims('service_role');
	if (pg_temp.member_row('63400000-0000-4000-8000-000000000004')).user_id is not null then raise exception 'The member row must go'; end if;
	if (select status from public.qorpera_runner_jobs where id = (w ->> 'jobId')::uuid) not in ('failed','cancelled') then
		raise exception 'The run the member''s own login pays for must end: %',
			(select status from public.qorpera_runner_jobs where id = (w ->> 'jobId')::uuid); end if;
	if (select status from public.qorpera_provider_connections where id = '63400000-0000-4000-8000-0000000000b5') <> 'revoked' then
		raise exception 'The member''s login must be revoked'; end if;
	if (select status from public.qorpera_shared_sessions where id = v_private) <> 'closed' then
		raise exception 'The member''s private conversation must close'; end if;
	if exists (select 1 from public.qorpera_company_room_members where room_id = v_room and principal_kind = 'member'
			and principal_id = '63400000-0000-4000-8000-000000000004' and status = 'active') then
		raise exception 'The member must leave agent A''s thread'; end if;
end $$;

-- 3. Leaving: the member's row goes. The founder guard: the last founder cannot step down; with a second founder, it can.
do $$
begin
	perform pg_temp.as_member('63400000-0000-4000-8000-000000000002');
	if public.qorpera_leave_hosted_profile('63400000-0000-4000-8000-000000000010') <> 'true'::jsonb then
		raise exception 'Leaving must return true'; end if;
	perform pg_temp.path_claims('service_role');
	if (pg_temp.member_row('63400000-0000-4000-8000-000000000002')).user_id is not null then raise exception 'The leaver''s row must go'; end if;
	perform pg_temp.as_member('63400000-0000-4000-8000-000000000001');
	perform pg_temp.raises_like($q$select public.qorpera_update_profile_member_role('63400000-0000-4000-8000-000000000010',
		'63400000-0000-4000-8000-000000000001', 'admin')$q$, '42501', 'The last founder cannot step down; make someone else a founder first');
	if public.qorpera_update_profile_member_role('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000003',
			'contributor') ->> 'role' <> 'contributor' then raise exception 'A role change must return the new role'; end if;
	perform public.qorpera_update_profile_member_role('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000005', 'owner');
	if (public.qorpera_update_profile_member_role('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000001',
			'admin')) ->> 'role' <> 'admin' then raise exception 'A founder steps down beside another founder'; end if;
	perform pg_temp.path_claims('service_role');
	if (pg_temp.member_row('63400000-0000-4000-8000-000000000005')).role <> 'owner' or (pg_temp.member_row('63400000-0000-4000-8000-000000000001')).role <> 'admin' then
		raise exception 'The founders after the step-down'; end if;
end $$;

-- 4. Joining by invitation: the new member is in, and in the agents' threads.
insert into auth.users(id, email, email_confirmed_at) values ('66400000-0000-4000-8000-000000000006', 'joiner@example.test', clock_timestamp());
insert into public.qorpera_profile_invitations(id, profile_id, email, role, invited_by_user_id, expires_at)
values ('66400000-0000-4000-8000-0000000000e1', '63400000-0000-4000-8000-000000000010', 'joiner@example.test', 'contributor',
	'63400000-0000-4000-8000-000000000005', clock_timestamp() + interval '1 day');
do $$
begin
	perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"66400000-0000-4000-8000-000000000006","email":"joiner@example.test"}', true);
	if public.qorpera_accept_profile_invitation('66400000-0000-4000-8000-0000000000e1') <> 'true'::jsonb then
		raise exception 'The join must return true'; end if;
	perform pg_temp.path_claims('service_role');
	if (pg_temp.member_row('66400000-0000-4000-8000-000000000006')).role is distinct from 'contributor'
		or exists (select 1 from public.qorpera_profile_invitations where id = '66400000-0000-4000-8000-0000000000e1')
		or not exists (select 1 from public.qorpera_company_room_members m join public.qorpera_company_rooms r on r.id = m.room_id
			where r.profile_id = '63400000-0000-4000-8000-000000000010' and r.bound_staff_agent_id = '63400000-0000-4000-8000-0000000000a1'
				and m.principal_kind = 'member' and m.principal_id = '66400000-0000-4000-8000-000000000006' and m.status = 'active') then
		raise exception 'The joiner must be a member, in agent A''s thread'; end if;
end $$;

-- 5. The snapshot-v1 control company keeps its own path: its last member cannot leave.
do $$
begin
	perform pg_temp.as_member('63400000-0000-4000-8000-000000000001');
	perform pg_temp.raises_like($q$select public.qorpera_leave_hosted_profile('64700000-0000-4000-8000-000000000011')$q$, '42501',
		'You are the last member; delete the company instead');
	perform pg_temp.path_claims('service_role');
end $$;

-- 6. Privileges: the new function is postgres-only.
do $$
begin
	if has_function_privilege('service_role', 'public.qorpera_folder_member_change_enter(uuid,uuid,text)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_member_change_enter(uuid,uuid,text)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_folder_member_change_enter(uuid,uuid,text)', 'execute') then
		raise exception 'qorpera_folder_member_change_enter must be postgres-only'; end if;
end $$;

rollback;
