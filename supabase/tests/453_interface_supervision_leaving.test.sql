-- @fixture 865_folder_state_tables.test.sql until "-- 1. The port of parseTableRows"
-- Interfaces I9b, a consent's end told, and a member's leaving (RUNTIME-INTERFACES.md §5.1 "Supervision"): the
-- platform clearing a supervisor's cell ends their consent released, and everyone it concerns is told (the company's
-- owners and admins, the supervisor, the area's owner; never a member who may not read the areas, nor one who left).
-- A member who leaves ends their consents (left): their cells keep naming them until the platform clears them, and
-- their areas' agents act for no one. A member with no consents leaving changes nothing. The notice once per consent,
-- and without a key too long to carry.

-- The areas' rows: area, owner, supervisor, agents, shared.
create function pg_temp.i9b_areas(p_rows text[][]) returns jsonb language sql as $$
	select pg_temp.rows(array['area','owner','supervisor','agents','shared'], p_rows)
$$;
-- An area's live consent's id, or null.
create function pg_temp.i9b_live(p_key jsonb) returns uuid language sql as $$
	select s.id from public.qorpera_interface_supervisions s where s.state = 'live' and s.row_key = p_key
$$;
-- A consent's state. Read in a statement of its own, after the change that ended it.
create function pg_temp.i9b_state(p_id uuid) returns text language sql as $$
	select s.state from public.qorpera_interface_supervisions s where s.id = p_id
$$;
-- Who was told a consent ended, by 634's user numbers (1 owner, 2 and 4 contributors, 3 viewer, 5 admin).
create function pg_temp.i9b_told(p_id uuid) returns integer[] language sql as $$
	select coalesce(array_agg(right(n.user_id::text, 12)::integer order by n.user_id), '{}')
	from public.qorpera_member_notifications n where n.kind = 'interface_supervision_ended' and n.dedupe_key = p_id::text
$$;
-- 634's member leaving the company.
create function pg_temp.i9b_leave(p_n integer) returns void language sql as $$
	delete from public.qorpera_profile_members where profile_id = '63400000-0000-4000-8000-000000000010'
		and user_id = ('63400000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;

-- 1. Sales: member 4 takes its owner, member 2 its supervisor (agent A in it). The platform clears the supervisor:
-- released, by no one, and the owner, the admin, the supervisor and the area's owner are told; the viewer is not.
do $$
declare m jsonb := pg_temp.member(2); n jsonb := pg_temp.member(4); o jsonb := pg_temp.member(1); v_id uuid; v_subject jsonb;
	c_m constant text := '63400000-0000-4000-8000-000000000002'; c_n constant text := '63400000-0000-4000-8000-000000000004';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
begin
	perform pg_temp.expect(pg_temp.save_rows(m, 'i9b-left-0001', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales','',c_m,c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	perform pg_temp.expect(pg_temp.save_rows(n, 'i9b-left-0002', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales',c_n,c_m,c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(o, 'i9b-left-0003', jsonb_build_array(pg_temp.p16_folder(o, 'tables/claims',
		jsonb_build_object('table.toml', pg_temp.claims('45300000-0000-4000-8000-000000000001'),
			'rows.csv', pg_temp.claim_rows(array[array['t1','',''], array['t2','','']]))))), 1, 'saved');
	v_id := pg_temp.i9b_live('["Sales"]');
	if v_id is null or (select count(*) from public.qorpera_interface_supervisions) is distinct from 1 then
		raise exception 'The supervisor''s take: %', (select jsonb_agg(to_jsonb(s)) from public.qorpera_interface_supervisions s); end if;

	perform pg_temp.expect(pg_temp.save_rows('{"kind":"platform"}', 'i9b-left-0004', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales',c_n,'',c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	if pg_temp.i9b_state(v_id) is distinct from 'released' or pg_temp.i9b_told(v_id) is distinct from array[1,2,4,5] then
		raise exception 'Cleared by the platform: %, %', pg_temp.i9b_state(v_id), pg_temp.i9b_told(v_id); end if;
	select n2.subject into v_subject from public.qorpera_member_notifications n2
	where n2.kind = 'interface_supervision_ended' and n2.dedupe_key = v_id::text and n2.user_id = c_n::uuid;
	if v_subject - 'at' is distinct from jsonb_build_object('schema', 'qorpera.member-notification.interface-supervision-ended/v1',
		'supervisionId', v_id, 'tableId', '86400000-0000-4000-8000-000000000012', 'key', '["Sales"]'::jsonb,
		'supervisorUserId', c_m, 'reason', 'released', 'byUserId', null)
		or jsonb_typeof(v_subject -> 'at') is distinct from 'string' then
		raise exception 'The notice: %', v_subject; end if;
	if exists (select 1 from public.qorpera_member_notifications n2 where n2.kind = 'interface_supervision_ended'
		and n2.dedupe_key = v_id::text and n2.subject is distinct from v_subject) then
		raise exception 'The notices differ by member'; end if;
end $$;

-- 2. Member 2 takes the supervisor again, then leaves: left, and the owner, the admin and the area's owner are told.
-- The cell keeps naming them; the area's agent acts for no one; the consent is no longer listed.
do $$
declare m jsonb := pg_temp.member(2); r jsonb; v_id uuid;
	c_m constant text := '63400000-0000-4000-8000-000000000002'; c_n constant text := '63400000-0000-4000-8000-000000000004';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
	g jsonb := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-000000000001');
begin
	perform pg_temp.expect(pg_temp.save_rows(m, 'i9b-left-0005', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales',c_n,c_m,c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	v_id := pg_temp.i9b_live('["Sales"]');
	if v_id is null then raise exception 'Taken again, no consent'; end if;
	perform pg_temp.i9b_leave(2);
	if pg_temp.i9b_state(v_id) is distinct from 'left' or pg_temp.i9b_told(v_id) is distinct from array[1,4,5] then
		raise exception 'Left: %, %', pg_temp.i9b_state(v_id), pg_temp.i9b_told(v_id); end if;
	if (select s.ended_at is null or s.row_key is not null from public.qorpera_interface_supervisions s where s.id = v_id)
		or (select n2.subject ->> 'reason' || coalesce(n2.subject ->> 'byUserId', '-') from public.qorpera_member_notifications n2
			where n2.dedupe_key = v_id::text and n2.user_id = c_n::uuid) is distinct from 'left-' then
		raise exception 'A left consent: %', (select to_jsonb(s) from public.qorpera_interface_supervisions s where s.id = v_id); end if;
	if (select a.value -> 'values' ->> 'supervisor' from jsonb_array_elements(public.qorpera_interface_area_rows(
		'63400000-0000-4000-8000-000000000020')) a where a.value -> 'key' = '["Sales"]') is distinct from c_m then
		raise exception 'Leaving changed the cell'; end if;
	r := pg_temp.save_rows(g -> 'actor', 'i9b-left-0006', 'tables/claims/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_m,''], array['t2','','']]));
	perform pg_temp.refused(r, 1, 'structured_rule', 'claim');
	if pg_temp.problem(r, 1) is distinct from 'nobody assigns anybody: only the member named changes owner' then
		raise exception 'An agent under a member who left: %', r; end if;
	perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', c_n)::text, true);
	r := public.qorpera_member_interface_supervisions('63400000-0000-4000-8000-000000000020');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	if jsonb_array_length(r -> 'supervisions') is distinct from 0 then raise exception 'A left consent is listed: %', r; end if;
end $$;

-- 3. The platform clears the leaver's cell; the owner takes it. Member 4, with no consents, leaves: nothing changes.
-- The owner releases it: the admin is told, not the area's owner (no longer a member) nor the owner (who released it).
do $$
declare o jsonb := pg_temp.member(1); v_id uuid; v_told bigint;
	c_o constant text := '63400000-0000-4000-8000-000000000001'; c_n constant text := '63400000-0000-4000-8000-000000000004';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
begin
	perform pg_temp.expect(pg_temp.save_rows('{"kind":"platform"}', 'i9b-left-0007', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales',c_n,'',c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	perform pg_temp.expect(pg_temp.save_rows(o, 'i9b-left-0008', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales',c_n,c_o,c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	v_id := pg_temp.i9b_live('["Sales"]');
	v_told := (select count(*) from public.qorpera_member_notifications n2 where n2.kind = 'interface_supervision_ended');
	perform pg_temp.i9b_leave(4);
	if v_id is null or pg_temp.i9b_state(v_id) is distinct from 'live'
		or (select count(*) from public.qorpera_interface_supervisions s where s.state = 'live') is distinct from 1
		or (select count(*) from public.qorpera_member_notifications n2 where n2.kind = 'interface_supervision_ended') is distinct from v_told then
		raise exception 'A member with no consents left: %', (select jsonb_agg(to_jsonb(s)) from public.qorpera_interface_supervisions s); end if;
	perform pg_temp.expect(pg_temp.save_rows(o, 'i9b-left-0009', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales',c_n,'',c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	if pg_temp.i9b_state(v_id) is distinct from 'released' or pg_temp.i9b_told(v_id) is distinct from array[5] then
		raise exception 'Released by the owner: %, %', pg_temp.i9b_state(v_id), pg_temp.i9b_told(v_id); end if;
end $$;

-- 4. The notice: a key too long to carry is null; told twice, each member has it once while unacknowledged.
do $$
declare v_long uuid := extensions.gen_random_uuid(); v_twice uuid := extensions.gen_random_uuid();
begin
	perform public.qorpera_interface_supervision_notify('63400000-0000-4000-8000-000000000020',
		'63400000-0000-4000-8000-000000000010', v_long, '86400000-0000-4000-8000-000000000012',
		jsonb_build_array(repeat('x', 1100)), '63400000-0000-4000-8000-000000000001', 'released', null);
	if pg_temp.i9b_told(v_long) is distinct from array[1,5] or exists (select 1 from public.qorpera_member_notifications n2
		where n2.dedupe_key = v_long::text and n2.subject -> 'key' is distinct from 'null'::jsonb) then
		raise exception 'A long key: %', (select jsonb_agg(n2.subject) from public.qorpera_member_notifications n2
			where n2.dedupe_key = v_long::text); end if;
	perform public.qorpera_interface_supervision_notify('63400000-0000-4000-8000-000000000020',
		'63400000-0000-4000-8000-000000000010', v_twice, '86400000-0000-4000-8000-000000000012', '["Sales"]',
		'63400000-0000-4000-8000-000000000001', 'released', null);
	perform public.qorpera_interface_supervision_notify('63400000-0000-4000-8000-000000000020',
		'63400000-0000-4000-8000-000000000010', v_twice, '86400000-0000-4000-8000-000000000012', '["Sales"]',
		'63400000-0000-4000-8000-000000000001', 'released', null);
	if pg_temp.i9b_told(v_twice) is distinct from array[1,5] then raise exception 'Told twice: %', pg_temp.i9b_told(v_twice); end if;
end $$;
