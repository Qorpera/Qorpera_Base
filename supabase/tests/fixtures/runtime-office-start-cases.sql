-- Disposable SQL only. Provider image/instance/configuration digests are
-- synthetic; this fixture never asserts physical readiness or activates a VM.
reset role;
update public.qorpera_runtime_offices set state='provisioning';
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_set_runtime_office_provider(current_setting('qorpera_test.office_scope')::jsonb,1,
	'35000000-0000-4000-8000-000000000070',repeat('f',64),0,true);
reset role;
savepoint office_start_member;
create function pg_temp.office_start_request(p_id uuid default '35000000-0000-4000-8000-000000000001') returns jsonb language sql as $$
	select public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,p_id)
$$;
create function pg_temp.office_start_reserve(p_binding_sha text default repeat('d',64)) returns jsonb language sql as $$
	select public.qorpera_reserve_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
		current_setting('qorpera_test.start_id')::uuid,'35000000-0000-4000-8000-000000000002',repeat('c',64),repeat('a',64),repeat('b',64),p_binding_sha,
		'35000000-0000-4000-8000-000000000070',repeat('f',64))
$$;
create function pg_temp.office_start_check() returns jsonb language sql as $$
	select public.qorpera_check_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
		current_setting('qorpera_test.start_id')::uuid,'35000000-0000-4000-8000-000000000002',repeat('c',64),repeat('d',64),
		'35000000-0000-4000-8000-000000000070',repeat('f',64))
$$;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.office_start_request()$q$,'42501');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.office_start_request()$q$,'42501');
select pg_temp.wake_assert(public.qorpera_runtime_office_start_status(current_setting('qorpera_test.office_scope')::jsonb)
	=jsonb_build_object('scope',current_setting('qorpera_test.office_scope')::jsonb,'computerGeneration',1,'officeState','provisioning','intent',null),
	'members can read an empty current start status');
reset role;
select pg_temp.path_claims('authenticated','35000000-0000-4000-8000-000000000099');
set local role authenticated;
select pg_temp.wake_error($q$select public.qorpera_runtime_office_start_status(current_setting('qorpera_test.office_scope')::jsonb)$q$,'42501');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.start_id',pg_temp.office_start_request()->>'intentId',true);
select pg_temp.wake_assert(public.qorpera_runtime_office_start_status(current_setting('qorpera_test.office_scope')::jsonb)->'intent'=pg_temp.office_start_request(),
	'lost request response recovers only the closed current intent');
select pg_temp.wake_assert(pg_temp.office_start_request()->>'state'='requested','start is durable demand only');
select pg_temp.wake_assert(pg_temp.office_start_request('35000000-0000-4000-8000-000000000003')->>'intentId'
	=current_setting('qorpera_test.start_id'),'one intent per generation coalesces callers');
select public.qorpera_set_company_machine_limit('30000000-0000-4000-8000-000000000010',1,0);
select pg_temp.wake_error($q$select public.qorpera_request_runtime_office_start(
	jsonb_set(current_setting('qorpera_test.office_scope')::jsonb,'{companyId}','"35000000-0000-4000-8000-000000000099"'),1,extensions.gen_random_uuid())$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,2,extensions.gen_random_uuid())$q$,'42501');
reset role;
select set_config('qorpera_test.start_native_machine',(select client_runner_id::text from public.qorpera_runners
	where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runnerId')::uuid),true);
select set_config('qorpera_test.start_native_provider',(select provider_adapter from public.qorpera_runners
	where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runnerId')::uuid),true);
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.office_start_check()$q$,'42501');
select public.qorpera_reserve_runtime_machine(current_setting('qorpera_test.start_native_machine')::uuid,
	current_setting('qorpera_test.start_native_provider'),repeat('e',64),
	(current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid,(current_setting('qorpera_test.wake_binding')::jsonb->>'runnerId')::uuid);
select pg_temp.wake_assert(pg_temp.office_start_reserve()='{"state":"refused","reason":"MACHINE_CAPACITY_EXHAUSTED"}'::jsonb,'start shares native machine capacity');
reset role;
select pg_temp.wake_assert((select state='requested' and allocation_id is null from public.qorpera_runtime_office_start_intents),'refusal binds no phantom allocation');
set local role service_role;
select public.qorpera_release_runtime_machine(current_setting('qorpera_test.start_native_machine')::uuid,
	current_setting('qorpera_test.start_native_provider'),repeat('e',64));
select pg_temp.wake_assert(pg_temp.office_start_reserve()->>'state'='reserved','provider reserves existing durable intent');
select pg_temp.wake_assert(pg_temp.office_start_reserve()->>'allocationId'='35000000-0000-4000-8000-000000000002','reservation replay preserves allocation');
select pg_temp.wake_error($q$select pg_temp.office_start_reserve(repeat('f',64))$q$,'42501');
select pg_temp.wake_assert(pg_temp.office_start_check()->>'state'='authorized','preparation check authorizes exact current binding');
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
	current_setting('qorpera_test.start_id')::uuid,'35000000-0000-4000-8000-000000000002',repeat('c',64),repeat('f',64),
	'35000000-0000-4000-8000-000000000070',repeat('f',64))$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_guest_binding(current_setting('qorpera_test.office_scope')::jsonb,
	1,'35000000-0000-4000-8000-000000000002',repeat('c',64),repeat('a',64),repeat('b',64))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.office_call('acquire')$q$,'42501');
reset role;
select pg_temp.wake_assert((select state='provisioning' from public.qorpera_runtime_offices),'reservation does not activate office');
savepoint changed_start_image;
update public.qorpera_runtime_offices set image_sha256=repeat('f',64);
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.office_start_check()$q$,'42501');
reset role;
rollback to savepoint changed_start_image;
savepoint changed_start_bootstrap;
update public.qorpera_runtime_offices set bootstrap_sha256=repeat('f',64);
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.office_start_check()$q$,'42501');
reset role;
rollback to savepoint changed_start_bootstrap;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_company_execution_pause('30000000-0000-4000-8000-000000000010',true,'start fixture');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.office_start_check()$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.office_start_reserve()$q$,'42501');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_company_execution_pause('30000000-0000-4000-8000-000000000010',false,'start fixture');
select pg_temp.wake_assert(public.qorpera_cancel_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
	current_setting('qorpera_test.start_id')::uuid)->>'state'='cancelled','cancellation fences future preparation');
select pg_temp.wake_assert(public.qorpera_cancel_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
	current_setting('qorpera_test.start_id')::uuid)->>'state'='cancelled','cancellation replay');
select pg_temp.wake_error($q$select pg_temp.office_start_request()$q$,'42501');
select pg_temp.wake_assert(public.qorpera_runtime_office_start_status(current_setting('qorpera_test.office_scope')::jsonb)#>>'{intent,state}'='cancelled',
	'cancellation remains observable without physical release');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.office_start_check()$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.office_start_reserve()$q$,'42501');
reset role;
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_machine_allocations where released_at is null),'cancelled and unknown physical outcomes still occupy capacity');
update public.qorpera_runtime_offices set generation=2;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_assert(public.qorpera_runtime_office_start_status(current_setting('qorpera_test.office_scope')::jsonb)
	=jsonb_build_object('scope',current_setting('qorpera_test.office_scope')::jsonb,'computerGeneration',2,'officeState','provisioning','intent',null),
	'new generation does not expose stale start recovery');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.office_start_check()$q$,'42501');
reset role;
rollback to savepoint office_start_member;

-- Native demand consumes the ordinary receipt, not a screen or physical guest.
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
select set_config('qorpera_test.start_descriptor',public.qorpera_native_office_start_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.start_descriptor')::jsonb->>'state'='available','native startup is discoverable while office is provisioning');
select pg_temp.wake_assert(public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->>'state'='unavailable','ordinary office tools stay closed');
select set_config('qorpera_test.start_envelope',jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
	'principals',(public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.wake_binding')::jsonb)->'identity')
		-array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
	'operation',jsonb_build_object('tool','computer_start','toolVersion','qorpera.company-computer-tools/v2','logicalOperationKey','start-office',
		'requiresCompanyRevision',false,'arguments','{"kind":"start"}'::jsonb,
		'target',jsonb_build_object('realm','company_computer','scope',current_setting('qorpera_test.start_descriptor')::jsonb->'scope',
			'computerGeneration',1,'resources',current_setting('qorpera_test.start_descriptor')::jsonb->'resources')))::text,true);
create function pg_temp.native_start(p_action text,p_envelope text default null) returns jsonb language sql as $$
	select public.qorpera_native_office_start(current_setting('qorpera_test.wake_binding')::jsonb,
		coalesce(p_envelope,current_setting('qorpera_test.start_envelope')),p_action,
		case when p_action='begin' then '35000000-0000-4000-8000-000000000010'::uuid else null end,
		case when p_action='begin' then repeat('d',64) else null end)
$$;
select pg_temp.wake_assert(pg_temp.native_start('authorize')->>'state'='authorized','native startup authority before receipt');
select pg_temp.wake_error($q$select pg_temp.native_start('begin')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.native_start('authorize',jsonb_set(current_setting('qorpera_test.start_envelope')::jsonb,
	'{principals,audienceKind}','"member_private"')::text)$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.native_start('authorize',jsonb_set(current_setting('qorpera_test.start_envelope')::jsonb,
	'{operation,target,computerGeneration}','2')::text)$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.native_start('authorize',jsonb_set(current_setting('qorpera_test.start_envelope')::jsonb,
	'{operation,arguments}','{"kind":"start","command":"untrusted"}')::text)$q$,'42501');
select public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,
	'35000000-0000-4000-8000-000000000010','computer_start:start-office',
	encode(extensions.digest(current_setting('qorpera_test.start_envelope'),'sha256'),'hex'),repeat('d',64),false);
select pg_temp.wake_error($q$select pg_temp.native_start('begin',current_setting('qorpera_test.start_envelope')||' ')$q$,'42501');
select set_config('qorpera_test.start_id',pg_temp.native_start('begin')->>'intentId',true);
select pg_temp.wake_assert(pg_temp.native_start('begin')->>'intentId'=current_setting('qorpera_test.start_id'),'repeated exact receipt coalesces durable demand');
reset role;
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_office_start_intents),'one native start intent');
select pg_temp.wake_assert((select receipt_id='35000000-0000-4000-8000-000000000010' and requested_by_user_id is null
	and requested_by_staff_agent_id='30000000-0000-4000-8000-000000000030' from public.qorpera_runtime_office_start_intents),'native receipt and staff provenance retained');
set local role service_role;
select public.qorpera_reserve_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,current_setting('qorpera_test.start_id')::uuid,
	'35000000-0000-4000-8000-000000000012',repeat('c',64),repeat('a',64),repeat('b',64),repeat('d',64),
	'35000000-0000-4000-8000-000000000070',repeat('f',64));
reset role;
savepoint start_activation_race;
-- Synthetic activation only, to model the result-release race. No provider
-- or physical readiness claim is made by this direct fixture mutation.
update public.qorpera_runtime_offices set state='active';
set local role service_role;
select pg_temp.wake_assert(pg_temp.native_start('authorize')->>'state'='authorized','activation does not discard a pending start result');
select pg_temp.wake_assert(public.qorpera_native_office_start_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->>'state'='unavailable','active office does not advertise a new start');
select pg_temp.wake_error($q$select pg_temp.native_start('begin')$q$,'42501');
reset role;
rollback to savepoint start_activation_race;
-- A process/run ending cannot erase accepted company demand or free capacity.
reset role;
update public.qorpera_native_provider_connection_leases set expires_at=clock_timestamp()
	where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'leaseId')::uuid;
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.native_start('authorize')$q$,'42501');
select pg_temp.wake_assert(public.qorpera_check_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,current_setting('qorpera_test.start_id')::uuid,
	'35000000-0000-4000-8000-000000000012',repeat('c',64),repeat('d',64),
	'35000000-0000-4000-8000-000000000070',repeat('f',64))->>'state'='authorized','accepted demand survives native requester expiry');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_runtime_office_access((current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,
	'30000000-0000-4000-8000-000000000030',1,false);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,current_setting('qorpera_test.start_id')::uuid,
	'35000000-0000-4000-8000-000000000012',repeat('c',64),repeat('d',64),
	'35000000-0000-4000-8000-000000000070',repeat('f',64))$q$,'42501');
reset role;
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_machine_allocations where released_at is null),'grant revocation does not claim physical deletion');
select pg_temp.wake_assert((select state='provisioning' from public.qorpera_runtime_offices),'native start and reservation do not activate office');
do $$
declare v_role text; v_function regprocedure;
begin
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		perform pg_temp.wake_assert(not has_table_privilege(v_role,'public.qorpera_runtime_office_start_intents','SELECT,INSERT,UPDATE,DELETE'),'private start intent table: '||v_role);
		for v_function in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
			and proname in ('qorpera_runtime_office_start_result','qorpera_assert_runtime_office_start_source') loop
			perform pg_temp.wake_assert(not has_function_privilege(v_role,v_function,'EXECUTE'),'private start helper: '||v_role);
		end loop;
	end loop;
	perform pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_reserve_runtime_office_start(jsonb,bigint,uuid,uuid,text,text,text,text,uuid,text)','EXECUTE'),'members cannot claim reservation');
	perform pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_native_office_start(jsonb,text,text,uuid,text)','EXECUTE'),'members cannot impersonate native startup');
	perform pg_temp.wake_assert(not has_function_privilege('anon','public.qorpera_runtime_office_start_status(jsonb)','EXECUTE'),'anonymous start status denied');
end
$$;
