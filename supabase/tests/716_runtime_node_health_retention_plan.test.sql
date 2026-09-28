begin;
-- Node health retention plan (20260928248935). The seven-day retention delete at the end of
-- qorpera_observe_runtime_node_health now bounds the history index with now() and deletes by primary
-- key from one selected array (observation_id = any(array(...))), so stale statistics can no longer
-- turn it into a semi join that re-reads the node's history per row. Timing is not asserted (not
-- reliable in CI); the function's source is checked instead, and what the delete removes is checked
-- exactly: the calling node's receipts observed more than seven days ago, oldest first, at most 500 per
-- call, never the receipt its latest row names, and nothing of any other node. A receipt exactly at the
-- cut stays: the cut is strict and is the transaction's now(), not the later clock_timestamp().
create function pg_temp.ok(p_value boolean,p_message text) returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%',p_message; end if; end $$;
create function pg_temp.definition() returns text language sql as $$
	select pg_get_functiondef('public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure) $$;

-- 1. The source: the index-bounded cut and the array delete are live, the volatile cut is gone, and the
--    rest of the function's clock checks, SECURITY DEFINER, empty search_path and privileges are as before.
select pg_temp.ok(position(E'h.observed_at<now()-interval \'7 days\'' in pg_temp.definition()) > 0,
	'The retention cut does not use now()');
select pg_temp.ok(position('where node_id=v_id and observation_id = any(array(' in pg_temp.definition()) > 0,
	'The retention delete does not delete by primary key from one array');
select pg_temp.ok(position(E'clock_timestamp()-interval \'7 days\'' in pg_temp.definition()) = 0
	and position('observation_id in (' in pg_temp.definition()) = 0,
	'The volatile retention cut or the IN semi join is still live');
select pg_temp.ok(position(E'v_at>clock_timestamp()+interval \'2 seconds\' or v_at<clock_timestamp()-interval \'60 seconds\''
	in pg_temp.definition()) > 0,'The observation currentness check changed');
select pg_temp.ok((select prosecdef and proconfig = array['search_path=""'] and provolatile = 'v'
	and pg_get_userbyid(proowner) = 'postgres'
	from pg_proc where oid = 'public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure),
	'SECURITY DEFINER, search_path, volatility or owner changed');
select pg_temp.ok(has_function_privilege('service_role','public.qorpera_observe_runtime_node_health(jsonb)','EXECUTE')
	and not has_function_privilege('anon','public.qorpera_observe_runtime_node_health(jsonb)','EXECUTE')
	and not has_function_privilege('authenticated','public.qorpera_observe_runtime_node_health(jsonb)','EXECUTE')
	and not exists(select 1 from pg_proc p,aclexplode(p.proacl) acl
		where p.oid = 'public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure and acl.grantee = 0),
	'Execute privileges changed');

-- 2. Two nodes with enrolled policies. Node A: 1100 receipts from eight days ago, one a minute past the
--    cut, one exactly at it, one a minute inside it and three from yesterday; its latest row names its
--    oldest receipt.
--    Node B: seven receipts from nine days ago, older than all of node A's (a selection that forgot the
--    node would take them first); its latest row names its oldest one.
insert into public.qorpera_runtime_nodes(id,machine_id_sha256,label,version,cpu_millis,memory_bytes,
	headroom_cpu_millis,headroom_memory_bytes,standard_cpu_millis,standard_memory_bytes,enabled)
values ('71600000-0000-4000-8000-00000000000a',encode(extensions.digest('716-node-a','sha256'),'hex'),'retention-plan-a',
		1,8000,8589934592,1000,1073741824,1000,1073741824,true),
	('71600000-0000-4000-8000-00000000000b',encode(extensions.digest('716-node-b','sha256'),'hex'),'retention-plan-b',
		1,8000,8589934592,1000,1073741824,1000,1073741824,true);
insert into public.qorpera_runtime_node_inventory_policies(node_id,policy,policy_sha256)
select node.id,'{"schema":"qorpera.runtime-node-inventory-policy/v1"}'::jsonb,
	encode(extensions.digest(('{"schema":"qorpera.runtime-node-inventory-policy/v1"}'::jsonb)::text,'sha256'),'hex')
from public.qorpera_runtime_nodes as node
where node.id in ('71600000-0000-4000-8000-00000000000a','71600000-0000-4000-8000-00000000000b');
create function pg_temp.health(p_node uuid,p_at timestamptz) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-health/v1','nodeId',p_node,
		'machineIdSha256',(select machine_id_sha256 from public.qorpera_runtime_nodes where id = p_node),
		'policySha256',(select policy_sha256 from public.qorpera_runtime_node_inventory_policies where node_id = p_node),
		'observerPackageSha256',null,'bootId',null,'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(p_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'cpu',null,'memory',null,'rootFilesystem',null,'network',null,'errors',jsonb_build_array('COLLECTION_UNCONFIRMED'))
$$;
-- p_count receipts, one second apart, the newest p_age before this transaction's start (the cut's clock).
create function pg_temp.stored(p_node uuid,p_age interval,p_count integer) returns void language sql as $$
	insert into public.qorpera_runtime_node_health_receipts(node_id,observation_id,observed_at,observation)
	select p_node,(h->>'observationId')::uuid,(h->>'observedAt')::timestamptz,h
	from generate_series(0,p_count-1) as g,
		lateral (select pg_temp.health(p_node,date_trunc('milliseconds',now()) - p_age - make_interval(secs => g)) as h) as made
$$;
create function pg_temp.old(p_node uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_runtime_node_health_receipts
	where node_id = p_node and observed_at < now() - interval '7 days' $$;
create function pg_temp.kept(p_node uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_runtime_node_health_receipts
	where node_id = p_node and observed_at >= now() - interval '7 days' $$;
-- The receipts the next call must delete: the node's 500 oldest past the cut, less its latest's.
create function pg_temp.expected_deleted(p_node uuid) returns uuid[] language sql as $$
	select array(select h.observation_id from public.qorpera_runtime_node_health_receipts h
		where h.node_id = p_node and h.observed_at < now() - interval '7 days'
			and h.observation_id <> (select observation_id from public.qorpera_runtime_node_health_latest where node_id = p_node)
		order by h.observed_at,h.observation_id limit 500) $$;
-- Node A's receipts before a call, and the ones that must go, as JSON arrays in settings.
create function pg_temp.remember(p_label text) returns void language sql as $$
	select set_config('qorpera_test.'||p_label||'_before',(select coalesce(jsonb_agg(observation_id),'[]')::text
		from public.qorpera_runtime_node_health_receipts where node_id = '71600000-0000-4000-8000-00000000000a'),true);
	select set_config('qorpera_test.'||p_label||'_gone',
		to_jsonb(pg_temp.expected_deleted('71600000-0000-4000-8000-00000000000a'))::text,true);
$$;
-- Exactly the remembered receipts went: every other receipt that was there before is still there.
create function pg_temp.exactly_deleted(p_label text) returns boolean language sql as $$
	select not exists(select 1 from jsonb_array_elements_text(current_setting('qorpera_test.'||p_label||'_gone')::jsonb) gone
			join public.qorpera_runtime_node_health_receipts h on h.observation_id = gone::uuid)
		and (select count(*) from jsonb_array_elements_text(current_setting('qorpera_test.'||p_label||'_before')::jsonb) before
			join public.qorpera_runtime_node_health_receipts h
				on h.node_id = '71600000-0000-4000-8000-00000000000a' and h.observation_id = before::uuid)
			= jsonb_array_length(current_setting('qorpera_test.'||p_label||'_before')::jsonb)
				- jsonb_array_length(current_setting('qorpera_test.'||p_label||'_gone')::jsonb) $$;

select pg_temp.stored('71600000-0000-4000-8000-00000000000a',interval '8 days',1100);
select pg_temp.stored('71600000-0000-4000-8000-00000000000a',interval '7 days 1 minute',1);
select pg_temp.stored('71600000-0000-4000-8000-00000000000a',interval '7 days' - interval '1 minute',1);
-- Exactly at the cut, to the microsecond (the observation's own time is only kept to the millisecond).
select set_config('qorpera_test.at_cut',(extensions.gen_random_uuid())::text,true);
insert into public.qorpera_runtime_node_health_receipts(node_id,observation_id,observed_at,observation)
select '71600000-0000-4000-8000-00000000000a',current_setting('qorpera_test.at_cut')::uuid,now() - interval '7 days',
	pg_temp.health('71600000-0000-4000-8000-00000000000a',now() - interval '7 days')
		|| jsonb_build_object('observationId',current_setting('qorpera_test.at_cut'));
select pg_temp.stored('71600000-0000-4000-8000-00000000000a',interval '1 day',3);
select pg_temp.stored('71600000-0000-4000-8000-00000000000b',interval '9 days',7);
insert into public.qorpera_runtime_node_health_latest(node_id,observation_id,observed_at)
select distinct on (node_id) node_id,observation_id,observed_at from public.qorpera_runtime_node_health_receipts
where node_id in ('71600000-0000-4000-8000-00000000000a','71600000-0000-4000-8000-00000000000b')
order by node_id,observed_at,observation_id;
select set_config('qorpera_test.latest_a',(select observation_id::text from public.qorpera_runtime_node_health_latest
	where node_id = '71600000-0000-4000-8000-00000000000a'),true);
select set_config('qorpera_test.latest_b',(select observation_id::text from public.qorpera_runtime_node_health_latest
	where node_id = '71600000-0000-4000-8000-00000000000b'),true);
select pg_temp.ok(pg_temp.old('71600000-0000-4000-8000-00000000000a') = 1101
	and pg_temp.kept('71600000-0000-4000-8000-00000000000a') = 5
	and pg_temp.old('71600000-0000-4000-8000-00000000000b') = 7,'Retention fixture differs');
select set_config('request.jwt.claims','{"role":"service_role"}',true);

-- 3. An exact replay of node A's oldest receipt, which its latest row names. The latest row stays (a
--    replay never moves it back), so the call deletes the 500 oldest receipts past the cut except that
--    one, and answers with the original receipt.
select pg_temp.remember('replay');
select pg_temp.ok(jsonb_array_length(current_setting('qorpera_test.replay_gone')::jsonb) = 500
	and not current_setting('qorpera_test.replay_gone')::jsonb ? current_setting('qorpera_test.latest_a'),
	'The replay fixture does not select 500 receipts other than the latest');
select pg_temp.ok(public.qorpera_observe_runtime_node_health((select observation
		from public.qorpera_runtime_node_health_receipts where observation_id = current_setting('qorpera_test.latest_a')::uuid))
	= (select jsonb_build_object('nodeId',node_id,'observationId',observation_id,'observedAt',observed_at)
		from public.qorpera_runtime_node_health_receipts where observation_id = current_setting('qorpera_test.latest_a')::uuid),
	'A replay of the latest receipt no longer answers with its original receipt');
select pg_temp.ok(pg_temp.exactly_deleted('replay'),'The replay did not delete exactly the 500 oldest receipts but the latest');
select pg_temp.ok(pg_temp.old('71600000-0000-4000-8000-00000000000a') = 601
	and pg_temp.kept('71600000-0000-4000-8000-00000000000a') = 5
	and (select observation_id::text = current_setting('qorpera_test.latest_a')
		from public.qorpera_runtime_node_health_latest where node_id = '71600000-0000-4000-8000-00000000000a'),
	'The replay deleted more than 500, a receipt inside seven days, or the latest receipt');

-- 4. A current observation moves the latest row to itself; the former latest receipt is now an ordinary
--    old receipt and goes first. At most 500 per call: 101 old receipts remain.
select pg_temp.ok(public.qorpera_observe_runtime_node_health(pg_temp.health('71600000-0000-4000-8000-00000000000a',
	date_trunc('milliseconds',clock_timestamp()))) is not null,'A current observation was refused');
select pg_temp.ok(not exists(select 1 from public.qorpera_runtime_node_health_receipts
		where observation_id = current_setting('qorpera_test.latest_a')::uuid)
	and pg_temp.old('71600000-0000-4000-8000-00000000000a') = 101
	and pg_temp.kept('71600000-0000-4000-8000-00000000000a') = 6,
	'The first current observation did not delete exactly 500 old receipts including the former latest');
select pg_temp.remember('current');
select pg_temp.ok(jsonb_array_length(current_setting('qorpera_test.current_gone')::jsonb) = 101,
	'The last pass does not select the 101 remaining old receipts');

-- 5. The next observation deletes the remaining 101, including the one a minute past the cut; the one
--    exactly at the cut, the one a minute inside it, yesterday's three and both new observations stay.
select set_config('qorpera_test.newest',public.qorpera_observe_runtime_node_health(
	pg_temp.health('71600000-0000-4000-8000-00000000000a',date_trunc('milliseconds',clock_timestamp())))::text,true);
select pg_temp.ok(pg_temp.exactly_deleted('current'),'The last pass did not delete exactly the remaining old receipts');
select pg_temp.ok(pg_temp.old('71600000-0000-4000-8000-00000000000a') = 0
	and pg_temp.kept('71600000-0000-4000-8000-00000000000a') = 7
	and exists(select 1 from public.qorpera_runtime_node_health_receipts
		where observation_id = current_setting('qorpera_test.at_cut')::uuid and observed_at = now() - interval '7 days')
	and exists(select 1 from public.qorpera_runtime_node_health_receipts
		where node_id = '71600000-0000-4000-8000-00000000000a'
			and observed_at >= now() - interval '7 days' and observed_at < now() - interval '6 days'),
	'The last pass left an old receipt or deleted one inside seven days');
select pg_temp.ok((select observation_id = (current_setting('qorpera_test.newest')::jsonb->>'observationId')::uuid
	from public.qorpera_runtime_node_health_latest where node_id = '71600000-0000-4000-8000-00000000000a'),
	'The latest row does not name the newest observation');
-- Nothing is left to delete: one more observation, made as service_role through its own EXECUTE grant
-- rather than as the owner, deletes nothing.
select set_config('qorpera_test.last_observation',pg_temp.health('71600000-0000-4000-8000-00000000000a',
	date_trunc('milliseconds',clock_timestamp()))::text,true);
set local role service_role;
select set_config('qorpera_test.last_result',public.qorpera_observe_runtime_node_health(
	current_setting('qorpera_test.last_observation')::jsonb)::text,true);
reset role;
select pg_temp.ok(current_setting('qorpera_test.last_result')::jsonb->>'observationId'
		= current_setting('qorpera_test.last_observation')::jsonb->>'observationId'
	and pg_temp.kept('71600000-0000-4000-8000-00000000000a') = 8,'An observation with nothing to delete lost a receipt');

-- 6. Node B was never the calling node: all seven old receipts and its latest row stay.
select pg_temp.ok(pg_temp.old('71600000-0000-4000-8000-00000000000b') = 7
	and (select observation_id::text = current_setting('qorpera_test.latest_b')
		from public.qorpera_runtime_node_health_latest where node_id = '71600000-0000-4000-8000-00000000000b'),
	'Another node''s receipts or latest row were touched');

rollback;
