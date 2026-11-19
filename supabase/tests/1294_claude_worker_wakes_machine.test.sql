-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.c4_owner_id());
select pg_temp.c4_login('12940000-0000-4000-8000-0000000000c1', pg_temp.c4_owner_id(), 'canary-wake-machine') \g /dev/null

create function pg_temp.cw_saved(p_result jsonb, p_what text) returns void language plpgsql as $$
begin
	perform pg_temp.base_assert(p_result -> 'units' -> 0 ->> 'outcome' = 'saved', p_what || ': ' || p_result::text);
end $$;
create function pg_temp.cw_id(p_n integer) returns uuid language sql as $$
	select ('12940000-0000-4000-8000-0000000001' || lpad(p_n::text, 2, '0'))::uuid
$$;
create function pg_temp.cw_dispatch(p_n integer, p_harness text default null) returns jsonb language sql as $$
	select pg_temp.c4_dispatch(pg_temp.c4_alice(), 'wake-machine-' || p_n, 'QorperaOS/agents/alice/todos/onboarding/wake-' || p_n,
		pg_temp.c4_brief(pg_temp.cw_id(p_n), p_harness))
$$;
create function pg_temp.cw_worker(p_n integer) returns public.qorpera_runtime_workers language sql as $$
	select * from public.qorpera_runtime_workers where id = pg_temp.cw_id(p_n)
$$;
create function pg_temp.cw_due(p_n integer) returns boolean language sql as $$
	select public.qorpera_folder_worker_due(pg_temp.cw_worker(p_n))
$$;
create function pg_temp.cw_wake(p_n integer) returns public.qorpera_wake_occurrences language sql as $$
	select wake.* from public.qorpera_wake_occurrences wake where wake.id = (pg_temp.cw_worker(p_n)).occurrence_id
$$;
create function pg_temp.cw_events(p_n integer, p_kind text) returns jsonb language sql as $$
	select coalesce(jsonb_agg(event.body order by event.created_at, event.id), '[]'::jsonb)
	from public.qorpera_runtime_worker_events event where event.worker_id = pg_temp.cw_id(p_n) and event.kind = p_kind
$$;
create function pg_temp.cw_agent_machines() returns setof public.qorpera_company_machines language sql as $$
	select * from public.qorpera_company_machines
	where started_by_staff_agent_id = '92400000-0000-4000-8000-000000000030' and removed_at is null order by created_at, id
$$;
create function pg_temp.cw_sleep(p_name text) returns void language sql as $$
	update public.qorpera_company_machines set desired_state = 'stopped', desired_by = 'kernel' where name = p_name and removed_at is null;
	update public.qorpera_company_machine_placements set running_at = null where id = (pg_temp.h1_placement(p_name)).id;
$$;
create function pg_temp.cw_gone(p_name text) returns void language sql as $$
	update public.qorpera_company_machine_placements set retired_at = clock_timestamp() where id = (pg_temp.h1_placement(p_name)).id;
	update public.qorpera_company_machines set desired_state = 'deleted', removed_at = clock_timestamp()
	where name = p_name and removed_at is null;
$$;
create function pg_temp.cw_listed(p_name text) returns jsonb language sql as $$
	select entry from jsonb_array_elements(public.qorpera_list_executor_machines('mx-1246', repeat('c', 64))) entry
	where entry ->> 'machineId' = (pg_temp.h1_machine(p_name)).id::text and not (entry -> 'retired')::boolean
$$;
create function pg_temp.cw_stop(p_name text) returns jsonb language sql as $$
	select public.qorpera_authorize_executor_machine((pg_temp.h1_placement(p_name)).id, (pg_temp.h1_placement(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.h1_placement(p_name)).binding),
		(pg_temp.h1_placement(p_name)).machine_id_sha256, 'stop')
$$;
create function pg_temp.cw_no_home_words() returns text language sql as $$
	select pg_temp.c4_words('Claude Code works on your own machine, and none is running for <member>''s work now: start your '
		|| 'machine, or dispatch this worker without Claude Code')
$$;

do $$
declare w public.qorpera_runtime_workers%rowtype; v_home public.qorpera_company_machines%rowtype; v_wake public.qorpera_wake_occurrences%rowtype;
begin
	begin
		perform pg_temp.cw_sleep('home-a');
		perform pg_temp.base_assert(public.qorpera_claude_worker_problem('92400000-0000-4000-8000-000000000010',
			'92400000-0000-4000-8000-000000000030', pg_temp.h1_run()) = pg_temp.cw_no_home_words(),
			'1: with the machine asleep the problem is the machine, in the same words');
		perform pg_temp.base_assert(public.qorpera_claude_worker_member_problem('92400000-0000-4000-8000-000000000010',
			pg_temp.h1_run()) is null, '1: and nothing of the member''s');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(1), '1: the default dispatch');
		w := pg_temp.cw_worker(1);
		perform pg_temp.base_assert(w.harness = 'claude-code' and w.harness_default
			and w.claude_login_id = '12940000-0000-4000-8000-0000000000c1' and w.claude_machine_id is null,
			'1: only the machine is missing, so the worker still goes to Claude Code: ' || to_jsonb(w)::text);
		perform pg_temp.base_assert(pg_temp.cw_due(1), '1: and is due, to wake its machine');
		perform pg_temp.c4_drain();
		w := pg_temp.cw_worker(1);
		v_home := pg_temp.h1_machine('home-a');
		perform pg_temp.base_assert(w.occurrence_id is null and w.claude_machine_id = v_home.id and w.claude_machine_since is not null
			and w.harness = 'claude-code', '1: the drain woke the agent''s machine and the worker waits for it: ' || to_jsonb(w)::text);
		perform pg_temp.base_assert(v_home.desired_state = 'running' and v_home.desired_by = 'agent'
			and public.qorpera_company_machine_state(v_home) = 'starting',
			'1: the machine is wanted running by the agent: ' || to_jsonb(v_home)::text);
		perform pg_temp.base_assert(jsonb_array_length(pg_temp.cw_events(1, 'machine_woken')) = 1
			and pg_temp.cw_events(1, 'machine_woken') -> 0 ->> 'machine' = 'home-a'
			and (pg_temp.cw_events(1, 'machine_woken') -> 0 -> 'new') = 'false'::jsonb
			and (pg_temp.cw_events(1, 'machine_woken') -> 0 -> 'woke') = 'true'::jsonb,
			'1: the wake is recorded: ' || pg_temp.cw_events(1, 'machine_woken')::text);
		perform pg_temp.base_assert(not pg_temp.cw_due(1) and not exists (select 1 from jsonb_array_elements(
			public.qorpera_folder_workers_due(null, 100) -> 'items') item
			where item ->> 'environment_id' = '92400000-0000-4000-8000-000000000020'),
			'1: a worker waiting for its machine is not due, and its company is not listed');
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert(jsonb_array_length(pg_temp.cw_events(1, 'machine_woken')) = 1
			and (pg_temp.cw_worker(1)).occurrence_id is null, '1: a second pass changes nothing');
		perform pg_temp.h1_up('home-a', extensions.gen_random_uuid());
		perform pg_temp.base_assert(pg_temp.cw_due(1), '1: once the machine runs the worker is due');
		perform pg_temp.c4_drain();
		v_wake := pg_temp.cw_wake(1);
		perform pg_temp.base_assert(v_wake.status = 'queued' and v_wake.payload ->> 'harness' = 'claude-code'
			and v_wake.occurrence_key = 'worker-dispatch:' || pg_temp.cw_id(1)::text || ':1'
			and (pg_temp.c4_lease()).wake_id = v_wake.id,
			'1: and starts on Claude Code: ' || to_jsonb(v_wake)::text);
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
	begin
		perform pg_temp.cw_sleep('home-a');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(2), '2: the default dispatch');
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((pg_temp.cw_worker(2)).claude_machine_id = (pg_temp.h1_machine('home-a')).id, '2: waiting');
		w := public.qorpera_claude_worker_resolve(pg_temp.cw_id(2), pg_temp.h1_run(), pg_temp.c4_owner_id());
		perform pg_temp.base_assert(w.harness = 'claude-code' and w.claude_machine_id is null and w.claude_machine_since is null,
			'2: resolving the worker again starts its wait over: ' || to_jsonb(w)::text);
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((pg_temp.cw_worker(2)).claude_machine_since is not null, '2: waiting again');
		update public.qorpera_runtime_workers set claude_machine_since = claude_machine_since - interval '299 seconds'
		where id = pg_temp.cw_id(2);
		perform pg_temp.base_assert(not pg_temp.cw_due(2), '2: within 5 minutes it waits');
		update public.qorpera_runtime_workers set claude_machine_since = claude_machine_since - interval '2 seconds'
		where id = pg_temp.cw_id(2);
		perform pg_temp.base_assert(pg_temp.cw_due(2), '2: after 5 minutes it is due');
		perform pg_temp.c4_drain();
		w := pg_temp.cw_worker(2);
		v_wake := pg_temp.cw_wake(2);
		perform pg_temp.base_assert(w.harness is null and w.claude_login_id is null and w.claude_fallback_sequence = w.sequence
			and v_wake.occurrence_key = 'worker-dispatch:' || w.id::text || ':1:codex' and not (v_wake.payload ? 'harness'),
			'2: the machine did not run in time: the worker started on Codex at once: ' || to_jsonb(w)::text || to_jsonb(v_wake)::text);
		perform pg_temp.base_assert(pg_temp.cw_events(2, 'fell_back') -> 0 ->> 'reason' = 'no_machine'
			and pg_temp.cw_events(2, 'fell_back') -> 0 ->> 'machine' = 'limit'
			and (pg_temp.cw_events(2, 'fell_back') -> 0 ->> 'waitedMs')::bigint >= 300000
			and pg_temp.cw_events(2, 'fell_back') -> 0 ->> 'words'
				= pg_temp.c4_words('<member>''s machine for Claude Code did not start within 5 minutes'),
			'2: the record: ' || pg_temp.cw_events(2, 'fell_back')::text);
		perform pg_temp.base_assert((pg_temp.h1_machine('home-a')).desired_state = 'stopped',
			'2: the machine woken only for it, still not running, is no longer wanted');
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
	begin
		perform pg_temp.cw_sleep('home-a');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(19), '19: the default dispatch');
		perform pg_temp.c4_drain();
		update public.qorpera_company_machines set taken_by_run_id = pg_temp.h1_run() where name = 'home-a' and removed_at is null;
		update public.qorpera_runtime_workers set claude_machine_since = claude_machine_since - interval '301 seconds'
		where id = pg_temp.cw_id(19);
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((pg_temp.cw_worker(19)).harness is null and (pg_temp.h1_machine('home-a')).desired_state = 'running',
			'19: a machine a going run of the agent took meanwhile stays wanted');
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
	begin
		perform pg_temp.cw_sleep('home-a');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(3), '3: the default dispatch');
		perform pg_temp.c4_drain();
		update public.qorpera_company_machines set last_error = 'start:COMPANY_MACHINE_START_FAILED', last_error_at = clock_timestamp()
		where name = 'home-a' and removed_at is null;
		perform pg_temp.base_assert(pg_temp.cw_due(3), '3: a machine that failed to start makes the worker due at once');
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((pg_temp.cw_worker(3)).harness is null and pg_temp.cw_events(3, 'fell_back') -> 0 ->> 'machine' = 'failed'
			and not ((pg_temp.cw_wake(3)).payload ? 'harness'), '3: and it starts on Codex: ' || pg_temp.cw_events(3, 'fell_back')::text);
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
	begin
		perform pg_temp.cw_sleep('home-a');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(4), '4: the default dispatch');
		perform pg_temp.h1_switch(true, false);
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((pg_temp.cw_worker(4)).harness is null and (pg_temp.cw_worker(4)).claude_machine_id is null
			and pg_temp.cw_events(4, 'fell_back') -> 0 ->> 'machine' = 'unavailable'
			and pg_temp.cw_events(4, 'machine_woken') = '[]'::jsonb and not ((pg_temp.cw_wake(4)).payload ? 'harness'),
			'4: no machines for the company by the drain: Codex at once: ' || pg_temp.cw_events(4, 'fell_back')::text);
		perform pg_temp.base_assert((pg_temp.h1_machine('home-a')).desired_state = 'stopped', '4: and nothing was woken');
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
	begin
		perform pg_temp.cw_sleep('home-a');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(6), '6: the default dispatch');
		perform pg_temp.c4_drain();
		update public.qorpera_company_machines set desired_state = 'stopped', desired_by = 'member' where name = 'home-a'
			and removed_at is null;
		perform pg_temp.base_assert(pg_temp.cw_due(6), '6: a machine stopped while the worker waits makes it due');
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((pg_temp.cw_worker(6)).harness is null and pg_temp.cw_events(6, 'fell_back') -> 0 ->> 'machine' = 'stopped',
			'6: and it starts on Codex: ' || pg_temp.cw_events(6, 'fell_back')::text);
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
	begin
		update public.qorpera_company_machines set requested_by_user_id = (select m.user_id from public.qorpera_profile_members m
			where m.profile_id = '92400000-0000-4000-8000-000000000010' and m.user_id <> pg_temp.c4_owner_id() order by m.user_id limit 1)
		where name = 'home-a' and removed_at is null;
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(7), '7: the default dispatch');
		perform pg_temp.base_assert((pg_temp.cw_worker(7)).harness = 'claude-code', '7: the agent''s machine runs for another member');
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((pg_temp.cw_worker(7)).claude_machine_id <> (pg_temp.h1_machine('home-a')).id
			and (select requested_by_user_id from public.qorpera_company_machines where id = (pg_temp.cw_worker(7)).claude_machine_id)
				= pg_temp.c4_owner_id(), '7: another member''s machine is never woken for this member''s work');
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
	begin
		perform pg_temp.cw_sleep('home-a');
		delete from public.qorpera_claude_sign_in_members where user_id = pg_temp.c4_owner_id();
		perform pg_temp.base_assert(not public.qorpera_claude_worker_machine_wakeable('92400000-0000-4000-8000-000000000010',
			'92400000-0000-4000-8000-000000000030', pg_temp.h1_run()), '8: a member Claude Code is not open for wakes nothing');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(8), '8: the default dispatch');
		perform pg_temp.base_assert((pg_temp.cw_worker(8)).harness is null, '8: and the worker goes to Codex');
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((pg_temp.h1_machine('home-a')).desired_state = 'stopped'
			and pg_temp.cw_events(8, 'machine_woken') = '[]'::jsonb, '8: nothing was woken');
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
	begin
		perform pg_temp.cw_sleep('home-a');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(9), '9: the default dispatch');
		perform pg_temp.base_assert((pg_temp.cw_worker(9)).harness = 'claude-code', '9: on Claude Code at the dispatch');
		delete from public.qorpera_claude_sign_in_members where user_id = pg_temp.c4_owner_id();
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((pg_temp.cw_worker(9)).harness is null and pg_temp.cw_events(9, 'machine_woken') = '[]'::jsonb
			and pg_temp.cw_events(9, 'fell_back') -> 0 ->> 'machine' = 'member'
			and pg_temp.cw_events(9, 'fell_back') -> 0 ->> 'words'
				= pg_temp.c4_words('Claude Code is not open for <member> yet: dispatch this worker without Claude Code'),
			'9: Claude Code closed for the member by the drain: Codex, in the member''s words: ' || pg_temp.cw_events(9, 'fell_back')::text);
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
	begin
		perform pg_temp.cw_sleep('home-a');
		update public.qorpera_company_machines set desired_state = 'deleted' where name = 'home-a' and removed_at is null;
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(5), '5: the default dispatch');
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((pg_temp.cw_worker(5)).claude_machine_id <> (pg_temp.h1_machine('home-a')).id,
			'5: a machine being deleted is never woken');
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
end $$;

do $$
declare w public.qorpera_runtime_workers%rowtype; v_new public.qorpera_company_machines%rowtype; v_binding jsonb; v_count integer;
begin
	begin
		perform pg_temp.cw_gone('home-a');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(11), '11: the first default dispatch');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(12), '11: the second');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(13), '11: the third');
		perform pg_temp.base_assert((select count(*) from public.qorpera_runtime_workers where id in (pg_temp.cw_id(11), pg_temp.cw_id(12),
			pg_temp.cw_id(13)) and harness = 'claude-code') = 3, '11: an agent with no machine still gets Claude Code');
		perform pg_temp.c4_drain();
		select count(*) into v_count from pg_temp.cw_agent_machines();
		select * into v_new from pg_temp.cw_agent_machines() limit 1;
		perform pg_temp.base_assert(v_count = 1 and v_new.name ~ '-home$' and v_new.requested_by_user_id = pg_temp.c4_owner_id()
			and v_new.started_by_run_id is null and v_new.started_by_receipt_id is null and v_new.desired_by = 'agent'
			and v_new.desired_state = 'running' and v_new.cpus = 2 and v_new.memory_bytes = 4 * 1073741824::bigint
			and v_new.disk_bytes = 40 * 1073741824::bigint and v_new.lifetime = 'task' and v_new.notify_run_ids = '{}'
			and v_new.purpose = 'Started for Claude Code work ' || pg_temp.c4_name() || ' asked for.',
			'11: three workers dispatched at once make ONE machine for the agent and the member: '
				|| (select jsonb_agg(to_jsonb(m)) from pg_temp.cw_agent_machines() m)::text);
		perform pg_temp.base_assert((select count(*) from public.qorpera_runtime_workers where id in (pg_temp.cw_id(11),
			pg_temp.cw_id(12), pg_temp.cw_id(13)) and claude_machine_id = v_new.id and occurrence_id is null) = 3,
			'11: all three wait for it');
		perform pg_temp.base_assert((pg_temp.cw_events(11, 'machine_woken') -> 0 -> 'new') = 'true'::jsonb
			and (pg_temp.cw_events(12, 'machine_woken') -> 0 -> 'new') = 'false'::jsonb
			and (pg_temp.cw_events(13, 'machine_woken') -> 0 -> 'new') = 'false'::jsonb, '11: made once');
		perform pg_temp.h1_up(v_new.name, extensions.gen_random_uuid());
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((select count(*) from public.qorpera_runtime_workers where id in (pg_temp.cw_id(11),
			pg_temp.cw_id(12), pg_temp.cw_id(13)) and occurrence_id is not null) >= 1
			and (select count(*) from pg_temp.cw_agent_machines()) = 1, '11: once it runs they start, on the one machine');
		perform pg_temp.base_materialize();
		v_binding := pg_temp.base_start(null);
		perform pg_temp.base_assert(public.qorpera_company_home_available(v_binding) ->> 'machineId' = v_new.id::text,
			'11: the worker''s run gets that machine as its home: ' || public.qorpera_company_home_available(v_binding)::text);
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
	begin
		perform pg_temp.cw_gone('home-a');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(15), '15: the first default dispatch');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(16), '15: the second');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(17), '15: the third');
		perform pg_temp.c4_drain();
		select * into v_new from pg_temp.cw_agent_machines() limit 1;
		perform pg_temp.base_assert((select count(*) from public.qorpera_runtime_workers where claude_machine_id = v_new.id) = 3,
			'15: three wait on one machine');
		update public.qorpera_runtime_workers set claude_machine_since = claude_machine_since - interval '301 seconds'
		where id = pg_temp.cw_id(15);
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((pg_temp.cw_worker(15)).harness is null and (pg_temp.h1_machine(v_new.name)).desired_state = 'running',
			'15: the first to give up leaves the machine to the two still waiting');
		update public.qorpera_runtime_workers set claude_machine_since = claude_machine_since - interval '301 seconds'
		where id in (pg_temp.cw_id(16), pg_temp.cw_id(17));
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((pg_temp.cw_worker(16)).harness is null and (pg_temp.cw_worker(17)).harness is null
			and (pg_temp.h1_machine(v_new.name)).desired_state = 'stopped'
			and pg_temp.cw_events(16, 'fell_back') -> 0 ->> 'machine' = 'limit' and pg_temp.cw_events(17, 'fell_back') -> 0 ->> 'machine' = 'limit'
			and pg_temp.cw_events(17, 'fell_back') -> 0 ->> 'words'
				= pg_temp.c4_words('<member>''s machine for Claude Code did not start within 5 minutes'),
			'15: once none waits, the machine they made is no longer wanted: ' || to_jsonb(pg_temp.h1_machine(v_new.name))::text);
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
	begin
		perform pg_temp.cw_gone('home-a');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(18), '18: the default dispatch');
		perform pg_temp.c4_drain();
		select * into v_new from pg_temp.cw_agent_machines() limit 1;
		update public.qorpera_company_machines set notify_run_ids = array[pg_temp.h1_run()] where id = v_new.id;
		update public.qorpera_runtime_workers set claude_machine_since = claude_machine_since - interval '301 seconds'
		where id = pg_temp.cw_id(18);
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((pg_temp.cw_worker(18)).harness is null and (pg_temp.h1_machine(v_new.name)).desired_state = 'running',
			'18: a machine a run waits to hear from stays wanted');
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
	begin
		perform pg_temp.cw_gone('home-a');
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(14), '14: the default dispatch');
		perform pg_temp.c4_drain();
		select * into v_new from pg_temp.cw_agent_machines() limit 1;
		update public.qorpera_runtime_workers set claude_machine_since = claude_machine_since - interval '301 seconds'
		where id = pg_temp.cw_id(14);
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((pg_temp.cw_worker(14)).harness is null
			and (pg_temp.h1_machine(v_new.name)).desired_state = 'stopped',
			'14: the worker went to Codex and the machine woken only for it is no longer wanted: '
				|| to_jsonb(pg_temp.h1_machine(v_new.name))::text);
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
end $$;

do $$
declare w public.qorpera_runtime_workers%rowtype; v_new public.qorpera_company_machines%rowtype; v_brief jsonb;
begin
	begin
		insert into public.qorpera_home_outdated_images(image_fingerprint) values (repeat('a', 64));
		perform public.qorpera_configure_machine_executor('mx-1246', repeat('c', 64), true,
			(select executor.policy || jsonb_build_object('imageFingerprint', repeat('d', 64)) from public.qorpera_machine_executors executor
				where executor.owner = 'mx-1246'), 322122547200);
		perform pg_temp.base_assert(public.qorpera_company_machine_state(pg_temp.h1_machine('home-a')) = 'running',
			'21: home-a runs, made from an image without the home');
		v_brief := pg_temp.c4_brief(pg_temp.cw_id(21));
		perform pg_temp.c4_refused(pg_temp.c4_dispatch(pg_temp.c4_alice(), 'wake-machine-21',
			'QorperaOS/agents/alice/todos/onboarding/wake-21', v_brief), v_brief, pg_temp.cw_no_home_words());
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(22), '21: the default dispatch');
		perform pg_temp.base_assert((pg_temp.cw_worker(22)).harness = 'claude-code', '21: the default goes to Claude Code');
		perform pg_temp.c4_drain();
		select * into v_new from pg_temp.cw_agent_machines() where name <> 'home-a' limit 1;
		perform pg_temp.base_assert(v_new.id is not null and (pg_temp.cw_worker(22)).claude_machine_id = v_new.id,
			'21: a new machine is started instead of the outdated one: ' || to_jsonb(pg_temp.cw_worker(22))::text);
		perform pg_temp.h1_up(v_new.name, extensions.gen_random_uuid());
		update public.qorpera_company_machines set last_used_at = clock_timestamp() + interval '1 hour' where name = 'home-a';
		perform pg_temp.base_assert(pg_temp.h1_home() ->> 'machineId' = v_new.id::text,
			'21: the home offered is the new machine, not the outdated one used later: ' || pg_temp.h1_home()::text);
		delete from public.qorpera_home_outdated_images where image_fingerprint = repeat('a', 64);
		perform pg_temp.base_assert(pg_temp.h1_home() ->> 'machine' = 'home-a', '21: without the mark the latest used is offered');
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
end $$;

do $$
declare v_binding jsonb; v_session uuid := extensions.gen_random_uuid(); v jsonb;
begin
	begin
		perform pg_temp.cw_saved(pg_temp.cw_dispatch(31), '31: the default dispatch while the machine runs');
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert((pg_temp.cw_worker(31)).occurrence_id is not null and (pg_temp.cw_worker(31)).claude_machine_id is null
			and pg_temp.cw_events(31, 'machine_woken') = '[]'::jsonb, '31: a running machine is not woken: the worker starts');
		perform pg_temp.base_materialize();
		v_binding := pg_temp.base_start(null);
		perform pg_temp.base_assert(pg_temp.h1_authorize('home-a', extensions.gen_random_uuid()) ->> 'state' = 'authorized',
			'31: the agent''s own run has a session on its machine');
		update public.qorpera_company_machines set last_used_at = clock_timestamp() - interval '2 hours' where name = 'home-a';
		perform pg_temp.base_assert((pg_temp.cw_listed('home-a') -> 'sleepDue')::boolean,
			'31: an hour without use: due to sleep, whatever run of the agent''s has a session: ' || pg_temp.cw_listed('home-a')::text);
		v := pg_temp.h1_authorize('home-a', v_session, v_binding);
		perform pg_temp.base_assert(v ->> 'state' = 'authorized', '31: the Claude Code run has its session: ' || v::text);
		update public.qorpera_company_machines set last_used_at = clock_timestamp() - interval '2 hours' where name = 'home-a';
		perform pg_temp.base_assert(not (pg_temp.cw_listed('home-a') -> 'sleepDue')::boolean,
			'31: while the Claude Code run goes, its machine is at work: ' || pg_temp.cw_listed('home-a')::text);
		perform pg_temp.base_assert(pg_temp.cw_stop('home-a') ->> 'reason' = 'MACHINE_IN_USE',
			'31: and the stop is refused: ' || pg_temp.cw_stop('home-a')::text);
		perform pg_temp.c4_end_job((v_binding ->> 'runId')::uuid, 'completed');
		perform pg_temp.base_assert((pg_temp.cw_listed('home-a') -> 'sleepDue')::boolean,
			'31: once the run ended it keeps nothing awake, its session still open: ' || pg_temp.cw_listed('home-a')::text);
		v := pg_temp.cw_stop('home-a');
		perform pg_temp.base_assert(v ->> 'intent' = 'stop' and (pg_temp.h1_machine('home-a')).desired_state = 'stopped',
			'31: and it sleeps: ' || v::text);
		raise exception 'cw-undo';
	exception when raise_exception then if sqlerrm <> 'cw-undo' then raise; end if;
	end;
end $$;

do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_function in array array[
			'public.qorpera_company_machine_home_outdated(public.qorpera_company_machines)',
			'public.qorpera_claude_worker_member_problem(uuid,uuid)',
			'public.qorpera_claude_worker_problem(uuid,uuid,uuid)',
			'public.qorpera_claude_worker_machine_wakeable(uuid,uuid,uuid)',
			'public.qorpera_claude_worker_machine_for(public.qorpera_runtime_workers)',
			'public.qorpera_claude_worker_machine_outcome(public.qorpera_runtime_workers)',
			'public.qorpera_claude_worker_machine_waits(public.qorpera_runtime_workers)',
			'public.qorpera_claude_worker_machine_fall_back(public.qorpera_runtime_workers,text,text)',
			'public.qorpera_claude_worker_machine_name(uuid,uuid)',
			'public.qorpera_claude_worker_machine_wait(public.qorpera_runtime_workers)',
			'public.qorpera_company_machine_claude_at_work(public.qorpera_company_machines,public.qorpera_company_machine_placements)'] loop
			if has_function_privilege(v_role, v_function, 'execute') then raise exception '41: % may call %', v_role, v_function; end if;
		end loop;
		if has_table_privilege(v_role, 'public.qorpera_home_outdated_images', 'select') then
			raise exception '41: % may read the outdated images', v_role; end if;
	end loop;
	perform pg_temp.base_assert((select count(*) from public.qorpera_home_outdated_images) = 5
		and exists (select 1 from public.qorpera_home_outdated_images where image_fingerprint like '9721cd75%')
		and not exists (select 1 from public.qorpera_home_outdated_images where image_fingerprint like '93ef50b7%'),
		'41: the five images before 93ef50b7 are the ones without the home');
end $$;
