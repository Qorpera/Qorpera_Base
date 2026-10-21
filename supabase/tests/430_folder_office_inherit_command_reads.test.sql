-- @fixture 639_folder_core_views.test.sql until "-- A run box: opened by its run"
-- A command that outlived its run (20260930491000; F3 step 4, slice 4d-4e: deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md):
-- before a shell command's output reaches another run, the office has that run take in the command's view's reads.
-- The run is the one the reading action's receipt names; the receipt is the inherit id. Command rows and the screen's
-- records of actions are built by hand (981's and 870's helpers); the office, screen and helpers are 639's.

-- 870's: the statement fails with this SQLSTATE (and message).
create function pg_temp.refused(p_sql text, p_state text, p_message text default null) returns void language plpgsql as $$
begin
	begin execute p_sql;
	exception when others then
		if sqlstate = p_state and (p_message is null or sqlerrm = p_message) then return; end if;
		raise exception 'Expected SQLSTATE % (%), got %: %', p_state, p_message, sqlstate, sqlerrm;
	end;
	raise exception 'Expected SQLSTATE % (%), but it succeeded: %', p_state, p_message, p_sql;
end $$;
-- 981's: a start's row as the native operation's begin makes it, keyed by its receipt; the command ends; its view; its
-- final change set, which closes the view.
create function pg_temp.command(p_run jsonb) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_office_shell_commands(id, receipt_id, office_id, computer_generation, screen_id, screen_generation,
		staff_agent_id, run_id, requested_by_user_id, conversation_run_id, command, network, started_at, worked_at)
	select v_id, v_id, '63900000-0000-4000-8000-0000000000e0', 1, '63900000-0000-4000-8000-0000000000e4', 1, r.staff_agent_id, r.id,
		r.requested_by_user_id, r.id, 'make', false, clock_timestamp(), clock_timestamp()
	from public.qorpera_execution_runs r where r.id = (p_run ->> 'runId')::uuid;
	set local session_replication_role = origin;
	return v_id;
end $$;
create function pg_temp.ended(p_command uuid) returns void language sql as $$
	select pg_temp.fx(format('update public.qorpera_runtime_office_shell_commands set ended_at = clock_timestamp(), end_reason = %L
		where id = %L', 'exited', p_command))
$$;
create function pg_temp.open_command(p_command uuid) returns jsonb language sql as $$
	select pg_temp.open('computer_shell_command', jsonb_build_object('shellCommandId', p_command))
$$;
create function pg_temp.final(p_view jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_units);
	return public.qorpera_folder_commit('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view) || '{"final":true}', p_key, p_units);
end $$;
-- 870's pg_temp.started: the screen's record of a run's action (its effect receipt), as admission writes it. The receipt
-- rows themselves are not needed here, so foreign keys are off while it goes in.
create function pg_temp.action(p_run jsonb, p_screen uuid default '63900000-0000-4000-8000-0000000000e4',
	p_receipt uuid default extensions.gen_random_uuid()) returns uuid language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_office_resources(office_id, screen_id, receipt_id, run_id, native_binding, screen_lease,
		input_sha256, downstream_idempotency_sha256, state, expires_at)
	values ('63900000-0000-4000-8000-0000000000e0', p_screen, p_receipt, (p_run ->> 'runId')::uuid, '{}', '{}', repeat('a', 64),
		repeat('b', 64), 'active', clock_timestamp() + interval '5 minutes');
	set local session_replication_role = origin;
	return p_receipt;
end $$;
-- The view releases what it read of a path (639's release).
create function pg_temp.release(p_view jsonb, p_path text) returns void language plpgsql as $$
declare e jsonb := public.qorpera_folder_read('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_path) -> 'entry';
begin
	perform public.qorpera_folder_record_release('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view),
		extensions.gen_random_uuid(), jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version',
		'authority', e -> 'authority')), repeat('5', 64));
end $$;
create function pg_temp.inherit(p_command uuid, p_receipt uuid, p_env uuid default '63200000-0000-4000-8000-000000000020')
returns jsonb language sql as $$
	select public.qorpera_folder_office_inherit_command_reads(p_env, p_command, p_receipt)
$$;
create function pg_temp.inherit_refused(p_command uuid, p_receipt uuid, p_state text, p_message text,
	p_env uuid default '63200000-0000-4000-8000-000000000020') returns void language sql as $$
	select pg_temp.refused(format('select pg_temp.inherit(%L, %L, %L)', p_command, p_receipt, p_env), p_state, p_message)
$$;
create function pg_temp.expect_inherit(p_result jsonb, p_receipt uuid, p_view jsonb, p_reads integer, p_replay boolean)
returns void language plpgsql as $$
begin
	if p_result is distinct from jsonb_build_object('schema', 'qorpera.folder-inherit/v1', 'inheritId', p_receipt,
		'viewId', p_view ->> 'viewId', 'reads', p_reads, 'replay', p_replay) then
		raise exception 'Expected % reads for receipt % (replay %), got %', p_reads, p_receipt, p_replay, p_result; end if;
end $$;


-- The platform's alone: a security definer with an empty search path, not owned by an API role, that no API role but
-- the service may run, and that refuses any other caller's claims.
do $$
declare f constant text := 'public.qorpera_folder_office_inherit_command_reads(uuid,uuid,uuid)'; r name; p pg_proc%rowtype;
begin
	select * into p from pg_proc where oid = f::regprocedure;
	if not p.prosecdef or p.proconfig is distinct from array['search_path=""']
		or pg_get_userbyid(p.proowner) in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
		raise exception 'The wrapper is a security definer with an empty search path and no API owner'; end if;
	foreach r in array array['public', 'anon', 'authenticated', 'qorpera_secret_broker']::name[] loop
		if has_function_privilege(r, f, 'EXECUTE') then raise exception '% may run the wrapper', r; end if;
	end loop;
	if not has_function_privilege('service_role', f, 'EXECUTE') then raise exception 'The service runs the wrapper'; end if;
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.inherit_refused(extensions.gen_random_uuid(), extensions.gen_random_uuid(), '42501', 'Folder core authority is required');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;


-- A command started by run v outlives it: the next run's action on the screen takes in what the command's view
-- released. The action's retry replays, and each new action checks the view's whole read set but copies only what the
-- view released since (20260930498000), also after the command ended and its final closed the view. The reading run
-- gets the read set and the records; a run that reads first after the close gets them all.
do $$
declare
	v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); v2 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	v3 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	c uuid; s jsonb; k uuid; k2 uuid; k3 uuid; k4 uuid;
begin
	perform pg_temp.hold(v);
	c := pg_temp.command(v);
	s := pg_temp.open_command(c);
	perform pg_temp.release(s, 'shared/a.txt');
	perform pg_temp.hold(v2);
	k := pg_temp.action(v2);
	perform pg_temp.expect_inherit(pg_temp.inherit(c, k), k, s, 1, false);
	if not exists (select 1 from public.qorpera_folder_run_reads where run_id = (v2 ->> 'runId')::uuid)
		or not exists (select 1 from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.run_id = (v2 ->> 'runId')::uuid and rec.release_id = k and x ->> 'path' = 'shared/a.txt')
		or not exists (select 1 from public.qorpera_folder_run_inheritances i
			where i.run_id = (v2 ->> 'runId')::uuid and i.inherit_id = k and i.view_id = (s ->> 'viewId')::uuid) then
		raise exception 'The reading run takes in the read set and the records'; end if;
	perform pg_temp.expect_inherit(pg_temp.inherit(c, k), k, s, 1, true);
	perform pg_temp.release(s, 'QorperaOS/rules/tone.txt');
	k2 := pg_temp.action(v2);
	perform pg_temp.expect_inherit(pg_temp.inherit(c, k2), k2, s, 2, false);
	if not exists (select 1 from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.run_id = (v2 ->> 'runId')::uuid and rec.release_id = k2 and x ->> 'path' = 'QorperaOS/rules/tone.txt')
		or exists (select 1 from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.run_id = (v2 ->> 'runId')::uuid and rec.release_id = k2 and x ->> 'path' = 'shared/a.txt') then
		raise exception 'A new action copies only what the view released since'; end if;
	perform pg_temp.expect_inherit(pg_temp.inherit(c, k), k, s, 1, true);
	perform pg_temp.ended(c);
	perform pg_temp.final(s, 'outlived-final', '[]');
	if (select v.state from public.qorpera_folder_views v where v.id = (s ->> 'viewId')::uuid) is distinct from 'closed' then
		raise exception 'The final closes the view'; end if;
	k3 := pg_temp.action(v2);
	perform pg_temp.expect_inherit(pg_temp.inherit(c, k3), k3, s, 2, false);
	if exists (select 1 from public.qorpera_folder_run_read_records where run_id = (v2 ->> 'runId')::uuid and release_id = k3) then
		raise exception 'An action with nothing new copies nothing'; end if;
	perform pg_temp.hold(v3);
	k4 := pg_temp.action(v3);
	perform pg_temp.expect_inherit(pg_temp.inherit(c, k4), k4, s, 2, false);
	if (select count(*) from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
		where rec.run_id = (v3 ->> 'runId')::uuid and rec.release_id = k4 and x ->> 'path' in ('shared/a.txt', 'QorperaOS/rules/tone.txt')) <> 2 then
		raise exception 'A closed view''s reads are taken in'; end if;
end $$;


-- Refusals. Invalid: a missing id. Not current: an unknown command or action, a command with no view, the command's
-- own start, an action on another screen, another environment. The reading run's job not leased. The take-in's own:
-- a run of another member or of agent B, the pause, a read the run can no longer read.
do $$
declare
	c_env constant uuid := '63200000-0000-4000-8000-000000000020'; c_profile constant uuid := '63200000-0000-4000-8000-000000000010';
	v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); v2 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	v3 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	c uuid; c2 uuid; s jsonb; k uuid; n uuid;
begin
	perform pg_temp.hold(v);
	c := pg_temp.command(v);
	s := pg_temp.open_command(c);
	perform pg_temp.release(s, 'shared/a.txt');
	k := pg_temp.action(v2);
	perform pg_temp.inherit_refused(c, k, '22023', 'Folder inheritance is invalid', null);
	perform pg_temp.inherit_refused(null, k, '22023', 'Folder inheritance is invalid');
	perform pg_temp.inherit_refused(c, null, '22023', 'Folder inheritance is invalid');
	perform pg_temp.expect_inherit(pg_temp.inherit(c, k), k, s, 1, false);
	perform pg_temp.inherit_refused(extensions.gen_random_uuid(), k, '42501', 'Folder inheritance read is not current');
	perform pg_temp.inherit_refused(c, extensions.gen_random_uuid(), '42501', 'Folder inheritance read is not current');
	c2 := pg_temp.command(v);
	perform pg_temp.inherit_refused(c2, k, '42501', 'Folder inheritance read is not current');
	perform pg_temp.action(v, p_receipt => c);
	perform pg_temp.inherit_refused(c, c, '42501', 'Folder inheritance read is not current');
	-- Agent B's screen in the same office.
	perform pg_temp.fx('insert into public.qorpera_runtime_office_screens(id, office_id, ordinal, staff_agent_id, generation, epoch, power)
		values (''63900000-0000-4000-8000-0000000000e5'', ''63900000-0000-4000-8000-0000000000e0'', 2,
			''63200000-0000-4000-8000-0000000000a2'', 1, 1, ''open'')');
	perform pg_temp.inherit_refused(c, pg_temp.action(v2, '63900000-0000-4000-8000-0000000000e5'), '42501',
		'Folder inheritance read is not current');
	perform pg_temp.inherit_refused(c, k, '42501', 'Folder inheritance read is not current', '63200000-0000-4000-8000-000000000021');
	-- The reading run's job lapsed: no actor, and no replay either.
	n := pg_temp.action(v3);
	perform pg_temp.expect_inherit(pg_temp.inherit(c, n), n, s, 1, false);
	perform pg_temp.fx(format('update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval ''1 second'' where id = %L',
		v3 ->> 'jobId'));
	perform pg_temp.inherit_refused(c, n, '42501', 'Run is unavailable');
	perform pg_temp.inherit_refused(c, pg_temp.action(v3), '42501', 'Run is unavailable');
	-- Another member's run of agent A, and agent B's run of the same member.
	perform pg_temp.inherit_refused(c, pg_temp.action(pg_temp.run('human', '63200000-0000-4000-8000-000000000004')), '42501',
		'A run inherits only its own agent''s and member''s views');
	perform pg_temp.inherit_refused(c, pg_temp.action(pg_temp.agent_b('63200000-0000-4000-8000-000000000002')), '42501',
		'A run inherits only its own agent''s and member''s views');
	-- The pause refuses a new action; an action already taken in replays.
	perform pg_temp.fx(format('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values (%L, %L, %L)',
		c_profile, '63200000-0000-4000-8000-000000000001', 'test'));
	perform pg_temp.inherit_refused(c, pg_temp.action(v2), '55000', 'Company execution is paused');
	perform pg_temp.expect_inherit(pg_temp.inherit(c, k), k, s, 1, true);
	perform pg_temp.fx(format('delete from public.qorpera_company_execution_pauses where profile_id = %L', c_profile));
	-- shared/ narrows to a resource agent A holds no grant on: what the view read is no longer the run's to read.
	perform public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'shared', 'subtree', 'company_shared', 'normal');
	perform pg_temp.inherit_refused(c, pg_temp.action(v2), '42501', 'A released read is no longer readable');
	perform pg_temp.expect_inherit(pg_temp.inherit(c, k), k, s, 1, true);
end $$;
