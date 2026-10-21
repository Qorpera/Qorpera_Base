-- @fixture 864_folder_state_interfaces.test.sql until "-- 1. The kinds, by the path's shape alone"
-- Interfaces I10 (deploy/first-node/RUNTIME-INTERFACES.md §7 and §9 decision 2, §10 row I10; 20260930370000): the
-- notes of a run's changes to the company's pages and tables in its conversation, a native host call. Which commits
-- get one (any of the run's that changed a path under interfaces/ or tables/, whatever tool's key it has; never a
-- table's rows), what a note names (each version the commit made there, with the one before it), whose event it is,
-- one note a commit, when there is none (another run's commit, a commit that saved nothing, no conversation), the
-- refusals (a closed conversation's run among them), and the grants. The seed is 864's: Pulse with its README, Mailbox,
-- and the numbers table with its rows. Runs are 647's with their native rows. Since 20260930510000 an agent changes
-- nothing under interfaces/ and no table's folder or table.toml (689), so the notes here are of a table's README, and a
-- page change the save check refuses notes nothing.

create function pg_temp.note(p_binding jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_note_interface_changes(p_binding, '{}'::jsonb)
$$;
create function pg_temp.noted(p_count integer) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.interface-change-notes/v1', 'noted', p_count)
$$;
-- A commit's key as a tool makes it: the tool, then the hash of the model's key.
create function pg_temp.key(p_tool text, p_model_key text) returns text language sql immutable as $$
	select p_tool || ':' || pg_temp.hash(p_model_key)
$$;
-- The notes in a run's conversation, in its order.
create function pg_temp.notes(p_actor jsonb) returns setof public.qorpera_session_events language sql as $$
	select e.* from public.qorpera_session_events e join public.qorpera_execution_runs r on r.session_id = e.session_id
	where r.id = (p_actor ->> 'runId')::uuid and e.body ->> 'schema' = 'qorpera.interface-change/v1' order by e.sequence
$$;
-- A commit's note id: its hash as a version 8 UUID.
create function pg_temp.event_id(p_commit jsonb) returns uuid language sql immutable as $$
	select overlay(overlay(md5('qorpera.interface-change:' || (p_commit ->> 'commitId'))::uuid::text placing '8' from 15 for 1)
		placing '8' from 20 for 1)::uuid
$$;
create function pg_temp.seq(p_commit jsonb) returns bigint language sql as $$
	select seq from public.qorpera_folder_commits where id = (p_commit ->> 'commitId')::uuid
$$;
-- One path version a note names.
create function pg_temp.change(p_unit integer, p_op text, p_kind text, p_path text, p_prior uuid) returns jsonb language sql as $$
	select jsonb_build_object('unit', p_unit, 'op', p_op, 'kind', p_kind, 'path', p_path,
		'version', pg_temp.p16_version(lower(p_path)), 'priorVersion', p_prior)
$$;
create function pg_temp.plain(p_actor jsonb, p_path text, p_text text) returns jsonb language sql as $$
	select jsonb_build_object('op', 'write', 'path', p_path, 'file', pg_temp.stage(p_text, p_actor))
$$;
-- The numbers table's rows with the first reading's value changed: a rows save.
create function pg_temp.reading(p_actor jsonb, p_value text) returns jsonb language sql as $$
	select pg_temp.p16_write(p_actor, 'QorperaOS/tables/numbers/rows.csv', jsonb_set(pg_temp.fixture('rows'), '{rows,0,fields,2}', to_jsonb(p_value)))
$$;
-- A routine run of agent A with no conversation (a silent routine, as 658 builds it), with its binding.
create function pg_temp.routine_run() returns jsonb language plpgsql as $$
declare
	v_profile uuid := '63400000-0000-4000-8000-000000000010'; v_env uuid := '63400000-0000-4000-8000-000000000020';
	v_staff uuid := '63400000-0000-4000-8000-0000000000a1'; v_member uuid := '63400000-0000-4000-8000-000000000002';
	v_sponsor uuid := '63400000-0000-4000-8000-0000000000b1'; v_routine uuid := extensions.gen_random_uuid();
	v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid();
	v_wake uuid := extensions.gen_random_uuid(); v_runner uuid := extensions.gen_random_uuid();
	v_assignment uuid := extensions.gen_random_uuid(); p jsonb;
begin
	set local session_replication_role = replica;
	insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, current_version, status,
		created_by_user_id, origin)
	values (v_routine, v_profile, v_env, extensions.gen_random_uuid(), 1, 'active', v_member, 'member');
	insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id, environment_id,
		staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id)
	values (v_routine, 1, extensions.gen_random_uuid(), v_profile, v_env, v_staff, 'Quiet pages', 'Tidy the pages quietly.',
		'[{"id":"s1","kind":"schedule","intervalMinutes":60,"replyPolicy":"silent"}]', 'medium', v_sponsor, 1, repeat('e', 64),
		v_member);
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		v_member, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids)
	values (v_run, v_profile, v_env, 'wake', v_wake, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		v_staff, 1, v_sponsor, 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_member, v_member,
		'openai', 'gpt-test', 'provider_default', 'company', extensions.gen_random_uuid(), repeat('b', 64), null, '{}');
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id, routine_version, trigger_id, occurrence_key,
		scheduled_for, not_before, wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id,
		sponsor_binding_id, sponsor_version, causal_root_id, causal_agent_ids, causal_hop_count, payload)
	values (v_wake, v_profile, v_env, v_routine, 1, 's1', v_wake::text, clock_timestamp(), clock_timestamp(), 'routine', 'schedule',
		v_routine, v_run, 'materialized', v_staff, 1, v_member, v_sponsor, 1, v_wake, array[v_staff], 0, '{}');
	set local session_replication_role = origin;
	p := jsonb_build_object('kind', 'run', 'runId', v_run, 'jobId', v_job, 'runnerId', v_runner, 'assignmentId', v_assignment);
	return jsonb_build_object('actor', p, 'binding', pg_temp.native(p));
end $$;

-- 1. A company_write of the numbers table's README (the platform's), a refused change of Pulse's README, then a plain
-- file: one note, of the README's commit. It names the version the commit made and the one before it; it is a
-- session_info event in the run's conversation, from the member the run is for, with no run identity. A repeat notes
-- nothing more.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor';
	v_old uuid; c jsonb; e public.qorpera_session_events%rowtype;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'i10-readme-0001', jsonb_build_array(
		pg_temp.plain('{"kind":"platform"}', 'QorperaOS/tables/numbers/README.md', 'About the numbers.'))), 1, 'saved');
	v_old := pg_temp.p16_version('QorperaOS/tables/numbers/readme.md');
	c := pg_temp.commit(p, pg_temp.key('company_write', 'readme-1'), jsonb_build_array(
		pg_temp.p16_write(p, 'QorperaOS/tables/numbers/README.md', '"About the numbers, by the agent."')));
	perform pg_temp.expect(c, 1, 'saved');
	perform pg_temp.refused(pg_temp.commit(p, pg_temp.key('company_write', 'page-1'), jsonb_build_array(
		pg_temp.p16_write(p, 'QorperaOS/interfaces/pulse/README.md', '"About Pulse, by the agent."'))), 1, 'structured_rule', 'layout_authoring');
	perform pg_temp.expect(pg_temp.commit(p, pg_temp.key('company_write', 'plain-1'), jsonb_build_array(
		pg_temp.plain(p, 'i10-plain.md', 'A plain file.'))), 1, 'saved');
	if pg_temp.note(b) <> pg_temp.noted(1) then raise exception 'One note: %', pg_temp.note(b); end if;
	select * into strict e from pg_temp.notes(p);
	-- The id is a version 8 UUID, which the web's strict event check takes.
	if e.event_id <> pg_temp.event_id(c) or e.event_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$'
		or e.event_type <> 'session_info' or e.actor_user_id <> '63400000-0000-4000-8000-000000000002'
		or e.execution_kind is not null or e.execution_id is not null or e.runner_assignment_id is not null
		or e.body <> jsonb_build_object('schema', 'qorpera.interface-change/v1', 'commitId', c ->> 'commitId',
			'seq', pg_temp.seq(c), 'runId', p ->> 'runId', 'staffAgentId', '63400000-0000-4000-8000-0000000000a1',
			'changes', jsonb_build_array(pg_temp.change(1, 'write', 'file', 'QorperaOS/tables/numbers/README.md', v_old)))
		or pg_temp.seq(c) is null or v_old is null or v_old = pg_temp.p16_version('QorperaOS/tables/numbers/readme.md') then
		raise exception 'The event: %', to_jsonb(e); end if;
	if pg_temp.note(b) <> pg_temp.noted(0) or (select count(*) from pg_temp.notes(p)) <> 1 then
		raise exception 'A repeat notes nothing more'; end if;
	perform set_config('qorpera_test.i10_run', x::text, true);
end $$;

-- 2. More commits, then one call notes each that has none, in the order they saved: the areas table's new README in a
-- commit that also writes a plain file and the numbers table's rows (the note names the README only); a commit of the
-- table's rows alone (no note); and the numbers table's README again under save_interface's key.
do $$
declare x jsonb := current_setting('qorpera_test.i10_run')::jsonb; b jsonb := x -> 'binding'; p jsonb := x -> 'actor';
	c3 jsonb; c5 jsonb; v_notes jsonb; v_prior uuid;
begin
	c3 := pg_temp.commit(p, pg_temp.key('company_write', 'table-1'), jsonb_build_array(
		pg_temp.p16_write(p, 'QorperaOS/tables/areas/README.md', '"About the areas."'),
		pg_temp.plain(p, 'i10-also.md', 'Another plain file.'),
		pg_temp.reading(p, '1300')));
	perform pg_temp.expect(c3, 1, 'saved');
	perform pg_temp.expect(c3, 2, 'saved');
	perform pg_temp.expect(c3, 3, 'saved');
	perform pg_temp.expect(pg_temp.commit(p, pg_temp.key('table_write', 'rows-1'), jsonb_build_array(pg_temp.reading(p, '1400'))),
		1, 'saved');
	v_prior := pg_temp.p16_version('QorperaOS/tables/numbers/readme.md');
	c5 := pg_temp.commit(p, pg_temp.key('save_interface', 'readme-2'), jsonb_build_array(
		pg_temp.p16_write(p, 'QorperaOS/tables/numbers/README.md', '"About the numbers, again."')));
	perform pg_temp.expect(c5, 1, 'saved');
	if pg_temp.note(b) <> pg_temp.noted(2) then raise exception 'Two notes'; end if;
	select jsonb_agg(jsonb_build_array(e.event_id, e.body) order by e.sequence) into v_notes from pg_temp.notes(p) e
	where e.event_id in (pg_temp.event_id(c3), pg_temp.event_id(c5));
	if v_notes is distinct from jsonb_build_array(
		jsonb_build_array(pg_temp.event_id(c3), jsonb_build_object('schema', 'qorpera.interface-change/v1',
			'commitId', c3 ->> 'commitId', 'seq', pg_temp.seq(c3), 'runId', p ->> 'runId',
			'staffAgentId', '63400000-0000-4000-8000-0000000000a1', 'changes', jsonb_build_array(
				pg_temp.change(1, 'write', 'file', 'QorperaOS/tables/areas/README.md', null)))),
		jsonb_build_array(pg_temp.event_id(c5), jsonb_build_object('schema', 'qorpera.interface-change/v1',
			'commitId', c5 ->> 'commitId', 'seq', pg_temp.seq(c5), 'runId', p ->> 'runId',
			'staffAgentId', '63400000-0000-4000-8000-0000000000a1', 'changes', jsonb_build_array(
				pg_temp.change(1, 'write', 'file', 'QorperaOS/tables/numbers/README.md', v_prior))))) then
		raise exception 'The notes: %', v_notes; end if;
	if pg_temp.note(b) <> pg_temp.noted(0) or (select count(*) from pg_temp.notes(p)) <> 3 then
		raise exception 'A repeat notes nothing more'; end if;
end $$;

-- 3. Refusals: the run check first (a snapshot-v1 binding), then the request, which is {} (22023).
do $$
declare b jsonb := current_setting('qorpera_test.i10_run')::jsonb -> 'binding'; request text;
begin
	perform pg_temp.raises(format('select public.qorpera_folder_note_interface_changes(%L, %L)',
		current_setting('qorpera_test.snapshot_binding'), '{}'), '42501');
	foreach request in array array['[]', '"x"', '1', 'null', '{"operationKey":"x"}', '{"more":1}', '{"":null}'] loop
		perform pg_temp.raises(format('select public.qorpera_folder_note_interface_changes(%L, %L)', b, request), '22023');
	end loop;
	perform pg_temp.raises(format('select public.qorpera_folder_note_interface_changes(%L, null)', b), '22023');
end $$;

-- 4. No note, and no event: another run's commit (the same agent's, in the same conversation) is that run's to note; a
-- commit that saved nothing; a run with no conversation (a silent routine's). A run whose conversation closed is refused
-- by the run check (42501), before the note's own check, which catches a close between the two.
do $$
declare x jsonb := current_setting('qorpera_test.i10_run')::jsonb; b jsonb := x -> 'binding'; p jsonb := x -> 'actor';
	y jsonb := pg_temp.agent_run(); z jsonb := pg_temp.routine_run(); w jsonb := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a2');
	c jsonb; v_events bigint;
begin
	c := pg_temp.commit(y -> 'actor', pg_temp.key('company_write', 'other-1'), jsonb_build_array(
		pg_temp.p16_write(y -> 'actor', 'QorperaOS/tables/areas/README.md', '"Another run''s note."')));
	perform pg_temp.expect(c, 1, 'saved');
	c := pg_temp.commit(p, pg_temp.key('company_write', 'stale-1'), jsonb_build_array(
		pg_temp.plain(p, 'QorperaOS/tables/numbers/README.md', 'Stale.') || jsonb_build_object('expectedVersion', extensions.gen_random_uuid())));
	perform pg_temp.expect(c, 1, 'conflict', 'version_changed');
	if exists (select 1 from public.qorpera_folder_commits where id = (c ->> 'commitId')::uuid and seq is not null) then
		raise exception 'The conflict saved nothing: %', c; end if;
	v_events := (select count(*) from public.qorpera_session_events);
	if pg_temp.note(b) <> pg_temp.noted(0) then raise exception 'Another run''s commit is not this run''s'; end if;
	-- A run with no conversation.
	perform pg_temp.expect(pg_temp.commit(z -> 'actor', pg_temp.key('company_write', 'quiet-1'), jsonb_build_array(
		pg_temp.p16_write(z -> 'actor', 'QorperaOS/tables/numbers/README.md', '"Quietly."'))), 1, 'saved');
	if pg_temp.note(z -> 'binding') <> pg_temp.noted(0) then raise exception 'No conversation, no note'; end if;
	-- A closed conversation (Agent B's own): the run check refuses.
	perform pg_temp.expect(pg_temp.commit(w -> 'actor', pg_temp.key('company_write', 'closed-1'), jsonb_build_array(
		pg_temp.p16_write(w -> 'actor', 'QorperaOS/tables/areas/README.md', '"Closed soon."'))), 1, 'saved');
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set status = %L where id = (select session_id from '
		'public.qorpera_execution_runs where id = %L)', 'closed', w -> 'actor' ->> 'runId'));
	perform pg_temp.raises(format('select public.qorpera_folder_note_interface_changes(%L, %L)', w -> 'binding', '{}'), '42501');
	if (select count(*) from public.qorpera_session_events) <> v_events then raise exception 'No note wrote an event'; end if;
	-- The other run notes its own.
	if pg_temp.note(y -> 'binding') <> pg_temp.noted(1) then raise exception 'The other run notes its commit'; end if;
end $$;

-- 5. The grants and the call list.
do $$
declare v_bad text;
begin
	select string_agg(r, ', ') into v_bad from unnest(array['anon', 'authenticated', 'service_role']) r
	where has_function_privilege(r, 'public.qorpera_folder_note_interface_changes(jsonb,jsonb)', 'execute') is distinct from (r = 'service_role');
	if v_bad is not null then raise exception 'Wrong callers: %', v_bad; end if;
	if not (select p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p
			where p.oid = 'public.qorpera_folder_note_interface_changes(jsonb,jsonb)'::regprocedure) then
		raise exception 'The note is a definer with an empty search path'; end if;
	if (select to_jsonb(array[c.scope, c.budget]) from public.qorpera_native_host_calls c
			where c.name = 'qorpera_folder_note_interface_changes') is distinct from '["binding", "standard"]'::jsonb then
		raise exception 'The call list'; end if;
end $$;

rollback;
