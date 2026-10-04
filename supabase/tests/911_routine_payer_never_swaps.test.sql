-- @fixture 708_folder_state_routines.test.sql until "-- 2. A member's routine: its row, its version and its position"
-- A routine's payer never changes without permission (20260930064000, founder decision 2026-10-04). A routine keeps a
-- payer that serves its saver, also when that payer cannot pay: it waits as needs_model_account. A member picks
-- another of their own logins, or an owner or admin a company account, with qorpera_set_routine_login; another
-- member's own save is their own first choice. A changed payer is recorded, and the member whose login paid before is
-- told. The fixture's owner (…01) pays with login c1 (b1); the member (…02) has login c2 (b2), not for unattended work.

create function pg_temp.p911_as(p_user text) returns void language plpgsql as $$
begin
	perform set_config('request.jwt.claims', jsonb_build_object('sub', '70700000-0000-4000-8000-00000000000' || p_user,
		'role', 'authenticated')::text, true);
	execute 'set local role authenticated';
end $$;
-- Back to the fixture's service claims.
create function pg_temp.p911_back() returns void language plpgsql as $$
begin
	execute 'reset role';
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;
create function pg_temp.p911_pick(p_user text, p_routine uuid, p_connection uuid) returns text language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.p911_as(p_user);
	v := public.qorpera_set_routine_login(p_routine, p_connection);
	perform pg_temp.p911_back();
	return v ->> 'connectionId';
exception when others then
	perform pg_temp.p911_back();
	return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.p911_payer(p_routine uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.p911_as('1');
	v := public.qorpera_get_routine_payer(p_routine);
	perform pg_temp.p911_back();
	return v;
end $$;
create function pg_temp.p911_assert(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Routine payer: %', p_message; end if; end $$;
create function pg_temp.p911_told(p_user text, p_routine uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_member_notifications where kind = 'routine_payer_changed'
		and user_id = ('70700000-0000-4000-8000-00000000000' || p_user)::uuid and subject ->> 'routineId' = p_routine::text
$$;

-- 0. Privileges: members call the pick and the read; the helpers and the change table are nobody's.
do $$
begin
	if not has_function_privilege('authenticated', 'public.qorpera_set_routine_login(uuid,uuid)', 'execute')
		or not has_function_privilege('authenticated', 'public.qorpera_get_routine_payer(uuid)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_set_routine_login(uuid,uuid)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_company_state_routine_serves(uuid,uuid,uuid)', 'execute')
		or has_function_privilege('authenticated',
			'public.qorpera_record_routine_payer_change(uuid,bigint,uuid,bigint,uuid,bigint,uuid,text)', 'execute')
		or has_table_privilege('authenticated', 'public.qorpera_routine_payer_changes', 'select') then
		raise exception 'Routine payer privileges are wrong'; end if;
end $$;

-- The owner's second login c3 (b3, newer), and the member's login allowed to work while away (b2 version 2).
select pg_temp.fx($f$insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider,
	created_by_user_id) values ('91100000-0000-4000-8000-0000000000c3', '70700000-0000-4000-8000-000000000010',
	extensions.gen_random_uuid(), '70700000-0000-4000-8000-000000000001', 'openai', '70700000-0000-4000-8000-000000000001');
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
		to_jsonb(cv) || '{"connection_id":"91100000-0000-4000-8000-0000000000c3"}'::jsonb)).*
	from public.qorpera_provider_connection_versions cv where connection_id = '70800000-0000-4000-8000-0000000000c1';
	insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id) values
		('91100000-0000-4000-8000-0000000000b3', '70700000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'70700000-0000-4000-8000-000000000001');
	insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id,
		provider_connection_version, allow_autonomous, created_by_user_id, created_at) values ('91100000-0000-4000-8000-0000000000b3', 1,
		'member_connection', '91100000-0000-4000-8000-0000000000c3', 1, true, '70700000-0000-4000-8000-000000000001',
		clock_timestamp() + interval '1 second');
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
		to_jsonb(cv) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
	from public.qorpera_provider_connection_versions cv where connection_id = '70800000-0000-4000-8000-0000000000c2';
	insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id,
		provider_connection_version, allow_autonomous, created_by_user_id) values ('70800000-0000-4000-8000-0000000000b2', 2,
		'member_connection', '70800000-0000-4000-8000-0000000000c2', 2, true, '70700000-0000-4000-8000-000000000002')$f$);

-- 1. A new routine is its saver's own first choice: the owner's newest login, never a company account.
select pg_temp.p911_as('1');
select set_config('qorpera_test.p911_company', public.qorpera_register_provider_connection('70700000-0000-4000-8000-000000000010',
	'91100000-0000-4000-8000-0000000000d0', null, 'openai', 'api_key', 'codex-cli', 'vault://company/openai', 'org-911',
	'company-api-billing', 'qorpera-provider-consent/v1', null,
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}',
	true)::text, true);
select set_config('qorpera_test.p911_company_binding', public.qorpera_create_execution_sponsor_binding(
	'70700000-0000-4000-8000-000000000010', '91100000-0000-4000-8000-0000000000d1', 'company_api_billing',
	(current_setting('qorpera_test.p911_company')::jsonb ->> 'connection_id')::uuid, 1, true) ->> 'binding_id', true);
select pg_temp.p911_back();
set local role service_role;
select public.qorpera_set_provider_execution_policy('openai', 'api_key', 'codex-cli', 'supported', 'enabled', 64, null, null);
reset role;
do $$
declare e uuid := '91100000-0000-4000-8000-0000000000e1';
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p911-0001', jsonb_build_array(pg_temp.routine('agents/nora/routines/digest.md',
		pg_temp.rparse(e, 'Digest', pg_temp.every())))), 1, 'saved');
	perform pg_temp.p911_assert((pg_temp.rv(e)).sponsor_binding_id = '91100000-0000-4000-8000-0000000000b3',
		'a new routine starts on the saver''s newest own login, not the company account');
end $$;

-- 2. Its login can no longer work while the owner is away: an edit keeps it and the routine waits; it never moves to the
-- owner's other login or the company account.
select pg_temp.fx($f$insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
		to_jsonb(cv) || '{"version":2,"allow_autonomous":false}'::jsonb)).*
	from public.qorpera_provider_connection_versions cv where connection_id = '91100000-0000-4000-8000-0000000000c3' and version = 1$f$);
do $$
declare e uuid := '91100000-0000-4000-8000-0000000000e1'; p jsonb;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p911-0002', jsonb_build_array(pg_temp.routine('agents/nora/routines/digest.md',
		pg_temp.rparse(e, 'Digest, daily', pg_temp.every())))), 1, 'saved');
	perform pg_temp.p911_assert((pg_temp.rv(e)).sponsor_binding_id = '91100000-0000-4000-8000-0000000000b3'
		and (pg_temp.rt(e)).status = 'paused' and (pg_temp.rt(e)).pause_reason = 'needs_model_account',
		'a routine whose login cannot pay keeps it and waits: ' || to_jsonb(pg_temp.rv(e))::text);
	p := pg_temp.p911_payer(e);
	perform pg_temp.p911_assert(p ->> 'connectionId' = '91100000-0000-4000-8000-0000000000c3' and p ->> 'payer' = 'member'
		and (p ->> 'canPay')::boolean = false and p ->> 'pauseReason' = 'needs_model_account', 'the read says why: ' || p::text);
	perform pg_temp.p911_assert(not exists (select 1 from public.qorpera_routine_payer_changes where routine_id = e),
		'no change of payer was recorded');
end $$;

-- 3. The owner picks their other login: a version on it, the routine runs again, the pick is recorded; nobody else is told.
do $$
declare e uuid := '91100000-0000-4000-8000-0000000000e1'; p jsonb; c public.qorpera_routine_payer_changes;
begin
	perform pg_temp.p911_assert(pg_temp.p911_pick('1', e, '91100000-0000-4000-8000-0000000000c3')
		= '22023:This login cannot pay for this routine', 'a login that cannot pay is refused');
	perform pg_temp.p911_assert(pg_temp.p911_pick('1', e, '70800000-0000-4000-8000-0000000000c1')
		= '70800000-0000-4000-8000-0000000000c1', 'the owner picks their other login');
	perform pg_temp.p911_assert((pg_temp.rv(e)).sponsor_binding_id = '70800000-0000-4000-8000-0000000000b1'
		and (pg_temp.rv(e)).created_by_user_id = '70700000-0000-4000-8000-000000000001'
		and (pg_temp.rv(e)).title = 'Digest, daily' and (pg_temp.rt(e)).status = 'active' and (pg_temp.rt(e)).pause_reason is null
		and (pg_temp.cursor(e)).routine_version = (pg_temp.rt(e)).current_version,
		'the pick makes a version on the login and the routine runs again: ' || to_jsonb(pg_temp.rt(e))::text);
	select * into strict c from public.qorpera_routine_payer_changes where routine_id = e;
	perform pg_temp.p911_assert(c.reason = 'pick' and c.from_connection_id = '91100000-0000-4000-8000-0000000000c3'
		and c.to_connection_id = '70800000-0000-4000-8000-0000000000c1'
		and c.changed_by_user_id = '70700000-0000-4000-8000-000000000001', 'the pick is recorded: ' || to_jsonb(c)::text);
	perform pg_temp.p911_assert(pg_temp.p911_told('1', e) = 0, 'the member who picked is not told about their own pick');
	p := pg_temp.p911_payer(e);
	perform pg_temp.p911_assert((p ->> 'canPay')::boolean and p ->> 'changeReason' = 'pick'
		and (p ->> 'since')::timestamptz = c.changed_at, 'the read says since when: ' || p::text);
end $$;

-- 4. Who may pick what: the member never the owner's login nor, as a contributor, a company account.
do $$
declare e uuid := '91100000-0000-4000-8000-0000000000e1';
begin
	perform pg_temp.p911_assert(pg_temp.p911_pick('2', e, '70800000-0000-4000-8000-0000000000c1')
		= '42501:This login cannot pay for this routine', 'another member''s login');
	perform pg_temp.p911_assert(pg_temp.p911_pick('2', e, (current_setting('qorpera_test.p911_company')::jsonb ->> 'connection_id')::uuid)
		= '42501:This login cannot pay for this routine', 'a company account picked by a contributor');
	perform pg_temp.p911_assert(pg_temp.p911_pick('9', e, '70800000-0000-4000-8000-0000000000c1')
		= '42501:Routine is unavailable', 'someone who is not a member');
end $$;

-- 5. The member picks their own login for the owner's routine: they become its saver, and the owner is told.
do $$
declare e uuid := '91100000-0000-4000-8000-0000000000e1'; n public.qorpera_member_notifications;
begin
	perform pg_temp.p911_assert(pg_temp.p911_pick('2', e, '70800000-0000-4000-8000-0000000000c2')
		= '70800000-0000-4000-8000-0000000000c2', 'the member picks their own login');
	perform pg_temp.p911_assert((pg_temp.rv(e)).sponsor_binding_id = '70800000-0000-4000-8000-0000000000b2'
		and (pg_temp.rv(e)).sponsor_version = 2 and (pg_temp.rv(e)).created_by_user_id = '70700000-0000-4000-8000-000000000002',
		'the routine runs on the member''s login, for them: ' || to_jsonb(pg_temp.rv(e))::text);
	select * into strict n from public.qorpera_member_notifications where kind = 'routine_payer_changed'
		and user_id = '70700000-0000-4000-8000-000000000001' and subject ->> 'routineId' = e::text;
	perform pg_temp.p911_assert(n.subject ->> 'payer' = 'member' and n.subject ->> 'payerUserId' = '70700000-0000-4000-8000-000000000002'
		and n.subject ->> 'changedByUserId' = '70700000-0000-4000-8000-000000000002' and n.subject ->> 'reason' = 'pick'
		and n.profile_id = '70700000-0000-4000-8000-000000000010', 'the owner is told: ' || to_jsonb(n)::text);
end $$;

-- 6. The owner picks the company account: the saver stays the member, and the member is told.
do $$
declare e uuid := '91100000-0000-4000-8000-0000000000e1';
begin
	perform pg_temp.p911_assert(pg_temp.p911_pick('1', e, (current_setting('qorpera_test.p911_company')::jsonb ->> 'connection_id')::uuid)
		= current_setting('qorpera_test.p911_company')::jsonb ->> 'connection_id', 'an owner picks the company account');
	perform pg_temp.p911_assert((pg_temp.rv(e)).sponsor_binding_id = current_setting('qorpera_test.p911_company_binding')::uuid
		and (pg_temp.rv(e)).created_by_user_id = '70700000-0000-4000-8000-000000000002', 'the saver stays the member');
	perform pg_temp.p911_assert(pg_temp.p911_told('2', e) = 1, 'the member whose login paid is told');
	-- A company account serves every member: the member's edit keeps it.
	perform pg_temp.expect(pg_temp.commit(pg_temp.mem(), 'p911-0003', jsonb_build_array(pg_temp.routine('agents/nora/routines/digest.md',
		pg_temp.rparse(e, 'Digest, twice a day', pg_temp.every(720))))), 1, 'saved');
	perform pg_temp.p911_assert((pg_temp.rv(e)).sponsor_binding_id = current_setting('qorpera_test.p911_company_binding')::uuid,
		'an edit keeps the company account it serves');
end $$;

-- 7. Another member's own save of the owner's routine is their own act: their own login, recorded, and the owner told.
do $$
declare e uuid := '91100000-0000-4000-8000-0000000000e2'; c public.qorpera_routine_payer_changes;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p911-0004', jsonb_build_array(pg_temp.routine('agents/nora/routines/report.md',
		pg_temp.rparse(e, 'Report', pg_temp.every())))), 1, 'saved');
	perform pg_temp.p911_assert((pg_temp.rv(e)).sponsor_binding_id = '70800000-0000-4000-8000-0000000000b1', 'the owner''s routine');
	perform pg_temp.expect(pg_temp.commit(pg_temp.mem(), 'p911-0005', jsonb_build_array(pg_temp.routine('agents/nora/routines/report.md',
		pg_temp.rparse(e, 'Report, short', pg_temp.every())))), 1, 'saved');
	perform pg_temp.p911_assert((pg_temp.rv(e)).sponsor_binding_id = '70800000-0000-4000-8000-0000000000b2'
		and (pg_temp.rv(e)).created_by_user_id = '70700000-0000-4000-8000-000000000002', 'the member''s save pays with their own login');
	select * into strict c from public.qorpera_routine_payer_changes where routine_id = e;
	perform pg_temp.p911_assert(c.reason = 'save' and c.changed_by_user_id = '70700000-0000-4000-8000-000000000002',
		'the save is recorded: ' || to_jsonb(c)::text);
	perform pg_temp.p911_assert(pg_temp.p911_told('1', e) = 1, 'the owner is told');
end $$;

-- 8. An agent's routine is prepared only on the login its run pays with.
do $$
declare v_run jsonb := pg_temp.routine_run('91100000-0000-4000-8000-0000000000e2'); r public.qorpera_execution_runs;
begin
	select * into strict r from public.qorpera_execution_runs where id = (v_run ->> 'runId')::uuid;
	perform pg_temp.p911_assert((select binding_id from public.qorpera_agent_routine_sponsor(r)) = '70800000-0000-4000-8000-0000000000b2',
		'the run''s own login');
	r.sponsor_binding_id := '70800000-0000-4000-8000-0000000000b1';
	perform pg_temp.p911_assert(not exists (select 1 from public.qorpera_agent_routine_sponsor(r)),
		'never the login of another member, nor the member''s other one');
end $$;
