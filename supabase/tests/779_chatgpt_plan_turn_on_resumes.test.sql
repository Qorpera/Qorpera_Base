-- @fixture 764_chatgpt_plan_login.test.sql until "-- A plan login is never listed for the account record the node switch-off reads; the Codex login is."
-- Sign in with ChatGPT (20260929985000): a member's own Turn on (qorpera_set_chatgpt_plan_work_while_away) also starts
-- the agent's routines that wait only for that member's plan: re-pinned to the plan's unattended binding of the
-- version just turned on, with a schedule cursor, and recorded on the new version. Never another member's routine, a
-- listener, a routine paused for another reason or paid by another login, one that ended, a folder file, one whose
-- agent is archived, nor in a
-- company being deleted or on the folder core; turning a plan off starts nothing; a routine locked elsewhere is
-- skipped, never waited for. The switch takes the company row before the routines and the plan, so it never
-- deadlocks with an agent's tool call (the fence, then its run's login), and waits at most 2 s for a lock, then answers
-- a plain 55P03. Test 764's fixture leaves the member with a plan login (off) and a Codex vault login.
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
	perform set_config('qorpera_test.r779', jsonb_build_object('plan', v_plan, 'codex', v_codex,
		'capsule', current_setting('qorpera_test.native_connection')::jsonb ->> 'connection_id')::text, false);
	-- The switch keeps its callers; the new helper is the kernel's own.
	if has_function_privilege('anon', 'public.qorpera_set_chatgpt_plan_work_while_away(uuid,uuid,boolean)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_set_chatgpt_plan_work_while_away(uuid,uuid,boolean)', 'execute')
		or not has_function_privilege('authenticated', 'public.qorpera_set_chatgpt_plan_work_while_away(uuid,uuid,boolean)', 'execute')
		or exists (select 1 from unnest(array['anon','authenticated','service_role']) as role(name)
			where has_function_privilege(role.name, 'public.qorpera_routine_waits_for_member_plan(uuid,uuid,uuid)', 'execute')) then
		raise exception 'the switch or its helper has the wrong callers'; end if;
	-- Its lock budget (a redefinition must repeat it).
	if (select array(select setting from unnest(proconfig) as setting order by setting) from pg_proc
		where oid = 'public.qorpera_set_chatgpt_plan_work_while_away(uuid,uuid,boolean)'::regprocedure)
		is distinct from array['lock_timeout=2s', 'search_path=""'] then
		raise exception 'the switch lost its lock budget'; end if;
end $$;
create function pg_temp.r779(p_key text) returns uuid language sql as $$
	select (current_setting('qorpera_test.r779')::jsonb ->> p_key)::uuid
$$;
create function pg_temp.r779_id(p_n integer) returns uuid language sql immutable as $$
	select ('77900000-0000-4000-8000-0000000000' || lpad(p_n::text, 2, '0'))::uuid
$$;
-- The member's switch, as a member calls it; the answer is kept in qorpera_test.plan764_last.
create function pg_temp.r779_call(p_user text, p_on boolean) returns text language plpgsql as $$
declare v_plan uuid := pg_temp.r779('plan');
begin
	perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, false);
	set local role authenticated;
	return pg_temp.plan764_try(format('select public.qorpera_set_chatgpt_plan_work_while_away(%L,%L,%L)::text',
		'16000000-0000-4000-8000-000000000010', v_plan, p_on));
end $$;
create function pg_temp.r779_resumed() returns text language sql as $$
	select coalesce((select string_agg(right(id, 2), ',' order by id)
		from jsonb_array_elements_text(current_setting('qorpera_test.plan764_last')::jsonb -> 'resumed_routines') as id), 'none')
$$;
-- Every test routine as status/reason/version, in id order.
create function pg_temp.r779_states() returns text language sql as $$
	select string_agg(right(routine.id::text, 2) || '=' || routine.status || '/' || coalesce(routine.pause_reason, '-') || '/'
		|| routine.current_version, ' ' order by routine.id)
	from public.qorpera_cloud_routines as routine where routine.id::text like '77900000-%'
$$;

-- The sponsor an agent's run pins when its member has no payer: the plan's own (not on for work while away). And one
-- on the member's Codex login.
insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id) values
	(pg_temp.r779_id(90), '16000000-0000-4000-8000-000000000010', pg_temp.r779_id(91), '16000000-0000-4000-8000-000000000001'),
	(pg_temp.r779_id(92), '16000000-0000-4000-8000-000000000010', pg_temp.r779_id(93), '16000000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id,
	provider_connection_version, allow_autonomous, created_by_user_id) values
	(pg_temp.r779_id(90), 1, 'member_connection', pg_temp.r779('plan'), 1, false, '16000000-0000-4000-8000-000000000001'),
	(pg_temp.r779_id(92), 1, 'member_connection', pg_temp.r779('codex'), 1, false, '16000000-0000-4000-8000-000000000001');

-- An agent's routine as its save leaves it, written directly (a plan cannot pay for a listener once saved, so the
-- listener's row is written without triggers).
create function pg_temp.r779_routine(p_n integer, p_runs_for uuid, p_status text, p_reason text, p_trigger jsonb,
	p_binding uuid, p_origin text default 'agent') returns void language plpgsql as $$
begin
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, current_version, status,
		pause_reason, created_by_user_id, origin, owner_staff_agent_id, routine_key, authorization_failures)
	values (pg_temp.r779_id(p_n), '16000000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000020',
		extensions.gen_random_uuid(), 1, p_status, p_reason, '16000000-0000-4000-8000-000000000001', p_origin,
		case when p_origin = 'agent' then '16000000-0000-4000-8000-000000000030'::uuid end,
		case when p_origin = 'agent' then 'routine-' || p_n end, 2);
	insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id, environment_id,
		staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id,
		created_at)
	values (pg_temp.r779_id(p_n), 1, extensions.gen_random_uuid(), '16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000020', '16000000-0000-4000-8000-000000000030', 'Morning notes ' || p_n,
		'Write the morning notes.', jsonb_build_array(p_trigger), 'high', p_binding, 1, repeat('a', 64), p_runs_for,
		clock_timestamp() - interval '3 hours');
	if p_trigger ->> 'kind' = 'schedule' then
		insert into public.qorpera_cloud_routine_schedule_cursors(routine_id, routine_version, trigger_id, last_scheduled_for,
			next_due_at)
		values (pg_temp.r779_id(p_n), 1, 'agent', clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour');
	end if;
	perform set_config('session_replication_role', 'origin', true);
end $$;
do $$
declare v_member uuid := '16000000-0000-4000-8000-000000000001'; v_other uuid := '16000000-0000-4000-8000-000000000002';
	v_hourly jsonb := '{"id":"agent","kind":"schedule","intervalMinutes":60}';
	v_plan uuid := pg_temp.r779_id(90); v_codex uuid := pg_temp.r779_id(92);
begin
	perform pg_temp.r779_routine(10, v_member, 'paused', 'needs_model_account', v_hourly, v_plan);
	perform pg_temp.r779_routine(11, v_member, 'paused', 'needs_model_account', jsonb_build_object('id', 'agent', 'kind', 'once',
		'at', to_char((clock_timestamp() + interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'timeZone', 'UTC'), v_plan);
	-- Left waiting: another member's (its current version runs for them, on this member's plan), a listener, one its
	-- agent paused, one paid by the member's Codex login, one that expired, a folder file, a member's own routine,
	-- one past its end.
	perform pg_temp.r779_routine(12, v_other, 'paused', 'needs_model_account', v_hourly, v_plan);
	perform pg_temp.r779_routine(13, v_member, 'paused', 'needs_model_account', '{"id":"agent","kind":"listener",
		"source":"company-file","path":"notes/today.md","match":"exact","timeZone":"UTC"}', v_plan);
	perform pg_temp.r779_routine(14, v_member, 'paused', 'agent', v_hourly, v_plan);
	perform pg_temp.r779_routine(15, v_member, 'paused', 'needs_model_account', v_hourly, v_codex);
	perform pg_temp.r779_routine(16, v_member, 'expired', null, v_hourly, v_plan);
	perform pg_temp.r779_routine(17, v_member, 'paused', 'needs_model_account', v_hourly, v_plan);
	update public.qorpera_cloud_routines set folder_environment_id = '16000000-0000-4000-8000-000000000020',
		folder_path = 'agents/native/routines/notes.md', folder_path_version = extensions.gen_random_uuid(),
		folder_commit_id = extensions.gen_random_uuid()
	where id = pg_temp.r779_id(17);
	perform pg_temp.r779_routine(18, v_member, 'paused', 'needs_model_account', v_hourly, v_plan, 'member');
	perform pg_temp.r779_routine(19, v_member, 'paused', 'needs_model_account', v_hourly, v_plan);
	update public.qorpera_cloud_routines set expires_at = clock_timestamp() - interval '1 minute'
	where id = pg_temp.r779_id(19);
end $$;
select set_config('qorpera_test.r779_before', pg_temp.r779_states(), false);

-- 1. The caller's own plan connection, once revoked, reads as unavailable like any other.
savepoint r779_revoked;
update public.qorpera_provider_connections set status = 'revoked' where id = pg_temp.r779('plan');
select pg_temp.plan764_expect(pg_temp.r779_call('16000000-0000-4000-8000-000000000001', true),
	'42501:ChatGPT plan login is unavailable', 'the member''s revoked plan');
reset role;
rollback to savepoint r779_revoked;

-- 2. Turning the plan off starts nothing; the answer names no routine.
select pg_temp.plan764_expect(pg_temp.r779_call('16000000-0000-4000-8000-000000000001', false), 'ok', 'the member turns it off');
reset role;
select pg_temp.plan764_expect(pg_temp.r779_resumed(), 'none', 'turning off starts nothing');
select pg_temp.plan764_expect(pg_temp.r779_states(), current_setting('qorpera_test.r779_before'), 'no routine changes');

-- 3. Nor in a company being deleted, nor in a company on the folder core (its agents write routine files): the plan
--    turns on, the routines wait.
savepoint r779_deleting;
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('16000000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000001');
select pg_temp.plan764_expect(pg_temp.r779_call('16000000-0000-4000-8000-000000000001', true), 'ok', 'on, in a company being deleted');
reset role;
select pg_temp.plan764_expect(pg_temp.r779_resumed(), 'none', 'a company being deleted starts nothing');
select pg_temp.plan764_expect(pg_temp.r779_states(), current_setting('qorpera_test.r779_before'), 'no routine changes');
rollback to savepoint r779_deleting;
savepoint r779_folder;
set local session_replication_role = replica;
update public.qorpera_company_files set core = 'folder-v2', head_snapshot_id = null, path_gateway_version = null
where environment_id = '16000000-0000-4000-8000-000000000020';
set local session_replication_role = origin;
select pg_temp.plan764_expect(pg_temp.r779_call('16000000-0000-4000-8000-000000000001', true), 'ok', 'on, on the folder core');
reset role;
select pg_temp.plan764_expect(pg_temp.r779_resumed(), 'none', 'a folder company starts nothing');
select pg_temp.plan764_expect(pg_temp.r779_states(), current_setting('qorpera_test.r779_before'), 'no routine changes');
rollback to savepoint r779_folder;
-- Nor a routine whose agent is archived: archiving keeps the routine, but every wake of it is cancelled
-- (qorpera_wake_authorized wants an active agent), so it does not wait only for the plan.
savepoint r779_archived;
update public.qorpera_profile_staff set employment_status = 'archived'
where profile_id = '16000000-0000-4000-8000-000000000010' and staff_agent_id = '16000000-0000-4000-8000-000000000030';
select pg_temp.plan764_expect(pg_temp.r779_call('16000000-0000-4000-8000-000000000001', true), 'ok', 'on, the agent archived');
reset role;
select pg_temp.plan764_expect(pg_temp.r779_resumed(), 'none', 'an archived agent''s routines wait');
select pg_temp.plan764_expect(pg_temp.r779_states(), current_setting('qorpera_test.r779_before'), 'no routine changes');
rollback to savepoint r779_archived;

-- 4. Another member turning their own switch never reaches this member's plan or routines.
select pg_temp.plan764_expect(pg_temp.r779_call('16000000-0000-4000-8000-000000000002', true),
	'42501:ChatGPT plan login is unavailable', 'another member');
reset role;

-- 5. The member turns the plan on: the two routines that wait only for it start, re-pinned to the plan's unattended
--    binding of the version just turned on; nothing else changes.
select pg_temp.plan764_expect(pg_temp.r779_call('16000000-0000-4000-8000-000000000001', true), 'ok', 'the member turns it on');
reset role;
select pg_temp.plan764_expect(pg_temp.r779_resumed(), '10,11', 'the answer names the started routines');
select pg_temp.plan764_expect(pg_temp.r779_states(), replace(replace(current_setting('qorpera_test.r779_before'),
	'10=paused/needs_model_account/1', '10=active/-/2'), '11=paused/needs_model_account/1', '11=active/-/2'),
	'only the two routines start');
do $$
declare v_answer jsonb := current_setting('qorpera_test.plan764_last')::jsonb; v_hex text; v_client uuid;
	v_binding public.qorpera_execution_sponsor_bindings%rowtype; v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_old public.qorpera_cloud_routine_versions%rowtype; v_new public.qorpera_cloud_routine_versions%rowtype;
	v_old_cursor public.qorpera_cloud_routine_schedule_cursors%rowtype; v_cursor public.qorpera_cloud_routine_schedule_cursors%rowtype;
begin
	-- The consent's answer, as before, plus the started routines.
	if v_answer ->> 'schema' is distinct from 'qorpera.provider-connection-consent/v1'
		or (v_answer ->> 'connection_id')::uuid is distinct from pg_temp.r779('plan')
		or v_answer ->> 'allow_autonomous' <> 'true' or v_answer ->> 'changed' <> 'true'
		or (v_answer ->> 'version')::bigint <> (select max(version) from public.qorpera_provider_connection_versions
			where connection_id = pg_temp.r779('plan')) then
		raise exception 'the answer changed shape: %', v_answer; end if;
	-- The binding qorpera_ensure_unattended_sponsor makes for that version.
	v_hex := encode(extensions.digest(convert_to('qorpera.unattended-sponsor/v1:' || pg_temp.r779('plan')::text || ':'
		|| (v_answer ->> 'version'), 'utf8'), 'sha256'), 'hex');
	v_client := (substr(v_hex,1,8) || '-' || substr(v_hex,9,4) || '-4' || substr(v_hex,14,3) || '-8' || substr(v_hex,18,3)
		|| '-' || substr(v_hex,21,12))::uuid;
	select * into strict v_binding from public.qorpera_execution_sponsor_bindings
	where profile_id = '16000000-0000-4000-8000-000000000010' and client_binding_id = v_client;
	select * into strict v_sponsor from public.qorpera_execution_sponsor_versions where binding_id = v_binding.id;
	if v_binding.created_by_user_id <> '16000000-0000-4000-8000-000000000001' or v_binding.status <> 'active'
		or v_sponsor.version <> 1 or v_sponsor.sponsor_kind <> 'member_connection'
		or v_sponsor.provider_connection_id <> pg_temp.r779('plan')
		or v_sponsor.provider_connection_version <> (v_answer ->> 'version')::bigint or not v_sponsor.allow_autonomous
		or v_sponsor.created_by_user_id <> '16000000-0000-4000-8000-000000000001' then
		raise exception 'the unattended binding is wrong: % %', to_jsonb(v_binding), to_jsonb(v_sponsor); end if;
	perform set_config('qorpera_test.r779_binding', v_binding.id::text, false);
	-- The new version: the old one with the new sponsor, marked as the member's resume, hashed as an agent's save.
	select * into strict v_old from public.qorpera_cloud_routine_versions where routine_id = pg_temp.r779_id(10) and version = 1;
	select * into strict v_new from public.qorpera_cloud_routine_versions where routine_id = pg_temp.r779_id(10) and version = 2;
	if to_jsonb(v_new) - array['version','client_version_id','sponsor_binding_id','sponsor_version','content_sha256',
			'created_at','resume_reason']
		is distinct from to_jsonb(v_old) - array['version','client_version_id','sponsor_binding_id','sponsor_version',
			'content_sha256','created_at','resume_reason']
		or v_new.client_version_id = v_old.client_version_id or v_new.created_at <= v_old.created_at
		or v_new.sponsor_binding_id <> v_binding.id or v_new.sponsor_version <> 1
		or v_new.resume_reason is distinct from 'plan_turned_on' or v_old.resume_reason is not null
		or v_new.content_sha256 <> encode(extensions.digest(convert_to(jsonb_build_object('staff_agent_id', v_old.staff_agent_id,
			'title', v_old.title, 'prompt', v_old.prompt, 'triggers', v_old.triggers, 'effort', v_old.effort,
			'sponsor_binding_id', v_binding.id, 'sponsor_version', 1, 'logical_computer_id', null,
			'required_capability', 'agent_turn', 'job_type', 'agent_turn', 'publication_mode', 'automatic',
			'review_policy_key', null, 'reviewer_staff_ids', '[]'::jsonb)::text, 'utf8'), 'sha256'), 'hex') then
		raise exception 'the resumed version is wrong: % from %', to_jsonb(v_new), to_jsonb(v_old); end if;
	if (select authorization_failures from public.qorpera_cloud_routines where id = pg_temp.r779_id(10)) <> 0 then
		raise exception 'the routine kept its authorization failures'; end if;
	-- The schedule restarts at the resume (a late switch back on), as an agent's save of a paused routine.
	select * into strict v_old_cursor from public.qorpera_cloud_routine_schedule_cursors
	where routine_id = pg_temp.r779_id(10) and routine_version = 1;
	select * into strict v_cursor from public.qorpera_cloud_routine_schedule_cursors
	where routine_id = pg_temp.r779_id(10) and routine_version = 2;
	if v_cursor.trigger_id <> 'agent' or v_cursor.last_scheduled_for is distinct from date_trunc('milliseconds', v_new.created_at)
		or v_cursor.next_due_at <> v_cursor.last_scheduled_for + interval '1 millisecond'
		or v_cursor.last_scheduled_for <= v_old_cursor.last_scheduled_for then
		raise exception 'the resumed schedule is wrong: % (was %)', to_jsonb(v_cursor), to_jsonb(v_old_cursor); end if;
	-- A dynamic routine takes no cursor; the tick makes its next run.
	if exists (select 1 from public.qorpera_cloud_routine_schedule_cursors where routine_id = pg_temp.r779_id(11))
		or (select sponsor_binding_id from public.qorpera_cloud_routine_versions
			where routine_id = pg_temp.r779_id(11) and version = 2) <> v_binding.id then
		raise exception 'the dynamic routine resumed wrong'; end if;
end $$;

-- 6. The routine list names the resume on the routine whose current version it is.
select set_config('request.jwt.claims', '{"sub":"16000000-0000-4000-8000-000000000002","role":"authenticated"}', false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_list_cloud_routines(''16000000-0000-4000-8000-000000000020'')::text'), 'ok', 'the routines');
reset role;
do $$
declare v_list jsonb := current_setting('qorpera_test.plan764_last')::jsonb; v_resumed jsonb; v_waiting jsonb;
begin
	select entry into strict v_resumed from jsonb_array_elements(v_list) as entry where (entry ->> 'routine_id')::uuid = pg_temp.r779_id(10);
	select entry into strict v_waiting from jsonb_array_elements(v_list) as entry where (entry ->> 'routine_id')::uuid = pg_temp.r779_id(12);
	if v_resumed ->> 'resume_reason' is distinct from 'plan_turned_on'
		or v_resumed ->> 'resumed_by_user_id' is distinct from '16000000-0000-4000-8000-000000000001'
		or (v_resumed ->> 'resumed_at')::timestamptz is distinct from (select created_at from public.qorpera_cloud_routine_versions
			where routine_id = pg_temp.r779_id(10) and version = 2)
		or v_resumed ->> 'status' <> 'active' or v_resumed -> 'pause_reason' <> 'null'::jsonb
		or (v_resumed ->> 'sponsor_binding_id')::uuid <> current_setting('qorpera_test.r779_binding')::uuid
		or v_waiting -> 'resume_reason' <> 'null'::jsonb or v_waiting -> 'resumed_at' <> 'null'::jsonb
		or v_waiting -> 'resumed_by_user_id' <> 'null'::jsonb then
		raise exception 'the list does not name the resume: % %', v_resumed, v_waiting; end if;
end $$;

-- 7. An agent's next save for the member finds the same binding (qorpera_ensure_unattended_sponsor, once the
--    member's other logins are gone, as in 768), so an identical save hashes to the resumed version.
update public.qorpera_provider_connections set status = 'revoked' where id in (pg_temp.r779('codex'), pg_temp.r779('capsule'));
do $$
declare v_run public.qorpera_execution_runs%rowtype; v_binding uuid; v_version bigint;
begin
	select * into strict v_run from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')::uuid;
	select sponsor.binding_id, sponsor.version into v_binding, v_version from public.qorpera_ensure_unattended_sponsor(v_run) as sponsor;
	if v_binding is distinct from current_setting('qorpera_test.r779_binding')::uuid or v_version is distinct from 1 then
		raise exception 'an agent''s save would pin another sponsor: % %', v_binding, v_version; end if;
end $$;

-- 8. Again: the plan is already on and nothing waits, so nothing more changes. Then off: nothing starts or stops.
select set_config('qorpera_test.r779_after', pg_temp.r779_states(), false);
select pg_temp.plan764_expect(pg_temp.r779_call('16000000-0000-4000-8000-000000000001', true), 'ok', 'on again');
reset role;
select pg_temp.plan764_expect(pg_temp.r779_resumed() || '/' || (current_setting('qorpera_test.plan764_last')::jsonb ->> 'changed'),
	'none/false', 'a second call starts nothing');
select pg_temp.plan764_expect(pg_temp.r779_states(), current_setting('qorpera_test.r779_after'), 'nothing more changes');
select pg_temp.plan764_expect(pg_temp.r779_call('16000000-0000-4000-8000-000000000001', false), 'ok', 'off');
reset role;
select pg_temp.plan764_expect(pg_temp.r779_resumed(), 'none', 'off starts nothing');
select pg_temp.plan764_expect(pg_temp.r779_states(), current_setting('qorpera_test.r779_after'), 'off changes no routine');

-- 8b. A binding an agent's save made for the plan version that is on is the one the switch pins: the plan is turned on
--     with nothing waiting, an agent's save for the member makes the plan's unattended binding
--     (qorpera_ensure_unattended_sponsor), then a routine waits and the member presses Turn on again: no second binding.
select pg_temp.plan764_expect(pg_temp.r779_call('16000000-0000-4000-8000-000000000001', true), 'ok', 'on, nothing waits');
reset role;
select pg_temp.plan764_expect(pg_temp.r779_resumed(), 'none', 'nothing waits');
do $$
declare v_run public.qorpera_execution_runs%rowtype; v_binding uuid; v_version bigint;
begin
	select * into strict v_run from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')::uuid;
	select sponsor.binding_id, sponsor.version into v_binding, v_version from public.qorpera_ensure_unattended_sponsor(v_run) as sponsor;
	if v_binding is null or v_binding = current_setting('qorpera_test.r779_binding')::uuid then
		raise exception 'ensure made no binding of its own for the version that is on: %', v_binding; end if;
	perform set_config('qorpera_test.r779_ensure_binding', v_binding::text, false);
	perform set_config('qorpera_test.r779_bindings', (select count(*) from public.qorpera_execution_sponsor_bindings
		where profile_id = '16000000-0000-4000-8000-000000000010')::text, false);
end $$;
select pg_temp.r779_routine(30, '16000000-0000-4000-8000-000000000001', 'paused', 'needs_model_account',
	'{"id":"agent","kind":"schedule","intervalMinutes":60}', pg_temp.r779_id(90));
select pg_temp.plan764_expect(pg_temp.r779_call('16000000-0000-4000-8000-000000000001', true), 'ok', 'on again, a routine waits');
reset role;
select pg_temp.plan764_expect(pg_temp.r779_resumed(), '30', 'the waiting routine starts');
do $$
begin
	if (select sponsor_binding_id::text || '/' || sponsor_version from public.qorpera_cloud_routine_versions
			where routine_id = pg_temp.r779_id(30) and version = 2) is distinct from current_setting('qorpera_test.r779_ensure_binding') || '/1'
		or (select count(*) from public.qorpera_execution_sponsor_bindings where profile_id = '16000000-0000-4000-8000-000000000010')::text
			<> current_setting('qorpera_test.r779_bindings') then
		raise exception 'the switch did not reuse the binding ensure made'; end if;
end $$;
select pg_temp.plan764_expect(pg_temp.r779_call('16000000-0000-4000-8000-000000000001', false), 'ok', 'off');
reset role;

-- 8c. The plan's unattended binding for the version the switch turns on exists already, but no longer pays with that
--     plan while the member is away: its newest sponsor version pays with another login (as a pins move leaves it),
--     or is not on for work while away, or the binding is switched off. The switch starts nothing.
create function pg_temp.r779_planned_binding(p_pays uuid, p_pays_version bigint, p_allow boolean, p_status text)
returns void language plpgsql as $$
declare v_hex text; v_id uuid := extensions.gen_random_uuid();
begin
	-- The version the switch is about to write: the newest plus one.
	v_hex := encode(extensions.digest(convert_to('qorpera.unattended-sponsor/v1:' || pg_temp.r779('plan')::text || ':'
		|| ((select max(version) from public.qorpera_provider_connection_versions where connection_id = pg_temp.r779('plan')) + 1)::text,
		'utf8'), 'sha256'), 'hex');
	insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, status, created_by_user_id)
	values (v_id, '16000000-0000-4000-8000-000000000010', (substr(v_hex,1,8) || '-' || substr(v_hex,9,4) || '-4' || substr(v_hex,14,3)
		|| '-8' || substr(v_hex,18,3) || '-' || substr(v_hex,21,12))::uuid, p_status, '16000000-0000-4000-8000-000000000001');
	insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id,
		provider_connection_version, allow_autonomous, created_by_user_id)
	values (v_id, 1, 'member_connection', p_pays, p_pays_version, p_allow, '16000000-0000-4000-8000-000000000001');
end $$;
savepoint r779_bindings;
select pg_temp.r779_routine(31, '16000000-0000-4000-8000-000000000001', 'paused', 'needs_model_account',
	'{"id":"agent","kind":"schedule","intervalMinutes":60}', pg_temp.r779_id(90));
do $$
declare v_plan_version bigint := (select max(version) from public.qorpera_provider_connection_versions
	where connection_id = pg_temp.r779('plan'));
	v_case record;
begin
	for v_case in select * from (values
		('pays with another login', pg_temp.r779('codex'), 1::bigint, true, 'active'),
		('is not on while away', pg_temp.r779('plan'), v_plan_version, false, 'active'),
		('is switched off', pg_temp.r779('plan'), v_plan_version, true, 'disabled')) as variant(label, pays, pays_version, allow, status) loop
		begin
			perform pg_temp.r779_planned_binding(v_case.pays, v_case.pays_version, v_case.allow, v_case.status);
			perform pg_temp.plan764_expect(pg_temp.r779_call('16000000-0000-4000-8000-000000000001', true), 'ok', 'on, ' || v_case.label);
			reset role;
			perform pg_temp.plan764_expect(pg_temp.r779_resumed(), 'none', 'a binding that ' || v_case.label || ' starts nothing');
			perform pg_temp.plan764_expect((select status || '/' || current_version from public.qorpera_cloud_routines
				where id = pg_temp.r779_id(31)), 'paused/1', 'the routine still waits (' || v_case.label || ')');
			raise exception using errcode = 'P0001', message = 'r779 undo';
		exception when sqlstate 'P0001' then
			if sqlerrm <> 'r779 undo' then raise; end if;
		end;
	end loop;
end $$;
rollback to savepoint r779_bindings;

-- 9. A routine locked elsewhere (an agent's save, the expiry sweep) is left waiting: the switch never waits for it.
--    Two more waiting routines; the plan is off again.
select pg_temp.r779_routine(20, '16000000-0000-4000-8000-000000000001', 'paused', 'needs_model_account',
	'{"id":"agent","kind":"schedule","intervalMinutes":60}', pg_temp.r779_id(90));
select pg_temp.r779_routine(21, '16000000-0000-4000-8000-000000000001', 'paused', 'needs_model_account',
	'{"id":"agent","kind":"schedule","intervalMinutes":60}', pg_temp.r779_id(90));

-- Row locks show only across connections, so the fixture is committed here and removed again at the end (the
-- harness of 602, 746 and 778): the test refuses to run beside other connections to this database, whose rows the
-- cleanup could not tell from its own.
reset role;
select set_config('qorpera_test.r779_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('r779_member', 'dbname=' || current_database());
select dblink_connect('r779_holder', 'dbname=' || current_database());
select set_config('qorpera_test.r779_' || name || '_pid', pid::text, false)
from unnest(array['member','holder']) name, lateral dblink('r779_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.r779_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r779_member_pid'),
			current_setting('qorpera_test.r779_holder_pid'))) then
		raise exception 'Plan turn-on lock test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r779_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r779_counts as select * from dblink('r779_member', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r779_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r779_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r779_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r779_rows select v_table, kept.row_value
			from dblink('r779_member', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.r779_collect(p_connection text) returns jsonb language plpgsql as $$
declare v_value jsonb; v_outcome jsonb;
begin
	begin
		select result into v_value from dblink_get_result(p_connection) as call(result jsonb);
		v_outcome := jsonb_build_object('result', v_value);
	exception when others then
		v_outcome := jsonb_build_object('error', sqlerrm, 'state', sqlstate);
	end;
	perform * from dblink_get_result(p_connection, false) as call(result jsonb);
	return v_outcome;
end
$$;
-- Whether the connection's call waited for a lock held by p_by before it finished (10 s at most).
create function pg_temp.r779_waited_for(p_connection text, p_by integer) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.r779_' || p_connection || '_pid')::integer;
begin
	for attempt in 1..400 loop
		if p_by = any(pg_blocking_pids(v_pid)) then return true; end if;
		exit when dblink_is_busy('r779_' || p_connection) = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;
-- At the end: remove what the test committed, as 602, 746 and 778 do.
create function pg_temp.r779_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.r779_first_xid')::xid;
begin
	perform pg_temp.r779_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r779_member','r779_holder']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r779_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r779_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r779_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r779_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Plan turn-on lock test cleanup left other row counts: %', v_wrong; end if;
end $$;

-- Another transaction holds routine 20 (as an agent's save does); the member turns the plan on meanwhile.
do $$
declare v_outcome jsonb;
begin
	perform dblink_exec('r779_holder', 'begin');
	perform * from dblink('r779_holder', format('select id from public.qorpera_cloud_routines where id = %L for update',
		pg_temp.r779_id(20))) as held(id uuid);
	perform dblink_exec('r779_member', 'begin');
	perform * from dblink('r779_member', $q$select set_config('request.jwt.claims',
		'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}', true)$q$) as claims(claims text);
	perform dblink_exec('r779_member', 'set local role authenticated');
	perform dblink_send_query('r779_member', format('select public.qorpera_set_chatgpt_plan_work_while_away(%L, %L, true)',
		'16000000-0000-4000-8000-000000000010', pg_temp.r779('plan')));
	if pg_temp.r779_waited_for('member', current_setting('qorpera_test.r779_holder_pid')::integer) then
		perform dblink_exec('r779_holder', 'rollback');
		raise exception 'Plan turn-on: the switch waited for a routine locked elsewhere: %', pg_temp.r779_collect('r779_member'); end if;
	v_outcome := pg_temp.r779_collect('r779_member');
	perform dblink_exec('r779_member', 'commit');
	perform dblink_exec('r779_holder', 'rollback');
	if v_outcome -> 'result' -> 'resumed_routines' is distinct from jsonb_build_array(pg_temp.r779_id(21))
		or v_outcome -> 'result' ->> 'allow_autonomous' <> 'true' then
		raise exception 'Plan turn-on: a locked routine was not skipped: %', v_outcome; end if;
	if (select status || '/' || current_version from public.qorpera_cloud_routines where id = pg_temp.r779_id(20)) <> 'paused/1'
		or (select status || '/' || current_version from public.qorpera_cloud_routines where id = pg_temp.r779_id(21)) <> 'active/2' then
		raise exception 'Plan turn-on: the routines read wrong after the lock: %', pg_temp.r779_states(); end if;
end $$;


-- The member's switch as a statement, and its call on the member's connection inside a transaction of its own.
create function pg_temp.r779_switch_sql(p_on boolean) returns text language sql as $$
	select format('select public.qorpera_set_chatgpt_plan_work_while_away(%L, %L, %L)',
		'16000000-0000-4000-8000-000000000010', pg_temp.r779('plan'), p_on)
$$;
create function pg_temp.r779_member_begin() returns void language plpgsql as $$
begin
	perform dblink_exec('r779_member', 'begin');
	perform * from dblink('r779_member', $q$select set_config('request.jwt.claims',
		'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}', true)$q$) as claims(claims text);
	perform dblink_exec('r779_member', 'set local role authenticated');
end $$;
-- What an agent's tool call on the member's plan holds: the company's fence (the company row FOR UPDATE, then its
-- wake admission row), then its run's login FOR SHARE.
create function pg_temp.r779_agent_call() returns void language plpgsql as $$
begin
	perform dblink_exec('r779_holder', 'begin');
	perform * from dblink('r779_holder', format('select 1 from public.qorpera_lock_profile_gc_fence(%L) as fence',
		'16000000-0000-4000-8000-000000000010')) as fenced(one integer);
	perform * from dblink('r779_holder', format('select 1 from public.qorpera_provider_connections where id = %L for share',
		pg_temp.r779('plan'))) as held(one integer);
end $$;
-- Whether the connection's call has finished within p_seconds.
create function pg_temp.r779_settles(p_connection text, p_seconds numeric) returns boolean language plpgsql as $$
begin
	for attempt in 1 .. (p_seconds * 40)::integer loop
		if dblink_is_busy('r779_' || p_connection) = 0 then return true; end if;
		perform pg_sleep(0.025);
	end loop;
	return false;
end $$;
-- The plan's versions: how many, and whether the newest is on.
create function pg_temp.r779_plan_versions() returns text language sql as $$
	select count(*) || '/' || (array_agg(version.allow_autonomous order by version.version desc))[1]
	from public.qorpera_provider_connection_versions as version where version.connection_id = pg_temp.r779('plan')
$$;

-- 10. An agent's tool call on the member's plan holds the fence and its login. The member's switch waits for the
--     company row while holding nothing, gives up after its 2 s budget with a plain "busy", and changes nothing.
--     Meanwhile the agent's call takes a waiting routine and the plan FOR UPDATE, as its routine save would,
--     without waiting for the switch: no deadlock. The plan is off and routine 22 waits, as routine 20 does.
select pg_temp.r779_routine(22, '16000000-0000-4000-8000-000000000001', 'paused', 'needs_model_account',
	'{"id":"agent","kind":"schedule","intervalMinutes":60}', pg_temp.r779_id(90));
do $$
begin
	perform pg_temp.r779_member_begin();
	perform * from dblink('r779_member', pg_temp.r779_switch_sql(false)) as call(result jsonb);
	perform dblink_exec('r779_member', 'commit');
end $$;
do $$
declare v_member integer := current_setting('qorpera_test.r779_member_pid')::integer;
	v_holder integer := current_setting('qorpera_test.r779_holder_pid')::integer;
	v_plan text := pg_temp.r779_plan_versions(); v_states text := pg_temp.r779_states(); v_agent jsonb; v_outcome jsonb;
begin
	if v_plan not like '%/false' then raise exception '(a) the plan is not off before the race: %', v_plan; end if;
	perform pg_temp.r779_agent_call();
	perform pg_temp.r779_member_begin();
	perform dblink_send_query('r779_member', pg_temp.r779_switch_sql(true));
	if not pg_temp.r779_waited_for('member', v_holder) then
		perform dblink_exec('r779_holder', 'rollback');
		raise exception '(a) the switch did not wait for the agent''s fence: %', pg_temp.r779_collect('r779_member'); end if;
	perform dblink_send_query('r779_holder', format('with routine as (select id from public.qorpera_cloud_routines
			where id = %L for update), plan as (select id from public.qorpera_provider_connections where id = %L for update)
		select jsonb_build_array((select id from routine), (select id from plan))', pg_temp.r779_id(20), pg_temp.r779('plan')));
	if pg_temp.r779_waited_for('holder', v_member) then
		raise exception '(a) the agent''s call waited for the switch (a deadlock)'; end if;
	v_agent := pg_temp.r779_collect('r779_holder');
	if v_agent -> 'result' is distinct from jsonb_build_array(pg_temp.r779_id(20), pg_temp.r779('plan')) then
		raise exception '(a) the agent''s call did not get its locks: %', v_agent; end if;
	if not pg_temp.r779_settles('member', 5) then
		perform dblink_exec('r779_holder', 'rollback');
		raise exception '(a) the switch did not give up within its lock budget'; end if;
	v_outcome := pg_temp.r779_collect('r779_member');
	perform dblink_exec('r779_member', 'rollback');
	perform dblink_exec('r779_holder', 'rollback');
	if v_outcome is distinct from '{"error": "Busy right now. Try again in a moment.", "state": "55P03"}'::jsonb then
		raise exception '(a) the switch answered %', v_outcome; end if;
	if pg_temp.r779_plan_versions() is distinct from v_plan or pg_temp.r779_states() is distinct from v_states then
		raise exception '(a) the busy switch changed something: % %', pg_temp.r779_plan_versions(), pg_temp.r779_states(); end if;
end $$;

-- 11. The member's switch goes first and holds its locks; an agent's call then waits for it at the fence, and both
--     finish.
do $$
declare v_member integer := current_setting('qorpera_test.r779_member_pid')::integer; v_switch jsonb; v_agent jsonb;
begin
	perform pg_temp.r779_member_begin();
	select call.result into v_switch from dblink('r779_member', pg_temp.r779_switch_sql(true)) as call(result jsonb);
	perform dblink_exec('r779_holder', 'begin');
	perform dblink_send_query('r779_holder', format('select to_jsonb(1) from public.qorpera_lock_profile_gc_fence(%L) as fence',
		'16000000-0000-4000-8000-000000000010'));
	if not pg_temp.r779_waited_for('holder', v_member) then
		perform dblink_exec('r779_member', 'rollback');
		raise exception '(b) the agent''s fence did not wait for the switch: %', pg_temp.r779_collect('r779_holder'); end if;
	perform dblink_exec('r779_member', 'commit');
	v_agent := pg_temp.r779_collect('r779_holder');
	if v_agent ? 'error' then raise exception '(b) the agent''s call failed: %', v_agent; end if;
	perform * from dblink('r779_holder', format('select 1 from public.qorpera_provider_connections where id = %L for share',
		pg_temp.r779('plan'))) as held(one integer);
	perform dblink_exec('r779_holder', 'rollback');
	if v_switch -> 'resumed_routines' is distinct from jsonb_build_array(pg_temp.r779_id(20), pg_temp.r779_id(22))
		or v_switch ->> 'changed' <> 'true' or pg_temp.r779_plan_versions() not like '%/true' then
		raise exception '(b) the switch did not turn the plan on and start both: %', v_switch; end if;
end $$;

-- 12. The agent's call ends within the switch's budget: the switch waits for it, then starts the waiting routine.
select pg_temp.r779_routine(23, '16000000-0000-4000-8000-000000000001', 'paused', 'needs_model_account',
	'{"id":"agent","kind":"schedule","intervalMinutes":60}', pg_temp.r779_id(90));
do $$
declare v_holder integer := current_setting('qorpera_test.r779_holder_pid')::integer; v_outcome jsonb;
begin
	perform pg_temp.r779_agent_call();
	perform pg_temp.r779_member_begin();
	perform dblink_send_query('r779_member', pg_temp.r779_switch_sql(true));
	if not pg_temp.r779_waited_for('member', v_holder) then
		perform dblink_exec('r779_holder', 'rollback');
		raise exception '(c) the switch did not wait for the agent''s fence: %', pg_temp.r779_collect('r779_member'); end if;
	perform pg_sleep(0.3);
	perform dblink_exec('r779_holder', 'rollback');
	v_outcome := pg_temp.r779_collect('r779_member');
	perform dblink_exec('r779_member', 'commit');
	if v_outcome -> 'result' -> 'resumed_routines' is distinct from jsonb_build_array(pg_temp.r779_id(23)) then
		raise exception '(c) the switch did not start the routine after the wait: %', v_outcome; end if;
	if (select status || '/' || current_version from public.qorpera_cloud_routines where id = pg_temp.r779_id(23)) <> 'active/2' then
		raise exception '(c) the routine reads wrong: %', pg_temp.r779_states(); end if;
end $$;

-- 13. A deletion request (the fence, then its row) is in flight when the member presses Turn on. The switch found its
--     routine before it locked anything, waits for the company row, and once the request commits reads the company
--     again under its key share: a company being deleted starts nothing. (The consent itself still turns the plan
--     on, as before this change; plan use stops for a company being deleted elsewhere.)
select pg_temp.r779_routine(24, '16000000-0000-4000-8000-000000000001', 'paused', 'needs_model_account',
	'{"id":"agent","kind":"schedule","intervalMinutes":60}', pg_temp.r779_id(90));
do $$
declare v_holder integer := current_setting('qorpera_test.r779_holder_pid')::integer; v_outcome jsonb;
begin
	perform dblink_exec('r779_holder', 'begin');
	perform * from dblink('r779_holder', format('select 1 from public.qorpera_lock_profile_gc_fence(%L) as fence',
		'16000000-0000-4000-8000-000000000010')) as fenced(one integer);
	perform dblink_exec('r779_holder', format('insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
		values (%L, %L)', '16000000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000001'));
	perform pg_temp.r779_member_begin();
	perform dblink_send_query('r779_member', pg_temp.r779_switch_sql(true));
	if not pg_temp.r779_waited_for('member', v_holder) then
		perform dblink_exec('r779_holder', 'rollback');
		raise exception '(13) the switch did not wait for the deletion request: %', pg_temp.r779_collect('r779_member'); end if;
	perform dblink_exec('r779_holder', 'commit');
	v_outcome := pg_temp.r779_collect('r779_member');
	perform dblink_exec('r779_member', 'commit');
	if v_outcome -> 'result' -> 'resumed_routines' is distinct from '[]'::jsonb
		or (select status || '/' || current_version from public.qorpera_cloud_routines where id = pg_temp.r779_id(24)) <> 'paused/1' then
		raise exception '(13) a company being deleted started a routine: % %', v_outcome, pg_temp.r779_states(); end if;
end $$;
delete from public.qorpera_company_deletions where profile_id = '16000000-0000-4000-8000-000000000010';
update public.qorpera_cloud_routines set status = 'retired', pause_reason = null where id = pg_temp.r779_id(24);

-- 14. An agent pauses one of two waiting routines (its fence, then the routine) while the member presses Turn on. The
--     switch found both before it locked anything; it reads each again under its lock, and starts only the other.
select pg_temp.r779_routine(25, '16000000-0000-4000-8000-000000000001', 'paused', 'needs_model_account',
	'{"id":"agent","kind":"schedule","intervalMinutes":60}', pg_temp.r779_id(90));
select pg_temp.r779_routine(26, '16000000-0000-4000-8000-000000000001', 'paused', 'needs_model_account',
	'{"id":"agent","kind":"schedule","intervalMinutes":60}', pg_temp.r779_id(90));
do $$
declare v_holder integer := current_setting('qorpera_test.r779_holder_pid')::integer; v_outcome jsonb;
begin
	perform dblink_exec('r779_holder', 'begin');
	perform * from dblink('r779_holder', format('select 1 from public.qorpera_lock_profile_gc_fence(%L) as fence',
		'16000000-0000-4000-8000-000000000010')) as fenced(one integer);
	perform dblink_exec('r779_holder', format('update public.qorpera_cloud_routines set pause_reason = %L,
		updated_at = statement_timestamp() where id = %L', 'agent', pg_temp.r779_id(25)));
	perform pg_temp.r779_member_begin();
	perform dblink_send_query('r779_member', pg_temp.r779_switch_sql(true));
	if not pg_temp.r779_waited_for('member', v_holder) then
		perform dblink_exec('r779_holder', 'rollback');
		raise exception '(14) the switch did not wait for the agent: %', pg_temp.r779_collect('r779_member'); end if;
	perform dblink_exec('r779_holder', 'commit');
	v_outcome := pg_temp.r779_collect('r779_member');
	perform dblink_exec('r779_member', 'commit');
	if v_outcome -> 'result' -> 'resumed_routines' is distinct from jsonb_build_array(pg_temp.r779_id(26))
		or (select status || '/' || coalesce(pause_reason, '-') || '/' || current_version from public.qorpera_cloud_routines
			where id = pg_temp.r779_id(25)) <> 'paused/agent/1' then
		raise exception '(14) the switch overrode the agent''s pause: % %', v_outcome, pg_temp.r779_states(); end if;
end $$;

-- 15. A deadlock broken on the switch's side answers the same busy. The one cycle the switch can be in: something
--     holds the member's row (an operator deleting a founder's account: the cascade) and then wants the company row
--     FOR UPDATE (its founder guard), while the switch holds the company row KEY SHARE and waits for that member row.
--     The switch waits first, so PostgreSQL's check after deadlock_timeout ends the switch; the other side goes on.
select pg_temp.r779_routine(27, '16000000-0000-4000-8000-000000000001', 'paused', 'needs_model_account',
	'{"id":"agent","kind":"schedule","intervalMinutes":60}', pg_temp.r779_id(90));
do $$
declare v_member integer := current_setting('qorpera_test.r779_member_pid')::integer;
	v_holder integer := current_setting('qorpera_test.r779_holder_pid')::integer;
	v_plan text := pg_temp.r779_plan_versions(); v_states text := pg_temp.r779_states(); v_outcome jsonb; v_other jsonb;
begin
	perform dblink_exec('r779_holder', 'begin');
	-- Only the switch's deadlock check may end the cycle (its 1 s), even on a machine that stalls: the other side
	-- checks after 10 s.
	perform dblink_exec('r779_holder', 'set local deadlock_timeout = ''10s''');
	perform * from dblink('r779_holder', format('select 1 from public.qorpera_profile_members where profile_id = %L
		and user_id = %L for update', '16000000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000001')) as held(one integer);
	perform pg_temp.r779_member_begin();
	perform dblink_send_query('r779_member', pg_temp.r779_switch_sql(true));
	if not pg_temp.r779_waited_for('member', v_holder) then
		perform dblink_exec('r779_holder', 'rollback');
		raise exception '(15) the switch did not wait for the member row: %', pg_temp.r779_collect('r779_member'); end if;
	perform dblink_send_query('r779_holder', format('select to_jsonb(id) from public.qorpera_profiles where id = %L for update',
		'16000000-0000-4000-8000-000000000010'));
	if not pg_temp.r779_settles('member', 5) then
		perform dblink_exec('r779_holder', 'rollback');
		raise exception '(15) the deadlock was not broken'; end if;
	v_outcome := pg_temp.r779_collect('r779_member');
	perform dblink_exec('r779_member', 'rollback');
	v_other := pg_temp.r779_collect('r779_holder');
	perform dblink_exec('r779_holder', 'rollback');
	if v_outcome is distinct from '{"error": "Busy right now. Try again in a moment.", "state": "55P03"}'::jsonb then
		raise exception '(15) the switch answered % (the other side: %)', v_outcome, v_other; end if;
	if v_other ? 'error' then raise exception '(15) the other side failed: %', v_other; end if;
	if pg_temp.r779_plan_versions() is distinct from v_plan or pg_temp.r779_states() is distinct from v_states then
		raise exception '(15) the broken switch changed something: % %', pg_temp.r779_plan_versions(), pg_temp.r779_states(); end if;
end $$;

select pg_temp.r779_cleanup();
