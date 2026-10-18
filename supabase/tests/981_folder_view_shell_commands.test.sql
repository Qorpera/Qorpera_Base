-- @fixture 639_folder_core_views.test.sql until "-- A run box: opened by its run"
-- Shell command views (20260930183000; F3 step 4, slice 4b: deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md), which
-- build C1b-3b (RUNTIME-COMPANY-FOLDER-C1B.md "C1b-3: views" §8): a command's own view, opened by the platform while
-- the command's run holds the screen, for a networked command as for an offline one (20260930342000, slice 4b-2). It acts through the run while the run's job is leased, then as the agent,
-- company-wide as a desktop; it stands through the command's end for one final publish, which closes it. Command rows
-- are built by hand, as the native operation's begin makes them (870 and 910 test that). The office, screen and
-- helpers are 639's.

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
-- A fixture change (632's pg_temp.fx) that breaks the named constraint or unique index.
create function pg_temp.violates(p_sql text, p_constraint text) returns void language plpgsql as $$
declare v_name text;
begin
	begin perform pg_temp.fx(p_sql);
	exception when integrity_constraint_violation then
		get stacked diagnostics v_name = constraint_name;
		if v_name = p_constraint then return; end if;
		raise exception 'Expected % to refuse, got %: %', p_constraint, v_name, sqlerrm;
	end;
	raise exception 'Expected % to refuse, but it succeeded: %', p_constraint, p_sql;
end $$;
-- A start's row as the native operation's begin makes it: keyed by its receipt, in the office's and the screen's
-- generation (1), for the run's agent and member; the guest has not named it yet (command_id null).
create function pg_temp.command(p_run jsonb, p_network boolean default false) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_office_shell_commands(id, receipt_id, office_id, computer_generation, screen_id, screen_generation,
		staff_agent_id, run_id, requested_by_user_id, conversation_run_id, command, network, started_at, worked_at)
	select v_id, v_id, '63900000-0000-4000-8000-0000000000e0', 1, '63900000-0000-4000-8000-0000000000e4', 1, r.staff_agent_id, r.id,
		r.requested_by_user_id, r.id, 'make', p_network, clock_timestamp(), clock_timestamp()
	from public.qorpera_execution_runs r where r.id = (p_run ->> 'runId')::uuid;
	set local session_replication_role = origin;
	return v_id;
end $$;
-- The office reports the command ended.
create function pg_temp.ended(p_command uuid) returns void language sql as $$
	select pg_temp.fx(format('update public.qorpera_runtime_office_shell_commands set ended_at = clock_timestamp(), end_reason = %L
		where id = %L', 'exited', p_command))
$$;
create function pg_temp.open_command(p_command uuid) returns jsonb language sql as $$
	select pg_temp.open('computer_shell_command', jsonb_build_object('shellCommandId', p_command))
$$;
create function pg_temp.not_current(p_command uuid) returns void language sql as $$
	select pg_temp.refused(format('select pg_temp.open_command(%L)', p_command), '42501', 'Folder view command is not current')
$$;
-- The command's last change set: the view actor says "final" (C1B §8). Possession is the view's, as for vcommit.
create function pg_temp.final(p_view jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_units);
	return public.qorpera_folder_commit('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view) || '{"final":true}', p_key, p_units);
end $$;
create function pg_temp.view_row(p_view jsonb) returns public.qorpera_folder_views language sql as $$
	select * from public.qorpera_folder_views where id = (p_view ->> 'viewId')::uuid
$$;


-- The migration's marker is in every function it patches and in the new one, and 20260930342000's in the open; the
-- starting check is internal and the open is still the service's alone. A command's row is keyed by its start's receipt.
do $$
declare f regprocedure; r name;
	v_starting text := 'public.qorpera_office_shell_command_starting(public.qorpera_runtime_office_shell_commands,timestamptz)';
begin
	foreach f in array array['public.qorpera_native_office_operation(jsonb,jsonb,jsonb,text,text,uuid,text)',
		'public.qorpera_valid_office_shell_action(jsonb)', 'public.qorpera_report_runtime_office_shell_activity(jsonb,bigint,jsonb)',
		'public.qorpera_take_agent_computer_stopped(public.qorpera_execution_runs)', v_starting,
		'public.qorpera_folder_view_valid(public.qorpera_folder_views)', 'public.qorpera_folder_view_live_run(public.qorpera_folder_views)',
		'public.qorpera_folder_view_resolve(uuid,uuid,jsonb)', 'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)',
		'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)']::regprocedure[] loop
		if strpos(pg_get_functiondef(f), '20260930183000') = 0 then raise exception '% has no marker 20260930183000', f; end if;
	end loop;
	if strpos(pg_get_functiondef('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure), '20260930342000') = 0 then
		raise exception 'view open has no marker 20260930342000'; end if;
	foreach r in array array['anon','authenticated','service_role','qorpera_secret_broker']::name[] loop
		if has_function_privilege(r, v_starting, 'EXECUTE') then raise exception '% may run the starting check', r; end if;
	end loop;
	if has_function_privilege('authenticated', 'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)', 'EXECUTE') then
		raise exception 'view open''s privileges changed'; end if;
	perform pg_temp.violates(format('insert into public.qorpera_runtime_office_shell_commands(id, receipt_id, office_id,
		computer_generation, screen_id, staff_agent_id, run_id, conversation_run_id, command, started_at, worked_at)
		values (%L, %L, %L, 1, %L, %L, %L, %L, %L, clock_timestamp(), clock_timestamp())', extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), '63900000-0000-4000-8000-0000000000e0', '63900000-0000-4000-8000-0000000000e4',
		'63200000-0000-4000-8000-0000000000a1', extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'make'),
		'qorpera_runtime_office_shell_commands_start');
end $$;


-- The open: the platform's, for a command that has not ended, offline or networked, while its run holds the screen in
-- the screen's and the office's generation the command started in, privacy is shared and the command has no view yet.
-- The anchor is the command's row and nothing else.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); v2 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	c uuid; c2 uuid; s jsonb; s2 jsonb; d jsonb; w public.qorpera_folder_views%rowtype; f text; n boolean;
begin
	perform pg_temp.hold(v);
	c := pg_temp.command(v);
	perform pg_temp.refused(format('select pg_temp.open(%L, %L)', 'computer_shell_command', '{}'), '22023', 'Folder view anchor is invalid');
	perform pg_temp.refused(format('select pg_temp.open(%L, %L)', 'computer_shell_command', jsonb_build_object('shellCommandId', c,
		'screenId', '63900000-0000-4000-8000-0000000000e4')), '22023', 'Folder view anchor is invalid');
	perform pg_temp.refused(format('select pg_temp.open(%L, %L)', 'computer_shell_command', jsonb_build_object('shellCommandId',
		upper(c::text))), '22023', 'Folder view anchor is invalid');
	perform pg_temp.refused(format('select pg_temp.open(%L, %L, %L)', 'computer_shell_command', jsonb_build_object('shellCommandId', c), v),
		'22023', 'Folder view opener is invalid');
	-- Not current: an unknown command; a row as the office's report makes it (networked, no screen generation); then
	-- each of the row's fields in turn (restored after each).
	perform pg_temp.not_current(extensions.gen_random_uuid());
	foreach f in array array['network = true, screen_generation = null', 'ended_at = clock_timestamp(), end_reason = ''exited''', 'screen_generation = 2',
		'computer_generation = 2', 'staff_agent_id = ''63200000-0000-4000-8000-0000000000a2''', format('run_id = %L', v2 ->> 'runId')] loop
		perform pg_temp.fx(format('update public.qorpera_runtime_office_shell_commands set %s where id = %L', f, c));
		perform pg_temp.not_current(c);
		perform pg_temp.fx(format('update public.qorpera_runtime_office_shell_commands set network = false, ended_at = null,
			end_reason = null, screen_generation = 1, computer_generation = 1, staff_agent_id = %L, run_id = %L where id = %L',
			'63200000-0000-4000-8000-0000000000a1', v ->> 'runId', c));
	end loop;
	-- The screen: another run's lease, a lapsed lease, a drain, a private sign-in; and another folder of the company.
	perform pg_temp.hold(v2);
	perform pg_temp.not_current(c);
	perform pg_temp.hold(v);
	perform pg_temp.fx('update public.qorpera_runtime_office_screens set lease_expires_at = clock_timestamp() - interval ''1 second''
		where id = ''63900000-0000-4000-8000-0000000000e4''');
	perform pg_temp.not_current(c);
	perform pg_temp.hold(v);
	perform pg_temp.fx('update public.qorpera_runtime_office_screens set drain_pending = true, drain_id = extensions.gen_random_uuid()
		where id = ''63900000-0000-4000-8000-0000000000e4''');
	perform pg_temp.not_current(c);
	perform pg_temp.fx('update public.qorpera_runtime_office_screens set drain_pending = false, drain_id = null
		where id = ''63900000-0000-4000-8000-0000000000e4''');
	perform pg_temp.fx('update public.qorpera_runtime_offices set privacy_state = ''private'', privacy_challenge = jsonb_build_object(''memberId'',
		''63200000-0000-4000-8000-000000000005'', ''screenId'', ''63900000-0000-4000-8000-0000000000e4'') where id = ''63900000-0000-4000-8000-0000000000e0''');
	perform pg_temp.not_current(c);
	perform pg_temp.fx('update public.qorpera_runtime_offices set privacy_state = ''shared'', privacy_challenge = null
		where id = ''63900000-0000-4000-8000-0000000000e0''');
	perform pg_temp.refused(format('select public.qorpera_folder_view_open(%L, %L, %L, %L)', '63200000-0000-4000-8000-000000000021',
		'{"kind":"platform"}', 'computer_shell_command', jsonb_build_object('shellCommandId', c)), '42501', 'Folder view command is not current');
	-- The computer: revoked access, a new activation.
	perform pg_temp.fx('update public.qorpera_runtime_office_access set state = ''revoked'' where office_id = ''63900000-0000-4000-8000-0000000000e0''');
	perform pg_temp.refused(format('select pg_temp.open_command(%L)', c), '42501', 'Folder view computer is unavailable');
	perform pg_temp.fx('update public.qorpera_runtime_office_access set state = ''active'' where office_id = ''63900000-0000-4000-8000-0000000000e0''');
	perform pg_temp.fx('update public.qorpera_runtime_office_activations set superseded_at = clock_timestamp()
		where activation_id = ''63900000-0000-4000-8000-0000000000e3''');
	perform pg_temp.refused(format('select pg_temp.open_command(%L)', c), '42501', 'Folder view computer is unavailable');
	perform pg_temp.fx('update public.qorpera_runtime_office_activations set superseded_at = null
		where activation_id = ''63900000-0000-4000-8000-0000000000e3''');

	-- It opens, for the offline command and then for one that uses the network (20260930342000): the command's row, no
	-- screen of its own, the screen generation and activation it started under, the run's agent, member and worker
	-- access. Every check here is null-safe (`is distinct from`).
	foreach n in array array[false, true] loop
		if n then c := pg_temp.command(v, true); end if;
		if (select x.network from public.qorpera_runtime_office_shell_commands x where x.id = c) is distinct from n then
			raise exception 'The command''s network is not %', n; end if;
		s := pg_temp.open_command(c);
		-- 20260930516000 (538): and its owner, for its cache.
		if (select count(*) from jsonb_object_keys(s)) <> 5 or s ->> 'schema' is distinct from 'qorpera.folder-view/v1'
			or length(s ->> 'pass') is distinct from 43 or s ->> 'leaseUntil' is null
			or s ->> 'owner' is distinct from 'agent-63200000-0000-4000-8000-0000000000a1' then
			raise exception 'Command view open (network %): %', n, s; end if;
		w := pg_temp.view_row(s);
		if w.kind is distinct from 'computer_shell_command' or w.shell_command_id is distinct from c or w.screen_id is not null
			or w.screen_generation is distinct from 1 or w.activation_id is distinct from '63900000-0000-4000-8000-0000000000e3'
			or w.machine_id is distinct from '63900000-0000-4000-8000-0000000000e1' or w.node_id is distinct from '63900000-0000-4000-8000-0000000000e2'
			or w.staff_agent_id is distinct from '63200000-0000-4000-8000-0000000000a1'
			or w.member_user_id is distinct from '63200000-0000-4000-8000-000000000002'
			or w.worker_access is distinct from (public.qorpera_run_worker((v ->> 'runId')::uuid)).access
			or w.holder_run_id is not null or w.holder_user_id is not null or w.run_id is not null or w.state is distinct from 'open' then
			raise exception 'Command view row (network %): %', n, to_jsonb(w); end if;
		-- One view per command, open or closed.
		perform pg_temp.not_current(c);
		perform public.qorpera_folder_view_close((s ->> 'viewId')::uuid, s ->> 'pass');
		perform pg_temp.not_current(c);
	end loop;
	-- The screen's desktop view and a command's view stand together: neither supersedes the other.
	d := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4','holderRunId',v ->> 'runId'));
	c2 := pg_temp.command(v);
	s2 := pg_temp.open_command(c2);
	if (pg_temp.view_row(d)).state is distinct from 'open' or (pg_temp.view_row(s2)).state is distinct from 'open' then
		raise exception 'A desktop view and a command view stand together'; end if;
	-- The table's rules: a command view has no screen; only a command view names a command; a test machine view names
	-- its machine (20260930420000); one view per command.
	perform pg_temp.violates(format('update public.qorpera_folder_views set screen_id = %L where id = %L',
		'63900000-0000-4000-8000-0000000000e4', s2 ->> 'viewId'), 'qorpera_folder_views_shell_command');
	perform pg_temp.violates(format('update public.qorpera_folder_views set shell_command_id = %L where id = %L', c2, d ->> 'viewId'),
		'qorpera_folder_views_shell_command_kind');
	perform pg_temp.violates(format('update public.qorpera_folder_views set kind = %L where id = %L', 'test_machine', d ->> 'viewId'),
		'qorpera_folder_views_test_machine');
	perform pg_temp.violates(format('update public.qorpera_folder_views set shell_command_id = %L where id = %L', c, s2 ->> 'viewId'),
		'qorpera_folder_views_one_per_command');
	perform public.qorpera_folder_view_close((d ->> 'viewId')::uuid, d ->> 'pass');
	perform public.qorpera_folder_view_close((s2 ->> 'viewId')::uuid, s2 ->> 'pass');
end $$;


-- While its run's job is leased, a command view acts through the run within the company-wide view, as a desktop's:
-- secret/ (agent A's grant only) and rules/ refuse its writes, and it reads what the company-wide view reads. Once
-- the job's lease lapses it is detached: it saves as the agent, for the run's member, in house.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); c uuid; s jsonb; r jsonb;
	m public.qorpera_folder_commits%rowtype; a jsonb := pg_temp.stage('epsilon');
begin
	perform pg_temp.hold(v);
	c := pg_temp.command(v);
	s := pg_temp.open_command(c);
	r := public.qorpera_folder_view_resolve('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-000000000010', pg_temp.vactor(s));
	if r ->> 'runId' is distinct from v ->> 'runId' or r -> 'view' ->> 'kind' is distinct from 'computer_shell_command'
		or r -> 'view' -> 'companyWide' is distinct from 'true'::jsonb or r -> 'view' -> 'runActor' is distinct from v then
		raise exception 'Live command view: %', r; end if;
	r := pg_temp.vcommit(s, 'cmd-live-1', jsonb_build_array(jsonb_build_object('op','write','path','shared/c.txt','file',a),
		jsonb_build_object('op','write','path','secret/c.txt','file',a), jsonb_build_object('op','write','path','rules/c.txt','file',a)));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'denied', 'denied'); perform pg_temp.expect(r, 3, 'denied', 'denied');
	m := pg_temp.last_commit(r);
	if m.run_id is distinct from (v ->> 'runId')::uuid or m.view_kind is distinct from 'computer_shell_command'
		or m.view_id is distinct from (s ->> 'viewId')::uuid then raise exception 'Live command commit: %', to_jsonb(m); end if;
	if (pg_temp.read('secret/s.txt', pg_temp.vactor(s)) ->> 'found')::boolean
		or not (pg_temp.read('rules/tone.txt', pg_temp.vactor(s)) ->> 'found')::boolean then
		raise exception 'The company-wide view for a command''s reads'; end if;
	-- The run's job lease lapses (the run's turn ended; the command runs on).
	perform pg_temp.fx(format('update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval ''1 second'' where id = %L',
		v ->> 'jobId'));
	r := public.qorpera_folder_view_resolve('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-000000000010', pg_temp.vactor(s));
	if r ->> 'kind' is distinct from 'staff_agent' or r ->> 'staffAgentId' is distinct from '63200000-0000-4000-8000-0000000000a1'
		or r ->> 'requesterUserId' is distinct from '63200000-0000-4000-8000-000000000002' or r ->> 'sessionKind' is distinct from 'in_house'
		or r -> 'runId' is distinct from 'null'::jsonb or r -> 'view' -> 'companyWide' is distinct from 'true'::jsonb
		or r -> 'view' -> 'turnRunActor' is distinct from 'null'::jsonb then
		raise exception 'Detached command view: %', r; end if;
	r := pg_temp.vcommit(s, 'cmd-detached-1', jsonb_build_array(jsonb_build_object('op','write','path','shared/c2.txt','file',a),
		jsonb_build_object('op','write','path','secret/c2.txt','file',a)));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'denied', 'denied');
	m := pg_temp.last_commit(r);
	if m.run_id is not null or m.actor_kind is distinct from 'staff_agent' or m.requester_id is distinct from '63200000-0000-4000-8000-000000000002'
		or m.session_kind is distinct from 'in_house' or m.view_id is distinct from (s ->> 'viewId')::uuid then
		raise exception 'Detached command commit: %', to_jsonb(m); end if;
	perform public.qorpera_folder_view_close((s ->> 'viewId')::uuid, s ->> 'pass');
end $$;


-- The end: a command view whose command has ended still renews, and saves only its final change set, which closes it.
-- A replay of the final answers as before; the same key unmarked is another change set. "final" is a boolean.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); c uuid; s jsonb; r jsonb; r2 jsonb; u jsonb;
	a jsonb := pg_temp.stage('zeta');
begin
	perform pg_temp.hold(v);
	c := pg_temp.command(v);
	s := pg_temp.open_command(c);
	perform pg_temp.refused(format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '63200000-0000-4000-8000-000000000020',
		pg_temp.vactor(s) || '{"final":"true"}', 'cmd-final-text', '[{"op":"mkdir","path":"refused"}]'), '22023', 'Folder actor is invalid');
	perform pg_temp.refused(format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '63200000-0000-4000-8000-000000000020',
		pg_temp.vactor(s) || '{"last":true}', 'cmd-final-key', '[{"op":"mkdir","path":"refused"}]'), '22023', 'Folder actor is invalid');
	perform pg_temp.expect(pg_temp.vcommit(s, 'cmd-end-running', '[{"op":"mkdir","path":"by-cmd-running"}]'), 1, 'saved');
	perform pg_temp.ended(c);
	r := public.qorpera_folder_view_renew((s ->> 'viewId')::uuid, s ->> 'pass');
	if r ->> 'state' is distinct from 'open' or r ->> 'kind' is distinct from 'computer_shell_command'
		or r ->> 'machineId' is distinct from '63900000-0000-4000-8000-0000000000e1' then
		raise exception 'An ended command''s view renews: %', r; end if;
	perform pg_temp.refused(format('select pg_temp.vcommit(%L, %L, %L)', s, 'cmd-end-after', '[{"op":"mkdir","path":"refused"}]'),
		'42501', 'Folder view command has ended');
	u := jsonb_build_array(jsonb_build_object('op','write','path','shared/final.txt','file',a),
		jsonb_build_object('op','mkdir','path','by-cmd-final'));
	r := pg_temp.final(s, 'cmd-end-final', u);
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	if r ->> 'seq' is null or (pg_temp.view_row(s)).state is distinct from 'closed' or (pg_temp.view_row(s)).close_reason is distinct from 'closed' then
		raise exception 'The final closes the view: %', r; end if;
	r2 := public.qorpera_folder_view_renew((s ->> 'viewId')::uuid, s ->> 'pass');
	if r2 is distinct from '{"schema":"qorpera.folder-view-renew/v1","state":"closed","reason":"closed"}'::jsonb then
		raise exception 'Renew after the final: %', r2; end if;
	r2 := public.qorpera_folder_commit('63200000-0000-4000-8000-000000000020', pg_temp.vactor(s) || '{"final":true}', 'cmd-end-final', u);
	if r2 -> 'replay' is distinct from 'true'::jsonb or r2 ->> 'commitId' is distinct from r ->> 'commitId' then
		raise exception 'The final''s replay: %', r2; end if;
	perform pg_temp.refused(format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '63200000-0000-4000-8000-000000000020',
		pg_temp.vactor(s), 'cmd-end-final', u), '22023', 'Operation key was used for a different change set');
	perform pg_temp.refused(format('select pg_temp.final(%L, %L, %L)', s, 'cmd-end-final-2', '[{"op":"mkdir","path":"refused"}]'),
		'42501', 'Folder view has ended');
end $$;


-- Only a command view sends a final, and a run's actor has no such key. A final that saves nothing still closes its
-- view, and so does one that carries no change (a change set that is not a final carries at least one); so does a
-- final while the command still runs.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); c uuid; s jsonb; d jsonb; r jsonb; r2 jsonb;
begin
	perform pg_temp.hold(v);
	d := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4','holderRunId',v ->> 'runId'));
	perform pg_temp.refused(format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '63200000-0000-4000-8000-000000000020',
		pg_temp.vactor(d) || '{"final":true}', 'desk-final', '[{"op":"mkdir","path":"refused"}]'), '22023',
		'Only a command or test machine view publishes a final change set');
	perform pg_temp.refused(format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '63200000-0000-4000-8000-000000000020',
		v || '{"final":true}', 'run-final', '[{"op":"mkdir","path":"refused"}]'), '22023', 'Folder actor is invalid');
	perform public.qorpera_folder_view_close((d ->> 'viewId')::uuid, d ->> 'pass');
	c := pg_temp.command(v);
	s := pg_temp.open_command(c);
	perform pg_temp.ended(c);
	r := pg_temp.final(s, 'cmd-empty-final', '[{"op":"mkdir","path":"shared"}]');
	perform pg_temp.expect(r, 1, 'conflict', 'exists');
	if r ->> 'seq' is not null or (pg_temp.view_row(s)).state is distinct from 'closed' or (pg_temp.view_row(s)).close_reason is distinct from 'closed' then
		raise exception 'A final that saves nothing closes the view: %', r; end if;
	c := pg_temp.command(v);
	s := pg_temp.open_command(c);
	perform pg_temp.refused(format('select pg_temp.vcommit(%L, %L, %L)', s, 'cmd-no-units', '[]'), '22023', 'Change set is invalid');
	perform pg_temp.ended(c);
	r := pg_temp.final(s, 'cmd-no-change-final', '[]');
	if r ->> 'commitId' is null or r -> 'seq' is distinct from 'null'::jsonb or r -> 'units' is distinct from '[]'::jsonb
		or (pg_temp.view_row(s)).state is distinct from 'closed' or (pg_temp.view_row(s)).close_reason is distinct from 'closed' then
		raise exception 'A final with no change closes the view: %', r; end if;
	r2 := pg_temp.final(s, 'cmd-no-change-final', '[]');
	if r2 -> 'replay' is distinct from 'true'::jsonb or r2 ->> 'commitId' is distinct from r ->> 'commitId'
		or r2 -> 'units' is distinct from '[]'::jsonb then
		raise exception 'The replay of a final with no change: %', r2; end if;
	c := pg_temp.command(v);
	s := pg_temp.open_command(c);
	perform pg_temp.expect(pg_temp.final(s, 'cmd-running-final', '[{"op":"mkdir","path":"by-cmd-running-final"}]'), 1, 'saved');
	if (pg_temp.view_row(s)).state is distinct from 'closed' then raise exception 'A final while the command runs closes the view'; end if;
	perform pg_temp.refused(format('select pg_temp.vcommit(%L, %L, %L)', s, 'cmd-after-final', '[{"op":"mkdir","path":"refused"}]'),
		'42501', 'Folder view has ended');
end $$;


-- Reads: while its run's job is leased, a read released through a command view lands in the view's read set and the
-- run's. Detached, the view still answers for what its run read: once the file is no longer readable to agent A (its
-- folder narrowed), the view's save refuses, as for a desktop, and so does the run's recheck
-- (qorpera_folder_run_reads_current, which qorpera_folder_assert_run_reads runs before a model request).
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); c uuid; s jsonb; e jsonb; a jsonb := pg_temp.stage('eta');
	b jsonb;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'cmd-read-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','cmd-read'),
		jsonb_build_object('op','write','path','cmd-read/r.txt','file',a))), 2, 'saved');
	perform pg_temp.hold(v);
	c := pg_temp.command(v);
	s := pg_temp.open_command(c);
	e := pg_temp.read('cmd-read/r.txt', pg_temp.vactor(s)) -> 'entry';
	perform public.qorpera_folder_record_release('63200000-0000-4000-8000-000000000020', pg_temp.vactor(s), extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')), repeat('5', 64));
	if not exists (select 1 from public.qorpera_folder_view_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.view_id = (s ->> 'viewId')::uuid and x ->> 'path' = 'cmd-read/r.txt')
		or not exists (select 1 from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.run_id = (v ->> 'runId')::uuid and x ->> 'path' = 'cmd-read/r.txt') then
		raise exception 'A live command view''s release lands in both read sets'; end if;
	-- The run as its recheck resolves it, while its job is leased.
	b := public.qorpera_folder_run_resolve('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-000000000010', v)
		- 'lockTargets' - 'attribution';
	perform public.qorpera_folder_run_reads_current('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-000000000010', b);
	perform pg_temp.fx(format('update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval ''1 second'' where id = %L',
		v ->> 'jobId'));
	perform pg_temp.expect(pg_temp.vcommit(s, 'cmd-read-before', '[{"op":"mkdir","path":"by-cmd-read"}]'), 1, 'saved');
	perform public.qorpera_folder_set_resource('63200000-0000-4000-8000-000000000020', pg_temp.member(1), 'cmd-read', 'subtree',
		'company_shared', 'normal');
	perform pg_temp.refused(format('select pg_temp.vcommit(%L, %L, %L)', s, 'cmd-read-after', '[{"op":"mkdir","path":"refused"}]'),
		'42501', 'A read is no longer readable');
	perform pg_temp.refused(format('select public.qorpera_folder_run_reads_current(%L, %L, %L)', '63200000-0000-4000-8000-000000000020',
		'63200000-0000-4000-8000-000000000010', b), '42501', 'A read is no longer readable');
end $$;


-- What its run read itself (released through the run, so in the run's read set alone): a detached command view still
-- answers for it, under the run's own authority (its agent's grants), as a detached desktop answers for its holder's.
-- The run's read of secret/ stays readable to agent A, so the detached save lands; once cmd-run/ narrows, it refuses.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); c uuid; s jsonb; a jsonb := pg_temp.stage('theta');
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'cmd-run-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','cmd-run'),
		jsonb_build_object('op','write','path','cmd-run/f.txt','file',a))), 2, 'saved');
	perform pg_temp.hold(v);
	c := pg_temp.command(v);
	s := pg_temp.open_command(c);
	perform public.qorpera_folder_record_release('63200000-0000-4000-8000-000000000020', v, extensions.gen_random_uuid(),
		(select jsonb_agg(jsonb_build_object('path', x ->> 'path', 'version', x ->> 'version', 'authority', x -> 'authority'))
			from (select pg_temp.read(f, v) -> 'entry' as x from unnest(array['cmd-run/f.txt','secret/s.txt']) f) r), repeat('6', 64));
	if exists (select 1 from public.qorpera_folder_view_read_records where view_id = (s ->> 'viewId')::uuid)
		or (select count(*) from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.run_id = (v ->> 'runId')::uuid and x ->> 'path' in ('cmd-run/f.txt','secret/s.txt')) <> 2 then
		raise exception 'The run''s own reads are in its read set alone'; end if;
	perform pg_temp.expect(pg_temp.vcommit(s, 'cmd-run-live', '[{"op":"mkdir","path":"by-cmd-run-live"}]'), 1, 'saved');
	perform pg_temp.fx(format('update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval ''1 second'' where id = %L',
		v ->> 'jobId'));
	perform pg_temp.expect(pg_temp.vcommit(s, 'cmd-run-detached', '[{"op":"mkdir","path":"by-cmd-run-detached"}]'), 1, 'saved');
	perform public.qorpera_folder_set_resource('63200000-0000-4000-8000-000000000020', pg_temp.member(1), 'cmd-run', 'subtree',
		'company_shared', 'normal');
	perform pg_temp.refused(format('select pg_temp.vcommit(%L, %L, %L)', s, 'cmd-run-after', '[{"op":"mkdir","path":"refused"}]'),
		'42501', 'A read is no longer readable');
	perform public.qorpera_folder_view_close((s ->> 'viewId')::uuid, s ->> 'pass');
end $$;


-- What ends a command view: a new activation, the seat changing agent (the screen's generation), revoked computer
-- access. Not the screen's holder: the command runs on after its run leaves the screen, and another run's lease does
-- not take it. Not privacy: a member's takeover or private sign-in drains the screen, which ends the command, and its
-- final still lands.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); v2 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	c uuid; s jsonb; r jsonb;
begin
	perform pg_temp.hold(v);
	c := pg_temp.command(v);
	s := pg_temp.open_command(c);
	perform pg_temp.hold(null);
	perform pg_temp.expect(pg_temp.vcommit(s, 'cmd-unheld', '[{"op":"mkdir","path":"by-cmd-unheld"}]'), 1, 'saved');
	perform pg_temp.hold(v2);
	r := pg_temp.vcommit(s, 'cmd-other-holder', '[{"op":"mkdir","path":"by-cmd-other-holder"}]');
	perform pg_temp.expect(r, 1, 'saved');
	if (pg_temp.last_commit(r)).run_id is distinct from (v ->> 'runId')::uuid then
		raise exception 'A command view acts through its own run: %', to_jsonb(pg_temp.last_commit(r)); end if;
	begin
		perform pg_temp.fx('update public.qorpera_runtime_office_activations set superseded_at = clock_timestamp()
			where activation_id = ''63900000-0000-4000-8000-0000000000e3''');
		perform pg_temp.refused(format('select pg_temp.vcommit(%L, %L, %L)', s, 'cmd-end-activation', '[{"op":"mkdir","path":"refused"}]'),
			'42501', 'Folder view has ended');
		r := public.qorpera_folder_view_renew((s ->> 'viewId')::uuid, s ->> 'pass');
		if r ->> 'state' is distinct from 'closed' or r ->> 'reason' is distinct from 'ended' then
			raise exception 'Renew after a new activation: %', r; end if;
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	begin
		perform pg_temp.fx('update public.qorpera_runtime_office_screens set generation = generation + 1
			where id = ''63900000-0000-4000-8000-0000000000e4''');
		perform pg_temp.refused(format('select pg_temp.vcommit(%L, %L, %L)', s, 'cmd-end-seat', '[{"op":"mkdir","path":"refused"}]'),
			'42501', 'Folder view has ended');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	begin
		perform pg_temp.fx('update public.qorpera_runtime_office_access set state = ''revoked''
			where office_id = ''63900000-0000-4000-8000-0000000000e0''');
		perform pg_temp.refused(format('select pg_temp.vcommit(%L, %L, %L)', s, 'cmd-end-access', '[{"op":"mkdir","path":"refused"}]'),
			'42501', 'Folder view has ended');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	begin
		perform pg_temp.fx('update public.qorpera_runtime_offices set privacy_state = ''private'', privacy_challenge = jsonb_build_object(''memberId'',
			''63200000-0000-4000-8000-000000000005'', ''screenId'', ''63900000-0000-4000-8000-0000000000e4'') where id = ''63900000-0000-4000-8000-0000000000e0''');
		perform pg_temp.ended(c);
		perform pg_temp.expect(pg_temp.final(s, 'cmd-private-final', '[{"op":"mkdir","path":"by-cmd-private-final"}]'), 1, 'saved');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	perform pg_temp.expect(pg_temp.vcommit(s, 'cmd-still', '[{"op":"mkdir","path":"by-cmd-still"}]'), 1, 'saved');
	perform public.qorpera_folder_view_close((s ->> 'viewId')::uuid, s ->> 'pass');
end $$;

rollback;
