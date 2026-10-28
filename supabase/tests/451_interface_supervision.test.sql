-- @fixture 865_folder_state_tables.test.sql until "-- 1. The port of parseTableRows"
-- Interfaces I9b, supervision consent (RUNTIME-INTERFACES.md §5.1 "Supervision", §6.1 rule 8): a member's own save that
-- puts them in an area's `supervisor` (a take, or an offer they accept) is their consent; a save that keeps the cell
-- makes none. It ends released (the cell names someone else or no one) or gone (the row deleted, or its key changed),
-- and the others it concerns are told. An agent takes and releases claimed cells as its area's supervisor while that
-- consent is live, and never changes an area's people. The members' calls are 452's; leaving and the notices 453's.

-- The areas' rows: area, owner, supervisor, agents, shared.
create function pg_temp.i9b_areas(p_rows text[][]) returns jsonb language sql as $$
	select pg_temp.rows(array['area','owner','supervisor','agents','shared'], p_rows)
$$;
-- An area's live consent (all nulls when it has none).
create function pg_temp.i9b_live(p_key jsonb) returns public.qorpera_interface_supervisions language sql as $$
	select * from public.qorpera_interface_supervisions s where s.state = 'live' and s.row_key = p_key
$$;
-- A consent's state. Read in a statement of its own, after the commit that changed it.
create function pg_temp.i9b_state(p_id uuid) returns text language sql as $$
	select s.state from public.qorpera_interface_supervisions s where s.id = p_id
$$;
-- Who was told a consent ended, by 634's user numbers (1 owner, 2 and 4 contributors, 3 viewer, 5 admin).
create function pg_temp.i9b_told(p_id uuid) returns integer[] language sql as $$
	select coalesce(array_agg(right(n.user_id::text, 12)::integer order by n.user_id), '{}')
	from public.qorpera_member_notifications n where n.kind = 'interface_supervision_ended' and n.dedupe_key = p_id::text
$$;
-- A call as a signed-in member, then as the service again.
create function pg_temp.i9b_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
	perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true);
	execute p_sql into r;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return r;
end $$;

-- 1. A member's take of an area's supervisor is their consent; saved again with the cell kept, still the one. Another
-- member takes another area and releases it: released, and the owners and admins are told, not the member.
do $$
declare m jsonb := pg_temp.member(2); n jsonb := pg_temp.member(4); v_sales uuid; v_ops uuid;
	c_m constant text := '63400000-0000-4000-8000-000000000002'; c_n constant text := '63400000-0000-4000-8000-000000000004';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
begin
	perform pg_temp.expect(pg_temp.save_rows(m, 'i9b-made-0001', 'QorperaOS/tables/areas/rows.csv', pg_temp.i9b_areas(array[
		array['Sales','',c_m,c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	v_sales := (pg_temp.i9b_live('["Sales"]')).id;
	if v_sales is null or (pg_temp.i9b_live('["Sales"]')).user_id is distinct from c_m::uuid
		or (pg_temp.i9b_live('["Sales"]')).table_id is distinct from '86400000-0000-4000-8000-000000000012'
		or (pg_temp.i9b_live('["Sales"]')).environment_id is distinct from '63400000-0000-4000-8000-000000000020'
		or (select count(*) from public.qorpera_interface_supervisions) is distinct from 1 then
		raise exception 'A take is a consent: %', (select jsonb_agg(to_jsonb(s)) from public.qorpera_interface_supervisions s); end if;
	perform pg_temp.expect(pg_temp.save_rows(m, 'i9b-made-0002', 'QorperaOS/tables/areas/rows.csv', pg_temp.i9b_areas(array[
		array['Sales','',c_m,c_a1,'yes'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	if (select count(*) from public.qorpera_interface_supervisions) is distinct from 1 or (pg_temp.i9b_live('["Sales"]')).id is distinct from v_sales then
		raise exception 'A save that keeps the cell made another consent'; end if;

	perform pg_temp.expect(pg_temp.save_rows(n, 'i9b-made-0003', 'QorperaOS/tables/areas/rows.csv', pg_temp.i9b_areas(array[
		array['Sales','',c_m,c_a1,'yes'], array['Ops','',c_n,c_a2,'no']])), 1, 'saved');
	v_ops := (pg_temp.i9b_live('["Ops"]')).id;
	if (pg_temp.i9b_live('["Ops"]')).user_id is distinct from c_n::uuid then raise exception 'The other member''s take'; end if;
	perform pg_temp.expect(pg_temp.save_rows(n, 'i9b-made-0004', 'QorperaOS/tables/areas/rows.csv', pg_temp.i9b_areas(array[
		array['Sales','',c_m,c_a1,'yes'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	if pg_temp.i9b_state(v_ops) is distinct from 'released' or pg_temp.i9b_state(v_sales) is distinct from 'live' then
		raise exception 'Released: %, %', pg_temp.i9b_state(v_ops), pg_temp.i9b_state(v_sales); end if;
	if (select s.ended_at is null or s.row_key is not null from public.qorpera_interface_supervisions s where s.id = v_ops) then
		raise exception 'A released consent keeps its key or has no end'; end if;
	if pg_temp.i9b_told(v_ops) is distinct from array[1,5] or pg_temp.i9b_told(v_sales) is distinct from '{}' then
		raise exception 'Told of a release: %, %', pg_temp.i9b_told(v_ops), pg_temp.i9b_told(v_sales); end if;
end $$;

-- 2. An agent's self (rule 8) is its area's supervisor while their consent is live, whoever asked for the run: it takes
-- and releases a claimed cell as them, and nobody else's. An agent whose area has no supervisor has no self. An agent
-- still never changes an area's people; its area's other cells are its own to change.
do $$
declare o jsonb := pg_temp.member(1); r jsonb; v_sales uuid := (pg_temp.i9b_live('["Sales"]')).id;
	c_m constant text := '63400000-0000-4000-8000-000000000002'; c_n constant text := '63400000-0000-4000-8000-000000000004';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
	g jsonb := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-000000000001');
	h jsonb := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a2', '63400000-0000-4000-8000-000000000001');
begin
	perform pg_temp.expect(pg_temp.commit(o, 'i9b-self-0001', jsonb_build_array(pg_temp.p16_folder(o, 'QorperaOS/tables/claims',
		jsonb_build_object('table.toml', pg_temp.claims('45100000-0000-4000-8000-000000000001'),
			'rows.csv', pg_temp.claim_rows(array[array['t1','',''], array['t2','','']]))))), 1, 'saved');
	perform pg_temp.expect(pg_temp.save_rows(g -> 'actor', 'i9b-self-0002', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_m,''], array['t2','','']])), 1, 'saved');
	r := pg_temp.save_rows(g -> 'actor', 'i9b-self-0003', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_m,''], array['t2',c_n,'']]));
	perform pg_temp.refused(r, 1, 'structured_rule', 'claim');
	if pg_temp.problem(r, 1) is distinct from 'nobody assigns anybody: you take an empty owner or release your own' then
		raise exception 'An agent assigns another member: %', r; end if;
	r := pg_temp.save_rows(h -> 'actor', 'i9b-self-0004', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.claim_rows(array[array['t1','',''], array['t2','','']]));
	perform pg_temp.refused(r, 1, 'structured_rule', 'claim');
	if pg_temp.problem(r, 1) is distinct from 'nobody assigns anybody: only the member named changes owner' then
		raise exception 'An agent with no supervisor: %', r; end if;
	perform pg_temp.expect(pg_temp.save_rows(g -> 'actor', 'i9b-self-0005', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.claim_rows(array[array['t1','',c_n], array['t2','','']])), 1, 'saved');

	r := pg_temp.save_rows(g -> 'actor', 'i9b-self-0006', 'QorperaOS/tables/areas/rows.csv', pg_temp.i9b_areas(array[
		array['Sales',c_m,c_m,c_a1,'yes'], array['Ops','','',c_a2,'no']]));
	perform pg_temp.refused(r, 1, 'structured_rule', 'claim');
	if pg_temp.problem(r, 1) is distinct from 'an agent never changes an area''s owner, supervisor or agents' then
		raise exception 'An agent changes its area''s people: %', r; end if;
	perform pg_temp.refused(pg_temp.save_rows(g -> 'actor', 'i9b-self-0007', 'QorperaOS/tables/areas/rows.csv', pg_temp.i9b_areas(array[
		array['Sales','','',c_a1,'yes'], array['Ops','','',c_a2,'no']])), 1, 'structured_rule', 'claim');
	perform pg_temp.expect(pg_temp.save_rows(g -> 'actor', 'i9b-self-0008', 'QorperaOS/tables/areas/rows.csv', pg_temp.i9b_areas(array[
		array['Sales','',c_m,c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	if pg_temp.i9b_state(v_sales) is distinct from 'live' or (select count(*) from public.qorpera_interface_supervisions) is distinct from 2 then
		raise exception 'An agent''s save changed the consents'; end if;
end $$;

-- 3. An area's supervisor offered (I9c) and taken: the taker's save is their consent, and the giver's ends released.
do $$
declare n jsonb := pg_temp.member(4); r jsonb; v_sales uuid := (pg_temp.i9b_live('["Sales"]')).id;
	c_m constant text := '63400000-0000-4000-8000-000000000002'; c_n constant text := '63400000-0000-4000-8000-000000000004';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
begin
	r := pg_temp.i9b_call(c_m::uuid, format('select public.qorpera_offer_interface_cell(%L, %L::jsonb)',
		'63400000-0000-4000-8000-000000000020', jsonb_build_object('table', '86400000-0000-4000-8000-000000000012',
			'key', '["Sales"]'::jsonb, 'column', 'supervisor', 'was', c_m, 'to', c_n)));
	if r ->> 'ok' is distinct from 'true' or r -> 'offer' ->> 'state' is distinct from 'open' then raise exception 'An area''s supervisor offered: %', r; end if;
	perform pg_temp.expect(pg_temp.save_rows(n, 'i9b-offer-0001', 'QorperaOS/tables/areas/rows.csv', pg_temp.i9b_areas(array[
		array['Sales','',c_n,c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	if (select o.state from public.qorpera_interface_offers o where o.id = (r -> 'offer' ->> 'id')::uuid) is distinct from 'accepted'
		or pg_temp.i9b_state(v_sales) is distinct from 'released' or (pg_temp.i9b_live('["Sales"]')).user_id is distinct from c_n::uuid then
		raise exception 'An offer taken: %', (select jsonb_agg(to_jsonb(s)) from public.qorpera_interface_supervisions s); end if;
	if pg_temp.i9b_told(v_sales) is distinct from array[1,2,5] then raise exception 'Told of a handover: %', pg_temp.i9b_told(v_sales); end if;
end $$;

-- 4. Gone: the row renamed by its supervisor's save (the renamed row's consent is made, and nobody is told), deleted, or
-- its key changed by the definition. A definition change that keeps the keys keeps the consents. Keyed as before, the
-- cell names its member again but no save of theirs put them there: no consent, and a save that keeps it makes none.
do $$
declare n jsonb := pg_temp.member(4); o jsonb := pg_temp.member(1); v_old uuid := (pg_temp.i9b_live('["Sales"]')).id;
	v_new uuid; v_areas jsonb := pg_temp.tbl('86400000-0000-4000-8000-000000000012', 'areas');
	c_n constant text := '63400000-0000-4000-8000-000000000004';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
begin
	perform pg_temp.expect(pg_temp.save_rows(n, 'i9b-gone-0001', 'QorperaOS/tables/areas/rows.csv', pg_temp.i9b_areas(array[
		array['Sales EU','',c_n,c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	v_new := (pg_temp.i9b_live('["Sales EU"]')).id;
	if pg_temp.i9b_state(v_old) is distinct from 'gone' or v_new is null or pg_temp.i9b_told(v_old) is distinct from '{}' then
		raise exception 'Renamed: %, %, %', pg_temp.i9b_state(v_old), v_new, pg_temp.i9b_told(v_old); end if;
	perform pg_temp.expect(pg_temp.commit(o, 'i9b-gone-0002', jsonb_build_array(
		pg_temp.p16_write(o, 'QorperaOS/tables/areas/table.toml', v_areas || '{"name":"Our areas"}'))), 1, 'saved');
	if pg_temp.i9b_state(v_new) is distinct from 'live' then raise exception 'A new name ended a consent'; end if;
	perform pg_temp.expect(pg_temp.save_rows(n, 'i9b-gone-0003', 'QorperaOS/tables/areas/rows.csv', pg_temp.i9b_areas(array[
		array['Ops','','',c_a2,'no']])), 1, 'saved');
	if pg_temp.i9b_state(v_new) is distinct from 'gone' or pg_temp.i9b_told(v_new) is distinct from array[1,5] then
		raise exception 'Deleted: %, %', pg_temp.i9b_state(v_new), pg_temp.i9b_told(v_new); end if;

	perform pg_temp.expect(pg_temp.save_rows(n, 'i9b-gone-0004', 'QorperaOS/tables/areas/rows.csv', pg_temp.i9b_areas(array[
		array['Sales','',c_n,c_a1,'yes'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	v_new := (pg_temp.i9b_live('["Sales"]')).id;
	perform pg_temp.expect(pg_temp.commit(o, 'i9b-gone-0005', jsonb_build_array(
		pg_temp.p16_write(o, 'QorperaOS/tables/areas/table.toml', v_areas || '{"key":["area","shared"]}'))), 1, 'saved');
	if v_new is null or pg_temp.i9b_state(v_new) is distinct from 'gone' or pg_temp.i9b_told(v_new) is distinct from array[4,5] then
		raise exception 'A new key: %, %, %', v_new, pg_temp.i9b_state(v_new), pg_temp.i9b_told(v_new); end if;
	perform pg_temp.expect(pg_temp.commit(o, 'i9b-gone-0006', jsonb_build_array(
		pg_temp.p16_write(o, 'QorperaOS/tables/areas/table.toml', v_areas))), 1, 'saved');
	perform pg_temp.expect(pg_temp.save_rows(n, 'i9b-gone-0007', 'QorperaOS/tables/areas/rows.csv', pg_temp.i9b_areas(array[
		array['Sales','',c_n,c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	if exists (select 1 from public.qorpera_interface_supervisions s where s.state = 'live') then
		raise exception 'A save that keeps a cell made a consent'; end if;
end $$;

-- 5. A cell with no live consent decides nothing: its area's agent has no self.
do $$
declare r jsonb; c_n constant text := '63400000-0000-4000-8000-000000000004';
	g jsonb := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-000000000004');
begin
	r := pg_temp.save_rows(g -> 'actor', 'i9b-none-0001', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_n,c_n], array['t2','','']]));
	perform pg_temp.refused(r, 1, 'structured_rule', 'claim');
	if pg_temp.problem(r, 1) is distinct from 'nobody assigns anybody: only the member named changes owner' then
		raise exception 'An agent under a cell with no consent: %', r; end if;
end $$;
