-- @fixture 702_folder_state_groups_sections.test.sql until "-- 3. An edit: the fields, the conversation's title, and the members"
-- Company folder core C4, slice P34a (20260930021000; deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §5):
-- member writes for the web's editors. The writer check answers a member of a folder-v2 company their own actor and
-- nothing else; the object gateway stages and commits as that actor, and the core checks it as any member. A member
-- reads the files of the live agents and group chats they may read.
--
-- The fixture (702): owner 01 and contributor 02 are members, 03 is not; the agents co-founder, nora, otto and vera;
-- the group chat launch.

create function pg_temp.as_user(p_n text) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated',
		'sub', '70200000-0000-4000-8000-0000000000' || p_n)::text, true)::text::void
$$;
create function pg_temp.as_service() returns void language sql as $$
	select set_config('request.jwt.claims', '{"role":"service_role"}', true)::text::void
$$;
create function pg_temp.state_of(p_statement text) returns text language plpgsql as $$
begin
	execute p_statement;
	return 'ok';
exception when others then
	return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
-- The answer's files, as "id:file" in its order.
create function pg_temp.files(p_answer jsonb, p_list text, p_id text) returns text language sql as $$
	select coalesce(string_agg(right(e.value ->> p_id, 2) || ':' || (e.value ->> 'file'), ',' order by e.ordinality), '')
	from jsonb_array_elements(p_answer -> p_list) with ordinality e
$$;

-- Who may call them: authenticated only, each with its body marker.
do $$
declare v_function text;
begin
	foreach v_function in array array['qorpera_member_folder_writer(uuid)', 'qorpera_member_company_state_folders(uuid)'] loop
		if not has_function_privilege('authenticated', 'public.' || v_function, 'EXECUTE')
			or has_function_privilege('anon', 'public.' || v_function, 'EXECUTE')
			or has_function_privilege('service_role', 'public.' || v_function, 'EXECUTE') then
			raise exception '% has the wrong grants', v_function; end if;
		if strpos(pg_get_functiondef(('public.' || v_function)::regprocedure), 'C4 P34a (20260930021000)') = 0 then
			raise exception '% has no body marker', v_function; end if;
	end loop;
end $$;

-- 1. The writer check: the caller's own actor and the company, for a member only ---------------------------------------

select pg_temp.as_user('02');
do $$ begin
	perform pg_temp.same(public.qorpera_member_folder_writer('70200000-0000-4000-8000-000000000020')::text,
		jsonb_build_object('schema', 'qorpera.member-folder-writer/v1',
			'actor', jsonb_build_object('kind', 'member', 'userId', '70200000-0000-4000-8000-000000000002'),
			'profileId', '70200000-0000-4000-8000-000000000010')::text, 'a contributor''s actor');
end $$;
select pg_temp.as_user('01');
do $$ begin
	perform pg_temp.same(public.qorpera_member_folder_writer('70200000-0000-4000-8000-000000000020') -> 'actor' ->> 'userId',
		'70200000-0000-4000-8000-000000000001', 'the owner''s actor is the owner''s');
end $$;

-- No folder: a non-member, a company that is not folder-v2, and a company being deleted.
select pg_temp.as_user('03');
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_writer(
		'70200000-0000-4000-8000-000000000020')$s$), '42501 Company folder is unavailable', 'a non-member writer');
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_company_state_folders(
		'70200000-0000-4000-8000-000000000020')$s$), '42501 Company folder is unavailable', 'a non-member''s folders');
end $$;
select pg_temp.as_service();
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('70200000-0000-4000-8000-000000000011', 'Nordlys Elsewhere', '70200000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('70200000-0000-4000-8000-000000000011', '70200000-0000-4000-8000-000000000001', 'groups-owner@example.test',
	'Owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('70200000-0000-4000-8000-000000000021', '70200000-0000-4000-8000-000000000011', 'Environment', 1,
	'70200000-0000-4000-8000-000000000001');
select pg_temp.as_user('01');
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_writer(
		'70200000-0000-4000-8000-000000000021')$s$), '42501 Company folder is unavailable', 'a company without a folder');
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_company_state_folders(
		'70200000-0000-4000-8000-000000000021')$s$), '42501 Company folder is unavailable',
		'the folders of a company without a folder');
end $$;
savepoint member_writes_deleting;
select pg_temp.as_service();
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('70200000-0000-4000-8000-000000000010', '70200000-0000-4000-8000-000000000001');
select pg_temp.as_user('02');
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_writer(
		'70200000-0000-4000-8000-000000000020')$s$), '55000 Company is being deleted', 'a writer while deleting');
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_company_state_folders(
		'70200000-0000-4000-8000-000000000020')$s$), '55000 Company is being deleted', 'the folders while deleting');
end $$;
rollback to savepoint member_writes_deleting;
-- A paused company takes no member writes, but its members still read it.
savepoint member_writes_paused;
select pg_temp.as_service();
select public.qorpera_folder_pause('70200000-0000-4000-8000-000000000010', '70200000-0000-4000-8000-000000000001',
	'member writes test') \g /dev/null
select pg_temp.as_user('02');
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_writer(
		'70200000-0000-4000-8000-000000000020')$s$), '55000 Company execution is paused', 'a writer while paused');
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_company_state_folders(
		'70200000-0000-4000-8000-000000000020')$s$), 'ok', 'the folders while paused');
end $$;
rollback to savepoint member_writes_paused;

-- 2. The gateway commits as the actor it was given: the core takes it as that member ----------------------------------

select pg_temp.as_user('01');
select set_config('qorpera_test.actor',
	(public.qorpera_member_folder_writer('70200000-0000-4000-8000-000000000020') ->> 'actor'), true) \g /dev/null
select pg_temp.as_service();
do $$
declare v_actor jsonb := current_setting('qorpera_test.actor')::jsonb; v_commit public.qorpera_folder_commits;
begin
	perform pg_temp.expect(pg_temp.commit(v_actor, 'member-writes-0001', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'drafts'))), 1, 'saved');
	select * into v_commit from public.qorpera_folder_commits
	where environment_id = '70200000-0000-4000-8000-000000000020' and operation_key = 'member-writes-0001';
	if v_commit.actor_kind is distinct from 'member' or v_commit.actor_id is distinct from '70200000-0000-4000-8000-000000000001' then
		raise exception 'The commit is the member''s: %', to_jsonb(v_commit); end if;
end $$;

-- 3. The agents' and group chats' files: live ones, in path order, only what the member may read -----------------------

select pg_temp.as_user('02');
do $$
declare v jsonb := public.qorpera_member_company_state_folders('70200000-0000-4000-8000-000000000020');
begin
	perform pg_temp.same(v ->> 'schema', 'qorpera.member-company-state-folders/v1', 'the schema');
	perform pg_temp.same(pg_temp.files(v, 'agents', 'staffAgentId'),
		'c0:agents/co-founder/agent.md,a1:agents/nora/agent.md,a2:agents/otto/agent.md,a3:agents/vera/agent.md',
		'every agent''s file');
	perform pg_temp.same(pg_temp.files(v, 'groups', 'roomId'), 'b1:agents/groups/launch/group.md', 'the group chat''s file');
	perform pg_temp.same((select string_agg(k, ',' order by k) from jsonb_object_keys(v) k), 'agents,groups,schema',
		'the answer''s keys');
end $$;

-- A deleted folder is gone; a file the member may not read is not listed.
select pg_temp.as_service();
do $$ begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'member-writes-0002', jsonb_build_array(
		jsonb_build_object('op', 'delete', 'path', 'agents/vera', 'expectedVersion', pg_temp.version('agents/vera'),
			'asOfSeq', pg_temp.seq()))), 1, 'saved');
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id, policy,
		created_by_user_id)
	values ('70200000-0000-4000-8000-000000000020', 'agents/otto', 'subtree', 'member_private',
		'70200000-0000-4000-8000-000000000001', 'normal', '70200000-0000-4000-8000-000000000001');
end $$;
select pg_temp.as_user('02');
do $$
declare v jsonb := public.qorpera_member_company_state_folders('70200000-0000-4000-8000-000000000020');
begin
	perform pg_temp.same(pg_temp.files(v, 'agents', 'staffAgentId'),
		'c0:agents/co-founder/agent.md,a1:agents/nora/agent.md', 'a deleted agent and an unreadable one are left out');
end $$;
select pg_temp.as_user('01');
do $$ begin
	perform pg_temp.same(pg_temp.files(public.qorpera_member_company_state_folders('70200000-0000-4000-8000-000000000020'),
		'agents', 'staffAgentId'), 'c0:agents/co-founder/agent.md,a1:agents/nora/agent.md,a2:agents/otto/agent.md',
		'the private folder''s owner reads it');
end $$;
select pg_temp.as_service();

rollback;
