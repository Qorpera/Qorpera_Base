-- Closed reset authority surface: private tables, service-only RPCs, strict
-- plan/custody/restore/successor validation and refusal without an enrolled
-- office. The full phase chain runs in scripts/test-runtime-office-reset.mjs
-- against a real office fixture with synthetic physical observations.
begin;

create function pg_temp.reset_state(p_command text,p_expected text)
returns void language plpgsql as $$
begin
	begin
		execute p_command;
		raise exception 'Denied request succeeded' using errcode = 'QTC01';
	exception when others then
		if sqlstate <> p_expected then
			raise exception 'Expected SQLSTATE %, received % (%)',p_expected,sqlstate,sqlerrm; end if;
	end;
end
$$;
create function pg_temp.reset_assert(p_condition boolean,p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition,false) then raise exception 'Reset assertion failed: %',p_message; end if;
end
$$;
create function pg_temp.reset_plan()
returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.lxd-office-reset-plan/v1',
		'resetId','35000000-0000-4000-8000-000000000001','intentId','35000000-0000-4000-8000-000000000013',
		'predecessor',jsonb_build_object('schema','qorpera.office-lifecycle-request/v1','transitionId','35000000-0000-4000-8000-000000000002',
			'action','replace','activationId','35000000-0000-4000-8000-000000000003','providerId','35000000-0000-4000-8000-000000000012',
			'providerPolicySha256',repeat('f',64),'startup',jsonb_build_object('scope',jsonb_build_object(
				'companyId','35000000-0000-4000-8000-000000000006','environmentId','35000000-0000-4000-8000-000000000007',
				'companyComputerId','35000000-0000-4000-8000-000000000008','logicalComputerId','35000000-0000-4000-8000-000000000009'),
				'computerGeneration',1,'allocationId','35000000-0000-4000-8000-000000000010','instanceSha256',repeat('a',64),
				'imageSha256',repeat('b',64),'bootstrapSha256',repeat('c',64),'bootId','35000000-0000-4000-8000-000000000011',
				'configurationSha256',repeat('d',64),'serviceInvocationId',repeat('e',32))),
		'preparationObservationSha256',repeat('1',64),'providerBindingSha256',repeat('2',64),'nodeId',null,
		'predecessorRootIncarnationId',null,'rootIncarnationId','35000000-0000-4000-8000-000000000005',
		'successorActivationId','35000000-0000-4000-8000-000000000004',
		'commands',jsonb_build_object('stopCommandId','35000000-0000-4000-8000-000000000020','deleteCommandId','35000000-0000-4000-8000-000000000021',
			'createCommandId','35000000-0000-4000-8000-000000000022','startCommandId','35000000-0000-4000-8000-000000000023'),
		'custody',jsonb_build_object('archiveRoot','/var/lib/qorpera-office-provider/reset-custody'))
$$;
create function pg_temp.reset_custody()
returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.office-reset-custody/v1','resetId','35000000-0000-4000-8000-000000000001',
		'rootIncarnationId','35000000-0000-4000-8000-000000000005','predecessorActivationId','35000000-0000-4000-8000-000000000003',
		'outbox',jsonb_build_object('manifestSha256',repeat('3',64),'recordCount',2,'totalBytes',900),
		'history',jsonb_build_object('manifestSha256',repeat('4',64),'totalBytes',700,'files',jsonb_build_array(
			jsonb_build_object('path','/etc/qorpera-office/adoption.json','bytes',100,'sha256',repeat('5',64),'mode',292),
			jsonb_build_object('path','/etc/qorpera-office/history/35000000-0000-4000-8000-000000000011/35000000-0000-4000-8000-000000000003/claim.json','bytes',300,'sha256',repeat('4',64),'mode',384),
			jsonb_build_object('path','/etc/qorpera-office/history/35000000-0000-4000-8000-000000000011/35000000-0000-4000-8000-000000000003/manifest.json','bytes',300,'sha256',repeat('4',64),'mode',384))),
		'journalHeadSha256',repeat('7',64),
		'nas',jsonb_build_object('workbenchSource','/mnt/office-workbench','adoptionId','35000000-0000-4000-8000-000000000015','layoutSha256',repeat('8',64)))
$$;

-- Tables are private to every role, including the service role.
do $$
declare r text; t text;
begin
	foreach r in array array['anon','authenticated','service_role'] loop
		foreach t in array array['qorpera_runtime_office_resets','qorpera_runtime_office_reset_events','qorpera_runtime_office_reset_challenges'] loop
			perform pg_temp.reset_assert(not has_table_privilege(r,'public.'||t,'select, insert, update, delete'),r||' cannot access '||t);
		end loop;
		perform pg_temp.reset_assert(not has_function_privilege(r,'public.qorpera_lock_runtime_office_reset(jsonb,boolean)','execute'),r||' cannot lock resets');
		perform pg_temp.reset_assert(not has_function_privilege(r,'public.qorpera_assert_runtime_office_reset_plan(jsonb)','execute'),r||' cannot call the plan assertion');
		perform pg_temp.reset_assert(not has_function_privilege(r,'public.qorpera_gate_runtime_office_reset_phase(public.qorpera_runtime_office_resets,text)','execute'),r||' cannot gate phases');
	end loop;
	foreach r in array array['anon','authenticated'] loop
		perform pg_temp.reset_assert(not has_function_privilege(r,'public.qorpera_begin_runtime_office_reset(jsonb,text)','execute'),r||' cannot begin a reset');
		perform pg_temp.reset_assert(not has_function_privilege(r,'public.qorpera_ack_runtime_office_reset_phase(jsonb,uuid,jsonb)','execute'),r||' cannot acknowledge a phase');
		perform pg_temp.reset_assert(not has_function_privilege(r,'public.qorpera_prepare_runtime_office_reset_successor(jsonb)','execute'),r||' cannot prepare a reset successor');
	end loop;
	perform pg_temp.reset_assert(has_function_privilege('service_role','public.qorpera_begin_runtime_office_reset(jsonb,text)','execute'),'service role begins resets');
	perform pg_temp.reset_assert(has_function_privilege('service_role','public.qorpera_activate_runtime_office_reset_successor(jsonb,text)','execute'),'service role activates reset successors');
end
$$;

-- Closed plan validation (immutable helper, exercised as the fixture owner).
select public.qorpera_assert_runtime_office_reset_plan(pg_temp.reset_plan());
select public.qorpera_assert_runtime_office_reset_plan(pg_temp.reset_plan()||jsonb_build_object('nodeId','35000000-0000-4000-8000-000000000014','predecessorRootIncarnationId','35000000-0000-4000-8000-000000000030'));
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_plan(%L::jsonb)',pg_temp.reset_plan()||'{"extra":true}'),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_plan(%L::jsonb)',jsonb_set(pg_temp.reset_plan(),'{predecessor,action}','"reboot"')),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_plan(%L::jsonb)',jsonb_set(pg_temp.reset_plan(),'{successorActivationId}','"35000000-0000-4000-8000-000000000003"')),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_plan(%L::jsonb)',jsonb_set(pg_temp.reset_plan(),'{commands,deleteCommandId}','"35000000-0000-4000-8000-000000000020"')),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_plan(%L::jsonb)',jsonb_set(pg_temp.reset_plan(),'{rootIncarnationId}','"35000000-0000-4000-8000-000000000011"')),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_plan(%L::jsonb)',jsonb_set(pg_temp.reset_plan(),'{predecessorRootIncarnationId}','"35000000-0000-4000-8000-000000000005"')),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_plan(%L::jsonb)',jsonb_set(pg_temp.reset_plan(),'{custody,archiveRoot}','"relative/custody"')),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_plan(%L::jsonb)',jsonb_set(pg_temp.reset_plan(),'{custody,archiveRoot}','"/var/../custody"')),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_plan(%L::jsonb)',jsonb_set(pg_temp.reset_plan(),'{custody,archiveRoot}','"/"')),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_plan(%L::jsonb)',jsonb_set(pg_temp.reset_plan(),'{providerBindingSha256}','"short"')),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_plan(%L::jsonb)',jsonb_set(pg_temp.reset_plan(),'{nodeId}','"x"')),'22023');

-- Custody and restore receipts bind the exact plan and allowlisted history.
select public.qorpera_assert_runtime_office_reset_custody(pg_temp.reset_custody(),pg_temp.reset_plan());
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_custody(%L::jsonb,%L::jsonb)',jsonb_set(pg_temp.reset_custody(),'{resetId}','"35000000-0000-4000-8000-000000000002"'),pg_temp.reset_plan()),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_custody(%L::jsonb,%L::jsonb)',jsonb_set(pg_temp.reset_custody(),'{history,totalBytes}','699'),pg_temp.reset_plan()),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_custody(%L::jsonb,%L::jsonb)',jsonb_set(pg_temp.reset_custody(),'{history,files,0,path}','"/etc/qorpera-office/credentials/registry"'),pg_temp.reset_plan()),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_custody(%L::jsonb,%L::jsonb)',jsonb_set(pg_temp.reset_custody(),'{history,files,0,mode}','420'),pg_temp.reset_plan()),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_custody(%L::jsonb,%L::jsonb)',jsonb_set(pg_temp.reset_custody(),'{history,files,1,sha256}',to_jsonb(repeat('9',64))),pg_temp.reset_plan()),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_custody(%L::jsonb,%L::jsonb)',jsonb_set(pg_temp.reset_custody(),'{outbox,recordCount}','8193'),pg_temp.reset_plan()),'22023');
select public.qorpera_assert_runtime_office_reset_restore(jsonb_build_object('schema','qorpera.office-reset-restore/v1',
	'resetId','35000000-0000-4000-8000-000000000001','rootIncarnationId','35000000-0000-4000-8000-000000000005','custodySha256',repeat('9',64),
	'bootId','35000000-0000-4000-8000-000000000016','outbox',jsonb_build_object('manifestSha256',repeat('3',64),'fileCount',3,'totalBytes',900),
	'history',jsonb_build_object('fileCount',3,'totalBytes',700),'nas',jsonb_build_object('reattached',true,'layoutSha256',repeat('8',64)),'state','restored'),
	pg_temp.reset_custody(),pg_temp.reset_plan(),repeat('9',64));
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_restore(%L::jsonb,%L::jsonb,%L::jsonb,%L)',jsonb_build_object('schema','qorpera.office-reset-restore/v1',
	'resetId','35000000-0000-4000-8000-000000000001','rootIncarnationId','35000000-0000-4000-8000-000000000005','custodySha256',repeat('9',64),
	'bootId','35000000-0000-4000-8000-000000000011','outbox',jsonb_build_object('manifestSha256',repeat('3',64),'fileCount',3,'totalBytes',900),
	'history',jsonb_build_object('fileCount',3,'totalBytes',700),'nas',jsonb_build_object('reattached',true,'layoutSha256',repeat('8',64)),'state','restored'),
	pg_temp.reset_custody(),pg_temp.reset_plan(),repeat('9',64)),'22023');
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_restore(%L::jsonb,%L::jsonb,%L::jsonb,%L)',jsonb_build_object('schema','qorpera.office-reset-restore/v1',
	'resetId','35000000-0000-4000-8000-000000000001','rootIncarnationId','35000000-0000-4000-8000-000000000005','custodySha256',repeat('9',64),
	'bootId','35000000-0000-4000-8000-000000000016','outbox',jsonb_build_object('manifestSha256',repeat('3',64),'fileCount',3,'totalBytes',900),
	'history',jsonb_build_object('fileCount',3,'totalBytes',700),'nas',jsonb_build_object('reattached',true,'layoutSha256',repeat('8',64)),'state','restored'),
	pg_temp.reset_custody(),pg_temp.reset_plan(),repeat('1',64)),'22023');

-- Successor requests require a replace predecessor with fresh identities.
select public.qorpera_assert_runtime_office_reset_successor_request(jsonb_build_object('schema','qorpera.office-reset-successor-request/v1',
	'resetId','35000000-0000-4000-8000-000000000001','rootIncarnationId','35000000-0000-4000-8000-000000000005','predecessor',pg_temp.reset_plan()->'predecessor',
	'attestation',jsonb_build_object('schema','qorpera.office-activation-attestation/v1','activationId','35000000-0000-4000-8000-000000000004',
		'bootId','35000000-0000-4000-8000-000000000016','preparationObservationSha256',repeat('1',64),'configurationObservationSha256',repeat('a',64),
		'configurationSha256',repeat('b',64),'adoptionReceiptSha256',repeat('5',64),'nativePort',9443,'viewerPort',9444),
	'custodySha256',repeat('9',64),'restoreSha256',repeat('0',64)));
select pg_temp.reset_state(format('select public.qorpera_assert_runtime_office_reset_successor_request(%L::jsonb)',jsonb_build_object('schema','qorpera.office-reset-successor-request/v1',
	'resetId','35000000-0000-4000-8000-000000000001','rootIncarnationId','35000000-0000-4000-8000-000000000005','predecessor',pg_temp.reset_plan()->'predecessor',
	'attestation',jsonb_build_object('schema','qorpera.office-activation-attestation/v1','activationId','35000000-0000-4000-8000-000000000004',
		'bootId','35000000-0000-4000-8000-000000000011','preparationObservationSha256',repeat('1',64),'configurationObservationSha256',repeat('a',64),
		'configurationSha256',repeat('b',64),'adoptionReceiptSha256',repeat('5',64),'nativePort',9443,'viewerPort',9444),
	'custodySha256',repeat('9',64),'restoreSha256',repeat('0',64))),'22023');

-- Without an enrolled office every RPC refuses; members never reach them.
select set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,true);
set local role service_role;
select pg_temp.reset_state(format('select public.qorpera_begin_runtime_office_reset(%L::jsonb,%L)',pg_temp.reset_plan(),repeat('9',64)),'42501');
select pg_temp.reset_state(format('select public.qorpera_begin_runtime_office_reset(%L::jsonb,%L)',pg_temp.reset_plan(),'x'),'22023');
select pg_temp.reset_state(format('select public.qorpera_runtime_office_reset_status(%L::jsonb)',pg_temp.reset_plan()),'42501');
select pg_temp.reset_state(format('select public.qorpera_prepare_runtime_office_reset_phase(%L::jsonb,%L,%L::uuid,%L)',pg_temp.reset_plan(),'stopped','35000000-0000-4000-8000-000000000040',repeat('9',64)),'42501');
select pg_temp.reset_state(format('select public.qorpera_check_runtime_office_reset_phase(%L::jsonb,%L::uuid)',pg_temp.reset_plan(),'35000000-0000-4000-8000-000000000040'),'42501');
select pg_temp.reset_state(format('select public.qorpera_ack_runtime_office_reset_phase(%L::jsonb,%L::uuid,%L::jsonb)',pg_temp.reset_plan(),'35000000-0000-4000-8000-000000000040','{}'),'42501');
select pg_temp.reset_state(format('select public.qorpera_begin_runtime_office_reset(%L::jsonb,%L)',pg_temp.reset_plan()||'{"extra":1}',repeat('9',64)),'22023');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub','35000000-0000-4000-8000-000000000001')::text,true);
set local role authenticated;
select pg_temp.reset_state(format('select public.qorpera_begin_runtime_office_reset(%L::jsonb,%L)',pg_temp.reset_plan(),repeat('9',64)),'42501');
select pg_temp.reset_state(format('select public.qorpera_runtime_office_reset_status(%L::jsonb)',pg_temp.reset_plan()),'42501');
reset role;

set constraints all immediate;
rollback;
