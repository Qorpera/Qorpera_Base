-- @fixture 865_folder_state_tables.test.sql until "-- 1. The port of parseTableRows"
-- Interfaces I9c, offers (RUNTIME-INTERFACES.md §5 "The claim rule", §6.1 rule 8): a member offers their own or an
-- empty claimed cell to another member; the offer changes nothing in the file; the member it names takes the cell with
-- a save the claim rule allows because the offer names them. Apply settles a table's offers after each change: taken,
-- still open, or lapsed (another value, the row, the claim or the folder gone). Decline, withdraw, the list, the grants
-- and a paused company. Members call as themselves (request.jwt.claims); the files change through commits as in 865.

-- Calls as a signed-in member, then as the service again; an error answers its SQLSTATE.
create function pg_temp.i9c_as_service() returns void language sql as $$
	select set_config('request.jwt.claims', '{"role":"service_role"}', true)
$$;
create function pg_temp.i9c_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
	perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true);
	execute p_sql into r;
	perform pg_temp.i9c_as_service();
	return r;
exception when others then
	perform pg_temp.i9c_as_service();
	return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end $$;
-- 634's users by number: 1 owner, 2 and 4 contributors, 3 viewer, 5 admin; 99 is nobody's.
create function pg_temp.i9c_user(p_n integer) returns uuid language sql immutable as $$
	select ('63400000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
-- An offer request: the row's key, the cell as read, the member it goes to.
create function pg_temp.i9c_ask(p_task text, p_was integer, p_to integer, p_column text default 'owner',
	p_table uuid default '93800000-0000-4000-8000-000000000001') returns jsonb language sql as $$
	select jsonb_build_object('table', p_table, 'key', jsonb_build_array(p_task), 'column', p_column,
		'was', pg_temp.i9c_user(p_was), 'to', pg_temp.i9c_user(p_to))
$$;
create function pg_temp.i9c_offer(p_by integer, p_request jsonb) returns jsonb language sql as $$
	select pg_temp.i9c_call(pg_temp.i9c_user(p_by), format('select public.qorpera_offer_interface_cell(%L, %L::jsonb)',
		'63400000-0000-4000-8000-000000000020', p_request))
$$;
create function pg_temp.i9c_close(p_by integer, p_verb text, p_offer uuid) returns jsonb language sql as $$
	select pg_temp.i9c_call(pg_temp.i9c_user(p_by), format('select public.qorpera_%s_interface_offer(%L, %L)', p_verb,
		'63400000-0000-4000-8000-000000000020', p_offer))
$$;
create function pg_temp.i9c_list(p_by integer) returns jsonb language sql as $$
	select pg_temp.i9c_call(pg_temp.i9c_user(p_by), format('select public.qorpera_member_interface_offers(%L)',
		'63400000-0000-4000-8000-000000000020'))
$$;
-- A new offer's id (created, open).
create function pg_temp.i9c_made(p_answer jsonb) returns uuid language plpgsql as $$
begin
	if p_answer ->> 'ok' is distinct from 'true' or p_answer ->> 'created' is distinct from 'true'
		or p_answer -> 'offer' ->> 'state' is distinct from 'open' then
		raise exception 'Expected a new offer, got %', p_answer using errcode = 'QTF01'; end if;
	return (p_answer -> 'offer' ->> 'id')::uuid;
end $$;
create function pg_temp.i9c_refused(p_answer jsonb, p_reason text, p_message text default null) returns void language plpgsql as $$
begin
	if p_answer ->> 'ok' is distinct from 'false' or p_answer ->> 'reason' is distinct from p_reason
		or p_answer ->> 'schema' is distinct from 'qorpera.interface-offer/v1'
		or (p_message is not null and p_answer ->> 'message' is distinct from p_message) then
		raise exception 'Expected the refusal % (%), got %', p_reason, p_message, p_answer using errcode = 'QTF01'; end if;
end $$;
create function pg_temp.i9c_error(p_answer jsonb, p_state text) returns void language plpgsql as $$
begin
	if p_answer ->> 'error' is distinct from p_state then
		raise exception 'Expected SQLSTATE %, got %', p_state, p_answer using errcode = 'QTF01'; end if;
end $$;
-- An offer as stored. Read in a statement of its own, after the call that changed it: one statement has one snapshot.
create function pg_temp.i9c_state(p_offer uuid) returns text language sql as $$
	select o.state || case when o.state = 'open' then '' when o.closed_at is null or o.row_key is not null
		or o.column_name is not null then ' (not closed)' else '' end
	from public.qorpera_interface_offers o where o.id = p_offer
$$;

-- 0. The grants: members call the four; the rest and the table are the platform's own.
do $$
declare f text;
begin
	foreach f in array array['public.qorpera_offer_interface_cell(uuid,jsonb)', 'public.qorpera_decline_interface_offer(uuid,uuid)',
		'public.qorpera_withdraw_interface_offer(uuid,uuid)', 'public.qorpera_member_interface_offers(uuid)'] loop
		if not has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')
			or has_function_privilege('service_role', f, 'execute') then raise exception 'The grants of %', f; end if;
	end loop;
	foreach f in array array['public.qorpera_close_interface_offer(uuid,uuid,text)',
		'public.qorpera_interface_offers_settle(uuid,text)', 'public.qorpera_interface_offer_refused(text,text)',
		'public.qorpera_interface_offer_json(public.qorpera_interface_offers,text)'] loop
		if has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')
			or has_function_privilege('service_role', f, 'execute') then raise exception 'The grants of %', f; end if;
	end loop;
	if has_table_privilege('authenticated', 'public.qorpera_interface_offers', 'select')
		or has_table_privilege('anon', 'public.qorpera_interface_offers', 'select')
		or not has_table_privilege('service_role', 'public.qorpera_interface_offers', 'select')
		or has_table_privilege('service_role', 'public.qorpera_interface_offers', 'insert,update,delete') then
		raise exception 'The offers table''s grants'; end if;
end $$;

-- 1. A claims table: t1 the maker's, t2 and t4 empty, t3 taken by the other contributor.
do $$
declare m jsonb := pg_temp.member(2); n jsonb := pg_temp.member(4);
	c_m constant text := '63400000-0000-4000-8000-000000000002'; c_n constant text := '63400000-0000-4000-8000-000000000004';
begin
	perform pg_temp.expect(pg_temp.commit(m, 'i9c-setup-0001', jsonb_build_array(pg_temp.p16_folder(m, 'tables/offers',
		jsonb_build_object('table.toml', pg_temp.claims('93800000-0000-4000-8000-000000000001'), 'rows.csv',
			pg_temp.claim_rows(array[array['t1',c_m,''], array['t2','',''], array['t3','',''], array['t4','','']]))))), 1, 'saved');
	perform pg_temp.expect(pg_temp.save_rows(n, 'i9c-setup-0002', 'tables/offers/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_m,''], array['t2','',''], array['t3',c_n,''], array['t4','','']])), 1, 'saved');
end $$;

-- 2. An offer made, made again, and everything that refuses one.
do $$
declare r jsonb; v_id uuid; v_ask jsonb := pg_temp.i9c_ask('t1', 2, 4);
	v_rows uuid := pg_temp.p16_version('tables/offers/rows.csv');
begin
	r := pg_temp.i9c_offer(2, v_ask);
	v_id := pg_temp.i9c_made(r);
	if r ->> 'schema' <> 'qorpera.interface-offer/v1' or (r -> 'offer') - 'id' - 'at' <> jsonb_build_object(
			'table', '93800000-0000-4000-8000-000000000001', 'folder', 'tables/offers', 'key', '["t1"]'::jsonb, 'column', 'owner',
			'from', pg_temp.i9c_user(2), 'was', pg_temp.i9c_user(2), 'to', pg_temp.i9c_user(4), 'state', 'open', 'closedAt', null)
		or r -> 'offer' ->> 'at' is null then
		raise exception 'An offer: %', r; end if;
	-- The file is as it was.
	if pg_temp.p16_version('tables/offers/rows.csv') is distinct from v_rows
		or (pg_temp.trow('tables/offers')).rows_version is distinct from v_rows then
		raise exception 'An offer changed the rows'; end if;
	-- Offered again: the open offer, not another.
	r := pg_temp.i9c_offer(2, v_ask);
	if r ->> 'ok' <> 'true' or r ->> 'created' <> 'false' or r -> 'offer' ->> 'id' <> v_id::text then
		raise exception 'An offer made twice: %', r; end if;
	if (select count(*) from public.qorpera_interface_offers) <> 1 then raise exception 'An offer made twice is stored twice'; end if;

	-- To oneself, to nobody's user, to a viewer; a viewer's own.
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t1', 2, 2)), 'member');
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t1', 2, 99)), 'member',
		'Offer it to another member of the company.');
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t1', 2, 3)), 'write');
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(3, pg_temp.i9c_ask('t2', null, 4)), 'write',
		'You or they may not change this table''s rows.');
	-- Another's cell, and a cell that isn't as the caller read it.
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(4, pg_temp.i9c_ask('t1', 2, 5)), 'not_yours',
		'Only the member it names can offer it.');
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(4, pg_temp.i9c_ask('t1', null, 5)), 'changed',
		'That changed while you were looking.');
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t3', null, 5)), 'changed');
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t2', 2, 5)), 'changed');
	-- Only a needs_yes member column; an area's supervisor waits for consent records (its owner is offered like any).
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t1', null, 4, 'helper')), 'column',
		'Only a member column that needs a yes can be offered.');
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t1', null, 4, 'task')), 'column');
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t1', null, 4, 'nobody')), 'column');
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(2, pg_temp.i9c_ask('Sales', null, 4, 'supervisor',
		'86400000-0000-4000-8000-000000000012')), 'column');
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(2, pg_temp.i9c_ask('Sales', null, 4, 'owner',
		'86400000-0000-4000-8000-000000000012')), 'gone', 'This row is gone.');
	-- A row or a table that isn't there.
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t9', null, 4)), 'gone', 'This row is gone.');
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t1', 2, 4, 'owner',
		'93800000-0000-4000-8000-000000000009')), 'gone', 'This table is gone.');
	-- Requests of the wrong shape.
	perform pg_temp.i9c_error(pg_temp.i9c_offer(2, '[]'), '22023');
	perform pg_temp.i9c_error(pg_temp.i9c_offer(2, v_ask || '{"extra":1}'), '22023');
	perform pg_temp.i9c_error(pg_temp.i9c_offer(2, v_ask - 'was'), '22023');
	perform pg_temp.i9c_error(pg_temp.i9c_offer(2, v_ask || '{"was":5}'), '22023');
	perform pg_temp.i9c_error(pg_temp.i9c_offer(2, v_ask || '{"key":[]}'), '22023');
	perform pg_temp.i9c_error(pg_temp.i9c_offer(2, v_ask || '{"key":"t1"}'), '22023');
	perform pg_temp.i9c_error(pg_temp.i9c_offer(2, v_ask || jsonb_build_object('key', jsonb_build_array(repeat('x', 4100)))), '22023');
	perform pg_temp.i9c_error(pg_temp.i9c_offer(2, v_ask || '{"column":""}'), '22023');
	perform pg_temp.i9c_error(pg_temp.i9c_offer(2, v_ask || '{"table":"tables/offers"}'), '22023');
	perform pg_temp.i9c_error(pg_temp.i9c_offer(2, v_ask || '{"to":"63400000-0000-4000-8000-0000000000A1"}'), '22023');
	-- Not a member.
	perform pg_temp.i9c_error(pg_temp.i9c_offer(99, v_ask), '42501');
	if (select count(*) from public.qorpera_interface_offers) <> 1 then raise exception 'A refused offer was stored'; end if;
end $$;

-- 3. Taking an offered cell: only the member it names; the cell's other offers lapse. An offer is of the cell as it
-- was: released and taken again, it is gone. An empty cell's offer is accepted by the take.
do $$
declare r jsonb; v_n uuid; v_admin uuid; v_id uuid;
	c_o constant text := '63400000-0000-4000-8000-000000000001'; c_m constant text := '63400000-0000-4000-8000-000000000002';
	c_n constant text := '63400000-0000-4000-8000-000000000004'; c_a constant text := '63400000-0000-4000-8000-000000000005';
begin
	v_n := (select o.id from public.qorpera_interface_offers o where o.to_user = c_n::uuid and o.state = 'open');
	perform pg_temp.refused(pg_temp.save_rows(pg_temp.member(1), 'i9c-accept-0001', 'tables/offers/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_o,''], array['t2','',''], array['t3',c_n,''], array['t4','','']])), 1, 'structured_rule', 'claim');
	v_admin := pg_temp.i9c_made(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t1', 2, 5)));
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'i9c-accept-0002', 'tables/offers/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_n,''], array['t2','',''], array['t3',c_n,''], array['t4','','']])), 1, 'saved');
	if pg_temp.i9c_state(v_n) <> 'accepted' or pg_temp.i9c_state(v_admin) <> 'lapsed' then
		raise exception 'Taken: %, %', pg_temp.i9c_state(v_n), pg_temp.i9c_state(v_admin); end if;
	perform pg_temp.refused(pg_temp.save_rows(pg_temp.member(5), 'i9c-accept-0003', 'tables/offers/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_a,''], array['t2','',''], array['t3',c_n,''], array['t4','','']])), 1, 'structured_rule', 'claim');

	v_id := pg_temp.i9c_made(pg_temp.i9c_offer(4, pg_temp.i9c_ask('t1', 4, 2)));
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'i9c-accept-0004', 'tables/offers/rows.csv',
		pg_temp.claim_rows(array[array['t1','',''], array['t2','',''], array['t3',c_n,''], array['t4','','']])), 1, 'saved');
	if pg_temp.i9c_state(v_id) <> 'lapsed' then raise exception 'Released: %', pg_temp.i9c_state(v_id); end if;
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'i9c-accept-0005', 'tables/offers/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_n,''], array['t2','',''], array['t3',c_n,''], array['t4','','']])), 1, 'saved');
	perform pg_temp.refused(pg_temp.save_rows(pg_temp.member(2), 'i9c-accept-0006', 'tables/offers/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_m,''], array['t2','',''], array['t3',c_n,''], array['t4','','']])), 1, 'structured_rule', 'claim');

	v_id := pg_temp.i9c_made(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t2', null, 4)));
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'i9c-accept-0007', 'tables/offers/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_n,''], array['t2',c_n,''], array['t3',c_n,''], array['t4','','']])), 1, 'saved');
	if pg_temp.i9c_state(v_id) <> 'accepted' then raise exception 'An empty cell taken: %', pg_temp.i9c_state(v_id); end if;
	if exists (select 1 from public.qorpera_interface_offers o where o.state = 'open') then
		raise exception 'An offer is still open after section 3'; end if;
end $$;

-- 4. What keeps an offer open and what lapses it: another member taking the empty cell; the row removed; other cells
-- and the definition's name changed (open); the claim gone from the column; the table's folder deleted. A moved folder
-- keeps its offers, and the take works at the new path.
do $$
declare r jsonb; v_id uuid; v_keep uuid; m jsonb := pg_temp.member(2); n jsonb := pg_temp.member(4); a jsonb := pg_temp.member(5);
	c_m constant text := '63400000-0000-4000-8000-000000000002'; c_n constant text := '63400000-0000-4000-8000-000000000004';
	c_a constant text := '63400000-0000-4000-8000-000000000005';
	v_two jsonb := pg_temp.claims('93800000-0000-4000-8000-000000000002');
begin
	v_id := pg_temp.i9c_made(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t4', null, 4)));
	perform pg_temp.expect(pg_temp.save_rows(a, 'i9c-lapse-0001', 'tables/offers/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_n,''], array['t2',c_n,''], array['t3',c_n,''], array['t4',c_a,'']])), 1, 'saved');
	if pg_temp.i9c_state(v_id) <> 'lapsed' then raise exception 'Taken by another: %', pg_temp.i9c_state(v_id); end if;

	v_id := pg_temp.i9c_made(pg_temp.i9c_offer(4, pg_temp.i9c_ask('t3', 4, 2)));
	perform pg_temp.expect(pg_temp.save_rows(n, 'i9c-lapse-0002', 'tables/offers/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_n,''], array['t2',c_n,''], array['t4',c_a,'']])), 1, 'saved');
	if pg_temp.i9c_state(v_id) <> 'lapsed' then raise exception 'The row removed: %', pg_temp.i9c_state(v_id); end if;

	v_keep := pg_temp.i9c_made(pg_temp.i9c_offer(4, pg_temp.i9c_ask('t1', 4, 2)));
	perform pg_temp.expect(pg_temp.save_rows(a, 'i9c-lapse-0003', 'tables/offers/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_n,''], array['t2',c_n,''], array['t4',c_a,c_m]])), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(m, 'i9c-lapse-0004', jsonb_build_array(pg_temp.p16_write(m, 'tables/offers/table.toml',
		pg_temp.claims('93800000-0000-4000-8000-000000000001') || '{"name":"Offered claims"}'))), 1, 'saved');
	if pg_temp.i9c_state(v_keep) <> 'open' then raise exception 'Other changes: %', pg_temp.i9c_state(v_keep); end if;

	perform pg_temp.expect(pg_temp.commit(m, 'i9c-lapse-0005', jsonb_build_array(pg_temp.p16_folder(m, 'tables/offers-2',
		jsonb_build_object('table.toml', v_two, 'rows.csv', pg_temp.claim_rows(array[array['a','','']]))))), 1, 'saved');
	v_id := pg_temp.i9c_made(pg_temp.i9c_offer(2, pg_temp.i9c_ask('a', null, 4, 'owner', '93800000-0000-4000-8000-000000000002')));
	perform pg_temp.expect(pg_temp.commit(m, 'i9c-lapse-0006', jsonb_build_array(pg_temp.p16_write(m, 'tables/offers-2/table.toml',
		jsonb_set(v_two, '{columns,1,needsYes}', 'false') || '{"holder":null}'))), 1, 'saved');
	if pg_temp.i9c_state(v_id) <> 'lapsed' then raise exception 'The claim gone: %', pg_temp.i9c_state(v_id); end if;
	perform pg_temp.expect(pg_temp.commit(m, 'i9c-lapse-0007', jsonb_build_array(pg_temp.p16_write(m, 'tables/offers-2/table.toml',
		v_two))), 1, 'saved');
	v_id := pg_temp.i9c_made(pg_temp.i9c_offer(2, pg_temp.i9c_ask('a', null, 4, 'owner', '93800000-0000-4000-8000-000000000002')));
	perform pg_temp.expect(pg_temp.commit(m, 'i9c-lapse-0008', jsonb_build_array(pg_temp.p16_delete('tables/offers-2'))), 1, 'saved');
	if pg_temp.i9c_state(v_id) <> 'lapsed' then raise exception 'The folder deleted: %', pg_temp.i9c_state(v_id); end if;
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(2, pg_temp.i9c_ask('a', null, 4, 'owner', '93800000-0000-4000-8000-000000000002')),
		'gone', 'This table is gone.');

	perform pg_temp.expect(pg_temp.commit(m, 'i9c-lapse-0009', jsonb_build_array(pg_temp.p16_move('tables/offers', 'tables/moved'))),
		1, 'saved');
	if pg_temp.i9c_state(v_keep) <> 'open' then raise exception 'Moved: %', pg_temp.i9c_state(v_keep); end if;
	r := pg_temp.i9c_list(2);
	if jsonb_array_length(r -> 'offers') <> 1 or r -> 'offers' -> 0 ->> 'id' <> v_keep::text
		or r -> 'offers' -> 0 ->> 'folder' <> 'tables/moved' then
		raise exception 'The list after a move: %', r; end if;
	perform pg_temp.expect(pg_temp.save_rows(m, 'i9c-lapse-0010', 'tables/moved/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_m,''], array['t2',c_n,''], array['t4',c_a,c_m]])), 1, 'saved');
	if pg_temp.i9c_state(v_keep) <> 'accepted' then raise exception 'Taken after a move: %', pg_temp.i9c_state(v_keep); end if;
end $$;

-- 5. Decline (the member it names) and withdraw (the member who made it); a closed offer stays as it closed.
do $$
declare r jsonb; v_d uuid; v_w uuid;
	c_m constant text := '63400000-0000-4000-8000-000000000002'; c_n constant text := '63400000-0000-4000-8000-000000000004';
	c_a constant text := '63400000-0000-4000-8000-000000000005';
begin
	v_d := pg_temp.i9c_made(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t1', 2, 4)));
	v_w := pg_temp.i9c_made(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t1', 2, 5)));
	perform pg_temp.i9c_error(pg_temp.i9c_close(2, 'decline', v_d), '42501');
	perform pg_temp.i9c_error(pg_temp.i9c_close(5, 'decline', v_d), '42501');
	perform pg_temp.i9c_error(pg_temp.i9c_close(4, 'withdraw', v_d), '42501');
	perform pg_temp.i9c_error(pg_temp.i9c_close(99, 'decline', v_d), '42501');
	perform pg_temp.i9c_error(pg_temp.i9c_close(4, 'decline', '93800000-0000-4000-8000-0000000000ff'), '22023');
	r := pg_temp.i9c_close(4, 'decline', v_d);
	if r ->> 'ok' <> 'true' or r ->> 'changed' <> 'true' or r -> 'offer' ->> 'state' <> 'declined' or r -> 'offer' ->> 'id' <> v_d::text
		or r -> 'offer' ->> 'closedAt' is null or r -> 'offer' -> 'key' <> 'null' or r -> 'offer' ->> 'folder' <> 'tables/moved' then
		raise exception 'Declined: %', r; end if;
	r := pg_temp.i9c_close(4, 'decline', v_d);
	if r ->> 'changed' <> 'false' or r -> 'offer' ->> 'state' <> 'declined' then raise exception 'Declined twice: %', r; end if;
	r := pg_temp.i9c_close(2, 'withdraw', v_d);
	if r ->> 'changed' <> 'false' or r -> 'offer' ->> 'state' <> 'declined' then raise exception 'Withdrawn once declined: %', r; end if;
	r := pg_temp.i9c_close(2, 'withdraw', v_w);
	if r ->> 'changed' <> 'true' or r -> 'offer' ->> 'state' <> 'withdrawn' then raise exception 'Withdrawn: %', r; end if;
	if pg_temp.i9c_state(v_d) <> 'declined' or pg_temp.i9c_state(v_w) <> 'withdrawn' then
		raise exception 'Closed: %, %', pg_temp.i9c_state(v_d), pg_temp.i9c_state(v_w); end if;
	-- A declined offer takes nothing.
	perform pg_temp.refused(pg_temp.save_rows(pg_temp.member(4), 'i9c-close-0001', 'tables/moved/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_n,''], array['t2',c_n,''], array['t4',c_a,c_m]])), 1, 'structured_rule', 'claim');
end $$;

-- 6. The list: open offers on live tables, newest first, for every member who reads the table (a viewer too); an
-- offer to or from a member who left is left out, and stays open.
do $$
declare r jsonb; v_one uuid; v_two uuid; v_three uuid;
begin
	v_one := pg_temp.i9c_made(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t1', 2, 4)));
	v_two := pg_temp.i9c_made(pg_temp.i9c_offer(4, pg_temp.i9c_ask('t2', 4, 2)));
	v_three := pg_temp.i9c_made(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t1', 2, 5)));
	r := pg_temp.i9c_list(3);
	if r ->> 'schema' <> 'qorpera.member-interface-offers/v1' or r ->> 'truncated' <> 'false'
		or (select jsonb_agg(o ->> 'id') from jsonb_array_elements(r -> 'offers') o) <> jsonb_build_array(v_three, v_two, v_one)
		or (r -> 'offers' -> 1) - 'id' - 'at' <> jsonb_build_object('table', '93800000-0000-4000-8000-000000000001',
			'folder', 'tables/moved', 'key', '["t2"]'::jsonb, 'column', 'owner', 'from', pg_temp.i9c_user(4),
			'was', pg_temp.i9c_user(4), 'to', pg_temp.i9c_user(2), 'state', 'open', 'closedAt', null) then
		raise exception 'The list: %', r; end if;
	if pg_temp.i9c_list(1) <> r then raise exception 'The owner''s list: %', pg_temp.i9c_list(1); end if;
	perform pg_temp.i9c_error(pg_temp.i9c_list(99), '42501');
	delete from public.qorpera_profile_members where profile_id = '63400000-0000-4000-8000-000000000010'
		and user_id = pg_temp.i9c_user(5);
	r := pg_temp.i9c_list(2);
	if (select jsonb_agg(o ->> 'id') from jsonb_array_elements(r -> 'offers') o) <> jsonb_build_array(v_two, v_one) then
		raise exception 'The list without the admin: %', r; end if;
	if pg_temp.i9c_state(v_three) <> 'open' then raise exception 'An offer to a member who left: %', pg_temp.i9c_state(v_three); end if;
	-- Offering to them now is refused.
	perform pg_temp.i9c_refused(pg_temp.i9c_offer(4, pg_temp.i9c_ask('t2', 4, 5)), 'member');
end $$;

-- 7. A paused company: no offers; decline, withdraw and the list still work.
do $$
declare r jsonb; v_one uuid;
begin
	v_one := (select o.id from public.qorpera_interface_offers o where o.state = 'open' and o.to_user = pg_temp.i9c_user(4));
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
	values ('63400000-0000-4000-8000-000000000010', pg_temp.i9c_user(1), 'I9c');
	perform pg_temp.i9c_error(pg_temp.i9c_offer(2, pg_temp.i9c_ask('t4', null, 4)), '55000');
	r := pg_temp.i9c_close(4, 'decline', v_one);
	if r ->> 'changed' <> 'true' or r -> 'offer' ->> 'state' <> 'declined' then raise exception 'Declined while paused: %', r; end if;
	r := pg_temp.i9c_list(2);
	if jsonb_array_length(r -> 'offers') <> 1 then raise exception 'The list while paused: %', r; end if;
end $$;
