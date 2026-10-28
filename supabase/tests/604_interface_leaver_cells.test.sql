-- @fixture 865_folder_state_tables.test.sql until "-- 1. The port of parseTableRows"
-- Interfaces C6d, a member's leaving and their cells (QORPERA-REBUILD-SCOPE-AMENDMENT-2026-10-17.md §2): a member who
-- leaves keeps every cell that names them, and their consents end left. Such a cell counts as empty for the members who
-- stay: a member takes it (rule 8), offers it, and accepts an open offer of it. Release stays the holder's own: nobody
-- clears it, and nobody puts another member in it. A current member's cell stays theirs; an agent never takes a
-- leaver's cell for its supervisor. Membership is per company, and a member who rejoins holds their cells again.
-- Members leave by the real call (qorpera_leave_hosted_profile, as 664); the second company and the rejoin are rows
-- written directly, as 647 and 634 write them. The last part walks the live check's path (C6-9) end to end.

-- 634's users by number (1 owner, 2 and 4 contributors, 3 viewer, 5 admin) as the cells hold them; 0 is an empty cell.
create function pg_temp.c6d_id(p_n integer) returns text language sql immutable as $$
	select case when p_n = 0 then '' else '63400000-0000-4000-8000-' || lpad(p_n::text, 12, '0') end
$$;
-- The claims table's rows t1..t4, by their owners.
create function pg_temp.c6d_claims(p_owners integer[]) returns jsonb language sql as $$
	select pg_temp.claim_rows(array[array['t1',pg_temp.c6d_id(p_owners[1]),''], array['t2',pg_temp.c6d_id(p_owners[2]),''],
		array['t3',pg_temp.c6d_id(p_owners[3]),''], array['t4',pg_temp.c6d_id(p_owners[4]),'']])
$$;
-- The areas' rows: Sales (its owner, agent A) and Ops (its supervisor, agent B).
create function pg_temp.c6d_areas(p_sales_owner integer, p_ops_supervisor integer) returns jsonb language sql as $$
	select pg_temp.rows(array['area','owner','supervisor','agents','shared'], array[
		array['Sales',pg_temp.c6d_id(p_sales_owner),'','63400000-0000-4000-8000-0000000000a1','no'],
		array['Ops','',pg_temp.c6d_id(p_ops_supervisor),'63400000-0000-4000-8000-0000000000a2','no']])
$$;
-- A stored cell, as the rows type it (null when empty).
create function pg_temp.c6d_cell(p_folder text, p_key text, p_column text) returns text language sql as $$
	select r.value -> 'values' ->> p_column from jsonb_array_elements(public.qorpera_interface_rows(
		public.qorpera_interface_stored('63400000-0000-4000-8000-000000000020', public.qorpera_folder_key(p_folder || '/table.toml')),
		public.qorpera_interface_stored('63400000-0000-4000-8000-000000000020', public.qorpera_folder_key(p_folder || '/rows.csv')))
		-> 'rows') r
	where r.value -> 'key' = jsonb_build_array(p_key)
$$;
-- A member's consents' states, and who an area's live consent is.
create function pg_temp.c6d_consents(p_n integer) returns text language sql as $$
	select string_agg(s.state, ',' order by s.state) from public.qorpera_interface_supervisions s where s.user_id::text = pg_temp.c6d_id(p_n)
$$;
create function pg_temp.c6d_live(p_area text) returns text language sql as $$
	select s.user_id::text from public.qorpera_interface_supervisions s where s.state = 'live' and s.row_key = jsonb_build_array(p_area)
$$;
-- A member offers a cell as read (was) to another member, signed in, then the service again.
create function pg_temp.c6d_offer(p_by integer, p_table uuid, p_key text, p_column text, p_was integer, p_to integer)
returns jsonb language plpgsql as $$
declare r jsonb;
begin
	perform pg_temp.path_claims('authenticated', pg_temp.c6d_id(p_by)::uuid);
	r := public.qorpera_offer_interface_cell('63400000-0000-4000-8000-000000000020', jsonb_build_object('table', p_table,
		'key', jsonb_build_array(p_key), 'column', p_column, 'was', nullif(pg_temp.c6d_id(p_was), ''), 'to', pg_temp.c6d_id(p_to)));
	perform pg_temp.path_claims('service_role');
	return r;
end $$;
-- A save refused by the claim rule, with this problem.
create function pg_temp.c6d_refused(p_result jsonb, p_problem text) returns void language plpgsql as $$
begin
	perform pg_temp.refused(p_result, 1, 'structured_rule', 'claim');
	if pg_temp.problem(p_result, 1) is distinct from p_problem then
		raise exception 'Expected the problem "%", got %', p_problem, p_result using errcode = 'QTF01'; end if;
end $$;

-- 1. Member 2 takes Sales's owner and Ops's supervisor (a live consent), and t1 and t4 of a claims table; member 4
-- takes t3. Member 2 leaves: every cell still names them, and their consent ended left.
do $$
declare o jsonb := pg_temp.member(1); c_m constant text := pg_temp.c6d_id(2);
begin
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(2), 'c6d-setup-0001', 'QorperaOS/tables/areas/rows.csv',
		pg_temp.c6d_areas(2, 2)), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(o, 'c6d-setup-0002', jsonb_build_array(pg_temp.p16_folder(o, 'QorperaOS/tables/claims',
		jsonb_build_object('table.toml', pg_temp.claims('60400000-0000-4000-8000-000000000001'),
			'rows.csv', pg_temp.c6d_claims(array[0,0,0,0]))))), 1, 'saved');
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(2), 'c6d-setup-0003', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.c6d_claims(array[2,0,0,2])), 1, 'saved');
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'c6d-setup-0004', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.c6d_claims(array[2,0,4,2])), 1, 'saved');
	if pg_temp.c6d_live('Ops') is distinct from c_m then raise exception 'Ops has no consent of member 2''s'; end if;

	perform pg_temp.path_claims('authenticated', c_m::uuid);
	if public.qorpera_leave_hosted_profile('63400000-0000-4000-8000-000000000010') <> 'true'::jsonb then
		raise exception 'Leaving must return true'; end if;
	perform pg_temp.path_claims('service_role');
	if exists (select 1 from public.qorpera_profile_members where profile_id = '63400000-0000-4000-8000-000000000010'
		and user_id = c_m::uuid) then raise exception 'Member 2 is still a member'; end if;
	if pg_temp.c6d_cell('QorperaOS/tables/areas', 'Sales', 'owner') is distinct from c_m or pg_temp.c6d_cell('QorperaOS/tables/areas', 'Ops', 'supervisor') is distinct from c_m
		or pg_temp.c6d_cell('QorperaOS/tables/claims', 't1', 'owner') is distinct from c_m or pg_temp.c6d_cell('QorperaOS/tables/claims', 't4', 'owner') is distinct from c_m then
		raise exception 'Leaving changed a cell: %', public.qorpera_interface_area_rows('63400000-0000-4000-8000-000000000020'); end if;
	if pg_temp.c6d_consents(2) is distinct from 'left' or pg_temp.c6d_live('Ops') is not null then
		raise exception 'Member 2''s consent: %', pg_temp.c6d_consents(2); end if;
end $$;

-- 2. Member 4 takes the leaver's Sales owner, as an empty cell.
do $$
begin
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'c6d-take-0001', 'QorperaOS/tables/areas/rows.csv',
		pg_temp.c6d_areas(4, 2)), 1, 'saved');
	if pg_temp.c6d_cell('QorperaOS/tables/areas', 'Sales', 'owner') is distinct from pg_temp.c6d_id(4) then raise exception 'Member 4''s take'; end if;
end $$;

-- 3. Member 4 offers the leaver's Ops supervisor to member 5, who accepts it by their save: the offer is accepted, and
-- the save is member 5's consent. Member 2's stays left.
do $$
declare r jsonb := pg_temp.c6d_offer(4, '86400000-0000-4000-8000-000000000012', 'Ops', 'supervisor', 2, 5);
begin
	if r ->> 'ok' is distinct from 'true' or r ->> 'created' is distinct from 'true' or r -> 'offer' ->> 'state' is distinct from 'open'
		or r -> 'offer' ->> 'from' is distinct from pg_temp.c6d_id(4) or r -> 'offer' ->> 'was' is distinct from pg_temp.c6d_id(2)
		or r -> 'offer' ->> 'to' is distinct from pg_temp.c6d_id(5) then
		raise exception 'An offer of a leaver''s cell: %', r; end if;
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(5), 'c6d-offer-0001', 'QorperaOS/tables/areas/rows.csv',
		pg_temp.c6d_areas(4, 5)), 1, 'saved');
	if (select o.state from public.qorpera_interface_offers o where o.id = (r -> 'offer' ->> 'id')::uuid) is distinct from 'accepted' then
		raise exception 'The offer after member 5''s save: %', (select to_jsonb(o) from public.qorpera_interface_offers o
			where o.id = (r -> 'offer' ->> 'id')::uuid); end if;
	if pg_temp.c6d_live('Ops') is distinct from pg_temp.c6d_id(5) or pg_temp.c6d_consents(2) is distinct from 'left' then
		raise exception 'The consents after the accept: %', (select jsonb_agg(to_jsonb(s)) from public.qorpera_interface_supervisions s); end if;
end $$;

-- 4. Nobody clears a leaver's cell (release is the holder's own), and nobody puts another member in it.
do $$
begin
	perform pg_temp.c6d_refused(pg_temp.save_rows(pg_temp.member(4), 'c6d-clear-0001', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.c6d_claims(array[0,0,4,2])), 'nobody assigns anybody: you take an empty owner or release your own');
	perform pg_temp.c6d_refused(pg_temp.save_rows(pg_temp.member(4), 'c6d-clear-0002', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.c6d_claims(array[5,0,4,2])), 'nobody assigns anybody: you take an empty owner or release your own');
	if pg_temp.c6d_cell('QorperaOS/tables/claims', 't1', 'owner') is distinct from pg_temp.c6d_id(2) then raise exception 'A refused save changed t1'; end if;
end $$;

-- 5. A current member's cell stays theirs: member 5 neither takes member 4's Sales owner nor offers it.
do $$
declare r jsonb;
begin
	perform pg_temp.c6d_refused(pg_temp.save_rows(pg_temp.member(5), 'c6d-held-0001', 'QorperaOS/tables/areas/rows.csv',
		pg_temp.c6d_areas(5, 5)), 'nobody assigns anybody: you take an empty owner or release your own');
	perform pg_temp.c6d_refused(pg_temp.save_rows(pg_temp.member(5), 'c6d-held-0002', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.c6d_claims(array[2,0,5,2])), 'nobody assigns anybody: you take an empty owner or release your own');
	r := pg_temp.c6d_offer(5, '86400000-0000-4000-8000-000000000012', 'Sales', 'owner', 4, 1);
	if r ->> 'ok' is distinct from 'false' or r ->> 'reason' is distinct from 'not_yours' then
		raise exception 'An offer of a current member''s cell: %', r; end if;
end $$;

-- 6. Agent B, in Ops, acts as member 5 (Ops's supervisor, consent live): it takes the empty t2 for them, but not the
-- leaver's t1.
do $$
declare g jsonb := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a2', '63400000-0000-4000-8000-000000000001');
begin
	perform pg_temp.expect(pg_temp.save_rows(g -> 'actor', 'c6d-agent-0001', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.c6d_claims(array[2,5,4,2])), 1, 'saved');
	perform pg_temp.c6d_refused(pg_temp.save_rows(g -> 'actor', 'c6d-agent-0002', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.c6d_claims(array[5,5,4,2])), 'nobody assigns anybody: you take an empty owner or release your own');
	if pg_temp.c6d_cell('QorperaOS/tables/claims', 't1', 'owner') is distinct from pg_temp.c6d_id(2) then raise exception 'The agent changed t1'; end if;
end $$;

-- 7. Companies stay apart. Member 4 joins 647's other company and leaves it: their t3 stays closed to member 5. Member
-- 2 joins that company: their t4 in this one is still a leaver's, and the owner takes it.
do $$
begin
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
		('64700000-0000-4000-8000-000000000011', pg_temp.c6d_id(4)::uuid, 'authority-other@example.test', 'Other', 'contributor'),
		('64700000-0000-4000-8000-000000000011', pg_temp.c6d_id(2)::uuid, 'authority-member@example.test', 'Member', 'contributor');
	delete from public.qorpera_profile_members where profile_id = '64700000-0000-4000-8000-000000000011' and user_id = pg_temp.c6d_id(4)::uuid;
	perform pg_temp.c6d_refused(pg_temp.save_rows(pg_temp.member(5), 'c6d-apart-0001', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.c6d_claims(array[2,5,5,2])), 'nobody assigns anybody: you take an empty owner or release your own');
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(1), 'c6d-apart-0002', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.c6d_claims(array[2,5,4,1])), 1, 'saved');
end $$;

-- 8. Member 2 rejoins: t1 is theirs again. Member 4 neither takes it nor offers it; member 2 releases it.
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000002', 'authority-member@example.test', 'Member', 'contributor');
do $$
declare r jsonb;
begin
	perform pg_temp.c6d_refused(pg_temp.save_rows(pg_temp.member(4), 'c6d-back-0001', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.c6d_claims(array[4,5,4,1])), 'nobody assigns anybody: you take an empty owner or release your own');
	r := pg_temp.c6d_offer(4, '60400000-0000-4000-8000-000000000001', 't1', 'owner', 2, 5);
	if r ->> 'ok' is distinct from 'false' or r ->> 'reason' is distinct from 'not_yours' then
		raise exception 'An offer of a rejoined member''s cell: %', r; end if;
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(2), 'c6d-back-0002', 'QorperaOS/tables/claims/rows.csv',
		pg_temp.c6d_claims(array[0,5,4,1])), 1, 'saved');
end $$;

-- 9. The walk the live check takes (C6-9), end to end: member 4 adds Desk, takes its supervisor (their consent), and
-- adds agent B to it from Ops; member 1, who isn't Desk's supervisor, may not add it and offers agent A instead. Member
-- 4 leaves: their consent ended left and the offer under it lapsed, while Desk still names them as its owner and
-- supervisor, with agent B. Member 1 takes both cells; member 5 doesn't take member 1's.
create function pg_temp.c6d_desk(p_owner integer, p_supervisor integer, p_ops text, p_desk text) returns jsonb language sql as $$
	select pg_temp.rows(array['area','owner','supervisor','agents','shared'], array[
		array['Sales',pg_temp.c6d_id(4),'','63400000-0000-4000-8000-0000000000a1','no'],
		array['Ops','',pg_temp.c6d_id(5),p_ops,'no'],
		array['Desk',pg_temp.c6d_id(p_owner),pg_temp.c6d_id(p_supervisor),p_desk,'no']])
$$;
do $$
declare c_b constant text := '63400000-0000-4000-8000-0000000000a2'; c_m constant text := pg_temp.c6d_id(4);
	r jsonb; v_offer uuid;
begin
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'c6d-walk-0001', 'QorperaOS/tables/areas/rows.csv',
		pg_temp.c6d_desk(4, 0, c_b, '')), 1, 'saved');
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'c6d-walk-0002', 'QorperaOS/tables/areas/rows.csv',
		pg_temp.c6d_desk(4, 4, c_b, '')), 1, 'saved');
	if pg_temp.c6d_live('Desk') is distinct from c_m then raise exception 'Desk has no consent of member 4''s'; end if;
	r := pg_temp.save_rows(pg_temp.member(1), 'c6d-walk-0003', 'QorperaOS/tables/areas/rows.csv', pg_temp.c6d_desk(4, 4, '', c_b));
	perform pg_temp.refused(r, 1, 'structured_rule', 'areas');
	if pg_temp.problem(r, 1) is distinct from 'only the area''s supervisor adds its agents; offer the agent to them' then
		raise exception 'Member 1 adding an agent to Desk: %', r; end if;
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(4), 'c6d-walk-0004', 'QorperaOS/tables/areas/rows.csv',
		pg_temp.c6d_desk(4, 4, '', c_b)), 1, 'saved');
	perform pg_temp.path_claims('authenticated', pg_temp.c6d_id(1)::uuid);
	r := public.qorpera_offer_interface_agent('63400000-0000-4000-8000-000000000020', jsonb_build_object(
		'key', jsonb_build_array('Desk'), 'agent', '63400000-0000-4000-8000-0000000000a1'));
	perform pg_temp.path_claims('service_role');
	if r ->> 'ok' is distinct from 'true' or r -> 'offer' ->> 'state' is distinct from 'open'
		or r -> 'offer' ->> 'to' is distinct from c_m then raise exception 'Member 1''s offer of agent A: %', r; end if;
	v_offer := (r -> 'offer' ->> 'id')::uuid;

	perform pg_temp.path_claims('authenticated', c_m::uuid);
	if public.qorpera_leave_hosted_profile('63400000-0000-4000-8000-000000000010') <> 'true'::jsonb then
		raise exception 'Leaving must return true'; end if;
	perform pg_temp.path_claims('service_role');
	if pg_temp.c6d_consents(4) is distinct from 'left' or pg_temp.c6d_live('Desk') is not null then
		raise exception 'Member 4''s consent: %', pg_temp.c6d_consents(4); end if;
	if (select o.state from public.qorpera_interface_offers o where o.id = v_offer) is distinct from 'lapsed' then
		raise exception 'The offer after member 4 left: %', (select to_jsonb(o) from public.qorpera_interface_offers o
			where o.id = v_offer); end if;
	if pg_temp.c6d_cell('QorperaOS/tables/areas', 'Desk', 'owner') is distinct from c_m
		or pg_temp.c6d_cell('QorperaOS/tables/areas', 'Desk', 'supervisor') is distinct from c_m
		or pg_temp.c6d_cell('QorperaOS/tables/areas', 'Desk', 'agents')::jsonb is distinct from jsonb_build_array(c_b) then
		raise exception 'Leaving changed Desk: %', public.qorpera_interface_area_rows('63400000-0000-4000-8000-000000000020'); end if;

	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(1), 'c6d-walk-0005', 'QorperaOS/tables/areas/rows.csv',
		pg_temp.c6d_desk(1, 1, '', c_b)), 1, 'saved');
	if pg_temp.c6d_live('Desk') is distinct from pg_temp.c6d_id(1) then raise exception 'Member 1''s take of Desk''s supervisor'; end if;
	perform pg_temp.c6d_refused(pg_temp.save_rows(pg_temp.member(5), 'c6d-walk-0006', 'QorperaOS/tables/areas/rows.csv',
		pg_temp.c6d_desk(5, 1, '', c_b)), 'nobody assigns anybody: you take an empty owner or release your own');
end $$;
