-- @fixture 632_folder_core_agents.test.sql until "-- A leased run of agent A saves as the agent"
-- Company folder core, C1b-3a (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1B.md, "C1b-3: views"): views for run
-- boxes, computer desktops and coding sessions. Offices, screens, activations and coding sessions are built by hand,
-- as runs are in 632. Races are in 644.

-- A company machine with one seat for agent A: office, current activation on allocation ...e1 (node ...e2), the
-- seat's screen, and A's computer access.
create function pg_temp.office() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_offices(id, profile_id, environment_id, logical_computer_id, client_computer_id, image_sha256,
		bootstrap_sha256, state, generation, revision, max_screens, created_by_user_id, privacy_state, privacy_version, computer_number)
	values ('63900000-0000-4000-8000-0000000000e0', '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('1', 64), repeat('2', 64), 'active', 1, 1, 6,
		'63200000-0000-4000-8000-000000000001', 'shared', 0, 1);
	insert into public.qorpera_runtime_machine_allocations(id, profile_id, provider_adapter, instance_sha256, office_id, computer_generation, reserved_at)
	values ('63900000-0000-4000-8000-0000000000e1', '63200000-0000-4000-8000-000000000010', 'lxd', repeat('3', 64),
		'63900000-0000-4000-8000-0000000000e0', 1, clock_timestamp());
	insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis, memory_bytes, reserved_at)
	values ('63900000-0000-4000-8000-0000000000e1', '63900000-0000-4000-8000-0000000000e2', 'lxd', 'node', repeat('4', 64), 1000, 1073741824,
		clock_timestamp());
	insert into public.qorpera_runtime_office_activations(intent_id, activation_id, office_id, computer_generation, allocation_id, provider_id,
		provider_policy_sha256, provider_binding_sha256, instance_sha256, image_sha256, bootstrap_sha256, attestation, mappings, state,
		service_invocation_id, ready_at, activated_at)
	values (extensions.gen_random_uuid(), '63900000-0000-4000-8000-0000000000e3', '63900000-0000-4000-8000-0000000000e0', 1,
		'63900000-0000-4000-8000-0000000000e1', extensions.gen_random_uuid(), repeat('5', 64), repeat('6', 64), repeat('3', 64),
		repeat('1', 64), repeat('2', 64), '{}', '{}', 'active', repeat('7', 32), clock_timestamp(), clock_timestamp());
	insert into public.qorpera_runtime_office_screens(id, office_id, ordinal, staff_agent_id, generation, epoch, power)
	values ('63900000-0000-4000-8000-0000000000e4', '63900000-0000-4000-8000-0000000000e0', 1, '63200000-0000-4000-8000-0000000000a1',
		1, 1, 'open');
	insert into public.qorpera_runtime_office_access(office_id, staff_agent_id, profile_id, version, state, capabilities, configured_by_user_id)
	values ('63900000-0000-4000-8000-0000000000e0', '63200000-0000-4000-8000-0000000000a1', '63200000-0000-4000-8000-000000000010', 1,
		'active', '["desktop","shell"]', '63200000-0000-4000-8000-000000000001');
	set local session_replication_role = origin;
end $$;

-- The screen held by a run (its lease), by a member (takeover), or by nobody.
create function pg_temp.hold(p_run jsonb, p_member uuid default null) returns void language plpgsql as $$
begin
	perform pg_temp.fx(format('update public.qorpera_runtime_office_screens set lease_id = %L, run_id = %L, lease_expires_at = %L,
		grant_version = %L, native_binding = %L, takeover_user_id = %L, epoch = epoch + 1 where id = %L',
		case when p_run is not null then extensions.gen_random_uuid() end, p_run ->> 'runId',
		case when p_run is not null then clock_timestamp() + interval '5 minutes' end, case when p_run is not null then 1 end,
		case when p_run is not null then '{}' end, p_member, '63900000-0000-4000-8000-0000000000e4'));
end $$;

create function pg_temp.open(p_kind text, p_anchor jsonb, p_opener jsonb default '{"kind":"platform"}') returns jsonb language sql as $$
	select public.qorpera_folder_view_open('63200000-0000-4000-8000-000000000020', p_opener, p_kind, p_anchor)
$$;
create function pg_temp.vactor(p_view jsonb) returns jsonb language sql as $$
	select jsonb_build_object('kind','view','viewId',p_view ->> 'viewId','pass',p_view ->> 'pass')
$$;
create function pg_temp.vcommit(p_view jsonb, p_key text, p_units jsonb, p_review uuid default null) returns jsonb language sql as $$
	select public.qorpera_folder_commit('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_key, p_units, p_review)
$$;
create function pg_temp.last_commit(p_result jsonb) returns public.qorpera_folder_commits language sql as $$
	select * from public.qorpera_folder_commits where id = (p_result ->> 'commitId')::uuid
$$;
-- A coding worker's leased turn: an agent wake from the worker's dispatch, under its steering run p_parent (as in 634).
create function pg_temp.turn(p_parent jsonb, p_worker uuid) returns jsonb language plpgsql as $$
declare
	v_profile uuid := '63200000-0000-4000-8000-000000000010'; v_env uuid := '63200000-0000-4000-8000-000000000020';
	v_staff uuid := '63200000-0000-4000-8000-0000000000a1'; v_sponsor uuid := '63200000-0000-4000-8000-0000000000b1';
	v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid(); v_wake uuid := extensions.gen_random_uuid();
	v_runner uuid := extensions.gen_random_uuid(); v_assignment uuid := extensions.gen_random_uuid();
	v_parent public.qorpera_wake_occurrences%rowtype;
begin
	select * into v_parent from public.qorpera_wake_occurrences where run_id = (p_parent ->> 'runId')::uuid;
	set local session_replication_role = replica;
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		v_parent.requested_by_user_id, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '5 minutes', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, input_ids)
	values (v_run, v_profile, v_env, 'wake', v_wake, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		v_staff, 1, v_sponsor, 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_parent.requested_by_user_id,
		v_parent.requested_by_user_id, 'openai', 'gpt-test', 'provider_default', 'company', '63200000-0000-4000-8000-0000000000b2',
		repeat('b', 64), '{}'::uuid[]);
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
		sponsor_version, causal_root_id, causal_agent_ids, causal_hop_count, parent_run_id, payload)
	values (v_wake, v_profile, v_env, 'worker-dispatch', v_wake::text, clock_timestamp(), clock_timestamp(), 'agent', 'worker-dispatch',
		p_worker, v_run, 'materialized', v_staff, 1, v_parent.requested_by_user_id, v_sponsor, 1, v_parent.causal_root_id,
		v_parent.causal_agent_ids, 0, (p_parent ->> 'runId')::uuid, '{}');
	set local session_replication_role = origin;
	return jsonb_build_object('kind','run','runId',v_run,'jobId',v_job,'runnerId',v_runner,'assignmentId',v_assignment);
end $$;

-- Setup: shared/ and a narrower secret/ that agent A holds a grant on, and rules/.
do $$
declare a jsonb := pg_temp.stage('alpha'); v_secret uuid;
begin
	perform pg_temp.office();
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'views-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','shared'),
		jsonb_build_object('op','write','path','shared/a.txt','file',a), jsonb_build_object('op','mkdir','path','secret'),
		jsonb_build_object('op','write','path','secret/s.txt','file',a), jsonb_build_object('op','mkdir','path','rules'),
		jsonb_build_object('op','write','path','rules/tone.txt','file',a), jsonb_build_object('op','mkdir','path','code'))), 7, 'saved');
	v_secret := public.qorpera_folder_set_resource('63200000-0000-4000-8000-000000000020', pg_temp.member(1), 'secret', 'subtree',
		'company_shared', 'normal') ->> 'resourceId';
	perform public.qorpera_folder_grant('63200000-0000-4000-8000-000000000020', pg_temp.member(1), v_secret, 'staff_agent',
		'63200000-0000-4000-8000-0000000000a1', array['read','write']);
end $$;


-- A run box: opened by its run, it saves as the run; a bad pass, a re-claimed lease and a closed view are refused.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); b jsonb; r jsonb; c public.qorpera_folder_commits%rowtype;
	v_runner uuid := extensions.gen_random_uuid();
begin
	b := pg_temp.open('run_box', '{}', v);
	r := pg_temp.vcommit(b, 'box-save-1', '[{"op":"mkdir","path":"by-box"}]');
	perform pg_temp.expect(r, 1, 'saved');
	c := pg_temp.last_commit(r);
	if c.actor_kind <> 'staff_agent' or c.run_id <> (v ->> 'runId')::uuid or c.view_id <> (b ->> 'viewId')::uuid or c.view_kind <> 'run_box' then
		raise exception 'Run box commit: %', to_jsonb(c); end if;
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', b || jsonb_build_object('pass', repeat('A', 43)), 'box-bad-pass',
		'[{"op":"mkdir","path":"refused"}]'), '42501');
	if (public.qorpera_folder_view_renew((b ->> 'viewId')::uuid, b ->> 'pass') ->> 'state') <> 'open' then raise exception 'Renew'; end if;
	perform pg_temp.fx(format('update public.qorpera_runner_jobs set runner_id = %L where id = %L', v_runner, v ->> 'jobId'));
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', b, 'box-reclaimed', '[{"op":"mkdir","path":"refused"}]'), '42501');
	if (public.qorpera_folder_view_renew((b ->> 'viewId')::uuid, b ->> 'pass') ->> 'state') <> 'closed' then
		raise exception 'A re-claimed lease ends the run box view on renew'; end if;
	-- A view whose own lease lapsed refuses, and renew closes it as expired.
	b := pg_temp.open('run_box', '{}', pg_temp.run('human', '63200000-0000-4000-8000-000000000002'));
	perform pg_temp.fx(format('update public.qorpera_folder_views set lease_until = clock_timestamp() - interval ''1 second'' where id = %L',
		b ->> 'viewId'));
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', b, 'box-expired', '[{"op":"mkdir","path":"refused"}]'), '42501');
	r := public.qorpera_folder_view_renew((b ->> 'viewId')::uuid, b ->> 'pass');
	if r ->> 'state' <> 'closed' or r ->> 'reason' <> 'expired' then raise exception 'Renew of a lapsed view: %', r; end if;
end $$;


-- A desktop held by a run: the run's authority within the company-wide view. After the run's release it is detached,
-- saves as the agent and member, and refuses a unit that needs review.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); d jsonb; r jsonb; c public.qorpera_folder_commits%rowtype;
	a jsonb := pg_temp.stage('beta');
begin
	perform pg_temp.hold(v);
	d := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4','holderRunId',v ->> 'runId'));
	r := pg_temp.vcommit(d, 'desk-live-1', jsonb_build_array(jsonb_build_object('op','write','path','shared/d.txt','file',a),
		jsonb_build_object('op','write','path','secret/d.txt','file',a), jsonb_build_object('op','write','path','rules/d.txt','file',a)));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'denied', 'denied'); perform pg_temp.expect(r, 3, 'denied', 'denied');
	c := pg_temp.last_commit(r);
	if c.run_id <> (v ->> 'runId')::uuid or c.view_kind <> 'computer_desktop' then raise exception 'Live desktop commit: %', to_jsonb(c); end if;
	if (public.qorpera_folder_read('63200000-0000-4000-8000-000000000020', pg_temp.vactor(d), 'secret/s.txt') ->> 'found')::boolean
		or not (public.qorpera_folder_read('63200000-0000-4000-8000-000000000020', pg_temp.vactor(d), 'rules/tone.txt') ->> 'found')::boolean then
		raise exception 'The company-wide view for reads'; end if;
	-- The run releases the screen: the view is detached.
	perform pg_temp.hold(null);
	r := pg_temp.vcommit(d, 'desk-detached-1', jsonb_build_array(jsonb_build_object('op','write','path','shared/e.txt','file',a),
		jsonb_build_object('op','delete','path','shared/d.txt','expectedVersion', pg_temp.read('shared/d.txt') -> 'entry' ->> 'version')));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'denied', 'review_required');
	c := pg_temp.last_commit(r);
	if c.run_id is not null or c.actor_kind <> 'staff_agent' or c.requester_id <> '63200000-0000-4000-8000-000000000002'
		or c.session_kind <> 'in_house' or c.view_id <> (d ->> 'viewId')::uuid then raise exception 'Detached desktop commit: %', to_jsonb(c); end if;
	-- While paused, a detached view refuses.
	perform public.qorpera_folder_pause('63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000001', 'test');
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', d, 'desk-paused', '[{"op":"mkdir","path":"refused"}]'), '55000');
	perform public.qorpera_folder_resume('63200000-0000-4000-8000-000000000010');
	perform public.qorpera_folder_view_close((d ->> 'viewId')::uuid, d ->> 'pass');
end $$;


-- What ends a desktop view: another run's acquire, a takeover after its ack (with the final save allowed while the
-- drain is pending), a private sign-in, a seat changing agent, a new activation, and revoked computer access.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); v2 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	d jsonb; m jsonb; r jsonb;
begin
	perform pg_temp.hold(v);
	d := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4','holderRunId',v ->> 'runId'));
	perform pg_temp.hold(v2);
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', d, 'end-acquired', '[{"op":"mkdir","path":"refused"}]'), '42501');
	-- Back to the first run; a takeover's drain is pending: the final save still lands, credited to the run's agent.
	perform pg_temp.hold(v);
	perform pg_temp.fx('update public.qorpera_runtime_office_screens set drain_pending = true, drain_id = extensions.gen_random_uuid(),
		takeover_user_id = ''63200000-0000-4000-8000-000000000001'', lease_id = null, run_id = null, lease_expires_at = null,
		grant_version = null, native_binding = null where id = ''63900000-0000-4000-8000-0000000000e4''');
	perform pg_temp.expect(pg_temp.vcommit(d, 'end-final-save', '[{"op":"mkdir","path":"final-save"}]'), 1, 'saved');
	-- The ack: the old view ends; the member's view opens and saves as the member, never in the member's private folder.
	perform pg_temp.fx('update public.qorpera_runtime_office_screens set drain_pending = false, drain_acknowledged_at = clock_timestamp()
		where id = ''63900000-0000-4000-8000-0000000000e4''');
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', d, 'end-after-ack', '[{"op":"mkdir","path":"refused"}]'), '42501');
	m := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4',
		'holderUserId','63200000-0000-4000-8000-000000000001'));
	r := pg_temp.vcommit(m, 'member-desk-1', '[{"op":"mkdir","path":"by-member-desk"},{"op":"mkdir","path":"members/63200000-0000-4000-8000-000000000001/private/x"}]');
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'denied', 'denied');
	if (pg_temp.last_commit(r)).actor_kind <> 'member' then raise exception 'A member-held desktop saves as the member'; end if;
	if (select state from public.qorpera_folder_views where id = (d ->> 'viewId')::uuid) <> 'closed' then
		raise exception 'Opening the member''s view supersedes the run''s'; end if;
	-- A private sign-in by another member ends the member's view.
	perform pg_temp.fx('update public.qorpera_runtime_offices set privacy_state = ''private'', privacy_challenge = jsonb_build_object(''memberId'',
		''63200000-0000-4000-8000-000000000005'', ''screenId'', ''63900000-0000-4000-8000-0000000000e4'') where id = ''63900000-0000-4000-8000-0000000000e0''');
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', m, 'end-private', '[{"op":"mkdir","path":"refused"}]'), '42501');
	perform pg_temp.fx('update public.qorpera_runtime_offices set privacy_state = ''shared'', privacy_challenge = null
		where id = ''63900000-0000-4000-8000-0000000000e0''');
	-- A new activation (a power-off and resume, or a reboot) ends it.
	perform pg_temp.fx('update public.qorpera_runtime_office_activations set superseded_at = clock_timestamp()
		where activation_id = ''63900000-0000-4000-8000-0000000000e3''');
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', m, 'end-activation', '[{"op":"mkdir","path":"refused"}]'), '42501');
	perform pg_temp.fx('update public.qorpera_runtime_office_activations set superseded_at = null
		where activation_id = ''63900000-0000-4000-8000-0000000000e3''');
	perform pg_temp.expect(pg_temp.vcommit(m, 'member-desk-2', '[{"op":"mkdir","path":"by-member-desk-2"}]'), 1, 'saved');
	-- Revoked computer access ends it; so does the seat changing agent.
	perform pg_temp.fx('update public.qorpera_runtime_office_access set state = ''revoked'' where office_id = ''63900000-0000-4000-8000-0000000000e0''');
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', m, 'end-access', '[{"op":"mkdir","path":"refused"}]'), '42501');
	perform pg_temp.fx('update public.qorpera_runtime_office_access set state = ''active'' where office_id = ''63900000-0000-4000-8000-0000000000e0''');
	perform pg_temp.fx('update public.qorpera_runtime_office_screens set generation = generation + 1 where id = ''63900000-0000-4000-8000-0000000000e4''');
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', m, 'end-seat', '[{"op":"mkdir","path":"refused"}]'), '42501');
	-- Open refuses a holder that is not current.
	perform pg_temp.hold(null);
	perform pg_temp.raises(format('select pg_temp.open(%L, %L)', 'computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4',
		'holderRunId', v ->> 'runId')), '42501');
end $$;

-- The newest view wins: run A's view, then run B's; when B leaves the screen, A's view does not come back.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); v2 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	d jsonb; d2 jsonb;
begin
	perform pg_temp.hold(v);
	d := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4','holderRunId',v ->> 'runId'));
	perform pg_temp.hold(v2);
	d2 := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4','holderRunId',v2 ->> 'runId'));
	perform pg_temp.hold(null);
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', d, 'newest-old', '[{"op":"mkdir","path":"refused"}]'), '42501');
	perform pg_temp.expect(pg_temp.vcommit(d2, 'newest-new', '[{"op":"mkdir","path":"by-newest"}]'), 1, 'saved');
	perform public.qorpera_folder_view_close((d2 ->> 'viewId')::uuid, d2 ->> 'pass');
end $$;

-- A coding session: detached as its agent and owner under the coding rule (code/ yes, agents/ no), never reviewed; an
-- archive ends it.
do $$
declare p jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); w uuid := extensions.gen_random_uuid();
	tok uuid := extensions.gen_random_uuid(); cm uuid := extensions.gen_random_uuid(); cv jsonb; r jsonb; c public.qorpera_folder_commits%rowtype;
	t jsonb; e jsonb;
	repo jsonb := '{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}';
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
		revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
	values (w, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1',
		extensions.gen_random_uuid(), 'w-coding', 'coding', 'Code', 'read', 'each', '{}', '63200000-0000-4000-8000-000000000002',
		(p ->> 'runId')::uuid, '63200000-0000-4000-8000-000000000002', '63200000-0000-4000-8000-0000000000b1', 1);
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values (cm, 'member', '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020',
		'63200000-0000-4000-8000-000000000002', 'exec-1', repeat('8', 64), '{}');
	insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, attached_machine_id,
		attachment_token, attachment_until, attachment_turn, attached_at)
	values (w, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', 'claude-code', repo, 'qorpera/w-coding', cm,
		tok, clock_timestamp() + interval '60 seconds', 1, clock_timestamp());
	insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
	values ('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1', repo, true);
	insert into public.qorpera_coding_executors(environment_id, owner, enabled) values ('63200000-0000-4000-8000-000000000020', 'exec-1', true);
	insert into public.qorpera_runtime_machine_allocations(id, profile_id, provider_adapter, instance_sha256, coding_machine_id, reserved_at)
	values (cm, '63200000-0000-4000-8000-000000000010', 'lxd', repeat('9', 64), cm, clock_timestamp());
	set local session_replication_role = origin;
	cv := pg_temp.open('coding_session', jsonb_build_object('workerId', w, 'attachmentToken', tok));
	r := pg_temp.vcommit(cv, 'coding-view-1', '[{"op":"mkdir","path":"code/repo"},{"op":"mkdir","path":"agents"}]');
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'denied', 'denied');
	c := pg_temp.last_commit(r);
	if c.session_kind <> 'coding' or c.run_id is not null or c.view_kind <> 'coding_session' or c.review_id is not null then
		raise exception 'Coding view commit: %', to_jsonb(c); end if;
	-- During a leased turn, the view's reads land in the turn's read set as well as the view's.
	t := pg_temp.turn(p, w);
	e := pg_temp.read('shared/a.txt', pg_temp.vactor(cv)) -> 'entry';
	perform public.qorpera_folder_record_release('63200000-0000-4000-8000-000000000020', pg_temp.vactor(cv), extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')), repeat('3', 64));
	if not exists (select 1 from public.qorpera_folder_view_reads where view_id = (cv ->> 'viewId')::uuid)
		or not exists (select 1 from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.run_id = (t ->> 'runId')::uuid and x ->> 'path' = 'shared/a.txt') then
		raise exception 'A coding view''s reads during a turn land in the turn''s read set'; end if;
	perform pg_temp.fx(format('update public.qorpera_coding_sessions set archived_at = clock_timestamp(), archived_by = ''member'' where worker_id = %L', w));
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', cv, 'coding-archived', '[{"op":"mkdir","path":"refused"}]'), '42501');
end $$;


-- Reads: a live-run view's release lands in the view's read set and the run's. Another run of the same agent and
-- member inherits them, records included. After a narrowing, the detached view's save and that run's recheck both
-- refuse.
do $$
declare
	c_env constant uuid := '63200000-0000-4000-8000-000000000020'; c_profile constant uuid := '63200000-0000-4000-8000-000000000010';
	v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); v2 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	d jsonb; e jsonb;
begin
	perform pg_temp.hold(v);
	d := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4','holderRunId',v ->> 'runId'));
	e := public.qorpera_folder_read(c_env, pg_temp.vactor(d), 'shared/a.txt') -> 'entry';
	perform public.qorpera_folder_record_release(c_env, pg_temp.vactor(d), extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')), repeat('1', 64));
	if not exists (select 1 from public.qorpera_folder_view_reads where view_id = (d ->> 'viewId')::uuid)
		or not exists (select 1 from public.qorpera_folder_run_reads where run_id = (v ->> 'runId')::uuid) then
		raise exception 'A live-run view''s release lands in both read sets'; end if;
	perform public.qorpera_folder_run_inherit_view_reads(c_env, v2, (d ->> 'viewId')::uuid, extensions.gen_random_uuid());
	if not exists (select 1 from public.qorpera_folder_run_reads where run_id = (v2 ->> 'runId')::uuid)
		or not exists (select 1 from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.run_id = (v2 ->> 'runId')::uuid and x ->> 'path' = 'shared/a.txt') then
		raise exception 'Inheritance copies the read set and the records'; end if;
	-- Another member's run inherits nothing from this view.
	perform pg_temp.raises(format('select public.qorpera_folder_run_inherit_view_reads(%L, %L, %L, %L)', c_env,
		pg_temp.run('human', '63200000-0000-4000-8000-000000000004'), d ->> 'viewId', extensions.gen_random_uuid()), '42501');
	-- The run releases the screen; shared/ narrows to a resource agent A holds no grant on.
	perform pg_temp.hold(null);
	perform public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'shared', 'subtree', 'company_shared', 'normal');
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', d, 'detached-after-narrow', '[{"op":"mkdir","path":"refused"}]'), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_run_reads_current(%L, %L, %L)', c_env, c_profile,
		public.qorpera_folder_run_resolve(c_env, c_profile, v2) - 'lockTargets' - 'attribution'), '42501');
	-- A seat whose open view has unsaved changes is in use.
	perform public.qorpera_folder_view_renew((d ->> 'viewId')::uuid, d ->> 'pass', clock_timestamp());
	if not public.qorpera_runtime_office_screen_in_use((select s from public.qorpera_runtime_office_screens s
		where s.id = '63900000-0000-4000-8000-0000000000e4')) then raise exception 'Unsaved changes keep a seat in use'; end if;
end $$;


-- Rank 0 is the company row only, KEY SHARE, and the company row is rank 0 only.
do $$
begin
	begin
		create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
		returns table(rank smallint, tbl text, key text, mode text) language sql stable set search_path = '' as $f$
			select 2::smallint, 'qorpera_profiles'::text, '63200000-0000-4000-8000-000000000010'::text, 'keyshare'::text
		$f$;
		perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', pg_temp.member(2), 'rank-2-company', '[{"op":"mkdir","path":"r2"}]'), 'XX000');
		create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
		returns table(rank smallint, tbl text, key text, mode text) language sql stable set search_path = '' as $f$
			select 0::smallint, 'qorpera_profile_staff'::text, '63200000-0000-4000-8000-000000000010:63200000-0000-4000-8000-0000000000a1'::text,
				'keyshare'::text
		$f$;
		perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', pg_temp.member(2), 'rank-0-staff', '[{"op":"mkdir","path":"r0"}]'), 'XX000');
		create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
		returns table(rank smallint, tbl text, key text, mode text) language sql stable set search_path = '' as $f$
			select 0::smallint, 'qorpera_profiles'::text, '63200000-0000-4000-8000-000000000010'::text, 'keyshare'::text
		$f$;
		perform pg_temp.expect(pg_temp.commit(pg_temp.member(2), 'rank-0-company', '[{"op":"mkdir","path":"r0-ok"}]'), 1, 'saved');
		raise exception 'Undo the hook' using errcode = 'QTF09';
	exception when sqlstate 'QTF09' then null;
	end;
end $$;

rollback;
