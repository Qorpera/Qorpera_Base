-- SQL policy regression only. Physical activation/stop evidence below is
-- synthetic; provider worker tests separately exercise retained stop journals.
reset role;
update public.qorpera_runtime_offices set state='provisioning';
select pg_temp.path_claims('service_role');
select public.qorpera_set_runtime_office_provider(current_setting('qorpera_test.office_scope')::jsonb,1,
	'39000000-0000-4000-8000-000000000001',repeat('f',64),0,true);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
	'39000000-0000-4000-8000-000000000002');
select pg_temp.path_claims('service_role');
select public.qorpera_reserve_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
	'39000000-0000-4000-8000-000000000002','39000000-0000-4000-8000-000000000003',repeat('c',64),repeat('a',64),repeat('b',64),repeat('d',64),
	'39000000-0000-4000-8000-000000000001',repeat('f',64));
insert into public.qorpera_runtime_office_activations(intent_id,activation_id,office_id,computer_generation,allocation_id,
	provider_id,provider_policy_sha256,provider_binding_sha256,instance_sha256,image_sha256,bootstrap_sha256,attestation,mappings,
	state,service_invocation_id,ready_at,activated_at)
select i.id,'39000000-0000-4000-8000-000000000004',i.office_id,1,i.allocation_id,p.provider_id,p.policy_sha256,
	i.provider_binding_sha256,i.instance_sha256,i.image_sha256,i.bootstrap_sha256,
	jsonb_build_object('bootId','39000000-0000-4000-8000-000000000005','configurationSha256',repeat('e',64)),
	'[]','active',repeat('a',32),clock_timestamp(),clock_timestamp()
from public.qorpera_runtime_office_start_intents i join public.qorpera_runtime_office_providers p on p.office_id=i.office_id;
update public.qorpera_runtime_offices set state='active';
create function pg_temp.idle_poll() returns jsonb language sql as $$
	select public.qorpera_reconcile_runtime_office_idle(current_setting('qorpera_test.office_scope')::jsonb,1,
		'39000000-0000-4000-8000-000000000001',repeat('f',64),60000)
$$;
create function pg_temp.idle_due() returns void language sql as $$
	update public.qorpera_runtime_office_idle_policies set idle_since=clock_timestamp()-interval '2 minutes'
$$;
select pg_temp.wake_assert(pg_temp.idle_poll()->'request'='null','an authorized ordinary run retains warm tools before first guest lease');
select pg_temp.wake_assert((select idle_since is null from public.qorpera_runtime_office_idle_policies),'live run resets idle timer');
select set_config('qorpera_test.idle_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select set_config('qorpera_test.idle_ticket',public.qorpera_create_runtime_office_viewer(
	current_setting('qorpera_test.idle_lease')::jsonb->'binding',
	(current_setting('qorpera_test.idle_lease')::jsonb->>'epoch')::bigint,'shared')::text,true);
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.idle_grant',public.qorpera_redeem_runtime_office_viewer(current_setting('qorpera_test.office_scope')::jsonb,
	encode(extensions.digest(current_setting('qorpera_test.idle_ticket')::jsonb->>'capability','sha256'),'hex'))::text,true);
select pg_temp.office_call('release',current_setting('qorpera_test.idle_lease')::jsonb);
-- Expire only scheduling demand; no resources or guest lease have been acquired.
select set_config('qorpera_test.idle_run_deadline',(select deadline_at::text from public.qorpera_execution_runs
	where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid),true);
update public.qorpera_execution_runs set deadline_at=clock_timestamp();
select pg_temp.idle_due();
select pg_temp.wake_assert(pg_temp.idle_poll()->'request'='null','live shared viewer alone retains VM after agent lease release');
select public.qorpera_release_runtime_office_viewer(current_setting('qorpera_test.idle_grant')::jsonb);
select pg_temp.wake_assert(pg_temp.idle_poll()->'request'='null','first demand-free poll starts grace period');
select pg_temp.idle_due();
savepoint pending_physical_drain;
update public.qorpera_runtime_office_screens set drain_pending=true,drain_id=extensions.gen_random_uuid(),drain_acknowledged_at=null;
select pg_temp.wake_assert(pg_temp.idle_poll()->'request'='null','unacknowledged physical drain blocks idle');
rollback to savepoint pending_physical_drain;
select set_config('qorpera_test.idle_since',(select idle_since::text from public.qorpera_runtime_office_idle_policies),true);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select public.qorpera_runtime_office_start_status(current_setting('qorpera_test.office_scope')::jsonb);
select public.qorpera_runtime_office_member_status(current_setting('qorpera_test.office_scope')::jsonb);
select pg_temp.wake_assert((select idle_since::text=current_setting('qorpera_test.idle_since') from public.qorpera_runtime_office_idle_policies),
	'signed-in status polling creates no machine demand');
select public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,extensions.gen_random_uuid());
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(pg_temp.idle_poll()->'request'='null','explicit open resets grace period before viewer connects');
-- Persistent shared desktop state is not proof of a live viewer.
update public.qorpera_runtime_office_screens set power='open';
select pg_temp.idle_due();
select set_config('qorpera_test.idle_first',pg_temp.idle_poll()::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.idle_first')::jsonb#>>'{request,action}'='power_off','idle emits concrete bounded lifecycle request');
select pg_temp.wake_assert(pg_temp.idle_poll()=current_setting('qorpera_test.idle_first')::jsonb,'uncertain reply retains same idle identity');
select pg_temp.wake_assert((select state='maintenance' from public.qorpera_runtime_offices),'idle atomically revokes before stopping');
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_machine_allocations where released_at is null),'idle preserves charged allocation');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
select pg_temp.wake_error($q$select public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,extensions.gen_random_uuid())$q$,'42501');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(public.qorpera_runtime_office_start_status(current_setting('qorpera_test.office_scope')::jsonb)#>>'{maintenance,reason}'='idle','current idle has distinct maintenance metadata');
select public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,'39000000-0000-4000-8000-000000000020');
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(pg_temp.idle_poll()->>'wakeRequested'='true','member open during stop creates durable wake');

-- Closing before the computer is up withdraws only the member's own request. The wake stands.
create function pg_temp.idle_withdraw(p_request uuid) returns jsonb language sql as $$
	select public.qorpera_withdraw_runtime_office_wake(current_setting('qorpera_test.office_scope')::jsonb,1,p_request)
$$;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
select public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,'39000000-0000-4000-8000-000000000021');
select pg_temp.wake_assert(pg_temp.idle_withdraw('39000000-0000-4000-8000-000000000020')->>'state'='unavailable','a member cannot withdraw another member''s wake');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(pg_temp.idle_withdraw(extensions.gen_random_uuid())->>'state'='unavailable','withdrawal names the exact request');
select pg_temp.wake_error($q$select public.qorpera_withdraw_runtime_office_wake(current_setting('qorpera_test.office_scope')::jsonb,2,'39000000-0000-4000-8000-000000000020')$q$,'42501');
select pg_temp.wake_assert(pg_temp.idle_withdraw('39000000-0000-4000-8000-000000000020')->>'state'='withdrawn','member withdraws own wake');
select pg_temp.wake_assert(pg_temp.idle_withdraw('39000000-0000-4000-8000-000000000020')->>'state'='withdrawn','withdrawal is idempotent');
select public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,'39000000-0000-4000-8000-000000000022');
select pg_temp.wake_assert((select withdrawn_at is null and request_id='39000000-0000-4000-8000-000000000022' from public.qorpera_runtime_office_wake_requests
	where user_id='30000000-0000-4000-8000-000000000001'),'asking again takes back a withdrawal');
select pg_temp.wake_assert(pg_temp.idle_withdraw('39000000-0000-4000-8000-000000000020')->>'state'='unavailable','a replaced request cannot be withdrawn');
select pg_temp.wake_assert(pg_temp.idle_withdraw('39000000-0000-4000-8000-000000000022')->>'state'='withdrawn','the latest request is withdrawn');
select pg_temp.wake_assert(public.qorpera_runtime_office_start_status(current_setting('qorpera_test.office_scope')::jsonb)#>>'{maintenance,state}'='resumed','withdrawal never takes back the wake');
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(pg_temp.idle_poll()->>'wakeRequested'='true','the provider still sees the wake after a withdrawal');
select pg_temp.wake_assert(not has_function_privilege('anon','public.qorpera_withdraw_runtime_office_wake(jsonb,bigint,uuid)','EXECUTE')
	and not has_function_privilege('service_role','public.qorpera_withdraw_runtime_office_wake(jsonb,bigint,uuid)','EXECUTE')
	and not has_function_privilege('authenticated','public.qorpera_runtime_office_wake_withdrawn(public.qorpera_runtime_office_idle_cycles)','EXECUTE')
	and not has_table_privilege('authenticated','public.qorpera_runtime_office_wake_requests','SELECT'),'only signed-in members withdraw, through the function');

-- Synthetic settlement advances SQL lineage without pretending to boot a VM.
create function pg_temp.idle_successor(p_activation uuid) returns void language plpgsql as $$
declare a public.qorpera_runtime_office_activations%rowtype; t public.qorpera_runtime_office_lifecycle_transitions%rowtype;
	v_challenge uuid:=extensions.gen_random_uuid(); v_now timestamptz:=clock_timestamp();
begin
	select * into strict a from public.qorpera_runtime_office_activations where superseded_at is null;
	select * into strict t from public.qorpera_runtime_office_lifecycle_transitions where activation_id=a.activation_id;
	insert into public.qorpera_runtime_office_stop_challenges(id,transition_id,command,start_completion_sha256,office_revision,privacy_version,drains,issued_at,expires_at)
		values(v_challenge,t.id,'{}',repeat('a',64),t.revocation_revision,1,t.drains,v_now,v_now+interval '5 seconds');
	insert into public.qorpera_runtime_office_stops(transition_id,challenge_id,inspection) values(t.id,v_challenge,'{}');
	update public.qorpera_runtime_office_activations set superseded_at=v_now where activation_id=a.activation_id;
	insert into public.qorpera_runtime_office_activations select (jsonb_populate_record(null::public.qorpera_runtime_office_activations,
		to_jsonb(a)||jsonb_build_object('activation_id',p_activation,'predecessor_activation_id',a.activation_id,
		'service_invocation_id',replace(p_activation::text,'-',''),'activated_at',v_now))).*;
	insert into public.qorpera_runtime_office_successors(activation_id,transition_id,request,office_revision,privacy_state,privacy_version)
		values(p_activation,t.id,'{}',t.revocation_revision,'shared',1);
	update public.qorpera_runtime_offices set state='active';
	update public.qorpera_runtime_office_screens set drain_pending=false,drain_id=null,drain_acknowledged_at=v_now;
end $$;
select pg_temp.idle_successor('39000000-0000-4000-8000-000000000006');
select pg_temp.wake_assert(pg_temp.idle_poll()->'request'=current_setting('qorpera_test.idle_first')::jsonb->'request','warm successor retains exact recovery lineage');
select pg_temp.wake_assert((select activated_at is not null from public.qorpera_runtime_office_idle_cycles),'successor completion recorded');
-- A wake every member withdrew stops one minute after the computer is up;
-- one still wanted, or a computer used since, keeps the full idle window.
create function pg_temp.idle_poll_long() returns jsonb language sql as $$
	select public.qorpera_reconcile_runtime_office_idle(current_setting('qorpera_test.office_scope')::jsonb,1,
		'39000000-0000-4000-8000-000000000001',repeat('f',64),300000)
$$;
create function pg_temp.idle_ago(p_seconds integer) returns void language sql as $$
	update public.qorpera_runtime_office_idle_policies set idle_since=clock_timestamp()-p_seconds*interval '1 second'
$$;
savepoint wake_still_wanted;
select pg_temp.idle_poll_long();
select pg_temp.idle_ago(90);
select pg_temp.wake_assert(pg_temp.idle_poll_long()->'request'=current_setting('qorpera_test.idle_first')::jsonb->'request','a wake another member still wants keeps the full idle window');
rollback to savepoint wake_still_wanted;
savepoint wake_withdrawn;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
select pg_temp.wake_assert(pg_temp.idle_withdraw('39000000-0000-4000-8000-000000000021')->>'state'='withdrawn','a member withdraws after the computer is up');
select pg_temp.path_claims('service_role');
select pg_temp.idle_poll_long();
select pg_temp.idle_ago(30);
select pg_temp.wake_assert(pg_temp.idle_poll_long()->'request'=current_setting('qorpera_test.idle_first')::jsonb->'request','a withdrawn wake still gets one minute');
select pg_temp.idle_ago(61);
select set_config('qorpera_test.idle_withdrawn',pg_temp.idle_poll_long()::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.idle_withdrawn')::jsonb#>>'{request,action}'='power_off'
	and current_setting('qorpera_test.idle_withdrawn')::jsonb#>'{request,transitionId}'<>current_setting('qorpera_test.idle_first')::jsonb#>'{request,transitionId}',
	'a wake every member withdrew stops one minute after the computer is up');
rollback to savepoint wake_withdrawn;
savepoint wake_used;
update public.qorpera_runtime_office_wake_requests set withdrawn_at=clock_timestamp();
update public.qorpera_runtime_office_screens set drain_pending=true,drain_id=extensions.gen_random_uuid(),drain_acknowledged_at=null;
select pg_temp.idle_poll_long();
select pg_temp.wake_assert((select demand_seen_at is not null from public.qorpera_runtime_office_idle_cycles),'demand after the wake is recorded');
update public.qorpera_runtime_office_screens set drain_pending=false,drain_id=null,drain_acknowledged_at=clock_timestamp();
select pg_temp.idle_poll_long();
select pg_temp.idle_ago(90);
select pg_temp.wake_assert(pg_temp.idle_poll_long()->'request'=current_setting('qorpera_test.idle_first')::jsonb->'request','a computer used since its wake keeps the full idle window');
rollback to savepoint wake_used;
-- Historical completed host reboot cannot mask a newer idle or operator stop.
insert into public.qorpera_runtime_office_host_reboots(transition_id,office_id,computer_generation,allocation_id,activation_id,
	shutdown_host_boot_id,resumed_host_boot_id,successor_activation_id,requested_at,resumed_at,activated_at)
select extensions.gen_random_uuid(),office_id,computer_generation,allocation_id,activation_id,
	extensions.gen_random_uuid(),extensions.gen_random_uuid(),activation_id,clock_timestamp()-interval '1 hour',clock_timestamp(),clock_timestamp()
from public.qorpera_runtime_office_activations where superseded_at is null;
select pg_temp.idle_due();
select set_config('qorpera_test.idle_second',pg_temp.idle_poll()::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.idle_second')::jsonb#>'{request,transitionId}'<>
	current_setting('qorpera_test.idle_first')::jsonb#>'{request,transitionId}','second idle has fresh transition');
select pg_temp.wake_assert(current_setting('qorpera_test.idle_second')::jsonb#>>'{request,activationId}'='39000000-0000-4000-8000-000000000006','second idle binds current successor');
select pg_temp.wake_assert((select public.qorpera_runtime_office_maintenance(o)->>'reason'='idle' from public.qorpera_runtime_offices o),'completed host history does not mask current idle');

-- Native work discovers cold startup and creates a normal receipt-backed waiter.
update public.qorpera_execution_runs set deadline_at=current_setting('qorpera_test.idle_run_deadline')::timestamptz;
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
select set_config('qorpera_test.idle_native_descriptor',public.qorpera_native_office_start_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.idle_native_descriptor')::jsonb->>'state'='available','idle advertises native computer_start');
select set_config('qorpera_test.idle_native_envelope',jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
	'principals',(public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.wake_binding')::jsonb)->'identity')
		-array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
	'operation',jsonb_build_object('tool','computer_start','toolVersion','qorpera.company-computer-tools/v2','logicalOperationKey','idle-start',
		'requiresCompanyRevision',false,'arguments','{"kind":"start"}'::jsonb,
		'target',jsonb_build_object('realm','company_computer','scope',current_setting('qorpera_test.idle_native_descriptor')::jsonb->'scope',
			'computerGeneration',1,'resources',current_setting('qorpera_test.idle_native_descriptor')::jsonb->'resources')))::text,true);
select public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,
	'39000000-0000-4000-8000-000000000010','computer_start:idle-start',
	encode(extensions.digest(current_setting('qorpera_test.idle_native_envelope'),'sha256'),'hex'),repeat('d',64),false);
select public.qorpera_native_office_start(current_setting('qorpera_test.wake_binding')::jsonb,current_setting('qorpera_test.idle_native_envelope'),
	'begin','39000000-0000-4000-8000-000000000010',repeat('d',64));
select pg_temp.wake_assert(pg_temp.idle_poll()->>'wakeRequested'='true','native receipt requests idle wake');
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_office_start_waiters where state='waiting'),'native continuation waiter is durable');
-- A member who also woke it and withdrew does not cut the agent's computer short.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,'39000000-0000-4000-8000-000000000023');
select pg_temp.wake_assert(pg_temp.idle_withdraw('39000000-0000-4000-8000-000000000023')->>'state'='withdrawn','member withdraws beside an agent wake');
select pg_temp.path_claims('service_role');
select pg_temp.idle_successor('39000000-0000-4000-8000-000000000007');
select pg_temp.idle_poll();
select pg_temp.wake_assert((select demand_seen_at is not null from public.qorpera_runtime_office_idle_cycles
	where transition_id=(current_setting('qorpera_test.idle_second')::jsonb#>>'{request,transitionId}')::uuid),
	'the waiting agent run keeps the full idle window after a member withdraws');
-- Later explicit maintenance supersedes idle lineage and must stay operator-owned.
select set_config('qorpera_test.idle_manual',(current_setting('qorpera_test.idle_second')::jsonb->'request'||jsonb_build_object(
	'transitionId',extensions.gen_random_uuid(),'activationId','39000000-0000-4000-8000-000000000007','action','service_restart',
	'startup',current_setting('qorpera_test.idle_second')::jsonb#>'{request,startup}'||jsonb_build_object('serviceInvocationId',replace('39000000-0000-4000-8000-000000000007','-',''))))::text,true);
select public.qorpera_begin_runtime_office_lifecycle(current_setting('qorpera_test.idle_manual')::jsonb);
select pg_temp.wake_assert(pg_temp.idle_poll()->'request'='null','explicit maintenance is never taken over by idle');
select pg_temp.wake_assert((select public.qorpera_runtime_office_maintenance(o) is null from public.qorpera_runtime_offices o),'historical host reboot does not advertise manual stop as wakeable');
select pg_temp.idle_successor('39000000-0000-4000-8000-000000000008');
select pg_temp.wake_assert(pg_temp.idle_poll()->'request'='null','later explicit successor does not replay old idle boot');
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_machine_allocations where released_at is null),'repeated idle/wake preserves one allocation');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_reconcile_runtime_office_idle(jsonb,bigint,uuid,text,integer)','EXECUTE'),'only provider can admit idle stop');
