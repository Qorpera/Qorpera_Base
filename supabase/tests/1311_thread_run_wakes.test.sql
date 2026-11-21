-- @fixture 1307_member_open_decisions.test.sql until "savepoint od_left;"
create function pg_temp.rw_read(p_user uuid, p_tail boolean default false) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	if p_tail then
		v := public.qorpera_read_session_events_tail(current_setting('qorpera_test.card_thread')::uuid, null, 500);
	else
		v := public.qorpera_read_session_events(current_setting('qorpera_test.card_thread')::uuid, 0, 500);
	end if;
	reset role;
	perform pg_temp.base_claims('service_role');
	return v;
end $$;

do $$
declare v jsonb; v_tail jsonb; v_run_events bigint; v_wrong bigint; v_stray bigint;
begin
	v := pg_temp.rw_read('92400000-0000-4000-8000-000000000001');
	select count(*) filter (where item ->> 'execution_kind' = 'run'),
		count(*) filter (where item ->> 'execution_kind' = 'run' and item ->> 'run_wake' is distinct from (
			select wake.wake_kind from public.qorpera_wake_occurrences as wake
			where wake.run_id = (item ->> 'execution_id')::uuid)),
		count(*) filter (where item ->> 'execution_kind' is distinct from 'run' and item ? 'run_wake')
	into v_run_events, v_wrong, v_stray
	from jsonb_array_elements(v) as listed(item);
	perform pg_temp.base_assert(v_run_events > 0 and v_wrong = 0,
		format('Every event a run wrote says what woke that run: %s run events, %s wrong', v_run_events, v_wrong));
	perform pg_temp.base_assert(v_stray = 0, 'An event no run wrote, a member''s post among them, carries no wake');
	perform pg_temp.base_assert(exists (select 1 from jsonb_array_elements(v) as listed(item)
			where item ->> 'run_wake' = 'room' and item ->> 'event_type' = 'interaction_request')
		and exists (select 1 from jsonb_array_elements(v) as listed(item)
			where item ->> 'event_type' = 'message' and not item ? 'run_wake'),
		'Fixture: a card of a run a member''s post woke, and a member''s own post');
	v_tail := pg_temp.rw_read('92400000-0000-4000-8000-000000000001', true);
	perform pg_temp.base_assert(v_tail = v, 'The tail read gives the same events with the same field');
	perform pg_temp.base_assert(pg_temp.rw_read('92400000-0000-4000-8000-000000000003') = v,
		'A spectator reads the same events with the same field');
end
$$;

savepoint rw_no_wake;
do $$
declare v jsonb;
begin
	delete from public.qorpera_wake_occurrences where run_id = (current_setting('qorpera_test.od_binding')::jsonb ->> 'runId')::uuid;
	v := pg_temp.rw_read('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(v) as listed(item)
			where item ->> 'execution_id' = current_setting('qorpera_test.od_binding')::jsonb ->> 'runId' and item ? 'run_wake')
		and exists (select 1 from jsonb_array_elements(v) as listed(item)
			where item ->> 'execution_id' = current_setting('qorpera_test.od_binding')::jsonb ->> 'runId'),
		'A run with no wake leaves the field out, and its events are still read');
end
$$;
rollback to savepoint rw_no_wake;

do $$
begin
	perform pg_temp.base_assert((select prosecdef and proconfig = array['search_path=""'] from pg_proc
		where oid = 'public.qorpera_read_session_events(uuid,bigint,integer)'::regprocedure),
		'The patched read is still a definer function with an empty search path');
	perform pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_read_session_events(uuid,bigint,integer)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_read_session_events(uuid,bigint,integer)', 'execute'),
		'and keeps its grants');
	perform pg_temp.base_error(format('select public.qorpera_read_session_events(%L, 0, 500)',
		current_setting('qorpera_test.card_thread')), '42501', 'session read access is required');
end
$$;

rollback;
