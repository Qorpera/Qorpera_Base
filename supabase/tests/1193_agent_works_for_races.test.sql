-- Who each agent works for (20260930700000) against a member leaving, on two connections (review of #1579, F5 and F6).
-- An ask and an answer hold the company's member rows FOR SHARE before anything else, so a leaving member's delete,
-- whose trigger clears their agents and asks, comes wholly before or after them: an ask never lands on a member who
-- left, and an answer and a departure never deadlock. Row locks show only across connections, so the company is
-- committed here and removed at the end. Waits are seen with pg_blocking_pids, never by wall-clock time; a third
-- connection holds an answer midway.
-- "Race shop": owner A, admin B, contributor C. Agents Xena and Yara work for B.

insert into auth.users(id, email) values
	('11930000-0000-4000-8000-00000000000a', 'race-a@example.test'),
	('11930000-0000-4000-8000-00000000000b', 'race-b@example.test'),
	('11930000-0000-4000-8000-00000000000c', 'race-c@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('11930000-0000-4000-8000-000000000101', 'Race shop', '11930000-0000-4000-8000-00000000000a');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('11930000-0000-4000-8000-000000000101', '11930000-0000-4000-8000-00000000000a', 'race-a@example.test', 'A', 'owner'),
	('11930000-0000-4000-8000-000000000101', '11930000-0000-4000-8000-00000000000b', 'race-b@example.test', 'B', 'admin'),
	('11930000-0000-4000-8000-000000000101', '11930000-0000-4000-8000-00000000000c', 'race-c@example.test', 'C', 'contributor');
insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter, appearance_color,
	appearance_shape, employment_status, created_at, updated_at, updated_by_user_id)
select '11930000-0000-4000-8000-000000000101', id::uuid, name, 'Helper', 'Helps.', 'qorpera-blue', 'round', 'active',
	statement_timestamp(), statement_timestamp(), '11930000-0000-4000-8000-00000000000a'
from (values ('11930000-0000-4000-8000-000000000201', 'Xena'), ('11930000-0000-4000-8000-000000000202', 'Yara')) as a(id, name);
insert into public.qorpera_agent_works_for(profile_id, staff_agent_id, user_id) values
	('11930000-0000-4000-8000-000000000101', '11930000-0000-4000-8000-000000000201', '11930000-0000-4000-8000-00000000000b'),
	('11930000-0000-4000-8000-000000000101', '11930000-0000-4000-8000-000000000202', '11930000-0000-4000-8000-00000000000b');

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['race_leave', 'race_act', 'race_hold']) name;

-- Runs p_act on race_act (as member p_as) while race_leave holds B's departure open; answers whether it waited for the
-- departure, and what it answered or the SQLSTATE it raised.
create function pg_temp.while_b_leaves(p_as text, p_act text) returns jsonb language plpgsql as $$
declare v_leave integer; v_act integer; v_waited boolean := false; v_answer text; v_state text;
begin
	select pid into v_leave from dblink('race_leave', 'select pg_backend_pid()') as b(pid integer);
	select pid into v_act from dblink('race_act', 'select pg_backend_pid()') as b(pid integer);
	perform dblink_exec('race_leave', 'begin');
	perform dblink_exec('race_leave', $q$delete from public.qorpera_profile_members
		where profile_id = '11930000-0000-4000-8000-000000000101' and user_id = '11930000-0000-4000-8000-00000000000b'$q$);
	perform dblink_exec('race_act', format('set request.jwt.claims = %L',
		format('{"sub":"11930000-0000-4000-8000-00000000000%s","role":"authenticated"}', p_as)));
	perform dblink_exec('race_act', 'set role authenticated');
	perform dblink_send_query('race_act', format($q$select coalesce((
		select ('ok ' || (%s)::text)), 'none')$q$, p_act));
	for attempt in 1..400 loop
		v_waited := v_leave = any(pg_blocking_pids(v_act));
		exit when v_waited or dblink_is_busy('race_act') = 0;
		perform pg_sleep(0.025);
	end loop;
	perform dblink_exec('race_leave', 'commit');
	begin
		select answer into v_answer from dblink_get_result('race_act') as call(answer text);
	exception when others then
		v_state := sqlstate;
		v_answer := sqlerrm;
	end;
	perform * from dblink_get_result('race_act', false) as call(answer text);
	perform dblink_exec('race_act', 'reset role');
	return jsonb_build_object('waited', v_waited, 'answer', v_answer, 'state', v_state);
end $$;

do $$
declare v jsonb; v_ask uuid;
begin
	-- F5: A offers Xena to B while B leaves. The ask waits for the departure, then finds B gone: refused, no ask to B.
	v := pg_temp.while_b_leaves('a', $q$public.qorpera_ask_works_for('11930000-0000-4000-8000-000000000101',
		'11930000-0000-4000-8000-000000000201', '11930000-0000-4000-8000-00000000000b')$q$);
	if not (v ->> 'waited')::boolean or v ->> 'state' is distinct from '22023' then
		raise exception 'an ask to a leaving member: %', v; end if;
	if exists (select 1 from public.qorpera_agent_works_for_asks where profile_id = '11930000-0000-4000-8000-000000000101'
		and to_user_id = '11930000-0000-4000-8000-00000000000b' and status = 'open') then
		raise exception 'an open ask names a member who left'; end if;
	if (select user_id from public.qorpera_agent_works_for where staff_agent_id = '11930000-0000-4000-8000-000000000201')
		is not null then raise exception 'Xena still works for B after B left'; end if;
end $$;

-- B joins again, Yara works for B again, and B offers Yara to C.
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('11930000-0000-4000-8000-000000000101', '11930000-0000-4000-8000-00000000000b', 'race-b@example.test', 'B', 'admin');
update public.qorpera_agent_works_for set user_id = '11930000-0000-4000-8000-00000000000b'
where staff_agent_id = '11930000-0000-4000-8000-000000000202';
insert into public.qorpera_agent_works_for_asks(profile_id, staff_agent_id, from_user_id, to_user_id, asked_by_user_id,
	answer_by_user_id, id)
values ('11930000-0000-4000-8000-000000000101', '11930000-0000-4000-8000-000000000202', '11930000-0000-4000-8000-00000000000b',
	'11930000-0000-4000-8000-00000000000c', '11930000-0000-4000-8000-00000000000b', '11930000-0000-4000-8000-00000000000c',
	'11930000-0000-4000-8000-000000000301');

-- F6: C says yes to Yara, and is held at Yara's staff row (race_hold keeps it) with the members and the ask already
-- taken; B starts leaving meanwhile. The departure waits for C's answer on the member rows, never the other way round,
-- so both finish: Yara works for C, and B's departure finds nothing of B's to clear. (Before, the answer took the ask
-- first and the departure took Yara's row first, and each waited for the other.)
do $$
declare v_hold integer; v_act integer; v_leave integer; v_answer text; v_act_waited boolean := false;
	v_leave_waited boolean := false;
begin
	select pid into v_hold from dblink('race_hold', 'select pg_backend_pid()') as b(pid integer);
	select pid into v_act from dblink('race_act', 'select pg_backend_pid()') as b(pid integer);
	select pid into v_leave from dblink('race_leave', 'select pg_backend_pid()') as b(pid integer);
	perform dblink_exec('race_hold', 'begin');
	perform * from dblink('race_hold', $q$select 1 from public.qorpera_profile_staff
		where staff_agent_id = '11930000-0000-4000-8000-000000000202' for update$q$) as held(one integer);
	perform dblink_exec('race_act', $q$set request.jwt.claims = '{"sub":"11930000-0000-4000-8000-00000000000c","role":"authenticated"}'$q$);
	perform dblink_exec('race_act', 'set role authenticated');
	perform dblink_send_query('race_act', $q$select public.qorpera_answer_works_for('11930000-0000-4000-8000-000000000301',
		true) ->> 'status'$q$);
	for attempt in 1..400 loop
		v_act_waited := v_hold = any(pg_blocking_pids(v_act));
		exit when v_act_waited or dblink_is_busy('race_act') = 0;
		perform pg_sleep(0.025);
	end loop;
	if not v_act_waited then raise exception 'the answer did not reach the staff row'; end if;
	perform dblink_exec('race_leave', 'begin');
	perform dblink_send_query('race_leave', $q$delete from public.qorpera_profile_members
		where profile_id = '11930000-0000-4000-8000-000000000101' and user_id = '11930000-0000-4000-8000-00000000000b'$q$);
	for attempt in 1..400 loop
		v_leave_waited := v_act = any(pg_blocking_pids(v_leave));
		exit when v_leave_waited or dblink_is_busy('race_leave') = 0;
		perform pg_sleep(0.025);
	end loop;
	if not v_leave_waited then raise exception 'the departure did not wait for the answer'; end if;
	perform dblink_exec('race_hold', 'commit');
	select answer into v_answer from dblink_get_result('race_act') as call(answer text);
	perform * from dblink_get_result('race_act', false) as call(answer text);
	perform dblink_exec('race_act', 'reset role');
	perform * from dblink_get_result('race_leave') as call(answer text);
	perform * from dblink_get_result('race_leave', false) as call(answer text);
	perform dblink_exec('race_leave', 'commit');
	if v_answer <> 'yes' then raise exception 'the held yes answered %', v_answer; end if;
	if (select user_id from public.qorpera_agent_works_for where staff_agent_id = '11930000-0000-4000-8000-000000000202')
		<> '11930000-0000-4000-8000-00000000000c' then raise exception 'Yara does not work for C'; end if;
	if exists (select 1 from public.qorpera_profile_members where profile_id = '11930000-0000-4000-8000-000000000101'
		and user_id = '11930000-0000-4000-8000-00000000000b') then raise exception 'B did not leave'; end if;
end $$;

-- At the end: remove what the test committed.
select dblink_disconnect(name) from unnest(array['race_leave', 'race_act', 'race_hold']) name;
delete from public.qorpera_profiles where id = '11930000-0000-4000-8000-000000000101';
delete from auth.users where id in ('11930000-0000-4000-8000-00000000000a', '11930000-0000-4000-8000-00000000000b',
	'11930000-0000-4000-8000-00000000000c');
