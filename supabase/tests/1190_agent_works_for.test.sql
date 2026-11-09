-- Who each agent works for (20260930700000), as the real client role, in one transaction that is rolled back.
-- "Works shop" has an owner A, an admin B, a contributor C, a viewer V and a stranger S outside it. Agents: Hugo hired
-- by B, Ida with no known hirer (so nobody's until someone takes her), Jens hired by B, and Arne, archived.
begin;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
values
	('11900000-0000-4000-8000-00000000000a', 'works-a@example.test', statement_timestamp(), '{"display_name":"Works A"}'),
	('11900000-0000-4000-8000-00000000000b', 'works-b@example.test', statement_timestamp(), '{"display_name":"Works B"}'),
	('11900000-0000-4000-8000-00000000000c', 'works-c@example.test', statement_timestamp(), '{"display_name":"Works C"}'),
	('11900000-0000-4000-8000-00000000000d', 'works-v@example.test', statement_timestamp(), '{"display_name":"Works V"}'),
	('11900000-0000-4000-8000-00000000000e', 'works-s@example.test', statement_timestamp(), '{"display_name":"Works S"}');

insert into public.qorpera_profiles (id, name, created_by_user_id)
values ('11900000-0000-4000-8000-000000000101', 'Works shop', '11900000-0000-4000-8000-00000000000a');
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role, joined_at)
values
	('11900000-0000-4000-8000-000000000101', '11900000-0000-4000-8000-00000000000a', 'works-a@example.test', 'Works A', 'owner', statement_timestamp() - interval '4 days'),
	('11900000-0000-4000-8000-000000000101', '11900000-0000-4000-8000-00000000000b', 'works-b@example.test', 'Works B', 'admin', statement_timestamp() - interval '3 days'),
	('11900000-0000-4000-8000-000000000101', '11900000-0000-4000-8000-00000000000c', 'works-c@example.test', 'Works C', 'contributor', statement_timestamp() - interval '2 days'),
	('11900000-0000-4000-8000-000000000101', '11900000-0000-4000-8000-00000000000d', 'works-v@example.test', 'Works V', 'viewer', statement_timestamp() - interval '1 day');

insert into public.qorpera_profile_staff (profile_id, staff_agent_id, display_name, role, charter, appearance_color,
	appearance_shape, employment_status, created_at, updated_at, updated_by_user_id)
select '11900000-0000-4000-8000-000000000101', id::uuid, name, 'Helper', 'Helps.', 'qorpera-blue', 'round', status,
	statement_timestamp(), statement_timestamp(), '11900000-0000-4000-8000-00000000000a'
from (values
	('11900000-0000-4000-8000-000000000201', 'Hugo', 'active'),
	('11900000-0000-4000-8000-000000000202', 'Ida', 'active'),
	('11900000-0000-4000-8000-000000000203', 'Jens', 'active'),
	('11900000-0000-4000-8000-000000000204', 'Arne', 'archived')) as agent(id, name, status);

-- The hires' follow-up records, with foreign keys and triggers off only while the rows go in.
set local session_replication_role = replica;
insert into public.qorpera_folder_follow_ups (environment_id, subject_kind, subject_id, profile_id, hired_by_user_id)
values
	('11900000-0000-4000-8000-000000000301', 'agent', '11900000-0000-4000-8000-000000000201',
		'11900000-0000-4000-8000-000000000101', '11900000-0000-4000-8000-00000000000b'),
	('11900000-0000-4000-8000-000000000301', 'agent', '11900000-0000-4000-8000-000000000203',
		'11900000-0000-4000-8000-000000000101', '11900000-0000-4000-8000-00000000000b');
set local session_replication_role = origin;

-- Who works for whom, as the page reads it.
create function pg_temp.works(p_agent text) returns text language sql as $$
	select coalesce(agent ->> 'user_id', 'nobody')
	from jsonb_array_elements(public.qorpera_read_works_for('11900000-0000-4000-8000-000000000101') -> 'agents') as agent
	where agent ->> 'staff_agent_id' = '11900000-0000-4000-8000-0000000002' || p_agent
$$;
create function pg_temp.as_member(p_letter text) returns void language plpgsql as $$
begin
	perform set_config('request.jwt.claims', format('{"sub":"11900000-0000-4000-8000-00000000000%s","role":"authenticated"}', p_letter), true);
end $$;
create function pg_temp.refused(p_sql text, p_state text) returns void language plpgsql as $$
begin
	execute p_sql;
	raise exception 'expected % from: %', p_state, p_sql;
exception when others then
	if sqlstate <> p_state then raise exception 'expected % from %, got %: %', p_state, p_sql, sqlstate, sqlerrm; end if;
end $$;
grant execute on function pg_temp.works(text), pg_temp.as_member(text), pg_temp.refused(text, text) to authenticated;

-- 1. The read: who each works for, the archived agent left out, the roles' rights, the logins with nothing private.
select pg_temp.as_member('c');
set local role authenticated;
do $$
declare v jsonb := public.qorpera_read_works_for('11900000-0000-4000-8000-000000000101');
begin
	if current_user <> 'authenticated' then raise exception 'works suite is not running as authenticated'; end if;
	if v ->> 'schema' <> 'qorpera.works-for/v1' or (v ->> 'may_ask')::boolean is not true
		or (v ->> 'may_ask_for_others')::boolean is not false then raise exception 'the contributor read is wrong: %', v; end if;
	if jsonb_array_length(v -> 'agents') <> 3 then raise exception 'the archived agent is listed: %', v -> 'agents'; end if;
	if pg_temp.works('01') <> '11900000-0000-4000-8000-00000000000b' then raise exception 'Hugo does not work for his hirer'; end if;
	if pg_temp.works('02') <> 'nobody' then raise exception 'Ida, with no known hirer, works for someone'; end if;
	if jsonb_array_length(v -> 'logins') <> 4 or exists (select 1 from jsonb_array_elements(v -> 'logins') as login
		where login ->> 'state' <> 'none' or login ? 'email') then raise exception 'the logins are wrong: %', v -> 'logins'; end if;
	if jsonb_array_length(v -> 'asks') <> 0 then raise exception 'asks before any: %', v -> 'asks'; end if;
end $$;

-- The owner takes Ida, who works for nobody: no one's yes is needed.
reset role;
select pg_temp.as_member('a');
set local role authenticated;
do $$
begin
	if not (public.qorpera_ask_works_for('11900000-0000-4000-8000-000000000101', '11900000-0000-4000-8000-000000000202',
		'11900000-0000-4000-8000-00000000000a') ->> 'moved')::boolean then raise exception 'taking Ida from nobody asked'; end if;
	if pg_temp.works('02') <> '11900000-0000-4000-8000-00000000000a' then raise exception 'Ida does not work for the owner'; end if;
end $$;

-- A stranger reads nothing; a viewer reads but may not ask.
reset role;
select pg_temp.as_member('e');
set local role authenticated;
select pg_temp.refused($$select public.qorpera_read_works_for('11900000-0000-4000-8000-000000000101')$$, '42501');
reset role;
select pg_temp.as_member('d');
set local role authenticated;
do $$
begin
	if (public.qorpera_read_works_for('11900000-0000-4000-8000-000000000101') ->> 'may_ask')::boolean then
		raise exception 'a viewer may ask'; end if;
end $$;
select pg_temp.refused($$select public.qorpera_ask_works_for('11900000-0000-4000-8000-000000000101',
	'11900000-0000-4000-8000-000000000202', '11900000-0000-4000-8000-00000000000d')$$, '42501');

-- 2. C asks to take Hugo from B: B answers. A second ask on Hugo waits; C cannot answer for B; B says yes.
reset role;
select pg_temp.as_member('c');
set local role authenticated;
create temporary table works_ask(id uuid) on commit drop;
grant all on works_ask to authenticated;
do $$
declare v jsonb := public.qorpera_ask_works_for('11900000-0000-4000-8000-000000000101',
	'11900000-0000-4000-8000-000000000201', '11900000-0000-4000-8000-00000000000c');
begin
	if (v ->> 'moved')::boolean or v ->> 'ask_id' is null then raise exception 'taking from a member moved at once: %', v; end if;
	insert into works_ask values ((v ->> 'ask_id')::uuid);
	if (select ask ->> 'answer_by_user_id' from jsonb_array_elements(public.qorpera_read_works_for(
		'11900000-0000-4000-8000-000000000101') -> 'asks') as ask) <> '11900000-0000-4000-8000-00000000000b' then
		raise exception 'B is not the one asked'; end if;
end $$;
select pg_temp.refused($$select public.qorpera_ask_works_for('11900000-0000-4000-8000-000000000101',
	'11900000-0000-4000-8000-000000000201', '11900000-0000-4000-8000-00000000000a')$$, '55P03');
select pg_temp.refused($$select public.qorpera_answer_works_for((select id from works_ask), true)$$, '42501');
-- Nor may C offer the owner's Ida to B, or offer anything to the viewer.
select pg_temp.refused($$select public.qorpera_ask_works_for('11900000-0000-4000-8000-000000000101',
	'11900000-0000-4000-8000-000000000202', '11900000-0000-4000-8000-00000000000b')$$, '42501');
select pg_temp.refused($$select public.qorpera_ask_works_for('11900000-0000-4000-8000-000000000101',
	'11900000-0000-4000-8000-000000000201', '11900000-0000-4000-8000-00000000000d')$$, '22023');
-- The archived agent cannot move.
select pg_temp.refused($$select public.qorpera_ask_works_for('11900000-0000-4000-8000-000000000101',
	'11900000-0000-4000-8000-000000000204', '11900000-0000-4000-8000-00000000000c')$$, '22023');
reset role;
select pg_temp.as_member('b');
set local role authenticated;
do $$
declare v jsonb := public.qorpera_answer_works_for((select id from works_ask), true);
begin
	if v ->> 'status' <> 'yes' or not (v ->> 'moved')::boolean then raise exception 'B''s yes did not move Hugo: %', v; end if;
	if pg_temp.works('01') <> '11900000-0000-4000-8000-00000000000c' then raise exception 'Hugo does not work for C'; end if;
	-- Answering again changes nothing.
	if public.qorpera_answer_works_for((select id from works_ask), false) ->> 'status' <> 'yes' then
		raise exception 'an answered ask changed'; end if;
end $$;

-- 3. The owner offers Ida to B; B says no, and Ida stays.
reset role;
select pg_temp.as_member('a');
set local role authenticated;
delete from works_ask;
insert into works_ask select (public.qorpera_ask_works_for('11900000-0000-4000-8000-000000000101',
	'11900000-0000-4000-8000-000000000202', '11900000-0000-4000-8000-00000000000b') ->> 'ask_id')::uuid;
reset role;
select pg_temp.as_member('b');
set local role authenticated;
do $$
begin
	if public.qorpera_answer_works_for((select id from works_ask), false) ->> 'status' <> 'no' then raise exception 'no is not no'; end if;
	if pg_temp.works('02') <> '11900000-0000-4000-8000-00000000000a' then raise exception 'Ida moved on a no'; end if;
end $$;

-- 4. The owner offers Ida to C and withdraws; offers her again, and she moves to B before C answers: C's yes is void.
reset role;
select pg_temp.as_member('a');
set local role authenticated;
delete from works_ask;
insert into works_ask select (public.qorpera_ask_works_for('11900000-0000-4000-8000-000000000101',
	'11900000-0000-4000-8000-000000000202', '11900000-0000-4000-8000-00000000000c') ->> 'ask_id')::uuid;
do $$
begin
	if public.qorpera_answer_works_for((select id from works_ask), false) ->> 'status' <> 'withdrawn' then
		raise exception 'the asker did not withdraw'; end if;
end $$;
delete from works_ask;
insert into works_ask select (public.qorpera_ask_works_for('11900000-0000-4000-8000-000000000101',
	'11900000-0000-4000-8000-000000000202', '11900000-0000-4000-8000-00000000000c') ->> 'ask_id')::uuid;
reset role;
select public.qorpera_works_for_move('11900000-0000-4000-8000-000000000101', '11900000-0000-4000-8000-000000000202',
	'11900000-0000-4000-8000-00000000000b');
select pg_temp.as_member('c');
set local role authenticated;
do $$
declare v jsonb := public.qorpera_answer_works_for((select id from works_ask), true);
begin
	if v ->> 'status' <> 'void' or (v ->> 'moved')::boolean then raise exception 'a stale yes moved Ida: %', v; end if;
	if pg_temp.works('02') <> '11900000-0000-4000-8000-00000000000b' then raise exception 'Ida left B on a void yes'; end if;
end $$;

-- 5. C offers Hugo to B, then B leaves: Ida and Jens (B's) work for nobody, Hugo stays C's, the ask is void.
delete from works_ask;
insert into works_ask select (public.qorpera_ask_works_for('11900000-0000-4000-8000-000000000101',
	'11900000-0000-4000-8000-000000000201', '11900000-0000-4000-8000-00000000000b') ->> 'ask_id')::uuid;
reset role;
delete from public.qorpera_profile_members
where profile_id = '11900000-0000-4000-8000-000000000101' and user_id = '11900000-0000-4000-8000-00000000000b';
select pg_temp.as_member('c');
set local role authenticated;
do $$
begin
	if pg_temp.works('01') <> '11900000-0000-4000-8000-00000000000c' then raise exception 'Hugo left C'; end if;
	if pg_temp.works('02') <> 'nobody' or pg_temp.works('03') <> 'nobody' then
		raise exception 'B''s agents did not go to nobody: % %', pg_temp.works('02'), pg_temp.works('03'); end if;
	if jsonb_array_length(public.qorpera_read_works_for('11900000-0000-4000-8000-000000000101') -> 'asks') <> 0 then
		raise exception 'the ask involving B is still open'; end if;
	-- 6. Taking an agent that works for nobody needs no one's yes.
	if not (public.qorpera_ask_works_for('11900000-0000-4000-8000-000000000101', '11900000-0000-4000-8000-000000000203',
		'11900000-0000-4000-8000-00000000000c') ->> 'moved')::boolean then raise exception 'taking Jens from nobody asked'; end if;
	if pg_temp.works('03') <> '11900000-0000-4000-8000-00000000000c' then raise exception 'Jens does not work for C'; end if;
end $$;
reset role;
do $$
begin
	if (select status from public.qorpera_agent_works_for_asks where id = (select id from works_ask)) <> 'void' then
		raise exception 'the ask to B is not void'; end if;
end $$;

rollback;
