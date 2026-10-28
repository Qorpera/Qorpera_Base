-- @fixture 708_folder_state_routines.test.sql until "-- 2. A member's routine"
-- Company folder core C4, slice P34r (20260930038000; deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §6): a
-- member finds a routine's file in the state folders read, as they find an agent's and a group chat's: the live routine
-- index rows whose file they may read, with the agent that owns each, in path order.
--
-- The fixture (708): owner 01 (whose login pays) and contributor 02 are members; the agents nora and otto, each with a
-- routines folder.

create function pg_temp.as_user(p_n text) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated',
		'sub', '70700000-0000-4000-8000-0000000000' || p_n)::text, true)::text::void
$$;
create function pg_temp.as_service() returns void language sql as $$
	select set_config('request.jwt.claims', '{"role":"service_role"}', true)::text::void
$$;
create function pg_temp.same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
-- The answer's routines, as "id:agent:file" in its order (the ids' last two digits).
create function pg_temp.routines(p_answer jsonb) returns text language sql as $$
	select coalesce(string_agg(right(e.value ->> 'routineId', 2) || ':' || right(e.value ->> 'staffAgentId', 2) || ':'
		|| (e.value ->> 'file'), ',' order by e.ordinality), '')
	from jsonb_array_elements(p_answer -> 'routines') with ordinality e
$$;
create function pg_temp.folders() returns jsonb language sql as $$
	select public.qorpera_member_company_state_folders('70700000-0000-4000-8000-000000000020')
$$;

-- The function keeps both slices' body markers and its grants.
do $$ begin
	if strpos(pg_get_functiondef('public.qorpera_member_company_state_folders(uuid)'::regprocedure), 'C4 P34a (20260930021000)') = 0
		or strpos(pg_get_functiondef('public.qorpera_member_company_state_folders(uuid)'::regprocedure), 'C4 P34r (20260930038000)') = 0 then
		raise exception 'The state folders read lost a body marker'; end if;
	if not has_function_privilege('authenticated', 'public.qorpera_member_company_state_folders(uuid)', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_member_company_state_folders(uuid)', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_member_company_state_folders(uuid)', 'EXECUTE') then
		raise exception 'The state folders read has the wrong grants'; end if;
end $$;

-- 1. Routines' files: live ones, in path order, with their agent ---------------------------------------------------------

select pg_temp.as_service();
do $$
declare r jsonb; i integer;
begin
	r := pg_temp.commit(pg_temp.owner(), 'routine-files-0001', jsonb_build_array(
		pg_temp.routine('QorperaOS/agents/otto/routines/report.md', pg_temp.rparse('89900000-0000-4000-8000-0000000000e2', 'Report',
			pg_temp.every(60))),
		pg_temp.routine('QorperaOS/agents/nora/routines/inbox.md', pg_temp.rparse('89900000-0000-4000-8000-0000000000e1', 'Inbox',
			pg_temp.every(30))),
		pg_temp.routine('QorperaOS/agents/nora/routines/weekly.md', pg_temp.rparse('89900000-0000-4000-8000-0000000000e3', 'Weekly',
			pg_temp.every(120)))));
	for i in 1..3 loop perform pg_temp.expect(r, i, 'saved'); end loop;
end $$;
select pg_temp.as_user('02');
do $$
declare v jsonb := pg_temp.folders();
begin
	perform pg_temp.same(pg_temp.routines(v),
		'e1:a1:QorperaOS/agents/nora/routines/inbox.md,e3:a1:QorperaOS/agents/nora/routines/weekly.md,e2:a2:QorperaOS/agents/otto/routines/report.md',
		'every routine''s file, with its agent');
	perform pg_temp.same((select string_agg(k, ',' order by k) from jsonb_object_keys(v) k), 'agents,groups,routines,schema',
		'the answer''s keys');
	perform pg_temp.same(v ->> 'schema', 'qorpera.member-company-state-folders/v1', 'the schema');
end $$;

-- 2. A deleted routine is gone; a routine the member may not read is not listed ------------------------------------------

select pg_temp.as_service();
do $$ begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'routine-files-0002', jsonb_build_array(
		jsonb_build_object('op', 'delete', 'path', 'QorperaOS/agents/nora/routines/weekly.md',
			'expectedVersion', pg_temp.version('QorperaOS/agents/nora/routines/weekly.md')))), 1, 'saved');
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id, policy,
		created_by_user_id)
	values ('70700000-0000-4000-8000-000000000020', 'QorperaOS/agents/otto', 'subtree', 'member_private',
		'70700000-0000-4000-8000-000000000001', 'normal', '70700000-0000-4000-8000-000000000001');
end $$;
select pg_temp.as_user('02');
do $$ begin
	perform pg_temp.same(pg_temp.routines(pg_temp.folders()), 'e1:a1:QorperaOS/agents/nora/routines/inbox.md',
		'a deleted routine and an unreadable one are left out');
end $$;
select pg_temp.as_user('01');
do $$ begin
	perform pg_temp.same(pg_temp.routines(pg_temp.folders()),
		'e1:a1:QorperaOS/agents/nora/routines/inbox.md,e2:a2:QorperaOS/agents/otto/routines/report.md', 'the private folder''s owner reads it');
end $$;

-- 3. A non-member reads nothing ---------------------------------------------------------------------------------------------

select pg_temp.as_user('03');
do $$
declare v_state text;
begin
	begin
		perform pg_temp.folders();
		v_state := 'ok';
	exception when others then
		v_state := sqlstate || ' ' || sqlerrm;
	end;
	perform pg_temp.same(v_state, '42501 Company folder is unavailable', 'a non-member');
end $$;
select pg_temp.as_service();

rollback;
