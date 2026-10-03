begin;
-- Node receipt retention (20260930004000): per node, the receipt its latest row names and the last seven
-- days are kept, oldest first deleted, each receipt with its inventory row, in calls of at most 500; the
-- computer-hour meter's position holds the cut back; a node whose latest report has no inventory keeps
-- everything; pg_cron runs it every five minutes; no API role reaches it.
create function pg_temp.ok(p_value boolean, p_message text) returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%', p_message; end if; end $$;
create function pg_temp.claims(p_role text) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', p_role)::text, true)::text::void $$;
create function pg_temp.purge(p_limit integer) returns jsonb language sql as $$
	select public.qorpera_purge_runtime_node_receipts(p_limit) $$;
create function pg_temp.run() returns jsonb language sql as $$
	select public.qorpera_run_runtime_node_receipt_retention() $$;
create function pg_temp.receipts(p_node uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_runtime_node_observation_receipts where node_id = p_node $$;
create function pg_temp.inventories(p_node uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_runtime_node_inventory_receipts where node_id = p_node $$;
-- Receipts: the n-th of a series, observed at p_at, with an inventory row when p_inventory.
create function pg_temp.receipt(p_node uuid, p_key text, p_at timestamptz, p_inventory boolean) returns uuid
language plpgsql as $$
declare v_id uuid := md5(p_node || ':' || p_key)::uuid;
begin
	insert into public.qorpera_runtime_node_observation_receipts(node_id, observation_id, observed_at, observation)
	values (p_node, v_id, p_at, jsonb_build_object('observationId', v_id, 'state', 'ready'));
	if p_inventory then
		insert into public.qorpera_runtime_node_inventory_receipts(node_id, observation_id, node_version, policy_sha256,
			context_sha256, inventory)
		values (p_node, v_id, 1, repeat('b', 64), repeat('c', 64), '{"schema":"qorpera.runtime-node-inventory/v1","entries":[]}');
	end if;
	return v_id;
end $$;
create function pg_temp.latest(p_node uuid, p_id uuid) returns void language sql as $$
	insert into public.qorpera_runtime_node_observations(node_id, observation_id, observed_at, observation)
	select node_id, observation_id, observed_at, observation from public.qorpera_runtime_node_observation_receipts
	where node_id = p_node and observation_id = p_id $$;

-- No API role runs, purges or schedules; the cron job runs as its owner.
select pg_temp.ok(not has_function_privilege(role_name, signature, 'EXECUTE'),
	signature || ' is executable by ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker']) role_name
cross join unnest(array['public.qorpera_purge_runtime_node_receipts(integer)',
	'public.qorpera_run_runtime_node_receipt_retention()',
	'public.qorpera_schedule_runtime_node_receipt_retention()']) signature;
select pg_temp.ok((select prosecdef and proconfig = array['search_path=""'] from pg_proc
		where oid = signature::regprocedure), signature || ' is not security definer with an empty search path')
from unnest(array['public.qorpera_purge_runtime_node_receipts(integer)',
	'public.qorpera_run_runtime_node_receipt_retention()']) signature;
select pg_temp.ok(not (select prosecdef from pg_proc where oid = 'public.qorpera_schedule_runtime_node_receipt_retention()'::regprocedure),
	'The scheduling helper runs as its caller');

-- What the purge may delete: the inventory row's foreign key is the only one into either table, and
-- neither table has triggers. A new reference must revisit the retention before it can fail it.
select pg_temp.ok((select array_agg(conrelid::regclass::text || ' -> ' || confrelid::regclass::text order by conname)
		from pg_constraint where contype = 'f' and confrelid in ('public.qorpera_runtime_node_observation_receipts'::regclass,
			'public.qorpera_runtime_node_inventory_receipts'::regclass))
	= array['qorpera_runtime_node_inventory_receipts -> qorpera_runtime_node_observation_receipts'],
	'A foreign key other than the inventory row''s points into the node receipts');
select pg_temp.ok(not exists (select 1 from pg_trigger where not tgisinternal
		and tgrelid in ('public.qorpera_runtime_node_observation_receipts'::regclass,
			'public.qorpera_runtime_node_inventory_receipts'::regclass)),
	'A trigger on the node receipts would see retention deletes');

-- A lock it cannot get within a second ends the run (55P03, caught), with nothing deleted. Another
-- session holds the meter row's table, which the purge reads first.
do $$
declare v_started timestamptz; v_waited interval; v_result jsonb;
begin
	perform dblink_connect('meter_holder', 'dbname=' || current_database());
	perform dblink_exec('meter_holder', 'begin');
	perform dblink_exec('meter_holder', 'lock table public.qorpera_computer_hour_meter in access exclusive mode');
	v_started := clock_timestamp();
	v_result := pg_temp.run();
	v_waited := clock_timestamp() - v_started;
	perform dblink_exec('meter_holder', 'rollback');
	perform dblink_disconnect('meter_holder');
	if v_result ->> 'stopped' <> 'lock_timeout' or v_result ->> 'calls' <> '0' or v_result ->> 'observations' <> '0' then
		raise exception 'A lock timeout did not end the run cleanly: %', v_result; end if;
	if v_waited < interval '0.9 seconds' or v_waited > interval '3 seconds' then
		raise exception 'The purge waited % for a lock, not about a second', v_waited; end if;
end
$$;

-- Fixture, at the transaction's time (the purge's now()). The meter is current.
update public.qorpera_computer_hour_meter set metered_until = now();
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes,
	headroom_cpu_millis, headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
select id, repeat(digit, 64), 'retention-' || digit, 1, 32000, 68719476736, 4000, 4294967296, 4000, 8589934592, true
from (values ('85100000-0000-4000-8000-00000000000a'::uuid, 'a'), ('85100000-0000-4000-8000-00000000000b'::uuid, 'b'),
	('85100000-0000-4000-8000-00000000000c'::uuid, 'c')) node(id, digit);
-- Node A reports: 12,000 between 8 and 16.3 days old (old-n is 8 days and n minutes old; every even one
-- has inventory), 20 in the last day, and its latest, 5 s ago.
select pg_temp.receipt('85100000-0000-4000-8000-00000000000a', 'old-' || n, now() - interval '8 days' - n * interval '1 minute', n % 2 = 0)
from generate_series(1, 12000) n;
select pg_temp.receipt('85100000-0000-4000-8000-00000000000a', 'recent-' || n, now() - n * interval '1 hour', true)
from generate_series(1, 20) n;
select pg_temp.latest('85100000-0000-4000-8000-00000000000a',
	pg_temp.receipt('85100000-0000-4000-8000-00000000000a', 'latest', now() - interval '5 seconds', true));
-- Node B went silent nine days ago: its latest is older than seven days.
select pg_temp.receipt('85100000-0000-4000-8000-00000000000b', 'd' || days, now() - days * interval '1 day', true)
from unnest(array[13, 12, 10]) days;
select pg_temp.latest('85100000-0000-4000-8000-00000000000b',
	pg_temp.receipt('85100000-0000-4000-8000-00000000000b', 'd9', now() - interval '9 days', true));
-- Node C's latest scan failed (no inventory): its old inventory must stay, so nothing of it goes.
select pg_temp.receipt('85100000-0000-4000-8000-00000000000c', 'old-' || n, now() - interval '10 days' - n * interval '1 minute', n % 2 = 0)
from generate_series(1, 10) n;
select pg_temp.latest('85100000-0000-4000-8000-00000000000c',
	pg_temp.receipt('85100000-0000-4000-8000-00000000000c', 'latest', now() - interval '5 seconds', false));

-- One call deletes at most its limit, 1 to 500, oldest first, each receipt with its inventory row.
do $$
declare v_limit integer; v_result jsonb;
begin
	foreach v_limit in array array[0, 501, -1] loop
		begin
			perform pg_temp.purge(v_limit);
			raise exception 'Retention limit % accepted', v_limit using errcode = 'QTB01';
		exception when sqlstate '22023' then null; end;
	end loop;
	begin
		perform pg_temp.purge(null);
		raise exception 'A null retention limit accepted' using errcode = 'QTB01';
	exception when sqlstate '22023' then null; end;
	-- The 7 oldest of node A: old-12000 down to old-11994, of which 4 have inventory.
	v_result := pg_temp.purge(7);
	if v_result - 'cutoff' <> jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention/v1', 'busy', false,
			'observations', 7, 'inventories', 4, 'moreEligible', true, 'heldByMeter', false,
			'nodesWithoutLatestInventory', 0, 'retentionDays', 7)
		or (v_result ->> 'cutoff')::timestamptz <> now() - interval '7 days' then
		raise exception 'The first call differs: %', v_result; end if;
	if exists (select 1 from public.qorpera_runtime_node_observation_receipts
			where node_id = '85100000-0000-4000-8000-00000000000a' and observed_at <= now() - interval '8 days' - 11994 * interval '1 minute')
		or not exists (select 1 from public.qorpera_runtime_node_observation_receipts
			where observation_id = md5('85100000-0000-4000-8000-00000000000a:old-11993')::uuid)
		or pg_temp.receipts('85100000-0000-4000-8000-00000000000a') <> 12021 - 7
		or pg_temp.inventories('85100000-0000-4000-8000-00000000000a') <> 6021 - 4 then
		raise exception 'The first call did not delete exactly the seven oldest receipts'; end if;
	-- The body sets the lock wait for its transaction.
	if current_setting('lock_timeout') <> '1s' then
		raise exception 'The purge does not limit lock waits: %', current_setting('lock_timeout'); end if;
	v_result := pg_temp.purge(500);
	if v_result ->> 'observations' <> '500' or v_result ->> 'inventories' <> '250' or v_result -> 'moreEligible' <> 'true'::jsonb
		or pg_temp.receipts('85100000-0000-4000-8000-00000000000a') <> 12021 - 507 then
		raise exception 'A full call differs: %', v_result; end if;
end
$$;

-- The meter's position holds the cut back: with metered_until ten days ago, nothing younger than eleven
-- days goes. Node A has 7,173 receipts older than that (old-4321 to old-11493), node B two.
update public.qorpera_computer_hour_meter set metered_until = now() - interval '10 days';
do $$
declare v_result jsonb; v_runs integer := 0; v_total integer := 0; v_kept bigint; v_inventories bigint; v_stopped text;
begin
	select count(*) into v_kept from public.qorpera_runtime_node_observation_receipts
	where observed_at >= now() - interval '11 days';
	select count(*) into v_inventories from public.qorpera_runtime_node_inventory_receipts;
	-- A run makes at most ten calls of 500 (or stops on its one-second budget), all full here.
	v_result := pg_temp.run();
	v_stopped := case when (v_result ->> 'calls')::integer = 10 then 'call_limit' else 'time_budget' end;
	if (v_result ->> 'calls')::integer not between 1 and 10
		or (v_result ->> 'observations')::integer <> 500 * (v_result ->> 'calls')::integer
		or v_result ->> 'stopped' <> v_stopped
		or v_result -> 'heldByMeter' <> 'true'::jsonb
		or (v_result ->> 'cutoff')::timestamptz <> now() - interval '11 days' then
		raise exception 'One run exceeded its bound or ignored the meter: %', v_result; end if;
	v_total := (v_result ->> 'observations')::integer;
	loop
		v_runs := v_runs + 1;
		v_result := pg_temp.run();
		v_total := v_total + (v_result ->> 'observations')::integer;
		exit when v_result ->> 'stopped' = 'done' or v_runs >= 10;
	end loop;
	if v_result ->> 'stopped' <> 'done' or v_total <> 7173 + 2
		or exists (select 1 from public.qorpera_runtime_node_observation_receipts
			where node_id <> '85100000-0000-4000-8000-00000000000c' and observed_at < now() - interval '11 days')
		or (select count(*) from public.qorpera_runtime_node_observation_receipts where observed_at >= now() - interval '11 days') <> v_kept then
		raise exception 'The meter''s cut was not honoured (deleted %): %', v_total, v_result; end if;
	-- Every deleted receipt took its inventory row along, and only those: node A's even old-4322 to
	-- old-11492 (3,586) and node B's two.
	if (select count(*) from public.qorpera_runtime_node_inventory_receipts) <> v_inventories - 3586 - 2 then
		raise exception 'Inventory rows deleted differ from their receipts'; end if;
end
$$;

-- With the meter current, everything older than seven days goes but each node's latest; node C keeps all.
update public.qorpera_computer_hour_meter set metered_until = now();
do $$
declare v_result jsonb; v_runs integer := 0;
begin
	loop
		v_runs := v_runs + 1;
		v_result := pg_temp.run();
		exit when v_result ->> 'stopped' = 'done' or v_runs >= 10;
	end loop;
	if v_result ->> 'stopped' <> 'done' or v_result -> 'heldByMeter' <> 'false'::jsonb
		or v_result ->> 'nodesWithoutLatestInventory' <> '1' then
		raise exception 'Retention did not finish: %', v_result; end if;
	-- Node A: its latest and its last day, every one with its inventory.
	if pg_temp.receipts('85100000-0000-4000-8000-00000000000a') <> 21 or pg_temp.inventories('85100000-0000-4000-8000-00000000000a') <> 21
		or exists (select 1 from public.qorpera_runtime_node_observation_receipts
			where node_id = '85100000-0000-4000-8000-00000000000a' and observed_at < now() - interval '1 day') then
		raise exception 'Node A kept other than its latest and last day'; end if;
	-- Node B: only its latest, nine days old, with its inventory.
	if (select array_agg(observation_id) from public.qorpera_runtime_node_observation_receipts
			where node_id = '85100000-0000-4000-8000-00000000000b') <> array[md5('85100000-0000-4000-8000-00000000000b:d9')::uuid]
		or pg_temp.inventories('85100000-0000-4000-8000-00000000000b') <> 1 then
		raise exception 'A silent node lost its latest receipt or kept older ones'; end if;
	-- Node C: everything, because its newest inventory is older than its latest report.
	if pg_temp.receipts('85100000-0000-4000-8000-00000000000c') <> 11 or pg_temp.inventories('85100000-0000-4000-8000-00000000000c') <> 5 then
		raise exception 'A node whose latest report has no inventory lost receipts'; end if;
	-- Nothing left: one short call, nothing deleted.
	v_result := pg_temp.run();
	if v_result ->> 'calls' <> '1' or v_result ->> 'observations' <> '0' or v_result ->> 'inventories' <> '0'
		or v_result ->> 'stopped' <> 'done' then
		raise exception 'An idle run differs: %', v_result; end if;
end
$$;

-- A deleted receipt's replay is refused as not current and recorded nowhere: identity stays deduplicated.
do $$
declare v_observation jsonb := jsonb_build_object('schema', 'qorpera.runtime-node-observation/v1',
	'nodeId', '85100000-0000-4000-8000-00000000000b', 'machineIdSha256', repeat('b', 64),
	'observationId', md5('85100000-0000-4000-8000-00000000000b:d10')::uuid,
	'observedAt', to_char((now() - interval '10 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
	'cpuMillis', 32000, 'memoryBytes', 68719476736, 'state', 'ready');
begin
	perform pg_temp.claims('service_role');
	set local role service_role;
	begin
		perform public.qorpera_observe_runtime_node(v_observation);
		raise exception 'A deleted receipt was recorded again' using errcode = 'QTB02';
	exception when insufficient_privilege then
		if sqlerrm <> 'Node observation is not current' then raise; end if;
	end;
	reset role;
	if exists (select 1 from public.qorpera_runtime_node_observation_receipts
			where observation_id = md5('85100000-0000-4000-8000-00000000000b:d10')::uuid) then
		raise exception 'A deleted receipt came back'; end if;
end
$$;

-- One run at a time: another session meanwhile answers busy and deletes nothing.
do $$
begin
	perform pg_advisory_xact_lock(hashtextextended('qorpera.runtime-node-receipt-retention', 0));
	perform dblink_connect('retention_peer', 'dbname=' || current_database());
	if (select value from dblink('retention_peer', 'select public.qorpera_run_runtime_node_receipt_retention()')
			as peer(value jsonb)) ->> 'stopped' <> 'busy' then
		raise exception 'A second retention run went ahead concurrently'; end if;
	perform dblink_disconnect('retention_peer');
end
$$;

-- pg_cron is not part of the test database. A stand-in with pg_cron's schedule-by-name contract shows the
-- helper schedules one job, idempotently, every five minutes, whose command runs as its owner.
do $$
declare v_first jsonb; v_second jsonb; v_command text;
begin
	if to_regnamespace('cron') is null then
		if public.qorpera_schedule_runtime_node_receipt_retention() <>
			'{"schema":"qorpera.runtime-node-receipt-retention-schedule/v1","scheduled":false}'::jsonb then
			raise exception 'Retention claimed a schedule without pg_cron'; end if;
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
	v_first := public.qorpera_schedule_runtime_node_receipt_retention();
	v_second := public.qorpera_schedule_runtime_node_receipt_retention();
	if v_first ->> 'scheduled' <> 'true' or v_second -> 'jobId' <> v_first -> 'jobId'
		or (select count(*) from cron.job where jobname = 'qorpera-runtime-node-receipts-retention') <> 1
		or (select schedule from cron.job where jobname = 'qorpera-runtime-node-receipts-retention') <> '*/5 * * * *' then
		raise exception 'Node receipt retention is not scheduled exactly once every five minutes'; end if;
	select command into v_command from cron.job where jobname = 'qorpera-runtime-node-receipts-retention';
	if v_command <> 'select public.qorpera_run_runtime_node_receipt_retention()' then
		raise exception 'Scheduled retention runs another command: %', v_command; end if;
	execute v_command;
	-- A caller that may not use pg_cron gets scheduled false, never an error that would fail the migration:
	-- without USAGE on schema cron, then with USAGE but without the right to schedule.
	create role node_receipt_scheduler nologin;
	grant execute on function public.qorpera_schedule_runtime_node_receipt_retention() to node_receipt_scheduler;
	for v_step in 1..2 loop
		if v_step = 2 then
			grant usage on schema cron to node_receipt_scheduler;
			revoke execute on function cron.schedule(text, text, text) from public;
		end if;
		set local role node_receipt_scheduler;
		if public.qorpera_schedule_runtime_node_receipt_retention() ->> 'scheduled' <> 'false' then
			raise exception 'A caller without pg_cron rights scheduled retention (step %)', v_step; end if;
		reset role;
	end loop;
end
$$;
rollback;
