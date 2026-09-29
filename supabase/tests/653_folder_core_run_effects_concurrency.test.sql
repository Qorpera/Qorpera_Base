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
set session_replication_role = origin;

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
