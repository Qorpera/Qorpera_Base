-- @fixture 865_folder_state_tables.test.sql until "-- 1. The port of parseTableRows"
-- Interfaces I9b, agents join a supervised area by its supervisor's yes (RUNTIME-INTERFACES.md §5.1 "Supervision",
-- §6.1 rule 9): while an area's consent is live, a save by anyone but its member that adds an agent to the area is
-- refused, and they offer the agent to the supervisor instead. The offer changes nothing in the file; the supervisor's
-- save that adds the agent accepts it (an agent in another area moves); it closes as any offer, and lapses when the
-- consent ends (withdrawn, released, gone, left). Removing an agent stays free, and an area with no live consent takes
-- agents from anyone. The grants, the requests' shapes and a paused company. The cells' offers are 938's; the consents
-- 451-453's.

-- Calls as a signed-in member, then as the service again; an error answers its SQLSTATE.
create function pg_temp.i9b_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
	perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true);
	execute p_sql into r;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return r;
exception when others then
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end $$;
-- 634's users by number: 1 owner, 2 and 4 contributors, 3 viewer, 5 admin; 99 is nobody's.
create function pg_temp.i9b_user(p_n integer) returns uuid language sql immutable as $$
	select ('63400000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
-- An agent offered to an area: the area's key, the agent.
create function pg_temp.i9b_ask(p_area text, p_agent text) returns jsonb language sql immutable as $$
	select jsonb_build_object('key', jsonb_build_array(p_area), 'agent', p_agent)
$$;
create function pg_temp.i9b_offer(p_by integer, p_request jsonb) returns jsonb language sql as $$
	select pg_temp.i9b_call(pg_temp.i9b_user(p_by), format('select public.qorpera_offer_interface_agent(%L, %L::jsonb)',
		'63400000-0000-4000-8000-000000000020', p_request))
$$;
create function pg_temp.i9b_close(p_by integer, p_verb text, p_offer uuid) returns jsonb language sql as $$
	select pg_temp.i9b_call(pg_temp.i9b_user(p_by), format('select public.qorpera_%s_interface_offer(%L, %L)', p_verb,
		'63400000-0000-4000-8000-000000000020', p_offer))
$$;
create function pg_temp.i9b_list(p_by integer) returns jsonb language sql as $$
	select pg_temp.i9b_call(pg_temp.i9b_user(p_by), format('select public.qorpera_member_interface_offers(%L)',
		'63400000-0000-4000-8000-000000000020'))
$$;
-- A new offer's id (created, open).
create function pg_temp.i9b_made(p_answer jsonb) returns uuid language plpgsql as $$
begin
	if p_answer ->> 'ok' is distinct from 'true' or p_answer ->> 'created' is distinct from 'true'
		or p_answer -> 'offer' ->> 'state' is distinct from 'open' then
		raise exception 'Expected a new offer, got %', p_answer using errcode = 'QTF01'; end if;
	return (p_answer -> 'offer' ->> 'id')::uuid;
end $$;
create function pg_temp.i9b_refused(p_answer jsonb, p_reason text, p_message text default null) returns void language plpgsql as $$
begin
	if p_answer ->> 'ok' is distinct from 'false' or p_answer ->> 'reason' is distinct from p_reason
		or p_answer ->> 'schema' is distinct from 'qorpera.interface-offer/v1'
		or (p_message is not null and p_answer ->> 'message' is distinct from p_message) then
		raise exception 'Expected the refusal % (%), got %', p_reason, p_message, p_answer using errcode = 'QTF01'; end if;
end $$;
create function pg_temp.i9b_error(p_answer jsonb, p_state text) returns void language plpgsql as $$
begin
	if p_answer ->> 'error' is distinct from p_state then
		raise exception 'Expected SQLSTATE %, got %', p_state, p_answer using errcode = 'QTF01'; end if;
end $$;
-- The areas' rows: area, owner, supervisor, agents, shared.
create function pg_temp.i9b_areas(p_rows text[][]) returns jsonb language sql as $$
	select pg_temp.rows(array['area','owner','supervisor','agents','shared'], p_rows)
$$;
-- An area's live consent's id, or null.
create function pg_temp.i9b_live(p_key jsonb) returns uuid language sql as $$
	select s.id from public.qorpera_interface_supervisions s where s.state = 'live' and s.row_key = p_key
$$;
-- A consent's state. Read in a statement of its own, after the change that ended it.
create function pg_temp.i9b_consent_state(p_id uuid) returns text language sql as $$
	select s.state from public.qorpera_interface_supervisions s where s.id = p_id
$$;
-- An offer as stored. Read in a statement of its own, after the change that closed it.
create function pg_temp.i9b_state(p_offer uuid) returns text language sql as $$
	select o.state || case when o.state = 'open' then '' when o.closed_at is null or o.row_key is not null
		or o.column_name is not null then ' (not closed)' else '' end
	from public.qorpera_interface_offers o where o.id = p_offer
$$;
-- 634's member leaving the company.
create function pg_temp.i9b_leave(p_n integer) returns void language sql as $$
	delete from public.qorpera_profile_members where profile_id = '63400000-0000-4000-8000-000000000010'
		and user_id = pg_temp.i9b_user(p_n)
$$;

-- 0. The grants: members call the offer; the lapse is the platform's own.
do $$
declare f text := 'public.qorpera_offer_interface_agent(uuid,jsonb)'; g text := 'public.qorpera_interface_supervision_offers_lapse()';
begin
	if not has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')
		or has_function_privilege('service_role', f, 'execute') then raise exception 'The grants of %', f; end if;
	if has_function_privilege('authenticated', g, 'execute') or has_function_privilege('anon', g, 'execute')
		or has_function_privilege('service_role', g, 'execute') then raise exception 'The grants of %', g; end if;
end $$;

-- 1. Member 2 takes Sales's supervisor, agent A in it; Ops, with no supervisor, has agent B.
do $$
declare c_m constant text := '63400000-0000-4000-8000-000000000002';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
begin
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(2), 'i9b-agents-0001', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales','',c_m,c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	if pg_temp.i9b_live('["Sales"]') is null then raise exception 'Sales has no consent'; end if;
end $$;

-- 2. The save rule: a save by another member, the owner or the platform that adds B to Sales is refused. One that keeps
-- Sales's agents or takes A out is saved, and so is one that adds agents to Ops. Only member 2 puts A back. The consent
-- stays live throughout.
do $$
declare r jsonb; v_actor jsonb; v_n integer := 0; v_id uuid := pg_temp.i9b_live('["Sales"]');
	v_rows uuid := pg_temp.p16_version('tables/areas/rows.csv');
	c_m constant text := '63400000-0000-4000-8000-000000000002';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
begin
	foreach v_actor in array array[pg_temp.member(4), pg_temp.member(1), '{"kind":"platform"}'::jsonb] loop
		v_n := v_n + 1;
		r := pg_temp.save_rows(v_actor, 'i9b-agents-010' || v_n, 'tables/areas/rows.csv', pg_temp.i9b_areas(
			array[array['Sales','',c_m,c_a1 || ' ' || c_a2,'no'], array['Ops','','','','no']]));
		perform pg_temp.refused(r, 1, 'structured_rule', 'areas');
		if pg_temp.problem(r, 1) is distinct from 'only the area''s supervisor adds its agents; offer the agent to them' then
			raise exception 'B added to Sales by %: %', v_actor, r; end if;
	end loop;
	if pg_temp.p16_version('tables/areas/rows.csv') is distinct from v_rows then raise exception 'A refused save changed the file'; end if;

	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'i9b-agents-0104', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales','',c_m,c_a1,'yes'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'i9b-agents-0105', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales','',c_m,'','yes'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'i9b-agents-0106', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales','',c_m,'','yes'], array['Ops','','',c_a1 || ' ' || c_a2,'no']])), 1, 'saved');
	perform pg_temp.refused(pg_temp.save_rows(pg_temp.member(4), 'i9b-agents-0107', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales','',c_m,c_a1,'yes'], array['Ops','','',c_a2,'no']])), 1, 'structured_rule', 'areas');
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(2), 'i9b-agents-0108', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales','',c_m,c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	if pg_temp.i9b_live('["Sales"]') is distinct from v_id then raise exception 'The saves ended Sales''s consent'; end if;
end $$;

-- 3. Offering is refused for an area that is not there, an agent the company has not hired (or let go), one in the area
-- already, an area nobody supervises or the caller's own, and when the caller or the supervisor may not write the rows.
-- Requests of the wrong shape, and a caller who is not a member, are errors. Nothing is stored.
do $$
declare c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
begin
	perform pg_temp.i9b_refused(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Nowhere', c_a2)), 'gone', 'This area is gone.');
	perform pg_temp.i9b_refused(pg_temp.i9b_offer(4, jsonb_build_object('key', '["Sales","no"]'::jsonb, 'agent', c_a2)), 'gone');
	perform pg_temp.i9b_refused(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', '45400000-0000-4000-8000-0000000000a9')), 'agent',
		'Offer an agent the company has hired.');
	perform pg_temp.fx(format('update public.qorpera_profile_staff set employment_status = ''archived'' where staff_agent_id = %L', c_a2));
	perform pg_temp.i9b_refused(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', c_a2)), 'agent');
	perform pg_temp.fx(format('update public.qorpera_profile_staff set employment_status = ''active'' where staff_agent_id = %L', c_a2));
	perform pg_temp.i9b_refused(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', c_a1)), 'changed', 'The agent is in this area already.');
	perform pg_temp.i9b_refused(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Ops', c_a1)), 'supervisor',
		'Nobody supervises this area: add the agent yourself.');
	perform pg_temp.i9b_refused(pg_temp.i9b_offer(2, pg_temp.i9b_ask('Sales', c_a2)), 'supervisor',
		'You supervise this area: add the agent yourself.');
	perform pg_temp.i9b_refused(pg_temp.i9b_offer(3, pg_temp.i9b_ask('Sales', c_a2)), 'write',
		'You or they may not change this table''s rows.');
	update public.qorpera_profile_members set role = 'viewer'
	where profile_id = '63400000-0000-4000-8000-000000000010' and user_id = pg_temp.i9b_user(2);
	perform pg_temp.i9b_refused(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', c_a2)), 'write');
	update public.qorpera_profile_members set role = 'contributor'
	where profile_id = '63400000-0000-4000-8000-000000000010' and user_id = pg_temp.i9b_user(2);

	perform pg_temp.i9b_error(pg_temp.i9b_offer(4, '[]'), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_offer(4, '{}'), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_offer(4, '{"key":["Sales"]}'), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_offer(4, jsonb_build_object('key', '[]'::jsonb, 'agent', c_a2)), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_offer(4, jsonb_build_object('key', 'Sales', 'agent', c_a2)), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', c_a2) || '{"extra":1}'), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', 'agent-b')), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', '63400000-0000-4000-0000-0000000000a2')), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_offer(4, '{"key":["Sales"],"agent":1}'), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_offer(4, pg_temp.i9b_ask(repeat('x', 4100), c_a2)), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_offer(99, pg_temp.i9b_ask('Sales', c_a2)), '42501');
	if exists (select 1 from public.qorpera_interface_offers) then raise exception 'A refused offer was stored'; end if;
end $$;

-- 4. Member 4 takes A out of Sales (free) and offers B to member 2, and the owner offers A: two open offers of agents on
-- one area to one member, next to an offer of Sales's empty owner cell. The file is as it was; offered again, by anyone,
-- the open offer answers. Every member who reads the areas sees all three. A save that leaves Sales's agents as they are
-- settles neither agent's offer.
do $$
declare r jsonb; v_a uuid; v_b uuid; v_cell uuid; v_rows uuid; v_id uuid := pg_temp.i9b_live('["Sales"]');
	c_m constant text := '63400000-0000-4000-8000-000000000002'; c_n constant text := '63400000-0000-4000-8000-000000000004';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
begin
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'i9b-agents-0201', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales','',c_m,'','no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	v_rows := pg_temp.p16_version('tables/areas/rows.csv');
	r := pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', c_a2));
	v_b := pg_temp.i9b_made(r);
	if r ->> 'schema' is distinct from 'qorpera.interface-offer/v1' or (r -> 'offer') - 'id' - 'at' is distinct from jsonb_build_object(
			'table', '86400000-0000-4000-8000-000000000012', 'folder', 'tables/areas', 'key', '["Sales"]'::jsonb, 'column', 'agents',
			'from', c_n, 'was', null, 'to', c_m, 'state', 'open', 'agent', c_a2, 'closedAt', null)
		or r -> 'offer' ->> 'at' is null then
		raise exception 'B offered: %', r; end if;
	if (select o.supervision_id from public.qorpera_interface_offers o where o.id = v_b) is distinct from v_id then
		raise exception 'B''s offer is not under Sales''s consent'; end if;
	if pg_temp.p16_version('tables/areas/rows.csv') is distinct from v_rows then raise exception 'An offer changed the file'; end if;
	r := pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', c_a2));
	if r ->> 'ok' is distinct from 'true' or r ->> 'created' is distinct from 'false' or r -> 'offer' ->> 'id' is distinct from v_b::text then
		raise exception 'B offered twice: %', r; end if;
	r := pg_temp.i9b_offer(1, pg_temp.i9b_ask('Sales', c_a2));
	if r ->> 'created' is distinct from 'false' or r -> 'offer' ->> 'id' is distinct from v_b::text
		or r -> 'offer' ->> 'from' is distinct from c_n then
		raise exception 'B offered by another: %', r; end if;
	v_a := pg_temp.i9b_made(pg_temp.i9b_offer(1, pg_temp.i9b_ask('Sales', c_a1)));
	r := pg_temp.i9b_call(pg_temp.i9b_user(4), format('select public.qorpera_offer_interface_cell(%L, %L::jsonb)',
		'63400000-0000-4000-8000-000000000020', jsonb_build_object('table', '86400000-0000-4000-8000-000000000012',
			'key', '["Sales"]'::jsonb, 'column', 'owner', 'was', null, 'to', c_m)));
	v_cell := pg_temp.i9b_made(r);
	if r -> 'offer' -> 'agent' is distinct from 'null'::jsonb then raise exception 'A cell''s offer: %', r; end if;
	if (select count(*) from public.qorpera_interface_offers o where o.state = 'open') is distinct from 3 then
		raise exception 'Three offers: %', (select jsonb_agg(to_jsonb(o)) from public.qorpera_interface_offers o); end if;
	r := pg_temp.i9b_list(3);
	if (select array_agg(o ->> 'agent' order by o ->> 'agent') from jsonb_array_elements(r -> 'offers') o)
		is distinct from array[c_a1, c_a2, null] then
		raise exception 'The list: %', r; end if;
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'i9b-agents-0202', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales','',c_m,'','yes'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	if pg_temp.i9b_state(v_a) is distinct from 'open' or pg_temp.i9b_state(v_b) is distinct from 'open'
		or pg_temp.i9b_state(v_cell) is distinct from 'open' then
		raise exception 'A save that kept the agents: %, %, %', pg_temp.i9b_state(v_a), pg_temp.i9b_state(v_b), pg_temp.i9b_state(v_cell); end if;
end $$;

-- 5. Member 2 takes the owner cell and adds B (out of Ops) in one save: B's offer and the cell's accepted, A's open.
-- Only the member it names declines it; member 2 does. Member 4 offers A again; only its maker withdraws it. B, in
-- Sales now, is not offered again.
do $$
declare r jsonb; c_m constant text := '63400000-0000-4000-8000-000000000002';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
	v_a uuid := (select o.id from public.qorpera_interface_offers o where o.state = 'open' and o.agent_id = c_a1::uuid);
	v_b uuid := (select o.id from public.qorpera_interface_offers o where o.state = 'open' and o.agent_id = c_a2::uuid);
	v_cell uuid := (select o.id from public.qorpera_interface_offers o where o.state = 'open' and o.agent_id is null);
begin
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(2), 'i9b-agents-0301', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales',c_m,c_m,c_a2,'yes'], array['Ops','','','','no']])), 1, 'saved');
	if pg_temp.i9b_state(v_b) is distinct from 'accepted' or pg_temp.i9b_state(v_cell) is distinct from 'accepted'
		or pg_temp.i9b_state(v_a) is distinct from 'open' then
		raise exception 'Accepted: %, %, %', pg_temp.i9b_state(v_b), pg_temp.i9b_state(v_cell), pg_temp.i9b_state(v_a); end if;
	perform pg_temp.i9b_error(pg_temp.i9b_close(4, 'decline', v_a), '42501');
	perform pg_temp.i9b_error(pg_temp.i9b_close(1, 'decline', v_a), '42501');
	r := pg_temp.i9b_close(2, 'decline', v_a);
	if r ->> 'changed' is distinct from 'true' or r -> 'offer' ->> 'state' is distinct from 'declined'
		or r -> 'offer' ->> 'agent' is distinct from c_a1 or r -> 'offer' -> 'key' is distinct from 'null'::jsonb then
		raise exception 'A declined: %', r; end if;
	v_a := pg_temp.i9b_made(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', c_a1)));
	perform pg_temp.i9b_error(pg_temp.i9b_close(1, 'withdraw', v_a), '42501');
	perform pg_temp.i9b_error(pg_temp.i9b_close(2, 'withdraw', v_a), '42501');
	r := pg_temp.i9b_close(4, 'withdraw', v_a);
	if r ->> 'changed' is distinct from 'true' or r -> 'offer' ->> 'state' is distinct from 'withdrawn' then
		raise exception 'A withdrawn: %', r; end if;
	perform pg_temp.i9b_refused(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', c_a2)), 'changed');
end $$;

-- 6. An open offer lapses when its consent ends. Withdrawn: until member 2 consents again nobody supervises Sales, and
-- anyone adds its agents. Released: member 2 clears the cell. Gone: member 2 renames the area.
do $$
declare r jsonb; v_o uuid; v_id uuid := pg_temp.i9b_live('["Sales"]');
	c_m constant text := '63400000-0000-4000-8000-000000000002';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
begin
	v_o := pg_temp.i9b_made(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', c_a1)));
	r := pg_temp.i9b_call(pg_temp.i9b_user(2), format('select public.qorpera_withdraw_interface_supervision(%L, %L)',
		'63400000-0000-4000-8000-000000000020', v_id));
	if r -> 'supervision' ->> 'state' is distinct from 'withdrawn' or pg_temp.i9b_state(v_o) is distinct from 'lapsed' then
		raise exception 'Withdrawn: %, %', r, pg_temp.i9b_state(v_o); end if;
	perform pg_temp.i9b_refused(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', c_a1)), 'supervisor',
		'Nobody supervises this area: add the agent yourself.');
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'i9b-agents-0401', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales',c_m,c_m,c_a1 || ' ' || c_a2,'yes'], array['Ops','','','','no']])), 1, 'saved');
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'i9b-agents-0402', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales',c_m,c_m,c_a2,'yes'], array['Ops','','','','no']])), 1, 'saved');
	r := pg_temp.i9b_call(pg_temp.i9b_user(2), format('select public.qorpera_consent_interface_supervision(%L, %L::jsonb)',
		'63400000-0000-4000-8000-000000000020', '{"key":["Sales"]}'));
	if r ->> 'created' is distinct from 'true' then raise exception 'Consented again: %', r; end if;
	v_id := (r -> 'supervision' ->> 'id')::uuid;

	v_o := pg_temp.i9b_made(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', c_a1)));
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(2), 'i9b-agents-0403', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales',c_m,'',c_a2,'yes'], array['Ops','','','','no']])), 1, 'saved');
	if pg_temp.i9b_consent_state(v_id) is distinct from 'released' or pg_temp.i9b_state(v_o) is distinct from 'lapsed' then
		raise exception 'Released: %, %', pg_temp.i9b_consent_state(v_id), pg_temp.i9b_state(v_o); end if;

	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(2), 'i9b-agents-0404', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales',c_m,c_m,c_a2,'yes'], array['Ops','','','','no']])), 1, 'saved');
	v_id := pg_temp.i9b_live('["Sales"]');
	v_o := pg_temp.i9b_made(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', c_a1)));
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(2), 'i9b-agents-0405', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales EU',c_m,c_m,c_a2,'yes'], array['Ops','','','','no']])), 1, 'saved');
	if v_id is null or pg_temp.i9b_consent_state(v_id) is distinct from 'gone' or pg_temp.i9b_state(v_o) is distinct from 'lapsed' then
		raise exception 'Gone: %, %, %', v_id, pg_temp.i9b_consent_state(v_id), pg_temp.i9b_state(v_o); end if;
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(2), 'i9b-agents-0406', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales',c_m,c_m,c_a2,'yes'], array['Ops','','','','no']])), 1, 'saved');
	if pg_temp.i9b_live('["Sales"]') is null or exists (select 1 from public.qorpera_interface_offers o where o.state = 'open') then
		raise exception 'Sales back: %', (select jsonb_agg(to_jsonb(o)) from public.qorpera_interface_offers o where o.state = 'open'); end if;
end $$;

-- 7. A paused company: no offering; the supervisor still declines and a maker still withdraws. Then the pause is lifted.
do $$
declare r jsonb; v_a uuid; v_b uuid; c_m constant text := '63400000-0000-4000-8000-000000000002';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
begin
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'i9b-agents-0501', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales',c_m,c_m,'','yes'], array['Ops','','','','no']])), 1, 'saved');
	v_a := pg_temp.i9b_made(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', c_a1)));
	v_b := pg_temp.i9b_made(pg_temp.i9b_offer(1, pg_temp.i9b_ask('Sales', c_a2)));
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
	values ('63400000-0000-4000-8000-000000000010', pg_temp.i9b_user(1), 'I9b');
	perform pg_temp.i9b_error(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', c_a1)), '55000');
	r := pg_temp.i9b_close(2, 'decline', v_a);
	if r -> 'offer' ->> 'state' is distinct from 'declined' then raise exception 'Declined while paused: %', r; end if;
	r := pg_temp.i9b_close(1, 'withdraw', v_b);
	if r -> 'offer' ->> 'state' is distinct from 'withdrawn' then raise exception 'Withdrawn while paused: %', r; end if;
	perform pg_temp.fx('delete from public.qorpera_company_execution_pauses where profile_id = ''63400000-0000-4000-8000-000000000010''');
end $$;

-- 8. Member 2 leaves: their consent ends left and its open offer lapses. Sales then takes agents from anyone.
do $$
declare v_o uuid; v_id uuid := pg_temp.i9b_live('["Sales"]'); c_m constant text := '63400000-0000-4000-8000-000000000002';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1';
begin
	v_o := pg_temp.i9b_made(pg_temp.i9b_offer(4, pg_temp.i9b_ask('Sales', c_a1)));
	perform pg_temp.i9b_leave(2);
	if v_id is null or pg_temp.i9b_consent_state(v_id) is distinct from 'left' or pg_temp.i9b_state(v_o) is distinct from 'lapsed' then
		raise exception 'Left: %, %, %', v_id, pg_temp.i9b_consent_state(v_id), pg_temp.i9b_state(v_o); end if;
	if jsonb_array_length(pg_temp.i9b_list(4) -> 'offers') is distinct from 0 then raise exception 'Offers listed after leaving'; end if;
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'i9b-agents-0601', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales',c_m,c_m,c_a1,'yes'], array['Ops','','','','no']])), 1, 'saved');
end $$;
