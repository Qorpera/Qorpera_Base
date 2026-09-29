-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- 20260929550000: while the operator switch is on, the database broadcasts a wake-up to every active
-- orchestrator's private Realtime topic, once per transaction, when claimable work may have appeared. The
-- orchestrator receives it as anon, on the topic it joined only.
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
-- Supabase's realtime.send (bootstrap.sql): its own failures, a lock timeout included, become a warning.
create function pg_temp.platform_send() returns void language plpgsql as $$
begin
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
end
$$;

do $$
declare
	v_wake text := 'qorpera-orchestrator-wake-cab2795dd16fc7b4a1303f59434bd9ff1be1cac1204e30dcf267af3c56a1da88';
	v_definitions text[];
begin
	perform pg_temp.wake_assert(public.qorpera_runner_orchestrator_wake_topic(
		'0c49d89230696ff3c031ca5a128a4e121e3589bf872c17fa04487ed0cc245d21') = v_wake,
		'The database names the topic the node derives from its control token');
	if has_function_privilege('anon', 'public.qorpera_runner_orchestrator_wake_topic(text)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_runner_orchestrator_wake_topic(text)', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_wake_runner_orchestrators_internal()', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_wake_runner_orchestrators_internal()', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_wake_runner_orchestrators_internal()', 'EXECUTE')
		or has_table_privilege('anon', 'public.qorpera_orchestrator_wake_settings', 'SELECT')
		or has_table_privilege('authenticated', 'public.qorpera_orchestrator_wake_settings', 'SELECT')
		or has_table_privilege('authenticated', 'public.qorpera_orchestrator_wake_settings', 'UPDATE') then
		raise exception 'Wake-up functions or the switch are open to clients';
	end if;
	-- Every source of claimable work, AFTER each row, with exactly these conditions.
	select array_agg(replace(pg_get_triggerdef(trigger.oid), 'public.qorpera_wake_runner_orchestrators_internal()',
			'qorpera_wake_runner_orchestrators_internal()') order by trigger.tgname)
	into v_definitions
	from pg_catalog.pg_trigger as trigger
	where trigger.tgfoid = 'public.qorpera_wake_runner_orchestrators_internal()'::regprocedure
		and not trigger.tgisinternal and trigger.tgrelid <> 'pg_temp.work'::regclass;
	perform pg_temp.wake_assert(v_definitions = array[
		'CREATE TRIGGER qorpera_proposal_reviews_insert_wake_orchestrators AFTER INSERT ON public.qorpera_company_proposal_review_assignments FOR EACH ROW WHEN ((new.status = ''queued''::text)) EXECUTE FUNCTION qorpera_wake_runner_orchestrators_internal()',
		'CREATE TRIGGER qorpera_proposal_reviews_status_wake_orchestrators AFTER UPDATE OF status ON public.qorpera_company_proposal_review_assignments FOR EACH ROW WHEN (((new.status = ''queued''::text) AND (old.status IS DISTINCT FROM ''queued''::text))) EXECUTE FUNCTION qorpera_wake_runner_orchestrators_internal()',
		'CREATE TRIGGER qorpera_runner_jobs_insert_wake_orchestrators AFTER INSERT ON public.qorpera_runner_jobs FOR EACH ROW EXECUTE FUNCTION qorpera_wake_runner_orchestrators_internal()',
		'CREATE TRIGGER qorpera_runner_jobs_status_wake_orchestrators AFTER UPDATE OF status ON public.qorpera_runner_jobs FOR EACH ROW WHEN ((new.status IS DISTINCT FROM old.status)) EXECUTE FUNCTION qorpera_wake_runner_orchestrators_internal()',
		'CREATE TRIGGER qorpera_session_inputs_insert_wake_orchestrators AFTER INSERT ON public.qorpera_session_inputs FOR EACH ROW EXECUTE FUNCTION qorpera_wake_runner_orchestrators_internal()',
		'CREATE TRIGGER qorpera_session_turn_requests_insert_wake_orchestrators AFTER INSERT ON public.qorpera_session_turn_requests FOR EACH ROW WHEN ((new.status = ''queued''::text)) EXECUTE FUNCTION qorpera_wake_runner_orchestrators_internal()',
		'CREATE TRIGGER qorpera_session_turn_requests_status_wake_orchestrators AFTER UPDATE OF status ON public.qorpera_session_turn_requests FOR EACH ROW WHEN (((new.status = ''queued''::text) AND (old.status IS DISTINCT FROM ''queued''::text))) EXECUTE FUNCTION qorpera_wake_runner_orchestrators_internal()',
		'CREATE TRIGGER qorpera_wake_occurrences_insert_wake_orchestrators AFTER INSERT ON public.qorpera_wake_occurrences FOR EACH ROW WHEN ((new.status = ''queued''::text)) EXECUTE FUNCTION qorpera_wake_runner_orchestrators_internal()',
		'CREATE TRIGGER qorpera_wake_occurrences_status_wake_orchestrators AFTER UPDATE OF status ON public.qorpera_wake_occurrences FOR EACH ROW WHEN (((new.status = ''queued''::text) AND (old.status IS DISTINCT FROM ''queued''::text))) EXECUTE FUNCTION qorpera_wake_runner_orchestrators_internal()'
	], 'Every source of claimable work wakes the orchestrators, after the row, with exactly these conditions');

	-- Off until an operator switches it on: the fixture's own work sent nothing, and neither does this.
	perform pg_temp.wake_assert(not (select enabled from public.qorpera_orchestrator_wake_settings)
		and pg_temp.wakes() = '[]'::jsonb, 'Wake-ups are off by default');
	perform pg_temp.next_transaction();
	insert into pg_temp.work values (0);
	perform pg_temp.wake_assert(pg_temp.wakes() = '[]'::jsonb, 'Nothing is sent while the switch is off');
end
$$;

-- Realtime's table locked (its partition work): three orchestrators with Supabase's realtime.send share one
-- 200 ms budget, so the enqueue waits about 200 ms once, not once per orchestrator. The enqueue runs in its
-- own session (this one would wait on nothing: it has not touched realtime.messages) while another holds
-- the table.
do $$
declare
	v_started timestamptz;
	v_elapsed interval;
	v_timeout text;
	v_rows integer;
begin
	perform pg_temp.platform_send();
	perform dblink_connect('wake_worker', 'dbname=' || current_database());
	perform dblink_connect('wake_locker', 'dbname=' || current_database());
	-- The worker's own switch and three orchestrators, uncommitted in its transaction.
	perform dblink_exec('wake_worker', 'create temp table wake_work (n integer)');
	perform dblink_exec('wake_worker', 'create trigger wake_work_wake after insert on wake_work for each row '
		|| 'execute function public.qorpera_wake_runner_orchestrators_internal()');
	for v_rows in 0..1 loop
		perform dblink_exec('wake_worker', 'begin');
		perform dblink_exec('wake_worker', $worker$
			do $setup$
			begin
				perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
				update public.qorpera_orchestrator_wake_settings set enabled = true;
				perform public.qorpera_register_runner_orchestrator(('74800000-0000-4000-8000-00000000000' || n)::uuid,
					'Wake lock ' || n, 'lxd', repeat(n::text, 64), 3600)
				from generate_series(1, 3) as n;
			end
			$setup$
		$worker$);
		-- The first round only warms the worker (plans, compiled functions) while Realtime's table is free.
		exit when v_rows = 1;
		perform dblink_exec('wake_worker', 'insert into wake_work values (0)');
		perform dblink_exec('wake_worker', 'rollback');
	end loop;
	perform dblink_send_query('wake_locker',
		'begin; lock table realtime.messages in access exclusive mode; select pg_sleep(30)');
	for v_rows in 1..500 loop
		exit when exists (select 1 from pg_catalog.pg_locks where relation = 'realtime.messages'::regclass
			and mode = 'AccessExclusiveLock');
		perform pg_sleep(0.01);
	end loop;
	v_started := clock_timestamp();
	perform dblink_exec('wake_worker', 'insert into wake_work values (1)');
	v_elapsed := clock_timestamp() - v_started;
	select setting into v_timeout from dblink('wake_worker', 'select current_setting(''lock_timeout'')') as t(setting text);
	select rows into v_rows from dblink('wake_worker', 'select count(*)::integer from wake_work where n = 1') as t(rows integer);
	perform dblink_cancel_query('wake_locker');
	perform dblink_disconnect('wake_locker');
	perform dblink_exec('wake_worker', 'rollback');
	perform dblink_disconnect('wake_worker');
	perform pg_temp.wake_assert(v_elapsed between interval '150 milliseconds' and interval '350 milliseconds'
		and v_rows = 1 and v_timeout = '0',
		'A locked Realtime table holds up the enqueue once for the 200 ms budget, not once per orchestrator ('
			|| v_elapsed::text || '), and leaves the caller''s lock timeout as it was');
end
$$;

update public.qorpera_orchestrator_wake_settings set enabled = true;

do $$
declare
	v_fixture text := public.qorpera_runner_orchestrator_wake_topic(repeat('0', 64));
	v_wake text := 'qorpera-orchestrator-wake-cab2795dd16fc7b4a1303f59434bd9ff1be1cac1204e30dcf267af3c56a1da88';
	v_other text := 'qorpera-orchestrator-wake-' || repeat('a', 64);
	v_drafts text := 'qorpera-room-drafts-30000000-0000-4000-8000-000000000001';
	v_job uuid := (current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId')::uuid;
	v_seen bigint;
	v_elsewhere bigint;
begin
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
	perform pg_temp.platform_send();

	-- The orchestrator reads, as anon, only rows of the wake topic it joined; nothing else, whatever the
	-- setting says, and it may not publish.
	delete from realtime.messages;
	perform pg_temp.next_transaction();
	insert into pg_temp.work values (7);
	insert into realtime.messages (topic, extension, payload, event, private)
	values (v_drafts, 'broadcast', '{"body":"a member''s draft"}', 'draft', true);
	perform set_config('realtime.topic', v_wake, true);
	set local role anon;
	select count(*) filter (where topic = v_wake), count(*) filter (where topic <> v_wake)
	into v_seen, v_elsewhere from realtime.messages;
	begin
		insert into realtime.messages (topic, extension, payload, event, private)
		values (v_wake, 'broadcast', '{}', 'wake', true);
		raise exception 'anon published a wake-up';
	exception when insufficient_privilege then null;
	end;
	reset role;
	perform pg_temp.wake_assert(v_seen = 1 and v_elsewhere = 0,
		'anon reads its wake topic and no other topic''s rows');
	perform set_config('realtime.topic', v_other, true);
	set local role anon;
	select count(*) into v_seen from realtime.messages;
	reset role;
	perform pg_temp.wake_assert(v_seen = 0, 'another wake-shaped topic reads nothing');
	perform set_config('realtime.topic', v_drafts, true);
	set local role anon;
	select count(*) into v_seen from realtime.messages;
	reset role;
	perform pg_temp.wake_assert(v_seen = 0, 'anon reads nothing on a drafts topic');
	perform set_config('realtime.topic', v_wake, true);
	perform pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
	set local role authenticated;
	select count(*) into v_seen from realtime.messages where topic = v_wake;
	reset role;
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert(v_seen = 0, 'a member reads nothing on a wake topic');
end
$$;

rollback;

-- The switch's own table locked (a later migration altering it): the switch is read inside the same 200 ms
-- budget, and a switch that cannot be read counts as off. The enqueue waits about 200 ms, sends nothing and
-- does not fail; once the lock is gone the same transaction wakes every orchestrator. This runs after the
-- fixture's transaction, which has read the switch and so would keep another session from locking it: the
-- switch is committed on for the check and committed off again at the end.
do $$
declare
	v_topics text[] := array(select public.qorpera_runner_orchestrator_wake_topic(repeat(n::text, 64))
		from generate_series(4, 6) as n order by 1);
	v_count text := format('select count(*)::integer from realtime.messages where topic = any (%L::text[])', v_topics);
	v_warm integer;
	v_started timestamptz;
	v_elapsed interval;
	v_rows integer;
	v_locked integer;
	v_unlocked integer;
	v_timeout text;
	v_waits integer;
begin
	perform dblink_connect('switch_worker', 'dbname=' || current_database());
	perform dblink_connect('switch_locker', 'dbname=' || current_database());
	perform dblink_exec('switch_locker', 'update public.qorpera_orchestrator_wake_settings set enabled = true');
	-- The caller's own lock timeout, which the wake-up must leave as it was.
	perform dblink_exec('switch_worker', 'set lock_timeout = ''1s''');
	perform dblink_exec('switch_worker', 'create temp table switch_work (n integer)');
	perform dblink_exec('switch_worker', 'create trigger switch_work_wake after insert on switch_work for each row '
		|| 'execute function public.qorpera_wake_runner_orchestrators_internal()');
	-- Three orchestrators, uncommitted in the worker's transaction. The first round, with nothing locked, also
	-- warms the worker (plans, compiled functions).
	for v_waits in 0..1 loop
		perform dblink_exec('switch_worker', 'begin');
		perform dblink_exec('switch_worker', $worker$
			do $setup$
			begin
				perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
				perform public.qorpera_register_runner_orchestrator(('74800000-0000-4000-8000-00000000000' || n)::uuid,
					'Wake switch ' || n, 'lxd', repeat(n::text, 64), 3600)
				from generate_series(4, 6) as n;
			end
			$setup$
		$worker$);
		exit when v_waits = 1;
		perform dblink_exec('switch_worker', 'insert into switch_work values (0)');
		select sent into v_warm from dblink('switch_worker', v_count) as t(sent integer);
		perform dblink_exec('switch_worker', 'rollback');
	end loop;
	perform dblink_send_query('switch_locker',
		'begin; lock table public.qorpera_orchestrator_wake_settings in access exclusive mode; select pg_sleep(30)');
	for v_waits in 1..500 loop
		exit when exists (select 1 from pg_catalog.pg_locks
			where relation = 'public.qorpera_orchestrator_wake_settings'::regclass
				and mode = 'AccessExclusiveLock' and granted);
		perform pg_sleep(0.01);
	end loop;
	v_started := clock_timestamp();
	perform dblink_exec('switch_worker', 'insert into switch_work values (1)');
	v_elapsed := clock_timestamp() - v_started;
	select rows into v_rows from dblink('switch_worker', 'select count(*)::integer from switch_work where n = 1')
		as t(rows integer);
	select sent into v_locked from dblink('switch_worker', v_count) as t(sent integer);
	perform dblink_cancel_query('switch_locker');
	perform dblink_disconnect('switch_locker');
	for v_waits in 1..500 loop
		exit when not exists (select 1 from pg_catalog.pg_locks
			where relation = 'public.qorpera_orchestrator_wake_settings'::regclass and mode = 'AccessExclusiveLock');
		perform pg_sleep(0.01);
	end loop;
	-- The same transaction, as if new to the once-per-transaction guard, with the lock gone.
	perform guard from dblink('switch_worker', 'select set_config(''qorpera.runner_orchestrators_woken'', '''', true)')
		as t(guard text);
	perform dblink_exec('switch_worker', 'insert into switch_work values (2)');
	select sent into v_unlocked from dblink('switch_worker', v_count) as t(sent integer);
	select setting into v_timeout from dblink('switch_worker', 'select current_setting(''lock_timeout'')')
		as t(setting text);
	perform dblink_exec('switch_worker', 'rollback');
	perform dblink_exec('switch_worker', 'update public.qorpera_orchestrator_wake_settings set enabled = false');
	perform dblink_disconnect('switch_worker');
	if v_warm is distinct from 3 then
		raise exception 'Wake assertion: the switch on and nothing locked wakes every orchestrator (%)', v_warm;
	end if;
	if not (v_elapsed between interval '150 milliseconds' and interval '350 milliseconds') or v_rows <> 1
		or v_locked <> 0 then
		raise exception 'Wake assertion: a locked switch counts as off within the 200 ms budget and never fails the '
			'enqueue (% ms, % rows, % sent)', round(extract(epoch from v_elapsed) * 1000), v_rows, v_locked;
	end if;
	if v_unlocked is distinct from 3 or v_timeout is distinct from '1s' then
		raise exception 'Wake assertion: once the lock is gone the enqueue wakes every orchestrator (%), and the '
			'caller''s lock timeout stays as it was (%)', v_unlocked, v_timeout;
	end if;
	if (select enabled from public.qorpera_orchestrator_wake_settings) then
		raise exception 'Wake assertion: the switch is off again';
	end if;
end
$$;
