-- @fixture 764_chatgpt_plan_login.test.sql until "-- Both kinds are listed for their account (20260930059000)"
-- Sign in with ChatGPT, slice 5a (20260928369970): what the web client reads to keep a member's ChatGPT plan
-- login apart from a Codex login. Test 764's fixture leaves the member with a plan login and a Codex vault
-- login in the company, and the node login of test 016's fixture.
reset role;
do $$
declare v_plan uuid; v_codex uuid;
begin
	select version.connection_id into strict v_plan from public.qorpera_provider_connection_versions as version
	join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
	where login.id = '76400000-0000-4000-8000-000000000150' and version.version = 1;
	select version.connection_id into strict v_codex from public.qorpera_provider_connection_versions as version
	join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
	where login.id = '76400000-0000-4000-8000-000000000250' and version.version = 1;
	perform set_config('qorpera_test.r772', jsonb_build_object('plan', v_plan, 'codex', v_codex)::text, false);
	-- A member records a showing; nobody reads or writes the table directly.
	if has_function_privilege('anon', 'public.qorpera_record_chatgpt_plan_routine_offer(uuid,uuid)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_record_chatgpt_plan_routine_offer(uuid,uuid)', 'execute')
		or not has_function_privilege('authenticated', 'public.qorpera_record_chatgpt_plan_routine_offer(uuid,uuid)', 'execute') then
		raise exception 'the offer record has the wrong callers'; end if;
	if exists (select 1 from unnest(array['anon','authenticated','service_role']) as role(name)
		where has_table_privilege(role.name, 'public.qorpera_chatgpt_plan_routine_offers', 'select,insert,update,delete')) then
		raise exception 'the offers table is open to the API'; end if;
end $$;
create function pg_temp.r772(p_key text) returns uuid language sql as $$
	select (current_setting('qorpera_test.r772')::jsonb ->> p_key)::uuid
$$;
-- The member's connection list as the web reads it.
create function pg_temp.r772_connection(p_connection uuid) returns jsonb language sql as $$
	select entry from jsonb_array_elements(current_setting('qorpera_test.plan764_last')::jsonb -> 'connections') as entry
	where (entry ->> 'connection_id')::uuid = p_connection
$$;

-- 1. The list names each login's kind and its work-while-away consent.
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_list_member_native_execution_connections(''16000000-0000-4000-8000-000000000010'')::text'),
	'ok', 'the member''s connections');
reset role;
do $$
declare v_plan jsonb := pg_temp.r772_connection(pg_temp.r772('plan'));
	v_codex jsonb := pg_temp.r772_connection(pg_temp.r772('codex'));
begin
	if v_plan ->> 'login_kind' is distinct from 'chatgpt_plan' or v_plan ->> 'allow_autonomous' is distinct from 'false'
		or not (v_plan ? 'routine_offer_shown_at') or v_plan -> 'routine_offer_shown_at' <> 'null'::jsonb then
		raise exception 'the plan login reads wrong: %', v_plan; end if;
	if v_codex ->> 'login_kind' is distinct from 'codex' or v_codex -> 'routine_offer_shown_at' <> 'null'::jsonb then
		raise exception 'the Codex login reads wrong: %', v_codex; end if;
	-- A node login has no vault login: no kind.
	if exists (select 1 from jsonb_array_elements(current_setting('qorpera_test.plan764_last')::jsonb -> 'connections') as entry
		where (entry ->> 'connection_id')::uuid not in (pg_temp.r772('plan'), pg_temp.r772('codex'))
			and entry -> 'login_kind' <> 'null'::jsonb) then
		raise exception 'a node login reads with a kind: %', current_setting('qorpera_test.plan764_last'); end if;
	if not exists (select 1 from jsonb_array_elements(current_setting('qorpera_test.plan764_last')::jsonb -> 'connections') as entry
		where (entry ->> 'connection_id')::uuid not in (pg_temp.r772('plan'), pg_temp.r772('codex'))) then
		raise exception 'the fixture lists no node login'; end if;
end $$;
-- The member turns on work while away: the list says so.
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format(
	'select public.qorpera_set_chatgpt_plan_work_while_away(%L,%L,true)::text',
	'16000000-0000-4000-8000-000000000010', pg_temp.r772('plan'))), 'ok', 'the member turns on work while away');
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_list_member_native_execution_connections(''16000000-0000-4000-8000-000000000010'')::text'),
	'ok', 'the member''s connections');
reset role;
do $$
begin
	if pg_temp.r772_connection(pg_temp.r772('plan')) ->> 'allow_autonomous' is distinct from 'true' then
		raise exception 'the consented plan login reads without consent: %', pg_temp.r772_connection(pg_temp.r772('plan')); end if;
end $$;

-- 2. The first-routine card is recorded once per member and company, by that member only. Rows written directly
-- give the other member a plan login too, and the member a second plan connection (as a new sign-in makes).
create function pg_temp.r772_copy_plan(p_owner uuid, p_connection uuid, p_capsule uuid, p_login uuid) returns void
language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_provider_connections
	select (jsonb_populate_record(source, jsonb_build_object('id', p_connection, 'client_connection_id', extensions.gen_random_uuid(),
		'owner_user_id', p_owner, 'created_by_user_id', p_owner))).*
	from public.qorpera_provider_connections as source where source.id = pg_temp.r772('plan');
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(source, jsonb_build_object('connection_id', p_connection, 'credential_capsule_id', p_capsule))).*
	from public.qorpera_provider_connection_versions as source where source.connection_id = pg_temp.r772('plan');
	insert into public.qorpera_model_logins
	select (jsonb_populate_record(source, jsonb_build_object('id', p_login, 'credential_capsule_id', p_capsule,
		'sign_in_session_id', null, 'compute_identity_id', extensions.gen_random_uuid(),
		'broker_authority_id', extensions.gen_random_uuid()))).*
	from public.qorpera_model_logins as source where source.id = '76400000-0000-4000-8000-000000000150';
	set local session_replication_role = origin;
end $$;
select pg_temp.r772_copy_plan('16000000-0000-4000-8000-000000000002', '77200000-0000-4000-8000-000000000021',
	'77200000-0000-4000-8000-000000000022', '77200000-0000-4000-8000-000000000023');
select pg_temp.r772_copy_plan('16000000-0000-4000-8000-000000000001', '77200000-0000-4000-8000-000000000031',
	'77200000-0000-4000-8000-000000000032', '77200000-0000-4000-8000-000000000033');
create function pg_temp.r772_record(p_user text, p_profile text, p_connection uuid) returns text language plpgsql as $$
begin
	perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, false);
	set local role authenticated;
	return pg_temp.plan764_try(format('select public.qorpera_record_chatgpt_plan_routine_offer(%L,%L)::text', p_profile, p_connection));
end $$;
-- Refused for another member's plan, someone outside the company, the plan named under another company (the
-- member is in that one too), and a Codex login.
set local session_replication_role = replica;
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('76400000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000001',
	'native-owner@example.test', 'Native Owner', 'contributor')
on conflict do nothing;
set local session_replication_role = origin;
select pg_temp.plan764_expect(pg_temp.r772_record('16000000-0000-4000-8000-000000000002',
	'16000000-0000-4000-8000-000000000010', pg_temp.r772('plan')),
	'42501:ChatGPT plan login is unavailable', 'another member records the card for someone''s plan');
reset role;
select pg_temp.plan764_expect(pg_temp.r772_record('76400000-0000-4000-8000-000000000099',
	'16000000-0000-4000-8000-000000000010', pg_temp.r772('plan')),
	'42501:ChatGPT plan login is unavailable', 'someone outside the company');
reset role;
select pg_temp.plan764_expect(pg_temp.r772_record('16000000-0000-4000-8000-000000000001',
	'76400000-0000-4000-8000-000000000010', pg_temp.r772('plan')),
	'42501:ChatGPT plan login is unavailable', 'the plan named under another company');
reset role;
select pg_temp.plan764_expect(pg_temp.r772_record('16000000-0000-4000-8000-000000000001',
	'16000000-0000-4000-8000-000000000010', pg_temp.r772('codex')),
	'22023:Not a ChatGPT plan login', 'the card for a Codex login');
reset role;
-- The other member is shown the card first: the member's own plan still reads as never shown.
select pg_temp.plan764_expect(pg_temp.r772_record('16000000-0000-4000-8000-000000000002',
	'16000000-0000-4000-8000-000000000010', '77200000-0000-4000-8000-000000000021'), 'ok', 'the other member''s card');
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_list_member_native_execution_connections(''16000000-0000-4000-8000-000000000010'')::text'),
	'ok', 'the member''s connections');
reset role;
do $$
begin
	if pg_temp.r772_connection(pg_temp.r772('plan')) -> 'routine_offer_shown_at' <> 'null'::jsonb then
		raise exception 'another member''s card reads as the member''s: %', pg_temp.r772_connection(pg_temp.r772('plan')); end if;
end $$;
-- The member's card: once, also on their later plan connection.
select pg_temp.plan764_expect(pg_temp.r772_record('16000000-0000-4000-8000-000000000001',
	'16000000-0000-4000-8000-000000000010', pg_temp.r772('plan')), 'ok', 'the member''s card is shown');
reset role;
select set_config('qorpera_test.r772_shown', current_setting('qorpera_test.plan764_last')::jsonb ->> 'shown_at', false);
select pg_temp.plan764_expect(pg_temp.r772_record('16000000-0000-4000-8000-000000000001',
	'16000000-0000-4000-8000-000000000010', pg_temp.r772('plan')), 'ok', 'shown again');
reset role;
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last')::jsonb ->> 'shown_at',
	current_setting('qorpera_test.r772_shown'), 'a repeat answers the first showing');
select pg_temp.plan764_expect(pg_temp.r772_record('16000000-0000-4000-8000-000000000001',
	'16000000-0000-4000-8000-000000000010', '77200000-0000-4000-8000-000000000031'), 'ok', 'shown on a later plan login');
reset role;
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last')::jsonb ->> 'shown_at',
	current_setting('qorpera_test.r772_shown'), 'a later plan login answers the member''s first showing');
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_list_member_native_execution_connections(''16000000-0000-4000-8000-000000000010'')::text'),
	'ok', 'the member''s connections');
reset role;
do $$
begin
	if (pg_temp.r772_connection(pg_temp.r772('plan')) ->> 'routine_offer_shown_at')::timestamptz
		is distinct from current_setting('qorpera_test.r772_shown')::timestamptz then
		raise exception 'the list does not say the card was shown: %', pg_temp.r772_connection(pg_temp.r772('plan')); end if;
	if (select count(*) from public.qorpera_chatgpt_plan_routine_offers) <> 2 then
		raise exception 'the cards were not recorded once per member'; end if;
end $$;
-- Nothing is recorded for a revoked plan connection, by a member who left, or in a company being deleted.
update public.qorpera_provider_connections set status = 'revoked' where id = '77200000-0000-4000-8000-000000000031';
select pg_temp.plan764_expect(pg_temp.r772_record('16000000-0000-4000-8000-000000000001',
	'16000000-0000-4000-8000-000000000010', '77200000-0000-4000-8000-000000000031'),
	'42501:ChatGPT plan login is unavailable', 'a revoked plan connection');
reset role;
savepoint r772_left;
set local session_replication_role = replica;
delete from public.qorpera_profile_members
where profile_id = '16000000-0000-4000-8000-000000000010' and user_id = '16000000-0000-4000-8000-000000000001';
set local session_replication_role = origin;
select pg_temp.plan764_expect(pg_temp.r772_record('16000000-0000-4000-8000-000000000001',
	'16000000-0000-4000-8000-000000000010', pg_temp.r772('plan')),
	'42501:ChatGPT plan login is unavailable', 'a member who left');
reset role;
rollback to savepoint r772_left;
savepoint r772_deleting;
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('16000000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000001');
select pg_temp.plan764_expect(pg_temp.r772_record('16000000-0000-4000-8000-000000000001',
	'16000000-0000-4000-8000-000000000010', pg_temp.r772('plan')),
	'42501:ChatGPT plan login is unavailable', 'a company being deleted');
reset role;
rollback to savepoint r772_deleting;

-- 3. The routine list names a paused routine's reason and the member its current version runs for (an agent's
-- routine that waits for a payer, written directly for this read; another member saved its current version).
set local session_replication_role = replica;
insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, created_by_user_id, current_version,
	status, pause_reason)
values ('77200000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000020',
	'77200000-0000-4000-8000-000000000002', '16000000-0000-4000-8000-000000000002', 1, 'paused', 'needs_model_account');
insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id, environment_id,
	staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id)
values ('77200000-0000-4000-8000-000000000001', 1, '77200000-0000-4000-8000-000000000003',
	'16000000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000020', '16000000-0000-4000-8000-000000000030',
	'Morning notes', 'Write the morning notes.', '[{"id":"schedule-main","kind":"schedule","intervalMinutes":60}]', 'medium',
	(current_setting('qorpera_test.native_sponsor')::jsonb ->> 'binding_id')::uuid,
	(current_setting('qorpera_test.native_sponsor')::jsonb ->> 'version')::bigint, repeat('a', 64),
	'16000000-0000-4000-8000-000000000001');
set local session_replication_role = origin;
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_list_cloud_routines(''16000000-0000-4000-8000-000000000020'')::text'), 'ok', 'the routines');
reset role;
do $$
declare v_routine jsonb;
begin
	select entry into v_routine from jsonb_array_elements(current_setting('qorpera_test.plan764_last')::jsonb) as entry
	where entry ->> 'routine_id' = '77200000-0000-4000-8000-000000000001';
	if v_routine ->> 'status' is distinct from 'paused' or v_routine ->> 'pause_reason' is distinct from 'needs_model_account'
		or v_routine ->> 'runs_for_user_id' is distinct from '16000000-0000-4000-8000-000000000001' then
		raise exception 'the routine reads wrong: %', v_routine; end if;
end $$;

rollback;
