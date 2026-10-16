begin;
-- Node health retention plan (20260928248935), as of 20260930485000. The seven-day retention delete that
-- ended qorpera_observe_runtime_node_health is gone: the hourly receipt retention
-- (qorpera_purge_runtime_node_receipts) deletes old health receipts instead, and 670 tests that (which
-- receipts go, the strict cut at the transaction's now(), the latest kept, and the observation's source).
-- What still holds here: the observation's clock checks, SECURITY DEFINER, empty search_path, owner and
-- privileges; an exact replay answers with its original receipt and never moves the latest row back; a
-- current observation moves the latest row to itself; and no observation deletes anything, of its own node
-- or of another, however many receipts are older than seven days.
create function pg_temp.ok(p_value boolean,p_message text) returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%',p_message; end if; end $$;
create function pg_temp.definition() returns text language sql as $$
	select pg_get_functiondef('public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure) $$;

-- 1. The function's clock checks, SECURITY DEFINER, empty search_path and privileges are as before.
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
--    Node B: seven receipts from nine days ago, older than all of node A's; its latest row names its oldest one.
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
-- p_count receipts, one second apart, the newest p_age before this transaction's start.
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

-- 3. An exact replay of node A's oldest receipt, which its latest row names, answers with the original
--    receipt; the latest row stays (a replay never moves it back) and nothing is deleted.
select pg_temp.ok(public.qorpera_observe_runtime_node_health((select observation
		from public.qorpera_runtime_node_health_receipts where observation_id = current_setting('qorpera_test.latest_a')::uuid))
	= (select jsonb_build_object('nodeId',node_id,'observationId',observation_id,'observedAt',observed_at)
		from public.qorpera_runtime_node_health_receipts where observation_id = current_setting('qorpera_test.latest_a')::uuid),
	'A replay of the latest receipt no longer answers with its original receipt');
select pg_temp.ok(pg_temp.old('71600000-0000-4000-8000-00000000000a') = 1101
	and pg_temp.kept('71600000-0000-4000-8000-00000000000a') = 5
	and (select observation_id::text = current_setting('qorpera_test.latest_a')
		from public.qorpera_runtime_node_health_latest where node_id = '71600000-0000-4000-8000-00000000000a'),
	'The replay deleted a receipt or moved the latest row');

-- 4. A current observation moves the latest row to itself and deletes nothing: the former latest receipt,
--    now an ordinary receipt older than seven days, stays for the hourly retention.
select pg_temp.ok(public.qorpera_observe_runtime_node_health(pg_temp.health('71600000-0000-4000-8000-00000000000a',
	date_trunc('milliseconds',clock_timestamp()))) is not null,'A current observation was refused');
select pg_temp.ok(exists(select 1 from public.qorpera_runtime_node_health_receipts
		where observation_id = current_setting('qorpera_test.latest_a')::uuid)
	and pg_temp.old('71600000-0000-4000-8000-00000000000a') = 1101
	and pg_temp.kept('71600000-0000-4000-8000-00000000000a') = 6,
	'A current observation deleted a receipt');

-- 5. The next observation, too, deletes nothing and becomes the latest; the receipt exactly at the cut
--    and the one a minute inside it are there as before.
select set_config('qorpera_test.newest',public.qorpera_observe_runtime_node_health(
	pg_temp.health('71600000-0000-4000-8000-00000000000a',date_trunc('milliseconds',clock_timestamp())))::text,true);
select pg_temp.ok(pg_temp.old('71600000-0000-4000-8000-00000000000a') = 1101
	and pg_temp.kept('71600000-0000-4000-8000-00000000000a') = 7
	and exists(select 1 from public.qorpera_runtime_node_health_receipts
		where observation_id = current_setting('qorpera_test.at_cut')::uuid and observed_at = now() - interval '7 days')
	and exists(select 1 from public.qorpera_runtime_node_health_receipts
		where node_id = '71600000-0000-4000-8000-00000000000a'
			and observed_at >= now() - interval '7 days' and observed_at < now() - interval '6 days'),
	'The next observation deleted a receipt');
select pg_temp.ok((select observation_id = (current_setting('qorpera_test.newest')::jsonb->>'observationId')::uuid
	from public.qorpera_runtime_node_health_latest where node_id = '71600000-0000-4000-8000-00000000000a'),
	'The latest row does not name the newest observation');
-- One more observation, made as service_role through its own EXECUTE grant rather than as the owner,
-- answers with its receipt and deletes nothing.
select set_config('qorpera_test.last_observation',pg_temp.health('71600000-0000-4000-8000-00000000000a',
	date_trunc('milliseconds',clock_timestamp()))::text,true);
set local role service_role;
select set_config('qorpera_test.last_result',public.qorpera_observe_runtime_node_health(
	current_setting('qorpera_test.last_observation')::jsonb)::text,true);
reset role;
select pg_temp.ok(current_setting('qorpera_test.last_result')::jsonb->>'observationId'
		= current_setting('qorpera_test.last_observation')::jsonb->>'observationId'
	and pg_temp.old('71600000-0000-4000-8000-00000000000a') = 1101
	and pg_temp.kept('71600000-0000-4000-8000-00000000000a') = 8,'An observation as service_role lost a receipt');

-- 6. Node B was never the calling node: all seven old receipts and its latest row stay.
select pg_temp.ok(pg_temp.old('71600000-0000-4000-8000-00000000000b') = 7
	and (select observation_id::text = current_setting('qorpera_test.latest_b')
		from public.qorpera_runtime_node_health_latest where node_id = '71600000-0000-4000-8000-00000000000b'),
	'Another node''s receipts or latest row were touched');

rollback;
