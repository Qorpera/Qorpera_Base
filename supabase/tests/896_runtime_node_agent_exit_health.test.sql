-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Agent exit E2d part 1 (20260930037000): the node observer posts the exit's own health check
-- (qorpera_observe_runtime_node_agent_exit), and a node's exit is ready while its latest answer is healthy and
-- current. Only the observer's service role may post or read it; a healthy answer needs the exit's check and no
-- problem; the host and policy must be the node's; an answer that is not current, or older than the one kept, never
-- replaces it; the answer goes stale 60 seconds after either the observation or the exit's check.
select pg_temp.path_claims('service_role');
reset role;
-- The real exit health only: the test databases' shim (supabase/tests/bootstrap.sql) stays out of this transaction.
select set_config('qorpera_test.agent_exit_real', 'on', true);

select pg_temp.wake_assert(not has_function_privilege(r, 'public.qorpera_observe_runtime_node_agent_exit(jsonb)', 'EXECUTE')
	and not has_function_privilege(r, 'public.qorpera_runtime_node_agent_exit_ready(uuid)', 'EXECUTE')
	and not has_function_privilege(r, 'public.qorpera_assert_runtime_node_agent_exit(jsonb)', 'EXECUTE'),
	'The API role ' || r || ' can neither post nor read the agent exit''s health')
from unnest(array['anon', 'authenticated']) r;
select pg_temp.wake_assert(has_function_privilege('service_role', 'public.qorpera_observe_runtime_node_agent_exit(jsonb)', 'EXECUTE')
	and has_function_privilege('service_role', 'public.qorpera_runtime_node_agent_exit_ready(uuid)', 'EXECUTE')
	and not has_table_privilege('service_role', 'public.qorpera_runtime_node_agent_exit', 'SELECT'),
	'The service role posts and asks through the functions only');

-- A node with its inventory policy and a fresh observation, as in 403.
set local role service_role;
select public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
	'nodeId','89600000-0000-4000-8000-000000000010','machineIdSha256',repeat('8',64),'label','agent-exit-fixture',
	'cpuMillis',32000,'memoryBytes',68719476736,'headroomCpuMillis',4000,'headroomMemoryBytes',8589934592,
	'standardCpuMillis',8000,'standardMemoryBytes',17179869184,'enabled',true),0);
select public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
	'nodeId','89600000-0000-4000-8000-000000000010','host',jsonb_build_object('machineIdSha256',repeat('8',64),
	'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
	'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',2000,'operatingMemoryBytes',4294967296,'infrastructure','[]'::jsonb));
reset role;
-- The node's inventory policy, as the observer holds it.
select set_config('qorpera_test.exit_policy', (select policy_sha256 from public.qorpera_runtime_node_inventory_policies
	where node_id = '89600000-0000-4000-8000-000000000010'), true);

create function pg_temp.ms(p_at timestamptz) returns text language sql as $$
	select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
-- The observer's report: healthy or not, the exit's check this many seconds ago (null: no check), its problems.
create function pg_temp.exit_report(p_healthy boolean, p_checked_ago integer, p_problems integer,
	p_observed_ago integer default 0, p_patch jsonb default '{}'::jsonb) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-agent-exit/v1','nodeId','89600000-0000-4000-8000-000000000010',
		'machineIdSha256',repeat('8',64),
		'policySha256',current_setting('qorpera_test.exit_policy'),
		'observationId',extensions.gen_random_uuid(),
		'observedAt',pg_temp.ms(clock_timestamp() - make_interval(secs => p_observed_ago)),
		'checkedAt',case when p_checked_ago is null then null
			else to_jsonb(pg_temp.ms(clock_timestamp() - make_interval(secs => p_checked_ago))) end,
		'healthy',p_healthy,'problemCount',p_problems) || p_patch
$$;
create function pg_temp.exit_post(p_report jsonb) returns jsonb language sql as $$
	select public.qorpera_observe_runtime_node_agent_exit(p_report)
$$;
create function pg_temp.exit_ready() returns boolean language sql as $$
	select public.qorpera_runtime_node_agent_exit_ready('89600000-0000-4000-8000-000000000010')
$$;
-- The SQL state a post fails with, or 'ok'.
create function pg_temp.exit_refusal(p_report jsonb) returns text language plpgsql as $$
begin
	perform public.qorpera_observe_runtime_node_agent_exit(p_report);
	return 'ok';
exception when others then return sqlstate;
end
$$;

set local role service_role;
select pg_temp.wake_assert(not pg_temp.exit_ready(), 'A node that never reported its exit has none');
select pg_temp.wake_assert(not public.qorpera_runtime_node_agent_exit_ready('89600000-0000-4000-8000-000000000099'),
	'An unknown node has no exit');

-- 1. A healthy answer makes the exit ready.
select pg_temp.wake_assert(pg_temp.exit_post(pg_temp.exit_report(true, 3, 0)) ->> 'healthy' = 'true', 'Healthy answer kept');
select pg_temp.wake_assert(pg_temp.exit_ready(), 'A healthy, current answer: ready');

-- 2. Malformed or untrue answers are refused and change nothing.
select pg_temp.wake_assert(pg_temp.exit_refusal(r.report) = r.state, r.what || ': ' || pg_temp.exit_refusal(r.report))
from (values
	(pg_temp.exit_report(true, null, 0), '22023', 'healthy without the exit''s check'),
	(pg_temp.exit_report(true, 3, 2), '22023', 'healthy with problems'),
	(pg_temp.exit_report(true, 3, 0, 0, '{"schema":"qorpera.runtime-node-agent-exit/v2"}'), '22023', 'another schema'),
	(pg_temp.exit_report(true, 3, 0, 0, '{"problems":["x"]}'), '22023', 'an extra key (problem texts never leave the node)'),
	(pg_temp.exit_report(true, 3, 0, 0, '{"healthy":"true"}'), '22023', 'healthy as text'),
	(pg_temp.exit_report(false, 3, 1001), '22023', 'more than 1000 problems'),
	(pg_temp.exit_report(true, 3, 0, 0, '{"observedAt":"2026-10-04T01:02:03Z"}'), '22023', 'a time without milliseconds'),
	(pg_temp.exit_report(true, 3, 0, 120), '22023', 'an observation two minutes old'),
	(pg_temp.exit_report(true, 3, 0, -60), '22023', 'an observation from the future'),
	(pg_temp.exit_report(true, 3, 0, 0, jsonb_build_object('machineIdSha256', repeat('9',64))), '42501', 'another host'),
	(pg_temp.exit_report(true, 3, 0, 0, jsonb_build_object('policySha256', repeat('9',64))), '42501', 'another policy'),
	(pg_temp.exit_report(true, 3, 0, 0, '{"nodeId":"89600000-0000-4000-8000-000000000099"}'), '42501', 'an unknown node')
) as r(report, state, what);
select pg_temp.wake_assert(pg_temp.exit_ready(), 'Refused answers left the healthy one in place');

-- 3. An unhealthy answer (or one the observer could not read: no check) stops the exit being ready.
select pg_temp.exit_post(pg_temp.exit_report(false, 2, 3));
select pg_temp.wake_assert(not pg_temp.exit_ready(), 'Unhealthy: not ready');
select pg_temp.exit_post(pg_temp.exit_report(true, 1, 0));
select pg_temp.wake_assert(pg_temp.exit_ready(), 'Healthy again: ready');
select pg_temp.exit_post(pg_temp.exit_report(false, null, 0));
select pg_temp.wake_assert(not pg_temp.exit_ready(), 'An answer the observer could not read: not ready');

-- 4. A late, older answer never replaces a newer one, and a replay changes nothing.
select pg_temp.exit_post(pg_temp.exit_report(true, 1, 0));
select set_config('qorpera_test.exit_kept', pg_temp.exit_post(pg_temp.exit_report(false, 12, 4, 10))::text, true);
select pg_temp.wake_assert(current_setting('qorpera_test.exit_kept')::jsonb ->> 'healthy' = 'true' and pg_temp.exit_ready(),
	'An older unhealthy answer arriving late is ignored: ' || current_setting('qorpera_test.exit_kept'));
select set_config('qorpera_test.exit_replay', pg_temp.exit_report(false, 2, 1)::text, true);
select pg_temp.exit_post(current_setting('qorpera_test.exit_replay')::jsonb);
select pg_temp.exit_post(pg_temp.exit_report(true, 1, 0));
select pg_temp.wake_assert(pg_temp.exit_post(current_setting('qorpera_test.exit_replay')::jsonb) ->> 'healthy' = 'true'
	and pg_temp.exit_ready(), 'A replay of an older answer changes nothing');
reset role;

-- 5. The answer goes stale: 60 seconds after the observation, or after the exit's own check.
update public.qorpera_runtime_node_agent_exit set checked_at = clock_timestamp() - interval '61 seconds'
where node_id = '89600000-0000-4000-8000-000000000010';
set local role service_role;
select pg_temp.wake_assert(not pg_temp.exit_ready(), 'An exit whose own check is over a minute old: not ready');
reset role;
update public.qorpera_runtime_node_agent_exit set checked_at = clock_timestamp(), observed_at = clock_timestamp() - interval '61 seconds'
where node_id = '89600000-0000-4000-8000-000000000010';
set local role service_role;
select pg_temp.wake_assert(not pg_temp.exit_ready(), 'An observation over a minute old: not ready');
select pg_temp.exit_post(pg_temp.exit_report(true, 1, 0));
select pg_temp.wake_assert(pg_temp.exit_ready(), 'A fresh healthy answer: ready again');
reset role;

-- 6. Nothing but healthy, a count and the times is kept.
select pg_temp.wake_assert((select array_agg(column_name::text order by ordinal_position) from information_schema.columns
	where table_schema = 'public' and table_name = 'qorpera_runtime_node_agent_exit')
	= array['node_id','observation_id','observed_at','checked_at','healthy','problem_count','received_at'],
	'The table keeps no problem text');
rollback;
