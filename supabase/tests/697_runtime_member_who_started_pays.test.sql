-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- The member who started the work pays (20260928230000): a member's login pays only for work that
-- member started, follow-up work inherits the starter's own login, a company account pays for a
-- starter with no login of their own (20260930059000: never because the starter's login is at its
-- limit, test 905), a coding session runs for the member who asked, and one check where runs are
-- created refuses anything else. The fixture's owner (…001) has a login; the contributor
-- (…002) connects one here; the viewer (…003) never has one.
reset role;

do $$
declare v_function text;
begin
	foreach v_function in array array['public.qorpera_sponsor_serves_requester(uuid,uuid,bigint,uuid)',
		'public.qorpera_starter_sponsor(uuid,uuid,uuid,uuid)','public.qorpera_company_account_sponsor(uuid,uuid)'] loop
		if has_function_privilege('anon', v_function, 'EXECUTE') or has_function_privilege('authenticated', v_function, 'EXECUTE') then
			raise exception 'API clients can resolve who pays: %', v_function;
		end if;
	end loop;
	-- Nothing stands on a member's login any more: the fixture agents have no standing authority.
	if exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010') then
		raise exception 'a standing authority survived on a member login';
	end if;
end
$$;

-- The contributor connects their own login, as the fixture's owner did.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.pays_identity',public.qorpera_upsert_member_compute_identity(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000750','Contributor identity','qorpera-member-linux','v1',
	'["agent_turn","company_substrate"]','{"network":"provider-native-only","credentialExport":false}')::text,true);
select set_config('qorpera_test.pays_login',public.qorpera_begin_native_provider_login(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000751','30000000-0000-4000-8000-000000000752',
	(current_setting('qorpera_test.pays_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('c',64),900)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.pays_connection',public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.pays_login')::jsonb ->> 'login_id')::uuid,repeat('c',64),'30000000-0000-4000-8000-000000000760',
	'object://native-capsules/30000000-0000-4000-8000-000000000760',repeat('d',64),'fixture-openai-account-2','personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,true);
reset role;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = (current_setting('qorpera_test.pays_connection')::jsonb ->> 'connection_id')::uuid and version = 1;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.pays_sponsor',public.qorpera_create_member_execution_sponsor(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000761',
	(current_setting('qorpera_test.pays_connection')::jsonb ->> 'connection_id')::uuid,2,true)::text,true);
reset role;
select pg_temp.path_claims('service_role');

-- Who pays, member by member: each member's own login, the viewer nothing, and no member's login
-- ever serves another member, even when it is the preferred (parent run's) binding.
do $$
declare
	v_profile uuid := '30000000-0000-4000-8000-000000000010';
	v_agent uuid := '30000000-0000-4000-8000-000000000031';
	v_owner_binding uuid := (current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid;
	v_member_binding uuid := (current_setting('qorpera_test.pays_sponsor')::jsonb ->> 'binding_id')::uuid;
	v_payer record;
begin
	select * into v_payer from public.qorpera_starter_sponsor(v_profile,'30000000-0000-4000-8000-000000000001',v_agent,v_owner_binding);
	if v_payer.binding_id is distinct from v_owner_binding or v_payer.version <> 1 then
		raise exception 'the owner''s chain is not paid by the owner''s login: %', row_to_json(v_payer); end if;
	select * into v_payer from public.qorpera_starter_sponsor(v_profile,'30000000-0000-4000-8000-000000000002',v_agent,v_owner_binding);
	if v_payer.binding_id is distinct from v_member_binding then
		raise exception 'the contributor''s chain is not paid by the contributor''s own login: %', row_to_json(v_payer); end if;
	select * into v_payer from public.qorpera_starter_sponsor(v_profile,'30000000-0000-4000-8000-000000000003',v_agent,v_owner_binding);
	if v_payer.binding_id is not null then
		raise exception 'a member without a login was paid for by someone else: %', row_to_json(v_payer); end if;
	if not public.qorpera_sponsor_serves_requester(v_profile,v_owner_binding,1,'30000000-0000-4000-8000-000000000001')
		or public.qorpera_sponsor_serves_requester(v_profile,v_owner_binding,1,'30000000-0000-4000-8000-000000000002')
		or public.qorpera_sponsor_serves_requester(v_profile,v_member_binding,1,'30000000-0000-4000-8000-000000000001')
		or not public.qorpera_sponsor_serves_requester(v_profile,v_member_binding,1,'30000000-0000-4000-8000-000000000002')
		or public.qorpera_sponsor_serves_requester(v_profile,v_owner_binding,1,null) then
		raise exception 'a login serves someone other than its owner';
	end if;
	-- An agent routine set up in the contributor's chain runs on the login the contributor's run pays with, never on
	-- another member's: a run of theirs the owner's login paid for (which the run trigger refuses anyway) prepares
	-- nothing, and never the contributor's other login either (20260930095000); the viewer's chain has nothing to run on.
	select sponsor.* into v_payer from public.qorpera_execution_runs as run
	cross join lateral public.qorpera_agent_routine_sponsor(jsonb_populate_record(run, jsonb_build_object(
		'requested_by_user_id', '30000000-0000-4000-8000-000000000002', 'sponsor_binding_id', v_member_binding,
		'sponsor_version', 1))) as sponsor
	where run.id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	if v_payer.binding_id is distinct from v_member_binding then
		raise exception 'an agent routine did not take the login its run pays with: %', row_to_json(v_payer); end if;
	select sponsor.* into v_payer from public.qorpera_execution_runs as run
	cross join lateral public.qorpera_agent_routine_sponsor(jsonb_populate_record(run,
		'{"requested_by_user_id":"30000000-0000-4000-8000-000000000002"}'::jsonb)) as sponsor
	where run.id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	if v_payer.binding_id is not null then
		raise exception 'an agent routine borrowed another member''s login or moved to its member''s other one: %',
			row_to_json(v_payer); end if;
	select sponsor.* into v_payer from public.qorpera_execution_runs as run
	cross join lateral public.qorpera_agent_routine_sponsor(jsonb_populate_record(run,
		'{"requested_by_user_id":"30000000-0000-4000-8000-000000000003"}'::jsonb)) as sponsor
	where run.id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	if v_payer.binding_id is not null then
		raise exception 'an agent routine for the viewer borrowed a login: %', row_to_json(v_payer); end if;
end
$$;

-- A coworker message in the owner's chain wakes the recipient on the owner's login, although no
-- standing authority exists; the run itself cannot be moved onto another member's login.
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
do $$
declare v_send jsonb; v_wake public.qorpera_wake_occurrences%rowtype; v_state text; v_message text;
	v_run uuid := (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
begin
	v_send := public.qorpera_send_coworker_message(current_setting('qorpera_test.wake_binding')::jsonb,
		'30000000-0000-4000-8000-000000000031','pays-hello','Can you check the numbers?');
	if v_send ->> 'status' <> 'queued' then raise exception 'coworker message was not queued: %', v_send; end if;
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_send ->> 'occurrenceId')::uuid;
	if v_wake.requested_by_user_id <> '30000000-0000-4000-8000-000000000001'
		or v_wake.sponsor_binding_id <> (current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid
		or v_wake.sponsor_version <> 1 or v_wake.logical_computer_id is not null or v_wake.status <> 'queued' then
		raise exception 'the coworker wake is not paid by the member who started the chain: %', row_to_json(v_wake);
	end if;
	if not public.qorpera_wake_authorized(v_wake) then
		raise exception 'the starter-paid coworker wake is not authorized'; end if;
	-- Admission refuses the same wake on another member's login.
	v_wake.sponsor_binding_id := (current_setting('qorpera_test.pays_sponsor')::jsonb ->> 'binding_id')::uuid;
	if public.qorpera_wake_authorized(v_wake) then
		raise exception 'a wake was admitted on another member''s login'; end if;
	-- The one check where runs are created or moved.
	begin
		update public.qorpera_execution_runs
		set sponsor_binding_id = (current_setting('qorpera_test.pays_sponsor')::jsonb ->> 'binding_id')::uuid, sponsor_version = 1
		where id = v_run;
		raise exception 'a run moved onto another member''s login';
	exception when insufficient_privilege then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		if v_message not like '%pays only for work that member started%' then raise; end if;
	end;
end
$$;

-- A coding session runs for the member who asked: the model cannot name another member.
select pg_temp.path_claims('service_role');
select pg_temp.wake_error($q$select public.qorpera_manage_agent_worker(current_setting('qorpera_test.wake_binding')::jsonb,
	jsonb_build_object('action','dispatch','operationKey','pays-code','todoKey','fix-login','workerKey','fix-login',
		'title','Fix the login page','goal','Make the login page load.','definitionOfDone','The page loads.',
		'access','read','species','coding','harness','codex',
		'repository',jsonb_build_object('host','github.com','owner','qorpera','name','site','baseBranch','main'),
		'owner','30000000-0000-4000-8000-000000000002'))$q$,'42501','A coding session runs for the member who asked for it');

-- A run created for one member on another member's login is refused where it is inserted.
do $$
declare v_base public.qorpera_execution_runs%rowtype; v_id uuid := extensions.gen_random_uuid(); v_job uuid;
	v_message text;
begin
	select * into strict v_base from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	insert into public.qorpera_runner_jobs(profile_id,environment_id,session_id,substrate_version_id,client_job_id,
		required_capability,job_type,payload,created_by_user_id)
	values(v_base.profile_id,v_base.environment_id,v_base.session_id,v_base.substrate_version_id,v_id,
		'agent_turn','agent_turn','{}','30000000-0000-4000-8000-000000000002') returning id into v_job;
	begin
		insert into public.qorpera_execution_runs(id,profile_id,environment_id,source_kind,source_id,session_id,job_id,
			substrate_version_id,company_snapshot_id,staff_agent_id,staff_version,input_ids,sponsor_binding_id,sponsor_version,
			required_capability,job_type,payload_sha256,compute_identity_id,transcript_start_sequence,created_by_user_id)
		values(v_id,v_base.profile_id,v_base.environment_id,'room_delivery',v_id,v_base.session_id,v_job,
			v_base.substrate_version_id,v_base.company_snapshot_id,v_base.staff_agent_id,v_base.staff_version,'{}',
			v_base.sponsor_binding_id,v_base.sponsor_version,'agent_turn','agent_turn',repeat('e',64),v_base.compute_identity_id,0,
			'30000000-0000-4000-8000-000000000002');
		raise exception 'a run for the contributor was created on the owner''s login';
	exception when insufficient_privilege then
		get stacked diagnostics v_message = message_text;
		if v_message not like '%pays only for work that member started%' then raise; end if;
	end;
end
$$;

-- A standing authority names a company account only.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_refused boolean := false;
begin
	begin
		perform public.qorpera_configure_staff_execution_authority('30000000-0000-4000-8000-000000000010',
			'30000000-0000-4000-8000-000000000031',(current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid,1,null);
	exception when invalid_parameter_value then v_refused := true;
	end;
	if not v_refused then raise exception 'a member login became an agent''s standing account'; end if;
end
$$;

-- The owner adds a company account. Until its kind of account can run, nobody is paid by it.
select set_config('qorpera_test.pays_company_connection',public.qorpera_register_provider_connection(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000770',null,
	'openai','api_key','codex-cli','vault://company/openai','org-fixture','company-api-billing','qorpera-provider-consent/v1',null,
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}',
	true)::text,true);
select set_config('qorpera_test.pays_company_sponsor',public.qorpera_create_execution_sponsor_binding(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000771','company_api_billing',
	(current_setting('qorpera_test.pays_company_connection')::jsonb ->> 'connection_id')::uuid,1,true)::text,true);
reset role;
select pg_temp.path_claims('service_role');
do $$
begin
	if exists (select 1 from public.qorpera_starter_sponsor('30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000031',null)) then
		raise exception 'a company account that cannot run was chosen to pay';
	end if;
end
$$;
set local role service_role;
select public.qorpera_set_provider_execution_policy('openai','api_key','codex-cli','supported','enabled',64,null,null);
reset role;

-- Now the company pays when the starter has no login of their own, and never before a member's own login; work
-- that follows a company-paid run stays on the company account (20260930059000).
do $$
declare
	v_profile uuid := '30000000-0000-4000-8000-000000000010';
	v_agent uuid := '30000000-0000-4000-8000-000000000031';
	v_company uuid := (current_setting('qorpera_test.pays_company_sponsor')::jsonb ->> 'binding_id')::uuid;
	v_owner_binding uuid := (current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid;
	v_payer record;
begin
	select * into v_payer from public.qorpera_starter_sponsor(v_profile,'30000000-0000-4000-8000-000000000003',v_agent,v_owner_binding);
	if v_payer.binding_id is distinct from v_company then
		raise exception 'the company account did not pay for a starter without a login: %', row_to_json(v_payer); end if;
	select * into v_payer from public.qorpera_starter_sponsor(v_profile,'30000000-0000-4000-8000-000000000001',v_agent,null);
	if v_payer.binding_id is distinct from v_owner_binding then
		raise exception 'the company account paid before the starter''s own login: %', row_to_json(v_payer); end if;
	select * into v_payer from public.qorpera_starter_sponsor(v_profile,'30000000-0000-4000-8000-000000000001',v_agent,v_company);
	if v_payer.binding_id is distinct from v_company then
		raise exception 'follow-up work of a company-paid run moved to the starter''s login: %', row_to_json(v_payer); end if;
	if not public.qorpera_sponsor_serves_requester(v_profile,v_company,1,'30000000-0000-4000-8000-000000000002')
		or not public.qorpera_sponsor_serves_requester(v_profile,v_company,1,'30000000-0000-4000-8000-000000000003') then
		raise exception 'a company account does not serve every member';
	end if;
end
$$;

-- An owner may name the company account as an agent's standing account; it is then that agent's company account.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_configure_staff_execution_authority('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000031',(current_setting('qorpera_test.pays_company_sponsor')::jsonb ->> 'binding_id')::uuid,1,null);
reset role;
do $$
begin
	if (select binding_id from public.qorpera_company_account_sponsor('30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000031')) is distinct from
		(current_setting('qorpera_test.pays_company_sponsor')::jsonb ->> 'binding_id')::uuid then
		raise exception 'the configured company account is not the agent''s company account';
	end if;
end
$$;

rollback;
