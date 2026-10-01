-- @fixture 395_runtime_coding_sessions.test.sql until "-- 2. The executor claims the session, prepares, admits the turn under the owner's sponsor, and the"
-- Sign in with ChatGPT, slice 1b (20260928359950): a member's ChatGPT plan pays for coding only when the asking
-- run is paid by that plan, and a coding worker takes the member's other login before a plan; switch-on gate 1
-- (20260929992000): a login that may work while its member is away comes before one that may not. Test 395's
-- fixture: the member's connection pays for the agent's run; the company has a coding executor and the agent a
-- repository grant. A connection is a plan login's when its capsule is a plan login's (rows written directly
-- for these checks).
create function pg_temp.plan775(p_connection uuid, p_login uuid) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_model_logins(id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id,
		provider, native_harness, current_version, access_issued_at, access_expires_at, login_kind)
	select p_login, connection.profile_id, extensions.gen_random_uuid(), version.credential_capsule_id,
		extensions.gen_random_uuid(), 'openai', 'codex-cli', 1, statement_timestamp(), statement_timestamp() + interval '1 hour',
		'chatgpt_plan'
	from public.qorpera_provider_connections as connection
	join public.qorpera_provider_connection_versions as version on version.connection_id = connection.id
	where connection.id = p_connection order by version.version desc limit 1;
	set local session_replication_role = origin;
end $$;
create function pg_temp.dispatch775(p_key text) returns jsonb language sql as $$
	select pg_temp.worker(jsonb_build_object('action', 'dispatch', 'operationKey', 'op-' || p_key, 'todoKey', 'composer-latency',
		'workerKey', p_key, 'title', 'Fix the delay after send', 'goal', 'g', 'definitionOfDone', 'd', 'access', 'read',
		'species', 'coding', 'harness', 'codex',
		'repository', '{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}'::jsonb))
$$;
create function pg_temp.owner_connection775(p_key text) returns uuid language sql as $$
	select sponsor.provider_connection_id from public.qorpera_runtime_workers as worker
	join public.qorpera_execution_sponsor_versions as sponsor
		on sponsor.binding_id = worker.owner_sponsor_binding_id and sponsor.version = worker.owner_sponsor_version
	where worker.worker_key = p_key
$$;
select set_config('qorpera_test.c775', current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id', false);

-- 1. The asking run's own login is the member's plan: the plan pays for the coding.
select pg_temp.plan775(current_setting('qorpera_test.c775')::uuid, '77500000-0000-4000-8000-000000000001');
select pg_temp.dispatch775('plan-same');
select pg_temp.wake_assert(pg_temp.owner_connection775('plan-same') = current_setting('qorpera_test.c775')::uuid,
	'Coding asked for by a run the plan pays for runs on that plan');
delete from public.qorpera_model_logins where id = '77500000-0000-4000-8000-000000000001';

-- 2. The member also connects a plan, newer than the login paying for the run. Coding takes the other login first.
do $$
declare v_plan uuid := '77500000-0000-4000-8000-000000000010';
begin
	set local session_replication_role = replica;
	insert into public.qorpera_provider_connections
	select (jsonb_populate_record(source, jsonb_build_object('id', v_plan, 'client_connection_id', '77500000-0000-4000-8000-000000000011',
		'created_at', clock_timestamp() + interval '1 minute'))).*
	from public.qorpera_provider_connections as source where source.id = current_setting('qorpera_test.c775')::uuid;
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(source, jsonb_build_object('connection_id', v_plan,
		'credential_capsule_id', '77500000-0000-4000-8000-000000000012'))).*
	from public.qorpera_provider_connection_versions as source where source.connection_id = current_setting('qorpera_test.c775')::uuid;
	set local session_replication_role = origin;
	perform pg_temp.plan775(v_plan, '77500000-0000-4000-8000-000000000013');
end $$;
select pg_temp.dispatch775('other-first');
select pg_temp.wake_assert(pg_temp.owner_connection775('other-first') = current_setting('qorpera_test.c775')::uuid,
	'Coding takes the member''s other login before a newer plan');

-- 3. Coding would take a plan that does not pay for the asking run (here the run's own login is an older plan,
--    so both are plans and the newer one comes first): refused at once, with a clear reason, never a wake
--    cancelled later.
select pg_temp.plan775(current_setting('qorpera_test.c775')::uuid, '77500000-0000-4000-8000-000000000001');
select pg_temp.wake_error($q$select pg_temp.dispatch775('plan-other')$q$, '55000',
	'Coding for this work needs a Codex login: a ChatGPT plan pays only for work started on it');

-- Switch-on gate 1 (20260929992000): a login that may work while its member is away comes first.
-- A new version of the login, as a consent change makes one (versions are never changed in place); written
-- directly, since the copied login's capsule is the fixture's.
create function pg_temp.away775(p_connection uuid, p_allow boolean, p_state text default 'active',
	p_harness text default 'codex-cli') returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(newest, jsonb_build_object('version', newest.version + 1, 'allow_autonomous', p_allow,
		'authorization_state', p_state, 'native_harness', p_harness, 'created_at', clock_timestamp()))).*
	from public.qorpera_provider_connection_versions as newest
	where newest.connection_id = p_connection
	order by newest.version desc limit 1;
	set local session_replication_role = origin;
end $$;

-- 4. The plan pays for the asking run, and the member's newer login is a Codex login that was never allowed to
--    work while away. Before, coding took that login and was refused; now the plan pays.
delete from public.qorpera_model_logins where id = '77500000-0000-4000-8000-000000000013';
select pg_temp.away775('77500000-0000-4000-8000-000000000010', false);
select pg_temp.dispatch775('plan-may');
select pg_temp.wake_assert(pg_temp.owner_connection775('plan-may') = current_setting('qorpera_test.c775')::uuid,
	'A plan that pays for the asking run pays for its coding, not a Codex login that may not work while away');

-- 5. Live for Codex logins (a bug fix): both are Codex logins, and only the older may work while away. Before,
--    coding took the newer and was refused; now it takes the older.
delete from public.qorpera_model_logins where id = '77500000-0000-4000-8000-000000000001';
select pg_temp.dispatch775('codex-may');
select pg_temp.wake_assert(pg_temp.owner_connection775('codex-may') = current_setting('qorpera_test.c775')::uuid,
	'Coding takes the member''s Codex login that may work while away over a newer one that may not');

-- 6. A Codex login that may work while away still comes before a plan that may: the plan pays only for work
--    started on it.
select pg_temp.plan775('77500000-0000-4000-8000-000000000010', '77500000-0000-4000-8000-000000000013');
select pg_temp.away775('77500000-0000-4000-8000-000000000010', true);
select pg_temp.dispatch775('codex-before-plan');
select pg_temp.wake_assert(pg_temp.owner_connection775('codex-before-plan') = current_setting('qorpera_test.c775')::uuid,
	'A Codex login that may work while away comes before a plan that may');

-- 7. Only the newest active version of the coding harness counts. The newer login once allowed work while away,
--    then was turned off; a later version that needs a new sign-in, and one for another harness, both allow it.
--    Neither makes the newer login one that may, so coding still takes the older one.
delete from public.qorpera_model_logins where id = '77500000-0000-4000-8000-000000000013';
select pg_temp.away775('77500000-0000-4000-8000-000000000010', false);
select pg_temp.away775('77500000-0000-4000-8000-000000000010', true, 'reauthentication_required');
select pg_temp.away775('77500000-0000-4000-8000-000000000010', true, 'active', 'claude-code');
select pg_temp.dispatch775('newest-active-harness');
select pg_temp.wake_assert(pg_temp.owner_connection775('newest-active-harness') = current_setting('qorpera_test.c775')::uuid,
	'Only the newest active version of the coding harness says whether a login may work while away');

-- 8. No login of the member may work while away: refused as before.
select pg_temp.away775(current_setting('qorpera_test.c775')::uuid, false);
select pg_temp.wake_error($q$select pg_temp.dispatch775('none-may')$q$, '42501',
	'The session owner has not allowed background work on their openai account');

rollback;
