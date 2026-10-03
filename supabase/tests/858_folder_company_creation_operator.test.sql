-- Company creation on the folder core, P14a: the operator's path (deploy/first-node/RUNTIME-COMPANY-FOLDER-CREATION.md
-- §6). Only the owner role calls it (every API role is refused); open needs a confirmed email; start refuses a lobby's
-- company, an owner who no longer owns it and an owner without a usable login, and records the creation through
-- seed's checks with the owner as the only founder and the operator's reason on the row.
begin;

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
	('85800000-0000-4000-8000-000000000001','proof@example.test',statement_timestamp(),'{"display_name":"Proof Owner"}'),
	('85800000-0000-4000-8000-000000000002','unconfirmed@example.test',null,'{"display_name":"Nobody"}'),
	('85800000-0000-4000-8000-000000000003','other@example.test',statement_timestamp(),'{"display_name":"Other"}');

create function pg_temp.as_user(p_user uuid)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',p_user,
		'email',(select email from auth.users where id = p_user))::text,true)::text::void
$$;
create function pg_temp.as_service()
returns void language sql as $$
	select set_config('request.jwt.claims','{"role":"service_role"}',true)::text::void
$$;
create function pg_temp.refused(p_sql text,p_state text)
returns void language plpgsql as $$
begin
	execute p_sql;
	raise exception 'expected SQLSTATE % from: %', p_state, p_sql;
exception when others then
	if sqlstate <> p_state then raise exception 'expected SQLSTATE %, got % (%) from: %', p_state, sqlstate, sqlerrm, p_sql; end if;
end $$;

-- Every API role is refused, with or without a JWT.
select pg_temp.as_user('85800000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.refused($$select public.qorpera_folder_company_operator_open('85800000-0000-4000-8000-000000000001',
	'85800000-0000-4000-8000-000000000100','Proof')$$,'42501');
select pg_temp.refused($$select public.qorpera_folder_company_operator_start('85800000-0000-4000-8000-000000000001','v','r')$$,'42501');
select pg_temp.refused($$select public.qorpera_folder_company_creation_requeue('85800000-0000-4000-8000-000000000001','r')$$,'42501');
reset role;
set local role anon;
select pg_temp.refused($$select public.qorpera_folder_company_operator_open('85800000-0000-4000-8000-000000000001',
	'85800000-0000-4000-8000-000000000100','Proof')$$,'42501');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.refused($$select public.qorpera_folder_company_operator_open('85800000-0000-4000-8000-000000000001',
	'85800000-0000-4000-8000-000000000100','Proof')$$,'42501');
select pg_temp.refused($$select public.qorpera_folder_company_operator_start('85800000-0000-4000-8000-000000000001','v','r')$$,'42501');
reset role;
select set_config('request.jwt.claims','',true) \g /dev/null

-- Open: a confirmed email only; then a folder-v2 company with its owner, repeat-safe.
select pg_temp.refused($$select public.qorpera_folder_company_operator_open('85800000-0000-4000-8000-000000000002',
	'85800000-0000-4000-8000-000000000100','Proof')$$,'42501');
select pg_temp.refused($$select public.qorpera_folder_company_operator_open(null,'85800000-0000-4000-8000-000000000100','Proof')$$,'42501');
select set_config('qorpera_test.proof',(public.qorpera_folder_company_operator_open('85800000-0000-4000-8000-000000000001',
	'85800000-0000-4000-8000-000000000100','Proof Company') ->> 'profile_id'),true);
do $$
declare v_profile uuid := current_setting('qorpera_test.proof')::uuid; v_again jsonb;
begin
	v_again := public.qorpera_folder_company_operator_open('85800000-0000-4000-8000-000000000001',
		'85800000-0000-4000-8000-000000000100','Proof Company');
	if (v_again ->> 'profile_id')::uuid <> v_profile then raise exception 'Operator open is not repeat-safe: %', v_again; end if;
	if not public.qorpera_company_is_folder_v2(v_profile)
		or (select role from public.qorpera_profile_members where profile_id = v_profile
			and user_id = '85800000-0000-4000-8000-000000000001') is distinct from 'owner'
		or (select display_name from public.qorpera_profile_members where profile_id = v_profile) <> 'Proof Owner' then
		raise exception 'Operator open did not make the folder-v2 company with its owner'; end if;
end $$;

-- Start: the arguments, then no usable login yet.
select pg_temp.refused(format($$select public.qorpera_folder_company_operator_start(%L,'v',' ')$$,
	current_setting('qorpera_test.proof')),'22023');
select pg_temp.refused(format($$select public.qorpera_folder_company_operator_start(%L,%L,'Proof run')$$,
	current_setting('qorpera_test.proof'),repeat('x',16385)),'22023');
select pg_temp.refused(format($$select public.qorpera_folder_company_operator_start(%L,'The vision.','Proof run')$$,
	current_setting('qorpera_test.proof')),'55000');

-- The owner connects a login (as 705 does).
select pg_temp.as_service();
select public.qorpera_set_provider_execution_policy('openai','native_subscription','codex-cli',
	'supported','enabled',32,null,'folder-company-operator-fixture') \g /dev/null
do $$
declare v_profile uuid := current_setting('qorpera_test.proof')::uuid; v_identity jsonb; v_login jsonb; v_connection jsonb;
begin
	perform pg_temp.as_user('85800000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_identity := public.qorpera_upsert_member_compute_identity(v_profile,'85800000-0000-4000-8000-000000000701',
		'My model account','qorpera-member-linux','v1','["agent_turn","company_substrate"]',
		'{"network":"provider-native-only","credentialExport":false}');
	v_login := public.qorpera_begin_native_provider_login(v_profile,'85800000-0000-4000-8000-000000000801',
		'85800000-0000-4000-8000-000000000901',(v_identity ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('01',32),900);
	reset role;
	perform pg_temp.as_service();
	set local role service_role;
	v_connection := public.qorpera_complete_native_provider_login((v_login ->> 'login_id')::uuid,repeat('01',32),
		'85800000-0000-4000-8000-000000000a01','object://native-capsules/85800000-0000-4000-8000-000000000a01',repeat('d',64),
		'openai-01','personal-subscription','qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
	reset role;
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
		to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
	from public.qorpera_provider_connection_versions v
	where connection_id = (v_connection ->> 'connection_id')::uuid and version = 1;
	perform pg_temp.as_user('85800000-0000-4000-8000-000000000001');
	set local role authenticated;
	perform public.qorpera_create_member_execution_sponsor(v_profile,'85800000-0000-4000-8000-000000000b01',
		(v_connection ->> 'connection_id')::uuid,2,true);
	reset role;
end $$;
select set_config('request.jwt.claims','',true) \g /dev/null

-- Start records the creation: the owner as the only founder and the kickoff's author, the reason on the row.
do $$
declare v_profile uuid := current_setting('qorpera_test.proof')::uuid; v_start jsonb;
	v_creation public.qorpera_folder_company_creations;
begin
	v_start := public.qorpera_folder_company_operator_start(v_profile, 'Prove the folder core.', '  Proof company P38 ');
	select * into strict v_creation from public.qorpera_folder_company_creations where profile_id = v_profile;
	if (v_start ->> 'creationId')::uuid <> v_creation.id or v_creation.state <> 'queued'
		or v_creation.kickoff_user_id <> '85800000-0000-4000-8000-000000000001'
		or v_creation.operator_reason <> 'Proof company P38'
		or v_creation.input <> jsonb_build_object('schema','qorpera.company-seed-input/v1','companyName','Proof Company',
			'vision','Prove the folder core.','kickoffRequestedBy','85800000-0000-4000-8000-000000000001',
			'founders',jsonb_build_array(jsonb_build_object('userId','85800000-0000-4000-8000-000000000001',
				'displayName','Proof Owner','role',''))) then
		raise exception 'Operator start did not record the creation: % %', v_start, to_jsonb(v_creation); end if;
	-- Again: the same creation, and the first reason stays.
	v_start := public.qorpera_folder_company_operator_start(v_profile, 'Prove the folder core.', 'Second');
	if (v_start ->> 'creationId')::uuid <> v_creation.id
		or (select operator_reason from public.qorpera_folder_company_creations where id = v_creation.id) <> 'Proof company P38'
		or (select count(*) from public.qorpera_folder_company_creations where profile_id = v_profile) <> 1 then
		raise exception 'A second operator start changed the creation'; end if;
	-- The worker finds it.
	perform pg_temp.as_service();
	if public.qorpera_folder_company_creation_claim('85800000-0000-4000-8000-0000000000f1', 60) ->> 'creationId'
		<> v_creation.id::text then
		raise exception 'The worker does not claim the operator''s creation'; end if;
	perform set_config('request.jwt.claims', '', true);
end $$;

-- An owner who no longer owns the company is refused.
select set_config('qorpera_test.second',(public.qorpera_folder_company_operator_open('85800000-0000-4000-8000-000000000001',
	'85800000-0000-4000-8000-000000000101','Second Proof') ->> 'profile_id'),true);
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values (current_setting('qorpera_test.second')::uuid,'85800000-0000-4000-8000-000000000003','other@example.test','Other','owner');
update public.qorpera_profile_members set role = 'admin'
where profile_id = current_setting('qorpera_test.second')::uuid and user_id = '85800000-0000-4000-8000-000000000001';
select pg_temp.refused(format($$select public.qorpera_folder_company_operator_start(%L,'v','Proof')$$,
	current_setting('qorpera_test.second')),'55000');

-- A lobby's company is never started by an operator.
create or replace function public.qorpera_company_founding_available()
returns boolean language sql stable security definer set search_path = '' as $$
	select true
$$;
select pg_temp.as_user('85800000-0000-4000-8000-000000000003');
set local role authenticated;
select set_config('qorpera_test.table',(public.qorpera_open_company_founding(
	'85800000-0000-4000-8000-000000000102','A Table') ->> 'profileId'),true);
reset role;
select set_config('request.jwt.claims','',true) \g /dev/null
select pg_temp.refused(format($$select public.qorpera_folder_company_operator_start(%L,'v','Proof')$$,
	current_setting('qorpera_test.table')),'55000');
do $$ begin
	if exists (select 1 from public.qorpera_folder_company_creations
		where profile_id in (current_setting('qorpera_test.second')::uuid, current_setting('qorpera_test.table')::uuid)) then
		raise exception 'A refused operator start wrote a creation'; end if;
end $$;

rollback;
