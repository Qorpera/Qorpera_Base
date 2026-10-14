-- @fixture 769_folder_core_review_recorder.test.sql until "-- The files the runs delete"
-- Interfaces I10 (deploy/first-node/RUNTIME-INTERFACES.md §9 decision 2, §10 row I10; 20260930370000): the note of a
-- run's save_interface commit in its conversation, a native host call. What the note names (each version the commit
-- made, with the one before it), whose event it is, one note a commit, when there is none (no commit of this run under
-- the key, a commit that saved nothing, no conversation), the refusals (a closed conversation's run among them), and the
-- grants. Runs are 647's with their native rows; the commits write plain files, since the note reads only what a
-- commit's units made.

create function pg_temp.note(p_binding jsonb, p_key text) returns jsonb language sql as $$
	select public.qorpera_folder_note_interface_change(p_binding, jsonb_build_object('operationKey', p_key))
$$;
-- The commit's key for the model's key, as save_interface makes it.
create function pg_temp.key(p_model_key text) returns text language sql immutable as $$
	select 'save_interface:' || pg_temp.hash(p_model_key)
$$;
create function pg_temp.version(p_path text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '63400000-0000-4000-8000-000000000020'
		and key_text = lower(p_path) and kind <> 'claim'
$$;
-- The notes in a run's conversation.
create function pg_temp.notes(p_actor jsonb) returns setof public.qorpera_session_events language sql as $$
	select e.* from public.qorpera_session_events e join public.qorpera_execution_runs r on r.session_id = e.session_id
	where r.id = (p_actor ->> 'runId')::uuid and e.body ->> 'schema' = 'qorpera.interface-change/v1'
$$;
create function pg_temp.none() returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.interface-change-note/v1', 'noted', false, 'eventId', null)
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

-- 1. A run's commit: a new file, a rewrite of the member's file, and a new folder with two files. The note names each
-- version in unit and path order, with the version each replaced; it is a session_info event in the run's conversation,
-- from the member the run is for, with no run identity. A replay finds the same note.
do $$
declare m jsonb := pg_temp.member(2); x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor';
	v_old uuid; c jsonb; v_commit public.qorpera_folder_commits%rowtype; v_event uuid; r jsonb;
	e public.qorpera_session_events%rowtype; v_changes jsonb;
begin
	perform pg_temp.expect(pg_temp.commit(m, 'i10-setup', jsonb_build_array(jsonb_build_object('op', 'write', 'path', 'i10-old.md',
		'file', pg_temp.stage('Old page.', m)))), 1, 'saved');
	v_old := pg_temp.version('i10-old.md');
	c := pg_temp.commit(p, pg_temp.key('page-1'), jsonb_build_array(
		jsonb_build_object('op', 'write', 'path', 'i10-new.md', 'file', pg_temp.stage('New page.', p)),
		jsonb_build_object('op', 'write', 'path', 'i10-old.md', 'file', pg_temp.stage('Changed page.', p), 'expectedVersion', v_old),
		jsonb_build_object('op', 'new_folder', 'path', 'i10-pages', 'contents', jsonb_build_array(
			jsonb_build_object('path', 'b.md', 'kind', 'file', 'file', pg_temp.stage('Page B.', p)),
			jsonb_build_object('path', 'a.md', 'kind', 'file', 'file', pg_temp.stage('Page A.', p))))));
	perform pg_temp.expect(c, 1, 'saved');
	perform pg_temp.expect(c, 2, 'saved');
	perform pg_temp.expect(c, 3, 'saved');
	select * into strict v_commit from public.qorpera_folder_commits where id = (c ->> 'commitId')::uuid;
	v_event := md5('qorpera.interface-change:' || v_commit.id::text)::uuid;
	r := pg_temp.note(b, pg_temp.key('page-1'));
	if r <> jsonb_build_object('schema', 'qorpera.interface-change-note/v1', 'noted', true, 'eventId', v_event) then
		raise exception 'The note: %', r; end if;
	select * into strict e from pg_temp.notes(p);
	v_changes := jsonb_build_array(
		jsonb_build_object('unit', 1, 'op', 'write', 'kind', 'file', 'path', 'i10-new.md', 'version', pg_temp.version('i10-new.md'),
			'priorVersion', null),
		jsonb_build_object('unit', 2, 'op', 'write', 'kind', 'file', 'path', 'i10-old.md', 'version', pg_temp.version('i10-old.md'),
			'priorVersion', v_old),
		jsonb_build_object('unit', 3, 'op', 'mkdir', 'kind', 'folder', 'path', 'i10-pages', 'version', pg_temp.version('i10-pages'),
			'priorVersion', null),
		jsonb_build_object('unit', 3, 'op', 'write', 'kind', 'file', 'path', 'i10-pages/a.md',
			'version', pg_temp.version('i10-pages/a.md'), 'priorVersion', null),
		jsonb_build_object('unit', 3, 'op', 'write', 'kind', 'file', 'path', 'i10-pages/b.md',
			'version', pg_temp.version('i10-pages/b.md'), 'priorVersion', null));
	if e.event_id <> v_event or e.event_type <> 'session_info' or e.actor_user_id <> '63400000-0000-4000-8000-000000000002'
		or e.execution_kind is not null or e.execution_id is not null or e.runner_assignment_id is not null
		or e.body <> jsonb_build_object('schema', 'qorpera.interface-change/v1', 'commitId', v_commit.id, 'seq', v_commit.seq,
			'runId', p ->> 'runId', 'staffAgentId', '63400000-0000-4000-8000-0000000000a1', 'changes', v_changes)
		or v_commit.seq is null or v_old = pg_temp.version('i10-old.md') then
		raise exception 'The event: %', to_jsonb(e); end if;
	-- A replay finds its note; the conversation holds one.
	if pg_temp.note(b, pg_temp.key('page-1')) <> r or (select count(*) from pg_temp.notes(p)) <> 1 then
		raise exception 'A replay notes once'; end if;
	perform set_config('qorpera_test.i10_run', x::text, true);
end $$;

-- 2. Refusals: the run check first (a snapshot-v1 binding), then the request's shape (22023).
do $$
declare b jsonb := current_setting('qorpera_test.i10_run')::jsonb -> 'binding'; request text;
begin
	perform pg_temp.raises(format('select public.qorpera_folder_note_interface_change(%L, %L)',
		current_setting('qorpera_test.snapshot_binding'), jsonb_build_object('operationKey', pg_temp.key('page-1'))), '42501');
	foreach request in array array['[]', '"x"', '1', 'null', '{}', '{"operationKey":null}', '{"operationKey":1}',
		'{"operationKey":["x"]}',
		jsonb_build_object('operationKey', pg_temp.key('page-1'), 'more', 1)::text,
		jsonb_build_object('operationKey', 'save_interface:')::text,
		jsonb_build_object('operationKey', pg_temp.hash('page-1'))::text,
		jsonb_build_object('operationKey', 'save_interface:' || upper(pg_temp.hash('page-1')))::text,
		jsonb_build_object('operationKey', 'table_write:' || pg_temp.hash('page-1'))::text,
		jsonb_build_object('operationKey', pg_temp.key('page-1') || '0')::text,
		jsonb_build_object('operationKey', ' ' || pg_temp.key('page-1'))::text,
		jsonb_build_object('operationKey', pg_temp.key('page-1') || E'\n')::text] loop
		perform pg_temp.raises(format('select public.qorpera_folder_note_interface_change(%L, %L)', b, request), '22023');
	end loop;
	perform pg_temp.raises(format('select public.qorpera_folder_note_interface_change(%L, null)', b), '22023');
end $$;

-- 3. No note, and no event: no commit under the key, another run's commit (the same agent's, in the same conversation),
-- a commit that saved nothing, a run with no conversation (a silent routine's). A run whose conversation closed is
-- refused by the run check (42501), before the note's own check, which catches a close between the two.
do $$
declare x jsonb := current_setting('qorpera_test.i10_run')::jsonb; b jsonb := x -> 'binding'; p jsonb := x -> 'actor';
	y jsonb := pg_temp.agent_run(); z jsonb := pg_temp.routine_run(); w jsonb := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a2');
	c jsonb; v_events bigint := (select count(*) from public.qorpera_session_events);
begin
	if pg_temp.note(b, pg_temp.key('page-none')) <> pg_temp.none() then raise exception 'No commit, no note'; end if;
	perform pg_temp.expect(pg_temp.commit(y -> 'actor', pg_temp.key('page-2'), jsonb_build_array(jsonb_build_object('op', 'write',
		'path', 'i10-other.md', 'file', pg_temp.stage('Other page.', y -> 'actor')))), 1, 'saved');
	if pg_temp.note(b, pg_temp.key('page-2')) <> pg_temp.none() then raise exception 'Another run''s commit is not this run''s'; end if;
	c := pg_temp.commit(p, pg_temp.key('page-3'), jsonb_build_array(jsonb_build_object('op', 'write', 'path', 'i10-new.md',
		'file', pg_temp.stage('Stale page.', p), 'expectedVersion', extensions.gen_random_uuid())));
	perform pg_temp.expect(c, 1, 'conflict', 'version_changed');
	if exists (select 1 from public.qorpera_folder_commits where id = (c ->> 'commitId')::uuid and seq is not null) then
		raise exception 'The conflict saved nothing: %', c; end if;
	if pg_temp.note(b, pg_temp.key('page-3')) <> pg_temp.none() then raise exception 'A commit that saved nothing has no note'; end if;
	-- A run with no conversation.
	perform pg_temp.expect(pg_temp.commit(z -> 'actor', pg_temp.key('page-4'), jsonb_build_array(jsonb_build_object('op', 'write',
		'path', 'i10-quiet.md', 'file', pg_temp.stage('Quiet page.', z -> 'actor')))), 1, 'saved');
	if pg_temp.note(z -> 'binding', pg_temp.key('page-4')) <> pg_temp.none() then raise exception 'No conversation, no note'; end if;
	-- A closed conversation (Agent B's own): the run check refuses.
	perform pg_temp.expect(pg_temp.commit(w -> 'actor', pg_temp.key('page-5'), jsonb_build_array(jsonb_build_object('op', 'write',
		'path', 'i10-closed.md', 'file', pg_temp.stage('Closed page.', w -> 'actor')))), 1, 'saved');
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set status = %L where id = (select session_id from '
		'public.qorpera_execution_runs where id = %L)', 'closed', w -> 'actor' ->> 'runId'));
	perform pg_temp.raises(format('select public.qorpera_folder_note_interface_change(%L, %L)', w -> 'binding',
		jsonb_build_object('operationKey', pg_temp.key('page-5'))), '42501');
	if (select count(*) from public.qorpera_session_events) <> v_events then raise exception 'No note wrote an event'; end if;
end $$;

-- 4. The grants and the call list.
do $$
declare v_bad text;
begin
	select string_agg(r, ', ') into v_bad from unnest(array['anon', 'authenticated', 'service_role']) r
	where has_function_privilege(r, 'public.qorpera_folder_note_interface_change(jsonb,jsonb)', 'execute') is distinct from (r = 'service_role');
	if v_bad is not null then raise exception 'Wrong callers: %', v_bad; end if;
	if not (select p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p
			where p.oid = 'public.qorpera_folder_note_interface_change(jsonb,jsonb)'::regprocedure) then
		raise exception 'The note is a definer with an empty search path'; end if;
	if (select to_jsonb(array[c.scope, c.budget]) from public.qorpera_native_host_calls c
			where c.name = 'qorpera_folder_note_interface_change') is distinct from '["binding", "standard"]'::jsonb then
		raise exception 'The call list'; end if;
end $$;

rollback;
