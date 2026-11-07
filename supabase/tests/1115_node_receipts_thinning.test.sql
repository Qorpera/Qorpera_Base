begin;
-- 20260930615100: node reports older than two days keep one in about 30 seconds and every report that differs, and
-- qorpera_runtime_computer_history answers the same. Each report is looked at once, from a cursor; a node's latest is
-- never removed; the computer-hour meter's position holds the cut back; no API role reaches any of it.
create function pg_temp.ok(p_value boolean, p_message text) returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%', p_message; end if; end $$;
create function pg_temp.run(p_row_limit integer default 6000) returns jsonb language sql as $$
	select public.qorpera_run_runtime_node_receipt_thinning(p_row_limit) $$;
-- Runs until the cut, with a row limit that stops a run often.
create function pg_temp.run_all() returns jsonb language plpgsql as $$
declare v_result jsonb; v_observations bigint := 0; v_inventories bigint := 0;
begin
	for i in 1..40 loop
		v_result := pg_temp.run(30);
		v_observations := v_observations + (v_result ->> 'observations')::bigint;
		v_inventories := v_inventories + (v_result ->> 'inventories')::bigint;
		if v_result ->> 'stopped' in ('done', 'held_by_meter') then
			return v_result || jsonb_build_object('observations', v_observations, 'inventories', v_inventories, 'runs', i);
		end if;
		perform pg_temp.ok(v_result ->> 'stopped' = 'row_limit', 'A run stopped on ' || v_result::text);
	end loop;
	raise exception 'Thinning did not reach the cut';
end $$;
create function pg_temp.id(p_node uuid, p_key text) returns uuid language sql as $$ select md5(p_node || ':' || p_key)::uuid $$;
create function pg_temp.entry(p_state text) returns jsonb language sql as $$
	select jsonb_build_object('project', 'machines', 'name', 'machine-a', 'type', 'virtual-machine', 'state', p_state,
		'physicalId', '11150000-0000-4000-8000-0000000000f1', 'configurationSha256', repeat('e', 64), 'cpuMillis', 4000,
		'memoryBytes', 8589934592, 'allocation', jsonb_build_object('allocationId', '11150000-0000-4000-8000-0000000000a1'),
		'category', 'managed', 'reason', null) $$;
-- A report, as the observer files it: no inventory when p_state is null (a failed scan). p_node_state is the node's own
-- state: 'unavailable' can come with a complete inventory, which then says the same as the report before.
create function pg_temp.report(p_node uuid, p_key text, p_at timestamptz, p_state text, p_node_state text default 'ready') returns uuid language plpgsql as $$
declare v_id uuid := pg_temp.id(p_node, p_key);
begin
	insert into public.qorpera_runtime_node_observation_receipts(node_id, observation_id, observed_at, observation)
	values (p_node, v_id, p_at, jsonb_build_object('schema', 'qorpera.runtime-node-observation/v1', 'nodeId', p_node,
		'machineIdSha256', repeat('a', 64), 'observationId', v_id, 'observedAt', p_at, 'cpuMillis', 32000, 'memoryBytes', 68719476736,
		'state', case when p_state is null then 'unavailable' else p_node_state end));
	if p_state is not null then
		insert into public.qorpera_runtime_node_inventory_receipts(node_id, observation_id, node_version, policy_sha256,
			context_sha256, inventory)
		values (p_node, v_id, 1, repeat('b', 64), repeat('c', 64), jsonb_build_object('schema', 'qorpera.runtime-node-inventory/v1',
			'bootId', '11150000-0000-4000-8000-0000000000b0', 'entries', jsonb_build_array(pg_temp.entry(p_state))));
	end if;
	return v_id;
end $$;
create function pg_temp.has(p_node uuid, p_key text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_runtime_node_observation_receipts
		where node_id = p_node and observation_id = pg_temp.id(p_node, p_key)) $$;
create function pg_temp.reports(p_node uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_runtime_node_observation_receipts where node_id = p_node $$;
create function pg_temp.inventories(p_node uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_runtime_node_inventory_receipts where node_id = p_node $$;

-- No API role runs, thins, schedules or reads the status; the cron job runs as its owner.
select pg_temp.ok(not has_function_privilege(role_name, signature, 'EXECUTE'), signature || ' is executable by ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker']) role_name
cross join unnest(array['public.qorpera_thin_runtime_node_receipts(timestamptz,timestamptz)',
	'public.qorpera_run_runtime_node_receipt_thinning(integer)', 'public.qorpera_schedule_runtime_node_receipt_thinning()']) signature;
select pg_temp.ok((select prosecdef and proconfig = array['search_path=""', 'lock_timeout=1s'] from pg_proc
		where oid = signature::regprocedure), signature || ' is not security definer with an empty search path and a 1 s lock limit')
from unnest(array['public.qorpera_thin_runtime_node_receipts(timestamptz,timestamptz)',
	'public.qorpera_run_runtime_node_receipt_thinning(integer)']) signature;
select pg_temp.ok((select relrowsecurity from pg_class where oid = 'public.qorpera_runtime_node_receipt_thinning_status'::regclass),
	'The thinning status has no row security');
select pg_temp.ok(not has_table_privilege(role_name, 'public.qorpera_runtime_node_receipt_thinning_status', privilege),
	'The thinning status allows ' || privilege || ' to ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker']) role_name
cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) privilege;
select pg_temp.ok((select count(*) = 1 and bool_and(ran_at is null and thinned_until is null) from public.qorpera_runtime_node_receipt_thinning_status),
	'The thinning status is not one empty row before the first run');

-- Another session holds the retention's lock: this run does nothing, and says so. Another holds the meter's table,
-- which a run reads first: it gives up after a second and the cursor stays. Both before this session writes anything.
do $$
declare v_result jsonb; v_started timestamptz; v_waited interval;
begin
	perform dblink_connect('thin_peer', 'dbname=' || current_database());
	perform dblink_exec('thin_peer', 'begin');
	perform * from dblink('thin_peer', $q$select pg_advisory_xact_lock(hashtextextended('qorpera.runtime-node-receipt-retention', 0))::text$q$) as t(v text);
	v_result := pg_temp.run();
	perform dblink_exec('thin_peer', 'rollback');
	perform pg_temp.ok(v_result ->> 'stopped' = 'busy' and v_result ->> 'slices' = '0', 'Thinning ran beside the retention: ' || v_result::text);
	perform pg_temp.ok((select stopped = 'busy' and thinned_until is null from public.qorpera_runtime_node_receipt_thinning_status), 'A busy run was not recorded');
	perform dblink_exec('thin_peer', 'begin');
	perform dblink_exec('thin_peer', 'lock table public.qorpera_computer_hour_meter in access exclusive mode');
	v_started := clock_timestamp();
	v_result := pg_temp.run();
	v_waited := clock_timestamp() - v_started;
	perform dblink_exec('thin_peer', 'rollback');
	perform dblink_disconnect('thin_peer');
	perform pg_temp.ok(v_result ->> 'stopped' = 'lock_timeout' and v_result ->> 'slices' = '0', 'A lock timeout did not end the run: ' || v_result::text);
	perform pg_temp.ok(v_waited between interval '0.9 seconds' and interval '3 seconds', 'The run waited ' || v_waited || ' for a lock');
	perform pg_temp.ok((select stopped = 'lock_timeout' and thinned_until is null and slices = 0 from public.qorpera_runtime_node_receipt_thinning_status),
		'A lock-timed-out run was not recorded');
end
$$;

-- Fixture, at the transaction's time (the run's now()). The meter is current for now; node A reports every five seconds
-- from three days ago, across an hour's slice boundary (the cursor starts seven days back, so at three days and no
-- minutes): running, stopped from 235 s, one failed scan, stopped, a silence of 100 seconds, stopped with one report at
-- 595 s where the node says unavailable and its inventory is unchanged. Then recent reports and a latest. Every change
-- falls between the 30-second marks, so only the comparison can keep it.
select set_config('qorpera_test.t0', (now() - interval '3 days' - interval '5 minutes')::text, true);
create function pg_temp.at(p_seconds integer) returns timestamptz language sql as $$
	select current_setting('qorpera_test.t0')::timestamptz + p_seconds * interval '1 second' $$;
update public.qorpera_computer_hour_meter set metered_until = now();
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes,
	headroom_cpu_millis, headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
select id, repeat(digit, 64), 'thinning-' || digit, 1, 32000, 68719476736, 4000, 4294967296, 4000, 8589934592, true
from (values ('11150000-0000-4000-8000-00000000000a'::uuid, 'a'), ('11150000-0000-4000-8000-00000000000b'::uuid, 'b')) node(id, digit);
select pg_temp.report('11150000-0000-4000-8000-00000000000a', 'r' || n, pg_temp.at(n * 5),
	case when n < 47 then 'running' when n = 72 then null else 'suspended' end)
from generate_series(0, 89) n;
select pg_temp.report('11150000-0000-4000-8000-00000000000a', 'r' || n, pg_temp.at(n * 5 + 95), 'suspended',
	case when n = 100 then 'unavailable' else 'ready' end)
from generate_series(90, 119) n;
select pg_temp.report('11150000-0000-4000-8000-00000000000a', 'recent' || n, now() - interval '47 hours' + n * interval '5 seconds', 'suspended')
from generate_series(0, 9) n;
-- While running, the rest of the receipt changes with the inventory the same, and stays changed: its context at 75 s, the
-- node's version at 140 s, its policy at 195 s. So the change at 235 s is in the inventory alone.
update public.qorpera_runtime_node_inventory_receipts set context_sha256 = repeat('d', 64)
where node_id = '11150000-0000-4000-8000-00000000000a'
	and observation_id in (select pg_temp.id(node_id, 'r' || n) from generate_series(15, 119) n);
update public.qorpera_runtime_node_inventory_receipts set node_version = 2
where node_id = '11150000-0000-4000-8000-00000000000a'
	and observation_id in (select pg_temp.id(node_id, 'r' || n) from generate_series(28, 119) n);
update public.qorpera_runtime_node_inventory_receipts set policy_sha256 = repeat('e', 64)
where node_id = '11150000-0000-4000-8000-00000000000a'
	and observation_id in (select pg_temp.id(node_id, 'r' || n) from generate_series(39, 119) n);
select pg_temp.report('11150000-0000-4000-8000-00000000000a', 'latest', now() - interval '5 seconds', 'suspended');
insert into public.qorpera_runtime_node_observations(node_id, observation_id, observed_at, observation)
select node_id, observation_id, observed_at, observation from public.qorpera_runtime_node_observation_receipts
where node_id = '11150000-0000-4000-8000-00000000000a' and observation_id = pg_temp.id(node_id, 'latest');
-- Node B went silent three days ago. Its latest row names r5, at 25 s, in the middle of a run of equal reports with more
-- after it, so only the guard on a node's latest keeps it: the 30-second rule alone would remove it.
select pg_temp.report('11150000-0000-4000-8000-00000000000b', 'r' || n, pg_temp.at(n * 5), 'running') from generate_series(0, 11) n;
insert into public.qorpera_runtime_node_observations(node_id, observation_id, observed_at, observation)
select node_id, observation_id, observed_at, observation from public.qorpera_runtime_node_observation_receipts
where node_id = '11150000-0000-4000-8000-00000000000b' and observation_id = pg_temp.id(node_id, 'r5');

-- The machine node A reports, for the history. Foreign keys and triggers off for these rows only: the company behind
-- the allocation plays no part here.
set local session_replication_role = replica;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, coding_worker_id, provider_adapter, instance_sha256)
values ('11150000-0000-4000-8000-0000000000a1', '11150000-0000-4000-8000-0000000000c1', '11150000-0000-4000-8000-0000000000c2', 'coding', repeat('d', 64));
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis, memory_bytes, requested_at, reserved_at)
values ('11150000-0000-4000-8000-0000000000a1', '11150000-0000-4000-8000-00000000000a', 'coding', 'thinning', repeat('f', 64), 4000, 8589934592,
	pg_temp.at(-3600), pg_temp.at(-3600));
insert into public.qorpera_runtime_node_instance_bindings(allocation_id, node_id, physical_id, binding)
values ('11150000-0000-4000-8000-0000000000a1', '11150000-0000-4000-8000-00000000000a', '11150000-0000-4000-8000-0000000000f1',
	jsonb_build_object('project', 'machines', 'name', 'machine-a', 'physicalId', '11150000-0000-4000-8000-0000000000f1', 'configurationSha256', repeat('e', 64)));
set local session_replication_role = origin;
create function pg_temp.history() returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_result := public.qorpera_runtime_computer_history('11150000-0000-4000-8000-0000000000a1', pg_temp.at(-120), pg_temp.at(900));
	perform set_config('request.jwt.claims', '', true);
	return jsonb_build_object('usage', v_result -> 'usage', 'intervals',
		(select jsonb_agg(i - array['firstObservationId', 'lastObservationId'] order by i ->> 'from') from jsonb_array_elements(v_result -> 'intervals') i));
end $$;
select set_config('qorpera_test.history', pg_temp.history()::text, true);
select pg_temp.ok((current_setting('qorpera_test.history')::jsonb -> 'usage' ->> 'estimatedRunningComputerHours')::numeric > 0
	and (current_setting('qorpera_test.history')::jsonb -> 'usage' ->> 'estimatedSuspendedComputerHours')::numeric > 0
	and current_setting('qorpera_test.history')::jsonb -> 'intervals' @> '[{"reason":"NODE_UNAVAILABLE"},{"reason":"OBSERVATION_STALE"}]',
	'The history before thinning does not show every kind of stretch: ' || current_setting('qorpera_test.history'));

-- The meter holds the cut back: metered until four days ago, the cut is five days ago, and nothing newer is looked at.
update public.qorpera_computer_hour_meter set metered_until = now() - interval '4 days';
select pg_temp.ok((v ->> 'stopped' = 'held_by_meter' and v ->> 'observations' = '0' and (v ->> 'thinnedUntil')::timestamptz = now() - interval '5 days'),
	'The meter did not hold the cut, or the run did not say so: ' || v::text) from pg_temp.run_all() v;
select pg_temp.ok((select stopped = 'held_by_meter' and thinned_until = now() - interval '5 days' from public.qorpera_runtime_node_receipt_thinning_status),
	'A run held by the meter was not recorded as held');
select pg_temp.ok(pg_temp.reports('11150000-0000-4000-8000-00000000000a') = 131, 'Thinning passed the meter');
update public.qorpera_computer_hour_meter set metered_until = now();

-- A run stops once it has removed its limit, and the next carries on from its cursor. The whole hour of slices holding
-- the reports' first stretch goes in one step; the cursor is on the slice boundary, seven days back plus whole hours.
select set_config('qorpera_test.first', pg_temp.run(50)::text, true);
select pg_temp.ok(current_setting('qorpera_test.first')::jsonb ->> 'stopped' = 'row_limit'
	and (current_setting('qorpera_test.first')::jsonb ->> 'observations')::integer >= 50
	and (current_setting('qorpera_test.first')::jsonb ->> 'thinnedUntil')::timestamptz < now() - interval '48 hours',
	'A run did not stop at its row limit: ' || current_setting('qorpera_test.first'));
select pg_temp.ok((select stopped = 'row_limit' and observations = (current_setting('qorpera_test.first')::jsonb ->> 'observations')::bigint
		and thinned_until = (current_setting('qorpera_test.first')::jsonb ->> 'thinnedUntil')::timestamptz
	from public.qorpera_runtime_node_receipt_thinning_status), 'A run''s cursor was not recorded');

-- Thinned: the first of each stretch of equal reports stays, and then one each 30 seconds or so. By report number, in
-- steps of 5 s until the silence:
-- running: 0, 6, 12, 15 (context), 21, 27, 28 (version), 34, 39 (policy), 45. stopped from 235 s: 47, 53, 59, 65, 71.
-- The failed scan: 72. stopped: 73, 79, 85 and 89, the last before the silence. stopped from 545 s: 90, 96, 100 where the
-- node says unavailable, 101 where it is ready again, 107, 113 and 119, the last before nothing. That is 27 of 120.
-- The ten recent ones and the latest are too new.
select set_config('qorpera_test.result', pg_temp.run_all()::text, true);
select pg_temp.ok(pg_temp.has('11150000-0000-4000-8000-00000000000a', 'r' || n)
		= (n = any(array[0, 6, 12, 15, 21, 27, 28, 34, 39, 45, 47, 53, 59, 65, 71, 72, 73, 79, 85, 89, 90, 96, 100, 101, 107, 113, 119])),
	'Report ' || n || ' should ' || case when n = any(array[0, 6, 12, 15, 21, 27, 28, 34, 39, 45, 47, 53, 59, 65, 71, 72, 73, 79, 85, 89, 90, 96, 100, 101, 107, 113, 119])
		then 'have stayed' else 'be gone' end)
from generate_series(0, 119) n;
select pg_temp.ok(pg_temp.reports('11150000-0000-4000-8000-00000000000a') = 27 + 10 + 1,
	'Node A has ' || pg_temp.reports('11150000-0000-4000-8000-00000000000a') || ' reports');
select pg_temp.ok(pg_temp.has('11150000-0000-4000-8000-00000000000a', 'recent' || n), 'A report newer than two days is gone')
from generate_series(0, 9) n;
select pg_temp.ok(pg_temp.has('11150000-0000-4000-8000-00000000000a', 'latest'), 'Node A''s latest is gone');
-- Each report's inventory went with it; the failed scan never had one.
select pg_temp.ok(pg_temp.inventories('11150000-0000-4000-8000-00000000000a') = 27 + 10 + 1 - 1, 'Inventory rows do not match the reports');
-- Node B: 0, its latest at 25 s, and 55 s, the last before nothing. Without the guard 30 s would stay instead of 25 s.
select pg_temp.ok(pg_temp.reports('11150000-0000-4000-8000-00000000000b') = 3, 'Node B has ' || pg_temp.reports('11150000-0000-4000-8000-00000000000b') || ' reports');
select pg_temp.ok(pg_temp.has('11150000-0000-4000-8000-00000000000b', 'r5'), 'Node B''s latest is gone');
select pg_temp.ok(not pg_temp.has('11150000-0000-4000-8000-00000000000b', 'r6'), 'Node B''s report after its latest is still there');
select pg_temp.ok((current_setting('qorpera_test.result')::jsonb ->> 'observations')::integer
		+ (current_setting('qorpera_test.first')::jsonb ->> 'observations')::integer = 93 + 9
	and (current_setting('qorpera_test.result')::jsonb ->> 'inventories')::integer
		+ (current_setting('qorpera_test.first')::jsonb ->> 'inventories')::integer = 93 + 9, 'The runs counted ' || current_setting('qorpera_test.result'));

-- The history answers the same, to the second. Only which report ids open and close a stretch may differ.
select pg_temp.ok(pg_temp.history() = current_setting('qorpera_test.history')::jsonb,
	E'The history changed.\nBefore: ' || current_setting('qorpera_test.history') || E'\nAfter: ' || pg_temp.history()::text);

-- Each report is looked at once: nothing is left to do.
select pg_temp.ok((v ->> 'stopped' = 'done' and v ->> 'observations' = '0' and v ->> 'slices' = '0'), 'A second pass had work: ' || v::text) from pg_temp.run() v;
select pg_temp.ok(pg_temp.reports('11150000-0000-4000-8000-00000000000a') = 38, 'A second pass removed reports');

-- pg_cron is not part of the test database. A stand-in with pg_cron's schedule-by-name contract shows the helper
-- schedules one job, idempotently, hourly at minute 32, whose command runs as its owner.
do $$
declare v_first jsonb; v_second jsonb; v_command text;
begin
	if to_regnamespace('cron') is null then
		perform pg_temp.ok(public.qorpera_schedule_runtime_node_receipt_thinning() =
			'{"schema":"qorpera.runtime-node-receipt-thinning-schedule/v1","scheduled":false}'::jsonb, 'Thinning claimed a schedule without pg_cron');
		create schema cron;
		create table cron.job(jobid bigint generated always as identity primary key, schedule text not null,
			command text not null, jobname text not null, username text not null default current_user,
			unique (jobname, username));
		create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $f$
			insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_command)
			on conflict (jobname, username) do update set schedule = excluded.schedule, command = excluded.command
			returning jobid
		$f$;
	end if;
	v_first := public.qorpera_schedule_runtime_node_receipt_thinning();
	v_second := public.qorpera_schedule_runtime_node_receipt_thinning();
	perform pg_temp.ok(v_first ->> 'scheduled' = 'true' and v_second -> 'jobId' = v_first -> 'jobId'
		and (select count(*) from cron.job where jobname = 'qorpera-runtime-node-receipts-thinning') = 1
		and (select schedule from cron.job where jobname = 'qorpera-runtime-node-receipts-thinning') = '32 * * * *',
		'Node receipt thinning is not scheduled exactly once, hourly at minute 32');
	select command into v_command from cron.job where jobname = 'qorpera-runtime-node-receipts-thinning';
	perform pg_temp.ok(v_command = 'select public.qorpera_run_runtime_node_receipt_thinning()', 'Scheduled thinning runs another command: ' || v_command);
	execute v_command;
end
$$;
rollback;
