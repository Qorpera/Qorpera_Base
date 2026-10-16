-- Summary trees M3, the memory eraser's turns (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10; 20260930443000).
-- Listing moves no erase; a pass taking one moves it behind every erase due. A thousand taken erases whose steps failed
-- and rolled back sit ahead of two not taken: the next listing starts at the 1,001st. Of two erases due at the same
-- time, the one with the smaller id comes first until a pass takes it, and the other next, however that pass ends.
-- Resting erases are passed over and keep their place; so is one a step holds now, without waiting, and no pass takes
-- it. The rows are written as requests would write them, with the foreign keys off (no company is needed), and the
-- queue holds only this test's erases.

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
-- How many of erases from to through a pass takes, one by one in order.
create function pg_temp.takes(p_from integer, p_through integer) returns integer language sql as $$
	select (count(*) filter (where public.qorpera_memory_message_erase_take(pg_temp.id(n))))::integer
	from generate_series(p_from, p_through) n
$$;
-- Erases from to through, pending, each waiting a second less than the one before: the longest waiting is the first.
-- The foreign keys stay off for the rest of the transaction: Postgres checks a row inserted in it again on each update,
-- a take's included.
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
	perform pg_temp.same(pg_temp.due(2), pg_temp.ids(1, 2), 'Listing moves none of them');
	-- A pass takes each, and its steps fail and roll back: the rows stay as they were, save the time each was taken.
	if pg_temp.takes(1, 1000) <> 1000 then raise exception 'A pass takes each erase due'; end if;
	perform pg_temp.same(pg_temp.due(2), pg_temp.ids(1001, 1002),
		'The next listing starts at the 1,001st, and reaches the one that is fine');
	perform pg_temp.same((select to_jsonb(d) from public.qorpera_memory_message_erase_due(1) d),
		jsonb_build_object('environment_id', '96700000-0000-4000-8000-0000000e0000', 'erase_id', pg_temp.id(1001),
			'state', 'pending'), 'With its company and its state');
	if pg_temp.takes(1001, 1002) <> 2 then raise exception 'A pass takes the two'; end if;
	perform pg_temp.same(pg_temp.due(3), pg_temp.ids(1, 3), 'Then the first again, in the order they were taken');
	if exists (select 1 from public.qorpera_memory_message_erases where id = pg_temp.id(1002) and state <> 'requested')
	then
		raise exception 'Taking leaves an erase''s state'; end if;
end $$;

-- 2. Of two erases due at the same time, the one a pass did not reach comes first next time ---------------------------

do $$
begin
	delete from public.qorpera_memory_message_erases;
	perform pg_temp.erases(1, 12);
	update public.qorpera_memory_message_erases set updated_at = timestamptz '2026-10-01 00:00:00+00'
	where id in (pg_temp.id(1), pg_temp.id(2));
	perform pg_temp.service();
	perform pg_temp.same(pg_temp.due(2), pg_temp.ids(1, 2), 'Due at the same time, the smaller id first');
	-- A pass takes the first, and its deadline comes before it reaches the second.
	if pg_temp.takes(1, 1) <> 1 then raise exception 'A pass takes the first'; end if;
	perform pg_temp.same(pg_temp.due(2), pg_temp.ids(2, 3), 'The next pass lists first the one the last did not reach');
	-- The next one ends the same way.
	if pg_temp.takes(2, 2) <> 1 then raise exception 'A pass takes the second'; end if;
	perform pg_temp.same(pg_temp.due(12), pg_temp.ids(3, 12) || pg_temp.ids(1, 2),
		'The ones taken come last, in the order they were taken');
end $$;

-- 3. Resting erases are passed over and keep their place; done and refused ones are neither listed nor taken ----------

do $$
begin
	perform pg_temp.service();
	perform pg_temp.same(pg_temp.due(2, array[pg_temp.id(3), pg_temp.id(4)]), pg_temp.ids(5, 6),
		'The queue passes over the resting');
	perform pg_temp.same(pg_temp.due(2), pg_temp.ids(3, 4), 'Then lists them where they were');
	update public.qorpera_memory_message_erases set state = 'done', done_at = clock_timestamp() where id = pg_temp.id(3);
	update public.qorpera_memory_message_erases set state = 'refused' where id = pg_temp.id(4);
	perform pg_temp.same(pg_temp.due(1), pg_temp.ids(5, 5), 'Done and refused erases are not due');
	if pg_temp.takes(3, 4) <> 0 then raise exception 'Done and refused erases are not taken'; end if;
	if pg_temp.takes(13, 13) <> 0 then raise exception 'An id that is no erase takes nothing'; end if;
	perform pg_temp.same(pg_temp.due(1000), pg_temp.ids(5, 12) || pg_temp.ids(1, 2), 'The rest are due, in their order');
end $$;

-- 4. Bounds and callers -----------------------------------------------------------------------------------------------

do $$
declare
	v_due constant regprocedure := 'public.qorpera_memory_message_erase_due(integer,uuid[])'::regprocedure;
	v_take constant regprocedure := 'public.qorpera_memory_message_erase_take(uuid)'::regprocedure;
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
	perform pg_temp.fails('select public.qorpera_memory_message_erase_take(null)', '22023', 'A pass takes an erase');
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.fails('select * from public.qorpera_memory_message_erase_due(1)', '42501', 'The folder core''s alone');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_take(%L)', pg_temp.id(5)), '42501',
		'The folder core alone takes an erase');
	if to_regprocedure('public.qorpera_memory_message_erase_due(integer)') is not null then
		raise exception 'The old queue is gone'; end if;
	-- The API runs a stable function in a read-only transaction, where neither could lock a row.
	if exists (select 1 from pg_proc p
		where p.oid in (v_due::oid, v_take::oid) and (p.provolatile <> 'v' or not p.prosecdef)) then
		raise exception 'The queue and the take lock rows, as their definer'; end if;
	if exists (select 1 from unnest(array[v_due::oid, v_take::oid]) f
		where has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')
			or not has_function_privilege('service_role', f, 'execute')) then
		raise exception 'Only the folder core calls the queue and the take'; end if;
end $$;
rollback;

-- 5. A step holds an erase: the queue passes over it without waiting, no pass takes it, and once it is free both do ---

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
	if pg_temp.takes(1, 1) <> 0 then raise exception 'No pass takes an erase a step holds'; end if;
end $$;
rollback;
select dblink_exec('q967_step', 'rollback');
begin;
do $$
begin
	delete from public.qorpera_memory_message_erases where id not in (pg_temp.id(1), pg_temp.id(2));
	perform pg_temp.service();
	perform pg_temp.same(pg_temp.due(10), pg_temp.ids(1, 2), 'Once the step ends, the queue lists it first again');
	if pg_temp.takes(1, 1) <> 1 then raise exception 'And a pass takes it'; end if;
	perform pg_temp.same(pg_temp.due(10), jsonb_build_array(pg_temp.id(2), pg_temp.id(1)), 'Behind the other one');
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
