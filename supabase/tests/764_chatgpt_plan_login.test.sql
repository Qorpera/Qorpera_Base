-- @fixture 160_native_subscription_compute_identity.test.sql until "-- Exercise the Step 2 authority/receipt RPCs using this real admitted native run."
-- Sign in with ChatGPT, slice 1a (20260929800000): a member's ChatGPT plan login is a second kind of
-- vault login, built switched off. It is begun, read, completed, handed to a run and renewed only while
-- the platform switch is on and its company is on the list (and its sign-ins go to the vault); it is
-- always a member's own; the vault in service keeps reading Codex sign-ins with exactly its v1 answer;
-- a plan login renews past half its pass for a run, every 7 days when idle, never before OpenAI's
-- earliest time; a renewal is saved for its own kind only, even while switched off.
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);

-- A live run of the fixture's member (as test 690 builds it), for the run's issue below.
set role service_role;
do $$
declare v_run_id uuid := (current_setting('qorpera_test.own_turn')::jsonb ->> 'turn_request_id')::uuid;
	v_claim jsonb; v_runner jsonb; v_assignment jsonb; v_native jsonb; v_runner_id uuid; v_job_id uuid;
begin
	v_claim := public.qorpera_claim_runner_job_for_orchestrator(
		'16000000-0000-4000-8000-000000000092','76400000-0000-4000-8000-0000000000d1',120);
	if (v_claim -> 'work' ->> 'run_id')::uuid is distinct from v_run_id then
		raise exception 'fixture did not claim the member-native turn'; end if;
	v_job_id := (v_claim -> 'work' ->> 'job_id')::uuid;
	v_runner := public.qorpera_provision_execution_runner(v_run_id,'76400000-0000-4000-8000-0000000000d2','process',repeat('4',64));
	v_runner_id := (v_runner ->> 'runner_id')::uuid;
	perform public.qorpera_activate_runner(v_runner_id,repeat('4',64),repeat('5',64),'linux','chatgpt-plan-test');
	v_assignment := public.qorpera_assign_runner_job('16000000-0000-4000-8000-000000000092',(v_claim ->> 'claim_id')::uuid,
		v_runner_id,'76400000-0000-4000-8000-0000000000d3',repeat('6',64),120);
	perform public.qorpera_accept_runner_assignment(v_runner_id,repeat('5',64),(v_assignment ->> 'assignment_id')::uuid,
		v_job_id,repeat('6',64));
	v_native := public.qorpera_acquire_native_provider_connection_lease(v_run_id,v_runner_id,repeat('5',64),
		(v_assignment ->> 'assignment_id')::uuid,repeat('6',64),120);
	perform set_config('qorpera_test.plan764_binding',jsonb_build_object(
		'leaseId',v_native ->> 'lease_id','runId',v_run_id,'jobId',v_job_id,'runnerId',v_runner_id,
		'assignmentId',v_assignment ->> 'assignment_id','credentialCapsuleId',v_native ->> 'credential_capsule_id',
		'computeIdentityId',v_native ->> 'compute_identity_id')::text,false);
end $$;
reset role;

-- The company's broker and a second company without vault sign-ins.
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('76400000-0000-4000-8000-000000000010','Other company','16000000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('76400000-0000-4000-8000-000000000040','16000000-0000-4000-8000-000000000010','https://secrets.qorpera.test',
	 'company-kek-1',repeat('c',64));

-- One helper: run a statement, keep its answer, report ok or the error.
create function pg_temp.plan764_try(p_sql text)
returns text language plpgsql as $$
declare v_result text;
begin
	execute p_sql into v_result;
	perform set_config('qorpera_test.plan764_last', coalesce(v_result, 'null'), false);
	return 'ok';
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.plan764_expect(p_actual text, p_expected text, p_label text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.plan764_last() returns jsonb language sql as $$
	select current_setting('qorpera_test.plan764_last')::jsonb
$$;
grant execute on function pg_temp.plan764_try(text), pg_temp.plan764_expect(text,text,text), pg_temp.plan764_last()
	to authenticated, service_role, qorpera_secret_broker;

-- Privileges: the begin and the availability are members'; the list and the callback address the
-- service role's; the v2 read, the plan completion and the plan commit the broker's; the rest nobody's.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon','service_role','qorpera_secret_broker'] loop
		if has_function_privilege(v_role,'public.qorpera_begin_chatgpt_plan_sign_in(uuid,uuid,uuid,uuid,text,integer)','execute')
			or has_function_privilege(v_role,'public.qorpera_chatgpt_plan_available(uuid)','execute') then
			raise exception 'The member plan begin is exposed to %', v_role; end if;
	end loop;
	foreach v_role in array array['anon','authenticated','qorpera_secret_broker'] loop
		if has_function_privilege(v_role,'public.qorpera_set_chatgpt_plan_company(uuid,boolean)','execute')
			or has_function_privilege(v_role,'public.qorpera_chatgpt_plan_callback_target(text)','execute') then
			raise exception 'The plan switch is exposed to %', v_role; end if;
	end loop;
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_function_privilege(v_role,'public.qorpera_describe_model_login_sign_in_v2(uuid,text,uuid,text)','execute')
			or has_function_privilege(v_role,'public.qorpera_complete_chatgpt_plan_sign_in(uuid,text,uuid,text,uuid,text,text,text,timestamptz,timestamptz,text,text,timestamptz)','execute')
			or has_function_privilege(v_role,'public.qorpera_commit_chatgpt_plan_renewal(uuid,text,uuid,uuid,bigint,text,text,text,timestamptz,timestamptz,timestamptz)','execute')
			or has_function_privilege(v_role,'public.qorpera_take_chatgpt_plan_revocation(uuid,text)','execute')
			or has_function_privilege(v_role,'public.qorpera_finish_chatgpt_plan_revocation(uuid,text,uuid,uuid,bigint)','execute') then
			raise exception 'The plan vault calls are exposed to %', v_role; end if;
	end loop;
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		if has_function_privilege(v_role,'public.qorpera_chatgpt_plan_allowed(uuid)','execute')
			or has_function_privilege(v_role,'public.qorpera_model_login_renewal_due(public.qorpera_model_logins,timestamptz,boolean)','execute')
			or has_function_privilege(v_role,'public.qorpera_complete_model_login_sign_in_kind(uuid,text,uuid,text,uuid,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz)','execute')
			or has_function_privilege(v_role,'public.qorpera_commit_model_login_renewal_kind(uuid,text,uuid,uuid,bigint,text,text,text,timestamptz,timestamptz,text,timestamptz)','execute')
			or has_table_privilege(v_role,'public.qorpera_chatgpt_plan_settings','select')
			or has_table_privilege(v_role,'public.qorpera_chatgpt_plan_companies','select')
			or has_table_privilege(v_role,'public.qorpera_chatgpt_plan_hosts','select') then
			raise exception 'Plan internals are exposed to %', v_role; end if;
	end loop;
	if not has_function_privilege('qorpera_secret_broker','public.qorpera_describe_model_login_sign_in(uuid,text,uuid,text)','execute')
		or not has_function_privilege('qorpera_secret_broker','public.qorpera_complete_model_login_sign_in(uuid,text,uuid,text,uuid,text,text,text,timestamptz,timestamptz,text,text)','execute')
		or not has_function_privilege('qorpera_secret_broker','public.qorpera_commit_model_login_renewal(uuid,text,uuid,uuid,bigint,text,text,text,timestamptz,timestamptz)','execute') then
		raise exception 'The vault in service lost its Codex calls'; end if;
	if (select enabled from public.qorpera_chatgpt_plan_settings) is not false then
		raise exception 'The platform switch is not built off'; end if;
end $$;

-- Switched off: no member sees the button and no plan sign-in begins, even for a listed company.
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_chatgpt_plan_available(''16000000-0000-4000-8000-000000000010'')::text'),'ok','availability');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'false','off by default');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'16000000-0000-4000-8000-000000000010','76400000-0000-4000-8000-000000000101','76400000-0000-4000-8000-000000000102',
	current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-one'::bytea),'hex'))),
	'55000:ChatGPT plan sign-in is switched off','a begin while switched off');
select pg_temp.plan764_expect(pg_temp.plan764_try('select public.qorpera_set_chatgpt_plan_company(''16000000-0000-4000-8000-000000000010'',true)::text'),
	'42501:permission denied for function qorpera_set_chatgpt_plan_company','a member cannot list a company');
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
set role service_role;
-- A company joins the list only once its sign-ins go to its vault.
select pg_temp.plan764_expect(pg_temp.plan764_try('select public.qorpera_set_chatgpt_plan_company(''16000000-0000-4000-8000-000000000010'',true)::text'),
	'55000:company sign-ins do not go to its vault','a company whose sign-ins stay on nodes');
select pg_temp.plan764_expect(pg_temp.plan764_try('select public.qorpera_set_chatgpt_plan_company(''76400000-0000-4000-8000-000000000010'',true)::text'),
	'55000:company sign-ins do not go to its vault','a company without a vault');
select pg_temp.plan764_expect(pg_temp.plan764_try('select public.qorpera_set_model_login_sign_in(''16000000-0000-4000-8000-000000000010'',true)::text'),
	'ok','the company signs in to its vault');
select pg_temp.plan764_expect(pg_temp.plan764_try('select public.qorpera_set_chatgpt_plan_company(''16000000-0000-4000-8000-000000000010'',true)::text'),
	'ok','the operator lists the company');
reset role;
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_chatgpt_plan_available(''16000000-0000-4000-8000-000000000010'')::text'),'ok','availability');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'false','listed, but the platform switch is off');
reset role;

-- The platform switch on: the member sees the button and begins for their own identity only.
update public.qorpera_chatgpt_plan_settings set enabled = true;
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_chatgpt_plan_available(''16000000-0000-4000-8000-000000000010'')::text'),'ok','availability');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'true','both switches on');
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_chatgpt_plan_available(''76400000-0000-4000-8000-000000000010'')::text'),'ok','availability');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'false','not a member of the other company');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'16000000-0000-4000-8000-000000000010','76400000-0000-4000-8000-000000000101','76400000-0000-4000-8000-000000000102',
	current_setting('qorpera_test.company_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-one'::bytea),'hex'))),
	'22023:ChatGPT plan sign-in is invalid','a company identity never holds a plan login');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'16000000-0000-4000-8000-000000000010','76400000-0000-4000-8000-000000000101','76400000-0000-4000-8000-000000000102',
	current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-one'::bytea),'hex'))),
	'ok','the member begins a plan sign-in');
select pg_temp.plan764_expect(pg_temp.plan764_last() ->> 'model_login_kind','chatgpt_plan','the begin names the kind');
select set_config('qorpera_test.plan764_login', pg_temp.plan764_last() ->> 'login_id', false);
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'16000000-0000-4000-8000-000000000010','76400000-0000-4000-8000-000000000101','76400000-0000-4000-8000-000000000102',
	current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-one'::bytea),'hex'))),
	'ok','a repeated begin');
select pg_temp.plan764_expect(pg_temp.plan764_last() ->> 'login_id',current_setting('qorpera_test.plan764_login'),
	'a repeated begin answers the same sign-in');
-- A Codex sign-in, begun the ordinary way, keeps its kind; its ids cannot become a plan sign-in.
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_native_provider_login(%L,%L,%L,%L,%L,%L,%L)::text',
	'16000000-0000-4000-8000-000000000010','76400000-0000-4000-8000-000000000201','76400000-0000-4000-8000-000000000202',
	current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id','openai','codex-cli',
	encode(sha256('codex-two'::bytea),'hex'))),'ok','a Codex sign-in');
select set_config('qorpera_test.plan764_codex', pg_temp.plan764_last() ->> 'login_id', false);
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'16000000-0000-4000-8000-000000000010','76400000-0000-4000-8000-000000000201','76400000-0000-4000-8000-000000000202',
	current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id',encode(sha256('codex-two'::bytea),'hex'))),
	'23505:native provider login id is already bound to other authority','a Codex sign-in''s ids');
reset role;
-- Another member cannot begin one for this member's identity.
select set_config('request.jwt.claims',
	'{"sub":"76400000-0000-4000-8000-000000000099","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'16000000-0000-4000-8000-000000000010','76400000-0000-4000-8000-000000000301','76400000-0000-4000-8000-000000000302',
	current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-three'::bytea),'hex'))),
	'22023:ChatGPT plan sign-in is invalid','another person''s identity');
reset role;

-- Both sign-ins are pending (the newer begin superseded the older for the same identity).
update public.qorpera_native_provider_login_sessions set status = 'pending', completed_at = null
where id in (current_setting('qorpera_test.plan764_login')::uuid, current_setting('qorpera_test.plan764_codex')::uuid);
do $$
begin
	if (select model_login_kind from public.qorpera_native_provider_login_sessions
		where id = current_setting('qorpera_test.plan764_login')::uuid) <> 'chatgpt_plan'
		or (select model_login_kind from public.qorpera_native_provider_login_sessions
		where id = current_setting('qorpera_test.plan764_codex')::uuid) <> 'codex' then
		raise exception 'sign-in kinds are wrong'; end if;
	if (select count(*) from public.qorpera_chatgpt_plan_hosts
		where compute_identity_id = (current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid
			and host_id ~ '^urn:uuid:[0-9a-f-]{36}$') <> 1 then
		raise exception 'the identity has no single host id'; end if;
	perform set_config('qorpera_test.plan764_host', (select host_id from public.qorpera_chatgpt_plan_hosts
		where compute_identity_id = (current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid), false);
end $$;

-- The callback's address: the company's vault, by the state's prefix, only with a pending plan sign-in.
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
set role service_role;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_chatgpt_plan_callback_target(%L)',
	'16000000-0000-4000-8000-000000000010.' || repeat('A',43))),'ok','the callback address');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),
	'https://secrets.qorpera.test/v1/model-logins/16000000-0000-4000-8000-000000000010/chatgpt-plan/callback',
	'the callback goes to the company''s vault');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_chatgpt_plan_callback_target(%L)',
	'76400000-0000-4000-8000-000000000010.' || repeat('A',43))),'ok','another company');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'null','a company without plan sign-ins');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_chatgpt_plan_callback_target(%L)',
	'16000000-0000-4000-8000-000000000010.' || repeat('A',42) || '/')),'ok','a malformed state');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'null','a malformed state goes nowhere');
reset role;

-- The vault's reads: v1 keeps exactly its keys and reads Codex sign-ins only; v2 reads both kinds.
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_describe_model_login_sign_in(%L,%L,%L,%L)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64),current_setting('qorpera_test.plan764_login'),
	encode(sha256('plan-one'::bytea),'hex'))),'42501:model login sign-in is unavailable','v1 never reads a plan sign-in');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_describe_model_login_sign_in(%L,%L,%L,%L)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64),current_setting('qorpera_test.plan764_codex'),
	encode(sha256('codex-two'::bytea),'hex'))),'ok','v1 reads a Codex sign-in');
select pg_temp.plan764_expect((select string_agg(key, ',' order by key) from jsonb_object_keys(pg_temp.plan764_last()) as key),
	'clientConnectionId,computeIdentityId,computeIdentityOwnerScopeKey,computeIdentityOwnerUserId,computeIdentityOwnershipKind,expiresAt,keyId,loginId,modelLoginId,profileId,schema,status',
	'v1 answers exactly its keys');
select pg_temp.plan764_expect(pg_temp.plan764_last() ->> 'schema','qorpera.model-login-sign-in/v1','v1 schema');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_describe_model_login_sign_in_v2(%L,%L,%L,%L)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64),current_setting('qorpera_test.plan764_codex'),
	encode(sha256('codex-two'::bytea),'hex'))),'ok','v2 reads a Codex sign-in');
select pg_temp.plan764_expect(pg_temp.plan764_last() ->> 'loginKind' || '/' || coalesce(pg_temp.plan764_last() ->> 'hostId','none'),
	'codex/none','a Codex sign-in has no host id');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_describe_model_login_sign_in_v2(%L,%L,%L,%L)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64),current_setting('qorpera_test.plan764_login'),
	encode(sha256('plan-one'::bytea),'hex'))),'ok','v2 reads a plan sign-in');
select pg_temp.plan764_expect(pg_temp.plan764_last() ->> 'loginKind' || '/' || (pg_temp.plan764_last() ->> 'status'),
	'chatgpt_plan/pending','a pending plan sign-in');
select pg_temp.plan764_expect(pg_temp.plan764_last() ->> 'hostId',current_setting('qorpera_test.plan764_host'),
	'the plan sign-in carries the identity''s host id');
reset session authorization;

-- Completion: each kind through its own call. A plan login is completed by the plan call only, while
-- the switches allow it, and records OpenAI's earliest renewal time and the plan consent version.
create function pg_temp.plan764_complete(p_call text, p_login text, p_secret text, p_model_login uuid, p_envelope bytea,
	p_renew_not_before timestamptz default null)
returns text language plpgsql as $$
begin
	return pg_temp.plan764_try(format('select public.%I(%L::uuid,%L,%L::uuid,%L,%L::uuid,%L,%L,%L,%L::timestamptz,%L::timestamptz,%L,%L%s)::text',
		p_call,'76400000-0000-4000-8000-000000000040',repeat('c',64),p_login,encode(sha256(p_secret::bytea),'hex'),p_model_login,
		'company-kek-1',encode(p_envelope,'base64'),encode(sha256(p_envelope),'hex'),clock_timestamp() - interval '1 minute',
		clock_timestamp() + interval '59 minutes','account-subject','member@example.test',
		case when p_call = 'qorpera_complete_chatgpt_plan_sign_in' then format(',%L::timestamptz',p_renew_not_before) else '' end));
end $$;
grant execute on function pg_temp.plan764_complete(text,text,text,uuid,bytea,timestamptz) to qorpera_secret_broker;
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_complete('qorpera_complete_model_login_sign_in',
	current_setting('qorpera_test.plan764_login'),'plan-one','76400000-0000-4000-8000-000000000150','plan-envelope'::bytea),
	'42501:model login sign-in is unavailable','the Codex completion refuses a plan sign-in');
select pg_temp.plan764_expect(pg_temp.plan764_complete('qorpera_complete_chatgpt_plan_sign_in',
	current_setting('qorpera_test.plan764_codex'),'codex-two','76400000-0000-4000-8000-000000000250','codex-envelope'::bytea),
	'42501:model login sign-in is unavailable','the plan completion refuses a Codex sign-in');
select pg_temp.plan764_expect(pg_temp.plan764_complete('qorpera_complete_model_login_sign_in',
	current_setting('qorpera_test.plan764_codex'),'codex-two','76400000-0000-4000-8000-000000000250','codex-envelope'::bytea,
	clock_timestamp()),'ok','the Codex completion completes a Codex sign-in');
reset session authorization;
-- While switched off a plan sign-in cannot complete; switched on it can.
update public.qorpera_chatgpt_plan_settings set enabled = false;
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_complete('qorpera_complete_chatgpt_plan_sign_in',
	current_setting('qorpera_test.plan764_login'),'plan-one','76400000-0000-4000-8000-000000000150','plan-envelope'::bytea,
	clock_timestamp() + interval '20 minutes'),'55000:model login sign-in is unavailable','a plan completion while switched off');
reset session authorization;
update public.qorpera_chatgpt_plan_settings set enabled = true;
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_complete('qorpera_complete_chatgpt_plan_sign_in',
	current_setting('qorpera_test.plan764_login'),'plan-one','76400000-0000-4000-8000-000000000150','plan-envelope'::bytea,
	clock_timestamp() + interval '40 days'),'22023:model login sign-in completion is invalid','an earliest renewal time out of range');
select pg_temp.plan764_expect(pg_temp.plan764_complete('qorpera_complete_chatgpt_plan_sign_in',
	current_setting('qorpera_test.plan764_login'),'plan-one','76400000-0000-4000-8000-000000000150','plan-envelope'::bytea,
	clock_timestamp() + interval '20 minutes'),'ok','the plan completion');
select pg_temp.plan764_expect(pg_temp.plan764_complete('qorpera_complete_chatgpt_plan_sign_in',
	current_setting('qorpera_test.plan764_login'),'plan-one','76400000-0000-4000-8000-000000000150','plan-envelope'::bytea,
	clock_timestamp() + interval '20 minutes'),'ok','a repeat after a lost answer');
reset session authorization;
do $$
declare v_plan public.qorpera_model_logins%rowtype; v_codex public.qorpera_model_logins%rowtype;
begin
	select * into strict v_plan from public.qorpera_model_logins where id = '76400000-0000-4000-8000-000000000150';
	select * into strict v_codex from public.qorpera_model_logins where id = '76400000-0000-4000-8000-000000000250';
	if v_plan.login_kind <> 'chatgpt_plan' or v_plan.renew_not_before is null
		or v_plan.renew_not_before < clock_timestamp() + interval '19 minutes' then
		raise exception 'plan login row is wrong: %', to_jsonb(v_plan); end if;
	if v_codex.login_kind <> 'codex' or v_codex.renew_not_before is not null then
		raise exception 'Codex login row is wrong: %', to_jsonb(v_codex); end if;
	if not exists (select 1 from public.qorpera_provider_connection_versions version
		where version.credential_capsule_id = v_plan.credential_capsule_id and version.authorization_state = 'active'
			and version.consent_version = 'qorpera-chatgpt-plan-v1' and version.allow_autonomous = false
			and version.billing_source = 'personal_subscription') then
		raise exception 'the plan connection version is wrong'; end if;
	if not exists (select 1 from public.qorpera_provider_connection_versions version
		where version.credential_capsule_id = v_codex.credential_capsule_id
			and version.consent_version = 'qorpera-native-subscription-v1') then
		raise exception 'the Codex connection version changed'; end if;
end $$;
-- A plan login is never listed for the account record the node switch-off reads; the Codex login is.
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_model_logins_without_account(%L,%L)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64))),'ok','the account list');
select pg_temp.plan764_expect((select string_agg(login ->> 'loginId', ',' order by login ->> 'loginId')
	from jsonb_array_elements(pg_temp.plan764_last() -> 'logins') as login),
	'76400000-0000-4000-8000-000000000250','only the Codex login is listed for its account');
reset session authorization;

-- The renewal rule.
do $$
declare v_login public.qorpera_model_logins%rowtype; v_now timestamptz := clock_timestamp();
begin
	v_login.login_kind := 'codex';
	v_login.access_issued_at := v_now - interval '31 minutes';
	v_login.access_expires_at := v_login.access_issued_at + interval '1 hour';
	if not public.qorpera_model_login_renewal_due(v_login, v_now, false)
		or not public.qorpera_model_login_renewal_due(v_login, v_now, true) then
		raise exception 'a Codex login past half its pass is due for runs and upkeep alike'; end if;
	v_login.login_kind := 'chatgpt_plan';
	if not public.qorpera_model_login_renewal_due(v_login, v_now, false) then
		raise exception 'a plan login past half its pass is due for a run'; end if;
	if public.qorpera_model_login_renewal_due(v_login, v_now, true) then
		raise exception 'idle upkeep renews a young plan login'; end if;
	v_login.access_issued_at := v_now - interval '8 days';
	v_login.access_expires_at := v_login.access_issued_at + interval '1 hour';
	if not public.qorpera_model_login_renewal_due(v_login, v_now, true) then
		raise exception 'idle upkeep leaves a week-old plan login'; end if;
	v_login.renew_not_before := v_now + interval '1 minute';
	if public.qorpera_model_login_renewal_due(v_login, v_now, true)
		or public.qorpera_model_login_renewal_due(v_login, v_now, false) then
		raise exception 'a plan login renews before OpenAI allows it'; end if;
end $$;

-- The run's issue: a plan login on the run's capsule (made like test 690's). Its answer names the kind;
-- switched off, a run gets no plan login; its renewal waits for OpenAI's earliest time.
insert into public.qorpera_model_logins(id,profile_id,compute_identity_id,credential_capsule_id,broker_authority_id,
	provider,native_harness,current_version,access_issued_at,access_expires_at,login_kind,renew_not_before)
select '76400000-0000-4000-8000-000000000050',identity.profile_id,identity.id,capsule.id,
	'76400000-0000-4000-8000-000000000040','openai','codex-cli',1,
	clock_timestamp() - interval '40 minutes',clock_timestamp() + interval '20 minutes','chatgpt_plan',
	clock_timestamp() + interval '1 hour'
from public.qorpera_native_credential_capsules capsule
join public.qorpera_member_compute_identities identity on identity.id = capsule.compute_identity_id
where capsule.id = (current_setting('qorpera_test.plan764_binding')::jsonb ->> 'credentialCapsuleId')::uuid;
insert into public.qorpera_model_login_versions(login_id,version,broker_authority_id,key_id,encrypted_envelope,
	envelope_sha256,origin,access_issued_at,access_expires_at)
select login.id,1,login.broker_authority_id,'company-kek-1','plan-run-v1'::bytea,
	encode(extensions.digest('plan-run-v1'::bytea,'sha256'),'hex'),'sign_in',login.access_issued_at,login.access_expires_at
from public.qorpera_model_logins login where login.id = '76400000-0000-4000-8000-000000000050';
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_issue_model_login(%L,%L,%L::jsonb,null,true)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64),current_setting('qorpera_test.plan764_binding'))),
	'ok','a run gets its plan login');
select pg_temp.plan764_expect(pg_temp.plan764_last() ->> 'loginKind' || '/' || coalesce(pg_temp.plan764_last() ->> 'renewal','none'),
	'chatgpt_plan/none','past half its pass, but before OpenAI''s earliest time: no renewal');
reset session authorization;
update public.qorpera_model_logins set renew_not_before = clock_timestamp() - interval '1 second'
where id = '76400000-0000-4000-8000-000000000050';
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_issue_model_login(%L,%L,%L::jsonb,null,true)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64),current_setting('qorpera_test.plan764_binding'))),
	'ok','a run renews its plan login');
select pg_temp.plan764_expect(pg_temp.plan764_last() #>> '{renewal,baseVersion}','1','the run holds the renewal lock');
select set_config('qorpera_test.plan764_token', pg_temp.plan764_last() #>> '{renewal,token}', false);
reset session authorization;
update public.qorpera_chatgpt_plan_settings set enabled = false;
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_issue_model_login(%L,%L,%L::jsonb,null,false)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64),current_setting('qorpera_test.plan764_binding'))),
	'55000:ChatGPT plan logins are switched off','switched off, a run gets no plan login');

-- A renewal is saved for its own kind only, and even while switched off (OpenAI already replaced the
-- refresh token). It records OpenAI's next earliest time.
create function pg_temp.plan764_commit(p_call text, p_envelope bytea, p_renew_not_before timestamptz default null)
returns text language plpgsql as $$
begin
	return pg_temp.plan764_try(format('select public.%I(%L::uuid,%L,%L::uuid,%L::uuid,1,%L,%L,%L,%L::timestamptz,%L::timestamptz%s)::text',
		p_call,'76400000-0000-4000-8000-000000000040',repeat('c',64),'76400000-0000-4000-8000-000000000050',
		current_setting('qorpera_test.plan764_token'),'company-kek-1',encode(p_envelope,'base64'),encode(sha256(p_envelope),'hex'),
		clock_timestamp(),clock_timestamp() + interval '1 hour',
		case when p_call = 'qorpera_commit_chatgpt_plan_renewal' then format(',%L::timestamptz',p_renew_not_before) else '' end));
end $$;
reset session authorization;
grant execute on function pg_temp.plan764_commit(text,bytea,timestamptz) to qorpera_secret_broker;
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_commit('qorpera_commit_model_login_renewal','codex-shaped'::bytea),
	'22023:model login renewal is for another kind of login','a Codex commit on a plan login');
select pg_temp.plan764_expect(pg_temp.plan764_commit('qorpera_commit_chatgpt_plan_renewal','plan-run-v2'::bytea,
	clock_timestamp() + interval '30 minutes'),'ok','the plan commit while switched off');
select pg_temp.plan764_expect(pg_temp.plan764_last() ->> 'version','2','the renewal is version 2');
reset session authorization;
do $$
begin
	if not exists (select 1 from public.qorpera_model_logins where id = '76400000-0000-4000-8000-000000000050'
		and current_version = 2 and renewal_token is null and renew_not_before > clock_timestamp() + interval '29 minutes') then
		raise exception 'the plan renewal was not saved with its next earliest time'; end if;
end $$;

-- Idle upkeep: a young plan login is left alone, a week-old one is renewed while switched on only, and
-- a Codex login is renewed as before.
update public.qorpera_model_logins set access_issued_at = clock_timestamp() - interval '8 days',
	access_expires_at = clock_timestamp() - interval '8 days' + interval '1 hour', renew_not_before = null
where id = '76400000-0000-4000-8000-000000000150';
update public.qorpera_model_logins set access_issued_at = clock_timestamp() - interval '2 hours',
	access_expires_at = clock_timestamp() - interval '1 hour', renew_not_before = null
where id = '76400000-0000-4000-8000-000000000050';
update public.qorpera_model_logins set access_issued_at = clock_timestamp() - interval '10 days',
	access_expires_at = clock_timestamp() + interval '1 day'
where id = '76400000-0000-4000-8000-000000000250';
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_take_idle_model_login_renewal(%L,%L)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64))),'ok','idle upkeep while switched off');
select pg_temp.plan764_expect(pg_temp.plan764_last() ->> 'loginId' || '/' || (pg_temp.plan764_last() ->> 'loginKind'),
	'76400000-0000-4000-8000-000000000250/codex','switched off, upkeep renews the Codex login only');
reset session authorization;
update public.qorpera_model_logins set renewal_token = null, renewal_until = null
where id = '76400000-0000-4000-8000-000000000250';
update public.qorpera_model_logins set access_issued_at = clock_timestamp() - interval '1 hour',
	access_expires_at = clock_timestamp() + interval '10 days'
where id = '76400000-0000-4000-8000-000000000250';
update public.qorpera_chatgpt_plan_settings set enabled = true;
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_take_idle_model_login_renewal(%L,%L)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64))),'ok','idle upkeep');
select pg_temp.plan764_expect(pg_temp.plan764_last() ->> 'loginId' || '/' || (pg_temp.plan764_last() ->> 'loginKind'),
	'76400000-0000-4000-8000-000000000150/chatgpt_plan','upkeep renews the week-old plan login');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_take_idle_model_login_renewal(%L,%L)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64))),'ok','idle upkeep again');
select pg_temp.plan764_expect((pg_temp.plan764_last() -> 'renewal')::text,'null',
	'nothing else is due: the renewing plan login, a young Codex login, a plan login off the vault''s pointer');
reset session authorization;

-- Ending a plan login nothing uses: the member disconnected. A login another renewal holds waits; the
-- vault then takes it under the lock, OpenAI ends it, and only the lock's holder marks it revoked.
update public.qorpera_model_logins set status = 'revoked' where id = '76400000-0000-4000-8000-000000000050';
update public.qorpera_provider_connections set status = 'revoked'
where id = (select version.connection_id from public.qorpera_provider_connection_versions version
	join public.qorpera_model_logins login on login.credential_capsule_id = version.credential_capsule_id
	where login.id = '76400000-0000-4000-8000-000000000150' limit 1);
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_take_chatgpt_plan_revocation(%L,%L)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64))),'ok','a revocation pass');
select pg_temp.plan764_expect((pg_temp.plan764_last() -> 'revocation')::text,'null','a login under a renewal waits for the next pass');
reset session authorization;
update public.qorpera_model_logins set renewal_token = null, renewal_until = null
where id = '76400000-0000-4000-8000-000000000150';
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_take_chatgpt_plan_revocation(%L,%L)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64))),'ok','a revocation pass');
select pg_temp.plan764_expect(pg_temp.plan764_last() ->> 'loginId','76400000-0000-4000-8000-000000000150',
	'the disconnected plan login is taken');
select set_config('qorpera_test.plan764_revocation', pg_temp.plan764_last() #>> '{revocation,token}', false);
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_finish_chatgpt_plan_revocation(%L,%L,%L,%L,1)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64),'76400000-0000-4000-8000-000000000150',
	'76400000-0000-4000-8000-0000000000ee')),'55000:ChatGPT plan revocation lock is not held','another lock');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_finish_chatgpt_plan_revocation(%L,%L,%L,%L,1)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64),'76400000-0000-4000-8000-000000000150',
	current_setting('qorpera_test.plan764_revocation'))),'ok','the lock holder marks it revoked');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_finish_chatgpt_plan_revocation(%L,%L,%L,%L,1)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64),'76400000-0000-4000-8000-000000000150',
	current_setting('qorpera_test.plan764_revocation'))),'ok','a repeat after a lost answer');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_take_chatgpt_plan_revocation(%L,%L)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64))),'ok','a revocation pass');
select pg_temp.plan764_expect((pg_temp.plan764_last() -> 'revocation')::text,'null','nothing else to end');
reset session authorization;
do $$
begin
	if (select status from public.qorpera_model_logins where id = '76400000-0000-4000-8000-000000000150') <> 'revoked'
		or (select status from public.qorpera_model_logins where id = '76400000-0000-4000-8000-000000000250') <> 'active' then
		raise exception 'revocation touched the wrong login'; end if;
end $$;

rollback;
