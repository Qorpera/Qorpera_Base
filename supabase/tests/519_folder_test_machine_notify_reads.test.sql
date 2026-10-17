-- @fixture 510_folder_test_machine_views.test.sql until "-- The migration's marker is in every function it patches"
-- A notify continuation takes in a test machine's reads (20260930500000; F3 step 6, slice 6d-3c: deploy/first-node/
-- RUNTIME-FOLDER-TEST-MACHINES.md "Reads", rule 3). A command with notify set wakes its run when it ends; before the wake
-- or the continuation shows how the command ended and what it printed, the woken run takes in the reads of the
-- placement's newest view, when it reads its wake or describes its context. A command whose reads it cannot take in shows
-- as held. The describe takes the locked path while a command waits to be taken in, and reads plain again after. The
-- continuations are built by hand as the machine events drain leaves them (qorpera_folder_insert_continuation and its
-- pin trigger), on 632's run builder; the machine, placement and view helpers are 510's and 639's, the release is 514's,
-- the native rows are 647's and the call counts are 672's.

-- 514's: the view reads the path and releases it.
create function pg_temp.release(p_view jsonb, p_path text) returns jsonb language plpgsql as $$
declare e jsonb := pg_temp.read(p_path, pg_temp.vactor(p_view)) -> 'entry';
begin
	return public.qorpera_folder_record_release('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view),
		extensions.gen_random_uuid(), jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version',
		'authority', e -> 'authority')), repeat('6', 64));
end $$;
-- 518's: whether the run's records hold the path under the inherit id.
create function pg_temp.run_has(p_run jsonb, p_inherit uuid, p_path text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
		where rec.run_id = (p_run ->> 'runId')::uuid and rec.release_id = p_inherit and x ->> 'path' = p_path)
$$;
-- A command of the parent on the anchor's placement, with notify set, that ended (failed, exit code 3, the tail), and
-- its event. Returns the event's id.
create function pg_temp.ended(p_anchor jsonb, p_parent jsonb, p_tail text) returns uuid language plpgsql as $$
declare v_command uuid := extensions.gen_random_uuid(); v_event uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head, notify,
		ended_at, state, exit_code, output_tail, requested_by_user_id)
	select v_command, (p_anchor ->> 'companyMachineId')::uuid, r.id, r.staff_agent_id, (p_anchor ->> 'placementId')::uuid, 'npm test',
		true, clock_timestamp(), 'failed', 3, p_tail, r.requested_by_user_id
	from public.qorpera_execution_runs r where r.id = (p_parent ->> 'runId')::uuid;
	insert into public.qorpera_company_machine_events(id, machine_id, profile_id, environment_id, staff_agent_id, parent_run_id, kind,
		command_id)
	select v_event, (p_anchor ->> 'companyMachineId')::uuid, r.profile_id, r.environment_id, r.staff_agent_id, r.id, 'command', v_command
	from public.qorpera_execution_runs r where r.id = (p_parent ->> 'runId')::uuid;
	set local session_replication_role = origin;
	return v_event;
end $$;
-- The machine runs now: an event with no command.
create function pg_temp.running(p_anchor jsonb, p_parent jsonb) returns uuid language plpgsql as $$
declare v_event uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.fx(format('insert into public.qorpera_company_machine_events(id, machine_id, profile_id, environment_id,
		staff_agent_id, parent_run_id, kind) select %L, %L, profile_id, environment_id, staff_agent_id, id, ''running''
		from public.qorpera_execution_runs where id = %L', v_event, p_anchor ->> 'companyMachineId', p_parent ->> 'runId'));
	return v_event;
end $$;
-- The run carries the active runtime bundle, whose model policy the context checks (647's), and so do its inputs.
create function pg_temp.bundled(p_run jsonb) returns void language plpgsql as $$
declare v_bundle public.qorpera_active_runtime_bundle%rowtype; v_manifest jsonb;
begin
	select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton;
	select manifest into strict v_manifest from public.qorpera_runtime_bundles
	where id = v_bundle.runtime_bundle_id and sha256 = v_bundle.runtime_bundle_sha256;
	perform pg_temp.fx(format('update public.qorpera_execution_runs set runtime_bundle_id = %L, runtime_bundle_sha256 = %L,
		reasoning_effort = %L, reasoning_policy_sha256 = %L, service_tier = ''standard'' where id = %L', v_bundle.runtime_bundle_id,
		v_bundle.runtime_bundle_sha256, v_manifest #>> '{modelPolicy,effort}',
		encode(extensions.digest(convert_to((v_manifest -> 'modelPolicy')::text, 'utf8'), 'sha256'), 'hex'), p_run ->> 'runId'));
	perform pg_temp.fx(format('update public.qorpera_session_inputs set runtime_bundle_id = %L, runtime_bundle_sha256 = %L
		where execution_run_id = %L', v_bundle.runtime_bundle_id, v_bundle.runtime_bundle_sha256, p_run ->> 'runId'));
end $$;
-- 647's native rows (the company's compute identity and login, the run's runner, accepted assignment, native lease,
-- sponsor reservation, model policy and budget row), with this test's identity and capsule. Returns the binding.
create function pg_temp.native(p_actor jsonb) returns jsonb language plpgsql as $$
declare v_run public.qorpera_execution_runs%rowtype; v_identity uuid := '51900000-0000-4000-8000-0000000000d1';
	v_capsule uuid := '51900000-0000-4000-8000-0000000000d2'; v_lease uuid := extensions.gen_random_uuid();
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (p_actor ->> 'runId')::uuid;
	select * into strict v_sponsor from public.qorpera_execution_sponsor_versions
	where binding_id = v_run.sponsor_binding_id and version = v_run.sponsor_version;
	set local session_replication_role = replica;
	insert into public.qorpera_member_compute_identities(id, profile_id, ownership_kind, client_identity_id, display_name)
	values (v_identity, v_run.profile_id, 'company', v_identity, 'Notify reads fixture') on conflict (id) do nothing;
	insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, provider, native_harness,
		encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
	values (v_capsule, v_run.profile_id, v_identity, 'company', 'openai', 'codex-cli', 'fixture://not-a-credential', repeat('e', 64),
		v_run.created_by_user_id) on conflict (id) do nothing;
	insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness, billing_source,
		consent_version, consented_by_user_id, created_by_user_id, credential_capsule_id, max_native_concurrency, quota_policy, allow_autonomous)
	values (v_sponsor.provider_connection_id, v_sponsor.provider_connection_version, 'native_subscription', 'codex-cli', 'subscription',
		'fixture', v_run.created_by_user_id, v_run.created_by_user_id, v_capsule, 8,
		'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}',
		true)
	on conflict (connection_id, version) do nothing;
	update public.qorpera_execution_sponsor_versions set allow_autonomous = true
	where binding_id = v_run.sponsor_binding_id and version = v_run.sponsor_version;
	insert into public.qorpera_runners(id, profile_id, client_runner_id, display_name, capabilities, status, activation_token_sha256,
		activation_expires_at, activated_at, session_token_sha256, session_expires_at, registered_by_user_id, compute_identity_id)
	values ((p_actor ->> 'runnerId')::uuid, v_run.profile_id, (p_actor ->> 'runnerId')::uuid, 'Notify reads runner', '["agent_turn"]',
		'active', repeat('e', 64), clock_timestamp() + interval '1 hour', clock_timestamp(), repeat('f', 64), clock_timestamp() + interval '1 hour',
		v_run.created_by_user_id, v_identity);
	insert into public.qorpera_runner_assignments(id, claim_id, job_id, run_id, runner_id, capability_sha256, status, expires_at, accepted_at)
	values ((p_actor ->> 'assignmentId')::uuid, extensions.gen_random_uuid(), v_run.job_id, v_run.id, (p_actor ->> 'runnerId')::uuid,
		repeat('e', 64), 'accepted', clock_timestamp() + interval '1 hour', clock_timestamp());
	insert into public.qorpera_native_provider_connection_leases(id, run_id, job_id, provider_connection_id, provider_connection_version,
		credential_capsule_id, compute_identity_id, runner_id, assignment_id, lease_token_sha256, expires_at)
	values (v_lease, v_run.id, v_run.job_id, v_sponsor.provider_connection_id, v_sponsor.provider_connection_version, v_capsule,
		v_identity, (p_actor ->> 'runnerId')::uuid, (p_actor ->> 'assignmentId')::uuid, repeat('d', 64), clock_timestamp() + interval '1 hour');
	insert into public.qorpera_execution_sponsor_reservations(run_id, job_id, profile_id, binding_id, sponsor_version, provider_connection_id,
		provider_connection_version, period_start, reserved_microusd)
	values (v_run.id, v_run.job_id, v_run.profile_id, v_run.sponsor_binding_id, v_run.sponsor_version, v_sponsor.provider_connection_id,
		v_sponsor.provider_connection_version, date_trunc('month', clock_timestamp()), 1);
	insert into public.qorpera_runner_model_policies(job_id, profile_id, environment_id, allowed_models, max_calls, max_input_tokens,
		max_output_tokens, authorized_by_user_id)
	values (v_run.job_id, v_run.profile_id, v_run.environment_id, '["gpt-test"]', 32, 1000, 1000, v_run.created_by_user_id);
	insert into public.qorpera_execution_run_budgets(run_id) values (v_run.id);
	update public.qorpera_execution_runs set compute_identity_id = v_identity where id = v_run.id;
	set local session_replication_role = origin;
	return jsonb_build_object('leaseId', v_lease, 'runId', v_run.id, 'jobId', v_run.job_id, 'runnerId', p_actor ->> 'runnerId',
		'assignmentId', p_actor ->> 'assignmentId', 'credentialCapsuleId', v_capsule, 'computeIdentityId', v_identity,
		'provider', 'openai', 'nativeHarness', 'codex-cli', 'model', 'gpt-test');
end $$;
-- The parent's continuation with the events: a leased run of agent A for the parent's requester and audience, in the
-- parent's conversation, its wake as the drain inserts it and the pin trigger fills it (the parent's causal chain), and
-- the events delivered to it. Both runs carry the active bundle. Returns the binding the runtime sends, with the run's
-- wake id (which the helpers below leave out of the binding).
create function pg_temp.continuation(p_parent jsonb, p_events uuid[]) returns jsonb language plpgsql as $$
declare v_parent public.qorpera_execution_runs%rowtype; v_parent_wake public.qorpera_wake_occurrences%rowtype; w jsonb; v_wake uuid;
begin
	select * into strict v_parent from public.qorpera_execution_runs where id = (p_parent ->> 'runId')::uuid;
	select * into strict v_parent_wake from public.qorpera_wake_occurrences where run_id = v_parent.id;
	w := pg_temp.run('agent', v_parent.requested_by_user_id, v_parent.audience_kind);
	select id into strict v_wake from public.qorpera_wake_occurrences where run_id = (w ->> 'runId')::uuid;
	perform pg_temp.fx(format('update public.qorpera_execution_runs set session_id = %L where id = %L', v_parent.session_id,
		w ->> 'runId'));
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set trigger_id = ''machine-event'', source_kind = ''machine-event'',
		source_id = %L, occurrence_key = %L, parent_run_id = %L, session_id = %L, causal_root_id = %L, causal_agent_ids = %L::uuid[],
		payload = public.qorpera_machine_event_payload(%L::uuid, %L::uuid[]) where id = %L', p_events[1], 'machine-event:' || v_wake,
		v_parent.id, v_parent.session_id, v_parent_wake.causal_root_id, v_parent_wake.causal_agent_ids, v_parent.id, p_events, v_wake));
	perform pg_temp.fx(format('update public.qorpera_company_machine_events set delivery = ''delivered'', occurrence_id = %L,
		scanned_at = clock_timestamp() where id = any(%L::uuid[])', v_wake, p_events));
	perform pg_temp.bundled(p_parent);
	perform pg_temp.bundled(w);
	return pg_temp.native(w) || jsonb_build_object('wakeId', v_wake);
end $$;
-- The run's continuation events (qorpera_machine_run_continuation), as it is shown them now.
create function pg_temp.cont_events(p_binding jsonb) returns jsonb language sql as $$
	select public.qorpera_machine_run_continuation(r) -> 'events' from public.qorpera_execution_runs r
	where r.id = (p_binding ->> 'runId')::uuid
$$;
-- An event that shows how the command ended (failed, exit code 3) and the tail; one that holds them back.
create function pg_temp.shows(p_event jsonb, p_tail text) returns boolean language sql as $$
	select coalesce(p_event ->> 'commandState' = 'failed' and p_event ->> 'exitCode' = '3' and p_event ->> 'outputTail' = p_tail, false)
$$;
create function pg_temp.held(p_event jsonb) returns boolean language sql as $$
	select coalesce(p_event ->> 'commandState' = 'held' and p_event -> 'exitCode' = 'null'::jsonb
		and p_event -> 'outputTail' = 'null'::jsonb and p_event ->> 'command' = 'npm test', false)
$$;
create function pg_temp.pending(p_binding jsonb) returns boolean language sql as $$
	select public.qorpera_folder_test_machine_notify_pending(p_binding - 'wakeId')
$$;
-- The wake read as the platform's service caller on its own RPC path (672's).
create function pg_temp.wake(p_binding jsonb) returns jsonb language plpgsql as $$
declare v jsonb; v_claims text := coalesce(current_setting('request.jwt.claims', true), '');
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform set_config('request.path', '/rpc/qorpera_read_native_wake', true);
	execute format('select public.qorpera_read_native_wake(%L::jsonb)', p_binding - 'wakeId') into v;
	perform set_config('request.path', '', true);
	perform set_config('request.jwt.claims', v_claims, true);
	return v;
end $$;
-- This transaction's calls of the plain read, the locked run check, the context check's reads check, the take-in and
-- the view's take-in (672's, with the last two).
create function pg_temp.n_calls() returns bigint[] language sql as $$
	select array_agg(coalesce((select sum(f.calls) from pg_stat_xact_user_functions f
		where f.schemaname = 'public' and f.funcname = n.name), 0)::bigint order by n.ordinal)
	from unnest(array['qorpera_folder_native_run_plain', 'qorpera_folder_tool_run', 'qorpera_folder_run_reads_current',
		'qorpera_folder_test_machine_notify_take_in', 'qorpera_folder_run_inherit_view_reads']) with ordinality as n(name, ordinal)
$$;
-- The context describe one way, as 672 calls it: as the entry point by request.path (the plain read the host reaches),
-- or by direct SQL with no request.path (the locked path). Returns its answer and its calls.
create function pg_temp.n_way(p_binding jsonb, p_way text) returns jsonb language plpgsql as $$
declare v jsonb; v_at bigint[] := pg_temp.n_calls(); v_after bigint[];
	v_claims text := coalesce(current_setting('request.jwt.claims', true), '');
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform set_config('request.path', case p_way when 'plain' then '/rpc/qorpera_describe_company_run_context' else '' end, true);
	execute format('select public.qorpera_describe_company_run_context(%L::jsonb)', p_binding - 'wakeId') into v;
	perform set_config('request.path', '', true);
	perform set_config('request.jwt.claims', v_claims, true);
	v_after := pg_temp.n_calls();
	return jsonb_build_object('answer', v, 'calls', to_jsonb(array[v_after[1] - v_at[1], v_after[2] - v_at[2], v_after[3] - v_at[3],
		v_after[4] - v_at[4], v_after[5] - v_at[5]]));
end $$;
-- Whether the describe's continuation holds the text (a command's tail shows only when the command is not held).
create function pg_temp.told(p_way jsonb, p_tail text) returns boolean language sql as $$
	select strpos(coalesce((p_way #> '{answer,continuation}')::text, ''), p_tail) > 0
$$;
set local track_functions = 'all';


-- 0. The new functions are internal: security definers with an empty search path, not owned by an API role, that no API
--    role may run. The wake read, the describe and the continuation carry the marker; the describe keeps 499000's.
do $$
declare f text; r name; p pg_proc%rowtype;
begin
	foreach f in array array['public.qorpera_folder_test_machine_notify_inherit_id(uuid,uuid)',
		'public.qorpera_folder_test_machine_event_shown(uuid,uuid,uuid,uuid)',
		'public.qorpera_folder_test_machine_event_hold(uuid,uuid,uuid,jsonb)',
		'public.qorpera_folder_test_machine_notify_take_in(public.qorpera_execution_runs,jsonb)',
		'public.qorpera_folder_test_machine_notify_pending(jsonb)'] loop
		select * into p from pg_proc where oid = f::regprocedure;
		if not p.prosecdef or p.proconfig is distinct from array['search_path=""']
			or pg_get_userbyid(p.proowner) in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '% is a security definer with an empty search path and no API owner', f; end if;
		foreach r in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker']::name[] loop
			if has_function_privilege(r, f, 'EXECUTE') then raise exception '% may run %', r, f; end if;
		end loop;
	end loop;
	foreach f in array array['public.qorpera_folder_read_wake(jsonb)', 'public.qorpera_describe_company_run_context(jsonb)',
		'public.qorpera_machine_run_continuation(public.qorpera_execution_runs,integer)'] loop
		if strpos(pg_get_functiondef(f::regprocedure), '20260930500000') = 0 then raise exception '% carries 20260930500000', f; end if;
	end loop;
	if strpos(pg_get_functiondef('public.qorpera_describe_company_run_context(jsonb)'::regprocedure), '20260930499000') = 0 then
		raise exception 'The describe keeps 20260930499000'; end if;
	if public.qorpera_folder_test_machine_notify_inherit_id('51900000-0000-4000-8000-000000000001', '51900000-0000-4000-8000-000000000002')
		is distinct from md5('test-machine-notify:51900000-0000-4000-8000-000000000001:51900000-0000-4000-8000-000000000002')::uuid then
		raise exception 'The inherit id comes from the wake and the view'; end if;
	-- A binding without a run id, or with an unknown one, has nothing to take in.
	if pg_temp.pending('{}') or pg_temp.pending('{"runId":"not-a-uuid"}')
		or pg_temp.pending(jsonb_build_object('runId', extensions.gen_random_uuid())) then
		raise exception 'A binding without a known run has nothing to take in'; end if;
end $$;

-- Setup: nr/ with two files, which the machines read, and the folder index the context names the company from.
do $$
declare a jsonb := pg_temp.stage('notify reads');
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'nr-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','nr'),
		jsonb_build_object('op','write','path','nr/a.txt','file',a), jsonb_build_object('op','write','path','nr/b.txt','file',a))), 3, 'saved');
	perform pg_temp.fx(format('insert into public.qorpera_folder_company_index(environment_id, profile_id, name, vision_path_version,
		vision_seeded, commit_id) select %L, %L, %L, %L, true, %L where not exists (select 1 from public.qorpera_folder_company_index
		where environment_id = %L)', '63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-000000000010', 'Nordlys',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), '63200000-0000-4000-8000-000000000020'));
end $$;


-- 1. The wake read takes in what the machine's view read before it shows how the command ended: until then the
--    continuation holds the command back, and a running event is shown as stored. A second read replays: it shows the
--    same and copies nothing. The stored wake is unchanged. The describe then reads plain again.
do $$
declare c_m2 constant uuid := '63200000-0000-4000-8000-000000000002'; t constant text := 'nr-519 wake: 3 tests failed';
	p jsonb := pg_temp.run('human', c_m2); m uuid := pg_temp.machine(p, 'notify-wake'); a jsonb := pg_temp.place(m);
	s jsonb; e uuid; r uuid; b jsonb; k uuid; v jsonb; w jsonb; n bigint; stored jsonb; d jsonb;
begin
	s := pg_temp.open_machine(a);
	perform pg_temp.release(s, 'nr/a.txt');
	e := pg_temp.ended(a, p, t);
	r := pg_temp.running(a, p);
	b := pg_temp.continuation(p, array[e, r]);
	k := public.qorpera_folder_test_machine_notify_inherit_id((b ->> 'wakeId')::uuid, (s ->> 'viewId')::uuid);
	select payload into strict stored from public.qorpera_wake_occurrences where id = (b ->> 'wakeId')::uuid;
	if not pg_temp.shows(stored #> '{events,0}', t) then raise exception 'The stored wake: %', stored; end if;
	if not pg_temp.pending(b) or not pg_temp.held(pg_temp.cont_events(b) -> 0)
		or pg_temp.cont_events(b) #>> '{1,kind}' is distinct from 'running' or pg_temp.cont_events(b) #>> '{1,commandState}' is not null then
		raise exception 'Before the take-in the continuation holds the command: %', pg_temp.cont_events(b); end if;
	v := pg_temp.wake(b);
	if not pg_temp.shows(v #> '{payload,events,0}', t) or v #>> '{payload,events,1,kind}' is distinct from 'running'
		or v #>> '{payload,events,1,commandState}' is not null then
		raise exception 'The wake shows the command: %', v -> 'payload'; end if;
	if not pg_temp.run_has(b, k, 'nr/a.txt') or (select count(*) from public.qorpera_folder_run_inheritances i
			where i.run_id = (b ->> 'runId')::uuid) <> 1
		or not exists (select 1 from public.qorpera_folder_run_inheritances i where i.run_id = (b ->> 'runId')::uuid and i.inherit_id = k
			and i.view_id = (s ->> 'viewId')::uuid) then
		raise exception 'The wake read takes in the view''s reads under the wake''s and the view''s id'; end if;
	if pg_temp.pending(b) or not pg_temp.shows(pg_temp.cont_events(b) -> 0, t) then
		raise exception 'After the take-in the continuation shows the command: %', pg_temp.cont_events(b); end if;
	select count(*) into n from public.qorpera_folder_run_read_records where run_id = (b ->> 'runId')::uuid;
	w := pg_temp.wake(b);
	if w -> 'payload' is distinct from v -> 'payload'
		or (select count(*) from public.qorpera_folder_run_read_records where run_id = (b ->> 'runId')::uuid) <> n then
		raise exception 'A second wake read replays'; end if;
	if (select payload from public.qorpera_wake_occurrences where id = (b ->> 'wakeId')::uuid) is distinct from stored then
		raise exception 'The stored wake is unchanged'; end if;
	-- Nothing waits: the describe reads plain, its nested describe too, and its continuation shows the command.
	d := pg_temp.n_way(b, 'plain');
	if d -> 'calls' is distinct from '[2,0,0,0,0]'::jsonb or not pg_temp.told(d, t) then
		raise exception 'The describe reads plain once nothing waits: % %', d -> 'calls', d #> '{answer,continuation}'; end if;
end $$;

-- 2. The describe takes the locked path while a command waits and takes it in there, before it builds the continuation;
--    its nested describe still reads plain. A second machine's view opened after its command ended: that command shows
--    as stored, and nothing of it is taken in. Then the describe reads plain again, the wake read replays the take-in, and
--    a direct describe (the locked path) takes in nothing new.
do $$
declare c_m2 constant uuid := '63200000-0000-4000-8000-000000000002';
	t constant text := 'nr-519 describe: 3 tests failed'; t2 constant text := 'nr-519 later view: 3 tests failed';
	p jsonb := pg_temp.run('human', c_m2); m uuid := pg_temp.machine(p, 'notify-describe'); a jsonb := pg_temp.place(m);
	m2 uuid := pg_temp.machine(p, 'notify-later-view'); a2 jsonb := pg_temp.place(m2);
	s jsonb; s2 jsonb; e uuid; e2 uuid; b jsonb; d jsonb; w jsonb; n bigint;
begin
	s := pg_temp.open_machine(a);
	perform pg_temp.release(s, 'nr/b.txt');
	e := pg_temp.ended(a, p, t);
	e2 := pg_temp.ended(a2, p, t2);
	s2 := pg_temp.open_machine(a2);
	perform pg_temp.release(s2, 'nr/a.txt');
	b := pg_temp.continuation(p, array[e, e2]);
	if not pg_temp.pending(b) or not pg_temp.held(pg_temp.cont_events(b) -> 0) or not pg_temp.shows(pg_temp.cont_events(b) -> 1, t2) then
		raise exception 'Before the take-in: %', pg_temp.cont_events(b); end if;
	d := pg_temp.n_way(b, 'plain');
	if d -> 'calls' is distinct from '[1,1,1,1,1]'::jsonb or not pg_temp.told(d, t) or not pg_temp.told(d, t2) then
		raise exception 'A waiting command sends the describe down the locked path: % %', d -> 'calls', d #> '{answer,continuation}'; end if;
	if not pg_temp.run_has(b, public.qorpera_folder_test_machine_notify_inherit_id((b ->> 'wakeId')::uuid, (s ->> 'viewId')::uuid),
			'nr/b.txt')
		or exists (select 1 from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.run_id = (b ->> 'runId')::uuid and x ->> 'path' = 'nr/a.txt')
		or (select jsonb_agg(i.view_id) from public.qorpera_folder_run_inheritances i where i.run_id = (b ->> 'runId')::uuid)
			is distinct from jsonb_build_array(s ->> 'viewId') then
		raise exception 'The describe takes in the first view only'; end if;
	if pg_temp.pending(b) then raise exception 'Nothing waits after the describe''s take-in'; end if;
	d := pg_temp.n_way(b, 'plain');
	if d -> 'calls' is distinct from '[2,0,0,0,0]'::jsonb or not pg_temp.told(d, t) then
		raise exception 'The describe reads plain again: %', d -> 'calls'; end if;
	-- The wake read replays the take-in (it copies the parent's reads under the wake's id, 20260928279580).
	w := pg_temp.wake(b);
	if not pg_temp.shows(w #> '{payload,events,0}', t) or not pg_temp.shows(w #> '{payload,events,1}', t2)
		or (select jsonb_agg(i.view_id) from public.qorpera_folder_run_inheritances i where i.run_id = (b ->> 'runId')::uuid)
			is distinct from jsonb_build_array(s ->> 'viewId') then
		raise exception 'The wake read replays the describe''s take-in: %', w #> '{payload,events}'; end if;
	select count(*) into n from public.qorpera_folder_run_read_records where run_id = (b ->> 'runId')::uuid;
	d := pg_temp.n_way(b, 'locked');
	if d -> 'calls' is distinct from '[0,2,1,1,0]'::jsonb or not pg_temp.told(d, t)
		or (select count(*) from public.qorpera_folder_run_read_records where run_id = (b ->> 'runId')::uuid) <> n then
		raise exception 'The locked describe takes in nothing new: %', d -> 'calls'; end if;
end $$;

-- 3. A run without the company-wide view may not take in a machine's reads: the take-in is refused and undone, and the
--    command stays held, in the wake, the continuation and the describe, which keeps the locked path. A machine that never
--    had a view shows its command in the same wake.
do $$
declare c_m2 constant uuid := '63200000-0000-4000-8000-000000000002'; c_m4 constant uuid := '63200000-0000-4000-8000-000000000004';
	t constant text := 'nr-519 private: 3 tests failed'; t2 constant text := 'nr-519 no view: 3 tests failed';
	v jsonb := pg_temp.run('human', c_m2); p jsonb := pg_temp.run('human', c_m4, 'member_private');
	m uuid := pg_temp.machine(v, 'notify-private'); a jsonb := pg_temp.place(m);
	m2 uuid := pg_temp.machine(p, 'notify-no-view'); a2 jsonb := pg_temp.place(m2);
	s jsonb; b jsonb; w jsonb; d jsonb;
begin
	s := pg_temp.open_machine(a);
	perform pg_temp.release(s, 'nr/a.txt');
	b := pg_temp.continuation(p, array[pg_temp.ended(a, p, t), pg_temp.ended(a2, p, t2)]);
	w := pg_temp.wake(b);
	if not pg_temp.held(w #> '{payload,events,0}') or not pg_temp.shows(w #> '{payload,events,1}', t2) then
		raise exception 'The private run''s wake holds the first command: %', w #> '{payload,events}'; end if;
	if exists (select 1 from public.qorpera_folder_run_inheritances where run_id = (b ->> 'runId')::uuid)
		or exists (select 1 from public.qorpera_folder_run_read_records where run_id = (b ->> 'runId')::uuid) then
		raise exception 'A refused take-in is undone'; end if;
	if not pg_temp.pending(b) or not pg_temp.held(pg_temp.cont_events(b) -> 0) or not pg_temp.shows(pg_temp.cont_events(b) -> 1, t2) then
		raise exception 'The continuation holds the first command: %', pg_temp.cont_events(b); end if;
	-- The view's take-in raises, so its call is not counted.
	d := pg_temp.n_way(b, 'plain');
	if d -> 'calls' is distinct from '[1,1,1,1,0]'::jsonb or pg_temp.told(d, t) or not pg_temp.told(d, t2) then
		raise exception 'The describe holds the first command on the locked path: % %', d -> 'calls', d #> '{answer,continuation}'; end if;
end $$;

-- 4. Agent A can no longer read what the machine read (nr/ narrows to a resource it holds no grant on): the take-in is
--    refused and undone, and the command stays held.
do $$
declare c_m2 constant uuid := '63200000-0000-4000-8000-000000000002'; c_m4 constant uuid := '63200000-0000-4000-8000-000000000004';
	t constant text := 'nr-519 unreadable: 3 tests failed';
	v jsonb := pg_temp.run('human', c_m2); p jsonb := pg_temp.run('human', c_m4);
	m uuid := pg_temp.machine(v, 'notify-unreadable'); a jsonb := pg_temp.place(m); s jsonb; b jsonb; w jsonb;
begin
	s := pg_temp.open_machine(a);
	perform pg_temp.release(s, 'nr/a.txt');
	b := pg_temp.continuation(p, array[pg_temp.ended(a, p, t)]);
	begin
		perform public.qorpera_folder_set_resource('63200000-0000-4000-8000-000000000020', pg_temp.member(1), 'nr', 'subtree',
			'company_shared', 'normal');
		w := pg_temp.wake(b);
		if not pg_temp.held(w #> '{payload,events,0}') or not pg_temp.held(pg_temp.cont_events(b) -> 0) or not pg_temp.pending(b)
			or exists (select 1 from public.qorpera_folder_run_inheritances where run_id = (b ->> 'runId')::uuid)
			or exists (select 1 from public.qorpera_folder_run_read_records where run_id = (b ->> 'runId')::uuid) then
			raise exception 'An unreadable read holds the command: %', w #> '{payload,events}'; end if;
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	-- Readable again: the next wake read takes it in.
	w := pg_temp.wake(b);
	if not pg_temp.shows(w #> '{payload,events,0}', t) or pg_temp.pending(b) then
		raise exception 'The command shows once its reads are readable again'; end if;
end $$;
