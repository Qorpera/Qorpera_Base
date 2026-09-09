-- Run after the office setup prefix, with real native authority/receipt helpers.
set local role service_role;
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
create function pg_temp.office_envelope(p_key text,p_command text default 'printf office') returns text language sql as $$
	select jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
		'principals',(public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.wake_binding')::jsonb)->'identity')
			-array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation',jsonb_build_object('tool','computer_shell','toolVersion','qorpera.company-computer-tools/v2',
			'logicalOperationKey',p_key,'requiresCompanyRevision',false,'arguments',jsonb_build_object('kind','shell','command',p_command,'timeoutMs',1000),
			'target',jsonb_build_object('realm','company_computer','binding',current_setting('qorpera_test.office_lease')::jsonb->'binding',
				'resources',public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->'resources')))::text
$$;
create function pg_temp.office_effect(p_action text,p_envelope text default null) returns jsonb language sql as $$
	select public.qorpera_native_office_operation(current_setting('qorpera_test.wake_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb,current_setting('qorpera_test.office_lease')::jsonb,
		coalesce(p_envelope,current_setting('qorpera_test.office_envelope')),p_action,
		case when p_action='authorize' then null else current_setting('qorpera_test.office_receipt')::uuid end,
		case when p_action='authorize' then null else repeat('d',64) end)
$$;
create function pg_temp.office_receipt(p_key text) returns void language plpgsql as $$
begin
	perform set_config('qorpera_test.office_envelope',pg_temp.office_envelope(p_key),true);
	perform set_config('qorpera_test.office_receipt',extensions.gen_random_uuid()::text,true);
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,
		current_setting('qorpera_test.office_receipt')::uuid,'computer_shell:'||p_key,
		encode(extensions.digest(current_setting('qorpera_test.office_envelope'),'sha256'),'hex'),repeat('d',64),false);
end
$$;
select pg_temp.office_receipt('first-effect');
select pg_temp.wake_assert(pg_temp.office_effect('authorize')->>'state'='authorized','current effect authority');
select pg_temp.wake_error($q$select pg_temp.office_effect('begin',pg_temp.office_envelope('first-effect','printf substituted'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.office_effect('authorize',jsonb_set(current_setting('qorpera_test.office_envelope')::jsonb,
	'{principals,audienceKind}','"member_private"')::text)$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.office_effect('authorize',jsonb_set(current_setting('qorpera_test.office_envelope')::jsonb,
	'{operation,target,resources,officeGrantVersion}','99')::text)$q$,'42501');
select set_config('qorpera_test.office_resource',pg_temp.office_effect('begin')::text,true);
select pg_temp.wake_assert((current_setting('qorpera_test.office_resource')::jsonb->>'validForMs')::integer between 1 and 30000,'bounded work lease');
select pg_temp.wake_error($q$select pg_temp.office_effect('begin')$q$,'55000');
select pg_temp.wake_assert(pg_temp.office_effect('check')->>'state'='admitted','same effect stays authorized');
select pg_temp.wake_assert(pg_temp.office_effect('finish')->>'state'='drained','confirmed successful guest drain');
select pg_temp.wake_error($q$select pg_temp.office_effect('begin')$q$,'55000');
select pg_temp.wake_error($q$select pg_temp.office_effect('check')$q$,'42501');
select public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,
	current_setting('qorpera_test.office_receipt')::uuid,encode(extensions.digest(current_setting('qorpera_test.office_envelope'),'sha256'),'hex'),
	'{"schema":"qorpera.cloud-tool-operation-result/v1","content":{"kind":"text","value":"fixture"}}');

-- A lost response leaves durable occupancy even after release/expiry.
select pg_temp.office_receipt('lost-response');
select pg_temp.office_effect('begin');
reset role;
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_office_resources where state<>'drained'),'one unresolved resource');
update public.qorpera_runtime_office_resources set expires_at=clock_timestamp()-interval '1 second' where state='active';
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.office_effect('check')$q$,'42501');
select pg_temp.office_call('release',current_setting('qorpera_test.office_lease')::jsonb);
select pg_temp.wake_assert(pg_temp.office_call('acquire')->>'state'='refused','release cannot prove unknown work stopped');
reset role;
select pg_temp.wake_assert((select bool_and(state='draining') from public.qorpera_runtime_office_resources where state<>'drained'),'unknown work is draining');

select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_error($q$select public.qorpera_request_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
	(current_setting('qorpera_test.office_lease')::jsonb#>>'{binding,screenId}')::uuid,1,2,2,false)$q$,'42501');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.drain',public.qorpera_request_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
	(current_setting('qorpera_test.office_lease')::jsonb#>>'{binding,screenId}')::uuid,1,2,2,true)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
create function pg_temp.office_ack(p_epoch bigint default null,p_drain_id uuid default null) returns jsonb language sql as $$
	select public.qorpera_ack_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
		(current_setting('qorpera_test.office_lease')::jsonb#>>'{binding,screenId}')::uuid,1,2,
		coalesce(p_epoch,(current_setting('qorpera_test.drain')::jsonb->>'epoch')::bigint),
		coalesce(p_drain_id,(current_setting('qorpera_test.drain')::jsonb->>'drainId')::uuid))
$$;
select pg_temp.wake_error($q$select pg_temp.office_ack(99)$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.office_ack(null,extensions.gen_random_uuid())$q$,'42501');
select pg_temp.wake_assert(pg_temp.office_call('acquire')->>'state'='refused','member takeover waits for guest');
select pg_temp.wake_assert(pg_temp.office_ack()->>'state'='drained','exact guest acknowledgement');
select pg_temp.wake_assert(pg_temp.office_ack()->>'state'='drained','ack replay is harmless');
select pg_temp.wake_assert(pg_temp.office_call('acquire')->>'state'='refused','ack reserves member takeover, never grants agent control');
reset role;
select pg_temp.wake_assert((select count(*)=0 from public.qorpera_runtime_office_resources where state<>'drained'),'guest acknowledgement reaps all old work');

-- Cancelling takeover also requires a fresh drain, not a direct slot reset.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.old_drain',current_setting('qorpera_test.drain'),true);
select set_config('qorpera_test.drain',public.qorpera_request_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
	(current_setting('qorpera_test.office_lease')::jsonb#>>'{binding,screenId}')::uuid,1,2,3,false)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.office_ack(3,(current_setting('qorpera_test.old_drain')::jsonb->>'drainId')::uuid)$q$,'42501');
select pg_temp.office_ack();
select pg_temp.wake_assert(pg_temp.office_call('acquire')->>'state'='admitted','fresh driver only after exact physical drain');
reset role;
select pg_temp.wake_assert(not has_table_privilege('service_role','public.qorpera_runtime_office_resources','SELECT,INSERT,UPDATE,DELETE'),'private work lease table');
select pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_native_office_screen_v1(jsonb,jsonb,text,jsonb)','EXECUTE'),'no old screen bypass');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_ack_runtime_office_drain(jsonb,uuid,bigint,bigint,bigint,uuid)','EXECUTE'),'members cannot attest physical drain');
