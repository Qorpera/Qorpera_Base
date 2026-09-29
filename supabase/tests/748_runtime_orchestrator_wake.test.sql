-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- 20260929550000: the database broadcasts a wake-up to every active orchestrator's private Realtime
-- topic, once per transaction, when claimable work may have appeared. The orchestrator receives it as anon.
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
-- Its control token is 'c' x 43; the node test pins the same topic for it.
select public.qorpera_register_runner_orchestrator('30000000-0000-4000-8000-000000000731', 'Wake fixture', 'lxd',
	'0c49d89230696ff3c031ca5a128a4e121e3589bf872c17fa04487ed0cc245d21', 3600);
reset role;

create function pg_temp.wakes() returns jsonb language sql as $$
	select coalesce(jsonb_agg(jsonb_build_object('topic', topic, 'event', event, 'private', private,
		'extension', extension, 'payload', payload) order by topic), '[]'::jsonb)
	from realtime.messages where topic like 'qorpera-orchestrator-wake-%'
$$;
-- Only these two orchestrators' topics: rows other tests committed (race tests use their own connections) may wake more.
create function pg_temp.wakes_on(p_topics text[]) returns jsonb language sql as $$
	select coalesce(jsonb_agg(value order by value ->> 'topic'), '[]'::jsonb)
	from jsonb_array_elements(pg_temp.wakes()) where value ->> 'topic' = any (p_topics)
$$;
create function pg_temp.wake(p_topic text) returns jsonb language sql as $$
	select jsonb_build_object('topic', p_topic, 'event', 'wake', 'private', true, 'extension', 'broadcast',
		'payload', jsonb_build_object('schema', 'qorpera.orchestrator-wake/v1'))
$$;
-- A new transaction, as far as the once-per-transaction guard knows.
create function pg_temp.next_transaction() returns void language sql as $$
	select set_config('qorpera.runner_orchestrators_woken', '', true)::text::void
$$;
-- Work that fires the wake-up on demand, apart from the job state machines.
create table pg_temp.work (n integer);
create trigger work_wake after insert on pg_temp.work
	for each row execute function public.qorpera_wake_runner_orchestrators_internal();

do $$
declare
	v_fixture text := public.qorpera_runner_orchestrator_wake_topic(repeat('0', 64));
	v_wake text := 'qorpera-orchestrator-wake-cab2795dd16fc7b4a1303f59434bd9ff1be1cac1204e30dcf267af3c56a1da88';
	v_job uuid := (current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId')::uuid;
	v_seen bigint;
	v_started timestamptz;
	v_lock_timeout text := current_setting('lock_timeout');
begin
	perform pg_temp.wake_assert(public.qorpera_runner_orchestrator_wake_topic(
		'0c49d89230696ff3c031ca5a128a4e121e3589bf872c17fa04487ed0cc245d21') = v_wake,
		'The database names the topic the node derives from its control token');
	if has_function_privilege('anon', 'public.qorpera_runner_orchestrator_wake_topic(text)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_runner_orchestrator_wake_topic(text)', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_wake_runner_orchestrators_internal()', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_wake_runner_orchestrators_internal()', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_wake_runner_orchestrators_internal()', 'EXECUTE') then
		raise exception 'Wake-up functions are callable by clients';
	end if;
	perform pg_temp.wake_assert((select count(*) from pg_catalog.pg_trigger
		where tgfoid = 'public.qorpera_wake_runner_orchestrators_internal()'::regprocedure and not tgisinternal
			and tgrelid in ('public.qorpera_runner_jobs'::regclass, 'public.qorpera_session_turn_requests'::regclass,
				'public.qorpera_session_inputs'::regclass, 'public.qorpera_wake_occurrences'::regclass,
				'public.qorpera_company_proposal_review_assignments'::regclass)) = 9,
		'Every source of claimable work wakes the orchestrators');
	perform pg_temp.wake_assert((select count(*) from pg_catalog.pg_trigger as trigger
		where trigger.tgfoid = 'public.qorpera_wake_runner_orchestrators_internal()'::regprocedure and not trigger.tgisinternal
			and trigger.tgrelid <> 'pg_temp.work'::regclass
			and (trigger.tgtype & 1) = 1 and (trigger.tgtype & 2) = 0) = 9,
		'The wake-up triggers fire after the change, once per row that passes their WHEN clause');

	-- A job that ends can make its session's next input claimable: every active orchestrator is woken once,
	-- on its own private topic, with nothing about the work.
	delete from realtime.messages;
	perform pg_temp.next_transaction();
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_terminalize_runner_attempt(v_job, 'failed', 'Wake fixture', false);
	perform pg_temp.wake_assert(pg_temp.wakes_on(array[v_fixture, v_wake]) = jsonb_build_array(
		pg_temp.wake(least(v_fixture, v_wake)), pg_temp.wake(greatest(v_fixture, v_wake))),
		'Every active orchestrator is woken on its own private topic');

	-- More work in the same transaction wakes nobody again.
	insert into pg_temp.work values (1), (2), (3);
	perform pg_temp.wake_assert(jsonb_array_length(pg_temp.wakes_on(array[v_fixture, v_wake])) = 2,
		'One wake-up per orchestrator per transaction');

	-- An orchestrator whose control token expired, or that is revoked, is not woken.
	delete from realtime.messages;
	perform pg_temp.next_transaction();
	update public.qorpera_runner_orchestrators set control_token_expires_at = statement_timestamp() - interval '1 second'
	where id = '30000000-0000-4000-8000-000000000731';
	insert into pg_temp.work values (4);
	perform pg_temp.wake_assert(pg_temp.wakes_on(array[v_fixture, v_wake]) = jsonb_build_array(pg_temp.wake(v_fixture)),
		'An orchestrator whose control token expired is not woken');
	delete from realtime.messages;
	perform pg_temp.next_transaction();
	update public.qorpera_runner_orchestrators set status = 'revoked'
	where id = '30000000-0000-4000-8000-000000000092';
	insert into pg_temp.work values (5);
	perform pg_temp.wake_assert(pg_temp.wakes_on(array[v_fixture, v_wake]) = '[]'::jsonb,
		'A revoked orchestrator is not woken');
	update public.qorpera_runner_orchestrators set status = 'active', control_token_expires_at = statement_timestamp() + interval '1 hour'
	where id in ('30000000-0000-4000-8000-000000000092', '30000000-0000-4000-8000-000000000731');

	-- A failing Realtime never fails the work it announces.
	delete from realtime.messages;
	perform pg_temp.next_transaction();
	create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
	returns void language plpgsql as $send$ begin raise exception 'Realtime is unavailable'; end $send$;
	insert into pg_temp.work values (6);
	perform pg_temp.wake_assert((select count(*) from pg_temp.work where n = 6) = 1 and pg_temp.wakes() = '[]'::jsonb,
		'A failing Realtime never fails the enqueue');
	-- Realtime's table held by someone else (its partition maintenance): the enqueue waits at most the
	-- 200 ms lock timeout, then goes ahead without a wake-up.
	delete from realtime.messages;
	perform pg_temp.next_transaction();
	perform dblink_connect('wake_locker', 'dbname=' || current_database());
	perform * from dblink('wake_locker', 'select pg_advisory_lock(748001)::text') as locked(result text);
	create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
	returns void language plpgsql as $send$
	begin
		perform pg_advisory_xact_lock(748001);
		insert into realtime.messages (payload, event, topic, private, extension)
		values (payload, event, topic, private, 'broadcast');
	end
	$send$;
	v_started := clock_timestamp();
	insert into pg_temp.work values (8);
	perform pg_temp.wake_assert(clock_timestamp() - v_started between interval '150 milliseconds' and interval '2 seconds'
		and (select count(*) from pg_temp.work where n = 8) = 1 and pg_temp.wakes() = '[]'::jsonb
		and current_setting('lock_timeout') = v_lock_timeout,
		'A locked Realtime table delays the enqueue by at most the lock timeout, and the caller''s timeout stays');
	perform * from dblink('wake_locker', 'select pg_advisory_unlock(748001)::text') as unlocked(result text);
	perform dblink_disconnect('wake_locker');
	create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
	returns void language plpgsql as $send$
	begin
		begin
			execute format('set local realtime.topic to %L', topic);
			insert into realtime.messages (payload, event, topic, private, extension)
			values (payload, event, topic, private, 'broadcast');
		exception when others then
			raise warning 'ErrorSendingBroadcastMessage: %', sqlerrm;
		end;
	end
	$send$;

	-- The orchestrator reads broadcasts on wake topics as anon; nothing else, and it may not publish.
	delete from realtime.messages;
	perform pg_temp.next_transaction();
	insert into pg_temp.work values (7);
	perform set_config('realtime.topic', v_wake, true);
	set local role anon;
	select count(*) into v_seen from realtime.messages;
	begin
		insert into realtime.messages (topic, extension, payload, event, private)
		values (v_wake, 'broadcast', '{}', 'wake', true);
		raise exception 'anon published a wake-up';
	exception when insufficient_privilege then null;
	end;
	reset role;
	perform pg_temp.wake_assert(v_seen > 0, 'anon receives on a wake topic');
	perform set_config('realtime.topic', 'qorpera-room-drafts-30000000-0000-4000-8000-000000000001', true);
	set local role anon;
	select count(*) into v_seen from realtime.messages;
	reset role;
	perform pg_temp.wake_assert(v_seen = 0, 'anon receives nothing on another topic');
	perform set_config('realtime.topic', 'qorpera-orchestrator-wake-not-a-digest', true);
	set local role anon;
	select count(*) into v_seen from realtime.messages;
	reset role;
	perform pg_temp.wake_assert(v_seen = 0, 'anon receives nothing on a malformed topic');
end
$$;

rollback;
