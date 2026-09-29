-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-2b part 2 under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.6, §5.9
-- tests 7b, 8 and 9): a folder send against legacy posting on the same conversation, in both orders, without a
-- deadlock (rank 0 before the session); two sends of one run queue on the run mutex; concurrent context views get
-- ordinals 1 and 2; an agent's "Ask first" rule against a member's role change, in both orders. 648's committed
-- fixture (Ada's leased human run), removed at the end.

-- The run's launch provenance, which the context view requires.
set session_replication_role = replica;
insert into public.qorpera_native_execution_launches(run_id, runtime_bundle_id, runtime_bundle_sha256, binary_sha256, reasoning_effort,
	reasoning_policy_sha256, tool_catalog_text, context_sha256, context_bytes)
values ('64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(), repeat('b', 64), repeat('c', 64), 'low', repeat('d', 64), '{}',
	repeat('e', 64), 1);
-- A second leased human run of Ada in the same conversation, for two cards at once.
do $$
declare
	v_profile uuid := '64800000-0000-4000-8000-000000000010'; v_env uuid := '64800000-0000-4000-8000-000000000020';
	v_staff uuid := '64800000-0000-4000-8000-0000000000a1'; v_requester uuid := '64800000-0000-4000-8000-000000000002';
	v_run uuid := '64800000-0000-4000-8000-0000000001f1'; v_job uuid := '64800000-0000-4000-8000-0000000001f2';
	v_wake uuid := '64800000-0000-4000-8000-0000000001f3'; v_runner uuid := '64800000-0000-4000-8000-0000000000f4';
	v_assignment uuid := '64800000-0000-4000-8000-0000000001f5'; v_lease uuid := '64800000-0000-4000-8000-0000000001f6';
	v_session uuid := '64800000-0000-4000-8000-0000000000f7'; v_input uuid := '64800000-0000-4000-8000-0000000001f8';
	v_bundle uuid := '64800000-0000-4000-8000-0000000000f9';
begin
	insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
		runtime_bundle_id, runtime_bundle_sha256, execution_run_id)
	values (v_input, v_session, extensions.gen_random_uuid(), v_requester, 'human', 'user_message', v_bundle, repeat('b', 64), v_run);
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		v_requester, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids, compute_identity_id)
	values (v_run, v_profile, v_env, 'session_turn', v_input, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		v_staff, 1, '64800000-0000-4000-8000-0000000000b1', 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_requester, v_requester,
		'openai', 'gpt-test', 'provider_default', 'company', v_bundle, repeat('b', 64), v_session, array[v_input],
		'64800000-0000-4000-8000-0000000000d1');
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
		sponsor_version, session_id, causal_root_id, causal_agent_ids, payload)
	values (v_wake, v_profile, v_env, 'input', v_wake::text, clock_timestamp(), clock_timestamp(), 'human', 'input', v_input,
		v_run, 'materialized', v_staff, 1, v_requester, '64800000-0000-4000-8000-0000000000b1', 1, v_session, v_wake, array[v_staff],
		jsonb_build_object('inputIds', jsonb_build_array(v_input)));
	insert into public.qorpera_runner_assignments(id, claim_id, job_id, run_id, runner_id, capability_sha256, status, expires_at, accepted_at)
	values (v_assignment, extensions.gen_random_uuid(), v_job, v_run, v_runner, repeat('e', 64), 'accepted',
		clock_timestamp() + interval '1 hour', clock_timestamp());
	insert into public.qorpera_native_provider_connection_leases(id, run_id, job_id, provider_connection_id, provider_connection_version,
		credential_capsule_id, compute_identity_id, runner_id, assignment_id, lease_token_sha256, expires_at)
	values (v_lease, v_run, v_job, '64800000-0000-4000-8000-0000000000b3', 1, '64800000-0000-4000-8000-0000000000d2',
		'64800000-0000-4000-8000-0000000000d1', v_runner, v_assignment, repeat('d', 64), clock_timestamp() + interval '1 hour');
	insert into public.qorpera_execution_sponsor_reservations(run_id, job_id, profile_id, binding_id, sponsor_version, provider_connection_id,
		provider_connection_version, period_start, reserved_microusd)
	values (v_run, v_job, v_profile, '64800000-0000-4000-8000-0000000000b1', 1, '64800000-0000-4000-8000-0000000000b3', 1,
		date_trunc('month', clock_timestamp()), 1);
	insert into public.qorpera_runner_model_policies(job_id, profile_id, environment_id, allowed_models, max_calls, max_input_tokens,
		max_output_tokens, authorized_by_user_id)
	values (v_job, v_profile, v_env, '["gpt-test"]', 32, 1000, 1000, v_requester);
	insert into public.qorpera_execution_run_budgets(run_id) values (v_run);
end $$;
set session_replication_role = origin;
select set_config('qorpera_test.binding2', jsonb_build_object('leaseId','64800000-0000-4000-8000-0000000001f6',
	'runId','64800000-0000-4000-8000-0000000001f1','jobId','64800000-0000-4000-8000-0000000001f2',
	'runnerId','64800000-0000-4000-8000-0000000000f4','assignmentId','64800000-0000-4000-8000-0000000001f5',
	'credentialCapsuleId','64800000-0000-4000-8000-0000000000d2','computeIdentityId','64800000-0000-4000-8000-0000000000d1',
	'provider','openai','nativeHarness','codex-cli','model','gpt-test')::text, false) \g /dev/null

create function pg_temp.sql_review(p_binding text, p_call text) returns text language sql as $$
	select format('select public.qorpera_record_action_review(%L, %L)::text', current_setting(p_binding),
		jsonb_build_object('callId', p_call, 'tool', 'send_email', 'effect', 'external', 'argumentSha256', repeat('d', 64),
			'action', jsonb_build_object('title', 'Send an email', 'target', 'bob@acme.test', 'details', jsonb_build_object('subject', 'Moved')),
			'decision', 'ask', 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'The reviewer is unsure.', 'proposedRule', null,
			'reviewerModel', 'gpt-6-luna'))
$$;
create function pg_temp.sql_card(p_binding text) returns text language sql as $$
	select format('select public.qorpera_append_native_interaction_request(%L, %L, %L, %L, %L, %L, %L, ''openai'', ''codex-cli'', %L, %L)::text',
		b ->> 'leaseId', b ->> 'runId', b ->> 'jobId', b ->> 'runnerId', b ->> 'assignmentId', b ->> 'credentialCapsuleId', b ->> 'computeIdentityId',
		extensions.gen_random_uuid(), '{"schema":"qorpera.interaction/v1","surface":"question","title":"Which channel?","payload":{"options":[{"label":"#general","value":"general"},{"label":"#finance","value":"finance"}]}}')
	from (select current_setting(p_binding)::jsonb b) x
$$;

create function pg_temp.sql_send(p_key text, p_phase text default 'progress') returns text language sql as $$
	select format('select public.qorpera_send_native_agent_message(%L, %L, %L, %L, %L, %L, %L, ''openai'', ''codex-cli'', %L, %L, %L)::text',
		b ->> 'leaseId', b ->> 'runId', b ->> 'jobId', b ->> 'runnerId', b ->> 'assignmentId', b ->> 'credentialCapsuleId', b ->> 'computeIdentityId',
		p_key, 'Working on it.', p_phase)
	from (select current_setting('qorpera_test.binding')::jsonb b) x
$$;
create function pg_temp.sql_view(p_request text) returns text language sql as $$
	select format('select public.qorpera_record_native_context_view(%L, %L, %L)::text', '64800000-0000-4000-8000-000000000020',
		current_setting('qorpera_test.binding'), jsonb_build_object('schema', 'qorpera.native-context-view/v1', 'requestId', p_request,
			'threadId', 't', 'turnId', null, 'purpose', 'turn', 'outputs', '[]'::jsonb))
$$;
create function pg_temp.sql_rule(p_key text) returns text language sql as $$
	select format('select public.qorpera_add_agent_review_rule(%L, %L)::text', current_setting('qorpera_test.binding'),
		jsonb_build_object('operationKey', p_key, 'when', 'Sending money'))
$$;

-- A. Legacy posting takes the company row FOR UPDATE, then the conversation. A folder send takes this company's row
-- (rank 0) before the conversation, so the two meet at the company row in either order and never deadlock. Without
-- rank 0 the send would hold the conversation and then wait at the company row for its event's foreign key: 40P01.
do $$
declare v_state text;
begin
	-- Posting first: the send waits at the company row, holding no conversation.
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010' for update$q$)
		as t(x integer);
	perform dblink_send_query('fence_one', pg_temp.sql_send('race-post-1'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The send must wait for the posting company row'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_profiles'::regclass then
		raise exception 'The send must wait at the company row, not on %', pg_temp.queued_on('fence_one'); end if;
	perform dblink_send_query('fence_two', $q$select 1 from public.qorpera_shared_sessions where id = '64800000-0000-4000-8000-0000000000f7'
		for update$q$);
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'Posting must take the conversation at once'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The send after posting: %', v_state; end if;

	-- The send first: posting waits at the company row until the send commits.
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_send('race-post-2')) as t(x text);
	perform dblink_send_query('fence_two', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010' for update$q$);
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'Posting must wait for the send in flight'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'Posting after the send: %', v_state; end if;
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_shared_sessions where id = '64800000-0000-4000-8000-0000000000f7'
		for update$q$) as t(x integer);
	perform dblink_exec('fence_two', 'commit');
end $$;

-- B. Two sends of one run: the second waits at the run mutex; both land, in order.
do $$
declare v_state text; v jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	select x::jsonb into v from dblink('fence_one', pg_temp.sql_send('race-two-1')) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_send('race-two-2'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A second send of the run must wait for the first'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_execution_run_budgets'::regclass then
		raise exception 'The second send must wait at the run mutex, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The second send: %', v_state; end if;
	if (select sequence from public.qorpera_session_events where execution_id = '64800000-0000-4000-8000-0000000000f1'
		and body #>> '{entry,id}' = (select event_id::text from public.qorpera_agent_sends where idempotency_key = 'race-two-2'))
		<= (v ->> 'sequence')::bigint then raise exception 'The sends land in order'; end if;
end $$;

-- C. Two context views of one run at once get ordinals 1 and 2 (the run mutex orders them).
do $$
declare v_state text; v jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	select x::jsonb into v from dblink('fence_one', pg_temp.sql_view('race-view-1')) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_view('race-view-2'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A second view must wait for the first'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The second view: %', v_state; end if;
	if v ->> 'ordinal' <> '1' or (select ordinal from public.qorpera_native_context_views where run_id = '64800000-0000-4000-8000-0000000000f1'
		and request_id = 'race-view-2') <> 2 then raise exception 'The views get ordinals 1 and 2'; end if;
end $$;

-- D. An agent's rule against a member's role change (the company row FOR UPDATE, then the member row), in both orders:
-- the rule takes this company's row before the member row (rank 0, then rank 1 FOR NO KEY UPDATE), so no deadlock.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010' for update$q$)
		as t(x integer);
	perform dblink_send_query('fence_one', pg_temp.sql_rule('race-rule-1'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The rule must wait for the role change''s company row'; end if;
	perform dblink_send_query('fence_two', $q$update public.qorpera_profile_members set display_name = 'Member 2'
		where profile_id = '64800000-0000-4000-8000-000000000010' and user_id = '64800000-0000-4000-8000-000000000002'$q$);
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'The role change must take the member row at once'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The rule after the role change: %', v_state; end if;

	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_rule('race-rule-2')) as t(x text);
	-- It holds the company row KEY SHARE only: a FOR NO KEY UPDATE of it does not wait.
	perform dblink_send_query('fence_three', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for no key update$q$);
	if not pg_temp.finishes_unblocked('fence_three', 'fence_one') then raise exception 'The rule must not lock the company row'; end if;
	v_state := pg_temp.outcome('fence_three');
	perform dblink_send_query('fence_two', $q$update public.qorpera_profile_members set display_name = 'Member two'
		where profile_id = '64800000-0000-4000-8000-000000000010' and user_id = '64800000-0000-4000-8000-000000000002'$q$);
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A member row change must wait for the rule in flight'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The member row change after the rule: %', v_state; end if;
	if (select count(*) from public.qorpera_review_rules where profile_id = '64800000-0000-4000-8000-000000000010'
		and member_user_id = '64800000-0000-4000-8000-000000000002' and lower(when_text) = 'sending money') <> 1 then
		raise exception 'One rule for the same text'; end if;
end $$;

-- E. A send takes the conversation FOR UPDATE before its first write (C1C §5.6): held elsewhere, the send waits there
-- having written nothing yet (no row lock on the send table), never upgrading a lock it took while inserting.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_shared_sessions where id = '64800000-0000-4000-8000-0000000000f7'
		for key share$q$) as t(x integer);
	perform dblink_send_query('fence_one', pg_temp.sql_send('race-session-first'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The send must lock the conversation'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_shared_sessions'::regclass then
		raise exception 'The send must wait at the conversation, not on %', pg_temp.queued_on('fence_one'); end if;
	if exists (select 1 from pg_locks where pid = current_setting('qorpera_test.pid_fence_one')::integer
		and relation = 'public.qorpera_agent_sends'::regclass and mode = 'RowExclusiveLock') then
		raise exception 'The send must lock the conversation before it writes'; end if;
	perform dblink_exec('fence_two', 'rollback');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The send after the conversation: %', v_state; end if;
end $$;

-- F. The action-review card against legacy posting (the company row FOR UPDATE, then the conversation), in both
-- orders: the card takes this company's row (rank 0) before the conversation, so no deadlock.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010' for update$q$)
		as t(x integer);
	perform dblink_send_query('fence_one', pg_temp.sql_review('qorpera_test.binding', 'race-card-post-1'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The card must wait for the posting company row'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_profiles'::regclass then
		raise exception 'The card must wait at the company row, not on %', pg_temp.queued_on('fence_one'); end if;
	perform dblink_send_query('fence_two', $q$select 1 from public.qorpera_shared_sessions where id = '64800000-0000-4000-8000-0000000000f7'
		for update$q$);
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'Posting must take the conversation at once'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The card after posting: %', v_state; end if;

	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_review('qorpera_test.binding', 'race-card-post-2')) as t(x text);
	perform dblink_send_query('fence_two', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010' for update$q$);
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'Posting must wait for the card in flight'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'Posting after the card: %', v_state; end if;
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_shared_sessions where id = '64800000-0000-4000-8000-0000000000f7'
		for update$q$) as t(x integer);
	perform dblink_exec('fence_two', 'commit');
end $$;

-- G. The interaction request against legacy posting, posting first: it waits at the company row, holding no
-- conversation.
do $$
declare v_state text;
begin
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010' for update$q$)
		as t(x integer);
	perform dblink_send_query('fence_one', pg_temp.sql_card('qorpera_test.binding'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The request must wait for the posting company row'; end if;
	perform dblink_send_query('fence_two', $q$select 1 from public.qorpera_shared_sessions where id = '64800000-0000-4000-8000-0000000000f7'
		for update$q$);
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'Posting must take the conversation at once'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_two', 'commit');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' then raise exception 'The request after posting: %', v_state; end if;
end $$;

-- H. Two cards of two runs in one conversation (review r1 B1). A card takes the conversation FOR UPDATE before its
-- review row, whose foreign keys to the conversation would otherwise take it KEY SHARE first: with both cards holding
-- KEY SHARE and each asking for FOR UPDATE, 40P01. A pause right after each review insert makes the race certain:
-- the first card pauses holding the conversation, and the second waits at the conversation, not at the pause. The pause
-- is committed (the connections must see it): replaced, not created, so a run that stopped before dropping it re-runs.
create or replace function public.qorpera_test_review_pause() returns trigger language plpgsql as $f$
begin
	if current_setting('qorpera_test.review_pause', true) = 'on' then
		perform pg_advisory_lock_shared(652653); perform pg_advisory_unlock_shared(652653); end if;
	return null;
end $f$;
drop trigger if exists qorpera_test_review_pause on public.qorpera_action_reviews;
create trigger qorpera_test_review_pause after insert on public.qorpera_action_reviews
	for each row execute function public.qorpera_test_review_pause();
select dblink_exec(name, 'set qorpera_test.review_pause = on') from unnest(array['fence_one','fence_two']) name;
do $$
declare v_one text; v_two text; v_until timestamptz;
begin
	perform pg_advisory_lock(652653);
	perform dblink_send_query('fence_one', pg_temp.sql_review('qorpera_test.binding', 'race-two-cards-1'));
	-- The first card pauses after its review insert, holding the conversation.
	v_until := clock_timestamp() + interval '60 seconds';
	loop
		exit when pg_backend_pid() = any (pg_blocking_pids(current_setting('qorpera_test.pid_fence_one')::integer));
		if clock_timestamp() > v_until then raise exception 'The first card never reached its pause'; end if;
		perform pg_sleep(0.02);
	end loop;
	perform dblink_send_query('fence_two', pg_temp.sql_review('qorpera_test.binding2', 'race-two-cards-2'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'The second card must wait for the first at the conversation'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_shared_sessions'::regclass then
		raise exception 'The second card must wait at the conversation, not on %', pg_temp.queued_on('fence_two'); end if;
	perform pg_advisory_unlock(652653);
	v_one := pg_temp.outcome('fence_one'); v_two := pg_temp.outcome('fence_two');
	if v_one <> 'ok' or v_two <> 'ok' then raise exception 'Two cards in one conversation: % / %', v_one, v_two; end if;
	if (select count(*) from public.qorpera_session_events where session_id = '64800000-0000-4000-8000-0000000000f7'
		and event_type = 'authorization_request'
		and event_id in (select id from public.qorpera_action_reviews where call_id in ('race-two-cards-1', 'race-two-cards-2'))) <> 2 then
		raise exception 'Both cards reach the conversation'; end if;
end $$;
select dblink_exec(name, 'reset qorpera_test.review_pause') from unnest(array['fence_one','fence_two']) name;
drop trigger qorpera_test_review_pause on public.qorpera_action_reviews;
drop function public.qorpera_test_review_pause();

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 648 does).
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_agent_sends where run_id = '64800000-0000-4000-8000-0000000000f1')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
