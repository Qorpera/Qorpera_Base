-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
-- 20260930772000 (Claude Code on the agent's home, slice C4c): a Claude Code worker with write access works on its
-- agent's own machine with the agent's own rights. On 1268's fixture (924's base: Alice's live run for the owner, a real
-- binding; 1246's machine home-a, started by Alice's own run for the owner, running), the owner's Claude sign-in made up:
-- 0. Three workers of Alice on the owner's word, started by the drain, materialized and started on real runners: a
--    Claude Code worker (write), a Codex worker with write access and a Codex worker with read access. A Claude Code
--    worker with read access is refused at the dispatch in its words.
-- 1. The Claude Code worker's run is offered home-a; A's authority writes its session and the executor's ask answers it
--    open. The Codex workers' runs get what they got before: no home, and a session refused HOME_NOT_SHARED.
-- 2. Each rule of the Claude Code branch, alone: the worker's access, its agent, its member; the machine's agent, its
--    member, its starter (the agent's own run or a write worker; never a read worker), and the root.
-- 3. The dispatch asks what the run will ask: for each starter and member of home-a, the dispatch's home check passes
--    exactly when the Claude Code worker's run is offered the machine.
-- 4. A follow-up of a Claude Code worker that is not write is refused in the same words.
-- 5. A coding session can never be a Claude Code worker (the table's check), and nothing here is the API's.

select pg_temp.base_claims('service_role');

-- 0. The workers -----------------------------------------------------------------------------------------------------
insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.c4_owner_id());
select pg_temp.c4_login('12700000-0000-4000-8000-0000000000c1', pg_temp.c4_owner_id(), 'canary-c4c-sealed-1') \g /dev/null

create function pg_temp.c4c_read_brief(p_id uuid, p_harness text) returns jsonb language sql as $$
	select pg_temp.c4_brief(p_id, p_harness, 'Read the notes') || jsonb_build_object('access', 'read')
		|| public.qorpera_company_state_worker_standing('in-house', 'read', 'each')
$$;
create function pg_temp.c4c_binding(p_name text) returns jsonb language sql as $$
	select current_setting('qorpera_test.c4c_' || p_name)::jsonb
$$;
create function pg_temp.c4c_run(p_name text) returns uuid language sql as $$
	select (pg_temp.c4c_binding(p_name) ->> 'runId')::uuid
$$;
-- Whether a run is offered home-a now.
create function pg_temp.c4c_home(p_name text) returns boolean language sql as $$
	select coalesce(public.qorpera_company_home_available(pg_temp.c4c_binding(p_name)) ->> 'machine' = 'home-a', false)
$$;
-- The dispatch's home check for Alice's run, as the worker rules ask it: null when it passes.
create function pg_temp.c4c_dispatch_problem() returns text language sql as $$
	select public.qorpera_claude_worker_problem('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000030', (pg_temp.c4_alice() ->> 'runId')::uuid)
$$;
create function pg_temp.c4c_other_member() returns uuid language sql as $$
	select m.user_id from public.qorpera_profile_members m
	where m.profile_id = '92400000-0000-4000-8000-000000000010' and m.user_id <> pg_temp.c4_owner_id() order by m.user_id limit 1
$$;

do $$
declare v_alice jsonb := pg_temp.c4_alice(); v_result jsonb; v_binding jsonb; v_worker uuid; v_i integer;
	v_names jsonb := jsonb_build_object('12700000-0000-4000-8000-0000000000b1', 'claude',
		'12700000-0000-4000-8000-0000000000b2', 'codex_write', '12700000-0000-4000-8000-0000000000b3', 'codex_read');
begin
	-- A Claude Code worker with read access: refused in its words, nothing written.
	perform pg_temp.c4_refused(pg_temp.c4_dispatch(v_alice, 'c4c-refuse-read', 'QorperaOS/agents/alice/todos/onboarding/look',
		pg_temp.c4c_read_brief('12700000-0000-4000-8000-0000000000b0', 'claude-code')),
		pg_temp.c4c_read_brief('12700000-0000-4000-8000-0000000000b0', 'claude-code'),
		'Claude Code works on your machine with your own rights: dispatch it with write access, or without Claude Code');
	v_result := pg_temp.c4_dispatch(v_alice, 'c4c-dispatch-1', 'QorperaOS/agents/alice/todos/onboarding/pdf',
		pg_temp.c4_brief('12700000-0000-4000-8000-0000000000b1'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '0: the Claude Code dispatch: ' || v_result::text);
	v_result := pg_temp.c4_dispatch(v_alice, 'c4c-dispatch-2', 'QorperaOS/agents/alice/todos/onboarding/notes',
		pg_temp.c4_brief('12700000-0000-4000-8000-0000000000b2', null, 'Write the notes'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '0: the Codex write dispatch: ' || v_result::text);
	v_result := pg_temp.c4_dispatch(v_alice, 'c4c-dispatch-3', 'QorperaOS/agents/alice/todos/onboarding/read',
		pg_temp.c4c_read_brief('12700000-0000-4000-8000-0000000000b3', null));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '0: the Codex read dispatch: ' || v_result::text);
	perform pg_temp.c4_drain();
	perform pg_temp.base_materialize();
	for v_i in 1..3 loop
		v_binding := pg_temp.base_start(null);
		select wake.source_id into v_worker from public.qorpera_wake_occurrences wake where wake.run_id = (v_binding ->> 'runId')::uuid;
		perform pg_temp.base_assert(v_names ? v_worker::text, '0: a run of one of the three workers: ' || v_binding::text);
		perform set_config('qorpera_test.c4c_' || (v_names ->> v_worker::text), v_binding::text, false);
	end loop;
	perform pg_temp.base_assert((public.qorpera_run_worker(pg_temp.c4c_run('claude'))).harness = 'claude-code'
		and (public.qorpera_run_worker(pg_temp.c4c_run('codex_write'))).access = 'write'
		and (public.qorpera_run_worker(pg_temp.c4c_run('codex_read'))).access = 'read', '0: the three runs are the three workers''');
	-- What this test stands on: home-a is Alice's machine for the owner, started by her own run, which has no worker.
	perform pg_temp.base_assert((pg_temp.h1_machine('home-a')).started_by_run_id = (v_alice ->> 'runId')::uuid
		and (pg_temp.h1_machine('home-a')).requested_by_user_id = pg_temp.c4_owner_id()
		and (public.qorpera_run_worker((v_alice ->> 'runId')::uuid)).id is null, '0: home-a is the agent''s own');
end $$;

-- The checks start here.

-- 1. The Claude Code worker's run has its agent's home; the Codex workers' runs have what they had --------------------
do $$
declare v_session uuid := extensions.gen_random_uuid(); v jsonb; v_name text;
begin
	perform pg_temp.base_assert(pg_temp.c4c_home('claude'), '1: the Claude Code worker''s run is offered home-a: '
		|| public.qorpera_company_home_available(pg_temp.c4c_binding('claude'))::text);
	v := pg_temp.h1_authorize('home-a', v_session, pg_temp.c4c_binding('claude'));
	perform pg_temp.base_assert(v ->> 'state' = 'authorized', '1: A authorizes its session: ' || v::text);
	v := public.qorpera_folder_home_session_window(v_session);
	perform pg_temp.base_assert(v ->> 'state' = 'open' and v ->> 'runId' = pg_temp.c4c_run('claude')::text
		and v ->> 'requestedByUserId' = pg_temp.c4_owner_id()::text, '1: the executor''s ask answers it open: ' || v::text);
	perform public.qorpera_close_home_session(pg_temp.c4c_binding('claude'), v_session, 'ended');
	foreach v_name in array array['codex_write', 'codex_read'] loop
		perform pg_temp.base_assert(not pg_temp.c4c_home(v_name), '1: no home for the ' || v_name || ' worker''s run');
		v_session := extensions.gen_random_uuid();
		v := pg_temp.h1_authorize('home-a', v_session, pg_temp.c4c_binding(v_name));
		perform pg_temp.base_assert(v ->> 'state' = 'authorized', '1: A''s authority is unchanged: ' || v::text);
		v := public.qorpera_folder_home_session_window(v_session);
		perform pg_temp.base_assert(v ->> 'state' = 'refused' and v ->> 'reason' = 'HOME_NOT_SHARED',
			'1: the ask refuses the ' || v_name || ' worker''s session: ' || v::text);
		perform public.qorpera_close_home_session(pg_temp.c4c_binding(v_name), v_session, 'ended');
	end loop;
	-- Alice's own run keeps its home.
	perform pg_temp.base_assert(pg_temp.h1_has_home(), '1: Alice''s own run keeps home-a');
end $$;

-- 1b. What the worker's run reads of itself: its member's name, and what its home changed (not its own report) ------------
do $$
declare v jsonb; v_run uuid := pg_temp.c4c_run('claude');
begin
	v := public.qorpera_claude_worker_run_facts(pg_temp.c4c_binding('claude'));
	perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.claude-worker-run-facts/v1', 'member', pg_temp.c4_name(),
		'outputs', '[]'::jsonb), '1b: the member''s name and no outputs yet: ' || v::text);
	begin
		set local session_replication_role = replica;
		-- Two commits of the machine's folder view as the run (the home's window credited them), and a commit of the run's
		-- own (its report, no view): only the view's files are outputs, newest first; a folder, a delete are not.
		insert into public.qorpera_folder_commits(id, environment_id, operation_key, actor_kind, actor_id, session_kind, run_id,
			receipt_id, view_id, units, created_at)
		values ('12700000-0000-4000-8000-0000000000e1', '92400000-0000-4000-8000-000000000020', 'c4c-home-1', 'staff_agent',
				'92400000-0000-4000-8000-000000000030', 'in_house', v_run, null, extensions.gen_random_uuid(), '[]'::jsonb,
				clock_timestamp() - interval '1 minute'),
			('12700000-0000-4000-8000-0000000000e2', '92400000-0000-4000-8000-000000000020', 'c4c-home-2', 'staff_agent',
				'92400000-0000-4000-8000-000000000030', 'in_house', v_run, null, extensions.gen_random_uuid(), '[]'::jsonb,
				clock_timestamp()),
			('12700000-0000-4000-8000-0000000000e3', '92400000-0000-4000-8000-000000000020', 'c4c-report', 'staff_agent',
				'92400000-0000-4000-8000-000000000030', 'in_house', v_run, extensions.gen_random_uuid(), null, '[]'::jsonb,
				clock_timestamp());
		insert into public.qorpera_folder_path_versions(version, environment_id, path, key_sha256, op, kind, commit_id, unit_no,
			created_at)
		select extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000020', x.path,
			extensions.digest(public.qorpera_folder_key(x.path), 'sha256'), x.op, x.kind, x.commit_id::uuid, x.n,
			clock_timestamp() - make_interval(secs => x.ago)
		from (values ('onboarding/a.pdf', 'write', 'file', '12700000-0000-4000-8000-0000000000e1', 1, 60),
			('onboarding/old.pdf', 'delete', 'file', '12700000-0000-4000-8000-0000000000e1', 2, 60),
			('onboarding/new-folder', 'mkdir', 'folder', '12700000-0000-4000-8000-0000000000e1', 3, 60),
			('onboarding/b.md', 'write', 'file', '12700000-0000-4000-8000-0000000000e2', 1, 0),
			('onboarding/a.pdf', 'write', 'file', '12700000-0000-4000-8000-0000000000e2', 2, 0),
			('QorperaOS/agents/alice/todos/onboarding/pdf/results.md', 'write', 'file', '12700000-0000-4000-8000-0000000000e3', 1, 0))
			as x(path, op, kind, commit_id, n, ago);
		set local session_replication_role = origin;
		v := public.qorpera_claude_worker_run_facts(pg_temp.c4c_binding('claude'));
		perform pg_temp.base_assert(v -> 'outputs' = '["onboarding/a.pdf", "onboarding/b.md"]'::jsonb,
			'1b: what its home wrote, newest first, without deletes, folders or its report: ' || v::text);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	perform pg_temp.base_error(format('select public.qorpera_claude_worker_run_facts(%L)', pg_temp.c4c_binding('codex_write')),
		'42501');
end $$;

-- 2. Each rule alone ---------------------------------------------------------------------------------------------------
do $$
declare v_m public.qorpera_company_machines := pg_temp.h1_machine('home-a'); v_x public.qorpera_company_machines;
	v_staff uuid := '92400000-0000-4000-8000-000000000030'; v_owner uuid := pg_temp.c4_owner_id();
	v_other uuid := pg_temp.c4c_other_member(); v_run uuid := pg_temp.c4c_run('claude');
	v_worker uuid := '12700000-0000-4000-8000-0000000000b1';
begin
	perform pg_temp.base_assert(v_other is not null and public.qorpera_folder_reads_root(v_m.environment_id, v_m.profile_id,
		v_staff, v_other), '2: the other member reads the root too (so only the member rules can refuse below)');
	perform pg_temp.base_assert(public.qorpera_folder_home_shared(v_m, v_staff, v_owner, v_run), '2: shared as it is');
	-- The worker's access.
	begin
		update public.qorpera_runtime_workers set access = 'read' where id = v_worker;
		perform pg_temp.base_assert(not public.qorpera_folder_home_shared(v_m, v_staff, v_owner, v_run),
			'2: a Claude Code worker with read access does not share');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	-- The worker's agent.
	begin
		set local session_replication_role = replica;
		update public.qorpera_runtime_workers set staff_agent_id = extensions.gen_random_uuid() where id = v_worker;
		set local session_replication_role = origin;
		perform pg_temp.base_assert(not public.qorpera_folder_home_shared(v_m, v_staff, v_owner, v_run),
			'2: another agent''s worker does not share');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	-- The worker's member: a machine of the agent for another member, asked as that member, is not this worker's.
	v_x := v_m; v_x.requested_by_user_id := v_other;
	perform pg_temp.base_assert(not public.qorpera_folder_home_shared(v_x, v_staff, v_other, v_run),
		'2: the worker''s member is not the member asked for');
	-- The machine's agent.
	v_x := v_m; v_x.started_by_staff_agent_id := extensions.gen_random_uuid();
	perform pg_temp.base_assert(not public.qorpera_folder_home_shared(v_x, v_staff, v_owner, v_run),
		'2: another agent''s machine');
	-- The machine's member.
	v_x := v_m; v_x.requested_by_user_id := v_other;
	perform pg_temp.base_assert(not public.qorpera_folder_home_shared(v_x, v_staff, v_owner, v_run),
		'2: the agent''s machine for another member');
	-- The machine's starter: a write worker's run shares it, a read worker's does not.
	v_x := v_m; v_x.started_by_run_id := pg_temp.c4c_run('codex_write');
	perform pg_temp.base_assert(public.qorpera_folder_home_shared(v_x, v_staff, v_owner, v_run),
		'2: a machine a write worker started');
	v_x := v_m; v_x.started_by_run_id := pg_temp.c4c_run('codex_read');
	perform pg_temp.base_assert(not public.qorpera_folder_home_shared(v_x, v_staff, v_owner, v_run),
		'2: a machine a read worker started');
	-- The root: a machine of a company folder the agent and the member do not read (none at all here).
	v_x := v_m; v_x.environment_id := extensions.gen_random_uuid();
	perform pg_temp.base_assert(not public.qorpera_folder_home_shared(v_x, v_staff, v_owner, v_run),
		'2: only while the agent and the member read the root');
	-- And a Codex write worker on a machine a write worker started shares it as before (today's rule, untouched).
	v_x := v_m; v_x.started_by_run_id := pg_temp.c4c_run('codex_write');
	perform pg_temp.base_assert(public.qorpera_folder_home_shared(v_x, v_staff, v_owner, pg_temp.c4c_run('codex_write')),
		'2: today''s rule stands for a Codex write worker');
	perform pg_temp.base_assert(not public.qorpera_folder_home_shared(v_m, v_staff, v_owner, pg_temp.c4c_run('codex_write')),
		'2: and refuses it the agent''s own machine, as before');
end $$;

-- 3. The dispatch asks what the run will ask ----------------------------------------------------------------------------
do $$
declare v_m public.qorpera_company_machines := pg_temp.h1_machine('home-a'); v_starter text; v_member text;
	v_words text := pg_temp.c4_words('Claude Code works on your own machine, and none is running for <member>''s work now: start your machine, or dispatch this worker without Claude Code');
	v_problem text; v_home boolean;
begin
	foreach v_starter in array array['alice', 'codex_write', 'codex_read'] loop
		foreach v_member in array array['owner', 'other'] loop
			begin
				set local session_replication_role = replica;
				update public.qorpera_company_machines set
					started_by_run_id = case v_starter when 'alice' then (pg_temp.c4_alice() ->> 'runId')::uuid
						else pg_temp.c4c_run(v_starter) end,
					requested_by_user_id = case v_member when 'owner' then pg_temp.c4_owner_id() else pg_temp.c4c_other_member() end
				where id = v_m.id;
				set local session_replication_role = origin;
				v_problem := pg_temp.c4c_dispatch_problem();
				v_home := pg_temp.c4c_home('claude');
				perform pg_temp.base_assert((v_problem is null) = v_home and (v_problem is null or v_problem = v_words),
					format('3: started by %s for the %s: the dispatch says %s and the run %s', v_starter, v_member,
						coalesce(v_problem, 'yes'), case when v_home then 'has its home' else 'has none' end));
				perform pg_temp.base_assert(v_home = (v_starter <> 'codex_read' and v_member = 'owner'),
					format('3: started by %s for the %s: the run %s its home', v_starter, v_member,
						case when v_home then 'has' else 'has not' end));
				raise exception 'Undo' using errcode = 'QTF80';
			exception when sqlstate 'QTF80' then null;
			end;
		end loop;
	end loop;
end $$;

-- 4. A follow-up of a Claude Code worker that is not write ----------------------------------------------------------------
do $$
declare v_alice jsonb := pg_temp.c4_alice(); v_result jsonb; w public.qorpera_runtime_workers%rowtype;
	v_folder text := 'QorperaOS/agents/alice/todos/onboarding/pdf';
begin
	-- The Claude Code worker's run ends without a report; its wake ends and the drain finishes it.
	perform pg_temp.c4_end_job(pg_temp.c4c_run('claude'), 'failed');
	update public.qorpera_wake_occurrences set status = 'failed', finished_at = coalesce(finished_at, clock_timestamp())
	where id = (pg_temp.c4_worker('12700000-0000-4000-8000-0000000000b1')).occurrence_id and status = 'materialized';
	perform pg_temp.c4_drain();
	w := pg_temp.c4_worker('12700000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.state <> 'active', '4: the worker has ended: ' || to_jsonb(w)::text);
	begin
		update public.qorpera_runtime_workers set access = 'read' where id = w.id;
		v_result := pg_temp.c4_followup(v_alice, 'c4c-followup-read', v_folder, 'Use the new logo.');
		perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'refused'
			and v_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message'
				= 'Claude Code works on your machine with your own rights: dispatch it with write access, or without Claude Code',
			'4: a read Claude Code worker is not followed up: ' || v_result::text);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	v_result := pg_temp.c4_followup(v_alice, 'c4c-followup-write', v_folder, 'Use the new logo.');
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '4: a write one is: ' || v_result::text);
end $$;

-- 5. Never a coding session; whose these are --------------------------------------------------------------------------
do $$
declare v_role text; v_function text;
begin
	perform pg_temp.base_error($sql$update public.qorpera_runtime_workers set species = 'coding'
		where id = '12700000-0000-4000-8000-0000000000b1'$sql$, '23514');
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_function in array array['public.qorpera_claude_worker_on_home(public.qorpera_company_machines,uuid,uuid)',
			'public.qorpera_claude_worker_shares(public.qorpera_company_machines,uuid,uuid,uuid)',
			'public.qorpera_folder_home_shared(public.qorpera_company_machines,uuid,uuid,uuid)'] loop
			if has_function_privilege(v_role, v_function, 'execute') then
				raise exception '5: % may call %', v_role, v_function; end if;
		end loop;
		if has_function_privilege(v_role, 'public.qorpera_claude_worker_run_facts(jsonb)', 'execute')
			<> (v_role = 'service_role') then
			raise exception '5: only the runtime reads a worker run''s facts (%)', v_role; end if;
	end loop;
	foreach v_function in array array['public.qorpera_folder_home_shared(public.qorpera_company_machines,uuid,uuid,uuid)',
		'public.qorpera_claude_worker_home(uuid,uuid,uuid,uuid)',
		'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'] loop
		if position('20260930772000' in pg_get_functiondef(v_function::regprocedure)) = 0 then
			raise exception '5: % does not name 20260930772000', v_function; end if;
	end loop;
end $$;
