-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- 20260930659000: every boot of a company machine is kept with the ask it answered, past the next stop (stopped to
-- ready, the perf scoreboard's A5). 648's committed fixture with a machine node and executor as 999 makes them: Ada's
-- run asked for the task machine m-1159, placed on node A. Covered:
-- 1. A first boot: one row, its ask the machine's wanted_at, placed after the ask, ready at the placement's running_at,
--    asked by the agent, not a restart.
-- 2. The same boot marked again: no row.
-- 3. A new boot while the last is still marked running (the guest restarted): a row marked restarted, with the old ask.
-- 4. A stop, and a member's wake on the disk it kept: the stop clears running_at as before, and the wake's boot gets a row
--    with the new ask, by the member, placed before the ask. The earlier rows stay. After another stop and wake, the
--    guest reporting the same boot id again marks the machine running as before and adds no row.
-- 5. A boot kept out (no boot id): no row.
-- 6. At any machine's boot, rows over 30 days old go, of any machine, the oldest first and at most 50 a time.
-- 7. A move to a new disk with no new start (a folder retirement): its boot answered no ask, so it is marked restarted,
--    not taken for a slow new-disk wake.
-- 8. Row security, privileges and the marker; the mark function under a private owner shaped as production's postgres
--    (no superuser, bypasses row security, reaches every older table): without the migration's grant its boot fails
--    42501, with it the mark runs. The fixture is removed at the end.

create function pg_temp.check(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Machine boots: %', p_message; end if; end
$$;

-- A machine node and its executor, as 999 makes them: the node, its inventory, a fresh ready observation, its machine
-- provider (named as the node) and the executor.
create function pg_temp.observe(p_node uuid, p_hash text) returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context(p_node);
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId',p_node,'machineIdSha256',p_hash,'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('7',64),
				'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end $$;
create function pg_temp.node(p_node uuid, p_hash text, p_label text, p_owner text) returns void language plpgsql as $$
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId',p_node,'machineIdSha256',p_hash,'label',p_label,'cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId',p_node,'host',jsonb_build_object('machineIdSha256',p_hash,
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.observe(p_node, p_hash);
	perform public.qorpera_enroll_runtime_node_provider(p_node,p_hash,'machine',p_label,repeat('f',64),8000,34359738368);
	perform public.qorpera_configure_machine_executor(p_owner,p_hash,true,jsonb_build_object('providerId',p_label,
		'providerPolicySha256',repeat('f',64),'project','machines','imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),
		'storagePool','machines','network','machine-net'),322122547200);
end $$;
select pg_temp.node('11590000-0000-4000-8000-000000000410', repeat('5b', 32), 'machine-1159a', 'mx-1159a');

-- Ada's task machine, asked for 40 seconds ago by Ada's leased run, and given room on node A.
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, wanted_at, updated_at)
values ('11590000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'm-1159',
	'Render the samples', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
	'64800000-0000-4000-8000-000000000002', 1, 1073741824, 10737418240, 'standard', 'task', 'running', clock_timestamp() - interval '40 seconds',
	clock_timestamp());
select pg_temp.observe('11590000-0000-4000-8000-000000000410', repeat('5b', 32));
select public.qorpera_admit_executor_machines('mx-1159a', repeat('5b', 32)) \g /dev/null

create function pg_temp.machine() returns public.qorpera_company_machines language sql as $$
	select * from public.qorpera_company_machines where id = '11590000-0000-4000-8000-0000000000a1'
$$;
create function pg_temp.placement() returns public.qorpera_company_machine_placements language sql as $$
	select * from public.qorpera_company_machine_placements where machine_id = '11590000-0000-4000-8000-0000000000a1' and removed_at is null
	order by created_at desc limit 1
$$;
create function pg_temp.running(p_boot uuid) returns jsonb language sql as $$
	select public.qorpera_mark_company_machine_running(p.id, p.owner, public.qorpera_company_machine_binding_text(p.binding),
		p.machine_id_sha256, p_boot) from pg_temp.placement() p
$$;
create function pg_temp.custody(p_intent text) returns jsonb language sql as $$
	select public.qorpera_authorize_executor_machine(p.id, p.owner, public.qorpera_company_machine_binding_text(p.binding),
		p.machine_id_sha256, p_intent) from pg_temp.placement() p
$$;
create function pg_temp.suspend() returns jsonb language sql as $$
	select public.qorpera_suspend_company_machine(p.id, p.owner, public.qorpera_company_machine_binding_text(p.binding),
		p.machine_id_sha256) from pg_temp.placement() p
$$;
create function pg_temp.release() returns jsonb language sql as $$
	select public.qorpera_release_company_machine(p.id, p.owner, public.qorpera_company_machine_binding_text(p.binding),
		p.machine_id_sha256) from pg_temp.placement() p
$$;
-- The kernel stops the machine, the executor powers it off, and a member starts it again on the disk it kept, as
-- 20260928259050's qorpera_member_manage_company_machine starts a machine that is not running; the executor gets its room.
create function pg_temp.stop_and_wake() returns void language plpgsql as $$
declare v_result jsonb;
begin
	perform public.qorpera_set_company_machine_desired(pg_temp.machine(), 'stopped', 'kernel');
	v_result := pg_temp.custody('stop');
	perform pg_temp.check(v_result ->> 'intent' = 'stop', 'the executor may stop it: ' || v_result::text);
	v_result := pg_temp.suspend();
	perform pg_temp.check(v_result ->> 'state' = 'suspended', 'powered off, its room given back: ' || v_result::text);
	perform pg_temp.check((pg_temp.placement()).running_at is null and (pg_temp.placement()).boot_id is null,
		'the stop clears the running boot as before');
	update public.qorpera_company_machines set desired_state = 'running', desired_by = 'member', wanted_at = clock_timestamp(),
		last_used_at = clock_timestamp(), updated_at = clock_timestamp()
	where id = '11590000-0000-4000-8000-0000000000a1';
	update public.qorpera_company_machine_placements set stop_authorized_at = null where id = (pg_temp.placement()).id;
	perform pg_temp.observe('11590000-0000-4000-8000-000000000410', repeat('5b', 32));
	v_result := pg_temp.custody('run');
	perform pg_temp.check(v_result ->> 'intent' = 'run', 'the executor gets its room back: ' || v_result::text);
end $$;
create function pg_temp.boot(p_boot uuid) returns public.qorpera_company_machine_boots language sql as $$
	select * from public.qorpera_company_machine_boots where machine_id = '11590000-0000-4000-8000-0000000000a1' and boot_id = p_boot
$$;
create function pg_temp.boots() returns bigint language sql as $$
	select count(*) from public.qorpera_company_machine_boots where machine_id = '11590000-0000-4000-8000-0000000000a1'
$$;
create function pg_temp.rows() returns text language sql as $$
	select coalesce(jsonb_agg(to_jsonb(b) order by b.ready_at)::text, '[]') from public.qorpera_company_machine_boots b
	where b.machine_id = '11590000-0000-4000-8000-0000000000a1'
$$;

select pg_temp.check((pg_temp.placement()).owner = 'mx-1159a'
	and public.qorpera_company_machine_placement_reserved((pg_temp.placement()).id), 'the machine has room on node A');
select pg_temp.check(pg_temp.boots() = 0, 'no boot yet: no row');

-- 1. The first boot.
select pg_temp.check(pg_temp.running('11590000-0000-4000-8000-0000000000b1') ->> 'state' = 'running', 'the machine runs in boot b1');
select pg_temp.check(pg_temp.boots() = 1, 'one boot, one row: ' || pg_temp.rows());
select pg_temp.check((select b.asked_at = m.wanted_at and b.placed_at = p.created_at and b.ready_at = p.running_at
		and b.placed_at > b.asked_at and b.ready_at >= b.placed_at
		and b.placement_id = p.id and b.profile_id = m.profile_id and b.asked_by = 'agent' and not b.restarted
	from pg_temp.boot('11590000-0000-4000-8000-0000000000b1') b, pg_temp.machine() m, pg_temp.placement() p),
	'b1 keeps the ask it answered, its placement (made after the ask: a new disk), its mark and who asked: ' || pg_temp.rows());
select pg_temp.check(extract(epoch from (pg_temp.boot('11590000-0000-4000-8000-0000000000b1')).ready_at
		- (pg_temp.boot('11590000-0000-4000-8000-0000000000b1')).asked_at) between 40 and 600,
	'stopped to ready reads back: about 40 seconds from the ask');

-- 2. The same boot again.
select pg_temp.check(pg_temp.running('11590000-0000-4000-8000-0000000000b1') ->> 'state' = 'running'
	and pg_temp.boots() = 1, 'the same boot marked again adds no row: ' || pg_temp.rows());

-- 3. A restart no one asked for: a new boot while b1 is still marked running.
select pg_temp.check(pg_temp.running('11590000-0000-4000-8000-0000000000b2') ->> 'state' = 'running', 'the machine runs in boot b2');
select pg_temp.check(pg_temp.boots() = 2 and (pg_temp.boot('11590000-0000-4000-8000-0000000000b2')).restarted
		and (pg_temp.boot('11590000-0000-4000-8000-0000000000b2')).asked_at = (pg_temp.machine()).wanted_at
		and (pg_temp.boot('11590000-0000-4000-8000-0000000000b2')).ready_at = (pg_temp.placement()).running_at
		and not (pg_temp.boot('11590000-0000-4000-8000-0000000000b1')).restarted,
	'b2 is a restart, with the old ask: ' || pg_temp.rows());

-- 4. The kernel stops it, the executor powers it off, and a member wakes it on the disk it kept.
select pg_temp.stop_and_wake();
select pg_temp.check(pg_temp.boots() = 2, 'the rows stay through a stop: ' || pg_temp.rows());
select pg_temp.check(pg_temp.running('11590000-0000-4000-8000-0000000000b3') ->> 'state' = 'running', 'the machine runs in boot b3');
select pg_temp.check(pg_temp.boots() = 3 and (select b.asked_at = m.wanted_at and b.asked_at > (pg_temp.boot('11590000-0000-4000-8000-0000000000b2')).ready_at
		and b.placed_at < b.asked_at and b.ready_at = p.running_at and b.asked_by = 'member' and not b.restarted
	from pg_temp.boot('11590000-0000-4000-8000-0000000000b3') b, pg_temp.machine() m, pg_temp.placement() p),
	'b3 answered the member''s wake, on the disk it kept: ' || pg_temp.rows());
-- Stopped and woken again, the guest reports b3 once more: it runs, as before this migration, and b3 keeps its one row.
select pg_temp.stop_and_wake();
select pg_temp.check(pg_temp.running('11590000-0000-4000-8000-0000000000b3') ->> 'state' = 'running'
		and (pg_temp.placement()).boot_id = '11590000-0000-4000-8000-0000000000b3' and (pg_temp.placement()).running_at is not null,
	'a boot id the placement had before marks the machine running');
select pg_temp.check(pg_temp.boots() = 3 and (pg_temp.boot('11590000-0000-4000-8000-0000000000b3')).asked_at
		< (pg_temp.machine()).wanted_at, 'and adds no row: ' || pg_temp.rows());

-- 5. A boot kept out writes nothing.
select pg_temp.check(pg_temp.running(null) ->> 'state' = 'kept' and pg_temp.boots() = 3, 'no boot id: kept, and no row');

-- 6. Rows over 30 days old go at any machine's boot, whichever machine they are of (a removed one never boots again),
--    the oldest first, at most 50 a boot.
update public.qorpera_company_machine_boots set ready_at = ready_at - interval '31 days'
where machine_id = '11590000-0000-4000-8000-0000000000a1' and boot_id in ('11590000-0000-4000-8000-0000000000b1',
	'11590000-0000-4000-8000-0000000000b2');
set session_replication_role = replica;
insert into public.qorpera_company_machine_boots(machine_id, placement_id, profile_id, boot_id, asked_at, placed_at, ready_at, asked_by, restarted)
select '11590000-0000-4000-8000-0000000000a2', '11590000-0000-4000-8000-0000000000c2', '64800000-0000-4000-8000-000000000010',
	extensions.gen_random_uuid(), clock_timestamp() - interval '41 days', clock_timestamp() - interval '41 days',
	clock_timestamp() - interval '40 days' - make_interval(secs => n), 'agent', false
from generate_series(1, 60) n;
set session_replication_role = origin;
create function pg_temp.expired() returns bigint language sql as $$
	select count(*) from public.qorpera_company_machine_boots where ready_at < clock_timestamp() - interval '30 days'
		and machine_id in ('11590000-0000-4000-8000-0000000000a1', '11590000-0000-4000-8000-0000000000a2')
$$;
select pg_temp.check(pg_temp.expired() = 62, 'two of this machine''s rows and 60 of a removed machine''s are over 30 days old');
select pg_temp.check(pg_temp.running('11590000-0000-4000-8000-0000000000b4') ->> 'state' = 'running', 'the machine runs in boot b4');
select pg_temp.check(pg_temp.expired() = 12 and (pg_temp.boot('11590000-0000-4000-8000-0000000000b1')).id is not null
		and (select count(*) from public.qorpera_company_machine_boots where machine_id = '11590000-0000-4000-8000-0000000000a2') = 10,
	'one boot removes 50 expired rows, the oldest first (the removed machine''s): ' || pg_temp.expired());
select pg_temp.check(pg_temp.running('11590000-0000-4000-8000-0000000000b5') ->> 'state' = 'running', 'the machine runs in boot b5');
select pg_temp.check(pg_temp.expired() = 0 and pg_temp.boots() = 3 and (pg_temp.boot('11590000-0000-4000-8000-0000000000b3')).id is not null
		and (pg_temp.boot('11590000-0000-4000-8000-0000000000b4')).restarted and (pg_temp.boot('11590000-0000-4000-8000-0000000000b5')).restarted,
	'the next boot removes the rest; b3, b4 and b5 stay: ' || pg_temp.rows());

-- 7. A move to a new disk with no new start: the running placement is retired, as 20260928559200's
--    qorpera_retire_company_machine retires one (its commands end lost), and the machine is placed again.
create temp table boots_moved_from as select (pg_temp.placement()).id as placement_id, (pg_temp.machine()).wanted_at;
select public.qorpera_end_company_machine_commands(pg_temp.machine(), 'lost') \g /dev/null
update public.qorpera_company_machine_placements set retired_at = clock_timestamp() where id = (pg_temp.placement()).id;
select pg_temp.observe('11590000-0000-4000-8000-000000000410', repeat('5b', 32));
select public.qorpera_admit_executor_machines('mx-1159a', repeat('5b', 32)) \g /dev/null
select pg_temp.check((pg_temp.placement()).id <> (select placement_id from boots_moved_from)
	and public.qorpera_company_machine_placement_reserved((pg_temp.placement()).id), 'the machine has a new placement with room');
select pg_temp.check(pg_temp.running('11590000-0000-4000-8000-0000000000b6') ->> 'state' = 'running', 'the machine runs in boot b6');
select pg_temp.check((select b.restarted and b.asked_at = (select wanted_at from boots_moved_from) and b.placed_at > b.asked_at
		and b.placement_id = (pg_temp.placement()).id
	from pg_temp.boot('11590000-0000-4000-8000-0000000000b6') b),
	'b6 on the new disk answered no ask (an earlier boot did): marked restarted, not a slow wake: ' || pg_temp.rows());

-- 8. Row security, privileges and the marker.
select pg_temp.check((select relrowsecurity from pg_class where oid = 'public.qorpera_company_machine_boots'::regclass),
	'the boots have no row security');
select pg_temp.check(not exists (select 1 from unnest(array['anon','authenticated','service_role','qorpera_secret_broker']) r(role)
	cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) p(privilege)
	where has_table_privilege(r.role, 'public.qorpera_company_machine_boots', p.privilege)), 'no API role reaches the boots');
select pg_temp.check(has_function_privilege('service_role', 'public.qorpera_mark_company_machine_running(uuid,text,text,text,uuid)', 'execute')
	and not exists (select 1 from unnest(array['anon','authenticated','qorpera_secret_broker']) r(role)
		where has_function_privilege(r.role, 'public.qorpera_mark_company_machine_running(uuid,text,text,text,uuid)', 'execute')),
	'the executor still marks a boot running, and no other API role does');
select pg_temp.check((select prosecdef and proconfig = array['search_path=""'] from pg_proc
		where oid = 'public.qorpera_mark_company_machine_running(uuid,text,text,text,uuid)'::regprocedure)
	and position('20260930659000' in pg_get_functiondef('public.qorpera_mark_company_machine_running(uuid,text,text,text,uuid)'::regprocedure)) > 0,
	'the patched function is still security definer with an empty search path, and names this migration');

select pg_temp.check((select bool_and(has_table_privilege(pg_get_userbyid(p.proowner), 'public.qorpera_company_machine_boots', privilege))
	from pg_proc p cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) privilege
	where p.oid = 'public.qorpera_mark_company_machine_running(uuid,text,text,text,uuid)'::regprocedure),
	'the mark function''s owner reaches the boots');

-- The mark function under a private owner shaped as production's postgres: no superuser, bypasses row security, owns
-- or reaches every table and function from before this migration but not the boots. The migration's own block (copied
-- here as it is) is what makes its boot work.
begin;
create role qorpera_test_1159_owner nologin nosuperuser bypassrls;
grant usage on schema public, extensions, auth to qorpera_test_1159_owner;
grant all on all tables in schema public to qorpera_test_1159_owner;
grant execute on all functions in schema public, extensions, auth to qorpera_test_1159_owner;
revoke all on public.qorpera_company_machine_boots from qorpera_test_1159_owner;
alter function public.qorpera_mark_company_machine_running(uuid,text,text,text,uuid) owner to qorpera_test_1159_owner;
do $$ begin
	perform pg_temp.running('11590000-0000-4000-8000-0000000000b8');
	raise exception 'Machine boots: a private owner without the grant marked a boot';
exception when insufficient_privilege then
	perform pg_temp.check(sqlerrm like '%qorpera_company_machine_boots%', 'refused on the boots: ' || sqlerrm);
end $$;
select pg_temp.check((pg_temp.placement()).boot_id = '11590000-0000-4000-8000-0000000000b6', 'the refused mark left the boot as it was');
do $$ declare v_owner name := (select pg_get_userbyid(proowner) from pg_proc
	where oid = 'public.qorpera_mark_company_machine_running(uuid,text,text,text,uuid)'::regprocedure);
begin
	if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
		raise exception 'qorpera_mark_company_machine_running has an API owner'; end if;
	if v_owner is distinct from current_user then
		execute format('grant select, insert, update, delete on public.qorpera_company_machine_boots to %I', v_owner); end if;
	-- Row security has no policy here, so the owner must own the table or pass row security, as for the machine tables.
	if not (has_table_privilege(v_owner, 'public.qorpera_company_machine_boots', 'select')
			and has_table_privilege(v_owner, 'public.qorpera_company_machine_boots', 'insert')
			and has_table_privilege(v_owner, 'public.qorpera_company_machine_boots', 'update')
			and has_table_privilege(v_owner, 'public.qorpera_company_machine_boots', 'delete'))
		or not (v_owner = (select pg_get_userbyid(relowner) from pg_class where oid = 'public.qorpera_company_machine_boots'::regclass)
			or exists (select 1 from pg_roles where rolname = v_owner and (rolsuper or rolbypassrls))) then
		raise exception 'The owner of qorpera_mark_company_machine_running (%) cannot keep the boots', v_owner; end if;
end $$;
select pg_temp.check(pg_temp.running('11590000-0000-4000-8000-0000000000b8') ->> 'state' = 'running'
		and (pg_temp.boot('11590000-0000-4000-8000-0000000000b8')).restarted, 'with the grant, the private owner marks b8 and keeps its row');
rollback;
select pg_temp.check((select pg_get_userbyid(proowner) from pg_proc
		where oid = 'public.qorpera_mark_company_machine_running(uuid,text,text,text,uuid)'::regprocedure) <> 'qorpera_test_1159_owner'
	and not exists (select 1 from pg_roles where rolname = 'qorpera_test_1159_owner'), 'the owner probe is rolled back');

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture: the machine node and executor, then 648's company rows as 648 removes them (the boots go with
-- the company's rows).
set session_replication_role = replica;
do $$
declare v_table record;
begin
	delete from public.qorpera_company_machine_container_stops where machine_id = '11590000-0000-4000-8000-0000000000a1';
	for v_table in select c.table_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name = 'node_id' and c.data_type = 'uuid' loop
		execute format('delete from public.%I where node_id = $1', v_table.table_name) using '11590000-0000-4000-8000-000000000410'::uuid;
	end loop;
	delete from public.qorpera_runtime_nodes where id = '11590000-0000-4000-8000-000000000410';
	delete from public.qorpera_machine_executors where owner = 'mx-1159a';
end $$;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
	-- The computer-hour inbox keeps ids of hour-log rows the loop above removed.
	delete from public.qorpera_computer_hour_inbox inbox
	where not exists (select 1 from public.qorpera_computer_hour_log log where log.id = inbox.log_id);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_company_machines where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_company_machine_boots where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_runtime_nodes where id = '11590000-0000-4000-8000-000000000410')
		or exists (select 1 from public.qorpera_machine_executors where owner = 'mx-1159a')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The fixture must be removed'; end if;
end $$;
