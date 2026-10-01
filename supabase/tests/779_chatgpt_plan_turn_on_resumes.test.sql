-- @fixture 764_chatgpt_plan_login.test.sql until "-- A plan login is never listed for the account record the node switch-off reads; the Codex login is."
-- Sign in with ChatGPT (20260929985000): a member's own Turn on (qorpera_set_chatgpt_plan_work_while_away) also starts
-- the agent's routines that wait only for that member's plan: re-pinned to the plan's unattended binding of the
-- version just turned on, with a schedule cursor, and recorded on the new version. Never another member's routine, a
-- listener, a routine paused for another reason or paid by another login, one that ended, a folder file, nor in a
-- company being deleted or on the folder core; turning a plan off starts nothing; a routine locked elsewhere is
-- skipped, never waited for. Test 764's fixture leaves the member with a plan login (off) and a Codex vault login.
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

select pg_temp.r779_cleanup();
