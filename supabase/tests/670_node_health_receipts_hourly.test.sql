begin;
-- Node health receipts hourly (20260930485000): the health observation deletes nothing; the hourly receipt
-- retention deletes health receipts instead. Per call of qorpera_purge_runtime_node_receipts: at most p_limit
-- health receipts (a budget of their own beside the observations'), node by node, oldest first, observed
-- more than seven days before the transaction's start, never the one a node's health latest row names. The
-- computer-hour meter does not hold them back. The run records and answers healthReceipts, in at most 30
-- calls and 20 seconds. Timing is printed, not checked.
create function pg_temp.ok(p_value boolean, p_message text) returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%', p_message; end if; end $$;
create function pg_temp.id(p_node uuid, p_key text) returns uuid language sql as $$
	select md5(p_node || ':' || p_key)::uuid $$;
-- A health receipt stored directly, as the observation would have stored it at p_at.
create function pg_temp.stored(p_node uuid, p_key text, p_at timestamptz) returns uuid language sql as $$
	insert into public.qorpera_runtime_node_health_receipts(node_id, observation_id, observed_at, observation)
	values (p_node, pg_temp.id(p_node, p_key), p_at,
		jsonb_build_object('schema', 'qorpera.runtime-node-health/v1', 'observationId', pg_temp.id(p_node, p_key)))
	returning observation_id $$;
create function pg_temp.latest(p_node uuid, p_id uuid) returns void language sql as $$
	insert into public.qorpera_runtime_node_health_latest(node_id, observation_id, observed_at)
	select node_id, observation_id, observed_at from public.qorpera_runtime_node_health_receipts
	where node_id = p_node and observation_id = p_id $$;
create function pg_temp.receipts(p_node uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_runtime_node_health_receipts where node_id = p_node $$;
create function pg_temp.old(p_node uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_runtime_node_health_receipts
	where node_id = p_node and observed_at < now() - interval '7 days' $$;
create function pg_temp.has(p_node uuid, p_key text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_runtime_node_health_receipts
		where node_id = p_node and observation_id = pg_temp.id(p_node, p_key)) $$;
-- A current health observation, as an observer sends it (as 716).
create function pg_temp.health(p_node uuid, p_at timestamptz) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.runtime-node-health/v1', 'nodeId', p_node,
		'machineIdSha256', (select machine_id_sha256 from public.qorpera_runtime_nodes where id = p_node),
		'policySha256', (select policy_sha256 from public.qorpera_runtime_node_inventory_policies where node_id = p_node),
		'observerPackageSha256', null, 'bootId', null, 'observationId', extensions.gen_random_uuid(),
		'observedAt', to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'cpu', null, 'memory', null, 'rootFilesystem', null, 'network', null, 'errors', jsonb_build_array('COLLECTION_UNCONFIRMED'))
$$;
-- The purge's exact answer; with the meter held (ten days behind) the cut is eleven days back.
create function pg_temp.answer(p_observations integer, p_health integer, p_more boolean, p_held boolean) returns jsonb
language sql as $$
	select jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention/v1', 'busy', false,
		'observations', p_observations, 'inventories', 0, 'healthReceipts', p_health, 'moreEligible', p_more,
		'cutoff', case when p_held then now() - interval '11 days' else now() - interval '7 days' end,
		'heldByMeter', p_held, 'retentionDays', 7) $$;

-- 1. Attributes. The health observation: SECURITY DEFINER, empty search_path, volatile, owned by postgres,
--    executable by service_role alone. The purge and the run: SECURITY DEFINER, empty search_path and a
--    one-second lock limit, volatile, executable by no API role and not by PUBLIC.
select pg_temp.ok((select prosecdef and proconfig = array['search_path=""'] and provolatile = 'v'
		and pg_get_userbyid(proowner) = 'postgres'
		from pg_proc where oid = 'public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure),
	'The health observation''s SECURITY DEFINER, search_path, volatility or owner changed');
select pg_temp.ok(has_function_privilege('service_role', 'public.qorpera_observe_runtime_node_health(jsonb)', 'EXECUTE')
		and not exists (select 1 from unnest(array['anon', 'authenticated', 'qorpera_secret_broker']) role_name
			where has_function_privilege(role_name, 'public.qorpera_observe_runtime_node_health(jsonb)', 'EXECUTE'))
		and not exists (select 1 from pg_proc p, aclexplode(p.proacl) acl
			where p.oid = 'public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure and acl.grantee = 0),
	'The health observation''s execute privileges changed');
select pg_temp.ok((select prosecdef and proconfig = array['search_path=""', 'lock_timeout=1s'] and provolatile = 'v'
		and pg_get_userbyid(proowner) = 'postgres' from pg_proc where oid = signature::regprocedure),
	signature || ' is not a volatile postgres-owned security definer with an empty search path and a 1 s lock limit')
from unnest(array['public.qorpera_purge_runtime_node_receipts(integer)',
	'public.qorpera_run_runtime_node_receipt_retention()']) signature;
select pg_temp.ok(not has_function_privilege(role_name, signature, 'EXECUTE'), signature || ' is executable by ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker']) role_name
cross join unnest(array['public.qorpera_purge_runtime_node_receipts(integer)',
	'public.qorpera_run_runtime_node_receipt_retention()']) signature;
select pg_temp.ok(not exists (select 1 from pg_proc p, aclexplode(p.proacl) acl
		where p.oid in ('public.qorpera_purge_runtime_node_receipts(integer)'::regprocedure,
			'public.qorpera_run_runtime_node_receipt_retention()'::regprocedure) and acl.grantee = 0),
	'The purge or the run is executable by PUBLIC');
-- The status row keeps row security and gains health_receipts: a nullable bigint, never negative.
select pg_temp.ok((select relrowsecurity from pg_class where oid = 'public.qorpera_runtime_node_receipt_retention_status'::regclass),
	'The retention status has no row security');
select pg_temp.ok((select atttypid = 'bigint'::regtype and not attnotnull from pg_attribute
		where attrelid = 'public.qorpera_runtime_node_receipt_retention_status'::regclass and attname = 'health_receipts'
			and not attisdropped),
	'The retention status has no nullable bigint health_receipts');
select pg_temp.ok(exists (select 1 from pg_constraint
		where conrelid = 'public.qorpera_runtime_node_receipt_retention_status'::regclass and contype = 'c'
			and pg_get_constraintdef(oid) = 'CHECK ((health_receipts >= 0))'),
	'The retention status has no health_receipts >= 0 check');
do $$
begin
	update public.qorpera_runtime_node_receipt_retention_status set health_receipts = -1;
	raise exception 'A negative health_receipts was stored' using errcode = 'QT670';
exception when check_violation then null;
end
$$;

-- 2. The source: no delete left on the observers' path (the replaced statement is one comment line naming
--    this migration), and the purge deletes health receipts (what the next bundle activation's guard checks).
select pg_temp.ok(position('delete from' in lower(pg_get_functiondef('public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure))) = 0
		and position('20260930485000' in pg_get_functiondef('public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure)) > 0,
	'The health observation still deletes, or does not name 20260930485000');
select pg_temp.ok(position('qorpera_runtime_node_health_receipts'
		in pg_get_functiondef('public.qorpera_purge_runtime_node_receipts(integer)'::regprocedure)) > 0,
	'The purge does not delete health receipts');

-- 3. Fixture, at the transaction's time (the cut's clock). The exact counts below assume no other node
--    receipt is older than seven days.
select pg_temp.ok(not exists (select 1 from public.qorpera_runtime_node_health_receipts where observed_at < now() - interval '7 days')
		and not exists (select 1 from public.qorpera_runtime_node_observation_receipts where observed_at < now() - interval '7 days'),
	'The database already holds node receipts older than seven days');
update public.qorpera_computer_hour_meter set metered_until = now();
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes,
	headroom_cpu_millis, headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
select id, encode(extensions.digest('670-node-' || digit, 'sha256'), 'hex'), 'health-hourly-' || digit,
	1, 8000, 8589934592, 1000, 1073741824, 1000, 1073741824, true
from (values ('67000000-0000-4000-8000-00000000000a'::uuid, 'a'), ('67000000-0000-4000-8000-00000000000b'::uuid, 'b'),
	('67000000-0000-4000-8000-00000000000c'::uuid, 'c')) node(id, digit);
insert into public.qorpera_runtime_node_inventory_policies(node_id, policy, policy_sha256)
values ('67000000-0000-4000-8000-00000000000a', '{"schema":"qorpera.runtime-node-inventory-policy/v1"}'::jsonb,
	encode(extensions.digest(('{"schema":"qorpera.runtime-node-inventory-policy/v1"}'::jsonb)::text, 'sha256'), 'hex'));
-- Node A reports: 2,000 receipts from 8 days ago on (old-n is 8 days and n minutes old), one a second past
-- the cut, one exactly at it, one a minute inside it, five in the last hours, and its latest, 5 s ago.
select pg_temp.stored('67000000-0000-4000-8000-00000000000a', 'old-' || n, now() - interval '8 days' - n * interval '1 minute')
from generate_series(1, 2000) n;
select pg_temp.stored('67000000-0000-4000-8000-00000000000a', 'past-cut', now() - interval '7 days 1 second');
select pg_temp.stored('67000000-0000-4000-8000-00000000000a', 'at-cut', now() - interval '7 days');
select pg_temp.stored('67000000-0000-4000-8000-00000000000a', 'inside', now() - interval '7 days' + interval '1 minute');
select pg_temp.stored('67000000-0000-4000-8000-00000000000a', 'recent-' || n, now() - n * interval '1 hour')
from generate_series(1, 5) n;
select pg_temp.latest('67000000-0000-4000-8000-00000000000a',
	pg_temp.stored('67000000-0000-4000-8000-00000000000a', 'latest', now() - interval '5 seconds'));
-- Node A's observations: four nine days old and its latest (the meter's hold applies to these).
insert into public.qorpera_runtime_node_observation_receipts(node_id, observation_id, observed_at, observation)
select '67000000-0000-4000-8000-00000000000a', pg_temp.id('67000000-0000-4000-8000-00000000000a', label), observed,
	jsonb_build_object('observationId', pg_temp.id('67000000-0000-4000-8000-00000000000a', label), 'state', 'ready')
from (select 'obs-old-' || n, now() - interval '9 days' - n * interval '1 minute' from generate_series(1, 4) n
	union all select 'obs-latest', now() - interval '5 seconds') receipt(label, observed);
insert into public.qorpera_runtime_node_observations(node_id, observation_id, observed_at, observation)
select node_id, observation_id, observed_at, observation from public.qorpera_runtime_node_observation_receipts
where observation_id = pg_temp.id('67000000-0000-4000-8000-00000000000a', 'obs-latest');
-- Node B went silent nine days ago: its latest is older than seven days.
select pg_temp.stored('67000000-0000-4000-8000-00000000000b', 'd' || days, now() - days * interval '1 day')
from unnest(array[13, 12, 10]) days;
select pg_temp.latest('67000000-0000-4000-8000-00000000000b',
	pg_temp.stored('67000000-0000-4000-8000-00000000000b', 'd9', now() - interval '9 days'));
-- Node C: three receipts older than all of A's, and its latest, a minute ago.
select pg_temp.stored('67000000-0000-4000-8000-00000000000c', 'old-' || n, now() - interval '20 days' - n * interval '1 minute')
from generate_series(1, 3) n;
select pg_temp.latest('67000000-0000-4000-8000-00000000000c',
	pg_temp.stored('67000000-0000-4000-8000-00000000000c', 'latest', now() - interval '1 minute'));
select pg_temp.ok(pg_temp.receipts('67000000-0000-4000-8000-00000000000a') = 2009
		and pg_temp.old('67000000-0000-4000-8000-00000000000a') = 2001
		and pg_temp.old('67000000-0000-4000-8000-00000000000b') = 4 and pg_temp.old('67000000-0000-4000-8000-00000000000c') = 3,
	'The fixture differs');

-- 4. The poller: a health observation of node A, as service_role, answers exactly nodeId, observationId and
--    observedAt, moves the latest row to itself and deletes nothing. Then 50 more, timed.
do $$
declare v_observation jsonb := pg_temp.health('67000000-0000-4000-8000-00000000000a', date_trunc('milliseconds', clock_timestamp()));
	v_result jsonb; v_batch jsonb[]; v_started timestamptz; v_elapsed interval;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_result := public.qorpera_observe_runtime_node_health(v_observation);
	reset role;
	if v_result is distinct from (select jsonb_build_object('nodeId', node_id, 'observationId', observation_id, 'observedAt', observed_at)
			from public.qorpera_runtime_node_health_receipts where observation_id = (v_observation ->> 'observationId')::uuid) then
		raise exception 'The health observation answers other than its receipt: %', v_result; end if;
	if (select observation_id from public.qorpera_runtime_node_health_latest where node_id = '67000000-0000-4000-8000-00000000000a')
			<> (v_observation ->> 'observationId')::uuid then
		raise exception 'The health observation did not move the latest row'; end if;
	if pg_temp.receipts('67000000-0000-4000-8000-00000000000a') <> 2010 or pg_temp.old('67000000-0000-4000-8000-00000000000a') <> 2001
			or not pg_temp.has('67000000-0000-4000-8000-00000000000a', 'old-2000') then
		raise exception 'The health observation deleted a receipt'; end if;
	v_batch := array(select pg_temp.health('67000000-0000-4000-8000-00000000000a', date_trunc('milliseconds', clock_timestamp()))
		from generate_series(1, 50));
	set local role service_role;
	v_started := clock_timestamp();
	for i in 1 .. 50 loop
		perform public.qorpera_observe_runtime_node_health(v_batch[i]);
	end loop;
	v_elapsed := clock_timestamp() - v_started;
	reset role;
	perform set_config('request.jwt.claims', '', true);
	if pg_temp.receipts('67000000-0000-4000-8000-00000000000a') <> 2060 or pg_temp.old('67000000-0000-4000-8000-00000000000a') <> 2001
			or pg_temp.receipts('67000000-0000-4000-8000-00000000000b') <> 4 or pg_temp.receipts('67000000-0000-4000-8000-00000000000c') <> 4
			or (select count(*) from public.qorpera_runtime_node_observation_receipts
				where node_id = '67000000-0000-4000-8000-00000000000a') <> 5 then
		raise exception 'A health observation deleted a receipt'; end if;
	perform set_config('qorpera_test.t670_observe', format('observe_health %s ms a call (mean of 50, node with 2,001 receipts past seven days)',
		round((extract(epoch from v_elapsed) * 1000 / 50)::numeric, 3)), true);
end
$$;

-- 5. The purge, with the meter ten days behind: observations are held at eleven days (none goes), health
--    receipts are not (they go at seven). Node by node (A, B, C), oldest first, at most p_limit a call.
update public.qorpera_computer_hour_meter set metered_until = now() - interval '10 days';
do $$
declare v_result jsonb; v_started timestamptz; v_elapsed interval;
begin
	-- Three: node A's three oldest.
	v_result := public.qorpera_purge_runtime_node_receipts(3);
	if v_result is distinct from pg_temp.answer(0, 3, true, true) then
		raise exception 'A call of three differs: %', v_result; end if;
	if pg_temp.has('67000000-0000-4000-8000-00000000000a', 'old-2000') or pg_temp.has('67000000-0000-4000-8000-00000000000a', 'old-1999')
			or pg_temp.has('67000000-0000-4000-8000-00000000000a', 'old-1998') or not pg_temp.has('67000000-0000-4000-8000-00000000000a', 'old-1997')
			or pg_temp.old('67000000-0000-4000-8000-00000000000a') <> 1998
			or pg_temp.old('67000000-0000-4000-8000-00000000000b') <> 4 or pg_temp.old('67000000-0000-4000-8000-00000000000c') <> 3 then
		raise exception 'A call of three did not delete exactly node A''s three oldest'; end if;
	-- Three full calls of 500, all node A's, oldest first: old-1997 down to old-498 go.
	for i in 1 .. 3 loop
		v_started := clock_timestamp();
		v_result := public.qorpera_purge_runtime_node_receipts(500);
		v_elapsed := clock_timestamp() - v_started;
		if v_result is distinct from pg_temp.answer(0, 500, true, true) then
			raise exception 'Full call % differs: %', i, v_result; end if;
	end loop;
	if exists (select 1 from public.qorpera_runtime_node_health_receipts where node_id = '67000000-0000-4000-8000-00000000000a'
				and observed_at < now() - interval '8 days' - 497 * interval '1 minute')
			or not pg_temp.has('67000000-0000-4000-8000-00000000000a', 'old-497')
			or pg_temp.old('67000000-0000-4000-8000-00000000000a') <> 498 then
		raise exception 'The full calls did not delete node A''s oldest first'; end if;
	perform set_config('qorpera_test.t670_purge', format('purge %s ms for 500 health receipts',
		round((extract(epoch from v_elapsed) * 1000)::numeric, 1)), true);
	-- One budget across nodes: node A's last 498 (the one a second past the cut last), then node B's two
	-- oldest; node C is not reached.
	v_result := public.qorpera_purge_runtime_node_receipts(500);
	if v_result is distinct from pg_temp.answer(0, 500, true, true) then
		raise exception 'The call across nodes differs: %', v_result; end if;
	if pg_temp.old('67000000-0000-4000-8000-00000000000a') <> 0 or pg_temp.has('67000000-0000-4000-8000-00000000000b', 'd13')
			or pg_temp.has('67000000-0000-4000-8000-00000000000b', 'd12') or not pg_temp.has('67000000-0000-4000-8000-00000000000b', 'd10')
			or pg_temp.old('67000000-0000-4000-8000-00000000000c') <> 3 then
		raise exception 'The call across nodes did not spend one budget, node by node, oldest first'; end if;
	-- The rest: node B's d10 and node C's three, with budget to spare.
	v_result := public.qorpera_purge_runtime_node_receipts(500);
	if v_result is distinct from pg_temp.answer(0, 4, false, true) then
		raise exception 'The last call differs: %', v_result; end if;
	-- Left: node B's latest (nine days old) and everything not older than seven days, the one exactly at
	-- the cut included; every latest row as it was; every observation receipt (held by the meter).
	if (select array_agg(observation_id) from public.qorpera_runtime_node_health_receipts where observed_at < now() - interval '7 days')
				is distinct from array[pg_temp.id('67000000-0000-4000-8000-00000000000b', 'd9')]
			or not pg_temp.has('67000000-0000-4000-8000-00000000000a', 'at-cut') or not pg_temp.has('67000000-0000-4000-8000-00000000000a', 'inside')
			or pg_temp.receipts('67000000-0000-4000-8000-00000000000a') <> 2060 - 2001
			or pg_temp.receipts('67000000-0000-4000-8000-00000000000b') <> 1 or pg_temp.receipts('67000000-0000-4000-8000-00000000000c') <> 1
			or (select observation_id from public.qorpera_runtime_node_health_latest where node_id = '67000000-0000-4000-8000-00000000000b')
				<> pg_temp.id('67000000-0000-4000-8000-00000000000b', 'd9')
			or (select observation_id from public.qorpera_runtime_node_health_latest where node_id = '67000000-0000-4000-8000-00000000000c')
				<> pg_temp.id('67000000-0000-4000-8000-00000000000c', 'latest')
			or (select count(*) from public.qorpera_runtime_node_observation_receipts
				where node_id = '67000000-0000-4000-8000-00000000000a') <> 5 then
		raise exception 'Health retention kept other than each node''s latest and last seven days, or the meter''s hold failed'; end if;
	-- Nothing left: nothing deleted, no more eligible.
	v_result := public.qorpera_purge_runtime_node_receipts(500);
	if v_result is distinct from pg_temp.answer(0, 0, false, true) then
		raise exception 'An idle held call differs: %', v_result; end if;
end
$$;
-- With the meter current, the four old observations go; health has nothing left.
update public.qorpera_computer_hour_meter set metered_until = now();
do $$
declare v_result jsonb := public.qorpera_purge_runtime_node_receipts(500);
begin
	if v_result is distinct from pg_temp.answer(4, 0, false, false)
			or (select array_agg(observation_id) from public.qorpera_runtime_node_observation_receipts
				where node_id = '67000000-0000-4000-8000-00000000000a') is distinct from
				array[pg_temp.id('67000000-0000-4000-8000-00000000000a', 'obs-latest')] then
		raise exception 'Observation retention with the meter current differs: %', v_result; end if;
end
$$;

-- 6. The run: 15,250 health receipts of node C past the cut. One run makes at most 30 calls of 500 (or
--    stops after 20 seconds, between calls), records health_receipts and answers healthReceipts; the next
--    run takes the rest and ends done; a third finds nothing.
insert into public.qorpera_runtime_node_health_receipts(node_id, observation_id, observed_at, observation)
select '67000000-0000-4000-8000-00000000000c', pg_temp.id('67000000-0000-4000-8000-00000000000c', 'bulk-' || n),
	now() - interval '7 days 1 hour' - n * interval '1 second', '{"schema":"qorpera.runtime-node-health/v1"}'
from generate_series(1, 15250) n;
do $$
declare v_result jsonb; v_started timestamptz; v_elapsed interval; v_calls integer; v_total bigint; v_runs integer := 1;
begin
	v_started := clock_timestamp();
	v_result := public.qorpera_run_runtime_node_receipt_retention();
	v_elapsed := clock_timestamp() - v_started;
	v_calls := (v_result ->> 'calls')::integer;
	if v_result ->> 'stopped' = 'time_budget' then
		-- A slow machine: only after 20 seconds, after full calls.
		if v_elapsed < interval '20 seconds' or v_calls not between 1 and 29
				or v_result - 'stopped' - 'calls' - 'healthReceipts' - 'cutoff' <> jsonb_build_object('schema',
					'qorpera.runtime-node-receipt-retention-run/v1', 'observations', 0, 'inventories', 0, 'heldByMeter', false)
				or (v_result ->> 'healthReceipts')::bigint <> 500 * v_calls then
			raise exception 'A run stopped on its time budget early or uneven (% elapsed): %', v_elapsed, v_result; end if;
	elsif v_result is distinct from jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention-run/v1',
			'stopped', 'call_limit', 'calls', 30, 'observations', 0, 'inventories', 0, 'healthReceipts', 15000,
			'cutoff', now() - interval '7 days', 'heldByMeter', false) then
		raise exception 'A run exceeded or fell short of its 30 calls: %', v_result; end if;
	if not exists (select 1 from public.qorpera_runtime_node_receipt_retention_status
			where stopped = v_result ->> 'stopped' and calls = v_calls and observations = 0 and inventories = 0
				and health_receipts = (v_result ->> 'healthReceipts')::bigint and cutoff = now() - interval '7 days'
				and not held_by_meter and held_by_meter_since is null) then
		raise exception 'The run was not recorded: %',
			(select to_jsonb(status) from public.qorpera_runtime_node_receipt_retention_status status); end if;
	perform set_config('qorpera_test.t670_run', format('run %s ms (%s calls, %s health receipts)',
		round((extract(epoch from v_elapsed) * 1000)::numeric, 1), v_calls, v_result ->> 'healthReceipts'), true);
	v_total := (v_result ->> 'healthReceipts')::bigint;
	loop
		v_runs := v_runs + 1;
		v_result := public.qorpera_run_runtime_node_receipt_retention();
		v_total := v_total + (v_result ->> 'healthReceipts')::bigint;
		exit when v_result ->> 'stopped' = 'done' or v_runs >= 10;
	end loop;
	if v_result ->> 'stopped' <> 'done' or v_total <> 15250
			or (select array_agg(observation_id) from public.qorpera_runtime_node_health_receipts where observed_at < now() - interval '7 days')
				is distinct from array[pg_temp.id('67000000-0000-4000-8000-00000000000b', 'd9')]
			or pg_temp.receipts('67000000-0000-4000-8000-00000000000c') <> 1
			or not exists (select 1 from public.qorpera_runtime_node_receipt_retention_status
				where stopped = 'done' and health_receipts = (v_result ->> 'healthReceipts')::bigint
					and calls = (v_result ->> 'calls')::integer) then
		raise exception 'The runs did not take every health receipt past the cut (took %): %', v_total, v_result; end if;
	v_result := public.qorpera_run_runtime_node_receipt_retention();
	if v_result is distinct from jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention-run/v1',
			'stopped', 'done', 'calls', 1, 'observations', 0, 'inventories', 0, 'healthReceipts', 0,
			'cutoff', now() - interval '7 days', 'heldByMeter', false)
			or not exists (select 1 from public.qorpera_runtime_node_receipt_retention_status
				where stopped = 'done' and calls = 1 and health_receipts = 0) then
		raise exception 'An idle run differs: %', v_result; end if;
end
$$;

-- 7. Busy: while this session holds the retention lock, another session's purge answers busy with nothing
--    deleted, healthReceipts 0 included.
do $$
declare v_result jsonb;
begin
	perform pg_advisory_xact_lock(hashtextextended('qorpera.runtime-node-receipt-retention', 0));
	perform dblink_connect('health_retention_peer', 'dbname=' || current_database());
	select value into v_result from dblink('health_retention_peer', 'select public.qorpera_purge_runtime_node_receipts(500)')
		as peer(value jsonb);
	perform dblink_disconnect('health_retention_peer');
	if v_result is distinct from jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention/v1', 'busy', true,
			'observations', 0, 'inventories', 0, 'healthReceipts', 0, 'moreEligible', false) then
		raise exception 'A busy purge differs: %', v_result; end if;
end
$$;

-- 8. The timing (printed, not checked).
select concat_ws('; ', current_setting('qorpera_test.t670_observe'), current_setting('qorpera_test.t670_purge'),
	current_setting('qorpera_test.t670_run')) as t670 \gset
\echo 670 timing: :t670
rollback;
