-- @fixture 865_folder_state_tables.test.sql until "-- 1. The port of parseTableRows"
-- Interfaces I9b, the members' calls (RUNTIME-INTERFACES.md §5.1 "Supervision"): withdraw a consent (the cell keeps
-- naming its member, and the area's agents act for no one), consent again to a cell that names you, and the list of
-- live consents. The grants, the requests' shapes, and a paused company (consenting is a write; withdrawing and the list
-- still work). Consents made and ended by saves are 451's; leaving and the notices 453's.

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
create function pg_temp.i9b_withdraw(p_by integer, p_supervision uuid) returns jsonb language sql as $$
	select pg_temp.i9b_call(pg_temp.i9b_user(p_by), format('select public.qorpera_withdraw_interface_supervision(%L, %L)',
		'63400000-0000-4000-8000-000000000020', p_supervision))
$$;
create function pg_temp.i9b_consent(p_by integer, p_request jsonb) returns jsonb language sql as $$
	select pg_temp.i9b_call(pg_temp.i9b_user(p_by), format('select public.qorpera_consent_interface_supervision(%L, %L::jsonb)',
		'63400000-0000-4000-8000-000000000020', p_request))
$$;
create function pg_temp.i9b_list(p_by integer) returns jsonb language sql as $$
	select pg_temp.i9b_call(pg_temp.i9b_user(p_by), format('select public.qorpera_member_interface_supervisions(%L)',
		'63400000-0000-4000-8000-000000000020'))
$$;
create function pg_temp.i9b_refused(p_answer jsonb, p_reason text, p_message text default null) returns void language plpgsql as $$
begin
	if p_answer ->> 'ok' is distinct from 'false' or p_answer ->> 'reason' is distinct from p_reason
		or p_answer ->> 'schema' is distinct from 'qorpera.interface-supervision/v1'
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
-- Who was told a consent ended, by user number.
create function pg_temp.i9b_told(p_id uuid) returns integer[] language sql as $$
	select coalesce(array_agg(right(n.user_id::text, 12)::integer order by n.user_id), '{}')
	from public.qorpera_member_notifications n where n.kind = 'interface_supervision_ended' and n.dedupe_key = p_id::text
$$;

-- 0. The grants: members call the three; the rest and the table are the platform's own.
do $$
declare f text;
begin
	foreach f in array array['public.qorpera_withdraw_interface_supervision(uuid,uuid)',
		'public.qorpera_consent_interface_supervision(uuid,jsonb)', 'public.qorpera_member_interface_supervisions(uuid)'] loop
		if not has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')
			or has_function_privilege('service_role', f, 'execute') then raise exception 'The grants of %', f; end if;
	end loop;
	foreach f in array array['public.qorpera_interface_supervision_json(public.qorpera_interface_supervisions,text)',
		'public.qorpera_interface_area_rows(uuid)', 'public.qorpera_interface_supervision_notify(uuid,uuid,uuid,uuid,jsonb,uuid,text,uuid)',
		'public.qorpera_interface_supervision_settle(uuid,uuid,uuid,text,uuid,boolean)',
		'public.qorpera_interface_agent_supervisor(uuid,uuid,text)', 'public.qorpera_interface_supervision_refused(text,text)',
		'public.qorpera_interface_supervision_left()'] loop
		if has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')
			or has_function_privilege('service_role', f, 'execute') then raise exception 'The grants of %', f; end if;
	end loop;
	if has_table_privilege('authenticated', 'public.qorpera_interface_supervisions', 'select')
		or has_table_privilege('anon', 'public.qorpera_interface_supervisions', 'select')
		or not has_table_privilege('service_role', 'public.qorpera_interface_supervisions', 'select')
		or has_table_privilege('service_role', 'public.qorpera_interface_supervisions', 'insert,update,delete') then
		raise exception 'The consents table''s grants'; end if;
end $$;

-- 1. The member takes Sales's supervisor (agent A in it); a claims table for the agent. The list: live consents, for
-- every member who reads the areas (a viewer too), none for one who is not a member.
do $$
declare r jsonb; v_id uuid; o jsonb := pg_temp.member(1);
	c_m constant text := '63400000-0000-4000-8000-000000000002';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
begin
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(2), 'i9b-calls-0001', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales','',c_m,c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(o, 'i9b-calls-0002', jsonb_build_array(pg_temp.p16_folder(o, 'tables/claims',
		jsonb_build_object('table.toml', pg_temp.claims('45200000-0000-4000-8000-000000000001'),
			'rows.csv', pg_temp.claim_rows(array[array['t1','',''], array['t2','','']]))))), 1, 'saved');
	v_id := pg_temp.i9b_live('["Sales"]');
	r := pg_temp.i9b_list(3);
	if v_id is null or r ->> 'schema' is distinct from 'qorpera.member-interface-supervisions/v1' or r ->> 'truncated' is distinct from 'false'
		or jsonb_array_length(r -> 'supervisions') is distinct from 1
		or (r -> 'supervisions' -> 0) - 'at' is distinct from jsonb_build_object('id', v_id, 'table', '86400000-0000-4000-8000-000000000012',
			'folder', 'tables/areas', 'key', '["Sales"]'::jsonb, 'user', c_m, 'state', 'live', 'endedAt', null)
		or r -> 'supervisions' -> 0 ->> 'at' is null then
		raise exception 'The list: %', r; end if;
	if pg_temp.i9b_list(2) is distinct from r or pg_temp.i9b_list(1) is distinct from r then raise exception 'The list differs by member'; end if;
	perform pg_temp.i9b_error(pg_temp.i9b_list(99), '42501');
end $$;

-- 2. Withdraw: only its member. The file is as it was and the cell keeps naming them, but the area's agent acts for no
-- one, and the others concerned are told. Withdrawn again: unchanged. A save that keeps the cell makes no consent.
do $$
declare r jsonb; v_id uuid := pg_temp.i9b_live('["Sales"]'); v_rows uuid := pg_temp.p16_version('tables/areas/rows.csv');
	c_m constant text := '63400000-0000-4000-8000-000000000002';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
	g jsonb := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-000000000001');
begin
	perform pg_temp.i9b_error(pg_temp.i9b_withdraw(4, v_id), '42501');
	perform pg_temp.i9b_error(pg_temp.i9b_withdraw(1, v_id), '42501');
	perform pg_temp.i9b_error(pg_temp.i9b_withdraw(99, v_id), '42501');
	perform pg_temp.i9b_error(pg_temp.i9b_withdraw(2, extensions.gen_random_uuid()), '22023');
	r := pg_temp.i9b_withdraw(2, v_id);
	if r ->> 'schema' is distinct from 'qorpera.interface-supervision/v1' or r ->> 'ok' is distinct from 'true' or r ->> 'changed' is distinct from 'true'
		or (r -> 'supervision') - 'at' - 'endedAt' is distinct from jsonb_build_object('id', v_id, 'table', '86400000-0000-4000-8000-000000000012',
			'folder', 'tables/areas', 'key', null, 'user', c_m, 'state', 'withdrawn')
		or r -> 'supervision' ->> 'endedAt' is null then
		raise exception 'Withdrawn: %', r; end if;
	if pg_temp.i9b_told(v_id) is distinct from array[1,5] then raise exception 'Told of a withdrawal: %', pg_temp.i9b_told(v_id); end if;
	if pg_temp.p16_version('tables/areas/rows.csv') is distinct from v_rows then raise exception 'A withdrawal changed the file'; end if;
	r := pg_temp.i9b_withdraw(2, v_id);
	if r ->> 'changed' is distinct from 'false' or r -> 'supervision' ->> 'state' is distinct from 'withdrawn' then raise exception 'Withdrawn twice: %', r; end if;
	if jsonb_array_length(pg_temp.i9b_list(2) -> 'supervisions') is distinct from 0 then raise exception 'A withdrawn consent is listed'; end if;
	r := pg_temp.save_rows(g -> 'actor', 'i9b-calls-0003', 'tables/claims/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_m,''], array['t2','','']]));
	perform pg_temp.refused(r, 1, 'structured_rule', 'claim');
	if pg_temp.problem(r, 1) is distinct from 'nobody assigns anybody: only the member named changes owner' then
		raise exception 'An agent under a withdrawn consent: %', r; end if;
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(2), 'i9b-calls-0004', 'tables/areas/rows.csv', pg_temp.i9b_areas(
		array[array['Sales','',c_m,c_a1,'yes'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	if pg_temp.i9b_live('["Sales"]') is not null then raise exception 'A save that keeps the cell consented again'; end if;
end $$;

-- 3. Consent again: only the member the cell names, to a row that is there; requests of the wrong shape refused.
-- Consenting while a consent is live answers that one. The area's agent acts for them again.
do $$
declare r jsonb; v_id uuid; c_m constant text := '63400000-0000-4000-8000-000000000002';
	g jsonb := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-000000000001');
begin
	perform pg_temp.i9b_refused(pg_temp.i9b_consent(4, '{"key":["Sales"]}'), 'not_yours',
		'Only the member it names as supervisor can consent.');
	perform pg_temp.i9b_refused(pg_temp.i9b_consent(3, '{"key":["Sales"]}'), 'not_yours');
	perform pg_temp.i9b_refused(pg_temp.i9b_consent(2, '{"key":["Ops"]}'), 'not_yours');
	perform pg_temp.i9b_refused(pg_temp.i9b_consent(2, '{"key":["Nowhere"]}'), 'gone', 'This area is gone.');
	perform pg_temp.i9b_refused(pg_temp.i9b_consent(2, '{"key":["Sales","no"]}'), 'gone');
	perform pg_temp.i9b_error(pg_temp.i9b_consent(2, '[]'), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_consent(2, '{}'), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_consent(2, '{"key":[]}'), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_consent(2, '{"key":"Sales"}'), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_consent(2, '{"key":["Sales"],"extra":1}'), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_consent(2, jsonb_build_object('key', jsonb_build_array(repeat('x', 4100)))), '22023');
	perform pg_temp.i9b_error(pg_temp.i9b_consent(99, '{"key":["Sales"]}'), '42501');
	if exists (select 1 from public.qorpera_interface_supervisions s where s.state = 'live') then
		raise exception 'A refused consent was stored'; end if;

	r := pg_temp.i9b_consent(2, '{"key":["Sales"]}');
	v_id := (r -> 'supervision' ->> 'id')::uuid;
	if r ->> 'schema' is distinct from 'qorpera.interface-supervision/v1' or r ->> 'ok' is distinct from 'true' or r ->> 'created' is distinct from 'true'
		or (r -> 'supervision') - 'id' - 'at' is distinct from jsonb_build_object('table', '86400000-0000-4000-8000-000000000012',
			'folder', 'tables/areas', 'key', '["Sales"]'::jsonb, 'user', c_m, 'state', 'live', 'endedAt', null) then
		raise exception 'Consented: %', r; end if;
	if pg_temp.i9b_live('["Sales"]') is distinct from v_id then raise exception 'The consent is not live'; end if;
	r := pg_temp.i9b_consent(2, '{"key":["Sales"]}');
	if r ->> 'ok' is distinct from 'true' or r ->> 'created' is distinct from 'false' or r -> 'supervision' ->> 'id' is distinct from v_id::text then
		raise exception 'Consented twice: %', r; end if;
	if (select count(*) from public.qorpera_interface_supervisions s where s.state = 'live') is distinct from 1 then
		raise exception 'A consent made twice is stored twice'; end if;
	perform pg_temp.expect(pg_temp.save_rows(g -> 'actor', 'i9b-calls-0005', 'tables/claims/rows.csv',
		pg_temp.claim_rows(array[array['t1',c_m,''], array['t2','','']])), 1, 'saved');
end $$;

-- 4. A paused company: no consenting; withdrawing and the list still work.
do $$
declare r jsonb; v_id uuid := pg_temp.i9b_live('["Sales"]');
begin
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
	values ('63400000-0000-4000-8000-000000000010', pg_temp.i9b_user(1), 'I9b');
	perform pg_temp.i9b_error(pg_temp.i9b_consent(2, '{"key":["Sales"]}'), '55000');
	if jsonb_array_length(pg_temp.i9b_list(3) -> 'supervisions') is distinct from 1 then raise exception 'The list while paused'; end if;
	r := pg_temp.i9b_withdraw(2, v_id);
	if r ->> 'changed' is distinct from 'true' or r -> 'supervision' ->> 'state' is distinct from 'withdrawn' then raise exception 'Withdrawn while paused: %', r; end if;
	perform pg_temp.i9b_error(pg_temp.i9b_consent(2, '{"key":["Sales"]}'), '55000');
	if jsonb_array_length(pg_temp.i9b_list(2) -> 'supervisions') is distinct from 0 then raise exception 'The list after withdrawing while paused'; end if;
end $$;
