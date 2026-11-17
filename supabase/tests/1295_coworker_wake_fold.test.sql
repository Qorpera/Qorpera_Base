-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

create function pg_temp.cf_session() returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where id = pg_temp.base_thread('92400000-0000-4000-8000-000000000033')
$$;
create function pg_temp.cf_send(p_from text, p_key text, p_text text, p_priority boolean default true) returns jsonb
language sql as $$
	select public.qorpera_send_coworker_message(current_setting('qorpera_test.cf_' || p_from)::jsonb,
		'92400000-0000-4000-8000-000000000033', p_key, p_text, p_priority)
$$;
create function pg_temp.cf_sent(p_name text, p_from text, p_text text, p_priority boolean default true) returns void
language sql as $$
	select set_config('qorpera_test.cf_sent_' || p_name, pg_temp.cf_send(p_from, 'cf-' || p_name, p_text, p_priority)::text, true)::text::void
$$;
create function pg_temp.cf_wake(p_name text) returns public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences
	where id = (current_setting('qorpera_test.cf_sent_' || p_name)::jsonb ->> 'occurrenceId')::uuid
$$;
create function pg_temp.cf_queued() returns uuid[] language sql as $$
	select coalesce(array_agg(id order by created_at, id), '{}') from public.qorpera_wake_occurrences
	where staff_agent_id = '92400000-0000-4000-8000-000000000033' and source_kind = 'coworker' and status = 'queued'
$$;
create function pg_temp.cf_untaken() returns uuid[] language sql as $$
	select coalesce(array_agg(wake.id order by wake.created_at, wake.id), '{}') from public.qorpera_wake_occurrences as wake
	where wake.staff_agent_id = '92400000-0000-4000-8000-000000000033' and wake.source_kind = 'coworker' and wake.status = 'queued'
		and not exists (select 1 from public.qorpera_pending_peer_messages as taken where taken.wake_id = wake.id)
$$;
create function pg_temp.cf_complete() returns void language sql as $$
	update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null
	where status in ('queued', 'leased')
		and run_id in (select id from public.qorpera_execution_runs where session_id = pg_temp.cf_session())
$$;
create function pg_temp.cf_job(p_run uuid) returns text language sql as $$
	select job.status from public.qorpera_runner_jobs as job join public.qorpera_execution_runs as run on run.job_id = job.id
	where run.id = p_run
$$;
create function pg_temp.cf_posted(p_staff uuid, p_text text) returns jsonb language plpgsql as $$
declare v_wakes jsonb := pg_temp.base_post('92400000-0000-4000-8000-000000000001', p_staff, p_text); v_pass jsonb;
	v_run uuid; v_binding jsonb;
begin
	v_pass := pg_temp.base_materialize();
	select run_id into v_run from public.qorpera_wake_occurrences where id = (v_wakes ->> 0)::uuid;
	perform pg_temp.base_assert(v_run is not null, 'the post is delivered: ' || v_pass::text);
	v_binding := pg_temp.base_start(v_run);
	perform pg_temp.base_public_send(v_binding, 'progress', 'cf-ack');
	return v_binding;
end $$;
create function pg_temp.cf_pass() returns uuid language plpgsql as $$
declare v_pass jsonb := pg_temp.base_materialize(); v_runs uuid[];
begin
	select array_agg(run.id) into v_runs from public.qorpera_execution_runs run
	where run.id in (select (value #>> '{}')::uuid from jsonb_array_elements(coalesce(v_pass -> 'run_ids', '[]'::jsonb)))
		and run.staff_agent_id = '92400000-0000-4000-8000-000000000033';
	perform pg_temp.base_assert(cardinality(coalesce(v_runs, '{}')) <= 1, 'one run at a time in the thread: ' || v_pass::text);
	return v_runs[1];
end $$;
create function pg_temp.cf_end() returns void language sql as $$
	update public.qorpera_runner_jobs set status = 'failed', finished_at = clock_timestamp(), last_error = 'Fixture: the run ended',
		lease_token_sha256 = null, lease_expires_at = null
	where status in ('queued', 'leased')
		and run_id in (select id from public.qorpera_execution_runs where session_id = pg_temp.cf_session())
$$;
create function pg_temp.cf_read(p_run uuid) returns jsonb language plpgsql as $$
declare v_binding jsonb := pg_temp.base_start(p_run);
begin
	perform set_config('qorpera_test.cf_reader', v_binding::text, true);
	return public.qorpera_read_native_wake(v_binding);
end $$;
create function pg_temp.cf_held(p_read jsonb) returns jsonb language sql as $$
	select coalesce(jsonb_agg(jsonb_build_object('from', m ->> 'staffAgentId', 'text', m ->> 'text') order by o), '[]'::jsonb)
	from jsonb_array_elements(coalesce(p_read #> '{payload,heldMessages}', '[]'::jsonb)) with ordinality x(m, o)
$$;
create function pg_temp.cf_line(p_from uuid, p_text text) returns jsonb language sql as $$
	select jsonb_build_object('from', p_from, 'text', p_text)
$$;
create function pg_temp.cf_stop(p_binding jsonb) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	v := public.qorpera_stop_run_chain((p_binding ->> 'runId')::uuid);
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
create function pg_temp.cf_actor(p_binding jsonb) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'run', 'runId', p_binding -> 'runId', 'jobId', p_binding -> 'jobId',
		'runnerId', p_binding -> 'runnerId', 'assignmentId', p_binding -> 'assignmentId')
$$;
create function pg_temp.cf_reads(p_binding jsonb, p_path text) returns void language plpgsql as $$
declare v_read jsonb := public.qorpera_folder_read('92400000-0000-4000-8000-000000000020', pg_temp.cf_actor(p_binding), p_path) -> 'entry';
begin
	perform public.qorpera_folder_record_release('92400000-0000-4000-8000-000000000020', pg_temp.cf_actor(p_binding),
		extensions.gen_random_uuid(), jsonb_build_array(jsonb_build_object('path', v_read ->> 'path', 'version', v_read ->> 'version',
			'authority', v_read -> 'authority')), repeat('0', 64));
end $$;
create function pg_temp.cf_shared(p_folder text, p_readers uuid[]) returns jsonb language plpgsql as $$
declare v_resource uuid; v_grants jsonb := '{}'; v_reader uuid;
begin
	v_resource := public.qorpera_folder_set_resource('92400000-0000-4000-8000-000000000020', pg_temp.base_owner(), p_folder,
		'subtree', 'company_shared', 'normal') ->> 'resourceId';
	foreach v_reader in array p_readers loop
		v_grants := v_grants || jsonb_build_object(v_reader::text, public.qorpera_folder_grant('92400000-0000-4000-8000-000000000020',
			pg_temp.base_owner(), v_resource, 'staff_agent', v_reader, array['read']) ->> 'grantId');
	end loop;
	perform pg_temp.base_commit('{"kind":"platform"}', 'cf-' || p_folder, jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', p_folder),
		jsonb_build_object('op', 'write', 'path', p_folder || '/a.txt', 'file', pg_temp.base_stage('cf ' || p_folder))));
	return jsonb_build_object('resource', v_resource, 'grants', v_grants);
end $$;

do $$
begin
	perform pg_temp.base_assert(exists (select 1 from information_schema.columns where table_schema = 'public'
			and table_name = 'qorpera_pending_peer_messages' and column_name = 'wake_id')
		and not has_function_privilege('service_role',
			'public.qorpera_coworker_take_waiting(public.qorpera_execution_runs,public.qorpera_wake_occurrences,jsonb)', 'execute')
		and not has_function_privilege('authenticated',
			'public.qorpera_coworker_take_waiting(public.qorpera_execution_runs,public.qorpera_wake_occurrences,jsonb)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_peer_message_shown(text,boolean)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_peer_message_shown(text,boolean)', 'execute')
		and position('qorpera_coworker_take_waiting(v_run, v_wake' in
			(select prosrc from pg_proc where oid = 'public.qorpera_folder_read_wake(jsonb)'::regprocedure)) > 0,
		'the take-over is internal and runs in the wake read');
	perform pg_temp.base_assert(pg_temp.cf_session() is not null, 'the Co-Founder has its thread');
end $$;

select set_config('qorpera_test.cf_alice', current_setting('qorpera_test.base_binding'), true) \g /dev/null
select pg_temp.base_public_send(current_setting('qorpera_test.cf_alice')::jsonb, 'progress', 'cf-ack') \g /dev/null
select set_config('qorpera_test.cf_bob', pg_temp.cf_posted('92400000-0000-4000-8000-000000000031', 'Ask the Co-Founder.')::text, true)
\g /dev/null
select set_config('qorpera_test.cf_carol', pg_temp.cf_posted('92400000-0000-4000-8000-000000000032', 'Ask the Co-Founder.')::text, true)
\g /dev/null

savepoint cf_three;
select pg_temp.cf_sent('w1', 'alice', 'Alice: which price list is current?');
select pg_temp.cf_sent('w2', 'bob', repeat('Bob: the supplier answered. ', 100));
select pg_temp.cf_sent('w3', 'carol', 'Carol: please confirm the launch date.');
do $$
declare v_run uuid; v_read jsonb; v_again jsonb; v_held jsonb;
begin
	perform pg_temp.base_assert((select bool_and(status = 'queued' and run_id is null) from (select (pg_temp.cf_wake(n)).*
			from unnest(array['w1', 'w2', 'w3']) n) w)
		and current_setting('qorpera_test.cf_sent_w2')::jsonb ->> 'status' = 'queued'
		and current_setting('qorpera_test.cf_sent_w3')::jsonb ->> 'status' = 'queued',
		'each message has its own wake and a queued receipt, as before');
	v_run := pg_temp.cf_pass();
	perform pg_temp.base_assert(v_run = (pg_temp.cf_wake('w1')).run_id
		and pg_temp.cf_queued() = array[(pg_temp.cf_wake('w2')).id, (pg_temp.cf_wake('w3')).id],
		'the oldest message becomes the run; the others wait behind it in the thread');
	v_read := pg_temp.cf_read(v_run);
	v_held := pg_temp.cf_held(v_read);
	perform pg_temp.base_assert(v_read #>> '{payload,text}' = 'Alice: which price list is current?'
		and v_read ->> 'actorStaffId' = '92400000-0000-4000-8000-000000000030'
		and v_held = jsonb_build_array(
			pg_temp.cf_line('92400000-0000-4000-8000-000000000031', repeat('Bob: the supplier answered. ', 100)),
			pg_temp.cf_line('92400000-0000-4000-8000-000000000032', 'Carol: please confirm the launch date.'))
		and v_read #>> '{payload,heldMessages,0,eventId}' = (pg_temp.cf_wake('w2')).payload ->> 'pairEventId'
		and v_read #>> '{payload,heldMessages,0,pairSessionId}' = (pg_temp.cf_wake('w2')).payload ->> 'pairSessionId',
		'one run carries all three messages, oldest first, each with its sender and in full: ' || v_read::text);
	perform pg_temp.base_assert(pg_temp.cf_untaken() = '{}'
		and pg_temp.cf_queued() = array[(pg_temp.cf_wake('w2')).id, (pg_temp.cf_wake('w3')).id]
		and (select count(*) from public.qorpera_pending_peer_messages where delivered_run_id = v_run
			and wake_id in ((pg_temp.cf_wake('w2')).id, (pg_temp.cf_wake('w3')).id)) = 2
		and pg_temp.cf_pass() is null,
		'the taken wakes wait under the run, held, and no pass runs them while it lives');
	v_again := public.qorpera_read_native_wake(current_setting('qorpera_test.cf_reader')::jsonb);
	perform pg_temp.base_assert(pg_temp.cf_held(v_again) = v_held, 'a second read of the run shows the same messages');
	perform set_config('qorpera_test.cf_x', v_run::text, true);
end $$;
select pg_temp.cf_sent('w4', 'alice', 'Alice: one more thing.');
do $$
declare v_x uuid := current_setting('qorpera_test.cf_x')::uuid; v_read jsonb; v_run uuid;
begin
	v_read := public.qorpera_read_native_wake(current_setting('qorpera_test.cf_reader')::jsonb);
	perform pg_temp.base_assert(pg_temp.cf_untaken() = array[(pg_temp.cf_wake('w4')).id]
		and jsonb_array_length(v_read #> '{payload,heldMessages}') = 2,
		'a message sent after the run was made keeps its own wake');
	perform pg_temp.cf_end();
	v_run := pg_temp.cf_pass();
	perform pg_temp.base_assert(v_run = (pg_temp.cf_wake('w2')).run_id and v_run <> v_x
			and not exists (select 1 from public.qorpera_pending_peer_messages where wake_id = (pg_temp.cf_wake('w2')).id),
		'the run failed: the oldest message it took gets its own run');
	v_read := pg_temp.cf_read(v_run);
	perform pg_temp.base_assert(v_read #>> '{payload,text}' = repeat('Bob: the supplier answered. ', 100)
		and pg_temp.cf_held(v_read) = jsonb_build_array(
			pg_temp.cf_line('92400000-0000-4000-8000-000000000032', 'Carol: please confirm the launch date.'),
			pg_temp.cf_line('92400000-0000-4000-8000-000000000030', 'Alice: one more thing.')),
		'and takes the rest, each once: ' || v_read::text);
end $$;
rollback to cf_three;

savepoint cf_lone;
select pg_temp.cf_sent('l1', 'alice', 'Alice: a lone question.');
do $$
declare v_run uuid := pg_temp.cf_pass(); v_read jsonb;
begin
	perform pg_temp.base_assert(v_run = (pg_temp.cf_wake('l1')).run_id, 'a lone message becomes its run in the first pass');
	v_read := pg_temp.cf_read(v_run);
	perform pg_temp.base_assert((select array_agg(k order by k) from jsonb_object_keys(v_read -> 'payload') k)
			= array['pairEventId', 'pairSessionId', 'receiptId', 'senderStaffId', 'text', 'transcript']
		and v_read #>> '{payload,text}' = 'Alice: a lone question.'
		and not exists (select 1 from public.qorpera_pending_peer_messages where delivered_run_id = v_run),
		'a lone message reads as before: ' || v_read::text);
end $$;
rollback to cf_lone;

savepoint cf_stop;
select pg_temp.cf_sent('s1', 'alice', 'Alice: what do we ship first?');
select pg_temp.cf_sent('s2', 'bob', 'Bob: can I order the samples?');
select pg_temp.cf_sent('s3', 'carol', 'Carol: is the shop name final?');
select pg_temp.cf_sent('s4', 'carol', 'Carol: and the colours?');
do $$
declare v_run uuid; v_read jsonb; v_s3 public.qorpera_wake_occurrences := pg_temp.cf_wake('s3');
begin
	perform pg_temp.base_assert(pg_temp.cf_stop(current_setting('qorpera_test.cf_bob')::jsonb) ->> 'cancelledWakes' = '1'
		and (pg_temp.cf_wake('s2')).status = 'cancelled', 'a stop before the run cancels the stopped chain''s waiting message');
	insert into public.qorpera_stopped_chains(profile_id, causal_root_id, stopped_run_id, stopped_by_user_id)
	values (v_s3.profile_id, v_s3.causal_root_id, (current_setting('qorpera_test.cf_carol')::jsonb ->> 'runId')::uuid,
		'92400000-0000-4000-8000-000000000001');
	v_run := pg_temp.cf_pass();
	v_read := pg_temp.cf_read(v_run);
	perform pg_temp.base_assert(v_run = (pg_temp.cf_wake('s1')).run_id and pg_temp.cf_held(v_read) = '[]'
		and pg_temp.cf_queued() = array[(pg_temp.cf_wake('s3')).id, (pg_temp.cf_wake('s4')).id],
		'a run never takes a message of a stopped chain, even one the stop has not reached yet: ' || v_read::text);
end $$;
rollback to cf_stop;

savepoint cf_withdrawn;
select pg_temp.cf_sent('d1', 'alice', 'Alice: what do we ship first?');
select pg_temp.cf_sent('d2', 'carol', 'Carol: is the shop name final?');
do $$
declare v_run uuid := pg_temp.cf_pass(); v_read jsonb;
begin
	v_read := pg_temp.cf_read(v_run);
	perform pg_temp.base_assert(pg_temp.cf_held(v_read) = jsonb_build_array(
		pg_temp.cf_line('92400000-0000-4000-8000-000000000032', 'Carol: is the shop name final?')), 'the run takes Carol''s message');
	perform pg_temp.cf_end();
	perform pg_temp.cf_stop(current_setting('qorpera_test.cf_carol')::jsonb);
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_pending_peer_messages
		where wake_id = (pg_temp.cf_wake('d2')).id), 'a stop withdraws its chain''s message from a failed run');
end $$;
select pg_temp.cf_sent('d3', 'alice', 'Alice: anything else?');
do $$
declare v_run uuid := pg_temp.cf_pass(); v_read jsonb;
begin
	v_read := pg_temp.cf_read(v_run);
	perform pg_temp.base_assert(v_run = (pg_temp.cf_wake('d3')).run_id and pg_temp.cf_held(v_read) = '[]',
		'the withdrawn message is not offered again: ' || v_read::text);
end $$;
rollback to cf_withdrawn;

savepoint cf_fail;
select pg_temp.cf_sent('f1', 'alice', 'Alice: what do we ship first?');
select pg_temp.cf_sent('f2', 'carol', 'Carol: is the shop name final?');
do $$
declare v_x uuid := pg_temp.cf_pass(); v_read jsonb; v_run uuid;
begin
	v_read := pg_temp.cf_read(v_x);
	perform pg_temp.base_assert(pg_temp.cf_held(v_read) = jsonb_build_array(
		pg_temp.cf_line('92400000-0000-4000-8000-000000000032', 'Carol: is the shop name final?')), 'the run takes Carol''s message');
	perform pg_temp.cf_end();
	v_run := pg_temp.cf_pass();
	perform pg_temp.base_assert(v_run = (pg_temp.cf_wake('f2')).run_id, 'the run failed with nothing else to wake the Co-Founder: '
		|| 'Carol''s message gets its own run');
	v_read := pg_temp.cf_read(v_run);
	perform pg_temp.base_assert(v_read #>> '{payload,text}' = 'Carol: is the shop name final?' and pg_temp.cf_held(v_read) = '[]',
		'it is delivered once, as its own wake: ' || v_read::text);
end $$;
rollback to cf_fail;

savepoint cf_done;
select pg_temp.cf_sent('c1', 'alice', 'Alice: what do we ship first?');
select pg_temp.cf_sent('c2', 'carol', 'Carol: is the shop name final?');
do $$
declare v_x uuid := pg_temp.cf_pass();
begin
	perform pg_temp.cf_read(v_x);
	perform pg_temp.cf_complete();
	perform pg_temp.base_assert(pg_temp.cf_pass() is null and (pg_temp.cf_wake('c2')).status = 'cancelled'
			and (pg_temp.cf_wake('c2')).run_id is null
			and (pg_temp.cf_wake('c2')).blocked_reason = 'Delivered with another coworker message in run ' || v_x::text
			and exists (select 1 from public.qorpera_pending_peer_messages where wake_id = (pg_temp.cf_wake('c2')).id
				and delivered_run_id = v_x),
		'the run completed: the message it took is done and never runs again');
end $$;
rollback to cf_done;

savepoint cf_stop_carrier;
select pg_temp.cf_sent('a1', 'alice', 'Alice: what do we ship first?');
select pg_temp.cf_sent('a2', 'carol', 'Carol: is the shop name final?');
do $$
declare v_x uuid := pg_temp.cf_pass(); v_run uuid; v_read jsonb;
begin
	perform pg_temp.cf_read(v_x);
	perform pg_temp.cf_stop(current_setting('qorpera_test.cf_alice')::jsonb);
	perform pg_temp.base_assert(pg_temp.cf_job(v_x) = 'cancelled' and (pg_temp.cf_wake('a2')).status = 'queued',
		'a Stop of Alice''s chain ends the run that took Carol''s message, not the message');
	v_run := pg_temp.cf_pass();
	v_read := pg_temp.cf_read(v_run);
	perform pg_temp.base_assert(v_run = (pg_temp.cf_wake('a2')).run_id
			and v_read #>> '{payload,text}' = 'Carol: is the shop name final?' and pg_temp.cf_held(v_read) = '[]',
		'Carol''s message gets its own run: ' || v_read::text);
end $$;
rollback to cf_stop_carrier;

savepoint cf_stop_taken;
select pg_temp.cf_sent('t1', 'alice', 'Alice: what do we ship first?');
select pg_temp.cf_sent('t2', 'carol', 'Carol: is the shop name final?');
do $$
declare v_x uuid := pg_temp.cf_pass(); v_answer jsonb;
begin
	perform pg_temp.cf_read(v_x);
	perform pg_temp.cf_stop(current_setting('qorpera_test.cf_carol')::jsonb);
	perform pg_temp.base_assert(pg_temp.cf_job(v_x) = 'leased' and (pg_temp.cf_wake('t2')).status = 'cancelled'
			and exists (select 1 from public.qorpera_pending_peer_messages where wake_id = (pg_temp.cf_wake('t2')).id
				and delivered_run_id = v_x),
		'a Stop of Carol''s chain after the take cancels her message''s own wake; the run that took it goes on');
	v_answer := public.qorpera_send_coworker_message(current_setting('qorpera_test.cf_reader')::jsonb,
		'92400000-0000-4000-8000-000000000032', 'cf-t-answer', 'Co-Founder: yes, the name is final.');
	perform pg_temp.base_assert(v_answer ->> 'status' = 'queued'
			and (select causal_root_id from public.qorpera_wake_occurrences where id = (v_answer ->> 'occurrenceId')::uuid)
				= (pg_temp.cf_wake('t1')).causal_root_id
			and (pg_temp.cf_wake('t1')).causal_root_id <> (pg_temp.cf_wake('t2')).causal_root_id
			and (select status from public.qorpera_wake_occurrences where id = (v_answer ->> 'occurrenceId')::uuid) = 'queued',
		'the answer joins the run''s own chain (Alice''s), which the Stop of Carol''s chain does not reach');
	perform pg_temp.cf_end();
	perform pg_temp.base_assert(pg_temp.cf_pass() is null and (pg_temp.cf_wake('t2')).run_id is null,
		'when that run fails, the stopped message does not run again');
end $$;
rollback to cf_stop_taken;

savepoint cf_reads;
do $$
declare v_f jsonb := pg_temp.cf_shared('cf1295-f', array['92400000-0000-4000-8000-000000000031'::uuid,
		'92400000-0000-4000-8000-000000000033'::uuid]);
	v_g jsonb := pg_temp.cf_shared('cf1295-g', array['92400000-0000-4000-8000-000000000032'::uuid,
		'92400000-0000-4000-8000-000000000033'::uuid]);
begin
	perform set_config('qorpera_test.cf_f', v_f::text, true);
	perform set_config('qorpera_test.cf_g', v_g::text, true);
	perform pg_temp.cf_reads(current_setting('qorpera_test.cf_bob')::jsonb, 'cf1295-f/a.txt');
	perform pg_temp.cf_reads(current_setting('qorpera_test.cf_carol')::jsonb, 'cf1295-g/a.txt');
end $$;
select pg_temp.cf_sent('r1', 'alice', 'Alice: what do we ship first?');
select pg_temp.cf_sent('r2', 'bob', 'Bob: see the file I read.');
select pg_temp.cf_sent('r3', 'carol', 'Carol: see the file I read.');
do $$
declare v_g jsonb := current_setting('qorpera_test.cf_g')::jsonb;
begin
	perform public.qorpera_folder_revoke('92400000-0000-4000-8000-000000000020', pg_temp.base_owner(), (v_g ->> 'resource')::uuid,
		(v_g -> 'grants' ->> '92400000-0000-4000-8000-000000000033')::uuid);
	perform pg_temp.base_commit(pg_temp.base_owner(), 'cf-archive-bob', jsonb_build_array(pg_temp.base_write(
		'QorperaOS/agents/bob/agent.md', 'agent',
		E'---\nid: 92400000-0000-4000-8000-000000000031\nname: Bob\nrole: Research\nkind: agent\nstatus: archived\n---\nRead and change the company folder.\n',
		jsonb_build_object('kind', 'agent', 'id', '92400000-0000-4000-8000-000000000031', 'name', 'Bob', 'role', 'Research',
			'agentKind', 'agent', 'status', 'archived', 'colour', null, 'figure', null, 'model', null, 'effort', null,
			'instructions', 'Read and change the company folder.'),
		pg_temp.base_version('QorperaOS/agents/bob/agent.md'))));
	perform pg_temp.base_assert((select employment_status from public.qorpera_profile_staff
			where staff_agent_id = '92400000-0000-4000-8000-000000000031') = 'archived'
		and (pg_temp.cf_wake('r2')).status = 'queued' and public.qorpera_wake_authorized(pg_temp.cf_wake('r2'))
		and not public.qorpera_wake_authorized(pg_temp.cf_wake('r3')),
		'Bob left after sending, his message still stands; the Co-Founder may no longer read what Carol read');
end $$;
do $$
declare v_run uuid := pg_temp.cf_pass(); v_read jsonb; v_r2 uuid := (pg_temp.cf_wake('r2')).id;
begin
	v_read := pg_temp.cf_read(v_run);
	perform pg_temp.base_assert(v_run = (pg_temp.cf_wake('r1')).run_id and pg_temp.cf_held(v_read) = jsonb_build_array(
			pg_temp.cf_line('92400000-0000-4000-8000-000000000031', 'Bob: see the file I read.'))
		and pg_temp.cf_untaken() = array[(pg_temp.cf_wake('r3')).id],
		'the run takes the departed sender''s message and leaves the one it may not read: ' || v_read::text);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.run_id = v_run and rec.release_id = v_r2
				and rec.resource_id = (current_setting('qorpera_test.cf_f')::jsonb ->> 'resource')::uuid
				and x ->> 'path' = 'cf1295-f/a.txt')
		and exists (select 1 from public.qorpera_folder_run_reads where run_id = v_run
			and resource_id = (current_setting('qorpera_test.cf_f')::jsonb ->> 'resource')::uuid),
		'the run inherits what the taken message''s sender read, filed under that message, so erasure finds the run');
	perform pg_temp.cf_complete();
	perform pg_temp.base_assert(pg_temp.cf_pass() is null and (pg_temp.cf_wake('r3')).status = 'cancelled'
		and (pg_temp.cf_wake('r3')).blocked_reason = 'Wake recipient or source authority is unavailable',
		'the message it left is refused on its own, as before');
end $$;
rollback to cf_reads;

savepoint cf_bytes;
select pg_temp.cf_sent('b1', 'alice', 'Alice: the first of six.');
select pg_temp.cf_sent('b2', 'alice', repeat('2', 4000));
select pg_temp.cf_sent('b3', 'alice', repeat('3', 4000));
select pg_temp.cf_sent('b4', 'alice', repeat('4', 4000));
select pg_temp.cf_sent('b5', 'alice', repeat('5', 4000));
select pg_temp.cf_sent('b6', 'alice', repeat('6', 4000));
do $$
declare v_run uuid := pg_temp.cf_pass(); v_read jsonb;
begin
	v_read := pg_temp.cf_read(v_run);
	perform pg_temp.base_assert((select array_agg(left(m ->> 'text', 1) order by o)
			from jsonb_array_elements(v_read #> '{payload,heldMessages}') with ordinality x(m, o)) = array['2', '3', '4', '5']
		and pg_temp.cf_untaken() = array[(pg_temp.cf_wake('b6')).id],
		'a run takes messages while 19200 bytes hold them; the next waits for its own run');
	perform pg_temp.cf_complete();
	v_run := pg_temp.cf_pass();
	perform pg_temp.base_assert(v_run = (pg_temp.cf_wake('b6')).run_id, 'the message left over starts the next run');
end $$;
rollback to cf_bytes;

savepoint cf_count;
select pg_temp.cf_sent('n00', 'alice', 'Alice: message 0.');
select pg_temp.cf_sent('n01', 'alice', 'Alice: message 1.');
select pg_temp.cf_sent('n02', 'alice', 'Alice: message 2.');
select pg_temp.cf_sent('n03', 'alice', 'Alice: message 3.');
select pg_temp.cf_sent('n04', 'alice', 'Alice: message 4.');
select pg_temp.cf_sent('n05', 'alice', 'Alice: message 5.');
select pg_temp.cf_sent('n06', 'alice', 'Alice: message 6.');
select pg_temp.cf_sent('n07', 'alice', 'Alice: message 7.');
select pg_temp.cf_sent('n08', 'alice', 'Alice: message 8.');
select pg_temp.cf_sent('n09', 'alice', 'Alice: message 9.');
select pg_temp.cf_sent('n10', 'alice', 'Alice: message 10.');
select pg_temp.cf_sent('n11', 'alice', 'Alice: message 11.');
select pg_temp.cf_sent('n12', 'alice', 'Alice: message 12.');
select pg_temp.cf_sent('n13', 'alice', 'Alice: message 13.');
do $$
declare v_run uuid := pg_temp.cf_pass(); v_read jsonb;
begin
	v_read := pg_temp.cf_read(v_run);
	perform pg_temp.base_assert(v_read #>> '{payload,text}' = 'Alice: message 0.'
		and (select array_agg(m ->> 'text' order by o) from jsonb_array_elements(v_read #> '{payload,heldMessages}') with ordinality x(m, o))
			= array(select 'Alice: message ' || n || '.' from generate_series(1, 12) n)
		and pg_temp.cf_untaken() = array[(pg_temp.cf_wake('n13')).id],
		'a run takes twelve more messages at most: ' || v_read::text);
end $$;
rollback to cf_count;

savepoint cf_notes;
select pg_temp.cf_sent('h1', 'alice', repeat('ø', 1000), false);
select pg_temp.cf_sent('h2', 'alice', repeat('x', 1600), false);
select pg_temp.cf_sent('h3', 'alice', 'Alice: a short note.', false);
select pg_temp.cf_sent('h4', 'bob', repeat('Bob: a long note. ', 30), false);
select pg_temp.cf_sent('h5', 'bob', 'Bob: a short note.', false);
select pg_temp.cf_sent('h6', 'bob', 'Bob: a question that wakes.');
do $$
declare v_run uuid := pg_temp.cf_pass(); v_read jsonb; v_cut text;
begin
	v_read := pg_temp.cf_read(v_run);
	v_cut := v_read #>> '{payload,heldMessages,0,text}';
	perform pg_temp.base_assert(v_read #>> '{payload,text}' = 'Bob: a question that wakes.'
		and jsonb_array_length(v_read #> '{payload,heldMessages}') = 4
		and octet_length(v_cut) <= 1600 and octet_length(v_cut) > 1500
		and v_cut like 'øøø%' and v_cut like '% … [cut: the full message is in your transcript with this coworker]'
		and v_read #>> '{payload,heldMessages,1,text}' = repeat('x', 1600)
		and v_read #>> '{payload,heldMessages,2,text}' = 'Alice: a short note.'
		and v_read #>> '{payload,heldMessages,3,text}' = repeat('Bob: a long note. ', 30)
		and exists (select 1 from jsonb_array_elements(v_read #> '{payload,transcript}') t where t ->> 'text' = 'Bob: a short note.'),
		'a note is shown up to 1600 bytes, a cut one says where the rest is, and one the transcript cuts is listed too: '
			|| v_read::text);
end $$;
rollback to cf_notes;

rollback;
