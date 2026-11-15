-- @fixture 1246_home_exec_sessions.test.sql until "-- 1. The switch is off ---"
-- The agent's home in the company folder (20260930754000), on builder A's own fixture (1246 on 924's base: Alice's live
-- run, a real binding, the real machine_start and the executor's custody). The chain a run goes through before Codex's
-- own tools touch a machine, with this migration in it:
-- 1. The offer (A's qorpera_company_home_available) gives the run the agent's machine only for the member it works for,
--    and only while the run's agent and member read the folder's root.
-- 2. A's authority writes the session; the executor's ask (qorpera_folder_home_session_window) answers it open, with
--    the ids its folder command window carries.
-- 3. A machine started for another member is no home of this run: the offer has none, and the ask refuses a session on
--    it (HOME_NOT_SHARED), so the executor starts no channel. A closed session is refused as ended.

do $$
declare v_session uuid := extensions.gen_random_uuid(); v jsonb; v_machine public.qorpera_company_machines;
	v_placement public.qorpera_company_machine_placements; v_other uuid;
begin
	perform pg_temp.h1_switch(true, true);
	perform pg_temp.h1_start('home-f');
	perform pg_temp.h1_up('home-f', extensions.gen_random_uuid());
	v_machine := pg_temp.h1_machine('home-f'); v_placement := pg_temp.h1_placement('home-f');
	-- What this test stands on: Alice and the member she works for read the folder's root on 924's base.
	perform pg_temp.base_assert(public.qorpera_folder_reads_root(v_machine.environment_id, v_machine.profile_id,
		v_machine.started_by_staff_agent_id, pg_temp.h1_requester()), '0: Alice and her member read the root');
	-- 1. The offer.
	perform pg_temp.base_assert(pg_temp.h1_has_home() and pg_temp.h1_home() ->> 'machine' = 'home-f',
		'1: the run is offered the agent''s machine for its member: ' || pg_temp.h1_home()::text);
	-- 2. A's authority, then the executor's ask.
	v := pg_temp.h1_authorize('home-f', v_session);
	perform pg_temp.base_assert(v ->> 'state' = 'authorized', '2: A authorizes the session: ' || v::text);
	v := public.qorpera_folder_home_session_window(v_session);
	perform pg_temp.base_assert(v ->> 'state' = 'open' and v ->> 'sessionId' = v_session::text
		and v ->> 'runId' = pg_temp.h1_run()::text and v ->> 'staffAgentId' = v_machine.started_by_staff_agent_id::text
		and v ->> 'requestedByUserId' = pg_temp.h1_requester()::text and v ->> 'machineId' = v_machine.id::text
		and v ->> 'placementId' = v_placement.id::text and v ->> 'bootId' = v_placement.boot_id::text,
		'2: the ask answers the session open, with its window''s ids: ' || v::text);
	-- 3. The machine was started for another member: no home for this run, and its session is refused.
	select user_id into v_other from public.qorpera_profile_members
	where profile_id = v_machine.profile_id and user_id <> pg_temp.h1_requester() order by user_id limit 1;
	begin
		set local session_replication_role = replica;
		update public.qorpera_company_machines set requested_by_user_id = v_other where id = v_machine.id;
		set local session_replication_role = origin;
		perform pg_temp.base_assert(not pg_temp.h1_has_home(),
			'3: a machine started for another member is offered to nobody else: ' || pg_temp.h1_home()::text);
		v := public.qorpera_folder_home_session_window(v_session);
		perform pg_temp.base_assert(v ->> 'state' = 'refused' and v ->> 'reason' = 'HOME_NOT_SHARED',
			'3: and the ask refuses the session on it: ' || v::text);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	perform pg_temp.base_assert(pg_temp.h1_has_home(), '3: the member''s own machine again');
	-- A session the run closed is ended for the executor too.
	perform public.qorpera_close_home_session(pg_temp.h1_binding(), v_session, 'ended');
	v := public.qorpera_folder_home_session_window(v_session);
	perform pg_temp.base_assert(v ->> 'state' = 'refused' and v ->> 'reason' = 'HOME_SESSION_ENDED',
		'3: a closed session is ended: ' || v::text);
	perform pg_temp.h1_switch(false, false);
end $$;
