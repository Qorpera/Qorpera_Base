-- 20260929570000: internal functions are not callable over the API.
-- Supabase's default privileges grant EXECUTE on every new public function to anon, authenticated and
-- service_role. The functions below were revoked from PUBLIC only, so in production the publishable key
-- could call them. The migration names the roles. This suite pins each function's API roles by exact
-- signature, shows that the grant is the only gate in front of the worst of them, and runs their real
-- callers as the real roles: the invitation email worker as service_role, and member RPCs that reach the
-- revoked functions SQL-to-SQL as the owner.
-- The CI bootstrap does not copy the platform's function defaults, so part 1 cannot tell the migration's
-- revokes from grants that were never made; it catches an explicit grant coming back.
begin;
reset role;
-- Counts the calls of every function below, so part 4 can show the real callers reached them.
set local track_functions = 'all';

create function pg_temp.grants_assert(p_ok boolean, p_message text) returns void language plpgsql as $$
begin
	if p_ok is not true then raise exception 'API role grants: %', p_message; end if;
end
$$;

-- 1. Who may execute each function. anon: never. authenticated: only the member RPC
-- qorpera_session_profile_id. service_role: the invitation delivery worker's three functions; the
-- three CHECK constraint validators are not asserted, since the migration leaves service_role as it was
-- (granted by the platform default in production, never granted here).
create temporary table grants_expected(signature text primary key, authenticated boolean not null, service_role boolean)
on commit drop;
insert into grants_expected(signature, authenticated, service_role) values
	('public.qorpera_lock_profile_gc_fence(uuid)', false, false),
	('public.qorpera_append_company_operation(uuid, uuid, text, uuid, bigint, jsonb, uuid)', false, false),
	('public.qorpera_reserve_execution_sponsor_authority(uuid)', false, false),
	('public.qorpera_quarantine_runner_model_requests(uuid, text)', false, false),
	('public.qorpera_append_runner_audit(uuid, uuid, uuid, text, jsonb, uuid)', false, false),
	('public.qorpera_append_artifact_gc_audit(public.qorpera_artifact_gc_plans, text, jsonb, uuid)', false, false),
	('public.qorpera_ensure_current_company_substrate(uuid, uuid, uuid, uuid, uuid)', false, false),
	('public.qorpera_artifact_gc_initial_guard_ready(uuid)', false, false),
	('public.qorpera_object_root_creator(text, uuid)', false, false),
	('public.qorpera_object_root_has_current_proof(text, uuid)', false, false),
	('public.qorpera_object_graph_objects_available(uuid)', false, false),
	('public.qorpera_profile_reachability_coverage_ready(uuid)', false, false),
	('public.qorpera_provider_execution_enabled(text, text, text)', false, false),
	('public.qorpera_current_email_verified()', false, false),
	('public.qorpera_runner_session_valid(uuid, text)', false, false),
	('public.qorpera_artifact_gc_plan_json(public.qorpera_artifact_gc_plans)', false, false),
	('public.qorpera_runner_json(public.qorpera_runners)', false, false),
	('public.qorpera_execution_run_json(public.qorpera_execution_runs)', false, false),
	('public.qorpera_execution_work_json(public.qorpera_runner_job_claims)', false, false),
	('public.qorpera_artifact_json(public.qorpera_artifacts)', false, false),
	('public.qorpera_artifact_index_json(public.qorpera_artifact_indexes)', false, false),
	('public.qorpera_artifact_retention_hold_json(public.qorpera_artifact_retention_holds)', false, false),
	('public.qorpera_company_substrate_version_json(public.qorpera_company_substrate_versions)', false, false),
	('public.qorpera_object_reachability_graph_json(public.qorpera_object_reachability_graphs)', false, false),
	('public.qorpera_object_restore_proof_json(public.qorpera_object_restore_proofs)', false, false),
	('public.qorpera_runner_job_json(public.qorpera_runner_jobs)', false, false),
	('public.qorpera_runner_model_policy_json(public.qorpera_runner_model_policies)', false, false),
	('public.qorpera_runner_usage_json(public.qorpera_runner_usage_observations)', false, false),
	('public.qorpera_runner_model_gateway_authority(uuid)', false, false),
	('public.qorpera_profile_invitation_delivery_json(uuid)', false, false),
	('public.qorpera_execution_compute_available(public.qorpera_execution_runs)', false, false),
	('public.qorpera_execution_sponsor_available(public.qorpera_execution_runs)', false, false),
	('public.qorpera_compute_policy_sha256(jsonb)', false, false),
	('public.qorpera_interaction_host_valid(text)', false, false),
	('public.qorpera_interaction_request_valid(jsonb)', false, false),
	('public.qorpera_interaction_text_valid(jsonb, integer, integer)', false, false),
	('public.qorpera_runner_transcript_entry_valid(text, jsonb)', false, false),
	('public.qorpera_claim_profile_invitation_deliveries(integer, uuid)', false, true),
	('public.qorpera_complete_profile_invitation_delivery(uuid, uuid, text)', false, true),
	('public.qorpera_fail_profile_invitation_delivery(uuid, uuid, text, boolean)', false, true),
	('public.qorpera_provider_quota_policy_valid(jsonb)', false, null),
	('public.qorpera_runner_capabilities_valid(jsonb)', false, null),
	('public.qorpera_uuid_array_is_unique(uuid[])', false, null),
	('public.qorpera_session_profile_id(uuid)', true, false);

do $$
declare v_row record; v_function regprocedure; v_owner oid; v_acl aclitem[];
begin
	perform pg_temp.grants_assert((select count(*) from grants_expected) = 44, 'the suite covers all 44 functions');
	for v_row in select * from grants_expected order by signature loop
		-- A signature that no longer resolves fails here rather than passing quietly.
		v_function := v_row.signature::regprocedure;
		select proowner, proacl into v_owner, v_acl from pg_proc where oid = v_function;
		perform pg_temp.grants_assert(not has_function_privilege('anon', v_function, 'EXECUTE'),
			format('anon can execute %s', v_row.signature));
		perform pg_temp.grants_assert(has_function_privilege('authenticated', v_function, 'EXECUTE') = v_row.authenticated,
			format('authenticated execute on %s is not %s', v_row.signature, v_row.authenticated));
		perform pg_temp.grants_assert(v_row.service_role is null
			or has_function_privilege('service_role', v_function, 'EXECUTE') = v_row.service_role,
			format('service_role execute on %s is not %s', v_row.signature, v_row.service_role));
		-- PUBLIC stays revoked, and the owner keeps EXECUTE: security definer callers run as the owner.
		perform pg_temp.grants_assert(v_acl is not null
			and not exists (select 1 from aclexplode(v_acl) item where item.grantee = 0)
			and exists (select 1 from aclexplode(v_acl) item where item.grantee = v_owner and item.privilege_type = 'EXECUTE'),
			format('%s must be revoked from PUBLIC and executable by its owner (acl %s)', v_row.signature, v_acl));
	end loop;
end
$$;

-- Fixtures: a company made the members' way (qorpera_create_cloud_company), and two invitations
-- whose emails are due. Other suites may have left due invitations too; the worker claims those as well.
insert into auth.users (id, email, email_confirmed_at) values
	('74900000-0000-4000-8000-000000000001', 'grants-owner@example.test', statement_timestamp()),
	('74900000-0000-4000-8000-000000000002', 'grants-invitee@example.test', statement_timestamp());
select set_config('request.jwt.claims', '{"sub":"74900000-0000-4000-8000-000000000001","email":"grants-owner@example.test","role":"authenticated"}', false);
set role authenticated;
select set_config('qorpera_test.grants_company',
	public.qorpera_create_cloud_company('74900000-0000-4000-8000-0000000000c1', 'API Grants QA', 2) ->> 'profile_id', false);
select set_config('qorpera_test.grants_invitation',
	public.qorpera_invite_profile_member(current_setting('qorpera_test.grants_company')::uuid,
		'grants-invitee@example.test', 'contributor') ->> 'id', false);
select set_config('qorpera_test.grants_second_invitation',
	public.qorpera_invite_profile_member(current_setting('qorpera_test.grants_company')::uuid,
		'grants-second@example.test', 'viewer') ->> 'id', false);
reset role;
select set_config('request.jwt.claims', '', false);
update public.qorpera_profile_invitation_deliveries
set next_attempt_at = statement_timestamp() - interval '1 day'
where invitation_id in (current_setting('qorpera_test.grants_invitation')::uuid,
	current_setting('qorpera_test.grants_second_invitation')::uuid);
select set_config('qorpera_test.grants_session', (select session.id::text from public.qorpera_shared_sessions session
	where session.profile_id = current_setting('qorpera_test.grants_company')::uuid order by session.created_at limit 1), false);
select pg_temp.grants_assert(current_setting('qorpera_test.grants_company', true) <> ''
	and current_setting('qorpera_test.grants_invitation', true) <> ''
	and current_setting('qorpera_test.grants_second_invitation', true) <> ''
	and current_setting('qorpera_test.grants_session', true) <> '', 'fixtures: company, invitations and member session');

-- 2. The five worst are refused to anon (the publishable key) and to a member of the company, before
-- their bodies run: the error is PostgreSQL's own privilege error, not a check inside the function.
create function pg_temp.grants_calls() returns table(label text, statement text) language sql as $$
	select * from (values
		('claim invitation emails', 'select public.qorpera_claim_profile_invitation_deliveries(50, ''74900000-0000-4000-8000-0000000000e1'')'),
		('complete an invitation email', format('select public.qorpera_complete_profile_invitation_delivery(%L, ''74900000-0000-4000-8000-0000000000e1'', ''fake'')',
			current_setting('qorpera_test.grants_invitation'))),
		('fail an invitation email', format('select public.qorpera_fail_profile_invitation_delivery(%L, ''74900000-0000-4000-8000-0000000000e1'', ''fake'', false)',
			current_setting('qorpera_test.grants_invitation'))),
		('append a company operation', format('select public.qorpera_append_company_operation(%L, null, ''staff_state'', ''74900000-0000-4000-8000-0000000000e2'', 1, ''{}'', null)',
			current_setting('qorpera_test.grants_company'))),
		('lock the company GC fence', format('select public.qorpera_lock_profile_gc_fence(%L)', current_setting('qorpera_test.grants_company')))
	) as calls(label, statement)
$$;
create function pg_temp.grants_refused(p_label text, p_statement text) returns void language plpgsql as $$
begin
	begin
		execute p_statement;
	exception when insufficient_privilege then
		if sqlerrm like 'permission denied for function %' then return; end if;
		raise exception 'API role grants: % as % was refused by the function body, not by its grant: %', p_label, current_user, sqlerrm;
	end;
	raise exception 'API role grants: % succeeded as %', p_label, current_user;
end
$$;

select set_config('request.jwt.claims', '{"role":"anon"}', false);
set role anon;
select pg_temp.grants_assert(current_user = 'anon', 'running as anon');
select pg_temp.grants_refused(label, statement) from pg_temp.grants_calls();
select pg_temp.grants_refused('read a session''s company',
	format('select public.qorpera_session_profile_id(%L)', current_setting('qorpera_test.grants_session')));
reset role;

select set_config('request.jwt.claims', '{"sub":"74900000-0000-4000-8000-000000000001","email":"grants-owner@example.test","role":"authenticated"}', false);
set role authenticated;
select pg_temp.grants_assert(current_user = 'authenticated', 'running as authenticated');
select pg_temp.grants_refused(label, statement) from pg_temp.grants_calls();
reset role;

select set_config('request.jwt.claims', '{"role":"service_role"}', false);
set role service_role;
select pg_temp.grants_refused(label, statement) from pg_temp.grants_calls()
where label in ('append a company operation', 'lock the company GC fence');
reset role;
select set_config('request.jwt.claims', '', false);

-- 3. The grant is the only gate. With the grant the platform default gave (inside a savepoint), the
-- publishable key leases every due invitation email, across companies, with no company id.
savepoint grants_platform_default;
grant execute on function public.qorpera_claim_profile_invitation_deliveries(integer, uuid) to anon;
select set_config('request.jwt.claims', '{"role":"anon"}', false);
set role anon;
select pg_temp.grants_assert(exists (
	select 1 from jsonb_array_elements(public.qorpera_claim_profile_invitation_deliveries(50, '74900000-0000-4000-8000-0000000000e1')) job
	where job ->> 'recipient_email' = 'grants-invitee@example.test'), 'with the default grant anon leases the invitation email');
reset role;
rollback to savepoint grants_platform_default;
select set_config('request.jwt.claims', '', false);
select pg_temp.grants_assert(not has_function_privilege('anon', 'public.qorpera_claim_profile_invitation_deliveries(integer, uuid)', 'EXECUTE')
	and (select status from public.qorpera_profile_invitation_deliveries
		where invitation_id = current_setting('qorpera_test.grants_invitation')::uuid) = 'pending',
	'the savepoint undid the grant and the lease');

-- 4. The real callers still work.
-- The invitation email worker (profile-invitation-email, a secret key: service_role) claims, then
-- completes one email and records a retryable failure for the other.
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
set role service_role;
do $$
declare
	v_invitation uuid := current_setting('qorpera_test.grants_invitation')::uuid;
	v_second uuid := current_setting('qorpera_test.grants_second_invitation')::uuid;
	v_claimed jsonb;
begin
	v_claimed := public.qorpera_claim_profile_invitation_deliveries(50, '74900000-0000-4000-8000-0000000000f1');
	perform pg_temp.grants_assert((select count(*) from jsonb_array_elements(v_claimed) job
		where (job ->> 'invitation_id')::uuid in (v_invitation, v_second)
			and job ->> 'lease_id' = '74900000-0000-4000-8000-0000000000f1') = 2, 'the worker claims both invitation emails');
	perform public.qorpera_complete_profile_invitation_delivery(v_invitation, '74900000-0000-4000-8000-0000000000f1', 'grants-message-1');
	perform public.qorpera_fail_profile_invitation_delivery(v_second, '74900000-0000-4000-8000-0000000000f1', 'provider unavailable', true);
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);
select pg_temp.grants_assert((select status = 'delivered' and provider_message_id = 'grants-message-1'
	from public.qorpera_profile_invitation_deliveries where invitation_id = current_setting('qorpera_test.grants_invitation')::uuid),
	'the worker completed the first email');
select pg_temp.grants_assert((select status = 'retrying' from public.qorpera_profile_invitation_deliveries
	where invitation_id = current_setting('qorpera_test.grants_second_invitation')::uuid), 'the worker recorded the second email''s failure');

-- Members: sending to the company's session takes the GC fence, the session's company is readable to a
-- member, and the invitee lists the invitation. Creating the company above appended its operations and
-- inviting built the delivery rows, all SQL-to-SQL.
select set_config('request.jwt.claims', '{"sub":"74900000-0000-4000-8000-000000000001","email":"grants-owner@example.test","role":"authenticated"}', false);
set role authenticated;
select public.qorpera_append_session_input(current_setting('qorpera_test.grants_session')::uuid,
	'74900000-0000-4000-8000-0000000000d1', 'user_message', '{"schema":"qorpera.session-prompt/v1","text":"hello","images":[]}');
select pg_temp.grants_assert(public.qorpera_session_profile_id(current_setting('qorpera_test.grants_session')::uuid)
	= current_setting('qorpera_test.grants_company')::uuid, 'a member reads the session''s company');
reset role;
select set_config('request.jwt.claims', '{"sub":"74900000-0000-4000-8000-000000000002","email":"grants-invitee@example.test","role":"authenticated"}', false);
set role authenticated;
select pg_temp.grants_assert(public.qorpera_list_profile_invitations()::text like '%API Grants QA%', 'the invitee lists the invitation');
reset role;
select set_config('request.jwt.claims', '', false);

-- The member paths reached the revoked functions.
select pg_temp.grants_assert((select count(*) from pg_stat_xact_user_functions stat
	where stat.schemaname = 'public' and stat.calls > 0 and stat.funcname in ('qorpera_append_company_operation',
		'qorpera_lock_profile_gc_fence', 'qorpera_profile_invitation_delivery_json', 'qorpera_current_email_verified')) = 4,
	format('member paths called the revoked functions: %s', (select jsonb_object_agg(funcname, calls)
		from pg_stat_xact_user_functions where schemaname = 'public' and funcname in ('qorpera_append_company_operation',
			'qorpera_lock_profile_gc_fence', 'qorpera_profile_invitation_delivery_json', 'qorpera_current_email_verified'))));

rollback;
