-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A member's ChatGPT plan login on folder-v2 (ported from snapshot-v1 in the legacy sweep; Sign in with ChatGPT, slice
-- 1a, 20260928329830): who may call each plan function; a plan sign-in begins, is read by the vault, completes and is
-- handed to a run only while the platform switch is on and its company is listed (and its sign-ins go to its vault); it is
-- always its member's own, never a company identity's or another person's; each kind completes and renews through its
-- own call only, and a node never completes a plan sign-in; the plan's connection never pays for unattended work until
-- its member says so; a disconnected plan login is ended under the vault's lock. The base run of 924 is the run here.
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);

-- The base run's binding, as the vault reads it (the run binding has exactly these seven keys).
select set_config('qorpera_test.plan764_binding', ((current_setting('qorpera_test.base_binding')::jsonb)
	- 'provider' - 'nativeHarness' - 'model')::text, false);

-- A company compute identity (as 160 made it): it never holds a plan login.
select set_config('request.jwt.claims',
	'{"sub":"92400000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select set_config('qorpera_test.plan764_company_identity', public.qorpera_upsert_scoped_compute_identity(
	'92400000-0000-4000-8000-000000000010','76400000-0000-4000-8000-0000000000c1','company',null,'Company compute identity',
	'qorpera-company-linux','v1','["agent_turn"]','{"network":"provider-native-only","credentialExport":false}')::text,false);
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);

-- The company's broker and a second company without vault sign-ins.
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('76400000-0000-4000-8000-000000000010','Other company','92400000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('76400000-0000-4000-8000-000000000040','92400000-0000-4000-8000-000000000010','https://secrets.qorpera.test',
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

-- Switched off: no member sees the button and no plan sign-in begins (the company is not listed yet).
select set_config('request.jwt.claims',
	'{"sub":"92400000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_chatgpt_plan_available(''92400000-0000-4000-8000-000000000010'')::text'),'ok','availability');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'false','off by default');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'92400000-0000-4000-8000-000000000010','76400000-0000-4000-8000-000000000101','76400000-0000-4000-8000-000000000102',
	current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-one'::bytea),'hex'))),
	'55000:ChatGPT plan sign-in is switched off','a begin while switched off');
select pg_temp.plan764_expect(pg_temp.plan764_try('select public.qorpera_set_chatgpt_plan_company(''92400000-0000-4000-8000-000000000010'',true)::text'),
	'42501:permission denied for function qorpera_set_chatgpt_plan_company','a member cannot list a company');
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
set role service_role;
-- A company joins the list only once its sign-ins go to its vault.
select pg_temp.plan764_expect(pg_temp.plan764_try('select public.qorpera_set_chatgpt_plan_company(''92400000-0000-4000-8000-000000000010'',true)::text'),
	'55000:company sign-ins do not go to its vault','a company whose sign-ins stay on nodes');
select pg_temp.plan764_expect(pg_temp.plan764_try('select public.qorpera_set_chatgpt_plan_company(''76400000-0000-4000-8000-000000000010'',true)::text'),
	'55000:company sign-ins do not go to its vault','a company without a vault');
select pg_temp.plan764_expect(pg_temp.plan764_try('select public.qorpera_set_model_login_sign_in(''92400000-0000-4000-8000-000000000010'',true)::text'),
	'ok','the company signs in to its vault');
select pg_temp.plan764_expect(pg_temp.plan764_try('select public.qorpera_set_chatgpt_plan_company(''92400000-0000-4000-8000-000000000010'',true)::text'),
	'ok','the operator lists the company');
reset role;
select set_config('request.jwt.claims',
	'{"sub":"92400000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_chatgpt_plan_available(''92400000-0000-4000-8000-000000000010'')::text'),'ok','availability');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'false','listed, but the platform switch is off');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'92400000-0000-4000-8000-000000000010','76400000-0000-4000-8000-000000000101','76400000-0000-4000-8000-000000000102',
	current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-one'::bytea),'hex'))),
	'55000:ChatGPT plan sign-in is switched off','a begin for a listed company while the platform switch is off');
reset role;

-- The platform switch on: the member sees the button and begins for their own identity only.
update public.qorpera_chatgpt_plan_settings set enabled = true;
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_chatgpt_plan_available(''92400000-0000-4000-8000-000000000010'')::text'),'ok','availability');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'true','both switches on');
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_chatgpt_plan_available(''76400000-0000-4000-8000-000000000010'')::text'),'ok','availability');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'false','not a member of the other company');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'92400000-0000-4000-8000-000000000010','76400000-0000-4000-8000-000000000101','76400000-0000-4000-8000-000000000102',
	current_setting('qorpera_test.plan764_company_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-one'::bytea),'hex'))),
	'22023:ChatGPT plan sign-in is invalid','a company identity never holds a plan login');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'92400000-0000-4000-8000-000000000010','76400000-0000-4000-8000-000000000101','76400000-0000-4000-8000-000000000102',
	current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-one'::bytea),'hex'))),
	'ok','the member begins a plan sign-in');
select pg_temp.plan764_expect(pg_temp.plan764_last() ->> 'model_login_kind','chatgpt_plan','the begin names the kind');
select set_config('qorpera_test.plan764_login', pg_temp.plan764_last() ->> 'login_id', false);
-- A Codex sign-in, begun the ordinary way, keeps its kind; its ids cannot become a plan sign-in.
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_native_provider_login(%L,%L,%L,%L,%L,%L,%L)::text',
	'92400000-0000-4000-8000-000000000010','76400000-0000-4000-8000-000000000201','76400000-0000-4000-8000-000000000202',
	current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id','openai','codex-cli',
	encode(sha256('codex-two'::bytea),'hex'))),'ok','a Codex sign-in');
select set_config('qorpera_test.plan764_codex', pg_temp.plan764_last() ->> 'login_id', false);
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'92400000-0000-4000-8000-000000000010','76400000-0000-4000-8000-000000000201','76400000-0000-4000-8000-000000000202',
	current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id',encode(sha256('codex-two'::bytea),'hex'))),
	'23505:native provider login id is already bound to other authority','a Codex sign-in''s ids');
reset role;
-- Someone outside the company cannot begin one for the member's identity.
select set_config('request.jwt.claims',
	'{"sub":"92400000-0000-4000-8000-000000000005","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'92400000-0000-4000-8000-000000000010','76400000-0000-4000-8000-000000000301','76400000-0000-4000-8000-000000000302',
	current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-three'::bytea),'hex'))),
	'22023:ChatGPT plan sign-in is invalid','an outsider and the member''s identity');
reset role;

-- Both sign-ins are pending (the newer begin superseded the older for the same identity).
update public.qorpera_native_provider_login_sessions set status = 'pending', completed_at = null
where id in (current_setting('qorpera_test.plan764_login')::uuid, current_setting('qorpera_test.plan764_codex')::uuid);

-- The callback's address: the company's vault, by the state's prefix, only with a pending plan sign-in.
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
set role service_role;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_chatgpt_plan_callback_target(%L)',
	'92400000-0000-4000-8000-000000000010.' || repeat('A',43))),'ok','the callback address');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),
	'https://secrets.qorpera.test/v1/model-logins/92400000-0000-4000-8000-000000000010/chatgpt-plan/callback',
	'the callback goes to the company''s vault');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_chatgpt_plan_callback_target(%L)',
	'76400000-0000-4000-8000-000000000010.' || repeat('A',43))),'ok','another company');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'null','a company without plan sign-ins');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_chatgpt_plan_callback_target(%L)',
	'92400000-0000-4000-8000-000000000010.' || repeat('A',42) || '/')),'ok','a malformed state');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'null','a malformed state goes nowhere');
reset role;

-- The vault's reads: v1 never reads a plan sign-in; v2 reads it.
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_describe_model_login_sign_in(%L,%L,%L,%L)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64),current_setting('qorpera_test.plan764_login'),
	encode(sha256('plan-one'::bytea),'hex'))),'42501:model login sign-in is unavailable','v1 never reads a plan sign-in');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_describe_model_login_sign_in_v2(%L,%L,%L,%L)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64),current_setting('qorpera_test.plan764_login'),
	encode(sha256('plan-one'::bytea),'hex'))),'ok','v2 reads a plan sign-in');
select pg_temp.plan764_expect(pg_temp.plan764_last() ->> 'loginKind' || '/' || (pg_temp.plan764_last() ->> 'status'),
	'chatgpt_plan/pending','a pending plan sign-in');
reset session authorization;

-- Completion: each kind through its own call. A plan login is completed by the plan call only, while
-- the switches allow it, with the plan consent version.
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
	current_setting('qorpera_test.plan764_codex'),'codex-two','76400000-0000-4000-8000-000000000250','codex-envelope'::bytea),
	'ok','the Codex completion completes a Codex sign-in');
reset session authorization;
-- While switched off a plan sign-in cannot complete or be read; switched on it completes.
update public.qorpera_chatgpt_plan_settings set enabled = false;
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_complete('qorpera_complete_chatgpt_plan_sign_in',
	current_setting('qorpera_test.plan764_login'),'plan-one','76400000-0000-4000-8000-000000000150','plan-envelope'::bytea,
	clock_timestamp() + interval '20 minutes'),'55000:model login sign-in is unavailable','a plan completion while switched off');
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_describe_model_login_sign_in_v2(%L,%L,%L,%L)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64),current_setting('qorpera_test.plan764_login'),
	encode(sha256('plan-one'::bytea),'hex'))),'42501:model login sign-in is unavailable','v2 never reads a plan sign-in while switched off');
reset session authorization;
-- A node completes Codex sign-ins only: a pending plan sign-in never becomes a node Codex login.
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
set role service_role;
select pg_temp.plan764_expect(pg_temp.plan764_try(format(
	'select public.qorpera_complete_native_provider_login(%L::uuid,%L,%L::uuid,%L,%L,%L,%L,%L,%L::jsonb,%L)::text',
	current_setting('qorpera_test.plan764_login'),encode(sha256('plan-one'::bytea),'hex'),'76400000-0000-4000-8000-000000000170',
	'native-capsule/76400000-0000-4000-8000-000000000170',repeat('a',64),'account-subject','personal_subscription',
	'qorpera-native-subscription-v1',jsonb_build_object('monthly_microusd',1,'reservation_microusd',1,'max_calls_per_run',128,
		'max_input_tokens_per_run',100000000,'max_output_tokens_per_run',100000000,'max_concurrent_runs',1)::text,
	'member@example.test')),'55000:native provider login is unavailable','a node never completes a plan sign-in');
reset role;
update public.qorpera_chatgpt_plan_settings set enabled = true;
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_complete('qorpera_complete_chatgpt_plan_sign_in',
	current_setting('qorpera_test.plan764_login'),'plan-one','76400000-0000-4000-8000-000000000150','plan-envelope'::bytea,
	clock_timestamp() + interval '20 minutes'),'ok','the plan completion');
reset session authorization;
-- The plan's connection is its member's personal subscription, never consented for unattended work by the sign-in.
do $$
declare v_plan public.qorpera_model_logins%rowtype;
begin
	select * into strict v_plan from public.qorpera_model_logins where id = '76400000-0000-4000-8000-000000000150';
	if v_plan.login_kind <> 'chatgpt_plan' then
		raise exception 'plan login row is wrong: %', to_jsonb(v_plan); end if;
	if not exists (select 1 from public.qorpera_provider_connection_versions version
		where version.credential_capsule_id = v_plan.credential_capsule_id and version.authorization_state = 'active'
			and version.consent_version = 'qorpera-chatgpt-plan-v1' and version.allow_autonomous = false
			and version.billing_source = 'personal_subscription') then
		raise exception 'the plan connection version is wrong'; end if;
end $$;

-- The plan login's own checks start here: tests 768, 771, 772, 776 and 778 stop at this line.

-- A renewal is saved for its own kind only: a plan commit on a Codex login is refused.
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format(
	'select public.qorpera_commit_chatgpt_plan_renewal(%L::uuid,%L,%L::uuid,%L::uuid,1,%L,%L,%L,%L::timestamptz,%L::timestamptz,null)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64),'76400000-0000-4000-8000-000000000250','76400000-0000-4000-8000-0000000000ef',
	'company-kek-1',encode('plan-shaped'::bytea,'base64'),encode(sha256('plan-shaped'::bytea),'hex'),
	clock_timestamp(),clock_timestamp() + interval '1 hour')),
	'22023:model login renewal is for another kind of login','a plan commit on a Codex login');
reset session authorization;

-- The run's issue: a plan login on the base run's capsule (made like test 690's). Its answer names the kind;
-- switched off, a run gets no plan login; a Codex commit never lands on a plan login.
insert into public.qorpera_model_logins(id,profile_id,compute_identity_id,credential_capsule_id,broker_authority_id,
	provider,native_harness,current_version,access_issued_at,access_expires_at,login_kind,renew_not_before)
select '76400000-0000-4000-8000-000000000050',identity.profile_id,identity.id,capsule.id,
	'76400000-0000-4000-8000-000000000040','openai','codex-cli',1,
	clock_timestamp() - interval '40 minutes',clock_timestamp() + interval '20 minutes','chatgpt_plan',
	clock_timestamp() - interval '1 second'
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
select pg_temp.plan764_expect(pg_temp.plan764_last() ->> 'loginKind','chatgpt_plan','the run''s login is the plan');
select set_config('qorpera_test.plan764_token', pg_temp.plan764_last() #>> '{renewal,token}', false);
reset session authorization;
update public.qorpera_chatgpt_plan_settings set enabled = false;
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_issue_model_login(%L,%L,%L::jsonb,null,false)::text',
	'76400000-0000-4000-8000-000000000040',repeat('c',64),current_setting('qorpera_test.plan764_binding'))),
	'55000:ChatGPT plan logins are switched off','switched off, a run gets no plan login');
reset session authorization;
create function pg_temp.plan764_commit(p_envelope bytea)
returns text language plpgsql as $$
begin
	return pg_temp.plan764_try(format('select public.qorpera_commit_model_login_renewal(%L::uuid,%L,%L::uuid,%L::uuid,1,%L,%L,%L,%L::timestamptz,%L::timestamptz)::text',
		'76400000-0000-4000-8000-000000000040',repeat('c',64),'76400000-0000-4000-8000-000000000050',
		current_setting('qorpera_test.plan764_token'),'company-kek-1',encode(p_envelope,'base64'),encode(sha256(p_envelope),'hex'),
		clock_timestamp(),clock_timestamp() + interval '1 hour'));
end $$;
grant execute on function pg_temp.plan764_commit(bytea) to qorpera_secret_broker;
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_commit('codex-shaped'::bytea),
	'22023:model login renewal is for another kind of login','a Codex commit on a plan login');
reset session authorization;
update public.qorpera_chatgpt_plan_settings set enabled = true;

-- Ending a plan login nothing can use again: once the member disconnected, the vault takes it under a lock, OpenAI
-- ends it, and only the lock's holder marks it revoked. (The run's plan login, 050, is set aside.)
update public.qorpera_model_logins set status = 'revoked' where id = '76400000-0000-4000-8000-000000000050';
update public.qorpera_provider_connections set status = 'revoked'
where id = (select version.connection_id from public.qorpera_provider_connection_versions version
	join public.qorpera_model_logins login on login.credential_capsule_id = version.credential_capsule_id
	where login.id = '76400000-0000-4000-8000-000000000150' limit 1);
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
reset session authorization;
do $$
begin
	if (select status from public.qorpera_model_logins where id = '76400000-0000-4000-8000-000000000150') <> 'revoked'
		or (select status from public.qorpera_model_logins where id = '76400000-0000-4000-8000-000000000250') <> 'active' then
		raise exception 'revocation touched the wrong login'; end if;
end $$;

rollback;
