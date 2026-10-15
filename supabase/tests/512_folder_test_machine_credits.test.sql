-- @fixture 510_folder_test_machine_views.test.sql until "-- The migration's marker is in every function it patches"
-- Credits per unit on a test machine's view (20260930421000; F3 step 6, slice 6a-2:
-- deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md, RUNTIME-COMPANY-FOLDER-C1B.md "C1b-3: views" §8). A unit may name
-- the machine commands whose work it holds. A credited command that no longer runs on the view's machine and placement
-- refuses its unit (command_ended); each credited command's agent and member are checked in the starter's place, and a
-- unit without credits is checked for the starter. The commit acts as the first valid command by start: its agent, its
-- member and its run while the run's job is leased; the commit row lists every valid command in start order. A command
-- that ends while the commit waits for the anchor refuses the commit. The true race needs a second connection and is
-- not run here: a test trigger ends the command inside the commit instead, after the units are decided. The office,
-- machine, run and view helpers are 510's, 639's and 632's.

-- A command on the anchor's machine and placement, from the run (its agent and requester), started at p_started.
create function pg_temp.cmd(p_anchor jsonb, p_run jsonb, p_started timestamptz) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head, notify,
		started_at, sent_at, requested_by_user_id)
	select v_id, (p_anchor ->> 'companyMachineId')::uuid, r.id, r.staff_agent_id, (p_anchor ->> 'placementId')::uuid, 'npm test', false,
		p_started, p_started, r.requested_by_user_id
	from public.qorpera_execution_runs r where r.id = (p_run ->> 'runId')::uuid;
	set local session_replication_role = origin;
	return v_id;
end $$;
create function pg_temp.end_cmd(p_id uuid) returns void language sql as $$
	select pg_temp.fx(format('update public.qorpera_company_machine_commands set ended_at = clock_timestamp(), state = ''succeeded'',
		exit_code = 0 where id = %L', p_id))
$$;
-- A mkdir that credits the commands.
create function pg_temp.mk(p_path text, variadic p_credits uuid[] default null) returns jsonb language sql as $$
	select jsonb_build_object('op','mkdir','path',p_path) || case when p_credits is null then '{}'::jsonb
		else jsonb_build_object('credits', to_jsonb(p_credits)) end
$$;
create function pg_temp.found(p_path text) returns boolean language sql as $$
	select (pg_temp.read(p_path) ->> 'found')::boolean
$$;

-- The migration's marker is in the commit; a commit row's credits are a non-empty list on a test machine's commit.
do $$
begin
	if strpos(pg_get_functiondef('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure), '20260930421000') = 0 then
		raise exception 'The commit has no marker 20260930421000'; end if;
	if (select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.qorpera_folder_commits'::regclass
			and attname = 'credits' and not attisdropped) is distinct from 'uuid[]' then
		raise exception 'A commit has no credits uuid[]'; end if;
	if not exists (select 1 from pg_constraint where conrelid = 'public.qorpera_folder_commits'::regclass
			and conname = 'qorpera_folder_commits_credits') then
		raise exception 'A commit''s credits have no check'; end if;
end $$;

-- Refusals: a credited command that has ended, ran on the machine's earlier placement or on another machine, or is not
-- a command refuses its unit, alone; the others save. The commit lists the valid ones and acts as the starter (the
-- first valid command is the starter's own). Without credits a commit keeps the starter and lists none.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); m uuid := pg_temp.machine(v, 'credit-refusals');
	m2 uuid := pg_temp.machine(v, 'credit-other'); a0 jsonb := pg_temp.place(m); c_old uuid; a jsonb; a2 jsonb; s jsonb; r jsonb;
	c_ok uuid; c_ended uuid; c_other uuid; c_unknown uuid := extensions.gen_random_uuid(); c public.qorpera_folder_commits%rowtype;
begin
	c_old := pg_temp.cmd(a0, v, clock_timestamp() - interval '9 minutes');
	a := pg_temp.place(m); s := pg_temp.open_machine(a);
	c_ok := pg_temp.cmd(a, v, clock_timestamp() - interval '8 minutes');
	c_ended := pg_temp.cmd(a, v, clock_timestamp() - interval '7 minutes'); perform pg_temp.end_cmd(c_ended);
	a2 := pg_temp.place(m2); c_other := pg_temp.cmd(a2, v, clock_timestamp() - interval '6 minutes');
	r := pg_temp.vcommit(s, 'cr-refusals', jsonb_build_array(pg_temp.mk('cr-ok', c_ok), pg_temp.mk('cr-ended', c_ended),
		pg_temp.mk('cr-old', c_old), pg_temp.mk('cr-other', c_other), pg_temp.mk('cr-unknown', c_unknown),
		pg_temp.mk('cr-mixed', c_ok, c_ended), pg_temp.mk('cr-none')));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'refused', 'command_ended');
	perform pg_temp.expect(r, 3, 'refused', 'command_ended'); perform pg_temp.expect(r, 4, 'refused', 'command_ended');
	perform pg_temp.expect(r, 5, 'refused', 'command_ended'); perform pg_temp.expect(r, 6, 'refused', 'command_ended');
	perform pg_temp.expect(r, 7, 'saved');
	if not pg_temp.found('cr-ok') or not pg_temp.found('cr-none') or pg_temp.found('cr-ended') or pg_temp.found('cr-mixed') then
		raise exception 'A refused credit applies nothing of its unit'; end if;
	c := pg_temp.last_commit(r);
	if c.credits is distinct from array[c_ok] or c.actor_kind is distinct from 'staff_agent'
		or c.actor_id is distinct from '63200000-0000-4000-8000-0000000000a1' or c.requester_id is distinct from '63200000-0000-4000-8000-000000000002'
		or c.run_id is distinct from (v ->> 'runId')::uuid or c.view_kind is distinct from 'test_machine' then
		raise exception 'A commit with credits of the starter''s own command: %', to_jsonb(c); end if;
	-- The check: a list of commands, only on a test machine's commit.
	perform pg_temp.violates(format('update public.qorpera_folder_commits set credits = ''{}'' where id = %L', c.id),
		'qorpera_folder_commits_credits');
	perform pg_temp.violates(format('update public.qorpera_folder_commits set credits = array[%L::uuid, null] where id = %L', c_ok, c.id),
		'qorpera_folder_commits_credits');
	perform pg_temp.violates(format('update public.qorpera_folder_commits set credits = array[%L::uuid]
		where id = (select id from public.qorpera_folder_commits where operation_key = ''views-setup'')', c_ok), 'qorpera_folder_commits_credits');
	-- Without credits: the starter, and no list.
	r := pg_temp.vcommit(s, 'cr-plain', jsonb_build_array(pg_temp.mk('cr-plain')));
	perform pg_temp.expect(r, 1, 'saved');
	c := pg_temp.last_commit(r);
	if c.credits is not null or c.run_id is distinct from (v ->> 'runId')::uuid
		or c.requester_id is distinct from '63200000-0000-4000-8000-000000000002' then
		raise exception 'A commit without credits: %', to_jsonb(c); end if;
	perform set_config('qorpera_test.credit_view', s::text, true);
	perform set_config('qorpera_test.credit_ok', c_ok::text, true);
	perform set_config('qorpera_test.credit_ended', c_ended::text, true);
	perform set_config('qorpera_test.credit_run', v::text, true);
end $$;

-- Malformed credits raise 22023 for their unit: not a list, an empty one, more than 64, an id that is not a lowercase
-- uuid string, a duplicate; credits from a view that is not a test machine's, from a run or from a member.
do $$
declare s jsonb := current_setting('qorpera_test.credit_view')::jsonb; v jsonb := current_setting('qorpera_test.credit_run')::jsonb;
	c_ok text := current_setting('qorpera_test.credit_ok'); bad jsonb; rb jsonb;
begin
	foreach bad in array array['"' || c_ok || '"', '[]', 'null', '["nope"]', '[1]', jsonb_build_array(upper(c_ok))::text,
		jsonb_build_array(c_ok, c_ok)::text,
		(select jsonb_agg(extensions.gen_random_uuid()::text) from generate_series(1, 65))::text]::jsonb[] loop
		perform pg_temp.refused(format('select pg_temp.vcommit(%L, %L, %L)', s, 'cr-bad', jsonb_build_array(pg_temp.mk('cr-bad-ok'),
			pg_temp.mk('cr-bad-ok-2', c_ok::uuid), jsonb_build_object('op','mkdir','path','cr-bad','credits',bad))), '22023',
			'Change set unit 3 is invalid');
	end loop;
	-- 64 distinct ids are well formed (none of them runs here).
	perform pg_temp.expect(pg_temp.vcommit(s, 'cr-64', jsonb_build_array(jsonb_build_object('op','mkdir','path','cr-64',
		'credits',(select jsonb_agg(extensions.gen_random_uuid()::text) from generate_series(1, 64)))))), 1, 'refused', 'command_ended');
	rb := pg_temp.open('run_box', '{}', v);
	perform pg_temp.refused(format('select pg_temp.vcommit(%L, %L, %L)', rb, 'cr-run-box', jsonb_build_array(pg_temp.mk('cr-rb-ok'),
		pg_temp.mk('cr-rb', c_ok::uuid))), '22023', 'Change set unit 2 is invalid');
	perform pg_temp.refused(format('select pg_temp.commit(%L, %L, %L)', v, 'cr-run', jsonb_build_array(pg_temp.mk('cr-run', c_ok::uuid))),
		'22023', 'Change set unit 1 is invalid');
	perform pg_temp.refused(format('select pg_temp.commit(%L, %L, %L)', pg_temp.member(2), 'cr-member',
		jsonb_build_array(pg_temp.mk('cr-member', c_ok::uuid))), '22023', 'Change set unit 1 is invalid');
	perform public.qorpera_folder_view_close((rb ->> 'viewId')::uuid, rb ->> 'pass');
end $$;

-- The race guard, without the race: the trigger ends the named command once the commit row is written, after the
-- credits were read and before the units are decided. A saved unit's ended command refuses the commit; a refused
-- unit's does not.
create function public.qorpera_test_end_credited() returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if coalesce(current_setting('qorpera_test.race_cmd', true), '') <> '' then
		update public.qorpera_company_machine_commands set ended_at = clock_timestamp(), state = 'succeeded', exit_code = 0
		where id = current_setting('qorpera_test.race_cmd')::uuid;
	end if;
	return null;
end $$;
create trigger qorpera_test_end_credited after insert on public.qorpera_folder_commits
	for each row execute function public.qorpera_test_end_credited();
do $$
declare s jsonb := current_setting('qorpera_test.credit_view')::jsonb; c_ok uuid := current_setting('qorpera_test.credit_ok')::uuid;
	c_ended uuid := current_setting('qorpera_test.credit_ended')::uuid; r jsonb; c public.qorpera_folder_commits%rowtype;
begin
	perform set_config('qorpera_test.race_cmd', c_ok::text, true);
	perform pg_temp.refused(format('select pg_temp.vcommit(%L, %L, %L)', s, 'cr-race', jsonb_build_array(pg_temp.mk('cr-race', c_ok),
		pg_temp.mk('cr-race-none'))), '42501', 'Folder view command has ended');
	if exists (select 1 from public.qorpera_company_machine_commands where id = c_ok and ended_at is not null) or pg_temp.found('cr-race') then
		raise exception 'A refused commit keeps nothing'; end if;
	r := pg_temp.vcommit(s, 'cr-race-refused', jsonb_build_array(pg_temp.mk('cr-race-mixed', c_ok, c_ended), pg_temp.mk('cr-race-plain')));
	perform pg_temp.expect(r, 1, 'refused', 'command_ended'); perform pg_temp.expect(r, 2, 'saved');
	perform set_config('qorpera_test.race_cmd', '', true);
	if not exists (select 1 from public.qorpera_company_machine_commands where id = c_ok and ended_at is not null) then
		raise exception 'The trigger ended the command'; end if;
	c := pg_temp.last_commit(r);
	if c.credits is distinct from array[c_ok] then raise exception 'A refused unit''s valid credit is listed: %', to_jsonb(c); end if;
	perform public.qorpera_folder_view_close((s ->> 'viewId')::uuid, s ->> 'pass');
end $$;
drop trigger qorpera_test_end_credited on public.qorpera_folder_commits;
drop function public.qorpera_test_end_credited();

-- Authority per credited command: each command's agent and member in the starter's place. A unit is denied when one
-- credited agent may not write (no grants, or off staff) or one credited member may not (a viewer); a unit without
-- credits is checked for the starter, also when the commit acts as a command of a viewer.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); m uuid := pg_temp.machine(v, 'credit-authority');
	a jsonb := pg_temp.place(m); s jsonb := pg_temp.open_machine(a);
	vb jsonb := pg_temp.agent_b('63200000-0000-4000-8000-000000000002'); vv jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000003');
	c_a uuid; c_b uuid; c_v uuid; c_v0 uuid; r jsonb; c public.qorpera_folder_commits%rowtype;
begin
	c_a := pg_temp.cmd(a, v, clock_timestamp() - interval '8 minutes');
	c_b := pg_temp.cmd(a, vb, clock_timestamp() - interval '7 minutes');
	c_v := pg_temp.cmd(a, vv, clock_timestamp() - interval '6 minutes');
	r := pg_temp.vcommit(s, 'cr-auth-1', jsonb_build_array(pg_temp.mk('cr-auth-1', c_b, c_a)));
	perform pg_temp.expect(r, 1, 'saved');
	c := pg_temp.last_commit(r);
	if c.credits is distinct from array[c_a, c_b] or c.run_id is distinct from (v ->> 'runId')::uuid then
		raise exception 'Two agents'' credits: %', to_jsonb(c); end if;
	-- Agent B off staff: its credits deny their unit.
	perform pg_temp.fx('update public.qorpera_profile_staff set employment_status = ''archived''
		where staff_agent_id = ''63200000-0000-4000-8000-0000000000a2''');
	r := pg_temp.vcommit(s, 'cr-auth-2', jsonb_build_array(pg_temp.mk('cr-auth-2a', c_a, c_b), pg_temp.mk('cr-auth-2b', c_a)));
	perform pg_temp.expect(r, 1, 'denied', 'denied'); perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.fx('update public.qorpera_profile_staff set employment_status = ''active''
		where staff_agent_id = ''63200000-0000-4000-8000-0000000000a2''');
	-- Agent B without grants; a viewer's command.
	perform pg_temp.fx('update public.qorpera_company_path_grants set revoked_at = clock_timestamp() where principal_kind = ''staff_agent''
		and principal_id = ''63200000-0000-4000-8000-0000000000a2'' and revoked_at is null');
	r := pg_temp.vcommit(s, 'cr-auth-3', jsonb_build_array(pg_temp.mk('cr-auth-3a', c_a, c_b), pg_temp.mk('cr-auth-3b', c_a),
		pg_temp.mk('cr-auth-3c', c_a, c_v), pg_temp.mk('cr-auth-3d')));
	perform pg_temp.expect(r, 1, 'denied', 'denied'); perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.expect(r, 3, 'denied', 'denied'); perform pg_temp.expect(r, 4, 'saved');
	c := pg_temp.last_commit(r);
	if c.credits is distinct from array[c_a, c_b, c_v] or c.requester_id is distinct from '63200000-0000-4000-8000-000000000002' then
		raise exception 'Credits of three commands: %', to_jsonb(c); end if;
	-- The viewer's command started first: the commit acts as it (agent A for the viewer, through its run), and the unit
	-- without credits is still the starter's.
	c_v0 := pg_temp.cmd(a, vv, clock_timestamp() - interval '20 minutes');
	r := pg_temp.vcommit(s, 'cr-auth-4', jsonb_build_array(pg_temp.mk('cr-auth-4a', c_v0), pg_temp.mk('cr-auth-4b')));
	perform pg_temp.expect(r, 1, 'denied', 'denied'); perform pg_temp.expect(r, 2, 'saved');
	c := pg_temp.last_commit(r);
	if c.credits is distinct from array[c_v0] or c.actor_id is distinct from '63200000-0000-4000-8000-0000000000a1'
		or c.requester_id is distinct from '63200000-0000-4000-8000-000000000003' or c.run_id is distinct from (vv ->> 'runId')::uuid then
		raise exception 'A commit as a viewer''s command: %', to_jsonb(c); end if;
	perform public.qorpera_folder_view_close((s ->> 'viewId')::uuid, s ->> 'pass');
end $$;

-- Two overlapping commands: the commit acts as the one that started first (its member, and its run while leased, with
-- none of the starter's wake, routine or sponsor), and lists both in start order. Once that run's job lapses the
-- commit has no run.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); m uuid := pg_temp.machine(v, 'credit-overlap');
	a jsonb := pg_temp.place(m); s jsonb := pg_temp.open_machine(a); w jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000004');
	c_first uuid; c_second uuid; r jsonb; c public.qorpera_folder_commits%rowtype;
begin
	c_first := pg_temp.cmd(a, w, clock_timestamp() - interval '10 minutes');
	c_second := pg_temp.cmd(a, v, clock_timestamp() - interval '5 minutes');
	r := pg_temp.vcommit(s, 'cr-overlap-1', jsonb_build_array(pg_temp.mk('cr-overlap-1', c_second, c_first)));
	perform pg_temp.expect(r, 1, 'saved');
	c := pg_temp.last_commit(r);
	if c.credits is distinct from array[c_first, c_second] or c.actor_kind is distinct from 'staff_agent'
		or c.actor_id is distinct from '63200000-0000-4000-8000-0000000000a1' or c.requester_id is distinct from '63200000-0000-4000-8000-000000000004'
		or c.run_id is distinct from (w ->> 'runId')::uuid or c.session_kind is distinct from 'in_house'
		or c.causal_wake_id is not null or c.routine_id is not null or c.sponsor_binding_id is not null
		or c.view_id is distinct from (s ->> 'viewId')::uuid then
		raise exception 'A commit as the first command: %', to_jsonb(c); end if;
	perform pg_temp.lapse(w);
	r := pg_temp.vcommit(s, 'cr-overlap-2', jsonb_build_array(pg_temp.mk('cr-overlap-2', c_first, c_second)));
	perform pg_temp.expect(r, 1, 'saved');
	c := pg_temp.last_commit(r);
	if c.credits is distinct from array[c_first, c_second] or c.run_id is not null
		or c.requester_id is distinct from '63200000-0000-4000-8000-000000000004' or c.actor_kind is distinct from 'staff_agent' then
		raise exception 'A commit as the first command after its run: %', to_jsonb(c); end if;
	perform public.qorpera_folder_view_close((s ->> 'viewId')::uuid, s ->> 'pass');
end $$;
