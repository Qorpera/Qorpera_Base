-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- WHY: Verify 20260930906000 inline room post materialization, lock-contention fail-open fallback, and invariants.

do $$
declare
	v_role text;
	v_bob uuid := '92400000-0000-4000-8000-000000000031';
	v_carol uuid := '92400000-0000-4000-8000-000000000032';
	v_owner uuid := '92400000-0000-4000-8000-000000000001';
	v_bob_room uuid := pg_temp.base_thread('92400000-0000-4000-8000-000000000031');
	v_sponsor uuid := (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid;
	v_client uuid := extensions.gen_random_uuid();
	v_res1 jsonb;
	v_res2 jsonb;
	v_wake public.qorpera_wake_occurrences;
	v_run public.qorpera_execution_runs;
	v_job public.qorpera_runner_jobs;
	v_pass jsonb;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(
			not has_function_privilege(
				v_role,
				'public.qorpera_folder_materialize_room_wakes_inline(uuid,uuid,uuid,uuid[])',
				'EXECUTE'
			),
			'inline room materializer stays private from ' || v_role
		);
	end loop;

	-- WHY: With wake settings disabled (default), room posts leave wakes queued for qorpera_folder_materialize_company.
	savepoint off_mode;
	v_res1 := pg_temp.base_post(v_owner, v_bob, 'Wait while wake switch is off.');
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_res1 ->> 0)::uuid;
	perform pg_temp.base_assert(
		v_wake.status = 'queued' and v_wake.run_id is null,
		'wake stays queued when wake switch is off: ' || to_jsonb(v_wake)::text
	);
	rollback to savepoint off_mode;

	-- WHY: With wake settings enabled, posting materializes the run, job, reservation, budget, and policy in the same transaction.
	update public.qorpera_orchestrator_wake_settings set enabled = true;

	perform pg_temp.base_claims('authenticated', v_owner);
	set local role authenticated;
	v_res1 := public.qorpera_post_company_room_message(
		v_bob_room,
		v_client,
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', 'Inline materialize this.'),
		v_sponsor,
		1
	);
	v_res2 := public.qorpera_post_company_room_message(
		v_bob_room,
		v_client,
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', 'Inline materialize this.'),
		v_sponsor,
		1
	);
	reset role;
	perform pg_temp.base_claims('service_role');

	perform pg_temp.base_assert(
		v_res1 = v_res2
		and v_res1 ->> 'schema' = 'qorpera.company-room-post/v1'
		and jsonb_array_length(v_res1 -> 'occurrenceIds') = 1
		and (select array_agg(k order by k) from jsonb_object_keys(v_res1) k)
			= array['inputId', 'occurrenceIds', 'roomId', 'schema', 'sessionId'],
		'exact return shape and replay idempotency preserved: ' || v_res1::text
	);

	select * into strict v_wake
	from public.qorpera_wake_occurrences
	where id = (v_res1 #>> '{occurrenceIds,0}')::uuid;
	perform pg_temp.base_assert(
		v_wake.status = 'materialized' and v_wake.run_id is not null and v_wake.blocked_reason is null,
		'room wake materialized inline: ' || to_jsonb(v_wake)::text
	);

	select * into strict v_run from public.qorpera_execution_runs where id = v_wake.run_id;
	select * into strict v_job from public.qorpera_runner_jobs where id = v_run.job_id;
	perform pg_temp.base_assert(
		v_run.source_kind = 'room_delivery'
		and v_run.source_id = v_wake.id
		and v_run.company_seq is not null
		and v_job.status = 'queued'
		and v_job.run_id = v_run.id
		and exists (select 1 from public.qorpera_execution_sponsor_reservations where run_id = v_run.id and status = 'reserved')
		and exists (select 1 from public.qorpera_execution_run_budgets where run_id = v_run.id)
		and exists (select 1 from public.qorpera_runner_model_policies where job_id = v_job.id)
		and exists (select 1 from public.qorpera_execution_run_events where run_id = v_run.id and event_type = 'queued'),
		'run, job, reservation, budget, policy, and queued event created inline'
	);

	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(
		v_pass ->> 'state' = 'idle',
		'follow-up materializer pass finds nothing left to materialize: ' || v_pass::text
	);

	-- WHY: One-run-per-conversation still holds: a second post in Bob's busy thread stays queued.
	v_res2 := pg_temp.base_post(v_owner, v_bob, 'Second post while Bob has a queued run.');
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_res2 ->> 0)::uuid;
	perform pg_temp.base_assert(
		v_wake.status = 'queued' and v_wake.run_id is null,
		'second post in busy thread waits queued: ' || to_jsonb(v_wake)::text
	);

	-- WHY: Full sponsor quota absorbs the inline refusal cleanly without failing the post or leaving orphan rows.
	savepoint full_quota;
	set local session_replication_role = replica;
	update public.qorpera_provider_connection_versions
	set quota_policy = jsonb_set(quota_policy, '{max_concurrent_runs}', to_jsonb(
		(select count(*)::integer from public.qorpera_execution_sponsor_reservations
			where provider_connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
				and status = 'reserved')
	))
	where connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid;
	set local session_replication_role = origin;
	v_res2 := pg_temp.base_post(v_owner, v_carol, 'Carol post under full quota.');
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_res2 ->> 0)::uuid;
	perform pg_temp.base_assert(
		v_wake.status = 'queued' and v_wake.run_id is null
		and not exists (select 1 from public.qorpera_execution_runs where source_id = v_wake.id),
		'full quota leaves wake queued with no orphan run: ' || to_jsonb(v_wake)::text
	);
	rollback to savepoint full_quota;

	-- WHY: Group chat post with two idle agents materializes both agents inline in one transaction.
	perform pg_temp.base_commit(pg_temp.base_owner(), 'irpm-group-launch', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents/groups'),
		jsonb_build_object('op', 'new_folder', 'path', 'QorperaOS/agents/groups/inline-desk',
			'contents', jsonb_build_array(jsonb_build_object('path', 'group.md', 'kind', 'file',
				'file', pg_temp.base_stage(
					E'---\nid: 13880000-0000-4000-8000-000000000465\nname: Inline Desk\nagents:\n'
					|| E'  - 92400000-0000-4000-8000-000000000031\n  - 92400000-0000-4000-8000-000000000032\n'
					|| E'people:\n  - 92400000-0000-4000-8000-000000000001\n---\nCoordinate inline.\n'))),
			'structured', jsonb_build_array(jsonb_build_object(
				'path', 'QorperaOS/agents/groups/inline-desk/group.md', 'kind', 'group',
				'text', E'---\nid: 13880000-0000-4000-8000-000000000465\nname: Inline Desk\nagents:\n'
					|| E'  - 92400000-0000-4000-8000-000000000031\n  - 92400000-0000-4000-8000-000000000032\n'
					|| E'people:\n  - 92400000-0000-4000-8000-000000000001\n---\nCoordinate inline.\n',
				'parse', jsonb_build_object('kind', 'group', 'id', '13880000-0000-4000-8000-000000000465',
					'name', 'Inline Desk', 'subtitle', null,
					'agents', '["92400000-0000-4000-8000-000000000031","92400000-0000-4000-8000-000000000032"]'::jsonb,
					'people', '["92400000-0000-4000-8000-000000000001"]'::jsonb,
					'purpose', 'Coordinate inline.'),
				'parserVersion', 1)))));
	perform pg_temp.base_claims('authenticated', v_owner);
	set local role authenticated;
	v_res2 := public.qorpera_post_company_room_message(
		'13880000-0000-4000-8000-000000000465',
		extensions.gen_random_uuid(),
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', 'Both of you chime in.'),
		v_sponsor,
		1
	);
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(
		jsonb_array_length(v_res2 -> 'occurrenceIds') = 2
		and (select count(*) = 2 from public.qorpera_wake_occurrences
			where id in (select jsonb_array_elements_text(v_res2 -> 'occurrenceIds')::uuid)
				and status = 'materialized' and run_id is not null),
		'group chat post materializes both agents inline: ' || v_res2::text
	);

	-- WHY: Lock contention on qorpera_orchestrator_wake_settings or provider connections never fails a post and restores caller lock_timeout.
	perform set_config('lock_timeout', '1s', true);
	v_res2 := pg_temp.base_post(v_owner, v_carol, 'Carol normal post.');
	perform pg_temp.base_assert(
		current_setting('lock_timeout') = '1s'
		and (select status = 'materialized' from public.qorpera_wake_occurrences where id = (v_res2 ->> 0)::uuid),
		'caller lock_timeout preserved after inline materialization: ' || current_setting('lock_timeout')
	);
end $$;

rollback;
