-- @fixture 708_folder_state_routines.test.sql until "-- 2. A member's routine"
-- Company state files, thin writers W4c (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §5 "Plan (W4c)"; migration
-- 20260928399960): a save that changes nothing ends a pause the platform recorded (a member's Stop, the
-- authorization-failure suspension, a wait for a login) and pays like a resume; an edit, the platform's own save, a pause
-- in the file and an unpaid resume do not; a member without a paying login is refused it. And the run agent's routine
-- read: the routine as runs see it and the file's own view, per file read authority, one key, a cursor, no worker.

create function pg_temp.inbox(p_status text default 'active', p_title text default 'Inbox') returns jsonb language sql as $$
	select pg_temp.routine('agents/nora/routines/inbox.md', pg_temp.rparse('78000000-0000-4000-8000-0000000000e1', p_title,
		pg_temp.every(30), jsonb_build_object('status', p_status)))
$$;
create function pg_temp.raises(p_sql text, p_state text) returns void language plpgsql as $$
begin
	execute p_sql;
	raise exception 'Expected SQLSTATE % from %', p_state, p_sql using errcode = 'QTF02';
exception when others then
	if sqlstate = 'QTF02' or sqlstate <> p_state then raise; end if;
end $$;
create function pg_temp.hold(p_reason text) returns void language sql as $$
	select pg_temp.fx(format('update public.qorpera_cloud_routines set status = %L, pause_reason = %L, authorization_failures = 3 where id = %L',
		'paused', p_reason, '78000000-0000-4000-8000-0000000000e1'))
$$;

-- 1. The resume rule.
do $$
declare x public.qorpera_cloud_routines; v_version bigint; r jsonb; v_reason text; a jsonb;
	e1 constant uuid := '78000000-0000-4000-8000-0000000000e1';
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'resume-0001', jsonb_build_array(pg_temp.inbox())), 1, 'saved');
	v_version := (pg_temp.rt(e1)).current_version;
	-- Each of the platform's pauses ends with an unchanged save of the active file, failures reset, no new version.
	foreach v_reason in array array['authorization_failed', 'member', 'needs_model_account'] loop
		perform pg_temp.hold(v_reason);
		perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'resume-' || v_reason, jsonb_build_array(pg_temp.inbox())), 1, 'saved');
		x := pg_temp.rt(e1);
		if x.status is distinct from 'active' or x.pause_reason is not null or x.authorization_failures is distinct from 0
			or x.current_version is distinct from v_version then
			raise exception 'An unchanged save ends the platform''s % pause: %', v_reason, to_jsonb(x); end if;
	end loop;
	-- An edit leaves a suspension or a Stop in place.
	foreach v_reason in array array['authorization_failed', 'member'] loop
		perform pg_temp.hold(v_reason);
		perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'edit-' || v_reason, jsonb_build_array(pg_temp.inbox('active', 'Inbox ' || v_reason))),
			1, 'saved');
		x := pg_temp.rt(e1);
		if x.status is distinct from 'paused' or x.pause_reason is distinct from v_reason then
			raise exception 'An edit leaves the platform''s % pause: %', v_reason, to_jsonb(x); end if;
		perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'unedit-' || v_reason, jsonb_build_array(pg_temp.inbox())), 1, 'saved');
	end loop;
	-- An agent's pause is not the platform's: an unchanged save leaves it.
	perform pg_temp.hold('agent');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'resume-agent', jsonb_build_array(pg_temp.inbox())), 1, 'saved');
	if (pg_temp.rt(e1)).status is distinct from 'paused' or (pg_temp.rt(e1)).pause_reason is distinct from 'agent' then
		raise exception 'An unchanged save leaves an agent''s pause: %', to_jsonb(pg_temp.rt(e1)); end if;
	-- The platform's own unchanged save keeps its pause.
	perform pg_temp.hold('authorization_failed');
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'resume-platform', jsonb_build_array(pg_temp.inbox())), 1, 'saved');
	if (pg_temp.rt(e1)).status is distinct from 'paused' or (pg_temp.rt(e1)).pause_reason is distinct from 'authorization_failed' then
		raise exception 'The platform''s save resumes nothing: %', to_jsonb(pg_temp.rt(e1)); end if;
	-- A member without a paying login is refused the resume (it would start work on no login).
	r := pg_temp.commit(pg_temp.mem(), 'resume-by-member', jsonb_build_array(pg_temp.inbox()));
	if not pg_temp.refused(r) or coalesce(pg_temp.problem(r), '') not like 'a routine runs on the AI login of the member who saves it%' then
		raise exception 'A member without a paying login is refused the resume: %', r; end if;
	-- An unpaid resume, by a run whose requester has no paying login, keeps the platform's pause and its reason. The run
	-- is woken by another of Nora's routines, which the member (whose login does not pay) made.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'resume-other', jsonb_build_array(pg_temp.routine('agents/nora/routines/other.md',
		pg_temp.rparse('78000000-0000-4000-8000-0000000000e2', 'Other', pg_temp.every())))), 1, 'saved');
	perform pg_temp.fx(format('update public.qorpera_cloud_routine_versions set created_by_user_id = %L, sponsor_binding_id = %L where routine_id = %L',
		'70700000-0000-4000-8000-000000000002', '70800000-0000-4000-8000-0000000000b2', '78000000-0000-4000-8000-0000000000e2'));
	a := pg_temp.routine_run('78000000-0000-4000-8000-0000000000e2');
	perform pg_temp.expect(pg_temp.reviewed(a, 'resume-unpaid', jsonb_build_array(pg_temp.inbox())), 1, 'saved');
	x := pg_temp.rt(e1);
	if x.status is distinct from 'paused' or x.pause_reason is distinct from 'authorization_failed' then
		raise exception 'An unpaid resume keeps the platform''s pause: %', to_jsonb(x); end if;
	-- The owner's resume ends it, on the owner's login.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'resume-owner', jsonb_build_array(pg_temp.inbox())), 1, 'saved');
	if (pg_temp.rt(e1)).status is distinct from 'active' or (pg_temp.rv(e1)).sponsor_binding_id is distinct from '70800000-0000-4000-8000-0000000000b1' then
		raise exception 'The owner''s resume runs on their login: %', to_jsonb(pg_temp.rt(e1)); end if;
	-- A pause in the file stays a pause: an unchanged paused file changes nothing, and an agent's pause reason ('agent'
	-- or 'member' from a file) is not the platform's.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'pause-file', jsonb_build_array(pg_temp.inbox('paused'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'pause-again', jsonb_build_array(pg_temp.inbox('paused'))), 1, 'saved');
	if (pg_temp.rt(e1)).status is distinct from 'paused' or (pg_temp.rt(e1)).pause_reason is distinct from 'member' then
		raise exception 'A pause in the file is the saver''s: %', to_jsonb(pg_temp.rt(e1)); end if;
end $$;

-- 2. The read: a run of Nora sees her file routines, as runs see them and as the file says; one key; a cursor.
do $$
declare a jsonb; r jsonb; i integer; e jsonb; seen text[] := '{}'; w jsonb; worker uuid; v_res uuid;
begin
	for i in 1..32 loop
		perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'routine-read-' || i, jsonb_build_array(pg_temp.routine(
			'agents/nora/routines/r-' || i || '.md', pg_temp.rparse(md5('r' || i)::uuid, 'Routine ' || i, pg_temp.every())))), 1, 'saved');
	end loop;
	-- Otto's routine is not Nora's.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'routine-read-otto', jsonb_build_array(pg_temp.routine(
		'agents/otto/routines/watch.md', pg_temp.rparse(md5('otto')::uuid, 'Watch', pg_temp.every())))), 1, 'saved');
	a := pg_temp.routine_run('78000000-0000-4000-8000-0000000000e2');
	r := public.qorpera_folder_agent_routines('70700000-0000-4000-8000-000000000020', a, '{}');
	if r ->> 'schema' is distinct from 'qorpera.folder-agent-routines/v1' or jsonb_array_length(r -> 'routines') is distinct from 32
		or (r ->> 'moreRoutines')::integer is distinct from 2 or r ->> 'nextCursor' is null then
		raise exception 'A page of 32 with a cursor: %', r - 'routines'; end if;
	for e in select value from jsonb_array_elements(r -> 'routines') loop seen := seen || (e ->> 'routineKey'); end loop;
	r := public.qorpera_folder_agent_routines('70700000-0000-4000-8000-000000000020', a, jsonb_build_object('cursor', r ->> 'nextCursor'));
	if jsonb_array_length(r -> 'routines') is distinct from 2 or (r ->> 'moreRoutines')::integer is distinct from 0
		or r ->> 'nextCursor' is not null then
		raise exception 'The second page: %', r; end if;
	for e in select value from jsonb_array_elements(r -> 'routines') loop seen := seen || (e ->> 'routineKey'); end loop;
	if cardinality(seen) <> 34 or (select count(distinct k) from unnest(seen) k) <> 34 or 'watch' = any(seen) then
		raise exception 'Every routine of Nora once: %', seen; end if;
	if jsonb_array_length(public.qorpera_folder_agent_routines('70700000-0000-4000-8000-000000000020', a, '{"routineKey":"watch"}')
			-> 'routines') <> 0 then
		raise exception 'Another agent''s routine is not read by key'; end if;
	r := public.qorpera_folder_agent_routines('70700000-0000-4000-8000-000000000020', a, '{"routineKey":"inbox"}');
	e := r -> 'routines' -> 0;
	if jsonb_array_length(r -> 'routines') is distinct from 1 or e ->> 'routineKey' is distinct from 'inbox'
		or e ->> 'path' is distinct from 'agents/nora/routines/inbox.md' or e ->> 'status' is distinct from 'paused'
		or e -> 'file' ->> 'status' is distinct from 'paused' or e -> 'file' -> 'trigger' ->> 'when' is distinct from 'every'
		or e -> 'file' ->> 'instructions' is distinct from 'Look at the inbox.' or e ? 'intent' or e ? 'instructionsTruncated'
		or e ->> 'folderVersion' is null then
		raise exception 'One routine, as runs see it and as the file says: %', e; end if;
	-- A page cuts long instructions to 200 characters; one routine by its key is whole.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'routine-read-long', jsonb_build_array(pg_temp.routine(
		'agents/nora/routines/long.md', pg_temp.rparse(md5('long')::uuid, 'Long', pg_temp.every(),
			jsonb_build_object('instructions', repeat('é', 250)))))), 1, 'saved');
	r := public.qorpera_folder_agent_routines('70700000-0000-4000-8000-000000000020', a, '{}');
	r := r -> 'routines' || (public.qorpera_folder_agent_routines('70700000-0000-4000-8000-000000000020', a,
		jsonb_build_object('cursor', r ->> 'nextCursor')) -> 'routines');
	select value into e from jsonb_array_elements(r) where value ->> 'routineKey' = 'long';
	if e -> 'file' ->> 'instructions' is distinct from repeat('é', 200)
		or e -> 'instructionsTruncated' is distinct from 'true'::jsonb then
		raise exception 'A page cuts long instructions: %', e; end if;
	e := public.qorpera_folder_agent_routines('70700000-0000-4000-8000-000000000020', a, '{"routineKey":"long"}') -> 'routines' -> 0;
	if e -> 'file' ->> 'instructions' is distinct from repeat('é', 250) or e ? 'instructionsTruncated' then
		raise exception 'One routine by its key is whole: %', e; end if;
	-- One routine file narrowed to another agent: the run may not read it, so the page, its count, its key and its cursor
	-- leave it out. Neither a removed routine (its file deleted, the row retired) nor one from before the company's
	-- folder (no file, so no folder environment) is listed.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'routine-read-remove', jsonb_build_array(
		pg_temp.del('agents/nora/routines/r-2.md'))), 1, 'saved');
	v_res := public.qorpera_folder_set_resource('70700000-0000-4000-8000-000000000020', pg_temp.owner(),
		'agents/nora/routines/r-1.md', 'exact', 'company_shared', 'normal') ->> 'resourceId';
	perform public.qorpera_folder_grant('70700000-0000-4000-8000-000000000020', pg_temp.owner(), v_res, 'staff_agent',
		'70700000-0000-4000-8000-0000000000a2', array['read']);
	perform pg_temp.fx(format('insert into public.qorpera_cloud_routines select (jsonb_populate_record(r, %L)).* '
		'from public.qorpera_cloud_routines r where id = %L', jsonb_build_object('id', md5('legacy')::uuid, 'client_routine_id',
			md5('legacy')::uuid, 'origin', 'agent', 'routine_key', 'legacy', 'folder_path', null, 'folder_environment_id', null,
			'folder_path_version', null, 'folder_commit_id', null), '78000000-0000-4000-8000-0000000000e1'));
	r := public.qorpera_folder_agent_routines('70700000-0000-4000-8000-000000000020', a, '{}');
	if (r ->> 'moreRoutines')::integer is distinct from 1 then raise exception 'Neither is counted: %', r - 'routines'; end if;
	r := r -> 'routines' || (public.qorpera_folder_agent_routines('70700000-0000-4000-8000-000000000020', a,
		jsonb_build_object('cursor', r ->> 'nextCursor')) -> 'routines');
	seen := array(select value ->> 'routineKey' from jsonb_array_elements(r));
	if cardinality(seen) is distinct from 33 or 'r-1' = any(seen) or 'r-2' = any(seen) or 'legacy' = any(seen)
		or not 'r-3' = any(seen) then
		raise exception 'Only what the run may read, from the folder: %', seen; end if;
	if jsonb_array_length(public.qorpera_folder_agent_routines('70700000-0000-4000-8000-000000000020', a, '{"routineKey":"r-1"}')
			-> 'routines') is distinct from 0
		or jsonb_array_length(public.qorpera_folder_agent_routines('70700000-0000-4000-8000-000000000020', a, '{"routineKey":"r-2"}')
			-> 'routines') is distinct from 0
		or jsonb_array_length(public.qorpera_folder_agent_routines('70700000-0000-4000-8000-000000000020', a, '{"routineKey":"legacy"}')
			-> 'routines') is distinct from 0 then
		raise exception 'None is read by its key'; end if;
	perform pg_temp.raises(format('select public.qorpera_folder_agent_routines(%L, %L, %L)', '70700000-0000-4000-8000-000000000020', a,
		jsonb_build_object('cursor', md5('r1')::uuid)), '22023');
	perform pg_temp.raises(format('select public.qorpera_folder_agent_routines(%L, %L, %L)', '70700000-0000-4000-8000-000000000020', a,
		jsonb_build_object('cursor', md5('legacy')::uuid)), '22023');
	perform pg_temp.raises(format('select public.qorpera_folder_agent_routines(%L, %L, %L)', '70700000-0000-4000-8000-000000000020', a,
		jsonb_build_object('cursor', md5('r2')::uuid)), '22023');
	-- Bad requests.
	perform pg_temp.raises(format('select public.qorpera_folder_agent_routines(%L, %L, %L)', '70700000-0000-4000-8000-000000000020', a,
		'{"routineKey":"Inbox"}'), '22023');
	perform pg_temp.raises(format('select public.qorpera_folder_agent_routines(%L, %L, %L)', '70700000-0000-4000-8000-000000000020', a,
		'{"other":1}'), '22023');
	perform pg_temp.raises(format('select public.qorpera_folder_agent_routines(%L, %L, %L)', '70700000-0000-4000-8000-000000000020', a,
		jsonb_build_object('cursor', extensions.gen_random_uuid())), '22023');
	-- A worker keeps no routines of its own; a view of the run is not the run.
	w := pg_temp.routine_run('78000000-0000-4000-8000-0000000000e2');
	worker := extensions.gen_random_uuid();
	perform pg_temp.fx(format('insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, '
		'worker_key, species, title, access, revival, dispatch, requested_by_user_id, steering_run_id) values (%L, %L, %L, %L, %L, '
		'%L, ''in-house'', ''Work'', ''write'', ''each'', ''{}'', %L, %L)', worker, '70700000-0000-4000-8000-000000000010',
		'70700000-0000-4000-8000-000000000020', (pg_temp.rv('78000000-0000-4000-8000-0000000000e2')).staff_agent_id,
		extensions.gen_random_uuid(), 'w-read', '70700000-0000-4000-8000-000000000001', a ->> 'runId'));
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set wake_kind = ''agent'', source_kind = ''worker-dispatch'', '
		'trigger_id = ''worker-dispatch'', source_id = %L, routine_id = null, routine_version = null, parent_run_id = %L, causal_root_id = (select causal_root_id '
		'from public.qorpera_wake_occurrences where run_id = %L) where run_id = %L', worker, a ->> 'runId', a ->> 'runId', w ->> 'runId'));
	-- (The worker's run itself stands: it reads the folder.)
	if public.qorpera_folder_read_actor('70700000-0000-4000-8000-000000000020', w) ->> 'workerAccess' is distinct from 'write' then
		raise exception 'The worker''s run stands'; end if;
	perform pg_temp.raises(format('select public.qorpera_folder_agent_routines(%L, %L, %L)', '70700000-0000-4000-8000-000000000020',
		w, '{}'), '42501');
	perform pg_temp.fx(format('insert into public.qorpera_folder_views(id, environment_id, profile_id, kind, staff_agent_id, '
		'member_user_id, run_id, job_id, runner_id, client_lease_id, pass_sha256, lease_until) values (%L, %L, %L, ''run_box'', %L, %L, '
		'%L, %L, %L, %L, %L, clock_timestamp() + interval ''1 hour'')', '78000000-0000-4000-8000-0000000000f1',
		'70700000-0000-4000-8000-000000000020', '70700000-0000-4000-8000-000000000010',
		(pg_temp.rv('78000000-0000-4000-8000-0000000000e2')).staff_agent_id, '70700000-0000-4000-8000-000000000001',
		a ->> 'runId', a ->> 'jobId', a ->> 'runnerId', a ->> 'assignmentId', extensions.digest(repeat('p', 43), 'sha256')));
	perform pg_temp.raises(format('select public.qorpera_folder_agent_routines(%L, %L, %L)', '70700000-0000-4000-8000-000000000020',
		jsonb_build_object('kind', 'view', 'viewId', '78000000-0000-4000-8000-0000000000f1', 'pass', repeat('p', 43)), '{}'), '42501');
	-- A member is not a run; only the runtime's role reads.
	perform pg_temp.raises(format('select public.qorpera_folder_agent_routines(%L, %L, %L)', '70700000-0000-4000-8000-000000000020',
		pg_temp.owner(), '{}'), '42501');
	if has_function_privilege('authenticated', 'public.qorpera_folder_agent_routines(uuid,jsonb,jsonb)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_folder_agent_routines(uuid,jsonb,jsonb)', 'execute') then
		raise exception 'The read is the runtime''s'; end if;
end $$;

rollback;
