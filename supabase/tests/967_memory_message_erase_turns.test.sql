-- Summary trees M3, the memory eraser's queue (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10; 20260930443000).
-- 1,001 erases whose steps keep failing sit ahead of one that is fine: a failed step rolls back, so it changes no row,
-- yet the second listing starts at the 1,001st, since each erase listed goes behind every erase due. Resting erases are
-- passed over and keep their place; so is one a step holds now, without waiting. The rows are written as requests would
-- write them, with the foreign keys off (no company is needed), and the queue holds only this test's erases.

-- The helpers, for the whole session: the first transaction rolls back.
create function pg_temp.same(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want using errcode = 'QTF01'; end if;
end $$;
-- A statement that must fail with this SQLSTATE.
create function pg_temp.fails(p_sql text, p_state text, p_what text) returns void language plpgsql as $$
declare v_state text; v_message text;
begin
	begin
		execute p_sql;
	exception when others then get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
	end;
	if v_state is distinct from p_state then
		raise exception '%: got % (%), want %', p_what, v_state, v_message, p_state using errcode = 'QTF01'; end if;
end $$;
create function pg_temp.service() returns void language sql as $$
	select set_config('request.jwt.claims', '{"role":"service_role"}', true)
$$;
-- Erase n's id.
create function pg_temp.id(p_n integer) returns uuid language sql immutable as $$
	select ('96700000-0000-4000-8000-' || lpad(to_hex(p_n), 12, '0'))::uuid
$$;
-- The ids of erases from to through, in order.
create function pg_temp.ids(p_from integer, p_through integer) returns jsonb language sql immutable as $$
	select jsonb_agg(pg_temp.id(n) order by n) from generate_series(p_from, p_through) n
$$;
-- The queue's listing, its ids in order.
create function pg_temp.due(p_limit integer, p_resting uuid[] default '{}') returns jsonb language sql as $$
	select coalesce(jsonb_agg(d.erase_id order by d.n), '[]')
	from public.qorpera_memory_message_erase_due(p_limit, p_resting) with ordinality d(environment_id, erase_id, state, n)
$$;
-- Erases from to through, pending, each waiting a second less than the one before: the longest waiting is the first.
-- The foreign keys stay off for the rest of the transaction: Postgres checks a row inserted in it again on each update,
-- the queue's own included.
create function pg_temp.erases(p_from integer, p_through integer) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_memory_message_erases(id, environment_id, profile_id, session_id, event_id, sequence,
		message_index, requested_by_user_id, updated_at)
	select pg_temp.id(n), '96700000-0000-4000-8000-0000000e0000', '96700000-0000-4000-8000-0000000f0000',
		'96700000-0000-4000-8000-0000000f0001', extensions.gen_random_uuid(), n, n, '96700000-0000-4000-8000-0000000f0002',
		timestamptz '2026-10-01 00:00:00+00' + n * interval '1 second'
	from generate_series(p_from, p_through) n;
end $$;

begin;

-- 1. A thousand failing erases do not hide the ones behind them -------------------------------------------------------

do $$
begin
	delete from public.qorpera_memory_message_erases;
	perform pg_temp.erases(1, 1002);
	-- The last one is fine: its step 3 is done, its step 4 next.
	update public.qorpera_memory_message_erases set state = 'requested', generation = 1 where id = pg_temp.id(1002);
	perform pg_temp.service();

	perform pg_temp.same(pg_temp.due(1000), pg_temp.ids(1, 1000), 'The queue lists the thousand longest waiting');
	-- Their steps fail and roll back: their rows stay as they were, save the time the queue listed them.
	perform pg_temp.same(pg_temp.due(2), pg_temp.ids(1001, 1002),
		'The next listing starts at the 1,001st, and reaches the one that is fine');
	perform pg_temp.same((select to_jsonb(d) from public.qorpera_memory_message_erase_due(1) d),
		jsonb_build_object('environment_id', '96700000-0000-4000-8000-0000000e0000', 'erase_id', pg_temp.id(1), 'state',
			'pending'), 'Then the first again, with its company and its state');
	perform pg_temp.same(pg_temp.due(3), pg_temp.ids(2, 4), 'In the order they were listed in');
	if exists (select 1 from public.qorpera_memory_message_erases where id = pg_temp.id(1002) and state <> 'requested')
	then
		raise exception 'Listing leaves an erase''s state'; end if;
end $$;

-- 2. Resting erases are passed over and keep their place; done and refused ones are never listed ----------------------

do $$
begin
	perform pg_temp.service();
	perform pg_temp.same(pg_temp.due(2, array[pg_temp.id(5), pg_temp.id(6)]), pg_temp.ids(7, 8),
		'The queue passes over the resting');
	perform pg_temp.same(pg_temp.due(2), pg_temp.ids(5, 6), 'Then lists them where they were');
	update public.qorpera_memory_message_erases set state = 'done', done_at = clock_timestamp() where id = pg_temp.id(9);
	update public.qorpera_memory_message_erases set state = 'refused' where id = pg_temp.id(10);
	perform pg_temp.same(pg_temp.due(1), pg_temp.ids(11, 11), 'Done and refused erases are not due');
	if (select count(*) from public.qorpera_memory_message_erase_due(1000)) <> 1000 then
		raise exception 'The rest are due'; end if;
end $$;

-- 3. Bounds and callers -----------------------------------------------------------------------------------------------

do $$
declare
	v_due constant regprocedure := 'public.qorpera_memory_message_erase_due(integer,uuid[])'::regprocedure;
begin
	perform pg_temp.service();
	perform pg_temp.fails('select * from public.qorpera_memory_message_erase_due(0)', '22023', 'A limit of at least one');
	perform pg_temp.fails('select * from public.qorpera_memory_message_erase_due(1001)', '22023',
		'A limit of at most 1000');
	perform pg_temp.fails('select * from public.qorpera_memory_message_erase_due(1, null)', '22023', 'Rests are a list');
	perform pg_temp.fails('select * from public.qorpera_memory_message_erase_due(1, array[null]::uuid[])', '22023',
		'Each rest is an erase');
	perform pg_temp.fails(format('select * from public.qorpera_memory_message_erase_due(1, %L)',
		(select array_agg(pg_temp.id(n)) from generate_series(1, 1001) n)), '22023', 'At most 1000 rests');
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.fails('select * from public.qorpera_memory_message_erase_due(1)', '42501', 'The folder core''s alone');
	if to_regprocedure('public.qorpera_memory_message_erase_due(integer)') is not null then
		raise exception 'The old queue is gone'; end if;
	-- The API runs a stable function in a read-only transaction, where the listing could not move an erase.
	if (select p.provolatile <> 'v' or not p.prosecdef from pg_proc p where p.oid = v_due::oid) then
		raise exception 'The queue writes, as its definer'; end if;
	if has_function_privilege('anon', v_due::oid, 'execute')
		or has_function_privilege('authenticated', v_due::oid, 'execute')
		or not has_function_privilege('service_role', v_due::oid, 'execute') then
		raise exception 'Only the folder core calls the queue'; end if;
end $$;
rollback;

-- 4. A step holds an erase: the queue passes over it without waiting, and lists it once it is free --------------------

begin;
select pg_temp.erases(1, 2);
commit;
select dblink_connect('q967_step', 'dbname=' || current_database());
select dblink_exec('q967_step', 'begin');
select * from dblink('q967_step', format('select 1 from public.qorpera_memory_message_erases where id = %L for update',
	pg_temp.id(1))) as t(x integer);
begin;
-- Waiting on the step's lock fails here (55P03) instead of hanging.
set local lock_timeout = '5s';
do $$
begin
	delete from public.qorpera_memory_message_erases where id not in (pg_temp.id(1), pg_temp.id(2));
	perform pg_temp.service();
	perform pg_temp.same(pg_temp.due(10), pg_temp.ids(2, 2), 'The queue passes over an erase a step holds');
end $$;
rollback;
select dblink_exec('q967_step', 'rollback');
begin;
do $$
begin
	delete from public.qorpera_memory_message_erases where id not in (pg_temp.id(1), pg_temp.id(2));
	perform pg_temp.service();
	perform pg_temp.same(pg_temp.due(10), pg_temp.ids(1, 2), 'Once the step ends, the queue lists it first again');
end $$;
rollback;
select dblink_disconnect('q967_step');
delete from public.qorpera_memory_message_erases where id in (pg_temp.id(1), pg_temp.id(2));
do $$
begin
	if exists (select 1 from public.qorpera_memory_message_erases
		where environment_id = '96700000-0000-4000-8000-0000000e0000') then
		raise exception 'The test''s erases must be removed'; end if;
end $$;
