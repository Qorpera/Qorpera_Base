-- @fixture 510_folder_test_machine_views.test.sql until "-- The migration's marker is in every function it patches"
-- The agent's home in the company folder (20260930754000; slice 3 of lanes/agent-box-20261113/HOME-PLAN.md, as reworked
-- after the audit of 13 Nov 2026). A home is a company machine whose /company is its boot's own company-wide view; a
-- run works there in a session of builder A's (qorpera_company_home_sessions, 20260930752000), whose rows are built here
-- by hand as A's authority writes them. This test holds:
-- 1. Which runs share a machine (qorpera_folder_home_shared): its own agent, member and worker access, and only while
--    they read the folder's root.
-- 2. The executor's ask before a channel starts (qorpera_folder_home_session_window): the session stands on its
--    machine's current placement and boot and may share it, and the answer names the ids its window carries.
-- 3. Credit: a change credited to a session of the view's machine, placement and boot saves, and the commit names it
--    and acts as the session's run; a session of another boot or placement credits nothing; a closed session still does,
--    while its run goes on (or ended a moment ago); a session whose run is over is skipped and closed as ended (3b).
-- 4. Reads: a release reaches every run with a session open on the machine, and none whose session closed.
-- The office, machine, run and view helpers are 510's, 639's and 632's; the command helper is 512's.

-- 512's: a command on the anchor's machine and placement, from the run, started at p_started.
create function pg_temp.cmd(p_anchor jsonb, p_run jsonb, p_started timestamptz) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id,
		command_head, notify, started_at, sent_at, requested_by_user_id)
	select v_id, (p_anchor ->> 'companyMachineId')::uuid, r.id, r.staff_agent_id, (p_anchor ->> 'placementId')::uuid,
		'npm test', false, p_started, p_started, r.requested_by_user_id
	from public.qorpera_execution_runs r where r.id = (p_run ->> 'runId')::uuid;
	set local session_replication_role = origin;
	return v_id;
end $$;
-- A session of the run on the anchor's machine, placement and boot, opened at p_opened, as A's authority writes it.
create function pg_temp.hs(p_anchor jsonb, p_run jsonb, p_opened timestamptz default clock_timestamp()) returns uuid
language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_company_home_sessions(id, machine_id, placement_id, boot_id, run_id, staff_agent_id,
		requested_by_user_id, opened_at)
	select v_id, (p_anchor ->> 'companyMachineId')::uuid, (p_anchor ->> 'placementId')::uuid, (p_anchor ->> 'bootId')::uuid,
		r.id, r.staff_agent_id, r.requested_by_user_id, p_opened
	from public.qorpera_execution_runs r where r.id = (p_run ->> 'runId')::uuid;
	set local session_replication_role = origin;
	return v_id;
end $$;
create function pg_temp.hs_close(p_session uuid) returns void language sql as $$
	select pg_temp.fx(format('update public.qorpera_company_home_sessions set closed_at = clock_timestamp(),
		close_reason = ''ended'' where id = %L', p_session))
$$;
create function pg_temp.hs_shared(p_machine uuid, p_run jsonb) returns boolean language sql as $$
	select public.qorpera_folder_home_shared(m, r.staff_agent_id, r.requested_by_user_id, r.id)
	from public.qorpera_company_machines m, public.qorpera_execution_runs r
	where m.id = p_machine and r.id = (p_run ->> 'runId')::uuid
$$;
create function pg_temp.hs_window(p_session uuid) returns jsonb language sql as $$
	select public.qorpera_folder_home_session_window(p_session)
$$;
-- A mkdir that credits the given ids (512's shape).
create function pg_temp.hs_mk(p_path text, variadic p_credits uuid[] default null) returns jsonb language sql as $$
	select jsonb_build_object('op','mkdir','path',p_path) || case when p_credits is null then '{}'::jsonb
		else jsonb_build_object('credits', to_jsonb(p_credits)) end
$$;
create function pg_temp.hs_found(p_path text) returns boolean language sql as $$
	select (pg_temp.read(p_path) ->> 'found')::boolean
$$;
-- The view reads the path and releases it under the release id.
create function pg_temp.hs_release(p_view jsonb, p_release uuid, p_path text) returns jsonb language plpgsql as $$
declare e jsonb := pg_temp.read(p_path, pg_temp.vactor(p_view)) -> 'entry';
begin
	return public.qorpera_folder_record_release('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_release,
		jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')),
		repeat('5', 64));
end $$;
create function pg_temp.hs_got(p_run jsonb, p_release uuid) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_folder_run_read_records where run_id = (p_run ->> 'runId')::uuid
		and release_id = p_release)
$$;


-- 0. The marker is in every function the migration patches and in the two it adds; the ask is the service role's
-- alone, and the rule is no API role's.
do $$
declare f regprocedure; r name;
begin
	foreach f in array array['public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)',
		'public.qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)',
		'public.qorpera_company_home_available(jsonb)',
		'public.qorpera_folder_home_shared(public.qorpera_company_machines,uuid,uuid,uuid)',
		'public.qorpera_folder_home_session_credits(uuid)',
		'public.qorpera_folder_home_session_window(uuid)']::regprocedure[] loop
		foreach r in array array['anon','authenticated','qorpera_secret_broker']::name[] loop
			if has_function_privilege(r, f, 'EXECUTE') and f::text like '%home\_s%' then
				raise exception '% may run %', r, f; end if;
		end loop;
	end loop;
	if has_function_privilege('service_role',
			'public.qorpera_folder_home_shared(public.qorpera_company_machines,uuid,uuid,uuid)', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_folder_home_session_credits(uuid)', 'EXECUTE') then
		raise exception 'The service role may run the rules themselves'; end if;
	if not has_function_privilege('service_role', 'public.qorpera_folder_home_session_window(uuid)', 'EXECUTE') then
		raise exception 'The service role may not ask'; end if;
end $$;


-- 1. Which runs share a machine: the agent's own, started for the same member by a run of the same worker access, and
-- only while the agent and the member read the folder's root.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	v2 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	viewer jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000003');
	vb jsonb := pg_temp.agent_b('63200000-0000-4000-8000-000000000002'); m uuid := pg_temp.machine(v, 'hs-shared');
	routine jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); w uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.place(m);
	if not pg_temp.hs_shared(m, v) or not pg_temp.hs_shared(m, v2) or not pg_temp.hs_shared(m, routine) then
		raise exception 'The agent''s own machine for the same member is not shared'; end if;
	if pg_temp.hs_shared(m, viewer) then raise exception 'Another member''s run shares the machine'; end if;
	if pg_temp.hs_shared(m, vb) then raise exception 'Another agent''s run shares the machine'; end if;
	-- The agent no longer reads the root: nobody shares a machine of its, its starter neither.
	perform pg_temp.a_grants(true);
	if pg_temp.hs_shared(m, v) or pg_temp.hs_shared(m, v2) then
		raise exception 'A run that does not read the root shares a machine'; end if;
	perform pg_temp.a_grants(false);
	-- A run of a worker whose access is not the starter's: the run's wake dispatches a read worker (1116's shape), as
	-- qorpera_run_worker reads it.
	perform pg_temp.fx(format('insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id,
			todo_id, worker_key, species, title, access, revival, dispatch, requested_by_user_id, steering_run_id)
		values (%L, ''63200000-0000-4000-8000-000000000010'', ''63200000-0000-4000-8000-000000000020'',
			''63200000-0000-4000-8000-0000000000a1'', %L, ''hs-worker'', ''in-house'', ''Worker'', ''read'', ''each'', ''{}'',
			''63200000-0000-4000-8000-000000000002'', %L)', w, extensions.gen_random_uuid(), v ->> 'runId'));
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set wake_kind = ''agent'', source_kind = ''worker-dispatch'',
		source_id = %L where run_id = %L', w, routine ->> 'runId'));
	if (public.qorpera_run_worker((routine ->> 'runId')::uuid)).access is distinct from 'read' then
		raise exception 'The worker fixture'; end if;
	if pg_temp.hs_shared(m, routine) then raise exception 'A worker of another access shares the machine'; end if;
end $$;


-- 2. The executor's ask: an open session on the machine's current placement and boot, and a run that may share it.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	viewer jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000003'); m uuid := pg_temp.machine(v, 'hs-ask');
	a jsonb := pg_temp.place(m); s uuid := pg_temp.hs(a, v); r jsonb; f text; b jsonb;
begin
	r := pg_temp.hs_window(s);
	if r is distinct from jsonb_build_object('schema','qorpera.folder-home-session/v1','state','open','sessionId',s,
			'runId',(v ->> 'runId')::uuid,'staffAgentId','63200000-0000-4000-8000-0000000000a1',
			'requestedByUserId','63200000-0000-4000-8000-000000000002','machineId',m,
			'placementId',(a ->> 'placementId')::uuid,'bootId',(a ->> 'bootId')::uuid) then
		raise exception 'The ask: %', r; end if;
	-- Ended: the session closed, the machine removed, its placement retired or removed, or another boot.
	foreach f in array array[
		format('update public.qorpera_company_home_sessions set closed_at = clock_timestamp(), close_reason = ''ended'' where id = %L', s),
		format('update public.qorpera_company_machines set removed_at = clock_timestamp() where id = %L', m),
		format('update public.qorpera_company_machine_placements set retired_at = clock_timestamp() where id = %L', a ->> 'placementId'),
		format('update public.qorpera_company_machine_placements set removing_at = clock_timestamp(),
			removed_at = clock_timestamp() where id = %L', a ->> 'placementId'),
		format('update public.qorpera_company_machine_placements set boot_id = %L where id = %L', extensions.gen_random_uuid(),
			a ->> 'placementId')] loop
		begin
			perform pg_temp.fx(f);
			r := pg_temp.hs_window(s);
			if r ->> 'state' is distinct from 'refused' or r ->> 'reason' is distinct from 'HOME_SESSION_ENDED' then
				raise exception 'The ask after %: %', f, r; end if;
			raise exception 'Undo' using errcode = 'QTF80';
		exception when sqlstate 'QTF80' then null;
		end;
	end loop;
	-- A new disk of the same machine: the session of the disk before is ended.
	b := pg_temp.place(m);
	if pg_temp.hs_window(s) ->> 'reason' is distinct from 'HOME_SESSION_ENDED' then
		raise exception 'A session of the disk before'; end if;
	-- Not shared: another member's session on this machine, and this run once the agent no longer reads the root.
	s := pg_temp.hs(b, viewer);
	r := pg_temp.hs_window(s);
	if r ->> 'state' is distinct from 'refused' or r ->> 'reason' is distinct from 'HOME_NOT_SHARED' then
		raise exception 'Another member''s session: %', r; end if;
	s := pg_temp.hs(b, v);
	perform pg_temp.a_grants(true);
	if pg_temp.hs_window(s) ->> 'reason' is distinct from 'HOME_NOT_SHARED' then
		raise exception 'A session of a run that does not read the root'; end if;
	perform pg_temp.a_grants(false);
	if pg_temp.hs_window(s) ->> 'state' is distinct from 'open' then raise exception 'The session again'; end if;
	-- An unknown session raises; and the ask is the service role's.
	perform pg_temp.refused(format('select pg_temp.hs_window(%L)', extensions.gen_random_uuid()), '42501',
		'Home session window unavailable');
	perform pg_temp.refused('select pg_temp.hs_window(null)', '22023', 'Home session window scope invalid');
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.refused(format('select pg_temp.hs_window(%L)', s), '22023', 'Home session window scope invalid');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;


-- 3. Credit: what the machine changed while a session's window was open is credited to that session, checked for its
-- agent and member, and the commit acts as the session's run. A session of another placement or boot is no credit
-- here; a closed one still is.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	v2 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	v3 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); m uuid := pg_temp.machine(v, 'hs-credit');
	m2 uuid := pg_temp.machine(v, 'hs-credit-two'); a jsonb := pg_temp.place(m); a2 jsonb := pg_temp.place(m2);
	t jsonb; r jsonb; c public.qorpera_folder_commits%rowtype; s uuid; s_closed uuid; s_other uuid; s_old_boot uuid;
	cmd uuid; fa jsonb := pg_temp.stage('home credit');
begin
	t := pg_temp.open('test_machine', a);
	-- v2's session opened first; a command of v's started after it.
	s := pg_temp.hs(a, v2, clock_timestamp() - interval '5 minutes');
	cmd := pg_temp.cmd(a, v, clock_timestamp() - interval '4 minutes');
	s_closed := pg_temp.hs(a, v3, clock_timestamp() - interval '3 minutes'); perform pg_temp.hs_close(s_closed);
	s_other := pg_temp.hs(a2, v2);
	s_old_boot := pg_temp.hs(a || jsonb_build_object('bootId', extensions.gen_random_uuid()), v2);
	r := pg_temp.vcommit(t, 'hs-credits', jsonb_build_array(pg_temp.hs_mk('hs-one', s),
		pg_temp.hs_mk('hs-both', cmd, s), pg_temp.hs_mk('hs-closed', s_closed), pg_temp.hs_mk('hs-other', s_other),
		pg_temp.hs_mk('hs-old-boot', s_old_boot), pg_temp.hs_mk('hs-none'),
		jsonb_build_object('op','write','path','QorperaOS/rules/hs.txt','file',fa,'credits',jsonb_build_array(s))));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved'); perform pg_temp.expect(r, 3, 'saved');
	perform pg_temp.expect(r, 4, 'refused', 'command_ended'); perform pg_temp.expect(r, 5, 'refused', 'command_ended');
	perform pg_temp.expect(r, 6, 'saved');
	-- A path the session's agent may not write is denied, in the folder.
	perform pg_temp.expect(r, 7, 'denied', 'denied');
	if not pg_temp.hs_found('hs-one') or not pg_temp.hs_found('hs-both') or not pg_temp.hs_found('hs-closed')
		or pg_temp.hs_found('hs-other') or pg_temp.hs_found('hs-old-boot') or not pg_temp.hs_found('hs-none') then
		raise exception 'A refused credit applies nothing of its unit'; end if;
	c := pg_temp.last_commit(r);
	-- The credits in start order: the session (opened 5 minutes ago), the command, the closed session; the first one is
	-- the commit's actor, so the commit is v2's run's, not the starter's.
	if c.credits is distinct from array[s, cmd, s_closed] or c.view_kind is distinct from 'test_machine'
		or c.run_id is distinct from (v2 ->> 'runId')::uuid
		or c.actor_id is distinct from '63200000-0000-4000-8000-0000000000a1' then
		raise exception 'The credited commit: % (credits %, %, %)', to_jsonb(c), s, cmd, s_closed; end if;
	-- A session whose run has let go of its job is still a credit, with no run: the commit acts as the agent.
	perform pg_temp.lapse(v2);
	r := pg_temp.vcommit(t, 'hs-lapsed', jsonb_build_array(pg_temp.hs_mk('hs-lapsed', s)));
	perform pg_temp.expect(r, 1, 'saved');
	c := pg_temp.last_commit(r);
	if c.credits is distinct from array[s] or c.run_id is not null then
		raise exception 'A session of a run that let go: %', to_jsonb(c); end if;
	-- A credit from a view that is no test machine's is still malformed.
	perform pg_temp.hold(v);
	t := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4',
		'holderRunId', v ->> 'runId'));
	perform pg_temp.refused(format('select pg_temp.vcommit(%L, %L, %L)', t, 'hs-kind-1', jsonb_build_array(pg_temp.hs_mk('hs-kind', s))),
		'22023', 'Change set unit 1 is invalid');
	perform public.qorpera_folder_view_close((t ->> 'viewId')::uuid, t ->> 'pass');
	perform pg_temp.hold(null);
end $$;


-- 3b. A session whose run is over credits nothing (review of the lead, 13 Nov): an executor that crashed leaves the
-- session's window open in the folder service, so every later change on the machine still names it. Its run ended long
-- ago: the session is skipped in each unit (a unit credited to it alone is the starter's, one credited to a command as
-- well is that command's) and closed as ended. A run that ended a moment ago still credits its session's last changes.
create function pg_temp.hs_end_job(p_run jsonb, p_ago interval) returns void language sql as $$
	select pg_temp.fx(format('update public.qorpera_runner_jobs set status = ''completed'', result = ''{}''::jsonb,
		finished_at = clock_timestamp() - %L::interval, lease_token_sha256 = null, lease_expires_at = null
		where id = %L', p_ago, p_run ->> 'jobId'))
$$;
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	gone jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	just jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	other jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); m uuid := pg_temp.machine(v, 'hs-stale');
	a jsonb := pg_temp.place(m); t jsonb; r jsonb; c public.qorpera_folder_commits%rowtype; stale uuid; recent uuid;
	cmd uuid; srow public.qorpera_company_home_sessions%rowtype;
begin
	t := pg_temp.open('test_machine', a);
	stale := pg_temp.hs(a, gone, clock_timestamp() - interval '2 hours');
	recent := pg_temp.hs(a, just, clock_timestamp() - interval '1 hour');
	cmd := pg_temp.cmd(a, other, clock_timestamp() - interval '1 minute');
	perform pg_temp.hs_end_job(gone, interval '90 minutes');
	perform pg_temp.hs_end_job(just, interval '30 seconds');
	r := pg_temp.vcommit(t, 'hs-stale', jsonb_build_array(pg_temp.hs_mk('hs-stale-alone', stale),
		pg_temp.hs_mk('hs-stale-and-cmd', stale, cmd), pg_temp.hs_mk('hs-recent', recent)));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved'); perform pg_temp.expect(r, 3, 'saved');
	c := pg_temp.last_commit(r);
	-- The ended run's session is in no credit; the recent one's is, in start order with the command.
	if c.credits is distinct from array[recent, cmd] then
		raise exception 'A session of a run that is over is credited: % (stale %, recent %, cmd %)', c.credits, stale,
			recent, cmd; end if;
	select * into srow from public.qorpera_company_home_sessions where id = stale;
	if srow.closed_at is null or srow.close_reason is distinct from 'ended' then
		raise exception 'A skipped session is not closed as ended: %', to_jsonb(srow); end if;
	if (select closed_at from public.qorpera_company_home_sessions where id = recent) is not null then
		raise exception 'A session whose run just ended is closed'; end if;
	-- A later change naming the stale session alone is the starter's: saved, credited to no session.
	r := pg_temp.vcommit(t, 'hs-stale-later', jsonb_build_array(pg_temp.hs_mk('hs-stale-later', stale)));
	perform pg_temp.expect(r, 1, 'saved');
	c := pg_temp.last_commit(r);
	if c.credits is not null or c.run_id is distinct from (v ->> 'runId')::uuid then
		raise exception 'A later change is credited to a run that is over: %', to_jsonb(c); end if;
	perform public.qorpera_folder_view_close((t ->> 'viewId')::uuid, t ->> 'pass');
end $$;


-- 4. Reads: a release through the machine's view reaches every run with a session open on it, checked for that run's
-- own authority, and no run whose session closed. The starter's run gets it as before.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	v2 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	v3 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	v4 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); m uuid := pg_temp.machine(v, 'hs-reads');
	a jsonb := pg_temp.place(m); t jsonb; s3 uuid; rel uuid := extensions.gen_random_uuid(); r jsonb;
begin
	t := pg_temp.open('test_machine', a);
	perform pg_temp.hs(a, v2);
	s3 := pg_temp.hs(a, v3); perform pg_temp.hs_close(s3);
	-- v4's session is of the boot before: not this view's.
	perform pg_temp.hs(a || jsonb_build_object('bootId', extensions.gen_random_uuid()), v4);
	r := pg_temp.hs_release(t, rel, 'QorperaOS/rules/tone.txt');
	if not pg_temp.hs_got(v, rel) or not pg_temp.hs_got(v2, rel) or pg_temp.hs_got(v3, rel) or pg_temp.hs_got(v4, rel) then
		raise exception 'The release reaches the open sessions'' runs: % (v %, v2 %, v3 %, v4 %)', r, pg_temp.hs_got(v, rel),
			pg_temp.hs_got(v2, rel), pg_temp.hs_got(v3, rel), pg_temp.hs_got(v4, rel); end if;
	-- A session's run whose job let go gets nothing, as a command's.
	perform pg_temp.lapse(v2);
	rel := extensions.gen_random_uuid();
	perform pg_temp.hs_release(t, rel, 'QorperaOS/rules/tone.txt');
	if pg_temp.hs_got(v2, rel) or not pg_temp.hs_got(v, rel) then raise exception 'A run that let go'; end if;
end $$;
