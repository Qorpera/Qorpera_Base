begin;
-- The node observer's reports now carry time-ordered ids (UUID version 7, packages/runner-orchestrator/src/time-ordered-uuid.ts).
-- Both database functions that take them accept such an id, repeat its answer on replay, and keep it in order.
create function pg_temp.ok(p_value boolean, p_message text) returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%', p_message; end if; end $$;
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes,
	headroom_cpu_millis, headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
values ('11150000-0000-4000-8000-00000000000a', repeat('a', 64), 'time-ordered-ids', 1, 32000, 68719476736, 4000, 4294967296, 4000, 8589934592, true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- A time-ordered id from the observer's clock: the same bits as timeOrderedUuid().
create function pg_temp.v7(p_at timestamptz) returns uuid language sql as $$
	select (lpad(to_hex((extract(epoch from p_at) * 1000)::bigint), 12, '0') || '7' || substr(h, 1, 3) || '8' || substr(h, 4, 15))::uuid
	from (select md5(gen_random_uuid()::text) h) x $$;
create function pg_temp.utc(p_at timestamptz) returns text language sql as $$
	select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

do $$
declare
	v_at timestamptz := date_trunc('milliseconds', clock_timestamp());
	v_id uuid := pg_temp.v7(v_at);
	v_report jsonb := jsonb_build_object('schema', 'qorpera.runtime-node-observation/v1', 'nodeId', '11150000-0000-4000-8000-00000000000a',
		'machineIdSha256', repeat('a', 64), 'observationId', v_id, 'observedAt', pg_temp.utc(v_at), 'cpuMillis', 32000,
		'memoryBytes', 68719476736, 'state', 'unavailable');
	v_answer jsonb;
begin
	perform pg_temp.ok(v_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'Not a version 7 id: ' || v_id);
	v_answer := public.qorpera_observe_runtime_node(v_report);
	perform pg_temp.ok((v_answer ->> 'observationId')::uuid = v_id, 'The node report answered ' || v_answer::text);
	perform pg_temp.ok(public.qorpera_observe_runtime_node(v_report) = v_answer, 'A replay answered differently');
	perform pg_temp.ok((select observation_id = v_id from public.qorpera_runtime_node_observations
		where node_id = '11150000-0000-4000-8000-00000000000a'), 'The latest row does not name the report');
end
$$;

-- The health check's pattern, as a report that measured nothing has it.
select pg_temp.ok(position('[1-8][0-9a-f]{3}' in pg_get_functiondef('public.qorpera_assert_runtime_node_health(jsonb)'::regprocedure)) > 0,
	'The health check no longer accepts a version 7 id');
do $$
declare
	v_at timestamptz := date_trunc('milliseconds', clock_timestamp());
begin
	perform public.qorpera_assert_runtime_node_health(jsonb_build_object('schema', 'qorpera.runtime-node-health/v1',
		'nodeId', '11150000-0000-4000-8000-00000000000a', 'machineIdSha256', repeat('a', 64), 'policySha256', repeat('b', 64),
		'observerPackageSha256', null, 'bootId', null, 'observationId', pg_temp.v7(v_at), 'observedAt', pg_temp.utc(v_at),
		'cpu', null, 'memory', null, 'rootFilesystem', null, 'network', null, 'errors', jsonb_build_array('COLLECTION_UNCONFIRMED')));
end
$$;

-- They sort by time in the database's own order, so a node's new key lands beside its last in the primary key.
select pg_temp.ok(bool_and(a < b), 'Time-ordered ids do not sort by time') from (
	select pg_temp.v7(now() + n * interval '5 seconds') a, pg_temp.v7(now() + (n + 1) * interval '5 seconds') b from generate_series(1, 200) n) x;
rollback;
